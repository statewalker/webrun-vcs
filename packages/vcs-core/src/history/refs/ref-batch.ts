/**
 * Atomic ref batches: the command shape every `Refs` implementation accepts,
 * and the backend-independent planning that checks a batch as
 * `git update-ref --stdin` does (checked against git 2.43).
 *
 * A backend reads a consistent view of its refs, calls `planRefBatch`, and
 * applies the planned updates atomically (or reports the rejections).
 */
import type { ObjectId } from "../../common/id/index.js";
import { isValidRefName } from "./ref-name.js";
import { isSymbolicRef, type Ref, type SymbolicRef } from "./ref-types.js";

/**
 * One command of a batch.
 *
 * - `old`: `undefined` = do not check, `null` = the ref must not exist, an id =
 *   the ref must currently hold it.
 * - `new`: an id, or `null` to delete the ref.
 * - `noDeref`: update `name` itself even if it is a symbolic ref (git
 *   `update-ref --no-deref`); for HEAD this detaches it.
 */
export interface RefCommand {
  name: string;
  old?: ObjectId | null;
  new: ObjectId | null;
  noDeref?: boolean;
  /**
   * The reflog lines to write for this ref, oldest first, in place of the line the
   * update would write (git's `ref_transaction_update_reflog`, as `git remote rename`
   * carries a renamed ref's log over). The log is created whatever the ref's name; a
   * line without `ident` takes the batch's (or the store's default) identity.
   *
   * @example
   * ```typescript
   * const line = { oldId: zero, newId: id, ident: "A <a@b> 1700000000 +0000", message: "fetch" };
   * await refs.batch([
   *   { name: "refs/remotes/old/main", new: null },
   *   { name: "refs/remotes/new/main", old: null, new: id, reflog: [line] },
   * ]);
   * ```
   */
  reflog?: OwnReflogLine[];
  /**
   * This update's reflog message, in place of the batch's (git gives each update of a
   * transaction its own: an atomic `git fetch` logs `storing head` for a new branch and
   * `fast-forward` for another in the same transaction). Also used for the lines of the
   * refs that record the update (`HEAD`).
   */
  message?: string;
}

/** A reflog line a {@link RefCommand} brings; without `ident`, the batch's identity. */
export type OwnReflogLine = Omit<ReflogLine, "ident"> & { ident?: string };

/** Why a batch was refused. */
export type RefRejectReason =
  /** The ref's current value differs from the command's `old`. */
  | "mismatch"
  /** Another writer holds the ref (or the store gave up retrying). */
  | "locked"
  /** Not `HEAD` and not a valid name under `refs/`. */
  | "invalid-name"
  /** A ref and a ref below it (`refs/a` and `refs/a/b`) would both exist. */
  | "df-conflict"
  /** The same ref named twice in one batch. */
  | "duplicate"
  /** A malformed command, such as a delete whose `old` says "must not exist". */
  | "invalid-command"
  /** A value to write (`new`) that is no full hex object id (git's "not a valid SHA1"). */
  | "invalid-object-id"
  /**
   * A name outside `refs/` (a detached HEAD) in a multi-ref batch. This is a
   * project policy, not git's rule: on git files such a ref cannot be committed
   * atomically with packed refs, so every backend refuses it alike.
   */
  | "not-atomic"
  /** The store cannot apply this batch atomically yet (interim stores). */
  | "unsupported";

export interface RefRejection {
  name: string;
  reason: RefRejectReason;
}

/** `ok` with no rejections when every command applied; otherwise nothing applied. */
export interface BatchResult {
  ok: boolean;
  rejected: RefRejection[];
}

/**
 * The reflog line of one ref update (git's `logmsg` and `git_committer_info`), for stores
 * that keep a reflog; others ignore it.
 */
export interface RefLogOptions {
  /** git identity with time: "Name <email> 1700000000 +0000" (default: the store's own). */
  ident?: string;
  /** The line's message, e.g. "commit: Add feature" (whitespace runs collapse to one space). */
  message?: string;
}

/**
 * The reflog of a symbolic ref set with {@link Refs.setSymbolic}: git's `create_symref`
 * line (`message`, `ident`), or the lines given.
 */
export interface SymbolicRefLogOptions extends RefLogOptions {
  /**
   * The lines to write, oldest first, in place of the create_symref line (git's
   * `ref_transaction_update_reflog`: `git remote rename` carries a symbolic ref's log over
   * to its new name). The log is created whatever the ref's name; a line without `ident`
   * takes `ident` (or the store's default identity).
   */
  reflog?: OwnReflogLine[];
}

