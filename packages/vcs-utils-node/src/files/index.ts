/**
 * The Node.js FilesApi: `NodeFilesApi` from `@statewalker/webrun-files-node`, with the
 * optional POSIX operations (`chmod`, `symlink`, `lstat`, `readlink`) a worktree needs to
 * hold executables and symbolic links. Library code reads and writes files only through
 * FilesApi; this module just picks the Node implementation for apps and tests that run on
 * Node.
 */

import type { PosixFilesApi } from "@statewalker/vcs-utils/files";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { PosixNodeFilesApi } from "./posix-node-files-api.js";

/**
 * Create a Node.js filesystem-backed FilesApi instance.
 *
 * It is a `PosixFilesApi`: a worktree over it writes executables and symbolic links as git
 * does, and never follows a symbolic link out of the root.
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
export function createNodeFilesApi(options: { rootDir: string }): PosixFilesApi {
  return new PosixNodeFilesApi(options);
}

export { NodeFilesApi, PosixNodeFilesApi };
