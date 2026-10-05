/**
 * Store for revert operation state.
 *
 * Manages Git revert state files:
 * - REVERT_HEAD: commit being reverted
 * - MERGE_MSG: revert commit message
 * - ORIG_HEAD: HEAD before revert
 */

import { joinPath, readText, tryReadText } from "@statewalker/vcs-core";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import type { RevertState } from "@statewalker/vcs-working-tree/transformation";

/**
 * Store for revert operation state
 */
export interface RevertStateStore {
  /**
   * Read current revert state
   * @returns RevertState if revert in progress, undefined otherwise
   */
  read(): Promise<RevertState | undefined>;

  /**
   * Begin a revert operation
   * @param state Initial revert state
   */
  begin(state: Omit<RevertState, "type" | "startedAt">): Promise<void>;

  /**
   * Update revert message
   * @param message New message
   */
  updateMessage(message: string): Promise<void>;

  /**
   * Complete the revert (clean up state files)
   */
  complete(): Promise<void>;

  /**
   * Abort the revert (restore original state)
   */
  abort(): Promise<void>;

  /**
   * Check if revert is in progress
   */
  isInProgress(): Promise<boolean>;
}

/**
 * Git file-based implementation of RevertStateStore
 */
export class GitRevertStateStore implements RevertStateStore {
  private readonly gitDir: string;

  constructor(
    private readonly files: FilesApi,
    gitDir: string,
  ) {
    this.gitDir = gitDir;
  }

  async read(): Promise<RevertState | undefined> {
    const revertHeadPath = joinPath(this.gitDir, "REVERT_HEAD");

    if (!(await this.files.exists(revertHeadPath))) {
      return undefined;
    }

    const revertHead = await readText(this.files, revertHeadPath);
    const origHead = await tryReadText(this.files, joinPath(this.gitDir, "ORIG_HEAD"));
    const message = await tryReadText(this.files, joinPath(this.gitDir, "MERGE_MSG"));

    // Get file modification time for startedAt
    const stats = await this.files.stats(revertHeadPath);
    const startedAt = stats?.lastModified ? new Date(stats.lastModified) : new Date();

    return {
      type: "revert",
      startedAt,
      revertHead: revertHead.trim(),
      origHead: origHead?.trim() ?? revertHead.trim(),
      message: message?.trim(),
      noCommit: false, // Default - actual value would come from sequencer opts
    };
  }

  async begin(state: Omit<RevertState, "type" | "startedAt">): Promise<void> {
    // Write REVERT_HEAD
    await this.writeText(joinPath(this.gitDir, "REVERT_HEAD"), `${state.revertHead}\n`);

    // Write ORIG_HEAD
    await this.writeText(joinPath(this.gitDir, "ORIG_HEAD"), `${state.origHead}\n`);

    // Write MERGE_MSG if provided
    if (state.message) {
      await this.writeText(joinPath(this.gitDir, "MERGE_MSG"), state.message);
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
    return this.files.exists(joinPath(this.gitDir, "REVERT_HEAD"));
  }

  // === Private Helpers ===

  private async removeStateFiles(): Promise<void> {
    const stateFiles = ["REVERT_HEAD", "MERGE_MSG", "ORIG_HEAD"];
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
 * Factory function for creating RevertStateStore
 *
 * @param files FilesApi implementation
 * @param gitDir Path to .git directory
 */
export function createRevertStateStore(files: FilesApi, gitDir: string): RevertStateStore {
  return new GitRevertStateStore(files, gitDir);
}
