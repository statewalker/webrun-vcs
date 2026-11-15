# 09-repository-facade

## What it is

A runnable example that exposes an in-memory repository to the transport layer and fetches from it. It builds a server repository, inspects it through the `History` API and a `RepositoryFacade`, round-trips a pack with `exportPack` and `importPack`, adapts its core `Refs` to the transport `RefStore` contract, then serves it with `serveOverDuplex` and fetches it into a second repository with `fetchOverDuplex` over a Node `MessageChannel`. Everything runs in one process; nothing touches disk or the network.

What you will learn:

- Creating `RepositoryFacade` for pack import and export
- Reading refs, including symbolic ones, through the `History` API
- Exporting a pack from one repository and importing it into another
- Adapting core `Refs` to the transport `RefStore` interface
- Serving with `serveOverDuplex` and fetching with `fetchOverDuplex`
- Wrapping a `MessagePort` as a transport `Duplex` with `createMessagePortDuplex`

It builds on [08-transport-basics](../08-transport-basics/).

## Layout

```
apps/examples/09-repository-facade/
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
pnpm --filter @statewalker/vcs-example-09-repository-facade start
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

### Step 2: the facade and the History API answer per-object questions

`RepositoryFacade` is the view the transport state machine uses. Besides packs it answers existence and size questions and walks commit ancestry for negotiation. It needs the `History` and its `SerializationApi`. Refs are read straight from the `History`.

```typescript
const serverFacade: RepositoryFacade = createVcsRepositoryFacade({
  history: serverHistory,
  serialization: serverHistory.serialization,
});

await serverFacade.has(commitId);
await serverFacade.getObjectSize?.(blobId);
for await (const oid of serverFacade.walkAncestors(commitId)) console.log(oid.slice(0, 7));

for await (const ref of serverHistory.refs.list()) {
  if (isSymbolicRef(ref)) console.log(`${ref.name} -> ${ref.target} (symbolic)`);
  else console.log(`${ref.name} -> ${ref.objectId?.slice(0, 7)}`);
}
```

Key APIs:
- `createVcsRepositoryFacade({ history, serialization })`
- `facade.has(oid)`, `facade.getObjectSize?.(oid)`: existence and size (`getObjectSize` is optional in the interface)
- `facade.walkAncestors(oid)`: commit ids, the start included
- `history.refs.list()` with `isSymbolicRef()`: all refs, `HEAD` as a symbolic ref

### Step 3: a pack round trip, and a RefStore in plain strings

`exportPack` streams the objects reachable from the wants as a pack; `importPack` stores such a stream. The example exports the commit, reads the 12-byte pack header (`PACK`, version, object count), imports the chunks into a scratch repository and checks that the commit, tree and blob arrived.

```typescript
const packChunks: Uint8Array[] = [];
for await (const chunk of serverFacade.exportPack(new Set([commitId]), new Set())) {
  packChunks.push(chunk);
}
const { signature, version, objectCount } = readPackHeader(packChunks);

const scratchFacade = createVcsRepositoryFacade({
  history: scratchHistory,
  serialization: scratchHistory.serialization,
});
const result = await scratchFacade.importPack(
  (async function* () {
    yield* packChunks;
  })(),
);
await scratchFacade.has(blobId); // true

const serverRefStore: RefStore = createRefStoreAdapter(serverHistory.refs);
const allRefs = await serverRefStore.listAll();
```

Key APIs:
- `facade.exportPack(wants, exclude)`: pack as an async stream of chunks
- `facade.importPack(stream)`: the reverse, used by the client during fetch; returns counts (`objectsImported`, `commitsImported`, ...)
- `RefStore.listAll()`: `[name, oid]` pairs; `RefStore.get(name)` and `RefStore.update(name, oid)`

The adapter at the bottom of `main.ts` wraps the shared one from `@statewalker/vcs-transport`:

```typescript
function createRefStoreAdapter(refs: Refs): RefStore {
  return createTransportRefStore(refs);
}
```

`get` resolves symbolic refs, `listAll` lists every ref with the id it resolves to (`HEAD` included), and `update` goes through `Refs.batch`.

### Step 4: serve and fetch over a MessageChannel

`createMessagePortDuplex` turns each end of a `MessageChannel` into a `Duplex`. The server and client run concurrently under `Promise.all`; the client gets its own empty memory repository, facade and ref store.

```typescript
// MessageChannel is the standard global (browsers, workers, Node); no node: import.
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

=== Step 2: Create RepositoryFacade ===

  facade.has(ad3fb07): true
  facade.getObjectSize(blob): 56 bytes
  facade.walkAncestors(commit):
    ad3fb07
  history.refs.list():
    HEAD -> refs/heads/main (symbolic)
    refs/heads/main -> ad3fb07

=== Step 3: Pack Round Trip & RefStore ===

  Exporting pack (wants=[commit], haves=[]):
    Pack size: 270 bytes
    Pack header: PACK v2, 3 objects
  Imported into a scratch repository: 3 objects (1 commit, 1 tree)
    scratch has commit ad3fb07: true
    scratch has tree 303b6d0: true
    scratch has blob d632b85: true
  RefStore.listAll():
    HEAD -> ad3fb07
    refs/heads/main -> ad3fb07

