---
"@statewalker/vcs-core": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
---

Checkout, switch, `read-tree -u`, `reset --hard`/`--mixed`/`--merge`/`--keep`, merge and clone now refuse a tree path that git's `verify_path` refuses the way git does, before anything is written. The message is `error: invalid path '<path>'` with the entry's full path, followed by the command's own lines and git's exit code. A tree entry with an empty name dies with `fatal: empty filename in tree entry`. Before this fix, these commands reported internal errors (`Tree entry name cannot be '..'`, `Invalid path: ... (contains .git)`), named the directory instead of the file, and `read-tree -u` and `reset` could remove files or move HEAD before refusing.

`core.protectNTFS` (default true) and `core.protectHFS` (default true on macOS, as git, and also where the system is unknown) are now read by checkouts and by `git add`/`mv`/`rm`/`commit` index writes (`worktreePathRules`). `isValidWorktreePath` takes `protectNTFS` and `protectHFS` options; with both off it still refuses `.git` in any case, `.`, `..` and a symlinked `.gitmodules`. `protectHFSDefault(systemName)` gives the default (on for `Darwin` and for an unknown system). `FileWorktree` keeps both protections on, on every platform, and reports them as `capabilities.protects`; commands that write such a worktree check at least that strictly, before writing anything. Tree decoding errors are now `InvalidTreeEntryNameError`. `ReadTreeFailedError` exits 128, as `git read-tree` does.
