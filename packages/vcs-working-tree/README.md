# @statewalker/vcs-working-tree

The mutable side of a Git repository: the index (staging area), working-tree status, `.gitignore` matching, the worktree file view, checkout state (HEAD, in-progress merge/rebase/cherry-pick/revert), stash, and the `WorkingCopy` interface that ties them to a history from `@statewalker/vcs-core`. It ships the interfaces plus in-memory implementations and a Git-compatible index (`.git/index`) reader/writer.

## Why the working tree is its own package

`@statewalker/vcs-core` holds content-addressed objects and refs: data that never changes once written. The index, the worktree and operation state change on every command, depend on a filesystem, and have Git-specific rules (three merge stages, racily-clean detection, ignore precedence). Keeping them here lets code that only reads or syncs history depend on `vcs-core` alone.

The package deliberately does not depend on `@statewalker/webrun-files-sync`. Combining file sync with Git working-tree state happens only in `@statewalker/vcs-workspace`.

## How to use it

```bash
pnpm add @statewalker/vcs-working-tree
```

No peer dependencies. Works in browsers, Node and workers.

| Entry point | Contents |
|-------------|----------|
| `@statewalker/vcs-working-tree` | Staging, status, ignore, checkout, worktree and working-copy APIs (everything except `/transformation`) |
| `@statewalker/vcs-working-tree/staging` | Only the staging part: `Staging` interface, `GitStaging`, `createGitStaging`, `createMemoryGitStaging`, staging edits, conflict helpers, DIRC `parseIndexFile` / `encodeIndexFile` / `serializeIndexFile` / `writeIndexFile`, `IndexLockedError` / `IndexChangedError` / `breakIndexLock`, index extensions (`carryIndexExtensions`, `parseResolveUndo`) |
| `@statewalker/vcs-working-tree/transformation` | Types only: `MergeState`, `RebaseState`, `CherryPickState`, `RevertState`, `SequencerState`, `ResolutionStore`, `ConflictInfo`, `Resolution`, ... |

Main exports of the root entry:

- **Staging**: `createMemoryGitStaging()`, `createGitStaging(files, indexPath, { lockTimeoutMs })`, `Staging` (`setEntry`, `getEntry`, `entries`, `createEditor`, `createBuilder`, `writeTree`, `readTree`, `hasConflicts`, `resolveConflict`, `read`, `write`, ...), conflict helpers (`getAllConflicts`, `generateConflictMarkers`, `parseConflictMarkers`, ...).
- **Status**: `createStatusCalculator(options)`, `FileStatus`, `RepositoryStatus`, `createIndexDiffCalculator(...)`.
- **Ignore**: `createIgnoreManager(options?)`, `createIgnoreNode()`, `createIgnoreRule(pattern)`.
- **Checkout**: `Checkout` interface, `createMemoryCheckout(options)`.
- **Worktree**: `Worktree` interface, `createMemoryWorktree(options)`.
- **Working copy**: `WorkingCopy` interface, `createMemoryWorkingCopy(options)`, `createMemoryStashStore()`, `RepositoryState` / `getStateCapabilities()`, checkout conflict detection (`detectCheckoutConflicts`, `createCheckoutConflictDetector`) and three-way tree helpers (`compareThreeWayTrees`, `mergeTreesThreeWay`, ...).

File-backed `Worktree`, `Checkout` and `WorkingCopy` implementations (`createFileWorktree`, `GitWorkingCopy`) are in `@statewalker/vcs-store-files`.

## Examples

### Compose an in-memory working copy

```typescript
import { createMemoryHistory } from "@statewalker/vcs-core";
import {
  createMemoryCheckout,
  createMemoryGitStaging,
  createMemoryWorkingCopy,
  createMemoryWorktree,
} from "@statewalker/vcs-working-tree";

const history = createMemoryHistory();
await history.initialize();
await history.refs.setSymbolic("HEAD", "refs/heads/main");

const staging = createMemoryGitStaging();
const workingCopy = createMemoryWorkingCopy({
  history,
  checkout: createMemoryCheckout({ staging }),
  worktree: createMemoryWorktree({ blobs: history.blobs, trees: history.trees }),
});
```

Pass it to `Git.fromWorkingCopy()` from `@statewalker/vcs-commands` to run Git commands.

### Stage entries and write a tree

