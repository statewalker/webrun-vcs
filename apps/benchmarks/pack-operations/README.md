# Pack Operations Benchmark

## What it is

A command-line benchmark for Git pack file writing in `@statewalker/vcs-core`. For seven configurations of blob counts and sizes it generates blob objects, writes them into a pack with `writePack`, writes the pack index with `writePackIndex`, then parses the index with `readPackIndex` and looks up every entry. It prints object count, content size, pack and index size, compression ratio, write time and index read time. It runs in memory and needs no network or files.

## The shape

One file, `src/main.ts`:

```
for config in configurations:
  objects = blobs of the configured sizes (content from a fixed-seed generator,
            id = SHA-1 of "blob <size>\0<content>")
  writePack(objects)                       -> packData, packChecksum, indexEntries   ("Write")
  writePackIndex(indexEntries, checksum)   -> index bytes                            (timed, not shown)
  readPackIndex(index); findOffset(id) for every entry                               ("Read")
then: totals and throughput
```

Configurations:

| Config | Objects |
|--------|---------|
| 10 small blobs | 10 x 1KB |
| 100 small blobs | 100 x 1KB |
| 10 medium blobs | 10 x 10KB |
| 100 medium blobs | 100 x 10KB |
| 10 large blobs | 10 x 100KB |
| Mixed sizes | 50 x 256B, 30 x 4KB, 15 x 16KB, 5 x 64KB |
| 1000 tiny blobs | 1000 x 256B |

## How to run it

Requires Node 24 and pnpm. From the repository root:

```bash
pnpm install
pnpm --filter @statewalker/vcs-benchmark-pack-operations start
```

`start` runs `tsx src/main.ts`. A run takes about a second.

## What the output means

| Column | Meaning |
|--------|---------|
| Config | Configuration name |
| Objects | Number of blobs in the pack |
| Content | Total raw blob content |
| Pack | Pack file size, including header and trailing checksum |
| Index | Pack index size |
| Ratio | Pack size / content size |
| Write | `writePack` time only |
| Read | `readPackIndex` plus one `findOffset` per entry |

The summary prints totals, overall ratio, total write and "read" time, and MB/s for each.

A real run (timings vary by machine):

```
                             Config |  Objects |    Content |       Pack |    Index |    Ratio |      Write |       Read
10 small blobs (1KB each)           |       10 |     10.0KB |      2.3KB |    1.3KB |    23.5% |    33.81ms |      519μs
100 small blobs (1KB each)          |      100 |    100.0KB |     23.2KB |    3.4KB |    23.2% |    57.74ms |     1.22ms
10 medium blobs (10KB each)         |       10 |    100.0KB |     19.5KB |    1.3KB |    19.5% |    16.65ms |      144μs
100 medium blobs (10KB each)        |      100 |   1000.0KB |    188.7KB |    3.4KB |    18.9% |   177.99ms |      764μs
10 large blobs (100KB each)         |       10 |   1000.0KB |     48.4KB |    1.3KB |     4.8% |    44.10ms |      166μs
Mixed sizes (realistic)             |      100 |    692.5KB |     82.9KB |    3.4KB |    12.0% |    94.01ms |      585μs
1000 tiny blobs (256B each)         |     1000 |    250.0KB |     85.5KB |   24.5KB |    34.2% |   237.66ms |     6.93ms

Overall compression: 14.3%
Write throughput: 4.65 MB/s
Read throughput: 298.14 MB/s
```

## Why it is the way it is

- **Whole objects only.** `writePack` stores each object either whole or as a `REF_DELTA` when the caller supplies `deltaBaseId` and `deltaData`. The benchmark supplies neither, so it measures header encoding, zlib compression of each object, CRC32 and the pack SHA-1, not delta search. Delta cost is measured by the delta-compression benchmark.
- **Real object ids.** Ids are computed as Git does, SHA-1 over `blob <size>\0<content>`, so the index is a valid Git index and lookups exercise realistic fan-out distribution.
- **The index is version 1 here.** `writePackIndex` picks the oldest format that can hold the offsets; every pack in this benchmark is far below 4GB, so it writes V1: a 1KB fan-out table, 24 bytes per object (4-byte offset and 20-byte SHA-1), and a 40-byte trailer. That is why 10 objects give a 1.3KB index and 1000 objects give 24.5KB. V1 has no CRC32 table.
- **Deterministic content.** A fixed-seed generator makes sizes and ratios repeatable between runs; only timings vary.

## What will surprise you

- **"Read" is index parsing, not object reading.** The code sets `readAllTimeMs` to the index read time; no object is decompressed from the pack. The "Read throughput" in the summary divides total content size by that time, so its hundreds of MB/s say nothing about decompression speed.
- **Index write time is measured but not shown.** `indexWriteTimeMs` is recorded and never printed.
- **The "random" content compresses well, so ratios are optimistic.** `createRandomContent` computes `state * 1103515245` in floating point; the product exceeds 2^53, low bits are lost before `& 0x7fffffff`, and the output is far from random. A 1KB blob deflates to about 23% and long runs fall into a cycle of about 10K values, which is why 100KB blobs reach 4.8%. Truly random bytes would not compress at all. The 256-byte blobs compress worst because per-object headers dominate.
- **A failing configuration prints `ERROR: <message>` in its row and the run continues;** the process still exits 0.
- **Timings are single-shot,** with no warm-up; the first row includes JIT and zlib initialization.

## Reference

### Commands

| Command | What it does |
|---------|--------------|
| `pnpm --filter @statewalker/vcs-benchmark-pack-operations start` | Runs `tsx src/main.ts` |
| `pnpm --filter @statewalker/vcs-benchmark-pack-operations typecheck` | Runs `tsc --noEmit` |

### Configuration

Edit `configurations` in `src/main.ts` (name and list of object sizes). There are no flags or environment variables.

### Files and APIs

- `src/main.ts`: object generation, benchmark loop, table and summary
- `writePack`, `PackWriterObject`, `PackObjectType`: [packages/vcs-core/src/pack/pack-writer.ts](../../../packages/vcs-core/src/pack/pack-writer.ts), [types.ts](../../../packages/vcs-core/src/pack/types.ts)
- `writePackIndex`: [packages/vcs-core/src/pack/pack-index-writer.ts](../../../packages/vcs-core/src/pack/pack-index-writer.ts)
- `readPackIndex`: [packages/vcs-core/src/pack/pack-index-reader.ts](../../../packages/vcs-core/src/pack/pack-index-reader.ts)
- `sha1`, `bytesToHex`: `@statewalker/vcs-utils/hash/sha1`, `@statewalker/vcs-utils/hash/utils`
- [../delta-compression/](../delta-compression/): delta algorithm benchmark
