/**
 * Public contract for the thin cross-axis orchestrator.
 *
 * `@statewalker/vcs-workspace` is the ONLY layer that composes Axis A
 * (`@statewalker/files-sync`) with Axis B (`@statewalker/vcs-working-tree` +
 * `@statewalker/vcs-core` + `@statewalker/vcs-transport`). It keeps the HARD BAN
 * intact — files-sync must never import vcs-core and vice-versa — by depending
 * on the file axis directly (real `plan`/`execute` calls) and on the history
 * axis ONLY through the minimal STRUCTURAL interfaces below ({@link Repository},
 * {@link GitRemote}). It never imports the git engine, so it can never link the
 * two axes together.
 *
 * The orchestrator holds POLICY + CHECKPOINT state, never engine internals. Each
 * workflow is a sequence of INDEPENDENT engine calls; every step is idempotent,
 * and a partial run is a valid recorded state — a re-run resumes from the last
 * good step (best-effort sequential + resumable, no distributed transaction).
 */

import type { ContentStore } from "@statewalker/content-store";
import type { FilesApi, PathFilter, VerificationMode } from "@statewalker/files-sync";

export type { ContentStore, FilesApi, PathFilter, VerificationMode };

/** A stream of bytes. */
export type ByteStream = AsyncIterable<Uint8Array>;

/**
 * The working-tree / commit surface the orchestrator needs from the history
 * axis, as a MINIMAL structural interface (workspace never imports the git
 * engine — a real adapter over `@statewalker/vcs-working-tree` +
 * `@statewalker/vcs-core` implements this).
 *
 * Real-engine mapping:
 * - `manifest()`  → the working-tree tree id (vcs-working-tree status → tree oid).
 * - `head()`      → current commit id (`VcsCore.refs.read("refs/heads/…")`).
 * - `hasChanges()`→ vcs-working-tree status is dirty?
 * - `commit()`    → stage + `VcsCore.writeCommit`; `changed` from status.
 * - `checkout()`  → vcs-working-tree checkout of the commit.
 */
export interface Repository {
  /** Working-tree manifest id — identity of the exact tracked file state. */
  manifest(): Promise<string>;
  /** Current commit id (HEAD), or `undefined` for an empty history. */
  head(): Promise<string | undefined>;
  /** Whether the working tree has uncommitted changes (for `commitOnlyWhenChanged`). */
  hasChanges(): Promise<boolean>;
  /** Create a commit; `changed` is `false` when there was nothing to commit. */
  commit(opts: { message?: string }): Promise<{ commit: string; changed: boolean }>;
  /** Reset the working tree to the given commit (for {@link restore}). */
  checkout(commit: string): Promise<void>;
}

/**
 * The push surface the orchestrator needs from the transport axis, as a MINIMAL
 * structural interface. A real adapter wraps `@statewalker/vcs-transport`'s
 * `push()` (`HttpPushResult` → the pushed commit id). `objects` is the OPTIONAL
 * remote large-object store (an LFS/xet side channel); the WorkspaceRemotes
 * model carries no separate content-store remote, so large objects travel with
 * their history remote.
 */
export interface GitRemote {
  /** Push the given refspecs; resolves the commit id now on the remote ref. */
  push(refspecs: string[]): Promise<{ commit: string }>;
  /** Remote large-object store, when this remote accepts large objects. */
  objects?: ContentStore;
}

/** The local resources a workflow reads/writes. */
export interface Workspace {
  /** Tracked file tree (Axis A endpoint). */
  workingTree: FilesApi;
  /** History adapter (Axis B); absent for a sync-only workspace. */
  repository?: Repository;
  /** Local large-object store; absent when there are no large objects. */
  largeObjects?: ContentStore;
}

/** The remotes a workflow syncs / pushes to. */
export interface WorkspaceRemotes {
  /** File-axis mirrors, by name (Axis A). */
  fileRemotes: Map<string, FilesApi>;
  /** History-axis remotes, by name (Axis B). */
  historyRemotes: Map<string, GitRemote>;
}

/**
 * Declarative, serializable versioning policy a workflow READS — no imperative
 * hooks. Every flag is honored independently.
 */
export interface SyncVersioningPolicy {
  /** Commit BEFORE syncing files (reserved; `update`-side symmetry). */
  commitBeforeSync?: boolean;
  /** Commit AFTER the file sync succeeds (`publish`). */
  commitAfterSync?: boolean;
  /** Skip the commit when the working tree has no changes. */
  commitOnlyWhenChanged?: boolean;
  /** Push after a commit is created. */
  pushAfterCommit?: boolean;
  /** Tag each sync point (DEFERRED — flag only; no git-notes/tag yet). */
  tagSyncPoints?: boolean;
  /** File-sync destination verification mode. */
  verify?: VerificationMode;
}

/**
 * Neutral correspondence record tying a working-tree manifest to an optional
 * commit and per-remote synced manifest / pushed commit ids. It answers "which
 * commit corresponds to the exact synced file state" from the record ALONE —
 * without either axis depending on the other, and without reading git to infer
 * sync state. Serializable by construction; the caller owns persistence.
 */
export interface WorkspaceCheckpoint {
  id: string;
  /** File-state identity of the working tree at this checkpoint. */
  workingTreeManifest: string;
  /** The commit that corresponds to `workingTreeManifest`, if one was made. */
  commit?: string;
  /** remote name → synced manifest id. */
  fileRemotes: Record<string, string>;
  /** remote name → pushed commit id. */
  historyRemotes: Record<string, string>;
  /** Caller-supplied timestamp. */
  createdAt: string;
}

/** Step events emitted by the workflows, in execution order. */
export type WorkspaceEvent =
  | { type: "scan"; remote: string; op: string; actions: number }
  | { type: "transfer"; remote: string; index: number; path: string }
  | { type: "commit"; commit: string; changed: boolean }
  | { type: "upload"; remote: string; object: string }
  | { type: "push"; remote: string; commit: string }
  | { type: "checkpoint"; checkpoint: WorkspaceCheckpoint }
  | { type: "skipped"; step: string; reason: string }
  | { type: "failed"; step: string; reason: string };

/** Shared options for the workflows. */
export interface WorkflowOptions {
  /** REQUIRED — algorithm-agnostic identity used for manifests + file sync. */
  hashContent: (input: ByteStream) => Promise<string>;
  /** Prior checkpoint to resume from; already-completed steps are skipped. */
  resume?: WorkspaceCheckpoint;
  /** Large-object ids to ensure present on the history remotes' object stores. */
  largeObjects?: string[];
  /** Commit message passed through to {@link Repository.commit}. */
  message?: string;
  /** Refspecs passed through to {@link GitRemote.push}. */
  refspecs?: string[];
  /** Path filter for the file sync. */
  filter?: PathFilter;
  /** Explicit checkpoint id; defaults to the working-tree manifest. */
  id?: string;
  /** Explicit checkpoint timestamp; defaults to `new Date().toISOString()`. */
  now?: string;
}
