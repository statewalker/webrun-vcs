---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

**`git.clean()` as `git clean`; the index refresh is compare-and-set; submodule gitfiles.**

- **vcs-commands (data loss fix):** `clean().setCleanDirectories(true)` no longer removes tracked directories, staged new files, nested repositories or ignored files. As `git clean -fd`: untracked files are removed one at a time; an untracked directory (no tracked or staged path in it) is entered only with `-d` or a path filter and removed once empty, deepest first, never recursively; nested repositories are skipped unless the new `setForceNestedRepositories(true)` (`-ff`); ignored files only with `setIgnore(false)` (`-x`); the index decides what is tracked (not HEAD). `cleaned` lists what `git clean -n` prints ("Would remove", a wholly removed directory as `dir/`), the new `skipped` the "Would skip repository" lines.
- **vcs-working-tree / vcs-store-files (index refresh):** status and stash refresh entries compare-and-set (`applyStatUpdate`): only a stage-0 entry still holding the compared id, mode, size and mtime changes, the rest of it (flags such as assume-unchanged) kept; an add made meanwhile is never undone. An index file is refreshed by the new optional `Staging.refreshStats` (`GitStaging`, `FileStagingStore`): read afresh, written under `index.lock` only while it is the index this instance read or wrote, without writing other in-memory edits, and memory changed only once the write succeeded. `isOutdated()` compares the index's checksum, not its mtime. Index entries keep nanoseconds, uid and gid (`StagingEntry.mtimeNs`/`ctimeNs`/`uid`/`gid`), and refreshed entries record the file's exact stat (`LinkStats`/`WorktreeEntry` gain `mtimeNs`, `ctimeNs`, `dev`, `ino`, `uid`, `gid`; the Node FilesApi reads them with a bigint `lstat`), so native git trusts them.
- **vcs-store-files:** `readGitlinkHead` resolves `gitdir: ../.git/modules/sub` (as `git submodule add` writes it) against the submodule's directory, refusing a path above the FilesApi's root, and reads only regular files (never a FIFO).
- **vcs-utils / vcs-utils-node:** new optional `PosixFilesApi.rmdir` (an empty directory only, never recursive), implemented by the Node, simulated-links and mounted FilesApis; `FileWorktree.removeEmptyDirectory` uses it, and no directory pruning falls back to a recursive removal.
