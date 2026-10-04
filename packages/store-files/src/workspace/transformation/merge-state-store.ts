/**
 * Store for merge operation state.
 *
 * Manages Git merge state files:
 * - MERGE_HEAD: commit being merged
 * - MERGE_MSG: merge commit message
 * - ORIG_HEAD: HEAD before merge
 * - MERGE_MODE: merge mode flags
 */

import { joinPath, readText, tryReadText } from "@statewalker/vcs-core";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import type { MergeState } from "@statewalker/vcs-working-tree/transformation";

/**
 * Store for merge operation state
 */
export interface MergeStateStore {
  /**
   * Read current merge state
   * @returns MergeState if merge in progress, undefined otherwise
   */
  read(): Promise<MergeState | undefined>;

  /**
   * Begin a merge operation
   * @param state Initial merge state
   */
  begin(state: Omit<MergeState, "type" | "startedAt">): Promise<void>;

  /**
   * Update merge message
   * @param message New message
   */
  updateMessage(message: string): Promise<void>;

  /**
   * Complete the merge (clean up state files)
   */
  complete(): Promise<void>;

  /**
   * Abort the merge (restore original state)
   */
  abort(): Promise<void>;

  /**
   * Check if merge is in progress
   */
  isInProgress(): Promise<boolean>;
}

/**
 * Git file-based implementation of MergeStateStore
 */
export class GitMergeStateStore implements MergeStateStore {
  private readonly gitDir: string;

  constructor(
    private readonly files: FilesApi,
    gitDir: string,
  ) {
    this.gitDir = gitDir;
  }

  async read(): Promise<MergeState | undefined> {
    const mergeHeadPath = joinPath(this.gitDir, "MERGE_HEAD");

    if (!(await this.files.exists(mergeHeadPath))) {
      return undefined;
    }

    const mergeHead = await readText(this.files, mergeHeadPath);
    const origHead = await tryReadText(this.files, joinPath(this.gitDir, "ORIG_HEAD"));
    const message = await tryReadText(this.files, joinPath(this.gitDir, "MERGE_MSG"));
    const mode = await tryReadText(this.files, joinPath(this.gitDir, "MERGE_MODE"));

    // Get file modification time for startedAt
    const stats = await this.files.stats(mergeHeadPath);
    const startedAt = stats?.lastModified ? new Date(stats.lastModified) : new Date();

    return {
      type: "merge",
      startedAt,
      mergeHead: mergeHead.trim(),
      origHead: origHead?.trim() ?? mergeHead.trim(),
      message: message?.trim(),
      squash: mode?.includes("squash") ?? false,
      noFastForward: mode?.includes("no-ff") ?? false,
    };
  }

  async begin(state: Omit<MergeState, "type" | "startedAt">): Promise<void> {
    // Write MERGE_HEAD
    await this.writeText(joinPath(this.gitDir, "MERGE_HEAD"), `${state.mergeHead}\n`);

    // Write ORIG_HEAD
    await this.writeText(joinPath(this.gitDir, "ORIG_HEAD"), `${state.origHead}\n`);

    // Write MERGE_MSG if provided
    if (state.message) {
      await this.writeText(joinPath(this.gitDir, "MERGE_MSG"), state.message);
    }

    // Write MERGE_MODE if needed
    const modeFlags: string[] = [];
    if (state.squash) modeFlags.push("squash");
    if (state.noFastForward) modeFlags.push("no-ff");

    if (modeFlags.length > 0) {
      await this.writeText(joinPath(this.gitDir, "MERGE_MODE"), `${modeFlags.join("\n")}\n`);
    }
  }

  async updateMessage(message: string): Promise<void> {
    await this.writeText(joinPath(this.gitDir, "MERGE_MSG"), message);
  }

  async complete(): Promise<void> {
    await this.removeStateFiles();
  }

  async abort(): Promise<void> {
    await this.removeStateFiles();
  }

  async isInProgress(): Promise<boolean> {
    return this.files.exists(joinPath(this.gitDir, "MERGE_HEAD"));
  }

  // === Private Helpers ===

  private async removeStateFiles(): Promise<void> {
    const stateFiles = ["MERGE_HEAD", "MERGE_MSG", "ORIG_HEAD", "MERGE_MODE"];
    for (const file of stateFiles) {
      try {
        await this.files.remove(joinPath(this.gitDir, file));
      } catch {
        // Ignore errors for files that don't exist
      }
    }
  }

  private async writeText(path: string, content: string): Promise<void> {
    const data = new TextEncoder().encode(content);
    await this.files.write(path, [data]);
  }
}

/**
 * Factory function for creating MergeStateStore
 *
 * @param files FilesApi implementation
 * @param gitDir Path to .git directory
 */
export function createMergeStateStore(files: FilesApi, gitDir: string): MergeStateStore {
  return new GitMergeStateStore(files, gitDir);
}
