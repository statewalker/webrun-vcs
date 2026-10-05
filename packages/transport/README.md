# @statewalker/vcs-transport

## What it is

Git transport protocol (wire protocol v1 and v2) built on finite state machines. It provides fetch, push, clone and ls-remote over smart HTTP, and fetch/push/serve over any bidirectional byte stream (MessagePort, `@statewalker/webrun-streams` channels, or your own). It uses Web platform APIs only (`fetch`, `Request`/`Response`, `MessagePort`, async iterables), so it runs in browsers, workers and Node.

## Why it exists: Git sync without a git binary or a socket

Browser and worker code cannot spawn `git` or open raw TCP sockets, yet repositories built with `@statewalker/vcs-core` still need to exchange objects with real Git servers and with each other. This package speaks the Git wire protocol directly over whatever channel is available: an HTTP `fetch`, a `MessagePort` between tabs or workers, or an in-process webrun-streams channel. The same client and server state machines serve every channel, so a peer-to-peer sync between two browser tabs uses exactly the code path that talks to a Git HTTP server.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design and [src/README.md](./src/README.md) for the FSM internals.

## How to use: pick a layer

The package has three layers:

1. **HTTP operations**: `fetch`, `push`, `clone`, `lsRemote` (smart-HTTP client).
2. **Duplex operations**: `fetchOverDuplex`, `fetchV2OverDuplex`, `pushOverDuplex`, `serveOverDuplex`, `p2pSync` (any `Duplex`).
3. **FSM primitives**: the `Fsm` engine and the client/server transition and handler tables.

### Install

```bash
pnpm add @statewalker/vcs-transport
```

No peer dependencies.

To get a `RepositoryFacade` and `RefStore` for a VCS store, use [`@statewalker/vcs-transport-adapters`](../transport-adapters/README.md), or `createRepositoryFacade()` from this package.

### Entry points

| Import path | Contents |
|-------------|----------|
| `@statewalker/vcs-transport` | Everything: operations, adapters, API interfaces, context, factories, FSMs, protocol, utils |
| `@statewalker/vcs-transport/protocol` | Wire format only: pkt-line codec, sideband, capabilities, ACK/NAK, report-status, request parser, constants, errors, protocol types |
| `@statewalker/vcs-transport/operations` | Operations only: `fetch`, `push`, `clone`, `lsRemote`, `fetchOverDuplex`, `fetchV2OverDuplex`, `pushOverDuplex`, `serveOverDuplex`, `p2pSync` |

All entry points are ESM with type declarations.

### API overview

#### Operations

| Function | Transport | Result |
|----------|-----------|--------|
| `fetch(options)` | HTTP | `HttpFetchResult`: `refs`, `packData`, `defaultBranch`, `bytesReceived`, `isEmpty` |
| `clone(options)` | HTTP | `CloneResult` (same shape as `HttpFetchResult`) |
| `push(options)` | HTTP | `HttpPushResult`: `ok`, `updates`, `unpackStatus`, `bytesSent`, `objectCount` |
| `lsRemote(url, options?)` | HTTP | `Map<refName, oidHex>` |
| `fetchOverDuplex(options)` | Duplex | `FetchResult` |
| `fetchV2OverDuplex(options)` | Duplex | `FetchResult` (protocol v2; adds `refPrefixes`, `peel`, `symrefs`) |
| `pushOverDuplex(options)` | Duplex | `PushResult` |
| `serveOverDuplex(options)` | Duplex | `ServeResult` |
| `p2pSync(options)` | Duplex | `P2PSyncResult` |

#### Core interfaces

| Interface | Description |
|-----------|-------------|
| `Duplex` | Async-iterable byte stream with `write(data)` and optional `close()` |
| `RepositoryFacade` | `importPack`, `exportPack`, `has`, `walkAncestors`, optional reachability helpers |
| `RefStore` | `get`, `update`, `listAll`, optional `getSymrefTarget`, `isRefTip` |
| `RepositoryAccess` | Object/ref access: `hasObject`, `getObjectInfo`, `loadObject`, `storeObject`, `listRefs`, `getHead`, `updateRef`, `walkObjects` |
| `TransportApi` | Pkt-line, sideband and pack I/O over a `Duplex` |
| `Credentials` | `{ username?, password?, token? }`. The HTTP operations use `username`/`password` only. |

