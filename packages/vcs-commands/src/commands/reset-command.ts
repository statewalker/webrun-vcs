import {
  type Blobs,
  EMPTY_BLOB_ID,
  FileMode,
  type ObjectId,
  type Ref,
} from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import {
  applyStatUpdate,
  cacheTreeOfTree,
  compareWithWorktree,
  copyCacheTree,
  entryStatOf,
  getWorktreeEntries,
  type IndexEntryOptions,
  type IndexStatUpdate,
  invalidateCacheTreePath,
  type ResolveUndoRecord,
  type Staging,
  type StagingEntry,
  statUpdateOf,
  type WorkingCopy,
  type Worktree,
  withWorktreeEntries,
} from "@statewalker/vcs-working-tree";

import {
  IncompatibleOptionsError,
  InvalidArgumentError,
  ResetRefusedError,
} from "../errors/command-errors.js";
import { RefNotFoundError } from "../errors/ref-errors.js";
import { type CommandTrees, GitCommand } from "../git-command.js";
import { ResetMode } from "../types.js";
import { coreBool, worktreeModeTrust } from "./core-config.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { addLeadingDirs, stageZeroClashes } from "./index-adder.js";
import { configBool } from "./merge-config.js";
import { flatTree, OperationState, rewriteIndex } from "./merge-support.js";
import {
  DO_MATCH_DIRECTORY,
  globalPathspecMagic,
  matchPathspec,
  type PathspecItem,
  parsePathspec,
  parsePathspecFile,
} from "./pathspec.js";
import { PathspecAttributes } from "./pathspec-attributes.js";
import { reflogMessages } from "./reflog-messages.js";
import { moveHeadAsReset, removeBranchState, resetKeep, resetMerge } from "./sequencer-support.js";
import { pushSparseWarnings, SparseUnpack } from "./sparse-checkout-support.js";
import { planTreeRestore, restoreCaseOptions, writeTreeRestorePlan } from "./tree-restore.js";
import { flaggedEntryDiffers, pruneEmptyParents } from "./worktree-overwrite-checks.js";

/** Names this operation in restore failure messages. */
const RESET_HARD = "reset --hard";

/**
 * Reset HEAD to a specified state.
 *
 * Equivalent to `git reset`.
 *
 * Based on JGit's ResetCommand.
 *
 * @example
 * ```typescript
 * // Soft reset - move HEAD only
 * await git.reset()
 *   .setRef("HEAD~1")
 *   .setMode(ResetMode.SOFT)
 *   .call();
 *
 * // Mixed reset (default) - move HEAD and reset staging
 * await git.reset()
 *   .setRef("abc123")
 *   .call();
 *
 * // Hard reset - move HEAD, reset staging, and reset working tree
 * await git.reset()
 *   .setRef("HEAD~1")
 *   .setMode(ResetMode.HARD)
 *   .call();
 *
 * // Reset specific paths
 * await git.reset()
 *   .addPath("src/file.ts")
 *   .call();
 * ```
 */
export class ResetCommand extends GitCommand<Ref> {
  private ref?: string;
  private mode = ResetMode.MIXED;
  private paths: string[] = [];
  private pathspecFromFile: string[] = [];
  private modeSet = false;
  private intentToAdd = false;
  private quiet = false;
  private noRefresh = false;
  private readonly output: string[] = [];

  /**
   * `-q` / `--quiet`: a mixed reset does not list the files left with unstaged changes
   * (refresh_index with `REFRESH_QUIET`: only unmerged paths, as `<path>: needs merge`), and
   * gives no hint about a slow refresh. (`reset.quiet` is read by neither git 2.43 nor 2.5x.)
   */
  setQuiet(quiet: boolean): this {
    this.checkCallable();
    this.quiet = quiet;
    return this;
  }

  /** `--no-refresh`: a mixed reset leaves the index's stat data as the reset wrote it. */
  setNoRefresh(noRefresh: boolean): this {
    this.checkCallable();
    this.noRefresh = noRefresh;
    return this;
  }

  /**
   * What the reset printed on stdout, line by line: after a mixed reset (with paths too),
   * git's "Unstaged changes after reset:" and a `M\t<path>` (`D`, `T`, `A`, `U`) line per
   * file whose content differs from its entry. Read after {@link call}.
   */
  getOutput(): string[] {
    return [...this.output];
  }

