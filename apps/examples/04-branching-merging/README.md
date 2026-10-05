# 04-branching-merging

## What it is

A closer look at branches and merges with `@statewalker/vcs-commands`: creating and listing branches, how `HEAD` works as a symbolic ref, fast-forward and three-way merges, tree-level and content-level merge strategies, what a conflict leaves in the staging area, and how rebase differs from merge. Seven step scripts run against an in-memory repository built from `@statewalker/vcs-core` and `@statewalker/vcs-working-tree`. Nothing is written to disk and nothing goes over the network.

## Layout

```
apps/examples/04-branching-merging/
├── package.json                    # name: @statewalker/vcs-example-04-branching-merging
└── src/
    ├── main.ts                     # runs steps 1-7 in order
    ├── shared.ts                   # getGit(), resetState(), addFileToStaging(), print helpers
    └── steps/
        ├── 01-branch-creation.ts
        ├── 02-head-management.ts
        ├── 03-fast-forward.ts
        ├── 04-three-way-merge.ts
        ├── 05-merge-strategies.ts
        ├── 06-conflict-handling.ts
        └── 07-rebase-concepts.ts
```

## How to run it

Requires Node 24 and pnpm.

```bash
# from the repository root
pnpm install
pnpm --filter @statewalker/vcs-example-04-branching-merging start
```

Each step also runs on its own:

```bash
pnpm --filter @statewalker/vcs-example-04-branching-merging step:01  # branch creation
pnpm --filter @statewalker/vcs-example-04-branching-merging step:02  # HEAD management
pnpm --filter @statewalker/vcs-example-04-branching-merging step:03  # fast-forward merge
pnpm --filter @statewalker/vcs-example-04-branching-merging step:04  # three-way merge
pnpm --filter @statewalker/vcs-example-04-branching-merging step:05  # merge strategies
pnpm --filter @statewalker/vcs-example-04-branching-merging step:06  # conflict handling
pnpm --filter @statewalker/vcs-example-04-branching-merging step:07  # rebase concepts
```

## The walk-through

[src/shared.ts](src/shared.ts) builds the same `Git` facade as [02-porcelain-commands](../02-porcelain-commands/): `createMemoryHistory()`, `createMemoryGitStaging()`, `createMemoryCheckout()`, `createMemoryWorktree()`, composed with `createMemoryWorkingCopy()` and wrapped with `Git.fromWorkingCopy()`. Files are staged with `addFileToStaging()`, which stores a blob and adds an index entry through `staging.createEditor()`.

Several steps switch branches by hand instead of with `git.checkout()`: they point `HEAD` at the branch and reload the index from the branch's tree.

```typescript
await history.refs.setSymbolic("HEAD", "refs/heads/feature-ff");
const ref = await history.refs.resolve("refs/heads/feature-ff");
const commit = ref?.objectId ? await history.commits.load(ref.objectId) : undefined;
if (commit) await workingCopy.checkout.staging.readTree(history.trees, commit.tree);
```

### Step 1: a branch is a ref created at HEAD or at a start point

[src/steps/01-branch-creation.ts](src/steps/01-branch-creation.ts):

```typescript
const feature = await git.branchCreate().setName("feature").call(); // returns the Ref
console.log(feature.name); // "refs/heads/feature"

await git.branchCreate().setName("release").setStartPoint(commitId).call();

const branches = await git.branchList().call(); // Ref[]

// Low level: list refs by prefix
for await (const ref of history.refs.list("refs/heads/")) {
  const resolved = await history.refs.resolve(ref.name);
  console.log(ref.name, resolved?.objectId);
}
```

### Step 2: HEAD is a symbolic ref until you detach it

[src/steps/02-head-management.ts](src/steps/02-head-management.ts):

```typescript
import { isSymbolicRef } from "@statewalker/vcs-core";

const head = await history.refs.get("HEAD");
// { name: "HEAD", target: "refs/heads/main", ... }
if (head && isSymbolicRef(head)) console.log(head.target);

const resolved = await history.refs.resolve("HEAD"); // follows the target to a commit
console.log(resolved?.objectId);

await history.refs.setSymbolic("HEAD", "refs/heads/feature"); // switch branch (refs only)
await history.refs.set("HEAD", resolved.objectId);             // detach HEAD at a commit
await history.refs.setSymbolic("HEAD", "refs/heads/main");     // re-attach
```

`refs.get()` returns either a `SymbolicRef` (`target`) or a `Ref` (`objectId`); `isSymbolicRef()` tells them apart. After `refs.set("HEAD", id)` the run prints `{"name":"HEAD","objectId":"7f561da...","storage":"loose","peeled":false}`.

### Step 3: a merge fast-forwards when main has not moved

[src/steps/03-fast-forward.ts](src/steps/03-fast-forward.ts) commits twice on `feature-ff`, returns to `main` and merges:

