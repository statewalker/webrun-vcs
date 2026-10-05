# @statewalker/vcs-commands

High-level Git commands (add, commit, checkout, merge, rebase, stash, fetch, push, clone, ...) over a `WorkingCopy`. A `Git` facade wraps a `WorkingCopy` from `@statewalker/vcs-working-tree` and creates command objects. You configure a command with chainable setters and run it once with `call()`.

## Why a command layer sits on top of the working copy

`@statewalker/vcs-core` and `@statewalker/vcs-working-tree` give you objects, refs, an index and a worktree. A Git operation such as "commit" or "merge" touches all of them in a fixed order: resolve HEAD, write a tree from the index, store a commit, move a branch, update the index and the files. This package holds those multi-step workflows so applications do not re-implement them.

Commands talk only to the `WorkingCopy` interfaces (history, checkout/staging, worktree). The same command code runs over memory, file, or SQL storage, in the browser, Node or a worker. The API copies JGit's command pattern, so names and option sets map to Git and JGit concepts you already know.

## How to use it: build a `WorkingCopy`, wrap it in `Git`

```bash
pnpm add @statewalker/vcs-commands
```

No peer dependencies.

| Entry point | Contents |
|-------------|----------|
| `@statewalker/vcs-commands` | Everything below, plus `Git`, `GitCommand`, `TransportCommand`, `ResetMode`, `ListBranchMode`, and re-exported types (`WorkingCopy`, `History`, `Checkout`, `Staging`, `Worktree`, `Blobs`, `Trees`, `Commits`, `Refs`, `Tags`) |
| `@statewalker/vcs-commands/commands` | Command classes (`AddCommand`, `CommitCommand`, `MergeCommand`, ..., `InitCommand`) and their enums (`CheckoutStatus`, `RebaseOperation`, `TagOption`, `RevFilter`, ...) |
| `@statewalker/vcs-commands/errors` | Error classes, all extending `GitApiError` |
| `@statewalker/vcs-commands/results` | Result types, status enums and helpers (`MergeStatus`, `PushStatus`, `isMergeSuccessful`, `isPushSuccessful`, ...) |

An in-memory repository:

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
await history.refs.setSymbolic("HEAD", "refs/heads/main");

const staging = createMemoryGitStaging();
const checkout = createMemoryCheckout({ staging });
const worktree = createMemoryWorktree({ blobs: history.blobs, trees: history.trees });
const workingCopy = createMemoryWorkingCopy({ history, checkout, worktree });

const git = Git.fromWorkingCopy(workingCopy);

await worktree.writeContent("README.md", new TextEncoder().encode("# Hello\n"));
await git.add().addFilepattern(".").call();
const commit = await git.commit().setMessage("Initial commit").call();
console.log(commit.id);

console.log("Clean:", (await git.status().call()).isClean());

git.close(); // or `using git = ...`: Git implements Disposable
```

For a Git-compatible on-disk repository, build the `WorkingCopy` from the file-backed classes in `@statewalker/vcs-store-files` (for example `GitWorkingCopy`).

`Git` methods:

| Area | Methods |
|------|---------|
| Staging | `add()`, `rm()`, `status()`, `clean()` |
| Commits | `commit()`, `log()`, `reflog()`, `blame()` |
| Branches | `branchCreate()`, `branchDelete()`, `branchList()`, `branchRename()`, `checkout()` |
| Tags | `tag()`, `tagDelete()`, `tagList()` |
| History | `reset()`, `merge()`, `rebase()`, `cherryPick()`, `revert()` |
| Inspection | `diff()`, `describe()` |
| Remotes | `fetch()`, `push()`, `pull()`, `clone()`, `lsRemote()`, `remoteAdd()`, `remoteRemove()`, `remoteList()`, `remoteSetUrl()` |
| Stash | `stashCreate()`, `stashApply()`, `stashDrop()`, `stashList()` |
| Maintenance | `gc()`, `packRefs()` |
| Static | `Git.fromWorkingCopy(wc)`, `Git.init()` |
| Components | `workingCopy`, `history`, `checkoutState`, `worktree` |

## Examples

### Staging and committing

```typescript
await git.add().addFilepattern("src/").addFilepattern("package.json").call();

// Stage modifications and deletions of tracked files only (git add -u)
await git.add().addFilepattern(".").setUpdate(true).call();

const commit = await git
  .commit()
  .setMessage("Add feature")
  .setAuthor("Developer", "dev@example.com")
  .call(); // CommitResult: the Commit fields plus `id`

await git.commit().setMessage("Add feature (fixed)").setAmend(true).call();
```

### Branches and checkout

```typescript
import { ListBranchMode } from "@statewalker/vcs-commands";

await git.branchCreate().setName("feature/login").setStartPoint("main").call();
await git.checkout().setName("feature/login").call();

// Create and switch in one step (git checkout -b)
await git.checkout().setName("feature/new").setCreateBranch(true).call();

const branches = await git.branchList().setListMode(ListBranchMode.ALL).call();
for (const ref of branches) console.log(ref.name); // "refs/heads/main", ...

