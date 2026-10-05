# 11-delta-strategies

## What it is

A runnable example of the `DeltaApi` that `HistoryWithOperations` exposes for storage optimization, and of the low-level delta functions in `@statewalker/vcs-utils/diff`. It stores three versions of a growing `README.md`, inspects backend capabilities and delta state, shows the batch pattern used by garbage collection and repacking, inspects delta chains and dependents, and then computes, applies and verifies a delta between two versions byte by byte.

What you will learn:

- What `DeltaApi` offers: `isDelta`, `listDeltas`, `getDeltaChain`, `getDependents`, batches, and the per-type sub-APIs (`blobs`, optional `trees` and `commits`)
- The `startBatch` / `endBatch` / `cancelBatch` pattern for all-or-nothing delta changes
- Why `getDependents` matters for safe deletion
- Low-level delta computation with `createDeltaRanges`, `createDelta` and `applyDelta`

It assumes you have seen [06-internal-storage](../06-internal-storage/).

## Layout

```
apps/examples/11-delta-strategies/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    └── main.ts          # Setup, DeltaApi, batches, chains, low-level deltas
```

Two layers are involved:

```
 history.delta (DeltaApi)                    @statewalker/vcs-utils/diff
   ├─ blobs   (BlobDeltaApi)                   createDeltaRanges(base, target) -> DeltaRange*
   ├─ trees?  (TreeDeltaApi)                   createDelta(base, target, ranges) -> Delta*
   ├─ commits?(CommitDeltaApi)                 applyDelta(base, deltas) -> Uint8Array*
   └─ isDelta / getDeltaChain / listDeltas
      getDependents / start|end|cancelBatch
   storage-level: which objects are stored      byte-level: how a delta is computed
   as deltas, against which base                and replayed, independent of storage
```

## How to run it

Requires Node 24 and pnpm. From the repository root:

```bash
pnpm install
pnpm --filter @statewalker/vcs-example-11-delta-strategies start
```

`start` runs `tsx src/main.ts`. `typecheck` runs `tsc --noEmit`.

## The walk-through: from stored versions to a verified delta

### Setup: three similar versions of one file

The example creates three commits, each with an incrementally longer `README.md`. Near-identical blobs are what delta compression is for.

```typescript
const history: HistoryWithOperations = createMemoryHistoryWithOperations();
await history.initialize();
await history.refs.setSymbolic("HEAD", "refs/heads/main");

const blobIds: string[] = [];
for (let i = 0; i < versions.length; i++) {
  const blobId = await history.blobs.store([encoder.encode(versions[i])]);
  blobIds.push(blobId);
  // ... store a tree and a commit for each version, chaining parents
}
await history.refs.set("refs/heads/main", parentCommitId);

const size = await history.blobs.size(blobIds[0]);
```

### Step 1: capabilities tell you what the backend does natively

`history.capabilities` reports backend features; `history.delta` is the `DeltaApi`.

```typescript
console.log(`nativeBlobDeltas: ${history.capabilities.nativeBlobDeltas}`);
console.log(`randomAccess:     ${history.capabilities.randomAccess}`);
console.log(`atomicBatch:      ${history.capabilities.atomicBatch}`);
console.log(`nativeGitFormat:  ${history.capabilities.nativeGitFormat}`);
```

For the memory backend this prints `nativeBlobDeltas: false`, `randomAccess: true`, `atomicBatch: false`, `nativeGitFormat: false`.

### Step 2: checking delta state

`isDelta(id)` tells whether an object is stored as a delta (blobs first, then trees and commits when the backend has those sub-APIs). `listDeltas()` streams every relationship with its chain depth and ratio.

```typescript
for (const blobId of blobIds) {
  const isDelta = await history.delta.isDelta(blobId);
  console.log(`  ${blobId.slice(0, 7)} isDelta: ${isDelta}`);
}

for await (const rel of history.delta.listDeltas()) {
  console.log(
    `  Delta: ${rel.targetId.slice(0, 7)} -> ${rel.baseId.slice(0, 7)} ` +
      `(depth=${rel.depth}, ratio=${rel.ratio.toFixed(2)})`,
  );
}
```

`ratio` is delta size divided by target size.

### Step 3: batches make delta changes all-or-nothing

Delta changes made between `startBatch()` and `endBatch()` are applied together; `cancelBatch()` discards them. The example only opens and cancels a batch. The full pattern, as documented on `DeltaApi`, is:

