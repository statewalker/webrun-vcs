# @statewalker/vcs-transport

## What it is

Git transport protocol (wire protocol v1 and v2) built on finite state machines. It provides fetch, push and ls-remote over smart HTTP, and fetch/push/serve over any bidirectional byte stream (MessagePort, `@statewalker/webrun-streams` channels, or your own). It uses Web platform APIs only (`fetch`, `Request`/`Response`, `MessagePort`, async iterables), so it runs in browsers, workers and Node.

## Why it exists: Git sync without a git binary or a socket

Browser and worker code cannot spawn `git` or open raw TCP sockets, yet repositories built with `@statewalker/vcs-core` still need to exchange objects with real Git servers and with each other. This package speaks the Git wire protocol directly over whatever channel is available: an HTTP `fetch`, a `MessagePort` between tabs or workers, or an in-process webrun-streams channel. The same client and server state machines serve every channel, so a peer-to-peer sync between two browser tabs uses exactly the code path that talks to a Git HTTP server.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design and [src/README.md](./src/README.md) for the FSM internals. [docs/transports.md](./docs/transports.md) is the guide to reaching remotes over HTTP, git://, ssh, a MessagePort, a WebSocket, libp2p or an httpeers mesh, with client and server examples for each.

## How to use: pick a layer

The package has three layers:

1. **HTTP operations**: `fetch`, `push`, `lsRemote` (smart-HTTP client).
2. **Duplex operations**: `fetchOverDuplex`, `pushOverDuplex`, `serveOverDuplex`, `p2pSync` (any `Duplex`).
3. **Fetch and push clients, FSM primitives**: the fetch client (`fetchFromConnection`, `fetchPack`, `Negotiator`, the HTTP and duplex connections), the push client (`pushToConnection`, `matchPushRefs`, `setPushStatus`, the HTTP and duplex receive-pack connections) and the `Fsm` engine with the server transition and handler tables.

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
| `@statewalker/vcs-transport/operations` | Operations only: `fetch`, `push`, `lsRemote`, `fetchOverDuplex`, `pushOverDuplex`, `serveOverDuplex`, `p2pSync` |

All entry points are ESM with type declarations.

### API overview

#### Operations

