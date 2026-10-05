# 10-custom-storage

## What it is

A runnable example that builds `History` instances five ways, from the zero-config `createMemoryHistory()` to composing every store by hand with `createHistoryFromStores()`, and ends with two `History` instances that share one object store but keep separate refs. Each pattern writes a blob, a tree and a commit, so you can see that all of them behave the same from the outside. Everything is in memory.

What you will learn:

- Which factory function fits which use case
- Building a `History` from a `GitObjectStore` with `createHistoryFromComponents()`
- Composing a `History` from explicit store instances with `createHistoryFromStores()`
- Sharing object storage between `History` instances while keeping refs independent
- The difference between `History` and `HistoryWithOperations`

It assumes you have seen [01-quick-start](../01-quick-start/).

## Layout

```
apps/examples/10-custom-storage/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    └── main.ts           # All five factory patterns in one file
```

How the layers stack, from bytes up:

```
 RawStorage (MemoryRawStorage, or your own)
      │  createGitObjectStore(storage)
      v
 GitObjectStore  ── one store for blobs, trees, commits and tags
      │  createBlobs / createTrees / createCommits / createTags
      v
 Blobs, Trees, Commits, Tags  +  Refs (createMemoryRefs, or an adapter)
      │  createHistoryFromStores({ blobs, trees, commits, tags, refs })
      v
 History
```

`createHistoryFromComponents()` does the middle two steps for you; `createMemoryHistory()` does all of them.

## How to run it

Requires Node 24 and pnpm. From the repository root:

```bash
pnpm install
pnpm --filter @statewalker/vcs-example-10-custom-storage start
```

`start` runs `tsx src/main.ts`. `typecheck` runs `tsc --noEmit`.

## The walk-through: five ways to get a History

All snippets import from `@statewalker/vcs-core`.

### Pattern 1: createMemoryHistory() wires everything for you

The fastest way to a working repository. It allocates a `MemoryRawStorage`, wraps it in a `GitObjectStore`, and uses in-memory refs. It returns the basic `History` interface.

```typescript
import { createMemoryHistory, type History } from "@statewalker/vcs-core";

const history: History = createMemoryHistory();
await history.initialize();
await history.refs.setSymbolic("HEAD", "refs/heads/main");

// Use history.blobs, .trees, .commits, .tags, .refs
```

### Pattern 2: createMemoryHistoryWithOperations() adds delta and serialization

When you need delta compression, pack serialization or transport, use `createMemoryHistoryWithOperations()`. It returns `HistoryWithOperations`, which adds `delta`, `serialization` and `capabilities`.

```typescript
import {
  createMemoryHistoryWithOperations,
  type HistoryWithOperations,
} from "@statewalker/vcs-core";

const history: HistoryWithOperations = createMemoryHistoryWithOperations();
await history.initialize();

console.log(JSON.stringify(history.capabilities));

const objectIds: string[] = [];
for await (const oid of history.collectReachableObjects(new Set([commitId]), new Set())) {
  objectIds.push(oid);
}
```

`collectReachableObjects(wants, exclude)` is part of the base `History` interface; it returns an async iterable of object ids reachable from `wants` and not from `exclude`.

### Pattern 3: createHistoryFromComponents() builds the typed stores from one object store

You supply a `GitObjectStore` and a refs choice; the factory creates the blob, tree, commit and tag stores over that one object store.

```typescript
import {
  createGitObjectStore,
  createHistoryFromComponents,
  MemoryRawStorage,
} from "@statewalker/vcs-core";

const objects = createGitObjectStore(new MemoryRawStorage());

const history = createHistoryFromComponents({
  objects,
  refs: { type: "memory" },
});
await history.initialize();
```

`refs` is either `{ type: "memory" }` or `{ type: "adapter", refStore }`, where `refStore` is an implementation of the core `RefStore` interface.

### Pattern 4: createHistoryFromStores() takes every store explicitly

For full control, build each store yourself. This is where you plug in a store that wraps an external database.

