---
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
"@statewalker/vcs-transport-adapters": patch
---

**Commit-graph walks give a full walk's answers on graphs whose generations cannot be trusted.**

- **vcs-core:** `CommitGraph.generationsTrusted` checks the whole graph once, on first use: generations cut and order walks only when the graph has generation numbers (`generationNumbersEnabled`), every record decodes, none is 0 and each is above its parents'. Otherwise every generation is Infinity (git reads a stored 0 as GENERATION_NUMBER_INFINITY), so `isAncestor`, `findMergeBase` and merge-ort's merge bases are right on graphs with zero levels (git before 2.18), a corrupt record, or corrected dates git 2.43 truncated past 2^32. `getHeader(id, { checkExists: true })` also looks the commit up in the object store (git's GIT_COMMIT_GRAPH_PARANOIA). A graph that fails to load is not loaded again until `invalidate()`. `listObjects` reads its wants, so a missing one throws even when a stale graph lists it. A split write gives the layers it merged away a new mtime, as git's `mark_commit_graphs`.
- **vcs-store-files:** `gc` reports a failed commit-graph write in `commitGraphError` and keeps what it did before, as `git gc`. The backend, `gc` and `writeCommitGraph` take an `environment`: the commit-graph settings are then read from the system and global config too. The backend reloads the graph after its ref store changes the `shallow` file or a replace ref.
- **vcs-commands:** the merge-base queue is ordered by generation only when the graph trusts them.
- **vcs-transport-adapters:** `getCommitInfo` does not report a commit that only a stale commit-graph lists.
