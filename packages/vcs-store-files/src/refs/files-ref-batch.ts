/**
 * Atomic ref batches on git's files layout, with git's lock-file protocol.
 *
 * - A single-ref batch locks `<ref>.lock` (O_CREAT|O_EXCL), re-checks under the
 *   lock, writes the new value into the lock and renames it over the ref.
 * - A multi-ref batch locks every ref (in name order) and then
 *   `packed-refs.lock`, and commits as JGit's PackedBatchRefUpdate does: first
 *   the involved loose refs move into packed-refs (values unchanged for
 *   readers), then the whole batch lands in packed-refs with one rename.
 *
 * A crash at any point leaves every ref at its old or its new value once stale
 * locks are removed. Reflog lines are written in git's format under the ref
 * locks, before the commit: as in git, a line that cannot be written fails the
 * update with the refs unchanged (only a delete's log removal is best effort).
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
  ReflogDeleteOptions,
  RefRejection,
  SymbolicRef,
  SymbolicRefLogOptions,
} from "@statewalker/vcs-core";
import {
  compareRefNames,
  deleteReflogLine,
  isRefObjectId,
  isUpdatableRefName,
  planRefBatch,
  ReflogEntryNotFoundError,
  type RefRemoveAllOptions,
  type RefRemoveOptions,
  RefStorage,
  RefTransactionAbortedError,
  type RefTransactionHook,
  type RefTransactionUpdate,
  symrefReflogWrites,
} from "@statewalker/vcs-core";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import type { AtomicFiles } from "@statewalker/vcs-utils/files";
import { parseReflogLine } from "./reflog-reader.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const PACKED = "packed-refs";
/** git's temporary for a packed-refs rewrite (packed-backend.c write_with_updates). */
const PACKED_NEW = "packed-refs.new";
const ZERO_ID = "0".repeat(40);
/** Follow at most this many refs along a symbolic chain (git's read limit). */
const MAX_SYMREF_READS = 5;

export interface FilesRefBatchOptions {
  /**
   * Told about each batch's states (git's reference-transaction hook); read when each batch
   * starts, so it can be set after the store is made
   */
  transactionHook?: () => RefTransactionHook | undefined;
  /**
   * Retry a held ref lock for this long (git: core.filesRefLockTimeout, 100 ms); negative
   * waits forever, 0 tries once (lockfile.c lock_file_timeout).
   */
  refLockTimeoutMs?: number;
  /**
   * Retry a held packed-refs.lock for this long (git: core.packedRefsTimeout, 1000 ms);
   * negative waits forever, 0 tries once.
   */
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
  /**
   * The id of a ref this store does not hold, where a symbolic ref of this store points
   * at it: a linked worktree's HEAD (`.git/worktrees/<id>/HEAD`) naming a branch of the
   * repository. Read while planning and as the old value (compared, and logged) of a
   * `noDeref` update of that symbolic ref, as git resolves it through the worktree's
   * combined ref store. Undefined: the ref does not exist.
   */
  resolveOutside?: (name: string) => Promise<ObjectId | undefined>;
  /**
   * Whether HEAD's reflog records an update of the branch HEAD points at (git's
   * split_head_update). Default true. False for the repository's refs as a linked worktree
   * updates them: that worktree's own HEAD records the update, the repository's does not.
   */
  logHeadUpdates?: boolean;
  /**
   * The id an annotated tag `id` peels to (undefined for an object that is not a tag): with
   * it, packed-refs is written as git writes it, every tag with its `^<id>` line under the
   * `peeled fully-peeled sorted` header. Without it, only the peel lines already known, under
   * a header claiming no more than those.
   */
  peel?: (id: ObjectId) => Promise<ObjectId | undefined>;
}

interface PackedEntry {
  id: string;
  peeled?: string;
  /**
   * Whether `peeled` is settled: an entry read with a peel line, or one the file's traits
   * settle (`fully-peeled`, or `peeled` for refs/tags/), or one peeled here; a ref written by
   * this store is not until peeled
   */
  known?: boolean;
}

type Loose = { id: string } | { target: string };

/** A planned update with the command's expected old value and its noDeref flag. */
type Update = PlannedRefUpdate & {
  old: ObjectId | null | undefined;
  noDeref: boolean;
  /** HEAD names the ref, not asked for through HEAD (see `RefTransactionUpdate.viaHead`) */
  viaHead?: boolean;
  /** The symbolic refs between the one asked for and the ref (see `RefTransactionUpdate.through`) */
  through?: string[];
};

/** What a batch tells its hook once its locks are released (see `afterLocks`). */
interface AfterLocks {
  committed?: boolean;
  refused?: RefTransactionAbortedError;
}

/** Refs git logs even without an existing reflog with core.logAllRefUpdates=true. */
const LOGGED_BY_DEFAULT = ["refs/heads/", "refs/remotes/", "refs/notes/"];

/** git's irregular root refs (refs.c is_root_ref): root refs that do not end in `_HEAD`. */
const IRREGULAR_ROOT_REFS = [
  "AUTO_MERGE",
  "BISECT_EXPECTED_REV",
  "NOTES_MERGE_PARTIAL",
  "NOTES_MERGE_REF",
  "MERGE_AUTOSTASH",
];

/**
 * Whether git writes and deletes `name` through a ref transaction (so its
 * reference-transaction hook hears of it), as refs.c `is_root_ref` names them: upper-case
 * names ending in `_HEAD` (ORIG_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, REBASE_HEAD, ...) and
 * AUTO_MERGE and kin, not HEAD itself and not the pseudo refs git writes as files
 * (FETCH_HEAD, MERGE_HEAD).
 */
export function isRootRefName(name: string): boolean {
  if (!/^[A-Z_-]+$/.test(name) || name === "HEAD") return false;
  if (name === "FETCH_HEAD" || name === "MERGE_HEAD") return false;
  return name.endsWith("_HEAD") || IRREGULAR_ROOT_REFS.includes(name);
}

/**
 * The hook of a root ref's transaction: git 2.43 writes AUTO_MERGE as a plain file, so only
 * 2.5x's hook hears of it.
 */
function rootRefHook(
  hook: RefTransactionHook | undefined,
  name: string,
): RefTransactionHook | undefined {
  if (!hook || name !== "AUTO_MERGE") return hook;
  return (state, updates, context) => hook(state, updates, { ...context, only: "2.56" });
}

/** Errors meaning "a file is where a directory must be" (refs/x is a ref, so refs/x/y.lock cannot exist). */
const isPathConflict = (e: unknown) =>
  ["ENOTDIR", "EISDIR", "EEXIST"].includes((e as { code?: string })?.code ?? "");

function parsePacked(text: string | undefined): Map<string, PackedEntry> {
  const out = new Map<string, PackedEntry>();
  if (!text) return out;
  // the header's traits say which entries without a peel line are known not to peel
  // (packed-backend.c create_snapshot / next_record): every one under `fully-peeled`, those
  // under refs/tags/ under `peeled`; a `^` line makes its entry known whatever the traits
  let fully = false;
  let tags = false;
  let last: PackedEntry | undefined;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("#")) {
      if (out.size === 0 && line.startsWith("# pack-refs with:")) {
        const traits = line.slice("# pack-refs with:".length).split(" ");
        fully = traits.includes("fully-peeled");
        tags = traits.includes("peeled");
      }
      continue;
    }
    if (line.startsWith("^")) {
      if (last) {
        last.peeled = line.slice(1).trim().toLowerCase();
        last.known = true;
      }
      continue;
    }
    if (line.indexOf(" ") !== 40) throw new Error(`malformed packed-refs line: ${line}`);
    const name = line.slice(41);
    last = {
      id: line.slice(0, 40).toLowerCase(),
      known: fully || (tags && name.startsWith("refs/tags/")),
    };
    out.set(name, last);
  }
  return out;
}

