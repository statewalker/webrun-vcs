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
// { head, committed, integration: "up-to-date" | "fast-forward" | "merge" | "conflicted",
//   pushed, conflicts, attempts, skipped, rejoined, merge? }
if (result.integration === "conflicted") console.warn("resolve, then concludeMerge:", result.conflicts);
```

One call does what `git add -A && git commit && git pull && git push` does for a folder: it commits the folder's changes on `main`, fetches the remote's `main` into `refs/remotes/origin/main`, brings it in, and pushes the result. It never forces. If someone else pushed between our fetch and our push, the push is refused as git refuses it, and the round runs again: fetch, merge, push. After `maxAttempts` rounds (default 5) it gives up with a `SyncError`.

The server side is the transport's own server. `createSyncServer` serves one repository over smart HTTP and over duplex streams, and tells subscribers which refs each push moved. receive-pack's post-receive hook does this once the push's report is written, so a workspace can pull as soon as another one pushes:

```typescript
import { createSyncServer, syncWorkspace } from "@statewalker/vcs-workspace/net";

// a bare repository (vcs-transport facade); `requestPolicy: "REACHABLE_COMMIT"` refuses
// fetches of objects no branch or tag reaches (git's v2 default serves any object)
const server = createSyncServer({ repository, refStore });
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
- **Conflicts are kept and reported, never resolved silently.** The merge result holds both sides:
  - text files get git's markers, labelled with the branch and the commit: `<<<<<<< main (1a2b3c4)` … `=======` … `>>>>>>> origin/main (5d6e7f8)`, in the file's own line ending;
  - a binary file keeps ours, with theirs next to it as `<path>.theirs-<id>` (`-2`, `-3`… when that name is taken);
  - a change against a deletion keeps the change;
  - a file against a directory moves the file aside as `<path>.ours-<id>` or `<path>.theirs-<id>`, after the side it came from.

  By default the merge then stops, as git stops; see [When a merge conflicts](#when-a-merge-conflicts).

### When a merge conflicts

```typescript
import { abortMerge, concludeMerge, readMergeState, syncWorkspace } from "@statewalker/vcs-workspace/net";

const result = await syncWorkspace(ws, remote);
if (result.integration === "conflicted") {
  // the folder holds the merge result; result.conflicts (and result.merge.conflicts) name the files
  // ...the user edits them, removing the markers...
  await concludeMerge(ws); // the merge commit, both parents
  await syncWorkspace(ws, remote); // pushes it
}
// or, to give up the merge: await abortMerge(ws);
```

A merge with conflicts does what `git merge` does (the default, `onConflict: "stop"`):

- The merge result is written into the folder: markers in text files, the other side beside binary files and beside files that met a directory, as listed above. Paths that merged cleanly get their merged content too.
- Nothing is committed or pushed. The branch stays where it was (local edits made before the sync are committed, as `git commit` before `git pull` would).
- The merge stays in progress under `refs/workspace/merge/main`, git's `MERGE_HEAD`: a ref only the workspace writes, never pushed. Its commit holds the merge result, the other parent and the conflicted paths. `readMergeState(ws)` returns it.
- The sync returns `integration: "conflicted"`, `pushed: false`, the paths in `conflicts`, and `merge`. It emits the `integrate` event and a `conflicted` event (`started: true`).

While the merge is in progress, `syncWorkspace` fetches, merges and pushes nothing. It returns the same `conflicted` result and a `conflicted` event (`started: false`), so a sync on a timer is safe. The exception is a sync that finished writing a merge result whose writing was cut short (below): the merge stopped in that sync, so its event says `started: true`. `commitWorkspaceChanges` makes no commit either, and its result has `merge` (and `mergeStarted` in that same case).

What was left out when the merge stopped stays left out until it ends. The record freezes the ignored paths, nested repositories and held files of that moment. It keeps only the topmost ones (an ignored directory is one entry), and paths are matched against it with one lookup per ancestor directory. If `ignore` changes or a nested repository's `.git` is removed during the merge, `concludeMerge` still carries those paths over from the merge result, and `abortMerge` never writes or removes them. The commit after the merge ends brings them back by the usual rules (below): a stale ignored copy gets the branch's version, and a local file that history never had is held.

Two calls end the merge:

- `concludeMerge(ws, { message?, force? })` makes the merge commit from the folder as it is then, with both parents. The next sync pushes it. The call is refused with an `UnresolvedConflictsError` (its `paths` name the files) while a conflicted text file still holds a marker line: a line starting with `<<<<<<<` or `>>>>>>>` and then a space or the line's end. git refuses while the index has unmerged entries; a folder has no index, so the markers are the equivalent. The `=======` line is not checked, since Markdown underlines headings with it. Binary conflicts are not checked: the folder's version is taken, and a `.theirs-<id>` copy still beside it is committed like any other file, so remove it first if you keep ours. A change against a deletion is not checked either: the changed file is in the folder, and it is committed as it is, so delete it first to accept the deletion. A file against a directory is in the folder as the directory, plus the file moved aside, both committed as they are. A conflicted path that was left out of the folder when the merge stopped (ignored, say) never reached the folder, so its markers are looked for in the merge result. The conclude is refused the same way, and the error's `leftOut` names such paths. Abort the merge, stop leaving the path out, and sync again to resolve it in the folder. `force: true` skips the marker check, for files whose content really has such lines. `hasConflictMarkers(bytes)` is exported for your own checks.
- `abortMerge(ws)` does what `git merge --abort` does. Every path the merge changed gets the branch tip's version back, and files the merge added are removed. Edits made to those paths since the merge started are discarded, as git discards them. Other paths are not touched, so edits made elsewhere during the merge stay, and nothing from before the merge is lost: the merge started from a committed folder. A directory holding files of its own is never removed; such a path is listed in `kept`.

Both refuse with a `NoMergeInProgressError` when no merge is in progress. A conclude cut short after the branch moved but before the record went leaves nothing stuck: the record is dropped as soon as the branch tip is seen to be that merge commit (both parents match), and the next sync pushes it.

The former behaviour is an option: `onConflict: "commit"`, on `openGitWorkspace` or on one `syncWorkspace` (or `integrateCommit`) call. The merge is then committed with the conflicts in the files, the commit's message lists them, and it is pushed. Every workspace sees the same marked file, and fixing it is an ordinary edit that the next sync carries.

### When recovering conflicts

Two steps that recover from an earlier round can also meet your edits, and by default they stop the same way:

- **Finishing a checkout that was cut short** (below) finds a file you edited in the meantime, before the checkout reached it. Your edit is the folder's side and the checkout's target is the other.
- **Bringing back a path that was left out** (a nested repository's `.git` removed, `ignore` changed; see [Coming back](#what-the-folder-cannot-hold-stays-in-history)) finds it changed both in the folder and on the branch. The folder's copy is one side and the branch's version is the other.

```typescript
const result = await syncWorkspace(ws, remote);
if (result.integration === "conflicted" && result.merge?.kind === "recovery") {
  // the folder holds the checkout's target, merged with your edits (markers in c.txt)
  await concludeMerge(ws); // after resolving: the merge of your edits and the target
  await syncWorkspace(ws, remote); // pushes it
}
```

With `onConflict: "stop"` (the default), the result is written into the folder as before: markers for text, the other side beside binary files and directories, a file you removed brought back. Then the step stops like a merge:

- Nothing of the result is committed or pushed. The merge record (`refs/workspace/merge/main`) holds the result, the conflicted paths and what was left out at that moment, and `result.merge.kind` says which step stopped (`"recovery"` or `"rejoin"`; a merge with the remote is `"merge"`).
- The sync returns `integration: "conflicted"`. Later syncs fetch, merge and push nothing and return the same result, `commitWorkspaceChanges` commits nothing, and `integrateCommit` refuses, until `concludeMerge` or `abortMerge`. `concludeMerge` checks the markers as for any merge, including those in frozen left-out paths, and `force` skips the check.

The two sides are recorded as commits, so that concluding makes an ordinary merge commit and aborting loses nothing:

- **Recovery.** Your edits become a commit of their own, on the commit the checkout started from. It holds your version of each conflicted path, and any edit you made to a file after the checkout had written it. This is what the sync would have committed had you saved before it started, as `git commit` before `git pull`. The branch moves to that commit, and it is `merge.head`. The checkout's target is `merge.theirs`. Nothing of the target is committed. `concludeMerge` makes the merge commit of the two.
- **Rejoin.** The branch does not move, and it is `merge.head`. The folder's copies of the conflicted paths become a commit on the branch tip, `merge.theirs`. `concludeMerge` makes the merge commit of the two. The paths' records stay in `refs/workspace/skip/main` until the merge ends.

`abortMerge` gives the folder its own version back, never the incoming one, and keeps the incoming one in history for the next sync:

- **Recovery.** Every path gets the version in your edits' commit. Conflicted paths get your version back, and other paths the checkout wrote go back to where the checkout started, so the checkout is undone. An edit you made to a file the checkout had already written is in that commit, so it stays. The branch stays on your edits' commit, and the target is not taken. The remote's commits are still in `refs/remotes/origin/main`, and the next sync merges them again, as a plain merge with the remote. While both sides still differ there, that merge stops again, as `git pull` after `git merge --abort` would.
- **Rejoin.** Every conflicted path gets the folder's copy back, and copies put beside files are removed. The branch does not move. The paths stay recorded as left out, with the version the folder last held, so the next commit brings them back again and stops again while both sides still differ. To end that loop, resolve and conclude, leave the path out again (put the `.git` back, or ignore it), or sync once with `onConflict: "commit"`. A held file that you named in `include` goes back to being held.

Edits made to the conflicted paths after the stop are discarded by an abort, as with any merge. Other paths are not touched.

The stop is written ahead:

- **Recovery.** The plan is stored as before. The merge record is set, marked as being written, before the first folder write that follows a conflict, and it takes over from `refs/workspace/pending/main`. A write cut short is finished from the same plan by the next commit, sync, conclude or abort, after a restart too, and the files never get their markers twice. Once the record is marked stopped, the branch moves to your edits' commit and the plan goes. A crash between those two is finished by the next call. The decision to stop is kept: a workspace reopened with `onConflict: "commit"` still finishes a recovery stop that was already being written as a stop.
- **Rejoin.** Each path's decision is recorded before it is written, as before, and marked as written once the folder holds it. A crash before the merge record is stored is resumed by the next commit, which stops without merging the path again. A conclude cut short after the branch moved also drops the paths' records, once the merge commit is seen.

`onConflict: "commit"`, on `openGitWorkspace`, on one `syncWorkspace` call or on `commitWorkspaceChanges`, keeps the former behaviour. The result is committed with the conflicts in the files, on top of the target (recovery) or the branch (rejoin), and pushed.

### What the folder cannot hold stays in history

- **Ignored paths** (`ignore`, default `.git/`) are never committed and never written by a checkout. They stay in history as they are: an ignored file another workspace committed stays in the tree, and deleting it locally records nothing. There is one exception, as in git: when a tracked directory becomes a file, ignored files inside that directory are removed to make room. A directory holding anything else, such as new files of the user's or a nested repository, is kept as it is. The target's file then goes beside it as `<path>.theirs-<id>`, and the path is reported as a conflict.
- **Unsafe paths** are refused. Every path of a fetched tree is checked against git's `verify_path` rules before anything is written, including the NTFS and HFS+ spellings of `.git` (`is_ntfs_dotgit`, `is_hfs_dotgit`). A path is refused when it has:
  - a component `.git` or `git~1` in any letter case, also with trailing dots or spaces, with an alternate data stream (`.git::$INDEX_ALLOCATION`) or with the code points HFS+ ignores (U+200C–200F, U+202A–202E, U+206A–206F, U+FEFF);
  - a `..`, `.` or empty component;
  - an absolute path, a backslash or a NUL;
  - the reserved temporary-file prefix (below).

  A remote commit with such a path fails the sync with a `SyncError`, and nothing is written. A folder's own `.git` directory is never committed, whatever `ignore` says.
- **Modes and submodules.** Submodule entries are never checked out and stay in every commit. When a submodule becomes a plain directory upstream, its files are checked out like any others. When a submodule becomes a file upstream, the submodule's checkout is kept (its `.git` and any unpushed work), and the file goes beside it as `<path>.theirs-<id>`, reported. A directory holding a `.git` directory, or a `.git` file starting with `gitdir:` (a git worktree, a submodule), is a nested repository. Its files belong to that repository and are left alone like ignored ones. They are not committed, the branch keeps exactly what it had there (no deletion is recorded), and a checkout does not touch them. A plain file named `.git` does not make a repository: it is only left out, as a name no tree may hold. An executable file stays executable in history when its content changes. On disk, an existing file is rewritten in place, so it keeps its permissions (the Node FilesApi keeps the mode). A new file gets the filesystem's default mode, because a FilesApi cannot set modes. A symbolic link is written as a file holding its target and keeps its mode in history. A FilesApi does not say whether a folder path is a symbolic link. A link the user made in the folder is therefore followed when its file is rewritten in place, as the Node FilesApi's own writes follow it. The sync itself never creates links.
- **Case.** On a case-insensitive folder (probed with a temporary file when the workspace opens, or set with `caseInsensitive`), names are compared case-folded and NFC-normalised:
  - a directory spelled two ways (`Docs/`, `docs/`) is renamed to its first spelling;
  - two files that would be one are kept apart by moving one aside as `<path>.case-<id>`.

  Both changes go in a commit on top and are reported as conflicts. Names are only changed when they collide after folding, and every change is reported. NTFS folds case but not Unicode normalisation, so there two spellings that differ only in NFC/NFD form are merged although the filesystem would keep them apart.
- **Reserved names.** Files whose names start with `.vcs-sync-tmp-` are reserved for the checkout's temporary files, and they are never committed. Temporary files a crash left behind are removed at the next commit or sync once they are older than ten minutes. Only names of the exact form a checkout writes are removed: `.vcs-sync-tmp-` followed by 12, 4 and 8 lowercase hex digits joined with dashes. Any other file with the prefix is left alone.
- **What is left out is reported.** `result.skipped` (and a `skipped` event, and `skipped` from `commitWorkspaceChanges`) lists every folder path the commit did not take, each with a reason:
  - `nested-repository`, by its directory;
  - `reserved-name`: a `.git` file below the root, or the temporary-file prefix;
  - `unsafe-path`;
  - `unignored-local`: a file back from being ignored, held out of commits (below).

  Ignored paths and submodule checkouts are not listed.
- **Coming back.** A path can stop being left out: a nested repository's `.git` is removed, or `ignore` changes. Meanwhile the branch may have moved on there while the folder's copy stayed as it was. So the workspace records, under a ref only it writes (`refs/workspace/skip/main`), the version the folder last held of every left-out path that the branch tracks. A path the remote added meanwhile is recorded as never held.

  When the path comes back, it is merged three ways: that recorded version, the folder's copy and the branch's.
  - Unchanged in the folder: it gets the branch's version (a remote edit arrives, a remote addition is written, a remote deletion is applied).
  - Changed only in the folder: it is kept and committed.
  - Changed on both sides: it is merged with git's markers (text), or kept with the branch's version beside it (binary), and reported. By default this stops like a merge, with nothing committed (see [When recovering conflicts](#when-recovering-conflicts)).

  The paths are listed in `result.rejoined` and a `rejoined` event. A nested repository's removal is therefore never pushed as the deletion of its files.

  Each path's rejoin is decided and recorded before anything is written to the folder. A crash after the file is written but before the record is updated is found at the next commit: the folder already holds the recorded result, so the path is done, never merged a second time.

- **Un-ignored files are held.** A file that was ignored for a reason, such as a `.env` with secrets, is not committed just because `ignore` changed:

  ```typescript
  const ws = await openGitWorkspace({ folder, history }); // `.env` no longer ignored
  const result = await syncWorkspace(ws, remote);
  // result.skipped: [{ path: ".env", reason: "unignored-local" }]; nothing of it committed or pushed
  await commitWorkspaceChanges(ws, { include: [".env"] }); // only now, as the folder holds it
  ```

  When a path comes back from being ignored and the folder holds content that history never had there, the file is held. That covers a local-only file (the branch never had it), a file the remote added while it was ignored (recorded as never held), and a folder copy that differs from what the branch had there. A held file stays as it is in the folder. It is not committed (the branch keeps its own version there, or nothing), nothing is written over it (a remote change there stays in history only), and it is reported as `unignored-local` until you opt in. To opt in, name the file or its directory in `include` of `commitWorkspaceChanges` (or of `syncWorkspace`). It is then committed as the folder holds it when the branch has not changed it since it was held. If the branch has changed it, it is first merged three ways (base: the branch's version when the file was held; ours: the folder's; theirs: the branch's now), so the branch's change is not dropped. A conflict is kept with markers, or with the branch's version beside a binary file, and reported in `conflicts`. Or open the workspace with `commitUnignored: true`, which brings every such file back by the three-way merge above, as before. Removing a held file stops holding it. Where the branch tracks the path, nothing is deleted: the commit that sees the removal keeps the branch's version, and the commit after it writes that version into the folder. Ignoring it again stops holding it too. So does a held file whose content becomes the branch's again: it is released, listed in `rejoined`, and from then on follows the branch like any file.

  The workspace knows a file was ignored because each commit records the topmost ignored paths it saw (in `refs/workspace/skip/main`). A file created and un-ignored with no commit or sync in between was never seen ignored, so it is committed as a new file. Paths that came back from a nested repository are the user's files in that repository: they come back by the three-way merge, as above. So do the paths of a skip record written by an earlier version of this package, which kept no reasons: they rejoin by the three-way merge that version promised, never held.

### Why a failure leaves nothing half-done

The branch always names the commit the folder holds. Before a checkout, the target commit is recorded (`refs/workspace/pending/main`). Then the folder is checked out, the branch moves (by compare-and-swap), and the record goes.

A checkout cut short, by a full disk for example, is finished at the start of the next commit or sync. The first attempt to finish makes a plan and stores it under its own ref (`refs/workspace/plan/main`), as a commit on top of the target. Only the workspace writes that ref, so a fetched commit cannot pass for a plan. The plan says:

- a file still at the old content gets the new one;
- a file already written stays;
- a file edited meanwhile keeps the edit, merged with the new content: markers for text, the new version beside it for binary content. By default the finish then stops like a merge, and nothing of the target is committed (see [When recovering conflicts](#when-recovering-conflicts)).

Each retry then follows the stored plan, so a merged file is never merged again, and a failing retry changes nothing it already did. The plan also records which paths are done. A file the checkout had already written and the user changed afterwards, a hand-resolved conflict for one, is the user's edit: it stays as it is and is committed on top. A file changed before the checkout reached it is kept like an edit found when the plan was made: merged or moved aside, the plan updated first, the path reported. Nothing the finish refuses is dropped. A path it cannot bring to the plan stops it with the branch unmoved, and the branch moves to the target only when every path is done. A half-written folder is never committed as local edits.

An edit made while a sync runs is not overwritten, with one small window left. Before the checkout, the sync checks that the folder still matches the branch; if not, it starts the round again and commits the edit first. Then, just before each file is replaced or removed, its content is hashed again. The new content is staged in a temporary file first. After that check, it is moved in place (a new file) or copied over the old file in place (an existing one, to keep its permissions). An edit found at the check stops the checkout, and the next round finishes it as above. What remains is the moment between the last check of a file and its replacement: a save that lands exactly then is replaced.

A merge with conflicts is written the same way. Its record (`refs/workspace/merge/main`) is set before the first file is written, marked as being written. A write cut short (a full disk, a crash, an edit found at a check) is finished by the next `commitWorkspaceChanges`, `syncWorkspace` or `concludeMerge`, from the same stored plan, so no file gets its markers twice and an edit made meanwhile, a hand resolution for one, is kept. Then the record is marked stopped. After a restart, the merge is still in progress. `abortMerge` works on a half-written merge too. It follows the stored plan as well as the merge result: every path either changed gets the branch tip's version, and copies the plan put beside files (an edit found during the finish) are removed. The blobs the workspace's own records name only in their messages (rejoin results, the bases of held files) stay reachable from the record's commit, through a parent commit whose tree holds them.

Each step of a round lists the folder once. The commit lists it once, and that one listing gives the snapshot, the nested repositories, and the ignored paths that a later un-ignore is checked against. A checkout lists it once more, to check that the folder still matches the branch. A round that pulls therefore lists the folder twice, and a round that only pushes, once. Only a commit that first finishes a cut-short checkout or brings back left-out paths lists the folder again, because those steps wrote to it. That second listing adds the nested repositories it finds to the round's set, never removes any. The same set then drives the snapshot and the tree, so no file under a `.git` that a listing found is ever committed as an ordinary file.

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
