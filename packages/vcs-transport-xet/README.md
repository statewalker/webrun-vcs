# @statewalker/vcs-transport-xet

## What it is

A portable client for reading files that Hugging Face stores with [Xet](https://huggingface.co/docs/xet). It covers the whole read path: the Hub's path info and read token, the CAS reconstruction answer, xorb byte ranges, chunk decoding (none, LZ4, ByteGrouping4-LZ4) and the keyed BLAKE3 hashes that let every chunk and term be checked as it streams. It also has Xet's content-defined chunker, the Merkle xorb and file hashes, and an MDB shard reader and writer, all matching the specification's reference data bit for bit.

The package also ships, under a separate entry point, `@statewalker/vcs-transport-xet/webrun-chunks`: webrun's own chunk-dedup Git LFS custom transfer. It used to be advertised as `xet`, which it never was; it is now named `webrun-chunks` (see [The webrun-chunks transfer](#the-webrun-chunks-transfer)).

## How to use

```bash
pnpm add @statewalker/vcs-transport-xet
```

### Download a file from the Hub

```typescript
import { downloadXetFile } from "@statewalker/vcs-transport-xet";

const repo = { repo: "xet-team/xet-spec-reference-files", repoType: "dataset" as const };
for await (const bytes of downloadXetFile(repo, "Electric_Vehicle_Population_Data_20250917.csv")) {
  await writer.write(bytes); // pieces of at most one chunk (128 KiB)
}
```

`downloadXetFile` asks the Hub for the file's Xet hash (`paths-info`) and a CAS read token, gets the reconstruction answer (v2, or v1 where v2 is missing), and streams the xorb ranges it names. Nothing larger than one chunk plus one network piece is held, whatever the file's size. Pass `range: { start, end }` (inclusive) for part of a file, `token` in the repository for a private one, and `fetch` to route requests through your own client.

### Check every chunk as it arrives

```typescript
import { downloadXetFile, hashFromString, readShard, verifierFromShard } from "@statewalker/vcs-transport-xet";

const shard = readShard(shardBytes); // the file's MDB shard, e.g. from your own upload
const verify = verifierFromShard(shard, hashFromString(fileHash), { wholeFile: true });
for await (const bytes of downloadXetFile(repo, path, { verify })) consume(bytes);
```

A reconstruction answer carries no hashes, so the hashes come from a shard: each decoded chunk is hashed and compared before it is yielded (a damaged chunk stops the stream there, with `XetIntegrityError`), and each term's verification hash is compared when its last chunk is decoded.

### Lower level: tokens, answers, ranges

```typescript
import {
  fetchReconstruction,
  httpRanges,
  hubReadTokens,
  reconstruct,
} from "@statewalker/vcs-transport-xet";

const tokens = hubReadTokens(repo); // renewed 60 s before expiry and after a 401
const answer = await fetchReconstruction({ token: tokens, fileHash });
for await (const bytes of reconstruct(answer, httpRanges({ retries: 4 }))) consume(bytes);
```

`reconstruct(answer, fetchRange, { length?, verify? })` takes any `fetchRange(url, start, end)` that yields the bytes of an inclusive range, so tests and other transports can serve xorbs from memory. `httpRanges` retries 429, 5xx and network errors with a growing pause (or `Retry-After`), resumes a cut body from the next byte, and, given `refreshUrl`, replaces a signed URL refused with 401/403. `downloadXetFile` wires that to a fresh reconstruction answer, so an expired xorb URL during a long download is replaced instead of failing.

### Chunk and hash local data

```typescript
import { chunkHash, chunkStream, fileHash, hashToString } from "@statewalker/vcs-transport-xet";

const chunks = [];
for await (const chunk of chunkStream(source)) chunks.push({ hash: chunkHash(chunk), length: chunk.length });
console.log(hashToString(fileHash(chunks))); // the Xet file hash the Hub shows as `xetHash`
```

### API

| Export | What it does |
|--------|--------------|
| `downloadXetFile(repo, path, options?)` | A Hub file streamed as `AsyncGenerator<Uint8Array>`; options `range`, `version`, `verify`, `xetHash`, `tokens`, `retries`, `backoffMs`, `signal` |
| `hubPathInfo(repo, path)`, `xetReadToken(repo)` | `paths-info` (Xet hash, size, SHA-256) and `GET /api/{models,datasets,spaces}/{repo}/xet-read-token/{revision}` |
| `xetTokenSource(fetchToken, options?)`, `hubReadTokens(repo, options?)` | Tokens fetched once, renewed `refreshAheadSec` (default 60) before `exp`, and on demand after a 401; concurrent callers share one request |
| `fetchReconstruction({ token, fileHash, range?, version? })` | `GET {casUrl}/v2/reconstructions/{hash}` (v1 fallback), as the v1 shape; a token source is renewed and the request retried once on 401 |
| `v2ToV1(answer)` | A v2 answer's `xorbs[].ranges[]` as v1 fetch entries |
| `httpRanges(options?)` | A `FetchRange` over HTTP `Range` requests with retries, resume and URL refresh |
| `reconstruct(answer, fetchRange, { length?, verify? })` | The file, chunk by chunk; consecutive terms of one fetch entry share one fetch |
| `readXorbChunks(bytes, count?)` | A xorb byte stream decoded chunk by chunk |
| `parseXorbChunkHeader`, `decodeXorbChunk`, `XorbCompression` | One chunk header and payload |
| `writeXorb(chunks, { compression })` | A serialized xorb (for tests and tooling; the CAS upload API is not called) |
| `readShard(bytes)`, `writeShard(shard)` | MDB shards: header, File Info (terms, verification, metadata extension), CAS Info, footer |
| `verifierFromShard(shard, fileHash?, { wholeFile?, strict? })` | A `ReconstructionVerifier` from a shard's chunk and term hashes |
| `dedupeIndex(shards)`, `termsFor(chunks, locate)`, `keyedChunkHash` | Deduplication lookups over shards, including global-dedupe (keyed) shards |
| `chunkStream(source)` | Xet's gear-hash chunks: target 64 KiB, at least 8 KiB, at most 128 KiB |
| `chunkHash`, `xorbHash`, `fileHash`, `rangeHash` | Keyed BLAKE3 chunk hash, Merkle xorb and file hashes, verification range hash |
| `hashToString`, `hashFromString` | Xet's hash text (four little-endian 64-bit words in hex) |
| `lz4FrameDecode`, `lz4FrameEncode`, `lz4BlockEncode`, `xxh32` | The LZ4 frame codec Xet chunks use |
| `XetHttpError`, `XetIntegrityError` | An unexpected HTTP answer; bytes that do not match their hash |

## Internals

### Chunks and hashes

Chunk boundaries come from a 64-bit gear hash `h = (h << 1) + TABLE[b]` (kept as two 32-bit halves, since BigInt per byte is slow): a boundary after a byte where the top 16 bits are zero once the chunk has 8 KiB, and always at 128 KiB. A chunk's hash is BLAKE3 keyed with `DATA_KEY`. The xorb hash is the root of xet-core's aggregated Merkle tree, whose internal nodes hash the text `{hash} : {size}\n` per child keyed with `INTERNAL_NODE_KEY`, grouping 2 to 9 children by a content-defined cut. The file hash is that root keyed once more with 32 zero bytes, and a term's verification hash is its chunk hashes concatenated, keyed with `VERIFICATION_KEY`. BLAKE3 is `@noble/hashes` (pure JS, keyed mode); everything else is in this package.

### Xorbs and reconstruction

A xorb is a run of chunks, each an 8-byte header (version, compressed size, compression type, uncompressed size) and a payload: stored, an LZ4 frame, or an LZ4 frame of ByteGrouping4 groups. `reconstruct` resolves each term to the fetch entry covering its chunks, fetches that byte range once for all consecutive terms that go forward through it, decodes chunks as bytes arrive through a queue that never copies the rest of the buffer, and closes the body as soon as the last needed chunk is out (a range may run on into later chunks or the `XETB` footer).

### Reference data

The tests check the specification's reference files (dataset `xet-team/xet-spec-reference-files`, Apache-2.0): 796 chunk hashes and lengths, the xorb, file and range hashes, and four reference shards written byte for byte. The 14.7 MB reference xorb is not committed: the tests that rebuild the 63 MB reference CSV from it run when it is in `XET_REFERENCE_CACHE` (default `<tmp>/xet-reference`) or with `XET_LIVE=1`, which downloads it (pinned revision, SHA-256 checked). `XET_LIVE=1` also runs the live test against huggingface.co. Offline, the same paths run on generated files.

## The webrun-chunks transfer

`@statewalker/vcs-transport-xet/webrun-chunks` is a Git LFS custom transfer named `webrun-chunks`. It negotiates over the standard LFS batch API, offering `["webrun-chunks", "basic"]`. When the server agrees, objects move chunk by chunk through `@statewalker/webrun-content-transfer`, so only chunks the receiver is missing are sent. When the server answers `basic`, the whole call falls back to whole-object transfer from `@statewalker/vcs-transport-lfs`. The LFS oid (whole-file SHA-256) is the shared identity on both paths. It is webrun's own protocol, unrelated to Hugging Face Xet.

```typescript
import {
  serveWebrunChunks,
  webrunChunksDownload,
  webrunChunksUpload,
} from "@statewalker/vcs-transport-xet/webrun-chunks";

const handler = serveWebrunChunks(serverStore, serverResolver);
const pointer = { oid, size }; // oid = whole-file SHA-256 hex

for await (const e of webrunChunksUpload(clientStore, clientResolver, "http://lfs.host", [pointer], {
  fetchImpl: handler,
  hashContent,
})) {
  if (e.type === "chunk-sent") console.log("chunk", e.chunkId, e.size);
  if (e.type === "error") console.error(e.oid, e.reason);
}

for await (const e of webrunChunksDownload(otherStore, otherResolver, "http://lfs.host", [pointer], {
  fetchImpl: handler,
  hashContent,
})) {
  if (e.type === "object-downloaded") console.log("downloaded", e.oid);
}
```

Store and resolver setup is the same as for `@statewalker/vcs-transport-lfs`. Against a basic-only host no code changes: if the batch response has `transfer: "basic"`, the client delegates to `lfsUpload` and `lfsDownload` and yields their events.

| Export (`/webrun-chunks`) | Description |
|--------|-------------|
| `serveWebrunChunks(store, resolver)` | Server `(Request) => Promise<Response>`: answers the batch with `webrun-chunks` when offered, serves chunk channels at `POST {base}/webrun-chunks/<oid>`, and hands all other requests to `serveLfs` |
| `webrunChunksUpload(store, resolver, url, pointers, options?)` | Client upload. Yields `WebrunChunksTransportEvent`s |
| `webrunChunksDownload(store, resolver, url, pointers, options?)` | Client download. Yields `WebrunChunksTransportEvent`s |
| `WEBRUN_CHUNKS_TRANSFER`, `BASIC_TRANSFER`, `WEBRUN_CHUNKS_TRANSFERS` | `"webrun-chunks"`, `"basic"`, and `["webrun-chunks", "basic"]` |
| `WebrunChunksBatchResponse`, `WebrunChunksBatchObjectResponse`, `WebrunChunksBatchAction` | Batch shapes; an action adds `objectId` (the server's content-store id) to the LFS `{ href, header? }` |
| `WebrunChunksOptions`, `WebrunChunksTransportEvent`, `HashContent`, `LfsPointer`, `TransportEvent`, `FetchLike` | Types |

Migration from 0.2: `xetUpload` → `webrunChunksUpload`, `xetDownload` → `webrunChunksDownload`, `serveXet` → `serveWebrunChunks`, `XET_TRANSFER(S)` → `WEBRUN_CHUNKS_TRANSFER(S)`, `Xet*` types → `WebrunChunks*`, imported from `@statewalker/vcs-transport-xet/webrun-chunks`. The transfer id is now `webrun-chunks` and the chunk channel path `/webrun-chunks/<oid>`, so clients and servers must be upgraded together.

`store` is a `ContentStore` from `@statewalker/webrun-content-store`. `resolver` is an `LfsResolver` from `@statewalker/vcs-transport-lfs`. `WebrunChunksOptions` (all optional): `fetchImpl` (default global `fetch`; a `serveWebrunChunks` handler can be passed directly for an in-process loopback), `hashContent` (chunk-integrity hasher passed to content-transfer), `checkpoint` (a `TransferCheckpoint` to resume from), `limits` (`TransferLimits`), and `streamRequestBody` (whether an upload that falls back to basic LFS streams its body). `WebrunChunksTransportEvent` is the LFS `TransportEvent` plus `{ type: "chunk-sent", oid, chunkId, size }`.

### How one object moves

```
client                                   server (serveWebrunChunks)
  POST /objects/batch {transfers:[webrun-chunks,basic]}  -->  {transfer:"webrun-chunks", actions:{download:{href, objectId}}}
  transfer([objectId], remote, local)
    each request frame = one POST /webrun-chunks/<oid>  -->  content-transfer serveStore(store)
  stream the stored object through SHA-256, check oid and size
  resolver.record(oid, objectId)
```

Each content-transfer call is one complete request followed by one reply, so the chunk channel maps each call to a single HTTP `POST`: the request body is the outgoing frame, the response body is the reply. Frames are buffered per call (at most one chunk), so no streaming request body is needed.

content-transfer addresses objects by content-store id, not by LFS oid. On download the server puts its content-store id in the action's `objectId`, and the client transfers that id; both sides must use the same content-store hashing for the ids to agree.

Chunks are verified one by one by content-transfer, but the LFS oid covers the whole file. After a chunk download the client streams the assembled object out of the store through `createLfsPointer`, an incremental SHA-256 that also counts bytes, so memory stays at one chunk however large the object is. If the SHA-256 differs from the oid or the size from the pointer, no mapping is recorded. The refused object is not removed (content-store ids are derived from content, so a concurrent honest download may share it); it stays until the store's `gc` runs with the resolver's values as live roots. On upload, `serveWebrunChunks` stores the assembled object through `storeVerified` from `@statewalker/vcs-transport-lfs`, and a mismatch fails the assemble, which the client sees as an `error` event.

Per-object failures are yielded as `{ type: "error", oid, reason }`, never thrown: `no local object for oid`, `no download action`, `Object does not exist`, `sha256 mismatch`, `size mismatch`, `webrun-chunks upload refused: sha256 mismatch`, or any error thrown by content-transfer. On the basic fallback path the reasons are those of `@statewalker/vcs-transport-lfs`. The server always offers an upload action for every object in an upload batch, the client does not check the batch `POST` status before parsing the body, and `checkpoint` object ids are content-store ids, not LFS oids.

## Dependencies

- `@noble/hashes`: BLAKE3 (keyed mode) for the Xet hashes.
- `@statewalker/vcs-transport-lfs`, `@statewalker/webrun-content-transfer`, `@statewalker/webrun-content-store`, `@statewalker/webrun-streams`, `@statewalker/webrun-http-streams`: the `webrun-chunks` transfer only.

```bash
pnpm --filter @statewalker/vcs-transport-xet test
XET_LIVE=1 pnpm --filter @statewalker/vcs-transport-xet test   # adds the reference xorb and huggingface.co
```

On Node behind an HTTPS proxy, `NODE_USE_ENV_PROXY=1` makes `fetch` use it.

## License

MIT