```typescript
import { FileMode } from "@statewalker/vcs-core";

const content = new TextEncoder().encode("hello\n");
const objectId = await history.blobs.store([content]);

await staging.setEntry({
  path: "src/index.ts",
  mode: FileMode.REGULAR_FILE,
  objectId,
  stage: 0,
  size: content.length,
});
console.log(await staging.getEntryCount(), await staging.hasConflicts()); // 1 false

const treeId = await staging.writeTree(history.trees);
```

### Read and write a Git index file

```typescript
import { createInMemoryFilesApi, FileMode } from "@statewalker/vcs-core";
import { createGitStaging } from "@statewalker/vcs-working-tree";

const files = createInMemoryFilesApi(); // any FilesApi, e.g. a Node or browser one
const index = createGitStaging(files, ".git/index");
await index.read();   // load .git/index if present
await index.setEntry({ path: "a.txt", mode: FileMode.REGULAR_FILE, objectId, stage: 0 });
await index.write();  // write DIRC format
```

`write()` takes the index the way git does. It creates `.git/index.lock` (only if no such file exists), streams the new index into it, and renames it over `.git/index`. If the lock already exists (another git process holds the index, or one crashed), the write fails with `IndexLockedError` and git's message, `Unable to create '.git/index.lock': File exists.`, and leaves both files alone. A write that fails halfway, including a rename that fails, removes its lock, so the old index stays in place. To wait for a lock instead of failing at once, pass `lockTimeoutMs`:

```typescript
const index = createGitStaging(files, ".git/index", { lockTimeoutMs: 1000 });
```

`FileStagingStore` (`@statewalker/vcs-store-files`) writes the same way; every command that changes the index (add, rm, reset, checkout, merge, stash, ...) goes through one of the two. The lock is taken with `atomicFilesOver(...).createExclusive`. When the FilesApi has `createExclusive` (an `O_EXCL` create: `@statewalker/webrun-files-node` from its next release, Web Locks in the browser, a transaction in sqlite), it is used, and the exclusion is cross-process: another process, tab or FilesApi instance creating the lock in the same instant loses and gets `IndexLockedError`. Without it, taking the lock is check-then-write: that excludes every writer sharing one `FilesApi` instance (their creates run one at a time, so the second fails with `IndexLockedError` or waits with `lockTimeoutMs`) and any lock file already on disk, such as native git's, but not another process that creates the lock in the same instant.

Once it holds the lock, `write()` checks that the index on disk is still the one this instance last read or wrote, by its trailing checksum. If native git changed it in between, the write fails with `IndexChangedError` (`index changed on disk since it was read; re-read and retry`), removes the lock and leaves the index alone; call `read()` again and redo the change. A read that found no index expects none, so an index created in the meantime is refused too. An instance that never called `read()` replaces whatever is there.

```typescript
try {
  await index.write();
} catch (error) {
  if (!(error instanceof IndexChangedError)) throw error;
  await index.read(); // take the other writer's index, then redo the edit
}
```

A writer that crashes while it holds the lock leaves `index.lock` behind, and every later write fails with `IndexLockedError`. On disk you remove the file by hand, as with git. On OPFS or in memory, where there is no shell, call `breakIndexLock(files, gitDir)` once you know no other writer is running:

```typescript
import { breakIndexLock } from "@statewalker/vcs-working-tree";

await breakIndexLock(files, ".git"); // true when a stale .git/index.lock was removed
```

Known limitation: the rename is `FilesApi.move`. In the browser (`webrun-files-browser`) a backend without a native move falls back to copy then delete. If the delete of `index.lock` fails after the copy has already replaced the index, `write()` throws although the new index is in place, and the leftover lock blocks later writes until it is removed (`breakIndexLock`). The fix belongs in webrun-files.

#### Index extensions

`parseIndexFile(bytes)` returns the version, the entries, `extensions` (the signatures of the extensions after the entries, in file order) and `extensionData` (each signature with its payload). When `GitStaging` rewrites an index that git wrote, it keeps only the extensions it knows and drops the rest, as git does with optional extensions it does not know (`carryIndexExtensions`):

