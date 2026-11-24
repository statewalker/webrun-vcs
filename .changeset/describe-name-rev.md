---
"@statewalker/vcs-commands": minor
---

`git.describe()` (`DescribeCommand`) is `git describe` (builtin/describe.c): `--first-parent`,
`--exact-match`, `--candidates`, `--contains` (through name-rev), `--dirty[=<mark>]`,
`--broken[=<mark>]`, `--debug`, `--long`, `--abbrev=0`, several revisions, blobs described by
the first commit that brings them (`<description>:<path>`), the "externally known as" warning
of a misnamed tag and git's deaths; `callText()` gives git's stdout and stderr and throws
`DescribeError` where git dies, `setCompatibility("2.43")` follows git 2.43's search and
`--contains --all`. `git.nameRev()` (`NameRevCommand`) is `git name-rev`: `--name-only`,
`--tags`, `--refs`, `--exclude`, `--no-undefined`, `--always`, `--all`, `--annotate-stdin`,
git's tie-breaks (tags first, older first, then ref names) and cut-offs by commit-graph
generation (else commit date less a day). `submodule status` names commits through the same
name-rev (statewalker/statewalker-root#337).
