---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-working-tree": patch
---

**`status` folds case under `core.ignorecase`; a diff of two trees reads no index attributes.**

```typescript
// core.ignorecase=true, a/b/two.txt tracked, a/b/TWO.txt in the worktree
(await git.status().call()).untracked.has("a/b/TWO.txt"); // false, as git status
```

The untracked scan asks the index as dir.c does through its name hashes: under
`core.ignorecase` a file whose name differs from an index path only by case (a skip-worktree
entry's included) is tracked, and a directory differing from a tracked one only by case is
entered rather than shown whole (`index_file_exists` with icase,
`directory_exists_in_index_icase`); the untracked cache records the same names as native git.
`IndexPathLookup` takes `{ ignoreCase }`, and `UntrackedScanOptions.isTrackedExactly` keeps
`index_name_is_other`'s exact check for ignored paths.

A diff of two trees (`git diff A B`, `log -p`, `show`, `format-patch`) takes the diff drivers'
in-tree `.gitattributes` from the worktree alone, as builtin/diff.c, which reads no index
there; the diffs against the index or the worktree still fall back to the index's files.