#### Adapters

| Export | Description |
|--------|-------------|
| `createMessagePortDuplex`, `messagePortFetch`, `messagePortServe` | MessagePort transport |
| `webrunClientDuplex`, `serveRepoOverWebrun` | Git protocol over a webrun-streams `Duplex` |
| `serveGitOverWebrunHttp`, `webrunHttpFetch` | Smart HTTP over a webrun-streams `Duplex` |
| `httpFetch`, `httpPush`, `createHttpClientDuplex`, `createSimpleDuplex` | Low-level HTTP client helpers |
| `createFetchHandler`, `createHttpHandler`, `createGitHttpServer` | Smart-HTTP server |

#### Factories

| Function | Description |
|----------|-------------|
| `createRepositoryFacade({ history })` | `RepositoryFacade` from a `HistoryWithOperations` (`@statewalker/vcs-core`) |
| `createTransportApi(duplex, state)` | `TransportApi` from a `Duplex` and a `ProtocolState` |

#### FSM

| Export | Description |
|--------|-------------|
| `Fsm`, `FsmError` | Engine: `new Fsm(transitions, handlers)`, `fsm.run(context, ...stopStates)` |
| `clientFetchTransitions` / `clientFetchHandlers` | Client fetch (v1) |
| `serverFetchTransitions` / `serverFetchHandlers` | Server upload-pack (v1) |
| `clientPushTransitions` / `clientPushHandlers` | Client push |
| `serverPushTransitions` / `serverPushHandlers` | Server receive-pack |
| `clientV2Transitions` / `clientV2Handlers` | Protocol v2 client |
| `serverV2Transitions` / `serverV2Handlers` | Protocol v2 server |
| `errorRecoveryTransitions` / `errorRecoveryHandlers`, `withErrorRecovery`, `withErrorRecoveryHandlers`, `classifyError` | Error recovery |
| `ProtocolState`, `HandlerOutput`, `ProcessConfiguration`, `ProcessContext` | FSM context |

#### Protocol utilities

| Category | Exports |
|----------|---------|
| Pkt-line | `encodePacket`, `encodePacketLine`, `encodeFlush`, `encodeDelim`, `encodeEnd`, `parsePacket`, `pktLineReader`, `pktLineWriter`, `collectPackets` |
| Sideband | `demuxSideband`, `extractPackData`, `encodeSidebandPacket`, `SideBandOutputStream`, `SideBandProgressParser` |
| Capabilities | `parseCapabilities`, `formatCapabilities`, `negotiateCapabilities`, `hasMultiAck`, `hasSideband`, `hasThinPack`, `hasOfsDelta` |
| ACK/NAK | `parseAckNak`, `parseAckNakV2`, `formatAck`, `formatNak` |
| Report status | `parseReportStatus`, `parseReportStatusV2`, `parseReportStatusLines`, `formatPushResult`, `assertPushSuccess` |
| Requests | `parseGitProtocolRequest`, `readGitProtocolRequest`, `encodeGitProtocolRequest` |
| Errors | `TransportError`, `PackProtocolError`, `PacketLineError`, `ServerError`, `ConnectionError`, `AuthenticationError`, `RepositoryNotFoundError` |
| RefSpec | `parseRefSpec`, `formatRefSpec`, `matchSource`, `matchDestination`, `expandFromSource`, `expandFromDestination`, `isWildcard`, `defaultFetchRefSpec`, `defaultPushRefSpec` |
| URL | `parseGitUrl`, `formatGitUrl`, `toHttpUrl`, `resolveUrl`, `isRemote`, `getRepositoryName`, `getDefaultPort`, `getEffectivePort` |

Protocol constants (`PKT_FLUSH`, `CAPABILITY_*`, `ZERO_OID`, `SERVICE_UPLOAD_PACK`, and others) are exported too.

## Examples

### HTTP: list refs, fetch, clone

The HTTP operations do not write to a repository. `fetch` and `clone` return the remote refs (binary OIDs) and the raw pack bytes. Importing the pack is up to you, for example with `RepositoryFacade.importPack`.

