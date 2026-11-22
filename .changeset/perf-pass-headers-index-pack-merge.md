---
"@statewalker/vcs-core": patch
"@statewalker/vcs-store-files": patch
"@statewalker/vcs-commands": patch
---

**Performance pass: object headers without resolving deltas, one-pass inflate in index-pack, one merge-base walk per merge.**

- A packed object's type and size come from its entry headers, as git's `oid_object_info` reads them: a delta's size from the start of its instructions, its type from the whole entry at the bottom of its chain, nothing applied or cached (`PackFile.header`/`objectType`, `PackSet.header`/`objectType`, the optional `GitObjects.header`/`objectType`). `objectHeader`, `hasObjectOfType` (every typed store's `has`), `Blobs.size` and pack writing's planning read them before falling back to `get`, so checks such as a checkout's `has` before each blob, blame's size checks and the planning of a fetch's pack no longer resolve whole delta chains. A header that cannot answer (a REF_DELTA base outside the pack, an unreadable entry) leaves the object to `get`, which reports errors as before.
- index-pack inflates an entry whose zlib stream lies whole in the chunk at hand in one pass (`inflateWhole`) instead of through the streaming inflater, reads entry header bytes without an await per byte, and feeds the pack hash and the entry CRC in runs; phase 2 inflates re-read entries the same way. Streams that cross a chunk, fail or inflate to another size take the streaming path, which reports the same errors as before. A clone's or fetch's pack import is about 20% faster.
- `merge` decides "already up to date" and fast-forward from the merge bases it computes anyway (git's `cmd_merge`), instead of two ancestry walks that, without a commit-graph, read the whole history when the merged branch is not an ancestor.
