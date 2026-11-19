---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": patch
---

**Racily clean entries stay protected after a commit shows its false index; `status -v`/`-vv` and the commit template follow git more closely; ahead/behind counts stop at the merge base.**

- `Staging.saveState()` / `restoreState()` (new, optional; `GitStaging` and `FileStagingStore` implement them) put a staging back exactly: the same entry objects, the entries kept as read, the pending cache-tree and untracked cache. `CommitCommand` uses them where it showed a partial commit's false index in the editor's template or the dry run, and where a failed commit puts back unwritten edits, so the entries read from the index are still smudged when racily clean (before, an editor `--only` commit made `git status` miss a change). The index builders of both stagings keep a copy of an entry kept as read as read (git copies the entry with its flags). New `IndexBuilder.finish({ upToDate: true })` counts every entry the builder took as set in this session instead; the merge family's index rewrite (merge, cherry-pick, revert, rebase, read-tree, apply) uses it, so a merge over a racily clean index again reads only the paths it writes, not every file.
- `status -vv` (and `commit --dry-run -vv`, the `-vv` template) print the unstaged diff only when a path that is not unmerged changed (`wt_status_check_worktree_changes`), and diff a conflicted path as `diff-files` does (`* Unmerged path`, then its stage 2): new `DiffCommand.setCombineMerges(false)`. The verbose diffs apply `submodule.<name>.ignore` and `diff.ignoreSubmodules` as git does, and show `-dirty` only for a submodule at its entry's commit (new `DiffCommand.setDirtySubmodules(false)`); `git diff` now honours `submodule.<name>.ignore` too.
- `CommitCommand.callDryRun()` takes the index lock as git's `prepare_index` does: an `index.lock` another process holds fails with `IndexLockFailedError` (exit code 128, git's "Unable to create '…/index.lock': File exists." message) and is left in place. A dry run of an `--only` commit stores no tree for the false index.
- `CommitCommand.setTemplate()` (`-t`, default `commit.template`) starts the editor from a template file read through the host; an untouched template aborts with "Aborting commit; you did not edit the message.". `COMMIT_EDITMSG` is written before an empty commit is refused, as git writes it.
- `countAheadBehind` (vcs-core) and the optional `Commits.countAheadBehind` count `rev-list --left-right --count ours...theirs` with one walk that stops at the merge bases (commit-graph generations order it where there is one); `git status`'s tracking report uses it instead of collecting every ancestor of both sides.
