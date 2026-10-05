# @statewalker/vcs-store-kv

StateWalker VCS stores (Git objects, refs, staging area, raw and delta binary storage) on top of
any key-value store. You supply a small `KVStore` adapter for your backend; this package does the
key layout and serialization. A `Map`-backed `MemoryKVAdapter` is included.

## Why it exists

Many places where a repository has to live offer only a key-value API: IndexedDB in the browser,
LevelDB or Redis on a server, an embedded KV in a worker. Writing a full set of VCS stores for each
of them would repeat the same Git logic many times. Here the Git side is written once against an
eight-method `KVStore` interface, and each backend only has to implement that interface.

## How to use

```bash
pnpm add @statewalker/vcs-store-kv
```

No peer dependencies. Runs in the browser, Node and workers; the environment is whatever your
adapter needs.

| Entry point | Gives |
| --- | --- |
| `@statewalker/vcs-store-kv` | Everything listed below |

| Export | What it is |
| --- | --- |
| `KVStore` (type) | The adapter contract: `get`, `set`, `delete`, `has`, `list(prefix)`, `getMany`, `setMany`, `compareAndSwap`, optional `close`. |
| `MemoryKVAdapter` | `Map`-backed `KVStore`. Copies values in and out. `close()` clears it. |
| `createKvObjectStores({ kv, prefix? })` | `{ objects, blobs, trees, commits, tags }` with **Git-compatible SHA-1 ids**, stored through a `KvRawStore`. |
| `KVRefStore` | `Refs` on a `KVStore`: direct and symbolic refs, compare-and-swap. |
| `KVStaging` | `Staging` (the index) on a `KVStore`. |
| `KVCommitStore`, `KVTreeStore`, `KVTagStore` | JSON-serialized `Commits` / `Trees` / `Tags` with scan-based queries. **Ids are not Git ids** (see Internals). |
| `KvRawStore`, `createKvRawStore(kv, prefix?)` | `RawStorage` (key to bytes) on a `KVStore`. |
| `KvDeltaStore`, `createKvDeltaStore(kv, prefix?)` | `DeltaStore` on a `KVStore`. |
| `KvBinStore`, `createKvBinStore(kv, rawPrefix?, deltaPrefix?)` | `BinStore` combining the two above. |
| `uint8ArrayEquals(a, b)` | Byte comparison helper for adapters implementing `compareAndSwap`. |
| `createGitObjectStore`, `createBlobs`, `createTrees`, `createCommits`, `createTags` | Re-exported from `@statewalker/vcs-core`. |

## Examples

### A repository in a key-value store

```ts
import { FileMode } from "@statewalker/vcs-core";
import {
  createKvObjectStores,
  KVRefStore,
  KVStaging,
  MemoryKVAdapter,
} from "@statewalker/vcs-store-kv";

const kv = new MemoryKVAdapter();
const stores = createKvObjectStores({ kv });
const staging = new KVStaging(kv);
const refs = new KVRefStore(kv);

const blobId = await stores.blobs.store([new TextEncoder().encode("hello\n")]);
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
await refs.resolve("HEAD"); // { name: "refs/heads/main", objectId: commitId, ... }

// Optimistic update of a branch
const result = await refs.compareAndSwap("refs/heads/main", commitId, commitId);
// { success: true, previousValue: commitId }
```

After this the adapter holds keys like:

```
objects::raw:ce013625...      objects::size:ce013625...   (blob)
objects::raw:853694aa...      objects::size:853694aa...   (tree)
objects::raw:8b459a2e...      objects::size:8b459a2e...   (commit)
staging:README.md<NUL>0
ref:refs/heads/main
ref:HEAD
```

### Writing an adapter

Implement `KVStore`. `compareAndSwap` must be atomic in your backend; `KVRefStore` relies on it.
A sketch for IndexedDB, with one object store whose keys are the strings above:

```ts
import { type KVStore, uint8ArrayEquals } from "@statewalker/vcs-store-kv";

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export class IdbKVAdapter implements KVStore {
  constructor(private db: IDBDatabase, private name = "vcs") {}

  private os(mode: IDBTransactionMode) {
    return this.db.transaction(this.name, mode).objectStore(this.name);
  }
  async get(key: string) {
    return (await req(this.os("readonly").get(key))) as Uint8Array | undefined;
  }
  async set(key: string, value: Uint8Array) {
    await req(this.os("readwrite").put(value, key));
  }
  async delete(key: string) {
    const os = this.os("readwrite");
    const existed = (await req(os.count(key))) > 0;
    await req(os.delete(key));
    return existed;
  }
  async has(key: string) {
    return (await req(this.os("readonly").count(key))) > 0;
  }
  async *list(prefix: string) {
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    for (const key of await req(this.os("readonly").getAllKeys(range))) yield key as string;
  }
  async getMany(keys: string[]) {
    const out = new Map<string, Uint8Array>();
    for (const k of keys) {
      const v = await this.get(k);
      if (v) out.set(k, v);
    }
    return out;
  }
  async setMany(entries: Map<string, Uint8Array>) {
    const os = this.os("readwrite");
    await Promise.all([...entries].map(([k, v]) => req(os.put(v, k))));
  }
  async compareAndSwap(key: string, expected: Uint8Array | undefined, next: Uint8Array) {
    const os = this.os("readwrite"); // get + put in one transaction
    const current = (await req(os.get(key))) as Uint8Array | undefined;
    if (!uint8ArrayEquals(current, expected)) return false;
    await req(os.put(next, key));
    return true;
  }
}
```

### Scan-based queries on the JSON stores

