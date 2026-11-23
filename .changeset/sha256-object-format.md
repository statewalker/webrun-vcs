---
"@statewalker/vcs-utils": minor
"@statewalker/vcs-utils-node": minor
"@statewalker/vcs-core": minor
"@statewalker/vcs-working-tree": minor
"@statewalker/vcs-store-files": minor
"@statewalker/vcs-transport": minor
"@statewalker/vcs-commands": minor
---

**SHA-256 repositories open: their loose objects, trees, commits, tags and refs read and write with 64-hex ids.**

- **vcs-utils:** `ObjectFormat` (git's `struct git_hash_algo`): `SHA1_OBJECT_FORMAT` and `SHA256_OBJECT_FORMAT` with their raw and hex lengths, null id, empty tree and blob ids, signature header and hashers; `objectFormatByName`, `isHexObjectId`, `isNullObjectId`, `nullObjectIdLike`. `sha256()` is a one-shot SHA-256 on Web Crypto (the portable incremental hasher where there is none); `computeObjectId(type, content, format?)` hashes in the given format. `UnsupportedObjectFormatError` and `assertSha1ObjectFormat` refuse what has no SHA-256 path yet.
- **Worktrees:** `FileWorktree` and `MemoryWorktree` hash files in the repository's format by default (`Blobs.objectFormat`), so status, diff and checkout agree with the stored blobs in a SHA-256 repository.
- **vcs-core:** a store carries its format (`GitObjects.objectFormat`, `createGitObjects(store, { objectFormat })`, `History.objectFormat`, `objectFormatOf()`); trees are encoded and decoded with the format's id length (`decodeTreeBytes(…, { idLength })`, `TreeEntryCursor(bytes, idLength)`), commits sign with `gpgsig-sha256` in SHA-256 (`CommitSignatureHeader`), the empty tree is the format's, abbreviations reach 64 digits (`parseCoreAbbrev(value, hexLength)`), refs check direct values against the format (`isRefObjectId(value, format)`, `RefBatchView.objectFormat`, `createMemoryRefs({ objectFormat })`, `createMemoryHistory({ objectFormat })`), and reflogs write 64-zero null ids.
- **vcs-store-files:** `extensions.objectFormat = sha256` is no longer refused (`RepositoryFormat.objectFormat`); `createGitFilesBackend({ create: true, objectFormat })` writes `core.repositoryformatversion = 1` and `extensions.objectformat`. Refused with `UnsupportedObjectFormatError` until their tickets land: a SHA-256 repository holding packs (or a multi-pack-index) and every pack write into one, its index file (`FileStagingStore`, through `GitStagingOptions.objectFormat`), gc, repack and prune, and writing its commit-graph (which is not read either).
- **vcs-transport:** fetch, push and serving refuse a SHA-256 repository (`createRepositoryFacade`) until the protocols' `object-format` capability is implemented.
- **vcs-commands:** `init().setObjectFormat("sha256")`, `$GIT_DEFAULT_HASH` (`GitHostEnvironment.defaultHash`) and `init.defaultObjectFormat` choose a new repository's format; re-initialising with another one throws `ReinitializeHashError` ("attempt to reinitialize repository with different hash"), an unknown name `UnknownHashAlgorithmError`. `rev-parse --show-object-format` (`addArgument`, `showObjectFormat()`), full and abbreviated 64-hex revisions, `log`, `diff` (`--full-index` too), `fsck` and `notes` (fanned-out trees too) work in SHA-256 repositories; `gc` refuses them. Patch-ids, `format-patch`'s zero commit, porcelain v2 status, rebase's ref updates, `worktree list`, `apply` and submodule summaries use the repository's null and empty ids.
