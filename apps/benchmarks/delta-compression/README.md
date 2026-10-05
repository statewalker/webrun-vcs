# Delta Compression Benchmark

## What it is

A command-line benchmark for the byte-level delta functions in `@statewalker/vcs-utils/diff`. For every combination of six buffer sizes and seven mutation rates it computes a delta from a source buffer to a mutated copy, serializes it to the Git binary delta format, replays it with `applyDelta`, verifies the result byte for byte, and prints delta size, ratio, encode and decode time, and throughput. It runs in memory and needs no network or files.

## The shape

One file, `src/main.ts`, run top to bottom:

```
for size in [1KB, 10KB, 50KB, 100KB, 500KB, 1MB]:
  source = createRandomContent(size, seed 12345)
  for mutation in [0, 1%, 5%, 10%, 25%, 50%, 100%]:
    target = mutateContent(source, mutation)
    encode:  createDeltaRanges(source, target, 16)
             -> createDelta(source, target, ranges)
             -> serializeDeltaToGit(deltas)            (its length is "Delta")
    decode:  applyDelta(source, deltas) -> concatenate (timed as "Decode")
    verify:  result === target                          ("OK" / "FAIL")
then: summary of averages by mutation rate and by size
```

## How to run it

Requires Node 24 and pnpm. From the repository root:

```bash
pnpm install
pnpm --filter @statewalker/vcs-benchmark-delta-compression start
```

`start` runs `tsx src/main.ts`. A full run takes a few seconds; the 1MB rows dominate.

## What the output means

| Column | Meaning |
|--------|---------|
| Size | Source and target size (they are equal) |
| Mutation | Fraction of byte positions overwritten |
| Delta | Length of the Git-format delta from `serializeDeltaToGit` |
| Ratio | Delta size / target size |
| Encode | `createDeltaRanges` + `createDelta` + `serializeDeltaToGit` |
| Decode | `applyDelta` over the in-memory instructions, plus concatenation |
| Total | Encode + Decode |
| Throughput | Size / Total, in MB/s |
| Status | `OK` if the decoded buffer equals the target |

After the table it prints pass/fail counts, the average ratio per mutation rate, and the average encode+decode time per size at 0% mutation.

Excerpt from a real run (timings vary by machine):

```
      Size |   Mutation |      Delta |    Ratio |     Encode |     Decode |      Total |   Throughput |  Status
     1.0KB |       0.0% |         6B |     0.6% |     1.33ms |      116μs |     1.45ms |    0.68 MB/s |  OK
   100.0KB |      10.0% |     23.6KB |    23.6% |    23.92ms |     1.12ms |    25.05ms |    3.90 MB/s |  OK
    1.00MB |       1.0% |     35.9KB |     3.5% |   407.99ms |     3.98ms |   411.97ms |    2.43 MB/s |  OK
    1.00MB |     100.0% |    725.6KB |    70.9% |   779.67ms |     9.16ms |   788.82ms |    1.27 MB/s |  OK

Total benchmarks: 42
Passed: 42
Failed: 0

Average compression ratio by mutation rate:
    0.0% mutation: 0.1% of original
    1.0% mutation: 4.2% of original
   10.0% mutation: 23.8% of original
  100.0% mutation: 72.7% of original
```

Encoding is the expensive side: decode is one to two orders of magnitude faster, and encode cost grows with the mutation rate as well as with size.

## Why it is the way it is

- **Deterministic content.** Source and mutations come from a fixed-seed linear congruential generator, so every run measures the same inputs and ratios are comparable between runs and machines; only timings vary.
- **16-byte blocks.** `createDeltaRanges` is called with `blockSize = 16`, its default; the rolling hash matches 16-byte blocks of the source.
- **Decode replays instructions, not the Git bytes.** The `Delta` instructions carry a Fossil checksum in their `finish` step that `applyDelta` verifies; the Git binary format does not carry it. Decoding the in-memory instructions keeps the checksum check in the loop. The "Delta" size is still the Git-format size, since that is what goes into a pack.
- **Mutation overwrites in place.** Mutation replaces bytes without inserting or deleting, so source and target always have the same length; shifted content is not exercised.

## What will surprise you

- **100% mutation still compresses to about 71%.** The generator computes `state * 1103515245` in floating point; the product exceeds 2^53, so low bits are lost before `& 0x7fffffff` and the output is far from random (a 1KB buffer deflates to about 23%, and long runs fall into a cycle of about 10K values). Repeated byte runs give the delta something to copy even when every byte was overwritten. Ratios in the 25% to 100% rows are better than real random data would give.
- **Small buffers report low throughput.** At 1KB, fixed per-call costs dominate and throughput is under 2 MB/s; it is not a regression.
- **A failing row prints `FAIL` or `ERROR: <message>` but the process still exits 0.** Errors from `applyDelta` look like `Target length mismatch: expected N, got M` or `Checksum mismatch: expected X, got Y`. Read the `Failed:` count, not the exit code.
- **Timings are single-shot.** Each cell is one run with no warm-up, so the first rows include JIT warm-up and numbers move between runs.

## Reference

### Commands

| Command | What it does |
|---------|--------------|
| `pnpm --filter @statewalker/vcs-benchmark-delta-compression start` | Runs `tsx src/main.ts` |
| `pnpm --filter @statewalker/vcs-benchmark-delta-compression typecheck` | Runs `tsc --noEmit` |

### Configuration

Edit the constants in `src/main.ts`: `sizes` (bytes) and `mutationRates` (0 to 1). There are no flags or environment variables.

### Files

- `src/main.ts`: content generation, benchmark loop, table and summary
- [packages/vcs-utils/src/diff/delta/](../../../packages/vcs-utils/src/diff/delta/): the delta algorithm and formats being measured
- [packages/vcs-utils/tests/diff/performance/](../../../packages/vcs-utils/tests/diff/performance/): performance tests for the same functions
