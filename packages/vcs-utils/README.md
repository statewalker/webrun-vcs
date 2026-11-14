# @statewalker/vcs-utils

## What it is

Low-level building blocks for a Git-compatible VCS: SHA-1 and other checksums, zlib compression, binary deltas in Git and Fossil formats, text diff (Myers and Histogram) and Git patch parsing, varint and pack-header encoding, byte-stream helpers, caches, a `FilesApi` abstraction, and MessagePort RPC. Everything works on `Uint8Array` and `AsyncIterable<Uint8Array>`.

## Why it exists

Higher packages (`@statewalker/vcs-core`, the stores, the transports) all need the same byte-level algorithms, and they must run in browsers, workers and Node.js. This package holds those algorithms in one place and uses only Web Platform APIs (`crypto.subtle`, `CompressionStream`, `MessageChannel`) plus pure-JS pako. No `node:*` imports. Platform-specific speedups live in other packages (for Node.js: `@statewalker/vcs-utils-node`) and are plugged in through setters, so a browser bundle never pulls them in.

The output is byte-compatible with Git: object hashes, zlib streams and pack deltas can be read by Git, and Git's can be read here.

## How to use it

```bash
pnpm add @statewalker/vcs-utils
```

No peer dependencies. Hashing uses `@noble/hashes`.

| Import path | Contents |
|-------------|----------|
| `@statewalker/vcs-utils` | Re-exports `cache`, `compression`, `diff`, `encoding`, `hash`, `streams`, plus `insertSorted` / `insertByTimestamp`. Does not include `files`, `ports` or `pack`. |
| `@statewalker/vcs-utils/compression` | `deflate`, `inflate` (streams), `compressBlock`, `decompressBlock`, `decompressBlockPartial`, `createInflater`, `createInflaterPool`, `TruncatedStreamError`, `InflateError`, `setCompressionUtils`, `CompressionError`, pako and stream helpers |
| `@statewalker/vcs-utils/hash` | All of the `hash/*` entries below, plus `fnv1aHash` |
| `@statewalker/vcs-utils/hash/hasher` | `Hasher`, `createSha1` |
| `@statewalker/vcs-utils/hash/sha1` | `sha1` (async one-shot) |
| `@statewalker/vcs-utils/hash/crc32` | `crc32`, `CRC32` |
| `@statewalker/vcs-utils/hash/fossil-checksum` | `FossilChecksum` |
| `@statewalker/vcs-utils/hash/rolling-checksum` | `RollingChecksum`, `JgitRollingHash` and related helpers |
| `@statewalker/vcs-utils/hash/strong-checksum` | `StrongChecksum` |
| `@statewalker/vcs-utils/hash/utils` | `bytesToHex`, `hexToBytes` |
| `@statewalker/vcs-utils/diff` | Binary deltas (`createDeltaRanges`, `createFossilLikeRanges`, `createDelta`, `applyDelta`, `deltaToGitFormat`, `applyGitDelta`, `parseGitDelta`, ...), text diff (`RawText`, `RawTextComparator`, `MyersDiff`, `HistogramDiff`, `getAlgorithm`, `MergeAlgorithm`, `merge3Way`, ...), Git patches (`Patch`, `FileHeader`, `PatchApplier`, ...) |
| `@statewalker/vcs-utils/encoding` | Git varints: `readVarint`, `writeVarint`, `readOfsVarint`, `writeOfsVarint`, `readPackHeader`, `writePackHeader` |
| `@statewalker/vcs-utils/streams` | `collect`, `toArray`, `concat`, `mapStream`, `toLines`, `toChunks`, `splitStream`, `slice`, `readHeader`, `BufferedByteReader`, port streams (`writeStream`, `readStream`, `createPortStream`, ...) |
| `@statewalker/vcs-utils/cache` | `LRUCache`, `IntermediateCache` |
| `@statewalker/vcs-utils/files` | `FilesApi` type, `createInMemoryFilesApi`, `AtomicFiles` and `atomicFilesOver` (lock-file primitives), `readFile`, `readText`, `tryReadText`, `readAt`, `readRange`, path helpers, `FileMode` |
| `@statewalker/vcs-utils/ports` | Request/response over `MessagePort`: `callPort`, `listenPort`, `callBidi`, `listenBidi`, `send`, `receive`, ... |
| `@statewalker/vcs-utils/pack` | Pack helpers: `parsePackHeader`, `computeObjectId`, `computeObjectIdFromStream`, `SizeMismatchError`, `packTypeToString`, `MemoryPackObjectCache`, async varint readers |

