import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import { mergeLines } from "@statewalker/vcs-utils";
import type { Worktree } from "@statewalker/vcs-working-tree";

import {
  InvalidArgumentError,
  NoHeadError,
  RefNotFoundError,
  StashApplyFailedError,
  StoreNotAvailableError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { type ContentMergeStrategy, MergeStrategy } from "../results/merge-result.js";
import type { StashApplyResult } from "../results/stash-result.js";
import { StashApplyStatus } from "../results/stash-result.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { STASH_REF } from "./stash-list-command.js";
import { planTreeRestore, type TreeRestorePlan, writeTreeRestorePlan } from "./tree-restore.js";
import {
  type CheckedEntry,
  findInTheWay,
  overwriteMessage,
  pruneEmptyParents,
  worktreeDiffers,
} from "./worktree-overwrite-checks.js";

/** A path both the index and the stash changed beyond a clean merge. */
interface MergeConflict {
  base?: CheckedEntry;
  ours?: CheckedEntry;
  theirs?: CheckedEntry;
  /** The file with conflict markers, for a text conflict */
  content?: Uint8Array;
  mode: number;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

const sameEntry = (a: CheckedEntry | undefined, b: CheckedEntry | undefined) =>
  a === undefined || b === undefined ? a === b : a.objectId === b.objectId && a.mode === b.mode;

/** Names this operation in restore failure messages. */
const STASH_APPLY = "stash apply";

/**
 * Command to apply a stashed commit.
 *
 * Equivalent to `git stash apply`.
 *
 * Based on JGit's StashApplyCommand.
 *
 * As git's `stash apply`: the stash's change is merged into the current index (staged
 * content and newly staged files take part), line by line where both sides changed a
 * file; the result goes to the worktree, refused up front where it would overwrite local
 * changes or untracked files. A content conflict is written with conflict markers and
 * staged at stages 1-3 (status CONFLICTS). Without `setRestoreIndex(true)` (`--index`)
 * the index keeps its entries plus the files the stash adds; the stashed untracked files
 * are restored first, refused (nothing written) where a file stands in their way.
 *
 * Known limits: a gitlink's contents are not restored, as in git; the restore is not
 * atomic across the working tree and the index.
 *
 * @example
 * ```typescript
 * // Apply most recent stash
 * const result = await git.stashApply().call();
 *
 * // Apply specific stash
 * const result = await git.stashApply()
 *   .setStashRef("stash@{2}")
 *   .call();
 *
 * // Apply without restoring index
 * const result = await git.stashApply()
 *   .setRestoreIndex(false)
 *   .call();
 * ```
 */
export class StashApplyCommand extends GitCommand<StashApplyResult> {
  private stashRef?: string;
  private restoreIndex = false;
  private restoreUntracked = true;
  private strategy = MergeStrategy.RECURSIVE;
  private contentStrategy?: ContentMergeStrategy;

  /**
   * Set the stash reference to apply.
   *
   * Defaults to stash@{0} (most recent) if not specified.
   *
   * @param stashRef Name of the stash ref to apply
   */
  setStashRef(stashRef: string): this {
    this.checkCallable();
    this.stashRef = stashRef;
    return this;
  }

  /**
   * Get the stash reference.
   */
  getStashRef(): string | undefined {
    return this.stashRef;
  }

  /**
   * Set whether to restore the index state (`git stash apply --index`): the stash's index
   * change is merged into the current index, and a conflict there refuses the apply
   * ("conflicts in index. Try without --index."). Off by default, as in git: the index then
   * keeps its entries, plus the files the stash adds.
   *
   * @param restoreIndex true to restore the index (default false)
   */
  setRestoreIndex(restoreIndex: boolean): this {
    this.checkCallable();
    this.restoreIndex = restoreIndex;
    return this;
  }

  /**
   * Get whether index will be restored.
   */
  getRestoreIndex(): boolean {
    return this.restoreIndex;
  }

  /**
   * Set whether to restore untracked files.
   *
   * @param restoreUntracked true to restore untracked files (default)
   */
  setRestoreUntracked(restoreUntracked: boolean): this {
    this.checkCallable();
    this.restoreUntracked = restoreUntracked;
    return this;
  }

  /**
   * Get whether untracked files will be restored.
   */
  getRestoreUntracked(): boolean {
    return this.restoreUntracked;
  }

  /**
   * Set whether to ignore repository state when applying.
   *
   * Note: Currently not implemented - stash apply always ignores repo state.
   *
   * @param _ignore true to ignore state
   */
  setIgnoreRepositoryState(_ignore: boolean): this {
    this.checkCallable();
    // Not currently implemented - reserved for future use
    return this;
  }

  /**
   * Set the merge strategy to use.
   *
   * @param strategy The merge strategy
   */
  setStrategy(strategy: MergeStrategy): this {
    this.checkCallable();
    this.strategy = strategy;
    return this;
  }

  /**
   * Get the merge strategy.
   */
  getStrategy(): MergeStrategy {
    return this.strategy;
  }

  /**
   * Set the content merge strategy for file-level conflicts.
   *
   * @param strategy The content merge strategy
   */
  setContentMergeStrategy(strategy: ContentMergeStrategy): this {
    this.checkCallable();
    this.contentStrategy = strategy;
    return this;
  }

  /**
   * Get the content merge strategy.
   */
  getContentMergeStrategy(): ContentMergeStrategy | undefined {
    return this.contentStrategy;
  }

  /**
   * Execute the stash apply command.
   *
   * @returns Result of the apply operation
   */
  async call(): Promise<StashApplyResult> {
    this.checkCallable();
    this.setCallable(false);

    // Applying a stash means putting files back. A repository with no working
    // tree has nowhere to put them, and reporting OK there would be the same
    // silent no-op this command used to be.
    const worktree = this.worktreeAccess;
    if (!worktree) {
      throw new StoreNotAvailableError("worktree", "stash apply requires a working tree");
    }

    // Get HEAD commit
    const headRef = await this.refsStore.resolve("HEAD");
    if (!headRef?.objectId) {
      throw new NoHeadError("HEAD is required to apply stash");
    }

    // Get stash commit
    const stashId = await this.resolveStashRef();
    const stashCommit = await this.commits.load(stashId);
    if (!stashCommit) {
      throw new RefNotFoundError(stashId, "Stash commit not found");
    }

    // Validate stash commit structure
    if (stashCommit.parents.length < 2 || stashCommit.parents.length > 3) {
      throw new InvalidArgumentError(
        "stashRef",
        stashId,
        `Stash commit ${stashId} has invalid number of parents: ${stashCommit.parents.length}`,
      );
    }

    const stashHeadCommit = stashCommit.parents[0];
    const stashIndexCommit = stashCommit.parents[1];
    const stashUntrackedCommit = stashCommit.parents[2]; // Optional

    // git's do_apply_stash: the stash's change (its base -> its worktree tree) merged into
    // the current index ("ours" is the tree written from the index, so staged content and
    // newly staged files take part), the result written to the worktree; with --index the
    // stash's index change is merged into the index too, else the index keeps its entries
    // plus the files the stash adds.
    const headCommit = await this.commits.load(headRef.objectId);
    const stashHeadCommitObj = await this.commits.load(stashHeadCommit);
    if (!headCommit || !stashHeadCommitObj) {
      throw new RefNotFoundError(headRef.objectId, "Head or stash commit not found");
    }
    const unmerged: string[] = [];
    const index = new Map<string, CheckedEntry>();
    for await (const entry of this.staging.entries()) {
      if (entry.stage === 0) index.set(entry.path, entry);
      else unmerged.push(entry.path);
    }
    if (unmerged.length > 0) {
      throw new StashApplyFailedError(
        stashId,
        [...new Set(unmerged)],
        "error: you need to resolve your current index first",
      );
    }
    const base = await this.flatTree(stashHeadCommitObj.tree);
    const stashWorking = await this.flatTree(stashCommit.tree);
    const ours = new Map(index);

    // --index: the stash's index change onto the current index, refused on a conflict
    let restoredIndex: Map<string, CheckedEntry> | undefined;
    if (this.restoreIndex) {
      const stashIndexCommitObj = await this.commits.load(stashIndexCommit);
      const stashIndex = stashIndexCommitObj ? await this.flatTree(stashIndexCommitObj.tree) : base;
      const indexMerge = await this.mergeFlat(base, ours, stashIndex);
      if (indexMerge.conflicts.size > 0) {
        throw new StashApplyFailedError(
          stashId,
          [...indexMerge.conflicts.keys()],
          "error: conflicts in index. Try without --index.",
        );
      }
      restoredIndex = indexMerge.result;
    }

    const merge = await this.mergeFlat(base, ours, stashWorking);

    // symlinks are restored as links, or as files holding the target where the worktree
    // or core.symlinks cannot have links (as clone writes them)
    const trust = worktreeModeTrust(this.workingCopy, worktree);
    const ignoreCase = coreBool(this.workingCopy, "ignorecase", false);
    // every path of the result verified (verify_path, collisions) before anything is written
    const resultTree = await this.storeFlat(merge.result);
    const worktreePlan = await planTreeRestore(this.trees, this.blobs, resultTree, STASH_APPLY, {
      symlinks: true,
      ignoreCase,
      windows: worktree.capabilities?.windowsPaths === true,
      reservedNames: worktree.capabilities?.reservedNames,
    });

    // Only what the merge changes is touched: the paths where its result differs from the
    // index are written or removed; an unrelated unstaged edit is left alone
    const changed = [...new Set([...ours.keys(), ...merge.result.keys()])]
      .filter((p) => !merge.untouched.has(p))
      .filter((p) => !sameEntry(ours.get(p), merge.result.get(p)) || merge.conflicts.has(p))
      .sort();
    const writes = changed.filter((p) => merge.result.has(p) || merge.conflicts.get(p)?.content);
    const removes = changed.filter(
      (p) => !merge.result.has(p) && ours.has(p) && !merge.conflicts.get(p)?.content,
    );

    // git's merge refuses before writing anything (protecting untracked files): local
    // changes on a path the merge changes, untracked files where it writes, untracked files
    // in a directory a file of the stash replaces
    const local: string[] = [];
    for (const path of changed) {
      const i = index.get(path);
      if (i && (await worktreeDiffers(worktree, path, i, trust))) local.push(path);
    }
    const found = await findInTheWay(worktree, {
      writes,
      removes: new Set(removes),
      index,
      ignoreCase,
    });
    const refused = overwriteMessage("merge", { local, ...found });
    if (refused) {
      throw new StashApplyFailedError(
        stashId,
        [...local, ...found.lostDirs, ...found.untracked],
        refused,
      );
    }
    // the stashed untracked files, checked (leading components too) before any write
    const untrackedPlan = await this.planUntrackedRestore(
      stashUntrackedCommit,
      worktreePlan,
      worktree,
    );

    // Everything below this line writes. Deletions first, as git's unpack-trees: a
    // deleted file or link `d` makes way for `d/x` and is never written through.
    if (untrackedPlan) {
      // git restores the untracked files first; they stay untracked
      await writeTreeRestorePlan(worktree, this.blobs, untrackedPlan, STASH_APPLY, {
        symlinks: trust.symlinks,
      });
    }
    for (const path of removes) {
      await worktree.remove(path);
      await pruneEmptyParents(worktree, path);
    }
    const writing = new Set(writes.filter((p) => merge.result.has(p)));
    await writeTreeRestorePlan(
      worktree,
      this.blobs,
      {
        ...worktreePlan,
        entries: worktreePlan.entries.filter((e) => writing.has(e.path)),
        gitlinks: [],
      },
      STASH_APPLY,
      { symlinks: trust.symlinks, replaceInTheWay: true },
    );
    // conflicted files get their content with conflict markers, as git writes them
    for (const [path, conflict] of merge.conflicts) {
      if (!conflict.content) continue;
      await worktree.writeContent(path, conflict.content, {
        mode: conflict.mode,
        createParents: true,
        replaceInTheWay: true,
      });
    }

    // the index
    const editor = this.staging.createEditor();
    const stage = async (path: string, entry: CheckedEntry, stageNumber: 0 | 1 | 2 | 3) => {
      const stats = stageNumber === 0 ? await worktree.getEntry(path) : undefined;
      editor.upsert({
        path,
        objectId: entry.objectId,
        mode: entry.mode,
        stage: stageNumber,
        size: stats?.size ?? 0,
        mtime: stats?.mtime ?? 0,
      });
    };
    if (merge.conflicts.size > 0) {
      // a conflicted merge leaves its result staged and the conflicts at stages 1-3
      for (const path of changed) {
        const result = merge.result.get(path);
        const conflict = merge.conflicts.get(path);
        if (conflict) {
          editor.remove(path);
          if (conflict.base) await stage(path, conflict.base, 1);
          if (conflict.ours) await stage(path, conflict.ours, 2);
          if (conflict.theirs) await stage(path, conflict.theirs, 3);
        } else if (result) await stage(path, result, 0);
        else editor.remove(path);
      }
      await editor.finish();
      await this.staging.write();
      return {
        status: StashApplyStatus.CONFLICTS,
        stashCommit: stashId,
        conflicts: [...merge.conflicts.keys()].sort(),
      };
    }
    if (restoredIndex) {
      // --index: the index is the stash's index change merged into it
      for (const path of new Set([...index.keys(), ...restoredIndex.keys()])) {
        const entry = restoredIndex.get(path);
        if (sameEntry(index.get(path), entry)) continue;
        if (entry) await stage(path, entry, 0);
        else editor.remove(path);
      }
    } else {
      // the index keeps its entries, plus the files the stash adds (git stages them)
      for (const path of changed) {
        const result = merge.result.get(path);
        if (result && !ours.has(path)) await stage(path, result, 0);
      }
    }
    await editor.finish();
    await this.staging.write();

    return {
      status: StashApplyStatus.OK,
      stashCommit: stashId,
    };
  }

  /** A merge conflict: the three sides, and the file content with markers if any. */
  private async mergeFlat(
    base: Map<string, CheckedEntry>,
    ours: Map<string, CheckedEntry>,
    theirs: Map<string, CheckedEntry>,
  ): Promise<{
    result: Map<string, CheckedEntry>;
    conflicts: Map<string, MergeConflict>;
    /** Paths a file/directory conflict leaves alone (below the conflicted file) */
    untouched: Set<string>;
  }> {
    const result = new Map<string, CheckedEntry>();
    const conflicts = new Map<string, MergeConflict>();
    for (const path of new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      let merged: CheckedEntry | undefined;
      if (sameEntry(o, t) || sameEntry(b, t)) merged = o;
      else if (sameEntry(b, o)) merged = t;
      else {
        // both sides changed the path: a line merge of regular files, else a conflict
        const textual = (e?: CheckedEntry) =>
          e === undefined ||
          e.mode === FileMode.REGULAR_FILE ||
          e.mode === FileMode.EXECUTABLE_FILE;
        if (o && t && textual(o) && textual(t) && textual(b)) {
          const read = async (e?: CheckedEntry) => {
            if (!e) return new Uint8Array(0);
            const chunks: Uint8Array[] = [];
            for await (const chunk of (await this.blobs.load(e.objectId)) ?? []) chunks.push(chunk);
            return concatBytes(chunks);
          };
          const mode = o.mode === t.mode ? o.mode : b && o.mode === b.mode ? t.mode : o.mode;
          const lines = mergeLines(await read(b), await read(o), await read(t), {
            oursLabel: "Updated upstream",
            theirsLabel: "Stashed changes",
          });
          if (lines.conflicts === 0) {
            merged = { objectId: await this.blobs.store([lines.content]), mode };
          } else {
            conflicts.set(path, { base: b, ours: o, theirs: t, content: lines.content, mode });
            continue;
          }
        } else {
          // modify/delete, or a link or submodule changed on both sides: the surviving side
          // stays in the worktree as it is
          conflicts.set(path, { base: b, ours: o, theirs: t, mode: (o ?? t)?.mode ?? 0 });
          continue;
        }
      }
      if (merged) result.set(path, merged);
    }
    // a path cannot be a file and a directory at once (CONFLICT (file/directory)): the file
    // is reported, and neither it nor the paths below it are touched
    const untouched = new Set<string>();
    const paths = [...result.keys()].sort();
    for (const path of paths) {
      const below = paths.filter((q) => q.startsWith(`${path}/`));
      if (below.length === 0) continue;
      conflicts.set(path, {
        base: base.get(path),
        ours: ours.get(path),
        theirs: theirs.get(path),
        mode: result.get(path)?.mode ?? 0,
      });
      result.delete(path);
      for (const q of below) {
        result.delete(q);
        untouched.add(q);
      }
    }
    return { result, conflicts, untouched };
  }

  /** Stores a flat path map as a tree. */
  private async storeFlat(entries: Map<string, CheckedEntry>): Promise<ObjectId> {
    type Node = Map<string, Node | CheckedEntry>;
    const root: Node = new Map();
    for (const [path, entry] of entries) {
      const parts = path.split("/");
      let node = root;
      for (const part of parts.slice(0, -1)) {
        let next = node.get(part);
        if (!(next instanceof Map)) {
          next = new Map();
          node.set(part, next);
        }
        node = next;
      }
      node.set(parts[parts.length - 1], entry);
    }
    const store = async (node: Node): Promise<ObjectId> => {
      const list: { name: string; mode: number; id: ObjectId }[] = [];
      for (const [name, value] of node) {
        if (value instanceof Map) list.push({ name, mode: FileMode.TREE, id: await store(value) });
        else list.push({ name, mode: value.mode, id: value.objectId });
      }
      return this.trees.storeTree(list);
    };
    return store(root);
  }

  /** The blobs, links and gitlinks of a tree, by path. */
  private async flatTree(treeId: ObjectId): Promise<Map<string, CheckedEntry>> {
    const out = new Map<string, CheckedEntry>();
    const walk = async (id: ObjectId, prefix: string): Promise<void> => {
      for await (const entry of this.trees.loadTree(id)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === FileMode.TREE) await walk(entry.id, path);
        else out.set(path, { objectId: entry.id, mode: entry.mode });
      }
    };
    await walk(treeId, "");
    return out;
  }

  /**
   * Plan the restore of the stash's untracked files, if there are any to restore.
   *
   * Untracked files are stashed in their own parentless commit and are not
   * merged with anything: they are simply written back. A stashed untracked
   * file whose path is already taken - by a file on disk, or by one the merged
   * tree is about to write - is refused rather than overwritten, since nothing
   * in the stash records what the displaced content was.
   *
   * @param untrackedCommitId The stash's third parent, if it has one
   * @param worktreePlan The already-planned restore of the merged working tree
   * @param worktree The working tree, checked for existing files
   * @returns The plan, or undefined if there is nothing to restore
   */
  private async planUntrackedRestore(
    untrackedCommitId: ObjectId | undefined,
    worktreePlan: TreeRestorePlan,
    worktree: Worktree,
  ): Promise<TreeRestorePlan | undefined> {
    if (!this.restoreUntracked || !untrackedCommitId) {
      return undefined;
    }

    const untrackedCommit = await this.commits.load(untrackedCommitId);
    if (!untrackedCommit) {
      throw new RefNotFoundError(untrackedCommitId, "Stash untracked commit not found");
    }

    const plan = await planTreeRestore(this.trees, this.blobs, untrackedCommit.tree, STASH_APPLY, {
      symlinks: true,
      ignoreCase: coreBool(this.workingCopy, "ignorecase", false),
      windows: worktree.capabilities?.windowsPaths === true,
      reservedNames: worktree.capabilities?.reservedNames,
    });

    for (const { path } of plan.entries) {
      // a file on a leading component: git cannot create the directory, and restores
      // nothing ("cannot create directory at 'd': File exists")
      const parts = path.split("/");
      for (let k = 1; k < parts.length; k++) {
        const prefix = parts.slice(0, k).join("/");
        const entry = await worktree.getEntry(prefix);
        if (entry && !entry.isDirectory) {
          throw new StashApplyFailedError(
            untrackedCommitId,
            [prefix],
            `fatal: cannot create directory at '${prefix}': File exists\nerror: could not restore untracked files from stash`,
          );
        }
      }
      if (worktreePlan.paths.has(path) || (await worktree.exists(path))) {
        throw new StashApplyFailedError(
          untrackedCommitId,
          undefined,
          `stash apply would overwrite ${path} with a stashed untracked file`,
        );
      }
    }

    return plan;
  }

  /**
   * Resolve the stash reference to a commit ID.
   */
  private async resolveStashRef(): Promise<ObjectId> {
    const refName = this.stashRef ?? `${STASH_REF}@{0}`;

    // Handle stash@{N} syntax
    const match = refName.match(/^(.+)@\{(\d+)\}$/);
    if (match) {
      let baseRef = match[1];
      const index = parseInt(match[2], 10);

      // Normalize stash to refs/stash
      if (baseRef === "stash") {
        baseRef = STASH_REF;
      }

      // For index 0, just resolve the ref
      if (index === 0) {
        const ref = await this.refsStore.resolve(baseRef);
        if (!ref?.objectId) {
          throw new RefNotFoundError(refName);
        }
        return ref.objectId;
      }

      // Older entries are in the ref's reflog (stash@{n}), as git reads them
      const reflog = await this.refsStore.getReflog?.(baseRef);
      if (!reflog) {
        throw new RefNotFoundError(refName, `Stash entry ${index} not found (no reflog)`);
      }
      const entry = await reflog.getReverseEntry(index);
      if (!entry) throw new RefNotFoundError(refName, `Stash entry ${index} not found`);
      return entry.newId;
    }

    // Try as direct ref
    const ref = await this.refsStore.resolve(refName);
    if (ref?.objectId) {
      return ref.objectId;
    }

    // Try as commit ID
    if (await this.commits.has(refName)) {
      return refName;
    }

    throw new RefNotFoundError(refName);
  }
}