```
before:  main ----o (initial)          after:  ----o----o----o
                   \                                         ^ main, feature-ff
                    o---o feature-ff
```

```typescript
const result = await git.merge().include("feature-ff").call();
console.log(result.status);  // "fast-forward"
console.log(result.newHead); // main now points at feature-ff's tip
```

The merge command's fast-forward behaviour is set with `setFastForwardMode()`:

| Mode                      | Behaviour                                                        |
| ------------------------- | ---------------------------------------------------------------- |
| `FastForwardMode.FF`      | Fast-forward when possible, merge commit otherwise (default)     |
| `FastForwardMode.NO_FF`   | Always create a merge commit                                     |
| `FastForwardMode.FF_ONLY` | Only fast-forward; otherwise throws `NotFastForwardError` |

The script describes these modes but only runs the default.

### Step 4: diverged branches get a merge commit with two parents

[src/steps/04-three-way-merge.ts](src/steps/04-three-way-merge.ts) adds two files on `main` and two different files on `feature-3way`, then merges:

```
main:    ----o---o---o---M
              \         /
feature:       o-------o
```

```typescript
import { MergeStatus } from "@statewalker/vcs-commands";

const result = await git.merge().include("feature-3way").call();
console.log(result.status, result.newHead, result.mergeBase); // "merged", ...

if (result.status === MergeStatus.MERGED && result.newHead) {
  const merge = await history.commits.load(result.newHead);
  console.log(merge?.parents.length); // 2
  console.log(merge?.message);        // "Merge commit '<short id>'"
}
```

`MergeResult` carries `status`, `newHead`, `mergeBase`, `mergedCommits`, `conflicts` and `failingPaths`.

### Step 5: tree strategies choose a side; content strategies resolve files

[src/steps/05-merge-strategies.ts](src/steps/05-merge-strategies.ts) runs two demos, each in a fresh repository.

```typescript
import { ContentMergeStrategy, MergeStrategy } from "@statewalker/vcs-commands";

// Both sides changed config.json. OURS keeps our tree and still records the merge.
await git.merge().include("their-changes").setStrategy(MergeStrategy.OURS).call(); // "merged"

// Both sides added an entry to CHANGELOG.md. UNION keeps both.
await git
  .merge()
  .include("changelog-branch")
  .setContentMergeStrategy(ContentMergeStrategy.UNION)
  .call(); // "merged"
```

| Situation                       | Setting                                          | Effect                                              |
| ------------------------------- | ------------------------------------------------ | --------------------------------------------------- |
| Normal merge                    | `MergeStrategy.RECURSIVE` (default)              | Three-way comparison against the merge base          |
| Single merge base only          | `MergeStrategy.RESOLVE`                          | Like recursive, without criss-cross handling         |
| Record the merge, keep our tree | `MergeStrategy.OURS`                             | Their changes are ignored                            |
| Take their tree                 | `MergeStrategy.THEIRS`                           | Our changes are discarded                            |
| Conflicting hunks in a file     | `ContentMergeStrategy.OURS` / `THEIRS`           | Pick one side per conflict                           |
| Additive files (changelogs)     | `ContentMergeStrategy.UNION`                     | Concatenate both sides, ours first                   |

### Step 6: a conflict leaves stages 1-3 in the index

[src/steps/06-conflict-handling.ts](src/steps/06-conflict-handling.ts) changes the same lines of `app.config.ts` on both branches and merges without a content strategy:

```typescript
const result = await git.merge().include("conflict-branch").call();

if (result.status === MergeStatus.CONFLICTING) {
  console.log(result.conflicts); // ["app.config.ts"]

  for await (const entry of workingCopy.checkout.staging.entries()) {
    console.log(entry.path, entry.stage, entry.objectId);
  }
}
```

| Stage | Meaning                           |
| ----- | --------------------------------- |
| 0     | Merged, no conflict               |
| 1     | Base (common ancestor) version    |
| 2     | Ours (current branch)             |
| 3     | Theirs (branch being merged)      |

The run prints `app.config.ts [BASE]`, `[OURS]` and `[THEIRS]`, each with its own blob id. To resolve, stage a single stage-0 entry for the path and commit; until then `git.commit()` throws `UnmergedPathsError` ("Cannot commit with unresolved conflicts"). The script stops at showing the stages.

### Step 7: rebase replays commits and gives them new ids

[src/steps/07-rebase-concepts.ts](src/steps/07-rebase-concepts.ts) prints the merge-versus-rebase diagrams, builds a `main` and a `feature-rebase` branch with two commits each, and stops there. It does not call `git.rebase()`.

```
before:  main:    ---A---B---C            after:  main:    ---A---B---C
                      \                                                \
         feature:      D---E                      feature:              D'---E'
```

To actually rebase the current branch onto `main`, resolve the branch name first:

