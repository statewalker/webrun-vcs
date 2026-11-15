---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

**Stash apply and checkout protect untracked files and local changes as git; no instance-lifetime lstat cache; confined composed FilesApis.**

- **vcs-commands:**
  - `stash apply` touches only the paths the stash changes and refuses before writing anything, with git's merge messages: local changes on such a path ("Your local changes to the following files would be overwritten by merge"), untracked files where it writes ("The following untracked working tree files would be overwritten by merge"), untracked files in a directory a stashed file replaces ("Updating the following directories would lose untracked files in them"). It no longer deletes untracked directories nor overwrites unrelated unstaged edits.
  - Branch checkout: untracked files on a leading component of a written path are refused up front (git's `check_leading_path`); a clean directory switches to a file (git's `verify_clean_subdirectory`; untracked files inside are refused with the directories message); directories a switch empties are removed; a local executable-bit change counts as a local change where `core.filemode` holds; a staged deletion of a file the target deletes too is refused ("would be removed by checkout"); ignored files in the way are overwritten (the worktree's `.gitignore` files are read); a case-only rename switches on a case-folding worktree; the stat shortcut compares ctime too.
  - The restore plan refuses a tree entry named `.webrun-symlinks.json` (any case), the simulated-links table.
- **vcs-utils-node:** `PosixNodeFilesApi` caches nothing across calls (an outside change is always seen); `withLstatCache()` returns a view for one batch whose directory cache is dropped with it, and forgotten on ENOENT/ENOTDIR/ELOOP or when an entry is seen not to be a directory (a write retries once after a cached directory vanished). `openLinkTarget` is opt-in (`openLinkTargets`, also on `createNodeFilesApi`). `chmod` works on a file it cannot read (lstat, then chmod by path).
- **vcs-store-files:** `FileWorktree.batch(fn)` runs operations in one lstat-cache batch (a walk is one batch too); `isIgnored` reads the `.gitignore` files of the path's directories (never a symlinked one).
- **vcs-working-tree:** `Worktree.batch?()`.
- **vcs-utils:** `PosixFilesApi.withLstatCache?()`. `createSymlinkFilesApi`: one table per base shared by all its wrappers, reloaded before and serialized across mutations; a link counts only while its entry and an empty placeholder agree (mutations ordered so an interruption never makes a file read as a link); move and copy forget what the target held; `..` refused; the reserved table name compared case- and NFC-insensitively; new `isReservedFilesName`. `createSubtreeFilesApi` / `createMountedFilesApi`: `..` refused, `openLinkTarget` forwarded only with `forwardOpenLinkTarget`, a mount point (or a directory holding one) cannot be removed, and listings include what is mounted below.
