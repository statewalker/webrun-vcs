# @statewalker/vcs-utils Architecture

This document explains the internal architecture of the utils package, covering algorithm implementations, design decisions, and extension points.

## Design Philosophy

### Foundation Role

The utils package serves as the foundational layer with zero VCS-specific dependencies. It provides pure algorithmic implementations that higher-level packages build upon:

```
@statewalker/vcs-commands
       ↓
@statewalker/vcs-core
       ↓
@statewalker/vcs-utils  ← You are here
       ↓
   pako, @statewalker/webrun-files-mem (external dependencies)
```

This separation ensures utils can be used independently for general-purpose hashing, compression, and diffing without pulling in VCS-specific code.

### Browser-First Compatibility

All implementations work in browser environments without Node.js APIs. Platform-specific optimizations (like Node.js zlib) are optional and injected via `setCompressionUtils()`. This enables:

- Same code running in browsers, edge functions, and Node.js
- Optional native acceleration when available
- Consistent behavior across environments

### Streaming by Default

Most APIs use generators and async iterables to handle arbitrarily large data with bounded memory:

```typescript
async function* deflate(stream: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array>
function* createDelta(source: Uint8Array, target: Uint8Array, ranges: Iterable<DeltaRange>): Generator<Delta>
```

This design enables processing multi-gigabyte files without loading everything into memory.

## Module Architecture

```
@statewalker/vcs-utils
├── hash/                 - Cryptographic and checksum algorithms
│   ├── sha1/            - SHA-1 hash (Git object IDs)
│   ├── crc32/           - CRC32 checksums (pack files)
│   ├── rolling-checksum/ - Rabin-Karp rolling hash (delta matching)
│   ├── strong-checksum/ - FNV-1a hash (match confirmation)
│   ├── fossil-checksum/ - Fossil format integrity
│   ├── fnv1a/           - FNV-1a string hash
│   └── utils/           - Hex/byte conversions
├── compression/          - DEFLATE/INFLATE streaming
│   └── compression/     - Core API (Web Compression Streams default), pako helpers
│       (Node.js zlib: @statewalker/vcs-utils-node, registered via setCompressionUtils)
├── diff/                 - Diff and patch algorithms
│   ├── delta/           - Binary delta encoding (Git and Fossil formats)
│   ├── patch/           - Git patch parsing/application
│   └── text-diff/       - Myers and Histogram line-based diff, 3-way merge
├── encoding/            - Git varints and pack object headers
├── cache/               - LRU caching utilities
├── collections/         - Sorted insertion helpers
├── streams/             - Async stream operations, MessagePort byte streams
├── files/               - FilesApi interface, in-memory FilesApi, path helpers (subpath only)
├── ports/               - Request/response RPC over MessagePort (subpath only)
└── pack/                - Pack header, object id, pack object cache (subpath only)
```

## Hash Module Deep Dive

The hash module provides multiple algorithms optimized for different use cases in version control.

### Algorithm Selection Guide

| Algorithm | Output | Speed | Use Case |
|-----------|--------|-------|----------|
| SHA-1 | 20 bytes | Slow | Object IDs, content verification |
| CRC32 | 4 bytes | Fast | Pack file checksums |
| RollingChecksum | 4 bytes | O(1) update | Delta block matching |
| StrongChecksum | 4 bytes | Fast | Match confirmation |
| FossilChecksum | 4 bytes | Fast | Delta reconstruction integrity |

### SHA-1 Implementation

The SHA-1 implementation provides both sync and async APIs:

```typescript
// Sync - pure TypeScript
import { Sha1 } from "@statewalker/vcs-utils/hash/sha1";
const hash = new Sha1().update(data).finalize();

// Async - Web Crypto when available
import { sha1 } from "@statewalker/vcs-utils/hash/sha1";
const hash = await sha1(data);
```

**Key Features:**

- **Incremental hashing**: Update with chunks, finalize when ready
- **State cloning**: Fork hash state for parallel computations
- **Idempotent finalize**: Safe to call multiple times

**Implementation Details:**

The pure TypeScript implementation processes data in 64-byte blocks. For incremental updates, partial blocks are buffered until complete. The async variant uses Web Crypto SubtleCrypto when available for native acceleration.

### Rolling Checksum (Rabin-Karp)

The rolling checksum enables O(1) sliding window updates for efficient block matching:

```typescript
import { RollingChecksum } from "@statewalker/vcs-utils/hash/rolling-checksum";

const rc = new RollingChecksum();
rc.init(data, 0, 16); // 16-byte window

// Slide window by 1 byte
const newChecksum = rc.update(oldByte, newByte);
```

**Algorithm:**

The checksum maintains two running sums:
- `s1 = Σ(bytes in window)` - simple byte sum
- `s2 = Σ(position × byte)` - position-weighted sum

Sliding the window updates both sums in constant time:
- Remove old byte: `s1 -= oldByte`, `s2 -= windowSize × oldByte`
- Add new byte: `s1 += newByte`, `s2 += s1`

