# @statewalker/vcs-workspace

Thin cross-axis orchestrator (publish / update / checkpoint / restore) composing file-sync, git working-tree, and transport.

## Overview

`vcs-workspace` is the **only** layer that composes Axis A (`@statewalker/webrun-files-sync`) with Axis B (`@statewalker/vcs-working-tree` + `@statewalker/vcs-core` + `@statewalker/vcs-transport`). It offers composite workflows — `publish`, `update`, `checkpoint`, `restore` — and holds only cross-axis **policy** (`SyncVersioningPolicy`) and **correspondence** state (`WorkspaceCheckpoint`), never any engine internals. Each workflow is a sequence of independent, idempotent engine calls: a partial run is a valid recorded state, and a re-run resumes from the last good step.

It keeps the **hard `files-sync ✗↔ vcs-core` ban** intact by depending on the file axis directly but on the history axis only through minimal *structural* `Repository` / `GitRemote` interfaces — it never imports the git engine, so it can never link the two engines together.

## Installation

```bash
pnpm add @statewalker/vcs-workspace
```

## Quick Start

```typescript
import { publish } from "@statewalker/vcs-workspace";
import type { SyncVersioningPolicy, Workspace, WorkspaceRemotes } from "@statewalker/vcs-workspace";

const policy: SyncVersioningPolicy = { commitAfterSync: true, pushAfterCommit: true };

const ws: Workspace = {
  workingTree,              // Axis A endpoint (a FilesApi)
  repository,               // Axis B adapter over vcs-working-tree + vcs-core (structural Repository)
  largeObjects: localStore, // optional local ContentStore
};
const remotes: WorkspaceRemotes = {
  fileRemotes: new Map([["origin", fileRemote]]),      // Axis A mirrors
  historyRemotes: new Map([["origin", gitRemote]]),    // Axis B GitRemote adapters
};

// Sync files → commit → upload large objects → push → record the checkpoint.
for await (const event of publish(ws, remotes, policy, {
  hashContent: sha256,
  largeObjects: [objId],
})) {
  if (event.type === "checkpoint") {
    // checkpoint.fileRemotes.origin === checkpoint.workingTreeManifest
    // checkpoint.historyRemotes.origin === the pushed commit id
    save(event.checkpoint);
  }
}
```

## API

- **`publish(ws, remotes, policy, opts): AsyncIterable<WorkspaceEvent>`** — sync working→file-remotes, then (per policy) commit, upload large objects, push, and emit a checkpoint.
- **`update(ws, remotes, policy, opts): AsyncIterable<WorkspaceEvent>`** — the inbound counterpart.
- **`restore(ws, checkpoint): AsyncIterable<WorkspaceEvent>`** — reset the working tree to a recorded checkpoint's commit.
- **`checkpoint(ws, remotes, opts): Promise<WorkspaceCheckpoint>`** — capture the current cross-axis correspondence record.
- **`buildSyncOptions(...)` / `manifestOf(files, hashContent)`** — helpers for the file-sync options and working-tree manifest id.

Structural interfaces the caller adapts to: **`Repository`** (`manifest` / `head` / `hasChanges` / `commit` / `checkout`) and **`GitRemote`** (`push`, optional `objects: ContentStore`). Types: `Workspace`, `WorkspaceRemotes`, `SyncVersioningPolicy`, `WorkspaceCheckpoint`, `WorkspaceEvent`, `WorkflowOptions`.

## Notes

- **Enforces the axis ban.** `files-sync` and `vcs-core` never import each other; this layer touches the file axis directly and the history axis only through the structural `Repository` / `GitRemote` interfaces — a real adapter over `vcs-working-tree` + `vcs-core` implements them.
- **Best-effort sequential + resumable.** Steps are idempotent; the serializable `WorkspaceCheckpoint` records what succeeded, and `opts.resume` skips already-completed steps. There is no distributed transaction across git + file remotes.
- **Declarative policy.** `SyncVersioningPolicy` is a serializable config (`commitAfterSync`, `commitOnlyWhenChanged`, `pushAfterCommit`, `verify`, …) that workflows read — no imperative hooks that could smuggle cross-axis logic in. `tagSyncPoints` is a deferred flag.
- **Neutral correspondence.** The checkpoint answers "which commit corresponds to the exact synced file state" from the record alone, without either axis depending on the other.
- Built red/green TDD (including an explicit axis-independence / ban test).
