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
}

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

/** Reflog details for stores that keep a reflog; others ignore them. */
export interface BatchOptions {
  /** git identity with time: "Name <email> 1700000000 +0000". */
  ident?: string;
  message?: string;
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
    updates.push({ name, requested: c.name, current, oldValue, newValue: c.new, reflogAlso });
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
 * Writes come in batch order, to be applied in that order (as the files store does).
 */
export function planReflog(updates: PlannedRefUpdate[], options: BatchOptions = {}): ReflogWrite[] {
  const ident =
    options.ident ?? `webrun-vcs <vcs@localhost> ${Math.floor(Date.now() / 1000)} +0000`;
  const message = (options.message ?? "").replace(/\s+/g, " ").trim();
  const writes: ReflogWrite[] = [];
  const create = (name: string) =>
    name === "HEAD" || LOGGED_BY_DEFAULT.some((prefix) => name.startsWith(prefix));
  for (const u of updates) {
    const line: ReflogLine = {
      oldId: u.oldValue ?? ZERO_ID,
      newId: u.newValue ?? ZERO_ID,
      ident,
      message,
    };
    if (u.newValue === null) writes.push({ op: "drop", name: u.name });
    else if (line.oldId !== u.newValue)
      writes.push({ op: "append", name: u.name, line, create: create(u.name) });
    for (const name of u.reflogAlso)
      writes.push({ op: "append", name, line, create: create(name) });
  }
  return writes;
}
