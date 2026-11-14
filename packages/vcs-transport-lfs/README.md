# @statewalker/vcs-transport-lfs

## What it is

A client and server for the standard Git LFS batch protocol (`POST /objects/batch`) with the `basic` whole-object transfer. Object bytes live in a `@statewalker/webrun-content-store` `ContentStore`. The LFS object id (`oid`) is the whole-file SHA-256 as bare lowercase hex. An injected `LfsResolver` maps LFS oids to content-store object ids.

## Why it exists: talk to real LFS hosts from any runtime

Large files are exchanged with Git LFS hosts through the batch API. This package implements that wire protocol on top of the content-store, using only `Request`/`Response`, Web Streams and a portable incremental SHA-256, so the same code runs in browsers, workers, Node and Deno. Objects are never held in memory whole: uploads send a streaming body, and every received object is hashed while it is stored. It does whole-object transfer only; chunk-level dedup is `@statewalker/vcs-transport-xet`, which falls back to this package. It builds and reads pointer files but knows nothing about git objects, the clean/smudge wiring or sync.

## How to use: a server handler and two client generators

```bash
pnpm add @statewalker/vcs-transport-lfs
```

No peer dependencies. One entry point, `@statewalker/vcs-transport-lfs` (ESM, with type declarations).

| Export | Description |
|--------|-------------|
| `serveLfs(store, resolver)` | Server: a `(Request) => Promise<Response>` handler for `POST {base}/objects/batch`, `PUT {base}/objects/<oid>` and `GET {base}/objects/<oid>` |
| `lfsUpload(store, resolver, url, pointers, fetchImpl?, opts?)` | Client: batch `upload`, then `PUT` each object the server asks for, as a streaming body. Yields `TransportEvent`s |
| `lfsDownload(store, resolver, url, pointers, fetchImpl?)` | Client: batch `download`, then `GET` each object, hashing it while it is stored and checking oid and size at the end. Yields `TransportEvent`s |
| `sha256Hex(content)` | `Promise<string>`: SHA-256 as bare hex (the LFS oid) of a buffer or a stream of chunks |
| `createLfsPointer(content)` | `Promise<LfsPointer>`: oid and size of a buffer or stream, in one streaming pass (what a clean filter needs) |
| `formatLfsPointer(pointer)`, `parseLfsPointer(text)` | Write and read the v1 pointer file text; `parseLfsPointer` returns `undefined` for anything else |
| `storeVerified(store, resolver, content, expected)` | Store a stream while hashing it; keep and record it only if it matches `expected.oid` (and `expected.size`) |
| `LFS_POINTER_VERSION` | `"version https://git-lfs.github.com/spec/v1"` |
| `BASIC_TRANSFER`, `LFS_CONTENT_TYPE` | `"basic"` and `"application/vnd.git-lfs+json"` |
| `BatchRequest`, `BatchResponse`, `BatchObjectRequest`, `BatchObjectResponse`, `BatchAction` | Batch API JSON shapes |
| `LfsPointer`, `LfsResolver`, `FetchLike`, `TransportEvent`, `LfsTransferOptions`, `LfsStoreResult`, `ByteSource` | Injected and emitted types |

- `LfsPointer` is `{ oid, size }`.
- `LfsResolver` is `{ toObject(lfsOid), record(lfsOid, objectId) }`. The package never persists this map; the caller owns it.
- `FetchLike` is `(request: Request) => Response | Promise<Response>`. It defaults to the global `fetch`. A `serveLfs` handler has the same shape, so it can be passed directly for an in-process loopback.
- `LfsTransferOptions` is `{ streamRequestBody? }`: whether uploads stream their body. By default they stream outside browsers and are collected in browsers (see "Streaming" below).
- `ByteSource` is a `Uint8Array`, a sync or async iterable of chunks, or a `ReadableStream<Uint8Array>` such as a `Response` body.
- `TransportEvent` is one of `{ type: "batch", operation, count }`, `{ type: "object-uploaded", oid }`, `{ type: "object-downloaded", oid }`, `{ type: "error", oid, reason }`.

## Examples

### Set up a store and a resolver

```typescript
import { createContentStore, type ObjectId } from "@statewalker/webrun-content-store";
import { memBlobStore } from "@statewalker/webrun-storage";
import type { LfsResolver } from "@statewalker/vcs-transport-lfs";

const store = createContentStore({
  chunks: memBlobStore(),
  manifests: memBlobStore(),
  hashContent, // your (stream) => Promise<string> content hash
});

const map = new Map<string, ObjectId>();
const resolver: LfsResolver = {
  toObject: async (oid) => map.get(oid),
  record: async (oid, id) => void map.set(oid, id),
};
```

### Serve, upload and download

