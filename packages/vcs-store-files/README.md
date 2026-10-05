# @statewalker/vcs-store-files

StateWalker VCS storage that reads and writes a standard `.git` directory: zlib-compressed loose
objects, pack files with their `.idx`, loose and packed refs, reflogs, the binary index file, and
the state files of merge, rebase, cherry-pick, revert and stash. All I/O goes through a `FilesApi`,
so the same code runs against the Node filesystem or any other `FilesApi` implementation.

## Why it exists

A repository written by this package is a repository `git` can open, and the reverse: `git log`,
`git status` and `git fsck` work on it, and it can read what `git init`, `git commit`,
`git pack-refs` and `git repack` produce. That is the point of a file backend. It lets an
application keep its data where other Git tools already look, and move between StateWalker code
and the `git` binary without import or export. The other backends (`@statewalker/vcs-store-mem`,
`-kv`, `-sql`) are for places with no filesystem.

## How to use

```bash
pnpm add @statewalker/vcs-store-files
```

No peer dependencies. You need a `FilesApi`: in Node, `createNodeFilesApi({ rootDir })` from
`@statewalker/vcs-utils-node/files`; in tests, `createInMemoryFilesApi()` from
`@statewalker/vcs-core`.

| Entry point | Gives |
| --- | --- |
| `@statewalker/vcs-store-files` | Everything listed below |

Main exports:

| Export | What it is |
| --- | --- |
| `createGitFilesBackend({ files, gitDir?, create?, defaultBranch? })` | `{ history, objects, packDirectory, looseStorage }` over a `.git` directory. `create: true` writes `HEAD`, `config`, `objects/`, `refs/heads`, `refs/tags`. |
| `createGitFilesHistoryFromFiles(options)` | Same options, returns a `HistoryWithOperations` (adds `delta` and `serialization` backed by the pack directory). |
| `FileStagingStore(files, indexPath)` | `Staging` stored in Git's binary index format (`.git/index`). |
| `createFileWorktree({ files, rootPath, blobs, trees, gitDir? })` / `FileWorktree` | `Worktree` over the working directory, with `.gitignore` support and `checkoutTree`. |
| `gc({ history, files, gitDir?, dryRun? })` | Deletes loose objects not reachable from any ref. |
| `repack({ looseStorage, packDirectory, dryRun? })` | Moves all loose objects into one new pack. |
| `FileGcStrategy({ looseStorage, packDirectory })` | `GcStrategy` for `@statewalker/vcs-core`: `prune`, `compact` (= `repack`), `getStats`. |

Lower-level building blocks, also exported:

| Area | Exports |
| --- | --- |
| Loose objects | `FileRawStorage` (`compress` option, default `true`), `PackDirectoryAdapter` (read-only `RawStorage` over packs), `FileVolatileStore` / `createFileVolatileStore` (temp files for large content) |
| Packs | `PackDirectory`, `PackReader`, `PackDeltaStore`, `PackConsolidator`, `RandomAccessDeltaReader`, `GitPackStoreImpl` / `createGitPackStore`, `DirectPackObjectReader`, `isDeltaType` |
| Refs | `FileRefStore` / `createFileRefStore(files, gitDir)`; functions `readRef`, `resolveRef`, `readAllRefs`, `getRefsByPrefix`, `writeRef`, `writeObjectRef`, `writeSymbolicRef`, `updateRef`, `deleteRef`, `readPackedRefs`, `writePackedRefs`, `packRefs`, `appendReflog`, `createReflogReader`, and the parsers `parseRefContent`, `parsePackedRefs`, `parseReflogLine` |
| Working copy | `GitWorkingCopy`, `GitWorkingCopyFactory` / `createGitWorkingCopyFactory`, `GitWorkingCopyConfig` / `createWorkingCopyConfig` (reads and writes `.git/config`), `GitCheckout` / `createGitCheckout`, `GitStashStore` / `createGitStashStore` (`refs/stash`) |
| Operation state | `GitTransformationStore` / `createTransformationStore(files, gitDir)`, the merge/rebase/cherry-pick/revert/sequencer stores, `GitResolutionStore`, `detectRepositoryState(files, gitDir, hasConflicts)` and `readMergeState` / `readRebaseState` / `readCherryPickState` / `readRevertState` |

