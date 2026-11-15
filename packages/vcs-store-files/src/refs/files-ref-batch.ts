/**
 * Atomic ref batches on git's files layout, with git's lock-file protocol.
 *
 * - A single-ref batch locks `<ref>.lock` (O_CREAT|O_EXCL), re-checks under the
 *   lock, writes the new value into the lock and renames it over the ref.
 * - A multi-ref batch locks every ref (in git's name order) and then
 *   `packed-refs.lock`, and commits as JGit's PackedBatchRefUpdate does: first
 *   the involved loose refs move into packed-refs (values unchanged for
 *   readers), then the whole batch lands in packed-refs with one rename.
 *
 * A crash at any point leaves every ref at its old or its new value once stale
 * locks are removed. Reflog lines are written in git's format after the
 * decision (best effort: a failed log line never fails a committed batch).
 *
 * Every rewrite of packed-refs (batches, pack-refs, the packed-refs writers)
 * follows git's packed-refs protocol (refs/packed-backend.c): take
 * `packed-refs.lock`, re-read under it, write the complete new content into
 * `packed-refs.new`, rename that over packed-refs while the lock is still held,
 * let the caller finish (a delete removes the loose file), and only then remove
 * the lock. Readers never see a partial packed-refs, and native git sees the
 * lock for the whole update. `packed-refs.new` is only ever written under the
 * lock, so one found by the lock holder is stale and is overwritten.
 */
import type {
  BatchOptions,
  BatchResult,
  ObjectId,
  PlannedRefUpdate,
  Ref,
  RefCommand,
  RefRejection,
  SymbolicRef,
} from "@statewalker/vcs-core";
import {
  compareRefNames,
  isUpdatableRefName,
  planRefBatch,
  RefStorage,
} from "@statewalker/vcs-core";
import type { AtomicFiles } from "@statewalker/vcs-utils/files";

const enc = new TextEncoder();
const dec = new TextDecoder();
const PACKED = "packed-refs";
/** git's temporary for a packed-refs rewrite (packed-backend.c write_with_updates). */
const PACKED_NEW = "packed-refs.new";
const ZERO_ID = "0".repeat(40);
/** Follow at most this many refs along a symbolic chain (git's read limit). */
const MAX_SYMREF_READS = 5;

export interface FilesRefBatchOptions {
  /** Retry a held ref lock for this long (git: core.filesRefLockTimeout, 100 ms). */
  refLockTimeoutMs?: number;
  /** Retry a held packed-refs.lock for this long (git: core.packedRefsTimeout, 1000 ms). */
  packedLockTimeoutMs?: number;
  /**
   * Which refs get a new reflog (git: core.logAllRefUpdates). `true` (the default here,
   * and git's for a non-bare repository): HEAD, refs/heads/, refs/remotes/ and refs/notes/;
   * `"always"`: every ref; `false` (git's default for a bare repository): none. An
   * existing reflog is appended to whatever the setting. `createGitFilesBackend` reads
   * it from the repository's config.
   */
  logAllRefUpdates?: boolean | "always";
  /**
   * The name and email of reflog lines when a batch passes no `ident` (git: user.name,
   * user.email). Defaults to `webrun-vcs <vcs@localhost>`.
   */
  reflogIdentity?: { name: string; email: string };
}

interface PackedEntry {
  id: string;
  peeled?: string;
}

type Loose = { id: string } | { target: string };

/** A planned update with the command's expected old value and its noDeref flag. */
type Update = PlannedRefUpdate & { old: ObjectId | null | undefined; noDeref: boolean };

/** Refs git logs even without an existing reflog with core.logAllRefUpdates=true. */
const LOGGED_BY_DEFAULT = ["refs/heads/", "refs/remotes/", "refs/notes/"];