```typescript
history.delta.startBatch();
try {
  for await (const blobId of blobsToProcess) {
    const result = await history.delta.blobs.findBlobDelta(blobId, candidates);
    if (result) {
      await history.delta.blobs.deltifyBlob(blobId, result.baseId, result.delta);
    }
  }
  await history.delta.endBatch();
} catch (error) {
  history.delta.cancelBatch();
  throw error;
}
```

`candidates` is an `AsyncIterable<ObjectId>` of possible bases. `BlobDeltaApi` also has `undeltifyBlob`, `isBlobDelta` and `getBlobDeltaChain`.

### Step 4: chains and dependents

`getDeltaChain(id)` returns `{ depth, totalSize, baseIds }` for an object stored as a delta, or `undefined` for a full object. `getDependents(baseId)` yields the objects stored as deltas against a base.

```typescript
for (const blobId of blobIds) {
  const chain = await history.delta.getDeltaChain(blobId);
  if (chain) {
    console.log(`  ${blobId.slice(0, 7)}: depth=${chain.depth}, totalSize=${chain.totalSize}`);
    console.log(`    baseIds: ${chain.baseIds.map((id) => id.slice(0, 7)).join(" -> ")}`);
  } else {
    console.log(`  ${blobId.slice(0, 7)}: stored as full object (no delta chain)`);
  }
}

for (const blobId of blobIds) {
  const dependents: string[] = [];
  for await (const depId of history.delta.getDependents(blobId)) {
    dependents.push(depId.slice(0, 7));
  }
}
```

### Step 5: computing and replaying a delta by hand

`@statewalker/vcs-utils/diff` works on `Uint8Array`s, independent of any storage.

```typescript
const { createDeltaRanges, createDelta, applyDelta } = await import("@statewalker/vcs-utils/diff");

const baseContent = encoder.encode(versions[0]);
const targetContent = encoder.encode(versions[1]);

// { from: "source", start, len } = copy from base; { from: "target", start, len } = insert
const ranges = [...createDeltaRanges(baseContent, targetContent)];

// start, copy, insert and finish instructions (finish carries a checksum)
const deltaInstructions = [...createDelta(baseContent, targetContent, ranges)];

// Replay against the base; yields chunks to concatenate
const reconstructed = [...applyDelta(baseContent, deltaInstructions)];
```

The example concatenates the chunks and checks the result equals the target.

### What the run prints

Blob ids are stable (the content is fixed); commit ids are not printed. A real run, trimmed:

```
=== Setup: Create Repository with Similar Content ===

  Created 3 commits with incrementally evolving README.md
  Version 1: blob 6cc518e (167 bytes)
  Version 2: blob 2609df3 (238 bytes)
  Version 3: blob 97149c1 (302 bytes)

=== Step 1: Understanding DeltaApi ===
  ...
  Backend capabilities:
    nativeBlobDeltas: false
    randomAccess:     true
    atomicBatch:      false
    nativeGitFormat:  false

=== Step 2: Check Delta State ===

  6cc518e isDelta: false
  2609df3 isDelta: false
  97149c1 isDelta: false
  Total delta relationships: 0

=== Step 3: Batch Operations ===
  ...
  Batch started.
  (In production, deltify blobs here using findBlobDelta + deltifyBlob)
  Batch cancelled (demo - no actual deltas applied).

=== Step 4: Delta Chain Inspection ===
  ...
  6cc518e: stored as full object (no delta chain)
  2609df3: stored as full object (no delta chain)
  97149c1: stored as full object (no delta chain)
  ...
  6cc518e dependents: none
  2609df3 dependents: none
  97149c1 dependents: none

=== Step 5: Low-Level Delta Utilities ===
  ...
  Base size:     167 bytes
  Target size:   238 bytes
  Delta ranges:  6 total
    Copy:   3 ranges (161 bytes from base)
    Insert: 3 ranges (77 bytes literal)

  Delta instructions: 8
  Delta data size:   238 bytes
  Savings:           0 bytes
  Reconstruction: matches original
  ...
Example completed successfully!
```

## Why it is the way it is

### Blob deltas are always available; tree and commit deltas depend on the backend

`DeltaApi.blobs` is required; `trees` and `commits` are optional. Blobs are most of a repository's bytes and successive versions of a file delta well. Trees and commits are small and read often, so whether storing them as deltas pays off depends on the backend: the Git-files backend uses binary deltas for trees and commits, the memory backend provides structural tree deltas (`nativeTreeDeltas: true`, see example 10's output) and no commit deltas. Pack serialization for the wire can use deltas for every type regardless.

### Batches exist for GC and repacking