/** git's packed-refs header (packed-backend.c `PACKED_REFS_HEADER`). */
const FULL_PACKED_HEADER = "# pack-refs with: peeled fully-peeled sorted \n";

/**
 * packed-refs as git writes it (packed-backend.c write_with_updates): with `peel`, every
 * entry whose peeled value is not known is peeled (an annotated tag gets its `^<id>` line):
 * the refs this store wrote and the entries of a file whose traits did not settle them (git
 * 2.43 peels those again; 2.5x copies them as read under its full header, which then claims
 * a peel it never wrote), under git's `peeled fully-peeled sorted` header. Without it, the
 * header claims only what holds: `peeled` while every unsettled entry is outside
 * refs/tags/, else `sorted` alone.
 */
async function serializePacked(
  entries: Map<string, PackedEntry>,
  peel?: (id: ObjectId) => Promise<ObjectId | undefined>,
): Promise<Uint8Array> {
  const names = [...entries.keys()].sort(compareRefNames);
  let full = true;
  let tags = true;
  let body = "";
  for (const name of names) {
    const e = entries.get(name) as PackedEntry;
    if (!e.known && peel) {
      const peeled = await peel(e.id as ObjectId).catch(() => undefined);
      if (peeled !== undefined && peeled !== e.id) e.peeled = peeled;
      else delete e.peeled;
      e.known = true;
    }
    if (!e.known) {
      full = false;
      if (name.startsWith("refs/tags/")) tags = false;
    }
    body += `${e.id} ${name}\n`;
    if (e.peeled) body += `^${e.peeled}\n`;
  }
  const header = full
    ? FULL_PACKED_HEADER
    : tags
      ? "# pack-refs with: peeled sorted \n"
      : "# pack-refs with: sorted \n";
  return enc.encode(header + body);
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
  packRefs(
    names: string[],
    options?: {
      all?: boolean;
      prune?: boolean;
      /** Every loose ref under one of these prefixes (`refs/tags/`: git's default) */
      prefixes?: string[];
    },
  ): Promise<void>;
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
   * Point `name` at `target` (`ref: <target>` through `writeLoose`). With a `log` message,
   * `name`'s reflog gets git's create_symref line: the id `name` resolved to before (zeros
   * if none) to the id `target` resolves to, nothing when `target` does not resolve. Tells
   * the transaction hook of the update (git 2.5x's `refs_update_symref`, `ref:<target>`).
   */
  writeSymbolic(name: string, target: string, log?: SymbolicRefLogOptions): Promise<void>;
  /**
   * Write a root ref (`isRootRefName`: ORIG_HEAD, CHERRY_PICK_HEAD, AUTO_MERGE, ...) as git's
   * refs_update_ref does, in a transaction the reference-transaction hook hears of
   * (`preparing`, `prepared`, `committed`; AUTO_MERGE for git 2.5x only): under its lock,
   * `old` (an id, or `null` for none) checked there when given, no reflog. Throws
   * `RefUpdateRejectedError` when the lock stays held or `old` does not match (`mismatch`),
   * `RefTransactionAbortedError` when the hook refuses, with nothing changed.
   */
  writeRootRef(name: string, id: ObjectId, old?: ObjectId | null): Promise<void>;
  /**
   * Delete a ref whatever its value, loose and packed, as a batch delete does: under
   * `<name>.lock` and then `packed-refs.lock`, in one pass. Removes its reflog. False if
   * there was nothing to delete. Throws `RefUpdateRejectedError` if `<name>.lock` stays
   * held, `PackedRefsLockedError` if `packed-refs.lock` does, with nothing changed.
   */
  removeRef(name: string, options?: RefRemoveOptions): Promise<boolean>;
  /**
   * Delete `names` whatever their values, as git's `delete_refs` (branch -d, tag -d, remote
   * prune): git 2.5x's refs_delete_refs, one transaction for all of them (a batch of
   * deletions: nothing deleted when one cannot be); with `legacy`, git 2.43's
   * files_delete_refs, which first drops them all from packed-refs in a transaction of the
   * packed store under packed-refs.lock (packed-refs is rewritten, created when absent),
   * then deletes each ref on its own (`removeRef`), going on past a failure. Throws once
   * done when a ref could not be deleted (`PackedRefsLockedError` before any change when
   * packed-refs.lock stays held in legacy mode, else the first failure).
   */
  removeRefs(names: string[], options?: RefRemoveAllOptions): Promise<void>;
  /**
   * Delete reflog entry `name@{index}` as git's files_reflog_expire does for `git reflog
   * delete`: under `<name>.lock` and `logs/<name>.lock`, the kept lines are written into
   * the log's lock and renamed over the log; with `updateRef` the newest kept value is
   * then committed from the ref's lock. Returns how many entries are kept. Throws
   * `ReflogEntryNotFoundError` without such an entry, `RefUpdateRejectedError` when a
   * lock stays held, with nothing changed.
   */
  deleteReflogEntry(name: string, index: number, options?: ReflogDeleteOptions): Promise<number>;
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

  /**
   * File text, or undefined if absent (also when it vanishes between the check and the
   * read), as git's files_read_raw_ref: lstat first, then read.
   *
   * An absent file reads as nothing, as an empty one does, so the check must come before
   * the read: asked only after an empty read, it would see a file another process created
   * (renamed into place) in between and take the missing ref for an empty, broken one
   * ("refs/stash is broken" while processes create refs/stash at once). An empty read
   * after the check may still be a file removed in between (or removed and created
   * again): look once more, as git goes back to its lstat when the open finds no file.
   */
  async function readText(path: string): Promise<string | undefined> {
    for (let look = 0; ; look++) {
      if (!(await files.exists(path))) return undefined;
      const text = await readOnce(path);
      if (text !== "" || look === 1) return text;
    }
  }
  /** The file's text ("" for an empty or absent file), or undefined if a read that throws finds it gone. */
  async function readOnce(path: string): Promise<string | undefined> {
    // a FilesApi that throws for an absent file is asked whether the file is there, as
    // files-staging-store
    let text = "";
    try {
      for await (const chunk of files.read(path)) text += dec.decode(chunk, { stream: true });
    } catch (e) {
      if (await files.exists(path)) throw e;
      return undefined;
    }
    return text + dec.decode();
  }
  /** As git's parse_loose_ref_contents: `ref:` with optional spaces, or an id then whitespace/end. */
  async function readLoose(name: string): Promise<Loose | undefined> {
    const text = await readText(name);
    if (text === undefined) return undefined;
    const sym = /^ref:\s*(\S+)/.exec(text);
    if (sym) return { target: sym[1] as string };
    // git's parse_oid_hex reads either case; the id is kept lowercase, as git writes it
    const m = /^([0-9a-fA-F]{40})(?:\s|$)/.exec(text);
    if (!m) throw new Error(`${name} is broken: ${JSON.stringify(text.slice(0, 50))}`);
    return { id: (m[1] as string).toLowerCase() };
  }
  const readPacked = async () => parsePacked(await readText(PACKED));
  /** The names packed-refs lists, kept with the stat data they were read at. */
  let packedNames: { size?: number; lastModified?: number; names: Set<string> } | undefined;
  /**
   * Whether packed-refs lists `name`: read again only when its size or modification time
   * changed (git's packed-refs snapshot, validated by `stat_validity_check`).
   */
  async function packedLists(name: string): Promise<boolean> {
    if (!files.stats) return (await readPacked()).has(name);
    const stats = await files.stats(PACKED);
    if (!stats) {
      packedNames = undefined;
      return false;
    }
    const valid =
      packedNames !== undefined &&
      stats.lastModified !== undefined &&
      packedNames.size === stats.size &&
      packedNames.lastModified === stats.lastModified;
    if (!valid) {
      const names = new Set((await readPacked()).keys());
      packedNames = { size: stats.size, lastModified: stats.lastModified, names };
    }
    return packedNames?.names.has(name) ?? false;
  }
  type ReadLoose = (name: string) => Promise<Loose | undefined>;
  /**
   * `readLoose` reading each file once: for one look at the refs (a plan, or the checks
   * made under the locks, where the locked refs cannot change), not across them.
   */
  const onceEach = (): ReadLoose => {
    const seen = new Map<string, Promise<Loose | undefined>>();
    return (name) => {
      let value = seen.get(name);
      if (!value) {
        value = readLoose(name);
        seen.set(name, value);
      }
      return value;
    };
  };
  async function readRef(
    name: string,
    packed: Map<string, PackedEntry>,
    read: ReadLoose = readLoose,
  ): Promise<Ref | SymbolicRef | undefined> {
    const loose = await read(name);
    if (loose && "target" in loose) {
      return { name, target: loose.target, storage: RefStorage.LOOSE };
    }
    if (loose) return { name, objectId: loose.id, storage: RefStorage.LOOSE, peeled: false };
    const e = packed.get(name);
    return e ? { name, objectId: e.id, storage: RefStorage.PACKED, peeled: false } : undefined;
  }
  /** `readRef`, falling back to `options.resolveOutside` for a ref this store does not hold. */
  async function readRefOrOutside(
    name: string,
    packed: Map<string, PackedEntry>,
    read: ReadLoose = readLoose,
  ): Promise<Ref | SymbolicRef | undefined> {
    const own = await readRef(name, packed, read);
    if (own || !options.resolveOutside) return own;
    const id = await options.resolveOutside(name);
    return id === undefined
      ? undefined
      : { name, objectId: id, storage: RefStorage.PACKED, peeled: false };
  }
  async function deref(name: string, read: ReadLoose = readLoose): Promise<string> {
    let current = name;
    for (let i = 0; i < MAX_SYMREF_READS; i++) {
      const v = await read(current);
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
    // git's lock_file_timeout: a negative timeout retries forever
    const until = timeoutMs < 0 ? Number.POSITIVE_INFINITY : Date.now() + timeoutMs;
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
   * As git: a log is created as `logAllRefUpdates` says (`autocreateReflog`) or when
   * the batch asks for it (`createReflog`), and appended to whenever it exists. Called
   * while the updated refs' locks (and HEAD's, when it records the update) are held,
   * so no other writer appends between our read of the value and our line.
   * The updated ref gets no line for a no-op and loses its log on delete; the
   * refs that record the update too (`reflogAlso`, HEAD among them) always get one.
   *
   * With `strict` (every write that is still to be committed), a line that cannot be
   * written fails the update, as git's files backend refuses to commit a ref whose log
   * write failed: the caller has not renamed any lock yet, so the refs keep their values.
   * After a commit (deletes), log writes are best effort.
   */
  async function writeLogs(
    updates: Update[],
    current: (u: Update) => ObjectId | undefined,
    o: BatchOptions,
    strict = false,
  ): Promise<void> {
    const ident = o.ident ?? defaultIdent();
    const message = normalizeMessage(o.message);
    const append = appendLog;
    for (const u of updates) {
      try {
        const old = current(u) ?? ZERO_ID;
        const next = u.newValue ?? ZERO_ID;
        const text = u.message !== undefined ? normalizeMessage(u.message) : message;
        const line = encodeGitPath(`${old} ${next} ${ident}${text ? `\t${text}` : ""}\n`);
        if (u.newValue === null) {
          if (await files.exists(`logs/${u.name}`)) await removeAndPrune(`logs/${u.name}`);
          if (o.skipReflog) continue;
        } else if (o.skipReflog) {
          continue; // git's initial transaction (clone): the refs are stored unlogged
        } else if (u.reflog) {
          // the command's own lines (a renamed ref's log), in place of this update's line
          for (const own of u.reflog) {
            const text = normalizeMessage(own.message);
            const who = own.ident ?? ident;
            const ownLine = `${own.oldId} ${own.newId} ${who}${text ? `\t${text}` : ""}\n`;
            await append(u.name, encodeGitPath(ownLine), true);
          }
        } else if (old !== u.newValue || (u.current && "target" in u.current)) {
          // a symbolic ref replaced by an id is written, so logged, even at the same id
          // (git's REF_NEEDS_COMMIT for a symref: `checkout --detach` logs `<id> <id>`)
          await append(u.name, line, o.createReflog === true);
        }
        for (const n of u.reflogAlso) await append(n, line);
      } catch (error) {
        if (strict) {
          const why = error instanceof Error ? error.message : String(error);
          throw new Error(`Unable to write the reflog of ${u.name}: ${why}`, { cause: error });
        }
        // after the commit: the ref update stands without its reflog line
      }
    }
  }
  /** The identity of a line written without one: the configured name and email, now. */
  function defaultIdent(): string {
    return `${identity.name} <${identity.email}> ${Math.floor(Date.now() / 1000)} +0000`;
  }
  /**
   * Append `line` to `name`'s reflog: created when git would create it (or with `force`),
   * else only appended to an existing log.
   */
  async function appendLog(name: string, line: Uint8Array, force = false): Promise<void> {
    const path = `logs/${name}`;
    if (!force && !autocreateReflog(name) && !(await files.exists(path))) return;
    try {
      await files.append(path, line);
    } catch (error) {
      // an empty directory where the log goes is removed, as git's log_ref_setup does
      if ((error as { code?: string })?.code !== "EISDIR") throw error;
      await files.removeEmptyDir(path);
      await files.append(path, line);
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
    read: ReadLoose = readLoose,
  ): Promise<RefRejection[]> {
    const plan = await planRefBatch(
      updates.map((u) => ({ name: u.name, new: u.newValue, noDeref: true })),
      {
        read: async (n) =>
          (await readRef(n, packed, read)) ??
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
  async function sameTargets(
    updates: Update[],
    read: ReadLoose = readLoose,
  ): Promise<RefRejection[]> {
    const out: RefRejection[] = [];
    for (const u of updates) {
      if (!u.noDeref && (await deref(u.requested, read)) !== u.name) {
        out.push({ name: u.requested, reason: "mismatch" });
      }
    }
    return out;
  }
  const mismatch = (old: ObjectId | null | undefined, current: ObjectId | undefined) =>
    old !== undefined && (old === null ? current !== undefined : current !== old);

  /** The updates of the packed store's nested transaction (see `packedPhase`). */
  function packedUpdates(names: string[]): RefTransactionUpdate[] {
    return names.map((name) => ({ requested: name, name, new: null }));
  }

  /** The updates as the transaction hook is told them. */
  function transactionUpdates(updates: Update[]): RefTransactionUpdate[] {
    return updates.map((u) => ({
      requested: u.requested,
      name: u.name,
      ...(u.old !== undefined ? { old: u.old } : {}),
      new: u.newValue,
      ...(u.viaHead ? { viaHead: true } : {}),
      ...(u.through?.length ? { through: u.through } : {}),
    }));
  }

  /**
   * The `prepared` state: a refusal is recorded in `after` (told `aborted` and thrown once
   * the locks are released, as git's ref_transaction_abort after transaction_abort).
   */
  async function prepared(
    hook: RefTransactionHook | undefined,
    updates: Update[],
    after: AfterLocks,
  ): Promise<boolean> {
    if (!hook) return true;
    const verdict = await hook("prepared", transactionUpdates(updates));
    if (verdict === false || typeof verdict === "string") {
      after.refused = new RefTransactionAbortedError("prepared", verdict || undefined);
      return false;
    }
    return true;
  }

  /**
   * What the hook is told once a batch's locks are released: `committed` after a commit
   * (ref_transaction_commit runs it after transaction_finish), `aborted` (then the throw)
   * after a refusal in `prepared`.
   */
  async function afterLocks(
    hook: RefTransactionHook | undefined,
    updates: Update[],
    after: AfterLocks,
  ): Promise<void> {
    if (!hook) return;
    if (after.refused) {
      await hook("aborted", transactionUpdates(updates));
      throw after.refused;
    }
    if (after.committed) await hook("committed", transactionUpdates(updates));
  }

  /**
   * git's nested transaction on the packed store for the deletions of a transaction
   * (files_transaction_prepare): `<zero> <zero> <ref>` lines; prepared when one of the refs
   * is packed (`preparing` and `prepared`, a refusal telling it `aborted` and throwing, as
   * git dies there), else given up at once (`aborted`). Whether it is to be committed.
   */
  async function packedPhase(
    hook: RefTransactionHook | undefined,
    names: string[],
    packed: boolean,
    only?: "2.43" | "2.56",
  ): Promise<boolean> {
    if (!hook || names.length === 0) return false;
    const told = packedUpdates(names);
    const context = { packed: true, ...(only ? { only } : {}) };
    if (!packed) {
      await hook("aborted", told, context);
      return false;
    }
    for (const state of ["preparing", "prepared"] as const) {
      const verdict = await hook(state, told, context);
      if (verdict === false || typeof verdict === "string") {
        await hook("aborted", told, context);
        throw new RefTransactionAbortedError(state, verdict || undefined);
      }
    }
    return true;
  }

  async function single(
    u: Update,
    o: BatchOptions,
    hook?: RefTransactionHook,
  ): Promise<BatchResult> {
    const after: AfterLocks = {};
    const result = await singleLocked(u, o, hook, after);
    await afterLocks(hook, [u], after);
    return result;
  }

  async function singleLocked(
    u: Update,
    o: BatchOptions,
    hook: RefTransactionHook | undefined,
    after: AfterLocks,
  ): Promise<BatchResult> {
    const content = u.newValue === null ? new Uint8Array(0) : enc.encode(`${u.newValue}\n`);
    // The refs that log this update too (HEAD, symbolic refs on the way) are locked as
    // git locks them (REF_LOG_ONLY updates), so their log lines are appended under a lock.
    const extra = [...new Set(u.reflogAlso)].filter((n) => n !== u.name);
    const held: string[] = [];
    let ours = true;
    let packedHeld = false;
    try {
      // the ref itself first, then the refs that only log the update, as git orders them
      // (a multi-ref batch takes the refs it updates in name order, then these: see there)
      for (const n of [u.name, ...extra]) {
        const r = await lock(n, refLockTimeout, n === u.name ? content : new Uint8Array(0));
        if (r !== "ok") {
          const name = n === u.name ? u.requested : n;
          return fail([{ name, reason: r === "held" ? "locked" : "df-conflict" }]);
        }
        held.push(n);
      }
      // every loose ref read once under the locks: those held cannot change meanwhile
      const read = onceEach();
      const moved = await sameTargets([u], read);
      if (moved.length) return fail(moved);
      const packed = await readPacked();
      const df = await conflicts([u], packed, new Set(held), read);
      if (df.length) return fail(df);
      const cur = await readRef(u.name, packed, read);
      // With noDeref on a symbolic ref, `old` (and the log line) use the value it resolves to, as git.
      const curId =
        cur && "target" in cur ? await resolveId(u.name) : cur ? cur.objectId : undefined;
      if (mismatch(u.old, curId)) {
        return fail([{ name: u.requested, reason: "mismatch" }]);
      }
      const deleting = u.newValue === null ? [u.name] : [];
      // a deletion locks packed-refs before the hook hears `prepared`, as
      // files_transaction_prepare: held, the packed store's transaction is given up
      // (`aborted`), the main one only freed
      if (deleting.length > 0) {
        if ((await lock(PACKED, packedLockTimeout)) !== "ok") {
          await hook?.("aborted", packedUpdates(deleting), { packed: true });
          return fail([{ name: PACKED, reason: "locked" }]);
        }
        packedHeld = true;
      }
      const packedCommit = await packedPhase(hook, deleting, packed.has(u.name));
      if (!(await prepared(hook, [u], after))) return fail([]);
      if (u.newValue === null) {
        await deleteHoldingPackedLock(u.name);
        await files.remove(`${PACKED}.lock`).catch(() => false);
        packedHeld = false;
        if (packedCommit) await hook?.("committed", packedUpdates(deleting), { packed: true });
        await writeLogs([u], () => curId, o);
      } else {
        // under the ref lock, before the rename (as git); a failed line fails the update
        await writeLogs([u], () => curId, o, true);
        if (!(await commit(u.name))) return fail([{ name: u.requested, reason: "df-conflict" }]);
        ours = false;
      }
      after.committed = true;
      return { ok: true, rejected: [] };
    } finally {
      if (packedHeld) await files.remove(`${PACKED}.lock`).catch(() => false);
      for (const n of held) if (n !== u.name || ours) await unlock(n);
    }
  }

  /**
   * As git, every delete goes through packed-refs.lock, decided on a copy re-read under
   * it: a pack-refs that holds the lock may be packing this loose ref right now. In one
   * pass under the lock: drop the ref from packed-refs if the fresh copy names it, then
   * remove the loose file, before the lock is released, so no pack-refs can copy the
   * loose value back in between. The caller holds `packed-refs.lock` (released by the
   * caller) and `<name>.lock` (or knows no loose file can exist there).
   */
  async function deleteHoldingPackedLock(
    name: string,
  ): Promise<{ packed: boolean; loose: boolean }> {
    const fresh = await readPacked();
    const packed = fresh.delete(name);
    if (packed) await commitPacked(await serializePacked(fresh, options.peel));
    const loose = await files.exists(name);
    if (loose) await removeAndPrune(name);
    return { packed, loose };
  }

  async function multi(
    updates: Update[],
    o: BatchOptions,
    hook?: RefTransactionHook,
  ): Promise<BatchResult> {
    const after: AfterLocks = {};
    const result = await multiLocked(updates, o, hook, after);
    await afterLocks(hook, updates, after);
    return result;
  }

  async function multiLocked(
    updates: Update[],
    o: BatchOptions,
    hook: RefTransactionHook | undefined,
    after: AfterLocks,
  ): Promise<BatchResult> {
    // git's files_transaction_prepare takes the locks in the transaction's order, then the
    // refs that only log an update (HEAD). Ours takes the refs it updates in name order, so
    // two batches naming the same refs in opposite orders can never each hold a lock the
    // other waits for (with core.filesRefLockTimeout < 0 they would wait forever), then the
    // log-only ones, as a single update (ours or git's) takes them after its ref. The hook's
    // lines keep the transaction's order; the ref a held lock fails on follows name order
    // when several locks are held (git reports the first held in transaction order)
    const extra = updates.flatMap((u) => u.reflogAlso);
    const own = [...new Set(updates.map((u) => u.name))];
    const names = [...new Set([...own, ...extra])];
    const lockOrder = [...[...own].sort(compareRefNames), ...names.filter((n) => !own.includes(n))];
    const deleting = updates.filter((u) => u.newValue === null).map((u) => u.name);
    const held: string[] = [];
    let packedHeld = false;
    try {
      for (const n of lockOrder) {
        const r = await lock(n, refLockTimeout);
        if (r !== "ok") {
          // the packed store's transaction, holding the deletions git would have locked
          // before this ref (those ahead of it in the transaction), given up
          const at = names.indexOf(n);
          const before = deleting.filter((d) => names.indexOf(d) < at);
          if (before.length > 0) {
            await hook?.("aborted", packedUpdates(before), { packed: true });
          }
          const name = updates.find((u) => u.name === n)?.requested ?? n;
          return fail([{ name, reason: r === "held" ? "locked" : "df-conflict" }]);
        }
        held.push(n);
      }
      // git locks packed-refs only for a transaction that deletes (files_transaction_prepare);
      // one that does not is committed through packed-refs when packed-refs.lock is free at
      // once, else loose as git commits it, so a held packed-refs.lock never fails it
      if ((await lock(PACKED, deleting.length > 0 ? packedLockTimeout : 0)) === "ok") {
        packedHeld = true;
      } else if (deleting.length > 0) {
        // the packed store's transaction of the deletions given up (files_transaction_cleanup)
        await hook?.("aborted", packedUpdates(deleting), { packed: true });
        return fail([{ name: PACKED, reason: "locked" }]);
      }
      const read = onceEach();
      const moved = await sameTargets(updates, read);
      if (moved.length) return fail(moved);
      const packed = await readPacked();
      const df = await conflicts(updates, packed, new Set(held), read);
      if (df.length) return fail(df);
      const loose = new Map<string, string>();
      const current = new Map<string, string | undefined>();
      for (const u of updates) {
        const l = await read(u.name);
        if (l && "target" in l) throw new Error(`${u.name} became a symbolic ref`);
        if (l) loose.set(u.name, l.id);
        current.set(u.name, l?.id ?? packed.get(u.name)?.id);
      }
      const mismatched = updates.filter((u) => mismatch(u.old, current.get(u.name)));
      if (mismatched.length) {
        return fail(mismatched.map((u) => ({ name: u.requested, reason: "mismatch" as const })));
      }
      const packedCommit = await packedPhase(
        hook,
        deleting,
        deleting.some((n) => packed.has(n)),
      );
      if (!(await prepared(hook, updates, after))) return fail([]);
      const at = (u: Update) => current.get(u.name);
      if (!packedHeld) {
        // git's commit of a transaction without deletions: each new value written into its
        // lock (with the log lines, before any rename: a line that cannot be written fails
        // the batch with every ref unchanged), then each lock renamed over its ref
        await writeLogs(updates, at, o, true);
        for (const u of updates) {
          await files.write(`${u.name}.lock`, enc.encode(`${u.newValue}\n`));
        }
        for (const u of updates) {
          if (!(await commit(u.name))) return fail([{ name: u.requested, reason: "df-conflict" }]);
          held.splice(held.indexOf(u.name), 1);
        }
        after.committed = true;
        return { ok: true, rejected: [] };
      }
      if (deleting.length === updates.length) {
        // only deletions, as git commits them: packed-refs rewritten when it names one of
        // them, then the loose files removed, all before packed-refs.lock is released
        const fresh = await readPacked();
        let dropped = false;
        for (const n of deleting) dropped = fresh.delete(n) || dropped;
        if (dropped) await commitPacked(await serializePacked(fresh, options.peel));
        for (const n of deleting) if (await files.exists(n)) await removeAndPrune(n);
      } else {
        if (loose.size) {
          // Phase 1: move the involved loose refs into packed-refs (values unchanged for
          // readers), committing packed-refs BEFORE removing the loose files.
          for (const [n, v] of loose) {
            const prev = packed.get(n);
            packed.set(n, prev?.id === v ? prev : { id: v });
          }
          // packed-refs.lock stays held: no other writer runs between the phases.
          await commitPacked(await serializePacked(packed, options.peel));
          for (const n of loose.keys()) await removeAndPrune(n);
        }
        // The log lines of the refs still to be committed, before the commit: a line that
        // cannot be written fails the batch with every ref unchanged (as git).
        await writeLogs(
          updates.filter((u) => u.newValue !== null),
          at,
          o,
          true,
        );
        // Phase 2: the whole batch in one rename.
        for (const u of updates) {
          if (u.newValue === null) packed.delete(u.name);
          else packed.set(u.name, { id: u.newValue });
        }
        await commitPacked(await serializePacked(packed, options.peel));
      }
      if (packedCommit) await hook?.("committed", packedUpdates(deleting), { packed: true });
      await files.remove(`${PACKED}.lock`);
      packedHeld = false;
      await writeLogs(
        updates.filter((u) => u.newValue === null),
        at,
        o,
      );
      after.committed = true;
      return { ok: true, rejected: [] };
    } finally {
      if (packedHeld) await files.remove(`${PACKED}.lock`).catch(() => false);
      for (const n of held) await unlock(n);
    }
  }

  /** The id `name` resolves to (through symbolic refs), as `old` is compared with it. */
  async function resolveId(name: string): Promise<ObjectId | undefined> {
    const packed = await readPacked();
    const ref = await readRefOrOutside(await deref(name), packed);
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
   * As git's files_pack_refs (`files_optimize`) and JGit's RefDirectory.pack: the loose refs
   * are read and packed-refs is written under packed-refs.lock; only then is each packed
   * loose ref removed, under its own lock and only if it still holds the packed value, so a
   * ref updated meanwhile stays loose with its new value.
   *
   * The reference-transaction hook hears what git's runs: the packed store's transaction
   * (`<zero> <id> <ref>` for every loose ref packed, in name order, run even when there is
   * none), then one transaction per pruned ref (`<id> <zero> <ref>`, in reverse name order,
   * git's `refs_to_prune` stack). A refusal tells the hook `aborted` and throws
   * {@link RefTransactionAbortedError}, as git dies there: nothing packed after it, no ref
   * pruned.
   */
  async function packRefs(
    names: string[],
    o: { all?: boolean; prune?: boolean; prefixes?: string[] } = {},
  ): Promise<void> {
    const packedNow = new Map<string, string>();
    const hook = options.transactionHook?.();
    let told: RefTransactionUpdate[] = [];
    const r = await withPackedLock(async (commit) => {
      const packed = await readPacked();
      const wanted =
        o.all || o.prefixes
          ? (await looseRefNames()).filter(
              (n) => o.all || (o.prefixes ?? []).some((prefix) => n.startsWith(prefix)),
            )
          : names;
      for (const n of [...new Set(wanted)].sort(compareRefNames)) {
        // git keeps per-worktree refs loose (refs/bisect/, refs/worktree/, refs/rewritten/)
        if (/^refs\/(bisect|worktree|rewritten)\//.test(n)) continue;
        // absent, broken (git's iteration skips those) or symbolic (git keeps symrefs loose)
        const l = await readLoose(n).catch(() => undefined);
        if (!l || "target" in l) continue;
        const prev = packed.get(n);
        packed.set(n, prev?.id === l.id ? prev : { id: l.id });
        packedNow.set(n, l.id);
      }
      told = [...packedNow].map(([name, id]) => ({ requested: name, name, new: id }));
      if (hook) {
        for (const state of ["preparing", "prepared"] as const) {
          const verdict = await hook(state, told, { packed: true });
          if (verdict === false || typeof verdict === "string") {
            await hook("aborted", told, { packed: true });
            throw new RefTransactionAbortedError(state, verdict || undefined);
          }
        }
      }
      if (packedNow.size) await commit(await serializePacked(packed, options.peel));
    });
    if (r === "held") throw new PackedRefsLockedError(packedLockTimeout);
    await hook?.("committed", told, { packed: true });
    if (!o.prune) return;
    for (const [n, id] of [...packedNow].reverse()) {
      const update: RefTransactionUpdate[] = [{ requested: n, name: n, old: id, new: null }];
      const refuse = async (state: "preparing" | "prepared", verdict: false | string) => {
        await hook?.("aborted", update);
        throw new RefTransactionAbortedError(state, verdict || undefined);
      };
      const preparing = hook ? await hook("preparing", update) : undefined;
      if (preparing === false || typeof preparing === "string")
        await refuse("preparing", preparing);
      // A ref someone is updating right now keeps its loose file (git fails to prune it).
      if ((await lock(n, refLockTimeout)) !== "ok") continue;
      let verdict: boolean | string | undefined;
      try {
        verdict = hook ? await hook("prepared", update) : undefined;
        if (verdict !== false && typeof verdict !== "string") {
          const l = await readLoose(n).catch(() => undefined);
          if (l && "id" in l && l.id === id) await files.remove(n);
        }
      } finally {
        await unlock(n); // also prunes the directories the removal emptied
      }
      if (verdict === false || typeof verdict === "string") await refuse("prepared", verdict);
      await hook?.("committed", update);
    }
  }

  /** Loose refs under refs/ (lock files skipped). */
  async function looseRefNames(): Promise<string[]> {
    const out: string[] = [];
    for await (const p of files.list("refs")) if (!p.endsWith(".lock")) out.push(p);
    return out;
  }

  const batch = (commands: RefCommand[], batchOptions: BatchOptions = {}) =>
    batchAs(commands, batchOptions);

  /**
   * `batch`; `requestedAs`: the symbolic root ref the one command was asked of (see there),
   * `through` the symbolic refs between it and the ref written.
   */
  const batchAs = async (
    commands: RefCommand[],
    batchOptions: BatchOptions,
    requestedAs?: string,
    through: string[] = [],
  ): Promise<BatchResult> => {
    if (commands.length === 0) {
      const hook = batchOptions.emptyTransaction ? options.transactionHook?.() : undefined;
      if (hook) {
        for (const state of ["preparing", "prepared"] as const) {
          const verdict = await hook(state, []);
          if (verdict === false || typeof verdict === "string") {
            await hook("aborted", []);
            throw new RefTransactionAbortedError(state, verdict || undefined);
          }
        }
        await hook("committed", []);
      }
      return { ok: true, rejected: [] };
    }
    // a root ref (ORIG_HEAD, ...) written on its own, as git's refs_update_ref writes it; a
    // symbolic one naming a ref under refs/ (unless replaced) is written through to that ref,
    // the hook told the root ref asked for, as git splits a symbolic ref's update
    const only = commands.length === 1 ? commands[0] : undefined;
    const rootTarget =
      only && !only.noDeref && isRootRefName(only.name)
        ? await symbolicTarget(only.name)
        : undefined;
    // (through further symbolic refs: an ORIG_HEAD naming HEAD writes HEAD's branch)
    const throughTo =
      rootTarget === undefined ? undefined : await deref(rootTarget).catch(() => rootTarget);
    if (only && rootTarget !== undefined && throughTo?.startsWith("refs/")) {
      const through: string[] = [];
      for (let n: string | undefined = rootTarget; n && n !== throughTo; ) {
        through.push(n);
        n = await symbolicTarget(n);
      }
      return batchAs([{ ...only, name: throughTo }], batchOptions, only.name, through);
    }
    if (only && only.new !== null && isRootRefName(only.name) && isRefObjectId(only.new)) {
      try {
        await writeRootRef(only.name, only.new, only.old);
        return { ok: true, rejected: [] };
      } catch (error) {
        if (error instanceof RefUpdateRejectedError) return fail(error.rejected);
        throw error;
      }
    }
    // Plan without locks: names, policy, D/F conflicts and old values (all re-checked under the locks).
    const packed = await readPacked();
    const read = onceEach();
    const plan = await planRefBatch(commands, {
      read: (name) => readRefOrOutside(name, packed, read),
      hasChildren: async (name) => {
        for (const k of packed.keys()) if (k.startsWith(`${name}/`)) return true;
        for await (const p of files.list(name)) if (!p.endsWith(".lock")) return true;
        return false;
      },
    });
    if (!plan.ok) return fail(plan.rejected);
    const updates: Update[] = plan.updates.map((u, i) => ({
      ...u,
      ...(requestedAs !== undefined ? { requested: requestedAs } : {}),
      ...(options.logHeadUpdates === false && u.name !== "HEAD"
        ? { reflogAlso: u.reflogAlso.filter((n) => n !== "HEAD") }
        : {}),
      old: commands[i]?.old,
      noDeref: commands[i]?.noDeref === true,
      viaHead:
        u.requested !== "HEAD" &&
        !through.includes("HEAD") &&
        u.name !== "HEAD" &&
        u.reflogAlso.includes("HEAD"),
      ...(through.length ? { through } : {}),
    }));
    if (updates.length > 1) {
      // Replacing a symbolic ref (noDeref) cannot join the packed-refs commit: its loose
      // file would shadow the packed value. git can; this store refuses it as a whole.
      const symrefs = updates.filter((u) => u.current && "target" in u.current);
      if (symrefs.length) {
        return fail(updates.map((u) => ({ name: u.requested, reason: "unsupported" as const })));
      }
    }
    // the reference-transaction hook: `preparing` before any lock
    const hook = options.transactionHook?.();
    const verdict = hook ? await hook("preparing", transactionUpdates(updates)) : undefined;
    if (verdict === false || typeof verdict === "string") {
      // ref_transaction_abort tells the hook whatever the state
      await hook?.("aborted", transactionUpdates(updates));
      throw new RefTransactionAbortedError("preparing", verdict || undefined);
    }
    return updates.length === 1
      ? single(updates[0] as Update, batchOptions, hook)
      : multi(updates, batchOptions, hook);
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

  async function writeLoose(
    name: string,
    content: string,
    /** Run once the lock is held and checked, before the rename; throwing gives the write up */
    beforeCommit?: () => Promise<void>,
  ): Promise<void> {
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
      await beforeCommit?.();
      if (!(await commit(name)))
        throw new RefUpdateRejectedError([{ name, reason: "df-conflict" }]);
      ours = false;
    } finally {
      if (ours) await unlock(name);
    }
  }

  /**
   * A symbolic ref written as git 2.5x's `refs_update_symref`: one update in a transaction
   * of its own (`<zero> ref:<target> <ref>`, no old value) told to the hook as `preparing`
   * before the lock, `prepared` under it, `committed` once it is released and the reflog
   * line written; a refusal gives the write up (`aborted`, then the throw). git 2.43 writes
   * symbolic refs outside any transaction, so the calls are marked `only: "2.56"`.
   */
  async function writeSymbolic(
    name: string,
    target: string,
    log?: SymbolicRefLogOptions,
  ): Promise<void> {
    const hook = options.transactionHook?.();
    const told: RefTransactionUpdate[] = [{ requested: name, name, new: null, newTarget: target }];
    const context = { only: "2.56" as const };
    const refusal = (state: "preparing" | "prepared", verdict: unknown) =>
      verdict === false || typeof verdict === "string"
        ? new RefTransactionAbortedError(state, verdict || undefined)
        : undefined;
    if (hook) {
      const refused = refusal("preparing", await hook("preparing", told, context));
      if (refused) {
        await hook("aborted", told, context);
        throw refused;
      }
    }
    const logged = log !== undefined && (log.message !== undefined || Boolean(log.reflog));
    // git's create_symref: the old value is what `name` resolved to before the write
    const old = logged && !log?.reflog ? await resolveId(name).catch(() => undefined) : undefined;
    let refused: RefTransactionAbortedError | undefined;
    try {
      await writeLoose(
        name,
        `ref: ${target}\n`,
        hook
          ? async () => {
              refused = refusal("prepared", await hook("prepared", told, context));
              if (refused) throw refused;
            }
          : undefined,
      );
    } catch (error) {
      if (hook && refused) await hook("aborted", told, context);
      throw error;
    }
    if (logged && log) {
      // an unborn target: git logs nothing
      const next = log.reflog ? undefined : await resolveId(target).catch(() => undefined);
      const ident = log.ident ?? defaultIdent();
      for (const w of symrefReflogWrites(name, old, next, { ...log, ident })) {
        if (w.op !== "append") continue;
        const { oldId, newId, message } = w.line;
        const line = `${oldId} ${newId} ${w.line.ident}${message ? `\t${message}` : ""}\n`;
        // after the commit, as git's files_create_symref: the ref stands without its line
        await appendLog(name, encodeGitPath(line), w.create && Boolean(log.reflog)).catch(() => {});
      }
    }
    if (hook) await hook("committed", told, context);
  }

  /** The ref the loose file of `name` names when it is a symbolic ref (`ref: ...`). */
  async function symbolicTarget(name: string): Promise<string | undefined> {
    const loose = await readLoose(name).catch(() => undefined);
    return loose && "target" in loose ? loose.target : undefined;
  }

  async function writeRootRef(name: string, id: ObjectId, old?: ObjectId | null): Promise<void> {
    const hook = rootRefHook(options.transactionHook?.(), name);
    const told: RefTransactionUpdate[] = [
      { requested: name, name, ...(old !== undefined ? { old } : {}), new: id },
    ];
    const refusal = async (state: "preparing" | "prepared", verdict: unknown) => {
      if (verdict !== false && typeof verdict !== "string") return undefined;
      return new RefTransactionAbortedError(state, verdict || undefined);
    };
    if (hook) {
      const refused = await refusal("preparing", await hook("preparing", told));
      if (refused) {
        await hook("aborted", told);
        throw refused;
      }
    }
    const r = await lock(name, refLockTimeout, enc.encode(`${id}\n`));
    if (r !== "ok") {
      throw new RefUpdateRejectedError([{ name, reason: r === "held" ? "locked" : "df-conflict" }]);
    }
    let ours = true;
    let refused: RefTransactionAbortedError | undefined;
    try {
      if (old !== undefined) {
        // checked under the lock (lock_ref_for_update): a mismatch fails before `prepared`
        const current = await readLoose(name).catch(() => undefined);
        if (mismatch(old, current && "id" in current ? current.id : undefined)) {
          throw new RefUpdateRejectedError([{ name, reason: "mismatch" }]);
        }
      }
      refused = hook ? await refusal("prepared", await hook("prepared", told)) : undefined;
      if (!refused) {
        if (!(await commit(name))) {
          throw new RefUpdateRejectedError([{ name, reason: "df-conflict" }]);
        }
        ours = false;
      }
    } finally {
      if (ours) await unlock(name);
    }
    if (hook) {
      if (refused) {
        await hook("aborted", told);
        throw refused;
      }
      await hook("committed", told);
    }
  }

  async function removeRef(name: string, o: RefRemoveOptions = {}): Promise<boolean> {
    // the reference-transaction hook for the refs git deletes in a transaction (refs/... and
    // the root refs): `<zero> <zero> <ref>`, no old value (delete_ref and delete_refs give none)
    const hook =
      name.startsWith("refs/") || isRootRefName(name)
        ? rootRefHook(options.transactionHook?.(), name)
        : undefined;
    if (!hook && isRootRefName(name) && !(await packedLists(name))) {
      // a root ref (AUTO_MERGE, CHERRY_PICK_HEAD, ...) git never packs: without a hook to
      // tell of git's nested packed-refs transaction, unlinked under its own lock, with no
      // packed-refs.lock taken and packed-refs read only when its stat data changed (as
      // every commit, reset and checkout deletes some). One packed-refs lists all the same
      // (git reads and deletes those) goes the whole way below.
      const r = await lock(name, refLockTimeout);
      if (r === "held") throw new RefUpdateRejectedError([{ name, reason: "locked" }]);
      try {
        const loose = await files.exists(name);
        if (loose) await removeAndPrune(name);
        if (await files.exists(`logs/${name}`)) {
          await removeAndPrune(`logs/${name}`).catch(() => {});
        }
        return loose;
      } finally {
        if (r === "ok") await unlock(name);
      }
    }
    const told = packedUpdates([name]);
    // packed-refs.lock found held: git 2.43's delete_refs gives up before any hook runs
    let packedBusy = false;
    if (hook && o.deleteRefs) {
      // git 2.43's files_delete_refs: the packed store's own transaction first, under
      // packed-refs.lock (released before the loose refs go)
      if ((await lock(PACKED, packedLockTimeout)) !== "ok") packedBusy = true;
      else {
        try {
          for (const state of ["prepared", "committed"] as const) {
            const verdict = await hook(state, told, { packed: true, only: "2.43" });
            if (state === "prepared" && (verdict === false || typeof verdict === "string")) {
              await hook("aborted", told, { packed: true, only: "2.43" });
              throw new RefTransactionAbortedError("prepared", verdict || undefined);
            }
          }
        } finally {
          await files.remove(`${PACKED}.lock`).catch(() => false);
        }
      }
    }
    if (hook) {
      const verdict = await hook("preparing", told);
      if (verdict === false || typeof verdict === "string") {
        await hook("aborted", told);
        throw new RefTransactionAbortedError("preparing", verdict || undefined);
      }
    }
    // a held lock fails the deletion with the hook told no more of the transaction (git
    // frees it without ref_transaction_abort), only the packed store's given up
    const after: AfterLocks = {};
    const r = await lock(name, refLockTimeout);
    if (r === "held") throw new RefUpdateRejectedError([{ name, reason: "locked" }]);
    // "conflict": a file where a parent directory would be, so no loose file at `name`
    let removed = false;
    let packedHeld = false;
    try {
      // packed-refs.lock taken before the hook hears `prepared` (files_transaction_prepare)
      if (packedBusy || (await lock(PACKED, packedLockTimeout)) !== "ok") {
        await hook?.("aborted", told, {
          packed: true,
          ...(o.deleteRefs ? { only: "2.56" as const } : {}),
        });
        throw new PackedRefsLockedError(packedLockTimeout);
      }
      packedHeld = true;
      let packedCommit = false;
      if (hook) {
        const inPacked = (await readPacked()).has(name);
        if (o.deleteRefs) {
          // 2.43 deleted it from packed-refs already: its nested transaction is not needed
          await packedPhase(hook, [name], false, "2.43");
          packedCommit = await packedPhase(hook, [name], inPacked, "2.56");
        } else packedCommit = await packedPhase(hook, [name], inPacked);
        const verdict = await hook("prepared", told);
        if (verdict === false || typeof verdict === "string") {
          after.refused = new RefTransactionAbortedError("prepared", verdict || undefined);
        }
      }
      if (!after.refused) {
        const d = await deleteHoldingPackedLock(name);
        await files.remove(`${PACKED}.lock`).catch(() => false);
        packedHeld = false;
        if (packedCommit) {
          await hook?.("committed", told, {
            packed: true,
            ...(o.deleteRefs ? { only: "2.56" as const } : {}),
          });
        }
        removed = d.packed || d.loose;
        // as git: the log goes too (also of a ref git 2.43's delete_refs unpacked already)
        if (await files.exists(`logs/${name}`)) {
          await removeAndPrune(`logs/${name}`).catch(() => {});
        }
        after.committed = true;
      }
    } finally {
      if (packedHeld) await files.remove(`${PACKED}.lock`).catch(() => false);
      if (r === "ok") await unlock(name);
    }
    if (hook) {
      if (after.refused) {
        await hook("aborted", told);
        throw after.refused;
      }
      await hook("committed", told);
    }
    return removed;
  }

  async function removeRefs(names: string[], o: RefRemoveAllOptions = {}): Promise<void> {
    const unique = [...new Set(names)];
    if (unique.length === 0) return;
    /** Each ref deleted on its own, going on past a failure; the first one thrown at the end */
    const eachOnItsOwn = async () => {
      let first: unknown;
      for (const name of unique) {
        try {
          await removeRef(name);
        } catch (error) {
          first ??= error;
        }
      }
      if (first !== undefined) throw first;
    };
    if (!o.legacy) {
      // refs_delete_refs: one transaction deleting them all, no old values checked
      const result = await batch(
        unique.map((name) => ({ name, new: null, noDeref: true })),
        o.message !== undefined ? { message: o.message } : {},
      );
      if (result.ok) return;
      // a symbolic ref among several cannot join the batch (see `batch`)
      if (result.rejected.length > 0 && result.rejected.every((r) => r.reason === "unsupported")) {
        return eachOnItsOwn();
      }
      if (result.rejected.some((r) => r.name === PACKED)) {
        throw new PackedRefsLockedError(packedLockTimeout);
      }
      throw new RefUpdateRejectedError(result.rejected);
    }
    // git 2.43's files_delete_refs: the packed store's transaction first, under
    // packed-refs.lock (a held lock fails the whole deletion before any hook runs); it
    // rewrites packed-refs whatever it holds
    const hook = options.transactionHook?.();
    if ((await lock(PACKED, packedLockTimeout)) !== "ok") {
      throw new PackedRefsLockedError(packedLockTimeout);
    }
    try {
      const told = packedUpdates(unique);
      const verdict = await hook?.("prepared", told, { packed: true });
      if (verdict === false || typeof verdict === "string") {
        await hook?.("aborted", told, { packed: true });
        throw new RefTransactionAbortedError("prepared", verdict || undefined);
      }
      const fresh = await readPacked();
      for (const name of unique) fresh.delete(name);
      await commitPacked(await serializePacked(fresh, options.peel));
      await hook?.("committed", told, { packed: true });
    } finally {
      await files.remove(`${PACKED}.lock`).catch(() => false);
    }
    // then each ref in a transaction of its own (refs_delete_ref)
    return eachOnItsOwn();
  }

  async function deleteReflogEntry(
    name: string,
    index: number,
    o: ReflogDeleteOptions = {},
  ): Promise<number> {
    const log = `logs/${name}`;
    const r = await lock(name, refLockTimeout);
    if (r !== "ok") {
      throw new RefUpdateRejectedError([{ name, reason: r === "held" ? "locked" : "df-conflict" }]);
    }
    let refLockOurs = true;
    let logLockHeld = false;
    try {
      // no log, no entry: refused before logs/<name>.lock (and its directories) exist
      if (!(await files.exists(log))) throw new ReflogEntryNotFoundError(name, index);
      const lr = await lock(log, refLockTimeout);
      if (lr !== "ok") {
        throw new RefUpdateRejectedError([
          { name: log, reason: lr === "held" ? "locked" : "df-conflict" },
        ]);
      }
      logLockHeld = true;
      const text = (await readText(log)) ?? "";
      // Entries are the lines the reader accepts (parseReflogLine), so `index` names the
      // entry `name@{index}` lists; lines it rejects are dropped, as git's expire does.
      const lines = text
        .split("\n")
        .filter((l) => l !== "" && parseReflogLine(l) !== undefined)
        .map((l) => ({ oldId: l.slice(0, 40), newId: l.slice(41, 81), rest: l.slice(81) }));
      const kept = deleteReflogLine(lines, index, o.rewrite);
      if (!kept) throw new ReflogEntryNotFoundError(name, index);
      const out = kept.map((l) => `${l.oldId} ${l.newId}${l.rest}\n`).join("");
      await files.write(`${log}.lock`, enc.encode(out)); // ours: we hold the lock
      // git: the ref is updated only when an entry is kept and the ref is not symbolic
      const top = kept.at(-1);
      let updateRef = false;
      if (o.updateRef && top) {
        const current = await readLoose(name).catch(() => undefined);
        if (!current || !("target" in current)) {
          await files.write(`${name}.lock`, enc.encode(`${top.newId}\n`));
          updateRef = true;
        }
      }
      await files.replace(`${log}.lock`, log);
      logLockHeld = false;
      if (updateRef) {
        if (!(await commit(name)))
          throw new RefUpdateRejectedError([{ name, reason: "df-conflict" }]);
        refLockOurs = false;
      }
      return kept.length;
    } finally {
      if (logLockHeld) await files.remove(`${log}.lock`).catch(() => false);
      if (refLockOurs) await unlock(name);
    }
  }

  return {
    batch,
    updatePackedRefs,
    packRefs,
    sweepTemporaries,
    writeLoose,
    writeSymbolic,
    writeRootRef,
    removeRef,
    removeRefs,
    deleteReflogEntry,
  };
}
