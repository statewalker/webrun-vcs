# @statewalker/vcs-transport-xet

## What it is

A Git LFS custom transfer agent named `xet`. It negotiates over the standard LFS batch API, offering `["xet", "basic"]`. When the server agrees to `xet`, objects move chunk by chunk through `@statewalker/webrun-content-transfer`, so only chunks the receiver is missing are sent. When the server answers `basic`, the whole call falls back to whole-object transfer from `@statewalker/vcs-transport-lfs`. The LFS oid (whole-file SHA-256) is the shared identity on both paths.

## Why it exists: dedup without giving up LFS interop

Large files change in small parts, and re-sending whole objects wastes bandwidth. The content-store already splits objects into chunks, and content-transfer already knows how to send only missing chunks and resume. This package wires those two into the LFS batch flow so that a xet-capable peer gets chunk-level dedup and resume, while a plain LFS host still works through the `basic` fallback. It is an adapter: it has no chunking, no batch/basic logic and no chunk protocol of its own.

## How to use: same shape as the LFS client, plus options

```bash
pnpm add @statewalker/vcs-transport-xet
```

No peer dependencies. One entry point, `@statewalker/vcs-transport-xet` (ESM, with type declarations).

| Export | Description |
|--------|-------------|
| `serveXet(store, resolver)` | Server `(Request) => Promise<Response>`: answers the batch with `xet` when offered, serves chunk channels at `POST {base}/xet-chunks/<oid>`, and hands all other requests to `serveLfs` |
| `xetUpload(store, resolver, url, pointers, options?)` | Client upload. Yields `XetTransportEvent`s |
| `xetDownload(store, resolver, url, pointers, options?)` | Client download. Yields `XetTransportEvent`s |
| `XET_TRANSFER`, `BASIC_TRANSFER`, `XET_TRANSFERS` | `"xet"`, `"basic"`, and `["xet", "basic"]` |
| `XetBatchResponse`, `XetBatchObjectResponse`, `XetBatchAction` | Batch shapes; a xet action adds `objectId` (the server's content-store id) to the LFS `{ href, header? }` |
| `XetOptions`, `XetTransportEvent`, `HashContent`, `LfsPointer`, `TransportEvent`, `FetchLike` | Types |

`store` is a `ContentStore` from `@statewalker/webrun-content-store`. `resolver` is an `LfsResolver` from `@statewalker/vcs-transport-lfs` (import that type from there; it is not re-exported here).

`XetOptions` (all optional):

- `fetchImpl`: `(Request) => Response | Promise<Response>`, default global `fetch`. A `serveXet` handler can be passed directly for an in-process loopback.
- `hashContent`: chunk-integrity hasher passed to content-transfer.
- `checkpoint`: a `TransferCheckpoint` to resume from.
- `limits`: `TransferLimits` for the transfer pipeline.
- `streamRequestBody`: whether an upload that falls back to basic LFS streams its body (see `LfsTransferOptions` in `@statewalker/vcs-transport-lfs`).

The last three apply on the xet path only.

`XetTransportEvent` is the LFS `TransportEvent` (`batch`, `object-uploaded`, `object-downloaded`, `error`) plus `{ type: "chunk-sent", oid, chunkId, size }`.

## Examples

### Upload and download with chunk dedup

```typescript
import { serveXet, xetDownload, xetUpload } from "@statewalker/vcs-transport-xet";

const handler = serveXet(serverStore, serverResolver);
const pointer = { oid, size }; // oid = whole-file SHA-256 hex

for await (const e of xetUpload(clientStore, clientResolver, "http://xet.host", [pointer], {
  fetchImpl: handler,
  hashContent,
})) {
  if (e.type === "chunk-sent") console.log("chunk", e.chunkId, e.size);
  if (e.type === "error") console.error(e.oid, e.reason);
}

for await (const e of xetDownload(otherStore, otherResolver, "http://xet.host", [pointer], {
  fetchImpl: handler,
  hashContent,
})) {
  if (e.type === "object-downloaded") console.log("downloaded", e.oid);
}
```

Store and resolver setup is the same as for `@statewalker/vcs-transport-lfs`.

### Fallback to a basic-only host

No code change. If the server's batch response has `transfer: "basic"`, `xetUpload` and `xetDownload` delegate to `lfsUpload` and `lfsDownload` and yield their events.

## Internals

### How one object moves on the xet path

```
client                                   server (serveXet)
  POST /objects/batch {transfers:[xet,basic]}  -->  {transfer:"xet", actions:{download:{href, objectId}}}
  transfer([objectId], remote, local)
    each request frame = one POST /xet-chunks/<oid>  -->  content-transfer serveStore(store)
  stream the stored object through SHA-256, check oid and size
  resolver.record(oid, objectId)
```

Each content-transfer call is one complete request followed by one reply, so the chunk channel maps each call to a single HTTP `POST`: the request body is the outgoing frame, the response body is the reply. Frames are buffered per call (at most one chunk), so no streaming request body is needed.

### Why the content-store id travels in the batch

content-transfer addresses objects by content-store id, not by LFS oid. On download the server puts its content-store id in the action's `objectId`, and the client transfers that id. The downloaded object is stored under the same id, so both sides must use the same content-store hashing for the ids to agree.

### Why the whole object is hashed after a chunk download

Chunks are verified one by one by content-transfer, but the LFS oid covers the whole file. After a xet download the client streams the assembled object out of the store through `createLfsPointer`, an incremental SHA-256 that also counts bytes, so memory stays at one chunk however large the object is. If the SHA-256 differs from the oid or the size from the pointer, the object is removed from the store (unless the resolver already maps its real oid to it). Only a match records the oid mapping.

The upload side does the same on the server: when content-transfer assembles an uploaded object, `serveXet` stores it through `storeVerified` from `@statewalker/vcs-transport-lfs`, hashing the reassembled bytes as they stream into the store. A mismatch removes the object and fails the assemble, which the client sees as an `error` event for that oid; the mapping is recorded only for a match.

### Which hashes Xet uses here

Two, and neither needs the whole object in memory. Chunk and content-store ids come from the injected `hashContent` (the demos and tests use SHA-256 over each chunk, streamed). The interop identity is the LFS oid, a whole-file SHA-256, computed incrementally. Hugging Face's own Xet storage uses BLAKE3-keyed merkle hashes for chunks and files; this package does not speak that protocol, so it needs no BLAKE3 implementation.

### Constraints
- The server always offers an upload action for every object in an upload batch.
- As in `@statewalker/vcs-transport-lfs`, the client does not check the batch `POST` status before parsing the body.
- `checkpoint` object ids are content-store ids, not LFS oids.

### What failures look like

Per-object failures are yielded as `{ type: "error", oid, reason }`, never thrown:

- `no local object for oid` (upload: resolver has no mapping)
- `no download action` (download: the action or its `objectId` is missing)
- `Object does not exist` (download batch for an oid the server does not know)
- `sha256 mismatch` (assembled object does not hash to the oid; the object is removed)
- `size mismatch` (assembled object is not the pointer size; the object is removed)
- `xet upload refused: sha256 mismatch` (upload: the server's assembled object does not hash to the oid)
- any error message thrown by content-transfer during the chunk exchange

On the basic fallback path the reasons are those of `@statewalker/vcs-transport-lfs`.

### Dependencies

- `@statewalker/vcs-transport-lfs`: batch types, `serveLfs`, the basic fallback client, `createLfsPointer` and `storeVerified` for streaming verification.
- `@statewalker/webrun-content-transfer`: `transfer`, `remoteStore`, `serveStore` (chunk dedup and resume).
- `@statewalker/webrun-content-store`: the `ContentStore` and id types.
- `@statewalker/webrun-streams`: the `Duplex` type of the chunk channel.
- `@statewalker/webrun-http-streams`: the `HttpHandler` type returned by `serveXet`.

### Commands

```bash
pnpm --filter @statewalker/vcs-transport-xet test
```

## License

MIT
