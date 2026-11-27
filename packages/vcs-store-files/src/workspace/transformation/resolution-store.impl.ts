/**
 * GitResolutionStore - Git file-based implementation of ResolutionStore
 *
 * Provides conflict tracking and resolution management using:
 * - Staging area entries (stages 1-3) for conflict detection
 * - Working tree for resolved content
 * - .git/rr-cache/ for recorded resolutions (rerere): git reads it as its own records, so
 *   only a {@link RerereEngine} (vcs-commands' rerere.c port, `git.rerere().engine()`)
 *   records or replays there; without one nothing is recorded. Listing, reading and
 *   deleting a record's directory work on git's format as it lies.
 *
 * Worktree files are read and written through a Worktree (a FileWorktree over the
 * FilesApi by default), never with raw FilesApi calls: a symbolic link is read as its
 * target and replaced rather than written through, and nothing beneath a link is touched.
 */

import { type Blobs, FileMode, type ObjectId, type Trees } from "@statewalker/vcs-core";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import { dirname, joinPath, tryReadFile } from "@statewalker/vcs-utils/files";
import type { IndexEntry, Staging, Worktree } from "@statewalker/vcs-working-tree";
import { MergeStage, storeWorktreeFile } from "@statewalker/vcs-working-tree";
import type {
  ConflictEntry,
  ConflictInfo,
  ConflictStats,
  ConflictType,
  RecordedResolution,
  RerereEngine,
  Resolution,
  ResolutionStore,
} from "@statewalker/vcs-working-tree/transformation";
import { createFileWorktree } from "../worktree/index.js";

/**
 * Git file-based ResolutionStore implementation.
 *
 * Conflict detection based on staging area (index) entries with stages 1-3.
 * Resolution recording stored in .git/rr-cache/ directory.
 */
export class GitResolutionStore implements ResolutionStore {
  private readonly rerereDir: string;
  private readonly worktree: Worktree;

  constructor(
    private readonly files: FilesApi,
    private readonly staging: Staging,
    private readonly blobs: Blobs,
    readonly gitDir: string,
    worktreePath?: string,
    worktree?: Worktree,
    /** git's rerere over the same index and worktree (`git.rerere().engine()`) */
    private readonly rerere?: RerereEngine,
  ) {
    this.rerereDir = joinPath(gitDir, "rr-cache");
    // Worktree is typically the parent of .git directory
    this.worktree =
      worktree ??
      createFileWorktree({
        files,
        rootPath: worktreePath ?? dirname(gitDir),
        gitDir,
        blobs,
        // never used: the resolution store reads and writes files, it checks out no tree
        trees: {} as Trees,
      });
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
        // Stream the working tree file into a blob and stage it
        const stored = await this.storeWorktreeFile(conflict.path);
        if (stored) {
          await this.markResolved(conflict.path, {
            strategy: "manual",
            objectId: stored.id,
            // a link stays a link; a file keeps the mode the conflict had
            mode:
              stored.mode === FileMode.SYMLINK
                ? FileMode.SYMLINK
                : (conflict.ours?.mode ?? conflict.theirs?.mode ?? 0o100644),
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
    await this.writeWorktreeFile(path, conflict.ours.objectId, conflict.ours.mode);
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
    await this.writeWorktreeFile(path, conflict.theirs.objectId, conflict.theirs.mode);
  }

  // ========== Resolution Recording (rerere) ==========

  async recordResolution(path: string): Promise<string | undefined> {
    if (!this.rerere || !(await this.getConflict(path))) return undefined;
    return this.rerere.record(path);
  }

  async getSuggestedResolution(path: string): Promise<RecordedResolution | undefined> {
    if (!this.rerere || !(await this.getConflict(path))) return undefined;
    const replay = await this.rerere.replay(path);
    return replay && this.replayed(replay);
  }

  async applyRecordedResolution(path: string): Promise<boolean> {
    if (!this.rerere || !(await this.getConflict(path))) return false;
    return (await this.rerere.replay(path, { apply: true })) !== undefined;
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

  private replayed(replay: {
    signature: string;
    preimage: Uint8Array;
    content: Uint8Array;
  }): RecordedResolution {
    return {
      signature: replay.signature,
      resolution: { strategy: "manual" },
      recordedAt: new Date(),
      conflictContent: replay.preimage,
      resolvedContent: replay.content,
    };
  }

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
    try {
      const entry = await this.worktree.getEntry(path);
      if (!entry || entry.isDirectory) return false;
      // Scan for conflict markers chunk by chunk; the tail of each chunk is kept
      // so a marker split across two chunks is still found.
      const decoder = new TextDecoder();
      let tail = "";
      for await (const chunk of this.worktree.readContent(path)) {
        const text = tail + decoder.decode(chunk, { stream: true });
        if (text.includes("<<<<<<<") || text.includes(">>>>>>>")) return false;
        tail = text.slice(-6);
      }
      const rest = tail + decoder.decode();
      return !rest.includes("<<<<<<<") && !rest.includes(">>>>>>>");
    } catch {
      return false;
    }
  }

  /**
   * Write content to working tree
   */
  private async writeWorktreeFile(path: string, objectId: ObjectId, mode?: number): Promise<void> {
    // the blob streams into the file; it is never held whole in memory. The worktree
    // refuses paths naming `.git` and paths beneath a symbolic link.
    const content = await this.blobs.load(objectId);
    if (content) {
      await this.worktree.writeContent(path, content, mode !== undefined ? { mode } : {});
    }
  }

  /**
   * Store a working tree file as a blob, streamed with its size from stat. If
   * the file changes size while it is read, it is stored again without a size
   * (the blob store spools it).
   */
  private async storeWorktreeFile(
    path: string,
  ): Promise<{ id: ObjectId; mode: number } | undefined> {
    const entry = await this.worktree.getEntry(path).catch(() => undefined);
    if (!entry || entry.isDirectory) return undefined;
    // a symbolic link is stored as its target, never as the file it names
    const stored = await storeWorktreeFile(this.blobs, this.worktree, path, entry);
    return { id: stored.id, mode: entry.mode };
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
}

/**
 * Factory function to create a GitResolutionStore
 *
 * @param files FilesApi implementation
 * @param staging Staging interface for conflict detection
 * @param blobs Blobs interface for content storage
 * @param gitDir Path to .git directory
 * @param worktreePath Path to working tree (defaults to parent of gitDir)
 * @param rerere git's rerere over the same index and worktree; without it nothing is recorded
 */
export function createResolutionStore(
  files: FilesApi,
  staging: Staging,
  blobs: Blobs,
  gitDir: string,
  worktreePath?: string,
  rerere?: RerereEngine,
): ResolutionStore {
  return new GitResolutionStore(files, staging, blobs, gitDir, worktreePath, undefined, rerere);
}
