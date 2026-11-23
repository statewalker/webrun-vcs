/**
 * The refs of a repository whose `extensions.refStorage` is `reftable`, through the `Refs`
 * interface (git's `refs/reftable-backend.c`): every write is one transaction appending one
 * table to each stack it changes (`createReftableStackWriter`), its reflog entries in the
 * same table, the reference-transaction hook told as git tells it.
 *
 * @example
 * ```typescript
 * const refs = createReftableRefStore({ files, gitDir: ".git" });
 * await refs.resolve("HEAD"); // HEAD's record in .git/reftable, through to its branch
 * for await (const ref of refs.list("refs/heads/")) console.log(ref.name);
 * await refs.set("refs/heads/x", id, { message: "branch: Created from HEAD" }); // one table
 * ```
 *
 * The layout is git's: the repository's stack in `<common dir>/reftable` holds the shared refs
 * and the main worktree's own (HEAD, the root refs, `refs/bisect/`, `refs/worktree/`,
 * `refs/rewritten/`); a linked worktree's own refs are in `<common dir>/worktrees/<id>/reftable`.
 * `.git/HEAD` is a stub (`ref: refs/heads/.invalid`) for older gits and is never read. A store
 * opened for a linked worktree (`gitDir` its `worktrees/<id>` directory) reads its own refs from
 * its stack and the shared ones from the repository's; any store reads another worktree's as
 * `worktrees/<id>/<ref>` and the main worktree's as `main-worktree/<ref>` (parse_worktree_ref).
 * The pseudo refs `FETCH_HEAD` and `MERGE_HEAD` stay files in the git directory, as git keeps
 * them. Listings give `HEAD` first (when the prefix allows), then the refs under `refs/` in
 * name order: in a linked worktree its own refs merged with the shared ones, its own winning.
 */

import type {
  BatchOptions,
  BatchResult,
  FilesApi,
  ObjectId,
  PackRefsOptions,
  PlannedRefUpdate,
  Ref,
  RefCommand,
  RefLogOptions,
  ReflogDeleteOptions,
  ReflogEntry,
  ReflogLine,
  ReflogReader,
  RefRejection,
  RefRemoveAllOptions,
  RefRemoveOptions,
  Refs,
  RefTransactionHook,
  RefTransactionState,
  RefTransactionUpdate,
  RefUpdateResult,
  SymbolicRef,
  SymbolicRefLogOptions,
} from "@statewalker/vcs-core";
import {
  createPeeledTagRef,
  createRef,
  createSymbolicRef,
  isRefObjectId,
  isSymbolicRef,
  isValidRefName,
  logsByDefault,
  planRefBatch,
  ReflogEntryNotFoundError,
  RefStorage,
  RefTransactionAbortedError,
  symrefReflogWrites,
} from "@statewalker/vcs-core";
import { atomicFilesOver, joinPath } from "@statewalker/vcs-utils/files";

import { isRootRefName, RefUpdateRejectedError } from "../files-ref-batch.js";
import { readLooseRef } from "../ref-reader.js";
import { createFileRefStore, type FileRefStore } from "../ref-store.files.js";
import { ReftablePartialCommitError } from "./reftable-errors.js";
import {
  createReftableStackReader,
  type ReftableStackReader,
  type ReftableView,
} from "./reftable-stack.js";
import {
  createReftableStackWriter,
  type ReftableAddition,
  ReftableLockError,
  type ReftableStackWriteOptions,
  type ReftableStackWriter,
} from "./reftable-stack-writer.js";
import {
  compareKeys,
  type ReftableLogUpdate,
  type ReftableRefRecord,
  type ReftableRefValue,
} from "./reftable-table.js";
import type { ReftableLogWrite, ReftableRefWrite } from "./reftable-writer.js";

/** git's symref depth limit while resolving. */
const MAX_SYMREF_DEPTH = 5;
const ZERO_ID = "0000000000000000000000000000000000000000";

/** Options of {@link createReftableRefStore}. */
export interface ReftableRefStoreOptions {
  /** The FilesApi the repository is in */
  files: FilesApi;
  /** The git directory: the repository's, or a linked worktree's (`<common>/worktrees/<id>`) */
  gitDir: string;
  /** The repository's directory (git's common dir); default `gitDir` */
  commonDir?: string;
  /** git's write options (`reftable.blockSize`, `restartInterval`, `indexObjects`, `geometricFactor`, `lockTimeout`) */
  write?: ReftableStackWriteOptions;
  /**
   * Which refs get a new reflog (git: core.logAllRefUpdates): `true` (the default) HEAD,
   * refs/heads/, refs/remotes/ and refs/notes/; `"always"` every ref; `false` none. An
   * existing reflog is appended to whatever the setting.
   */
  logAllRefUpdates?: boolean | "always";
  /** The name and email of reflog entries written without an identity (user.name, user.email) */
  reflogIdentity?: { name: string; email: string };
  /**
   * The id an annotated tag `id` peels to: with it, a ref naming an annotated tag is
   * written with its peeled value (git's REF_HAVE_PEELED, `value_type` 2)
   */
  peel?: (id: ObjectId) => Promise<ObjectId | undefined>;
}

/** git's is_root_ref_syntax: uppercase letters, `-` and `_` only. */
function isRootRefSyntax(name: string): boolean {
  return /^[A-Z_-]*$/.test(name);
}

/** git's is_current_worktree_ref: root ref syntax or a per-worktree prefix. */
function isCurrentWorktreeRef(name: string): boolean {
  return (
    isRootRefSyntax(name) ||
    name.startsWith("refs/worktree/") ||
    name.startsWith("refs/bisect/") ||
    name.startsWith("refs/rewritten/")
  );
}