  /**
   * Set the ref to reset to.
   *
   * Can be a commit ID, branch name, tag name, or relative ref like HEAD~1.
   * If not set, defaults to HEAD.
   *
   * @param ref Commit-ish to reset to
   */
  setRef(ref: string): this {
    this.checkCallable();
    this.ref = ref;
    return this;
  }

  /**
   * Set the reset mode.
   *
   * - SOFT: Move HEAD only
   * - MIXED (default): Move HEAD and reset staging
   * - HARD: Move HEAD, reset staging, and reset working tree. DESTRUCTIVE -
   *   uncommitted changes to tracked files are discarded and tracked files
   *   absent from the target commit are deleted from the working tree.
   * - MERGE: as git's `reset --merge`: index entries that differ from the target take
   *   its version, worktree files with them; refused (ResetRefusedError) where a file
   *   with unstaged changes or an untracked file would be lost. Unmerged entries are reset.
   * - KEEP: as git's `reset --keep`: files that differ between HEAD and the target are
   *   switched, local changes elsewhere kept; refused where a switched file has local
   *   changes, and in the middle of a merge.
   *
   * Every mode records the old HEAD in ORIG_HEAD and, as git's reset, forgets a merge,
   * cherry-pick or revert in progress (MERGE_HEAD, CHERRY_PICK_HEAD, ...).
   *
   * @param mode Reset mode
   */
  setMode(mode: ResetMode): this {
    this.checkCallable();
    this.mode = mode;
    this.modeSet = true;
    return this;
  }

  /**
   * What the reset printed on stderr while applying the sparse checkout's patterns, line by
   * line: the patterns' warnings, and git's `error: Path '<p>' not uptodate; will not remove
   * from working tree.` for a changed file left outside them (`--merge`, `--keep`), and
   * "Autostash exists; creating a new stash entry." with its lines when a stopped merge's
   * autostash is kept on `refs/stash`. Read after {@link call}.
   */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  private readonly warnings: string[] = [];

  /**
   * Add a path to reset.
   *
   * When paths are specified, only those paths are reset in the staging area.
   * The ref must be HEAD when using paths.
   *
   * @param path Repository-relative path
   */
  addPath(path: string): this {
    this.checkCallable();
    this.paths.push(path);
    return this;
  }

  /**
   * `-N` / `--intent-to-add` (mixed resets only): a path the tree lacks stays in the index as
   * an intent-to-add entry instead of leaving it.
   */
  setIntentToAdd(intentToAdd: boolean): this {
    this.checkCallable();
    this.intentToAdd = intentToAdd;
    return this;
  }

  /**
   * `--pathspec-from-file` (and `--pathspec-file-nul` with `nul`): the pathspec elements of
   * `content`, one per line.
   */
  setPathspecFromFile(content: string | Uint8Array, nul = false): this {
    this.checkCallable();
    try {
      this.pathspecFromFile = parsePathspecFile(content, nul);
    } catch (error) {
      throw new InvalidArgumentError(
        "pathspecFromFile",
        content,
        `fatal: ${(error as Error).message}`,
      );
    }
    return this;
  }