```typescript
import { clone, fetch, lsRemote } from "@statewalker/vcs-transport";

const refs = await lsRemote("https://example.com/user/repo.git");
for (const [name, oid] of refs) console.log(name, oid);

const fetched = await fetch({
  url: "https://example.com/user/repo.git",
  refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
  auth: { username: "user", password: "secret" },
});
console.log(fetched.defaultBranch, fetched.bytesReceived, fetched.packData.length);

const cloned = await clone({ url: "https://example.com/user/repo.git", depth: 1 });
```

Common HTTP options (`BaseHttpOptions`): `url`, `auth` (`{ username, password }`), `headers`, `timeout` (ms), and `fetchImpl` (a `(Request) => Promise<Response>` used instead of `globalThis.fetch`). `fetch` also accepts `depth`, `localHas`, `localCommits`, `onProgress`, `onProgressMessage`. `clone` accepts `branch`, `depth`, `onProgress`, `onProgressMessage`.

### HTTP: push

```typescript
import { push } from "@statewalker/vcs-transport";

const result = await push({
  url: "https://example.com/user/repo.git",
  refspecs: ["refs/heads/main:refs/heads/main"],
  auth: { username: "user", password: "token" },
  getLocalRef: (ref) => refStore.get(ref),
  exportPack: (wants, exclude) => repository.exportPack(wants, exclude),
});

for (const [ref, status] of result.updates) {
  console.log(ref, status.ok ? "ok" : status.message);
}
```

`push` produces pack data with `exportPack` (preferred) or `getObjectsToPush`. It also accepts `force` and `atomic`.

### Smart-HTTP server

`createFetchHandler` returns a `(Request) => Promise<Response>` that serves `/info/refs`, `/git-upload-pack` and `/git-receive-pack`. It works with any Fetch-API server.

```typescript
import { createFetchHandler } from "@statewalker/vcs-transport";

const handleGit = createFetchHandler({
  async resolveRepository(repoPath) {
    // return null for unknown paths
    return { repository, refStore };
  },
});

// e.g. Deno.serve(handleGit) or Bun.serve({ fetch: handleGit })
```

Lower-level pieces are also exported: `createHttpHandler`, `createGitHttpServer`, `handleInfoRefs`, `handleUploadPack`, `handleReceivePackInfoRefs`, `handleReceivePack`, `parseGitRequest`, `fetchRequestToHttpRequest`, `httpResponseToFetchResponse`.

### Smart-HTTP without a network port

`serveGitOverWebrunHttp` wraps the server handler as a webrun-streams `Duplex`. `webrunHttpFetch` turns a webrun `Duplex` into a `fetchImpl`. For an in-process loopback, pass one to the other:

```typescript
import { lsRemote, serveGitOverWebrunHttp, webrunHttpFetch } from "@statewalker/vcs-transport";

const server = serveGitOverWebrunHttp({
  resolveRepository: async () => ({ repository, refStore }),
});
const refs = await lsRemote("http://localhost/repo.git", {
  fetchImpl: webrunHttpFetch(server),
});
```

### Fetch over a Duplex

`serveRepoOverWebrun` builds a webrun-streams handler that runs `serveOverDuplex`. `webrunClientDuplex` wraps a webrun caller as a transport `Duplex`. In-process:

```typescript
import { fetchOverDuplex, serveRepoOverWebrun, webrunClientDuplex } from "@statewalker/vcs-transport";

const handler = serveRepoOverWebrun({
  repository: sourceFacade,
  refStore: sourceRefStore,
  service: "git-upload-pack",
});

const result = await fetchOverDuplex({
  duplex: webrunClientDuplex(handler),
  repository: destFacade,
  refStore: destRefStore,
});
if (!result.success) throw new Error(result.error);
console.log(result.updatedRefs, result.objectsImported);
```

Over a `MessagePort`, wrap each end with `createMessagePortDuplex(port)`. Call `fetchOverDuplex` or `pushOverDuplex` on one side and `serveOverDuplex` on the other. `messagePortFetch(port, repository, refStore, options)` and `messagePortServe(port, repository, refStore, options)` do this in one call.

