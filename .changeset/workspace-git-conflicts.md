---
"@statewalker/vcs-workspace": minor
---

**`@statewalker/vcs-workspace/net`: a merge with conflicts stops as git stops, un-ignored files are held, one folder listing per step.**

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
