---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

`extensions.compatObjectFormat` (statewalker/webrun-vcs#245). A repository with a compatibility object format opens (it was refused): every loose write keeps git's loose object map, `objects/loose-object-idx` (`<storage id> <compat id>` lines appended under `loose-object-idx.lock`; a quarantine keeps its own and merges it on commit), converting trees, commits and tags as git's object-file-convert.c and refusing, before anything is written, what git cannot map (`CompatObjectConversionError`, git's lines). As in git, packs get no map (index-pack writes `.idx` v2; git has no `.idx` v3), gc, repack and prune leave the file alone, and repack's `--unpack-unreachable` refuses an unmapped object (`unable to force loose object`). Ids translate through `GitObjects.compat` (`CompatObjects`: `toCompat`, `toStorage`, `readAsCompat`); `rev-parse --output-object-format`, `--show-object-format=compat` and `cat-file -t/-s/-p/-e/<type>` of a compatibility id follow git. New exports in vcs-store-files: `LooseObjectMap`, `withCompatWrites`, `createCompatObjects`, `convertObjectContent`, `compatObjectIdOf`; `RepositoryFormat.compatObjectFormat`.