Output combines both: `(s1 & 0xFFFF) | ((s2 & 0xFFFF) << 16)`

### Two-Stage Block Matching

Delta compression uses a two-stage approach for efficiency:

1. **Weak checksum** (RollingChecksum): Fast pre-filter, may have collisions
2. **Strong checksum** (FNV-1a): Confirms matches, no false positives

```
Target block → Compute weak hash → Lookup in source index
                                         ↓
                              No match? Skip to next position
                                         ↓
                              Match? → Compute strong hash → Compare
                                                                ↓
                                                    Match? → Emit copy instruction
```

This two-stage approach provides speed of weak hashing with accuracy of strong hashing.

## Compression Module Deep Dive

The compression module provides streaming DEFLATE/INFLATE with pluggable implementations.

### Core API

```typescript
import { compressBlock, decompressBlock, deflate, inflate } from "@statewalker/vcs-utils/compression";

// Streaming compression
async function* compress(input: AsyncIterable<Uint8Array>) {
  for await (const chunk of deflate(input, { level: 6 })) {
    yield chunk;
  }
}

// Block compression (for small data)
const compressed = await compressBlock(data);
const decompressed = await decompressBlock(compressed);
```

### Pluggable Implementations

The default streaming implementation uses the Web `CompressionStream` / `DecompressionStream` API; partial decompression uses pako. To use Node.js zlib instead:

```typescript
import { setCompressionUtils } from "@statewalker/vcs-utils/compression";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";

setCompressionUtils(createNodeCompression());
```

### Partial Decompression

A critical feature for pack file parsing is partial decompression. Git pack files concatenate compressed objects without length headers, so we need to decompress exactly one object and report how many bytes were consumed:

```typescript
const { data, bytesRead } = await decompressBlockPartial(compressedData);
// data contains the decompressed content
// bytesRead tells us where the next object starts
```

The default implementation uses pako's low-level inflate, which reports the consumed byte count (`total_in`) after one pass. The Node.js implementation in `@statewalker/vcs-utils-node` finds the boundary by binary search over the input length.

## Diff Module Deep Dive

The diff module provides three complementary diffing approaches:

### 1. Text Diff (Myers Algorithm)

Line-based diffing for human-readable output:

```typescript
import { MyersDiff, RawText, RawTextComparator } from "@statewalker/vcs-utils/diff";

const a = new RawText(oldContent);
const b = new RawText(newContent);
const edits = MyersDiff.diff(RawTextComparator.DEFAULT, a, b);

for (const edit of edits) {
  console.log(`${edit.getType()}: lines ${edit.beginA}-${edit.endA} → ${edit.beginB}-${edit.endB}`);
}
```

**Algorithm:**

Based on Eugene W. Myers' "An O(ND) Difference Algorithm and its Variations". Uses bidirectional search for O(N) space complexity. The implementation follows JGit patterns with edit normalization for consistent output.

### 2. Binary Delta (Fossil Format)

Compact delta encoding for binary files:

```
Source: [----A----][----B----][----C----]
Target: [----B----][--new--][----A----]

Delta:
  COPY from source offset 10, length 10  (block B)
  INSERT [--new--]                       (new data)
  COPY from source offset 0, length 10   (block A)
```

**Three-Level Architecture:**

```
Level 1: Range Generation
  createDeltaRanges() → Generator<DeltaRange>
  - Scans target for matching blocks in source
  - Uses rolling hash + strong checksum

Level 2: Delta Creation
  createDelta() → Generator<Delta>
  - Converts ranges to copy/insert instructions
  - Adds integrity checksum

Level 3: Delta Application
  applyDelta() → Generator<Uint8Array>
  - Reconstructs target from source + delta
  - Validates checksum
```

**Range Types:**

```typescript
type DeltaRange =
  | { from: "source"; start: number; len: number }  // Copy from source
  | { from: "target"; start: number; len: number }  // Insert from target (new data)
```

**Delta Instructions:**

```typescript
type Delta =
  | { type: "start"; sourceLen?: number; targetLen: number } // Header with sizes
  | { type: "copy"; start: number; len: number } // Copy from source
  | { type: "insert"; data: Uint8Array }      // Insert literal bytes
  | { type: "finish"; checksum: number }      // Trailer with Fossil checksum
```

### 3. Git Patch Format

Parsing and applying Git unified/binary patches:

```typescript
import { Patch } from "@statewalker/vcs-utils/diff";

const patch = new Patch();
patch.parse(patchContent);

for (const file of patch.getFiles()) {
  console.log(`${file.changeType}: ${file.oldPath} → ${file.newPath}`);
}
```

**Supported Formats:**

- `diff --git` extended format
- `diff --cc` combined diffs (for merges)
- Unified diff with hunks
- Binary patches (literal and delta)

**Binary Encoding:**

Git uses Base85 encoding for binary data in patches. The decoder handles:
- Literal hunks (complete file content)
- Delta hunks (Fossil-style delta compressed)

## Cache Module

### LRU Cache

Doubly-linked list implementation with both size and entry count limits:

