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
| Object kernel store | `filesStagingStore(files, objectsDir)`: git's loose layout as a `StagingBlobStore` for `createGitObjects`, written through `tmp_obj_*` and a rename; `sweepStaged(olderThanMs)` removes stale temporaries as `git prune` does; `withPacks(objects, packDirectory)`: a `GitObjects` that reads loose objects first, then packs; `skipPacked(store, packDirectory)`: a staging store that does not write objects already packed |
| Loose objects | `FileRawStorage` (`compress` option, default `true`), `PackDirectoryAdapter` (read-only `RawStorage` over packs) |
| Packs | `PackDirectory`, `PackReader`, `PackDeltaStore`, `PackConsolidator`, `RandomAccessDeltaReader`, `GitPackStoreImpl` / `createGitPackStore`, `DirectPackObjectReader`, `isDeltaType` |
| Refs | `FileRefStore` / `createFileRefStore(files, gitDir, { atomicFiles?, refLockTimeoutMs?, packedLockTimeoutMs? })` with atomic `batch`; `createFilesRefBatch(atomicFiles)`; functions `readRef`, `resolveRef`, `readAllRefs`, `getRefsByPrefix`, `writeRef`, `writeObjectRef`, `writeSymbolicRef`, `updateRef`, `deleteRef`, `readPackedRefs`, `writePackedRefs`, `packRefs`, `appendReflog`, `createReflogReader`, and the parsers `parseRefContent`, `parsePackedRefs`, `parseReflogLine` |
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

### Update several refs at once, safely next to native git

```ts
import { createFileRefStore } from "@statewalker/vcs-store-files";
import { createNodeAtomicFiles, createNodeFilesApi } from "@statewalker/vcs-utils-node/files";

const files = createNodeFilesApi({ rootDir: "/path/to/repo" });
const refs = createFileRefStore(files, ".git", {
  atomicFiles: createNodeAtomicFiles("/path/to/repo/.git"),
});
const r = await refs.batch(
  [
    { name: "refs/heads/main", old: oldMain, new: newMain },
    { name: "refs/tags/v1", old: null, new: tagId },
  ],
  { ident: "A U Thor <a@example.com> 1700000000 +0000", message: "release v1" },
);
// r.ok, or r.rejected: [{ name, reason: "mismatch" | "locked" | ... }]; nothing changed then
```

`batch` uses git's lock-file protocol. One ref: create `<ref>.lock` exclusively, re-check under
the lock, write the new id into the lock and rename it over the ref. Several refs: lock them all,
then `packed-refs.lock`, and commit as JGit's `PackedBatchRefUpdate` does, first moving the
involved loose refs into `packed-refs` and then landing the whole batch in `packed-refs` with one
rename. A crash at any file operation leaves every ref at its old or its new value once stale
locks are removed; native `git` reads the result, honours our locks and makes us report `locked`
while it holds its own. Reflog lines are written to `logs/` in git's format (HEAD's too when it
points at an updated branch). `compareAndSwap` is a one-command batch.

The lock-file primitives (`AtomicFiles`) default to `atomicFilesOver(files, gitDir)`, which is
atomic only among users of the same FilesApi instance: two FilesApi instances over one directory,
even in one process, do not exclude each other. On disk, pass `createNodeAtomicFiles` (O_CREAT|O_EXCL,
rename, O_APPEND) wherever another FilesApi or process, native `git` included, may write the same
repository. `createGitFilesBackend` takes the same `atomicFiles` option, and the lock timeouts.

Reflogs follow git with `core.logAllRefUpdates=true` in a non-bare repository: a log is created
for `HEAD`, `refs/heads/`, `refs/remotes/` and `refs/notes/` (and appended to wherever one exists),
a no-op update logs HEAD but not the branch, and deleting a branch removes its log while HEAD's log
records the delete. Two differences from git remain: a multi-ref batch that replaces a symbolic ref
(`noDeref`) is refused as `unsupported` (its loose file would shadow the packed commit), and bare
repositories are logged like non-bare ones. Readers skip `*.lock` files and re-read loose refs
around `packed-refs`, so a listing never combines states of a batch committing meanwhile.

## Internals

### The storage stack

```
History (blobs / trees / commits / tags / refs)
  └─ withPacks               loose objects first, then packs
       ├─ GitObjects         adds and strips the "type size\0" header, computes SHA-1
       │    └─ skipPacked         drops a write whose object is already packed
       │         └─ filesStagingStore   read/write  .git/objects/ab/cdef...   (zlib)
       └─ PackDirectory            read-only   .git/objects/pack/*.pack + *.idx
  └─ FileRefStore            .git/HEAD, .git/refs/**, .git/packed-refs, .git/logs/**
```

Writing an object that is already packed (`put` or `putRaw`) writes nothing, as git and JGit do.
`gc()` and `repack()` still work on `FileRawStorage` (the `looseStorage` the backend returns) and
`PackDirectory`, and ignore files in `objects/` that are not objects (such as git's
`objects/ab/tmp_obj_*` while it writes).

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
- Ref batches and `compareAndSwap` use `.lock` files and rename (with native `AtomicFiles`, safe
  next to a running `git`). `set`, `setSymbolic`, `remove`, `packRefs` / `optimize` (which rewrite
  `packed-refs` without `packed-refs.lock` and can lose a concurrent batch), loose objects and the
  index are still written directly, without locks: do not run them next to a batch or a `git`
  process writing the same repository.

### What will surprise you

- `createGitFilesHistoryFromFiles({ enableDeltas: false })` has no effect; the option is
  accepted and ignored.
- `FileGcStrategy.getStats().totalSize` counts loose objects only; pack sizes are not included.
  `FileGcStrategy.deltify()` always returns `0`.
- `FileRawStorage` stores the full `type size\0` header plus content, compressed. Do not wrap it
  in `rawStorageStaging()` for `createGitObjects` (that would compress twice); use
  `filesStagingStore(files, objectsDir)` instead. It is not a general-purpose blob store either,
  unless you pass `compress: false` and your own keys.

### Errors

| Situation | Error |
| --- | --- |
| `FileRawStorage.load()` of a loose object that does not exist (`objects.get()` returns `undefined` instead) | `Key not found: <id>` |
| A pack with a bad header | `Invalid pack file signature` / `Unsupported pack version: <n>` |
| A delta whose base is missing | `Base object not found: <id>` |
| A broken `packed-refs` file | `Invalid packed-refs line: <line>`, `Peeled line before ref in packed-refs` |
| A truncated ref file | `Invalid ref content in <name>: too short` |
| A symbolic ref loop | `Symbolic ref depth exceeded for <name>` |
| `staging.writeTree()` with conflict stages | `Cannot write tree with unresolved conflicts` |
| Index builder: duplicate entry / stage 0 next to stages 1-3 | `Duplicate entry: <path> stage <n>` / `Invalid stages for <path>: stage 0 cannot coexist with other stages` |
| `GitPackStoreImpl` used before `initialize()` or after `close()` | `GitPackStore not initialized. Call initialize() first.` / `GitPackStore is closed` |

### Dependencies

- `@statewalker/vcs-core`: the store interfaces, `FilesApi`, `GitObjects`,
  `CompositeRawStorage`, pack reading/writing (`StreamingPackWriter`, `writePackIndexV2`), and
  `createHistoryFromComponents` / `createGitFilesHistory`.
- `@statewalker/vcs-utils`: zlib `deflate`/`inflate`, SHA-1.
- `@statewalker/vcs-working-tree`: the `Staging`, `Worktree`, `Checkout`, `WorkingCopy`
  interfaces and ignore-rule handling.

## License

MIT
