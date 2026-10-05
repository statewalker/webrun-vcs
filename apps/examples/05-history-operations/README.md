# 05-history-operations

A runnable tutorial that reads repository history with the `@statewalker/vcs-commands` porcelain and the `history.commits` API from `@statewalker/vcs-core`. Five steps cover log traversal, commit ancestry and merge bases, diffs between commits, blame, and tracking one file across commits. Everything runs in memory: nothing is written to disk and no network is used.

## Each step is one file that builds its own history

```
apps/examples/05-history-operations/
├── package.json
├── tsconfig.json
└── src/
    ├── main.ts                       # Runs steps 1-5 in order
    ├── shared.ts                     # In-memory History + WorkingCopy + Git setup, helpers
    └── steps/
        ├── 01-log-traversal.ts       # git.log(), walkAncestry()
        ├── 02-commit-ancestry.ts     # ancestor checks, findMergeBase()
        ├── 03-diff-commits.ts        # git.diff() between commits
        ├── 04-blame.ts               # git.blame() and BlameResult
        └── 05-file-history.ts        # manual per-file history walk
```

`shared.ts` composes an in-memory repository from `createMemoryHistory()` (vcs-core) and `createMemoryGitStaging()`, `createMemoryCheckout()`, `createMemoryWorktree()`, `createMemoryWorkingCopy()` (vcs-working-tree), then wraps it with `Git.fromWorkingCopy()`. Each step calls `resetState()` first and creates the commits it needs, so steps are independent of each other.

## How to run it

Requires Node 24 and pnpm. From the repository root:

1. Install the workspace:

   ```bash
   pnpm install
   ```

2. Run all five steps:

   ```bash
   pnpm --filter @statewalker/vcs-example-05-history-operations start
   ```

3. Or run a single step:

   ```bash
   pnpm --filter @statewalker/vcs-example-05-history-operations step:01  # Log traversal
   pnpm --filter @statewalker/vcs-example-05-history-operations step:02  # Commit ancestry
   pnpm --filter @statewalker/vcs-example-05-history-operations step:03  # Diff commits
   pnpm --filter @statewalker/vcs-example-05-history-operations step:04  # Blame
   pnpm --filter @statewalker/vcs-example-05-history-operations step:05  # File history
   ```

Commits are staged with a helper, `addFileToStaging()`, that stores a blob and writes a staging entry directly. Example [02-porcelain-commands](../02-porcelain-commands/) covers the porcelain basics this tutorial assumes.

## The walk-through

### Step 1: `git.log()` yields commits newest first

**File:** [src/steps/01-log-traversal.ts](src/steps/01-log-traversal.ts)

The step makes five commits, then reads them back. `git.log().call()` resolves to an async iterable of commit objects (`LogResult`), ordered from newest to oldest. The commit objects do not carry their id; the step gets it by hashing the commit again with `history.commits.store(commit)`, which returns the same id for the same content.

```typescript
// Basic log - iterate all commits
for await (const commit of await git.log().call()) {
  console.log(commit.message);
}

// Limited log - only the most recent commits
for await (const commit of await git.log().setMaxCount(3).call()) {
  const commitId = await history.commits.store(commit);
  console.log(`${shortId(commitId)} ${commit.message}`);
}

// Low-level ancestry walk
const head = await history.refs.resolve("HEAD");
if (head?.objectId) {
  for await (const id of history.commits.walkAncestry(head.objectId, { limit: 3 })) {
    const commit = await history.commits.load(id);
    console.log(`${shortId(id)} ${commit?.message}`);
  }
}
```

**Key APIs:**
- `git.log().call()` - async iterable of commits, starting at HEAD
- `git.log().setMaxCount(n)` - stop after n commits
- `git.log().add(commitId)` - start from a given commit instead of HEAD (can be called several times)
- `git.log().addPath(path)` - keep only commits that change `path`
- `history.commits.walkAncestry(startId, { limit, stopAt, firstParentOnly })` - low-level walker that yields commit ids

### Step 2: The merge base of two branches is their newest common ancestor

**File:** [src/steps/02-commit-ancestry.ts](src/steps/02-commit-ancestry.ts)

The step builds this graph, switching to `feature` by pointing HEAD at the branch and reading its tree into the staging area:

```
A---B---C  (main)
     \
      D  (feature)
```

It then checks ancestry with a breadth-first walk over `commit.parents`, and asks for the merge base. The merge base is the input to a three-way merge; fast-forward detection is an ancestry check.

