---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-transport": patch
"@statewalker/vcs-working-tree": patch
---

**Linked worktrees run the reference-transaction hook and peel packed-refs as git does; served repositories can confine their config includes.**

- A linked worktree's ref store (`createWorktreeRefs`) now has `setTransactionHook`: commits (HEAD told as asked, then its branch), branch and tag creation and deletion (`removeAll`, one transaction as 2.5x or 2.43's legacy order), the worktree's own refs (`refs/bisect/`, `refs/worktree/`, ORIG_HEAD), its symbolic HEAD (2.5x's `ref:` line), `pack-refs` and gc run the repository's hook from the worktree, as native git 2.43 and 2.56 do. Hooks run in a worktree reached through a gitfile get `GIT_DIR`, as git exports it.
- A commit refused in `preparing` tells `aborted` HEAD as asked, not its branch (new `RefTransactionContext.asAsked`).
- packed-refs written from a linked worktree is peeled as the main worktree writes it (`peeled fully-peeled sorted`, a `^` line per annotated tag); `peelTag` is exported.
- New `Worktree.openRepository(location, { configIncludes })` (`OpenRepositoryOptions`) and `GitConfigOptions.includes: "files"`: a server can keep a repository's `include.path` / `includeIf.*.path` inside its storage (no `~/`, climbing or outside absolute paths, no symbolic link leading out) or follow none. The default stays git's; see the security notes in `docs/transports.md`.