  /**
   * Execute the reset.
   *
   * @returns The ref that HEAD now points to
   * @throws RefNotFoundError if ref cannot be resolved
   */
  async call(): Promise<Ref> {
    this.checkCallable();
    this.setCallable(false);
    // the index as it is now, before the worktree or a ref is touched: one another writer
    // replaced is read again (git reads the index at its start), unless this instance holds
    // unwritten edits (refused)
    await this.readCurrentIndex();

    if (this.paths.length > 0 && this.pathspecFromFile.length > 0) {
      throw new InvalidArgumentError(
        "pathspecFromFile",
        this.pathspecFromFile,
        "fatal: '--pathspec-from-file' and pathspec arguments cannot be used together",
      );
    }
    if (this.intentToAdd && this.mode !== ResetMode.MIXED) {
      throw new IncompatibleOptionsError(
        ["-N", "--mixed"],
        "fatal: the option '-N' requires '--mixed'",
      );
    }
    // If paths are specified, do path reset
    if (this.paths.length > 0 || this.pathspecFromFile.length > 0) {
      return this.resetPaths();
    }

    // Resolve target commit
    const targetRef = this.ref ?? "HEAD";
    const targetId = await this.resolveRef(targetRef);

    // For HARD, capture the currently tracked paths BEFORE staging is reset:
    // a path tracked now but absent from the target tree must be deleted from
    // the working tree, and after resetStaging() that information is gone.
    const trackedBefore =
      this.mode === ResetMode.HARD ? await this.collectTrackedPaths() : undefined;

    const state = new OperationState(this.workingCopy.checkout, this.refsStore);
    const headId = (await this.refsStore.resolve("HEAD"))?.objectId;
    // git refuses a soft or keep reset in the middle of a merge (die_if_unmerged_cache)
    if (this.mode === ResetMode.SOFT || this.mode === ResetMode.KEEP) {
      let unmerged = false;
      for await (const entry of this.staging.entries()) if (entry.stage > 0) unmerged = true;
      if (unmerged || (await state.exists("MERGE_HEAD"))) {
        throw new ResetRefusedError(
          `fatal: Cannot do a ${this.mode} reset in the middle of a merge.`,
        );
      }
    }
    // --merge and --keep: the index and worktree first, refused before anything changes
    if (this.mode === ResetMode.MERGE || this.mode === ResetMode.KEEP) {
      const ctx = {
        workingCopy: this.workingCopy,
        worktree: this.worktreeAccess,
        staging: this.staging,
        blobs: this.blobs,
        trees: this.trees,
        commits: this.commits,
        refs: this.refsStore,
        sparseWarnings: this.warnings,
      };
      const refused =
        this.mode === ResetMode.MERGE
          ? await resetMerge(ctx, targetId, targetRef)
          : await resetKeep(ctx, headId ?? targetId, targetId, targetRef);
      if (refused) throw new ResetRefusedError(refused.message, refused.paths);
    }

    // a hard reset in a sparse checkout: unpack-trees with its patterns (what stays outside
    // is neither checked nor touched)
    const sparse =
      this.mode === ResetMode.HARD
        ? await SparseUnpack.start({
            workingCopy: this.workingCopy,
            worktree: this.worktreeAccess,
            staging: this.staging,
          })
        : undefined;

    // --hard: unpack-trees' one-way merge checks the entries whose flags cheat (assume-unchanged,
    // skip-worktree) before anything changes; a file kept outside the worktree stays so
    let flagged: FlaggedEntries | undefined;
    if (this.mode === ResetMode.HARD) {
      const commit = await this.commits.load(targetId);
      if (commit) {
        flagged = await checkFlaggedEntries(
          {
            trees: this.trees,
            staging: this.staging,
            workingCopy: this.workingCopy,
            worktree: this.worktreeAccess,
          },
          commit.tree,
          sparse,
        );
        if (flagged.refused !== undefined) {
          throw new ResetRefusedError(
            `error: Entry '${flagged.refused}' not uptodate. Cannot merge.\n` +
              `fatal: Could not reset index file to revision '${targetRef}'.`,
            [flagged.refused],
          );
        }
      }
    }

    // git's set_reflog_message: "reset: moving to <rev>", or "<action>: updating HEAD"
    const message = this.hasReflogAction()
      ? `${this.reflogAction("reset")}: updating HEAD`
      : reflogMessages.reset(targetRef);
    // Move HEAD/branch, the old HEAD kept in ORIG_HEAD (git's update_refs)
    await moveHeadAsReset(this.refsStore, state, headId, targetId, this.reflogLine(message));

    // Reset staging area (for MIXED and HARD)
    if (this.mode === ResetMode.MIXED || this.mode === ResetMode.HARD) {
      await this.resetStaging(targetId);
    }
    // a mixed reset refreshes the index and lists what is left unstaged
    if (this.mode === ResetMode.MIXED && (await this.refreshAfterReset())) {
      await this.staging.write();
    }

    // Reset working tree (for HARD) - this DESTROYS uncommitted changes
    if (this.mode === ResetMode.HARD) {
      const written = await this.resetWorkingTree(
        targetId,
        trackedBefore ?? new Set(),
        flagged?.keptOut,
        sparse,
      );
      // check_updates: the entries written carry the stat of their new files
      if (this.worktreeAccess && written.size > 0) {
        await recordWrittenStat(this.staging, this.worktreeAccess, written);
        await this.staging.write();
      }
      if (sparse) {
        // UNPACK_RESET_OVERWRITE_UNTRACKED: an entry coming back is written over anything
        const outcome = await sparse.finish(
          {
            workingCopy: this.workingCopy,
            worktree: this.worktreeAccess,
            staging: this.staging,
            blobs: this.blobs,
          },
          { written, overwrite: true },
        );
        pushSparseWarnings(this.warnings, sparse, outcome, false);
      }
    }

    // git's remove_branch_state: a merge, cherry-pick or revert in progress is forgotten
    // (a merge's autostash kept on refs/stash, git's lines printed)
    this.warnings.push(
      ...(await removeBranchState({ commits: this.commits, refs: this.refsStore }, state)),
    );

    // Return the updated HEAD ref
    const headRef = await this.refsStore.resolve("HEAD");
    return headRef as Ref;
  }

