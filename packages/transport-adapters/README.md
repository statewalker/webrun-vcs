# @statewalker/vcs-transport-adapters

## What it is

Adapters that turn `@statewalker/vcs-core` stores into the interfaces `@statewalker/vcs-transport` runs on: `RepositoryFacade` (pack import/export, ancestry, reachability), the transport `RefStore`, and `RepositoryAccess` (object and ref level access). It also has helpers for the Git object wire format (`"<type> <size>\0<content>"`) and an object graph walker.

## Why it exists: the transport knows nothing about storage

`@statewalker/vcs-transport` speaks the Git protocol but never touches storage. It asks for a `RepositoryFacade` and a `RefStore`. This package is the bridge between those small interfaces and the `History`, `GitObjectStore` and `@statewalker/webrun-storage` stores of `@statewalker/vcs-core`. Keeping the bridge separate keeps the transport free of any storage dependency.

## How to use: choose an adapter by what you have

```bash
pnpm add @statewalker/vcs-transport-adapters
```

No peer dependencies. One entry point, `@statewalker/vcs-transport-adapters` (ESM, with type declarations).

| You have | Use | You get |
|----------|-----|---------|
| `BlobStore` + `KvStore` from `@statewalker/webrun-storage` | `createStorageRepositoryFacade({ objects, refs })` | `{ facade, refStore }` ready for fetch/push/serve |
| A `History` and a `SerializationApi` | `createVcsRepositoryFacade({ history, serialization })` | `RepositoryFacade` |
| A `History` | `createVcsRepositoryAccess({ history })` | `RepositoryAccess` |
| A `GitObjectStore` and a core `RefStore` | `createCoreRepositoryAccess({ objectStore, refStore })` | `RepositoryAccess` |
| A `GitObjectStore` only | `new GitNativeRepositoryAccess(objectStore)` | object-only access (no refs) |
| A store matching `MinimalStorage` | `createStorageAdapter(storage)` | `RepositoryAccess` |

Other exports:

| Export | Description |
|--------|-------------|
| `VcsRepositoryFacade`, `VcsRepositoryAccess` | The classes behind the two `createVcs*` factories |
| `DeltaAwareGitNativeRepositoryAccess` | `GitNativeRepositoryAccess` plus `isDelta`, `getDeltaBase`, `getChainDepth` from a `DeltaAwareStore` |
| `createObjectGraphWalker(objectStore)` | `walk(wants, haves)` yields every object reachable from `wants` and not from `haves`, once each |
| `createGitWireFormat`, `parseGitWireFormat` | Build and parse `"<type> <size>\0<content>"` bytes |
| `stringToObjectType`, `objectTypeToString` | Convert between `"commit"`/`"tree"`/`"blob"`/`"tag"` and type codes |

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

### RepositoryAccess for server code

```typescript
import { createVcsRepositoryAccess } from "@statewalker/vcs-transport-adapters";

const access = createVcsRepositoryAccess({ history });

for await (const ref of access.listRefs()) console.log(ref.name, ref.objectId);
const head = await access.getHead();
const ok = await access.updateRef("refs/heads/main", oldOid, newOid);
```

### Wire format

```typescript
import { createGitWireFormat, parseGitWireFormat } from "@statewalker/vcs-transport-adapters";

const bytes = createGitWireFormat("blob", new TextEncoder().encode("hello\n"));
const { type, body } = parseGitWireFormat(bytes); // type is the blob type code
```

## Internals

### Why there are two interfaces

`RepositoryFacade` works at the pack level: the protocol state machines only need to import a pack, export a pack for `wants`/`exclude`, test `has`, walk ancestors and answer reachability and shallow-boundary questions. `RepositoryAccess` works at the object and ref level (`loadObject`, `storeObject`, `listRefs`, `updateRef`) for server code that handles objects one by one. Most transport use needs only the facade.

### How the facades map onto vcs-core

- `VcsRepositoryFacade.exportPack` collects objects with `history.collectReachableObjects(wants, exclude)` and encodes them with `serialization.createPack`. Pack import goes through the `SerializationApi` too.
- `createStorageRepositoryFacade` builds the full stack from two byte stores: `blobStoreToRawStorage(objects)` feeds `createGitObjectStore`, `kvStoreRefs(refs)` provides refs, `createHistoryFromStores` composes a `History`, and `DefaultSerializationApi` handles packs. It returns the facade plus a transport `RefStore` over the same refs.
- `VcsRepositoryAccess.updateRef` uses the refs store's `compareAndSwap` when an old id is given, so concurrent updates fail instead of overwriting.
- `GitNativeRepositoryAccess` reads straight from a `GitObjectStore`, which already stores objects in wire format, so no re-serialization is needed.

### Constraints

- `createVcsRepositoryFacade` returns only a `RepositoryFacade`. This package exports no standalone adapter from a core `Refs` to the transport `RefStore`; `createStorageRepositoryFacade` is the only factory that returns one.
- `VcsRepositoryFacade.exportPack` ignores its `ExportPackOptions` (`thin`, `includeTag`, `filterSpec`, `shallow`), so packs are always full packs of the reachable set.
- `GitNativeRepositoryAccess` has no refs. Use `createCoreRepositoryAccess` when ref operations are needed.

### What failures look like

- Loading a missing object throws `Object not found: <id>`.
- Malformed wire-format bytes throw `Invalid Git object: no header null byte found`, `Invalid Git object header: no space separator`, or `Unknown object type: <type>`.
- An invalid type code throws `Unknown type code: <code>`.

### Dependencies

- `@statewalker/vcs-core`: `History`, object stores, refs, serialization and pack encoding.
- `@statewalker/vcs-transport`: the `RepositoryFacade`, `RefStore` and `RepositoryAccess` interfaces being implemented.
- `@statewalker/vcs-utils`: stream helpers (`collect`, `toArray`, `concat`).
- `@statewalker/webrun-storage`: the `BlobStore` and `KvStore` types used by `createStorageRepositoryFacade`.

### Commands

```bash
pnpm --filter @statewalker/vcs-transport-adapters test
```

## License

MIT
