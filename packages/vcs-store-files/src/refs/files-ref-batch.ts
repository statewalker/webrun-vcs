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
import { compareRefNames, planRefBatch, RefStorage } from "@statewalker/vcs-core";
import type { AtomicFiles } from "@statewalker/vcs-utils/files";

const enc = new TextEncoder();
const dec = new TextDecoder();
const PACKED = "packed-refs";
const ZERO_ID = "0".repeat(40);
/** Follow at most this many refs along a symbolic chain (git's read limit). */
const MAX_SYMREF_READS = 5;

export interface FilesRefBatchOptions {
  /** Retry a held ref lock for this long (git: core.filesRefLockTimeout, 100 ms). */
  refLockTimeoutMs?: number;
  /** Retry a held packed-refs.lock for this long (git: core.packedRefsTimeout, 1000 ms). */
  packedLockTimeoutMs?: number;
}

interface PackedEntry {
  id: string;
  peeled?: string;
}

type Loose = { id: string } | { target: string };

/** A planned update with the command's expected old value and its noDeref flag. */
type Update = PlannedRefUpdate & { old: ObjectId | null | undefined; noDeref: boolean };

/** Refs git logs even without an existing reflog (core.logAllRefUpdates=true, non-bare). */
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const defaultIdent = () => `webrun-vcs <vcs@localhost> ${Math.floor(Date.now() / 1000)} +0000`;
/** git's reflog message: whitespace runs collapsed to one space, trimmed (refs.c copy_reflog_msg). */
const normalizeMessage = (m: string | undefined) => (m ?? "").replace(/\s+/g, " ").trim();
const fail = (rejected: RefRejection[]): BatchResult => ({ ok: false, rejected });

/**
 * The batch operation of a git-files ref store, over `files` rooted at the
 * `.git` directory.
 *
 * @example
 * ```typescript
 * const batch = createFilesRefBatch(createNodeAtomicFiles("/repo/.git"));
 * await batch([{ name: "refs/heads/main", old: oldId, new: newId }], { message: "commit: x" });
 * ```
 */
export function createFilesRefBatch(
  files: AtomicFiles,
  options: FilesRefBatchOptions = {},
): (commands: RefCommand[], batchOptions?: BatchOptions) => Promise<BatchResult> {
  const refLockTimeout = options.refLockTimeoutMs ?? 100;
  const packedLockTimeout = options.packedLockTimeoutMs ?? 1000;

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
  /** Commit a lock over its target; an empty directory left at the target is removed first. */
  async function commit(path: string): Promise<void> {
    await files.removeEmptyDir(path);
    await files.replace(`${path}.lock`, path);
  }
  /**
   * Reflog lines in git's format, after the decision (best effort, as git and JGit).
   * As git with core.logAllRefUpdates=true: a log is created for HEAD,
   * refs/heads/, refs/remotes/ and refs/notes/, and appended to when it exists.
   * The updated ref gets no line for a no-op and loses its log on delete; the
   * refs that record the update too (`reflogAlso`, HEAD among them) always get one.
   */
  async function writeLogs(
    updates: Update[],
    current: (u: Update) => ObjectId | undefined,
    o: BatchOptions,
  ): Promise<void> {
    const ident = o.ident ?? defaultIdent();
    const message = normalizeMessage(o.message);
    const append = async (name: string, line: Uint8Array) => {
      const path = `logs/${name}`;
      const create = name === "HEAD" || LOGGED_BY_DEFAULT.some((p) => name.startsWith(p));
      if (!create && !(await files.exists(path))) return;
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
        if (packed.has(u.name)) {
          // git's order: drop it from packed-refs first, then remove the loose file
          if ((await lock(PACKED, packedLockTimeout)) !== "ok") {
            return fail([{ name: PACKED, reason: "locked" }]);
          }
          let packedOurs = true;
          try {
            const fresh = await readPacked();
            fresh.delete(u.name);
            await files.write(`${PACKED}.lock`, serializePacked(fresh));
            await files.replace(`${PACKED}.lock`, PACKED);
            packedOurs = false;
          } finally {
            if (packedOurs) await files.remove(`${PACKED}.lock`).catch(() => false);
          }
        }
        if (await files.exists(u.name)) await removeAndPrune(u.name);
        await writeLogs([u], () => curId, o);
      } else {
        await writeLogs([u], () => curId, o); // under the ref lock, before the rename (as git)
        await commit(u.name);
        ours = false;
      }
      return { ok: true, rejected: [] };
    } finally {
      for (const n of held) if (n !== u.name || ours) await unlock(n);
    }
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
      let packed = await readPacked();
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
        await files.write(`${PACKED}.lock`, serializePacked(packed));
        await files.replace(`${PACKED}.lock`, PACKED);
        packedHeld = false;
        for (const n of loose.keys()) await removeAndPrune(n);
        if ((await lock(PACKED, packedLockTimeout)) !== "ok") {
          return fail([{ name: PACKED, reason: "locked" }]);
        }
        packedHeld = true;
        packed = await readPacked();
      }
      // Phase 2: the whole batch in one rename.
      for (const u of updates) {
        if (u.newValue === null) packed.delete(u.name);
        else packed.set(u.name, { id: u.newValue });
      }
      await files.write(`${PACKED}.lock`, serializePacked(packed));
      await files.replace(`${PACKED}.lock`, PACKED);
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

  return async (commands, batchOptions = {}) => {
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
}
