---
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
---

`git repack --geometric` follows `repack.midxMustContainCruft=false` as git 2.5x: pack-objects' `--stdin-packs=follow` walk rescues once-cruft objects (packs above the split that no midx names are excluded-open), and the midx leaves cruft packs out where git does. `repack -l -m` with alternates warns as git, the midx gets a bitmap only for `-b`/`repack.writeBitmaps`, `--filter` with nothing new still writes its filtered pack after `Nothing new to pack.`, loose objects are listed in git's fan-out/readdir order, and `listObjects` takes `ignoreMissingLinks` (the `--stdin-packs` hint walk goes on past a partial clone's missing links).
