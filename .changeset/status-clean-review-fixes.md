---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-store-files": patch
---

**Clean never removes a repository it cannot check; review fixes for status, clean and renames.**

- **vcs-store-files (data loss fix):** `isRepository` takes a gitfile whose target's HEAD cannot be checked (reached through a symbolic link, unreadable) as a repository, as git keeps it: `clean -d`, `-dx` and `-Xd` no longer remove such a nested worktree. A `.git` link is kept too. A submodule whose gitdir cannot be read is shown clean (not a fatal error); only a confirmed missing HEAD is git's fatal error.
- **vcs-commands:** `clean -X -d` removes ignored directories that are empty or hold only empty directories, and removes a directory holding a `.git` that is no repository whole (dry run and real run agree, as git). `clean -d` without `-x` no longer removes empty directories inside an ignored directory.
- **vcs-commands:** stash apply never pairs empty files as renames (git's merge-ort); status still does, as git status. `detectRenames` takes `renameEmpty`, `size` (contents are read only when compared and not kept) and `onRenameLimit`; a rename limit of 0 or less is git's 32767. New `Status.warnings`: git's "exhaustive rename detection was skipped" text when the rename limit stopped inexact detection.
- **vcs-commands, vcs-working-tree:** status does not list files inside a deinitialised submodule's directory (`findUntrackedFiles` takes `isGitlink`); a submodule's own `status.showUntrackedFiles=no` (any false value) hides its untracked files, as git.