```typescript
import {
  createBlobs,
  createCommits,
  createGitObjectStore,
  createHistoryFromStores,
  createMemoryRefs,
  createTags,
  createTrees,
  MemoryRawStorage,
} from "@statewalker/vcs-core";

const objects = createGitObjectStore(new MemoryRawStorage());

const history = createHistoryFromStores({
  blobs: createBlobs(objects),
  trees: createTrees(objects),
  commits: createCommits(objects),
  tags: createTags(objects),
  refs: createMemoryRefs(),
});
await history.initialize();
```

The store factories all take a `GitObjectStore`. Any object that implements `Blobs`, `Trees`, `Commits`, `Tags` or `Refs` can replace the matching one.

### Pattern 5: two Histories over one object store

Two instances built from the same `GitObjectStore` see each other's objects immediately. Each `{ type: "memory" }` refs config creates its own ref store, so branches stay separate.

```typescript
const sharedObjects = createGitObjectStore(new MemoryRawStorage());

const historyA = createHistoryFromComponents({ objects: sharedObjects, refs: { type: "memory" } });
const historyB = createHistoryFromComponents({ objects: sharedObjects, refs: { type: "memory" } });

// A writes a commit; B can load it
const commitFromB = await historyB.commits.load(sharedCommit);

// B sets a branch; A does not see it
await historyB.refs.set("refs/heads/feature", sharedCommit);
await historyA.refs.resolve("refs/heads/feature"); // undefined
```

### What the run prints

Commit ids differ on every run because the timestamp is `Date.now() / 1000`. A real run:

```
=== Pattern 1: createMemoryHistory() ===
  ...
  Commit: 1e5b4e1
  Available APIs: blobs, trees, commits, tags, refs

=== Pattern 2: createMemoryHistoryWithOperations() ===
  ...
  Commit: f613970
  Additional APIs: delta, serialization, capabilities
  Capabilities: {"nativeBlobDeltas":false,"nativeTreeDeltas":true,"nativeCommitDeltas":false,"randomAccess":true,"atomicBatch":false,"nativeGitFormat":false}
  Reachable objects from commit: 3

=== Pattern 3: createHistoryFromComponents() ===
  ...
  Commit: 67e24c5
  All Git objects share a single MemoryRawStorage via GitObjectStore
  createHistoryFromComponents auto-builds typed stores (blobs, trees, commits, tags)

=== Pattern 4: createHistoryFromStores() ===
  ...
  Commit: 65c570d

=== Pattern 5: Shared Storage ===
  ...
  Workspace A wrote commit: 5052234
  Workspace B can read it: "Shared commit"
  Workspace A refs/heads/feature: not set
  Workspace B refs/heads/feature: 5052234

=== Decision Guide ===
  ...
Example completed successfully!
```

## Why it is the way it is

### Which factory to pick

| Need | Factory |
|------|---------|
| Quick tests, no delta or serialization | `createMemoryHistory()` |
| Tests with transport, packs or deltas | `createMemoryHistoryWithOperations()` |
| Your own `RawStorage`, or object storage shared between instances | `createHistoryFromComponents({ objects, refs })` |
| Your own store implementations (SQL, IndexedDB, ...) | `createHistoryFromStores({ blobs, trees, commits, tags, refs })` |
| Git-compatible files | `createGitFilesHistory(config)` from `@statewalker/vcs-core` (takes prebuilt stores plus a `packDeltaStore`), or `createGitFilesHistoryFromFiles(options)` from `@statewalker/vcs-store-files` |

Only the memory-with-operations and Git-files factories return `HistoryWithOperations`; the other three return plain `History`. Code that needs `delta` or `serialization` must be given one of those two.

### All object types share one GitObjectStore

Blobs, trees, commits and tags are stored as Git objects, with Git headers, in a single `GitObjectStore`. Object ids are then real Git SHA-1s and objects can go into a pack without conversion, which is what the transport layer needs. Swapping the backend means swapping the `RawStorage` underneath, not reimplementing four stores.

