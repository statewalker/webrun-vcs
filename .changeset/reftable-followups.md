---
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
---

Reftable follow-ups. The stack reader no longer fails with `truncated: 0 bytes` when a concurrent compaction (ours or git's) deletes a table between its stat and its read: as git's `reftable_stack_reload_maybe_reuse`, a table that is gone or reads short reloads `tables.list` and retries while the list changed (backing off, giving up after 3 seconds once it tried more than 3 times); a table missing while the list is unchanged still fails with `ReftableFormatError` (webrun-vcs#232). `git fsck` reads a linked worktree's HEAD from that worktree's reftable stack, not its `HEAD` stub, so a detached HEAD there is a root and its commit no longer reported dangling (webrun-vcs#231).
