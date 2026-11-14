# @statewalker/vcs-transport-adapters

## What it is

Adapters that turn `@statewalker/vcs-core` stores into the interfaces `@statewalker/vcs-transport` runs on: `RepositoryFacade` (pack import/export, ancestry, reachability), and, for byte stores, the transport `RefStore`. Both pack directions stream: nothing here holds a whole pack or a whole object set in memory.

## Why it exists: the transport knows nothing about storage

`@statewalker/vcs-transport` speaks the Git protocol but never touches storage. It asks for a `RepositoryFacade` and a `RefStore`. This package is the bridge between those small interfaces and the `History`, `GitObjects` and `@statewalker/webrun-storage` stores of `@statewalker/vcs-core`. Keeping the bridge separate keeps the transport free of any storage dependency.

## How to use: choose an adapter by what you have

```bash
pnpm add @statewalker/vcs-transport-adapters
```

No peer dependencies. One entry point, `@statewalker/vcs-transport-adapters` (ESM, with type declarations).

| You have | Use | You get |
|----------|-----|---------|
| `BlobStore` + `KvStore` from `@statewalker/webrun-storage` | `createStorageRepositoryFacade({ objects, refs })` | `{ facade, refStore }` ready for fetch/push/serve |
| A `History` and a `SerializationApi` | `createVcsRepositoryFacade({ history, serialization })` | `RepositoryFacade` |

`VcsRepositoryFacade` is the class behind `createVcsRepositoryFacade`. For refs over a core `Refs`, use `createTransportRefStore(refs)` from `@statewalker/vcs-transport`.

## Examples

### Storage-backed repository for fetch and serve

```typescript
import { fetchOverDuplex, serveRepoOverWebrun, webrunClientDuplex } from "@statewalker/vcs-transport";
import { createStorageRepositoryFacade } from "@statewalker/vcs-transport-adapters";
import { memBlobStore, memKvStore } from "@statewalker/webrun-storage";

const source = createStorageRepositoryFacade({ objects: memBlobStore(), refs: memKvStore() });
const dest = createStorageRepositoryFacade({ objects: memBlobStore(), refs: memKvStore() });

const handler = serveRepoOverWebrun({
  repository: source.facade,
  refStore: source.refStore,
  service: "git-upload-pack",
});

const result = await fetchOverDuplex({
  duplex: webrunClientDuplex(handler),
  repository: dest.facade,
  refStore: dest.refStore,
});
```

### RepositoryFacade from a History

```typescript
import { DefaultSerializationApi } from "@statewalker/vcs-core";
import { createVcsRepositoryFacade } from "@statewalker/vcs-transport-adapters";

const serialization = new DefaultSerializationApi({ history });
const facade = createVcsRepositoryFacade({ history, serialization });

const exists = await facade.has(oid);
for await (const chunk of facade.exportPack(new Set([tipOid]), new Set())) {
  // pack bytes
}
```

## Internals

### Why there is one interface

`RepositoryFacade` works at the pack level: the protocol state machines only need to import a pack, export a pack for `wants`/`exclude`, test `has`, walk ancestors and answer reachability and shallow-boundary questions. Fetch, push and serve all run on it, and per-object questions go to the `History` directly.

### How the facades map onto vcs-core

- `VcsRepositoryFacade.exportPack` delegates to `serialization.exportPack(wants, exclude, options)`, which lists the reachable objects and streams a pack. Pack import goes through `serialization.importPack`.
- `createStorageRepositoryFacade` builds the full stack from two byte stores: `blobStoreToRawStorage(objects)` feeds `createGitObjects(rawStorageStaging(...))`, `kvStoreRefs(refs)` provides refs, `createHistoryFromStores` composes a `History` (with the object kernel as its `objects`), and `DefaultSerializationApi` handles packs. Received packs (a push, a fetch) are written through that kernel byte for byte, so a commit with a header the commit parser does not model, such as `mergetag`, keeps its id. It returns the facade plus a transport `RefStore` over the same refs.

### Constraints

- `createVcsRepositoryFacade` returns only a `RepositoryFacade`. For its refs, wrap the core `Refs` with `createTransportRefStore` from `@statewalker/vcs-transport`; `createStorageRepositoryFacade` returns both.
- `VcsRepositoryFacade.exportPack` passes `thin`, `shallow` and `ofsDelta` on to the `SerializationApi` and ignores `includeTag` and `filterSpec`.

### What failures look like

- `has()` returns `false` and `getObjectSize()` returns `null` for an object the repository lacks.

### Dependencies

- `@statewalker/vcs-core`: `History`, object stores, refs, serialization and pack encoding.
- `@statewalker/vcs-transport`: the `RepositoryFacade` and `RefStore` interfaces being implemented.
- `@statewalker/vcs-utils`: stream helpers (`toArray`).
- `@statewalker/webrun-storage`: the `BlobStore` and `KvStore` types used by `createStorageRepositoryFacade`.

### Commands

```bash
pnpm --filter @statewalker/vcs-transport-adapters test
```

## License

MIT
