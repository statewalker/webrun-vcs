import {
  type Commit,
  FileMode,
  type ObjectId,
  type PersonIdent,
  type TreeEntry,
} from "@statewalker/vcs-core";
import { compareGitPaths } from "@statewalker/vcs-utils/encoding";
import type { Staging, StagingEntry, Worktree, WorktreeEntry } from "@statewalker/vcs-working-tree";

import {
  EmptyCommitError,
  GitApiError,
  IncompatibleOptionsError,
  InvalidArgumentError,
  NoHeadError,
  NoMessageError,
  RefNotFoundError,
  StoreNotAvailableError,
  UnmergedPathsError,
} from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { AddCommand } from "./add-command.js";
import { worktreeModeTrust } from "./core-config.js";
import { withoutCrud } from "./git-ident.js";
import { IndexAdder } from "./index-adder.js";
import { OperationState, updateIndexCacheTree, writeIndexAsTree } from "./merge-support.js";
import {
  CleanupMode,
  cleanupWith,
  commitCleanupMode,
  commitMessageFromOption,
  preparedMessageCleanup,
} from "./message-cleanup.js";
import { copyNotesForAmend } from "./notes-support.js";
import {
  DO_MATCH_DIRECTORY,
  DO_MATCH_LEADING_PATHSPEC,
  matchPathspec,
  matchPathspecSeen,
  type PathspecItem,
  parsePathspec,
  pathspecErrors,
} from "./pathspec.js";
import { type CommitReflogKind, reflogMessages, updateHead } from "./reflog-messages.js";
import { applyAutostash } from "./sequencer-support.js";

/**
 * Result of a commit operation.
 *
 * Extends Commit with the ID of the created commit.
 * JGit's CommitCommand returns RevCommit which includes getId().
 */
export interface CommitResult extends Commit {
  /** The ObjectId of the created commit */
  id: ObjectId;
}

/**
 * Create a commit from staged changes.
 *
 * Equivalent to `git commit`.
 *
 * Based on JGit's CommitCommand.
 *
 * @example
 * ```typescript
 * // Simple commit
 * const commit = await git.commit()
 *   .setMessage("Fix bug in parser")
 *   .call();
 *
 * // Commit with author
 * const commit = await git.commit()
 *   .setMessage("Add feature")
 *   .setAuthor("John Doe", "john@example.com")
 *   .call();
 *
 * // Amend previous commit
 * const commit = await git.commit()
 *   .setMessage("Updated message")
 *   .setAmend(true)
 *   .call();
 *
 * // Allow empty commit
 * const commit = await git.commit()
 *   .setMessage("Empty commit")
 *   .setAllowEmpty(true)
 *   .call();
 *
 * // Commit only specific paths
 * const commit = await git.commit()
 *   .setMessage("Partial commit")
 *   .setOnly("src/file.ts", "tests/file.test.ts")
 *   .call();
 *
 * // Auto-stage and commit tracked changes (requires worktree)
 * const commit = await git.commit()
 *   .setMessage("All changes")
 *   .setAll(true)
 *   .setWorktree(worktree)
 *   .call();
 * ```
 */
export class CommitCommand extends GitCommand<CommitResult> {
  private message?: string;
  private author?: PersonIdent;
  private committer?: PersonIdent;
  /** `--author=<name> <email>`: dated when the commit is made */
  private authorName?: { name: string; email: string };
  /** A committer named without a date, dated when the commit is made */
  private committerName?: { name: string; email: string };
  private resetAuthor = false;
  private amend = false;
  private noPostRewrite = false;
  private allowEmpty = false;
  private parents: ObjectId[] = [];
  private onlyPaths: string[] = [];
  private all = false;
  private worktreeIterator: Worktree | undefined;
  private cleanupMode?: CleanupMode;
  private allowEmptyMessage = false;

  /**
   * Set the commit message, as git's `commit -m` takes it: its last line is ended and it is
   * cleaned up (`whitespace` by default, see {@link setCleanupMode}), so `"Fix"` is stored
   * as `"Fix\n"` and the commit gets native git's id.
   *
   * @param message Commit message
   */
  setMessage(message: string): this {
    this.checkCallable();
    this.message = message;
    return this;
  }

  /**
   * Add a paragraph to the message, as each further `-m` of `git commit` does: the
   * message so far gets its last line ended and a blank line, then this one (`-m a -m b`
   * is `"a\n\nb\n"`). The first call is {@link setMessage}.
   *
   * @example
   * ```typescript
   * await git.commit().addMessage("Subject").addMessage("Body paragraph.").call();
   * ```
   *
   * @param message One paragraph of the commit message
   */
  addMessage(message: string): this {
    this.checkCallable();
    // git's opt_parse_m: a newline before the next -m only when the buffer holds something
    this.message = !this.message
      ? message
      : `${this.message}${this.message.endsWith("\n") ? "" : "\n"}\n${message}`;
    return this;
  }

