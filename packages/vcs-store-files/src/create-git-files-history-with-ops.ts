/**
 * Full-featured file-backed History factory with delta compression.
 *
 * Extends createGitFilesBackend with PackDeltaStore integration to return
 * HistoryWithOperations (delta API, serialization, capabilities).
 */

import type { HistoryWithOperations } from "@statewalker/vcs-core";
import { createGitFilesHistory, joinPath } from "@statewalker/vcs-core";
import { createGitFilesBackend, type GitFilesBackendOptions } from "./create-git-files-backend.js";
import { PackDeltaStore } from "./pack/pack-delta-store.js";

/**
 * Options for creating file-backed History with full operations support.
 */
export interface GitFilesHistoryOptions extends GitFilesBackendOptions {
  /** Enable delta compression via PackDeltaStore (default: true) */
  enableDeltas?: boolean;
}

/**
 * Create file-backed History with full operations support.
 *
 * Returns HistoryWithOperations backed by the filesystem, providing:
 * - Standard Git loose object storage (compressed)
 * - File-based refs
 * - PackDeltaStore for delta compression (pack files)
 * - Serialization API for pack file creation/parsing
 * - Full backend capabilities (native Git format, random access, atomic batch)
 *
 * @example
 * ```typescript
 * import { createInMemoryFilesApi } from "@statewalker/vcs-utils";
 * import { createGitFilesHistoryFromFiles } from "@statewalker/vcs-store-files";
 *
 * const files = createInMemoryFilesApi();
 * const history = await createGitFilesHistoryFromFiles({
 *   files,
 *   create: true,
 * });
 * await history.initialize();
 *
 * // Use standard History API
 * const blobId = await history.blobs.store([new TextEncoder().encode("hello")]);
 *
 * // Use delta API for GC
 * history.delta.startBatch();
 * await history.delta.blobs.deltifyBlob(targetId, baseId, delta);
 * await history.delta.endBatch();
 * ```
 */
export async function createGitFilesHistoryFromFiles(
  options: GitFilesHistoryOptions,
): Promise<HistoryWithOperations> {
  const { enableDeltas = true, ...backendOptions } = options;
  const gitDir = backendOptions.gitDir ?? ".git";

  // Create the base backend (loose objects, refs)
  const { history, objects: _objects } = await createGitFilesBackend(backendOptions);

  // Create PackDeltaStore for delta compression
  const packDir = joinPath(gitDir, "objects", "pack");
  const packDeltaStore = new PackDeltaStore({
    files: backendOptions.files,
    basePath: packDir,
  });

  // Use core's createGitFilesHistory to wire up HistoryWithOperations
  // It needs the typed stores + packDeltaStore
  return createGitFilesHistory({
    blobs: history.blobs,
    trees: history.trees,
    commits: history.commits,
    tags: history.tags,
    refs: history.refs,
    packDeltaStore,
  });
}