/** git's is_pseudo_ref: the refs kept as files whatever the ref storage. */
function isPseudoRef(name: string): boolean {
  return name === "FETCH_HEAD" || name === "MERGE_HEAD";
}

type WorktreeRefKind =
  | { kind: "other"; worktree: string; name: string }
  | { kind: "main"; name: string }
  | { kind: "current"; name: string }
  | { kind: "shared"; name: string };

/** git's parse_worktree_ref. */
function parseWorktreeRef(name: string): WorktreeRefKind {
  if (name.startsWith("worktrees/")) {
    const rest = name.slice("worktrees/".length);
    const slash = rest.indexOf("/");
    if (slash < 0) return { kind: "other", worktree: rest, name: "" };
    const bare = rest.slice(slash + 1);
    if (isCurrentWorktreeRef(bare)) {
      return { kind: "other", worktree: rest.slice(0, slash), name: bare };
    }
  }
  if (name.startsWith("main-worktree/")) {
    const bare = name.slice("main-worktree/".length);
    if (isCurrentWorktreeRef(bare)) return { kind: "main", name: bare };
  }
  if (isCurrentWorktreeRef(name)) return { kind: "current", name };
  return { kind: "shared", name };
}

/** git's minutes_to_tz: `-480` is `-0800`. */
function minutesToTz(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hhmm = Math.floor(abs / 60) * 100 + (abs % 60);
  return `${sign}${String(hhmm).padStart(4, "0")}`;
}

/** The record as the Refs API gives it, under `name` (the name it was asked by). */
function toRef(name: string, record: ReftableRefRecord): Ref | SymbolicRef | undefined {
  const value = record.value;
  switch (value.type) {
    case "id":
      return createRef(name, value.id, RefStorage.PACKED);
    case "peeled":
      return createPeeledTagRef(name, value.id, value.peeled, RefStorage.PACKED);
    case "symref":
      return createSymbolicRef(name, value.target, RefStorage.PACKED);
    default:
      return undefined;
  }
}

/** The refs of a reftable repository (see the module's notes). */
export function createReftableRefStore(options: ReftableRefStoreOptions): ReftableRefStore {
  return new ReftableRefStore(options);
}

export class ReftableRefStore implements Refs {
  private readonly files: FilesApi;
  private readonly gitDir: string;
  private readonly commonDir: string;
  private readonly options: ReftableRefStoreOptions;
  private readonly main: StackHandle;
  /** This linked worktree's own stack (undefined in the main worktree) */
  private readonly own?: StackHandle;
  private readonly others = new Map<string, StackHandle>();
  /** The `shallow` and grafts files, which stay files */
  private readonly fileState: FileRefStore;
  private transactionHook?: RefTransactionHook;

  constructor(options: ReftableRefStoreOptions) {
    this.options = options;
    this.files = options.files;
    this.gitDir = options.gitDir;
    this.commonDir = options.commonDir ?? options.gitDir;
    this.main = this.handle(joinPath(this.commonDir, "reftable"));
    if (this.gitDir !== this.commonDir) {
      this.own = this.handle(joinPath(this.gitDir, "reftable"));
    }
    this.fileState = createFileRefStore(this.files, this.commonDir);
  }

  private handle(dir: string): StackHandle {
    const reader = createReftableStackReader(this.files, dir);
    const writer = createReftableStackWriter(this.files, dir, reader, this.options.write);
    return { dir, reader, writer };
  }

  /**
   * The store of another git directory of this repository (a linked worktree's
   * `<common>/worktrees/<id>`), with these settings unless `overrides` changes them.
   */
  forGitDir(
    gitDir: string,
    overrides: Partial<Omit<ReftableRefStoreOptions, "files" | "gitDir" | "commonDir">> = {},
  ): ReftableRefStore {
    return new ReftableRefStore({
      ...this.options,
      ...overrides,
      gitDir,
      commonDir: this.commonDir,
    });
  }

  /**
   * The store of the repository's own git directory: the main worktree's refs (HEAD, root
   * refs, `refs/bisect/` ...) and the shared ones; this store itself in the main worktree.
   * gc, repack and fsck take their roots from it whichever worktree they run in.
   */
  repositoryStore(): ReftableRefStore {
    return this.gitDir === this.commonDir ? this : this.forGitDir(this.commonDir);
  }

  /** git's reftable_stack_clean of this store's own stack (see `ReftableStackWriter.clean`). */
  cleanStack(): Promise<void> {
    return (this.own ?? this.main).writer.clean();
  }

  /**
   * Tells `hook` about each ref transaction as git runs the reference-transaction hook for
   * the reftable backend: `preparing` before the stacks are locked (the updates as asked),
   * `prepared` once they are locked and checked, `committed` once the new tables are listed,
   * `aborted` when the hook refuses. Symbolic refs (`setSymbolic`: `<zero> ref:<target>`) and
   * root refs (ORIG_HEAD, ...) are written in transactions too. Undefined removes it.
   */
  setTransactionHook(hook: RefTransactionHook | undefined): void {
    this.transactionHook = hook;
  }

  /** The hook {@link setTransactionHook} installed, if any. */
  getTransactionHook(): RefTransactionHook | undefined {
    return this.transactionHook;
  }

