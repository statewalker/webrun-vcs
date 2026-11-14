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

To get a `RepositoryFacade` and `RefStore` for a VCS store, use [`@statewalker/vcs-transport-adapters`](../vcs-transport-adapters/README.md), or `createRepositoryFacade()` and `createTransportRefStore(history.refs)` from this package.

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
| `RefStore` | `get`, `update`, `listAll`, optional `getSymrefTarget`, `isRefTip`, `batch` |
| `createTransportRefStore(refs)` | the `RefStore` over a vcs-core `Refs`, with `batch` |
| `RepositoryAccess` | Object/ref access: `hasObject`, `getObjectInfo`, `loadObject`, `storeObject`, `listRefs`, `getHead`, `updateRef`, `walkObjects` |
| `TransportApi` | Pkt-line, sideband and pack I/O over a `Duplex` |
| `Credentials` | `{ username?, password?, token? }`. The HTTP operations send Basic auth: `token` as the password (username defaults to `x-access-token`), otherwise `username`/`password`. |

#### Adapters

| Export | Description |
|--------|-------------|
| `createMessagePortDuplex`, `messagePortFetch`, `messagePortServe` | MessagePort transport |
| `webrunClientDuplex`, `serveRepoOverWebrun` | Git protocol over a webrun-streams `Duplex` |
| `serveGitOverWebrunHttp`, `webrunHttpFetch` | Smart HTTP over a webrun-streams `Duplex` |
| `httpFetch`, `httpPush`, `createSimpleDuplex` | Low-level HTTP client helpers |
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

The HTTP operations do not write to a repository. `fetch` and `clone` return the remote refs (binary OIDs). Give them `onPack` and the pack is handed to you as it arrives, demultiplexed from the response body, so it can flow straight into vcs-core's `importPack` without ever being held whole; without `onPack` it is collected into `packData`.

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

// stream the pack into a repository instead of collecting it
await fetch({
  url: "https://example.com/user/repo.git",
  onPack: (pack) => history.serialization.importPack(pack).then(() => {}),
});

