---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

`git.repack()` follows git in more cases (statewalker/webrun-vcs#347). `--geometric` rolls promisor packs up the way each git version does (2.5x: a geometry of their own and a new promisor pack; 2.43: with the rest, and git's death with a promisor remote), keeps `--keep-pack` objects out even with `--pack-kept-objects`, warns `disabling bitmap writing` for `-l` with alternates, and names objects through pack-objects' `--stdin-packs` hint walk, so the `delta` attribute applies there. Delta-island marks propagate through commits of `.keep` packs (`DeltaIslandOptions.walkedCommits`), and the `delta` attribute is read in bare repositories (`info/attributes`). `--cruft` without `-d` and `--filter` without `-a` now run as git runs them instead of being refused. `RepackOptions.onWarning` receives the warnings of a geometric repack that writes no pack.
