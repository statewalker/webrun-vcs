---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-store-kv": patch
"@statewalker/vcs-store-sql": patch
"@statewalker/vcs-working-tree": minor
---

**Local remotes, rebase by name, missing stashes, attr pathspecs and exit codes.**

- `rebase().setUpstream()` takes a revision (`main`, `HEAD~2`, a tag) as well as an id. It is resolved when the rebase starts and fails with git's `fatal: invalid upstream '<x>'` before anything is written. Before, the name itself was written into `.git/HEAD`. The reflog keeps the name as given (`checkout main`).
- Every ref store refuses a direct ref value that is not a full lowercase hex object id. This covers `set`, `compareAndSwap` and `batch` in the files, memory, KV and SQL stores (`isRefObjectId`, reject reason `invalid-object-id`), so a name can no longer end up in a ref. Symbolic refs are written as before.
- `fetch`, `ls-remote`, `clone` and `push` reach a repository named by a path or a `file://` URL, as git's local transport does. The repository is opened through the working copy's storage (`Worktree.openRepository`, which follows git's `enter_repo`), and upload-pack or receive-pack is served in process over an in-memory duplex. A path with no repository there fails with git's "does not appear to be a git repository" lines; a clone of such a path fails with "repository '<path>' does not exist". A `<helper>::` address or an unknown scheme fails with git's "unable to find remote helper for '<scheme>'".
- `stashDrop` and `stashApply` fail as git does on a missing stash: "No stash entries found.", "error: stash@{n} is not a valid reference" (exit status 128, as in git 2.5x) and "fatal: log for 'stash' only has N entries". `setAll(true)` without a stash still returns undefined.
- `stash push -u` with `:(attr:...)` enters an untracked directory only when the directory's own name and attributes match as a leading path, as dir.c's `treat_directory` does (`PathspecAttributes.reachable`, shared with `add`).
- Exit codes are inferred from a message's prefixes only where git puts them: `usage:` or `error:` on the first line, and `fatal:` on the last line (or the first). A path in a listing, such as `fatal: x.log`, no longer changes the status. Error classes that always end with the same status set it explicitly (`AddFailedError`, `EmptyCommitError`, `NoMessageError`, `NotMergedError` and others).
- `commit().callDryRun()` honours `setInclude`: it runs the same option checks, stages the named tracked paths on the held index, shows the status, and rolls the index back.
- An initial commit, or `--amend` of a root commit, with an empty index (or one holding only intent-to-add entries) fails with "nothing to commit" unless `setAllowEmpty`.
- When the status is not part of the template, an editor's commit decides whether there is anything to commit with git's `index_differs_from` (HEAD, or HEAD^1 when amending) instead of a status run. As a result, `--amend` with `setIncludeStatus(false)` no longer refuses a commit that changes the amended commit's parent.
- `add().setCompatibility("2.43")` refuses `:(attr:...)` with git 2.43's message, so `stash push` under 2.43 compatibility fails after saving the stash, as git 2.43 does. `diff` of trees in a bare repository works and reads the bare attributes for `:(attr:...)`, as `log` does. `PathspecAttributes.forWorktree` without a worktree throws a `GitApiError` instead of a plain `Error`.
