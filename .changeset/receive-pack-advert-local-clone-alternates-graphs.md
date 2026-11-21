---
"@statewalker/vcs-transport": patch
"@statewalker/vcs-commands": patch
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
---

**receive-pack advertises as git, commands surface alternates errors, local clones copy objects, alternates' commit-graphs are read.**

- receive-pack (over a duplex and smart HTTP's `info/refs?service=git-receive-pack`) advertises only the refs under `refs/` (git's `write_head_info`): no `HEAD`, which upload-pack still advertises; an empty repository, or one whose refs are all hidden, sends `capabilities^{}`. The connectivity check still counts HEAD's history as present (`--all`). New `receivePackRefs`.
- `GitCommand.alternatesErrors()`: the `error: ...` lines git prints on stderr when it reads the repository's alternates (a missing directory, a path that cannot be normalized, nesting too deep), once per command; fsck folds them into `errorOutput`/`findings` and gc into `GcResult.errors`, first.
- `git clone <path>` follows `clone_local`: the source's objects directory is copied through the FilesApi (loose objects, packs, `info/packs`, the commit-graph byte for byte; no hard links: the FilesApi has no link primitive), its `objects/info/alternates` entries carried over as absolute paths, the refs listed through the transport and written without fetching. `setLocal(false)` (`--no-local`) fetches; `setLocal(true)` warns for a URL ("--local is ignored") or a shallow source (clone.c's check of the source's own git directory: a linked worktree of a shallow repository is still copied, as git copies it); `setNoHardlinks` is accepted; `--depth`, `--shallow-since` and `--shallow-exclude` are ignored for local clones with git's warnings. Clones keep the received pack whatever its size (git's `TRANS_OPT_KEEP`; new `keepPack` fetch and `importPack` option). `beforeFetch` may return `completeTips`.
- The commit-graph is the first one found among the repository's objects directory and its alternates' (git's `prepare_commit_graph`), and fsck verifies the graph of every object directory (`commit-graph verify --object-dir` per source). Each layer of a split chain is looked up in every object directory, the repository's own first (git's `load_commit_graph_chain_fd_st`): a chain written over an alternate's layers loads (`readCommitGraph(files, dir, settings, objectDirs)`, `verifyCommitGraph`'s `objectDirs`). `ObjectAlternates.onChange` reports every later `add()`/`refresh()`, and the files backend invalidates its commit-graph on each.
