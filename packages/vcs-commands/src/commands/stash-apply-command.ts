import { FileMode, type ObjectId } from "@statewalker/vcs-core";
import { mergeLines } from "@statewalker/vcs-utils";
import {
  attributesIndexOf,
  type ContentAttributesContext,
  entryStatOf,
  type Worktree,
} from "@statewalker/vcs-working-tree";
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
import { conflictStyleOf } from "./merge-config.js";
import { ortConfigOptions } from "./merge-drivers.js";
import { type OrtConflict, ortMerge, ortResultEntries, readBlob } from "./ort-merge.js";
import { STASH_REF } from "./stash-list-command.js";
import {
  planTreeRestore,
  restoreCaseOptions,
  type TreeRestorePlan,
  writeTreeRestorePlan,
} from "./tree-restore.js";
import {
  type CheckedEntry,
  findInTheWay,
  overwriteMessage,
  pruneEmptyParents,
  removeDirectoryIfEmpty,
  worktreeDiffers,
} from "./worktree-overwrite-checks.js";

/** A path the index and the stash changed beyond a clean merge, as git leaves it. */
type MergeConflict = OrtConflict;

const sameEntry = (a: CheckedEntry | undefined, b: CheckedEntry | undefined) =>
  a === undefined || b === undefined ? a === b : a.objectId === b.objectId && a.mode === b.mode;

/** Names this operation in restore failure messages. */
const STASH_APPLY = "stash apply";

