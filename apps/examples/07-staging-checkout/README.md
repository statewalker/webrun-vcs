# 07-staging-checkout

A runnable tutorial on the staging area (the index) and on the operations built on it: staging, unstaging, status, restoring a file from an older commit, switching branches, and reset. It uses `@statewalker/vcs-commands` for commit, status and branch commands, and the staging API from `@statewalker/vcs-working-tree` for everything else. Everything runs in memory: nothing is written to disk and no network is used.

## The staging area sits between the worktree and history

```
  Worktree            Staging area (index)          History
  (your files)  add   path -> blob id, mode,  commit  commits, trees,
               ────▶  stage, size, mtime     ──────▶  blobs, refs
```

Every step in this example works on the middle box. The in-memory worktree has no files, so steps change staging directly and the porcelain commands that need a worktree (`add`, `checkout`, `reset`, `clean`) are shown as code text rather than executed.

```
apps/examples/07-staging-checkout/
├── package.json
├── tsconfig.json
└── src/
    ├── main.ts                        # Runs steps 1-7 in order
    ├── shared.ts                      # In-memory History + WorkingCopy + Git setup, helpers
    └── steps/
        ├── 01-staging-concepts.ts     # entries(), entry fields, merge stages
        ├── 02-staging-changes.ts      # editor and builder
        ├── 03-unstaging.ts            # editor.remove(), rebuild, readTree()
        ├── 04-status.ts               # git.status()
        ├── 05-checkout-files.ts       # restore one file from an older commit
        ├── 06-checkout-branches.ts    # switch HEAD and reload staging
        └── 07-clean-reset.ts          # soft, mixed and hard reset by hand
```

`shared.ts` composes the repository from `createMemoryHistory()` (vcs-core) and `createMemoryGitStaging()`, `createMemoryCheckout()`, `createMemoryWorktree()`, `createMemoryWorkingCopy()` (vcs-working-tree), wrapped with `Git.fromWorkingCopy()`. Each step calls `resetState()` and starts from an empty repository.

## How to run it

Requires Node 24 and pnpm. From the repository root:

1. Install the workspace:

   ```bash
   pnpm install
   ```

2. Run all seven steps:

   ```bash
   pnpm --filter @statewalker/vcs-example-07-staging-checkout start
   ```

3. Or run a single step:

   ```bash
   pnpm --filter @statewalker/vcs-example-07-staging-checkout step:01  # Staging concepts
   pnpm --filter @statewalker/vcs-example-07-staging-checkout step:02  # Staging changes
   pnpm --filter @statewalker/vcs-example-07-staging-checkout step:03  # Unstaging
   pnpm --filter @statewalker/vcs-example-07-staging-checkout step:04  # Status
   pnpm --filter @statewalker/vcs-example-07-staging-checkout step:05  # Checkout files
   pnpm --filter @statewalker/vcs-example-07-staging-checkout step:06  # Checkout branches
   pnpm --filter @statewalker/vcs-example-07-staging-checkout step:07  # Clean and reset
   ```

Example [02-porcelain-commands](../02-porcelain-commands/) covers the porcelain basics this tutorial assumes.

## The walk-through

### Step 1: Staging holds the content of the next commit

**File:** [src/steps/01-staging-concepts.ts](src/steps/01-staging-concepts.ts)

The step makes one commit and lists the staging entries. A commit writes the staging entries as a tree and leaves staging as it was, so after the commit staging still describes the same snapshot.

```typescript
await resetState();
const { git, workingCopy } = await getGit();

await addFileToStaging(workingCopy, "README.md", "# Staging Demo");
await git.commit().setMessage("Initial commit").call();

for await (const entry of workingCopy.checkout.staging.entries()) {
  console.log(`${entry.path} -> ${shortId(entry.objectId)}`);
}
```

**Key APIs:**
- `staging.entries()` - iterate all entries in Git index order (by path, then stage)
- `staging.createEditor()` - targeted changes to individual entries
- `staging.createBuilder()` - replace the whole staging area

### Step 2: The editor changes entries, the builder replaces them all

**File:** [src/steps/02-staging-changes.ts](src/steps/02-staging-changes.ts)

