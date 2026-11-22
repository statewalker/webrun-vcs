---
"@statewalker/vcs-commands": patch
"@statewalker/vcs-working-tree": patch
"@statewalker/vcs-store-files": patch
---

**`add`, `clean` and `stash -u`/`-a` fold case under `core.ignorecase`; `apply`, `am` and `reset -- <paths>` run as one worktree operation.**

```typescript
// core.ignorecase=true: a/b/two.txt tracked, a/b/TWO.txt and A/y.txt in the worktree
(await git.clean().setDryRun(true).call()).cleaned; // Set { "A/y.txt" }, as git clean -n
await git.add().addFilepattern(".").call(); // stages A/y.txt as a/y.txt, as git add
```

The untracked walks of `git add`, `git clean`, `git stash -u`/`-a` (its untracked tree and
the clean after it) ask the index as dir.c does through its name hashes, as `status` already
did: a file whose name differs from an index path only by case (a skip-worktree entry's
included) is tracked, so it is neither listed, added, stashed nor removed, and a directory
differing from a tracked one only by case is entered rather than taken whole
(`index_file_exists` with icase, `directory_exists_in_index_icase`, `dir_add_name`);
`index_name_is_other` stays exact. `git add` also spells a new file's leading directories as
the index does (`adjust_dirname_case`), forgetting a directory whose entries the same
`add -A` removed first, as name-hash.c's `remove_dir_entry` (a dry run removes nothing):
`IndexDirnameCase.forget`. `stash push -u -- A` with `A/` a case variant of a tracked `a/`
saves and removes `A/y.txt` and succeeds, where native git saves the stash and then fails
its reverse apply, leaving the file (a deliberate divergence). `IndexPathLookup` takes `gitlinks` and answers
`indexDirectory` (git's `directory_exists_in_index`), and `untrackedIndexPredicates` gives
`findUntrackedFiles` the same answers.

`git apply`, `git am` and `git reset [<tree>] -- <paths>` run inside `Worktree.batch`, so the
configuration and the attributes files are read once per command instead of once per file
converted or refreshed (2000 changed files: `apply --index` 4.3 s → 1.6 s, `reset -- .`
1.0 s → 0.19 s).

The files `git apply` writes are converted by the attributes as read before its writes: a
`.gitattributes` the patch adds or changes no longer converts the files written with it
(apply.c converts through convert.c's attribute stack, built on its first check and kept).
`Worktree.batch` and `WorktreeContentFilter.batch` take `OperationOptions`
(`keepAttributes`), which nested batches pass on.
