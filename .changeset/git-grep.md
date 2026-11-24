---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-utils": patch
---

`git.grep()` (`GrepCommand`) is `git grep` (builtin/grep.c, grep.c): the worktree's tracked
files, `--cached`, `--untracked`, `--no-index` (and `grepNoIndex` outside a repository), trees
and revisions (`<rev>:<path>` names, arguments read as git reads them with or without `--`).
Patterns `-e`/`-f` with `--and`/`--or`/`--not`/parentheses and `--all-match`, `-E`/`-F`/`-G`
(`-P` as a git without PCRE), `-i`, `-w`, `-v`; output `-n`, `-c`, `-l`/`-L`, `-o`, `--column`,
`-h`/`-H`, `--full-name`, `-z`, `--break`, `--heading`, `-q`, `-m`, context `-A`/`-B`/`-C`,
`-p`/`-W` through the diff driver's funcname pattern, `--color` with `color.grep.<slot>`;
`--max-depth`, pathspecs from the current directory (`setPrefix`), `grep.*` settings, binary
files (`-a`, `-I`, the `diff` attribute), `--textconv` through the installed runner, and git's
threaded output (`--threads`). `--recurse-submodules` is refused. `setCompatibility("2.43")`
follows 2.43's `-o` columns, `-W` trailing lines and expression errors.

`compilePosixRegex`'s `exec` takes `REG_NOTBOL`, and an unterminated `[` at the pattern's end is
glibc's `REG_BADPAT` ("Invalid regular expression").
