---
"@statewalker/vcs-commands": minor
---

`--pathspec-from-file` and `--pathspec-file-nul` for add, rm, commit and stash push:
`AddCommand`, `RmCommand`, `CommitCommand` and `StashCreateCommand` get
`setPathspecFromFile(content, nul?)`, as reset, restore and checkout have it. The commands
share one reader (`PathspecFile` over `parsePathspecFile`: C-quoted lines, CRLF, NUL mode, a
NUL inside a line ending its element) and git's refusals: beside pathspec arguments (now
whatever the file holds, an empty file too, in reset, restore and checkout as well), with
`-p`/`--interactive` (add), `-a` (commit), `--patch`/`--staged` (stash push) and `--detach`
(checkout, which now refuses it with git's message). An empty file is git's "Nothing
specified, nothing added." for add, "No pathspec was given. Which files should I remove?" for
rm, and a commit of the index as it is (statewalker/statewalker-root#299).
