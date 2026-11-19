---
"@statewalker/vcs-utils": patch
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": minor
---

**`stash push -- <pathspec>` fails as git does after saving; `DA` for intent-to-add over HEAD; unreadable-directory and sparse-checkout messages.**

- **vcs-commands:** `stash push -- <pathspec>` reproduces git's failures after the stash is saved (`StashPathspecResetError`, carrying `stashCommit`): `git apply --index -R` refusing a path HEAD has, the index does not and the worktree holds untracked ("error: b.txt: already exists in working directory", the index updated by git's `add -u`, the worktree untouched); with `-u`/`-a`, git's `git add -- <pathspec>` dying on an element that matches nothing or naming ignored files (the others added); with `--keep-index`, `git checkout` naming an element the index tree lacks (the paths reset, the index tree not checked out). Pathspec errors name the elements as git hands them on: `:(prefix:0)x` (git 2.5x) or `:(,prefix:0)x` (`setCompatibility("2.43")`), also in the "did not match any file(s) known to git" check; `prefixOriginElement` spells them.
- **vcs-commands:** status shows an intent-to-add entry over a path of HEAD as git does: `DA` (`DD` once the file is gone), with HEAD's side in porcelain v2, `removed` listing it, and a rename from it keeping only its worktree side.
- **vcs-commands:** status, add and clean report git's "warning: could not open directory 'u/': Permission denied" for directories the scan cannot list (`Status.warnings`, `AddResult.warnings`, the new `CleanResult.warnings`); a real clean removes an empty unreadable directory (rmdir) and warns "failed to remove u: Directory not empty" for the others.
- **vcs-commands:** `add` (also `--chmod`, `--refresh`, `-u`, `--dry-run`) advises as git does on pathspec elements that match only skip-worktree entries ("The following paths and/or pathspecs matched paths that exist outside of your sparse-checkout definition…", hint off with `advice.updateSparsePath=false`), writes the index and rejects with `AddFailedError` (git's exit status 1).
- **vcs-working-tree:** `WorktreeWalkOptions.onUnreadable` receives the listing's error; `findUntrackedFiles` takes `onUnreadable`; `unreadableDirectoryWarning` words git's warning.
- **vcs-store-files:** `FileWorktree.getEntries` without `lstatMany` keeps at most 48 `getEntry` calls in flight (slow asynchronous FilesApis); the staging editor's in-place merge falls back to the full sort when a path's stages are out of order (a malformed index).
- **vcs-utils-node:** `list()` of a directory that cannot be read (EACCES) now throws, as `listKinds` does, instead of listing nothing; a missing directory still lists nothing.
- **vcs-utils:** the `FilesApi.list` contract documents that an unreadable directory fails the listing.