## Examples

### Create a repository `git` can read

```ts
import { FileMode } from "@statewalker/vcs-core";
import { createFileWorktree, createGitFilesBackend, FileStagingStore } from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";

const files = createNodeFilesApi({ rootDir: "/tmp/demo" });
const { history } = await createGitFilesBackend({ files, create: true }); // HEAD -> refs/heads/main
await history.initialize();

const blobId = await history.blobs.store([new TextEncoder().encode("hello\n")]);

const staging = new FileStagingStore(files, ".git/index");
await staging.read();
await staging.setEntry({ path: "README.md", mode: FileMode.REGULAR_FILE, objectId: blobId, size: 6 });
const treeId = await staging.writeTree(history.trees);
await staging.write(); // writes .git/index

const who = { name: "Ada", email: "ada@example.com", timestamp: 1700000000, tzOffset: "+0000" };
const commitId = await history.commits.store({
  tree: treeId,
  parents: [],
  author: who,
  committer: who,
  message: "init\n",
});
await history.refs.set("refs/heads/main", commitId);

// Write README.md into the working directory
const worktree = createFileWorktree({
  files,
  rootPath: "",
  blobs: history.blobs,
  trees: history.trees,
  gitDir: ".git",
});
await worktree.checkoutTree(treeId); // { updated: ["README.md"], removed: [], conflicts: [], failed: [] }
```

```console
$ cd /tmp/demo && git log --oneline && git status --short && git fsck
8b459a2 init
```

### Open an existing repository

```ts
import { createGitFilesHistoryFromFiles } from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";

const history = await createGitFilesHistoryFromFiles({
  files: createNodeFilesApi({ rootDir: "/path/to/repo" }),
}); // gitDir defaults to ".git"; loose objects and existing packs are both readable
await history.initialize();

const head = await history.refs.resolve("HEAD");
const commit = head?.objectId ? await history.commits.load(head.objectId) : undefined;
```

For a bare repository pass `gitDir: "."` with `rootDir` pointing at the repository directory.

### Garbage-collect and pack

```ts
import { createGitFilesBackend, FileGcStrategy, gc, repack } from "@statewalker/vcs-store-files";

const { history, looseStorage, packDirectory } = await createGitFilesBackend({ files });

await gc({ history, files, dryRun: true }); // { removedObjects, reachableObjects, totalLooseObjects }
await gc({ history, files }); // deletes unreachable loose objects

const packed = await repack({ looseStorage, packDirectory });
// { packName: "pack-<sha1>", objectCount: 3, looseObjectsRemoved: 3 }, or null if nothing is loose

await new FileGcStrategy({ looseStorage, packDirectory }).getStats();
// { looseObjectCount: 0, packedObjectCount: 3, totalSize: 0, packCount: 1 }
```

### Refs at the file level

```ts
import { createFileRefStore, readAllRefs } from "@statewalker/vcs-store-files";

const refs = createFileRefStore(files, ".git");
await refs.setSymbolic("HEAD", "refs/heads/main");
await refs.resolve("HEAD"); // follows HEAD to refs/heads/main, loose or packed

for (const ref of await readAllRefs(files, ".git")) console.log(ref.name); // refs/ by default
```

## Internals

### The storage stack

```
History (blobs / trees / commits / tags / refs)
  └─ GitObjectStore          adds and strips the "type size\0" header, computes SHA-1
       └─ CompositeRawStorage
            ├─ FileRawStorage          read/write  .git/objects/ab/cdef...   (zlib)
            └─ PackDirectoryAdapter    read-only   .git/objects/pack/*.pack + *.idx
  └─ FileRefStore            .git/HEAD, .git/refs/**, .git/packed-refs, .git/logs/**
```