  /**
   * `git reset [<tree-ish>] [--] <pathspec>...` (builtin/reset.c): the index entries the
   * pathspec names are set to the tree's (`read_from_tree`); HEAD and the worktree stay.
   */
  private async resetPaths(): Promise<Ref> {
    // cmd_reset: only a mixed reset takes paths (an explicit --mixed is deprecated)
    if (this.modeSet && this.mode !== ResetMode.MIXED) {
      throw new ResetRefusedError(`fatal: Cannot do ${this.mode} reset with paths.`);
    }
    if (this.modeSet) {
      this.warnings.push(
        "warning: --mixed with paths is deprecated; use 'git reset -- <paths>' instead.",
      );
    }
    let items: PathspecItem[];
    try {
      const global = globalPathspecMagic(hostEnvironmentOf(this.workingCopy)?.pathspecs);
      items = parsePathspec([...this.pathspecFromFile, ...this.paths], { attr: true, global });
    } catch (error) {
      throw new InvalidArgumentError("path", this.paths, `fatal: ${(error as Error).message}`);
    }
    const treeId = await this.resetTree(true);
    await this.readFromTree(treeId, items);
    await this.refreshAfterReset();
    await this.staging.write();
    const headRef = await this.refsStore.resolve("HEAD");
    return headRef as Ref;
  }

  /**
   * cmd_reset's refresh after a mixed reset (`refresh_index` with `REFRESH_IN_PORCELAIN`, or
   * `REFRESH_QUIET` with `--quiet`): every stage-0 entry compared with its file, those still
   * holding their content given the file's stat; the others listed under "Unstaged changes
   * after reset:" (unmerged paths whatever the flag). Skip-worktree and assume-unchanged
   * entries are taken as up to date. With git's hint when it took over two seconds
   * (`advice.resetNoRefresh`). Whether any entry's stat changed (the index is to be written).
   */
  private async refreshAfterReset(): Promise<boolean> {
    const worktree = this.worktreeAccess;
    if (this.noRefresh || !worktree) return false;
    const started = Date.now();
    let first = true;
    const show = (line: string) => {
      if (!this.quiet && first) this.output.push("Unstaged changes after reset:");
      first = false;
      this.output.push(line);
    };
    const trust = worktreeModeTrust(this.workingCopy, worktree);
    const indexTime = this.staging.getUpdateTime();
    const entries: StagingEntry[] = [];
    for await (const entry of this.staging.entryList?.() ?? this.staging.entries()) {
      entries.push(entry);
    }
    const stated = (entry: StagingEntry) =>
      entry.stage === 0 && !entry.skipWorktree && !entry.assumeValid;
    const updates: IndexStatUpdate[] = [];
    let lastUnmerged: string | undefined;
    for await (const { item: entry, current } of withWorktreeEntries(worktree, entries, stated)) {
      if (entry.stage !== 0) {
        if (entry.path === lastUnmerged) continue;
        lastUnmerged = entry.path;
        show(this.quiet ? `${entry.path}: needs merge` : `U\t${entry.path}`);
        continue;
      }
      if (entry.skipWorktree || entry.assumeValid) continue;
      const compared = await compareWithWorktree(worktree, entry, { trust, indexTime }, current);
      if (!compared.kind && !entry.intentToAdd) {
        const update = statUpdateOf(entry, compared);
        if (update && !update.smudge) updates.push(update);
        continue;
      }
      if (this.quiet) continue;
      const code =
        compared.kind === "deleted"
          ? "D"
          : entry.intentToAdd
            ? "A"
            : compared.kind === "typechange"
              ? "T"
              : "M";
      show(`${code}\t${entry.path}`);
    }
    if (updates.length > 0) {
      const now = Date.now();
      const editor = this.staging.createEditor();
      for (const update of updates) {
        editor.add({
          path: update.path,
          apply: (existing) => applyStatUpdate(existing, update, now) ?? existing,
        });
      }
      await editor.finish();
    }
    const elapsed = Date.now() - started;
    if (
      !this.quiet &&
      elapsed > 2000 &&
      configBool(this.workingCopy, "advice.resetNoRefresh", true)
    ) {
      this.warnings.push(
        `hint: It took ${(elapsed / 1000).toFixed(2)} seconds to refresh the index after reset.  You can use\n` +
          "hint: '--no-refresh' to avoid this.",
      );
    }
    return updates.length > 0;
  }