| Function | Transport | Result |
|----------|-----------|--------|
| `fetch(options)` | HTTP | `FetchClientResult`: `protocolVersion`, `remoteRefs`, `defaultBranch`, `isEmpty`, `refUpdates`, `followedTags`, `shallow`, `imports`, `packObjects`, `packBytes`, `stats` (throws on failure) |
| `push(options)` | HTTP | `PushClientResult`: `ok`, `updates` (each with git's status and summary), `unpack`, `capabilities`, `packObjects`, `packBytes`, `bytesSent` (throws on failure) |
| `lsRemote(url, options?)` | HTTP | `Map<refName, oidHex>` |
| `fetchOverDuplex(options)` | Duplex | `FetchResult`: `success`, `error`, `updatedRefs`, `objectsImported`, `report` (the `FetchClientResult`); v2 or v0, as the server speaks |
| `pushOverDuplex(options)` | Duplex | `PushResult`: `success`, `error`, `refStatus`, `report` (the `PushClientResult`) |
| `serveOverDuplex(options)` | Duplex | `ServeResult` |
| `p2pSync(options)` | Duplex | `P2PSyncResult` |

#### Core interfaces

| Interface | Description |
|-----------|-------------|
| `Duplex` | Async-iterable byte stream with `write(data)` and optional `close()` |
| `RepositoryFacade` | `importPack`, `exportPack`, `has`, `walkAncestors`, optional reachability helpers |
| `RefStore` | `get`, `update`, `listAll`, optional `getSymrefTarget`, `isRefTip`, `batch`, `getShallow`/`setShallow` (git's shallow file) |
| `createTransportRefStore(refs)` | the `RefStore` over a vcs-core `Refs`, with `batch` and the shallow file |
| `TransportApi` | Pkt-line, sideband and pack I/O over a `Duplex` |
| `Credentials` | `{ username?, password?, token? }`. The HTTP operations send Basic auth: `token` as the password (username defaults to `x-access-token`), otherwise `username`/`password`. |

#### Adapters

| Export | Description |
|--------|-------------|
| `createMessagePortDuplex`, `messagePortFetch`, `messagePortServe` | MessagePort transport |
| `webrunClientDuplex`, `serveRepoOverWebrun` | Git protocol over a webrun-streams `Duplex` |
| `serveGitOverWebrunHttp`, `webrunHttpFetch` | Smart HTTP over a webrun-streams `Duplex` |
| `createSimpleDuplex` | Low-level HTTP helper |
| `createFetchHandler`, `createHttpHandler`, `createGitHttpServer` | Smart-HTTP server |

#### Factories

| Function | Description |
|----------|-------------|
| `createRepositoryFacade({ history })` | `RepositoryFacade` from a `History` (`@statewalker/vcs-core`); its own `serialization` when it is a `HistoryWithOperations`, a `DefaultSerializationApi` otherwise |
| `createTransportApi(duplex, state)` | `TransportApi` from a `Duplex` and a `ProtocolState` |

#### FSM

| Export | Description |
|--------|-------------|
| `Fsm`, `FsmError` | Engine: `new Fsm(transitions, handlers)`, `fsm.run(context, ...stopStates)` |
| `serverFetchTransitions` / `serverFetchHandlers` | Server upload-pack (v1) |
| `serverPushTransitions` / `serverPushHandlers` | Server receive-pack |
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

### Fetch: one client, git's fetch-pack

`fetch` (smart HTTP) and `fetchOverDuplex` (any duplex) run the same client, the one vcs-commands' `FetchCommand` and `CloneCommand` use. It writes into a repository: the pack goes into `repository.importPack` as it arrives (never held whole), the refs into `refStore`.

```typescript
import { createRepositoryFacade, createTransportRefStore, fetch, lsRemote } from "@statewalker/vcs-transport";

const refs = await lsRemote("https://example.com/user/repo.git");

const result = await fetch({
  url: "https://example.com/user/repo.git",
  auth: { token: "…" },
  repository: createRepositoryFacade({ history }),
  refStore: createTransportRefStore(history.refs),
  refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
});
for (const u of result.refUpdates) console.log(u.summary, u.localRef); // [new branch] refs/remotes/origin/main
```

What it does, as git does it:

- **Protocol.** HTTP asks for v2 (`Git-Protocol: version=2`): `ls-refs` (`ref-prefix` from the refspecs, `symrefs`, `peel`, `unborn`), then stateless `fetch` rounds. A server that answers the v0 advertisement gets v0 (`protocolVersion: 0` forces it). Over a duplex the server speaks first and the client follows (`version 2` or a v0 advertisement).
- **Negotiation** (`Negotiator`, git's default negotiator): local ref tips are walked newest commit first; haves go in batches (16, then doubling; on a stateful v0 connection +32 past 32); an `ACK` makes the commit and its ancestors common (they are never offered); `done` when nothing is left, when the server is `ready`, or once 256 haves went unacknowledged after the first `ACK` (v0: without a new common commit). Stateless requests repeat the wants and the common commits. Remote tips already here are offered once (git's known-common). An incremental fetch therefore downloads only the new objects.
- **Shallow.** `refStore.getShallow()` is sent (`shallow <id>`); `depth`, `deepenRelative`, `deepenSince`, `deepenNot` and `unshallow` ask for a cut; the server's `shallow`/`unshallow` answer is written with `refStore.setShallow(after, before)` once the pack is in, refused when the shallow commits changed meanwhile (git's check_shallow_file_for_update). A store without `setShallow` refuses shallow fetches.
- **Completeness.** A want is skipped, and a remote tip offered as known-common, only when it is reachable from the local refs (git's `mark_complete`), not merely present: an interrupted fetch leaves commits behind without their trees and blobs, and the next fetch asks for them again.
- **Tags** (`tags`: `auto` default, `all`, `none`). `auto` (only when a refspec has a destination, as git's autotags: fetching `HEAD` or `main` alone creates no tag) asks for `include-tag` and creates the remote tags whose objects are here; tags of fetched objects whose tag objects did not come (a server that ignores `include-tag`, like ours) are fetched in a second request.
- **Refspecs.** An exact source the remote does not have fails the fetch (`couldn't find remote ref <src>`) unless `missingRefsOk` (configured refspecs) or the remote is empty. A `RefspecResolver` (`{ prefixes, resolve(remoteRefs) }`) picks the refspecs once the remote refs are listed: a clone of the remote HEAD's branch, or a tag.
- **Refs.** Each update is `new`, `up-to-date`, `fast-forward`, `forced` (a `+` refspec, or `force`) or `rejected` (`non-fast-forward`, `would clobber existing tag`, or the ref store's refusal), with git's summary (`[new branch]`, `abc1234..def5678`, `+ abc1234...def5678`, `[rejected]`). Each ref is written in its own `refStore.batch` transaction with its old value checked (`atomic`: one for all); a rejected ref does not stop the others. `dryRun` negotiates and reads the pack but stores nothing.

`fetch` throws on transport and protocol errors (HTTP status, `ERR`, a missing pack: wants were sent, so a pack must follow, an empty one when everything is here). `timeout` bounds each wait for the server, not the whole fetch. `fetchOverDuplex` never throws: it returns `success: false` with the error, or `success: true` with `updatedRefs`, `objectsImported` and the full `report`.

The pieces are exported for other transports: `openHttpConnection`, `openDuplexConnection` (an `UploadPackConnection`), `fetchFromConnection` (the whole fetch), `fetchPack` (negotiation and pack), `lsRefs`, `mapRefs`, `planRefUpdates`, `applyRefUpdates`, `PktStream`, `readSidebandPack`. `sidebandPackStream(body, { onProgress })` demultiplexes a whole upload-pack response body.

### HTTP: push

```typescript
import { push } from "@statewalker/vcs-transport";

const result = await push({
  url: "https://example.com/user/repo.git",
  auth: { username: "user", password: "token" },
  repository, // the local objects (a RepositoryFacade)
  refStore, // the local refs
  refspecs: ["main", "+topic:refs/heads/review", ":refs/heads/old", "refs/tags/*:refs/tags/*"],
});

for (const u of result.updates) console.log(u.summary, u.remoteRef);
// [new branch] refs/heads/main
// [rejected] (fetch first) refs/heads/review
// [deleted] refs/heads/old
```

`push` is the push client, git's send-pack (transport.c, remote.c, send-pack.c), over smart HTTP; `pushOverDuplex` runs the same client over a duplex. It reads the receive-pack advertisement, maps the refspecs onto the remote refs as `git push` does (`matchPushRefs`), decides each ref (`setPushStatus`), sends the commands and a thin pack, and reads the report:

- **Refspecs.** `src:dst`, `src` (to its own name), `+` to force, `:dst` to delete, `^src` to exclude; `src` may be a short name, `HEAD`/`@`, or any revision (`main~1`, `HEAD^`, `v1^{}`, `main^{tree}`, an abbreviated id: `resolveRevision`, with the facade's `resolvePrefix` for abbreviated ids) with a full or existing `dst`. A short `dst` names a remote ref the remote has; a new ref needs its full name unless the source is a branch or a tag (`main:topic` creates `refs/heads/topic`; otherwise git's "The destination you provided is not a full refname" error). Patterns push every matching local ref (a pattern wins over `:` for the refs it matches; two explicit refspecs for one remote ref are git's "dst ref … receives from more than one src"): `refs/heads/*:refs/heads/*` is `--all`, `refs/tags/*:refs/tags/*` `--tags`, `+refs/*:refs/*` with `prune: true` `--mirror`; `:` pushes the branches the remote has ("matching"). `prune` deletes the remote refs a pattern's destination (its source, without a colon) or `:` (branches) covers whose local source is gone. git's `push.default` (what a bare `git push` pushes) is the caller's: `PushCommand` pushes the configured `remote.<name>.push` refspecs, else follows `push.default` (`simple` by default, `current`, `upstream`, `matching`, `nothing`). A refspec error (a source that matches nothing, an ambiguous name, two sources for one ref) throws a `PushRefspecError` before anything is sent.
- **Statuses** are named after git's: `ok`, `up-to-date`, `rejected-fetch-first` (the remote has a commit that is not here), `rejected-nonfastforward` (it is here, and no ancestor of the new value), `rejected-needs-force` (either end is no commit), `rejected-already-exists` (a tag), `rejected-stale` (a `forceWithLease` whose expected value is not the remote's), `rejected-nodelete` (no `delete-refs`), `atomic-push-failed`, `remote-rejected` (the server's `ng`, with its `message`), `remote-failure` (not reported). Each update carries git's status column as `summary` (`[new branch]`, `abc1234..def5678`, `+ abc1234...def5678 (forced update)`, `[rejected] (fetch first)`, `[remote rejected] (hook declined)`). `force` (or `+`) turns a local refusal into a forced update; a lease that holds forces too, a stale one refuses unless `force` is set; a lease value may be a revision, and an entry without `ref` covers every pushed ref the others do not name (at `trackingValue`). Refused refs are not sent; with `atomic` one refusal refuses all and nothing is sent.
- **The request.** The commands carry the remote's advertised values as old ids. The client asks only for advertised capabilities: `report-status`, `side-band-64k`, `quiet` (with `quiet: true`), `atomic`, `push-options`, `object-format`, `agent`; asking for `atomic` or `pushOptions` the server does not advertise throws. The pack holds what the new values reach and no advertised tip that is here does (`.have` lines included), thin unless the server says `no-thin` or `thin: false`, with OFS deltas when the server says `ofs-delta`. A shallow repository (`refStore.getShallow`) sends its `shallow` lines first and a pack cut there. A push of deletes only sends no pack; a push with nothing to update sends no request (over a duplex, the flush that ends receive-pack). `dryRun` decides and reports, and sends nothing.
- **The report** is read as it arrives: side-band channel 2 goes to `onProgress`, keep-alives (empty channel-1 packets) are skipped, channel 3 throws. `unpack` is the server's unpack status; a report without it, or with a line that is not `ok`/`ng`, leaves the refs it did not report as `remote-failure` (git's `[remote failure]`), and an `ng` without a reason reads `failed`, as git.

The pieces are exported for other transports: `openHttpReceivePackConnection`, `openDuplexReceivePackConnection` (a `ReceivePackConnection`), `pushToConnection`, `matchPushRefs`, `setPushStatus`, `pushSummary`. A 401 or 403 is an `AuthenticationError`.

The commands and the pack go out in the POST body. Outside browsers (Node, Deno, Bun) the body is a `ReadableStream` with `duplex: "half"`, pulled as the connection takes it, so the pack writer runs no further ahead than the network and the pack is never collected. In browsers the body is collected and sent whole by default, which holds the pack in memory: Firefox and Safari do not stream request bodies, and Chromium passes the usual feature test (`supportsRequestStreams()`: a `Request` built with a stream body reads its `duplex` option and adds no `Content-Type`) yet rejects a streamed body with a `TypeError` over HTTP/1.1, which a page cannot know in advance. `shouldStreamRequestBody(streamRequestBody)` makes the choice: the option when it is set, otherwise stream only where `isBrowserContext()` is false (no `document` and no `WorkerGlobalScope` instance as the global) and streams are supported. `streamRequestBody: true` opts a browser in (for an HTTP/2 server); `false` always collects. When a streamed request is rejected with a `TypeError` before any response, `fetchWithRequestBody` sends it once more with a collected body, calling `exportPack` again (so it may run twice); an error from the pack itself is thrown as it is. `timeout` is an idle timeout on the server: it bounds each wait for the server, is paused while the pack is produced here (listing objects, the delta search), and re-armed each time a chunk waits for the request to take it, so neither a large pack nor a slow local pack times out, while a server that stops reading or answering does. `pushOverDuplex` takes `timeout` and `signal` too; an already-aborted `signal` sends nothing.

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

Lower-level pieces are also exported: `createHttpHandler`, `createGitHttpServer`, `handleInfoRefs`, `handleInfoRefsV2`, `handleUploadPack`, `handleUploadPackV2`, `handleReceivePackInfoRefs`, `handleReceivePack`, `parseGitRequest`, `requestsProtocolV2`, `isProtocolV2Request`, `fetchRequestToHttpRequest`, `httpResponseToFetchResponse`.

The handler speaks protocol v2 to clients that ask for it, as git's http-backend does. `git -c protocol.version=2 clone http://…` (the default since git 2.26) sends `Git-Protocol: version=2` (a `:`-separated list of `key=value`; `requestsProtocolV2` reads it):

**Which objects a client may fetch by id.** As git, a v0/v1 client may ask only for the advertised ref ids, and a v2 client for any object the repository has; only a missing one is refused, `ERR upload-pack: not our ref <oid>`. `requestPolicy` changes that for every server (`serveOverDuplex`, `createHttpHandler`, `createGitHttpServer`, `createFetchHandler`, `handleUploadPack`/`handleUploadPackV2`), for both protocol versions; its values follow git's `uploadpack.*` settings:

| `requestPolicy` | Served by id | git |
| --- | --- | --- |
| (default) | v0/v1: `"ADVERTISED"`; v2: `"ANY"` | its defaults |
| `"ADVERTISED"` | the advertised ref ids | v0 default |
| `"TIP"` | ref tips, hidden ones too | `uploadpack.allowTipSHA1InWant` |
| `"REACHABLE_COMMIT"` | the tips and the commits they reach | `uploadpack.allowReachableSHA1InWant` |
| `"REACHABLE_COMMIT_TIP"` | both | both settings |
| `"ANY"` | any object it has | `uploadpack.allowAnySHA1InWant`, and git's v2 always |

```ts
// refuse objects no branch or tag reaches, over v2 as well: a refused push's leftovers,
// history a ref was rewound past
createFetchHandler({ resolveRepository, requestPolicy: "REACHABLE_COMMIT" });
```

git's v2 upload-pack ignores the `uploadpack.allow*` settings (its `parse_want` refuses only a missing object), so a v2 policy stricter than `"ANY"` is an extension of ours.

```
GET  /repo.git/info/refs?service=git-upload-pack   →  version 2, agent=…, ls-refs=unborn,
                                                       fetch=shallow wait-for-done, …, flush
POST /repo.git/git-upload-pack  command=ls-refs     →  <oid> HEAD symref-target:refs/heads/main, …, flush
POST /repo.git/git-upload-pack  command=fetch       →  acknowledgments … ready, shallow-info, packfile (side-band, streamed)
```

As git's http-backend, the v2 advertisement has no `# service=git-upload-pack` preamble (only v0 has one), and every info/refs and rpc response, v0 and v2, carries git's no-cache headers (`NO_CACHE_HEADERS`: `Expires: Fri, 01 Jan 1980 00:00:00 GMT`, `Pragma: no-cache`, `Cache-Control: no-cache, max-age=0, must-revalidate`). The `Git-Protocol` entries are split on `:` exactly, with no trimming (`foo : version=2` is v0, as for git). A request is parsed as git's `serve.c` does: `command=` must name an advertised command exactly (`command=ls-refsX` is `invalid command 'ls-refsX'`), capability lines may come before or after it, an `object-format=` other than the server's is refused (`mismatched object format: server sha1; client sha256`), and only the first command of a POST runs (git's `--stateless-rpc`). `ls-refs=unborn` is advertised: with `symrefs` and `unborn`, an empty repository (or any unborn HEAD) is listed as `unborn HEAD symref-target:refs/heads/<branch>`, so `git clone` of an empty repository checks out the server's branch. `object-info` is neither advertised nor served by default, as git since 2.45 without `transfer.advertiseObjectInfo` (a request for it is `invalid command 'object-info'`); `advertiseObjectInfo: true` advertises `object-info=size type` (as git 2.56; only the attributes the repository facade can answer, none without `getObjectSize`/`getObjectType`) and answers as git does: the attribute lines asked for (`size`, `type`), then a line per requested oid in order (`<oid> <size> <type>` with the attributes asked for, or `<oid> ` for an object the server does not have), and an `ERR` line for an argument that is not an oid. Where git's upload-pack dies before writing anything (an invalid command, a mismatched object format, a malformed request), http-backend answers an empty `200`; this handler answers `500` with git's message instead.

Each POST runs one command (`ls-refs`, `fetch` or `object-info`) through the v2 server state machine from a fresh state: the negotiation is stateless, every `fetch` round carries all the client's haves, and the server answers `ready` with the pack once each want reaches a common commit. The request body goes through the same gzip decoding and `maxRequestBodyBytes` limit as v0 and is read whole before the command runs; the pack streams. Requests without the header get protocol v0, and receive-pack is always v0 (git has no v2 push). `protocolV2: false` serves v0 to everyone; `v2Capabilities` replaces the advertised capabilities (`advertiseObjectInfo` still adds `object-info` to them). In v0 the handler advertises what upload-pack implements for the repository (`defaultUploadPackCapabilities`), so `git fetch --deepen` works there too.

`handleUploadPack` streams its response: `HttpResponse.body` is then a `ReadableStream`, returned as soon as the negotiation starts writing, and each pack chunk waits until the reader took the previous one. A failure before the first byte is still a 500; after it, the status is out and every failure still reaches the client: on sideband channel 3 as `ERR <message>` inside a side-band pack (protocol v0/v1 and the v2 `packfile` section), otherwise as an `ERR <message>` pkt-line (an `ls-refs` or `object-info` that fails half way, for example), and without side-band, where raw pack bytes may be out, or when the state machine throws, the response stream is aborted, so the client never takes a truncated answer for a complete one. The pack goes in band-1 packets as full as the side-band allows (65515 payload bytes with side-band-64k), whatever the chunking of `exportPack`; a partial packet is sent when `exportPack` stalls for `keepAliveMs`. While the pack is prepared (listing objects, reading headers, the delta search) and side-band is on, upload-pack sends git's keep-alive, an empty band-1 packet `0005\x01`, every `keepAliveMs` (default 5000, as git's `uploadpack.keepAlive`; 0 turns it off; `HttpServerOptions.keepAliveMs`, `ProcessConfiguration.keepAliveMs`) until the first pack byte, so proxies do not time the connection out; the fetch client skips these packets. `httpResponseToFetchResponse` passes a stream body through; a Node server should write it chunk by chunk and wait for `drain`, and cancel the body's reader when the response closes early (`res.on("close")` before the body ended: the client disconnected), so the pack source is finalized instead of left waiting on a dead socket. The pack follows the capabilities the client asked for in its first `want` line, and only those (possibly none), limited to the advertised ones: a thin pack only with `thin-pack`, OFS deltas only with `ofs-delta`, side-band only with `side-band-64k`. Capabilities on later `want` lines are ignored, and the advertised set is kept apart (`ProtocolState.advertisedCapabilities`). In protocol v2 these are arguments of the `fetch` command (`thin-pack`, `ofs-delta`, `no-progress`), and the packfile section is always side-band. Received packs (`handleReceivePack`, the push state machine) go through vcs-core's `importPack` as before.

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

`serveOverDuplex` returns `success: false` when a pack failed part way. With side-band the client was told in band (`ERR` on band 3); without it, a `Duplex` has no abort, so the caller should close the duplex with an error rather than end it normally (the pack's trailer checksum still catches a truncated pack on the client).

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

`serveOverDuplex` options: `duplex`, `repository`, `refStore`, `service` (`"git-upload-pack"` by default, or `"git-receive-pack"`), `allowDeletes`, `allowNonFastForward`, `denyCurrentBranch`, `currentBranch`, `capabilities`, `protocolVersion` (`"1"` or `"2"`; v2 applies to upload-pack only), and for receive-pack `hooks`, `maxCommands`, `keepAliveMs`, `idleTimeoutMs`, `bare`, `denyDeleteCurrent`, `shallowUpdate`, `logger`.

### Receiving pushes

```typescript
const handleGit = createFetchHandler({
  resolveRepository,
  receivePack: {
    hooks: {
      // before the pack is read: a refusal of the whole push is a 403, the body unread
      authorize: (commands, ctx) =>
        ctx.request?.headers.authorization === `Bearer ${token}` || "permission denied",
      // once per ref: "ng <ref> hook declined" for this ref only (all of them when atomic)
      update: (refName) => (refName === "refs/heads/release" ? "release is frozen" : undefined),
      // after the report went out, detached: it cannot change the outcome
      postReceive: (commands) => notifyCi(commands),
    },
    maxCommands: 1000,
  },
});
```

receive-pack follows git's `receive-pack.c`. The order is: read the commands (and a shallow client's `shallow` lines) and push options, `authorize`, read and import the pack, check connectivity, `preReceive`, check each command (git's `update()`, then the `update` hook), apply the refs in a ref transaction, write the report, start `postReceive`. The connectivity check (`checkConnectivity`, git's `check_connected`) walks from every new tip down to what the existing refs reach and verifies that each commit, tree, blob and tag it names is present; a tip that fails gets `ng <ref> missing necessary objects` while the other refs go on. It needs the facade's `getObjectType`, `getTreeEntries`, `getTagInfo` and `CommitGraphInfo.tree` (`createRepositoryFacade` has them); without them only each tip's presence is checked. The report texts are git's: `funny refname`, `failed to update ref` (a stale old value, the same ref twice), `invalid new value provided` (a branch pointing at a non-commit, as git 2.55+; 2.43 said `failed to update ref`), `deletion of the current branch prohibited`, `branch is currently checked out` (a non-bare repository: `bare: false`), `non-fast-forward`, `shallow update not allowed` (unless `shallowUpdate` and the facade's `updateShallow`), `pre-receive hook declined`, `hook declined`, `unpacker error`; deleting a ref that does not exist is `ok`. With side-band, git's `error:` explanations and hook messages go to channel 2, `Checking connectivity: N, done.` too unless the client asked `quiet`, and keep-alive packets follow every `keepAliveMs` (5 s) while a received push is checked. Over smart HTTP the response head goes out as soon as the commands are authorized, so a relay that bounds a call by its first byte does not time out a long push; before that a malformed request or too many commands is a 400, an oversized body a 413, a refused push a 403; after it every failure is reported in band (an over-limit or idle body is `unpack request body larger than … bytes` / `unpack request idle for … ms`). report-status-v2 is not advertised.

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

### One session over a MessagePort

```typescript
import { fetchOverDuplex, messagePortDuplex, serveOverDuplex, serveOverPort } from "@statewalker/vcs-transport";

const { port1, port2 } = new MessageChannel();
serveOverPort(port2, (duplex) =>
  serveOverDuplex({ duplex, repository, refStore, service: "git-upload-pack" }),
);
const result = await fetchOverDuplex({ duplex: messagePortDuplex(port1), repository: local, refStore: localRefs });
```

`serveOverPort` runs a server on one end of a port and `messagePortDuplex` is the client's end, with
backpressure both ways and a half-close; they replace the deprecated `createMessagePortDuplex`.
For remote commands, register a connector instead ([docs/transports.md](./docs/transports.md)).

## Internals

### Why every operation is a state machine

Each server role (upload-pack, receive-pack, protocol v2) is a table of `[source, event, target]` transitions plus a map of state handlers. Handlers do one protocol step through `TransportApi` and return the next event. This keeps the protocol flow readable as data and lets tests drive single states. It also enables stop states: `fsm.run(context, "SOME_STATE")` pauses the machine, which is how the stateless smart-HTTP request/response pair maps onto one continuous protocol conversation. Error recovery is a separate transition table merged in with `withErrorRecovery`. The clients are not state machines: the fetch client (`fetch-client/`, git's fetch-pack) and the push client (`push-client/`, git's send-pack) are plain async code over a connection.

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

- **Receiving a push** (receive-pack), names must be valid refs under `refs/` (anything else, `HEAD` included, gets `ng <ref> funny refname`, as from git). A `RefStore` with `batch` gets git's ref transaction: an `atomic` push is one batch, so every ref in it changes or none does; a plain push is one batch per ref. Which refs an atomic push holds follows git's `execute_commands_atomic`: a ref refused before the transaction (`missing necessary objects`, `shallow update not allowed`, `authorize`, as git's hidden refs) keeps its error and the others are still applied, together; a ref `preReceive` refuses by name (`rejectedRefs`, which git's whole-push pre-receive cannot do) counts as an `update` hook refusal; the first refusal of git's `update()` checks (`funny refname`, the checked-out branch, deletes, `non-fast-forward`, `bad ref`, the `update` hook, a branch pointing at a non-commit as in git 2.55+) stops the checks (later `update` hooks do not run) and every other ref gets `ng <ref> atomic push failure`; a ref that moved since the advertisement or the same ref twice fail the transaction itself, every ref in it `ng <ref> atomic transaction failed`. `receivePack.strictAtomic: true` (`strictAtomic` on `serveOverDuplex`) makes an atomic push all or nothing: any refused ref fails the others with `atomic push failure`. Each update checks the old id the client sent, so a ref that moved since the advertisement is refused (`ng <ref> failed to update ref`) instead of overwritten. A store whose batch answers `unsupported` for several refs, and a `RefStore` without `batch`, keep the older path: one `update` per ref, no old-value check, and a best-effort rollback for `atomic`.
- `fetch` and `fetchOverDuplex` import into the given `RepositoryFacade` and update the `RefStore`; a clone is a fetch into an empty repository (`CloneCommand` in vcs-commands adds the local branch, HEAD and checkout).
- HTTP `fetch`, `push` and `lsRemote` send Basic auth. With `auth.token`, the token is the password and the username is `auth.username`, defaulting to `x-access-token` (GitHub and GitLab accept any username with a token; Bitbucket expects `x-token-auth`, passed as `username`). Without a token they use `auth.username` and `auth.password`.
- The fetch client gives up as git does: v0 counts haves "in vain" from the last newly common commit; v2 (git's `do_fetch_pack_v2`) resets the count on any `ACK`, re-sent commons included, so after the first `ACK` the first request that adds 256 haves says `done`.
- A v0 fetch over a duplex cannot follow tags in a second request (upload-pack ends the session after the pack); `include-tag` still brings the tags of the objects sent when the server honours it, and the tags it could not follow are listed in `tagsNotFollowed`.
- Pkt-lines are limited to 65520 bytes (`MAX_PACKET_SIZE`). Larger packets fail with `Packet too large: <n> bytes (max 65520)`.
- `pktLineReader` and `parsePacket` return the three special packets typed: `0000` as `flush`, `0001` as `delim`, and `0002` as `response-end` (protocol v2's end of a stateless response; this packet type was named `end` before). `demuxSideband` and `parseReportStatus` stop at `response-end` as at a flush. `TransportApi.readPktLine` rejects `0002` with `Unexpected response-end packet (0002)`: none of the exchanges it drives uses it.
- The readers keep received bytes as a queue of chunks and copy each byte once, so a packet that arrives in many small chunks is read in linear time: `pktLineReader`, `TransportApi.readPktLine` and `readGitProtocolRequest`.
- An `ACK` whose object id is not 40 hex digits fails with `PackProtocolError` (`Expected ACK/NAK, got: ...`), in v0/v1 (`parseAckNak`) and v2 (`parseAckNakV2`).
- Protocol v2 is fetch-only. `serveOverDuplex` with `protocolVersion: "2"` and `service: "git-receive-pack"` runs the v1 push machine.

### What failures look like

- HTTP operations throw: `Failed to get refs: <status> <statusText>`, `Failed to upload-pack: ...`, `Failed to receive-pack: ...`, `Empty response from /info/refs`, `Request timeout` (when `timeout` elapses), `Server error: <message>` (an `ERR` packet or sideband error), and for `push`, a `PushRefspecError` with git's message (`src refspec x does not match any`, …), `the receiving end does not support --atomic push`, `the receiving end does not support push options`; 401/403 throw an `AuthenticationError`.
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
