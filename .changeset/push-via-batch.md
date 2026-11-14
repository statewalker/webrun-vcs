---
"@statewalker/vcs-transport": minor
"@statewalker/vcs-transport-adapters": patch
---

**Receive-pack applies pushes through `Refs.batch`, as git's receive-pack applies them in a ref transaction.** This happens when the transport `RefStore` has the new optional `batch`.
- **Atomic push:** it is one batch, so every ref changes or none does. Before, it was a sequence of writes with a best-effort rollback.
  - If the batch is refused, every ref gets `atomic transaction failed`.
  - If validation or a hook already rejected a ref, nothing is applied and the others get `atomic push failure` (previously the rest were applied).
  - A store whose batch answers `unsupported` for several refs (such as `kvStoreRefs`) keeps the one-by-one path.
- **Plain push:** it is one batch per ref.
- **Old values:** every update checks the old id the client sent. A ref moved since the advertisement is refused with `failed to update ref`, where before it was silently overwritten.
- **Failures:** a store failure is reported per ref instead of ending the session without a report.

**Changed:** receive-pack refuses ref names outside `refs/` (including `HEAD`) and invalid names with `funny refname`, as git does. It names refs directly and does not follow symbolic refs. The client maps `failed to update ref` to `LOCK_FAILURE`.

**New:** `createTransportRefStore(refs)` adapts a vcs-core `Refs`, including `batch`; its `listAll` also lists symbolic refs, such as `HEAD`, by their resolved ids. vcs-transport-adapters' `createStorageRepositoryFacade` uses it, as do the demo apps and test helpers, which used to carry their own copies.

**Fixed:** a push deleting a ref through these adapters no longer stores the zero id as the ref's value; the ref is removed.