  /**
   * The tree a path reset (or a `-N` reset) reads: the empty tree on an unborn HEAD, else the
   * tree-ish's tree (git's "Failed to resolve '<rev>' as a valid tree.").
   */
  private async resetTree(paths: boolean): Promise<ObjectId | undefined> {
    const targetRef = this.ref ?? "HEAD";
    let id: ObjectId;
    try {
      id = await this.resolveRevision(targetRef);
    } catch (error) {
      if (targetRef === "HEAD" && error instanceof RefNotFoundError) return undefined;
      if (error instanceof RefNotFoundError) {
        throw new RefNotFoundError(
          targetRef,
          paths
            ? `fatal: Failed to resolve '${targetRef}' as a valid tree.`
            : `fatal: Failed to resolve '${targetRef}' as a valid revision.`,
        );
      }
      throw error;
    }
    const treeId = await this.revisionResolver().peelToType(id, "tree");
    if (treeId === undefined) {
      throw new RefNotFoundError(targetRef, `fatal: Could not parse object '${targetRef}'.`);
    }
    return treeId;
  }

  /**
   * git's `read_from_tree` (`do_diff_cache` of the tree and the index, then
   * `update_index_from_diff`): each path the pathspec names (every path without one) where
   * the index differs from the tree (mode or blob; an unmerged path always) takes the
   * tree's entry, stage 0, or leaves the index when the tree lacks it (with `-N` it stays as
   * an intent-to-add entry). A new entry keeps a skip-worktree bit, or gets one outside the
   * sparse checkout; the conflict stages it replaces are recorded for resolve-undo.
   */
  private async readFromTree(treeId: ObjectId | undefined, items: PathspecItem[]): Promise<void> {
    const tree = await flatTree(this.trees, treeId);
    const index = new Map<string, StagingEntry[]>();
    for await (const entry of this.staging.entries()) {
      const list = index.get(entry.path);
      if (list) list.push(entry);
      else index.set(entry.path, [entry]);
    }
    const attributes = PathspecAttributes.forWorktree(items, this.worktreeAccess);
    if (attributes) await attributes.load([...index.keys(), ...tree.keys()]);
    const named = (path: string, mode: number) =>
      items.length === 0 ||
      matchPathspec(items, path, mode === FileMode.GITLINK ? DO_MATCH_DIRECTORY : 0) > 0;
    const patterns = await this.sparseCheckoutPatterns();
    const changes = new Map<string, IndexEntryOptions[]>();
    const undo: ResolveUndoRecord[] = [];
    // the index as edited so far, for add_index_entry's file/directory clashes
    const current = (path: string): readonly IndexEntryOptions[] =>
      changes.get(path) ?? index.get(path) ?? [];
    const hasStageZero = (path: string) => current(path).some((e) => (e.stage ?? 0) === 0);
    const dirs = new Set<string>();
    for (const path of index.keys()) addLeadingDirs(dirs, path);
    // update_index_from_diff works through the diff queue in the index's order
    const paths = [...new Set([...index.keys(), ...tree.keys()])].sort(compareGitPaths);
    let intentToAddCreated = false;
    for (const path of paths) {
      const entries = index.get(path) ?? [];
      const t = tree.get(path);
      // diff-lib's oneway_diff matches the index entry, else the tree's
      const first = entries[0];
      if (!named(path, first ? first.mode : (t?.mode ?? 0))) continue;
      const unmerged = entries.some((e) => e.stage > 0);
      const staged = entries.find((e) => e.stage === 0);
      if (!unmerged) {
        // the same mode and blob: no change (an intent-to-add entry included)
        if (staged && t && staged.mode === t.mode && staged.objectId === t.objectId) continue;
        if (!staged && !t) continue;
      }
      if (unmerged) {
        const record: ResolveUndoRecord = {
          path,
          modes: [0, 0, 0],
          objectIds: [undefined, undefined, undefined],
        };
        for (const e of entries) {
          if (e.stage < 1 || e.stage > 3) continue;
          record.modes[e.stage - 1] = e.mode;
          record.objectIds[e.stage - 1] = e.objectId;
        }
        undo.push(record);
      }
      if (!t && !this.intentToAdd) {
        changes.set(path, []);
        continue;
      }
      const skipWorktree = staged
        ? staged.skipWorktree === true
        : patterns !== undefined && !patterns.includes(path);
      // add_index_entry: the new stage-0 entry replaces the stage-0 entries it clashes with
      // as a file or a directory (has_dir_name / has_file_name; conflict stages stay)
      for (const other of stageZeroClashes(path, hasStageZero, paths, dirs)) {
        changes.set(
          other,
          current(other).filter((e) => (e.stage ?? 0) > 0),
        );
      }
      addLeadingDirs(dirs, path);
      if (!t) intentToAddCreated = true;
      changes.set(path, [
        {
          path,
          // make_cache_entry of a path the tree lacks: create_ce_mode(0), a regular file
          mode: t ? t.mode : FileMode.REGULAR_FILE,
          objectId: t ? t.objectId : EMPTY_BLOB_ID,
          stage: 0,
          size: 0,
          mtime: 0,
          ...(skipWorktree ? { skipWorktree: true } : {}),
          ...(t ? {} : { intentToAdd: true }),
        },
      ]);
    }
    // set_object_name_for_intent_to_add_entry: the empty blob an intent-to-add entry names
    // is written, so the index never names a missing object
    if (intentToAddCreated) await this.blobs.store([new Uint8Array(0)], 0);
    if (undo.length > 0) this.staging.recordResolveUndo?.(undo);
    if (changes.size > 0) await rewriteIndex(this.staging, changes);
  }

