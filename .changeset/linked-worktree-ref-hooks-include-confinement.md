---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-transport": patch
"@statewalker/vcs-utils-node": patch
"@statewalker/vcs-working-tree": patch
---

**Linked worktrees run the reference-transaction hook and peel packed-refs as git does; served repositories can confine their config includes.**

- A linked worktree's ref store (`createWorktreeRefs`) now has `setTransactionHook`: commits (HEAD told as asked, then its branch), branch and tag creation and deletion (`removeAll`, one transaction as 2.5x or 2.43's legacy order), the worktree's own refs (`refs/bisect/`, `refs/worktree/`, ORIG_HEAD), its symbolic HEAD (2.5x's `ref:` line), `pack-refs` and gc run the repository's hook from the worktree, as native git 2.43 and 2.56 do. Hooks run in a worktree reached through a gitfile get `GIT_DIR` as git exports it (the real path, through the new `GitHostEnvironment.realPath`; Node: `realHostPath`), a bare repository's hooks `GIT_DIR=.` (they now run from `Git.fromWorktreeAdmin` too), and `worktree add`'s post-checkout runs without `GIT_DIR`/`GIT_WORK_TREE` (new `HookInvocation.unsetEnv`). Concurrent batches each tell the hook their own updates (`BatchOptions.transactionHook`); `removeAll` deletes none of the worktree's refs when the repository's transaction is refused (as 2.43, `legacy`, only when the packed store's transaction is: a refusal of one ref's own transaction leaves the others, the worktree's included, going; new `RefTransactionAbortedError.packed`). A sequencer's "cannot lock ref" message names the lock under the git directory's logical path, as git's `absolute_path` keeps `$PWD` (`HookSession.hostGitDir({ real: false })`).
- A commit refused in `preparing` tells `aborted` HEAD as asked, not its branch (new `RefTransactionContext.asAsked`).
- packed-refs written from a linked worktree is peeled as the main worktree writes it (`peeled fully-peeled sorted`, a `^` line per annotated tag); `peelTag` is exported.
- New `Worktree.openRepository(location, { configIncludes })` (`OpenRepositoryOptions`) and `GitConfigOptions.includes: "files"`: a server can keep a repository's `include.path` / `includeIf.*.path` inside the repository's own git directory (`includeRoots`; no `~/` path, links followed and checked, files up to 1 MiB, read no further than that through `ConfigFilesApi.readPrefix`, none where the storage cannot tell links apart or give a file's size) or follow none, also for the settings `createGitFilesBackend({ configIncludes })` reads (`configFilesApiOf`). The repository format check follows no include whatever the rule, as git's `read_repository_format` (`readRepositoryFormat` lost its `includes` option). The default stays git's; see the security notes in `docs/transports.md`. A linked worktree's git directory opened this way reads its `config.worktree`, its own HEAD for `includeIf.onbranch:` and its host path for `includeIf.gitdir:`.