To stage content without a worktree, store the blob and add an entry. An editor edit names a path and an `apply` function that receives the existing entry (or `undefined`) and returns the new one.

```typescript
import { FileMode } from "@statewalker/vcs-core";
import { MergeStage } from "@statewalker/vcs-working-tree";

const content = new TextEncoder().encode("export const v1 = 1;");
const blobId = await workingCopy.history.blobs.store([content]);

const editor = workingCopy.checkout.staging.createEditor();
editor.add({
  path: "src/version.ts",
  apply: () => ({
    path: "src/version.ts",
    mode: FileMode.REGULAR_FILE,
    objectId: blobId,
    stage: MergeStage.MERGED,
    size: content.length,
    mtime: Date.now(),
  }),
});
await editor.finish();
```

A builder starts from an empty staging area: after `builder.finish()` only the entries added to the builder remain. In the run, adding `src/config.ts` through the builder drops `README.md` and `src/version.ts`:

```
3. Using staging builder:
  Added via builder: src/config.ts

--- Current staging area ---
  src/config.ts -> 190e5ba
```

With a worktree, `git.add().addFilepattern(pattern).call()` stages files from disk; the step prints that form without running it.

**Key APIs:**
- `staging.createEditor()` - `add(edit)`, `upsert(entry)`, `remove(path)`, then `finish()`
- `staging.createBuilder()` - `add(entry)`, `addTree(trees, treeId, prefix)`, `keep(start, count)`, then `finish()`
- `git.add().addFilepattern(pattern).call()` - porcelain staging from the worktree

### Step 3: Unstaging removes entries or reloads them from HEAD

**File:** [src/steps/03-unstaging.ts](src/steps/03-unstaging.ts)

The step stages three new files, then removes one with the editor, rebuilds staging without another, and finally reloads staging from the HEAD commit's tree.

```typescript
// Remove a single entry
const editor = workingCopy.checkout.staging.createEditor();
editor.remove("src/remove.ts");
await editor.finish();

// Reset staging to match HEAD
const head = await history.refs.resolve("HEAD");
if (head?.objectId) {
  const commit = await history.commits.load(head.objectId);
  if (commit) {
    await workingCopy.checkout.staging.readTree(history.trees, commit.tree);
  }
}
```

**Key APIs:**
- `editor.remove(path)` - remove one entry
- `staging.readTree(trees, treeId)` - replace staging with the contents of a tree
- `git.reset().addPath(path).call()` - porcelain unstage of one path

### Step 4: Status compares staging with HEAD

**File:** [src/steps/04-status.ts](src/steps/04-status.ts)

`git.status()` compares the staging area with the HEAD tree and returns sets of paths. It does not look at the worktree, so there is no untracked or modified-in-worktree set.

```typescript
const status = await git.status().call();

console.log("Added:", [...status.added]);
console.log("Changed:", [...status.changed]);
console.log("Removed:", [...status.removed]);
console.log("Conflicting:", [...status.conflicting]);

if (status.isClean()) {
  console.log("Nothing staged");
}
```

Output of the run, after staging a new file, changing one and dropping another:

```
  Current status:
    Clean:       false
    Added:       src/new-file.ts
    Changed:     src/index.ts
    Removed:     README.md
    Conflicting: (none)
```

**Key APIs:**
- `git.status().call()` - `Status` with `added`, `changed`, `removed`, `conflicting` (all `Set<string>`)
- `status.isClean()` - true when all four sets are empty
- `git.status().addPath(path)` - limit status to a path

### Step 5: Restoring a file means pointing its entry at an older blob

**File:** [src/steps/05-checkout-files.ts](src/steps/05-checkout-files.ts)

The step commits three versions of `config.json`, finds the file's blob in commit 1's tree, and writes that blob id into the staging entry. HEAD does not move. It then restores the HEAD version the same way.

```typescript
const commit = await history.commits.load(commit1);
const entry = commit ? await history.trees.getEntry(commit.tree, "config.json") : undefined;

if (entry) {
  const editor = workingCopy.checkout.staging.createEditor();
  editor.add({
    path: "config.json",
    apply: (existing) => ({
      path: "config.json",
      mode: existing?.mode ?? FileMode.REGULAR_FILE,
      objectId: entry.id,
      stage: MergeStage.MERGED,
      size: existing?.size ?? 0,
      mtime: Date.now(),
    }),
  });
  await editor.finish();
}
```

