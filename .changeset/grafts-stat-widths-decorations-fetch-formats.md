---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
"@statewalker/vcs-transport": patch
"@statewalker/vcs-utils": minor
---

**`GIT_GRAFT_FILE` everywhere grafts count, git's diffstat widths, log decoration filters, `fetch -v` / `--porcelain`.**

- **Grafts file:** `commitGraphCompatible` takes `readGraftFile` (the file `GIT_GRAFT_FILE` names, read in place of `info/grafts`); the files commit-graph provider and `writeCommitGraph` pass the environment's, so a graph is neither read nor written while that file has grafts. `git fsck` reads the grafts file the environment names too (its walk, its deprecation hint, its commit-graph checks). `fsck`'s `git commit-graph verify` now reads grafted commits as git does once the grafts file is read: the grafted parents from the object database, no parents from the graph (`VerifyGraphOptions.ungraphedParents`), and the grafts file's `bad graft data` errors repeated by that second process.
- **`diff --stat` widths:** names are measured with git 2.56's character widths (`gitStrWidth`, git's `utf8_strwidth`: byte count for invalid UTF-8) and shortened behind `...` as git 2.55+ does (`gitCharWidthAt`, diff.c's `utf8_ish_width`: whole characters, invalid bytes one column, control characters none). `blame`'s author column uses the same widths.
- **Decorations:** `createRefDecorationFilter` is `git log`'s decoration filter (`--decorate-refs`, `--decorate-refs-exclude`, `--clear-decorations`, `log.excludeDecoration`, `log.initialDecorationSet=all`, the default set), and `loadRefDecorations` takes it as `logOptions` (with `decorate` / `log.decorate=full` for full ref names in `%d`, `%D`).
- **Fetch:** `FetchCommand.setVerbose` (`-v`: ` = [up to date]` lines, the remote column measured over them) and `setPorcelain` (`--porcelain`: `<flag> <old> <new> <ref>` lines in `display`); `fetch.output=compact` is honoured. As in git, a refused ref update stops the fetch before tag backfill and before the remote HEAD is followed, and with `--atomic` writes no ref and no `FETCH_HEAD` line.
