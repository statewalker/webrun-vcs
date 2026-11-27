---
"@statewalker/vcs-commands": patch
---

`git mv` marks the moved entry fsmonitor-valid where git's `rename_index_entry_at` does (`refresh_cache_entry`): a valid source keeps its bit and stat, a stat-clean moved file comes out valid, a content-clean one takes the new stat and is valid only if a regular file, and a tracked destination replaced by `-f` stays dirty (statewalker/webrun-vcs#471).
