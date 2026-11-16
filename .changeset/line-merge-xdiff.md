---
"@statewalker/vcs-utils": minor
---

**`mergeLines` diffs with git's xdiff, so merges conflict where git's do, in linear time.**

`mergeLines` (merge, cherry-pick, revert, stash apply) now runs on a port of git's xdiff: lines classified and, for Myers, unmatched and many-matched lines set aside before the search (`xdl_cleanup_records`), Myers with xdiff's cost cutoff and snake heuristic, git's histogram and patience diffs, and `xdl_change_compact`'s sliding. On repetitive content (`}`, blank lines, short tokens) it used to pick other, equally short diffs than git, and so other conflicts; a 40,000-line repetitive merge took 38 s and now takes about 0.3 s. Defaults follow merge-ort: histogram and `XDL_MERGE_ZEALOUS`. New options: `algorithm` (`myers`, `minimal`, `patience`, `histogram`), `level` (`minimal`, `eager`, `zealous`, `zealous-alnum`; `git merge-file` is `algorithm: "myers", level: "zealous-alnum"`) and `histogramRediff` (false merges as git before 2.54, which did not diff a histogram group again after sliding joined it). An empty label is written without the space after the marker, as newer git does. `xdiff(a, b, { algorithm, indentHeuristic })` gives the same line changes as `git diff`, and `ByteLines` moved to its own module (still exported).
