/**
 * StatusCalculator - Compares working tree, index, and HEAD to detect changes.
 *
 * Performs three-way comparison:
 * 1. HEAD tree (last commit)
 * 2. Index (staging area)
 * 3. Working tree (filesystem)
 *
 * Features:
 * - Detects added, modified, deleted, renamed files
 * - Rename detection with configurable similarity threshold
 * - Conflict detection from staging area
 * - Content-based comparison for accurate modification detection
 *
 * Uses IndexDiffCalculator for core diff computation.
 *
 * Reference: jgit/org.eclipse.jgit/src/org/eclipse/jgit/api/StatusCommand.java
 */

import type { Blobs, Commits, ObjectId, Refs, Trees } from "@statewalker/vcs-core";
import { FileMode, isSymbolicRef } from "@statewalker/vcs-core";
import type { Staging } from "../staging/staging.js";
import type { Worktree } from "../worktree/worktree.js";
import type { IndexDiff } from "./index-diff.js";
import { createIndexDiffCalculator } from "./index-diff-calculator.js";
import {
  FileStatus,
  type FileStatusEntry,
  type FileStatusValue,
  type RepositoryStatus,
  type StatusCalculator,
  type StatusOptions,
} from "./status-calculator.js";

/**
 * Tree entry info for comparison.
 */
interface TreeEntryInfo {
  objectId: ObjectId;
  mode: number;
}

/**
 * Index entry info for comparison.
 */
interface IndexEntryInfo {
  objectId: ObjectId;
  mode: number;
  size: number;
  mtime: number;
}

/**
 * Working tree entry info for comparison.
 */
interface WorktreeEntryInfo {
  size: number;
  mtime: number;
  mode: number;
  isIgnored: boolean;
}

/**
 * Options for creating a StatusCalculator.
 */
export interface StatusCalculatorOptions {
  /** Working tree iterator */
  worktree: Worktree;

  /** Staging area (index) */
  staging: Staging;

  /** Tree storage */
  trees: Trees;

  /** Commit storage */
  commits: Commits;

  /** Reference storage */
  refs: Refs;

  /** Blob storage (optional, needed for content-based comparison) */
  blobs?: Blobs;
}

/**
 * StatusCalculator implementation.
 */
export class StatusCalculatorImpl implements StatusCalculator {
  private readonly worktree: Worktree;
  private readonly staging: Staging;
  private readonly trees: Trees;
  private readonly commits: Commits;
  private readonly refs: Refs;
  private readonly blobs?: Blobs;

  constructor(options: StatusCalculatorOptions) {
    this.worktree = options.worktree;
    this.staging = options.staging;
    this.trees = options.trees;
    this.commits = options.commits;
    this.refs = options.refs;
    this.blobs = options.blobs;
  }

