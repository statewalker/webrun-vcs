# @statewalker/vcs-transport-lfs

## What it is

A client and server for the standard Git LFS batch protocol (`POST /objects/batch`) with the `basic` whole-object transfer, conformant with native git-lfs (tested against git-lfs 3.4: `git push`, `git lfs push`, `git lfs pull`, `git clone`). Object bytes live either in a `@statewalker/webrun-content-store` `ContentStore`, with an injected `LfsResolver` mapping LFS oids to content-store ids, or in any `LfsObjectStore`, such as `createFilesLfsStore`: a `FilesApi` in git-lfs's own `lfs/objects/aa/bb/<oid>` layout, which native git-lfs shares. The LFS object id (`oid`) is the whole-file SHA-256 as bare lowercase hex.

## Why it exists: talk to real LFS hosts from any runtime

Large files are exchanged with Git LFS hosts through the batch API. This package implements that wire protocol on top of the content-store, using only `Request`/`Response`, Web Streams and a portable incremental SHA-256, so the same code runs in browsers, workers, Node and Deno. Objects are never held in memory whole: uploads send a streaming body, and every received object is hashed while it is stored. It does whole-object transfer only; chunk-level dedup is the `webrun-chunks` transfer of `@statewalker/vcs-transport-xet`, which falls back to this package. It builds and reads pointer files but knows nothing about git objects, the clean/smudge wiring or sync.

## How to use: a server handler and two client generators

```bash
pnpm add @statewalker/vcs-transport-lfs
```

No peer dependencies. One entry point, `@statewalker/vcs-transport-lfs` (ESM, with type declarations).

| Export | Description |
|--------|-------------|
| `serveLfs(store, resolver, opts?)`, `serveLfs(objects, opts?)` | Server: a `(Request) => Promise<Response>` handler for `POST {base}/objects/batch`, `PUT`/`GET`/`HEAD {base}/objects/<oid>` and `POST {base}/verify`, over a content-store and resolver or an `LfsObjectStore`. `opts`: `LfsServerOptions` (below) |
| `lfsUpload(store, resolver, url, pointers, fetchImpl?, opts?)`, `lfsUpload(objects, url, pointers, fetchImpl?, opts?)` | Client: batch `upload`, then `PUT` each object the server asks for, as a streaming body whose `content-length` is the local object's size, then its `verify` action. Yields `TransportEvent`s |
| `lfsDownload(store, resolver, url, pointers, fetchImpl?, opts?)`, `lfsDownload(objects, url, pointers, fetchImpl?, opts?)` | Client: batch `download`, then `GET` each object, hashing it while it is stored and checking oid and size at the end; resumes with `Range` into a store that keeps partials. Yields `TransportEvent`s |
| `createFilesLfsStore(files, root?)` | An `LfsObjectStore` on a `FilesApi` in git-lfs's layout under `root` (`".git"` for a repository): objects at `lfs/objects/aa/bb/<oid>`, partial downloads at `lfs/incomplete/<oid>.part`, writes through `lfs/tmp/` then an atomic `move` |
| `contentStoreLfsObjects(store, resolver)` | The `LfsObjectStore` view of a content-store and its resolver (what the `(store, resolver, ...)` overloads use) |
| `sha256Hex(content)` | `Promise<string>`: SHA-256 as bare hex (the LFS oid) of a buffer or a stream of chunks |
| `createLfsPointer(content)` | `Promise<LfsPointer>`: oid and size of a buffer or stream, in one streaming pass (what a clean filter needs) |
| `formatLfsPointer(pointer)`, `parseLfsPointer(textOrBytes)` | Write and read pointer files as git-lfs does (`EncodePointer`, `DecodeFrom`); `parseLfsPointer` returns `undefined` for anything git-lfs would not take as a pointer |
| `storeVerified(store, resolver, content, expected)` | Store a stream while hashing it; record it only if it matches `expected.oid` (and `expected.size`). A refused object is not removed; the store's `gc` reclaims it |
| `LFS_POINTER_VERSION`, `LFS_POINTER_MAX_SIZE` | `"version https://git-lfs.github.com/spec/v1"`; 1024, the bytes a pointer is read from |
| `BASIC_TRANSFER`, `LFS_CONTENT_TYPE` | `"basic"` and `"application/vnd.git-lfs+json"` |
| `BatchRequest`, `BatchResponse`, `BatchObjectRequest`, `BatchObjectResponse`, `BatchAction` | Batch API JSON shapes |
| `LfsPointer`, `LfsPointerExtension`, `LfsResolver`, `FetchLike`, `TransportEvent`, `LfsTransferOptions`, `LfsStoreResult`, `ByteSource` | Injected and emitted types |
| `LfsObjectStore`, `LfsPartialStore`, `LfsPutResult` | The store interface the server and client run over (below) |
| `LfsServerOptions`, `LfsAuthorization`, `LfsOperation` | Server options |