```typescript
import { LRUCache } from "@statewalker/vcs-utils/cache";

const cache = new LRUCache<string, Uint8Array>(
  50 * 1024 * 1024,  // 50MB max size
  500,               // 500 entries max
  (buf) => buf.length // Size calculator
);

cache.set(key, value);
const cached = cache.get(key);
```

**Implementation Details:**

```
head ←→ entry1 ←→ entry2 ←→ entry3 ←→ tail
 ↑                                     ↑
Most Recently Used           Least Recently Used
```

- O(1) get, set, delete via Map + linked list
- Evicts from tail when limits exceeded
- Access moves entry to head

### Intermediate Cache

Optimizes delta chain reconstruction by caching waypoints:

```typescript
import { IntermediateCache } from "@statewalker/vcs-utils/cache";

const cache = new IntermediateCache();

// Cache every 8 steps in reconstruction
cache.set(baseRecordId, depth, reconstructedContent);

// Later reconstructions can start from cached waypoint
const cached = cache.getByComponents(baseRecordId, 4);
```

## Streams Module

Async stream utilities for composable data processing:

### Core Operations

```typescript
// Transform items
mapStream(input, (item) => transform(item))

// Collect into single buffer
const buffer = await collect(stream);
const array = await toArray(stream);

// Split by delimiter
for await (const segment of splitStream(input, newByteSplitter(0x0A))) {
  // Each segment is a stream until newline
}

// Concatenate two byte arrays
concat(bytes1, bytes2)

// Byte range of a stream
slice(stream, 0, 100)   // First 100 bytes
slice(stream, 50)       // Skip first 50 bytes
```

### Delimiter Matching

The `newSplitter()` function handles multi-byte delimiters across chunk boundaries:

```typescript
const splitter = newSplitter(new TextEncoder().encode("\r\n"));
// Correctly finds "\r\n" even if "\r" and "\n" are in different chunks
```

## Extension Points

### Custom Compression

Implement `CompressionUtils` for custom backends:

```typescript
interface CompressionUtils {
  deflate: (stream: ByteStream, options?) => ByteStream;
  inflate: (stream: ByteStream, options?) => ByteStream;
  compressBlock: (data: Uint8Array, options?) => Promise<Uint8Array>;
  decompressBlock: (data: Uint8Array, options?) => Promise<Uint8Array>;
  decompressBlockPartial?: (data: Uint8Array, options?) => Promise<PartialDecompressionResult>;
}

setCompressionUtils(myCustomImplementation);
```

### Custom Delta Strategies

The delta creation separates range finding from encoding. Implement custom range finding for domain-specific optimization:

```typescript
function* myCustomRanges(source: Uint8Array, target: Uint8Array): Generator<DeltaRange> {
  // Your matching strategy
}

const delta = [...createDelta(source, target, myCustomRanges(source, target))];
```

### Custom Hash Algorithms

Hash implementations follow a common pattern for interchangeability:

```typescript
class MyHash {
  update(data: Uint8Array): this { ... }
  finalize(): Uint8Array { ... }
  clone(): MyHash { ... }
  reset(): void { ... }
}
```

## Performance Considerations

### Streaming vs Buffering

Prefer streaming APIs for large data:

```typescript
// Good: Streaming
for await (const chunk of deflate(largeStream)) {
  await write(chunk);
}

// Avoid: Buffering large data
const allData = await collect(largeStream); // Memory spike!
const compressed = await compressBlock(allData);
```

### Block Size Tuning

Delta compression block size affects both speed and ratio:

| Block Size | Speed | Compression |
|------------|-------|-------------|
| 8 bytes | Slow | Better |
| 16 bytes | Balanced | Good |
| 64 bytes | Fast | Worse |

Default is 16 bytes, which works well for most VCS workloads.

### Hash Algorithm Selection

Choose the right hash for your use case:

- **Content addressing**: SHA-1 (security not critical for VCS)
- **Block matching**: RollingChecksum + StrongChecksum
- **Integrity checks**: CRC32 or FossilChecksum
- **General hashing**: StrongChecksum (FNV-1a)

## Testing Patterns

### Hash Testing

Verify hash implementations against known test vectors:

```typescript
const knownVectors = [
  { input: "abc", sha1: "a9993e364706816aba3e25717850c26c9cd0d89d" },
  // ...
];

for (const { input, sha1 } of knownVectors) {
  const result = bytesToHex(new Sha1().update(encode(input)).finalize());
  expect(result).toBe(sha1);
}
```

### Delta Round-Trip

Test delta encoding by verifying round-trip:

```typescript
const source = randomBytes(10000);
const target = mutate(source); // Make some changes

const ranges = [...createDeltaRanges(source, target)];
const delta = [...createDelta(source, target, ranges)];
const reconstructed = mergeChunks(applyDelta(source, delta));

expect(reconstructed).toEqual(target);
```

### Compression Round-Trip

```typescript
const original = randomBytes(1000);
const compressed = await compressBlock(original);
const decompressed = await decompressBlock(compressed);

expect(decompressed).toEqual(original);
```
