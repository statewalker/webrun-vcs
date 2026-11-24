---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-utils": minor
---

Merge strategies and strategy options (statewalker/statewalker-root#336): `-s resolve` runs git-merge-resolve (the trivial in-index merge, then `read-tree -m --aggressive` and git-merge-one-file), `-s subtree` and `-X subtree[=<path>]` shift the other side as match-trees.c does, and the `-X` options that tune merge-ort's diffs (`ignore-space-change`, `ignore-all-space`, `ignore-space-at-eol`, `ignore-cr-at-eol`, `patience`, `histogram`, `diff-algorithm=`, `find-renames[=]`, `rename-threshold=`, `no-renames`, `renormalize`) are taken by `merge`, `cherry-pick`, `revert` and `rebase` (`setStrategyOptions`/`addStrategyOption`; `diff.algorithm` is read as git's ui merges read it). cherry-pick, revert and rebase pass `-s`/`-X` to each pick and keep them in `sequencer/opts` and `rebase-merge/strategy`/`strategy_opts`. `mergeLines` takes xdiff's whitespace bits (`whitespace`).