await git.branchDelete().setBranchNames("feature/old").call();
await git.branchDelete().setBranchNames("feature/abandoned").setForce(true).call();
```

`checkout()` returns a `CheckoutResult` with `status` (`CheckoutStatus.OK`, `CONFLICTS`, ...), `updated`, `removed` and `conflicts`. Use `addPath()` to restore single files and `setForced(true)` to discard local changes.

### Log and reset

```typescript
import { ResetMode } from "@statewalker/vcs-commands";

for await (const entry of await git.log().setMaxCount(10).call()) {
  console.log(entry.id.slice(0, 7), entry.message.split("\n")[0]);
}
// More filters: addPath(), setSkip(), setSince(), setUntil(),
// setAuthorFilter(), setCommitterFilter(), setFirstParent(), addRange()

await git.reset().setRef("HEAD~1").setMode(ResetMode.MIXED).call();
await git.reset().setRef("main").setMode(ResetMode.HARD).call();
```

### Merge, rebase, cherry-pick, revert

```typescript
import { RebaseOperation } from "@statewalker/vcs-commands";
import { FastForwardMode, MergeStatus } from "@statewalker/vcs-commands/results";

const result = await git.merge().include("feature/login").call();
if (result.status === MergeStatus.CONFLICTING) {
  console.log("Conflicts in:", result.conflicts);
}

await git
  .merge()
  .include("feature/login")
  .setFastForwardMode(FastForwardMode.NO_FF)
  .setMessage("Merge feature/login")
  .call();

// setUpstream() takes a commit id; setUpstreamBranch() resolves a name and is async
const rebase = await (await git.rebase().setUpstreamBranch("main")).call();
await git.rebase().setOperation(RebaseOperation.CONTINUE).call();
await git.rebase().setOperation(RebaseOperation.ABORT).call();

await git.cherryPick().include(commitId).call();
await git.revert().include(commitId).setNoCommit(true).call();
```

### Remotes

```typescript
import { isPushSuccessful } from "@statewalker/vcs-commands/results";

await git.remoteAdd().setName("origin").setUri("https://github.com/user/repo.git").call();

const fetched = await git
  .fetch()
  .setRemote("origin")
  .setCredentials({ username: "user", password: "token" })
  .call();
console.log(fetched.trackingRefUpdates.length, "refs updated");

const pushed = await git.push().setRemote("origin").add("refs/heads/main").call();
if (!isPushSuccessful(pushed)) console.log(pushed.messages);

await git.pull().setRemote("origin").setRemoteBranchName("main").call();
```

`setRemote()` takes a configured remote name or a URL. Clone writes into the `WorkingCopy` that the `Git` instance wraps, so start from an empty one:

```typescript
const cloned = await Git.fromWorkingCopy(emptyWorkingCopy)
  .clone()
  .setURI("https://github.com/user/repo.git")
  .setCredentials({ token: "github_pat_xxx" })
  .setProgressMonitor((p) => console.log(p.stage, p.current, p.total))
  .call();
console.log(cloned.defaultBranch, cloned.headCommit);
```

All transport commands share `setCredentials({ username?, password?, token? })`, `setCredentialsProvider(username, password)`, `setHeaders()`, `setTimeout(ms)`, `setProgressMonitor(cb)` and `setProgressMessageCallback(cb)`.

### Stash

```typescript
const stashId = await git.stashCreate().setMessage("WIP").call(); // ObjectId | undefined

for (const entry of await git.stashList().call()) {
  console.log(`stash@{${entry.index}}: ${entry.message}`);
}

await git.stashApply().setStashRef("stash@{0}").call(); // StashApplyResult
await git.stashDrop().setStashRef(0).call(); // a 0-based index, not a ref string
await git.stashDrop().setAll(true).call();
```

There is no `stashPop()`: call `stashApply()`, then `stashDrop()`.

### Tags

```typescript
await git
  .tag()
  .setName("v1.0.0")
  .setMessage("Release 1.0.0")
  .setTagger("Developer", "dev@example.com")
  .call();
await git.tag().setName("v0.9.0").setObjectId(commitId).call();

const tags = await git.tagList().call(); // Ref[]
await git.tagDelete().setTags("v0.9.0").call();
```

### Errors

```typescript
import { RefNotFoundError } from "@statewalker/vcs-commands/errors";