/** Removes the directory at `path` if nothing is in it (git's `rmdir` of a submodule). */
async function removeIfEmptyDirectory(worktree: Worktree, path: string): Promise<void> {
  const entry = await worktree.getEntry(path);
  if (!entry?.isDirectory) {
    if (entry) await worktree.remove(path);
    return;
  }
  await removeDirectoryIfEmpty(worktree, path);
}

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
    // one batch: the checks and the writes share one reading of the ignore rules
    return worktree.batch ? worktree.batch(() => this.apply(worktree)) : this.apply(worktree);
  }

  private async apply(worktree: Worktree): Promise<StashApplyResult> {
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
    const ignoreCase = coreBool(this.workingCopy, "ignorecase", false);
    const base = await this.flatTree(stashHeadCommitObj.tree);
    const stashWorking = await this.flatTree(stashCommit.tree);
    const ours = new Map(index);

    // --index: the stash's index change onto the current index, refused on a conflict
    let restoredIndex: Map<string, CheckedEntry> | undefined;
    if (this.restoreIndex) {
      const stashIndexCommitObj = await this.commits.load(stashIndexCommit);
      const stashIndex = stashIndexCommitObj ? await this.flatTree(stashIndexCommitObj.tree) : base;
      // git's has_index: the stash's index differs from its base and from the index
      const differs = (a: Map<string, CheckedEntry>, b: Map<string, CheckedEntry>) =>
        a.size !== b.size || [...a].some(([p, e]) => !sameEntry(e, b.get(p)));
      if (differs(stashIndex, base) && differs(stashIndex, ours)) {
        // the stash's index change applied to the index as `git apply --cached` applies it
        const applied = await this.applyCached(base, ours, stashIndex);
        if (applied.errors.length > 0) {
          throw new StashApplyFailedError(
            stashId,
            applied.failed,
            [...applied.errors, "error: conflicts in index. Try without --index."].join("\n"),
          );
        }
        restoredIndex = applied.result;
        // git's reset of the index to HEAD records ORIG_HEAD
        await this.refsStore.set("ORIG_HEAD", headRef.objectId);
      }
    }

    const merge = await this.mergeFlat(base, ours, stashWorking, ignoreCase);

    // symlinks are restored as links, or as files holding the target where the worktree
    // or core.symlinks cannot have links (as clone writes them)
    const trust = worktreeModeTrust(this.workingCopy, worktree);
    // every path of the result verified (verify_path, collisions) before anything is written
    const resultTree = await this.storeFlat(merge.result);
    const worktreePlan = await planTreeRestore(this.trees, this.blobs, resultTree, STASH_APPLY, {
      symlinks: true,
      ...(await restoreCaseOptions(worktree, ignoreCase)),
      windows: worktree.capabilities?.windowsPaths === true,
      reservedNames: worktree.capabilities?.reservedNames,
    });

    // Only what the merge changes is touched: the paths where its result differs from the
    // index, and its conflicts, are written, removed or staged; an unrelated unstaged edit is
    // left alone
    const conflicts = merge.conflicts;
    const changed = [...new Set([...ours.keys(), ...merge.result.keys(), ...conflicts.keys()])]
      .filter((p) => conflicts.has(p) || !sameEntry(ours.get(p), merge.result.get(p)))
      .sort();
    const movedFrom = new Set(
      [...conflicts.values()].flatMap((c) => (c.moveFrom ? [c.moveFrom] : [])),
    );
    const removes = changed.filter((p) => !merge.result.has(p) && ours.has(p) && !conflicts.has(p));
    const conflictWrites = [...conflicts.values()].filter((c) => c.content || c.write);
    const writes = [
      ...changed.filter((p) => merge.result.has(p) && !conflicts.has(p)),
      ...conflictWrites.map((c) => c.stagePath),
    ];

    // git's merge refuses before writing anything (protecting untracked files): local
    // changes on a path the merge changes, untracked files where it writes, untracked files
    // in a directory a file of the stash replaces (ignored files are expendable)
    const local: string[] = [];
    for (const path of changed) {
      // a conflict that leaves the worktree file as it is (rename/rename, rename/delete on
      // our side, a binary conflict) only stages: git keeps an unstaged edit there
      const conflict = conflicts.get(path);
      if (conflict && !conflict.content && !conflict.write && !conflict.moveFrom) continue;
      const i = index.get(path);
      if (i && (await worktreeDiffers(worktree, path, i, trust, this.staging.getUpdateTime())))
        local.push(path);
    }
    const found = await findInTheWay(worktree, {
      writes,
      removes: new Set([...removes, ...movedFrom]),
      index,
      ignoreCase,
    });
    // the stashed untracked files (their paths validated before any write); restored
    // after the merge, as git restores them (`checkout-index --all` of their own index)
    const untrackedPlan = await this.planUntrackedRestore(stashUntrackedCommit, worktree);
    const refused = overwriteMessage("merge", { local, ...found });
    if (refused) {
      // a refused merge still restores the untracked files (git's goto restore_untracked)
      let restoreError = "";
      try {
        await this.writeUntracked(untrackedPlan, worktree, stashId, trust.symlinks);
      } catch (error) {
        restoreError = `\n${(error as Error).message}`;
      }
      throw new StashApplyFailedError(
        stashId,
        [...local, ...found.lostDirs, ...found.untracked],
        `${refused}${restoreError}`,
      );
    }

    // Everything below this line writes.
    // git writes the merge's result through unpack-trees: every file smudged with the
    // attributes of the merged index (whatever order the files are written in)
    const attributes: ContentAttributesContext = {
      direction: "checkout",
      index: attributesIndexOf([...merge.result].map(([p, e]) => [p, e.objectId] as const)),
    };
    // a file a file/directory conflict moves aside goes to `<path>~<side>` first
    for (const conflict of conflicts.values()) {
      if (!conflict.moveFrom) continue;
      if (conflict.write?.mode === FileMode.GITLINK) {
        // a submodule moved aside: staged at stage 2, its new path an empty directory (as
        // git checks out an unpopulated submodule); the old directory goes only if empty
        if (!(await worktree.getEntry(conflict.stagePath))) {
          await worktree.mkdir(conflict.stagePath);
        }
        await removeIfEmptyDirectory(worktree, conflict.moveFrom);
        continue;
      }
      if (conflict.content) {
        await worktree.writeContent(conflict.stagePath, conflict.content, {
          mode: conflict.mode,
          createParents: true,
          replaceInTheWay: true,
          attributes,
        });
      } else if (conflict.write) {
        await this.writeBlob(
          worktree,
          conflict.stagePath,
          conflict.write,
          trust.symlinks,
          attributes,
        );
      }
      await worktree.remove(conflict.moveFrom);
    }
    // deletions next, as git's unpack-trees: a deleted file or link `d` makes way for `d/x`
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
      { symlinks: trust.symlinks, replaceInTheWay: true, attributes },
    );
    // conflicted files: the text with git's markers, or the surviving side of a
    // modify/delete; a binary conflict keeps ours as it is
    for (const conflict of conflicts.values()) {
      if (conflict.moveFrom) continue;
      if (conflict.content) {
        await worktree.writeContent(conflict.stagePath, conflict.content, {
          mode: conflict.mode,
          createParents: true,
          replaceInTheWay: true,
          attributes,
        });
      } else if (conflict.write) {
        await this.writeBlob(
          worktree,
          conflict.stagePath,
          conflict.write,
          trust.symlinks,
          attributes,
        );
      }
    }

    // merge-ort records the tree it wrote (AUTO_MERGE), clean or not; a stash whose
    // worktree is its base is "Already up to date." (merge_ort_nonrecursive): no merge
    const autoMerge = await ortResultEntries(this.blobs, { ...merge, messages: [], clean: true });
    if (stashCommit.tree !== stashHeadCommitObj.tree) {
      await this.refsStore.set("AUTO_MERGE", await this.storeFlat(autoMerge));
    }

    // the index
    const editor = this.staging.createEditor();
    const stage = async (path: string, entry: CheckedEntry, stageNumber: 0 | 1 | 2 | 3) => {
      // the worktree's stat only for a file that holds the staged blob (else it is rehashed)
      let stats: { size: number; mtime: number; ctime?: number } | undefined;
      if (stageNumber === 0) {
        const current = await worktree.getEntry(path);
        if (
          current &&
          !current.isDirectory &&
          (await worktree.computeHash(path)) === entry.objectId
        ) {
          stats = current;
        }
      }
      editor.upsert({
        path,
        objectId: entry.objectId,
        mode: entry.mode,
        stage: stageNumber,
        ...entryStatOf(stats ?? {}),
      });
    };
    if (conflicts.size > 0) {
      // a conflicted merge leaves its result staged and the conflicts at stages 1-3
      for (const path of changed) {
        const result = merge.result.get(path);
        const conflict = conflicts.get(path);
        if (conflict) {
          editor.remove(path);
          if (conflict.base) await stage(conflict.stagePath, conflict.base, 1);
          if (conflict.ours) await stage(conflict.stagePath, conflict.ours, 2);
          if (conflict.theirs) await stage(conflict.stagePath, conflict.theirs, 3);
        } else if (result) await stage(path, result, 0);
        else editor.remove(path);
      }
      await editor.finish();
      await this.staging.write();
      await this.writeUntracked(untrackedPlan, worktree, stashId, trust.symlinks);
      return {
        status: StashApplyStatus.CONFLICTS,
        stashCommit: stashId,
        conflicts: [...conflicts.keys()].sort(),
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
    await this.writeUntracked(untrackedPlan, worktree, stashId, trust.symlinks);

    return {
      status: StashApplyStatus.OK,
      stashCommit: stashId,
    };
  }

  /** Writes a blob to the worktree (a link as a link where the worktree has them). */
  private async writeBlob(
    worktree: Worktree,
    path: string,
    entry: CheckedEntry,
    symlinks: boolean,
    attributes: ContentAttributesContext,
  ): Promise<void> {
    const content = await this.blobs.load(entry.objectId);
    if (!content) throw new Error(`${STASH_APPLY} cannot restore ${path}: blob missing`);
    const mode = entry.mode === FileMode.SYMLINK && !symlinks ? FileMode.REGULAR_FILE : entry.mode;
    // a link written as a file holds its target as it is (never smudged)
    await worktree.writeContent(path, content, {
      mode,
      ...(mode !== entry.mode ? { raw: true } : {}),
      createParents: true,
      replaceInTheWay: true,
      attributes,
    });
  }

  /**
   * git's ort merge of a stash: `base` (the stash's parent) to `ours` (the current index)
   * and to `theirs` (the stash), with git's labels (`Updated upstream` / `Stashed changes`,
   * `Stash base` for diff3), shared with `merge` ({@link ortMerge}).
   */
  private async mergeFlat(
    baseIn: Map<string, CheckedEntry>,
    oursIn: Map<string, CheckedEntry>,
    theirsIn: Map<string, CheckedEntry>,
    ignoreCase = false,
  ): Promise<{
    result: Map<string, CheckedEntry>;
    conflicts: Map<string, MergeConflict>;
  }> {
    const { result, conflicts } = await ortMerge(this.blobs, baseIn, oursIn, theirsIn, {
      oursLabel: "Updated upstream",
      theirsLabel: "Stashed changes",
      baseLabel: "Stash base",
      style: conflictStyleOf(this.workingCopy),
      ignoreCase,
      ...ortConfigOptions(this.workingCopy, this.worktreeAccess),
    });
    return { result, conflicts };
  }

  /**
   * `git apply --cached` of the change `from` -> `to` onto `index`: a path the change adds
   * must not be in the index, a path it deletes or modifies must be there; a deletion needs
   * the index to hold the deleted version, a modification applies where the index holds
   * the old version or its edit merges cleanly with the index's (the patch's context
   * matches). Errors as git's apply reports them.
   */
  private async applyCached(
    from: Map<string, CheckedEntry>,
    index: Map<string, CheckedEntry>,
    to: Map<string, CheckedEntry>,
  ): Promise<{ result: Map<string, CheckedEntry>; errors: string[]; failed: string[] }> {
    const result = new Map(index);
    const errors: string[] = [];
    const failed: string[] = [];
    const paths = [...new Set([...from.keys(), ...to.keys()])].sort(compareBytes);
    for (const path of paths) {
      const b = from.get(path);
      const t = to.get(path);
      if (sameEntry(b, t)) continue;
      const current = index.get(path);
      if (!b && t) {
        if (current) {
          errors.push(`error: ${path}: already exists in index`);
          failed.push(path);
        } else result.set(path, t);
        continue;
      }
      if (!current) {
        errors.push(`error: ${path}: does not exist in index`);
        failed.push(path);
        continue;
      }
      if (b && !t) {
        if (current.objectId !== b.objectId) {
          errors.push(`error: ${path}: patch does not apply`);
          failed.push(path);
        } else result.delete(path);
        continue;
      }
      if (!b || !t) continue;
      // the mode: the patch's new mode where it changes it, else the index's
      const mode = b.mode !== t.mode ? t.mode : current.mode;
      if (current.objectId === b.objectId || b.objectId === t.objectId) {
        result.set(path, {
          objectId: b.objectId === t.objectId ? current.objectId : t.objectId,
          mode,
        });
        continue;
      }
      const merged = mergeLines(
        await readBlob(this.blobs, b.objectId),
        await readBlob(this.blobs, current.objectId),
        await readBlob(this.blobs, t.objectId),
        { oursLabel: "", theirsLabel: "" },
      );
      if (merged.conflicts > 0) {
        errors.push(`error: ${path}: patch does not apply`);
        failed.push(path);
        continue;
      }
      result.set(path, { objectId: await this.blobs.store([merged.content]), mode });
    }
    // an added path cannot sit beneath a file of the index, nor over a directory of it
    for (const path of paths) {
      if (from.has(path) || !to.has(path) || !result.has(path)) continue;
      const parts = path.split("/");
      const underFile = parts.slice(1).some((_, k) => result.has(parts.slice(0, k + 1).join("/")));
      const overDir = [...result.keys()].some((p) => p.startsWith(`${path}/`));
      if (underFile || overDir) {
        errors.push(
          `error: '${path}' appears as both a file and as a directory`,
          `error: unable to add cache entry for ${path}`,
        );
        failed.push(path);
      }
    }
    return { result, errors, failed };
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
      ...(await restoreCaseOptions(worktree, coreBool(this.workingCopy, "ignorecase", false))),
      windows: worktree.capabilities?.windowsPaths === true,
      reservedNames: worktree.capabilities?.reservedNames,
    });

    return plan;
  }

  /**
   * The stashed untracked files written back after the merge, as git's
   * `checkout-index --all` of their own index writes them (the worktree's attributes, then
   * that index's; they stay untracked): in index order, a path something already stands at
   * is skipped (`<path> already exists, no checkout`), a file on a leading component stops
   * the restore there (`cannot create directory at '<dir>': File exists`). What could not
   * be restored is reported (thrown) once the rest is written, as git exits with an error
   * after applying the stash.
   */
  private async writeUntracked(
    plan: TreeRestorePlan | undefined,
    worktree: Worktree,
    stashId: ObjectId,
    symlinks: boolean,
  ): Promise<void> {
    if (!plan || plan.entries.length === 0) return;
    const errors: string[] = [];
    const failed: string[] = [];
    const sorted = [...plan.entries].sort((a, b) => compareBytes(a.path, b.path));
    let stopped = false;
    for (const entry of sorted) {
      const parts = entry.path.split("/");
      for (let k = 1; k < parts.length && !stopped; k++) {
        const prefix = parts.slice(0, k).join("/");
        const found = await worktree.getEntry(prefix);
        if (found && !found.isDirectory) {
          errors.push(`fatal: cannot create directory at '${prefix}': File exists`);
          failed.push(prefix);
          stopped = true;
        }
      }
      if (stopped) break;
      if (await worktree.exists(entry.path)) {
        errors.push(`${entry.path} already exists, no checkout`);
        failed.push(entry.path);
        continue;
      }
      // written one by one: a later path may sit beneath an earlier one's directory
      await writeTreeRestorePlan(
        worktree,
        this.blobs,
        { ...plan, entries: [entry], gitlinks: [] },
        STASH_APPLY,
        {
          symlinks,
          attributes: {
            direction: "checkin",
            index: attributesIndexOf(plan.entries.map((e) => [e.path, e.objectId] as const)),
          },
        },
      );
    }
    if (errors.length > 0) {
      throw new StashApplyFailedError(
        stashId,
        failed,
        [...errors, "error: could not restore untracked files from stash"].join("\n"),
      );
    }
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

/** Byte order of paths, as git sorts an index. */
function compareBytes(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