```typescript
// Find merge base (common ancestor of two branches)
const mergeBases = await history.commits.findMergeBase(commitC, commitD);
const commonAncestor = mergeBases[0]; // B

// Manual ancestry check by walking the commit graph
async function isAncestor(ancestorId: string, descendantId: string): Promise<boolean> {
  if (ancestorId === descendantId) return true;
  const visited = new Set<string>();
  const queue = [descendantId];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    if (current === ancestorId) return true;
    const commit = await history.commits.load(current);
    for (const parent of commit?.parents ?? []) {
      if (!visited.has(parent)) queue.push(parent);
    }
  }
  return false;
}
```

The manual walk is there to show the mechanism. `history.commits.isAncestor(ancestor, descendant)` does the same check in one call.

**Key APIs:**
- `history.commits.findMergeBase(a, b)` - common ancestor(s), as an array of ids
- `history.commits.isAncestor(ancestor, descendant)` - ancestry check
- `history.commits.load(commitId)` - load a commit object by id

### Step 3: A diff is a list of `DiffEntry` change records

**File:** [src/steps/03-diff-commits.ts](src/steps/03-diff-commits.ts)

Comparing two commits produces `DiffEntry` objects. Each one has a change type, the old and new paths, and the old and new blob ids. A diff compares two snapshots, so the diff from commit 1 to commit 3 lists every path that differs between them, whichever commit changed it.

```typescript
import { formatDiffEntry } from "@statewalker/vcs-commands";

const diff = await git.diff().setOldTree(commit1).setNewTree(commit2).call();

for (const entry of diff) {
  console.log(`${entry.changeType}: ${entry.newPath || entry.oldPath}`);
  console.log(formatDiffEntry(entry)); // e.g. "M\tsrc/index.ts"
}
```

Output of the run:

```
--- Diff between commit 1 and commit 2 ---

  Changes (2 entries):
    MODIFY: src/index.ts
    ADD: src/utils.ts
```

**Key APIs:**
- `git.diff().setOldTree(refOrId).setNewTree(refOrId).call()` - compare two commits
- `DiffEntry.changeType` - `ChangeType.ADD`, `DELETE`, `MODIFY`, `RENAME` or `COPY`
- `DiffEntry.oldPath` / `newPath`, `oldId` / `newId` - unset on the missing side for ADD and DELETE
- `formatDiffEntry(entry)` - one-line, name-status style formatting

### Step 4: Blame attributes every line to the commit that introduced it

**File:** [src/steps/04-blame.ts](src/steps/04-blame.ts)

The step commits three versions of `src/config.ts` and blames the result. `BlameResult.entries` is a list of runs of consecutive lines that come from the same commit. A commit that touched lines in several places shows up in several entries: the 8-line file in this step produces 7 entries from 3 commits.

```typescript
const result = await git.blame().setFilePath("src/config.ts").call();

// Author of one line (1-based)
const author = result.getSourceAuthor(5);
console.log(`Line 5 by: ${author?.name}`);

// Runs of consecutive lines from the same commit
for (const entry of result.entries) {
  console.log(`Lines ${entry.resultStart}-${entry.resultStart + entry.lineCount - 1}`);
  console.log(`  Commit: ${entry.commit.message}`);
}
```

Output of the run (ids differ on each run because commit timestamps are the current time):

```
  Line | Commit  | Author        | Content
  ------------------------------------------------------------
     1 | 47d828a | Unknown      | // Configuration file
     2 | f0983de | Unknown      | // Updated for v2
     3 | 47d828a | Unknown      | export const config = {
     4 | 47d828a | Unknown      |   name: "MyApp",
     5 | f0983de | Unknown      |   version: "2.0.0",
     6 | 1667756 | Unknown      |   debug: false,
     7 | f0983de | Unknown      |   features: ["auth", "api"],
     8 | 47d828a | Unknown      | };
```

**Key APIs:**
- `git.blame().setFilePath(path).call()` - blame a file at HEAD (path is required)
- `.setStartCommit(id)`, `.setFollowRenames(bool)` - blame from another commit, follow renames
- `BlameResult.entries` - `BlameEntry[]` with `commitId`, `commit`, `resultStart`, `sourceStart`, `lineCount`
- `BlameResult.getEntry(line)`, `getSourceCommit(line)`, `getSourceAuthor(line)`, `getSourceLine(line)` - per-line lookups, 1-based
- `BlameResult.getLineTracking()` - one `LineTracking` record per line

### Step 5: File history by comparing blob ids along the ancestry walk

**File:** [src/steps/05-file-history.ts](src/steps/05-file-history.ts)

The step makes five commits, three of which change `src/main.ts`, then walks the ancestry from HEAD and resolves the file's blob id in each commit's tree with `history.trees.getEntry()`. A change in blob id between neighbouring commits marks a change to the file. It then prints the earliest and latest content, loaded with `history.blobs.load()`.

