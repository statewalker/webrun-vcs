---
"@statewalker/vcs-commands": patch
---

**Stash apply: move-aside names made unique, file/directory collisions in conflicts, rename conflicts; `stashCreate` needs a working tree.**

- **Unique move-aside names.** A file moved aside by a file/directory conflict now gets a unique name, as git's `unique_path` makes it: `<path>~<side>`, then `_0`, `_1`, … appended while the name is a path or directory in the base, the index or the stash, or is already taken. A tracked file, directory or link of that name is never overwritten. An untracked file there still refuses the apply, and an ignored one is overwritten, as in git.
- **File/directory collisions inside conflicts.** A modify/delete conflict whose surviving file collides with a directory now moves aside the same way, and the directory keeps its name. That covers ours modifying `p` while the stash deletes it and adds `p/x`, the stash modifying `p` while the index or HEAD has `p/x`, and a rename onto a directory the stash adds.
- **Safety net.** `findInTheWay` refuses any write onto a directory that holds tracked files the operation does not remove.
- **Rename conflicts.** Renames are no longer reported as clean merges when git reports a conflict:
  - rename/delete is staged at 1 and 2 or 3 (DU/UD), with the renaming side's file in the worktree
  - rename/rename to two paths stages the original at 1 (DD) and each side's file at its own path (AU/UA)
- **`stashCreate` (breaking).** Without a working tree provider it now throws `StoreNotAvailableError` instead of reporting a stash of HEAD's tree while the local changes stay unsaved. Pass one with `setWorkingTreeProvider`.
