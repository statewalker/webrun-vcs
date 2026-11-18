---
"@statewalker/vcs-commands": minor
---

**`git log` output: review fixes.**

- `-m` and `--diff-merges=separate|first-parent` turn git's history simplification off for path-limited walks, as `--full-history` does (new `LogCommand.setFullHistory`): merges are compared with every parent and all are walked.
- `--follow` finds copies of files the commit left unchanged (copies found harder, as git's `try_to_follow_renames`); `-c`/`--cc` with `--follow` limit the combined diff to the followed path, read in each parent under the name it had there. `--follow` with no or several paths, or with magic, throws git's error; `--graph` with `--reverse` too. `-n 0 --follow` shows nothing, and `--reverse -n <n> --follow` reverses the newest `n` commits walked.
- `--diff-merges=<mode>` without `-p` diffs only the merges.
- `log -p` / `--stat` read the trees directly (no ref lookup for a full object id in `DiffCommand`), compare only the subtrees that differ, and share the replace refs, the object count and lately read trees between the commits' diffs (new `GitCommand.shareReadsOf`): about five times faster.
- `all()` walks the refs in git's order (by name, then HEAD) and combines with `add()`; `add()` peels annotated tags.
- Commits with an `encoding` header are shown in UTF-8 (message and idents), as git re-encodes them; replaced commits are printed from their replacement.
- `--full-diff` under `--graph` diffs against the parents before rewriting; `--abbrev=<n>` reaches the diffs' `index` lines and is clamped to 4..40.
- Dates past JavaScript's range (`9999999999999 +0000` in the year 318857) and zones such as `+0060` and `-0001` print as git prints them; `format:` dates follow glibc's strftime (flags `_ - 0 ^ #`, widths, `E`/`O` modifiers) and `format-local:` names the local zone (`localTzName`).
- `%N` stays literal without notes; a relative `mailmap.file` is read from the worktree when no host environment is given.
