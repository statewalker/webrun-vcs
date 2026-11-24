import type { ReflogEntry } from "@statewalker/vcs-core";

import { GitCommand } from "../git-command.js";
import type { LogOutputOptions } from "./log-output.js";
import { RevListCommand } from "./rev-list-command.js";

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
 *
 * // git reflog show -2 main: "1a2b3c4 main@{0}: commit: Second\n..."
 * const text = await git.reflog().setRef("main").setMaxCount(2).callText();
 *
 * // git reflog exists refs/heads/main
 * const exists = await git.reflog().setRef("refs/heads/main").callExists();
 * ```
 */
export class ReflogCommand extends GitCommand<ReflogEntry[]> {
  private ref = "HEAD";
  private maxCount?: number;
  private warnings: string[] = [];

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

  /** `-<n>` / `-n <n>` of `git reflog show`: at most `n` entries. */
  setMaxCount(maxCount: number): this {
    this.checkCallable();
    this.maxCount = maxCount;
    return this;
  }

  /**
   * `git reflog [show] [<ref>]`'s output: `git log -g --abbrev-commit --pretty=oneline` of
   * the ref (`%h <ref>@{n}: <message>` per entry; the ref may carry a selector, `main@{2}`,
   * `HEAD@{now}`). `options` are log options over those defaults (`{ pretty: "short" }`
   * still abbreviates, `{ abbrevCommit: false }` is `--no-abbrev-commit`). Throws where git
   * dies (a ref that names nothing: `ambiguous argument`); {@link getWarnings} holds what it
   * warned.
   */
  async callText(options: LogOutputOptions = {}): Promise<string> {
    this.checkCallable();
    this.setCallable(false);
    const command = new RevListCommand(this._workingCopy)
      .setWalkReflogs(true)
      .addRevision(this.ref);
    if (this.maxCount !== undefined) command.setMaxCount(this.maxCount);
    try {
      const pretty = options.oneline ? {} : { pretty: "oneline" };
      return await command.callLogText({ ...pretty, abbrevCommit: true, ...options });
    } finally {
      this.warnings = command.getWarnings();
    }
  }

  /** What {@link callText} warned while reading the ref (`warning: log for ...`). */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  /**
   * `git reflog exists <ref>`: whether the ref (a full name, `refs/heads/main`, or `HEAD`)
   * has a reflog, an empty one too.
   */
  async callExists(): Promise<boolean> {
    this.checkCallable();
    this.setCallable(false);
    const reader = await this.refsStore.getReflog?.(this.ref).catch(() => undefined);
    return reader !== undefined;
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

    // Check if the ref store supports reflog
    if (!this.refsStore.getReflog) {
      throw new Error("This ref store does not support reflog");
    }

    const reader = await this.refsStore.getReflog(this.ref);
    if (!reader) {
      // Return empty array if no reflog exists (consistent with git behavior)
      return [];
    }

    return reader.getReverseEntries();
  }
}
