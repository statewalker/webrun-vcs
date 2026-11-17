import type { ObjectId, PersonIdent } from "@statewalker/vcs-core";
import type { Staging } from "@statewalker/vcs-working-tree";

import { NoHeadError, RefNotFoundError, StoreNotAvailableError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { abbrevLengths } from "./core-config.js";
import { reflogMessages, updateHead } from "./reflog-messages.js";
import { STASH_REF } from "./stash-list-command.js";
import { WorkingCopyStashProvider } from "./stash-working-tree.js";

/**
 * Default message format for index commit.
 */
const MSG_INDEX = "index on {0}: {1} {2}";

/**
 * Default message format for working directory commit.
 */
const MSG_WORKING_DIR = "WIP on {0}: {1} {2}";

/**
 * Default message format for untracked files commit.
 */
const MSG_UNTRACKED = "untracked files on {0}: {1} {2}";

/**
 * What the reset after a stash covers, as `git stash push` options.
 */
export interface StashResetOptions {
  /** `-u`: the untracked files were stashed and are removed (`git clean -fd`) */
  includeUntracked?: boolean;
  /** `-a`: the ignored files too (`git clean -fdx`) */
  includeIgnored?: boolean;
  /** `--keep-index`: the index tree is checked out again after the reset */
  keepIndex?: boolean;
  /** The stashed index tree (for `keepIndex`) */
  indexTree?: ObjectId;
}

/**
 * Interface for providing working tree and index state.
 *
 * A working copy with an index and a worktree has a built-in provider
 * ({@link WorkingCopyStashProvider}); set one only to stash something else.
 */
export interface StashWorkingTreeProvider {
  /**
   * Get the current index tree (staged changes).
   */
  getIndexTree(): Promise<ObjectId>;

  /**
   * Get the working tree with uncommitted changes.
   */
  getWorkingTree(): Promise<ObjectId>;

  /**
   * Get tree of untracked files (optional); the ignored ones too with `includeIgnored`.
   */
  getUntrackedTree?(options?: { includeIgnored?: boolean }): Promise<ObjectId | undefined>;

  /**
   * Check if there are local changes to stash (untracked files count with
   * `includeUntracked`, as `git stash -u`).
   */
  hasLocalChanges(options?: {
    includeUntracked?: boolean;
    includeIgnored?: boolean;
  }): Promise<boolean>;

  /**
   * Reset the working directory and index to HEAD after the stash, as `git stash push`.
   */
  resetHard(options?: StashResetOptions): Promise<void>;
}

/**
 * Command to create a stash commit.
 *
 * Equivalent to `git stash` or `git stash push`.
 *
 * Based on JGit's StashCreateCommand.
 *
 * On a working copy with an index and a worktree it stashes as `git stash push` does:
 * the index tree, the worktree tree (tracked files as they are on disk), with `-u` the
 * untracked files, then resets the index and the worktree to HEAD (keeping untracked files
 * unless they were stashed). A working copy without a worktree has nothing to stash:
 * `call()` throws `StoreNotAvailableError` unless a provider is set.
 *
 * @example
 * ```typescript
 * // git stash push -m "WIP: feature work"
 * const stashCommit = await git.stashCreate().setMessage("WIP: feature work").call();
 *
 * // git stash push -u --keep-index
 * const stashCommit = await git.stashCreate()
 *   .setIncludeUntracked(true)
 *   .setKeepIndex(true)
 *   .call();
 * ```
 */
export class StashCreateCommand extends GitCommand<ObjectId | undefined> {
  private indexMessage = MSG_INDEX;
  private workingDirectoryMessage = MSG_WORKING_DIR;
  private ref: string | null = STASH_REF;
  private includeUntracked = false;
  private includeIgnored = false;
  private keepIndex = false;
  private workingTreeProvider?: StashWorkingTreeProvider;
  private customMessage?: string;
  private author?: PersonIdent;

  /**
   * Set the message used when committing index changes.
   *
   * The message will be formatted with the current branch, abbreviated
   * commit ID, and short commit message.
   *
   * @param message The index message template
   */
  setIndexMessage(message: string): this {
    this.checkCallable();
    this.indexMessage = message;
    return this;
  }

  /**
   * Set the message used when committing working directory changes.
   *
   * @param message The working directory message template
   */
  setWorkingDirectoryMessage(message: string): this {
    this.checkCallable();
    this.workingDirectoryMessage = message;
    return this;
  }

  /**
   * Set a custom stash message; the stash is then "On <branch>: <message>", as `git stash push -m`.
   *
   * @param message The custom message
   */
  setMessage(message: string): this {
    this.checkCallable();
    this.customMessage = message;
    return this;
  }

  /**
   * Set the reference to update with the stashed commit ID.
   * If null, no reference is updated and the index and worktree are left as they are
   * (`git stash create`).
   *
   * @param ref The ref name (default: refs/stash)
   */
  setRef(ref: string | null): this {
    this.checkCallable();
    this.ref = ref;
    return this;
  }

  /**
   * Set whether to include untracked files in the stash.
   *
   * @param includeUntracked true to include untracked files
   */
  setIncludeUntracked(includeUntracked: boolean): this {
    this.checkCallable();
    this.includeUntracked = includeUntracked;
    return this;
  }

  /**
   * Get whether untracked files will be included.
   */
  getIncludeUntracked(): boolean {
    return this.includeUntracked;
  }

  /**
   * Set whether to stash (and remove) the ignored files too, as `git stash --all`; implies
   * untracked files.
   */
  setIncludeIgnored(includeIgnored: boolean): this {
    this.checkCallable();
    this.includeIgnored = includeIgnored;
    if (includeIgnored) this.includeUntracked = true;
    return this;
  }

  /**
   * Set whether the staged changes stay in the index and the worktree after the stash, as
   * `git stash push --keep-index`.
   */
  setKeepIndex(keepIndex: boolean): this {
    this.checkCallable();
    this.keepIndex = keepIndex;
    return this;
  }

  /**
   * Set the working tree provider for accessing uncommitted changes.
   *
   * @param provider The working tree provider
   */
  setWorkingTreeProvider(provider: StashWorkingTreeProvider): this {
    this.checkCallable();
    this.workingTreeProvider = provider;
    return this;
  }

  /**
   * Set the author/committer identity for the stash commits (default: each resolved as git
   * resolves it).
   *
   * @param author The author identity
   */
  setAuthor(author: PersonIdent): this {
    this.checkCallable();
    this.author = author;
    return this;
  }

  /**
   * Execute the stash create command.
   *
   * @returns The stash commit ID, or undefined if nothing to stash
   */
  async call(): Promise<ObjectId | undefined> {
    this.checkCallable();
    this.setCallable(false);
    // one operation: one reading of the ignore rules for the trees, the clean and the reset
    const worktree = this.worktreeAccess;
    return worktree?.batch ? worktree.batch(() => this.stash()) : this.stash();
  }

  private async stash(): Promise<ObjectId | undefined> {
    // Get current HEAD
    const headRef = await this.refsStore.resolve("HEAD");
    if (!headRef?.objectId) {
      throw new NoHeadError("HEAD is required to stash");
    }

    const headCommit = await this.commits.load(headRef.objectId);
    if (!headCommit) {
      throw new RefNotFoundError(headRef.objectId, "HEAD commit not found");
    }
    const branch = await this.getCurrentBranchName();

    // git's stash commits (commit_tree without an author): the author and the committer as
    // git resolves them (GIT_AUTHOR_* / GIT_COMMITTER_*, author.* / committer.*, user.*),
    // unless one identity is given for both
    const author: PersonIdent = this.author ?? this.resolveAuthor();
    const committer: PersonIdent = this.author ?? this.resolveCommitter(author);

    // Determine trees to stash
    const provider = this.workingTreeProvider ?? this.defaultProvider();
    if (!provider) {
      // without a working tree there is nothing to stash: stashing HEAD's tree instead
      // would report success while the local changes stay unsaved
      throw new StoreNotAvailableError("worktree", "stash requires a working tree");
    }
    const untrackedOptions = {
      includeUntracked: this.includeUntracked,
      includeIgnored: this.includeIgnored,
    };
    // Check if there are changes to stash ("No local changes to save")
    if (!(await provider.hasLocalChanges(untrackedOptions))) {
      return undefined;
    }

    const indexTree = await provider.getIndexTree();
    const workingTree = await provider.getWorkingTree();
    const untrackedTree =
      this.includeUntracked && provider.getUntrackedTree
        ? await provider.getUntrackedTree({ includeIgnored: this.includeIgnored })
        : undefined;

    // Build commit messages
    // git's find_unique_abbrev (core.abbrev, unique in the repository)
    const head = headRef.objectId;
    const abbrev = head.substring(
      0,
      (await abbrevLengths(this.workingCopy, [head])).get(head) ?? 7,
    );
    const shortMessage = headCommit.message.split("\n")[0];

    // git's do_create_stash: the index and untracked commits' messages end in a line end
    // ("index on %s\n"), the stash commit's does not
    const withEol = (text: string) => (text.endsWith("\n") ? text : `${text}\n`);
    const indexMsg = withEol(this.formatMessage(this.indexMessage, branch, abbrev, shortMessage));
    // git: `stash push -m <msg>` is "On <branch>: <msg>"
    const workingMsg =
      this.customMessage !== undefined
        ? `On ${branch}: ${this.customMessage}`
        : this.formatMessage(this.workingDirectoryMessage, branch, abbrev, shortMessage);

    // Create index commit (parent: HEAD)
    const indexCommit = await this.commits.store({
      tree: indexTree,
      parents: [headRef.objectId],
      author,
      committer,
      message: indexMsg,
    });

    // Create untracked commit if needed (no parents)
    let untrackedCommit: ObjectId | undefined;
    if (untrackedTree) {
      const untrackedMsg = withEol(this.formatMessage(MSG_UNTRACKED, branch, abbrev, shortMessage));
      untrackedCommit = await this.commits.store({
        tree: untrackedTree,
        parents: [],
        author,
        committer,
        message: untrackedMsg,
      });
    }

    // Create stash commit (working tree state)
    // Parents: HEAD, index commit, [untracked commit]
    const parents = [headRef.objectId, indexCommit];
    if (untrackedCommit) {
      parents.push(untrackedCommit);
    }

    const stashCommit = await this.commits.store({
      tree: workingTree,
      parents,
      author,
      committer,
      message: workingMsg,
    });

    // `git stash create` (no ref): the stash commit only, nothing else changes
    if (!this.ref) return stashCommit;
    await this.updateStashRef(this.ref, stashCommit, workingMsg, this.author);

    // Reset the index and the working directory, as git stash push does
    await provider.resetHard({ ...untrackedOptions, keepIndex: this.keepIndex, indexTree });
    // git stash push runs `git reset --hard`: HEAD's reflog says "reset: moving to HEAD"
    await updateHead(
      this.refsStore,
      headRef.objectId,
      this.reflogLine(reflogMessages.reset("HEAD"), this.author),
    );

    return stashCommit;
  }

  /** The built-in provider, for a working copy with an index and a worktree. */
  private defaultProvider(): StashWorkingTreeProvider | undefined {
    const worktree = this.worktreeAccess;
    if (!worktree) return undefined;
    let staging: Staging;
    try {
      staging = this.staging;
    } catch {
      return undefined;
    }
    return new WorkingCopyStashProvider({
      workingCopy: this.workingCopy,
      trees: this.trees,
      blobs: this.blobs,
      staging,
      worktree,
      headTree: async () => {
        const head = await this.refsStore.resolve("HEAD");
        return head?.objectId ? (await this.commits.load(head.objectId))?.tree : undefined;
      },
    });
  }

  /**
   * Format a message template.
   */
  private formatMessage(
    template: string,
    branch: string,
    abbrev: string,
    shortMessage: string,
  ): string {
    return template.replace("{0}", branch).replace("{1}", abbrev).replace("{2}", shortMessage);
  }

  /**
   * Get the current branch name.
   */
  private async getCurrentBranchName(): Promise<string> {
    const branch = await this.getCurrentBranch();
    if (branch) {
      // Strip refs/heads/ prefix
      return branch.replace(/^refs\/heads\//, "");
    }
    return "(no branch)"; // detached HEAD, as git names it
  }

  /**
   * Update the stash ref as `git stash` does (update_ref with REF_FORCE_CREATE_REFLOG):
   * a one-ref batch, under `<ref>.lock` on git files, that creates the ref's reflog and
   * appends a line with the stash commit's message, so the stash is `stash@{0}` and the
   * earlier ones move down the reflog.
   */
  private async updateStashRef(
    ref: string,
    commitId: ObjectId,
    message: string,
    who: PersonIdent | undefined,
  ): Promise<void> {
    // the identity: the one set, else git's committer ident (environment, configuration)
    const result = await this.refsStore.batch([{ name: ref, new: commitId }], {
      ...this.reflogLine(message, who),
      createReflog: true,
    });
    if (!result.ok) {
      const why = result.rejected.map((r) => `${r.name}: ${r.reason}`).join(", ");
      throw new Error(`Cannot save the current status: ${why}`);
    }
  }
}
