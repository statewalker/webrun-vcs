/**
 * Files API module
 *
 * Provides a cross-platform filesystem abstraction for VCS operations.
 * All library code should depend on FilesApi interface, not specific implementations.
 */

export * from "./atomic-files.js";
export * from "./beyond-symlink-error.js";
export * from "./file-mode.js";
export * from "./file-utils.js";
// Core types and interfaces
export * from "./files-api.js";
// Factory functions
export { createInMemoryFilesApi } from "./mem-files-api.js";
// Portable composition: a subtree of a FilesApi, FilesApis mounted into another
export * from "./mounted-files-api.js";
// Node.js filesystem: use @statewalker/vcs-utils-node/files
export * from "./path-utils.js";
// Portable simulated symbolic links (and modes, case folding) over any FilesApi
export * from "./symlink-files-api.js";