  /**
   * Calculate full repository status.
   */
  async calculateStatus(options: StatusOptions = {}): Promise<RepositoryStatus> {
    const {
      includeIgnored = false,
      includeUntracked = true,
      pathPrefix = "",
      detectRenames = false,
      renameThreshold = 50,
    } = options;

    // Get HEAD tree
    const headRef = await this.refs.resolve("HEAD");
    const headTreeId = headRef?.objectId ? await this.commits.getTree(headRef.objectId) : undefined;

    // Build maps for comparison
    const headEntries = headTreeId
      ? await this.buildTreeMap(headTreeId, "")
      : new Map<string, TreeEntryInfo>();

    const indexEntries = await this.buildIndexMap();
    const worktreeEntries = await this.buildWorktreeMap(includeIgnored, pathPrefix);

    // Collect all paths
    const allPaths = new Set([
      ...headEntries.keys(),
      ...indexEntries.keys(),
      ...worktreeEntries.keys(),
    ]);

    // Calculate status for each path
    const files: FileStatusEntry[] = [];
    let hasStaged = false;
    let hasUnstaged = false;
    let hasUntracked = false;
    let hasConflicts = false;

    for (const path of allPaths) {
      // Filter by path prefix if specified
      if (pathPrefix && !path.startsWith(pathPrefix)) {
        continue;
      }

      const headEntry = headEntries.get(path);
      const indexEntry = indexEntries.get(path);
      const worktreeEntry = worktreeEntries.get(path);

      const status = this.calculateFileStatus(path, headEntry, indexEntry, worktreeEntry);

      // Track summary flags
      if (status.indexStatus !== FileStatus.UNMODIFIED) {
        hasStaged = true;
      }
      if (
        status.workTreeStatus !== FileStatus.UNMODIFIED &&
        status.workTreeStatus !== FileStatus.UNTRACKED &&
        status.workTreeStatus !== FileStatus.IGNORED
      ) {
        hasUnstaged = true;
      }
      if (status.workTreeStatus === FileStatus.UNTRACKED) {
        hasUntracked = true;
      }
      if (status.indexStatus === FileStatus.CONFLICTED) {
        hasConflicts = true;
      }

      // Only include non-unmodified entries
      if (
        status.indexStatus !== FileStatus.UNMODIFIED ||
        status.workTreeStatus !== FileStatus.UNMODIFIED
      ) {
        // Filter ignored/untracked based on options
        if (!includeIgnored && status.workTreeStatus === FileStatus.IGNORED) {
          continue;
        }
        if (!includeUntracked && status.workTreeStatus === FileStatus.UNTRACKED) {
          continue;
        }

        files.push(status);
      }
    }

    // Detect renames if enabled
    if (detectRenames) {
      await this.detectRenames(files, headEntries, indexEntries, renameThreshold);
    }

    // Check for conflicts in staging
    if (await this.staging.hasConflicts()) {
      hasConflicts = true;
      // Add conflict entries
      for (const conflictPath of await this.staging.getConflictedPaths()) {
        const existing = files.find((f) => f.path === conflictPath);
        if (existing) {
          existing.indexStatus = FileStatus.CONFLICTED;
        } else {
          files.push({
            path: conflictPath,
            indexStatus: FileStatus.CONFLICTED,
            workTreeStatus: FileStatus.UNMODIFIED,
          });
        }
      }
    }

    // Sort files by path
    files.sort((a, b) => a.path.localeCompare(b.path));

    // Get branch info
    const branch = await this.getCurrentBranch();

    return {
      branch,
      head: headRef?.objectId,
      files,
      isClean: files.length === 0,
      hasStaged,
      hasUnstaged,
      hasUntracked,
      hasConflicts,
    };
  }

  /**
   * Get status for a specific file.
   */
  async getFileStatus(path: string): Promise<FileStatusEntry | undefined> {
    // Get HEAD tree entry
    const headRef = await this.refs.resolve("HEAD");
    const headTreeId = headRef?.objectId ? await this.commits.getTree(headRef.objectId) : undefined;

    const headEntry = headTreeId ? await this.getTreeEntry(headTreeId, path) : undefined;

    // Get index entry
    const indexEntry = await this.staging.getEntry(path);
    const indexInfo = indexEntry
      ? {
          objectId: indexEntry.objectId,
          mode: indexEntry.mode,
          size: indexEntry.size,
          mtime: indexEntry.mtime,
        }
      : undefined;

    // Get worktree entry
    const worktreeEntry = await this.worktree.getEntry(path);
    const worktreeInfo = worktreeEntry
      ? {
          size: worktreeEntry.size,
          mtime: worktreeEntry.mtime,
          mode: worktreeEntry.mode,
          isIgnored: worktreeEntry.isIgnored,
        }
      : undefined;

    const status = this.calculateFileStatus(path, headEntry, indexInfo, worktreeInfo);

    // Return undefined if completely unmodified
    if (
      status.indexStatus === FileStatus.UNMODIFIED &&
      status.workTreeStatus === FileStatus.UNMODIFIED
    ) {
      return undefined;
    }

    return status;
  }

