# 09-repository-access

## What it is

A runnable example that exposes an in-memory repository to the transport layer and fetches from it. It builds a server repository, inspects it through `RepositoryAccess` (object level) and `RepositoryFacade` (pack level), adapts its core `Refs` to the transport `RefStore` contract, then serves it with `serveOverDuplex` and fetches it into a second repository with `fetchOverDuplex` over a Node `MessageChannel`. Everything runs in one process; nothing touches disk or the network.

What you will learn:

- Creating `RepositoryAccess` from a `History` for object-level protocol operations
- Creating `RepositoryFacade` for pack import and export
- Adapting core `Refs` to the transport `RefStore` interface
- Serving with `serveOverDuplex` and fetching with `fetchOverDuplex`
- Wrapping a `MessagePort` as a transport `Duplex` with `createMessagePortDuplex`

It builds on [08-transport-basics](../08-transport-basics/).

## Layout

```
apps/examples/09-repository-access/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    └── main.ts          # All four steps in one file, plus the RefStore adapter
```

Data flow of step 4:

```
 server History ──> createVcsRepositoryFacade ──┐
 server Refs    ──> createRefStoreAdapter     ──┤ serveOverDuplex
                                                │      │ port1
                                     MessageChannel    │
                                                │      │ port2
 client History ──> createVcsRepositoryFacade ──┤ fetchOverDuplex
 client Refs    ──> createRefStoreAdapter     ──┘
```

## How to run it

Requires Node 24 and pnpm. From the repository root:

```bash
pnpm install
pnpm --filter @statewalker/vcs-example-09-repository-access start
```

`start` runs `tsx src/main.ts`. `typecheck` runs `tsc --noEmit`.

## The walk-through: four steps from a repository to a fetch

### Step 1: a server repository with one commit

The example sets up a memory-backed repository with a blob, a tree and a commit, then points `refs/heads/main` at the commit. `HEAD` is a symbolic ref to `refs/heads/main`.

```typescript
const serverHistory = createMemoryHistoryWithOperations();
await serverHistory.initialize();
await serverHistory.refs.setSymbolic("HEAD", "refs/heads/main");

const blobId = await serverHistory.blobs.store([
  encoder.encode("# Hello from Server\n\nThis file was served via transport."),
]);
const treeId = await serverHistory.trees.store([
  { mode: FileMode.REGULAR_FILE, name: "README.md", id: blobId },
]);
const commitId = await serverHistory.commits.store({
  tree: treeId,
  parents: [],
  author: { name: "Server", email: "server@example.com", timestamp: now, tzOffset: "+0000" },
  committer: { name: "Server", email: "server@example.com", timestamp: now, tzOffset: "+0000" },
  message: "Initial commit from server",
});
await serverHistory.refs.set("refs/heads/main", commitId);
```

Key APIs:
- `createMemoryHistoryWithOperations()`: in-memory `History` that also carries `serialization` and `delta`
- `history.blobs.store()`, `history.trees.store()`, `history.commits.store()`: object creation
- `history.refs.setSymbolic()`: symbolic ref (`HEAD` -> `refs/heads/main`)

### Step 2: RepositoryAccess answers per-object questions

`RepositoryAccess` is the object-level view protocol handlers use: existence, type and size, ref listing, and graph walks that yield raw content.

```typescript
const repoAccess = createVcsRepositoryAccess({ history: serverHistory });

const hasCommit = await repoAccess.hasObject(commitId);
const commitInfo = await repoAccess.getObjectInfo(commitId);
const headInfo = await repoAccess.getHead();

for await (const ref of repoAccess.listRefs()) {
  console.log(`${ref.name} -> ${ref.objectId.slice(0, 7)}`);
}

const typeNames = ["", "commit", "tree", "blob", "tag"];
for await (const obj of repoAccess.walkObjects([commitId], [])) {
  console.log(`${typeNames[obj.type]}: ${obj.id.slice(0, 7)} (${obj.content.length} bytes)`);
}
```

Key APIs:
- `createVcsRepositoryAccess({ history })`: adapter from a `History`
- `hasObject(id)`, `getObjectInfo(id)`: existence, and `{ type, size }` where `type` is a numeric `ObjectTypeCode`
- `getHead()`: `{ target }` of `HEAD`
- `listRefs()`: all refs, including `HEAD`
- `walkObjects(wants, haves)`: object graph traversal

### Step 3: RepositoryFacade works in packs, RefStore in plain strings

`RepositoryFacade` operates on pack streams, which is what the transport state machine produces and consumes. It needs the `History` and its `SerializationApi`.

