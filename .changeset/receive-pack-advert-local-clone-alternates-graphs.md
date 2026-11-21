---
"@statewalker/vcs-transport": patch
"@statewalker/vcs-commands": patch
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
---

**receive-pack advertises as git, commands surface alternates errors, local clones copy objects, alternates' commit-graphs are read.**

- receive-pack (over a duplex and smart HTTP's `info/refs?service=git-receive-pack`) advertises only the refs under `refs/` (git's `write_head_info`): no `HEAD`, which upload-pack still advertises; an empty repository, or one whose refs are all hidden, sends `capabilities^{}`. The connectivity check still counts HEAD's history as present (`--all`). New `receivePackRefs`.
- `GitCommand.alternatesErrors()`: the `error: ...` lines git prints on stderr when it reads the repository's alternates (a missing directory, a path that cannot be normalized, nesting too deep), once per command.
- `git clone <path>` follows `clone_local`: the source's objects directory is copied through the FilesApi (loose objects, packs, `info/packs`, the commit-graph byte for byte; no hard links: the FilesApi has no link primitive), its `objects/info/alternates` entries carried over as absolute paths, the refs listed through the transport and written without fetching. `setLocal(false)` (`--no-local`) fetches; `setLocal(true)` warns for a URL ("--local is ignored") or a shallow source; `setNoHardlinks` is accepted; `--depth`, `--shallow-since` and `--shallow-exclude` are ignored for local clones with git's warnings. Clones keep the received pack whatever its size (git's `TRANS_OPT_KEEP`; new `keepPack` fetch and `importPack` option). `beforeFetch` may return `completeTips`.
- The commit-graph is the first one found among the repository's objects directory and its alternates' (git's `prepare_commit_graph`), and fsck verifies the graph of every object directory (`commit-graph verify --object-dir` per source).