```ts
import { KVCommitStore, MemoryKVAdapter } from "@statewalker/vcs-store-kv";

const commits = new KVCommitStore(new MemoryKVAdapter());
const who = { name: "Ada", email: "ada@example.com", timestamp: 1700000000, tzOffset: "+0000" };
await commits.store({
  tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
  parents: [],
  author: who,
  committer: who,
  message: "fix: bug",
});

for await (const id of commits.findByAuthor("ada@example.com")) console.log(id);
for await (const id of commits.searchMessage("fix")) console.log(id); // case-insensitive substring
await commits.count(); // 1
```

`KVTreeStore` has `findTreesWithBlob(blobId)` and `findByNamePattern("*.ts")` (`*` and `?`
wildcards, case-insensitive). `KVTagStore` has `findByNamePattern`, `findByTagger(email)` and
`findByTargetType(type)`. Every one of them loads every object of its kind: cost is O(n) in the
number of stored objects.

### Binary storage with deltas

```ts
import { createKvBinStore, MemoryKVAdapter } from "@statewalker/vcs-store-kv";

const bin = createKvBinStore(new MemoryKVAdapter());
await bin.raw.store("base", (async function* () {
  yield new TextEncoder().encode("hello world");
})());
await bin.raw.size("base"); // 11

const update = bin.delta.startUpdate();
await update.storeDelta({ baseKey: "base", targetKey: "target" }, [
  { type: "start", targetLen: 5 },
  { type: "copy", start: 0, len: 5 },
  { type: "finish", checksum: 0 },
]);
await update.close();
await bin.delta.isDelta("target"); // true
```

## Internals

### Why the adapter contract has eight methods

`get`/`set`/`delete`/`has`/`list(prefix)` are the minimum to store and enumerate objects.
`getMany`/`setMany` let `KvRawStore` write an object's bytes and its size record in one call, so
a backend with batch writes can make that a single operation. `compareAndSwap` is what makes
`KVRefStore.compareAndSwap` safe when two writers move the same branch. Every method is async so
synchronous backends (a `Map`) and asynchronous ones (IndexedDB) fit the same interface.

### Key layout

All stores can share one `KVStore` because each writes under its own prefix:

| Store | Keys |
| --- | --- |
| `createKvObjectStores` (prefix `objects:`) / `KvRawStore` (prefix `raw`) | `<prefix>:raw:<key>` (bytes), `<prefix>:size:<key>` (4-byte little-endian length) |
| `KvDeltaStore` (prefix `delta`) | `<prefix>:delta:<targetKey>` (JSON) |
| `KVRefStore` | `ref:<name>`: `{"oid":…}` or `{"t":<target>}` |
| `KVStaging` | `staging:<path><NUL><stage>`, plus `staging:__meta__` |
| `KVCommitStore` / `KVTreeStore` / `KVTagStore` | `commit:<id>`, `tree:<id>`, `tag:<id>` (compact JSON) |

The default `objects:` prefix plus the `:` separator yields a double colon (`objects::raw:…`).
`list(prefix)` must be a real prefix scan; `KVRefStore.list()` and the query methods depend on it.

### Two kinds of object stores, and why their ids differ

`createKvObjectStores` serializes objects in Git format and hashes them with SHA-1 through the
same `@statewalker/vcs-core` codecs as the other backends. Its ids match native Git. Use it when
ids must interoperate (transport, packs, comparing with `git`).

`KVCommitStore`, `KVTreeStore` and `KVTagStore` store compact JSON (`{"t":…,"p":[…],"an":…}`) and
take ids from `computeCommitHash` / `computeTreeHash` / `computeTagHash`: a 32-bit FNV-1a hash
with a type prefix, zero-padded to 40 characters (`commitd0ac0057000…`). Ids are stable but are
not Git ids. The empty tree is always Git's `4b825dc642cb6eb9a060e54bf8d69288fbee4904`. These
stores add the scan-based query methods shown above.

### Raw storage holds whole values

`KvRawStore.store()` collects the whole stream into one value before writing, and `load()` reads
the whole value before slicing a range. Object size is bounded by what the backend accepts as a
single value and by memory.

### What breaks

| Situation | Symptom |
| --- | --- |
| `KvRawStore.load()` of a missing key | throws `Key not found: <key>` |
| `KvRawStore.size()` of a missing key | returns `-1` |
| A symbolic ref chain deeper than 100 | `Symbolic ref chain too deep (> 100)` |
| A nested annotated tag chain deeper than 100 with `getTarget(id, true)` | `Tag chain too deep (> 100)` |
| `refs.compareAndSwap(name, expected, next)` where `name` is a symbolic ref (for example `HEAD`) | always `{ success: false, errorMessage: "Concurrent modification detected" }`. The stored value is `{"t":…}`, not the `{"oid":…}` the swap compares against. Update the target branch instead. |
| `refs.compareAndSwap` with a stale `expected` | `{ success: false, errorMessage: "Expected <old>, found <current>" }` |
| `KVStaging.writeTree()` with conflict stages | `Cannot write tree with unresolved conflicts` |
| `KVStaging.resolveConflict()` with no entry at the chosen stage | `No entry at stage <n> for path: <path>` |
| Index builder `add()` without a mode / duplicate entry / stage 0 next to stages 1-3 | `FileMode not set for path <path>` / `Duplicate entry: <path> stage <n>` / `Invalid stages for <path>: stage 0 cannot coexist with other stages` |
| `storeDelta()` on an update after its `close()` | `Update already closed` |

### Dependencies

- `@statewalker/vcs-core`: store interfaces, Git object codecs, id hash functions, and the
  ancestry algorithms (`walkAncestry`, `findMergeBase`, `isAncestor`) `KVCommitStore` delegates to.
- `@statewalker/vcs-working-tree`: the `Staging` interface and merge-stage constants.
- `@statewalker/vcs-utils`: the `Delta` type.

## License

MIT
