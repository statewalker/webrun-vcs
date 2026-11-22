---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-utils-node": patch
---

**`index.version` and `feature.manyFiles`, `core.untrackedCache` in every index writer, case folding in the unpack-trees callers.**

- **Index version:** a new index (no index file when it was read) is written in the version read-cache.c's `get_index_format_default` gives: `$GIT_INDEX_VERSION` (`GitHostEnvironment.indexVersion`), else `index.version`, else 4 under `feature.manyFiles`, else 3 (written as 2 without extended flags); an index read from a file keeps its version, a split index's shared index included. A value outside 2..4 falls back to 3 with git's warning (`IndexHost.warn`, `takeIndexWarnings`); an `index.version` that is not a number refuses the write (`IndexVersionConfigError`, git's `bad numeric config value`). `IndexSettings.version`/`versionWarning`, `indexFormatDefault`.
- **Untracked cache in every index writer:** `core.untrackedCache` (default `true` under `feature.manyFiles`) is applied to every index written through the staging's host, as git's `tweak_untracked_cache` applies it to every index it reads: `true` adds an empty cache (ident and the flags of `status.showUntrackedFiles`, no root) when there is none or it names another worktree, `false` removes it (`IndexSettings.untrackedCache`/`untrackedIdent`/`untrackedFlags`). `add` writes the index when only that changes (git's `SKIP_IF_UNCHANGED`; also for `core.splitIndex`), through the new `Staging.wantsRewrite`. Only `status` fills the cache, as in git. `Worktree.hostPath` is part of the interface.
- **Case folding in the unpack-trees callers:** under `core.ignorecase`, read-tree `-m -u` (one and two trees, `--prefix`, three-way additions), merge (fast-forward and the result's checkout), rebase, cherry-pick, revert, am, stash apply and `reset --merge`/`--keep` ask the source index folding case where git's `verify_absent` does (`icase_exists`, `verify_clean_subdirectory`'s `read_directory`): a case variant of a tracked file in a directory a file replaces goes with the directory, removed after every refusal check (`IndexCaseFolding`, `removeCaseVariants`); nested repositories are still refused.
- **stash apply:** an entry the merge removed that clashes with a file the stash adds (a directory replaced by a file, or the reverse) stays out of the index with git's `error: '<path>' appears as both a file and as a directory`, instead of leaving both in the index.