/** Errors meaning "a file is where a directory must be" (refs/x is a ref, so refs/x/y.lock cannot exist). */
const isPathConflict = (e: unknown) =>
  ["ENOTDIR", "EISDIR", "EEXIST"].includes((e as { code?: string })?.code ?? "");

function parsePacked(text: string | undefined): Map<string, PackedEntry> {
  const out = new Map<string, PackedEntry>();
  if (!text) return out;
  let last: PackedEntry | undefined;
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("^")) {
      if (last) last.peeled = line.slice(1).trim();
      continue;
    }
    if (line.indexOf(" ") !== 40) throw new Error(`malformed packed-refs line: ${line}`);
    last = { id: line.slice(0, 40) };
    out.set(line.slice(41), last);
  }
  return out;
}

/** "sorted" only: peel lines are kept for untouched refs; git peels the others on demand. */
function serializePacked(entries: Map<string, PackedEntry>): Uint8Array {
  let s = "# pack-refs with: sorted \n";
  for (const name of [...entries.keys()].sort(compareRefNames)) {
    const e = entries.get(name) as PackedEntry;
    s += `${e.id} ${name}\n`;
    if (e.peeled) s += `^${e.peeled}\n`;
  }
  return enc.encode(s);
}

/** Thrown when `packed-refs.lock` stays held by another writer past the timeout. */
export class PackedRefsLockedError extends Error {
  readonly code = "ELOCKED";
  constructor(timeoutMs: number) {
    super(
      `Unable to lock packed-refs: packed-refs.lock is held by another writer (waited ${timeoutMs} ms)`,
    );
    this.name = "PackedRefsLockedError";
  }
}

/**
 * Thrown by the single-ref writes (`writeLoose`, `removeRef`, and so `FileRefStore.set`,
 * `setSymbolic`, `remove`) when the update is refused: `code` is "ELOCKED" when another
 * writer kept `<ref>.lock` past `refLockTimeoutMs`, "EREJECTED" otherwise (a D/F conflict).
 */
export class RefUpdateRejectedError extends Error {
  readonly code: "ELOCKED" | "EREJECTED";
  constructor(readonly rejected: RefRejection[]) {
    const why = rejected
      .map((r) =>
        r.reason === "locked"
          ? `${r.name}.lock is held by another writer`
          : `${r.name}: ${r.reason}`,
      )
      .join(", ");
    super(`Unable to update ref: ${why}`);
    this.name = "RefUpdateRejectedError";
    this.code = rejected.some((r) => r.reason === "locked") ? "ELOCKED" : "EREJECTED";
  }
}

/**
 * The ref operations of a git-files ref store, all under git's lock files.
 */
