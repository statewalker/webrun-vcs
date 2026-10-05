# 06-internal-storage

A runnable tutorial on how objects are stored on disk, using the low-level APIs of `@statewalker/vcs-core`, `@statewalker/vcs-store-files` and `@statewalker/vcs-utils`. It writes loose objects into a real `.git` directory, bundles them into a pack file with an index, deletes the loose copies, uses the blob store as a plain content-addressable store, and walks through delta compression. The repository it builds is a valid Git repository that the `git` command line can read.

## Steps share one on-disk repository under `test-repo/`

```
apps/examples/06-internal-storage/
├── package.json
├── tsconfig.json
├── .gitignore                           # ignores test-repo/
└── src/
    ├── main.ts                          # Runs all steps, or one step with --step=NN
    ├── shared/
    │   └── index.ts                     # Paths, file-backed History factory, disk helpers
    └── steps/
        ├── 01-loose-objects.ts          # blobs, tree, commit as loose objects
        ├── 02-pack-files.ts             # PackWriterStream + writePackIndexV2
        ├── 03-garbage-collection.ts     # delete loose copies of packed objects
        ├── 04-direct-storage.ts         # blobs.store()/load() without a commit
        └── 05-delta-internals.ts        # createDeltaRanges/createDelta/applyDelta
```

At runtime the app creates this in the current working directory:

```
test-repo/
└── .git/
    ├── HEAD                     # ref: refs/heads/main
    ├── config
    ├── refs/heads/main          # written by step 01
    └── objects/
        ├── 16/364579dc...       # loose objects (removed again by step 03)
        └── pack/
            ├── pack-<sha>.pack  # written by step 02
            └── pack-<sha>.idx
```

Steps 01-04 share state through the `state` object in `shared/index.ts`: step 01 creates the History, steps 02-04 use it. Step 05 works on in-memory buffers only.

## How to run it

Requires Node 24 and pnpm. From the repository root:

1. Install the workspace:

   ```bash
   pnpm install
   ```

2. Run all steps:

   ```bash
   pnpm --filter @statewalker/vcs-example-06-internal-storage start
   ```

3. Or run up to one step. `step:NN` runs `tsx src/main.ts --step=NN`, which runs every earlier step first and then step NN, because each step needs the repository state the previous ones left:

   ```bash
   pnpm --filter @statewalker/vcs-example-06-internal-storage step:01  # Loose objects
   pnpm --filter @statewalker/vcs-example-06-internal-storage step:02  # Pack files
   pnpm --filter @statewalker/vcs-example-06-internal-storage step:03  # Garbage collection
   pnpm --filter @statewalker/vcs-example-06-internal-storage step:04  # Direct storage
   pnpm --filter @statewalker/vcs-example-06-internal-storage step:05  # Delta internals
   ```

4. Optionally inspect the result with Git. `pnpm --filter` runs the script inside the app directory, so `test-repo/` lands in `apps/examples/06-internal-storage/`:

   ```bash
   git -C apps/examples/06-internal-storage/test-repo log --oneline main
   ```

## The walk-through

### Step 1: Every object starts as one compressed file named by its hash

**File:** [src/steps/01-loose-objects.ts](src/steps/01-loose-objects.ts)

The step deletes any previous `test-repo/`, builds a file-backed History, and stores two blobs, a tree and a commit. Each becomes a loose object: a zlib-compressed file under `.git/objects/`, where the first two hex characters of the SHA-1 are the directory and the remaining 38 the file name. The step then reads one back with `decompressBlock()` to show the `type size\0content` layout.

The History is assembled from parts in `shared/index.ts`, because the example needs the raw object store as well as the typed stores:

```typescript
import { createGitObjectStore, createHistoryFromComponents, FileMode } from "@statewalker/vcs-core";
import { createFileRefStore, FileRawStorage } from "@statewalker/vcs-store-files";
import { setCompressionUtils } from "@statewalker/vcs-utils";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";

setCompressionUtils(createNodeCompression());

const files = createNodeFilesApi({ rootDir: "test-repo" });
const objects = createGitObjectStore(new FileRawStorage(files, ".git/objects"));
const history = createHistoryFromComponents({
  objects,
  refs: { type: "adapter", refStore: createFileRefStore(files, ".git") },
});
await history.initialize();

const blobId = await history.blobs.store([new TextEncoder().encode("# Internal Storage Example")]);
const treeId = await history.trees.store([
  { mode: FileMode.REGULAR_FILE, name: "README.md", id: blobId },
]);
```

The app's `createFileHistory()` also creates the `.git` directory skeleton, `HEAD` and `config` when called with `create: true`.

Output of the run:

```
  Total loose objects: 4
[07:32:23]   .git/objects/16/364579dc8e1ee6bc0e791373dff6ed53bf07f3
...
[07:32:23] Object 577c0fd structure:
    Compressed size: 76 bytes
    Decompressed size: 72 bytes
    Header: blob 64
```