With a worktree, the porcelain form is `git.checkout().setStartPoint(commitId).addPath("config.json").call()`.

**Key APIs:**
- `history.trees.getEntry(treeId, name)` - one entry of a tree (`{ mode, name, id }`)
- `history.blobs.load(blobId)` - file content as an async iterable of chunks
- `git.checkout().setStartPoint(commitId).addPath(path).call()` - porcelain file checkout

### Step 6: Switching branches moves HEAD and reloads staging

**File:** [src/steps/06-checkout-branches.ts](src/steps/06-checkout-branches.ts)

The step creates `feature`, commits once more on `main`, then switches by hand: point HEAD at the branch, load the branch commit, read its tree into staging. `main-only.ts` disappears from staging on `feature` and comes back on `main`. Finally it creates `develop` with `history.refs.set()` and lists branches with `git.branchList()`.

```typescript
await git.branchCreate().setName("feature").call();

// Switch to feature
await history.refs.setSymbolic("HEAD", "refs/heads/feature");
const ref = await history.refs.resolve("refs/heads/feature");
if (ref?.objectId) {
  const commit = await history.commits.load(ref.objectId);
  if (commit) {
    await workingCopy.checkout.staging.readTree(history.trees, commit.tree);
  }
}

const branches = await git.branchList().call();
```

With a worktree, `git.checkout().setName("feature").call()` does this and also updates files; `.setCreateBranch(true)` creates the branch first.

**Key APIs:**
- `history.refs.setSymbolic("HEAD", "refs/heads/<branch>")` - attach HEAD to a branch
- `history.refs.set(name, commitId)` - create or move a branch
- `staging.readTree(trees, treeId)` - load the branch's tree into staging
- `git.branchCreate()`, `git.branchList()` - branch porcelain
- `git.checkout().setName(branch).setCreateBranch(bool).call()` - porcelain branch switch

### Step 7: The three reset modes differ in what they roll back

**File:** [src/steps/07-clean-reset.ts](src/steps/07-clean-reset.ts)

The step makes three commits and performs each reset by hand, so the effect of each mode is visible:

| Mode | Branch ref | Staging | Worktree | How the step does it |
|------|------------|---------|----------|----------------------|
| soft | Moves | Unchanged | Unchanged | `history.refs.set("refs/heads/main", commit2)` |
| mixed (default) | Moves | Reset | Unchanged | the same, then `staging.readTree(trees, commit2.tree)` |
| hard | Moves | Reset | Reset | the same; the in-memory worktree has nothing to reset |

After the soft reset to commit 2, staging still holds the commit 3 version of `src/index.ts`; after the mixed reset it holds the commit 2 version.

The porcelain equivalents, with `ResetMode` from `@statewalker/vcs-commands`:

```typescript
import { ResetMode } from "@statewalker/vcs-commands";

await git.reset().setRef("HEAD~1").setMode(ResetMode.SOFT).call();
await git.reset().setRef(commitId).call(); // mixed
await git.reset().setRef(commitId).setMode(ResetMode.HARD).call();
await git.reset().addPath("path/to/file").call(); // unstage one path
```

`git.clean()` removes untracked files from the worktree. Its options are `setDryRun(bool)`, `setCleanDirectories(bool)`, `setIgnore(bool)` and `setPaths(set)`. The step only describes it, since the in-memory worktree has no untracked files.

**Key APIs:**
- `git.reset().setRef(ref).setMode(ResetMode.SOFT | MIXED | HARD | KEEP).call()`
- `git.reset().addPath(path).call()`
- `git.clean().setDryRun(true).call()`

## Staging entries and merge stages

Each staging entry carries the path, mode, blob id, merge stage, size and mtime (milliseconds since the epoch), plus optional flags (`intentToAdd`, `assumeValid`, `skipWorktree`, ...). The full type is `StagingEntry` in `@statewalker/vcs-working-tree`.

