# @statewalker/vcs-workspace

A small orchestrator that combines plain file sync with Git history. It runs four workflows over a local working tree: `publish` (mirror files to file remotes, commit, upload large objects, push), `update` (copy files from file remotes), `restore` (check out the commit recorded in a checkpoint) and `checkpoint` (record the current state). Each workflow is an async generator of step events and ends with a serializable `WorkspaceCheckpoint`.

## Why this layer exists

An application often keeps the same folder both mirrored as files (to a backup, a device, a server) and versioned as Git history. The two engines, `@statewalker/webrun-files-sync` for files and the `@statewalker/vcs-*` packages for history, do not know about each other. Something has to run them in order and record which commit matches which synced file state. This package does that and nothing else: it holds a declarative policy (`SyncVersioningPolicy`) and the correspondence record (`WorkspaceCheckpoint`), not engine logic.

It calls the file engine directly. It reaches history only through two small structural interfaces, `Repository` and `GitRemote`, that the caller implements. The root entry never imports `vcs-core`, `vcs-working-tree` or `vcs-transport`; a test (`tests/ban.test.ts`) enforces this. Network sync, which needs the Git engine, is a separate entry, `@statewalker/vcs-workspace/net` (see [Network sync](#network-sync)), so file-only users never load the engine. So the file engine and the Git engine stay independent, and a sync-only workspace (no repository) works the same way.

## How to use it

```bash
pnpm add @statewalker/vcs-workspace
```

No peer dependencies. Two entry points: `@statewalker/vcs-workspace` for the workflows below, and `@statewalker/vcs-workspace/net` for [network sync](#network-sync). The root entry:

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

## Network sync

```typescript
import { createMemoryHistoryWithOperations } from "@statewalker/vcs-core";
import { httpRemote, openGitWorkspace, syncWorkspace } from "@statewalker/vcs-workspace/net";

const history = createMemoryHistoryWithOperations(); // or a repository on files, in a database
await history.initialize();
const ws = await openGitWorkspace({
  folder, // any FilesApi: the folder kept in step
  history,
  identity: { name: "Ann", email: "ann@example.com" },
});

const result = await syncWorkspace(ws, httpRemote({ url: "https://example.com/notes.git" }));
// { head, committed, integration: "up-to-date" | "fast-forward" | "merge", pushed, conflicts, attempts }
if (result.conflicts.length > 0) console.warn("both sides kept in", result.conflicts);
```

One call does what `git add -A && git commit && git pull && git push` does for a folder: it commits the folder's changes on `main`, fetches the remote's `main` into `refs/remotes/origin/main`, brings it in, and pushes the result. It never forces. If someone else pushed between our fetch and our push, the push is refused as git refuses it, and the round runs again: fetch, merge, push. After `maxAttempts` rounds (default 5) it gives up with a `SyncError`.

The server side is the transport's own server. `createSyncServer` serves one repository over smart HTTP and over duplex streams, and tells subscribers which refs each push moved. receive-pack's post-receive hook does this once the push's report is written, so a workspace can pull as soon as another one pushes:

```typescript
import { createSyncServer, syncWorkspace } from "@statewalker/vcs-workspace/net";

const server = createSyncServer({ repository, refStore }); // a bare repository (vcs-transport facade)
Bun.serve({ fetch: server.fetch });
server.subscribe((updates) => {
  // [{ ref: "refs/heads/main", oldOid, newOid }]: tell the other clients (WebSocket, push message...)
  broadcast(updates);
});

// on another client, when the message arrives:
await syncWorkspace(otherWs, httpRemote({ url }));
```

The same sync runs over a duplex stream (a MessagePort, a WebSocket, a WebRTC channel) and over an httpeers mesh:

```typescript
import { createMessagePortDuplex } from "@statewalker/vcs-transport";
import { meshGitHandler, meshRemoteFetch, servePeerConnection } from "@statewalker/vcs-transport-httpeers";
import { duplexRemote, httpRemote } from "@statewalker/vcs-workspace/net";

// duplex: one connection per fetch and per push
const overChannel = duplexRemote({
  connect: (service) => {
    const channel = new MessageChannel();
    void server.serve(createMessagePortDuplex(channel.port2), service);
    return createMessagePortDuplex(channel.port1);
  },
});

// mesh: the hub serves the repository behind httpeers access, with the sync server's hooks
const handler = meshGitHandler({ repository, refStore, access, receivePack: { hooks: server.hooks } });
const call = servePeerConnection(handler, { remotePeer }); // the peer connection
const overMesh = httpRemote({ url: "http://hub.mesh/notes.git", fetchImpl: meshRemoteFetch({ call, token }) });
```

### How remote changes come in

- **Fast-forward** when the local branch is behind: the folder is brought to the remote commit, writing only the files that differ.
- **Merge** when both sides committed: a merge commit with both parents, against the best common ancestors. These are found as git's `merge-base` finds them: a newest-first walk that stops at the merge base, so it reads only the commits since then. When there are several (a criss-cross history), they are first merged into a virtual base, recursively, as git's recursive strategy does.
- Paths only one side changed are taken from that side.
- Text files both sides changed are merged line by line with `mergeLines` of `@statewalker/vcs-utils`. That merge works on bytes: it splits on LF and keeps every terminator, so CRLF files, a missing final newline and non-UTF-8 text come out unchanged. A file with a NUL byte in its first 8000 bytes is binary, as git decides it.
- `mergeLines` aligns lines with a histogram diff, while `git merge-file` uses its own xdiff. They agree on almost every input. In a fuzz run against `git merge-file` (1500 random three-way merges), the merged output was identical whenever both were clean, but 3 inputs that git reports as conflicts merged cleanly here. In those, one side deleted a line the other side kept next to its own change.
- **Conflicts are kept and reported, never resolved silently.** The merge commit holds both sides:
  - text files get git's markers, labelled with the branch and the commit: `<<<<<<< main (1a2b3c4)` … `=======` … `>>>>>>> origin/main (5d6e7f8)`, in the file's own line ending;
  - a binary file keeps ours, with theirs next to it as `<path>.theirs-<id>` (`-2`, `-3`… when that name is taken);
  - a change against a deletion keeps the change;
  - a file against a directory moves the file aside as `<path>.ours-<id>` or `<path>.theirs-<id>`, after the side it came from.

  The paths are in `result.conflicts`, in the `integrate` event and in the merge commit's message. The merge is committed and pushed, so every workspace sees the same marked file, and fixing it is an ordinary edit that the next sync carries.

### What the folder cannot hold stays in history

- **Ignored paths** (`ignore`, default `.git/`) are never committed and never written by a checkout. They stay in history as they are: an ignored file another workspace committed stays in the tree, and deleting it locally records nothing. There is one exception, as in git: when a tracked directory becomes a file, ignored files inside that directory are removed to make room. A directory holding anything else, such as new files of the user's or a nested repository, is kept as it is. The target's file then goes beside it as `<path>.theirs-<id>`, and the path is reported as a conflict.
- **Unsafe paths** are refused. Every path of a fetched tree is checked against git's `verify_path` rules before anything is written, including the NTFS and HFS+ spellings of `.git` (`is_ntfs_dotgit`, `is_hfs_dotgit`). A path is refused when it has:
  - a component `.git` or `git~1` in any letter case, also with trailing dots or spaces, with an alternate data stream (`.git::$INDEX_ALLOCATION`) or with the code points HFS+ ignores (U+200C–200F, U+202A–202E, U+206A–206F, U+FEFF);
  - a `..`, `.` or empty component;
  - an absolute path, a backslash or a NUL;
  - the reserved temporary-file prefix (below).

  A remote commit with such a path fails the sync with a `SyncError`, and nothing is written. A folder's own `.git` directory is never committed, whatever `ignore` says.
- **Modes and submodules.** Submodule entries are never checked out and stay in every commit. When a submodule becomes a plain directory upstream, its files are checked out like any others. When a submodule becomes a file upstream, the submodule's checkout is kept (its `.git` and any unpushed work), and the file goes beside it as `<path>.theirs-<id>`, reported. A directory holding a `.git` entry is a nested repository: its files are never committed. An executable file stays executable in history when its content changes. On disk, an existing file is rewritten in place, so it keeps its permissions (the Node FilesApi keeps the mode). A new file gets the filesystem's default mode, because a FilesApi cannot set modes. A symbolic link is written as a file holding its target and keeps its mode in history. A FilesApi does not say whether a folder path is a symbolic link. A link the user made in the folder is therefore followed when its file is rewritten in place, as the Node FilesApi's own writes follow it. The sync itself never creates links.
- **Case.** On a case-insensitive folder (probed with a temporary file when the workspace opens, or set with `caseInsensitive`), names are compared case-folded and NFC-normalised:
  - a directory spelled two ways (`Docs/`, `docs/`) is renamed to its first spelling;
  - two files that would be one are kept apart by moving one aside as `<path>.case-<id>`.

  Both changes go in a commit on top and are reported as conflicts.
- **Reserved names.** Files whose names start with `.vcs-sync-tmp-` are reserved for the checkout's temporary files, and they are never committed. Temporary files a crash left behind are removed at the next commit or sync once they are older than ten minutes. Only names of the exact form a checkout writes (`.vcs-sync-tmp-<time>-<counter>-<random>`) are removed; any other file with the prefix is left alone.

### Why a failure leaves nothing half-done

The branch always names the commit the folder holds. Before a checkout, the target commit is recorded (`refs/workspace/pending/main`). Then the folder is checked out, the branch moves (by compare-and-swap), and the record goes.

A checkout cut short, by a full disk for example, is finished at the start of the next commit or sync. The first attempt to finish makes a plan and stores it under its own ref (`refs/workspace/plan/main`), as a commit on top of the target. Only the workspace writes that ref, so a fetched commit cannot pass for a plan. The plan says:

- a file still at the old content gets the new one;
- a file already written stays;
- a file edited meanwhile keeps the edit, merged with the new content: markers for text, the new version beside it for binary content.

Each retry then follows the stored plan, so a merged file is never merged again, and a failing retry changes nothing it already did. A file changed again after the plan was stored is kept the same way: merged or moved aside, the plan updated first, the path reported. Nothing the finish refuses is dropped. A path it cannot bring to the plan stops it with the branch unmoved, and the branch moves to the target only when every path is done. A half-written folder is never committed as local edits.

An edit made while a sync runs is not overwritten, with one small window left. Before the checkout, the sync checks that the folder still matches the branch; if not, it starts the round again and commits the edit first. Then, just before each file is replaced or removed, its content is hashed again. The new content is staged in a temporary file first. After that check, it is moved in place (a new file) or copied over the old file in place (an existing one, to keep its permissions). An edit found at the check stops the checkout, and the next round finishes it as above. What remains is the moment between the last check of a file and its replacement: a save that lands exactly then is replaced.

The folder snapshot does not read a file again when its size and modification time are unchanged. A time within `racyWindowMs` (default 3 s) of when the file was last read is not trusted, because a later write in the same clock tick would look the same. Such a file is hashed again, as git does for "racily clean" index entries. Raise the window for a filesystem with coarser times. Files a checkout writes are always read again. Two cases are beyond the window: a same-size replacement whose modification time is set back (`rsync -t`, `cp -p`, a restore from backup), and a clock skewed by more than the window between the folder's filesystem and this machine. For such folders, set `rehashAll: true`, which reads every file on every snapshot.

Failures reject with a `SyncError`: a fetch or push that fails, a checkout that cannot write, a refused path. On the wire, objects arrive before refs move on both sides. A link cut mid-fetch leaves no tracking ref. A push cut mid-pack leaves the server's branch where it was (receive-pack quarantines the pack). The next sync over a working link completes.

Only a lost race is retried: a push refused as a non-fast-forward or fetch-first, or a ref that moved under receive-pack's compare-and-swap (`cannot lock ref`, `failed to lock`, `failed to update ref`). Any other refusal, such as a declined hook, fails at once. A folder that keeps changing through every round fails with "the folder kept changing during the sync".

### What it does not do

- The served repository is bare. A workspace syncs with a server, or a hub reached through a mesh. It does not serve its own folder to peers that push into it.
- There is no folder watcher. Call `syncWorkspace` on a timer, on a push notification, or when the user saves.
- Merges are not deterministic across workspaces. Only one workspace makes a given merge, because it pushes the merge and the others fast-forward to it.

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
- `@statewalker/vcs-core`, `@statewalker/vcs-transport`, `@statewalker/vcs-utils`, `@statewalker/vcs-working-tree`: the `./net` entry only (objects and refs; the fetch and push clients and the server; the line merge; streamed blob hashing of folder files). The root entry imports none of them, and `tests/ban.test.ts` checks that it does not reach into `net/` in any import form.

## License

MIT