=== Step 4: Serve Over Duplex (MessagePort) ===

  Server result: success=true
  Client result: refs updated=2
  Client received commit: "Initial commit from server"

=== Summary ===
...
Example completed successfully!
```

## Why it is the way it is

### One facade, because the protocol works in packs

The transport state machine negotiates and transfers whole pack streams, so `RepositoryFacade` is the only repository view it needs: `exportPack` and `importPack` for the transfer, `has` and `walkAncestors` for negotiation, and a few optional methods for protocol V2 and server-side checks. Both directions stream: a pack is never assembled in memory by the facade. (This example collects the chunks only to replay them into the scratch repository.) Per-object questions that the facade does not answer go to the `History` directly.

### The RefStore adapter is inline

The transport layer depends on a minimal `RefStore` (`get`, `update`, `listAll`, plus optional `getSymrefTarget` and `isRefTip`) rather than on the core `Refs` with its symbolic refs and resolution chains. That keeps the transport package usable with any ref backend. `createTransportRefStore` from `@statewalker/vcs-transport` adapts a `Refs`; the example wraps it in a named helper so the step reads clearly.

### Any duplex works

`serveOverDuplex` and `fetchOverDuplex` only see a `Duplex`: an async iterable of `Uint8Array` with `write()` and an optional `close()`. A `MessageChannel` makes the full round trip testable in one process; the same calls work over a WebSocket or a WebRTC data channel.

## What will surprise you

- **Commit ids change every run.** The commit timestamp is `Date.now() / 1000`, so the commit id differs between runs; the blob and tree ids are stable.
- **`history.refs.list()` shows `HEAD` as symbolic, `RefStore.listAll()` as an id.** The core lists the ref as stored; the transport adapter resolves it.
- **The pack header counts objects, the import result counts more finely.** `importPack` reports commits and trees separately; blobs are in `objectsImported` only.
- **The client reports two updated refs.** The fetch updates `HEAD` and `refs/heads/main` in the client `RefStore`.
- **`as any` on the ports.** Under Node's type definitions the global `MessageChannel` is the `worker_threads` one, whose `MessagePort` is not the DOM `MessagePort` type that `createMessagePortDuplex` declares; the cast is needed to typecheck.
- **The process does not exit if ports stay open.** Setting `onmessage` keeps a Node `MessagePort` alive; the example calls `channel.port1.close()` and `channel.port2.close()` before finishing.
- **Fetch assumes `refs/heads/main` locally.** `fetchOverDuplex` resolves `options.localHead ?? "refs/heads/main"` in the client `RefStore` to choose haves. Here the client is empty, so it sends none.
- **Missing objects answer, not throw.** `facade.has()` returns `false` and `getObjectSize()` returns `null` for an id the repository lacks. Port errors are logged as `MessagePort error:`.

## Reference

### Commands

| Command | What it does |
|---------|--------------|
| `pnpm --filter @statewalker/vcs-example-09-repository-facade start` | Runs `tsx src/main.ts` |
| `pnpm --filter @statewalker/vcs-example-09-repository-facade typecheck` | Runs `tsc --noEmit` |

### API locations

| Interface / function | Location | Purpose |
|----------------------|----------|---------|
| `RepositoryFacade` | [api/repository-facade.ts](../../../packages/vcs-transport/src/api/repository-facade.ts) | Pack-level import/export interface |
| `RefStore` | [context/process-context.ts](../../../packages/vcs-transport/src/context/process-context.ts) | Transport ref storage contract |
| `serveOverDuplex` | [operations/serve-over-duplex.ts](../../../packages/vcs-transport/src/operations/serve-over-duplex.ts) | Serve Git requests over a duplex |
| `fetchOverDuplex` | [operations/fetch-over-duplex.ts](../../../packages/vcs-transport/src/operations/fetch-over-duplex.ts) | Fetch from a served repository |
| `createMessagePortDuplex` | [adapters/messageport/messageport-duplex.ts](../../../packages/vcs-transport/src/adapters/messageport/messageport-duplex.ts) | `MessagePort` as a `Duplex` |
| `createVcsRepositoryFacade` | [vcs-repository-facade.ts](../../../packages/vcs-transport-adapters/src/vcs-repository-facade.ts) | `RepositoryFacade` from a `History` |
| `Refs` | [history/refs/](../../../packages/vcs-core/src/history/refs/) | Core ref storage |
| `History` | [history/](../../../packages/vcs-core/src/history/) | Repository interface |

### Related examples

- [08-transport-basics](../08-transport-basics/): HTTP transport (ls-remote, clone, fetch)
- [10-custom-storage](../10-custom-storage/): building storage backends
- [WebRTC P2P sync demo](../../demos/webrtc-p2p-sync/): peer-to-peer synchronization