- `LfsPointer` is `{ oid, size, extensions? }`; `extensions` (`{ priority, name, oid }[]`, by priority) is present only for a pointer with `ext-N-name` lines.
- `LfsObjectStore` is `{ size(oid), read(oid, range?), put(content, expected, opts?), partial? }`. `put` hashes as it streams and makes the object visible only when its SHA-256 (and size, when given) match, answering `{ ok: true, size }` or `{ ok: false, reason: "sha256 mismatch" | "size mismatch" | "too large" }`. `partial` (`LfsPartialStore`: `size`, `append`, `complete`, `remove`) keeps the bytes of unfinished downloads so they resume.
- `LfsResolver` is `{ toObject(lfsOid), record(lfsOid, objectId) }`. The package never persists this map; the caller owns it.
- `FetchLike` is `(request: Request) => Response | Promise<Response>`. It defaults to the global `fetch`. A `serveLfs` handler has the same shape, so it can be passed directly for an in-process loopback.
- `LfsTransferOptions` is `{ streamRequestBody?, headers?, credentials? }`. `streamRequestBody`: whether uploads stream their body; by default they stream outside browsers and are collected in browsers (see "Streaming" below). `headers` and `credentials` (`{ username, password }`, sent as Basic auth) go with the batch, and with each transfer whose href is on the endpoint's origin, unless the server marked the object `authenticated`; they never go to another origin (git-lfs scopes credentials per URL too). `headersFor(href)` gives headers for hrefs on other origins (a CDN, a bucket). An action's headers replace the client's of the same name, case-insensitively.
- `LfsServerOptions` is `{ authorize?, transferAuth?, maxBatchObjects?, maxBatchBytes?, maxObjectSize?, publicUrl?, realm?, documentationUrl?, onError? }`, each described under "Server" below.
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

### Share objects with native git-lfs, and resume downloads

```typescript
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { createFilesLfsStore, lfsDownload, serveLfs } from "@statewalker/vcs-transport-lfs";

// The objects of a repository on disk, where git-lfs keeps them.
const store = createFilesLfsStore(createNodeFilesApi({ rootDir: repoDir }), ".git");

// A download that breaks keeps its bytes in .git/lfs/incomplete/<oid>.part;
// running it again asks for the rest with `Range: bytes=N-`.
for await (const e of lfsDownload(store, "https://host/repo.git/info/lfs", pointers, fetch, {
  credentials: { username, password },
})) {
  if (e.type === "error") console.warn(e.oid, e.reason);
}

// Serve the same store: `git push` and `git clone` with `lfs.url` pointing here work.
const handler = serveLfs(store, {
  authorize: (request, operation) => operation === "download" || isWriter(request),
});
```

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

`parseLfsPointer` reads a pointer as git-lfs's `DecodeFrom` does, and agrees with native git-lfs on the 48 cases in `tests/pointer-cases.ts`:

- only the first 1024 bytes count (a valid pointer followed by whitespace and then anything is still a pointer; a pointer followed by more text within those bytes is not);
- the text is trimmed as Go's `TrimSpace` trims (Unicode spaces too, not a BOM), lines may end in CRLF, blank lines are skipped;
- `version` (spec v1, or the legacy `https://hawser.github.com/spec/v1` and `http://git-media.io/v/2`), then `oid sha256:<64 lowercase hex>`, then `size`, in that order, nothing after `size`;
- `ext-<digit>-<name> sha256:<hex>` lines may stand anywhere before `size`, one per priority (a repeated key keeps its last value);
- the size is read as Go's `ParseInt` reads it (`+8` and `08` are 8) and must be at least 0. One difference stays: sizes above 2^53 are refused, where git-lfs takes up to 2^63.

