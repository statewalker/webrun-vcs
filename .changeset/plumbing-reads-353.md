---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-core": minor
---

Listing plumbing with git's byte-identical output (statewalker/statewalker-root#353): `git.catFile()` (`-t`/`-s`/`-e`/`-p`, `<type> <object>`, `--batch`/`--batch-check`/`--batch-command` with formats, `--buffer`, `-z`/`-Z`, `--batch-all-objects`; blobs streamed to the sink chunk by chunk, stdin read as it arrives), `git.lsFiles()` (`-c`/`-d`/`-m`/`-o`/`-i`/`-s`/`-u`/`-k`/`-t`/`-v`, excludes, `--directory`, `--error-unmatch`, `--with-tree`, `--eol`, `--deduplicate`, `--format`, `-z`, prefixes), `git.lsTree()` (`-d`/`-r`/`-t`/`-l`/`-z`, `--name-only`/`--name-status`/`--object-only`, `--full-name`/`--full-tree`, `--abbrev`, `--format`, ls-tree's own path matching) and `git.showRef()` (patterns, `--head`, `--heads`/`--branches`, `--tags`, `-d`, `--hash`, `--abbrev`, `-q`, `--verify`, `--exists`, `--exclude-existing`). They share `PlumbingCommand`: stdout to a byte sink (`setStdout`), git's stderr and exit status (`call()`, `callOutput()`), deaths as `PlumbingError`. `scanUntracked` gains `DIR_SHOW_IGNORED`, `DIR_COLLECT_KILLED_ONLY` and `allEntries`; `RevisionResolver.lastMode` gives the mode of a `<rev>:<path>` entry. `decodeTreeBytes` takes `checkNames: false` for listings of trees holding names fsck refuses.
