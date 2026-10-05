# @statewalker/vcs-workspace

A small orchestrator that combines plain file sync with Git history. It runs four workflows over a local working tree: `publish` (mirror files to file remotes, commit, upload large objects, push), `update` (copy files from file remotes), `restore` (check out the commit recorded in a checkpoint) and `checkpoint` (record the current state). Each workflow is an async generator of step events and ends with a serializable `WorkspaceCheckpoint`.

## Why this layer exists

An application often keeps the same folder both mirrored as files (to a backup, a device, a server) and versioned as Git history. The two engines, `@statewalker/webrun-files-sync` for files and the `@statewalker/vcs-*` packages for history, do not know about each other. Something has to run them in order and record which commit matches which synced file state. This package does that and nothing else: it holds a declarative policy (`SyncVersioningPolicy`) and the correspondence record (`WorkspaceCheckpoint`), not engine logic.

It calls the file engine directly. It reaches history only through two small structural interfaces, `Repository` and `GitRemote`, that the caller implements. The source never imports `vcs-core`, `vcs-working-tree` or `vcs-transport`; a test (`tests/ban.test.ts`) enforces this. So the file engine and the Git engine stay independent, and a sync-only workspace (no repository) works the same way.

## How to use it

```bash
pnpm add @statewalker/vcs-workspace
```

No peer dependencies. One entry point, `@statewalker/vcs-workspace`:

| Export | What it does |
|--------|--------------|
| `publish(ws, remotes, policy, opts)` | Local to remote: sync files, commit, upload large objects, push, emit a checkpoint |
| `update(ws, remotes, policy, opts)` | Remote to local: copy each file remote into the working tree, emit a checkpoint |
| `restore(ws, checkpoint)` | `repository.checkout(checkpoint.commit)`, then echo the checkpoint |
| `checkpoint(ws, remotes, opts)` | Snapshot the current manifests and HEAD without running a workflow |
| `buildSyncOptions(hashContent, policy, opts)` | The `SyncOptions` the workflows pass to the file engine |
| `manifestOf(files, hashContent)` | Content identity of a file tree (hash of the sorted path to content-id map) |

Types: `Workspace`, `WorkspaceRemotes`, `Repository`, `GitRemote`, `SyncVersioningPolicy`, `WorkflowOptions`, `WorkspaceCheckpoint`, `WorkspaceEvent`, and re-exported `FilesApi`, `ContentStore`, `PathFilter`, `VerificationMode`, `ByteStream`.

The interfaces you implement:

```typescript
interface Repository {
  manifest(): Promise<string>;
  head(): Promise<string | undefined>;
  hasChanges(): Promise<boolean>;
  commit(opts: { message?: string }): Promise<{ commit: string; changed: boolean }>;
  checkout(commit: string): Promise<void>;
}

interface GitRemote {
  push(refspecs: string[]): Promise<{ commit: string }>;
  objects?: ContentStore; // remote large-object store, if this remote takes large objects
}
```

The package ships no adapter for these. Write one over `@statewalker/vcs-commands` (`commit()`, `checkout()`, `push()`) or your own history layer.

## Examples

### Publish files and history

```typescript
import { createHash } from "node:crypto";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import {
  type ByteStream,
  type Workspace,
  type WorkspaceCheckpoint,
  type WorkspaceRemotes,
  publish,
} from "@statewalker/vcs-workspace";

async function sha256(input: ByteStream): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of input) h.update(chunk);
  return h.digest("hex");
}

const ws: Workspace = {
  workingTree: new MemFilesApi({ initialFiles: { "/a.txt": "one" } }),
  repository, // your Repository adapter
};
const remotes: WorkspaceRemotes = {
  fileRemotes: new Map([["backup", new MemFilesApi()]]),
  historyRemotes: new Map([["origin", gitRemote]]), // your GitRemote adapter
};

let saved: WorkspaceCheckpoint | undefined;
for await (const event of publish(
  ws,
  remotes,
  { commitAfterSync: true, commitOnlyWhenChanged: true, pushAfterCommit: true },
  { hashContent: sha256, message: "sync" },
)) {
  if (event.type === "failed") console.error(event.step, event.reason);
  if (event.type === "checkpoint") saved = event.checkpoint; // persist it yourself
}
// Events in order: scan, transfer..., commit, push, checkpoint
```

