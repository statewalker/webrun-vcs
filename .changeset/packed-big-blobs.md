---
"@statewalker/vcs-core": patch
---

Packed blobs above the pack reader's `maxObjectSize` (1 GiB) are read again: a whole entry's size comes from its header and its content streams, as git's `open_istream` streams a blob above `core.bigFileThreshold`. The limit still guards what a read must hold in memory: delta instructions, delta results and delta bases (statewalker/webrun-vcs#477).