`formatLfsPointer` writes extension lines by priority, and an empty object as the empty string: git-lfs's clean leaves an empty file empty.

`createLfsPointer` reads the content once, feeding each chunk to an incremental SHA-256 and counting its bytes, so a multi-gigabyte file costs one chunk of memory. This is the hashing half of a clean filter; writing the pointer into the index is the working tree's job.

## Internals

### Why the oid and the store id are separate

The LFS oid is fixed by the LFS spec: SHA-256 of the whole file. The content-store computes its own ids with whatever `hashContent` it was given, and those ids are opaque. The resolver maps between the two, so the content-store does not have to use SHA-256 and the package stores no state of its own.

### Why every transfer is hash-checked while it streams

The LFS spec requires the receiver to verify the whole-object SHA-256. Web Crypto's `subtle.digest` is one-shot and would need the whole object in memory, so both sides use the incremental `createSha256` from `@statewalker/vcs-utils/hash` instead. The client in `lfsDownload` and the server on `PUT` pass the incoming body straight into `store.put`, hashing and counting each chunk on the way (`storeVerified`). When the stream ends, the oid and the size (on the client the pointer size, on the server the request's `content-length` when it has one) must match; otherwise the transfer is refused and no mapping is recorded. A body that runs past the expected size is cut off at once, its stream cancelled, before its manifest is written, so a `PUT` cannot write more than it declared.

A refused object is never removed from the store. Store ids are derived from content, so a peer that sends the same bytes under a bogus oid gets the very id an honest transfer of those bytes may be verifying at that moment; removing it would delete the honest object just before its mapping is recorded, leaving a mapping with nothing behind it. Instead the refused object, or the chunks written before an overrun, stays until the store's `gc` runs with the resolver's values as live roots:

```typescript
await store.gc([...mapping.values()]); // every store id some LFS oid maps to
```

### Streaming

Downloads and server uploads always stream. `lfsUpload` sends a `ReadableStream` body with `duplex: "half"`, using `fetchWithRequestBody` from `@statewalker/vcs-utils/streams`, and a `content-length` (S3-style presigned URLs reject chunked uploads). The length is the size of the local object, read from its manifest, never a size the server sent: a wrong length would make the runtime's `fetch` reject the request (undici's `UND_ERR_REQ_CONTENT_LENGTH_MISMATCH`). When the local size disagrees with the requested pointer or with the batch response, that object gets a `size mismatch` error event and is not sent; any other failure, a rejected `fetch` included, also becomes that object's error event, and the other objects are still uploaded.

Node, Deno and Bun stream such bodies. Browsers collect the body first by default, because Firefox and Safari cannot stream request bodies and Chromium only can over HTTP/2; pass `{ streamRequestBody: true }` to stream there anyway, and a body that Chromium refuses before reading it is sent once more, collected. A streamed browser upload has no length, though: `content-length` is a forbidden header in browsers, which drop it, so the body goes out chunked and a presigned S3-style URL may reject it. A collected body gets its length from the browser, which is one more reason collecting is the browser default. The server answers a `GET` with the store's stream and the object's `content-length`.

### Constraints

