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
| `createGitFilesBackend({ files, gitDir?, create?, defaultBranch? })` | `{ history, objects, packs, looseStorage, files, gitDir }` over a `.git` directory: `objects` reads packs first, then loose objects; `packs` is the `PackSet` it reads from. `create: true` writes `HEAD`, `config`, `objects/`, `refs/heads`, `refs/tags`. The result is what `repack()` and `FileGcStrategy` take. |
| `createGitFilesHistoryFromFiles(options)` | Same options, returns a `HistoryWithOperations` (adds `serialization`, and `delta`: a read-only view of which packed objects are deltas). |
| `FileStagingStore(files, indexPath)` | `Staging` stored in Git's binary index format (`.git/index`). |
| `createFileWorktree({ files, rootPath, blobs, trees, gitDir?, newHasher? })` / `FileWorktree` | `Worktree` over the working directory, with `.gitignore` support and `checkoutTree`. `computeHash` streams the file through `newHasher` (SHA-1 by default) with its size from stat; `checkoutTree` streams each blob into `FilesApi.write`. Neither holds a whole file in memory. |
| `gc({ history, files, gitDir?, dryRun?, pruneExpireMs?, tmpExpiryMs?, orphanPackExpiryMs?, packRefs?, repack? })` | `git gc`: under a `gc.pid` lock, repacks everything reachable into one pack (`repack -A -d`: unreachable packed objects younger than two weeks are loosened), packs refs, prunes unreachable loose objects older than two weeks, sweeps stale temporaries and orphaned `.pack` files. |
| `repack({ ...backend, all?, unpackUnreachable?, deltaSearch?, dryRun? })` | `git repack -a -d` (default), `git repack -A -d` with `unpackUnreachable: true`, or, with `all: false`, `git repack -d`: one streamed pack, `.keep` packs honoured, replaced packs and loose copies removed after the install; only packs present before the walk are replaced. |
| `FileGcStrategy(backend)` | `GcStrategy` for `@statewalker/vcs-core`: `prune`, `compact` (= `repack` with `all: false`), `getStats`. |
| `listReachableObjects` / `collectReachabilityRoots` | What repack and gc keep: objects reachable from every ref, HEAD, the reflogs, the index and every linked worktree's HEAD, index and reflogs. Refs are read strictly: an unreadable or malformed ref throws. |

Lower-level building blocks, also exported:

| Area | Exports |
| --- | --- |
| Object kernel store | `filesStagingStore(files, objectsDir, { freshenMaxAgeMs? })`: git's loose layout as a `StagingBlobStore` for `createGitObjects`, written through `tmp_obj_*` and a rename (a write over a loose file older than an hour renews it); `spool(content)` writes content of unknown size to a `tmp_obj_*` file so `putUnsized` can hash it in a second pass without holding it; `isFresh(id)` says whether a loose object exists and needs no freshening; `sweepStaged(olderThanMs)` removes stale temporaries as `git prune` does; `withPacks(objects, packs)`: a `GitObjects` that reads the packs of a `PackSet` (`openPackSet` from `@statewalker/vcs-core`) first, then loose objects; `skipPacked(store, packs)`: a staging store that does not write objects already packed (in a pack still on storage, in a copy not found corrupt) |
| Loose objects | `FileRawStorage` (`compress` option, default `true`); `prunePacked(looseStorage, packs)` removes loose copies of packed objects (`git prune-packed`) |
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

const backend = await createGitFilesBackend({ files });

const packed = await repack(backend); // git repack -a -d
// { packName: "pack-<sha1>", objectCount: 42, looseObjectsRemoved: 3,
//   packsRemoved: ["pack-<old>"], keptPacks: [], unpackedObjects: 0 }, or null if nothing is reachable

await repack({ ...backend, all: false }); // git repack -d: only the reachable loose objects
await repack({ ...backend, unpackUnreachable: true }); // git repack -A -d