  /**
   * How the message is cleaned up (git's `--cleanup=<mode>`; default `commit.cleanup`, else
   * `default`, which without an editor is `whitespace`: trailing whitespace and surrounding
   * blank lines dropped, blank runs collapsed). `strip` also drops comment lines;
   * `verbatim` keeps the message as given (with its last line ended, as `-m` does).
   */
  setCleanupMode(mode: CleanupMode): this {
    this.checkCallable();
    this.cleanupMode = mode;
    return this;
  }

  /**
   * Allow a message that is empty after its cleanup (git's `--allow-empty-message`);
   * without it such a commit is refused: `Aborting commit due to empty commit message.`
   */
  setAllowEmptyMessage(allow: boolean): this {
    this.checkCallable();
    this.allowEmptyMessage = allow;
    return this;
  }

  /**
   * Set the author identity.
   *
   * @param name Author name
   * @param email Author email
   */
  setAuthor(name: string, email: string): this {
    this.checkCallable();
    // git's --author: the name and email; the date is the amended commit's, the picked
    // commit's, else GIT_AUTHOR_DATE or now
    this.author = undefined;
    this.authorName = { name, email };
    return this;
  }

  /**
   * Set the author identity from a PersonIdent.
   *
   * @param author Author identity
   */
  setAuthorIdent(author: PersonIdent): this {
    this.checkCallable();
    this.authorName = undefined;
    this.author = author;
    return this;
  }

  /**
   * Set the committer identity.
   *
   * @param name Committer name
   * @param email Committer email
   */
  setCommitter(name: string, email: string): this {
    this.checkCallable();
    // dated as git dates the committer: GIT_COMMITTER_DATE, else now
    this.committer = undefined;
    this.committerName = { name, email };
    return this;
  }

  /**
   * Set the committer identity from a PersonIdent.
   *
   * @param committer Committer identity
   */
  setCommitterIdent(committer: PersonIdent): this {
    this.checkCallable();
    this.committerName = undefined;
    this.committer = committer;
    return this;
  }

  /**
   * `--reset-author`: an amended commit, or the commit that concludes a cherry-pick, is
   * authored as a new one (the author resolved as git resolves it, dated now) instead of
   * keeping the earlier commit's author.
   *
   * @param reset Whether to reset the author
   */
  setResetAuthor(reset: boolean): this {
    this.checkCallable();
    this.resetAuthor = reset;
    return this;
  }

  /**
   * `--no-post-rewrite`: an amend does not carry the amended commit's notes over to the new
   * one (`notes.rewriteRef`, `notes.rewrite.amend`), as git skips its post-rewrite step.
   */
  setNoPostRewrite(noPostRewrite: boolean): this {
    this.checkCallable();
    this.noPostRewrite = noPostRewrite;
    return this;
  }

  /**
   * Set whether to amend the previous commit.
   *
   * @param amend Whether to amend
   */
  setAmend(amend: boolean): this {
    this.checkCallable();
    this.amend = amend;
    return this;
  }

  /**
   * Set whether to allow an empty commit.
   *
   * @param allowEmpty Whether to allow empty commits
   */
  setAllowEmpty(allowEmpty: boolean): this {
    this.checkCallable();
    this.allowEmpty = allowEmpty;
    return this;
  }

  /**
   * Set explicit parent commits.
   *
   * Normally parents are determined automatically, but this
   * can be used for merge commits or special cases.
   *
   * @param parents Parent commit IDs
   */
  setParentIds(...parents: ObjectId[]): this {
    this.checkCallable();
    this.parents = parents;
    return this;
  }

  /**
   * Set paths to commit (`git commit --only <paths>`, git's partial commit).
   *
   * The paths are a pathspec, as git reads it (`d/`, `*.md`, `:(glob)d/**`, `:!d/x`,
   * `./a`). As git's `prepare_index`: the index entries (any stage) and HEAD's files the
   * pathspec matches are listed (`list_paths`); an element that matches none of them fails
   * with git's "error: pathspec '<path>' did not match any file(s) known to git". The index
   * lock is then held until HEAD has moved. Each listed path is taken from the worktree
   * literally (`add_remove_files`): a file (ignored or not) is staged as `git add` stages it
   * (cleaned by the content filters; an intent-to-add entry gets the content, a conflicted
   * path is resolved to the file, the entries it clashes with as a file or a directory
   * replaced), a path gone is removed, and a path that is now a directory refuses the commit
   * before anything changes ("'<path>' does not have a commit checked out"). The index is
   * written into the lock with the paths updated, and the commit records HEAD's tree with
   * only these paths changed, whatever else is staged. The lock is renamed over the index
   * once the commit is made; on any failure it is removed and the index (and this instance's
   * staging, unwritten edits included) stays as it was. A skip-worktree path keeps its HEAD
   * version. A partial commit during a merge, a cherry-pick or a rebase is refused; other
   * unmerged paths do not stop it (they stay unmerged in the index).
   *
   * Cannot be combined with setAll().
   *
   * @param paths Paths to include in commit
   * @throws Error if combined with --all mode
   */
  setOnly(...paths: string[]): this {
    this.checkCallable();
    // JGit: --all and --only are mutually exclusive
    if (this.all && paths.length > 0) {
      throw new IncompatibleOptionsError(["--only", "--all"]);
    }
    this.onlyPaths = paths;
    return this;
  }

