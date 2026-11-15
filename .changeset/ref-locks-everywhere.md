---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-store-kv": minor
"@statewalker/vcs-store-sql": minor
"@statewalker/vcs-commands": minor
---

**Every ref and reflog write goes through git's locks; the unlocked writers are gone (breaking).** `vcs-store-files` no longer exports `writeRef`, `writeObjectRef`, `writeSymbolicRef`, `deleteRef`, `updateRef` (`refs/ref-writer.ts`) or `appendReflog`, `deleteReflog` (`refs/reflog-writer.ts`, removed; `hasReflog` moved to `reflog-reader.ts`). They wrote loose refs and reflogs with plain writes. Use `FileRefStore` instead: `set`, `setSymbolic`, `remove`, `batch`, `compareAndSwap` and the new `deleteReflogEntry` all take `<ref>.lock` (and `packed-refs.lock` where git does), and a reflog line is appended while the ref's lock is held, as git does. A batch now also locks every symbolic ref that logs the update (not only HEAD), the updated ref first. As in git, a reflog line that cannot be written now fails the update before its commit (the ref keeps its value) instead of being skipped.

**Stash as git keeps it.** `GitStashStore` (the files `WorkingCopy.stash`) writes `refs/stash` through the history's ref store: a push is a one-ref batch under `refs/stash.lock` that creates the reflog (git's REF_FORCE_CREATE_REFLOG) with the stash commit's message, a drop is `git reflog delete --rewrite --updateref refs/stash@{n}` under `refs/stash.lock` and `logs/refs/stash.lock`, and the last drop deletes the ref and its log. Messages follow git ("WIP on main: abc1234 subject", "On main: message", "index on main: …"), commit timestamps are seconds (they were milliseconds), and `list()` returns the reflog message. Native `git stash list` / `show` / `drop` work on our stashes and we read and drop git's. `GitStashStoreOptions` loses `files` and `gitDir` (and `StashFilesApi` is gone): the store needs only `history`. In `vcs-commands`, `stashCreate` logs every stash (a custom message becomes "On <branch>: <message>", a detached HEAD "(no branch)", as in git), `stashList` lists every `stash@{n}` from the reflog, `stashApply` resolves `stash@{n}`, and `stashDrop` drops any `stash@{n}` (stores without reflogs keep the old `stash@{0}`-only behaviour).

**Pseudo refs and HEAD.** ORIG_HEAD, MERGE_HEAD, CHERRY_PICK_HEAD and REVERT_HEAD are written and removed through the ref store (under `<name>.lock` on git files) by the merge, cherry-pick and revert state stores and by `GitCheckout`, which also reads them from its `refs`. `createGitFilesBackend({ create: true })` writes HEAD with `setSymbolic` (under `HEAD.lock`).

**New core API.** `BatchOptions.createReflog` creates the updated refs' reflogs whatever their names. `Refs.deleteReflogEntry(name, index, { rewrite, updateRef })` (optional) deletes `name@{index}`; it is implemented by the memory, KV, SQL and git-files stores. `deleteReflogLine` and `ReflogEntryNotFoundError` are exported from `vcs-core`.