```typescript
const serverFacade: RepositoryFacade = createVcsRepositoryFacade({
  history: serverHistory,
  serialization: serverHistory.serialization,
});
const serverRefStore: RefStore = createRefStoreAdapter(serverHistory.refs);

let packSize = 0;
for await (const chunk of serverFacade.exportPack(new Set([commitId]), new Set())) {
  packSize += chunk.length;
}

const allRefs = await serverRefStore.listAll();
```

Key APIs:
- `createVcsRepositoryFacade({ history, serialization })`
- `facade.exportPack(wants, exclude)`: pack as an async stream of chunks
- `facade.importPack(stream)`: the reverse, used by the client during fetch
- `facade.has(oid)`
- `RefStore.listAll()`: `[name, oid]` pairs; `RefStore.get(name)` and `RefStore.update(name, oid)`

The adapter is defined at the bottom of `main.ts`:

```typescript
function createRefStoreAdapter(refs: Refs): RefStore {
  return {
    async get(name: string): Promise<string | undefined> {
      const resolved = await refs.resolve(name);
      return resolved?.objectId;
    },
    async update(name: string, oid: string): Promise<void> {
      await refs.set(name, oid);
    },
    async listAll(): Promise<Iterable<[string, string]>> {
      const result: [string, string][] = [];
      for await (const entry of refs.list()) {
        if ("objectId" in entry && entry.objectId !== undefined) {
          result.push([entry.name, entry.objectId]);
        }
      }
      return result;
    },
  };
}
```

`get` resolves symbolic refs through `refs.resolve()`; `listAll` keeps only entries that carry an `objectId`, so symbolic refs such as `HEAD` are left out.

### Step 4: serve and fetch over a MessageChannel

`createMessagePortDuplex` turns each end of a `MessageChannel` into a `Duplex`. The server and client run concurrently under `Promise.all`; the client gets its own empty memory repository, facade and ref store.

```typescript
const { MessageChannel } = await import("node:worker_threads");
const { serveOverDuplex, fetchOverDuplex, createMessagePortDuplex } = await import(
  "@statewalker/vcs-transport"
);

const channel = new MessageChannel();
const serverDuplex = createMessagePortDuplex(channel.port1 as any);
const clientDuplex = createMessagePortDuplex(channel.port2 as any);

const [serveResult, fetchResult] = await Promise.all([
  serveOverDuplex({
    duplex: serverDuplex,
    repository: serverFacade,
    refStore: serverRefStore,
    service: "git-upload-pack",
  }),
  fetchOverDuplex({
    duplex: clientDuplex,
    repository: clientFacade,
    refStore: clientRefStore,
  }),
]);
```

Afterwards the example resolves `refs/heads/main` in the client repository, loads the commit and prints its message, then closes both ports.

Key APIs:
- `serveOverDuplex({ duplex, repository, refStore, service })`: returns a `ServeResult` with `success`
- `fetchOverDuplex({ duplex, repository, refStore })`: returns a `FetchResult` with `success` and `updatedRefs` (a `Map`)

### What the run prints

Commit ids differ on every run (see below). A real run:

```
=== Step 1: Create Server Repository ===

  Server commit: ad3fb07
  Server blob:   d632b85
  Server tree:   303b6d0

=== Step 2: Create RepositoryAccess ===

  hasObject(ad3fb07): true
  getObjectInfo: type=1 size=180
  getHead: target=refs/heads/main
  listRefs:
    HEAD -> ad3fb07
    refs/heads/main -> ad3fb07
  walkObjects (from commit, no exclusions):
    commit: ad3fb07 (180 bytes)
    tree: 303b6d0 (37 bytes)
    blob: d632b85 (56 bytes)
  Total objects walked: 3

=== Step 3: Create RepositoryFacade & RefStore ===

  facade.has(ad3fb07): true
  Exporting pack (wants=[commit], haves=[]):
    Pack size: 270 bytes
  RefStore.listAll():
    refs/heads/main -> ad3fb07

=== Step 4: Serve Over Duplex (MessagePort) ===

  Server result: success=true
  Client result: refs updated=1
  Client received commit: "Initial commit from server"

=== Summary ===
...
Example completed successfully!
```

## Why it is the way it is

### Two adapters, because the protocol works at two levels

`RepositoryAccess` is object-oriented: it answers "do you have X, what type is it, give me its bytes, walk from here". `RepositoryFacade` is pack-oriented: it exports and imports whole pack streams, which is the unit the transport state machine negotiates. A server uses the facade for pack transfer; the object-level view serves ref advertisement and inspection. Both are built from the same `History`, so they always agree.