**Key APIs:**
- `history.blobs.store(chunks)` - store content as a blob, returns its SHA-1 id
- `history.trees.store(entries)` - store a tree from `{ mode, name, id }` entries
- `history.commits.store(commit)` - store a commit
- `history.refs.set(name, id)`, `history.refs.setSymbolic("HEAD", target)` - write refs
- `decompressBlock(data)` - inflate raw zlib data for inspection

### Step 2: A pack bundles objects into one file with an index

**File:** [src/steps/02-pack-files.ts](src/steps/02-pack-files.ts)

The step reads each loose object from disk, adds it to a `PackWriterStream`, and writes `pack-<checksum>.pack` and `pack-<checksum>.idx` into `.git/objects/pack/`. It then decodes the 12-byte pack header (`PACK`, version 2, object count).

```typescript
import { ObjectType, PackWriterStream, writePackIndexV2 } from "@statewalker/vcs-core";
import { bytesToHex } from "@statewalker/vcs-utils";

const packWriter = new PackWriterStream();
await packWriter.addObject(objectId, ObjectType.BLOB, content);

const result = await packWriter.finalize();
const packName = `pack-${bytesToHex(result.packChecksum)}`;
await fs.writeFile(`${packName}.pack`, result.packData);

const indexData = await writePackIndexV2(result.indexEntries, result.packChecksum);
await fs.writeFile(`${packName}.idx`, indexData);
```

The objects are added whole; this pack contains no deltas.

**Key APIs:**
- `new PackWriterStream()` - build a pack incrementally
- `packWriter.addObject(id, type, content)` - add an object with its uncompressed content
- `packWriter.finalize()` - returns `packData`, `indexEntries` and `packChecksum`
- `writePackIndexV2(entries, packChecksum)` - build a version 2 `.idx` file

### Step 3: Garbage collection here means deleting the loose copies

**File:** [src/steps/03-garbage-collection.ts](src/steps/03-garbage-collection.ts)

Once every loose object is also in the pack, the loose files are redundant. The step closes the History, deletes every loose object file and any empty fan-out directory, and reopens the History. It does not check reachability, prune, or repack; it relies on step 02 having packed every loose object.

```typescript
import { countLooseObjects, listPackFiles } from "../shared/index.js";

const { count: looseBefore, objects: looseObjectIds } = await countLooseObjects();

for (const objectId of looseObjectIds) {
  await fs.unlink(path.join(OBJECTS_DIR, objectId.substring(0, 2), objectId.substring(2)));
}

const { count: looseAfter } = await countLooseObjects(); // 0
```

**Helpers (in `shared/index.ts`):**
- `countLooseObjects()` - count and list loose object ids on disk
- `listPackFiles()` - names of `.pack` files
- `getPackFileStats()` - size of each pack

### Step 4: The blob store works as a content-addressable store on its own

**File:** [src/steps/04-direct-storage.ts](src/steps/04-direct-storage.ts)

Blobs can be stored and loaded without staging or committing. The id is the hash of the content, so storing the same bytes twice returns the same id and stores nothing new. The step stores text, JSON and binary data, and reads type and size with `objects.getHeader()` without loading the content.

```typescript
const version1 = new TextEncoder().encode("Version 1 content");
const id1 = await history.blobs.store([version1]);
const id3 = await history.blobs.store([version1]);
console.log(id1 === id3); // true

const chunks: Uint8Array[] = [];
const stream = await history.blobs.load(id1);
if (stream) {
  for await (const chunk of stream) chunks.push(chunk);
}

const header = await history.objects.getHeader(id1); // { type: "blob", size: 17 }
```

**Key APIs:**
- `history.blobs.store(chunks)` - store bytes, returns the content-addressed id
- `history.blobs.load(id)` - content as an async iterable of chunks
- `objects.getHeader(id)` - object type and size

### Step 5: A delta is copy and insert instructions against a base

**File:** [src/steps/05-delta-internals.ts](src/steps/05-delta-internals.ts)

A delta rebuilds a target from a base with two kinds of instructions: copy a range of bytes from the base, or insert literal bytes. `createDeltaRanges()` finds the ranges, `createDelta()` turns them into instructions framed by `start` and `finish`, and `applyDelta()` replays them.

```typescript
import { applyDelta, createDelta, createDeltaRanges } from "@statewalker/vcs-utils/diff";

const base = new TextEncoder().encode("Hello World! This is the original content.");
const target = new TextEncoder().encode("Hello World! This is the modified content.");

const ranges = [...createDeltaRanges(base, target)];
// [{ from: "source", start: 0, len: 25 }, { from: "target", start: 25, len: 17 }]

const delta = [...createDelta(base, target, ranges)];
// start, copy, insert, finish

const chunks = [...applyDelta(base, delta)];
```

Output of the run:

