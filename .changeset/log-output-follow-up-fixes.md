---
"@statewalker/vcs-commands": patch
---

**`git log` / `git diff` output: follow-up fixes.**

- Combined diffs (`log -c`/`--cc`, and `DiffCommand`'s combined diffs of conflicted paths) abbreviate their `index` lines to git's default length whatever `--abbrev` says; `DiffCommand`'s `abbrev` is clamped as git's `--abbrev=<n>` (below 4, 0 too, is 4; above 40 is 40).
- `--full-diff` runs every commit's diff (git's `revs->diff`), so `--diff-merges=first-parent --full-diff` and `-m --full-history --full-diff` print what git prints.
- `-m` / `--diff-merges=separate` with `--first-parent` diff merges against the first parent only.
- `-c`/`--cc` with `--follow` show nothing of a merge when a parent before the last finds the file renamed or copied, and `--name-status` marks a copy found by the last parent `C`.
- `--first-parent --graph` keeps the lane git keeps for a merge whose first parent was rewritten away.
- The combined diff of a path a merge deletes prints its hunk, as git does.
