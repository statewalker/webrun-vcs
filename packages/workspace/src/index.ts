/**
 * @statewalker/vcs-workspace
 *
 * The thin cross-axis orchestration layer of the VCS two-axis architecture — the
 * ONLY package that composes Axis A (`@statewalker/webrun-files-sync`) with Axis B
 * (`@statewalker/vcs-working-tree` + `@statewalker/vcs-core` +
 * `@statewalker/vcs-transport`). It keeps the HARD BAN intact: files-sync and
 * vcs-core never import each other; this layer depends on the file axis directly
 * and on the history axis only through the STRUCTURAL {@link Repository} /
 * {@link GitRemote} interfaces, so it never links the two engines together.
 *
 * It holds POLICY ({@link SyncVersioningPolicy}) + CHECKPOINT state
 * ({@link WorkspaceCheckpoint}) — never engine internals. Every workflow is a
 * sequence of independent, idempotent engine calls; a partial run is a valid
 * recorded state and a re-run resumes from the last good step.
 */

export { checkpoint } from "./checkpoint.js";
export { publish } from "./publish.js";
export { restore } from "./restore.js";
export { buildSyncOptions, manifestOf } from "./sync-options.js";
export type {
  ByteStream,
  ContentStore,
  FilesApi,
  GitRemote,
  PathFilter,
  Repository,
  SyncVersioningPolicy,
  VerificationMode,
  WorkflowOptions,
  Workspace,
  WorkspaceCheckpoint,
  WorkspaceEvent,
  WorkspaceRemotes,
} from "./types.js";
export { update } from "./update.js";