### The RefStore adapter is inline

The transport layer depends on a minimal `RefStore` (`get`, `update`, `listAll`, plus optional `getSymrefTarget` and `isRefTip`) rather than on the core `Refs` with its symbolic refs and resolution chains. That keeps the transport package usable with any ref backend. `@statewalker/vcs-transport-adapters` does not export a `Refs`-to-`RefStore` adapter for a `History`, so the example writes the adapter itself; copy it.

### Any duplex works

`serveOverDuplex` and `fetchOverDuplex` only see a `Duplex`: an async iterable of `Uint8Array` with `write()` and an optional `close()`. A `MessageChannel` makes the full round trip testable in one process; the same calls work over a WebSocket or a WebRTC data channel.

## What will surprise you

- **Commit ids change every run.** The commit timestamp is `Date.now() / 1000`, so the commit id differs between runs; the blob and tree ids are stable.
- **`getObjectInfo` prints `type=1`, not `type=commit`.** `ObjectInfo.type` is a numeric `ObjectTypeCode` (1 commit, 2 tree, 3 blob, 4 tag). The walk output maps codes to names with a local `typeNames` array.
- **`listRefs()` shows `HEAD`, `RefStore.listAll()` does not.** The access layer resolves `HEAD`; the inline adapter drops entries without an `objectId`.
- **`as any` on the ports.** Node's `worker_threads` `MessagePort` is not the DOM `MessagePort` type that `createMessagePortDuplex` declares; the cast is needed to typecheck.
- **The process does not exit if ports stay open.** Setting `onmessage` keeps a Node `MessagePort` alive; the example calls `channel.port1.close()` and `channel.port2.close()` before finishing.
- **Fetch assumes `refs/heads/main` locally.** `fetchOverDuplex` resolves `options.localHead ?? "refs/heads/main"` in the client `RefStore` to choose haves. Here the client is empty, so it sends none.
- **Missing objects throw.** Loading an id that is not in the repository through the access adapter throws `Object not found: <id>`. Port errors are logged as `MessagePort error:`.

## Reference

### Commands

| Command | What it does |
|---------|--------------|
| `pnpm --filter @statewalker/vcs-example-09-repository-access start` | Runs `tsx src/main.ts` |
| `pnpm --filter @statewalker/vcs-example-09-repository-access typecheck` | Runs `tsc --noEmit` |

### API locations

| Interface / function | Location | Purpose |
|----------------------|----------|---------|
| `RepositoryFacade` | [api/repository-facade.ts](../../../packages/vcs-transport/src/api/repository-facade.ts) | Pack-level import/export interface |
| `RepositoryAccess` | [api/repository-access.ts](../../../packages/vcs-transport/src/api/repository-access.ts) | Object-level protocol operations |
| `RefStore` | [context/process-context.ts](../../../packages/vcs-transport/src/context/process-context.ts) | Transport ref storage contract |
| `serveOverDuplex` | [operations/serve-over-duplex.ts](../../../packages/vcs-transport/src/operations/serve-over-duplex.ts) | Serve Git requests over a duplex |
| `fetchOverDuplex` | [operations/fetch-over-duplex.ts](../../../packages/vcs-transport/src/operations/fetch-over-duplex.ts) | Fetch from a served repository |
| `createMessagePortDuplex` | [adapters/messageport/messageport-duplex.ts](../../../packages/vcs-transport/src/adapters/messageport/messageport-duplex.ts) | `MessagePort` as a `Duplex` |
| `createVcsRepositoryAccess` | [vcs-repository-access.ts](../../../packages/vcs-transport-adapters/src/vcs-repository-access.ts) | `RepositoryAccess` from a `History` |
| `createVcsRepositoryFacade` | [vcs-repository-facade.ts](../../../packages/vcs-transport-adapters/src/vcs-repository-facade.ts) | `RepositoryFacade` from a `History` |
| `Refs` | [history/refs/](../../../packages/vcs-core/src/history/refs/) | Core ref storage |
| `History` | [history/](../../../packages/vcs-core/src/history/) | Repository interface |

### Related examples

- [08-transport-basics](../08-transport-basics/): HTTP transport (ls-remote, clone, fetch)
- [10-custom-storage](../10-custom-storage/): building storage backends
- [WebRTC P2P sync demo](../../demos/webrtc-p2p-sync/): peer-to-peer synchronization