  /**
   * Set whether to auto-stage modified tracked files before committing.
   *
   * If true, stages all modified and deleted tracked files before
   * creating the commit. Requires a working tree iterator. As git's: the index lock is held
   * from before the files are staged until HEAD has moved, and the index is left as it was
   * when the commit fails.
   *
   * Cannot be combined with setOnly().
   *
   * Equivalent to `git commit -a` or `git commit --all`.
   *
   * @param all Whether to auto-stage tracked changes
   * @returns this for chaining
   * @throws Error if combined with --only paths
   */
  setAll(all: boolean): this {
    this.checkCallable();
    // JGit: --all and --only are mutually exclusive
    if (all && this.onlyPaths.length > 0) {
      throw new IncompatibleOptionsError(["--all", "--only"]);
    }
    this.all = all;
    return this;
  }

  /**
   * Whether --all mode is enabled.
   */
  isAll(): boolean {
    return this.all;
  }

  /**
   * Set a custom working tree iterator.
   *
   * Required when using setAll(true) if the store doesn't have
   * a built-in working tree.
   *
   * @param iterator Custom working tree iterator
   * @returns this for chaining
   */
  setWorktree(iterator: Worktree): this {
    this.checkCallable();
    this.worktreeIterator = iterator;
    return this;
  }

  /**
   * Execute the commit.
   *
   * @returns The created commit with its ID
   * @throws NoMessageError if message is not set and not amending
   * @throws UnmergedPathsError if there are unresolved conflicts
   * @throws EmptyCommitError if nothing to commit and allowEmpty is false
   */
  async call(): Promise<CommitResult> {
    this.checkCallable();
    // the index as it is now: one another writer replaced is read again (git reads the
    // index at its start), unless this instance holds unwritten edits (refused)
    await this.readCurrentIndex();
    const partial = this.onlyPaths.length > 0;
    if (!this.all) return this.commitWith(partial, undefined);
    // `-a` (git's COMMIT_NORMAL): the index lock held from before the tracked changes are
    // staged until HEAD has moved
    const index = await this.holdIndex();
    try {
      // Handle --all flag: auto-stage modified tracked files
      await this.stageTrackedChanges();
      return await this.commitWith(partial, index);
    } catch (error) {
      await index.release();
      throw error;
    }
  }

  /**
   * The commit, once `-a` staged the tracked changes (`index`: the index lock it holds).
   * A partial commit takes the lock itself.
   */
  private async commitWith(partial: boolean, held: HeldIndex | undefined): Promise<CommitResult> {
    let index = held;

    // Check for conflicts (a partial commit records HEAD and the named paths: other
    // unmerged paths stay in the index, as git's)
    if (!partial && (await this.staging.hasConflicts())) {
      const conflictPaths = await this.staging.getConflictedPaths();
      throw new UnmergedPathsError(
        conflictPaths,
        [
          "error: Committing is not possible because you have unmerged files.",
          "hint: Fix them up in the work tree, and then use 'git add/rm <file>'",
          "hint: as appropriate to mark resolution and make a commit.",
          "fatal: Exiting because of an unresolved conflict.",
        ].join("\n"),
      );
    }

    // a merge, cherry-pick or revert in progress (git's whence: MERGE_HEAD,
    // CHERRY_PICK_HEAD, REVERT_HEAD), and the message it prepared
    const state = new OperationState(this.workingCopy.checkout, this.refsStore);
    const mergeHeads = await this.mergeHeads(state);
    const pickHead = await state.ref("CHERRY_PICK_HEAD");
    if (this.amend && mergeHeads.length > 0) {
      throw new InvalidArgumentError(
        "amend",
        true,
        "fatal: You are in the middle of a merge -- cannot amend.",
      );
    }
    // a partial commit: the paths named, from the index and HEAD (git's list_paths)
    const headId = (await this.refsStore.resolve("HEAD"))?.objectId;
    let partialTree: ObjectId | undefined;
    const partialPaths = partial
      ? await this.listPartialPaths(state, mergeHeads, headId)
      : undefined;
    if (partialPaths) {
      // git's partial commit (prepare_index): the index lock taken once the paths are
      // listed, the named paths taken from the worktree into the index and written into
      // the lock (renamed over the index once HEAD has moved), the commit's tree HEAD's with
      // the same paths taken; any failure leaves the index as it was
      index = await this.holdIndex();
      try {
        partialTree = await this.preparePartialCommit(partialPaths, headId, index);
      } catch (error) {
        await index.release();
        throw error;
      }
    }
    try {
      return await this.commitPrepared(partialTree, state, mergeHeads, pickHead, index);
    } catch (error) {
      await index?.release();
      throw error;
    }
  }

