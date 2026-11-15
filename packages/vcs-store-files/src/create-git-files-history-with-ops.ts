/**
 * Full-featured file-backed History factory with delta compression.
 *
 * Extends createGitFilesBackend to return HistoryWithOperations (delta view of the packs,
 * serialization, capabilities).
 */

import type { HistoryWithOperations } from "@statewalker/vcs-core";
import { createGitFilesHistory } from "@statewalker/vcs-core";
import { createGitFilesBackend, type GitFilesBackendOptions } from "./create-git-files-backend.js";

/**
 * Options for creating file-backed History with full operations support.
 */
export type GitFilesHistoryOptions = GitFilesBackendOptions;

/**
 * Create file-backed History with full operations support.
 *
 * Returns HistoryWithOperations backed by the filesystem, providing:
 * - Standard Git loose object storage (compressed)
 * - File-based refs
 * - A read-only delta view of the installed packs (deltas are written by `repack()`)
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
 * // Which packed objects are deltas
 * const chain = await history.delta.getDeltaChain(blobId);
 * ```
 */
export async function createGitFilesHistoryFromFiles(
  options: GitFilesHistoryOptions,
): Promise<HistoryWithOperations> {
  // Create the base backend (packs, loose objects, refs)
  const { history, objects, packs } = await createGitFilesBackend(options);

  // Use core's createGitFilesHistory to wire up HistoryWithOperations
  return createGitFilesHistory({
    blobs: history.blobs,
    trees: history.trees,
    commits: history.commits,
    tags: history.tags,
    refs: history.refs,
    objects,
    packs,
  });
}
