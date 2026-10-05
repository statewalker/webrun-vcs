/**
 * Garbage collection for file-backed Git repositories.
 *
 * Identifies and removes unreachable loose objects, and optionally
 * repacks remaining loose objects into pack files.
 */

import type { FilesApi, History } from "@statewalker/vcs-core";
import { joinPath } from "@statewalker/vcs-core";

import { FileRawStorage } from "./storage/raw/file-raw-storage.js";

/**
 * Options for garbage collection.
 */
export interface GcOptions {
  /** History instance to determine reachable objects */
  history: History;
  /** FilesApi for filesystem operations */
  files: FilesApi;
  /** Path to .git directory (default: ".git") */
  gitDir?: string;
  /** If true, report what would be removed without actually removing (default: false) */
  dryRun?: boolean;
}

/**
 * Result of garbage collection.
 */
export interface GcResult {
  /** Number of unreachable objects removed (or that would be removed in dry-run) */
  removedObjects: number;
  /** Total number of reachable objects found */
  reachableObjects: number;
  /** Total number of loose objects scanned */
  totalLooseObjects: number;
}

/**
 * Run garbage collection on a file-backed repository.
 *
 * Algorithm:
 * 1. Collect all ref tips (branches, tags, HEAD)
 * 2. Walk object graph to find all reachable objects
 * 3. Scan loose objects directory
 * 4. Remove loose objects not in the reachable set
 *
 * @example
 * ```typescript
 * const result = await gc({
 *   history,
 *   files,
 *   gitDir: ".git",
 * });
 * console.log(`Removed ${result.removedObjects} unreachable objects`);
 * ```
 */
export async function gc(options: GcOptions): Promise<GcResult> {
  const { history, files, gitDir = ".git", dryRun = false } = options;

  // Step 1: Collect all ref tips
  const refTips = new Set<string>();
  for await (const ref of history.refs.list()) {
    const resolved = await history.refs.resolve(ref.name);
    if (resolved?.objectId) {
      refTips.add(resolved.objectId);
    }
  }

  // Step 2: Walk object graph to find all reachable objects
  const reachable = new Set<string>();
  for await (const oid of history.collectReachableObjects(refTips, new Set())) {
    reachable.add(oid);
  }

  // Step 3: Scan loose objects
  const objectsDir = joinPath(gitDir, "objects");
  const looseStorage = new FileRawStorage(files, objectsDir);

  let totalLooseObjects = 0;
  let removedObjects = 0;

  for await (const key of looseStorage.keys()) {
    totalLooseObjects++;
    if (!reachable.has(key)) {
      if (!dryRun) {
        await looseStorage.remove(key);
      }
      removedObjects++;
    }
  }

  return {
    removedObjects,
    reachableObjects: reachable.size,
    totalLooseObjects,
  };
}
