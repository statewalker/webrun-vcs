# @statewalker/vcs-store-mem

In-memory implementations of the StateWalker VCS store interfaces: Git objects (blobs, trees,
commits, tags), refs, the staging area (index), and raw/delta binary storage. Everything lives in
JavaScript `Map`s and arrays and disappears with the instance.

## Why it exists

Code built on `@statewalker/vcs-core` and `@statewalker/vcs-working-tree` takes stores as
interfaces. Tests, examples and short-lived operations need an implementation of those interfaces
with no disk, no database and no setup. This package is that implementation. It is also the
reference behavior: the shared conformance suites in `@statewalker/vcs-testing` run against it
and against the persistent backends, so a difference between them points to a bug.

## How to use

```bash
pnpm add @statewalker/vcs-store-mem
```

No peer dependencies. Runs anywhere modern JavaScript runs (browser, Node, workers).

| Entry point | Gives |
| --- | --- |
| `@statewalker/vcs-store-mem` | Everything listed below |

| Export | What it is |
| --- | --- |
| `createMemoryObjectStores(options?)` | `{ objects, blobs, trees, commits, tags }` with **Git-compatible SHA-1 ids**, backed by a `MemoryRawStorage`. Pass `{ storage }` to reuse an existing one. |
| `MemoryStagingStore` | In-memory `Staging` (the index): entries, conflict stages, builder/editor, `readTree`/`writeTree`. |
| `MemoryRefStore` | In-memory `Refs` (re-exported from `@statewalker/vcs-core`). |
| `MemoryRawStorage` | In-memory `RawStorage` key/bytes map (re-exported from `@statewalker/vcs-core`). |
| `MemoryCommitStore`, `MemoryTreeStore`, `MemoryTagStore` | Object-map `Commits` / `Trees` / `Tags`. **Ids are not Git ids** (see Internals). |
| `MemBinStore`, `createMemBinStore()` | `BinStore` combining a `MemoryRawStorage` and a `MemDeltaStore`. |
| `MemDeltaStore` | `DeltaStore` that records base/target delta relationships. |

Use `createMemoryObjectStores()` when ids must match what `git` produces (interop, transport,
pack tests). Use the `Memory*Store` classes only where any stable, content-derived id is enough.

## Examples

### Git-compatible object stores, refs and staging

```ts
import { FileMode } from "@statewalker/vcs-core";
import {
  createMemoryObjectStores,
  MemoryRefStore,
  MemoryStagingStore,
} from "@statewalker/vcs-store-mem";

const stores = createMemoryObjectStores();
const refs = new MemoryRefStore();
const staging = new MemoryStagingStore();

// The real Git SHA-1 of "hello\n"
const blobId = await stores.blobs.store([new TextEncoder().encode("hello\n")]);
// -> "ce013625030ba8dba906f756967f9e9ca394464a"

await staging.setEntry({ path: "README.md", mode: FileMode.REGULAR_FILE, objectId: blobId });
const treeId = await staging.writeTree(stores.trees);

const who = { name: "Ada", email: "ada@example.com", timestamp: 1700000000, tzOffset: "+0000" };
const commitId = await stores.commits.store({
  tree: treeId,
  parents: [],
  author: who,
  committer: who,
  message: "init\n",
});

await refs.set("refs/heads/main", commitId);
await refs.setSymbolic("HEAD", "refs/heads/main");
const head = await refs.resolve("HEAD"); // { name: "refs/heads/main", objectId: commitId, ... }
```

### Fresh, isolated stores per test

```ts
import { beforeEach, expect, it } from "vitest";
import { createMemoryObjectStores, type MemoryObjectStores } from "@statewalker/vcs-store-mem";

let stores: MemoryObjectStores;
beforeEach(() => {
  stores = createMemoryObjectStores(); // nothing is shared between instances
});

it("stores a blob", async () => {
  const id = await stores.blobs.store([new TextEncoder().encode("test")]);
  expect(await stores.blobs.has(id)).toBe(true);
});
```

### Object-map stores (fast, non-Git ids)