```
  COPY 25 bytes from base at offset 0
  INSERT 17 bytes: "modified content."
...
  START: source=42, target=42
  COPY: 25 bytes from offset 0
  INSERT: 17 bytes
  FINISH: checksum=2926707683
```

The step then deltas a 271-byte document against a 362-byte revision and prints a size estimate (about 69% smaller than the full target). The estimate uses fixed per-instruction overheads; it is not the size of an encoded Git delta.

**Key APIs:**
- `createDeltaRanges(base, target)` - matching (`from: "source"`) and new (`from: "target"`) ranges
- `createDelta(base, target, ranges)` - delta instructions
- `applyDelta(base, delta)` - reconstruct the target as chunks

## Why it is the way it is

- **A real directory, not memory.** Loose objects and packs are files; the point of the example is to look at them. Writing a standard `.git` layout means `git` can verify the result.
- **The History is built from parts.** `createHistoryFromComponents()` with a `FileRawStorage` keeps a handle on the `GitObjectStore`, which step 04 needs for `getHeader()`. `FileRawStorage` compresses with zlib by default, which is what makes the files valid loose objects.
- **Compression is installed first.** `shared/index.ts` calls `setCompressionUtils(createNodeCompression())` at import time, before any storage call, so compression and decompression (including `decompressBlock()` in steps 01-02) use the Node implementation from `@statewalker/vcs-utils-node`.
- **Steps run cumulatively.** Steps 02-04 operate on the repository step 01 created, so `--step=NN` runs the earlier steps first instead of failing.

## What will surprise you

- **It writes `test-repo/` into the current working directory.** With `pnpm --filter ... start` that is the app directory (ignored by the app's `.gitignore`). Running `tsx src/main.ts` from elsewhere creates `test-repo/` there. Step 01 deletes and recreates it on every run.
- **After step 03 the History cannot read the packed objects.** The History reads only loose objects through `FileRawStorage`; nothing in the example registers the pack for reading. After the loose copies are deleted, `history.commits.load()` of the step 01 commit returns `undefined`. `git` itself reads the pack fine. Step 04 still works because it only stores and loads new blobs, which are written as new loose objects.
- **Garbage collection does not check what was packed.** Step 03 deletes every loose object it finds. Anything written after step 02 and before step 03 would be lost.
- **Ids and timestamps change on every run.** The commit uses the current time, and log lines are prefixed with the wall-clock time.
- **Unknown step names exit with code 1.** `--step=09` prints `Unknown step: 09` and the list of valid `--step=` values. A step that throws prints `Step <name> failed:` (all-steps mode) or `Fatal error:` and exits with code 1. Steps 02-04 throw `History not initialized. Run step 01 first.` if called without step 01, which only happens when the step modules are imported directly.

## Reference

### Commands

| Command | What it runs |
|---------|--------------|
| `pnpm --filter @statewalker/vcs-example-06-internal-storage start` | `tsx src/main.ts` (all steps) |
| `pnpm --filter @statewalker/vcs-example-06-internal-storage step:01` ... `step:05` | `tsx src/main.ts --step=NN` (steps 01..NN) |
| `pnpm --filter @statewalker/vcs-example-06-internal-storage typecheck` | `tsc --noEmit` |

### Source of the APIs used

| API | Location |
|-----|----------|
| `createHistoryFromComponents` | [packages/core/src/history/create-history.ts](../../../packages/core/src/history/create-history.ts) |
| `createGitObjectStore`, `GitObjectStore` | [packages/core/src/history/objects/](../../../packages/core/src/history/objects/) |
| `PackWriterStream` | [packages/core/src/pack/pack-writer.ts](../../../packages/core/src/pack/pack-writer.ts) |
| `writePackIndexV2` | [packages/core/src/pack/pack-index-writer.ts](../../../packages/core/src/pack/pack-index-writer.ts) |
| `FileRawStorage` | [packages/store-files/src/storage/raw/file-raw-storage.ts](../../../packages/store-files/src/storage/raw/file-raw-storage.ts) |
| `createFileRefStore` | [packages/store-files/src/refs/ref-store.files.ts](../../../packages/store-files/src/refs/ref-store.files.ts) |
| `createDeltaRanges` | [packages/utils/src/diff/delta/create-delta-ranges.ts](../../../packages/utils/src/diff/delta/create-delta-ranges.ts) |
| `createDelta` | [packages/utils/src/diff/delta/create-delta.ts](../../../packages/utils/src/diff/delta/create-delta.ts) |
| `applyDelta` | [packages/utils/src/diff/delta/apply-delta.ts](../../../packages/utils/src/diff/delta/apply-delta.ts) |
| `decompressBlock`, `setCompressionUtils` | [packages/utils/src/compression/compression/index.ts](../../../packages/utils/src/compression/compression/index.ts) |

### Related examples

- [03-object-model](../03-object-model/) - blobs, trees, commits and tags
- [11-delta-strategies](../11-delta-strategies/) - delta compression strategies