## Examples

### Hash a Git object

```typescript
import { computeObjectId, computeObjectIdFromStream } from "@statewalker/vcs-utils/pack";

const content = new TextEncoder().encode("hello\n");
await computeObjectId("blob", content);
// "ce013625030ba8dba906f756967f9e9ca394464a", the id `git hash-object` prints

// A file too large to hold: hash it as it streams, in one pass.
const size = (await files.stats(path))?.size;
if (size === undefined) throw new Error(`no such file: ${path}`);
const id = await computeObjectIdFromStream("blob", size, files.read(path));
```

A git object id is the SHA-1 of `"<type> <size>\0"` followed by the content, so the stream form needs the size before the first byte. If the stream ends early, or runs past the declared size, it rejects with `SizeMismatchError` (`declared`, `actual`). An overrun is caught at the first chunk that crosses the size, nothing after it is pulled, and `actual` (above `declared`) counts up to that chunk.

`computeObjectId` hashes small objects with the portable hasher and objects of 64 KiB and more with Web Crypto, where the runtime has it: each is the faster path for its size.

### Incremental SHA-1

```typescript
import { bytesToHex, createSha1 } from "@statewalker/vcs-utils/hash";

const h = createSha1().update(part1);
const forked = h.clone().update(otherTail); // the shared prefix is hashed once
h.update(part2);
bytesToHex(h.digest());
```

`createSha1()` returns a `Hasher`: `update(bytes)` (chainable), `digest()` and `clone()`. Read `digest()` once; the hasher is spent after it and every later call throws, so `clone()` first if the state is still needed. For a buffer already in memory, `await sha1(bytes)` from `@statewalker/vcs-utils/hash/sha1` uses Web Crypto where the runtime has it and the portable hasher elsewhere.

### Compress and decompress

```typescript
import { compressBlock, decompressBlock, deflate, inflate } from "@statewalker/vcs-utils/compression";
import { collect } from "@statewalker/vcs-utils/streams";

const input = new TextEncoder().encode("Some content to compress");

// Whole buffers (zlib format by default; pass { raw: true } for raw DEFLATE)
const packed = await compressBlock(input);
const restored = await decompressBlock(packed);

// Streams
const packedStream = deflate([input]);
const restored2 = await collect(inflate(packedStream));
```

### Find where each compressed stream ends

```typescript
import { createInflater } from "@statewalker/vcs-utils/compression";

// A pack: zlib streams back to back, no lengths. Inflate one and keep the rest.
const inf = createInflater();
let rest = new Uint8Array(0);
const output: Uint8Array[] = [];
for (const chunk of chunks) {
  const { out, done, consumed } = inf.push(chunk);
  output.push(...out);
  if (done) {
    rest = chunk.subarray(consumed); // the next object starts here
    break;
  }
}
inf.end(); // throws TruncatedStreamError if the input ran out first
```

Chunks can be split anywhere, even inside the zlib header or the Adler-32 trailer, and each byte is inflated once. A stream is `done` only after its checksum is read and verified. Input that runs out first makes `end()` throw `TruncatedStreamError`, and a corrupt stream makes `push` throw `InflateError`; both extend `CompressionError`. Pass `{ raw: true }` for raw DEFLATE.

`decompressBlockPartial(buffer)` is the same thing for a buffer in memory: it returns `{ data, bytesRead }` and ignores what follows the stream.

### Create and apply a binary delta

