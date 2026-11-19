---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-working-tree": patch
---

**`git add` finds nested repositories as git's `is_git_directory` does, and reports failures with what git printed before them.**

- A tracked file replaced by a repository whose HEAD is a symbolic link (`core.preferSymlinkRefs`) or whose `.git` is a link to a repository is staged as a gitlink by `add -u`, `-A` and `.`; `add -u` used to drop the file silently, and `-A` / `.` failed.
- A `.git` (directory, gitfile or link) names a repository only when its common directory (`commondir`, relative or absolute) has `objects` and `refs`: a gitfile naming a directory with only a HEAD, a linked worktree whose commondir is gone, or a link to a plain directory is no repository, so the files inside are added. An empty `commondir` fails with git's "fatal: failed to read <gitdir>/commondir". A drive-letter commondir counts as absolute only on Windows.
- New optional `Worktree.gitlinkHeadState` (and the `GitlinkHeadState` type) tells "no commit" (the tracked file is removed, as git's `check_removed`) from "cannot be read here" (kept, with a warning).
- `add -n .` reports a tracked file turned repository twice (`add 'a'`, `add 'a/'`), as git does.
- A path git's `verify_path` refuses (a `.GIT` component) fails with "error: invalid path", "error: unable to add … to index" and "fatal: adding files failed", and `--ignore-errors` goes on (exit status 1); `--dry-run` lists it.
- `--renormalize` keeps the errors printed before its "fatal: unable to stat", and `AddFailedError` has a new `warnings` field with the warnings printed before the failure.