New objects are always written loose. Packs are only read, until `repack()` turns loose objects
into a pack. This keeps writes simple (one file per object, no pack index to rewrite) and matches
how `git` itself behaves between `git gc` runs. `PackDirectory` keeps at most 10 open packs in
its cache by default (`maxCachedPacks`).

### Reachability is computed from refs only

`gc()` collects every ref tip, walks `history.collectReachableObjects`, and deletes each loose
object outside that set. It only looks at refs: objects held only by the index, older stash entries
(kept only in the `refs/stash` reflog), and objects another process is writing right now are not
protected.
There is no grace period like `git gc`'s two weeks. Run `dryRun: true` first if in doubt. Packed
objects are never deleted.

### What `repack` does and does not do

`repack()` packs every loose object, reachable or not, into a single new pack with no deltas,
then deletes those loose objects. The whole pack is built in memory before it is written.
Run `gc()` first if unreachable objects should not end up in the pack. `PackConsolidator` merges
small packs separately (defaults: consolidate when there are more than 50 packs, or more than 10 packs under 1 MiB).

### Compatibility limits

- A new index is written as version 2; an existing index keeps the version it was read with.
- `.git/config` is read and written by `GitWorkingCopyConfig` as one file: `[include]` /
  `[includeIf]` are not followed, a malformed section header is kept but ignored where `git`
  would reject the file, and `save()` rewrites the whole file without a `config.lock`.
- Loose objects, refs and the index are written directly, without `.lock` files or
  write-then-rename. Do not run a `git` process that writes the same repository at the same time.

### What will surprise you

- **`refs.compareAndSwap()` fails on a ref that exists only in `packed-refs`.** `resolve()` finds
  the packed value and the comparison passes, but `updateRef` re-reads only the loose file,
  finds none, and returns `{ success: false, previousValue: <the matching id> }` with no
  `errorMessage`. This happens after `git pack-refs` or `git gc` in the same repository.
  `refs.set()` works.
- `createGitFilesHistoryFromFiles({ enableDeltas: false })` has no effect; the option is
  accepted and ignored.
- `FileGcStrategy.getStats().totalSize` counts loose objects only; pack sizes are not included.
  `FileGcStrategy.deltify()` always returns `0`.
- `FileRawStorage` stores the full `type size\0` header plus content. Use it through
  `GitObjectStore`, not as a general-purpose blob store, unless you pass `compress: false` and
  your own keys.

### Errors

| Situation | Error |
| --- | --- |
| Reading a loose object that does not exist | `Key not found: <id>` |
| A pack with a bad header | `Invalid pack file signature` / `Unsupported pack version: <n>` |
| A delta whose base is missing | `Base object not found: <id>` |
| A broken `packed-refs` file | `Invalid packed-refs line: <line>`, `Peeled line before ref in packed-refs` |
| A truncated ref file | `Invalid ref content in <name>: too short` |
| A symbolic ref loop | `Symbolic ref depth exceeded for <name>` |
| `staging.writeTree()` with conflict stages | `Cannot write tree with unresolved conflicts` |
| Index builder: duplicate entry / stage 0 next to stages 1-3 | `Duplicate entry: <path> stage <n>` / `Invalid stages for <path>: stage 0 cannot coexist with other stages` |
| `GitPackStoreImpl` used before `initialize()` or after `close()` | `GitPackStore not initialized. Call initialize() first.` / `GitPackStore is closed` |

### Dependencies

- `@statewalker/vcs-core`: the store interfaces, `FilesApi`, `GitObjectStore`,
  `CompositeRawStorage`, pack reading/writing (`StreamingPackWriter`, `writePackIndexV2`), and
  `createHistoryFromComponents` / `createGitFilesHistory`.
- `@statewalker/vcs-utils`: zlib `deflate`/`inflate`, SHA-1.
- `@statewalker/vcs-working-tree`: the `Staging`, `Worktree`, `Checkout`, `WorkingCopy`
  interfaces and ignore-rule handling.

## License

MIT
