/**
 * Files API module
 *
 * Provides a cross-platform filesystem abstraction for VCS operations.
 * All library code should depend on FilesApi interface, not specific implementations.
 */

export * from "./file-mode.js";
export * from "./file-utils.js";
// Core types and interfaces
export * from "./files-api.js";
// Factory functions
export { createInMemoryFilesApi } from "./mem-files-api.js";
// Node.js filesystem: use @statewalker/vcs-utils-node/files
export * from "./path-utils.js";