  /** The stack that holds `name`, and the name it has there (git's backend_for). */
  private stackFor(name: string): { stack: StackHandle; name: string } | undefined {
    const parsed = parseWorktreeRef(name);
    switch (parsed.kind) {
      case "other": {
        if (parsed.name === "" || parsed.worktree === "" || parsed.worktree.includes("..")) {
          return undefined;
        }
        let stack = this.others.get(parsed.worktree);
        if (!stack) {
          stack = this.handle(joinPath(this.commonDir, "worktrees", parsed.worktree, "reftable"));
          this.others.set(parsed.worktree, stack);
        }
        return { stack, name: parsed.name };
      }
      case "main":
        return { stack: this.main, name: parsed.name };
      case "current":
        return { stack: this.own ?? this.main, name: parsed.name };
      default:
        return { stack: this.main, name: parsed.name };
    }
  }

  async get(name: string): Promise<Ref | SymbolicRef | undefined> {
    if (isPseudoRef(name)) return readLooseRef(this.files, this.gitDir, name);
    const where = this.stackFor(name);
    if (!where) return undefined;
    const record = (await where.stack.reader.read()).getRef(where.name);
    return record ? toRef(name, record) : undefined;
  }

  async resolve(name: string): Promise<Ref | undefined> {
    let current = await this.get(name);
    for (let depth = 0; current && isSymbolicRef(current); depth++) {
      if (depth >= MAX_SYMREF_DEPTH) return undefined;
      current = await this.get(current.target);
    }
    return current as Ref | undefined;
  }

  async has(name: string): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  async *list(prefix = ""): AsyncIterable<Ref | SymbolicRef> {
    if (prefix === "" || "HEAD".startsWith(prefix)) {
      const head = await this.get("HEAD");
      if (head) yield head;
    }
    // only refs under refs/ are listed: seek the longer of the prefix and "refs/"
    const seek = prefix.startsWith("refs/") ? prefix : "refs/".startsWith(prefix) ? "refs/" : "";
    if (seek === "") return;
    const main = await this.main.reader.read();
    const own = this.own ? await this.own.reader.read() : undefined;
    if (!own) {
      for (const record of main.refs(seek)) {
        const ref = toRef(record.name, record);
        if (ref) yield ref;
      }
      return;
    }
    // git's ref_iterator_select: the worktree's refs, and the repository's shared ones (the
    // worktree's own winning on equal names)
    const mine = own.refs(seek);
    const shared = (function* () {
      for (const r of main.refs(seek)) if (parseWorktreeRef(r.name).kind === "shared") yield r;
    })();
    let a = mine.next();
    let b = shared.next();
    while (!a.done || !b.done) {
      let record: ReftableRefRecord;
      if (!a.done && (b.done || compareKeys(a.value.key, b.value.key) <= 0)) {
        record = a.value;
        if (!b.done && compareKeys(a.value.key, b.value.key) === 0) b = shared.next();
        a = mine.next();
      } else {
        record = (b as IteratorYieldResult<ReftableRefRecord>).value;
        b = shared.next();
      }
      const ref = toRef(record.name, record);
      if (ref) yield ref;
    }
  }

  async getReflog(name: string): Promise<ReflogReader | undefined> {
    const where = this.stackFor(name);
    if (!where) return undefined;
    // a snapshot of the stack's tables; each read below walks the reflog lazily again,
    // decoding only the entries it returns (and those before them)
    const view = await where.stack.reader.read();
    const refName = where.name;
    if (!view.hasLogs(refName)) return undefined;
    function* entries(): Generator<ReflogEntry> {
      for (const log of view.logs(refName)) {
        const u = log.update;
        // both ids zero: git's reflog existence marker, never shown
        if (!u || (u.oldId === ZERO_ID && u.newId === ZERO_ID)) continue;
        yield {
          oldId: u.oldId,
          newId: u.newId,
          who: {
            name: u.name,
            email: u.email,
            timestamp: u.time,
            tzOffset: minutesToTz(u.tzOffset),
          },
          comment: u.message.endsWith("\n") ? u.message.slice(0, -1) : u.message,
        };
      }
    }
    const take = (max: number): ReflogEntry[] => {
      const out: ReflogEntry[] = [];
      if (max <= 0) return out;
      for (const entry of entries()) {
        out.push(entry);
        if (out.length >= max) break;
      }
      return out;
    };
    return {
      getLastEntry: async () => take(1)[0],
      getReverseEntries: async (max = Number.MAX_SAFE_INTEGER) => take(max),
      getReverseEntry: async (index) => (index < 0 ? undefined : take(index + 1)[index]),
    };
  }

  getShallow(): Promise<ObjectId[]> {
    return this.fileState.getShallow();
  }

  readGrafts(): Promise<string | undefined> {
    return this.fileState.readGrafts();
  }

  setShallow(commits: Iterable<ObjectId>, expected?: Iterable<ObjectId>): Promise<void> {
    return this.fileState.setShallow(commits, expected);
  }

  // Writes: each one transaction, one table per stack it changes (git's reftable backend)

  /**
   * Sets `name` to `objectId` (replacing a symbolic ref of that name), as `git update-ref
   * --no-deref`: one transaction, its reflog line as `log` says. A root ref (ORIG_HEAD, ...)
   * is written in a transaction too, without a reflog; FETCH_HEAD and MERGE_HEAD stay files.
   * Throws `RefUpdateRejectedError` with nothing changed.
   */
  async set(name: string, objectId: ObjectId, log?: RefLogOptions): Promise<void> {
    if (!isRefObjectId(objectId)) {
      throw new RefUpdateRejectedError([{ name, reason: "invalid-object-id" }]);
    }
    if (isPseudoRef(name)) return this.writePseudoRef(name, `${objectId}\n`);
    if (!isValidRefName(name, { allowOneLevel: true }) || !this.stackFor(name)) {
      throw new RefUpdateRejectedError([{ name, reason: "invalid-name" }]);
    }
    const r = await this.transact([{ name, new: objectId, noDeref: true }], log ?? {});
    if (!r.ok) throw new RefUpdateRejectedError(r.rejected);
  }