const { history } = backend;
await gc({ history, files, dryRun: true }); // what would be pruned; nothing changes
await gc({ history, files });
// { removedObjects, keptRecentObjects, reachableObjects, totalLooseObjects, removedTemporaries,
//   removedOrphanPacks, refsPacked: true, repack: { packName, ... }, skipped: false }
await gc({ history, files, pruneExpireMs: 0 }); // git gc --prune=now
// another gc holding .git/gc.pid: { skipped: true, ... } and nothing is done

await new FileGcStrategy(backend).getStats();
// { looseObjectCount: 0, packedObjectCount: 42, totalSize: 0, packCount: 1 }
```

After a commit and two abandoned blobs, one three weeks old and one an hour old, `gc` reports
`removedObjects: 1, keptRecentObjects: 1`: the old blob is pruned, the young one stays because it
might belong to a write still in progress.

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
us report `locked` while it holds its own (a lock created in the same instant by both is
excluded only when the FilesApi has `createExclusive`, see below). Reflog lines are written to `logs/` in git's format (HEAD's too when it
points at an updated branch). `compareAndSwap` is a one-command batch.

The lock-file primitives (`AtomicFiles`) default to `atomicFilesOver(files, gitDir)`. When the
FilesApi has `createExclusive` (an O_CREAT|O_EXCL create: `open "wx"` in `@statewalker/webrun-files-node`
0.11, Web Locks in the browser, a transaction in sqlite, a synchronous reservation in memory), every lock is created with
it, and the exclusion is cross-process: other processes such as native `git`, other tabs and other
FilesApi instances are excluded. Without it, a lock is atomic only among users of the same FilesApi
instance: two FilesApi instances over one directory, even in one process, do not exclude each
other, nor does another process; share one FilesApi per repository then. `createGitFilesBackend`
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
by that stream; a caller that stops after the header releases the pack read. A pack miss, and
every `list()`, rescans the pack directory at most once per second (git's
`reprepare_packed_git`, rate-limited; the first rescan after open always runs), so a pack native
git writes meanwhile is found within that interval, and a run of misses (fetch negotiation probing
absent ids) does not list the directory each time. `list()` takes one snapshot of the packs for
both the packed ids and for skipping loose ids that are already packed. A pack `repack()`
installs is read by `packs` at once, and a reader whose pack was removed by a repack (another
backend over the same directory, or native git) rescans at once, whatever the rate limit, and
finds the replacement.

A packed copy that fails before `get` returns (a corrupt entry header, a missing delta base, a
zlib stream broken from its start: the first chunk is read before `get` returns) gives way to a
loose copy; its error is raised only when there is none. A stream that breaks later fails while
it is read, with nothing to fall back to at that point, but the copy is marked bad and the next
`get` reads the loose copy. A corrupt pack is skipped when the backend opens (`packs.skipped`
says which and why) and the rest of the repository stays readable.

Writing an object that is already packed (`put` or `putRaw`) writes nothing, as git and JGit do,
unless its pack file has been deleted behind the backend's back (by `git repack -a -d` or gc) or
its packed copy was found corrupt: then it is written loose, so a repairing write lands. A pack
whose file was checked less than a second ago is trusted without another check, so writes made
within that second after the pack was deleted are skipped and not retried. An object whose pack
file is older than an hour (`freshenMaxAgeMs` of `openPackSet`, git's freshen window) is written
loose again: git would touch the pack's mtime so a concurrent gc does not expire the object with
it, FilesApi cannot set mtimes, and the fresh loose copy does that job instead. An object
skipped because its pack is younger is safe too: gc loosens the unreachable objects of young
packs instead of dropping them.

Writing an object that is already loose keeps the existing file, unless it was last modified
more than an hour ago (`freshenMaxAgeMs` of `filesStagingStore` and `createGitFilesBackend`):
then the new temporary is moved over it, so the rename renews its mtime at once and a concurrent
gc keeps the object for its grace period, as git's `freshen_loose_object` does by touching the
file. A loose file whose mtime the FilesApi does not report is kept as it is, as `PackSet`
trusts a pack of unknown age.
`gc()` and `repack()` work on the `packs` and `looseStorage` the backend returns, and ignore
files in `objects/` that are not objects (such as git's `objects/ab/tmp_obj_*` while it writes).

New objects are always written loose. Packs are only read, until `repack()` turns objects into a
pack. This keeps writes simple (one file per object, no pack index to rewrite) and matches how
`git` itself behaves between `git gc` runs.

### How `repack` works

`repack()` is one stream from end to end:

```
snapshot packs ─► listObjects (refs, HEAD, reflogs, index, worktrees) ─► writePack (reuse + delta search) ─► PackSet.install
```

`listObjects` keeps only ids, types and paths; `writePack` reads one object at a time, copies
stored entries (whole objects and deltas) from the existing packs and searches deltas for the
rest; `PackSet.install` (index-pack) stores the stream in a temporary file as it arrives, checks
and indexes it, and renames `pack-<id>.pack`, then `pack-<id>.idx`, into place. No pack is ever
held in memory: a 60 MiB blob goes through with no write larger than the stream's chunks.

Only then are things deleted, so a concurrent reader always finds each object somewhere: the
packs the new one replaces go first (`.idx` before `.pack`), then the loose objects a pack now
holds (`git prune-packed`). Packs with a `.keep` file are never removed, and their objects are
not copied into the new pack (git's `--honor-pack-keep`). Unreachable objects inside the
replaced packs are dropped, exactly as `git repack -a -d` drops them, unless
`unpackUnreachable` is set (`git repack -A -d`, what `gc()` uses): each of them is then streamed
from its pack into a loose object (temporary file and rename) before the pack is removed, unless
the pack was last modified more than `unpackUnreachableExpireMs` ago (two weeks); a pack whose
mtime is unknown is always loosened. An object that is already loose is rewritten if its loose
file is older than an hour, which renews its mtime: an old loose copy of an object that a push
also brought in a young pack would otherwise expire once that pack is gone.

Only packs that were installed before the walk started are replaced: the pack set is refreshed
and snapshotted first, then the reachable objects are listed. A pack installed by someone else
during the walk or the write (a push whose ref is not yet updated) is left alone, and so is any
snapshot pack whose file was modified after the walk started. A ref that cannot be read or is
malformed makes the repack throw before it writes or deletes anything.

With `all: false` (`git repack -d`), the reachable objects no pack holds go into a new pack and
their loose copies are removed; existing packs are untouched. Unreachable loose objects are never
packed: they stay loose for `gc()` to prune when they are old enough.

### What `gc` keeps

`gc()` treats as reachable every object reachable from a ref, HEAD, any reflog entry (old and new
ids, `logs/HEAD` and `logs/refs/**`), an index entry, and, for each linked worktree
(`.git/worktrees/<name>/`), its HEAD (detached or symbolic), its index and its reflogs, as
`git gc` does. The trees of the index's cache-tree (TREE) extension and the blobs of its
resolve-undo (REUC) extension are not read (git counts them too): a tree only the cache-tree
names can be pruned, and git then rebuilds that part of the cache-tree; a blob only resolve-undo
names (a conflict resolved since) can be pruned, and `git checkout -m` then cannot recreate that
conflict. A split index (a `link` extension) makes gc and repack throw before anything is
changed: its entries live partly in a shared index file, which is not read, so the blobs staged
there would silently stop being roots (`git update-index --no-split-index` undoes it). Refs are listed strictly: a ref file that cannot be read, an empty or malformed ref
or a broken `packed-refs` makes gc throw before anything is changed, as `git gc` refuses to run.

gc repacks with `repack -A -d`: unreachable objects of the replaced packs are written loose,
unless their pack is older than `pruneExpireMs`, so a branch deleted with its reflog
(`git branch -D`) keeps its packed commits for the grace period. FilesApi cannot set mtimes, so
these loose copies get the current time and live up to `pruneExpireMs` longer than under git.
Then gc removes, except the objects the repack just left loose, each remaining loose object that is unreachable and was last modified more than
`pruneExpireMs` ago (git's `gc.pruneExpire`, two weeks). Younger unreachable objects are kept,
because another process may be writing a commit that will reference them; an object whose age is
unknown is kept too unless `pruneExpireMs` is 0 (`--prune=now`).

Temporaries left by a crashed write (`objects/**/tmp_obj_*` and `objects/pack/tmp_*`) are
removed once older than `tmpExpiryMs` (two weeks). `.pack` files whose `.idx` is gone (a crash
while a pack was removed) are removed once older than `orphanPackExpiryMs`, which defaults to
`tmpExpiryMs` but never less than an hour: a pack being installed is moved into place before its
`.idx`, with its temporary's mtime, so a young one may still be arriving. git never removes such
files.

gc takes `.git/gc.pid` with an exclusive create first, writing a random token into it; while
another gc holds it, gc returns `skipped: true` and does nothing. A `gc.pid` older than 12 hours
is taken over, as git does: one takeover at a time (under `gc.pid.takeover`), the stale lock is
removed and created again exclusively, then read back to check it holds our token. Without
`lastModified` from the FilesApi a lock's age is unknown and it is never taken over: remove
`gc.pid` by hand after a crash. gc releases the lock only while it still holds its token. The
lock excludes gcs in other processes when the FilesApi has `createExclusive`, and otherwise
only gcs over the same FilesApi instance. A dry run takes no lock and changes nothing: it does not pack refs, repack or sweep, and
reports what it would prune.

### Compatibility limits

- A new index is written as version 2; an existing index keeps the version it was read with.
- `.git/config` is read and written by `GitWorkingCopyConfig` as one file: `[include]` /
  `[includeIf]` are not followed, a malformed section header is kept but ignored where `git`
  would reject the file, and `save()` rewrites the whole file without a `config.lock`.
- Ref batches and `compareAndSwap` use `.lock` files and rename, exclusive across processes when
  the FilesApi has `createExclusive`, and otherwise only among writers sharing one FilesApi. `set`, `setSymbolic`, `remove`, `packRefs` / `optimize` (which rewrite
  `packed-refs` without `packed-refs.lock` and can lose a concurrent batch), loose objects and the
  index are still written directly, without locks: do not run them next to a batch or a `git`
  process writing the same repository.

### What will surprise you

- `history.delta.blobs.deltifyBlob()` throws on a git files history: git stores deltas only in
  packs, and `repack()` computes them. `undeltifyBlob()` does nothing (reads resolve deltas).
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
| A pack with a bad header, or a delta whose base is missing | `PackError` |
| `repack()` or `gc()` when a reachable object is missing (a broken repository) | `MissingObjectError`; nothing is deleted |
| `objects.get()` of a packed object whose only copy is corrupt (bad zlib, a delta cycle, a missing base) | `PackError` (a `CorruptObjectError`); with `verify`, content hashing to another id raises `ObjectIdMismatchError` |
| A broken `packed-refs` file | `Invalid packed-refs line: <line>`, `Peeled line before ref in packed-refs` |
| A truncated ref file | `Invalid ref content in <name>: too short` |
| `repack()` or `gc()` when a ref cannot be read, is empty or is not an object id | the read error, `Invalid ref <name>: empty file` or `Invalid ref content in <name>: not an object id`; nothing is deleted |
| A symbolic ref loop | `Symbolic ref depth exceeded for <name>` |
| `staging.writeTree()` with conflict stages | `Cannot write tree with unresolved conflicts` |
| Index builder: duplicate entry / stage 0 next to stages 1-3 | `Duplicate entry: <path> stage <n>` / `Invalid stages for <path>: stage 0 cannot coexist with other stages` |

### Dependencies

- `@statewalker/vcs-core`: the store interfaces, `FilesApi`, `GitObjects`,
  `CompositeRawStorage`, packs (`openPackSet`, `listObjects`, `writePack`, `installPack`), and
  `createHistoryFromComponents` / `createGitFilesHistory`.
- `@statewalker/vcs-utils`: zlib `deflate`/`inflate`, SHA-1.
- `@statewalker/vcs-working-tree`: the `Staging`, `Worktree`, `Checkout`, `WorkingCopy`
  interfaces and ignore-rule handling.

## License

MIT
