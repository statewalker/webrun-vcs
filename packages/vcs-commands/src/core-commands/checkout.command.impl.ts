/**
 * CheckoutCommand - Materializes tree contents to filesystem.
 *
 * Implements the Checkout interface to:
 * - Checkout branches, tags, or commits
 * - Checkout specific paths from index or commits
 * - Detect and report conflicts
 * - Update HEAD and index after checkout
 *
 * Reference: jgit/org.eclipse.jgit/src/org/eclipse/jgit/api/CheckoutCommand.java
 */

import {
  type Blobs,
  type Commits,
  FileMode,
  type FilesApi,
  joinPath,
  type ObjectId,
  type RefStore,
  type TreeEntry,
  type Trees,
} from "@statewalker/vcs-core";
import type { Staging } from "@statewalker/vcs-working-tree";
import type { Checkout, CheckoutOptions, CheckoutResult } from "./checkout.command.js";

/**
 * Flattened tree entry with full path.
 */
interface FlatTreeEntry extends TreeEntry {
  /** Full path from repository root */
  path: string;
}

/**
 * Options for creating a CheckoutCommand.
 */
export interface CheckoutCommandOptions {
  /** FilesApi for filesystem operations */
  files: FilesApi;

  /** Working tree root path */
  workTreeRoot: string;

  /** Blob storage for loading file content */
  blobs: Blobs;

  /** Tree storage for loading tree entries */
  trees: Trees;

  /** Commit storage for resolving commits */
  commits: Commits;

  /** Reference storage for resolving refs and updating HEAD */
  refs: RefStore;

  /** Staging area (index) for updating after checkout */
  staging: Staging;
}

/**
 * CheckoutCommand implementation.
 */
export class CheckoutCommand implements Checkout {
  private readonly files: FilesApi;
  private readonly workTreeRoot: string;
  private readonly blobs: Blobs;
  private readonly trees: Trees;
  private readonly commits: Commits;
  private readonly refs: RefStore;
  private readonly staging: Staging;

  constructor(options: CheckoutCommandOptions) {
    this.files = options.files;
    this.workTreeRoot = options.workTreeRoot;
    this.blobs = options.blobs;
    this.trees = options.trees;
    this.commits = options.commits;
    this.refs = options.refs;
    this.staging = options.staging;
  }

  /**
   * Checkout a branch, tag, or commit.
   */
  async checkout(target: string, options: CheckoutOptions = {}): Promise<CheckoutResult> {
    // Resolve target to commit
    const commitId = await this.resolveTarget(target);
    if (!commitId) {
      throw new Error(`Cannot resolve '${target}' to a commit`);
    }

    // Get target tree
    const treeId = await this.commits.getTree(commitId);
    if (!treeId) {
      throw new Error(`Cannot get tree for commit ${commitId}`);
    }

    // Check for conflicts unless force
    if (!options.force) {
      const conflicts = await this.detectConflicts(treeId);
      if (conflicts.length > 0) {
        return {
          updated: [],
          added: [],
          removed: [],
          conflicts,
        };
      }
    }

    // Perform checkout
    const result = await this.checkoutTree(treeId, options);

    // Update HEAD
    if (await this.isLocalBranch(target)) {
      await this.refs.setSymbolic("HEAD", `refs/heads/${target}`);
      result.newBranch = target;
    } else {
      await this.refs.set("HEAD", commitId);
    }

    // Create new branch if requested
    if (options.createBranch) {
      await this.refs.set(`refs/heads/${options.createBranch}`, commitId);
      await this.refs.setSymbolic("HEAD", `refs/heads/${options.createBranch}`);
      result.newBranch = options.createBranch;
    }

    result.newHead = commitId;
    return result;
  }

  /**
   * Checkout specific paths from index or commit.
   */
  async checkoutPaths(paths: string[], options: CheckoutOptions = {}): Promise<CheckoutResult> {
    const source = options.source ?? "index";

    const result: CheckoutResult = {
      updated: [],
      added: [],
      removed: [],
      conflicts: [],
    };

    for (const path of paths) {
      try {
        if (source === "index") {
          await this.checkoutFromIndex(path);
        } else {
          const treeId =
            source === "head" ? await this.getHeadTreeId() : await this.commits.getTree(source);
          if (treeId) {
            await this.checkoutFromTree(path, treeId);
          }
        }
        result.updated.push(path);
      } catch {
        result.conflicts.push(path);
      }
    }

    return result;
  }

  /**
   * Checkout a path from the index.
   */
  private async checkoutFromIndex(path: string): Promise<void> {
    const entry = await this.staging.getEntry(path);
    if (!entry) {
      throw new Error(`Path not in index: ${path}`);
    }

    await this.writeFileContent(path, entry.objectId, entry.mode);
  }