```typescript
import { lfsDownload, lfsUpload, serveLfs, sha256Hex } from "@statewalker/vcs-transport-lfs";

// Server side.
const handler = serveLfs(serverStore, serverResolver);

// Client side: the object is already in clientStore and recorded in clientResolver.
const pointer = { oid: await sha256Hex(bytes), size: bytes.length };

for await (const e of lfsUpload(clientStore, clientResolver, "http://lfs.host", [pointer], handler)) {
  if (e.type === "error") console.error(e.oid, e.reason);
}

for await (const e of lfsDownload(otherStore, otherResolver, "http://lfs.host", [pointer], handler)) {
  if (e.type === "object-downloaded") console.log("downloaded", e.oid);
}
```

Against a real host, omit the last argument to use the global `fetch`, and pass the LFS endpoint URL (the client appends `/objects/batch`).

### Make a pointer for a large file

```typescript
import { createLfsPointer, formatLfsPointer, parseLfsPointer } from "@statewalker/vcs-transport-lfs";

const pointer = await createLfsPointer(files.read(["weights.bin"])); // streamed, never collected
const text = formatLfsPointer(pointer);
// version https://git-lfs.github.com/spec/v1
// oid sha256:4fab47c1...
// size 3561811

parseLfsPointer(text); // { oid: "4fab47c1...", size: 3561811 }
```

`createLfsPointer` reads the content once, feeding each chunk to an incremental SHA-256 and counting its bytes, so a multi-gigabyte file costs one chunk of memory. This is the hashing half of a clean filter; writing the pointer into the index is the working tree's job.

## Internals

### Why the oid and the store id are separate

The LFS oid is fixed by the LFS spec: SHA-256 of the whole file. The content-store computes its own ids with whatever `hashContent` it was given, and those ids are opaque. The resolver maps between the two, so the content-store does not have to use SHA-256 and the package stores no state of its own.

### Why every transfer is hash-checked while it streams

The LFS spec requires the receiver to verify the whole-object SHA-256. Web Crypto's `subtle.digest` is one-shot and would need the whole object in memory, so both sides use the incremental `createSha256` from `@statewalker/vcs-utils/hash` instead. The client in `lfsDownload` and the server on `PUT` pass the incoming body straight into `store.put`, hashing and counting each chunk on the way (`storeVerified`). When the stream ends, the oid (and, on the client, the pointer size) must match; otherwise the stored object is removed again and the transfer is refused. A download that runs past the pointer size is cut off at once, before its manifest is written.

The removal has one exception: if the resolver already maps the content's real oid to the same store object, the bytes were stored legitimately before and a lying transfer merely repeated them, so the object stays. Chunks written for a refused object stay in the chunk store until the store's `gc` reclaims them.

### Streaming

Downloads and server uploads always stream. `lfsUpload` sends a `ReadableStream` body with `duplex: "half"` and a `content-length` taken from the pointer (S3-style presigned URLs reject chunked uploads), using `fetchWithRequestBody` from `@statewalker/vcs-utils/streams`. Node, Deno and Bun stream such bodies. Browsers collect the body first by default, because Firefox and Safari cannot stream request bodies and Chromium only can over HTTP/2; pass `{ streamRequestBody: true }` to stream there anyway, and a body that Chromium refuses before reading it is sent once more, collected. The server answers a `GET` with the store's stream and the object's `content-length`.

### Constraints

- Peak memory is a few chunks per transfer, plus whatever the `ContentStore` keeps (a `memBlobStore` keeps everything).
- The server always offers an upload action for every object in an `upload` batch, even one it already has.
- The server ignores the request's `transfers` list and always answers with `basic`.
- No authentication is built in. Pass a `fetchImpl` that adds headers if the host needs them; batch actions' `header` values are forwarded on `PUT`/`GET`.
- The client does not check the HTTP status of the batch `POST`; it parses the body as a `BatchResponse`.

### What failures look like

Client generators do not throw for per-object failures. They yield `{ type: "error", oid, reason }` with one of:

- the server's batch error message, for example `Object does not exist` (download of an unknown oid)
- `no local object for oid` (upload: resolver has no mapping)
- `no download action`
- `upload failed: <status>` / `download failed: <status>`
- `sha256 mismatch` (downloaded bytes do not hash to the oid; nothing is kept)
- `size mismatch` (downloaded bytes are shorter or longer than the pointer size; nothing is kept)

Server responses: `422 {"message":"oid does not match content"}` on a `PUT` whose bytes do not hash to the path oid; `404 {"message":"Object does not exist"}` on a `GET` for an unknown oid; `404 {"message":"Not found"}` for any other route.

### Dependencies

- `@statewalker/webrun-content-store`: the `ContentStore` that holds object bytes.
- `@statewalker/webrun-http-streams`: the `HttpHandler` type returned by `serveLfs`.
- `@statewalker/vcs-utils`: the incremental `createSha256` and the streaming request body helpers.

### Commands

```bash
pnpm --filter @statewalker/vcs-transport-lfs test
```

## License

MIT
