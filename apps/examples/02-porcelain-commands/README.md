# 02-porcelain-commands

## What it is

A tour of the high-level commands API in `@statewalker/vcs-commands`: the `Git` facade with builder-style commands that mirror `git commit`, `branch`, `checkout`, `merge`, `log`, `diff`, `status`, `tag` and `stash`. Eight step scripts run against one in-memory repository built from `@statewalker/vcs-core` (history) and `@statewalker/vcs-working-tree` (staging, checkout, worktree). Nothing is written to disk and nothing goes over the network.

## Layout

```
apps/examples/02-porcelain-commands/
├── package.json                 # name: @statewalker/vcs-example-02-porcelain-commands
└── src/
    ├── main.ts                  # runs steps 1-8 in order on one shared repository
    ├── shared.ts                # getGit(), addFileToStaging(), print helpers
    └── steps/
        ├── 01-init-and-commit.ts
        ├── 02-branching.ts
        ├── 03-checkout.ts
        ├── 04-merge.ts
        ├── 05-log-diff.ts
        ├── 06-status.ts
        ├── 07-tag.ts
        └── 08-stash.ts
```

## How to run it

Requires Node 24 and pnpm.

```bash
# from the repository root
pnpm install
pnpm --filter @statewalker/vcs-example-02-porcelain-commands start
```

Each step also runs on its own:

```bash
pnpm --filter @statewalker/vcs-example-02-porcelain-commands step:01  # init and commit
pnpm --filter @statewalker/vcs-example-02-porcelain-commands step:02  # branching
pnpm --filter @statewalker/vcs-example-02-porcelain-commands step:03  # checkout
pnpm --filter @statewalker/vcs-example-02-porcelain-commands step:04  # merge
pnpm --filter @statewalker/vcs-example-02-porcelain-commands step:05  # log and diff
pnpm --filter @statewalker/vcs-example-02-porcelain-commands step:06  # status
pnpm --filter @statewalker/vcs-example-02-porcelain-commands step:07  # tags
pnpm --filter @statewalker/vcs-example-02-porcelain-commands step:08  # stash
```

## The walk-through

### The Git facade wraps a WorkingCopy

[src/shared.ts](src/shared.ts) assembles the repository once and caches it, so every step in a `start` run sees the same state:

```typescript
import { Git } from "@statewalker/vcs-commands";
import { createMemoryHistory } from "@statewalker/vcs-core";
import {
  createMemoryCheckout,
  createMemoryGitStaging,
  createMemoryWorkingCopy,
  createMemoryWorktree,
} from "@statewalker/vcs-working-tree";

const history = createMemoryHistory();
await history.initialize();

const staging = createMemoryGitStaging();
const checkout = createMemoryCheckout({ staging });
const worktree = createMemoryWorktree({ blobs: history.blobs, trees: history.trees });

const workingCopy = createMemoryWorkingCopy({ history, checkout, worktree });
const git = Git.fromWorkingCopy(workingCopy);
```

Files are staged directly into the index rather than through a worktree on disk. `addFileToStaging()` stores the blob and adds an index entry:

```typescript
const data = new TextEncoder().encode(content);
const objectId = await workingCopy.history.blobs.store([data]);

const editor = workingCopy.checkout.staging.createEditor();
editor.add({
  path,
  apply: () => ({
    path,
    mode: FileMode.REGULAR_FILE,
    objectId,
    stage: 0,
    size: data.length,
    mtime: Date.now(),
  }),
});
await editor.finish();
```

Every command is created by a `git.*()` method, configured with setters, and executed once with `.call()`.

### Step 1: a commit is made from whatever is staged

[src/steps/01-init-and-commit.ts](src/steps/01-init-and-commit.ts) stages `README.md` and `src/index.ts`, commits, then stages `src/utils.ts` and commits again.

```typescript
const commitResult = await git.commit().setMessage("Initial commit").call();
console.log(commitResult.id, commitResult.message);
```

### Step 2: branches are refs under refs/heads

[src/steps/02-branching.ts](src/steps/02-branching.ts):

```typescript
await git.branchCreate().setName("feature").call();
await git.branchCreate().setName("bugfix").call();

const branches = await git.branchList().call();
for (const branch of branches) console.log(branch.name); // "refs/heads/bugfix", ...

await git.branchDelete().setBranchNames("bugfix").setForce(true).call();
```

`branchList()` returns full ref names (`refs/heads/main`), not short names.