- Peak memory is a few chunks per transfer, plus whatever the `ContentStore` keeps (a `memBlobStore` keeps everything). The files store streams every write and read.
- The server ignores the request's `transfers` list and always answers with `basic`; the client refuses any other transfer.
- Only a store with `partial` resumes downloads. Resuming copies the held bytes once into a new `.part` (FilesApi has no append), streamed; if the `.part` changes while it is copied, the append fails (`LfsPartialChangedError`) before any new byte is read and the client starts over. A 206 from another offset or without `Content-Range`, and a 416, also drop the held bytes and start over once from zero, as git-lfs does.
- Downloads of one oid are serialized within a process only: across every `createFilesLfsStore` over the same FilesApi instance and root (`partial.exclusive`), or per store instance for other stores.
- The files store moves through `moveCompleting` (a copy-then-delete backend's half-done move is finished) and removes its temporary file whenever a write or move throws.
- No locking API, no `tus`/`multipart`/`ssh` adapters, no retries or `expires_at` handling in the client.

### Server

`serveLfs` routes by path suffix, so it can sit under any prefix (git-lfs's default endpoint is `<remote>/info/lfs`); hrefs keep that prefix, or use `publicUrl` behind a proxy.

- **Batch** (`docs/api/batch.md`): an `upload` batch gives `upload` and `verify` actions, and no actions at all for objects the server already holds with that size; a `download` batch gives a `download` action, or per-object errors `{ code, message }`: 404 for a missing object, 422 for an invalid oid or size, a held size that differs, or an object over `maxObjectSize`. Batch-level errors: 409 for a `hash_algo` other than `sha256`, 413 past `maxBatchObjects` (1000) or `maxBatchBytes` (1 MiB), 422 for a malformed request, 406 for an `Accept` without the LFS media type. Responses carry `hash_algo: "sha256"`.
- **Errors** are `application/vnd.git-lfs+json` objects `{ message, request_id?, documentation_url? }`: `request_id` echoes an `X-Request-Id` header, `documentation_url` is `opts.documentationUrl`. An unexpected error is a 500 with only `Internal server error` and a `request_id` (the header's, or a fresh UUID); the error itself goes to `opts.onError(error, request, requestId)`.
- **Authentication** (`docs/api/authentication.md`): `authorize(request, operation)` decides each batch before anything in it is answered, and, without `transferAuth`, each transfer (`PUT` and verify are authorized before their oid or body is validated, so an unauthenticated caller only ever sees 401/403). `false` is 401 with `LFS-Authenticate: Basic realm="Git LFS"` when the request carries no `Authorization` (git-lfs then asks its credential helper and retries), 403 when it does; `{ status, message }` picks them. With `transferAuth: { header(op, oid), check(request, op, oid), expiresIn? }`, actions carry per-object headers and `expires_in`, objects are marked `authenticated`, and a transfer without the right headers (or, for verify, without a valid oid to check them against) is 401.
- **Basic transfer** (`docs/api/basic-transfers.md`): `GET` answers `Range: bytes=N-` (and RFC 9110's other single ranges) with 206 and `Content-Range`, past the end 416 with `Content-Range: bytes */size`, ignores other ranges, and takes the oid as a strong `ETag` for `If-Range`. `PUT` is verified as it streams (422 on a mismatch, 413 over `maxObjectSize`, 400 for an invalid `Content-Length`). `POST .../verify` is 200 when the object is held with that size, 404 if not, 422 for a malformed body.

### What failures look like

Client generators throw when the batch `POST` fails (a non-2xx status, with the server's `message`). They do not throw for per-object failures. They yield `{ type: "error", oid, reason }` with one of:

- the server's batch error message, for example `Object does not exist` (download of an unknown oid)
- `no local object for oid` (upload: resolver has no mapping)
- `no download action`
- `upload failed: <status>` / `download failed: <status>` (the response body is cancelled unread)
- `size mismatch` (upload: the local object's size differs from the pointer or the batch response; nothing is sent)
- `sha256 mismatch` (downloaded bytes do not hash to the oid; nothing is recorded, and the stored bytes remain until the store's `gc`)
- `size mismatch` (downloaded bytes are shorter or longer than the pointer size; nothing is recorded, and the stored bytes or chunks remain until the store's `gc`)
- `unexpected object in batch response`, `size mismatch in batch response`, `missing from batch response` (the batch answer does not match what was asked; an unexpected object is never transferred)
- `verify failed: <status>` (the server's `verify` action refused an upload)
- `incomplete: N of M bytes (kept to resume)`, or a transfer error with `(N of M bytes kept to resume)` (a store with partials; the next download resumes)
- `the server resumed at X, not N` (a 206 from another offset even after starting over from zero)
- the message of an error thrown while transferring one object, such as a rejected `fetch`

Server responses: `422 {"message":"oid does not match content"}` on a `PUT` whose bytes do not hash to the path oid; `422 {"message":"size does not match content-length"}` on a `PUT` whose body is shorter or longer than its `content-length`; `404 {"message":"Object does not exist"}` on a `GET` for an unknown oid; `404 {"message":"Not found"}` for any other route.

### Dependencies

- `@statewalker/webrun-content-store`: the `ContentStore` that holds object bytes.
- `@statewalker/webrun-http-streams`: the `FetchHandler` type returned by `serveLfs`.
- `@statewalker/vcs-utils`: the incremental `createSha256`, the streaming request body helpers and the `FilesApi` type.

### Commands

```bash
pnpm --filter @statewalker/vcs-transport-lfs test
```

## License

MIT
