---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
---

Host-supplied drivers follow git around their commands: `diff.<driver>.cachetextconv` keeps textconv output in git's notes cache (`refs/notes/textconv/<driver>`, commits and reflog as git writes them) and skips the runner for cached blobs; an empty `filter.<driver>.clean`/`.smudge` turns a host's driver off for that direction (a required one then dies); filter and merge drivers are given the configured command (`FilterDriverContext.command`, `MergeDriverInput.command`); `merge.<driver>.recursive` from the configuration wins over the registered driver's own; a merge driver that fails to run (`MergeDriverResult.error`, or a throw) stops the merge as git's `LL_MERGE_ERROR` (`MergeDriverFailedError`, exit 2) (statewalker/statewalker-root#369).