| Extension | Kept when |
|-----------|-----------|
| `TREE` (cache-tree), `UNTR` (untracked cache), `FSMN` (fsmonitor) | the entries (path, stage, mode, id, intent-to-add) did not change; otherwise dropped, git rebuilds them |
| `REUC` (resolve-undo, what `git checkout -m` restores) | always, every record; dropped only when its payload cannot be parsed |
| `EOIE`, `IEOT` (offsets into the file) | never |
| any other extension whose signature starts with an uppercase letter (optional, by git's rule) | never: unknown optional extensions are dropped |

Resolve-undo records stay even for a path that is no longer in the index, such as a conflict resolved with `git rm`, as git keeps them. Git clears them on `read-tree`, `reset` and `commit`. Here a full `readTree` (without `keepExisting`) clears them on the next `write()`, which covers `ResetCommand`; `CommitCommand` does not rewrite the index, so the records stay until the next read-tree or reset, or until native git commits.

A signature that starts with a lowercase letter marks a required extension, such as `link` (split index) or `sdir` (sparse index). The entries cannot be read correctly without it, so `read()` refuses such an index with `UnsupportedIndexExtensionError` and a later `write()` refuses too, instead of replacing it. For a split index, run `git update-index --no-split-index` first.

`encodeIndexFile(entries, version, extensions)` yields the index as chunks (the header, the entries in pieces of about 64 KiB, the extensions, then the trailing SHA-1, computed as they go), so a write streams instead of building one buffer. Paths and object ids (exactly 40 lowercase hex characters, else `InvalidObjectIdError`) are validated before the first chunk, so invalid input never leaves a half-written index and never takes the lock. `serializeIndexFile` joins the same bytes, for callers that need them in memory. To write an index file directly, use `writeIndexFile`, which follows the lock protocol:

```typescript
import { writeIndexFile } from "@statewalker/vcs-working-tree";

await writeIndexFile(files, ".git/index", entries);
```

### Compute status

```typescript
import { createStatusCalculator, FileStatus } from "@statewalker/vcs-working-tree";

const status = createStatusCalculator({
  worktree: workingCopy.worktree,
  staging,
  trees: history.trees,
  commits: history.commits,
  refs: history.refs,
});

const result = await status.calculateStatus({ includeUntracked: true });
for (const file of result.files) {
  console.log(file.path, file.indexStatus, file.workTreeStatus); // e.g. "notes.txt unmodified untracked"
}
console.log(result.isClean, result.hasStaged, result.hasUntracked);
```

### Store a worktree file as a blob

```typescript
import { storeWorktreeFile } from "@statewalker/vcs-working-tree";

const entry = await worktree.getEntry("video.mp4");
if (entry) {
  const { id, entry: stat } = await storeWorktreeFile(history.blobs, worktree, "video.mp4", entry);
  // record stat.size and stat.mtime in the index
}
```

A regular file is stored with the size the worktree reported, in one pass and without holding it
in memory. If the file changes while it is read, the store rejects with `SizeMismatchError`;
`storeWorktreeFile` then stats the file again and retries once with the new size, as git retries
a file that changed during `git add`. If that read disagrees too, and for symlinks, the content is
stored without a size, which spools it when it is large. The result carries the stat that matched
the stored content (the fresh one after a retry; after the unsized fallback, the latest stat with
the blob's size), which is what the index must record. The add commands and the stash use it.

### Hash a worktree file without reading it whole

```typescript
import { hashWorktreeFile, isUnknownContentId } from "@statewalker/vcs-working-tree";

const id = await hashWorktreeFile("video.mp4", {
  size: async () => {
    const stats = await files.stats("/repo/video.mp4");
    return stats?.kind === "file" ? stats.size : undefined;
  },
  read: () => files.read("/repo/video.mp4"),
});
if (isUnknownContentId(id)) {
  // the file kept changing while it was read: treat it as modified
}
```

Every `Worktree.computeHash` (`MemoryWorktree`, and `FileWorktree` and `FileTreeIterator` in
`@statewalker/vcs-store-files`) goes through `hashWorktreeFile`, so status, the checkout conflict
check and the stash hash a file as it streams past: the size comes from stat, because the git
header that starts the hash carries it. If the file produces a different number of bytes, it was
changed while it was read; it is stat'ed and read once more, and if that disagrees too the result
is `unknownContentId()`: a value that is not hex and differs on every call, so it never equals an
index id (not the all-zero id, not an empty one), and any comparison reports the file as modified.
`isUnknownContentId(id)` recognises it; it is never written anywhere. (`add -N` records the empty
blob's id flagged `intentToAdd`, as git does, rather than an empty id.)

Checkout writes stream each blob into `FilesApi.write`, so a write is exactly as atomic as the
`FilesApi`: the Node and in-memory ones write to a temporary and rename, so a blob that fails part
way leaves the old file; a `FilesApi` that writes in place can leave a cut-off file.

The worktrees take a `newHasher` factory instead of the old `hashFunction` option, which needed
the whole file in one buffer. It returns an incremental `Hasher` and defaults to SHA-1:

```typescript
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";

const worktree = createMemoryWorktree({ blobs, trees, newHasher: createSha1 });
```

Checkout writes stream the same way: `checkoutTree`, `reset --hard`, `stash apply` and the
conflict resolution store hand the blob's content stream to `writeContent` / `FilesApi.write`. No
content filter (`core.autocrlf`, smudge, LFS pointers) is applied on checkout, so nothing needs the
whole blob in between.

### Match `.gitignore` rules

```typescript
import { createIgnoreManager } from "@statewalker/vcs-working-tree";

const ignore = createIgnoreManager({ globalPatterns: [".DS_Store"] });
ignore.addIgnoreFile("", "node_modules/\n*.log\n"); // "" = repository root
ignore.isIgnored("node_modules", true);  // true
ignore.isIgnored("debug.log", false);    // true
ignore.isIgnored("src/a.ts", false);     // false
```

## Internals

### How the pieces fit

```
                 WorkingCopy
   +-------------+-----------+-------------+
   |             |           |             |
 history      checkout     worktree      stash, config
 (vcs-core)      |         (files)
            staging (index)
            HEAD, merge/rebase/
            cherry-pick/revert state
```

`WorkingCopy` adds HEAD helpers (`getHead`, `setHead`, `getCurrentBranch`, `isDetachedHead`), operation state (`getMergeState`, `getRebaseState`, ..., `getState`, `getStateCapabilities`) and `getStatus()` / `refresh()`.

### Why the index keeps stages

An index entry is keyed by path and stage. Stage 0 is a normal entry. Stages 1, 2 and 3 hold base, ours and theirs during a conflict, as in Git. This lets a merge write all sides into the index and lets `resolveConflict(path, "ours" | "theirs" | "base" | entry)` collapse them back to stage 0.

### How status decides a file changed

Status is a three-way diff: HEAD tree vs index (`indexStatus`) and index vs worktree (`workTreeStatus`). For index vs worktree it compares sizes first. If sizes match and the file's mtime is more than 3 seconds older than the index update time, the file is treated as unchanged. Otherwise it hashes the content. This mirrors Git's "racily clean" handling and avoids hashing every file.

### What breaks, and how it looks

- An index entry written without `size` (defaults to 0) makes the matching worktree file show as `modified`, because the size check fails before any hashing.
- `writeTree()` with unresolved conflicts throws `Cannot write tree with unresolved conflicts`.
- An index that mixes stage 0 with stages 1-3 for one path throws `Invalid stages for <path>: stage 0 cannot coexist with other stages`.
- Reading a bad `.git/index` throws `Invalid index file signature: expected DIRC, got ...`, `Unsupported index version: <n>` or `Index file checksum mismatch`.
- Index paths are validated: `Invalid path: <path> (starts with /)`, `(contains //)`, `(contains .git)`, ...
- The memory worktree throws `File not found: <path>` on reads of missing files.
- `MemoryWorkingCopy.getStatus()` is a stub: it always returns `isClean: true` and no files. Use `createStatusCalculator` for real status.

### Why `/transformation` is a separate entry point

Its type names (`MergeState`, `RebaseState`, `ConflictInfo`, `ConflictType`, `ResolutionStrategy`) collide with names exported from the staging and working-copy modules. The root entry does not re-export them; import them from `@statewalker/vcs-working-tree/transformation`. That entry contains types only; there is no runtime code.

### Dependencies and why

- `@statewalker/vcs-core`: `History`, `Blobs`, `Trees`, `Commits`, `Refs`, `FileMode`, `FilesApi`.
- `@statewalker/vcs-utils`: SHA-1 for the index checksum and worktree content hashes, hex helpers.

## License

MIT
