/**
 * `@statewalker/vcs-workspace/net`: a workspace synced with a remote repository over git's own
 * wire protocol. Unlike the root entry, which reaches history only through structural
 * interfaces, this entry is built on the git engine (`@statewalker/vcs-core` objects and refs,
 * `@statewalker/vcs-transport` fetch/push clients and server), so the file-only workflows never
 * load it.
 */

export * from "./flat-tree.js";
export * from "./folder-tree.js";
export * from "./git-workspace.js";
export * from "./merge-trees.js";
export * from "./path-rules.js";
export * from "./sync-remote.js";
export * from "./sync-server.js";
export * from "./sync-workspace.js";