  /** The commit made from the index (or the partial commit's tree), after the index is ready. */
  private async commitPrepared(
    partialTree: ObjectId | undefined,
    state: OperationState,
    mergeHeads: ObjectId[],
    pickHead: ObjectId | undefined,
    index: HeldIndex | undefined,
  ): Promise<CommitResult> {
    let message = this.message;
    const given = message !== undefined;
    if (message === undefined && !this.amend) {
      const prepared = (await state.read("MERGE_MSG")) ?? (await state.read("SQUASH_MSG"));
      // as git commit leaves it once the editor accepts it: comments stripped, or as
      // setCleanupMode / commit.cleanup say, with core.commentChar's character
      const cleaned =
        prepared !== undefined
          ? preparedMessageCleanup(this.workingCopy, prepared, this.cleanupMode)
          : "";
      if (cleaned) message = cleaned;
    }

    // Check message
    if (message === undefined && !this.amend) {
      throw new NoMessageError();
    }

    // Get message (from amend or new): a message given is git's `-m` (its line ended, then
    // cleaned up); one prepared by a merge or pick was cleaned up above
    const cleanup = commitCleanupMode(this.workingCopy, this.cleanupMode);
    let finalMessage =
      given && message !== undefined
        ? commitMessageFromOption(message, this.cleanupMode, this.workingCopy, true)
        : message;
    let previousCommit: Commit | undefined;
    let amendedId: ObjectId | undefined;

    if (this.amend) {
      const headId = await this.resolveHead();
      amendedId = headId;
      previousCommit = await this.commits.load(headId);
      if (!previousCommit) {
        throw new NoHeadError("Cannot amend: HEAD commit not found");
      }
      if (finalMessage === undefined) {
        // `--amend --no-edit`: the amended commit's message, cleaned up as any other
        finalMessage = cleanupWith(this.workingCopy, previousCommit.message, cleanup, true);
      }
    }

    // git's message_is_empty: nothing but whitespace and sign-offs (any text, verbatim)
    if (
      finalMessage === undefined ||
      (!this.allowEmptyMessage &&
        (cleanup !== CleanupMode.VERBATIM || finalMessage.length === 0) &&
        isEmptyMessage(finalMessage))
    ) {
      throw new NoMessageError("Aborting commit due to empty commit message.");
    }

    // The author (git's determine_author_info): the one given; else an amended commit's or
    // a concluded cherry-pick's author (its date too; `--author` replaces only the name and
    // email), unless --reset-author; else resolved as git does (GIT_AUTHOR_*, author.*,
    // user.*, GIT_AUTHOR_DATE or now)
    let author = this.author;
    if (!author) {
      const kept = this.resetAuthor
        ? undefined
        : this.amend && previousCommit
          ? previousCommit.author
          : pickHead
            ? (await this.commits.load(pickHead))?.author
            : undefined;
      if (kept) {
        author = this.authorName
          ? {
              ...kept,
              name: withoutCrud(this.authorName.name),
              email: withoutCrud(this.authorName.email),
            }
          : kept;
      } else if (this.authorName) author = this.datedIdent("author", this.authorName);
      else author = this.resolveAuthor(this.committer ?? this.committerName);
    }
    // the committer: always resolved (GIT_COMMITTER_*, committer.*, user.*), unless given
    const committer =
      this.committer ??
      (this.committerName
        ? this.datedIdent("committer", this.committerName)
        : this.resolveCommitter(author));

    // Determine parents
    let parents: ObjectId[];
    if (this.parents.length > 0) {
      parents = this.parents;
    } else if (this.amend) {
      // Use amended commit's parents
      const headId = await this.resolveHead();
      const headCommit = await this.commits.load(headId);
      if (!headCommit) {
        throw new NoHeadError("Cannot amend: HEAD commit not found");
      }
      parents = headCommit.parents;
    } else {
      // Normal commit - HEAD as parent (if exists)
      try {
        const headId = await this.resolveHead();
        parents = [headId];
      } catch {
        // Initial commit
        parents = [];
      }
      if (mergeHeads.length > 0) {
        // a merge commit: HEAD and MERGE_HEAD's commits; reduced to the independent ones
        // unless MERGE_MODE says no-ff (git's reduce_heads_replace)
        parents = [...parents, ...mergeHeads.filter((id) => !parents.includes(id))];
        const mode = (await state.read("MERGE_MODE")) ?? "";
        if (!/\bno-ff\b/.test(mode)) parents = await this.reduceHeads(parents);
      }
    }

    // Generate tree from staging area
    let treeId: ObjectId;
    if (partialTree) {
      treeId = partialTree;
    } else if (index) {
      // `-a`: the index with a fully valid cache-tree (cache_tree_update), written into the
      // lock
      treeId = await writeIndexAsTree(this.staging, this.trees, { write: false });
      await index.write();
    } else {
      // Normal mode: use full staging area; as git's prepare_index, the index is written
      // again with a fully valid cache-tree (cache_tree_update, which keeps the valid nodes:
      // a stored subtree no edit touched stays the one stored)
      treeId = await writeIndexAsTree(this.staging, this.trees);
    }
    return this.finishCommit(treeId, parents, mergeHeads, pickHead, {
      author,
      committer,
      finalMessage,
      state,
      amendedId,
      commitIndex: index ? () => index.commit() : undefined,
    });
  }