`serveOverDuplex` options: `duplex`, `repository`, `refStore`, `service` (`"git-upload-pack"` by default, or `"git-receive-pack"`), `allowDeletes`, `allowNonFastForward`, `denyCurrentBranch`, `currentBranch`, `capabilities`, `protocolVersion` (`"1"` or `"2"`; v2 applies to upload-pack only).

### Peer-to-peer sync

```typescript
import { p2pSync } from "@statewalker/vcs-transport";

const result = await p2pSync({
  localRepository: facade,
  localRefStore: refStore,
  remoteDuplex: duplex,
  direction: "bidirectional", // or "pull" / "push"
});
if (result.success) console.log(`Synced ${result.refsSynced} refs`);
```

## Internals

### Why every operation is a state machine

Each protocol role (client fetch, server upload-pack, client push, server receive-pack, v2 client and server) is a table of `[source, event, target]` transitions plus a map of state handlers. Handlers do one protocol step through `TransportApi` and return the next event. This keeps the protocol flow readable as data and lets tests drive single states. It also enables stop states: `fsm.run(context, "SOME_STATE")` pauses the machine, which is how the stateless smart-HTTP request/response pair maps onto one continuous protocol conversation. Error recovery is a separate transition table merged in with `withErrorRecovery`.

```
HTTP operations / Duplex operations
        |
        v
  Fsm (transitions + handlers)  <-- ProcessContext: transport, repository, refStore, state, output, config
        |
        v
  TransportApi (pkt-line, sideband, pack streams)
        |
        v
  Duplex (async-iterable bytes + write)
```

### Why storage stays outside

The transport never touches storage directly. It needs only a `RepositoryFacade` (pack import/export, `has`, ancestry walks) and a `RefStore`. That keeps the package independent of any backend; `@statewalker/vcs-transport-adapters` builds these from `@statewalker/vcs-core` stores.

### Constraints

- HTTP `fetch` and `clone` return raw pack bytes and binary OIDs; they do not import anything. The duplex operations do import into the given `RepositoryFacade` and update the `RefStore`.
- HTTP authentication is Basic auth from `auth.username` and `auth.password`. `Credentials.token` is accepted by the type but not sent by `fetch`, `push`, `clone` or `lsRemote`; pass a token as `password` or as an `Authorization` header in `headers`.
- `clone` accepts `bare` and `remoteName` in its options type but does not use them.
- `fetchOverDuplex` resolves `localHead` (default `refs/heads/main`) to pick negotiation haves and sends at most `maxHaves` (default 256).
- Pkt-lines are limited to 65520 bytes (`MAX_PACKET_SIZE`). Larger packets fail with `Packet too large: <n> bytes (max 65520)`.
- Protocol v2 is fetch-only. `serveOverDuplex` with `protocolVersion: "2"` and `service: "git-receive-pack"` runs the v1 push machine.

### What failures look like

- HTTP operations throw: `Failed to get refs: <status> <statusText>`, `Failed to upload-pack: ...`, `Failed to receive-pack: ...`, `Empty response from /info/refs`, `Request timeout` (when `timeout` elapses), `Server error: <message>` (an `ERR` packet or sideband error), and for `push`, `Local ref not found: <ref>`.
- Duplex operations do not throw on protocol failure. They return `{ success: false, error }`, with `error` set by the failing handler or `FSM did not complete successfully` (`V2 FSM did not complete successfully` for v2). `p2pSync` prefixes `Fetch failed:` or `Push failed:`.
- A broken custom transition table throws `FsmError`: `No handler for state: "<state>"` or `No transition for event "<event>" from state "<state>"`.

### Dependencies

- `@statewalker/vcs-core`: object, ref and history types; `createRepositoryFacade` builds on its `HistoryWithOperations`.
- `@statewalker/vcs-utils`: hashing and compression for pack handling.
- `@statewalker/webrun-streams`: the functional `Duplex` type used by the webrun adapters.
- `@statewalker/webrun-http-streams`: runs Fetch `Request`/`Response` over a webrun `Duplex` for the smart-HTTP-without-a-port adapter.

### Commands

```bash
pnpm --filter @statewalker/vcs-transport test        # tests in tests/
pnpm --filter @statewalker/vcs-transport test:bench  # performance benchmarks
```

Benchmark results: [tests-bench/performance-results.md](./tests-bench/performance-results.md).

## License

MIT
