# @statewalker/vcs-transport-lfs

## What it is

A client and server for the standard Git LFS batch protocol (`POST /objects/batch`) with the `basic` whole-object transfer. Object bytes live in a `@statewalker/webrun-content-store` `ContentStore`. The LFS object id (`oid`) is the whole-file SHA-256 as bare lowercase hex. An injected `LfsResolver` maps LFS oids to content-store object ids.

## Why it exists: talk to real LFS hosts from any runtime

Large files are exchanged with Git LFS hosts through the batch API. This package implements that wire protocol on top of the content-store, using only `Request`/`Response` and Web Crypto, so the same code runs in browsers, workers, Node and Deno. It does whole-object transfer only; chunk-level dedup is `@statewalker/vcs-transport-xet`, which falls back to this package. It knows nothing about git objects, LFS pointer files or sync.

## How to use: a server handler and two client generators

```bash
pnpm add @statewalker/vcs-transport-lfs
```

No peer dependencies. One entry point, `@statewalker/vcs-transport-lfs` (ESM, with type declarations).

| Export | Description |
|--------|-------------|
| `serveLfs(store, resolver)` | Server: a `(Request) => Promise<Response>` handler for `POST {base}/objects/batch`, `PUT {base}/objects/<oid>` and `GET {base}/objects/<oid>` |
| `lfsUpload(store, resolver, url, pointers, fetchImpl?)` | Client: batch `upload`, then `PUT` each object the server asks for. Yields `TransportEvent`s |
| `lfsDownload(store, resolver, url, pointers, fetchImpl?)` | Client: batch `download`, then `GET`, verify and store each object. Yields `TransportEvent`s |
| `sha256Hex(bytes)` | `Promise<string>`: whole-object SHA-256 as bare hex (the LFS oid) |
| `BASIC_TRANSFER`, `LFS_CONTENT_TYPE` | `"basic"` and `"application/vnd.git-lfs+json"` |
| `BatchRequest`, `BatchResponse`, `BatchObjectRequest`, `BatchObjectResponse`, `BatchAction` | Batch API JSON shapes |
| `LfsPointer`, `LfsResolver`, `FetchLike`, `TransportEvent` | Injected and emitted types |

- `LfsPointer` is `{ oid, size }`.
- `LfsResolver` is `{ toObject(lfsOid), record(lfsOid, objectId) }`. The package never persists this map; the caller owns it.
- `FetchLike` is `(request: Request) => Response | Promise<Response>`. It defaults to the global `fetch`. A `serveLfs` handler has the same shape, so it can be passed directly for an in-process loopback.
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

## Internals

### Why the oid and the store id are separate

The LFS oid is fixed by the LFS spec: SHA-256 of the whole file. The content-store computes its own ids with whatever `hashContent` it was given, and those ids are opaque. The resolver maps between the two, so the content-store does not have to use SHA-256 and the package stores no state of its own.

### Why every transfer is hash-checked

The LFS spec requires the receiver to verify the whole-object SHA-256. Both sides do it before storing: the client in `lfsDownload`, the server on `PUT`. Bytes that do not match are never stored.

### Constraints

- Whole objects are buffered in memory on both sides (read fully, hashed, then stored).
- `sha256Hex` uses `crypto.subtle`, which is async, so it returns a Promise.
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
- `sha256 mismatch` (downloaded bytes do not hash to the oid)

Server responses: `422 {"message":"oid does not match content"}` on a `PUT` whose bytes do not hash to the path oid; `404 {"message":"Object does not exist"}` on a `GET` for an unknown oid; `404 {"message":"Not found"}` for any other route.

### Dependencies

- `@statewalker/webrun-content-store`: the `ContentStore` that holds object bytes.
- `@statewalker/webrun-http-streams`: the `HttpHandler` type returned by `serveLfs`.

### Commands

```bash
pnpm --filter @statewalker/vcs-transport-lfs test
```

## License

MIT
