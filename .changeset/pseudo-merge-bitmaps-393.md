---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
---

Pseudo-merge bitmaps (statewalker/statewalker-root#393, git 2.46+'s `bitmapPseudoMerge.*`). `writePackBitmap({ pseudoMerges })` selects pseudo-merges as git's pseudo-merge.c does and writes their section (`selectPseudoMerges`, `encodePseudoMerges`, `PseudoMergeGroup`), byte for byte as git: the 2.55+ table by default, 2.46-2.54's with `layout: "2.46"`. `repack -b` and `multi-pack-index write --bitmap` read the groups from the configuration (`readBitmapSettings().pseudoMergeConfig`, `pseudoMergeGroupsOf`, `pseudoMergeInput`; git's deaths as `PseudoMergeConfigError`; none under 2.43 compatibility). `parsePackBitmap` reads and checks the section (`PackBitmapIndex.pseudoMerges`, a bad one refuses the bitmap) and `bitmapWalk` applies pseudo-merges as git's cascade (`BitmapWalkResult.pseudoMergesSatisfied`). Older readers skip the section; rollback is a repack without the configuration.
