---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

**A faster worktree stat pass; `add --chmod` / `add --refresh`; `stash push -- <pathspec>` and `--staged`.**

- **vcs-utils:** `PosixFilesApi` gains two optional members: `lstatMany(paths)`, which lstats many paths in one call (a path beneath a link, or with nothing there, answers undefined), and `listKinds(path)`, which lists a directory with each entry's kind from `readdir` (git's `d_type`) and no stat, throwing for a directory it cannot read.
- **vcs-utils-node:** the Node FilesApi implements both with synchronous calls (`lstatSync`, `readdirSync`; names read as strings, re-read as bytes when one is not UTF-8), and joins plain paths without `path.resolve`.
- **vcs-working-tree:** `Worktree.getEntries(paths)` (optional) and `getWorktreeEntries`; `withWorktreeEntries` stats index entries a chunk at a time (git's `preload_index`), and `compareWithWorktree` takes such a prefetched entry. `WorktreeWalkOptions.skipFile` passes files over before any stat or ignore check (the untracked scan passes the index's paths, as git's `treat_path`). Status, `diffIndexWithWorktree` and the stash scan use them. `StashTreesSource.pathFilter` limits the worktree and untracked trees and the check for changes to a pathspec.
- **vcs-store-files:** `FileWorktree` implements `getEntries` (one `lstatMany`, the ignore flag worked out when asked) and walks with `listKinds`, statting only the entries it yields. The staging editor applies a few edits to a large index in place instead of regrouping and sorting every entry.
- **vcs-commands:** status, diff (worktree), `add -u` / `-A` / `.`, `commit -a` and stash stat the index's files in one batch; status takes HEAD's directories whose cache-tree node matches as the index's without reading them (git's `cache_tree_matches_traversal`); `add` passes a tracked file whose stat matches before `verify_path`, as git's `add_to_index`; diff of the worktree leaves unchanged entries out before pairing. On a 50k-file repository status, `add -u` and `commit -a` after one change run about twice to four times as fast.
- **vcs-commands:** `AddCommand.setChmod("+x" | "-x")` (`git add --chmod`, git's `chmod_pathspec` and its "cannot chmod" errors; `chmodIndexEntries` for an `update-index --chmod`), `setRefresh(true)` (`git add --refresh`: fresh stat only, "needs merge" lines, porcelain lines with `setVerbose(true)`, "pathspec did not match any files"). `StashCreateCommand.addPath()` stashes and resets only the matching paths (`git stash push -- <pathspec>`: no ORIG_HEAD, git's "did not match any file(s) known to git" check without `-u`) and `setStaged(true)` stashes the staged changes alone (`git stash push --staged`: the staged diff applied in reverse to the worktree, the index reset; `NoStagedChangesError`, `StashWorktreeRemovalError`).
