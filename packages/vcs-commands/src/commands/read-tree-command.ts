/**
 * `git read-tree` (builtin/read-tree.c over unpack-trees.c): read trees into the index,
 * merging them with it (`-m`: one-, two- and three-way), optionally updating the worktree.
 */
import { EMPTY_TREE_ID, FileMode, type ObjectId } from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import {
  attributesIndexOf,
  cacheTreeOfTree,
  entryStatOf,
  type IndexEntryOptions,
  repairCacheTree,
  type StagingEntry,
  type Worktree,
} from "@statewalker/vcs-working-tree";

import { ReadTreeFailedError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { worktreeModeTrust } from "./core-config.js";
import {
  firstPlainError,
  flatTree,
  type MergeWriteContext,
  planPathsRestore,
  rewriteIndex,
  switchTrees,
} from "./merge-support.js";
import { resetMerge } from "./sequencer-support.js";
import { pushSparseWarnings, SparseUnpack } from "./sparse-checkout-support.js";
import { writeTreeRestorePlan } from "./tree-restore.js";
import {
  type CheckedEntry,
  entryNotUptodate,
  pruneEmptyParents,
  untrackedUnder,
} from "./worktree-overwrite-checks.js";

/** unpack-trees' `MAX_UNPACK_TREES`. */
const MAX_UNPACK_TREES = 8;

/** Result of {@link ReadTreeCommand}. */
export interface ReadTreeResult {
  /**
   * What git prints on stderr without failing: the deprecation warning of a bare
   * `read-tree`, the sparse checkout's warnings
   */
  warnings: string[];
  /** The paths left unmerged (three-way merge stages 1-3) */
  unmerged: string[];
}

const same = (a: CheckedEntry | undefined, b: CheckedEntry | undefined) =>
  a === undefined || b === undefined ? a === b : a.objectId === b.objectId && a.mode === b.mode;

/**
 * Read trees into the index (`git read-tree`).
 *
 * ```typescript
 * // the index becomes HEAD's tree (stat data and flags gone)
 * await git.readTree().addTree("HEAD").call();
 *
 * // a fast-forward of the index and the worktree from HEAD to `next`
 * await git.readTree().setMerge(true).setUpdate(true).addTree("HEAD").addTree("next").call();
 *
 * // a three-way merge leaving the conflicts as stages 1-3
 * await git.readTree().setMerge(true).addTree(base).addTree("HEAD").addTree(other).call();
 * ```
 *
 * A refusal is unpack-trees' plain message for the first path refused (`error: Entry 'x'
 * would be overwritten by merge. Cannot merge.`), thrown as {@link ReadTreeFailedError}
 * before anything changed. One tree read without `--prefix` leaves the index's cache-tree
 * primed with it (`prime_cache_tree`); otherwise each directory is valid where its tree is
 * stored (`cache_tree_update` with `WRITE_TREE_REPAIR`), none while conflicts remain.
 */
export class ReadTreeCommand extends GitCommand<ReadTreeResult> {
  private treeishes: string[] = [];
  private merge = false;
  private reset = false;
  private prefix: string | undefined;
  private update = false;
  private indexOnly = false;
  private empty = false;
  private trivial = false;
  private aggressive = false;
  private skipSparseCheckout = false;

  /** A tree-ish to read (up to eight). */
  addTree(treeish: string): this {
    this.checkCallable();
    this.treeishes.push(treeish);
    return this;
  }

  /** `-m`: merge the trees with the index (one-, two- or three-way by their number). */
  setMerge(merge: boolean): this {
    this.checkCallable();
    this.merge = merge;
    return this;
  }

  /** `--reset`: as `-m`, unmerged entries discarded and local changes no refusal. */
  setReset(reset: boolean): this {
    this.checkCallable();
    this.reset = reset;
    return this;
  }

  /** `--prefix=<dir>/`: the tree read under `<dir>/` (bound into the index, which keeps the rest). */
  setPrefix(prefix: string | undefined): this {
    this.checkCallable();
    this.prefix = prefix;
    return this;
  }

  /** `-u`: the worktree updated with the merge's result. */
  setUpdate(update: boolean): this {
    this.checkCallable();
    this.update = update;
    return this;
  }

  /** `-i`: the worktree is not looked at (no up-to-date check). */
  setIndexOnly(indexOnly: boolean): this {
    this.checkCallable();
    this.indexOnly = indexOnly;
    return this;
  }

  /** `--empty`: empty the index. */
  setEmpty(empty: boolean): this {
    this.checkCallable();
    this.empty = empty;
    return this;
  }

  /** `--trivial`: a three-way merge only where no path needs a file-level merge. */
  setTrivial(trivial: boolean): this {
    this.checkCallable();
    this.trivial = trivial;
    return this;
  }

  /** `--aggressive`: a three-way merge also resolving deletions and identical additions. */
  setAggressive(aggressive: boolean): this {
    this.checkCallable();
    this.aggressive = aggressive;
    return this;
  }

  /**
   * `-v`: accepted for parity. git shows only a delayed progress meter ("Updating files"),
   * which an update shorter than two seconds never prints; nothing is reported here.
   */
  setVerbose(_verbose: boolean): this {
    this.checkCallable();
    return this;
  }

  /** `--no-sparse-checkout`: the sparse-checkout patterns are not applied. */
  setSkipSparseCheckout(skip: boolean): this {
    this.checkCallable();
    this.skipSparseCheckout = skip;
    return this;
  }

  async call(): Promise<ReadTreeResult> {
    this.checkCallable();
    this.setCallable(false);
    const fatal = (message: string): never => {
      throw new ReadTreeFailedError(`fatal: ${message}`);
    };
    const result: ReadTreeResult = { warnings: [], unmerged: [] };
    const prefixSet = this.prefix !== undefined;
    if (Number(this.merge) + Number(this.reset) + Number(prefixSet) > 1) {
      fatal("Which one? -m, --reset, or --prefix?");
    }
    if (this.prefix?.startsWith("/")) fatal("Invalid prefix, prefix cannot start with '/'");
    await this.readCurrentIndex();

    let merge = this.merge;
    let unmergedIndex = false;
    for await (const e of this.staging.entries()) {
      if (e.stage !== 0) {
        unmergedIndex = true;
        break;
      }
    }
    if (this.reset || merge || prefixSet) {
      if (unmergedIndex && (prefixSet || merge)) {
        fatal("You need to resolve your current index first");
      }
      merge = true;
    }

    const treeIds: ObjectId[] = [];
    for (const name of this.treeishes) {
      if (treeIds.length >= MAX_UNPACK_TREES) {
        fatal(`I cannot read more than ${MAX_UNPACK_TREES} trees`);
      }
      const id = await this.resolveRevision(name).catch(() => undefined);
      const tree = id ? await this.revisionResolver().peelToType(id, "tree") : undefined;
      if (!id) fatal(`Not a valid object name ${name}`);
      if (!tree) fatal(`failed to unpack tree object ${name}`);
      treeIds.push(tree as ObjectId);
    }
    if (treeIds.length === 0 && !this.empty && !merge) {
      result.warnings.push(
        "warning: read-tree: emptying the index with no arguments is deprecated; use --empty",
      );
    } else if (treeIds.length > 0 && this.empty) {
      fatal("passing trees as arguments contradicts --empty");
    }
    if (this.update && this.indexOnly) fatal("-u and -i at the same time makes no sense");
    if ((this.update || this.indexOnly) && !merge) {
      fatal(`${this.update ? "-u" : "-i"} is meaningless without -m, --reset, or --prefix`);
    }
    if (merge && treeIds.length === 0) fatal("you must specify at least one tree to merge");

    // the worktree checked (none with -i) and updated (-u)
    const checked = this.indexOnly ? undefined : this.worktreeAccess;
    const sequencerCtx = {
      workingCopy: this.workingCopy,
      worktree: checked,
      staging: this.staging,
      blobs: this.blobs,
      trees: this.trees,
      commits: this.commits,
      refs: this.refsStore,
      sparseWarnings: result.warnings,
    };
    const refused = (message: string | undefined, paths: string[] = []) => {
      if (message) throw new ReadTreeFailedError(message, paths);
    };

    if (!merge) {
      await this.readWithoutMerge(treeIds);
    } else if (prefixSet) {
      const prefix = (this.prefix as string).replace(/\/*$/, "/");
      await this.bindMerge(sequencerCtx, treeIds, prefix === "/" ? "" : prefix, result);
    } else if (treeIds.length === 1) {
      const tree = treeIds[0] as ObjectId;
      const refusal = await resetMerge(sequencerCtx, tree, tree, {
        hard: this.reset,
        update: this.update,
        overwriteUntracked: this.reset,
        skipSparseCheckout: this.skipSparseCheckout,
        targetTree: tree,
        plain: true,
      });
      refused(refusal?.message, refusal?.paths);
    } else if (treeIds.length === 2) {
      const [h, m] = treeIds as [ObjectId, ObjectId];
      const refusal = await switchTrees(
        sequencerCtx,
        await flatTree(this.trees, h),
        await flatTree(this.trees, m),
        {
          action: "merge",
          operation: "read-tree",
          update: this.update,
          skipSparseCheckout: this.skipSparseCheckout,
          plainErrors: true,
        },
      );
      refused(refusal?.message, refusal?.paths);
    } else {
      await this.threewayMerge(sequencerCtx, treeIds, result);
    }

    // read-tree starts from no cache-tree and resolve-undo (cache_tree_free,
    // resolve_undo_clear_index); one tree read whole primes it
    this.staging.clearResolveUndo?.();
    if (treeIds.length === 1 && !prefixSet) {
      this.staging.setCacheTree?.(await cacheTreeOfTree(this.trees, treeIds[0] as ObjectId));
    } else {
      this.staging.setCacheTree?.(await this.repairedCacheTree());
    }
    await this.staging.write();
    for await (const e of this.staging.entries()) {
      if (e.stage !== 0 && result.unmerged[result.unmerged.length - 1] !== e.path) {
        result.unmerged.push(e.path);
      }
    }
    return result;
  }

  /** `cache_tree_update(WRITE_TREE_SILENT | WRITE_TREE_REPAIR)` of the index as it is. */
  private async repairedCacheTree() {
    const entries = await this.entryList();
    const trees = this.trees;
    return repairCacheTree(
      { has: async (id: ObjectId) => id === EMPTY_TREE_ID || (await trees.has(id)) },
      entries,
    );
  }

  private async entryList(): Promise<readonly StagingEntry[]> {
    const list = this.staging.entryList?.();
    if (list) return list;
    const out: StagingEntry[] = [];
    for await (const e of this.staging.entries()) out.push(e);
    return out;
  }

  /**
   * unpack-trees without `-m`: the index is the trees' entries (a later tree's entry
   * replacing an earlier one's), at stage 0, without stat data or flags.
   */
  private async readWithoutMerge(treeIds: ObjectId[]): Promise<void> {
    const entries = new Map<string, CheckedEntry>();
    for (const id of treeIds) {
      for (const [path, e] of await flatTree(this.trees, id)) {
        // add_index_entry with OK_TO_REPLACE: a clashing file or directory goes
        for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) {
          entries.delete(path.slice(0, at));
        }
        const under = `${path}/`;
        for (const p of [...entries.keys()]) if (p.startsWith(under)) entries.delete(p);
        entries.set(path, e);
      }
    }
    const builder = this.staging.createBuilder();
    for (const path of [...entries.keys()].sort(compareGitPaths)) {
      const e = entries.get(path) as CheckedEntry;
      builder.add({ path, objectId: e.objectId, mode: e.mode, size: 0, mtime: 0 });
    }
    await builder.finish();
  }

  /**
   * `bind_merge` (`--prefix=<dir>/`): the tree's entries under `<dir>/`, every index entry
   * kept; a path both have is refused ("Entry 'x' overlaps with 'x'.  Cannot bind."). With
   * `-u` the new files are written (an untracked file in the way refused first).
   */
  private async bindMerge(
    ctx: MergeWriteContext,
    treeIds: ObjectId[],
    prefix: string,
    result: ReadTreeResult,
  ): Promise<void> {
    if (treeIds.length !== 1) {
      throw new ReadTreeFailedError(`error: Cannot do a bind merge of ${treeIds.length} trees`);
    }
    const tree = await flatTree(this.trees, treeIds[0] as ObjectId);
    const index = new Map<string, StagingEntry>();
    for (const e of await this.entryList()) index.set(e.path, e);
    const target = new Map<string, CheckedEntry>();
    for (const [p, e] of tree) target.set(`${prefix}${p}`, e);
    const paths = [...target.keys()].sort(compareGitPaths);
    for (const path of paths) {
      if (index.has(path)) {
        throw new ReadTreeFailedError(
          `error: Entry '${path}' overlaps with '${path}'.  Cannot bind.`,
          [path],
        );
      }
    }
    const worktree = this.update ? ctx.worktree : undefined;
    const sparse = worktree && !this.skipSparseCheckout ? await SparseUnpack.start(ctx) : undefined;
    if (worktree) {
      for (const path of paths) {
        if (sparse?.leavesAlone(path)) continue;
        const error = await verifyAbsent(worktree, path, (p) => index.has(p), "untracked");
        if (error) throw new ReadTreeFailedError(error, [path]);
      }
    }
    const writing = new Set(paths.filter((p) => !sparse || sparse.writes(p)));
    if (worktree && writing.size > 0) await this.writeFiles(ctx, worktree, target, writing, index);
    const changes = new Map<string, IndexEntryOptions[]>();
    for (const path of paths) {
      const e = target.get(path) as CheckedEntry;
      const stat = worktree && writing.has(path) ? await worktree.getEntry(path) : undefined;
      changes.set(path, [
        {
          path,
          objectId: e.objectId,
          mode: e.mode,
          ...entryStatOf(stat && !stat.isDirectory ? stat : {}),
        },
      ]);
    }
    await rewriteIndex(this.staging, changes);
    if (sparse && worktree) {
      const outcome = await sparse.finish(ctx, { written: writing });
      pushSparseWarnings(result.warnings, sparse, outcome, false);
    }
  }

  /** The files of `writing` written from `target` (smudged with the result's attributes). */
  private async writeFiles(
    ctx: MergeWriteContext,
    worktree: Worktree,
    target: Map<string, CheckedEntry>,
    writing: Set<string>,
    index: Map<string, CheckedEntry>,
  ): Promise<void> {
    const plan = await planPathsRestore(ctx, target, undefined, writing, "read-tree");
    const attributes = new Map<string, ObjectId>();
    for (const [p, e] of index) if (p.endsWith(".gitattributes")) attributes.set(p, e.objectId);
    for (const p of writing) {
      if (p.endsWith(".gitattributes")) attributes.set(p, (target.get(p) as CheckedEntry).objectId);
    }
    await writeTreeRestorePlan(worktree, ctx.blobs, plan, "read-tree", {
      symlinks: worktreeModeTrust(this.workingCopy, worktree).symlinks,
      gitlinks: true,
      replaceInTheWay: true,
      attributes: { direction: "checkout", index: attributesIndexOf(attributes) },
    });
  }

  /**
   * `threeway_merge` over `<base>... <head> <remote>`: the trivial cases resolved (the
   * index must hold the head's entry, or the result's where `#14ALT`/`#2ALT` allow it),
   * the rest left as stages 1 (the first base), 2 and 3, the worktree untouched there.
   * `--aggressive` resolves deletions on one side with the other unchanged, deletions on
   * both, and identical additions. `--trivial` fails where a file-level merge is needed.
   */
  private async threewayMerge(
    ctx: MergeWriteContext,
    treeIds: ObjectId[],
    result: ReadTreeResult,
  ): Promise<void> {
    const flat = await Promise.all(treeIds.map((id) => flatTree(this.trees, id)));
    const bases = flat.slice(0, -2);
    const head = flat[flat.length - 2] as Map<string, CheckedEntry>;
    const remote = flat[flat.length - 1] as Map<string, CheckedEntry>;
    const indexEntries = new Map<string, StagingEntry>();
    for (const e of await this.entryList()) if (e.stage === 0) indexEntries.set(e.path, e);
    const checkedWorktree = ctx.worktree;
    const worktree = this.update ? checkedWorktree : undefined;
    const sparse = worktree && !this.skipSparseCheckout ? await SparseUnpack.start(ctx) : undefined;
    const quiet = (p: string) => sparse?.leavesAlone(p) === true;
    const trust = checkedWorktree
      ? worktreeModeTrust(this.workingCopy, checkedWorktree)
      : undefined;
    const indexTime = this.staging.getUpdateTime();
    const tracked = (p: string) => indexEntries.has(p);

    const paths = new Set<string>(indexEntries.keys());
    for (const m of flat) for (const p of m.keys()) paths.add(p);
    const sorted = [...paths].sort(compareGitPaths);

    const changes = new Map<string, IndexEntryOptions[]>();
    const writes = new Set<string>();
    const removes = new Set<string>();
    const conflicted: string[] = [];
    let nontrivial = false;
    const fail = (message: string, path: string): never => {
      throw new ReadTreeFailedError(message, [path]);
    };
    const verifyUptodate = async (old: StagingEntry) => {
      if (!checkedWorktree || quiet(old.path)) return;
      if (await entryNotUptodate(checkedWorktree, old.path, old, trust, indexTime)) {
        fail(`error: Entry '${old.path}' not uptodate. Cannot merge.`, old.path);
      }
    };
    const absent = async (path: string, kind: "untracked" | "untrackedRemoved") => {
      if (!worktree || quiet(path)) return;
      const error = await verifyAbsent(worktree, path, tracked, kind);
      if (error) fail(error, path);
    };
    const mergedEntry = async (ce: CheckedEntry, old: StagingEntry | undefined, path: string) => {
      if (!old) {
        await absent(path, "untracked");
        changes.set(path, [{ path, objectId: ce.objectId, mode: ce.mode, size: 0, mtime: 0 }]);
        writes.add(path);
        return;
      }
      if (same(old, ce)) return; // the old entry kept, stat data and flags with it
      await verifyUptodate(old);
      changes.set(path, [
        {
          path,
          objectId: ce.objectId,
          mode: ce.mode,
          size: 0,
          mtime: 0,
          ...(old.skipWorktree ? { skipWorktree: true } : {}),
        },
      ]);
      writes.add(path);
    };
    const deletedEntry = async (old: StagingEntry, path: string) => {
      await verifyUptodate(old);
      changes.set(path, []);
      removes.add(path);
    };

    for (const path of sorted) {
      const index = indexEntries.get(path);
      const h = head.get(path);
      const r = remote.get(path);
      const stages = bases.map((b) => b.get(path));
      const anyAncMissing = stages.some((s) => !s);
      const noAncExists = stages.every((s) => !s);
      let headMatch = 0;
      let remoteMatch = 0;
      if (!same(r, h)) {
        stages.forEach((s, k) => {
          if (same(s, h)) headMatch = k + 1;
          if (same(s, r)) remoteMatch = k + 1;
        });
      }
      // #14, #14ALT, #2ALT
      if (r && headMatch && !remoteMatch) {
        if (index && !same(index, r) && !same(index, h)) {
          fail(`error: Entry '${path}' would be overwritten by merge. Cannot merge.`, path);
        }
        await mergedEntry(r, index, path);
        continue;
      }
      if (index && !same(index, h)) {
        fail(`error: Entry '${path}' would be overwritten by merge. Cannot merge.`, path);
      }
      if (h) {
        // #5ALT, #15
        if (same(h, r)) {
          await mergedEntry(h, index, path);
          continue;
        }
        // #13, #3ALT
        if (remoteMatch && !headMatch) {
          await mergedEntry(h, index, path);
          continue;
        }
      }
      // #1
      if (!h && !r && anyAncMissing) continue;
      if (this.aggressive) {
        const headDeleted = !h;
        const remoteDeleted = !r;
        if (
          (headDeleted && remoteDeleted) ||
          (headDeleted && r && remoteMatch) ||
          (remoteDeleted && h && headMatch)
        ) {
          if (index) {
            await deletedEntry(index, path);
            continue;
          }
          if (!headDeleted) await absent(path, "untrackedRemoved");
          continue;
        }
        if (noAncExists && h && r && same(h, r)) {
          await mergedEntry(h, index, path);
          continue;
        }
      }
      // the "no merge" cases: the index must be up to date
      if (index) await verifyUptodate(index);
      nontrivial = true;
      const list: IndexEntryOptions[] = [];
      if (!headMatch || !remoteMatch) {
        const base = stages.find((s) => s !== undefined);
        if (base) list.push({ path, objectId: base.objectId, mode: base.mode, stage: 1 });
      }
      if (h) list.push({ path, objectId: h.objectId, mode: h.mode, stage: 2 });
      if (r) list.push({ path, objectId: r.objectId, mode: r.mode, stage: 3 });
      for (const e of list) Object.assign(e, { size: 0, mtime: 0 });
      changes.set(path, list);
      conflicted.push(path);
    }
    if (this.trivial && nontrivial) {
      throw new ReadTreeFailedError("error: Merge requires file-level merging");
    }

    // the worktree: removals first, then the files written
    sparse?.conflict(conflicted);
    const target = new Map<string, CheckedEntry>();
    for (const path of writes) {
      const e = changes.get(path)?.[0];
      if (e) target.set(path, e);
    }
    const writing = new Set([...writes].filter((p) => !sparse || sparse.writes(p)));
    if (worktree) {
      if (sparse) {
        const unlink = await sparse.leaving(
          worktree,
          (p) => (removes.has(p) ? undefined : (target.get(p) ?? indexEntries.get(p))),
          { trust },
        );
        await sparse.unlink(worktree, unlink);
      }
      for (const path of removes) {
        if (quiet(path)) continue;
        const entry = await worktree.getEntry(path);
        if (entry && !entry.isDirectory) {
          await worktree.remove(path);
          await pruneEmptyParents(worktree, path);
        }
      }
      if (writing.size > 0) await this.writeFiles(ctx, worktree, target, writing, indexEntries);
      for (const path of writing) {
        const stat = await worktree.getEntry(path);
        const e = changes.get(path)?.[0];
        if (e && stat && !stat.isDirectory) Object.assign(e, entryStatOf(stat));
      }
    }
    await rewriteIndex(this.staging, changes);
    if (sparse && worktree) {
      const outcome = await sparse.finish(ctx, { written: worktree ? writing : new Set() });
      pushSparseWarnings(result.warnings, sparse, outcome, false);
    }
  }
}

/**
 * unpack-trees' `verify_absent` of a path the merge adds (or, `untrackedRemoved`, removes)
 * with no index entry there: an untracked file or link in the way (ignored files are
 * expendable: `preserve_ignored` is off with `-u`), or a directory holding untracked files.
 * Returns git's plain message, or undefined.
 */
async function verifyAbsent(
  worktree: Worktree,
  path: string,
  tracked: (path: string) => boolean,
  kind: "untracked" | "untrackedRemoved",
): Promise<string | undefined> {
  const parts = path.split("/");
  for (let k = 1; k < parts.length; k++) {
    const prefix = parts.slice(0, k).join("/");
    const entry = await worktree.getEntry(prefix).catch(() => undefined);
    if (!entry) return undefined;
    if (entry.isDirectory) continue;
    if (tracked(prefix) || (await worktree.isIgnored(prefix))) return undefined;
    return firstPlainError({ [kind]: [prefix] });
  }
  const entry = await worktree.getEntry(path).catch(() => undefined);
  if (!entry) return undefined;
  if (entry.isDirectory) {
    if (entry.mode === FileMode.GITLINK) return undefined;
    if (await untrackedUnder(worktree, path, tracked)) {
      return firstPlainError({ lostDir: [path] });
    }
    return undefined;
  }
  if (await worktree.isIgnored(path)) return undefined;
  return firstPlainError({ [kind]: [path] });
}