  /** The commit of `treeId` made, HEAD moved to it, and what was in progress ended. */
  private async finishCommit(
    treeId: ObjectId,
    parents: ObjectId[],
    mergeHeads: ObjectId[],
    pickHead: ObjectId | undefined,
    info: {
      author: PersonIdent;
      committer: PersonIdent;
      finalMessage: string;
      state: OperationState;
      amendedId: ObjectId | undefined;
      /** Renames the index lock over the index, once HEAD has moved (git's commit_index_files) */
      commitIndex?: () => Promise<void>;
    },
  ): Promise<CommitResult> {
    const { author, committer, finalMessage, state, amendedId } = info;
    // Check for empty commit (a merge may record HEAD's tree)
    if (!this.allowEmpty && parents.length > 0 && mergeHeads.length === 0) {
      const parentCommit = await this.commits.load(parents[0]);
      if (parentCommit && parentCommit.tree === treeId) {
        throw new EmptyCommitError();
      }
    }

    // Create commit
    const commit: Commit = {
      tree: treeId,
      parents,
      author,
      committer,
      message: finalMessage,
    };

    const commitId = await this.commits.store(commit);

    // Update HEAD/branch ref, with git's reflog line in the branch's log and HEAD's
    // (builtin/commit.c: initial, amend, merge, cherry-pick, else plain)
    const initial = !(await this.refsStore.resolve("HEAD"))?.objectId;
    const kind: CommitReflogKind = initial
      ? "initial"
      : this.amend
        ? "amend"
        : mergeHeads.length > 0
          ? "merge"
          : pickHead
            ? "cherry-pick"
            : undefined;
    const action = this.hasReflogAction() ? this.reflogAction("commit") : undefined;
    await updateHead(
      this.refsStore,
      commitId,
      this.reflogLine(reflogMessages.commit(kind, finalMessage, action), committer),
    );

    this.setCallable(false);

    // the commit ends what was in progress (git's sequencer_post_commit_cleanup and the
    // state files cmd_commit unlinks), then the new index (commit_index_files), then applies
    // a merge's autostash
    await this.cleanupAfterCommit(state, info.commitIndex);

    // commit_post_rewrite: the amended commit's notes carried over (notes.rewriteRef)
    if (amendedId && !this.noPostRewrite) {
      // git exports the amend's author (determine_author_info): the notes commit's too
      await copyNotesForAmend(this.notesContext(), amendedId, commitId, commit.author);
    }

    // Return commit with its ID (like JGit's RevCommit)
    return { ...commit, id: commitId };
  }

