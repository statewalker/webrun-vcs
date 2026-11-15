---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

**Stash apply as git (index, content merge, conflicts); ignore rules read fresh as git; no leftover walk cache.**

- **vcs-commands (breaking defaults):** `stash apply` no longer restores the index by default (git's default; `setRestoreIndex(true)` is `--index`). The stash's change is merged into the tree written from the current index, so staged content and newly staged files survive; both-sides changes to a file are merged line by line (`mergeLines`), a real conflict is written with git's markers (`Updated upstream` / `Stashed changes`) and staged at stages 1-3 (status CONFLICTS). Without `--index` the index keeps its entries plus the files the stash adds (git stages them); with it, the stash's index change is merged into the index, refused on a conflict with git's "error: conflicts in index. Try without --index.". An index with unmerged entries is refused. Stashed untracked files are restored first and refused, nothing written, when a file stands on a leading component (git's "fatal: cannot create directory at '…': File exists" / "error: could not restore untracked files from stash"). Outcomes compared with native `git stash apply`.
- **vcs-commands:** restore plans refuse a reserved name only where the worktree's storage reserves it (new `capabilities.reservedNames`, at the storage's root), not on plain worktrees.
- **vcs-working-tree:** `IgnoreManager.setIgnoreFile(dir, content | undefined)` and `setExcludeFile(source, content | undefined)` replace a source's rules (`addIgnoreFile` now replaces too); a path inside an ignored directory is ignored and cannot be re-included (git: `build/` then `!build/keep.txt`). `WorktreeCapabilities.reservedNames`.
- **vcs-store-files:** `FileWorktree` rereads `.gitignore`, `info/exclude` and `core.excludesFile` for every walk and ignore check (a changed or removed file is always seen); a walk keeps its lstat-caching view to itself (an abandoned iterator leaves nothing behind).
- **vcs-utils:** `createSymlinkFilesApi` creates no table on a base without links and rewrites it only when it changed; a stale entry is dropped before `createExclusive`/`write` so a new empty file never reads as a link; `PosixFilesApi.reservedNames` (the table's name at the wrapper's root; passed on by mounts, not by subtrees).
- **vcs-utils-node:** new `openRepositoryFiles(rootDir, { gitDir })`: the FilesApi to open a repository with, following a `.git` / `.git/objects` linked elsewhere (as git) while every other link stays unfollowed; a FilesApi opened by `openLinkTarget` follows no links itself; `PosixNodeFilesApi.rootDirectory`.