  /**
   * Points `name` at `target` in a transaction of its own, as git's `refs_update_symref`
   * (the hook told `<zero> ref:<target> <name>`). With a `log` message, `name`'s reflog
   * records the change as git's reftable backend does: from what `name` resolved to before
   * (zeros when nothing) to what `target` resolves to; nothing when `target` does not
   * resolve. `log.reflog` writes those lines instead. Throws `RefUpdateRejectedError` on a
   * directory/file conflict or a held lock, `RefTransactionAbortedError` when the hook
   * refuses.
   */
  async setSymbolic(name: string, target: string, log?: SymbolicRefLogOptions): Promise<void> {
    if (isPseudoRef(name)) return this.writePseudoRef(name, `ref: ${target}\n`);
    const where = this.stackFor(name);
    if (!where || !isValidRefName(name, { allowOneLevel: true })) {
      throw new RefUpdateRejectedError([{ name, reason: "invalid-name" }]);
    }
    const hook = this.transactionHook;
    const told: RefTransactionUpdate[] = [{ requested: name, name, new: null, newTarget: target }];
    await this.tell(hook, "preparing", told, { asAsked: true });
    const tx = new Transaction();
    try {
      const addition = await tx.lock(where.stack);
      if (name.startsWith("refs/") && (await this.dfConflict(name))) {
        throw new RefUpdateRejectedError([{ name, reason: "df-conflict" }]);
      }
      const logged = log !== undefined && (log.message !== undefined || Boolean(log.reflog));
      const old = logged && !log?.reflog ? (await this.resolve(name))?.objectId : undefined;
      await this.tell(hook, "prepared", told, {}, tx);
      const ts = addition.nextUpdateIndex;
      const logs: ReftableLogWrite[] = [];
      if (logged && log) {
        const next = log.reflog ? undefined : (await this.resolve(target))?.objectId;
        const ident = log.ident ?? this.defaultIdent();
        const view = addition.view;
        let index = ts;
        for (const w of symrefReflogWrites(name, old, next, { ...log, ident })) {
          if (w.op !== "append") continue;
          if (!log.reflog && !this.shouldLog(where.name, view, false)) continue;
          logs.push(this.logLine(where.name, log.reflog ? ++index : index, w.line));
        }
      }
      tx.content(where.stack, {
        refs: [{ name: where.name, updateIndex: ts, value: { type: "symref", target } }],
        logs,
        maxUpdateIndex: ts + Math.max(0, logs.length > 0 && log?.reflog ? logs.length : 0),
      });
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    await this.tell(hook, "committed", told);
  }

  /**
   * Deletes `name` whatever its value (a symbolic ref itself, not its target) and its
   * reflog; false when it does not exist. FETCH_HEAD and MERGE_HEAD are files.
   */
  async remove(name: string, _options?: RefRemoveOptions): Promise<boolean> {
    if (isPseudoRef(name)) return atomicFilesOver(this.files, this.gitDir).remove(name);
    if (!this.stackFor(name)) return false;
    if ((await this.get(name)) === undefined) return false;
    const r = await this.transact([{ name, new: null, noDeref: true }], {});
    if (!r.ok) throw new RefUpdateRejectedError(r.rejected);
    return true;
  }

  /**
   * Deletes `names` whatever their values in one transaction, as git 2.5x's
   * refs_delete_refs (`legacy` has no meaning here: git 2.43 has no reftable backend).
   */
  async removeAll(names: string[], options?: RefRemoveAllOptions): Promise<void> {
    if (names.length === 0) return;
    const r = await this.transact(
      names.map((name) => ({ name, new: null, noDeref: true })),
      options?.message !== undefined ? { message: options.message } : {},
    );
    if (!r.ok) throw new RefUpdateRejectedError(r.rejected);
  }

  /**
   * Applies `commands` atomically in one transaction (one table per stack changed), checked
   * as `git update-ref --stdin` checks them (`planRefBatch`), under `tables.list.lock`.
   */
  batch(commands: RefCommand[], options?: BatchOptions): Promise<BatchResult> {
    return this.transact(commands, options ?? {});
  }

  async compareAndSwap(
    name: string,
    expected: ObjectId | undefined,
    newValue: ObjectId,
  ): Promise<RefUpdateResult> {
    const r = await this.transact([{ name, old: expected ?? null, new: newValue }], {});
    if (r.ok) return { success: true, previousValue: expected };
    return {
      success: false,
      previousValue: (await this.resolve(name))?.objectId,
      errorMessage: r.rejected.map((x) => `${x.name}: ${x.reason}`).join(", "),
    };
  }

  /** Creates `<git dir>/reftable` (git's reftable_be_create_on_disk). */
  async initialize(): Promise<void> {
    await this.files.mkdir((this.own ?? this.main).dir);
  }

  /** Compacts the stack into one table (git's `pack-refs`: reftable_be_optimize). */
  async optimize(): Promise<void> {
    await (this.own ?? this.main).writer.compactAll();
  }

  /**
   * git's `pack-refs` on a reftable repository (reftable_be_optimize): the whole stack
   * compacted into one table and stale tables removed; with `auto`, the geometric
   * compaction only. The ref names and prefixes have no meaning here. Returns 0.
   */
  async packRefs(_refNames: string[], options?: PackRefsOptions): Promise<number> {
    const writer = (this.own ?? this.main).writer;
    if (options?.auto) await writer.autoCompact();
    else await writer.compactAll();
    return 0;
  }

  /**
   * Deletes reflog entry `name@{index}` as git's reftable backend expires reflogs
   * (reftable_be_reflog_expire): one table rewriting the ref's log (the dropped entry a
   * tombstone; with `rewrite`, each kept entry's old id the new id of the kept one before
   * it; an existence marker when none is left) and, with `updateRef`, the ref set to the
   * newest kept entry's new id (not a symbolic ref). Returns how many entries are kept.
   */
  async deleteReflogEntry(
    name: string,
    index: number,
    options: ReflogDeleteOptions = {},
  ): Promise<number> {
    let kept = 0;
    await this.expireReflog(
      name,
      (entries) => {
        if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
          throw new ReflogEntryNotFoundError(name, index);
        }
        kept = entries.length - 1;
        return entries.map((_, i) => i === index);
      },
      options,
    );
    return kept;
  }