/** Reflog details for stores that keep a reflog; others ignore them. */
export interface BatchOptions extends RefLogOptions {
  /**
   * Create the reflog of every updated ref, even one the store would not log by
   * default (git's REF_FORCE_CREATE_REFLOG: `git stash` logs `refs/stash` this way,
   * and `git update-ref --create-reflog`). An existing reflog is appended to anyway.
   */
  createReflog?: boolean;
  /**
   * Write no reflog line for this batch (git's initial ref transaction: `git clone` stores
   * the remote's refs without logging them). A deleted ref still loses its log.
   */
  skipReflog?: boolean;
  /**
   * A batch with no command still runs as a transaction its reference-transaction hook is
   * told about (`preparing`, `prepared`, `committed` with no line): git 2.5x's receive-pack
   * commits the transaction of a phase whose every update was refused
   */
  emptyTransaction?: boolean;
}

/** A consistent view of a store's refs, read while planning one batch. */
export interface RefBatchView {
  read(name: string): Promise<Ref | SymbolicRef | undefined> | Ref | SymbolicRef | undefined;
  /** Whether any ref exists below `name/`. */
  hasChildren(name: string): Promise<boolean> | boolean;
}

/** One write a planned batch makes. */
export interface PlannedRefUpdate {
  /** The ref written: the command's name, or the target it dereferenced to. */
  name: string;
  /** The name the command gave. */
  requested: string;
  /** What `name` held before the batch, as read (a symbolic ref when `noDeref` names one). */
  current: Ref | SymbolicRef | undefined;
  /** The id the command's `old` was compared with: `name`'s value, through symbolic refs. */
  oldValue: ObjectId | undefined;
  /** The value after the batch; `null` deletes the ref. */
  newValue: ObjectId | null;
  /**
   * Other refs whose reflogs record this update, as git logs them: the symbolic
   * refs the command went through, and HEAD when it points at `name`.
   */
  reflogAlso: string[];
  /** The command's own reflog lines ({@link RefCommand.reflog}), written instead of the default one. */
  reflog?: OwnReflogLine[];
  /** The command's own message ({@link RefCommand.message}), in place of the batch's. */
  message?: string;
}

export type RefBatchPlan =
  | { ok: true; updates: PlannedRefUpdate[] }
  | { ok: false; rejected: RefRejection[] };

/**
 * At most 5 refs are read along a symbolic-ref chain (4 symbolic refs and the
 * ref they end at), git's SYMREF_MAXDEPTH for reading refs. git's update-ref
 * follows longer chains on some backends; this is a project limit for updates.
 */
const MAX_SYMREF_READS = 5;

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Control characters (a newline would start a forged reflog line). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are the point
const CONTROL = /[\u0000-\u001f\u007f]+/g;

/** An own reflog line has object ids and, if any, an identity of the git shape. */
function validOwnLine(line: OwnReflogLine): boolean {
  if (!OBJECT_ID.test(line.oldId) || !OBJECT_ID.test(line.newId)) return false;
  if (line.ident === undefined) return true;
  const ident = line.ident.replace(CONTROL, " ").trim();
  return /^[^<>]*<[^<>]*> \d+ [+-]\d{4}$/.test(ident);
}

/** Control characters in the identity and message collapse to one space, as git's copy_reflog_msg. */
function sanitizeOwnLine(line: OwnReflogLine): OwnReflogLine {
  return {
    oldId: line.oldId,
    newId: line.newId,
    message: line.message.replace(CONTROL, " ").replace(/\s+/g, " ").trim(),
    ...(line.ident !== undefined
      ? { ident: line.ident.replace(CONTROL, " ").replace(/ +/g, " ").trim() }
      : {}),
  };
}

/**
 * Whether `value` may be written as a ref's direct value: a full lowercase hex object id
 * (SHA-1, the one object format the stores read). A name (`main`) written there leaves a ref no git can read, `HEAD`
 * holding `main\n` is no repository to git at all, so every ref store refuses it.
 *
 * @example
 * ```typescript
 * isRefObjectId("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"); // true
 * isRefObjectId("main"); // false
 * ```
 */
export function isRefObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

