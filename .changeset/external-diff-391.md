---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-utils-node": minor
---

External diff programs (statewalker/statewalker-root#391). `git.diff()` now behaves as porcelain `git diff` with `--ext-diff`: a pair whose `diff.<driver>.command` is set, or any pair when `GIT_EXTERNAL_DIFF` or `diff.external` is, goes to that program instead of the builtin patch, run through the host's `hookRunner` with git's seven arguments (`<path> <old-file> <old-hex> <old-mode> <new-file> <new-hex> <new-mode>`, plus `<new-path> <header lines>` for renames). The sides it reads are written in `GitHostEnvironment.tempDirectory` through `hostFilesOf`. Its stdout replaces the pair's patch. `setOptions({ extDiff: false })` is `--no-ext-diff`. `log`/`show` and the plumbing diffs need `extDiff: true`. Hosts without a hook runner see no change. `trustExitCode` (`diff.<driver>.trustExitCode`, `diff.trustExitCode`, `GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE`) decides `--exit-code`/`--quiet`; an exit code git refuses throws `ExternalDiffDiedError`. New `GitHostEnvironment.diffVariables` (filled by `createNodeGitHostEnvironment`) also carries `GIT_DIFF_OPTS` (`-u<n>`/`--unified=<n>`: every builtin patch's context) and `GIT_MERGE_VERBOSITY`; at 0, as with `merge.verbosity=0`, `git merge` prints no merge-ort messages (git 2.50+).