  /**
   * Check if a file is modified (quick check).
   */
  async isModified(path: string): Promise<boolean> {
    const indexEntry = await this.staging.getEntry(path);
    if (!indexEntry) {
      // Not in index - check if it exists in worktree
      const worktreeEntry = await this.worktree.getEntry(path);
      return worktreeEntry !== undefined;
    }

    const worktreeEntry = await this.worktree.getEntry(path);
    if (!worktreeEntry) {
      // In index but deleted from worktree
      return true;
    }

    // Quick size check
    if (indexEntry.size !== worktreeEntry.size) {
      return true;
    }

    // Check mtime (racily clean detection)
    // If mtime is older than index update, trust size check
    const indexUpdateTime = this.staging.getUpdateTime();
    if (worktreeEntry.mtime < indexUpdateTime - 3000) {
      return false;
    }

    // Potentially modified (racily clean scenario)
    return true;
  }

  /**
   * Calculate status for a single file.
   */
  private calculateFileStatus(
    path: string,
    head: TreeEntryInfo | undefined,
    index: IndexEntryInfo | undefined,
    worktree: WorktreeEntryInfo | undefined,
  ): FileStatusEntry {
    // Index vs HEAD (staged changes)
    let indexStatus: FileStatusValue;
    if (!head && index) {
      indexStatus = FileStatus.ADDED;
    } else if (head && !index) {
      indexStatus = FileStatus.DELETED;
    } else if (head && index && head.objectId !== index.objectId) {
      indexStatus = FileStatus.MODIFIED;
    } else {
      indexStatus = FileStatus.UNMODIFIED;
    }

    // Worktree vs Index (unstaged changes)
    let workTreeStatus: FileStatusValue;
    if (!index && worktree) {
      workTreeStatus = worktree.isIgnored ? FileStatus.IGNORED : FileStatus.UNTRACKED;
    } else if (index && !worktree) {
      workTreeStatus = FileStatus.DELETED;
    } else if (index && worktree) {
      // Check if content changed
      if (this.isWorktreeModified(index, worktree)) {
        workTreeStatus = FileStatus.MODIFIED;
      } else {
        workTreeStatus = FileStatus.UNMODIFIED;
      }
    } else {
      workTreeStatus = FileStatus.UNMODIFIED;
    }

    return {
      path,
      indexStatus,
      workTreeStatus,
    };
  }

  /**
   * Check if worktree file differs from index.
   */
  private isWorktreeModified(index: IndexEntryInfo, worktree: WorktreeEntryInfo): boolean {
    // Quick check: size mismatch
    if (index.size !== worktree.size) {
      return true;
    }

    // Quick check: mode mismatch (executable bit)
    // Normalize modes for comparison (ignore tree vs file distinction)
    const indexIsExecutable = index.mode === FileMode.EXECUTABLE_FILE;
    const worktreeIsExecutable = worktree.mode === FileMode.EXECUTABLE_FILE;
    if (indexIsExecutable !== worktreeIsExecutable) {
      return true;
    }

    // Check mtime (racily clean detection)
    // If mtime is older than index update, trust the size check
    const indexUpdateTime = this.staging.getUpdateTime();
    if (worktree.mtime < indexUpdateTime - 3000) {
      return false;
    }

    // Potentially modified (racily clean scenario)
    // For accurate detection, would need content hash comparison
    // This is handled by isContentModified() for cases where we need certainty
    return true;
  }

  /**
   * Check if worktree file content differs from index using hash comparison.
   *
   * This provides accurate modification detection for "racily clean" files
   * where mtime is too recent to trust. It computes the actual content hash
   * and compares it to the index object ID.
   *
   * @param path File path to check
   * @param indexObjectId Expected object ID from index
   * @returns True if content differs, false if identical
   */
  async isContentModified(path: string, indexObjectId: ObjectId): Promise<boolean> {
    // Compute actual content hash from worktree
    const worktreeHash = await this.worktree.computeHash(path);

    // Compare with index object ID
    return worktreeHash !== indexObjectId;
  }