try {
  await git.checkout().setName("nonexistent").call();
} catch (error) {
  if (error instanceof RefNotFoundError) console.log(error.message); // "Ref not found: nonexistent"
}
```

| Area | Errors |
|------|--------|
| Command | `MissingArgumentError`, `InvalidArgumentError`, `IncompatibleOptionsError`, `NotImplementedError`, `StoreNotAvailableError` |
| Refs | `RefNotFoundError`, `RefAlreadyExistsError`, `InvalidRefNameError`, `CannotDeleteCurrentBranchError`, `DetachedHeadError`, `NoHeadError`, `NotMergedError` |
| Add / checkout | `NoFilepatternError`, `PathNotInIndexError`, `PathNotFoundInTreeError`, `NotADirectoryError` |
| Commit | `NoMessageError`, `EmptyCommitError`, `UnmergedPathsError` |
| Merge | `MergeConflictError`, `InvalidMergeHeadsError`, `NotFastForwardError`, `MultipleParentsNotAllowedError`, `NoMergeBaseError`, `InvalidMainlineParentError` |
| Rebase | `NoRebaseInProgressError`, `UpstreamRequiredError`, `CommitNotFoundError` |
| Remotes / transport | `RemoteAlreadyExistsError`, `RemoteNotFoundError`, `InvalidRemoteError`, `TransportError`, `AuthenticationError`, `PushRejectedException`, `NonFastForwardError` |
| Stash / tag | `InvalidStashIndexError`, `StashNotFoundError`, `StashApplyFailedError`, `InvalidTagNameError` |

## Internals

### How a command runs

```
Git.fromWorkingCopy(wc)
   |
   +-- git.commit()            new CommitCommand(wc)
         .setMessage(...)      setters only record options
         .call()               checks "callable", then:
             wc.checkout.staging  -> writeTree()
             wc.history.commits   -> store()
             wc.history.refs      -> set(branch)
```

Every command extends `GitCommand<T>`. Remote commands extend `TransportCommand<T>`, which adds credentials, headers, timeout and progress callbacks. `Git` holds no state besides the `WorkingCopy` and a closed flag.

### Why commands are single-use

A command records options in fields and `call()` acts on them. Running it twice would reuse half-consumed state (a resolved upstream, a parsed refspec list), so `call()` marks it spent. A second call throws `Command CommitCommand has already been called`. After `git.close()`, every factory method throws `Git instance is closed`. Closing `Git` does not close the underlying stores.

### How refs are resolved

`resolveRef()` tries, in order: the name as given (`refs/heads/main`, `HEAD`), `refs/heads/<name>`, `refs/tags/<name>`, then a full commit id. Names containing `~` or `^` are walked through parents (`HEAD~2`, `HEAD^2`). Annotated tags are peeled to commits. Abbreviated commit ids are not resolved; they fail with `Ref not found: <name>`.

### Remote commands use smart HTTP only

`fetch`, `push`, `pull`, `clone` and `lsRemote` call the Git smart HTTP client in `@statewalker/vcs-transport`, which uses the global `fetch`. Received packs are imported into `workingCopy.history`. Remotes are stored as `[remote "<name>"]` entries in `WorkingCopy.config` (`.git/config` for a file-backed working copy), so `remoteAdd()` must run on the same `WorkingCopy` before `setRemote("origin")` can resolve. A name that is not configured is passed to the transport as if it were a URL, so a typo shows up as a network error, not as `Invalid remote: <name>`.

### What breaks, and how it looks

- `push().call()` does not throw on rejection. Check `isPushSuccessful(result)` or each `remoteUpdates[i].status`. `push().callOrThrow()` throws `NonFastForwardError` or `PushRejectedException` instead.
- Merge conflicts are not thrown: `merge()` returns `status: MergeStatus.CONFLICTING` with `conflicts`. Only some merges throw, for example `Cannot fast-forward merge; branches have diverged` with `FastForwardMode.FF_ONLY`, or `No merge base found`.
- A `WorkingCopy` without history or staging fails at first use with `WorkingCopy.history is required for commands` or `WorkingCopy.checkout.staging is required for commands`.
- Writing files with no worktree fails with `Worktree not available for file writes`.
- Commands that need a commit in an empty repository fail with `HEAD cannot be resolved` (`NoHeadError`).
- `commit()` without a message fails with `Commit message is required`; with unresolved conflicts, `Cannot commit with unresolved conflicts`.

### Constraints

- `status()` compares HEAD with the index only (`added`, `changed`, `removed`, `conflicting`). It does not look at the worktree. For a working-tree status use `createStatusCalculator` from `@statewalker/vcs-working-tree`.
- `stashCreate()` captures the working state only through `setWorkingTreeProvider(provider)`. Without a provider it stores a stash whose trees are the HEAD tree, even when nothing changed. The package ships no provider implementation.
- `merge()` supports a single merge head (`Only single-head merges are currently supported`).
- `fetch()` passes only `setProgressMessageCallback()` to the transport; `setProgressMonitor()` has effect on `clone()` only.
- `Git.init()` (an `InitCommand`) always creates an in-memory history. `setFilesApi()` only backs the worktree when `setWorktree(true)` is set. Its `InitResult` has `git`, `workingCopy`, `repository`, `initialBranch`, `bare` and `gitDir`.
- `stashDrop().setStashRef(n)` takes an index; without reflog support only index 0 is valid.

### Dependencies and why

- `@statewalker/vcs-core`: object stores, refs, commit/tree serialization.
- `@statewalker/vcs-working-tree`: `WorkingCopy`, `Checkout`, `Staging`, `Worktree` interfaces and memory implementations.
- `@statewalker/vcs-transport`: smart HTTP fetch, push, clone, ls-remote.
- `@statewalker/vcs-store-files`, `@statewalker/vcs-store-mem`: used by `InitCommand` to build a default worktree and staging.
- `@statewalker/vcs-utils`: hashing and byte helpers.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the class hierarchy and extension points.

## License

MIT