```ts
import { MemoryCommitStore, MemoryTreeStore } from "@statewalker/vcs-store-mem";

const trees = new MemoryTreeStore();
const commits = new MemoryCommitStore();

const treeId = await trees.store([]); // empty tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
const who = { name: "Ada", email: "ada@example.com", timestamp: 1700000000, tzOffset: "+0000" };
const c1 = await commits.store({ tree: treeId, parents: [], author: who, committer: who, message: "a" });
const c2 = await commits.store({ tree: treeId, parents: [c1], author: who, committer: who, message: "b" });

await commits.isAncestor(c1, c2); // true
for await (const id of commits.walkAncestry(c2)) console.log(id); // c2, then c1
```

### Binary storage with deltas

```ts
import { createMemBinStore } from "@statewalker/vcs-store-mem";

const bin = createMemBinStore();
await bin.raw.store("base", (async function* () {
  yield new TextEncoder().encode("hello world");
})());

const update = bin.delta.startUpdate();
await update.storeDelta({ baseKey: "base", targetKey: "target" }, [
  { type: "start", targetLen: 5 },
  { type: "copy", start: 0, len: 5 },
  { type: "finish", checksum: 0 },
]);
await update.close(); // deltas become visible only after close()

await bin.delta.isDelta("target"); // true
bin.clear();
```

## Internals

### Two kinds of object stores, and why their ids differ

`createMemoryObjectStores()` serializes every object in Git format into a `MemoryRawStorage` and
hashes it with SHA-1. It uses the same `createGitObjectStore` / `createBlobs` / `createTrees` /
`createCommits` / `createTags` code as the persistent backends, so its ids match native Git.

`MemoryCommitStore`, `MemoryTreeStore` and `MemoryTagStore` keep plain JavaScript objects and skip
serialization. Their ids come from `computeCommitHash` / `computeTreeHash` / `computeTagHash` in
`@statewalker/vcs-core`: a 32-bit FNV-1a hash with a type prefix, zero-padded to 40 characters
(`commit2814e9b0000…`, `tree84b15896000…`, `tag…`). They are deterministic and content-derived,
but they are not Git ids. Do not mix them with ids from a Git-format store. The one exception is
the empty tree, which `MemoryTreeStore` always reports as Git's
`4b825dc642cb6eb9a060e54bf8d69288fbee4904`. `gpgSignature` is stored but not hashed.

### Copies in, copies out

The object-map stores deep-copy on `store` and on `load`, so mutating a returned commit, tree
entry or tag never changes stored state. Tree entries are sorted in Git canonical order
(directories compare as `name/`) before hashing.

### Staging keeps entries sorted

`MemoryStagingStore` keeps entries in one array sorted by `(path, stage)` and looks them up by
binary search. `read()`, `write()` and `isOutdated()` exist for interface compatibility; nothing
is persisted.

### What breaks

| Situation | Error |
| --- | --- |
| `staging.writeTree()` with conflict stages present | `Cannot write tree with unresolved conflicts` |
| Builder `add()` without a mode | `FileMode not set for path <path>` |
| Builder `finish()` with the same path and stage twice | `Duplicate entry: <path> stage <n>` |
| Builder `finish()` with stage 0 next to stages 1-3 | `Invalid stages for <path>: stage 0 cannot coexist with other stages` |
| `resolveConflict()` with an unknown resolution | `Invalid resolution: <value>` |
| `MemoryCommitStore.getParents()` on a missing id | `Commit <id> not found` |
| `MemoryTagStore.getTarget(id, true)` over more than 100 nested tags | `Tag chain too deep (> 100)` |
| `storeDelta()` on an update after its `close()` | `Update already closed` |

### Delta store limits

`MemDeltaStore` records which key is a delta of which base and keeps the delta instructions. The
update's `storeObject()` does nothing: full objects belong in the raw store. Chain walks stop at
depth 50. `getDeltaChainInfo()` always reports `originalSize: 0`, `compressedSize` is an estimate
from the instruction list, and the stored `ratio` is `1` or `0`. Do not use these numbers for
packing decisions.

### Dependencies

- `@statewalker/vcs-core`: store interfaces, Git object codecs, `MemoryRefStore`,
  `MemoryRawStorage`, and the ancestry algorithms (`walkAncestry`, `findMergeBase`,
  `isAncestor`) that `MemoryCommitStore` delegates to.
- `@statewalker/vcs-working-tree`: the `Staging` interface and merge-stage constants.
- `@statewalker/vcs-utils`: the `Delta` type.

## License

MIT
