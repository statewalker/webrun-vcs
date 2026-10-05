# Complete Git Workflow Demo

## What it is

A Node script that walks one repository through a full Git lifecycle using only the porcelain commands of `@statewalker/vcs-commands`: init, add, commit, branch, checkout, merge, log, diff, gc and status. It runs nine steps in one process and prints what each step did. No native `git` binary is called.

## Layout

```
src/
  main.ts                  runs all steps, or one with --step=NN
  shared/index.ts          REPO_DIR, shared state between steps, logging, file helpers
  steps/
    01-init-repo.ts        Git.init() with a Node FilesApi and a FileStagingStore
    02-create-files.ts     writes 8 project files, git.add("."), first commit
    03-generate-commits.ts 9 more commits (add file / modify / update README / add test)
    04-branching.ts        branches "feature" and "bugfix", one commit on each
    05-merging.ts          fast-forward merge of bugfix, three-way merge of feature
    06-diff-viewer.ts      git.log() + git.diff() between commits
    07-gc-packing.ts       git.gc().setPackRefs(true)
    08-checkout.ts         detached checkout of the first commit
    09-verification.ts     compares staged blobs with the original file contents
```

The script writes into `test-workflow-repo/` under the current working directory (ignored by `.gitignore`).

## How to run it

The `@statewalker/vcs-*` workspace packages resolve to their built `dist/`, so build once first.

1. `pnpm install && pnpm build` at the repository root (Node 24).
2. Run all steps:

   ```bash
   pnpm --filter @statewalker/vcs-demo-git-workflow-complete start
   ```

The run ends with a summary of the nine steps and the total time, and exits 0. Abridged output:

```
  Step 05: Merge Operations
Merging 'bugfix' into 'main' (fast-forward)...
  Merge status: fast-forward
Merging 'feature' into 'main' (three-way merge)...
  Merge status: merged
...
  Step 09: Verify Checkout
  ✓ Staging area is clean (no uncommitted changes)
  ✓ Verification complete! All files match original content.
```

## What the steps do

### One repository, built up across steps

Step 01 creates the repository:

```typescript
import { Git } from "@statewalker/vcs-commands";
import { FileStagingStore } from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";

const files = createNodeFilesApi({ rootDir: REPO_DIR });
const staging = new FileStagingStore(files, ".git/index");

const { git, repository, initialBranch } = await Git.init()
  .setFilesApi(files)
  .setDirectory("")
  .setGitDir(".git")
  .setInitialBranch("main")
  .setStagingStore(staging)
  .setWorktree(true)
  .call();
```

Steps 02 and 03 write files through the `FilesApi` and commit them with `git.add().addFilepattern(".").call()` and `git.commit().setMessage(...).call()`, giving 10 commits on `main`.

### Branching and merging

```typescript
import { MergeStrategy } from "@statewalker/vcs-commands";

await git.branchCreate().setName("feature").call();
await git.branchCreate().setName("bugfix").call();
await git.checkout().setName("feature").call();
// ... commit on feature, then on bugfix ...
await git.checkout().setName("main").call();

await git.merge().include("bugfix").call(); // fast-forward
await git.merge().include("feature").setStrategy(MergeStrategy.RECURSIVE).call(); // three-way

await git.branchDelete().setBranchNames("bugfix", "feature").call();
```

### Viewing diffs

Step 06 reads the last five commits with `git.log().setMaxCount(5)` and diffs HEAD against HEAD~1, then the oldest of those five against HEAD:

```typescript
const diff = await git.diff().setOldTree(previousCommit).setNewTree(latestCommit).call();
for (const entry of diff) {
  console.log(`${entry.changeType}: ${entry.newPath}`);
}
```

### Maintenance, checkout and verification

Step 07 runs `git.gc().setPackRefs(true).call()` and prints loose-object and pack-file counts before and after. Step 08 checks out the first commit by id (`git.checkout().setName(firstCommit.id)`) and lists the staging entries. Step 09 loads each staged blob, compares it with the content written in step 02, calls `git.status()`, and checks out `main` again.

## Why it is the way it is

- **Porcelain only.** The demo exists to show the command builder API (`git.<command>().setX().call()`) end to end, so it uses no low-level store calls and no native git.
- **Steps share in-process state.** Each step reads `git`, `files` and the recorded commits from the `state` object in `shared/index.ts`. That keeps every step file short, at the cost that steps cannot run on their own (see below).
- **`FileStagingStore` for the index.** The index is written to `.git/index` in Git's binary format rather than held in memory.

## What will surprise you

- **`test-workflow-repo/` is not a Git repository on disk.** `Git.init()` always creates an in-memory history; `setFilesApi()` only backs the working tree. After a run the directory contains the working files and `.git/index`, nothing else. `git log` inside it fails with `fatal: not a git repository`.
- **Step 07 finds nothing to pack.** Because objects never reach disk, it prints `Loose objects: 0`, `Pack files: 0` and `Refs packed: no`, then a note that full object packing is not done by `git.gc()`.
- **Step 08 does not rewrite the files on disk.** The checkout reports `Files updated: 0`; it changes HEAD and the staging area. Step 09 verifies staged blobs, not files on disk.
- **`step:NN` scripts other than `step:01` fail on their own.** Each runs in a fresh process with empty state, so step 02 and later throw `Repository not initialized. Run step 01 first.` and the script prints `✗ Step NN failed:` and exits 1. Use `start` to run the full sequence.
- **Each run deletes `test-workflow-repo/` first.** Step 01 removes the directory recursively before re-creating it.
- **Run through `pnpm --filter`, the directory lands in the app folder.** pnpm runs the script with the package directory as the working directory, so the output is `apps/demos/git-workflow-complete/test-workflow-repo/`.

## Reference

### Commands

Run from the repository root:

| Command | What it does |
|---|---|
| `pnpm --filter @statewalker/vcs-demo-git-workflow-complete start` | Run all nine steps |
| `pnpm --filter @statewalker/vcs-demo-git-workflow-complete step:01` | Run one step (`step:01` to `step:09`; only `step:01` works alone) |
| `pnpm --filter @statewalker/vcs-demo-git-workflow-complete typecheck` | `tsc --noEmit` |

### Dependencies

`@statewalker/vcs-commands` (porcelain API), `@statewalker/vcs-core` (types), `@statewalker/vcs-store-files` (`FileStagingStore`), `@statewalker/vcs-utils` and `@statewalker/vcs-utils-node` (Node compression and `FilesApi`). `@statewalker/vcs-store-mem` is declared but not imported by the source.
