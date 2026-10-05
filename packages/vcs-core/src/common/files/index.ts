/**
 * Files API re-exports
 *
 * Re-exports from @statewalker/vcs-utils/files for backwards compatibility.
 * All new code should import directly from @statewalker/vcs-utils/files.
 *
 * Note: Node.js filesystem (createNodeFilesApi) is now in @statewalker/vcs-utils-node/files
 */

// Re-export everything from vcs-utils/files
// Note: isNotFoundError and tryReadFile are not re-exported here
// because they conflict with ./utils/file-utils.ts exports.
export {
  basename,
  createInMemoryFilesApi,
  dirname,
  extname,
  type FileInfo,
  FileMode,
  type FileModeValue,
  type FileStats,
  type FilesApi,
  joinPath,
  type ListOptions,
  normalizePath,
  type ReadOptions,
  readAt,
  readFile,
  readRange,
  readText,
  tryReadText,
} from "@statewalker/vcs-utils/files";
