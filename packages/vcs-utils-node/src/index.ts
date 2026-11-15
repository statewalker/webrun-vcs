/**
 * Node.js entry points for @statewalker/vcs-utils: the Node FilesApi.
 *
 * Everything else in the VCS packages uses only portable APIs (FilesApi, Web
 * Streams, Web Crypto), so the same code runs in browsers, Node and workers.
 *
 * @example
 * ```ts
 * import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
 * const files = createNodeFilesApi({ rootDir: "/path/to/repo" });
 * ```
 *
 * @packageDocumentation
 */

export * from "./files/index.js";