/** Names a batch may update: `HEAD`, or a valid name under `refs/`. */
export function isUpdatableRefName(name: string): boolean {
  return name === "HEAD" || (name.startsWith("refs/") && isValidRefName(name));
}

function ancestors(name: string): string[] {
  const parts = name.split("/");
  const out: string[] = [];
  for (let i = 2; i < parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

/**
 * Check `commands` against `view` and return the updates to apply, or why the
 * batch is refused. The view must not change until the updates are applied.
 *
 * @example
 * ```typescript
 * const plan = await planRefBatch(commands, { read: (n) => map.get(n), hasChildren });
 * if (!plan.ok) return { ok: false, rejected: plan.rejected };
 * for (const u of plan.updates) apply(u.name, u.newValue);
 * ```
 */
export async function planRefBatch(
  commands: RefCommand[],
  view: RefBatchView,
): Promise<RefBatchPlan> {
  const reject = (rejected: RefRejection[]): RefBatchPlan => ({ ok: false, rejected });

  // Names, duplicates and malformed commands, before dereferencing.
  const early: RefRejection[] = [];
  const seen = new Set<string>();
  for (const c of commands) {
    if (!isUpdatableRefName(c.name)) early.push({ name: c.name, reason: "invalid-name" });
    else if (seen.has(c.name)) early.push({ name: c.name, reason: "duplicate" });
    else if (c.new === null && c.old === null) {
      early.push({ name: c.name, reason: "invalid-command" });
    } else if (c.new !== null && !isRefObjectId(c.new)) {
      early.push({ name: c.name, reason: "invalid-object-id" });
    } else if (c.reflog && (c.new === null || !c.reflog.every(validOwnLine))) {
      // own reflog lines: on a written ref only, with object ids and an identity
      early.push({ name: c.name, reason: "invalid-command" });
    }
    seen.add(c.name);
  }
  if (early.length) return reject(early);

  // Dereference symbolic refs and read current values.
  const follow = async (start: string) => {
    const chain: string[] = [];
    let name = start;
    let ref = await view.read(name);
    while (ref && isSymbolicRef(ref)) {
      if (chain.length === MAX_SYMREF_READS - 1) return undefined; // too deep
      chain.push(name);
      name = ref.target;
      ref = await view.read(name);
    }
    return { name, ref, chain };
  };
  const head = await view.read("HEAD");
  const headTarget = head && isSymbolicRef(head) ? (await follow("HEAD"))?.name : undefined;
  const updates: PlannedRefUpdate[] = [];
  for (const c of commands) {
    const end = await follow(c.name);
    if (!end) return reject([{ name: c.name, reason: "invalid-command" }]);
    let name = end.name;
    let current: Ref | SymbolicRef | undefined = end.ref;
    let via = end.chain;
    if (c.noDeref) {
      // Write the name itself; `old` is still compared with the value it resolves to, as git does.
      name = c.name;
      current = await view.read(c.name);
      via = [];
    }
    if (!isUpdatableRefName(name)) return reject([{ name: c.name, reason: "invalid-name" }]);
    const oldValue = end.ref && !isSymbolicRef(end.ref) ? end.ref.objectId : undefined;
    const reflogAlso = [...via];
    if (headTarget === name && !reflogAlso.includes("HEAD") && name !== "HEAD") {
      reflogAlso.push("HEAD");
    }
    updates.push({
      name,
      requested: c.name,
      current,
      oldValue,
      newValue: c.new,
      reflogAlso,
      ...(c.reflog ? { reflog: c.reflog.map(sanitizeOwnLine) } : {}),
      ...(c.message !== undefined ? { message: c.message } : {}),
    });
  }

  // Policy: a ref outside refs/ (a detached HEAD) cannot join a multi-ref batch,
  // since git files could not commit it atomically with packed refs.
  if (updates.length > 1) {
    const outside = updates.filter((u) => !u.name.startsWith("refs/"));
    if (outside.length) {
      return reject(outside.map((u) => ({ name: u.requested, reason: "not-atomic" as const })));
    }
  }

  // Duplicates after dereferencing, and directory/file conflicts.
  const conflicts: RefRejection[] = [];
  const names = new Set<string>();
  for (const u of updates) {
    if (names.has(u.name)) conflicts.push({ name: u.requested, reason: "duplicate" });
    names.add(u.name);
  }
  for (const u of updates) {
    if (ancestors(u.name).some((a) => names.has(a))) {
      conflicts.push({ name: u.requested, reason: "df-conflict" });
    }
  }
  if (conflicts.length) return reject(conflicts);
  for (const u of updates) {
    // Only a create can conflict with existing refs; git refuses it even when the
    // same batch deletes the blocking ref.
    if (u.newValue === null || u.current !== undefined) continue;
    let blocked = false;
    for (const a of ancestors(u.name)) {
      const existing = await view.read(a);
      if (existing) {
        blocked = true;
        break;
      }
    }
    if (blocked || (await view.hasChildren(u.name))) {
      conflicts.push({ name: u.requested, reason: "df-conflict" });
    }
  }
  if (conflicts.length) return reject(conflicts);

  // Expected old values.
  const mismatched: RefRejection[] = [];
  commands.forEach((c, i) => {
    const current = updates[i]?.oldValue;
    if (c.old === undefined) return;
    if (c.old === null ? current !== undefined : current !== c.old) {
      mismatched.push({ name: c.name, reason: "mismatch" });
    }
  });
  if (mismatched.length) return reject(mismatched);

  return { ok: true, updates };
}

/** The part of a ref store the interim batch needs. */
export interface SingleRefWriter {
  get(name: string): Promise<Ref | SymbolicRef | undefined>;
  list(prefix?: string): AsyncIterable<Ref | SymbolicRef>;
  compareAndSwap(
    name: string,
    expected: ObjectId | undefined,
    newValue: ObjectId,
  ): Promise<{ success: boolean }>;
  remove(name: string): Promise<boolean>;
}

/**
 * Interim `batch` for stores that only have a single-ref compare-and-swap.
 *
 * @deprecated Interim: removed once the SQL, KV and git-files stores apply
 * batches atomically (they each get a batch of their own).
 *
 * A batch of one command is checked with `planRefBatch` and written through
 * `compareAndSwap` (a delete through `remove`). It is only as atomic as the
 * store's `compareAndSwap`, and a delete is checked and then removed, so a write
 * in between can be lost. What it cannot do at all it refuses as `unsupported`:
 * a batch of several commands, and `noDeref` on a symbolic ref.
 */
export async function batchBySingleRef(
  store: SingleRefWriter,
  commands: RefCommand[],
): Promise<BatchResult> {
  const unsupported = (): BatchResult => ({
    ok: false,
    rejected: commands.map((c) => ({ name: c.name, reason: "unsupported" as const })),
  });
  if (commands.length === 0) return { ok: true, rejected: [] };
  if (commands.length > 1) return unsupported();
  const plan = await planRefBatch(commands, {
    read: (name) => store.get(name),
    hasChildren: async (name) => {
      for await (const _ of store.list(`${name}/`)) return true;
      return false;
    },
  });
  if (!plan.ok) return { ok: false, rejected: plan.rejected };
  const [u] = plan.updates;
  if (!u) return { ok: true, rejected: [] };
  if (u.current && isSymbolicRef(u.current)) return unsupported();
  if (u.newValue === null) {
    // Deleting a ref that is not there is a no-op, as in git.
    if (u.current === undefined) return { ok: true, rejected: [] };
    await store.remove(u.name);
    return { ok: true, rejected: [] };
  }
  if ((await store.compareAndSwap(u.name, u.oldValue, u.newValue)).success) {
    return { ok: true, rejected: [] };
  }
  // Lost a race to another writer: report the conflict as git does.
  const now = await store.get(u.name);
  const nowValue = now && !isSymbolicRef(now) ? now.objectId : undefined;
  return {
    ok: false,
    rejected: [{ name: u.requested, reason: nowValue === u.oldValue ? "locked" : "mismatch" }],
  };
}

/** One reflog line, as git writes it: `<old> <new> <ident>\t<message>`. */
export interface ReflogLine {
  oldId: ObjectId;
  newId: ObjectId;
  /** git identity with time: "Name <email> 1700000000 +0000". */
  ident: string;
  message: string;
}

/**
 * One reflog write of a batch: append a line (`create` says whether the log
 * may be created if it does not exist), or drop the log of a deleted ref.
 */
export type ReflogWrite =
  | { op: "append"; name: string; line: ReflogLine; create: boolean }
  | { op: "drop"; name: string };

const ZERO_ID = "0".repeat(40);
/** Refs git logs even without an existing reflog (core.logAllRefUpdates=true, non-bare). */
const LOGGED_BY_DEFAULT = ["refs/heads/", "refs/remotes/", "refs/notes/"];

/**
 * The reflog writes for a planned batch, as git writes them with
 * core.logAllRefUpdates=true: a log is created for HEAD, refs/heads/,
 * refs/remotes/ and refs/notes/ (and appended to wherever one exists); the
 * updated ref gets no line for a no-op and loses its log on delete; the refs
 * that record the update too (`reflogAlso`, HEAD among them) always get a line.
 * With `options.createReflog` the updated refs' logs are created whatever their
 * names (git's REF_FORCE_CREATE_REFLOG). Writes come in batch order, to be applied in that order (as the files store does).
 */
export function planReflog(updates: PlannedRefUpdate[], options: BatchOptions = {}): ReflogWrite[] {
  const ident = options.ident ?? defaultReflogIdent();
  const message = (options.message ?? "").replace(/\s+/g, " ").trim();
  const writes: ReflogWrite[] = [];
  const create = logsByDefault;
  for (const u of updates) {
    if (options.skipReflog) {
      if (u.newValue === null) writes.push({ op: "drop", name: u.name });
      continue;
    }
    const line: ReflogLine = {
      oldId: u.oldValue ?? ZERO_ID,
      newId: u.newValue ?? ZERO_ID,
      ident,
      message: u.message !== undefined ? u.message.replace(/\s+/g, " ").trim() : message,
    };
    if (u.newValue === null) writes.push({ op: "drop", name: u.name });
    else if (u.reflog) {
      for (const own of u.reflog) {
        const ownMessage = own.message.replace(/\s+/g, " ").trim();
        const ownLine = { ...own, ident: own.ident ?? ident, message: ownMessage };
        writes.push({ op: "append", name: u.name, line: ownLine, create: true });
      }
    } else if (line.oldId !== u.newValue)
      writes.push({
        op: "append",
        name: u.name,
        line,
        create: options.createReflog === true || create(u.name),
      });
    for (const name of u.reflogAlso)
      writes.push({ op: "append", name, line, create: create(name) });
  }
  return writes;
}

/** The identity of a reflog line written without one: `webrun-vcs <vcs@localhost>`, now. */
export function defaultReflogIdent(): string {
  return `webrun-vcs <vcs@localhost> ${Math.floor(Date.now() / 1000)} +0000`;
}

/**
 * Whether git creates `name`'s reflog on an update with core.logAllRefUpdates=true (a
 * non-bare repository): HEAD, refs/heads/, refs/remotes/ and refs/notes/.
 */
export function logsByDefault(name: string): boolean {
  return name === "HEAD" || LOGGED_BY_DEFAULT.some((prefix) => name.startsWith(prefix));
}

/**
 * The reflog writes of a symbolic ref `name` set with `log` (see
 * {@link Refs.setSymbolic}): the lines `log.reflog` gives (the log created whatever the
 * name; malformed lines skipped), else git's create_symref line ({@link symrefReflogLine}), logged when `name`'s log
 * exists or git logs `name` by default. Empty when nothing is logged.
 *
 * @example
 * ```typescript
 * for (const w of symrefReflogWrites("HEAD", oldId, featId, { message: "checkout: ..." })) {
 *   // append w.line to w.name's log (creating it when w.create allows)
 * }
 * ```
 */
export function symrefReflogWrites(
  name: string,
  old: ObjectId | undefined,
  next: ObjectId | undefined,
  log: SymbolicRefLogOptions | undefined,
): ReflogWrite[] {
  if (log?.reflog) {
    const ident = log.ident ?? defaultReflogIdent();
    // a line without object ids or with a malformed identity is not written
    return log.reflog.filter(validOwnLine).map((own) => {
      const line = sanitizeOwnLine(own);
      return {
        op: "append",
        name,
        line: { ...line, ident: line.ident ?? ident },
        create: true,
      };
    });
  }
  const line = symrefReflogLine(old, next, log);
  return line ? [{ op: "append", name, line, create: logsByDefault(name) }] : [];
}

/**
 * The reflog line of a symbolic ref (re)pointed with a message, as git's `create_symref`
 * logs it: from the id the ref resolved to before (zeros when it did not) to the id its new
 * target resolves to, even when they are equal. None without a message, and none when the
 * target does not resolve (git skips the line for an unborn branch).
 *
 * @example
 * ```typescript
 * const line = symrefReflogLine(oldHeadId, featId, { message: "checkout: moving from main to feat" });
 * ```
 */
export function symrefReflogLine(
  old: ObjectId | undefined,
  next: ObjectId | undefined,
  log: RefLogOptions | undefined,
): ReflogLine | undefined {
  if (log?.message === undefined || next === undefined) return undefined;
  return {
    oldId: old ?? ZERO_ID,
    newId: next,
    ident: log.ident ?? defaultReflogIdent(),
    message: log.message.replace(/\s+/g, " ").trim(),
  };
}

/** The states of a ref transaction a {@link RefTransactionHook} is told about (githooks(5)). */
export type RefTransactionState = "preparing" | "prepared" | "committed" | "aborted";

/** One update of a ref transaction, as git's reference-transaction hook is fed it. */
export interface RefTransactionUpdate {
  /** The name the command gave (`HEAD`) */
  requested: string;
  /** The ref written: the requested one, or the ref it dereferenced to */
  name: string;
  /** The command's expected old value: an id, `null` for "must not exist", none unchecked */
  old?: ObjectId | null;
  /** The value written; `null` deletes the ref (or, with `newTarget`, writes a symbolic ref) */
  new: ObjectId | null;
  /**
   * The ref a symbolic ref is (re)pointed at: git 2.5x's symref update, told to the hook as
   * `ref:<target>` (git 2.43 writes symbolic refs outside any transaction)
   */
  newTarget?: string;
  /**
   * HEAD names the ref written, which was asked for by its own name or through another
   * symbolic ref (a symbolic ORIG_HEAD): git's transaction also logs the update on HEAD
   * (`split_head_update`, a line of its own in git 2.43, after the ref's)
   */
  viaHead?: boolean;
  /**
   * The symbolic refs between `requested` and `name` (an ORIG_HEAD naming HEAD: `HEAD`), in
   * order: each a log-only update of its own in git 2.43 (`split_symref_update`)
   */
  through?: string[];
}

/**
 * Told about each ref transaction of a store that supports it (`setTransactionHook`): before
 * the locks (`preparing`), once every lock is held and checked (`prepared`), after the
 * commit (`committed`), or when it is given up (`aborted`). Returning false (or the message
 * to fail with) in `preparing` or `prepared` aborts the transaction: the store tells the hook
 * `aborted`, then throws {@link RefTransactionAbortedError}.
 */
export type RefTransactionHook = (
  state: RefTransactionState,
  updates: readonly RefTransactionUpdate[],
  context?: RefTransactionContext,
) => Promise<boolean | string | undefined>;

/**
 * Which transaction a {@link RefTransactionHook} call is about, beyond the store's own.
 *
 * git's files backend deletes a ref from `packed-refs` in a transaction of its own on the
 * packed store, nested in the one that deletes it (`<zero> <zero> <ref>` lines, no old
 * value): prepared when the ref is packed, else given up at once (`aborted`), committed
 * before the outer one. git 2.43's `delete_refs` (branch -d, tag -d) also first runs one
 * on the packed store alone; such calls are marked with the version that makes them.
 */
export interface RefTransactionContext {
  /** The packed store's nested transaction */
  packed?: boolean;
  /** Made by this git version only: a hook following the other leaves the call out */
  only?: "2.43" | "2.56";
}

/** How a ref store removes a ref, where git's commands differ (see {@link RefTransactionContext}). */
export interface RefRemoveOptions {
  /** As git's `delete_refs` (branch -d, tag -d), rather than `delete_ref` */
  deleteRefs?: boolean;
}

/** How a ref store removes several refs (`Refs.removeAll`, git's `delete_refs`). */
export interface RefRemoveAllOptions {
  /**
   * As git 2.43's files backend (files_delete_refs): the refs dropped from packed-refs in a
   * transaction of the packed store first (packed-refs rewritten, created when absent), then
   * each ref deleted in a transaction of its own, going on past one that fails. Without it,
   * as git 2.5x: one transaction deleting them all (none deleted when one cannot be).
   */
  legacy?: boolean;
  /** The reflog message (logged on HEAD when a removed ref is the branch it names) */
  message?: string;
}

/** A ref transaction its hook aborted (git: "in '<state>' phase, update aborted by ..."). */
export class RefTransactionAbortedError extends Error {
  constructor(
    readonly state: "preparing" | "prepared",
    message = `in '${state}' phase, update aborted by the reference-transaction hook`,
  ) {
    super(message);
    this.name = "RefTransactionAbortedError";
  }
}