  /**
   * git's reftable_be_reflog_expire for `name`: `prune` is given the ref's reflog entries
   * newest first (existence markers left out) and answers, per entry, whether it goes;
   * one table writes them all again (the pruned ones as tombstones; with `rewrite` the kept
   * ones relinked), an existence marker when none is left, and with `updateRef` the ref at
   * the newest kept entry's new id. No transaction hook runs (git runs none). Returns how
   * many entries were pruned.
   */
  async expireReflog(
    name: string,
    prune: (entries: readonly ReftableLogUpdate[]) => boolean[] | Promise<boolean[]>,
    options: ReflogDeleteOptions & { dryRun?: boolean } = {},
  ): Promise<number> {
    const where = this.stackFor(name);
    if (!where) throw new RefUpdateRejectedError([{ name, reason: "invalid-name" }]);
    const tx = new Transaction();
    try {
      const addition = await tx.lock(where.stack);
      const view = addition.view;
      const records: { updateIndex: number; update: ReftableLogUpdate }[] = [];
      for (const log of view.logs(where.name)) {
        const u = log.update;
        if (!u || (u.oldId === ZERO_ID && u.newId === ZERO_ID)) continue;
        records.push({ updateIndex: log.updateIndex, update: u });
      }
      const verdicts = await prune(records.map((r) => r.update));
      const ts = addition.nextUpdateIndex;
      const logs: ReftableLogWrite[] = [];
      let lastHash: string | undefined;
      let live = 0;
      let pruned = 0;
      for (let i = records.length - 1; i >= 0; i--) {
        const r = records[i] as (typeof records)[number];
        if (verdicts[i]) {
          pruned++;
          logs.push({ refName: where.name, updateIndex: r.updateIndex });
          continue;
        }
        live++;
        const update =
          options.rewrite && lastHash !== undefined ? { ...r.update, oldId: lastHash } : r.update;
        logs.push({ refName: where.name, updateIndex: r.updateIndex, update });
        lastHash = r.update.newId;
      }
      if (live === 0) {
        logs.push({
          refName: where.name,
          updateIndex: ts,
          update: {
            oldId: ZERO_ID,
            newId: ZERO_ID,
            name: "",
            email: "",
            time: 0,
            tzOffset: 0,
            message: "",
          },
          exactMessage: true,
        });
      }
      const refs: ReftableRefWrite[] = [];
      const current = view.getRef(where.name);
      if (
        options.updateRef &&
        lastHash !== undefined &&
        lastHash !== ZERO_ID &&
        current &&
        current.value.type !== "symref"
      ) {
        refs.push({ name: where.name, updateIndex: ts, value: await this.valueOf(lastHash) });
      }
      if (options.dryRun) {
        await tx.rollback();
        return pruned;
      }
      tx.content(where.stack, { refs, logs, maxUpdateIndex: ts });
      await tx.commit();
      return pruned;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }

  /**
   * The names of the refs that have a reflog, in byte order, as git's reflog iterator lists
   * them (gc, fsck): this store's own (a linked worktree's per-worktree refs from its stack,
   * the shared ones from the repository's); with `worktree`, that linked worktree's own refs
   * (named `worktrees/<id>/<ref>`) and the shared ones.
   */
  async reflogNames(worktree?: string): Promise<string[]> {
    const out: string[] = [];
    const add = async (stack: StackHandle, keep: (name: string) => boolean, prefix = "") => {
      const view = await stack.reader.read();
      for (const name of view.logNames()) {
        if (keep(name) && view.hasLogs(name)) out.push(prefix + name);
      }
    };
    const shared = (name: string) => parseWorktreeRef(name).kind === "shared";
    if (worktree !== undefined) {
      const where = this.stackFor(`worktrees/${worktree}/HEAD`);
      if (where) await add(where.stack, (n) => !shared(n), `worktrees/${worktree}/`);
      await add(this.main, shared);
    } else if (this.own) {
      await add(this.own, () => true);
      await add(this.main, shared);
    } else {
      await add(this.main, () => true);
    }
    const bare = (n: string) => n.replace(/^worktrees\/[^/]+\//, "");
    return out.sort((a, b) => (bare(a) < bare(b) ? -1 : bare(a) > bare(b) ? 1 : 0));
  }

  /**
   * The refs a linked worktree keeps in its own stack (`worktrees/<id>/reftable`: HEAD, root
   * refs, `refs/bisect/`, `refs/worktree/`, `refs/rewritten/`), named as other worktrees name
   * them: `worktrees/<id>/<ref>`.
   */
  async worktreeRefs(worktree: string): Promise<(Ref | SymbolicRef)[]> {
    const where = this.stackFor(`worktrees/${worktree}/HEAD`);
    if (!where) return [];
    const out: (Ref | SymbolicRef)[] = [];
    for (const record of (await where.stack.reader.read()).refs("refs/")) {
      const name = `worktrees/${worktree}/${record.name}`;
      const ref = toRef(name, record);
      if (!ref) continue;
      if (isSymbolicRef(ref) && parseWorktreeRef(ref.target).kind === "current") {
        // a symbolic ref to another of the worktree's own refs: named as seen from outside
        out.push(createSymbolicRef(name, `worktrees/${worktree}/${ref.target}`, RefStorage.PACKED));
      } else out.push(ref);
    }
    return out;
  }

  // -- the transaction engine --

  /** Tells the hook `state`; a refusal in `preparing`/`prepared` aborts (rolled back, thrown). */
  private async tell(
    hook: RefTransactionHook | undefined,
    state: RefTransactionState,
    told: RefTransactionUpdate[],
    context: { asAsked?: boolean } = {},
    tx?: Transaction,
  ): Promise<void> {
    if (!hook) return;
    const verdict = await hook(state, told);
    if (
      (state === "preparing" || state === "prepared") &&
      (verdict === false || typeof verdict === "string")
    ) {
      await tx?.rollback();
      await hook("aborted", told, context.asAsked ? { asAsked: true } : undefined);
      throw new RefTransactionAbortedError(state, verdict || undefined);
    }
  }

  private async transact(commands: RefCommand[], o: BatchOptions): Promise<BatchResult> {
    const hook = o.transactionHook ?? this.transactionHook;
    if (commands.length === 0) {
      if (o.emptyTransaction && hook) {
        await this.tell(hook, "preparing", []);
        await this.tell(hook, "prepared", []);
        await this.tell(hook, "committed", []);
      }
      return { ok: true, rejected: [] };
    }
    if (o.initial) {
      const bad = commands.filter((c) => c.new === null || !c.name.startsWith("refs/"));
      if (bad.length) return fail(bad.map((c) => ({ name: c.name, reason: "invalid-command" })));
    }
    for (const c of commands) {
      if (isPseudoRef(c.name) || !this.stackFor(c.name)) {
        return fail([{ name: c.name, reason: "invalid-name" }]);
      }
    }
    // a root ref (ORIG_HEAD, ...): written on its own, the name itself
    const root = commands.length === 1 && isRootRefName((commands[0] as RefCommand).name);
    const plan = async () =>
      root ? this.planRoot(commands[0] as RefCommand) : this.planBatch(commands);
    const unlocked = await plan();
    if (!unlocked.ok) return fail(unlocked.rejected);
    await this.tell(hook, "preparing", this.told(unlocked.updates), { asAsked: true });

    const tx = new Transaction();
    let result: BatchResult;
    let told: RefTransactionUpdate[] = [];
    try {
      // the stacks the updates (and the refs logging them) live in, locked in order; planned
      // again under the locks until no other stack is needed
      let planned: Plan = unlocked;
      for (;;) {
        let more = false;
        // git's order (reftable_be_transaction_prepare): the stacks of every ref asked for,
        // then those of the refs symbolic ones name, then HEAD's log-only update's
        const updates = planned.ok ? planned.updates : [];
        const names = [
          ...updates.map((u) => u.requested),
          ...updates.map((u) => u.name),
          ...updates.flatMap((u) => u.reflogAlso),
        ];
        for (const n of names) {
          const where = this.stackFor(n);
          if (where && !tx.holds(where.stack)) {
            await tx.lock(where.stack);
            more = true;
          }
        }
        planned = await plan();
        if (!planned.ok || !more) break;
      }
      if (!planned.ok) {
        await tx.rollback();
        return fail(planned.rejected);
      }
      if (o.initial) {
        const existing = planned.updates.filter((u) => u.current !== undefined);
        if (existing.length) {
          await tx.rollback();
          return fail(existing.map((u) => ({ name: u.requested, reason: "mismatch" })));
        }
      }
      told = this.told(planned.updates);
      await this.tell(hook, "prepared", told, {}, tx);
      await this.writeUpdates(tx, planned.updates, o);
      await tx.commit();
      result = { ok: true, rejected: [] };
    } catch (error) {
      await tx.rollback();
      if (error instanceof ReftableLockError) {
        return fail(commands.map((c) => ({ name: c.name, reason: "locked" })));
      }
      throw error;
    }
    if (!o.initial) await this.tell(hook, "committed", told);
    return result;
  }

  /** The updates as the hook is told them. */
  private told(updates: Update[]): RefTransactionUpdate[] {
    return updates.map((u) => ({
      requested: u.requested,
      name: u.name,
      ...(u.old !== undefined ? { old: u.old } : {}),
      new: u.newValue,
      ...(u.viaHead ? { viaHead: true } : {}),
    }));
  }

  private async planBatch(commands: RefCommand[]): Promise<Plan> {
    const plan = await planRefBatch(commands, {
      read: (name) => this.get(name),
      hasChildren: (name) => this.hasChildren(name),
    });
    if (!plan.ok) return plan;
    return {
      ok: true,
      updates: plan.updates.map((u, i) => ({
        ...u,
        old: commands[i]?.old,
        viaHead: u.requested !== "HEAD" && u.name !== "HEAD" && u.reflogAlso.includes("HEAD"),
      })),
    };
  }

  /** A root ref's one update: the name itself, its old value checked, no reflog. */
  private async planRoot(c: RefCommand): Promise<Plan> {
    if (c.new !== null && !isRefObjectId(c.new)) {
      return { ok: false, rejected: [{ name: c.name, reason: "invalid-object-id" }] };
    }
    if (c.new === null && c.old === null) {
      return { ok: false, rejected: [{ name: c.name, reason: "invalid-command" }] };
    }
    const current = await this.get(c.name);
    const oldValue = current && !isSymbolicRef(current) ? current.objectId : undefined;
    if (c.old !== undefined && (c.old === null ? current !== undefined : oldValue !== c.old)) {
      return { ok: false, rejected: [{ name: c.name, reason: "mismatch" }] };
    }
    return {
      ok: true,
      updates: [
        {
          name: c.name,
          requested: c.name,
          current,
          oldValue,
          newValue: c.new,
          reflogAlso: [],
          old: c.old,
          ...(c.reflog ? { reflog: c.reflog } : {}),
          ...(c.message !== undefined ? { message: c.message } : {}),
        },
      ],
    };
  }

  private async hasChildren(name: string): Promise<boolean> {
    for await (const _ of this.list(`${name}/`)) return true;
    return false;
  }

  /** Whether creating `name` meets a ref above or below it. */
  private async dfConflict(name: string): Promise<boolean> {
    if (await this.get(name)) return false;
    const parts = name.split("/");
    for (let i = 2; i < parts.length; i++) {
      if (await this.get(parts.slice(0, i).join("/"))) return true;
    }
    return this.hasChildren(name);
  }

  /** git's should_write_log: forced, or autocreated by core.logAllRefUpdates, or existing. */
  private shouldLog(name: string, view: ReftableView, force: boolean): boolean {
    const logAll = this.options.logAllRefUpdates ?? true;
    if (force || logAll === "always") return true;
    if (logAll === true && logsByDefault(name)) return true;
    return view.hasLogs(name);
  }

  private defaultIdent(): string {
    const id = this.options.reflogIdentity ?? { name: "webrun-vcs", email: "vcs@localhost" };
    return `${id.name} <${id.email}> ${Math.floor(Date.now() / 1000)} +0000`;
  }

  /** A reflog line as a log record (git's fill_reftable_log_record), its message bounded. */
  private logLine(refName: string, updateIndex: number, line: ReflogLine): ReftableLogWrite {
    const who = parseIdent(line.ident);
    const limit = Math.floor((this.options.write?.blockSize || 4096) / 2);
    let message = normalizeMessage(line.message);
    if (encoder.encode(message).length > limit) {
      message = new TextDecoder().decode(encoder.encode(message).subarray(0, limit));
    }
    return {
      refName,
      updateIndex,
      update: { oldId: line.oldId, newId: line.newId, ...who, message },
    };
  }

  /** The ref value of `id`: peeled when it is an annotated tag and `peel` is given. */
  private async valueOf(id: ObjectId): Promise<ReftableRefValue> {
    const peeled = this.options.peel
      ? await this.options.peel(id).catch(() => undefined)
      : undefined;
    return peeled !== undefined && peeled !== id
      ? { type: "peeled", id, peeled }
      : { type: "id", id };
  }

  /** The records each locked stack gets for `updates` (git's write_transaction_table). */
  private async writeUpdates(tx: Transaction, updates: Update[], o: BatchOptions): Promise<void> {
    const ident = o.ident ?? this.defaultIdent();
    const batchMessage = o.message ?? "";
    // own reflog lines (git's ref_transaction_update_reflog) take update indexes past the
    // transaction's, one each, in order
    let extra = 0;
    for (const u of updates) {
      const where = this.stackFor(u.name) as { stack: StackHandle; name: string };
      const ts = tx.addition(where.stack).nextUpdateIndex;
      const view = tx.addition(where.stack).view;
      const symbolic = u.current !== undefined && isSymbolicRef(u.current);
      const message = u.message ?? batchMessage;
      const line: ReflogLine = {
        oldId: u.oldValue ?? ZERO_ID,
        newId: u.newValue ?? ZERO_ID,
        ident,
        message,
      };
      if (u.newValue === null) {
        if (u.current === undefined) continue; // nothing to delete: nothing written
        tx.ref(where.stack, { name: where.name, updateIndex: ts, value: { type: "deletion" } });
        if (!symbolic) {
          // the ref's whole reflog goes with it, one tombstone per entry
          for (const log of view.logs(where.name)) {
            tx.log(where.stack, { refName: where.name, updateIndex: log.updateIndex });
          }
        }
      } else {
        const changes = symbolic || u.oldValue !== u.newValue;
        if (changes) {
          tx.ref(where.stack, {
            name: where.name,
            updateIndex: ts,
            value: await this.valueOf(u.newValue),
          });
        }
        if (!o.skipReflog && !o.initial) {
          if (u.reflog) {
            for (const own of u.reflog) {
              extra++;
              tx.log(
                where.stack,
                this.logLine(where.name, ts + extra, { ...own, ident: own.ident ?? ident }),
              );
            }
          } else if (changes && this.shouldLog(where.name, view, o.createReflog === true)) {
            tx.log(where.stack, this.logLine(where.name, ts, line));
          }
        }
      }
      if (o.skipReflog || o.initial) continue;
      for (const also of u.reflogAlso) {
        const at = this.stackFor(also);
        if (!at) continue;
        const atView = tx.addition(at.stack).view;
        if (!this.shouldLog(at.name, atView, false)) continue;
        tx.log(at.stack, this.logLine(at.name, tx.addition(at.stack).nextUpdateIndex, line));
      }
    }
    tx.extend(extra);
  }

  /** FETCH_HEAD and MERGE_HEAD: files in the git directory, written under their lock. */
  private async writePseudoRef(name: string, content: string): Promise<void> {
    const atomic = atomicFilesOver(this.files, this.gitDir);
    if (!(await atomic.createExclusive(`${name}.lock`, encoder.encode(content)))) {
      throw new RefUpdateRejectedError([{ name, reason: "locked" }]);
    }
    try {
      await atomic.replace(`${name}.lock`, name);
    } catch (error) {
      await atomic.remove(`${name}.lock`).catch(() => false);
      throw error;
    }
  }
}

/** A stack's reader and writer. */
interface StackHandle {
  dir: string;
  reader: ReftableStackReader;
  writer: ReftableStackWriter;
}

/** A planned update, with what the hook is told. */
type Update = PlannedRefUpdate & { old: ObjectId | null | undefined; viaHead?: boolean };
type Plan = { ok: true; updates: Update[] } | { ok: false; rejected: RefRejection[] };

const fail = (rejected: RefRejection[]): BatchResult => ({ ok: false, rejected });
const encoder = new TextEncoder();

/** git's reflog message (refs.c copy_reflog_msg): whitespace runs one space, trimmed. */
function normalizeMessage(m: string): string {
  return m.replace(/\s+/g, " ").trim();
}

/** git's tz_to_minutes over a `+hhmm` / `-hhmm` offset. */
function tzMinutes(tz: string): number {
  const m = /^([+-])?(\d+)$/.exec(tz);
  if (!m) return 0;
  const v = Number.parseInt(m[2] as string, 10);
  const minutes = Math.floor(v / 100) * 60 + (v % 100);
  return m[1] === "-" ? -minutes : minutes;
}

/** An identity `Name <email> <time> <tz>` split as git's split_ident_line. */
function parseIdent(ident: string): {
  name: string;
  email: string;
  time: number;
  tzOffset: number;
} {
  const lt = ident.indexOf("<");
  const gt = ident.indexOf(">", lt + 1);
  if (lt < 0 || gt < 0) return { name: ident.trim(), email: "", time: 0, tzOffset: 0 };
  const rest = ident
    .slice(gt + 1)
    .trim()
    .split(/\s+/);
  return {
    name: ident.slice(0, lt).trim(),
    email: ident.slice(lt + 1, gt),
    time: Number.parseInt(rest[0] ?? "0", 10) || 0,
    tzOffset: tzMinutes(rest[1] ?? "+0000"),
  };
}

/**
 * The additions of one transaction, a stack each, locked in the order asked; the records
 * gathered per stack, written and committed together.
 */
class Transaction {
  private readonly additions = new Map<StackHandle, ReftableAddition>();
  private readonly records = new Map<
    StackHandle,
    { refs: ReftableRefWrite[]; logs: ReftableLogWrite[]; max?: number }
  >();
  private extra = 0;

  holds(stack: StackHandle): boolean {
    return this.additions.has(stack);
  }

  async lock(stack: StackHandle): Promise<ReftableAddition> {
    let addition = this.additions.get(stack);
    if (!addition) {
      addition = await stack.writer.begin();
      this.additions.set(stack, addition);
    }
    return addition;
  }

  addition(stack: StackHandle): ReftableAddition {
    const addition = this.additions.get(stack);
    if (!addition) throw new Error(`reftable: '${stack.dir}' is not locked`);
    return addition;
  }

  private of(stack: StackHandle) {
    let r = this.records.get(stack);
    if (!r) {
      r = { refs: [], logs: [] };
      this.records.set(stack, r);
    }
    return r;
  }

  ref(stack: StackHandle, ref: ReftableRefWrite): void {
    this.of(stack).refs.push(ref);
  }

  log(stack: StackHandle, log: ReftableLogWrite): void {
    this.of(stack).logs.push(log);
  }

  /** The records of one stack, its table ending at `maxUpdateIndex`. */
  content(
    stack: StackHandle,
    c: { refs: ReftableRefWrite[]; logs: ReftableLogWrite[]; maxUpdateIndex: number },
  ): void {
    const r = this.of(stack);
    r.refs.push(...c.refs);
    r.logs.push(...c.logs);
    r.max = c.maxUpdateIndex;
  }

  /** The transaction's own reflog lines past its update index (git's max_index). */
  extend(extra: number): void {
    this.extra = extra;
  }

  async commit(): Promise<void> {
    // every table is written before any list is committed
    for (const [stack, addition] of this.additions) {
      const r = this.records.get(stack);
      if (!r) continue;
      const ts = addition.nextUpdateIndex;
      // duplicates of one log key (a ref logging an update twice) keep the first
      const seen = new Set<string>();
      const logs = r.logs.filter((l) => {
        const key = `${l.refName}\u0000${l.updateIndex}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      await addition.add({
        minUpdateIndex: ts,
        maxUpdateIndex: r.max ?? ts + this.extra,
        refs: r.refs,
        logs,
      });
    }
    // stack after stack, in the order they were locked (git's reftable_be_transaction_finish);
    // whatever fails, no stack is left locked
    const pending = [...this.additions];
    this.additions.clear();
    let done = 0;
    try {
      for (const [, addition] of pending) {
        await addition.commit();
        done++;
      }
    } catch (error) {
      for (const [, addition] of pending.slice(done)) await addition.rollback().catch(() => {});
      if (done === 0) throw error;
      throw new ReftablePartialCommitError(
        pending.slice(0, done).map(([stack]) => stack.dir),
        (pending[done] as [StackHandle, ReftableAddition])[0].dir,
        { cause: error },
      );
    }
  }

  async rollback(): Promise<void> {
    const pending = [...this.additions.values()];
    this.additions.clear();
    for (const addition of pending) await addition.rollback();
  }
}
