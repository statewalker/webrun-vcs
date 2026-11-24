---
"@statewalker/vcs-commands": minor
---

`git log`/`git rev-list` revision selection and order (statewalker/statewalker-root#314).
`RevListCommand.addRevision` takes git's ref options: `--all`, `--branches[=<pattern>]`,
`--tags[=<pattern>]`, `--remotes[=<pattern>]`, `--glob=<pattern>` and `--exclude=<pattern>`
(which applies to the next ref option only), with `addAll`/`addBranches`/`addTags`/
`addRemotes`/`addGlob`/`addExclude` as shortcuts, and `--end-of-options`; `addStdin(text)` is
`--stdin` (its own `--not`, ref options, `--` then paths). `LogCommand` and `RevListCommand`
get `setOrder("topo" | "date" | "author-date")`, `setReverse`, `setBoundary` (boundary commits
after the others, `boundary: true`) and `setSource` (`source` on each commit, also turned on
by `%S`); `LogOutputOptions` gets `dateOrder`, `authorDateOrder`, `boundary` and `source`, and
log's output prints the `-` mark (`commit - <id>`, `- <id>` under `--oneline`, `%m`) and the
`\t<source>` after the id. `RevListCommand.callText()` prints rev-list's output (`-<id>` for
boundaries), `callLogText(options)` git log's, and `setBisect("bisect" | "vars")` gives
`--bisect` and `--bisect-vars` (`getExitStatus()`). `%m` in log formats is now `>` as git's.
`--graph --boundary` is refused (`NotImplementedError`).
