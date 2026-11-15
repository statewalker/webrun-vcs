---
"@statewalker/vcs-utils-node": patch
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

**Clean never enters tracked paths; git's racy smudging on every index write; exact nanoseconds.**

- **vcs-commands (data loss fix):** `clean()` never enters a directory standing where the index has a file, link or submodule (a file replaced by a directory, a deinitialised submodule's directory), as git; a path filter removes the untracked directory it names as `git clean -f -- u` does (`u/`), globs (`*.txt`) match as git's pathspecs, a nested repository named by a path filter is passed over silently, and a directory whose `.git` is no repository (an empty `.git`) is removed with `-d`, as git (new optional `Worktree.isRepository`).
- **vcs-working-tree / vcs-store-files (racy git):** every index write of `GitStaging` / `FileStagingStore` applies git's `ce_smudge_racily_clean_entry`: an entry as read whose mtime second is not older than the index file's, and whose content changed behind a matching stat, is written with size 0 (new `Staging.setRacyCheck`, installed by every command from the worktree; `smudgeRacilyClean`). The index time is the index file's own mtime after every read and write (0, every entry racy, when unknown; never "now"). Entries a refresh proved clean are recorded as they are, not smudged.
- **vcs-utils-node:** `lstat` builds millisecond times from the nanosecond parts exactly (a ~1.8e18 nanosecond time no longer drifts below its millisecond), so the index records the file's nanoseconds exactly.
- **vcs-store-files:** a submodule `gitdir:` file pointing where there is no repository, or beyond the FilesApi's root, makes status fail with git's message ("fatal: gitfile does not point to a valid repository: sub/.git") instead of reporting the submodule clean.
- **vcs-working-tree:** stash push keeps the index's commit for a submodule (as git stash), even when the submodule checked out another one.
