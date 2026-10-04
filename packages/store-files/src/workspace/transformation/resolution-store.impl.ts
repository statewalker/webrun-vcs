/**
 * GitResolutionStore - Git file-based implementation of ResolutionStore
 *
 * Provides conflict tracking and resolution management using:
 * - Staging area entries (stages 1-3) for conflict detection
 * - Working tree for resolved content
 * - .git/rr-cache/ for recorded resolutions (rerere)
 */

import type { Blobs, ObjectId } from "@statewalker/vcs-core";
import { sha1 } from "@statewalker/vcs-utils";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import { joinPath, tryReadFile } from "@statewalker/vcs-utils/files";
import type { IndexEntry, Staging } from "@statewalker/vcs-working-tree";
import { MergeStage } from "@statewalker/vcs-working-tree";
import type {
  ConflictEntry,
  ConflictInfo,
  ConflictStats,
  ConflictType,
  RecordedResolution,
  Resolution,
  ResolutionStore,
} from "@statewalker/vcs-working-tree/transformation";

/**
 * Git file-based ResolutionStore implementation.
 *
 * Conflict detection based on staging area (index) entries with stages 1-3.
 * Resolution recording stored in .git/rr-cache/ directory.
 */
export class GitResolutionStore implements ResolutionStore {
  private readonly rerereDir: string;
  private readonly worktreePath: string;

  constructor(
    private readonly files: FilesApi,
    private readonly staging: Staging,
    private readonly blobs: Blobs,
    readonly gitDir: string,
    worktreePath?: string,
  ) {
    this.rerereDir = joinPath(gitDir, "rr-cache");
    // Worktree is typically the parent of .git directory
    this.worktreePath = worktreePath ?? joinPath(gitDir, "..");
  }

  // ========== Conflict Registry ==========

  async getConflicts(): Promise<ConflictInfo[]> {
    const conflictsByPath = new Map<string, IndexEntry[]>();

    // Collect all conflict entries (stage > 0)
    for await (const entry of this.staging.entries()) {
      if (entry.stage !== MergeStage.MERGED) {
        const existing = conflictsByPath.get(entry.path) ?? [];
        existing.push(entry);
        conflictsByPath.set(entry.path, existing);
      }
    }

    // Build ConflictInfo for each path
    const conflicts: ConflictInfo[] = [];
    for (const [path, stageEntries] of conflictsByPath) {
      const base = stageEntries.find((e) => e.stage === MergeStage.BASE);
      const ours = stageEntries.find((e) => e.stage === MergeStage.OURS);
      const theirs = stageEntries.find((e) => e.stage === MergeStage.THEIRS);

      conflicts.push({
        path,
        type: this.determineConflictType(base, ours, theirs),
        base: base ? this.toConflictEntry(base) : undefined,
        ours: ours ? this.toConflictEntry(ours) : undefined,
        theirs: theirs ? this.toConflictEntry(theirs) : undefined,
        resolvedInWorktree: await this.isResolvedInWorktree(path),
        staged: false, // Not staged if we have conflict entries
      });
    }

    return conflicts;
  }

  async getConflict(path: string): Promise<ConflictInfo | undefined> {
    const entries = await this.staging.getEntries(path);
    const conflictEntries = entries.filter((e) => e.stage !== MergeStage.MERGED);

    if (conflictEntries.length === 0) {
      return undefined;
    }

    const base = conflictEntries.find((e) => e.stage === MergeStage.BASE);
    const ours = conflictEntries.find((e) => e.stage === MergeStage.OURS);
    const theirs = conflictEntries.find((e) => e.stage === MergeStage.THEIRS);

    return {
      path,
      type: this.determineConflictType(base, ours, theirs),
      base: base ? this.toConflictEntry(base) : undefined,
      ours: ours ? this.toConflictEntry(ours) : undefined,
      theirs: theirs ? this.toConflictEntry(theirs) : undefined,
      resolvedInWorktree: await this.isResolvedInWorktree(path),
      staged: false,
    };
  }

  async hasConflicts(): Promise<boolean> {
    return this.staging.hasConflicts();
  }

