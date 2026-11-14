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
| `createGitFilesBackend({ files, gitDir?, create?, defaultBranch? })` | `{ history, objects, packs, packDirectory, looseStorage }` over a `.git` directory: `objects` reads packs first, then loose objects; `packs` is the `PackSet` it reads from. `create: true` writes `HEAD`, `config`, `objects/`, `refs/heads`, `refs/tags`. |
| `createGitFilesHistoryFromFiles(options)` | Same options, returns a `HistoryWithOperations` (adds `delta` and `serialization` backed by the pack directory). |
| `FileStagingStore(files, indexPath)` | `Staging` stored in Git's binary index format (`.git/index`). |
| `createFileWorktree({ files, rootPath, blobs, trees, gitDir? })` / `FileWorktree` | `Worktree` over the working directory, with `.gitignore` support and `checkoutTree`. |
| `gc({ history, files, gitDir?, dryRun?, tmpExpiryMs? })` | Deletes loose objects not reachable from any ref, and `tmp_obj_*` temporaries older than two weeks. |
| `repack({ looseStorage, packDirectory, dryRun? })` | Moves all loose objects into one new pack. |
| `FileGcStrategy({ looseStorage, packDirectory })` | `GcStrategy` for `@statewalker/vcs-core`: `prune`, `compact` (= `repack`), `getStats`. |

Lower-level building blocks, also exported:

| Area | Exports |
| --- | --- |
| Object kernel store | `filesStagingStore(files, objectsDir)`: git's loose layout as a `StagingBlobStore` for `createGitObjects`, written through `tmp_obj_*` and a rename; `sweepStaged(olderThanMs)` removes stale temporaries as `git prune` does; `withPacks(objects, packs)`: a `GitObjects` that reads the packs of a `PackSet` (`openPackSet` from `@statewalker/vcs-core`) first, then loose objects; `skipPacked(store, packs)`: a staging store that does not write objects already packed (in a pack still on storage, in a copy not found corrupt) |
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

await gc({ history, files, dryRun: true }); // { removedObjects, reachableObjects, totalLooseObjects, removedTemporaries }
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

### Update several refs at once

```ts
import { createFileRefStore } from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";

const files = createNodeFilesApi({ rootDir: "/path/to/repo" });
const refs = createFileRefStore(files, ".git");
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
locks are removed; native `git` reads the result, refuses to update a ref we hold locked, and makes
us report `locked` while it holds its own (a lock created in the same instant by both is not
excluded: FilesApi has no exclusive create). Reflog lines are written to `logs/` in git's format (HEAD's too when it
points at an updated branch). `compareAndSwap` is a one-command batch.

The lock-file primitives (`AtomicFiles`) default to `atomicFilesOver(files, gitDir)`, which is
atomic only among users of the same FilesApi instance: two FilesApi instances over one directory,
even in one process, do not exclude each other, nor does another process such as native `git`.
Share one FilesApi per repository. Excluding other processes needs an exclusive create in FilesApi
(O_CREAT|O_EXCL), which belongs upstream in `@statewalker/webrun-files`. `createGitFilesBackend`
takes the same `atomicFiles` option, and the lock timeouts.

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
  └─ withPacks               packs first, then loose objects
       ├─ GitObjects         adds and strips the "type size\0" header, computes SHA-1
       │    └─ skipPacked         drops a write whose object is already packed
       │         └─ filesStagingStore   read/write  .git/objects/ab/cdef...   (zlib)
       └─ PackSet (vcs-core)       read-only   .git/objects/pack/*.pack + *.idx
  └─ FileRefStore            .git/HEAD, .git/refs/**, .git/packed-refs, .git/logs/**
```

Reads try the packs first, then the loose objects, as git and JGit do: a packed object is
streamed from its pack (a large blob arrives in many chunks), and `getRaw` is its header followed
by that stream. A pack miss rescans the pack directory at most once per second (git's
`reprepare_packed_git`, rate-limited; the first miss after open always rescans), so a pack native
git writes meanwhile is found within that interval, and a run of misses (fetch negotiation probing
absent ids) does not list the directory each time. Packs that `repack()` and gc add or remove
through the returned `packDirectory` refresh `packs` at once.

A packed copy that fails before `get` returns (a corrupt entry header, a missing delta base, a
zlib stream broken from its start: the first chunk is read before `get` returns) gives way to a
loose copy; its error is raised only when there is none. A stream that breaks later fails while
it is read, with nothing to fall back to at that point, but the copy is marked bad and the next
`get` reads the loose copy. A corrupt pack is skipped when the backend opens (`packs.skipped`
says which and why) and the rest of the repository stays readable.

Writing an object that is already packed (`put` or `putRaw`) writes nothing, as git and JGit do,
unless its pack file has been deleted behind the backend's back (by `git repack -a -d` or gc) or
its packed copy was found corrupt: then it is written loose, so the object is never lost and a
repairing write lands.
`gc()` and `repack()` still work on `FileRawStorage` (the `looseStorage` the backend returns) and
`PackDirectory` (also returned, until they move to `packs`), and ignore files in `objects/` that are not objects (such as git's
`objects/ab/tmp_obj_*` while it writes).

New objects are always written loose. Packs are only read, until `repack()` turns loose objects
into a pack. This keeps writes simple (one file per object, no pack index to rewrite) and matches
how `git` itself behaves between `git gc` runs. A pack `repack()` writes through `PackDirectory`
is read by `packs` at once (the backend refreshes the set after each `addPack` and `removePack`).

### Reachability is computed from refs only

`gc()` collects every ref tip, walks `history.collectReachableObjects`, and deletes each loose
object outside that set. It only looks at refs: objects held only by the index, older stash entries
(kept only in the `refs/stash` reflog), and objects another process is writing right now are not
protected.
There is no grace period like `git gc`'s two weeks for objects. Run `dryRun: true` first if in
doubt. Packed objects are never deleted. Temporaries left by a crashed write (`tmp_obj_*`) are
removed once older than `tmpExpiryMs` (two weeks, git prune's default); a dry run removes none.

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
- Ref batches and `compareAndSwap` use `.lock` files and rename, exclusive among writers sharing
  one FilesApi; another process such as a running `git` is not excluded. `set`, `setSymbolic`, `remove`, `packRefs` / `optimize` (which rewrite
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
| `objects.get()` of a packed object whose only copy is corrupt (bad zlib, a delta cycle, a missing base) | `PackError` (a `CorruptObjectError`); with `verify`, content hashing to another id raises `ObjectIdMismatchError` |
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
