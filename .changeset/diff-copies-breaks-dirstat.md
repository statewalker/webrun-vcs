---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-utils": minor
---

diffcore options of `git diff`, `log` and `show` (statewalker/statewalker-root#342): `DiffTextOptions.findRenames` (`-M<n>`), `findCopies` (`-C<n>`), `findCopiesHarder` (`-C -C`, `--find-copies-harder`, also a `-C` under `diff.renames=copies`) and `breakRewrites` (`-B[<n>][/<m>]`: broken pairs, `dissimilarity index`, complete-rewrite patches, `--diff-filter=B`) follow git's diffcore-break and diffcore-rename, with git's rename-limit warnings; the `dirstat` output format with `DiffTextOptions.dirstat` and `diff.dirstat` (`changes`, `lines`, `files`, `cumulative`, cut-off); `DiffTextOptions.anchored` (`--anchored=<text>`, the patience diff's anchors, `XdiffOptions.anchors` in vcs-utils). `git status` takes `setFindRenames(<n>)` (`-M`/`--find-renames`), detects copies under `status.renames=copies` (`copied:`, `C` in the short and porcelain formats), and its `-v`/`-vv` diffs follow `status.renames`, the rename threshold and `status.renameLimit`.