### Refs are separate from objects

Refs are passed in independently of the object store. That is what makes pattern 5 possible: object data is written once, while each instance keeps its own branch namespace (multiple workspaces, test isolation, read replicas).

## What will surprise you

- **Ref changes do not cross instances.** In pattern 5, `historyA.refs.resolve("refs/heads/feature")` returns `undefined` after B set it; the output says `not set`. Share a `Refs` instance (pass the same one to `createHistoryFromStores`) if you need shared branches.
- **Plain `History` has no `delta` or `serialization`.** Patterns 1, 3 and 4 return `History`, so there is no `history.serialization` to hand to APIs that need one, such as `createVcsRepositoryFacade({ history, serialization })`.
- **Store factories take a `GitObjectStore`, not a `RawStorage`.** `createBlobs(new MemoryRawStorage())` is a type error; wrap the storage with `createGitObjectStore()` first.
- **Commit ids change between runs**, because commit timestamps are taken from the clock.
- **Nothing persists.** Every pattern uses `MemoryRawStorage`; the data is gone when the process exits.
- **Pattern 4 allocates an unused `_customBlobStorage`.** It is leftover in `main.ts`; blobs go into the shared object store like everything else.

## Reference

### Commands

| Command | What it does |
|---------|--------------|
| `pnpm --filter @statewalker/vcs-example-10-custom-storage start` | Runs `tsx src/main.ts` |
| `pnpm --filter @statewalker/vcs-example-10-custom-storage typecheck` | Runs `tsc --noEmit` |

### API locations

| Function / class | Location | Purpose |
|------------------|----------|---------|
| `createMemoryHistory()` | [history/create-history.ts](../../../packages/core/src/history/create-history.ts) | Zero-config in-memory `History` |
| `createMemoryHistoryWithOperations()` | [history/create-history.ts](../../../packages/core/src/history/create-history.ts) | In-memory `HistoryWithOperations` |
| `createHistoryFromComponents()` | [history/create-history.ts](../../../packages/core/src/history/create-history.ts) | `History` from a `GitObjectStore` and refs config |
| `createHistoryFromStores()` | [history/create-history.ts](../../../packages/core/src/history/create-history.ts) | `History` from explicit stores |
| `createGitFilesHistory()` | [history/create-history.ts](../../../packages/core/src/history/create-history.ts) | `HistoryWithOperations` over Git-files stores |
| `History`, `HistoryWithOperations` | [history/history.ts](../../../packages/core/src/history/history.ts) | The interfaces |
| `createGitObjectStore()` | [history/objects/object-store.impl.ts](../../../packages/core/src/history/objects/object-store.impl.ts) | Wrap a `RawStorage` as a Git object store |
| `MemoryRawStorage` | [storage/raw/memory-raw-storage.ts](../../../packages/core/src/storage/raw/memory-raw-storage.ts) | In-memory `RawStorage` |
| `createBlobs()` | [history/blobs/blobs.impl.ts](../../../packages/core/src/history/blobs/blobs.impl.ts) | Blob store factory |
| `createTrees()` | [history/trees/trees.impl.ts](../../../packages/core/src/history/trees/trees.impl.ts) | Tree store factory |
| `createCommits()` | [history/commits/commits.impl.ts](../../../packages/core/src/history/commits/commits.impl.ts) | Commit store factory |
| `createTags()` | [history/tags/tags.impl.ts](../../../packages/core/src/history/tags/tags.impl.ts) | Tag store factory |
| `createMemoryRefs()` | [history/refs/refs.impl.ts](../../../packages/core/src/history/refs/refs.impl.ts) | In-memory ref store |

### Related examples

- [01-quick-start](../01-quick-start/): the basic Git workflow
- [06-internal-storage](../06-internal-storage/): storage layer internals
- [11-delta-strategies](../11-delta-strategies/): storage optimization with deltas
