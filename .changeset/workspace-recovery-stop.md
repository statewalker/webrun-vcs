---
"@statewalker/vcs-workspace": minor
---

**`@statewalker/vcs-workspace/net`: conflicts found while recovering stop like a merge conflict.**

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
