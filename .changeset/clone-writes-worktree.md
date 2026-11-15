---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
---

**A non-bare clone checks out its files, as `git clone` does.**

- **vcs-commands:** `CloneCommand` writes the files of the checked-out commit into the worktree, not only the index: contents, the executable bit and symbolic links where the worktree can represent them, an empty directory for each submodule (gitlink), and the index with the size and mtime of every file written, so native `git status` reports a clean tree right after the clone. The tree is planned (every blob checked) before the first file is written. A symlink becomes a plain file holding its target where the worktree cannot make links or `core.symlinks` is false; the index keeps mode 120000. When the worktree cannot represent executables or symlinks, the clone sets `core.filemode` / `core.symlinks` to false, as `git init` does after probing the filesystem. `setNoCheckout(true)` writes no files and leaves the index empty (git writes no `.git/index`); a bare clone writes neither. `planTreeRestore` (internal, shared with `reset --hard` and `stash apply`) takes `{ symlinks: true }` and reports the tree's gitlinks.
- **vcs-working-tree:** `Worktree` gains the optional `capabilities` (`WorktreeCapabilities`: `executable`, `symlinks`); undefined means both. `WorktreeWriteOptions.mode` documents that mode `0o120000` makes the content the link target.
- **vcs-store-files:** `FileWorktree` writes mode `0o120000` as a link where its FilesApi can make one (else as a plain file holding the target), chmods regular and executable files with their permission bits (`0o644`/`0o755`, was the whole git mode), and reports `capabilities` (see the changeset on symbolic links for what it requires of the FilesApi).