  /**
   * Checkout a path from a tree.
   */
  private async checkoutFromTree(path: string, treeId: ObjectId): Promise<void> {
    // Find the entry in the tree
    const parts = path.split("/");
    let currentTreeId = treeId;
    let entry: TreeEntry | undefined;

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      entry = await this.trees.getEntry(currentTreeId, name);

      if (!entry) {
        throw new Error(`Path not found in tree: ${path}`);
      }

      if (i < parts.length - 1) {
        // Navigate into subtree
        if (entry.mode !== FileMode.TREE) {
          throw new Error(`Not a directory: ${parts.slice(0, i + 1).join("/")}`);
        }
        currentTreeId = entry.id;
      }
    }

    if (!entry) {
      throw new Error(`Path not found in tree: ${path}`);
    }

    await this.writeFileContent(path, entry.id, entry.mode);
  }

  /**
   * Checkout an entire tree to the working directory.
   */
  private async checkoutTree(treeId: ObjectId, options: CheckoutOptions): Promise<CheckoutResult> {
    const result: CheckoutResult = {
      updated: [],
      added: [],
      removed: [],
      conflicts: [],
    };

    // Build current index map
    const currentIndex = new Map<string, { objectId: ObjectId; mode: number }>();
    for await (const entry of this.staging.entries()) {
      if (entry.stage === 0) {
        // Only stage 0 entries
        currentIndex.set(entry.path, { objectId: entry.objectId, mode: entry.mode });
      }
    }

    // Build target tree map
    const targetTree = await this.flattenTree(treeId, "");

    // Calculate operations
    const toRemove = new Set<string>();
    const toUpdate = new Map<string, FlatTreeEntry>();

    // Find files to remove (in current but not in target)
    for (const path of currentIndex.keys()) {
      if (!targetTree.has(path)) {
        toRemove.add(path);
      }
    }

    // Find files to add/update
    for (const [path, entry] of targetTree) {
      const current = currentIndex.get(path);
      if (!current || current.objectId !== entry.id) {
        toUpdate.set(path, entry);
      }
    }

    // Execute removals
    for (const path of toRemove) {
      try {
        await this.removeFile(path);
        result.removed.push(path);
      } catch {
        result.conflicts.push(path);
      }
    }

    // Execute updates
    let processed = 0;
    const total = toUpdate.size;

    for (const [path, entry] of toUpdate) {
      try {
        await this.writeFileContent(path, entry.id, entry.mode);

        if (currentIndex.has(path)) {
          result.updated.push(path);
        } else {
          result.added.push(path);
        }
      } catch {
        result.conflicts.push(path);
      }

      processed++;
      options.onProgress?.(processed, total, path);
    }

    // Update index from target tree
    await this.rebuildIndex(targetTree);

    return result;
  }

  /**
   * Write file content to working tree.
   */
  private async writeFileContent(path: string, objectId: ObjectId, _mode: number): Promise<void> {
    const absolutePath = joinPath(this.workTreeRoot, path);

    // Ensure parent directory exists
    const lastSlash = path.lastIndexOf("/");
    if (lastSlash > 0) {
      const parentDir = joinPath(this.workTreeRoot, path.substring(0, lastSlash));
      await this.files.mkdir(parentDir);
    }

    // Load and write content
    const content = await this.loadBlobContent(objectId);
    await this.files.write(absolutePath, [content]);

    // Note: FilesApi doesn't support chmod, so executable bit is not set
    // This could be extended with FilesApiAdapter if needed
  }

  /**
   * Load blob content as Uint8Array.
   */
  private async loadBlobContent(objectId: ObjectId): Promise<Uint8Array> {
    const result = await this.blobs.load(objectId);
    if (!result) {
      throw new Error(`Blob ${objectId} not found`);
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }
    return concatBytes(chunks);
  }

  /**
   * Remove file from working tree.
   */
  private async removeFile(path: string): Promise<void> {
    const absolutePath = joinPath(this.workTreeRoot, path);
    await this.files.remove(absolutePath);

    // Try to remove empty parent directories
    await this.cleanEmptyParents(path);
  }

  /**
   * Remove empty parent directories.
   */
  private async cleanEmptyParents(path: string): Promise<void> {
    const parts = path.split("/");
    parts.pop(); // Remove filename

    while (parts.length > 0) {
      const dirPath = joinPath(this.workTreeRoot, parts.join("/"));

      try {
        let isEmpty = true;
        for await (const _ of this.files.list(dirPath)) {
          isEmpty = false;
          break;
        }

        if (isEmpty) {
          await this.files.remove(dirPath);
          parts.pop();
        } else {
          break;
        }
      } catch {
        break;
      }
    }
  }

  /**
   * Flatten a tree into a map of path -> entry.
   */
  private async flattenTree(treeId: ObjectId, prefix: string): Promise<Map<string, FlatTreeEntry>> {
    const map = new Map<string, FlatTreeEntry>();
    const entries = await this.trees.load(treeId);
    if (!entries) {
      return map;
    }

    for await (const entry of entries) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.mode === FileMode.TREE) {
        // Recurse into subtree
        const subtree = await this.flattenTree(entry.id, path);
        for (const [subPath, subEntry] of subtree) {
          map.set(subPath, subEntry);
        }
      } else {
        map.set(path, { ...entry, path });
      }
    }

    return map;
  }

  /**
   * Resolve target to commit ID.
   */
  private async resolveTarget(target: string): Promise<ObjectId | undefined> {
    // Try as branch first
    let ref = await this.refs.resolve(`refs/heads/${target}`);
    if (ref?.objectId) {
      return ref.objectId;
    }

    // Try as tag
    ref = await this.refs.resolve(`refs/tags/${target}`);
    if (ref?.objectId) {
      return ref.objectId;
    }

    // Try as direct ref
    ref = await this.refs.resolve(target);
    if (ref?.objectId) {
      return ref.objectId;
    }

    // Try as commit ID
    if (await this.commits.has(target)) {
      return target;
    }

    return undefined;
  }

  /**
   * Check if name is a local branch.
   */
  private async isLocalBranch(name: string): Promise<boolean> {
    return this.refs.has(`refs/heads/${name}`);
  }

  /**
   * Get HEAD's tree ID.
   */
  private async getHeadTreeId(): Promise<ObjectId | undefined> {
    const headRef = await this.refs.resolve("HEAD");
    if (headRef?.objectId) {
      return this.commits.getTree(headRef.objectId);
    }
    return undefined;
  }

  /**
   * Detect conflicts - files that would be overwritten.
   */
  private async detectConflicts(targetTreeId: ObjectId): Promise<string[]> {
    const conflicts: string[] = [];

    // Get current HEAD tree
    const headTreeId = await this.getHeadTreeId();
    const headTree = headTreeId
      ? await this.flattenTree(headTreeId, "")
      : new Map<string, FlatTreeEntry>();

    // Get current index
    const indexEntries = new Map<string, { objectId: ObjectId; size: number; mtime: number }>();
    for await (const entry of this.staging.entries()) {
      if (entry.stage === 0) {
        indexEntries.set(entry.path, {
          objectId: entry.objectId,
          size: entry.size,
          mtime: entry.mtime,
        });
      }
    }

    // Get target tree
    const targetTree = await this.flattenTree(targetTreeId, "");

    // Check each path that differs between HEAD and target
    for (const [path, targetEntry] of targetTree) {
      const headEntry = headTree.get(path);
      const indexEntry = indexEntries.get(path);

      // If path is same in HEAD and target, no conflict possible
      if (headEntry && headEntry.id === targetEntry.id) {
        continue;
      }

      // If index differs from HEAD, user has staged changes
      if (indexEntry && headEntry && indexEntry.objectId !== headEntry.id) {
        conflicts.push(path);
        continue;
      }

      // Check working tree for modifications
      const fullPath = joinPath(this.workTreeRoot, path);
      try {
        const stats = await this.files.stats(fullPath);
        if (stats && indexEntry) {
          // If size or mtime differs, might be modified
          if (stats.size !== indexEntry.size || (stats.lastModified ?? 0) > indexEntry.mtime) {
            conflicts.push(path);
          }
        }
      } catch {
        // File doesn't exist, no conflict
      }
    }

    // Check for files that would be removed but have local changes
    for (const [path] of headTree) {
      if (!targetTree.has(path)) {
        const indexEntry = indexEntries.get(path);
        const fullPath = joinPath(this.workTreeRoot, path);

        try {
          const stats = await this.files.stats(fullPath);
          if (stats && indexEntry) {
            if (stats.size !== indexEntry.size || (stats.lastModified ?? 0) > indexEntry.mtime) {
              conflicts.push(path);
            }
          }
        } catch {
          // File already deleted, no conflict
        }
      }
    }

    return [...new Set(conflicts)]; // Remove duplicates
  }

  /**
   * Rebuild index from tree.
   */
  private async rebuildIndex(targetTree: Map<string, FlatTreeEntry>): Promise<void> {
    const builder = this.staging.createBuilder();

    for (const [path, entry] of targetTree) {
      // Get file stats from working tree
      const fullPath = joinPath(this.workTreeRoot, path);
      let size = 0;
      let mtime = Date.now();

      try {
        const stats = await this.files.stats(fullPath);
        if (stats) {
          size = stats.size ?? 0;
          mtime = stats.lastModified ?? Date.now();
        }
      } catch {
        // Use defaults
      }

      builder.add({
        path,
        mode: entry.mode,
        objectId: entry.id,
        stage: 0,
        size,
        mtime,
      });
    }

    builder.finish();
    await this.staging.write();
  }
}

/**
 * Concatenate Uint8Arrays.
 */
function concatBytes(arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 0) return new Uint8Array(0);
  if (arrays.length === 1) return arrays[0];

  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }

  return result;
}

/**
 * Create a CheckoutCommand.
 *
 * @param options Command options
 * @returns New CheckoutCommand instance
 */
export function createCheckoutCommand(options: CheckoutCommandOptions): Checkout {
  return new CheckoutCommand(options);
}
