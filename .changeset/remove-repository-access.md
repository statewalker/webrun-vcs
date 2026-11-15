---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-transport-adapters": minor
---

**Breaking: `RepositoryAccess` is removed.** Fetch, push and serve run on `RepositoryFacade`, whose `exportPack` and `importPack` stream; `RepositoryAccess` was on no live path and its implementations held whole objects in memory.

- **vcs-transport removals:** the `RepositoryAccess` interface and its `ObjectInfo`, `RefInfo` and `HeadInfo` types, plus the `ObjectId` and `ObjectTypeCode` re-exports that came with them (import those from `@statewalker/vcs-core`).
- **vcs-transport-adapters removals:**
  - `createVcsRepositoryAccess`, `VcsRepositoryAccess`, `VcsRepositoryAccessConfig`;
  - `createCoreRepositoryAccess`, `CoreRepositoryAccessOptions`, `GitNativeRepositoryAccess`, `DeltaAwareGitNativeRepositoryAccess`, `ObjectStoreAccess`, `DeltaAwareRepositoryAccess`, `DeltaAwareStore`, `RepositoryObjectInfo`, `ObjectData`;
  - `createStorageAdapter`, `MinimalStorage`;
  - `createObjectGraphWalker`, `ObjectGraphWalker`;
  - `createGitWireFormat`, `parseGitWireFormat`, `stringToObjectType`, `objectTypeToString`.
- **Migration:** use `createVcsRepositoryFacade({ history, serialization })` (or `createStorageRepositoryFacade`) for objects and packs, `createTransportRefStore(refs)` from `@statewalker/vcs-transport` for refs, and the `History` API for per-object reads.