  /**
   * Build map from tree.
   */
  private async buildTreeMap(
    treeId: ObjectId,
    prefix: string,
  ): Promise<Map<string, TreeEntryInfo>> {
    const map = new Map<string, TreeEntryInfo>();

    const treeEntries = await this.trees.load(treeId);
    if (!treeEntries) return map;

    for await (const entry of treeEntries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.mode === FileMode.TREE) {
        // Recurse into subtree
        const subtreeMap = await this.buildTreeMap(entry.id, path);
        for (const [subPath, subEntry] of subtreeMap) {
          map.set(subPath, subEntry);
        }
      } else {
        map.set(path, {
          objectId: entry.id,
          mode: entry.mode,
        });
      }
    }

    return map;
  }

  /**
   * Build map from index.
   */
  private async buildIndexMap(): Promise<Map<string, IndexEntryInfo>> {
    const map = new Map<string, IndexEntryInfo>();

    for await (const entry of this.staging.entries()) {
      // Only stage 0 entries (non-conflicted)
      if (entry.stage === 0) {
        map.set(entry.path, {
          objectId: entry.objectId,
          mode: entry.mode,
          size: entry.size,
          mtime: entry.mtime,
        });
      }
    }

    return map;
  }

  /**
   * Build map from working tree.
   */
  private async buildWorktreeMap(
    _includeIgnored: boolean,
    pathPrefix: string,
  ): Promise<Map<string, WorktreeEntryInfo>> {
    const map = new Map<string, WorktreeEntryInfo>();

    for await (const entry of this.worktree.walk({
      includeIgnored: true, // Always include to detect ignored status
      pathPrefix,
    })) {
      if (!entry.isDirectory) {
        map.set(entry.path, {
          size: entry.size,
          mtime: entry.mtime,
          mode: entry.mode,
          isIgnored: entry.isIgnored,
        });
      }
    }

    return map;
  }

  /**
   * Get tree entry by path.
   */
  private async getTreeEntry(treeId: ObjectId, path: string): Promise<TreeEntryInfo | undefined> {
    const parts = path.split("/");
    let currentTreeId = treeId;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const entry = await this.trees.getEntry(currentTreeId, name);

      if (!entry) {
        return undefined;
      }

      if (i === parts.length - 1) {
        return {
          objectId: entry.id,
          mode: entry.mode,
        };
      }

      if (entry.mode !== FileMode.TREE) {
        return undefined;
      }

      currentTreeId = entry.id;
    }

    return undefined;
  }

  /**
   * Get current branch name.
   */
  private async getCurrentBranch(): Promise<string | undefined> {
    const head = await this.refs.get("HEAD");
    if (head && isSymbolicRef(head)) {
      const target = head.target;
      if (target.startsWith("refs/heads/")) {
        return target.slice("refs/heads/".length);
      }
    }
    return undefined;
  }

  /**
   * Calculate status using IndexDiff.
   *
   * This is an alternative implementation that uses the IndexDiffCalculator
   * for core diff computation. It provides the same result as calculateStatus
   * but uses a more modular approach.
   *
   * @param options Status options
   * @returns Repository status
   */
  async calculateStatusFromIndexDiff(options: StatusOptions = {}): Promise<RepositoryStatus> {
    const {
      includeIgnored = false,
      includeUntracked = true,
      pathPrefix = "",
      detectRenames = false,
      renameThreshold = 50,
    } = options;

    // Get HEAD tree
    const headRef = await this.refs.resolve("HEAD");
    const headTreeId = headRef?.objectId ? await this.commits.getTree(headRef.objectId) : undefined;

    // Create IndexDiff calculator and compute diff
    const diffCalculator = createIndexDiffCalculator(
      {
        trees: this.trees,
        staging: this.staging,
        worktree: this.worktree,
      },
      headTreeId,
    );

    const indexDiff = await diffCalculator.calculate({
      includeIgnored,
      includeUntracked,
      pathPrefix,
    });

    // Convert IndexDiff to FileStatusEntry array
    const files = this.convertIndexDiffToStatusEntries(indexDiff, includeIgnored, includeUntracked);

    // Build tree maps for rename detection if needed
    if (detectRenames) {
      const headEntries = headTreeId
        ? await this.buildTreeMap(headTreeId, "")
        : new Map<string, TreeEntryInfo>();
      const indexEntries = await this.buildIndexMap();
      await this.detectRenames(files, headEntries, indexEntries, renameThreshold);
    }

    // Sort files by path
    files.sort((a, b) => a.path.localeCompare(b.path));

    // Calculate summary flags
    const hasStaged = files.some((f) => f.indexStatus !== FileStatus.UNMODIFIED);
    const hasUnstaged = files.some(
      (f) =>
        f.workTreeStatus !== FileStatus.UNMODIFIED &&
        f.workTreeStatus !== FileStatus.UNTRACKED &&
        f.workTreeStatus !== FileStatus.IGNORED,
    );
    const hasUntracked = files.some((f) => f.workTreeStatus === FileStatus.UNTRACKED);
    const hasConflicts = indexDiff.conflicting.size > 0;

    // Get branch info
    const branch = await this.getCurrentBranch();

    return {
      branch,
      head: headRef?.objectId,
      files,
      isClean: files.length === 0,
      hasStaged,
      hasUnstaged,
      hasUntracked,
      hasConflicts,
    };
  }

  /**
   * Convert IndexDiff result to FileStatusEntry array.
   */
  private convertIndexDiffToStatusEntries(
    diff: IndexDiff,
    includeIgnored: boolean,
    includeUntracked: boolean,
  ): FileStatusEntry[] {
    const entries: FileStatusEntry[] = [];

    // Added files (in index, not in HEAD)
    for (const path of diff.added) {
      const workTreeStatus = diff.modified.has(path)
        ? FileStatus.MODIFIED
        : diff.missing.has(path)
          ? FileStatus.DELETED
          : FileStatus.UNMODIFIED;
      entries.push({ path, indexStatus: FileStatus.ADDED, workTreeStatus });
    }

    // Changed files (in index with different content from HEAD)
    for (const path of diff.changed) {
      const workTreeStatus = diff.modified.has(path)
        ? FileStatus.MODIFIED
        : diff.missing.has(path)
          ? FileStatus.DELETED
          : FileStatus.UNMODIFIED;
      entries.push({ path, indexStatus: FileStatus.MODIFIED, workTreeStatus });
    }

    // Removed files (in HEAD, not in index)
    for (const path of diff.removed) {
      entries.push({
        path,
        indexStatus: FileStatus.DELETED,
        workTreeStatus: FileStatus.UNMODIFIED,
      });
    }

    // Conflicting files
    for (const path of diff.conflicting) {
      const stageState = diff.conflictingStageStates.get(path);
      entries.push({
        path,
        indexStatus: FileStatus.CONFLICTED,
        workTreeStatus: diff.modified.has(path) ? FileStatus.MODIFIED : FileStatus.UNMODIFIED,
        stageState,
      });
    }

    // Missing files (in index but not on disk) - only if not already added
    for (const path of diff.missing) {
      if (!diff.added.has(path) && !diff.changed.has(path) && !diff.conflicting.has(path)) {
        entries.push({
          path,
          indexStatus: FileStatus.UNMODIFIED,
          workTreeStatus: FileStatus.DELETED,
        });
      }
    }

    // Modified files in worktree (different from index) - only if not already added
    for (const path of diff.modified) {
      if (!diff.added.has(path) && !diff.changed.has(path) && !diff.conflicting.has(path)) {
        entries.push({
          path,
          indexStatus: FileStatus.UNMODIFIED,
          workTreeStatus: FileStatus.MODIFIED,
        });
      }
    }

    // Untracked files
    if (includeUntracked) {
      for (const path of diff.untracked) {
        entries.push({
          path,
          indexStatus: FileStatus.UNMODIFIED,
          workTreeStatus: FileStatus.UNTRACKED,
        });
      }
    }

    // Ignored files
    if (includeIgnored) {
      for (const path of diff.ignoredNotInIndex) {
        entries.push({
          path,
          indexStatus: FileStatus.UNMODIFIED,
          workTreeStatus: FileStatus.IGNORED,
        });
      }
    }

    return entries;
  }

  /**
   * Detect renamed files by comparing content hashes.
   *
   * Finds pairs of DELETED (in HEAD) and ADDED (in index) files with
   * matching content, marking them as RENAMED.
   *
   * @param files File status entries to update
   * @param headEntries HEAD tree entries map
   * @param indexEntries Index entries map
   * @param threshold Similarity threshold (0-100)
   */
  private async detectRenames(
    files: FileStatusEntry[],
    headEntries: Map<string, TreeEntryInfo>,
    indexEntries: Map<string, IndexEntryInfo>,
    threshold: number,
  ): Promise<void> {
    // Collect deleted (from HEAD) and added (to index) files
    const deleted: FileStatusEntry[] = [];
    const added: FileStatusEntry[] = [];

    for (const file of files) {
      if (file.indexStatus === FileStatus.DELETED) {
        deleted.push(file);
      } else if (file.indexStatus === FileStatus.ADDED) {
        added.push(file);
      }
    }

    // No renames possible if either list is empty
    if (deleted.length === 0 || added.length === 0) {
      return;
    }

    // Build maps of object IDs for comparison
    // For deleted files, get object ID from HEAD
    // For added files, get object ID from index
    const deletedIds = new Map<string, ObjectId>();
    for (const file of deleted) {
      const headEntry = headEntries.get(file.path);
      if (headEntry) {
        deletedIds.set(file.path, headEntry.objectId);
      }
    }

    const addedIds = new Map<string, ObjectId>();
    for (const file of added) {
      const indexEntry = indexEntries.get(file.path);
      if (indexEntry) {
        addedIds.set(file.path, indexEntry.objectId);
      }
    }

    // Find exact matches (100% similarity - same object ID)
    const matchedDeleted = new Set<string>();
    const matchedAdded = new Set<string>();

    for (const [deletedPath, deletedId] of deletedIds) {
      for (const [addedPath, addedId] of addedIds) {
        if (matchedAdded.has(addedPath)) continue;

        // Exact content match
        if (deletedId === addedId) {
          // Mark as rename
          const deletedFile = files.find((f) => f.path === deletedPath);
          const addedFile = files.find((f) => f.path === addedPath);

          if (deletedFile && addedFile) {
            // Update the added file to be a rename
            addedFile.indexStatus = FileStatus.RENAMED;
            addedFile.originalPath = deletedPath;
            addedFile.similarity = 100;

            // Remove the deleted file from the list
            matchedDeleted.add(deletedPath);
            matchedAdded.add(addedPath);
            break;
          }
        }
      }
    }

    // Remove matched deleted files from the result
    const indicesToRemove: number[] = [];
    for (let i = files.length - 1; i >= 0; i--) {
      if (matchedDeleted.has(files[i].path)) {
        indicesToRemove.push(i);
      }
    }
    for (const idx of indicesToRemove) {
      files.splice(idx, 1);
    }

    // For similarity-based detection (threshold < 100), we'd need to compute
    // content similarity. This requires reading blob content and comparing.
    // Currently only exact matches are supported.
    // Future enhancement: implement similarity detection using blob content
    if (threshold < 100 && this.blobs) {
      // Similarity detection would go here
      // For now, we only support exact matches (100% similarity)
    }
  }
}

/**
 * Create a StatusCalculator.
 *
 * @param options Calculator options
 * @returns New StatusCalculator instance
 */
export function createStatusCalculator(options: StatusCalculatorOptions): StatusCalculator {
  return new StatusCalculatorImpl(options);
}