### Resume after a failed push

```typescript
for await (const event of publish(ws, remotes, policy, { hashContent: sha256, resume: saved })) {
  // Remotes already recorded in `saved` emit { type: "skipped", reason: "already synced" | "already pushed" }.
  // A commit recorded in `saved` is reused, not repeated.
}
```

### Pull files, snapshot, restore

```typescript
import { checkpoint, restore, update } from "@statewalker/vcs-workspace";

for await (const event of update(ws, remotes, {}, { hashContent: sha256 })) {
  if (event.type === "transfer") console.log("pulled", event.path);
}

const now = await checkpoint(ws, remotes, { hashContent: sha256 });
for await (const event of restore(ws, now)) {
  // { type: "commit", changed: false } after repository.checkout(), then { type: "checkpoint" }
}
```

## Internals

### What `publish` does, step by step

```
working tree ──sync──> each file remote          (webrun-files-sync plan + execute, op "sync")
      │
      ├─ policy.commitAfterSync ─> repository.commit({ message })
      │      (skipped if policy.commitOnlyWhenChanged and !hasChanges())
      │
      ├─ opts.largeObjects ─> for each history remote with `objects`:
      │      put(ws.largeObjects.read(id)) unless objects.has(id)
      │
      ├─ policy.pushAfterCommit && commit ─> remote.push(opts.refspecs
      │      ?? ["refs/heads/main:refs/heads/main"])
      │
      └─ checkpoint { workingTreeManifest, commit, fileRemotes, historyRemotes }
```

`update` uses the file engine's `copy` operation (remote to local), not `sync`: remote changes land locally and local-only files stay. It creates no commit and fetches no history, because `GitRemote` has only `push`.

### Why the checkpoint is the source of truth

A `WorkspaceCheckpoint` maps a working-tree manifest to the commit made from it, plus each file remote's manifest and each history remote's pushed commit. `restore` and `resume` read only this record. Nothing walks Git history to guess which commit matches the files. The caller owns persistence; the object is plain JSON. Its `id` defaults to the working-tree manifest and `createdAt` to `new Date().toISOString()` (override with `opts.id` / `opts.now`).

### Why the file sync never uses a commit as its baseline

`buildSyncOptions()` passes only `hashContent`, `verify` and `filter` to the file engine. It sets no anchor store and no commit-derived pair key. Change detection compares against the destination's current files, so a history rewrite can never make the file sync skip or delete files.

### What breaks, and how it looks

- Only push errors are caught. A failing push yields `{ type: "failed", step: "push:<name>", reason }`, then a checkpoint with the progress so far, and the workflow stops. Errors from the file sync or `repository.commit()` are thrown from the generator; no checkpoint is emitted.
- Without `pushAfterCommit`, or with no commit made (no repository, `commitAfterSync` off, or skipped as unchanged), nothing is pushed and `historyRemotes` stays empty.
- The default refspec is `refs/heads/main:refs/heads/main`. Pass `opts.refspecs` for any other branch.
- `restore` only calls `repository.checkout()`. It does not re-sync file remotes. With no repository or no recorded commit it yields `{ type: "skipped", step: "checkout", reason: "no repository or commit recorded" }`.
- `policy.commitBeforeSync` and `policy.tagSyncPoints` are accepted but not acted on by any workflow.
- `hashContent` is required. All manifests depend on it, so use the same function for every run or checkpoints will not match.

### Dependencies and why

- `@statewalker/webrun-files-sync`: `plan` / `execute` for file mirroring, `buildAnchor` for manifests.
- `@statewalker/webrun-content-store`: the `ContentStore` type for large objects.
- `package.json` also lists `@statewalker/vcs-core`, `@statewalker/vcs-working-tree`, `@statewalker/vcs-transport` and `@statewalker/webrun-files`, but the source imports none of them.

## License

MIT
