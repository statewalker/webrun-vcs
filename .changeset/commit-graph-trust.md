---
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
"@statewalker/vcs-transport-adapters": patch
"@statewalker/vcs-transport": patch
---

**Commit-graph walks give a full walk's answers on graphs whose generations cannot be trusted.**

- **vcs-core:** `CommitGraph.generationsTrusted` checks the whole graph once, on first use: generations cut and order walks only when the graph has generation numbers (`generationNumbersEnabled`), every record decodes, none is 0 and each is above its parents'. Otherwise every generation is Infinity (git reads a stored 0 as GENERATION_NUMBER_INFINITY), so `isAncestor`, `findMergeBase` and merge-ort's merge bases are right on graphs with zero levels (git before 2.18), a corrupt record, or corrected dates git 2.43 truncated past 2^32. `getHeader(id, { checkExists: true })` also looks the commit up in the object store (git's GIT_COMMIT_GRAPH_PARANOIA). A graph that fails to load is not loaded again until `invalidate()`. `listObjects` reads its wants, so a missing one throws even when a stale graph lists it. A split write gives the layers it merged away a new mtime, as git's `mark_commit_graphs`, and expires them with one clock read (the default expire time is that same now), so they are always expired as in git. `isAncestor` and `findMergeBase` read one graph for the whole walk: a graph written and loaded while they run is not mixed in (commits outside the walk's graph are read from the object store). `Commits.headerReader()` gives a header reader bound to the graph loaded now. `createGitFilesHistory` takes and exposes the `commitGraph` provider.
- **vcs-store-files:** `gc` reports a failed commit-graph write in `commitGraphError` and keeps what it did before, as `git gc`. The backend, `gc` and `writeCommitGraph` take an `environment`: the commit-graph settings are then read from the system and global config too. `createGitFilesHistoryFromFiles` passes the backend's commit-graph on (`History.commitGraph`); `FileWorktree` takes an `environment` for the submodules `openGitlink` opens. The backend reloads the graph after its ref store changes the `shallow` file or a replace ref.
- **vcs-commands:** the merge-base queue is ordered by generation only when the graph trusts them, and one merge-base computation reads one graph (`commitsBaseSource` takes a `headerReader` once). `InitCommand.setEnvironment` passes the host's environment to the repository it opens, so a global `core.commitGraph` is honoured.
- **vcs-transport-adapters:** `getCommitInfo(oid, { checkExists: true })` does not report a commit that only a stale commit-graph lists; without it (upload-pack's walks) the graph is read unchecked, as git does by default.
- **vcs-transport:** `RepositoryFacade.getCommitInfo` takes `{ checkExists }`; receive-pack asks for it for the type of a new tip and in its connectivity check.