### Step 3: checkout moves HEAD

[src/steps/03-checkout.ts](src/steps/03-checkout.ts) reads `HEAD` with `history.refs.get("HEAD")` (a symbolic ref with a `target`) before and after each switch:

```typescript
const result = await git.checkout().setName("feature").call();
console.log(result.status); // "OK"

await git.checkout().setCreateBranch(true).setName("new-feature").call();
await git.checkout().setName("main").call();
```

### Step 4: merge fast-forwards when it can and creates a merge commit when it must

[src/steps/04-merge.ts](src/steps/04-merge.ts) builds two situations. It switches branches by pointing `HEAD` with `history.refs.setSymbolic()` and reloading the index with `staging.readTree(history.trees, commit.tree)`, then merges:

```typescript
import { MergeStrategy } from "@statewalker/vcs-commands";

// main has not moved since merge-demo branched off: fast-forward
const ffResult = await git.merge().include("merge-demo").call();
console.log(ffResult.status, ffResult.newHead); // "fast-forward"

// main and branch-a both have new commits: three-way merge
const result = await git
  .merge()
  .include("branch-a")
  .setStrategy(MergeStrategy.RECURSIVE)
  .call();
console.log(result.status); // "merged"
```

| Strategy                  | Effect                                                         |
| ------------------------- | -------------------------------------------------------------- |
| `MergeStrategy.RECURSIVE` | Three-way merge against the common ancestor (default)          |
| `MergeStrategy.RESOLVE`   | Like recursive, single merge base                              |
| `MergeStrategy.OURS`      | Records a merge commit but keeps our tree unchanged            |
| `MergeStrategy.THEIRS`    | Records a merge commit but replaces our tree with theirs       |

`MergeStatus` values include `fast-forward`, `already-up-to-date`, `merged`, `conflicting`, `failed` and `aborted`. Other merge options: `setFastForwardMode()`, `setContentMergeStrategy()`, `setSquash()`, `setCommit()`, `setMessage()`.

### Step 5: log is an async iterable; diff compares two trees

[src/steps/05-log-diff.ts](src/steps/05-log-diff.ts):

```typescript
for await (const commit of await git.log().call()) {
  console.log(commit.message.trim(), commit.author.name);
}

const lastTwo = await git.log().setMaxCount(2).call();
for await (const commit of lastTwo) console.log(commit.message.trim());

const entries = await git.diff().setOldTree(olderCommitId).setNewTree(newerCommitId).call();
for (const entry of entries) {
  console.log(`${entry.changeType}: ${entry.newPath || entry.oldPath}`);
}
```

`git.log().call()` resolves to an `AsyncIterable`, so it needs `for await`. `git.diff().call()` resolves to a plain array of `DiffEntry` (`changeType`, `oldPath`, `newPath`, `oldId`, `newId`). `changeType` is one of `ADD`, `MODIFY`, `DELETE`, `RENAME`, `COPY`. The script picks the two commit ids with `history.commits.walkAncestry(headId, { limit: 2 })`.

### Step 6: status compares the staging area with HEAD

[src/steps/06-status.ts](src/steps/06-status.ts):

```typescript
const status = await git.status().call();
console.log(status.isClean());
console.log(status.added.size, status.changed.size, status.removed.size, status.conflicting.size);
```

`added`, `changed`, `removed` and `conflicting` are `Set<string>` of paths. `git.status()` looks only at staged changes against `HEAD`; it does not scan a working directory. The script shows a clean repository, stages `new-file.ts` (status turns dirty, `added` contains it), commits, and is clean again.

### Step 7: tags are lightweight unless annotated

[src/steps/07-tag.ts](src/steps/07-tag.ts):

```typescript
await git.tag().setName("v1.0.0").call();
await git.tag().setName("v2.0.0").setAnnotated(true).setMessage("Major version 2.0.0 release").call();

for (const tag of await git.tagList().call()) console.log(tag.name, tag.objectId);

await git.tagDelete().setTags("v1.1.0-beta").call();
```

In the output, the lightweight tags point at the HEAD commit and the annotated tag points at a separate tag object, so its id differs.

### Step 8: a stash is a commit kept off the branch

[src/steps/08-stash.ts](src/steps/08-stash.ts) stages `work-in-progress.ts`, stashes it and lists the stash:

```typescript
const stashCommit = await git.stashCreate().setMessage("WIP: feature work").call(); // ObjectId | undefined

for (const stash of await git.stashList().call()) {
  console.log(`stash@{${stash.index}}: ${stash.commitId.slice(0, 7)}`);
}
```

