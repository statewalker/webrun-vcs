---
"@statewalker/vcs-workspace": minor
---

**`@statewalker/vcs-workspace/net`: conflicts found while recovering stop like a merge conflict.**

Behaviour change: with `onConflict: "stop"` (the default), two recovery steps no longer commit and push the conflicts they find. One is finishing a checkout that was cut short, when it meets a folder edit. The other is bringing back paths that were left out, when they were changed both in the folder and on the branch. Pass `onConflict: "commit"` (on `openGitWorkspace`, `syncWorkspace` or `commitWorkspaceChanges`) to keep the former behaviour.

- The result is written into the folder as before (markers, the other side beside binary files), but nothing of it is committed or pushed. A merge is in progress under `refs/workspace/merge/<branch>`: the sync returns `integration: "conflicted"`, later syncs do nothing more, commits are refused, and `concludeMerge` or `abortMerge` ends it. The marker check covers frozen left-out paths, and `force` skips it.
- New: `MergeInProgress.kind` (`"merge" | "recovery" | "rejoin"`, type `MergeKind`), and `CommitOptions.onConflict`.
- Recovery: the folder's edits become a commit of their own on the commit the checkout started from (`merge.head`; the branch moves there). The checkout's target is `merge.theirs`, and concluding merges the two. Aborting gives every path its version from the edits' commit: your version of each conflicted path, and the start's version elsewhere, so the checkout is undone. An edit made to a file the checkout had already written is in that commit too, so it is kept. The target is not taken, and the next sync merges the remote's commits again.
- Rejoin: the branch stays (`merge.head`). The folder's copies of the conflicted paths become a commit on it (`merge.theirs`), and concluding merges the two. Aborting gives the folder's copies back and keeps the paths in the skip record, so the next commit brings them back again.
- Crash safety:
  - The recovery stop is recorded (`writing`) before the first folder write after a conflict, and takes over from the pending checkout. It is finished from the stored plan by the next commit, sync, conclude or abort, then stopped. The branch move to the edits' commit is finished if it was cut short.
  - A rejoin step stopped on is marked written, so a crash before the stop is recorded never merges the path twice.
  - A conclude cut short after the branch moved also clears the rejoin's records.