const cloned = await clone({ url: "https://example.com/user/repo.git", depth: 1 });
```

Common HTTP options (`BaseHttpOptions`): `url`, `auth` (`{ username, password }` or `{ token }`), `headers`, `timeout` (ms), and `fetchImpl` (a `(Request) => Promise<Response>` used instead of `globalThis.fetch`). `fetch` also accepts `depth`, `localHas`, `localCommits`, `onProgress`, `onProgressMessage` and `onPack`. `clone` accepts `branch`, `depth`, `onProgress`, `onProgressMessage` and `onPack`.

`fetch` sends wants, so it fails unless a pack comes back (git sends an empty pack, 32 bytes, when every wanted object is already present): a caller never writes refs to objects it did not receive. `httpFetch` and the fetch state machine refuse a missing pack the same way. When the import (or anything after the request) fails, the response body is cancelled. `timeout` bounds each wait for the server, a response or the next chunk of a body, not the whole fetch: the time `onPack` spends storing a large pack does not count, while a server that stops sending is still cut off.

The same demultiplexer is exported as `sidebandPackStream(body, { onProgress })`: it yields the channel-1 bytes of an upload-pack response as they arrive, skips the NAK, ACK and shallow lines and the flush packets, and throws `ServerError` on channel 3 and on an `ERR <message>` line. `httpFetch` and the fetch state machine import the pack this way too. The fetch request bodies (wants and haves) are still built in memory: they are small. A push streams its body (see below).

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

`exportPack` produces the pack: the objects reachable from the pushed tips and not from the remote's refs, as `history.serialization.exportPack` (vcs-core's `listObjects` and `writePack`) streams it. It is required whenever the push sends objects; a delete-only push sends git's empty pack. `push` also accepts `force` and `atomic`, and reports `bytesSent` and `objectCount` (read from the pack header as it goes by).

The commands and the pack go out in the POST body. Outside browsers (Node, Deno, Bun) the body is a `ReadableStream` with `duplex: "half"`, pulled as the connection takes it, so the pack writer runs no further ahead than the network and the pack is never collected. In browsers the body is collected and sent whole by default, which holds the pack in memory: Firefox and Safari do not stream request bodies, and Chromium passes the usual feature test (`supportsRequestStreams()`: a `Request` built with a stream body reads its `duplex` option and adds no `Content-Type`) yet rejects a streamed body with a `TypeError` over HTTP/1.1, which a page cannot know in advance. `shouldStreamRequestBody(streamRequestBody)` makes the choice: the option when it is set, otherwise stream only where `isBrowserContext()` is false (no `document` and no `WorkerGlobalScope` instance as the global) and streams are supported. `streamRequestBody: true` opts a browser in (for an HTTP/2 server); `false` always collects. When a streamed request is rejected with a `TypeError` before any response, `fetchWithRequestBody` sends it once more with a collected body, calling `exportPack` again (so it may run twice); an error from the pack itself is thrown as it is. `httpPush` sends its body the same way and takes the same `streamRequestBody` option. Both pass `{ ofsDelta }` to `exportPack`: true only when the receive-pack advertisement lists `ofs-delta` (the push then requests it, as git's send-pack does), so a server without it gets REF deltas; the push state machine does the same.

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

`handleUploadPack` streams its response: `HttpResponse.body` is then a `ReadableStream`, returned as soon as the negotiation starts writing, and each pack chunk waits until the reader took the previous one. A failure before the first byte is still a 500; after it, the error travels in band as `ERR <message>` on sideband channel 3 (protocol v0/v1 and the v2 `packfile` section), and without side-band, where raw pack bytes may be out, the response stream is aborted so the client sees a failure rather than a truncated pack that looks complete (as with a thrown error). While the pack is prepared (listing objects, reading headers, the delta search) and side-band is on, upload-pack sends git's keep-alive, an empty band-1 packet `0005\x01`, every `keepAliveMs` (default 5000, as git's `uploadpack.keepAlive`; 0 turns it off; `HttpServerOptions.keepAliveMs`, `ProcessConfiguration.keepAliveMs`) until the first pack byte, so proxies do not time the connection out; the fetch client skips these packets. `httpResponseToFetchResponse` passes a stream body through; a Node server should write it chunk by chunk and wait for `drain`. The pack follows the capabilities the client asked for in its first `want` line, and only those (possibly none), limited to the advertised ones: a thin pack only with `thin-pack`, OFS deltas only with `ofs-delta`, side-band only with `side-band-64k`. Capabilities on later `want` lines are ignored, and the advertised set is kept apart (`ProtocolState.advertisedCapabilities`). In protocol v2 these are arguments of the `fetch` command (`thin-pack`, `ofs-delta`, `no-progress`), and the packfile section is always side-band. Received packs (`handleReceivePack`, the push state machine) go through vcs-core's `importPack` as before.

Every writer in the transport awaits `Duplex.write`: a duplex may return a Promise to apply backpressure (the upload-pack response and `createGitSocketClient` do), or nothing when it has no flow control (the MessagePort and webrun adapters queue).

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

- **Receiving a push** (receive-pack), names must be valid refs under `refs/` (anything else, `HEAD` included, gets `ng <ref> funny refname`, as from git). A `RefStore` with `batch` gets git's ref transaction: an `atomic` push is one batch, so every ref changes or none does, and when any ref is refused every ref gets `ng <ref> atomic transaction failed` (`atomic push failure` when validation or a hook already rejected one); a plain push is one batch per ref. Each update checks the old id the client sent, so a ref that moved since the advertisement is refused (`ng <ref> failed to update ref`) instead of overwritten. A store whose batch answers `unsupported` for several refs, and a `RefStore` without `batch`, keep the older path: one `update` per ref, no old-value check, and a best-effort rollback for `atomic`.
- HTTP `fetch` and `clone` return raw pack bytes and binary OIDs; they do not import anything. The duplex operations do import into the given `RepositoryFacade` and update the `RefStore`.
- HTTP `fetch`, `push`, `clone` and `lsRemote` send Basic auth. With `auth.token`, the token is the password and the username is `auth.username`, defaulting to `x-access-token` (GitHub and GitLab accept any username with a token; Bitbucket expects `x-token-auth`, passed as `username`). Without a token they use `auth.username` and `auth.password`.
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