During a merge conflict one path can have up to three entries at different stages. Resolving the conflict replaces them with one stage-0 entry.

| Stage | `MergeStage` | Meaning |
|-------|--------------|---------|
| 0 | `MERGED` | No conflict |
| 1 | `BASE` | Common ancestor |
| 2 | `OURS` | Current branch |
| 3 | `THEIRS` | Incoming branch |

## Why it is the way it is

- **In-memory repository.** No setup, nothing left behind, identical behaviour on every run.
- **Staging is edited directly.** With no files in the worktree, the porcelain commands that read or write files have nothing to act on. Editing staging and refs by hand shows exactly what those commands change, one layer down.
- **Each step starts fresh.** `resetState()` at the top of every step keeps steps independent, so `step:NN` runs alone.

## What will surprise you

- **Some porcelain shown in the output is never executed.** `git.add()`, `git.checkout()`, `git.reset()` and `git.clean()` appear only as printed code. The executed calls are `git.commit()`, `git.status()`, `git.branchCreate()` and `git.branchList()`.
- **The printed API text has mistakes.** Step 4 lists `status.untracked`, which does not exist. Step 7 prints `setMode("soft")` (the method takes `ResetMode.SOFT`) and `setForce(true)` / `setDirectories(true)` for clean; `CleanCommand` has neither (use `setCleanDirectories()`). Step 3 prints `staging.builder()`; the method is `createBuilder()`. The snippets in this README use the real API.
- **The builder drops everything you did not add.** In step 2 the commit `Add source files` contains `src/config.ts` and `src/version.ts` only; `README.md` was removed by the builder.
- **Ids and dates change on every run.** Commits use the default `Unknown <unknown@example.com>` identity and the current time.
- **A failing step exits with code 1.** `main.ts` and each standalone step print `Error:` followed by the error and call `process.exit(1)`.

## Reference

### Commands

| Command | What it runs |
|---------|--------------|
| `pnpm --filter @statewalker/vcs-example-07-staging-checkout start` | `tsx src/main.ts` (all steps) |
| `pnpm --filter @statewalker/vcs-example-07-staging-checkout step:01` ... `step:07` | `tsx src/steps/0N-*.ts` (one step) |
| `pnpm --filter @statewalker/vcs-example-07-staging-checkout typecheck` | `tsc --noEmit` |

### Source of the APIs used

| API | Location |
|-----|----------|
| `Staging`, `IndexEditor`, `IndexBuilder` | [packages/working-tree/src/staging/staging.ts](../../../packages/working-tree/src/staging/staging.ts) |
| `StagingEntry`, `MergeStage` | [packages/working-tree/src/staging/types.ts](../../../packages/working-tree/src/staging/types.ts) |
| `Checkout` | [packages/working-tree/src/checkout/checkout.ts](../../../packages/working-tree/src/checkout/checkout.ts) |
| `WorkingCopy` | [packages/working-tree/src/working-copy.ts](../../../packages/working-tree/src/working-copy.ts) |
| `Refs` | [packages/core/src/history/refs/refs.ts](../../../packages/core/src/history/refs/refs.ts) |
| `AddCommand` | [packages/commands/src/commands/add-command.ts](../../../packages/commands/src/commands/add-command.ts) |
| `StatusCommand` | [packages/commands/src/commands/status-command.ts](../../../packages/commands/src/commands/status-command.ts) |
| `Status` | [packages/commands/src/results/status-result.ts](../../../packages/commands/src/results/status-result.ts) |
| `CheckoutCommand` | [packages/commands/src/commands/checkout-command.ts](../../../packages/commands/src/commands/checkout-command.ts) |
| `ResetCommand` | [packages/commands/src/commands/reset-command.ts](../../../packages/commands/src/commands/reset-command.ts) |
| `ResetMode` | [packages/commands/src/types.ts](../../../packages/commands/src/types.ts) |
| `CleanCommand` | [packages/commands/src/commands/clean-command.ts](../../../packages/commands/src/commands/clean-command.ts) |

### Related examples

- [04-branching-merging](../04-branching-merging/) - branch operations and merge strategies
- [06-internal-storage](../06-internal-storage/) - low-level object and pack operations