  async getStats(): Promise<ConflictStats> {
    const conflicts = await this.getConflicts();
    const resolved = conflicts.filter((c) => c.resolvedInWorktree);

    const byType: Record<ConflictType, number> = {
      content: 0,
      "delete-modify": 0,
      "modify-delete": 0,
      "add-add": 0,
      mode: 0,
      "rename-rename": 0,
      "rename-delete": 0,
      "directory-file": 0,
      submodule: 0,
    };

    for (const conflict of conflicts) {
      byType[conflict.type]++;
    }

    return {
      totalConflicts: conflicts.length,
      resolvedCount: resolved.length,
      pendingCount: conflicts.length - resolved.length,
      byType,
    };
  }

  async getConflictPaths(): Promise<string[]> {
    return this.staging.getConflictedPaths();
  }

  // ========== Resolution Workflow ==========

  async markResolved(path: string, resolution: Resolution): Promise<void> {
    // Remove all conflict stage entries for this path
    await this.staging.removeEntry(path, MergeStage.BASE);
    await this.staging.removeEntry(path, MergeStage.OURS);
    await this.staging.removeEntry(path, MergeStage.THEIRS);

    // Add resolved entry at stage 0 (unless deleted)
    if (resolution.strategy !== "delete" && resolution.objectId) {
      await this.staging.setEntry({
        path,
        objectId: resolution.objectId,
        mode: resolution.mode ?? 0o100644,
        stage: MergeStage.MERGED,
      });
    }
  }

  async markAllResolved(): Promise<void> {
    const conflicts = await this.getConflicts();

    for (const conflict of conflicts) {
      if (conflict.resolvedInWorktree) {
        // Get content from working tree and stage it
        const content = await this.readWorktreeFile(conflict.path);
        if (content) {
          const objectId = await this.blobs.store([content]);
          await this.markResolved(conflict.path, {
            strategy: "manual",
            objectId,
            mode: conflict.ours?.mode ?? conflict.theirs?.mode ?? 0o100644,
          });
        }
      }
    }
  }

  async unmarkResolved(_path: string): Promise<void> {
    // This would require restoring original conflict entries
    // which we'd need to have saved somewhere
    throw new Error("unmarkResolved not implemented - original conflict entries are not preserved");
  }

  async acceptOurs(path: string): Promise<void> {
    const conflict = await this.getConflict(path);
    if (!conflict) {
      throw new Error(`No conflict for path: ${path}`);
    }
    if (!conflict.ours) {
      throw new Error(`No 'ours' version for conflict: ${path}`);
    }

    await this.markResolved(path, {
      strategy: "ours",
      objectId: conflict.ours.objectId,
      mode: conflict.ours.mode,
    });

    // Write to working tree
    await this.writeWorktreeFile(path, conflict.ours.objectId);
  }

  async acceptTheirs(path: string): Promise<void> {
    const conflict = await this.getConflict(path);
    if (!conflict) {
      throw new Error(`No conflict for path: ${path}`);
    }
    if (!conflict.theirs) {
      throw new Error(`No 'theirs' version for conflict: ${path}`);
    }

    await this.markResolved(path, {
      strategy: "theirs",
      objectId: conflict.theirs.objectId,
      mode: conflict.theirs.mode,
    });

    // Write to working tree
    await this.writeWorktreeFile(path, conflict.theirs.objectId);
  }

  // ========== Resolution Recording (rerere) ==========

  async recordResolution(path: string): Promise<string | undefined> {
    const conflict = await this.getConflict(path);
    if (!conflict) return undefined;

    // Compute conflict signature
    const signature = await this.computeConflictSignature(conflict);

    // Get resolved content from working tree
    const resolvedContent = await this.readWorktreeFile(path);
    if (!resolvedContent) return undefined;

    // Ensure rr-cache directory exists
    try {
      await this.files.mkdir(this.rerereDir);
    } catch {
      // Directory may already exist
    }

    const cacheDir = joinPath(this.rerereDir, signature);
    try {
      await this.files.mkdir(cacheDir);
    } catch {
      // Directory may already exist
    }

    // Write postimage (resolved content)
    await this.files.write(joinPath(cacheDir, "postimage"), [resolvedContent]);

    // Write preimage (conflict content) for reference
    const conflictContent = await this.generateConflictMarkers(conflict);
    if (conflictContent) {
      await this.files.write(joinPath(cacheDir, "preimage"), [conflictContent]);
    }

    return signature;
  }

