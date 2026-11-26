---
"@statewalker/vcs-store-files": patch
---

A submodule or nested repository whose refs live in a reftable (`extensions.refStorage = reftable`) no longer reads as having no commit checked out: `FileWorktree.gitlinkHeadState` / `readGitlinkHead` resolve its HEAD through its reftable stacks (the linked worktree's own stack for per-worktree names), as git's `resolve_gitlink_ref` opens the submodule's ref store, instead of following the `.git/HEAD` stub. `add`, `submodule add`, status, diff and `submodule status` of such a submodule now match native git.
