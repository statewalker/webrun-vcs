/**
 * Store for cherry-pick operation state.
 *
 * Manages Git cherry-pick state files:
 * - CHERRY_PICK_HEAD: commit being cherry-picked
 * - MERGE_MSG: cherry-pick commit message
 * - ORIG_HEAD: HEAD before cherry-pick
 */

import { joinPath, readText, tryReadText } from "@statewalker/vcs-core";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import type { CherryPickState } from "@statewalker/vcs-working-tree/transformation";

/**
 * Store for cherry-pick operation state
 */
export interface CherryPickStateStore {
  /**
   * Read current cherry-pick state
   * @returns CherryPickState if cherry-pick in progress, undefined otherwise
   */
  read(): Promise<CherryPickState | undefined>;

  /**
   * Begin a cherry-pick operation
   * @param state Initial cherry-pick state
   */
  begin(state: Omit<CherryPickState, "type" | "startedAt">): Promise<void>;

  /**
   * Update cherry-pick message
   * @param message New message
   */
  updateMessage(message: string): Promise<void>;

  /**
   * Complete the cherry-pick (clean up state files)
   */
  complete(): Promise<void>;

  /**
   * Abort the cherry-pick (restore original state)
   */
  abort(): Promise<void>;

  /**
   * Check if cherry-pick is in progress
   */
  isInProgress(): Promise<boolean>;
}

/**
 * Git file-based implementation of CherryPickStateStore
 */
export class GitCherryPickStateStore implements CherryPickStateStore {
  private readonly gitDir: string;

  constructor(
    private readonly files: FilesApi,
    gitDir: string,
  ) {
    this.gitDir = gitDir;
  }

  async read(): Promise<CherryPickState | undefined> {
    const cherryPickHeadPath = joinPath(this.gitDir, "CHERRY_PICK_HEAD");

    if (!(await this.files.exists(cherryPickHeadPath))) {
      return undefined;
    }

    const cherryPickHead = await readText(this.files, cherryPickHeadPath);
    const origHead = await tryReadText(this.files, joinPath(this.gitDir, "ORIG_HEAD"));
    const message = await tryReadText(this.files, joinPath(this.gitDir, "MERGE_MSG"));

    // Get file modification time for startedAt
    const stats = await this.files.stats(cherryPickHeadPath);
    const startedAt = stats?.lastModified ? new Date(stats.lastModified) : new Date();

    return {
      type: "cherry-pick",
      startedAt,
      cherryPickHead: cherryPickHead.trim(),
      origHead: origHead?.trim() ?? cherryPickHead.trim(),
      message: message?.trim(),
      noCommit: false, // Default - actual value would come from sequencer opts
    };
  }

  async begin(state: Omit<CherryPickState, "type" | "startedAt">): Promise<void> {
    // Write CHERRY_PICK_HEAD
    await this.writeText(joinPath(this.gitDir, "CHERRY_PICK_HEAD"), `${state.cherryPickHead}\n`);

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
    return this.files.exists(joinPath(this.gitDir, "CHERRY_PICK_HEAD"));
  }

  // === Private Helpers ===

  private async removeStateFiles(): Promise<void> {
    const stateFiles = ["CHERRY_PICK_HEAD", "MERGE_MSG", "ORIG_HEAD"];
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
 * Factory function for creating CherryPickStateStore
 *
 * @param files FilesApi implementation
 * @param gitDir Path to .git directory
 */
export function createCherryPickStateStore(files: FilesApi, gitDir: string): CherryPickStateStore {
  return new GitCherryPickStateStore(files, gitDir);
}
