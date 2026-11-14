---
"@statewalker/vcs-core": major
"@statewalker/vcs-store-files": major
"@statewalker/vcs-store-mem": major
"@statewalker/vcs-store-kv": major
"@statewalker/vcs-store-sql": major
"@statewalker/vcs-transport-adapters": major
"@statewalker/vcs-testing": major
---

**Breaking: every store reads and writes objects through the object kernel (`GitObjects`).**

Removed: `GitObjectStore`, `createGitObjectStore`, `GitObjectHeader`, `loadWithHeader`, `VolatileStore`, `MemoryVolatileStore`, `handleTypedContent` (vcs-core); `FileVolatileStore` / `createFileVolatileStore` (vcs-store-files); `createGitObjectStoreTests` and `createVolatileStoreTests` (vcs-testing). Replace `createGitObjectStore(raw)` with `createGitObjects(rawStorageStaging(raw))`, and for a `.git/objects` directory use `createGitObjects(filesStagingStore(files, objectsDir))`.

- `createBlobs`, `createTrees`, `createCommits`, `createTags` and `createHistoryFromComponents({ objects })` take a `GitObjects`; `createMemoryObjectStores`, `createKvObjectStores` and `createSqlObjectStores` return one as `objects`.
- `Blobs.store(content, size?)`: with a size, the blob is written in one pass without being buffered.
- `createGitFilesBackend` builds its objects as `withPacks(createGitObjects(filesStagingStore(...)), packDirectory)`: loose objects first, then packs; a raw object received while already packed is not written again (as JGit).
- `GitNativeRepositoryAccess` and `createObjectGraphWalker` take a `GitObjects`.
- Stored bytes: the memory, KV and SQL object stores (and the `BlobStore` behind `createVcsCore` and `createStorageRepositoryFacade`) now hold zlib loose objects, as `.git/objects` does. Data those stores persisted before is not readable; re-import from a git remote.
