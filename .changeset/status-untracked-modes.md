---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
---

**`git status` untracked and ignored modes, with the untracked cache in normal mode.**

- **Behaviour change:** `StatusCommand` now lists untracked files in git's default `normal` mode: an untracked directory shows as `dir/` (porcelain `?? dir/`) and one holding nothing untracked is not shown. Callers that need every untracked file ask for `setUntrackedFiles("all")` (the old default); `setUntracked(true)` keeps meaning `all` and is deprecated.
- `setUntrackedFiles("no" | "normal" | "all")` and `status.showUntrackedFiles`, read as git 2.5x reads them (`true`/`yes`/`on`/`1` or a variable without a value are `normal`; `false`/`off`/`0`/an empty value are `no`); a value git cannot read fails with git's `Invalid untracked files mode` message (`InvalidConfigError`). `parseUntrackedFilesMode` and `parseIgnoredMode` are exported.
- `setIgnored("no" | "traditional" | "matching")` (a boolean still works: `true` is `traditional`): ignored paths as git's `DIR_SHOW_IGNORED_TOO` (an ignored directory as `!! dir/`) and `DIR_SHOW_IGNORED_TOO_MODE_MATCHING` find them, in every untracked mode; `matching` with `-uno` fails with git's "Unsupported combination of ignored and untracked-files arguments" (`IncompatibleOptionsError`).
- `scanUntracked` (vcs-working-tree) is a port of dir.c's `read_directory` with `treat_directory`'s flags (`DIR_SHOW_OTHER_DIRECTORIES`, `DIR_HIDE_EMPTY_DIRECTORIES`, `DIR_SHOW_IGNORED_TOO`, `DIR_SHOW_IGNORED_TOO_MODE_MATCHING`), its `check_only` walks and a literal pathspec (`treat_leading_path`, `simplify_away`), and returns the ignored paths too. The pathspec given to `StatusCommand.addPath` now prunes the untracked scan as git's does.
- The index's untracked cache (`UNTR`) is used and written in normal mode (dir flags 6) as git does, `check_only` directories included; a cache of another mode is replaced unless it is the configured mode's (`new_untracked_cache_flags`). The bytes equal native git's on 2.43 and 2.5x.
- `walkUntrackedScanHost` runs the scan on a worktree without a scan host of its own (in memory).
- `git rm` of a submodule and the submodule state status reads (`S..U`) now run the inner status in its own configured untracked mode, as git's `git status` child does.
