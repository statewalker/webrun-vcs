# @statewalker/vcs-workspace

## 0.4.0

### Minor Changes

- 03b17ed: **Breaking defaults: upload-pack v2 serves any object it has, an atomic push applies the refs refused only before its transaction, and `object-info` is off unless asked for; each stricter behaviour stays available as an option.**
  
  - **vcs-transport, upload-pack:** over protocol v2 a `want <oid>` is now served for any object the repository has, as git's v2 upload-pack (its `parse_want` refuses only a missing object, whatever `uploadpack.allow*SHA1InWant` say); before, v2 defaulted to `"REACHABLE_COMMIT"`. v0/v1 keeps git's `"ADVERTISED"`. `requestPolicy: "REACHABLE_COMMIT"` (on `serveOverDuplex`, `createHttpHandler`, `createGitHttpServer`, `createFetchHandler`, `handleUploadPack(V2)`) refuses objects no branch or tag reaches over both versions, with git's `ERR upload-pack: not our ref <oid>`; no git setting does this over v2. The policy values are documented as the new exported type `UploadPackRequestPolicy`, mapped to git's `uploadpack.*` settings.
  - **vcs-transport, upload-pack v2 errors:** an `ERR` packet is written as git's `packet_writer_error` (no newline) and is no longer followed by a flush, as git dies right after it.
  - **vcs-transport, receive-pack:** an atomic push follows git's `execute_commands_atomic`. A command refused before the ref transaction (connectivity `missing necessary objects`, `shallow update not allowed`, `authorize`, as git's hidden refs) keeps its error and the others are applied together; before, they all got `atomic push failure`. A `preReceive` verdict refusing some refs by name (`rejectedRefs`; git's pre-receive refuses only whole pushes) counts as an `update` hook refusal: the others get `atomic push failure`. The first refusal of git's `update()` checks (ref name, checked-out branch, deletes, non-fast-forward, `bad ref`, the `update` hook) stops the checks, so later `update` hooks no longer run, and the others get `atomic push failure`; a stale old value now fails the transaction (`atomic transaction failed` for every ref in it), as git's ref transaction does when it commits. A branch pointing at a non-commit is refused in `update()` after the `update` hook, as git 2.55+'s `ref_transaction_update`, with its wording `invalid new value provided` (atomic or not; was `failed to update ref`). New `strictAtomic` (`ReceivePackServerOptions`, `serveOverDuplex`, `ReceivePackConfig`): an atomic push that refuses any ref refuses them all (`atomic push failure`), the previous behaviour.
  - **vcs-transport, object-info:** the v2 server no longer advertises `object-info` by default and refuses the command (`invalid command 'object-info'`), as git since 2.45 without `transfer.advertiseObjectInfo` (2.43 and 2.44 always advertise it). New `advertiseObjectInfo: true` (`serveOverDuplex`, the HTTP handlers, `ProcessConfiguration`) advertises `object-info=size type`, as git 2.56 (2.45 to 2.55 advertise a bare `object-info`), limited to the attributes the repository facade can answer (`size` needs `getObjectSize`, `type` `getObjectType`; neither: not advertised), and the command now also answers the `type` attribute (`<oid> <size> <type>`). Every requested object is looked up, attributes or not (`<oid> ` for a missing one), as current git. `SERVER_V2_CAPABILITIES` no longer lists `object-info`; new `OBJECT_INFO_CAPABILITY` and `serverV2Capabilities(capabilities, advertiseObjectInfo)`.
  - **vcs-transport-httpeers:** `meshGitHandler` takes `requestPolicy` and defaults it to `"REACHABLE_COMMIT"`, so a `git:read` caller fetches what the refs publish, not every object the repository holds; pass `"ANY"` for git's v2 behaviour.
  - **vcs-workspace:** `createSyncServer` takes `requestPolicy`, passed to its smart-HTTP and duplex servers (default git's: v2 serves any object; `"REACHABLE_COMMIT"` to refuse objects no ref reaches).
- 46f2a01: **Move to `@statewalker/webrun-files` 0.12 and webrun-sync 0.3.** webrun-files, -browser, -mem and -node go from ^0.11.0 to ^0.12.0. webrun-storage, -content-store, -content-transfer and -files-sync go from ^0.2.0 to ^0.3.0, which are their releases on webrun-files 0.12. Both are breaking lines. webrun-files 0.12 resolves `..` segments before any filter, guard or mount sees a path, and throws `Path climbs above the root` for a path above the root. Consumers must move to webrun-files 0.12 too, so a single copy of the core is installed.
  
  - **vcs-store-files:** `GitResolutionStore` without an explicit `worktreePath` now defaults it to `dirname(gitDir)`, not the literal path `<gitDir>/..`. That literal path left the resolution to the store, and with `gitDir` at the root it now throws.
  - **vcs-core:** `decodeTreeEntries` now refuses entry names that git fsck rejects: empty, `.`, `..`, or containing `/`. Such names come only from crafted trees, for example fetched from a remote. Checkout turns entry names into worktree paths, and webrun-files 0.12 resolves `..`, so a tree `sub/` → `..` → `.git/config` would otherwise write into the repository's own `.git`.
- fa05852: **`@statewalker/vcs-workspace/net`: a merge with conflicts stops as git stops, un-ignored files are held, one folder listing per step.**
  
  Behaviour change: by default, `syncWorkspace` no longer commits and pushes a merge with conflict markers. Pass `onConflict: "commit"` (on `openGitWorkspace`, `syncWorkspace` or `integrateCommit`) to keep the former behaviour.
  
  - A merge with conflicts (`onConflict: "stop"`, the default) does what `git merge` does:
    - the merge result is written into the folder: markers for text, the other side beside binary files as `<path>.theirs-<id>`;
    - nothing is committed or pushed, and the branch stays where it was;
    - the merge stays in progress under `refs/workspace/merge/<branch>` (git's `MERGE_HEAD`), never pushed;
    - the sync returns `integration: "conflicted"`, `pushed: false`, `conflicts` and `merge`, with a `conflicted` event.
  - While a merge is in progress, `syncWorkspace` fetches, merges and pushes nothing: it reports the conflicts again (`conflicted` event, `started: false`). `commitWorkspaceChanges` makes no commit and returns `merge`. `integrateCommit` refuses.
  - New: `concludeMerge(ws, { message? })` makes the merge commit with both parents, and the next sync pushes it. It refuses with `UnresolvedConflictsError` (`paths`) while a conflicted text file still has a `<<<<<<<` or `>>>>>>>` marker line, this workspace's stand-in for git's unmerged index entries. Binary conflicts take the folder as it is.
  - New: `abortMerge(ws)` does what `git merge --abort` does: the paths the merge changed get the branch tip's version back, and other edits stay. `readMergeState(ws)`, `hasConflictMarkers(bytes)`, `NoMergeInProgressError`.
  - A merge write cut short is recorded first and finished from the checkout plan by the next commit, sync or conclude, after a restart too. No file gets its markers twice, and a hand resolution made meanwhile is kept.
  - Files back from being ignored are held: when the folder holds content there that history never had (a local-only `.env`, say), it is not committed or written over. It is reported in `skipped` as `unignored-local` until it is named in `commitWorkspaceChanges(ws, { include })` (or `syncWorkspace`'s `include`), or the workspace is opened with `commitUnignored: true` (the former three-way rejoin). `commitWorkspaceChanges` now also takes an options object, and a message string still works.
  - Each step of a sync round lists the folder once. The commit's single `walkFolder` listing gives the snapshot, the nested repositories and the ignored paths, and a checkout's listing gives its check. That is 2 listings for a pulling round instead of 4, and 1 for a pushing one instead of 2. `snapshotFolder` takes a `walk`, and always leaves out the nested repositories its listing shows, besides any it is given: files under a `.git` found during the round are never committed as ordinary files.
  - A rejoin is written ahead: the decision (with its merged result) is recorded before the folder is written. A crash in between never merges the path twice.
  - What was left out when a merge stopped (ignored paths, nested repositories, held files) is frozen in the merge record. `concludeMerge` carries it over from the merge result and `abortMerge` never writes or removes it, even if `ignore` changed or a nested repository was removed during the merge.
  - A conclude cut short after the branch moved never wedges the workspace: the record is dropped once the merge commit is the branch tip. `concludeMerge(ws, { force: true })` skips the marker check.
  - A held file holding the branch's content again is released. Including a held file the branch changed since it was held merges it three ways. Skip records from an earlier version keep their three-way rejoin. An abort of a half-written merge follows its plan. Blobs that records name only in messages stay reachable.
  - `concludeMerge` refuses a conflicted path that was left out of the folder when the merge stopped, if the merge result it would carry over holds markers (`UnresolvedConflictsError.leftOut`), unless `force`. The frozen paths are stored topmost only and matched by set lookups (`pathMatcher`).
- 2d1e1c1: **Network sync of a workspace with a remote repository: `@statewalker/vcs-workspace/net`.**
  
  A new entry point keeps a folder (any `FilesApi`) as commits on one branch and syncs it with a served repository over git's own wire protocol. The root entry is unchanged and still engine-free.
  
  - `openGitWorkspace({ folder, history, branch?, identity?, now?, ignore?, caseInsensitive? })` opens a folder over any vcs-core history; `commitWorkspaceChanges(ws, message?)` commits what changed.
  - `syncWorkspace(ws, remote, { message?, maxAttempts?, signal?, onEvent? })` does four things, never forcing:
    - commits the folder;
    - fetches the remote branch into `refs/remotes/<name>/<branch>`;
    - integrates it: a fast-forward, or a merge commit against the best common ancestor, with git's recursive strategy for several bases;
    - pushes.
  - Text both sides changed is merged byte for byte with `mergeLines`, so CRLF, a missing final newline and non-UTF-8 text are kept.
  - Conflicts are kept in the files and reported in `result.conflicts`, never resolved silently:
    - text gets git's markers, labelled with branch and commit;
    - a binary file keeps ours, with theirs beside it under a unique `<path>.theirs-<id>`;
    - a change against a deletion keeps the change;
    - a file against a directory moves the file aside.
  - Only a lost race is retried: non-fast-forward, fetch first, or a compare-and-swap loss in receive-pack. A declined hook fails at once. Retries stop at `maxAttempts` (default 5).
  - Fetched trees are checked against git's `verify_path` rules before anything is written: a `.git` component in any case, `..`, an absolute path, a backslash or a NUL fails the sync.
  - What a folder cannot hold stays in history: ignored paths, submodule entries, executable modes and symbolic links.
  - On case-insensitive folders, paths differing only in case are moved aside. Case sensitivity is probed when the workspace opens, or set with `caseInsensitive`.
  - Each file is checked again just before a checkout replaces it. New content is staged in a temporary file; an existing file is rewritten in place so it keeps its permissions.
  - A checkout cut short is recorded (`refs/workspace/pending/<branch>`) and finished by the next commit or sync, from a plan stored on the first attempt under `refs/workspace/plan/<branch>`, so retries never merge a merged file twice. Nothing the finish refuses is dropped:
    - an edit made later is merged or moved aside and reported;
    - a path it cannot bring to the plan stops it with the branch unmoved.
  - When a directory becomes a file, ignored files in it are removed. Any other content is kept, such as new files or a submodule's checkout with its `.git`; the target's file goes aside and the path is reported. Nested repositories (a `.git` directory or a `gitdir:` file) are left alone like ignored paths: the branch keeps what it had there. They are reported, with other left-out paths, in `result.skipped` and a `skipped` event. When a path stops being left out (a nested repository removed, `ignore` changed), it comes back by a three-way merge against the version the folder last held (recorded in `refs/workspace/skip/<branch>`). It is reported in `result.rejoined` and a `rejoined` event.
  - `rehashAll` reads every file on every snapshot, for folders whose times can be set back.
  - Folder snapshots skip unchanged files by size and modification time. Racily clean entries (a time within `racyWindowMs`, default 3 s, of the last read) are hashed again.
  - Merge bases are found with git's paint-down-to-common walk.
  - `.git` is refused in its NTFS and HFS+ spellings too. The `.vcs-sync-tmp-` prefix is reserved, and stale temporary files are swept.
  - Failures reject with a `SyncError`. A folder that keeps changing fails with its own message.
  - Remotes:
    - `httpRemote({ url, auth?, fetchImpl? })`: the transport's fetch and push clients over smart HTTP. An httpeers peer connection plugs in as `fetchImpl: meshRemoteFetch(...)`.
    - `duplexRemote({ connect })`: `fetchOverDuplex` / `pushOverDuplex`, one connection per operation.
  - `createSyncServer({ repository, refStore, hooks? })` serves the repository over smart HTTP (`fetch`) and over duplex streams (`serve`).
    - Its `subscribe` listeners are called from receive-pack's detached post-receive hook with the refs each push moved, so other workspaces can pull.
    - `server.hooks` plugs the same notification into `meshGitHandler`.
  - New dependency: `@statewalker/vcs-utils`. `@statewalker/vcs-working-tree` (already listed) is now used for streamed blob hashing.
- 87992fd: **`@statewalker/vcs-workspace/net`: conflicts found while recovering stop like a merge conflict.**
  
  Behaviour change: with `onConflict: "stop"` (the default), two recovery steps no longer commit and push the conflicts they find. One is finishing a checkout that was cut short, when it meets a folder edit. The other is bringing back paths that were left out, when they were changed both in the folder and on the branch. Pass `onConflict: "commit"` (on `openGitWorkspace`, `syncWorkspace` or `commitWorkspaceChanges`) to keep the former behaviour.
  
  - The result is written into the folder as before (markers, the other side beside binary files), but nothing of it is committed or pushed. A merge is in progress under `refs/workspace/merge/<branch>`: the sync returns `integration: "conflicted"`, later syncs do nothing more, commits are refused, and `concludeMerge` or `abortMerge` ends it. The marker check covers frozen left-out paths, and `force` skips it.
  - New: `MergeInProgress.kept`, the conflicts where a directory (a nested repository, a submodule's checkout, files of your own) is kept in place of the other side's file. They are still named in `conflicts`, and marked `(directory kept)` in the merge message. When all conflicts are of that kind, `MergeInProgress.hint` says how to get out (conclude keeping the `.theirs-` copy, move the directory, or `onConflict: "commit"`), since an abort brings the same stop back.
  - New: `MergeInProgress.kind` (`"merge" | "recovery" | "rejoin"`, type `MergeKind`), and `CommitOptions.onConflict`.
  - Recovery: the folder's edits become a commit of their own on the commit the checkout started from (`merge.head`; the branch moves there). The checkout's target is `merge.theirs`, and concluding merges the two. Aborting gives every path its version from the edits' commit: your version of each conflicted path, and the start's version elsewhere, so the checkout is undone. An edit made to a file the checkout had already written is in that commit too, so it is kept. The target is not taken, and the next sync merges the remote's commits again.
  - Rejoin: the branch stays (`merge.head`). The folder's copies of the conflicted paths become a commit on it (`merge.theirs`), and concluding merges the two. Aborting gives the folder's copies back and keeps the paths in the skip record, so the next commit brings them back again.
  - Crash safety:
    - The recovery stop is recorded (`writing`) before the first folder write after a conflict, and takes over from the pending checkout. It is finished from the stored plan by the next commit, sync, conclude or abort, then stopped. The branch move to the edits' commit is finished if it was cut short.
    - A rejoin step stopped on is marked written. It counts only while the folder still holds its result and the path is not left out again, so a decision stale since a crash is never replayed over newer work.
    - A conclude cut short after the branch moved also clears the rejoin's records.
  - A first checkout cut short (nothing committed before it) does not commit the edits as a history of their own. The branch takes the target (`merge.head`), the edits are a commit on it (`merge.theirs`), and concluding commits on the target with one parent. Aborting gives the edits back, as edits on top of the target.
  - Files back from being ignored are held before a cut-short checkout is finished, even where the target adds the same path. They are never written over, never taken for edits, and frozen as left out by a stop, so concluding never commits them.
  - New: `abortMerge(ws, { force })` and `MergeAbortRefusedError`. For every kind of merge, as `git reset --merge` does, an abort is refused when it would discard edits made since the stop to a file that merged cleanly. Edits to conflicted files are still discarded. `force: true` discards both.

### Patch Changes

- Updated dependencies [03b17ed]
- Updated dependencies [3b82e8b]
- Updated dependencies [2d1e1c1]
- Updated dependencies [3b59cf9]
- Updated dependencies [44b3105]
- Updated dependencies [e509d97]
- Updated dependencies [658066d]
- Updated dependencies [bc7c6e2]
- Updated dependencies [c60d922]
- Updated dependencies [07ace72]
- Updated dependencies [f440ae3]
- Updated dependencies [b6a5d9c]
- Updated dependencies [08309ab]
- Updated dependencies [accab85]
- Updated dependencies [ee92812]
- Updated dependencies [8db23c6]
- Updated dependencies [c2c944f]
- Updated dependencies [c9bfe06]
- Updated dependencies [d04f62d]
- Updated dependencies [8c6e99c]
- Updated dependencies [060fcd0]
- Updated dependencies [6a3a31d]
- Updated dependencies [33612d4]
- Updated dependencies [6964023]
- Updated dependencies [6343211]
- Updated dependencies [5684650]
- Updated dependencies [e77be2f]
- Updated dependencies [bb70139]
- Updated dependencies [0a580e3]
- Updated dependencies [3a69a0f]
- Updated dependencies [0335389]
- Updated dependencies [7392d8e]
- Updated dependencies [60dd7da]
- Updated dependencies [081386c]
- Updated dependencies [c767140]
- Updated dependencies [46f2a01]
- Updated dependencies [b124917]
- Updated dependencies [b758bc0]
  - @statewalker/vcs-transport@0.4.0
  - @statewalker/vcs-utils@0.4.0
  - @statewalker/vcs-core@0.4.0
  - @statewalker/vcs-working-tree@0.4.0

## 0.3.2

### Patch Changes

- Release of the changes since the last published version:
  
  - files changed: README.md
- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @statewalker/vcs-core@0.3.3
  - @statewalker/vcs-transport@0.3.2
  - @statewalker/vcs-working-tree@0.3.2

## 0.1.1

### Patch Changes

- Initial public release from the statewalker multi-repo ecosystem.
- Updated dependencies
  - @statewalker/content-store@0.1.1
  - @statewalker/vcs-core@0.1.1
  - @statewalker/files-sync@0.1.1
  - @statewalker/vcs-transport@0.1.1
  - @statewalker/vcs-working-tree@0.1.1
