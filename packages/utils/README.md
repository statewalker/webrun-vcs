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

No peer dependencies.

| Import path | Contents |
|-------------|----------|
| `@statewalker/vcs-utils` | Re-exports `cache`, `compression`, `diff`, `encoding`, `hash`, `streams`, plus `insertSorted` / `insertByTimestamp`. Does not include `files`, `ports` or `pack`. |
| `@statewalker/vcs-utils/compression` | `deflate`, `inflate` (streams), `compressBlock`, `decompressBlock`, `decompressBlockPartial`, `setCompressionUtils`, `CompressionError`, pako and stream helpers |
| `@statewalker/vcs-utils/hash` | All of the `hash/*` entries below, plus `fnv1aHash` |
| `@statewalker/vcs-utils/hash/sha1` | `sha1` (async), `sha1Sync`, `Sha1`, `newSha1` |
| `@statewalker/vcs-utils/hash/crc32` | `crc32`, `CRC32` |
| `@statewalker/vcs-utils/hash/fossil-checksum` | `FossilChecksum` |
| `@statewalker/vcs-utils/hash/rolling-checksum` | `RollingChecksum`, `JgitRollingHash` and related helpers |
| `@statewalker/vcs-utils/hash/strong-checksum` | `StrongChecksum` |
| `@statewalker/vcs-utils/hash/utils` | `bytesToHex`, `hexToBytes` |
| `@statewalker/vcs-utils/diff` | Binary deltas (`createDeltaRanges`, `createFossilLikeRanges`, `createDelta`, `applyDelta`, `deltaToGitFormat`, `applyGitDelta`, `parseGitDelta`, ...), text diff (`RawText`, `RawTextComparator`, `MyersDiff`, `HistogramDiff`, `getAlgorithm`, `MergeAlgorithm`, `merge3Way`, ...), Git patches (`Patch`, `FileHeader`, `PatchApplier`, ...) |
| `@statewalker/vcs-utils/encoding` | Git varints: `readVarint`, `writeVarint`, `readOfsVarint`, `writeOfsVarint`, `readPackHeader`, `writePackHeader` |
| `@statewalker/vcs-utils/streams` | `collect`, `toArray`, `concat`, `mapStream`, `toLines`, `toChunks`, `splitStream`, `slice`, `readHeader`, `BufferedByteReader`, port streams (`writeStream`, `readStream`, `createPortStream`, ...) |
| `@statewalker/vcs-utils/cache` | `LRUCache`, `IntermediateCache` |
| `@statewalker/vcs-utils/files` | `FilesApi` type, `createInMemoryFilesApi`, `readFile`, `readText`, `tryReadText`, `readAt`, `readRange`, path helpers, `FileMode` |
| `@statewalker/vcs-utils/ports` | Request/response over `MessagePort`: `callPort`, `listenPort`, `callBidi`, `listenBidi`, `send`, `receive`, ... |
| `@statewalker/vcs-utils/pack` | Pack helpers: `parsePackHeader`, `computeObjectId`, `packTypeToString`, `MemoryPackObjectCache`, async varint readers |

## Examples

### Hash a Git object

```typescript
import { sha1, sha1Sync } from "@statewalker/vcs-utils/hash/sha1";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";

const data = new TextEncoder().encode("Hello, World!");
const id = bytesToHex(await sha1(data)); // Web Crypto when available
const same = bytesToHex(sha1Sync(data)); // pure TypeScript, synchronous
```

For a Git object id, hash the header and content together: `computeObjectId("blob", content)` from `@statewalker/vcs-utils/pack` does that and returns the hex id.

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

`deflate` and `inflate` default to the Web `CompressionStream` / `DecompressionStream` API, which every current runtime has. `compressBlock` and `decompressBlock` run the same streams over one buffer. `setCompressionUtils(partial)` replaces any subset of the five functions process-wide; `@statewalker/vcs-utils-node` provides a `node:zlib` set. Nothing registers itself on import.

### Why partial decompression uses pako

Git pack files concatenate zlib streams, and an entry header gives only the uncompressed size. The reader has to know how many compressed bytes each object used. `DecompressionStream` does not report that. The default `decompressBlockPartial` therefore uses pako's low-level inflate, which exposes the number of input bytes consumed (`total_in`) after one pass. This is the only reason pako is a dependency.

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

- `pako`: partial zlib decompression with byte accounting (see above), and an alternative pure-JS compression set (`createPakoCompression`).
- `@statewalker/webrun-files-mem`: backs `createInMemoryFilesApi`. The `FilesApi` interface itself is declared in this package (`src/files/files-api.ts`) and matches the one implemented by the `@statewalker/webrun-files*` packages.
- `@statewalker/webrun-files` is listed in `package.json`, but no source file imports it.

Tests: `pnpm --filter @statewalker/vcs-utils test` (Node) and `pnpm --filter @statewalker/vcs-utils test:browser` (Playwright).

## License

MIT
