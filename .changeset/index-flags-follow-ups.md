---
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-store-mem": patch
"@statewalker/vcs-store-kv": patch
"@statewalker/vcs-store-sql": patch
"@statewalker/vcs-commands": patch
---

**`add -N` no longer turns a tracked file into a deletion, and `commit --only` commits what git commits.**

- **vcs-commands:** `add -N` leaves a path with a stage-0 entry (tracked or already intent-to-add) as it is, as git's `ADD_CACHE_NEW_ONLY`; before, a tracked file became an empty intent-to-add entry and the next commit deleted it. A conflicted path still has its stages replaced, as git does.
- **vcs-commands:** `commit --only <paths>` is git's partial commit: the paths the given ones name in the index or HEAD are taken from the worktree (cleaned; a file gone removed, an intent-to-add file with its content) into the index and into HEAD's tree, which is committed; the index keeps its other staged changes and is written once the commit is made. A path nothing knows fails with git's `pathspec ... did not match`, a partial commit during a merge, cherry-pick or rebase is refused, other unmerged paths do not stop it, and an amend starts from HEAD.
- **vcs-commands:** every index-writing command (add, rm, commit, reset, checkout, switch, merge, cherry-pick, revert, rebase, am, pull, stash push/apply, apply `--index`/`--cached`, and clean for reading) reads the index again at its start when another writer replaced it, as git does, and refuses with `IndexChangedError` before touching anything only when the instance holds unwritten edits. `commit` now re-reads instead of refusing.
- **vcs-working-tree, vcs-store-files, vcs-store-mem, vcs-store-kv, vcs-store-sql:** the stagings' builders and editors copy the whole stat data of an entry (nanoseconds, uid, gid), so an index rewritten around a few paths (`rm` of many entries, `commit --only`) no longer leaves the others stat-dirty. `Staging.hasUnwrittenChanges()` (optional) tells whether an instance holds edits made since it read or wrote the index.
