---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

**The worktree never follows a symbolic link; Node clones keep executables and links; add stages modes as git.**

- **vcs-utils:** new `PosixFilesApi` (a `FilesApi` with optional `chmod`, `symlink(target: Uint8Array, path)`, `lstat` and `readlink`) and `LinkStats` (`kind` `file`/`directory`/`symlink`/`other`, `size`, `lastModified`, `ctime?`, `mode?`); re-exported by vcs-core.
- **vcs-utils-node:** `createNodeFilesApi` returns a `PosixNodeFilesApi` (new, exported): `NodeFilesApi` with `chmod`, `symlink`, `lstat` and `readlink`, contained to the root and never following a link (at the path or in a leading component; `chmod` refuses a link). Its `remove` unlinks a link (a dangling one too) instead of following it, `exists` sees a dangling link, and a non-recursive `list` lists links, dangling ones included, with their own size. Link targets round-trip as bytes.
- **vcs-core:** `isValidWorktreePath(path, mode?)` / `assertValidWorktreePath(path, mode?)`: with mode 120000, a symlinked `.gitmodules` (any case, NTFS `gitmod~1`, trailing dots/spaces, HFS-ignorable code points) is refused, as git's `verify_path`.
- **vcs-store-files:** `WorktreeFilesApi` is now `PosixFilesApi` (its `symlink` takes the target as bytes). `FileWorktree` reports `capabilities.executable` only with `chmod` and `lstat`, and `capabilities.symlinks` only with `symlink`, `lstat` and `readlink`. With `lstat` it never follows a symbolic link: `writeContent`, `mkdir`, `remove` and `rename` refuse a path beneath a symlink or a file (git's `has_symlink_leading_path`); `writeContent` unlinks a link at the path instead of writing through it and refuses to write over a directory; `remove` unlinks a link (a dangling one too) and leaves a directory in place unless `recursive`; `walk`, `getEntry`, `readContent` and `computeHash` report a link as mode 120000 with its target as content (never descending into a linked directory), an executable as 100755, and `ctime`; a symlinked `.gitignore` is not followed. `checkoutTree` / `checkoutPaths` now write symlinks as links (or files holding the target), chmod files, create an empty directory for a gitlink instead of failing it, and refuse paths beneath a symlink.
- **vcs-working-tree:** `WorktreeEntry` gains `ctime?`. New `modeFromWorktree(worktreeMode, indexMode, trust)` and `WorktreeModeTrust`, after git's `ce_mode_from_stat`. The status calculator ignores the executable bit where the worktree cannot show it (`capabilities.executable === false`).
- **vcs-commands:**
  - `AddCommand` stages the mode git would: a link as 120000 with its target as content (never the file it names), and, where the worktree or `core.filemode` / `core.symlinks` cannot be trusted, the index's 100755 / 120000 kept for a regular file.
  - `CloneCommand` checks out last, after HEAD, `refs/remotes/<name>/HEAD` and the configuration, as git; a failed checkout throws the new `CloneCheckoutError` ("Clone succeeded, but checkout failed: …", with the clone's `result`), the repository usable. Every path of the tree is checked before the first write. The index records the worktree's own stat of each entry (a link's from `lstat`) and its ctime.
  - `planTreeRestore` (clone, `reset --hard`, `stash apply`) refuses paths `verify_path` refuses and colliding entries: the same path twice, or a path beneath a planned file, symlink or submodule, case-folded with `core.ignorecase`.
  - `reset --hard` deletes the tracked paths the target drops before writing, as git's unpack-trees: a tracked file or link `d` makes way for `d/x` (this also fixes a file replaced by a directory failing with EEXIST).
  - `core.*` settings are read from the repository's own configuration only (no global or system configuration).
