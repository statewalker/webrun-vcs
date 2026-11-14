/**
 * The Node.js FilesApi: `NodeFilesApi` from `@statewalker/webrun-files-node`.
 * Library code reads and writes files only through FilesApi; this module just
 * picks the Node implementation for apps and tests that run on Node.
 */

import type { FilesApi } from "@statewalker/vcs-utils/files";
import { NodeFilesApi } from "@statewalker/webrun-files-node";

/**
 * Create a Node.js filesystem-backed FilesApi instance.
 *
 * @param options.rootDir - Root directory for all operations
 * @returns FilesApi instance
 *
 * @example
 * ```typescript
 * import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
 *
 * const files = createNodeFilesApi({
 *   rootDir: "/path/to/repo",
 * });
 * ```
 */
export function createNodeFilesApi(options: { rootDir: string }): FilesApi {
  return new NodeFilesApi(options);
}

export { NodeFilesApi };