  /**
   * Collect every path currently tracked in the staging area.
   */
  private async collectTrackedPaths(): Promise<Set<string>> {
    const paths = new Set<string>();
    for await (const entry of this.staging.entries()) {
      paths.add(entry.path);
    }
    return paths;
  }

  /**
   * Make the working tree match the target commit's tree (HARD reset).
   *
   * This is destructive: uncommitted modifications to tracked files are
   * overwritten, and tracked files missing from the target tree are deleted.
   * Untracked files are left alone - removing those is `git clean`.
   *
   * A repository without a worktree (bare) has no working tree to reset, so
   * this is a no-op there. The restore is planned and validated in full before
   * any file is touched, so a tree this command cannot restore faithfully
   * (a symlink, a missing blob) fails with the working tree still intact.
   *
   * @param targetId Commit to reset the working tree to
   * @param trackedBefore Paths tracked before staging was reset
   */
  private async resetWorkingTree(
    targetId: ObjectId,
    trackedBefore: Set<string>,
    keptOut?: ReadonlySet<string>,
    sparse?: SparseUnpack,
  ): Promise<Set<string>> {
    const worktree = this.worktreeAccess;
    if (!worktree) {
      // Bare repository: there is no working tree to reset.
      return new Set();
    }

    const commit = await this.commits.load(targetId);
    if (!commit) {
      throw new RefNotFoundError(targetId, "Target commit not found");
    }
    return restoreWorktreeHard(
      { trees: this.trees, blobs: this.blobs, workingCopy: this.workingCopy, worktree },
      commit.tree,
      trackedBefore,
      keptOut,
      sparse,
    );
  }

