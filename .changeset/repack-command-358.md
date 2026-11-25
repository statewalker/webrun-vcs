---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-core": minor
---

`git repack` as a command (statewalker/statewalker-root#358): `git.repack()` (`RepackCommand`) takes git's options (`-a`, `-A`, `-d`, `-l`, `-k`, `-f`, `-F`, `-b`, `-m`, `-n`, `-i`, `-q`, `--geometric`, `--cruft`, `--cruft-expiration`, `--max-cruft-size`, `--unpack-unreachable`, `--keep-pack`, `--pack-kept-objects`, `--filter`, `--window`, `--depth`) with their defaults from the configuration (`repack.updateServerInfo`, `repack.useDeltaIslands`). The store's `repack` gains `deleteRedundant` (`-d`), `keepUnreachable` (`-k`: unreachable packed and loose objects kept in the new pack, as 2.43 or 2.5x decides), `geometric` (`geometricRepack`, repack-geometry.c's split, with `--write-midx` the largest pack above the split preferred), `deltaIslands` (`pack.island`, `pack.islandCore`) and `noDelta` (the `delta` attribute). vcs-core adds `computeDeltaIslands` and `writePack`'s `islands` option and `PackObjectRef.noDelta`.
