import type { Commit, ObjectId, PersonIdent } from "@statewalker/vcs-core";
import type { Worktree } from "@statewalker/vcs-working-tree";

import {
  EmptyCommitError,
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
import { withoutCrud } from "./git-ident.js";
import { OperationState } from "./merge-support.js";
import {
  CleanupMode,
  cleanupWith,
  commitCleanupMode,
  commitMessageFromOption,
  preparedMessageCleanup,
} from "./message-cleanup.js";
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
   * Set paths to commit (--only mode).
   *
   * When set, only the specified paths are taken from the staging area.
   * All other paths are taken from the parent commit's tree. This allows
   * partial commits without affecting unstaged changes to other files.
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
   * creating the commit. Requires a working tree iterator.
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

    // Handle --all flag: auto-stage modified tracked files
    if (this.all) {
      await this.stageTrackedChanges();
    }

    // Check for conflicts
    if (await this.staging.hasConflicts()) {
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

    if (this.amend) {
      const headId = await this.resolveHead();
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

    if (this.onlyPaths.length > 0 && parents.length > 0) {
      // --only mode: combine parent tree with specified paths from staging
      treeId = await this.buildOnlyTree(parents[0]);
    } else {
      // Normal mode: use full staging area
      treeId = await this.staging.writeTree(this.trees);
    }

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
    // state files cmd_commit unlinks), then applies a merge's autostash
    await this.cleanupAfterCommit(state);

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
  private async cleanupAfterCommit(state: OperationState): Promise<void> {
    if (!state.supported) return;
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
   * Build tree for --only mode.
   *
   * Combines parent tree with specified paths from staging area.
   *
   * @param parentCommitId Parent commit ID
   * @returns Tree ObjectId
   */
  private async buildOnlyTree(parentCommitId: ObjectId): Promise<ObjectId> {
    const parentCommit = await this.commits.load(parentCommitId);
    if (!parentCommit) {
      throw new RefNotFoundError(parentCommitId, "Parent commit not found");
    }

    // Collect staging entries for onlyPaths
    const onlyPathSet = new Set(this.onlyPaths);
    const stagingEntriesMap = new Map<string, { objectId: ObjectId; mode: number }>();

    for await (const entry of this.staging.entries()) {
      if (onlyPathSet.has(entry.path) && entry.stage === 0) {
        stagingEntriesMap.set(entry.path, {
          objectId: entry.objectId,
          mode: entry.mode,
        });
      }
    }

    // Create builder and populate with filtered tree
    const builder = this.staging.createBuilder();

    // Walk parent tree and add entries NOT in onlyPaths
    await this.addTreeFiltered(builder, parentCommit.tree, "", onlyPathSet);

    // Add staging entries for onlyPaths
    for (const [path, { objectId, mode }] of stagingEntriesMap) {
      builder.add({
        path,
        mode,
        objectId,
        size: 0,
        mtime: Date.now(),
      });
    }

    await builder.finish();

    // Now write tree from staging
    return await this.staging.writeTree(this.trees);
  }

  /**
   * Recursively walk tree and add entries to builder, excluding specified paths.
   */
  private async addTreeFiltered(
    builder: ReturnType<typeof this.staging.createBuilder>,
    treeId: ObjectId,
    prefix: string,
    excludePaths: Set<string>,
  ): Promise<void> {
    for await (const entry of this.trees.loadTree(treeId)) {
      const fullPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      // Check if this is a tree (directory)
      const isTree = (entry.mode & 0o170000) === 0o040000;

      if (isTree) {
        // Recursively process subtree
        await this.addTreeFiltered(builder, entry.id, fullPath, excludePaths);
      } else {
        // Only add if not in excluded paths
        if (!excludePaths.has(fullPath)) {
          builder.add({
            path: fullPath,
            mode: entry.mode,
            objectId: entry.id,
            size: 0,
            mtime: Date.now(),
          });
        }
      }
    }
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
    const addCommand = new AddCommand(this._workingCopy);
    addCommand.addFilepattern(".");
    addCommand.setUpdate(true);
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

/** git's `rest_is_empty`: only whitespace and `Signed-off-by:` lines. */
function isEmptyMessage(message: string): boolean {
  return message
    .split("\n")
    .every((line) => line.startsWith("Signed-off-by: ") || /^[ \t\r]*$/.test(line));
}
