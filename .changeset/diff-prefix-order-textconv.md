---
"@statewalker/vcs-commands": minor
---

**`git diff` path prefixes, order file and textconv, as git prints them.**

- **Prefixes:** `DiffCommand` reads `diff.noprefix`, `diff.mnemonicPrefix` (`i/` and `w/` for the index against the worktree, `c/` and `w/` for a commit against it, `c/` and `i/` for `--cached`, `a/` and `b/` between two trees, the combined diff of a conflicted path included) and `diff.srcPrefix` / `diff.dstPrefix` (git 2.45+). New options `noPrefix` (`--no-prefix`) and `defaultPrefix` (`--default-prefix`) join `srcPrefix` / `dstPrefix`.
- **Order file:** `diff.orderFile` and the option `orderFile` (`-O<orderfile>`) reorder the files of every output format as `diffcore-order.c` does (wildmatch on the path and its leading directories, first matching pattern, unmatched last, stable). A relative path is read in the worktree; a missing file fails with git's message. `parseOrderFile`, `orderRank` and `orderByPatterns` are exported.
- **Textconv:** `diff.<driver>.textconv` (with `.cachetextconv`; no cache is kept, which changes nothing in the output) converts both sides of a patch and of a combined diff, a converted side never being binary (`diff.<driver>.binary` and `-diff` still apply to the other cases); the option `textconv` is `--textconv` / `--no-textconv`. Running the command is the host's job: `installTextconvRunner(workingCopy, runner)` registers a `TextconvRunner`; without one no textconv applies (git's `--no-textconv`), where git would fail.
- **Fixes:** `--stat` and `--numstat` count binary files in bytes even with `--text`, as git does; the `diff` attribute's driver applies to regular files only (an absent side, a symbolic link and a submodule take the default driver, as `diff_filespec_load_driver`).