```typescript
import {
  applyDelta,
  applyGitDelta,
  createDelta,
  createDeltaRanges,
  deltaToGitFormat,
  mergeChunks,
} from "@statewalker/vcs-utils/diff";

const base = new TextEncoder().encode("Original file content, long enough to match blocks.");
const target = new TextEncoder().encode("Original file content, long enough to match blocks. With additions.");

// Ranges say which parts of target are copied from base and which are new
const delta = [...createDelta(base, target, createDeltaRanges(base, target))];

// Apply directly
const rebuilt = mergeChunks(applyDelta(base, delta));

// Or serialize to Git's pack delta format and apply that
const gitDelta = deltaToGitFormat(base.length, delta);
const rebuilt2 = applyGitDelta(base, gitDelta);
```

### Diff two texts line by line

```typescript
import { MyersDiff, RawText, RawTextComparator } from "@statewalker/vcs-utils/diff";

const a = new RawText("line1\nline2\nline3\n");
const b = new RawText("line1\nmodified\nline3\n");

for (const edit of MyersDiff.diff(RawTextComparator.DEFAULT, a, b)) {
  // REPLACE: lines 1-2 -> 1-2 (0-based, end exclusive)
  console.log(`${edit.getType()}: lines ${edit.beginA}-${edit.endA} -> ${edit.beginB}-${edit.endB}`);
}
```

`getAlgorithm(SupportedAlgorithm.HISTOGRAM)` returns `HistogramDiff.diff` with the same signature. Histogram is `DEFAULT_ALGORITHM`.

### CRC32

```typescript
import { crc32 } from "@statewalker/vcs-utils/hash/crc32";

const checksum = crc32(new Uint8Array([1, 2, 3, 4, 5])); // number
```

### LRU cache

```typescript
import { LRUCache } from "@statewalker/vcs-utils/cache";

// maxSize in bytes (default 50 MB), maxEntries (default 500), optional sizeOf(value)
const cache = new LRUCache<string, Uint8Array>(10 * 1024 * 1024, 100);
cache.set("key1", new Uint8Array(16));
cache.get("key1");
cache.has("key1");
```

The entry is evicted when either limit is exceeded. Without `sizeOf`, the size of a `Uint8Array` value is its byte length.

### Stream helpers

```typescript
import { collect, concat, mapStream, toLines } from "@statewalker/vcs-utils/streams";

const bytes = await collect(source);        // AsyncIterable<Uint8Array> -> Uint8Array
const joined = concat(chunkA, chunkB);      // two arrays -> one
for await (const line of toLines(source)) { // decoded strings, LF or CRLF
  console.log(line);
}
const doubled = mapStream([1, 2, 3], (n) => n * 2);
```

### In-memory files

```typescript
import { createInMemoryFilesApi, readText } from "@statewalker/vcs-utils/files";

const files = createInMemoryFilesApi({ "/docs/readme.txt": "hello" });
const text = await readText(files, "/docs/readme.txt");
```

For a disk-backed `FilesApi` in Node.js, use `createNodeFilesApi()` from `@statewalker/vcs-utils-node/files`.

### RPC over a MessagePort

```typescript
import { callPort, listenPort } from "@statewalker/vcs-utils/ports";

const { port1, port2 } = new MessageChannel();
port1.start();
port2.start();

const stop = listenPort(port2, async ({ a, b }: { a: number; b: number }) => a + b);
const sum = await callPort<{ a: number; b: number }, number>(port1, { a: 1, b: 2 }, { timeout: 5000 });
stop();
```

Byte streams with backpressure over a port (`writeStream`, `readStream`, `createPortStream`) are described in [docs/PORT-STREAM.md](docs/PORT-STREAM.md).

## Internals

### Why compression is replaceable

`deflate` and `inflate` default to the Web `CompressionStream` / `DecompressionStream` API, which every current runtime has. `compressBlock` and `decompressBlock` run the same streams over one buffer. `deflate` pulls its input as the compressor takes it; a consumer that stops early closes the source (without waiting for one that is stalled), and an error from the source comes out unchanged, compressor errors as `CompressionError`. `setCompressionUtils(partial)` replaces any subset of the five functions process-wide (for example in a test). Nothing registers itself on import, and no package ships a non-portable set.