  /**
   * Reset staging area to match a tree.
   */
  private async resetStaging(commitId: ObjectId): Promise<void> {
    const commit = await this.commits.load(commitId);
    if (commit) {
      if (this.mode !== ResetMode.MIXED) {
        // oneway_merge: an unchanged entry keeps its flags, a changed one its skip-worktree
        // bit (the stat data goes: every file is written again)
        await this.staging.readTree(this.trees, commit.tree, { keepMatching: "flags" });
        await this.primeCacheTree(commit.tree);
        await this.staging.write();
        return;
      }
      if (this.intentToAdd) {
        // -N: the paths the commit lacks stay as intent-to-add entries
        await this.readFromTree(commit.tree, []);
        await this.staging.write();
        return;
      }
      // git's reset --mixed edits the index in place (read_from_tree): the resolve-undo
      // records stay, and the conflict stages it removes are recorded as well
      const unmerged = new Map<string, ResolveUndoRecord>();
      // read_from_tree edits the index entry by entry: the cache-tree keeps its nodes, those
      // of the paths it changes invalid (not primed, as a hard reset's is)
      const cached = this.staging.getCacheTree?.();
      const before = new Map<string, string>();
      for await (const entry of this.staging.entries()) {
        before.set(
          entry.path,
          `${before.has(entry.path) ? "u" : ""}${entry.mode} ${entry.objectId}`,
        );
        if (entry.stage < 1 || entry.stage > 3) continue;
        let record = unmerged.get(entry.path);
        if (!record) {
          record = {
            path: entry.path,
            modes: [0, 0, 0],
            objectIds: [undefined, undefined, undefined],
          };
          unmerged.set(entry.path, record);
        }
        record.modes[entry.stage - 1] = entry.mode;
        record.objectIds[entry.stage - 1] = entry.objectId;
      }
      // read_from_tree leaves the entries it does not change alone (their flags and stat), and
      // a changed entry keeps its skip-worktree bit (update_index_from_diff)
      await this.staging.readTree(this.trees, commit.tree, {
        keepResolveUndo: true,
        keepMatching: true,
      });
      if (unmerged.size > 0) this.staging.recordResolveUndo?.([...unmerged.values()]);
      if (cached && this.staging.setCacheTree) {
        const tree = copyCacheTree(cached);
        for await (const entry of this.staging.entries()) {
          if (before.get(entry.path) !== `${entry.mode} ${entry.objectId}`) {
            invalidateCacheTreePath(tree, entry.path);
          }
          before.delete(entry.path);
        }
        for (const path of before.keys()) invalidateCacheTreePath(tree, path);
        this.staging.setCacheTree(tree);
      }
      await this.staging.write();
    }
  }

  /**
   * git's `prime_cache_tree` after a hard reset: the index's cache-tree is the
   * target tree's, every directory valid with the tree stored there (a tree holding 100664
   * modes is kept, so a write-tree of the unchanged index gives it back).
   */
  private async primeCacheTree(treeId: ObjectId): Promise<void> {
    if (!this.staging.setCacheTree) return;
    this.staging.setCacheTree(await cacheTreeOfTree(this.trees, treeId));
  }
}

/**
 * The working tree half of `git reset --hard` (unpack-trees `oneway_merge` with `update`):
 * `treeId` written over the worktree, the paths of `trackedBefore` it lacks deleted first.
 * Untracked files in the way are overwritten, as git's reset does. The restore is planned
 * in full before any file is touched. In a sparse checkout (`sparse`) only the paths in its
 * patterns are written, nothing that stays outside is removed, and the files leaving the
 * checkout are unlinked first. Returns the paths written.
 */
export async function restoreWorktreeHard(
  deps: { trees: CommandTrees; blobs: Blobs; workingCopy: WorkingCopy; worktree: Worktree },
  treeId: ObjectId,
  trackedBefore: Set<string>,
  keptOut?: ReadonlySet<string>,
  sparse?: SparseUnpack,
): Promise<Set<string>> {
  const { trees, blobs, workingCopy, worktree } = deps;
  // Plan the whole restore first. Anything unrestorable then fails while the
  // working tree is still untouched, instead of half-way through rewriting it.
  const fullPlan = await planTreeRestore(trees, blobs, treeId, RESET_HARD, {
    symlinks: true,
    ...(await restoreCaseOptions(worktree, coreBool(workingCopy, "ignorecase", false))),
    windows: worktree.capabilities?.windowsPaths === true,
    reservedNames: worktree.capabilities?.reservedNames,
  });
  // a skip-worktree entry the tree keeps is not checked out (oneway_merge skips it); in a
  // sparse checkout, nothing outside its patterns is (apply_sparse_checkout), and an entry
  // coming back into them is written
  const skip = sparse
    ? (path: string) => !sparse.writes(path)
    : keptOut && keptOut.size > 0
      ? (path: string) => keptOut.has(path)
      : undefined;
  const plan = skip
    ? {
        ...fullPlan,
        entries: fullPlan.entries.filter((e) => !skip(e.path)),
        gitlinks: fullPlan.gitlinks.filter((e) => !skip(e.path)),
      }
    : fullPlan;

  if (sparse) {
    // apply_sparse_checkout before check_updates: the files leaving the checkout
    const result = new Map<string, { objectId: ObjectId; mode: number }>();
    for (const e of fullPlan.entries) result.set(e.path, e);
    for (const e of fullPlan.gitlinks) result.set(e.path, e);
    const unlink = await sparse.leaving(worktree, (p) => result.get(p), {
      reset: true,
      trust: worktreeModeTrust(workingCopy, worktree),
    });
    await sparse.unlink(worktree, unlink);
  }

  // Delete the files that were tracked but are not in the target tree first, as git's
  // unpack-trees does: a tracked file or symlink `d` then makes way for `d/x`, and is
  // never written beneath or through; the directories left empty go too (unlink_entry's
  // schedule_dir_for_removal). A skip-worktree entry staying outside a sparse checkout
  // keeps its file.
  for (const path of trackedBefore) {
    if (plan.paths.has(path) || sparse?.leavesAlone(path)) continue;
    await worktree.remove(path);
    await pruneEmptyParents(worktree, path);
  }

  // a forced checkout: a file or link where a directory must go is unlinked, never
  // written through; links are written as links where the worktree has them
  await writeTreeRestorePlan(worktree, blobs, plan, RESET_HARD, {
    symlinks: worktreeModeTrust(workingCopy, worktree).symlinks,
    replaceInTheWay: true,
    // git's reset --hard overwrites untracked files (UNPACK_RESET_OVERWRITE_UNTRACKED)
    discardUntracked: true,
  });
  return new Set([...plan.entries, ...plan.gitlinks].map((e) => e.path));
}

