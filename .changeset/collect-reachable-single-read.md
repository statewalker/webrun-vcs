---
"@statewalker/vcs-core": patch
---

**`collectReachableObjects` and `Commits.load` read each object once.**

`History.collectReachableObjects` probed the typed stores one after another for every object: `has` on commits, trees, blobs and tags, then `load` as a commit, a tree and a tag, each of which read the object header again. A blob cost about ten reads, each a file open and an inflate on a file-backed repository. With an object kernel the walk now reads each object once, takes the type from its header and decodes the same stream; the objects yielded and their order are unchanged (a history without a kernel still probes the stores). `Commits.load` no longer checks `has` before loading, so loading a commit reads it once instead of twice, which also speeds up `walkAncestry`. Walking the 79-commit, 257-object loose fixture of the webrtc demo went from about 1560 file reads to about 510.
