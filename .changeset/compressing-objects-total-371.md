---
"@statewalker/vcs-core": patch
---

`writePack`'s "Compressing objects" total is pack-objects' `nr_deltas` (statewalker/webrun-vcs#371): every object of 50 bytes or more up to `core.bigFileThreshold` (git's 512 MiB unless `bigFileThreshold` is given) that is not a reused delta or `noDelta`, including objects too large for our delta search (counted as done when it ends), and it is shown only when git lists more than one object. The delta search itself is unchanged.
