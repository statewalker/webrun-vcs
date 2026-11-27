---
"@statewalker/vcs-store-files": patch
---

`repack` with nothing new to pack goes on as git's does: `-a -d` removes the replaced packs (loosening their unreachable objects under `--unpack-unreachable`), `--cruft` writes its cruft pack and `-d` prunes the loose objects already packed, instead of leaving everything in place (statewalker/webrun-vcs#389).