  async getSuggestedResolution(path: string): Promise<RecordedResolution | undefined> {
    const conflict = await this.getConflict(path);
    if (!conflict) return undefined;

    const signature = await this.computeConflictSignature(conflict);
    return this.getRecordedResolution(signature);
  }

  async applyRecordedResolution(path: string): Promise<boolean> {
    const recorded = await this.getSuggestedResolution(path);
    if (!recorded?.resolvedContent) return false;

    // Write resolved content to working tree
    const fullPath = joinPath(this.worktreePath, path);
    await this.files.write(fullPath, [recorded.resolvedContent]);

    return true;
  }

  async autoResolve(): Promise<string[]> {
    const conflicts = await this.getConflicts();
    const resolved: string[] = [];

    for (const conflict of conflicts) {
      if (await this.applyRecordedResolution(conflict.path)) {
        resolved.push(conflict.path);
      }
    }

    return resolved;
  }

  async clearRecordedResolutions(): Promise<void> {
    if (await this.directoryExists(this.rerereDir)) {
      await this.removeDirectory(this.rerereDir);
    }
  }

  // ========== Rerere Database ==========

  async listRecordedResolutions(): Promise<string[]> {
    if (!(await this.directoryExists(this.rerereDir))) {
      return [];
    }

    const signatures: string[] = [];
    try {
      for await (const entry of this.files.list(this.rerereDir)) {
        if (entry.kind === "directory") {
          signatures.push(entry.name);
        }
      }
    } catch {
      // Directory may not exist or be readable
    }
    return signatures;
  }

  async getRecordedResolution(signature: string): Promise<RecordedResolution | undefined> {
    const cacheDir = joinPath(this.rerereDir, signature);
    if (!(await this.directoryExists(cacheDir))) {
      return undefined;
    }

    const postimage = await tryReadFile(this.files, joinPath(cacheDir, "postimage"));
    const preimage = await tryReadFile(this.files, joinPath(cacheDir, "preimage"));

    if (!postimage) return undefined;

    let recordedAt = new Date();
    try {
      const stats = await this.files.stats(cacheDir);
      if (stats?.lastModified) {
        recordedAt = new Date(stats.lastModified);
      }
    } catch {
      // Use current time if stats fails
    }

    return {
      signature,
      resolution: {
        strategy: "manual",
      },
      recordedAt,
      conflictContent: preimage,
      resolvedContent: postimage,
    };
  }

  async deleteRecordedResolution(signature: string): Promise<boolean> {
    const cacheDir = joinPath(this.rerereDir, signature);
    if (!(await this.directoryExists(cacheDir))) {
      return false;
    }

    await this.removeDirectory(cacheDir);
    return true;
  }

  // ========== Private Helpers ==========

  /**
   * Determine conflict type from staging entries
   */
  private determineConflictType(
    base: IndexEntry | undefined,
    ours: IndexEntry | undefined,
    theirs: IndexEntry | undefined,
  ): ConflictType {
    // Both sides modified (most common case)
    if (base && ours && theirs) {
      // Check for mode-only conflict
      if (ours.mode !== theirs.mode && ours.objectId === theirs.objectId) {
        return "mode";
      }
      return "content";
    }

    // Delete/modify conflicts
    if (base && !ours && theirs) return "delete-modify";
    if (base && ours && !theirs) return "modify-delete";

    // Add/add conflict (no common ancestor)
    if (!base && ours && theirs) return "add-add";

    // Default to content conflict
    return "content";
  }

  /**
   * Convert staging entry to conflict entry
   */
  private toConflictEntry(entry: IndexEntry): ConflictEntry {
    return {
      objectId: entry.objectId,
      mode: entry.mode,
      size: entry.size,
    };
  }

  /**
   * Check if file is resolved in working tree (no conflict markers)
   */
  private async isResolvedInWorktree(path: string): Promise<boolean> {
    const content = await this.readWorktreeFile(path);
    if (!content) return false;

    // Check if file still has conflict markers
    const text = new TextDecoder().decode(content);
    return !text.includes("<<<<<<<") && !text.includes(">>>>>>>");
  }