### Why partial decompression uses pako

Git pack files concatenate zlib streams, and an entry header gives only the uncompressed size, so the reader has to know how many compressed bytes each object used. Neither `DecompressionStream` nor Node's zlib reports that. pako's low-level inflate does: when it reaches the end of a stream, its input position is exactly the first byte after it. The push inflater (`createInflater`) and `decompressBlockPartial` are built on that; it is the only reason pako is a dependency.

Inflate states are pooled, as in JGit's `InflaterCache`. When a stream ends, fails or is found truncated, its state is reset and kept for the next one (at most 4 idle per format), and its reference to the caller's input is dropped. Reusing state makes small objects about 3× faster to inflate. Output is copied out of one shared 64 KiB buffer rather than returned as views of it, so kept output never pins a large buffer. `createInflaterPool()` gives a private pool, for tests or isolation.

### Why `files`, `ports` and `pack` are not in the root export

`diff` exports a `FileMode` interface (for patches) and `files` exports a `FileMode` constant (Git mode numbers). Putting both in the root would collide, so `files` is only reachable through its subpath. `ports` and `pack` are likewise subpath-only.

### Deltas are built in two steps

Delta creation is split into two steps. A range generator (`createDeltaRanges`, or `createFossilLikeRanges` with a rolling checksum) decides which target bytes are copied from the source. `createDelta` turns ranges into `Delta` records (`start`, `copy`, `insert`, `finish` with a Fossil checksum). Those records can be applied directly or serialized to Git's pack delta format (`deltaToGitFormat`, `serializeDeltaToGit`) or to Fossil's format (`serializeDeltaToFossil`).

### What breaks, and the error you see

- Compression: `CompressionError` with `Compression failed: ...`, `Decompression failed: ...` or `Partial decompression failed: ...`, wrapping `Web compression failed: ...` or `Pako ... failed: ...` from the underlying implementation.
- Git deltas: `applyGitDelta` throws `Delta base length mismatch: expected N, got M` when the base is the wrong object, and `Delta result size mismatch: ...` for a corrupt delta. `applyDelta` throws `Checksum mismatch: expected X, got Y` when the rebuilt bytes do not match.
- Varints and pack headers: `Truncated varint`, `Truncated pack header`, `Invalid pack signature: 0x...`, `Unsupported pack version: N`.
- `callPort` rejects with `Call timeout. CallId: "..."` after `timeout` ms (default 1000). `callPort` and `listenPort` attach listeners with `addEventListener`, which does not start a native `MessagePort`: call `port.start()` yourself, or every call ends in that timeout.
- Port streams: `Timeout waiting for acknowledgement` when the receiver does not ACK within `ackTimeout`.

### The diff, patch and delta code follows JGit

The text diff (`MyersDiff`, `HistogramDiff`, `RawText`, `RawTextComparator`, `Edit`), the patch parser and applier, `applyGitDelta` and the rolling hash follow Eclipse JGit's implementations, so edge cases (whitespace modes, binary hunks, delta limits) behave as JGit does.

### Dependencies

- `@noble/hashes`: incremental SHA-1 (audited, dependency-free, runs in every JavaScript runtime). The `Hasher` interface keeps it replaceable by a native or WASM implementation.
- `pako`: partial zlib decompression with byte accounting (see above), and an alternative pure-JS compression set (`createPakoCompression`).
- `@statewalker/webrun-files-mem`: backs `createInMemoryFilesApi`. The `FilesApi` interface itself is declared in this package (`src/files/files-api.ts`) and matches the one implemented by the `@statewalker/webrun-files*` packages.
- `@statewalker/webrun-files` is listed in `package.json`, but no source file imports it.

Tests: `pnpm --filter @statewalker/vcs-utils test` (Node) and `pnpm --filter @statewalker/vcs-utils test:browser` (Playwright).

## License

MIT
