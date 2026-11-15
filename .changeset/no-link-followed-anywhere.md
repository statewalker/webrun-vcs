---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-workspace": minor
---

**Breaking: no operation follows a symbolic link; git's Windows path rules on Windows worktrees; the core CheckoutCommand is gone.**

- **vcs-core:** `isValidWorktreePath(path, mode?, { windows? })` / `assertValidWorktreePath`: with `windows: true` (a worktree on Windows) git's Windows rules apply too, as its `verify_path` built for Windows: `\` refused (CVE-2019-1354, `d\post-checkout` would land inside `d`), and `is_valid_win32_path` (drive prefix, control characters and `<>:"|?*`, components ending in a space or a dot, reserved device names `CON`, `NUL`, `COM1`, `LPT1`, `CONIN$`...). Without it `a\b.txt` is an ordinary file name, as git on Linux and macOS; `.git` behind a backslash (`.git\x`) is still refused everywhere (git's `is_ntfs_dotgit`). New `WorktreePathOptions`. New `isGitWorktreeFile(component, "gitmodules" | "gitattributes" | "gitignore" | "mailmap")` (git's `is_hfs_dot*` / `is_ntfs_dot*`, with the NTFS fallback short names `gi7eba~N`, `gi7d29~N`, `gi250a~N`, `maba30~N`); a symlinked `.gitmodules` is refused under all of them.
- **vcs-utils:** new `BeyondSymlinkError` / `isBeyondSymlinkError`; `PosixFilesApi.lstat` throws it for a path beneath a link (never "absent"). New optional `PosixFilesApi.pathSeparators` (`"/\\"` on Windows).
- **vcs-utils-node:** `PosixNodeFilesApi` (from `createNodeFilesApi`) never follows a link in any operation: read, write, createExclusive, mkdir, list (recursive too), stats, exists, remove, move, copy, chmod, symlink, lstat, readlink all refuse a path beneath a link (`BeyondSymlinkError`; `exists` answers false). A link at the path is a link: listed and stat'ed with its own size, read as nothing, never listed into, replaced by a write (new file written beside it and renamed over the link itself; a regular file it replaces passes on its permission bits, so a new file gets a new inode), unlinked by remove, copied and moved as a link. Directories are created without following a linked component. On Windows (`platform` option, default `process.platform`) a `\` in a path is refused and `pathSeparators` is `"/\\"` (`"/"` elsewhere).
- **vcs-store-files:**
  - `FileWorktree` no longer chmods to fixed bits: an executable gets x where r is set (`mode | ((mode & 0o444) >> 2)`) and a regular file loses x, from the file's own mode, so the umask holds.
  - `readContent` / `computeHash` refuse a path beneath a link; `getEntry` / `exists` report it absent; `remove` of it returns false (git's `has_symlink_or_noent_leading_path`).
  - New `WorktreeWriteOptions.replaceInTheWay` (forced checkout: a file or link where a parent directory must go is unlinked, as git's `create_directories` with force).
  - FIFOs, sockets and devices are skipped by `walk` and are no `getEntry`.
  - New `probeCaseFolding(files, gitDir)` / `FileWorktree.probeCaseFolding()` (git init's `CoNfIg` and NFC/NFD probes; only over a FilesApi with `lstat`).
  - `GitResolutionStore` reads and writes worktree files through a `FileWorktree` (new optional `worktree` constructor argument): a link is staged as a link by `markAllResolved` and replaced, not written through, by `acceptOurs` / `acceptTheirs` / `applyRecordedResolution`.
- **vcs-working-tree:** `Worktree.probeCaseFolding?()`; `WorktreeWriteOptions.replaceInTheWay`; `WorktreeCapabilities.windowsPaths?` (set by `FileWorktree` from its FilesApi's `pathSeparators`: checkout and the restore plans, via `planTreeRestore`'s new `windows` option, then apply git's Windows path rules).
- **vcs-commands:**
  - Removed the unexported core `CheckoutCommand` (`core-commands/checkout.command*.ts`), which wrote and deleted through raw FilesApi calls; nothing used it.
  - The porcelain `CheckoutCommand` writes a branch checkout through the restore plan, worktree first: paths verified and collisions refused before writing, tracked files the target drops removed, links written as links (or files holding the target), executables, an empty directory per submodule; then HEAD and the index.
  - `reset --hard` and `stash apply` restore symbolic links (as links, or as files holding the target where the worktree or `core.symlinks` cannot have them) instead of refusing them; deletions go first; `reset --hard` unlinks a file or link where a directory must go.
  - `writeTreeRestorePlan` takes `{ symlinks, replaceInTheWay, gitlinks }`.
  - `CloneCommand` and `InitCommand` write `core.ignorecase = true` / `core.precomposeunicode = true` when the probe finds the filesystem folds case or Unicode composition (git writes each only then on Linux; on macOS it also writes `precomposeunicode = false`, which we do not).
- **vcs-workspace:** `walkFolder` / `snapshotFolder` never read or descend a symbolic link or a special file (over a FilesApi with `lstat`, e.g. `createNodeFilesApi`): they are listed in the new `FolderWalk.special` and reported as skipped with the new reasons `symbolic-link` / `special-file`.
