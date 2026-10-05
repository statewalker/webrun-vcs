/**
 * File-based reference handling
 *
 * File-dependent implementations of Git ref storage,
 * moved from vcs-core for package boundary cleanup.
 */

export * from "./packed-refs-reader.js";
export * from "./packed-refs-writer.js";
export * from "./ref-reader.js";
export * from "./ref-store.files.js";
export * from "./ref-writer.js";
export * from "./reflog-reader.js";
export * from "./reflog-writer.js";
