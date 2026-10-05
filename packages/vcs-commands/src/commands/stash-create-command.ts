import type { ObjectId, PersonIdent } from "@statewalker/vcs-core";

import { NoHeadError, RefNotFoundError } from "../errors/index.js";
import { GitCommand } from "../git-command.js";
import { STASH_REF } from "./stash-list-command.js";

/**
 * Get timezone offset string in Git format (+HHMM or -HHMM).
 */
function getTimezoneOffset(): string {
  const offset = new Date().getTimezoneOffset();
  const sign = offset <= 0 ? "+" : "-";
  const absOffset = Math.abs(offset);
  const hours = Math.floor(absOffset / 60)
    .toString()
    .padStart(2, "0");
  const minutes = (absOffset % 60).toString().padStart(2, "0");
  return `${sign}${hours}${minutes}`;
}

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
 * Interface for providing working tree and index state.
 *
 * The stash create operation requires access to the working directory
 * and index, which requires a WorkingCopy with worktree access.
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
   * Get tree of untracked files (optional).
   */
  getUntrackedTree?(): Promise<ObjectId | undefined>;

  /**
   * Check if there are local changes to stash.
   */
  hasLocalChanges(): Promise<boolean>;

  /**
   * Reset working directory to HEAD after stash.
   */
  resetHard(): Promise<void>;
}

/**
 * Command to create a stash commit.
 *
 * Equivalent to `git stash` or `git stash push`.
 *
 * Based on JGit's StashCreateCommand.
 *
 * Note: This command requires a working tree provider to access
 * uncommitted changes. Without a provider, it creates a stash
 * from the current HEAD state (no actual changes stashed).
 *
 * @example
 * ```typescript
 * // Create a stash with working tree provider
 * const stashCommit = await git.stashCreate()
 *   .setWorkingTreeProvider(provider)
 *   .setMessage("WIP: feature work")
 *   .call();
 *
 * // Create stash including untracked files
 * const stashCommit = await git.stashCreate()
 *   .setWorkingTreeProvider(provider)
 *   .setIncludeUntracked(true)
 *   .call();
 * ```
 */
export class StashCreateCommand extends GitCommand<ObjectId | undefined> {
  private indexMessage = MSG_INDEX;
  private workingDirectoryMessage = MSG_WORKING_DIR;
  private ref: string | null = STASH_REF;
  private includeUntracked = false;
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
   * Set a custom stash message.
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
   * If null, no reference is updated.
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
   * Set the author/committer identity for the stash commits.
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

    // Get author/committer
    const author: PersonIdent = this.author ?? {
      name: "Unknown",
      email: "unknown@example.com",
      timestamp: Math.floor(Date.now() / 1000),
      tzOffset: getTimezoneOffset(),
    };

    // Determine trees to stash
    let indexTree: ObjectId;
    let workingTree: ObjectId;
    let untrackedTree: ObjectId | undefined;

    if (this.workingTreeProvider) {
      // Check if there are changes to stash
      const hasChanges = await this.workingTreeProvider.hasLocalChanges();
      if (!hasChanges) {
        return undefined;
      }

      indexTree = await this.workingTreeProvider.getIndexTree();
      workingTree = await this.workingTreeProvider.getWorkingTree();

      if (this.includeUntracked && this.workingTreeProvider.getUntrackedTree) {
        untrackedTree = await this.workingTreeProvider.getUntrackedTree();
      }
    } else {
      // No working tree provider - use HEAD tree
      // This is a degenerate case where there's nothing to actually stash
      indexTree = headCommit.tree;
      workingTree = headCommit.tree;
    }

    // Build commit messages
    const abbrev = headRef.objectId.substring(0, 7);
    const shortMessage = headCommit.message.split("\n")[0];

    const indexMsg = this.formatMessage(this.indexMessage, branch, abbrev, shortMessage);
    const workingMsg =
      this.customMessage ??
      this.formatMessage(this.workingDirectoryMessage, branch, abbrev, shortMessage);

    // Create index commit (parent: HEAD)
    const indexCommit = await this.commits.store({
      tree: indexTree,
      parents: [headRef.objectId],
      author,
      committer: author,
      message: indexMsg,
    });

    // Create untracked commit if needed (no parents)
    let untrackedCommit: ObjectId | undefined;
    if (untrackedTree) {
      const untrackedMsg = this.formatMessage(MSG_UNTRACKED, branch, abbrev, shortMessage);
      untrackedCommit = await this.commits.store({
        tree: untrackedTree,
        parents: [],
        author,
        committer: author,
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
      committer: author,
      message: workingMsg,
    });

    // Update stash ref
    if (this.ref) {
      await this.updateStashRef(this.ref, stashCommit, workingMsg);
    }

    // Reset working directory (if provider supports it)
    if (this.workingTreeProvider) {
      await this.workingTreeProvider.resetHard();
    }

    return stashCommit;
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
    return "HEAD";
  }

  /**
   * Update the stash ref.
   *
   * Note: Reflog support is not part of the core RefStore interface.
   * Stash history is tracked via parent commit chain instead.
   */
  private async updateStashRef(ref: string, commitId: ObjectId, _message: string): Promise<void> {
    // Update ref
    await this.refsStore.set(ref, commitId);
  }
}
