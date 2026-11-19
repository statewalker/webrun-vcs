---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": patch
---

**`git add` checks its pathspec, stages gitlinks and removals as git does; faster index writes.**

- `git add` reads its patterns as git pathspecs and checks them as git's `cmd_add` does. A pattern that names nothing fails with "fatal: pathspec 'x' did not match any files" before anything changes (this used to pass in silence). Ignored paths named without `setForce` are reported with git's "The following paths are ignored by one of your .gitignore files" and its hint: the other paths are added and the index written, then `call` rejects with an `AddFailedError` that carries the result. `add -u` with a pattern that matches nothing tracked fails with git 2.5x's "error: pathspec 'x' did not match any file(s) known to git". New options: `setDryRun` (`-n`, which lists git's `add '<path>'` / `remove '<path>'` lines in `result.output`), `setIgnoreMissing` (`--ignore-missing`, only with a dry run), `setIgnoreErrors` (`--ignore-errors`, `add.ignoreErrors`) and `setWarnEmbeddedRepo`. `AddResult` gains `ignored` and `output`.
- A tracked file that became a directory is removed by `add -u`, `commit -a`, and by `add .` / `-A`, which add the directory's files as new. This also resolves a conflicted path replaced by a directory, keeping its stages as resolve-undo. A directory holding a repository with a commit takes the file's place as a gitlink instead.
- A repository inside the worktree is staged as a gitlink to its HEAD, with git's "warning: adding embedded git repository: x" and its advice (`advice.addEmbeddedRepo`). One without a commit fails with "'x/' does not have a commit checked out" and "fatal: adding files failed", and the index is not written. A submodule's gitlink follows the commit checked out there.
- `add -N` writes the empty blob, so `git fsck` and `git write-tree` find it. Its entries carry no stat data, as git's do. On a changed tracked file it keeps the entry and invalidates the file's cache-tree path, as git does.
- `add --renormalize` invalidates the cache-tree path of every file it adds again, changed or not, so the `TREE` extension matches git's.
- `commit -a` brings the tracked files up to date without a pathspec, as git's `add_files_to_cache` does.
- `stash push` records ORIG_HEAD, as the `reset --hard` git runs does.
- The index encoder (versions 2 and 3) writes every entry into one buffer. Sizes are summed first. ASCII paths and object ids are written in place, and each path and id is checked in the same pass. An entry encoded before is copied from where its bytes were last written. The first write of a 50,000-entry index goes from about 145 ms to about 40 ms, and `commit -a` on such a repository from about 870 ms to about 660 ms.