  /**
   * Compute unique signature for a conflict based on content
   */
  private async computeConflictSignature(conflict: ConflictInfo): Promise<string> {
    // Signature based on base/ours/theirs object IDs
    const parts = [
      conflict.base?.objectId ?? "none",
      conflict.ours?.objectId ?? "none",
      conflict.theirs?.objectId ?? "none",
    ];
    const input = new TextEncoder().encode(parts.join(":"));
    const hash = await sha1(input);
    return this.toHexString(hash);
  }

  /**
   * Generate conflict markers for preimage
   */
  private async generateConflictMarkers(conflict: ConflictInfo): Promise<Uint8Array | undefined> {
    const parts: string[] = [];

    if (conflict.ours) {
      const content = await this.loadBlobContent(conflict.ours.objectId);
      if (content) {
        parts.push("<<<<<<< ours");
        parts.push(new TextDecoder().decode(content));
      }
    }

    if (conflict.base) {
      const content = await this.loadBlobContent(conflict.base.objectId);
      if (content) {
        parts.push("||||||| base");
        parts.push(new TextDecoder().decode(content));
      }
    }

    parts.push("=======");

    if (conflict.theirs) {
      const content = await this.loadBlobContent(conflict.theirs.objectId);
      if (content) {
        parts.push(new TextDecoder().decode(content));
        parts.push(">>>>>>> theirs");
      }
    }

    if (parts.length > 1) {
      return new TextEncoder().encode(parts.join("\n"));
    }

    return undefined;
  }

  /**
   * Load blob content as Uint8Array
   */
  private async loadBlobContent(objectId: ObjectId): Promise<Uint8Array | undefined> {
    const stream = await this.blobs.load(objectId);
    if (!stream) return undefined;

    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return this.concat(chunks);
  }

  /**
   * Read file from working tree
   */
  private async readWorktreeFile(path: string): Promise<Uint8Array | undefined> {
    const fullPath = joinPath(this.worktreePath, path);
    try {
      // First check if file exists
      const stats = await this.files.stats(fullPath);
      if (!stats) return undefined;

      return await tryReadFile(this.files, fullPath);
    } catch {
      return undefined;
    }
  }

  /**
   * Write content to working tree
   */
  private async writeWorktreeFile(path: string, objectId: ObjectId): Promise<void> {
    const content = await this.loadBlobContent(objectId);
    if (content) {
      const fullPath = joinPath(this.worktreePath, path);
      await this.files.write(fullPath, [content]);
    }
  }

  /**
   * Check if directory exists
   */
  private async directoryExists(path: string): Promise<boolean> {
    try {
      const stats = await this.files.stats(path);
      return stats !== undefined && stats !== null;
    } catch {
      return false;
    }
  }

  /**
   * Remove directory recursively
   */
  private async removeDirectory(path: string): Promise<void> {
    if (!(await this.directoryExists(path))) return;

    try {
      for await (const entry of this.files.list(path)) {
        const entryPath = joinPath(path, entry.name);
        if (entry.kind === "directory") {
          await this.removeDirectory(entryPath);
        } else {
          await this.files.remove(entryPath);
        }
      }
      await this.files.remove(path);
    } catch {
      // Ignore errors during cleanup
    }
  }

  /**
   * Concatenate Uint8Array chunks
   */
  private concat(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  /**
   * Convert Uint8Array to hex string
   */
  private toHexString(bytes: Uint8Array): string {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}

/**
 * Factory function to create a GitResolutionStore
 *
 * @param files FilesApi implementation
 * @param staging Staging interface for conflict detection
 * @param blobs Blobs interface for content storage
 * @param gitDir Path to .git directory
 * @param worktreePath Path to working tree (defaults to parent of gitDir)
 */
export function createResolutionStore(
  files: FilesApi,
  staging: Staging,
  blobs: Blobs,
  gitDir: string,
  worktreePath?: string,
): ResolutionStore {
  return new GitResolutionStore(files, staging, blobs, gitDir, worktreePath);
}