/**
 * Records in the index the stat of the files a one-way reset just wrote (`paths`): git's
 * `checkout_entry` fills each written entry's stat data in `check_updates`, so a following
 * `diff-files` or sparse update finds them clean. Only stage-0 entries are touched, and the
 * staging's own racy-git smudging still applies when the index is written. Not written here.
 */
export async function recordWrittenStat(
  staging: Staging,
  worktree: Worktree,
  paths: Iterable<string>,
): Promise<void> {
  const list = [...paths];
  if (list.length === 0) return;
  const found = await getWorktreeEntries(worktree, list);
  const editor = staging.createEditor();
  let edits = 0;
  for (let i = 0; i < list.length; i++) {
    const stat = found[i];
    if (!stat || stat.isDirectory) continue;
    edits++;
    editor.add({
      path: list[i] as string,
      apply: (existing) =>
        existing && existing.stage === 0 ? { ...existing, ...entryStatOf(stat) } : existing,
    });
  }
  if (edits > 0) await editor.finish();
}

/** What {@link checkFlaggedEntries} found. */
export interface FlaggedEntries {
  /** The first path whose flagged entry the tree changes or deletes over a changed file. */
  refused?: string;
  /** The skip-worktree entries the tree keeps: their files are left alone. */
  keptOut: Set<string>;
}

/**
 * The index entries whose flags cheat (assume-unchanged, skip-worktree) before a one-way
 * reset onto `treeId` (`reset --hard`, `checkout -f`): unpack-trees checks them even when it
 * resets (`verify_uptodate_1`: "CE_VALID and CE_SKIP_WORKTREE cheat"), so one the tree
 * changes or deletes is refused while its file differs from it (by stat, as
 * `ie_match_stat`; a missing file is fine). A skip-worktree entry the tree keeps is not
 * checked out (`oneway_merge`).
 */
export async function checkFlaggedEntries(
  deps: {
    trees: CommandTrees;
    staging: Staging;
    workingCopy: WorkingCopy;
    worktree?: Worktree;
  },
  treeId: ObjectId,
  /** A sparse checkout's run: an entry that stays outside it is not checked (verify_uptodate) */
  sparse?: SparseUnpack,
): Promise<FlaggedEntries> {
  const flagged: StagingEntry[] = [];
  for await (const entry of deps.staging.entries()) {
    if (entry.stage === 0 && (entry.assumeValid || entry.skipWorktree)) flagged.push(entry);
  }
  const keptOut = new Set<string>();
  if (flagged.length === 0) return { keptOut };
  const target = await flatTree(deps.trees, treeId);
  const worktree = deps.worktree;
  const trust = worktree ? worktreeModeTrust(deps.workingCopy, worktree) : undefined;
  const indexTime = deps.staging.getUpdateTime();
  for (const entry of flagged) {
    if (sparse?.leavesAlone(entry.path)) continue;
    const t = target.get(entry.path);
    if (t && t.mode === entry.mode && t.objectId === entry.objectId) {
      if (entry.skipWorktree) keptOut.add(entry.path);
      continue;
    }
    if (worktree && (await flaggedEntryDiffers(worktree, entry.path, entry, trust, indexTime))) {
      return { refused: entry.path, keptOut };
    }
  }
  return { keptOut };
}