The script only creates and lists stashes. The facade also has `git.stashApply()` (`setStashRef("stash@{0}")`) and `git.stashDrop()` (`setStashRef(0)`, a number, or `setAll(true)`). There is no `stashPop()` method; apply then drop.

### What the output looks like

Abbreviated from a real `start` run (ids differ on each run):

```
--- Step 1: Initialize and Commit ---
  Commit created: 0eebd78
  Message: "Initial commit"
  Second commit: 8a146c5

--- Step 2: Branching ---
  Branches:
    - refs/heads/bugfix
    - refs/heads/feature
    - refs/heads/main

--- Step 4: Merge ---
Merging 'merge-demo' into 'main' (fast-forward)...
  Merge status: fast-forward
Merging 'branch-a' into 'main' (three-way)...
  Merge status: merged

--- Step 5: Log and Diff ---
  - Merge commit '8658745'
    Author: Author <author@example.com>
  - Add file-main on main
    Author: Unknown <unknown@example.com>
  ...
  Comparing f84a9d7 -> d889ffd:
    ADD: file-a.ts

--- Step 8: Stash ---
  Stash created: 9a0e1c6
  Current stashes: 1
    stash@{0}: 9a0e1c6
```

## Why it is the way it is

- **One shared repository for `start`, a fresh one per `step:NN`.** `getGit()` caches the `Git` instance, so the full run builds on earlier steps. Each step begins with an "ensure we have a commit" guard that creates a minimal history when it runs alone, so every `step:NN` script also works by itself.
- **The staging area is filled directly.** The example stages content with `staging.createEditor()` instead of writing files and running `git.add()`. That keeps each step about the command it shows.
- **History, checkout and worktree are separate objects.** `History` holds immutable objects and refs; `Checkout` holds HEAD-related state and the staging area; `Worktree` is file access. `createMemoryWorkingCopy()` composes them, and `Git.fromWorkingCopy()` needs that composite.
- **Commands are single-use builders.** Calling `.call()` twice on one instance throws `Command <ClassName> has already been called`; create a new one with `git.*()` each time.

## What will surprise you

- **Commit authors are placeholders.** No step sets an author, so commits are recorded as `Unknown <unknown@example.com>` and merge commits as `Author <author@example.com>`.
- **`branchList()` and `tagList()` return full ref names** (`refs/heads/feature`, `refs/tags/v1.0.0`), while `setName()` and `setBranchNames()` take short names.
- **Iterating `git.log().call()` with plain `for ... of` fails**, because it is an async iterable.
- **The closing summary in the script output lists `git.stashPop()`**, which the facade does not have.
- **Errors are typed.** Re-creating an existing branch throws `RefAlreadyExistsError` ("Branch 'feature' already exists"), deleting a missing branch throws `RefNotFoundError` ("Branch 'x' not found"), and committing without a message throws `NoMessageError` ("Commit message is required"). Any error ends the run with `Error:` followed by the error and exit code 1.
- **Nothing persists.** All storage is in memory and gone when the process exits.

## Reference

| Script          | Runs                               |
| --------------- | ---------------------------------- |
| `start`         | `tsx src/main.ts` (all steps)      |
| `step:01`-`08`  | `tsx src/steps/NN-*.ts`            |
| `typecheck`     | `tsc --noEmit`                     |

| What | Where |
| ---- | ----- |
| `Git` facade | [packages/commands/src/git.ts](../../../packages/commands/src/git.ts) |
| Command classes | [packages/commands/src/commands/](../../../packages/commands/src/commands/) |
| `MergeStrategy`, `MergeStatus` | [packages/commands/src/results/merge-result.ts](../../../packages/commands/src/results/merge-result.ts) |
| `DiffEntry`, `ChangeType` | [packages/commands/src/results/diff-entry.ts](../../../packages/commands/src/results/diff-entry.ts) |
| Staging | [packages/working-tree/src/staging/](../../../packages/working-tree/src/staging/) |
| Memory working copy | [packages/working-tree/src/working-copy/](../../../packages/working-tree/src/working-copy/) |
| `History` | [packages/core/src/history/history.ts](../../../packages/core/src/history/history.ts) |

Previous: [01-quick-start](../01-quick-start/). Next: [03-object-model](../03-object-model/), [04-branching-merging](../04-branching-merging/).