export interface FilesRefOps {
  /** An atomic ref batch (see `createFilesRefBatch`). */
  batch(commands: RefCommand[], batchOptions?: BatchOptions): Promise<BatchResult>;
  /**
   * Rewrite packed-refs under `packed-refs.lock`: `update` gets the file's text,
   * re-read under the lock (undefined if absent), and returns the new bytes,
   * `null` to delete the file, or `undefined` to leave it unchanged. Throws
   * `PackedRefsLockedError` if the lock stays held past `packedLockTimeoutMs`.
   */
  updatePackedRefs(
    update: (text: string | undefined) => Uint8Array | null | undefined,
  ): Promise<void>;
  /**
   * `git pack-refs`: under `packed-refs.lock`, copy the named loose refs into
   * packed-refs (`all`: every loose ref under `refs/`). With `prune`, then remove
   * each loose ref under its own `.lock`, only if it still holds the packed value.
   */
  packRefs(names: string[], options?: { all?: boolean; prune?: boolean }): Promise<void>;
  /**
   * Remove `packed-refs.new` left by a crashed rewrite, if `packed-refs.lock` is free right
   * now (the temporary is only written under the lock, so it is stale then). Returns how
   * many files it removed (0 or 1).
   */
  sweepTemporaries(): Promise<number>;
  /**
   * Write a loose ref file as git's lock_ref / commit_ref: create `<name>.lock` with
   * `content` (waiting up to `refLockTimeoutMs`), check for D/F conflicts under it, and
   * rename it over the ref. No old-value check and no reflog (for symbolic refs and names
   * outside `refs/`; object ids under `refs/` go through `batch`). Throws
   * `RefUpdateRejectedError` with nothing changed.
   */
  writeLoose(name: string, content: string): Promise<void>;
  /**
   * Delete a ref whatever its value, loose and packed, as a batch delete does: under
   * `<name>.lock` and then `packed-refs.lock`, in one pass. Removes its reflog. False if
   * there was nothing to delete. Throws `RefUpdateRejectedError` if `<name>.lock` stays
   * held, `PackedRefsLockedError` if `packed-refs.lock` does, with nothing changed.
   */
  removeRef(name: string): Promise<boolean>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_IDENTITY = { name: "webrun-vcs", email: "vcs@localhost" };
/** git's reflog message: whitespace runs collapsed to one space, trimmed (refs.c copy_reflog_msg). */
const normalizeMessage = (m: string | undefined) => (m ?? "").replace(/\s+/g, " ").trim();
const fail = (rejected: RefRejection[]): BatchResult => ({ ok: false, rejected });

/**
 * The batch operation of a git-files ref store, over `files` rooted at the
 * `.git` directory.
 *
 * @example
 * ```typescript
 * const batch = createFilesRefBatch(atomicFilesOver(files, ".git"));
 * await batch([{ name: "refs/heads/main", old: oldId, new: newId }], { message: "commit: x" });
 * ```
 */
export function createFilesRefBatch(
  files: AtomicFiles,
  options: FilesRefBatchOptions = {},
): (commands: RefCommand[], batchOptions?: BatchOptions) => Promise<BatchResult> {
  return createFilesRefOps(files, options).batch;
}

/**
 * Ref batches, pack-refs and packed-refs rewrites over `files` rooted at the
 * `.git` directory, sharing one lock protocol and its timeouts.
 *
 * @example
 * ```typescript
 * const ops = createFilesRefOps(atomicFilesOver(files, ".git"));
 * await ops.packRefs([], { all: true, prune: true }); // git pack-refs --all
 * ```
 */
export function createFilesRefOps(
  files: AtomicFiles,
  options: FilesRefBatchOptions = {},
): FilesRefOps {
  const refLockTimeout = options.refLockTimeoutMs ?? 100;
  const packedLockTimeout = options.packedLockTimeoutMs ?? 1000;
  const logAll = options.logAllRefUpdates ?? true;
  const identity = options.reflogIdentity ?? DEFAULT_IDENTITY;
  /** git's should_autocreate_reflog (refs/files-backend.c). */
  const autocreateReflog = (name: string) =>
    logAll === "always" ||
    (logAll === true && (name === "HEAD" || LOGGED_BY_DEFAULT.some((p) => name.startsWith(p))));

  /** File text, or undefined if absent (also when it vanishes between the check and the read). */
  async function readText(path: string): Promise<string | undefined> {
    if (!(await files.exists(path))) return undefined;
    let text = "";
    let any = false;
    for await (const chunk of files.read(path)) {
      any = true;
      text += dec.decode(chunk, { stream: true });
    }
    if (!any && !(await files.exists(path))) return undefined;
    return text + dec.decode();
  }
  /** As git's parse_loose_ref_contents: `ref:` with optional spaces, or an id then whitespace/end. */
  async function readLoose(name: string): Promise<Loose | undefined> {
    const text = await readText(name);
    if (text === undefined) return undefined;
    const sym = /^ref:\s*(\S+)/.exec(text);
    if (sym) return { target: sym[1] as string };
    const m = /^([0-9a-f]{40})(?:\s|$)/.exec(text);
    if (!m) throw new Error(`${name} is broken: ${JSON.stringify(text.slice(0, 50))}`);
    return { id: m[1] as string };
  }
  const readPacked = async () => parsePacked(await readText(PACKED));
  async function readRef(
    name: string,
    packed: Map<string, PackedEntry>,
  ): Promise<Ref | SymbolicRef | undefined> {
    const loose = await readLoose(name);
    if (loose && "target" in loose) {
      return { name, target: loose.target, storage: RefStorage.LOOSE };
    }
    if (loose) return { name, objectId: loose.id, storage: RefStorage.LOOSE, peeled: false };
    const e = packed.get(name);
    return e ? { name, objectId: e.id, storage: RefStorage.PACKED, peeled: false } : undefined;
  }
  async function deref(name: string): Promise<string> {
    let current = name;
    for (let i = 0; i < MAX_SYMREF_READS; i++) {
      const v = await readLoose(current);
      if (!v || !("target" in v)) return current;
      current = v.target;
    }
    throw new Error(`symbolic ref ${name} nests too deeply`);
  }
  /**
   * Remove `path`, then its empty parent directories, keeping the category
   * directories git keeps (`refs/heads`, `refs/tags`, …, and `logs/refs/heads`, …).
   */
  async function removeAndPrune(path: string): Promise<void> {
    await files.remove(path);
    const keep = path.startsWith("logs/") ? 3 : 2; // components of the shortest kept directory
    for (
      let d = path.slice(0, path.lastIndexOf("/"));
      d.split("/").length > keep;
      d = d.slice(0, d.lastIndexOf("/"))
    ) {
      if (!(await files.removeEmptyDir(d))) break;
    }
  }
  /** "ok", "held" (someone else's lock) or "conflict" (a file where a directory is needed). */
  async function lock(
    path: string,
    timeoutMs: number,
    content = new Uint8Array(0),
  ): Promise<"ok" | "held" | "conflict"> {
    const until = Date.now() + timeoutMs;
    for (let wait = 1; ; wait = Math.min(wait * 2, 20)) {
      try {
        if (await files.createExclusive(`${path}.lock`, content)) return "ok";
      } catch (e) {
        if (isPathConflict(e)) return "conflict";
        throw e; // EACCES, ENOSPC, EIO…: a real failure, not a D/F conflict
      }
      if (Date.now() >= until) return "held";
      await sleep(wait);
    }
  }
  const unlock = (path: string) => removeAndPrune(`${path}.lock`).catch(() => {});
  /**
   * Replace packed-refs (`null`: remove it). Only while holding `packed-refs.lock`, which
   * this does not release: the complete content goes into `packed-refs.new` first, then
   * one rename puts it in place, so a reader sees the old file or the new one.
   */
  async function commitPacked(content: Uint8Array | null): Promise<void> {
    if (content === null) {
      await files.remove(PACKED);
      return;
    }
    try {
      // Inside the try: a write that fails partway leaves no partial packed-refs.new.
      await files.write(PACKED_NEW, content); // overwrites a stale one: we hold the lock
      await files.replace(PACKED_NEW, PACKED);
    } catch (e) {
      await files.remove(PACKED_NEW).catch(() => false);
      throw e;
    }
  }
  /**
   * Run `fn` holding `packed-refs.lock` from start to end, as git's packed-refs
   * transaction: `fn` may commit packed-refs (`commitPacked`) and then finish its work
   * (remove loose refs) before the lock is removed. "held" if another writer keeps the
   * lock past the timeout.
   */
  async function withPackedLock<T>(
    fn: (commit: typeof commitPacked) => Promise<T>,
  ): Promise<T | "held"> {
    if ((await lock(PACKED, packedLockTimeout)) !== "ok") return "held";
    try {
      return await fn(commitPacked);
    } finally {
      await files.remove(`${PACKED}.lock`).catch(() => false);
    }
  }
  /**
   * Commit a lock over its target; an empty directory left at the target is removed
   * first. A directory still holding another writer's lock (a batch on `<path>/…`
   * that lost to ours and is unlocking) is waited for, up to the ref lock timeout.
   * False if the target stays a non-empty directory: a D/F conflict.
   */
  async function commit(path: string): Promise<boolean> {
    const until = Date.now() + refLockTimeout;
    for (let wait = 1; ; wait = Math.min(wait * 2, 20)) {
      await files.removeEmptyDir(path);
      try {
        await files.replace(`${path}.lock`, path);
        return true;
      } catch (e) {
        if (await files.exists(path)) throw e; // a file is there: not a directory in the way
        if (Date.now() >= until) return false;
        await sleep(wait);
      }
    }
  }
  /**
   * Reflog lines in git's format, after the decision (best effort, as git and JGit).
   * As git: a log is created as `logAllRefUpdates` says (`autocreateReflog`), and
   * appended to whenever it exists.
   * The updated ref gets no line for a no-op and loses its log on delete; the
   * refs that record the update too (`reflogAlso`, HEAD among them) always get one.
   */
  async function writeLogs(
    updates: Update[],
    current: (u: Update) => ObjectId | undefined,
    o: BatchOptions,
  ): Promise<void> {
    const ident =
      o.ident ?? `${identity.name} <${identity.email}> ${Math.floor(Date.now() / 1000)} +0000`;
    const message = normalizeMessage(o.message);
    const append = async (name: string, line: Uint8Array) => {
      const path = `logs/${name}`;
      if (!autocreateReflog(name) && !(await files.exists(path))) return;
      await files.removeEmptyDir(path);
      await files.append(path, line);
    };
    for (const u of updates) {
      try {
        const old = current(u) ?? ZERO_ID;
        const next = u.newValue ?? ZERO_ID;
        const line = enc.encode(`${old} ${next} ${ident}${message ? `\t${message}` : ""}\n`);
        if (u.newValue === null) {
          if (await files.exists(`logs/${u.name}`)) await removeAndPrune(`logs/${u.name}`);
        } else if (old !== u.newValue) {
          await append(u.name, line);
        }
        for (const n of u.reflogAlso) await append(n, line);
      } catch {
        // as git and JGit: the ref update stands without its reflog line
      }
    }
  }
  /**
   * Directory/file checks under the locks, counting other writers' lock files
   * as pending names (`mine` are this batch's own locks).
   */
  async function conflicts(
    updates: Update[],
    packed: Map<string, PackedEntry>,
    mine: Set<string>,
  ): Promise<RefRejection[]> {
    const plan = await planRefBatch(
      updates.map((u) => ({ name: u.name, new: u.newValue, noDeref: true })),
      {
        read: async (n) =>
          (await readRef(n, packed)) ??
          (!mine.has(n) && (await files.exists(`${n}.lock`))
            ? { name: n, objectId: ZERO_ID, storage: RefStorage.LOOSE, peeled: false }
            : undefined),
        hasChildren: async (n) => {
          for (const k of packed.keys()) if (k.startsWith(`${n}/`)) return true;
          for await (const p of files.list(n)) {
            if (!p.endsWith(".lock") || !mine.has(p.slice(0, -5))) return true;
          }
          return false;
        },
      },
    );
    if (plan.ok) return [];
    const byName = new Map(updates.map((u) => [u.name, u.requested]));
    return plan.rejected.map((r) => ({ name: byName.get(r.name) ?? r.name, reason: r.reason }));
  }
  /**
   * Under the locks: every command still names the same target as when it was
   * planned. A name that became a symbolic ref meanwhile (say HEAD re-attached by
   * a checkout) now dereferences elsewhere, and is refused unless noDeref is set.
   */
  async function sameTargets(updates: Update[]): Promise<RefRejection[]> {
    const out: RefRejection[] = [];
    for (const u of updates) {
      if (!u.noDeref && (await deref(u.requested)) !== u.name) {
        out.push({ name: u.requested, reason: "mismatch" });
      }
    }
    return out;
  }
  const mismatch = (old: ObjectId | null | undefined, current: ObjectId | undefined) =>
    old !== undefined && (old === null ? current !== undefined : current !== old);

  async function single(u: Update, o: BatchOptions): Promise<BatchResult> {
    const content = u.newValue === null ? new Uint8Array(0) : enc.encode(`${u.newValue}\n`);
    const extra = u.reflogAlso.includes("HEAD") && u.name !== "HEAD" ? ["HEAD"] : [];
    const held: string[] = [];
    let ours = true;
    try {
      for (const n of [...extra, u.name]) {
        const r = await lock(n, refLockTimeout, n === u.name ? content : new Uint8Array(0));
        if (r !== "ok") {
          const name = n === u.name ? u.requested : n;
          return fail([{ name, reason: r === "held" ? "locked" : "df-conflict" }]);
        }
        held.push(n);
      }
      const moved = await sameTargets([u]);
      if (moved.length) return fail(moved);
      const packed = await readPacked();
      const df = await conflicts([u], packed, new Set(held));
      if (df.length) return fail(df);
      const cur = await readRef(u.name, packed);
      // With noDeref on a symbolic ref, `old` (and the log line) use the value it resolves to, as git.
      const curId =
        cur && "target" in cur ? await resolveId(u.name) : cur ? cur.objectId : undefined;
      if (mismatch(u.old, curId)) {
        return fail([{ name: u.requested, reason: "mismatch" }]);
      }
      if (u.newValue === null) {
        if ((await deleteUnderPackedLock(u.name)) === "held") {
          return fail([{ name: PACKED, reason: "locked" }]);
        }
        await writeLogs([u], () => curId, o);
      } else {
        await writeLogs([u], () => curId, o); // under the ref lock, before the rename (as git)
        if (!(await commit(u.name))) return fail([{ name: u.requested, reason: "df-conflict" }]);
        ours = false;
      }
      return { ok: true, rejected: [] };
    } finally {
      for (const n of held) if (n !== u.name || ours) await unlock(n);
    }
  }

  /**
   * As git, every delete goes through packed-refs.lock, decided on a copy re-read under
   * it: a pack-refs that holds the lock may be packing this loose ref right now. In one
   * pass under the lock: drop the ref from packed-refs if the fresh copy names it, then
   * remove the loose file, before the lock is released, so no pack-refs can copy the
   * loose value back in between. The caller holds `<name>.lock` (or knows no loose file
   * can exist there).
   */
  async function deleteUnderPackedLock(
    name: string,
  ): Promise<{ packed: boolean; loose: boolean } | "held"> {
    return withPackedLock(async (commit) => {
      const fresh = await readPacked();
      const packed = fresh.delete(name);
      if (packed) await commit(serializePacked(fresh));
      const loose = await files.exists(name);
      if (loose) await removeAndPrune(name);
      return { packed, loose };
    });
  }

  async function multi(updates: Update[], o: BatchOptions): Promise<BatchResult> {
    const extra = updates.some((u) => u.reflogAlso.includes("HEAD")) ? ["HEAD"] : [];
    const names = [...new Set([...extra, ...updates.map((u) => u.name)])].sort(compareRefNames);
    const held: string[] = [];
    let packedHeld = false;
    try {
      for (const n of names) {
        const r = await lock(n, refLockTimeout);
        if (r !== "ok") {
          const name = updates.find((u) => u.name === n)?.requested ?? n;
          return fail([{ name, reason: r === "held" ? "locked" : "df-conflict" }]);
        }
        held.push(n);
      }
      if ((await lock(PACKED, packedLockTimeout)) !== "ok") {
        return fail([{ name: PACKED, reason: "locked" }]);
      }
      packedHeld = true;
      const moved = await sameTargets(updates);
      if (moved.length) return fail(moved);
      const packed = await readPacked();
      const df = await conflicts(updates, packed, new Set(held));
      if (df.length) return fail(df);
      const loose = new Map<string, string>();
      const current = new Map<string, string | undefined>();
      for (const u of updates) {
        const l = await readLoose(u.name);
        if (l && "target" in l) throw new Error(`${u.name} became a symbolic ref`);
        if (l) loose.set(u.name, l.id);
        current.set(u.name, l?.id ?? packed.get(u.name)?.id);
      }
      const mismatched = updates.filter((u) => mismatch(u.old, current.get(u.name)));
      if (mismatched.length) {
        return fail(mismatched.map((u) => ({ name: u.requested, reason: "mismatch" as const })));
      }
      if (loose.size) {
        // Phase 1: move the involved loose refs into packed-refs (values unchanged for
        // readers), committing packed-refs BEFORE removing the loose files.
        for (const [n, v] of loose) {
          const prev = packed.get(n);
          packed.set(n, prev?.id === v ? prev : { id: v });
        }
        // packed-refs.lock stays held: no other writer runs between the phases.
        await commitPacked(serializePacked(packed));
        for (const n of loose.keys()) await removeAndPrune(n);
      }
      // Phase 2: the whole batch in one rename.
      for (const u of updates) {
        if (u.newValue === null) packed.delete(u.name);
        else packed.set(u.name, { id: u.newValue });
      }
      await commitPacked(serializePacked(packed));
      await files.remove(`${PACKED}.lock`);
      packedHeld = false;
      await writeLogs(updates, (u) => current.get(u.name), o);
      return { ok: true, rejected: [] };
    } finally {
      if (packedHeld) await files.remove(`${PACKED}.lock`).catch(() => false);
      for (const n of held) await unlock(n);
    }
  }

  /** The id `name` resolves to (through symbolic refs), as `old` is compared with it. */
  async function resolveId(name: string): Promise<ObjectId | undefined> {
    const packed = await readPacked();
    const ref = await readRef(await deref(name), packed);
    return ref && "objectId" in ref ? ref.objectId : undefined;
  }

  async function updatePackedRefs(
    update: (text: string | undefined) => Uint8Array | null | undefined,
  ): Promise<void> {
    const r = await withPackedLock(async (commit) => {
      const text = await readText(PACKED);
      const next = update(text);
      if (next === undefined || (next === null && text === undefined)) return;
      await commit(next);
    });
    if (r === "held") throw new PackedRefsLockedError(packedLockTimeout);
  }

  /**
   * As git's files_pack_refs and JGit's RefDirectory.pack: the loose refs are read
   * and packed-refs is written under packed-refs.lock; only then is each packed
   * loose ref removed, under its own lock and only if it still holds the packed
   * value, so a ref updated meanwhile stays loose with its new value.
   */
  async function packRefs(
    names: string[],
    o: { all?: boolean; prune?: boolean } = {},
  ): Promise<void> {
    const packedNow = new Map<string, string>();
    const r = await withPackedLock(async (commit) => {
      const packed = await readPacked();
      const wanted = o.all ? await looseRefNames() : names;
      for (const n of wanted) {
        // absent, broken (git's iteration skips those) or symbolic (git keeps symrefs loose)
        const l = await readLoose(n).catch(() => undefined);
        if (!l || "target" in l) continue;
        const prev = packed.get(n);
        packed.set(n, prev?.id === l.id ? prev : { id: l.id });
        packedNow.set(n, l.id);
      }
      if (packedNow.size) await commit(serializePacked(packed));
    });
    if (r === "held") throw new PackedRefsLockedError(packedLockTimeout);
    if (!o.prune) return;
    for (const [n, id] of packedNow) {
      // A ref someone is updating right now keeps its loose file (git skips it too).
      if ((await lock(n, refLockTimeout)) !== "ok") continue;
      try {
        const l = await readLoose(n).catch(() => undefined);
        if (l && "id" in l && l.id === id) await files.remove(n);
      } finally {
        await unlock(n); // also prunes the directories the removal emptied
      }
    }
  }

  /** Loose refs under refs/ (lock files skipped). */
  async function looseRefNames(): Promise<string[]> {
    const out: string[] = [];
    for await (const p of files.list("refs")) if (!p.endsWith(".lock")) out.push(p);
    return out;
  }

  const batch = async (
    commands: RefCommand[],
    batchOptions: BatchOptions = {},
  ): Promise<BatchResult> => {
    if (commands.length === 0) return { ok: true, rejected: [] };
    // Plan without locks: names, policy, D/F conflicts and old values (all re-checked under the locks).
    const packed = await readPacked();
    const plan = await planRefBatch(commands, {
      read: (name) => readRef(name, packed),
      hasChildren: async (name) => {
        for (const k of packed.keys()) if (k.startsWith(`${name}/`)) return true;
        for await (const p of files.list(name)) if (!p.endsWith(".lock")) return true;
        return false;
      },
    });
    if (!plan.ok) return fail(plan.rejected);
    const updates: Update[] = plan.updates.map((u, i) => ({
      ...u,
      old: commands[i]?.old,
      noDeref: commands[i]?.noDeref === true,
    }));
    if (updates.length > 1) {
      // Replacing a symbolic ref (noDeref) cannot join the packed-refs commit: its loose
      // file would shadow the packed value. git can; this store refuses it as a whole.
      const symrefs = updates.filter((u) => u.current && "target" in u.current);
      if (symrefs.length) {
        return fail(updates.map((u) => ({ name: u.requested, reason: "unsupported" as const })));
      }
    }
    return updates.length === 1
      ? single(updates[0] as Update, batchOptions)
      : multi(updates, batchOptions);
  };

  async function sweepTemporaries(): Promise<number> {
    if (!(await files.exists(PACKED_NEW))) return 0;
    if ((await lock(PACKED, 0)) !== "ok") return 0; // a rewrite in flight owns it
    try {
      return (await files.remove(PACKED_NEW)) ? 1 : 0;
    } finally {
      await files.remove(`${PACKED}.lock`).catch(() => false);
    }
  }

  async function writeLoose(name: string, content: string): Promise<void> {
    const r = await lock(name, refLockTimeout, enc.encode(content));
    if (r !== "ok") {
      throw new RefUpdateRejectedError([{ name, reason: r === "held" ? "locked" : "df-conflict" }]);
    }
    let ours = true;
    try {
      if (isUpdatableRefName(name)) {
        const u = { name, requested: name, newValue: ZERO_ID } as Update;
        const df = await conflicts([u], await readPacked(), new Set([name]));
        if (df.length) throw new RefUpdateRejectedError(df);
      }
      if (!(await commit(name)))
        throw new RefUpdateRejectedError([{ name, reason: "df-conflict" }]);
      ours = false;
    } finally {
      if (ours) await unlock(name);
    }
  }

  async function removeRef(name: string): Promise<boolean> {
    const r = await lock(name, refLockTimeout);
    if (r === "held") throw new RefUpdateRejectedError([{ name, reason: "locked" }]);
    // "conflict": a file where a parent directory would be, so no loose file at `name`
    try {
      const d = await deleteUnderPackedLock(name);
      if (d === "held") throw new PackedRefsLockedError(packedLockTimeout);
      const removed = d.packed || d.loose;
      if (removed && (await files.exists(`logs/${name}`))) {
        await removeAndPrune(`logs/${name}`).catch(() => {}); // as git: the log goes too
      }
      return removed;
    } finally {
      if (r === "ok") await unlock(name);
    }
  }

  return { batch, updatePackedRefs, packRefs, sweepTemporaries, writeLoose, removeRef };
}