  /** The commits MERGE_HEAD names (one per line), none without a merge in progress. */
  private async mergeHeads(state: OperationState): Promise<ObjectId[]> {
    const text = await state.read("MERGE_HEAD");
    if (text !== undefined) {
      return text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /^[0-9a-f]{40,64}$/.test(l));
    }
    const id = await state.ref("MERGE_HEAD");
    return id ? [id] : [];
  }

  /** The heads none of the others reaches (git's reduce_heads), in their order. */
  private async reduceHeads(heads: ObjectId[]): Promise<ObjectId[]> {
    const out: ObjectId[] = [];
    for (const head of heads) {
      let reached = false;
      for (const other of heads) {
        if (other === head) continue;
        if (await this.commits.isAncestor(head, other)) {
          reached = true;
          break;
        }
      }
      if (!reached) out.push(head);
    }
    return out.length > 0 ? out : heads.slice(0, 1);
  }

  /**
   * After the commit: the merge state removed (MERGE_HEAD, MERGE_MSG, MERGE_MODE,
   * SQUASH_MSG, AUTO_MERGE), a stopped cherry-pick or revert ended (its sequencer state
   * too once it was the last pick), and MERGE_AUTOSTASH applied back, as `git commit`.
   */
  private async cleanupAfterCommit(
    state: OperationState,
    commitIndex: (() => Promise<void>) | undefined,
  ): Promise<void> {
    if (!state.supported) {
      await commitIndex?.();
      return;
    }
    const picking =
      (await state.ref("CHERRY_PICK_HEAD")) !== undefined ||
      (await state.ref("REVERT_HEAD")) !== undefined;
    await state.removeRef("CHERRY_PICK_HEAD", "REVERT_HEAD", "AUTO_MERGE", "MERGE_HEAD");
    await state.remove("MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "SQUASH_MSG");
    if (picking) {
      // have_finished_the_last_pick: the todo holds no more than the pick just committed
      const todo = (await state.read("sequencer/todo")) ?? "";
      const left = todo.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
      if (left.length <= 1) await state.remove("sequencer");
    }
    await commitIndex?.();
    const autostash = (await state.read("MERGE_AUTOSTASH"))?.trim();
    if (autostash) {
      await state.remove("MERGE_AUTOSTASH");
      await applyAutostash(
        {
          workingCopy: this.workingCopy,
          worktree: this.worktreeIterator ?? this.worktreeAccess,
          staging: this.staging,
          blobs: this.blobs,
          trees: this.trees,
          commits: this.commits,
          refs: this.refsStore,
        },
        autostash,
      );
    }
  }

  /**
   * The index held for a commit that changes it (git's `repo_hold_locked_index`): the
   * index lock taken now (a staging with an index file), released on failure with the
   * staging as it was before (read again, or its unwritten edits put back).
   */
  private async holdIndex(): Promise<HeldIndex> {
    const staging = this.staging;
    const unwritten = staging.hasUnwrittenChanges?.() !== false;
    // what the staging held, for a staging that cannot read it back (no index file) or that
    // holds edits not yet written
    const lock = staging.lockIndex ? await staging.lockIndex() : undefined;
    const snapshot =
      !lock || unwritten
        ? {
            entries: (staging.entryList?.() ?? (await collectEntries(staging))).slice(),
            cacheTree: staging.getCacheTree?.(),
          }
        : undefined;
    let done = false;
    return {
      write: async () => {
        await lock?.write();
      },
      commit: async () => {
        if (lock) await lock.commit();
        else await staging.write();
        done = true;
      },
      release: async () => {
        if (done) return;
        done = true;
        await lock?.rollback();
        if (!snapshot) {
          await staging.read();
          return;
        }
        const builder = staging.createBuilder();
        for (const entry of snapshot.entries) builder.add(entry);
        await builder.finish();
        staging.setCacheTree?.(snapshot.cacheTree);
      },
    };
  }

  /**
   * The paths a partial commit takes (git's `list_paths`): those of the index (any stage)
   * and of HEAD's tree the pathspec matches (`ce_path_match`, magic and globs as git's), in
   * git's order, each with whether its index entry is skip-worktree. Refused during a
   * merge, a cherry-pick or a rebase (git's whence), and when an element of the pathspec
   * matches nothing (`report_path_error`).
   */
  private async listPartialPaths(
    state: OperationState,
    mergeHeads: ObjectId[],
    headId: ObjectId | undefined,
  ): Promise<Map<string, boolean>> {
    if (mergeHeads.length > 0) {
      throw new InvalidArgumentError(
        "only",
        this.onlyPaths,
        "fatal: cannot do a partial commit during a merge.",
      );
    }
    const pick = await state.ref("CHERRY_PICK_HEAD");
    if (pick) {
      // sequencer_determine_whence: a rebase stopped at this pick, else a cherry-pick
      const rebasing =
        (await state.read("rebase-merge/head-name")) !== undefined &&
        (await state.ref("REBASE_HEAD")) === pick;
      throw new InvalidArgumentError(
        "only",
        this.onlyPaths,
        `fatal: cannot do a partial commit during a ${rebasing ? "rebase" : "cherry-pick"}.`,
      );
    }

    let items: PathspecItem[];
    try {
      items = parsePathspec(this.onlyPaths);
    } catch (error) {
      throw new InvalidArgumentError("only", this.onlyPaths, `fatal: ${(error as Error).message}`);
    }
    // the elements as given (and the "." git adds when every element excludes)
    const originals =
      items.length > this.onlyPaths.length ? [...this.onlyPaths, "."] : [...this.onlyPaths];
    // git's overlay_tree_on_index: HEAD's files at stage 1, among the index's entries (its
    // conflict stages hoisted to 3), a HEAD file the index has at stage 0 left out; matched
    // in that order (the order decides what an element matched exactly skips, as in git)
    type Listed = { path: string; key: number; mode: number; skipWorktree: boolean };
    const listed: Listed[] = [];
    const stage0 = new Set<string>();
    for await (const entry of this.staging.entries()) {
      if (entry.stage === 0) stage0.add(entry.path);
      listed.push({
        path: entry.path,
        key: entry.stage === 0 ? 0 : 3,
        mode: entry.mode,
        skipWorktree: entry.skipWorktree === true,
      });
    }
    if (headId) {
      const head = await this.commits.load(headId);
      if (!head) throw new RefNotFoundError(headId, "HEAD commit not found");
      // only the directories a positive element can match something in are read
      const positive = items.filter((i) => !i.exclude);
      const mayMatch = (dir: string) =>
        matchPathspec(positive, dir, DO_MATCH_DIRECTORY | DO_MATCH_LEADING_PATHSPEC) > 0;
      const files: Array<{ path: string; mode: number }> = [];
      await this.collectTreeFiles(head.tree, "", mayMatch, files);
      for (const file of files) {
        if (!stage0.has(file.path)) listed.push({ ...file, key: 1, skipWorktree: false });
      }
      listed.sort((a, b) => compareGitPaths(a.path, b.path) || a.key - b.key);
    }
    const seen = items.map(() => 0);
    const paths = new Map<string, boolean>();
    for (const entry of listed) {
      const flags = isGitlink(entry.mode) ? DO_MATCH_DIRECTORY : 0;
      if (!matchPathspecSeen(items, entry.path, flags, seen)) continue;
      paths.set(entry.path, (paths.get(entry.path) ?? false) || entry.skipWorktree);
    }
    const errors = pathspecErrors(originals, seen);
    if (errors.length > 0) {
      throw new InvalidArgumentError(
        "only",
        originals.filter((_, i) => !seen[i]),
        errors.join("\n"),
      );
    }
    // git's string_list: sorted by the paths' bytes
    return new Map([...paths].sort(([a], [b]) => compareGitPaths(a, b)));
  }

  /** The files (and gitlinks) of a tree, in the directories `mayMatch` lets in. */
  private async collectTreeFiles(
    treeId: ObjectId,
    prefix: string,
    mayMatch: (dir: string) => boolean,
    files: Array<{ path: string; mode: number }>,
  ): Promise<void> {
    for await (const entry of this.trees.loadTree(treeId)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === FileMode.TREE) {
        if (mayMatch(path)) await this.collectTreeFiles(entry.id, path, mayMatch, files);
      } else {
        files.push({ path, mode: entry.mode });
      }
    }
  }

  /**
   * git's partial commit (`prepare_index`, `add_remove_files`): each listed path (but the
   * skip-worktree ones) as git's `add_remove_files` takes it, literally: a file (ignored or
   * not) hashed and staged, a path gone removed, a directory refused before anything
   * changes ("'<path>' does not have a commit checked out"); the index then gets its
   * cache-tree (none while it holds conflicts) and is written into the lock. The tree
   * committed is HEAD's with the same paths taken (git's false index).
   */
  private async preparePartialCommit(
    paths: Map<string, boolean>,
    headId: ObjectId | undefined,
    index: HeldIndex,
  ): Promise<ObjectId> {
    const taken = [...paths].filter(([, skipWorktree]) => !skipWorktree).map(([path]) => path);
    // the lstat of each path, before the index is touched
    const found = new Map<string, WorktreeEntry | undefined>();
    let worktree: Worktree | undefined;
    if (taken.length > 0) {
      worktree = this.getWorktreeIterator();
      if (!worktree) {
        throw new StoreNotAvailableError(
          "Worktree",
          "Working tree iterator required for a partial commit. " +
            "Ensure WorkingCopy has worktree or call setWorktreeStore().",
        );
      }
    }
    if (worktree) {
      for (const path of taken) {
        const entry = await worktree.getEntry(path);
        if (entry?.isDirectory) {
          // add_to_index of a directory: a gitlink only for a repository with a commit
          // (index_path's resolve_gitlink_ref), which a worktree cannot hold here; git 2.5x
          // adds the "unable to index file" line
          throw new GitApiError(
            `error: '${path}' does not have a commit checked out\n` +
              `error: unable to index file '${path}'\nfatal: updating files failed`,
          );
        }
        found.set(path, entry);
      }
      const trust = worktreeModeTrust(this.workingCopy, worktree);
      const adder = await IndexAdder.open(this.staging, this.blobs, trust);
      for (const path of taken) {
        const entry = found.get(path);
        if (entry) await adder.add(worktree, path, entry);
        else adder.remove(path);
      }
      await adder.finish();
    }
    // the real index, with a cache-tree made valid as git's cache_tree_update before
    // write_locked_index (none while it holds conflicts: the edits' invalidations stay)
    await updateIndexCacheTree(this.staging, this.trees);
    await index.write();

    // the false index: HEAD's tree with the same paths as the index now has them
    const edits = new Map<string, { mode: number; id: ObjectId } | null>();
    for (const path of taken) {
      const entry = found.get(path) ? await this.staging.getEntry(path) : undefined;
      edits.set(
        path,
        entry && !entry.intentToAdd ? { mode: entry.mode, id: entry.objectId } : null,
      );
    }
    const head = headId ? await this.commits.load(headId) : undefined;
    if (headId && !head) throw new RefNotFoundError(headId, "HEAD commit not found");
    return (await this.editTree(head?.tree, [...edits])) ?? this.trees.store([]);
  }

  /**
   * A tree with the given files set (or removed, for null), only the directories on their
   * paths stored again; undefined when nothing is left in it.
   */
  private async editTree(
    treeId: ObjectId | undefined,
    edits: Array<[string, { mode: number; id: ObjectId } | null]>,
  ): Promise<ObjectId | undefined> {
    const entries = new Map<string, TreeEntry>();
    if (treeId) {
      for await (const entry of this.trees.loadTree(treeId)) entries.set(entry.name, entry);
    }
    const subdirs = new Map<string, Array<[string, { mode: number; id: ObjectId } | null]>>();
    for (const [path, edit] of edits) {
      const slash = path.indexOf("/");
      if (slash >= 0) {
        const dir = path.slice(0, slash);
        const list = subdirs.get(dir) ?? [];
        list.push([path.slice(slash + 1), edit]);
        subdirs.set(dir, list);
      } else if (edit) {
        entries.set(path, { name: path, mode: edit.mode, id: edit.id });
      } else if (entries.get(path)?.mode !== FileMode.TREE) {
        entries.delete(path);
      }
    }
    for (const [dir, list] of subdirs) {
      const existing = entries.get(dir);
      const base = existing?.mode === FileMode.TREE ? existing.id : undefined;
      const id = await this.editTree(base, list);
      if (id) entries.set(dir, { name: dir, mode: FileMode.TREE, id });
      else if (base) entries.delete(dir);
    }
    if (entries.size === 0) return undefined;
    return this.trees.store([...entries.values()]);
  }

  /**
   * Stage all modified/deleted tracked files.
   *
   * Uses AddCommand with setUpdate(true) to stage changes,
   * equivalent to `git add -u .` which JGit does for --all.
   */
  private async stageTrackedChanges(): Promise<void> {
    // Get working tree iterator
    const worktree = this.getWorktreeIterator();
    if (!worktree) {
      throw new StoreNotAvailableError(
        "Worktree",
        "Working tree iterator required for --all mode. " +
          "Ensure WorkingCopy has worktree or call setWorktreeStore().",
      );
    }

    // Use AddCommand to stage all modified tracked files
    // git's add_files_to_cache without a pathspec (`commit -a`): no element to report
    const addCommand = new AddCommand(this._workingCopy);
    addCommand.setUpdate(true);
    // into the index lock the commit holds, once the commit's tree is made
    addCommand.setWriteIndex(false);
    addCommand.setWorktreeStore(worktree);
    await addCommand.call();
  }

  /**
   * Get working tree iterator from store or explicitly set.
   */
  private getWorktreeIterator(): Worktree | undefined {
    if (this.worktreeIterator) {
      return this.worktreeIterator;
    }

    // Get worktree from WorkingCopy
    return this.worktreeAccess;
  }
}

/** The index a commit holds while it changes it (see `CommitCommand.holdIndex`). */
interface HeldIndex {
  /** Writes the staging's entries into the index lock (nothing without an index file). */
  write(): Promise<void>;
  /** The index lock renamed over the index (a staging without one: written). */
  commit(): Promise<void>;
  /** On failure: the lock removed, the staging as it was before. Idempotent. */
  release(): Promise<void>;
}

/** Every entry of the staging, in its order. */
async function collectEntries(staging: Staging): Promise<StagingEntry[]> {
  const out: StagingEntry[] = [];
  for await (const entry of staging.entries()) out.push(entry);
  return out;
}

const isGitlink = (mode: number) => (mode & 0o170000) === 0o160000;

/** git's `rest_is_empty`: only whitespace and `Signed-off-by:` lines. */
function isEmptyMessage(message: string): boolean {
  return message
    .split("\n")
    .every((line) => line.startsWith("Signed-off-by: ") || /^[ \t\r]*$/.test(line));
}
