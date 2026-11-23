---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
---

**repack and gc read pack-objects' `pack.*` settings.**

- `repack()` (and so `gc()`) reads `pack.window`, `pack.depth` (capped at 4095, as git), `pack.windowMemory` and `pack.deltaCacheSize` (0: no limit) into the delta search, and `pack.compression` (else `core.compression`) as the zlib level of the entries it writes (`readPackWriteSettings`, `packDeltaSearch`; `RepackOptions.packSettings` to pass them). An explicit `deltaSearch` object still wins. A value git refuses throws `PackConfigError` with git's message (`bad numeric config value ...`, `bad pack compression level ...`).
- `writePack` takes `compression` (-1 to 9): entries it deflates use that level (pako); entries copied as stored keep theirs, as git's do without `-F`.
- `pack.packSizeLimit` is read (`PackWriteSettings.packSizeLimit`) but has no effect: repack writes one pack, never splits it.
