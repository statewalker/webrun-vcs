---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": minor
---

**SHA-256 repositories read and write commit-graphs, multi-pack-indexes and bitmaps, as git does.**

- **Commit-graph (vcs-core):** single files and split chains in the repository's format: hash version 2, 32-byte ids in OIDL/CDAT/BASE, SHA-256 trailers and 64-digit chain lines and layer names, generation data (GDA2/GDO2) and Bloom filters (BIDX/BDAT) unchanged. `CommitGraphReadSettings.objectFormat` / `CommitGraphSettings.objectFormat` (a layer of another hash version is refused with git's `commit-graph hash version` message), `CommitGraphLayer.objectFormat`/`hashSize`/`dataWidth`, `CommitGraph.hashSize`, `graphDataWidth(raw)`/`graphMinSize(raw)`, `WriteCommitGraphFileOptions.objectFormat` (default: the objects'), `parseGraphCommit(data, id, format)`, `CommitGraphRepository.objectFormat` (replace refs and grafts of 64-digit ids). The bytes equal `git commit-graph write`'s and `git gc`'s.
- **Multi-pack-index (vcs-core):** `parseMultiPackIndex(..., { objectFormat })`, `encodeMultiPackIndex({ objectFormat })` (refuses ids of another width), `loadMultiPackIndex(..., { objectFormat })` (64-digit chain lines), `clearMultiPackIndexNaming(..., { objectFormat })`, `MultiPackIndex.objectFormat`; `RIDX`, `BTMP` and incremental chains as for SHA-1.
- **Bitmaps (vcs-core):** `parsePackBitmap`, `writePackBitmap` and `bitmapWalk` take the width of the header's pack checksum, the trailer and tree entries from the pack's format (`BitmapPack.objectFormat`, set by `openPack` as `Pack.objectFormat` and by `multiPackIndexBitmapPack`); a SHA-256 pack set reads the midx and bitmaps (`PackSet.multiPackIndex()`, `bitmap()`).
- **vcs-store-files:** the refusals of SHA-256 multi-pack-indexes (at open, in alternates, `multiPackIndexWrite`/`Verify`/`Expire`/`Repack`, `repack({ writeMidx })`), of bitmaps (`repack.writeBitmaps`, `-b`; a bare repository's default `-a` bitmap is now written, as git writes it) and of the commit-graph (`writeCommitGraph`; gc now writes the graph `git gc` writes) are lifted; `assertNoMultiPackIndexInFormat` and `removeCommitGraphFiles` are removed (gc and repack no longer delete a SHA-256 graph: gc rewrites it, as for SHA-1). `createFilesCommitGraphProvider({ objectFormat })`.
- **vcs-commands:** fsck verifies SHA-256 commit-graphs and multi-pack-indexes (and their bitmaps' checksums) as git's fsck does; `log` parses SHA-256 commit headers without falling back.