```typescript
const fileHistory = [];
let previousBlobId;

for await (const commitId of history.commits.walkAncestry(headId)) {
  const commit = await history.commits.load(commitId);
  if (!commit) continue;
  const blobId = await getFileBlobId(history, commit.tree, "src/main.ts");

  if (blobId && blobId !== previousBlobId) {
    fileHistory.push({ commitId, blobId });
    previousBlobId = blobId;
  }
}
```

The walk goes newest to oldest, so this loop records the newest commit of each run of identical versions, not the commit that introduced the version. See "What will surprise you". `git.log().addPath("src/main.ts")` performs a path filter inside the log command.

**Key APIs:**
- `history.commits.walkAncestry(startId)` - walk all ancestor commits
- `history.trees.getEntry(treeId, name)` - look up one name in a tree; nested paths are resolved one segment at a time
- `history.blobs.load(blobId)` - file content as an async iterable of chunks

## Why it is the way it is

- **In-memory repository.** The steps use the in-memory History and WorkingCopy so the tutorial needs no setup, leaves no files behind, and runs the same way every time.
- **Staging is written directly.** `addFileToStaging()` stores a blob and edits the staging area through `checkout.staging.createEditor()` instead of writing files and calling `git.add()`. This keeps the focus on history rather than on the worktree.
- **Low-level and porcelain side by side.** Each step shows the `git.*` command next to the `history.*` call it rests on (`walkAncestry`, `findMergeBase`, `trees.getEntry`), so you can drop down a level when the porcelain does not fit.

## What will surprise you

- **Commit ids and dates change on every run.** Commits have no author set, so `CommitCommand` uses `Unknown <unknown@example.com>` and the current time. Ids in your output will not match the ones shown here.
- **Step 5 lists the wrong commits for `src/main.ts`.** Because of the newest-to-oldest walk described in Step 5, the run prints `Add config import to main.ts`, `Add README` and `Add utils.ts`. The commits that changed the file are `Create main.ts`, `Update main.ts with import` and `Add config import to main.ts`. The blob contents it prints as earliest and latest are correct.
- **The app's printed API summaries are partly stale.** Step 1 prints `.addPath(path) - Filter by path (not yet implemented)` and `.setStartCommit(id)`. `addPath()` is implemented, and `LogCommand` has no `setStartCommit()`; use `add(commitId)`.
- **Blame entries are not one per commit.** Expect more entries than commits whenever a commit's lines are not contiguous.
- **A failing step exits with code 1.** `main.ts` and each standalone step print `Error:` followed by the error and call `process.exit(1)`.

## Reference

### Commands

| Command | What it runs |
|---------|--------------|
| `pnpm --filter @statewalker/vcs-example-05-history-operations start` | `tsx src/main.ts` (all steps) |
| `pnpm --filter @statewalker/vcs-example-05-history-operations step:01` ... `step:05` | `tsx src/steps/0N-*.ts` (one step) |
| `pnpm --filter @statewalker/vcs-example-05-history-operations typecheck` | `tsc --noEmit` |

### Source of the APIs used

| API | Location |
|-----|----------|
| `Git` | [packages/vcs-commands/src/git.ts](../../../packages/vcs-commands/src/git.ts) |
| `LogCommand` | [packages/vcs-commands/src/commands/log-command.ts](../../../packages/vcs-commands/src/commands/log-command.ts) |
| `DiffCommand`, `formatDiffEntry` | [packages/vcs-commands/src/commands/diff-command.ts](../../../packages/vcs-commands/src/commands/diff-command.ts) |
| `BlameCommand`, `BlameResult` | [packages/vcs-commands/src/commands/blame-command.ts](../../../packages/vcs-commands/src/commands/blame-command.ts) |
| `DiffEntry`, `ChangeType` | [packages/vcs-commands/src/results/diff-entry.ts](../../../packages/vcs-commands/src/results/diff-entry.ts) |
| `Commits` (ancestry, merge base) | [packages/vcs-core/src/history/commits/](../../../packages/vcs-core/src/history/commits/) |
| `Trees` | [packages/vcs-core/src/history/trees/](../../../packages/vcs-core/src/history/trees/) |
| `Blobs` | [packages/vcs-core/src/history/blobs/](../../../packages/vcs-core/src/history/blobs/) |
| `Refs` | [packages/vcs-core/src/history/refs/](../../../packages/vcs-core/src/history/refs/) |

### Related examples

- [04-branching-merging](../04-branching-merging/) - branch operations and merge strategies
- [07-staging-checkout](../07-staging-checkout/) - working tree and staging area operations