```typescript
const rebase = await git.rebase().setUpstreamBranch("main"); // resolves "main" to a commit id
const result = await rebase.call();
```

|             | Merge                    | Rebase                          |
| ----------- | ------------------------ | ------------------------------- |
| History     | Keeps the branch shape   | Linear                          |
| Commit ids  | Unchanged                | Rewritten (D', E')              |
| Shared work | Safe                     | Only for commits not yet shared |

### What the output looks like

Excerpt from a real `start` run (ids differ on every run):

```
--- Step 1: Branch Creation ---
  Created branch: refs/heads/release at 7b818d7
    - refs/heads/develop
    - refs/heads/feature
    - refs/heads/main
    - refs/heads/release
  Total branches: 4

--- Step 3: Fast-Forward Merge ---
  Main before merge: d5f55ce
    Status: fast-forward
  Main after merge: 1367cf3

--- Step 4: Three-Way Merge ---
    Status: merged
    Merge base: 0bfdff9
    Parents: 2
    Message: Merge commit '820b112'

--- Step 6: Conflict Handling ---
    Status: conflicting
    Conflicts: 1 file(s)
      - app.config.ts
    app.config.ts [BASE] -> 833a72f
    app.config.ts [OURS] -> 083fdd0
    app.config.ts [THEIRS] -> e1fbbfd
```

## Why it is the way it is

- **Every step starts from an empty repository.** `main.ts` calls `resetState()` before steps 1 and 2, and steps 3 to 7 call it themselves. Each merge scenario needs a specific branch shape, and building it from scratch keeps the scenarios from interfering. It also means `start` and `step:NN` print the same thing for each step.
- **Branch switching is done on refs and the index.** Moving `HEAD` with `refs.setSymbolic()` and loading the tree with `staging.readTree()` shows what a checkout changes, without a worktree in the way.
- **Strategies are split into tree level and content level.** `MergeStrategy` decides how whole trees combine; `ContentMergeStrategy` decides what happens inside a file when both sides changed the same lines. They are set independently (`setStrategy()`, `setContentMergeStrategy()`).

## What will surprise you

- **`git.rebase().setUpstream("main")` does not resolve branch names.** `setUpstream()` takes a commit id. Given `"main"`, the rebase returns status `ok` but writes a rebased commit whose parent is the literal string `main`; walking that branch's history then hits a missing commit. Use `setUpstreamBranch("main")` (async) instead. Step 7 prints `git.rebase().setUpstream("main").call()` in its explanation; do not copy that line.
- **Commit authors are placeholders.** No step sets an author, so commits are recorded as `Unknown <unknown@example.com>` and merge commits as `Author <author@example.com>`.
- **`branchList()` and `branchCreate()` return full ref names** (`refs/heads/feature`).
- **Step 7 gets commit ids by storing the commit again.** It prints `history.commits.store(commitResult)`; the returned `commitResult.id` already holds the id.
- **Merge errors are typed.** Merging with nothing included throws `InvalidMergeHeadsError` ("No merge head specified"); `FF_ONLY` on diverged branches throws `NotFastForwardError` ("Cannot fast-forward merge; branches have diverged"); branches without a common ancestor throw `NoMergeBaseError` ("No merge base found"). Any error ends the run with `Error:` followed by the error and exit code 1.

## Reference

| Script          | Runs                               |
| --------------- | ---------------------------------- |
| `start`         | `tsx src/main.ts` (all steps)      |
| `step:01`-`07`  | `tsx src/steps/NN-*.ts`            |
| `typecheck`     | `tsc --noEmit`                     |

| What | Where |
| ---- | ----- |
| `Git` facade | [packages/commands/src/git.ts](../../../packages/commands/src/git.ts) |
| Branch commands | [packages/commands/src/commands/branch-command.ts](../../../packages/commands/src/commands/branch-command.ts) |
| `MergeCommand` | [packages/commands/src/commands/merge-command.ts](../../../packages/commands/src/commands/merge-command.ts) |
| `RebaseCommand` | [packages/commands/src/commands/rebase-command.ts](../../../packages/commands/src/commands/rebase-command.ts) |
| `MergeResult`, `MergeStatus`, `MergeStrategy`, `ContentMergeStrategy`, `FastForwardMode` | [packages/commands/src/results/merge-result.ts](../../../packages/commands/src/results/merge-result.ts) |
| `Refs`, `isSymbolicRef` | [packages/core/src/history/refs/](../../../packages/core/src/history/refs/) |
| `WorkingCopy` | [packages/working-tree/src/working-copy.ts](../../../packages/working-tree/src/working-copy.ts) |
| Staging | [packages/working-tree/src/staging/](../../../packages/working-tree/src/staging/) |

Previous: [03-object-model](../03-object-model/). Next: [05-history-operations](../05-history-operations/), [07-staging-checkout](../07-staging-checkout/).
