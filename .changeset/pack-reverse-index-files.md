---
"@statewalker/vcs-core": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-commands": patch
---

**Pack reverse indexes (`.rev`), git 2.41+'s default.**

- **Written:** every pack index-pack installs (`installPack`'s new `writeReverseIndex`, `PackSet.install`: fetch, clone, receive-pack quarantines) and every pack repack and gc write gets `pack-<id>.rev` (RIDX version 1, byte-identical to git's for the same pack) while `pack.writeReverseIndex` is true, its default. It is renamed into place after the `.pack` and before the `.idx`, as git's `pack_copy_priority` orders them. `openPackSet` takes `writeReverseIndex` (default true) and `readReverseIndex`; `createGitFilesBackend` reads both from the config (`readPackSetSettings`), and repack re-reads `pack.writeReverseIndex` where it writes (`readPackWriteSettings`).
- **Read:** `PackFile.loadReverseIndex()` reads a present `.rev` (under `pack.readReverseIndex`, default true) with git's checks (size, signature, version, hash id) and uses it for the pack order when its positions follow the idx's offsets; otherwise the order is computed from the idx, as before. The pack set loads it before reading a pack's bitmap. `encodeReverseIndex`, `parseReverseIndex`, `ReverseIndexError`, `verifyReverseIndexFile` are exported from vcs-core.
- **fsck:** checks each pack's `.rev` as git's `verify_reverse_indices` (`invalid checksum`, `invalid rev-index position at ...`, `invalid rev-index for pack '...'`, `unable to load rev-index for pack '...'`): with 2.5x compatibility per object source after its packs (object bit), with 2.43's at the end of the walk before the bitmaps (`FSCK_ERROR_PACK_REV_INDEX_243`, 0100, `--connectivity-only` too).
