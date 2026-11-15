---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
---

**Checkout never writes into the repository's own `.git`** (git's `verify_path`, CVE-2014-9390). Tree and index paths come from other people's repositories, and a crafted tree with an entry named `.git` used to write its files into the worktree's `.git` (config, hooks, refs).

- **vcs-core:** new `isValidWorktreePath(path)` and `assertValidWorktreePath(path)`. They refuse empty, `.` and `..` components, and `.git` under any spelling a filesystem folds to it: any letter case; NTFS trailing dots and spaces, the 8.3 name `git~1`, alternate data streams (`.git::$INDEX_ALLOCATION`) and `\` as a separator; and HFS+-ignored code points (`‌.git`). `.gitignore`, `.github/` and other dotfiles stay valid.
- **vcs-store-files:** `FileWorktree.writeContent`, `mkdir`, `remove` and `rename` refuse such paths. `checkoutTree` and `checkoutPaths` report them under `failed` and check out the rest. `GitResolutionStore` refuses them when it writes conflict resolutions to the worktree.
- **vcs-commands:** the core `CheckoutCommand` refuses such paths when it writes or removes worktree files. It reports them as conflicts.
