---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-store-mem": minor
"@statewalker/vcs-store-kv": minor
"@statewalker/vcs-store-sql": minor
"@statewalker/vcs-utils": minor
---

**Status detects renames and reads submodules as git; `clean -X`; racy smudging on every staging store.**

- **vcs-commands (behaviour change):** `git.status()` detects renames as git's default `status.renames=true`: a path removed from the index paired with one added to it is one entry `R  old -> new` (porcelain v2 `2 R. ... R<score> new<TAB>old`), a path deleted from the worktree paired with an intent-to-add file is ` R old -> new`; untracked files are never paired. Scores and pairing follow git's `diffcore_rename` (exact renames, unique basenames at 75%, then the best pairs at 50%, `diff.renameLimit`/`status.renameLimit`, default 1000). `status.renames` (else `diff.renames`) and new `setRenames(boolean)` (`--[no-]renames`) and `setRenameLimit(n)` control it. New `Status.renamed` (new path to old path), `StatusFileEntry.renamedFrom`/`renameScore`/`intentToAdd`, status code `R`. The paths stay in `added`/`removed`/`missing` too.
- **vcs-commands (behaviour change):** a populated submodule's own index and worktree are read (as git's `is_submodule_modified`): tracked changes inside show ` M sub` with v2 `S.M.`, untracked files `S..U`, with a new commit `SCMU`; nested submodules count as git counts them. `diff.ignoreSubmodules`, `submodule.<name>.ignore` (config, then `.gitmodules`) and new `setIgnoreSubmodules("none" | "untracked" | "dirty" | "all")` (`--ignore-submodules`) behave as git; `setUntracked(false)` also stops looking for untracked files inside submodules. New `StatusFileEntry.submoduleModified`/`submoduleUntracked`, exported `submoduleToken()`.
- **vcs-commands:** new `CleanCommand.setIgnoredOnly(true)` is `git clean -X`: only ignored files go (with `-d`, ignored directories and directories holding only ignored content, as git; path filters as git's).
- **vcs-commands:** stash apply's rename detection uses the same git-exact detection (`detectRenames`, git's similarity estimate).
- **vcs-store-files:** an absolute submodule gitdir (`gitdir: /abs/.git/modules/sub`, older git, `--separate-git-dir`) inside the FilesApi's root directory is read (status sees its commit and content; `clean -d` removes a directory whose absolute gitfile names a place without HEAD); outside the root it stays unreadable (shown clean, kept by clean). New `FileWorktree.openGitlink(path)` opens a populated submodule as a working copy through the same FilesApi.
- **vcs-working-tree:** new optional `Worktree.openGitlink(path)`.
- **vcs-utils:** new optional `PosixFilesApi.rootDirectory` (the real directory a local FilesApi is rooted at), which `PosixNodeFilesApi` already exposes.
- **vcs-store-mem, vcs-store-kv, vcs-store-sql:** the staging stores implement `setRacyCheck`: every write (editor, builder, `write()`) smudges racily clean entries that changed (size 0) against the time of the store's previous write, as `GitStaging`/`FileStagingStore` do. The KV and SQL stores keep that time with their entries (`staging:__meta__`; new SQL migration 8, `staging_meta`) and `read()` restores it.
