import type { ReflogEntry } from "@statewalker/vcs-core";

import { GitCommand } from "../git-command.js";

/**
 * Read reflog entries for a ref.
 *
 * Equivalent to `git reflog`.
 *
 * The reflog records when the tip of branches and other references
 * were updated in the local repository.
 *
 * Based on JGit's ReflogCommand.
 *
 * @example
 * ```typescript
 * // Get HEAD reflog entries
 * const entries = await git.reflog().call();
 *
 * // Get reflog for specific branch
 * const branchEntries = await git.reflog()
 *   .setRef("refs/heads/main")
 *   .call();
 *
 * // Iterate through entries
 * for (const entry of entries) {
 *   console.log(`${entry.newId.slice(0, 7)} ${entry.comment}`);
 * }
 * ```
 */
export class ReflogCommand extends GitCommand<ReflogEntry[]> {
  private ref = "HEAD";

  /**
   * Set the ref to show reflog for.
   *
   * @param ref Ref name (default: "HEAD")
   */
  setRef(ref: string): this {
    this.checkCallable();
    this.ref = ref;
    return this;
  }

  /**
   * Execute the reflog command.
   *
   * @returns Array of reflog entries in reverse chronological order (most recent first)
   * @throws Error if reflog doesn't exist for the ref
   */
  async call(): Promise<ReflogEntry[]> {
    this.checkCallable();
    this.setCallable(false);

    // Check if the RefStore supports reflog
    if (!this.refsStore.getReflog) {
      throw new Error("RefStore does not support reflog");
    }

    const reader = await this.refsStore.getReflog(this.ref);
    if (!reader) {
      // Return empty array if no reflog exists (consistent with git behavior)
      return [];
    }

    return reader.getReverseEntries();
  }
}