Repacking rewrites many objects as deltas against new bases. Stopping halfway would leave some objects pointing at bases that are about to change. Batching makes the whole rewrite one unit: `endBatch()` commits, `cancelBatch()` discards.

### Dependents guard deletion

A base cannot be deleted while objects are stored as deltas against it; `getDependents(baseId)` is how GC checks that before removing anything.

### Two layers, so the algorithm is reusable

The delta algorithm in `@statewalker/vcs-utils/diff` has no knowledge of storage; the same functions serve internal delta storage, pack writing and transport. `createDeltaRanges` uses a rolling hash over `blockSize` (default 16) byte blocks; `createDelta` turns ranges into instructions with a checksum; serializers (`deltaToGitFormat`, `serializeDeltaToFossil`) turn instructions into bytes.

## What will surprise you

- **On the memory backend, the `DeltaApi` is a no-op for blobs.** `createMemoryHistoryWithOperations()` has no blob delta tracker: `findBlobDelta` always returns `null`, `deltifyBlob` and `undeltifyBlob` silently do nothing, `listDeltas` and `getDependents` yield nothing, and batches only count nesting. That is why every blob prints `isDelta: false` and `stored as full object`, and why the example cancels its batch. Use a Git-files history to see blob deltas take effect.
- **`endBatch()` without `startBatch()` throws** `No batch in progress`. `cancelBatch()` with no open batch does nothing.
- **"Savings: 0 bytes" is a measuring error in the example, not a property of the delta.** Step 5 counts a copy instruction as `len` bytes, so "Delta data size" always equals the target size. A copy instruction costs a few bytes when encoded; measure the real size with `deltaToGitFormat(baseContent.length, deltaInstructions).length` from the same subpath. For the version 1 to version 2 delta that is 92 bytes for a 238-byte target.
- **`createDeltaRanges` throws `blockSize must be >= 1`** for a non-positive block size. If the base is empty it emits a single insert of the whole target (nothing for an empty target).
- **`applyDelta` yields chunks, not one buffer.** Concatenate them, as the example does, before comparing.

## Reference

### Commands

| Command | What it does |
|---------|--------------|
| `pnpm --filter @statewalker/vcs-example-11-delta-strategies start` | Runs `tsx src/main.ts` |
| `pnpm --filter @statewalker/vcs-example-11-delta-strategies typecheck` | Runs `tsc --noEmit` |

### API locations

| Interface / function | Location | Purpose |
|----------------------|----------|---------|
| `DeltaApi` | [storage/delta/delta-api.ts](../../../packages/core/src/storage/delta/delta-api.ts) | Delta operations and batches |
| `BlobDeltaApi` | [storage/delta/blob-delta-api.ts](../../../packages/core/src/storage/delta/blob-delta-api.ts) | Blob delta operations |
| `DeltaEngine` | [storage/delta/delta-engine.ts](../../../packages/core/src/storage/delta/delta-engine.ts) | Delta computation engine |
| `DeltaStore` | [storage/delta/delta-store.ts](../../../packages/core/src/storage/delta/delta-store.ts) | Delta relationship storage |
| `DeltaIndex` | [storage/delta/delta-index.ts](../../../packages/core/src/storage/delta/delta-index.ts) | Delta lookup index |
| `MemoryDeltaApi` | [backend/memory-storage-backend.ts](../../../packages/core/src/backend/memory-storage-backend.ts) | The memory backend's `DeltaApi` |
| `Blobs` | [history/blobs/](../../../packages/core/src/history/blobs/) | Blob storage |
| `Commits` | [history/commits/](../../../packages/core/src/history/commits/) | Commit storage |
| `createDeltaRanges` | [diff/delta/create-delta-ranges.ts](../../../packages/utils/src/diff/delta/create-delta-ranges.ts) | Copy/insert ranges between buffers |
| `createDelta` | [diff/delta/create-delta.ts](../../../packages/utils/src/diff/delta/create-delta.ts) | Delta instructions from ranges |
| `applyDelta` | [diff/delta/apply-delta.ts](../../../packages/utils/src/diff/delta/apply-delta.ts) | Rebuild the target from base and instructions |
| `Delta`, `DeltaRange` | [diff/delta/types.ts](../../../packages/utils/src/diff/delta/types.ts) | Instruction and range types |

### Related examples

- [06-internal-storage](../06-internal-storage/): loose objects and pack files
- [10-custom-storage](../10-custom-storage/): building storage backends
- [09-repository-access](../09-repository-access/): transport layer integration
