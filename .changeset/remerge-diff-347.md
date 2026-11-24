---
"@statewalker/vcs-commands": minor
---

`git log --remerge-diff` and `git show --remerge-diff` (`LogOutputOptions.remergeDiff`, `--diff-merges=remerge`/`r`, `log.diffMerges=remerge` under `-m`): each two-parent merge is merged again by merge-ort in memory (`RemergeTreeCommand` over `remergeObjectsView`, an in-memory overlay of the repository's blobs and trees, so nothing is stored) and shown as the diff from that result, conflict markers included, to the recorded merge, with merge-ort's conflict messages as `remerge CONFLICT` headers (`DiffCommand.setAdditionalHeaders`, `OrtMergeResult.pathMessages`); octopus merges get git's warning, and git 2.43's `--reverse` merge bases are reproduced under `setCompatibility("2.43")`. A merge shown with paths is TREESAME only to every parent under full history. Ported from statewalker/statewalker-root#347.
