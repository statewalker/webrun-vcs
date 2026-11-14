---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-transport-adapters": patch
---

**Receive-pack applies pushes through `Refs.batch`, as git does in a ref transaction.** When the transport `RefStore` has the new optional `batch`:
- An `atomic` push is one batch: every ref changes or none does. Before, it was a sequence of writes with a best-effort rollback.
- A plain push is one batch per ref.
- Every update checks the old id the client sent. A ref moved since the advertisement is refused as `LOCK_FAILURE` ("failed to update ref (stale info)"); before, it was silently overwritten.

**New:** `createTransportRefStore(refs)` adapts a vcs-core `Refs`, `batch` included. vcs-transport-adapters' `createStorageRepositoryFacade` uses it.

**Fixed:** a push that deleted a ref through the adapter stored the zero id as the ref's value. It now removes the ref.
