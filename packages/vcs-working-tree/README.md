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
| `@statewalker/vcs-working-tree/staging` | Only the staging part: `Staging` interface, `GitStaging`, `createGitStaging`, `createMemoryGitStaging`, staging edits, conflict helpers, DIRC `parseIndexFile` / `serializeIndexFile` |
| `@statewalker/vcs-working-tree/transformation` | Types only: `MergeState`, `RebaseState`, `CherryPickState`, `RevertState`, `SequencerState`, `ResolutionStore`, `ConflictInfo`, `Resolution`, ... |

Main exports of the root entry:

- **Staging**: `createMemoryGitStaging()`, `createGitStaging(files, indexPath)`, `Staging` (`setEntry`, `getEntry`, `entries`, `createEditor`, `createBuilder`, `writeTree`, `readTree`, `hasConflicts`, `resolveConflict`, `read`, `write`, ...), conflict helpers (`getAllConflicts`, `generateConflictMarkers`, `parseConflictMarkers`, ...).
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
