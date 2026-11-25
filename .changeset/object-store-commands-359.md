---
"@statewalker/vcs-commands": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-utils": minor
"@statewalker/vcs-utils-node": minor
---

Object-store commands (statewalker/statewalker-root#359): `git.prune()` (`PruneCommand`, `git prune [-n] [-v] [--expire <time>] [<head>...]` without the rest of gc: the store's new `prune`, which keeps what gc's recent-object walk keeps, removes loose objects a pack holds, stale `tmp_*` files and unreached shallow commits), `git.countObjects()` (`CountObjectsCommand`, `-v` and `-H`, git's garbage warnings and index errors) and `git.showIndex()` (`ShowIndexCommand`, pack indexes of version 1 and 2, 64-bit offsets, git's deaths). `LinkStats.blocks` gives `st_blocks` (the Node FilesApi fills it), so sizes on disk match git's.
