---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
---

fsmonitor: every command that reads the index asks the monitor as git's `tweak_fsmonitor` does (`GitCommand.readCurrentIndex`), so any index it writes carries the `FSMN` extension and a failed answer drops the valid bits; `reset --hard` and `checkout -f` neither stat nor rewrite an entry the monitor holds unchanged when the target keeps it (unpack-trees' `oneway_merge`; `fsmonitorKeptEntries`, `restoreKeptEntries`); a sparse index keeps `FSMN` with its positions over the collapsed entries, on read and write (`FsmonitorState.markSparseDirectoriesInvalid`).
