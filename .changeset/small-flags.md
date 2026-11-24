---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": patch
---

`git rm -q`/`--quiet` (`RmCommand.setQuiet`) and git's `rm '<path>'` lines in `RmResult.output` (dry runs too, one per index entry, a sparse directory `--sparse` removes whole as `out/`); `git clean -e <pattern>` (`CleanCommand.setExcludePatterns`: command-line exclude rules asked before the standard ones, the only ones under `-x`); `git add --sparse` (`AddCommand.setSparse`). `add --ignore-errors` reports an unreadable file as git does (`error: open("<path>"): Permission denied`, `error: unable to index file '<path>'`). `rm`, `add` and `--renormalize` see a sparse index as git does (sparse directories kept collapsed unless a pathspec or a sparse directory on disk expands it, with 2.5x's `advice.sparseIndexExpanded` hint), and a failed `add --chmod` exits 255 as git. vcs-working-tree: `WorktreeWalkOptions.excludePatterns`, `createCommandLineExcludes`/`commandLineExcluded`, an `IgnoreManager.isIgnored` command-line argument, and `Staging.indexLayout().sparseDirectories`.
