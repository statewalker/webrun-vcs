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
| Branches | `branchCreate()`, `branchDelete()`, `branchList()`, `branchRename()`, `branchCopy()`, `checkout()`, `switch()` |
| Tags | `tag()`, `tagDelete()`, `tagList()` |
| History | `reset()`, `merge()`, `rebase()`, `cherryPick()`, `revert()` |
| Inspection | `diff()`, `describe()` |
| Remotes | `fetch()`, `push()`, `pull()`, `clone()`, `lsRemote()`, `remoteAdd()`, `remoteRemove()`, `remoteList()`, `remoteSetUrl()` |
| Stash | `stashCreate()`, `stashApply()`, `stashDrop()`, `stashList()` |
| Maintenance | `gc()`, `packRefs()`, `fsck()`, `verifyPack()` |
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

A message is taken as git's `-m` takes it: `commit()` ends its last line and cleans it up (`whitespace` by default, or `commit.cleanup`, or `setCleanupMode(CleanupMode.STRIP | VERBATIM | ...)`), so `"Add feature"` is stored as `"Add feature\n"` and the commit gets native git's id. `merge().setMessage()` cleans up the same way; `tag().setMessage()` uses `strip` by default, as `git tag -m` does (comment lines go). A message that cleans up to nothing is refused (`Aborting commit due to empty commit message.`) unless `setAllowEmptyMessage(true)`. Several `-m` are `addMessage()` calls on `commit()`, `merge()` and `tag()`: each adds a paragraph after a blank line (`git commit -m Subject -m Body` is `commit().addMessage("Subject").addMessage("Body")`). `merge().setCommit(false)` writes `MERGE_MSG` as git does: the message given plus a newline (before any conflicts hint).

### Branches and checkout

```typescript
import { ListBranchMode } from "@statewalker/vcs-commands";

await git.branchCreate().setName("feature/login").setStartPoint("main").call();
await git.checkout().setName("feature/login").call();

// Create and switch in one step (git checkout -b; refused when the branch exists)
await git.checkout().setName("feature/new").setCreateBranch(true).call();
// git checkout -B: create, or reset an existing branch to the start point
await git.checkout().setName("feature/new").setForceCreateBranch(true).setStartPoint("main").call();

const branches = await git.branchList().setListMode(ListBranchMode.ALL).call();
for (const ref of branches) console.log(ref.name); // "refs/heads/main", ...

await git.branchDelete().setBranchNames("feature/old").call();
await git.branchDelete().setBranchNames("feature/abandoned").setForce(true).call();

// git branch -c: the copy gets the branch's reflog and its branch.<name>.* configuration
await git.branchCopy().setOldName("feature/login").setNewName("feature/login-2").call();

// git switch: branches only; -c/-C, --detach, --orphan, - (the branch before)
await git.switch().setName("main").call();
await git.switch().setName("-").call();
await git.switch().setCreateBranch("topic").setStartPoint("origin/topic").call(); // tracks it
await git.switch().setName("dev").call(); // only origin/dev exists: creates dev tracking it
await git.switch().setDetach(true).setName("v1.0.0").call();
await git.checkout().setDetach(true).call(); // git checkout --detach
// git switch -m: local changes carried over (git 2.55+'s autostash; conflicts labelled
// "feature" / "local", the changes kept as stash@{0} when they conflict)
await git.switch().setName("feature").setMerge(true).call();
```

`checkout()` returns a `CheckoutResult` with `status` (`CheckoutStatus.OK`, `CONFLICTS`, ...), `updated`, `removed` and `conflicts`. Use `addPath()` to restore single files and `setForced(true)` to discard local changes. A new branch tracks a remote-tracking start point as `branch.autoSetupMerge` says (`setTrack(TrackMode.DIRECT | INHERIT | NONE)` for `--track`, `--track=inherit`, `--no-track`). `switch()` refuses what is not a branch with git's message (`fatal: a branch is expected, got tag 'v1.0.0'` and its hint), and refuses while a merge, rebase, cherry-pick or revert is in progress. `setMerge(true)` (`-m`, on `checkout()` too) carries local changes over as git 2.55+ does: when the switch would lose them they are stashed, the switch made, and the stash applied with the labels `<target>` and `local`; a clean apply gives `OK` with the message `Applied autostash.`, a conflicting one gives `CONFLICTS` with `ref` set (the switch was made), the conflicts in the index and worktree and the changes kept as `stash@{0}`.

### Revisions

Every command that takes a revision (`checkout`, `switch`, `reset`, `merge`, `rebase`, `branchCreate`, `diff`, `cherryPick`, `revert`, ...) reads it as git's `get_oid` does, and `revParse()` resolves one as `git rev-parse --verify`:

```typescript
await git.revParse().setRevision("@{u}").call();             // the upstream (branch.<b>.remote/.merge)
await git.revParse().setRevision("feature@{push}").call();   // where push would go (push.default, pushRemote)
await git.revParse().setRevision("HEAD@{2}").call();         // HEAD two moves ago
await git.revParse().setRevision("main@{yesterday}").call(); // main a day ago (git's approxidate)
await git.revParse().setRevision(":/fix typo").call();       // youngest commit whose message matches
await git.revParse().setRevision("v1.0^{tree}").call();      // peeling: ^{commit|tree|blob|tag|object|}
await git.revParse().setRevision("HEAD~2:src/a.ts").call();  // a path in a tree; ":2:a.ts" an index stage
```

Ref names follow git's dwim rules; `@` is HEAD, `@{-N}` the branch left N switches ago, `<ref>@{<n>}` the reflog's nth entry, `<ref>@{<date>}` the ref at that time, `<rev>^{/<regex>}` and `:/<regex>` search commit messages with POSIX extended regexes (`!-` negates). Where git dies, `RevisionError` carries its line (`fatal: no upstream configured for branch 'x'`, `fatal: HEAD does not point to a branch`, `fatal: log for 'main' only has 2 entries`); `revParse()` also returns git's warnings (`warning: log for 'main' only goes back to ...`). Abbreviated ids and `describe` names are not read.

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

### Diff and blame output as git prints it

```typescript
// git diff (the index against the worktree), git diff --cached --stat, git diff A B -w -U1
const patch = await git.diff().callText();
const stat = await git.diff().setCached(true).callText("stat");
const ws = await git.diff().setOldTree(a).setNewTree(b)
  .setOptions({ ignoreWhitespace: true, context: 1 }).callText();

// git blame --porcelain, and the default output
const blame = await git.blame().setFilePath("src/main.ts").call();
process.stdout.write(formatBlamePorcelain(blame));
process.stdout.write(formatBlame(blame));
```

`callText()` prints the patch, `--stat`, `--numstat`, `--shortstat`, `--name-only` or `--name-status` byte for byte as `git diff` does: `diff --git` headers with mode, rename and `index` lines, quoted paths, "Binary files ... differ", hunks from git's xdiff with function lines (default and `diff=<driver>` builtin patterns), renames (`diff.renames`), and the configuration `git diff` reads (`diff.algorithm`, `diff.indentHeuristic`, `diff.context`, `core.quotePath`, ...). Without trees it compares the index with the worktree (`git diff`); with only an old tree, that tree with the worktree. `formatNoIndexDiff` prints `git diff --no-index` for two files. `call()` still returns the changed paths, with renames only on `setRenames(true)`.

A conflicted path is shown as `git diff` shows it: the combined diff of "ours" and "theirs" against the worktree file (`diff --cc`) in the patch, an unmerged entry and stage 2 against the worktree in the other formats, and the plain worktree file against a tree (`git diff A`). A submodule with tracked changes inside reads `Subproject commit <id>-dirty`. Ids are abbreviated as git abbreviates them (`core.abbrev`, the number of packed objects, and lengthened while another object shares the prefix). A revision that names nothing throws, as git refuses it.

`blame()` runs git's blame algorithm: commits newest first, lines passed to the parents through the same xdiff diff, whole-file renames followed (`setFollowRenames(false)` is `--no-follow`), root commits as boundaries unless `setShowRoot(true)`, `-w` and `-L` ranges. `-M`/`-C`, `--reverse` and ignored revisions are not supported. For git's id width in the default output, pass `formatBlame(blame, { autoAbbrev: await blame.autoAbbrev?.() })`.

Remaining differences from `git diff`: `diff.noprefix`, `diff.mnemonicPrefix`, `diff.orderFile`, textconv drivers and `submodule.<name>.ignore` are not read.

### Big and binary files in diff, merge and blame

```typescript
import { DiffFormatter } from "@statewalker/vcs-commands";

const formatter = new DiffFormatter(history.blobs, { bigFileThreshold: 10 * 2 ** 20 });
const diff = await formatter.format(entry);
console.log(formatter.toString(diff)); // "Binary files a/video.mp4 and b/video.mp4 differ"

await git.merge().include("feature").setContentMergeStrategy(ContentMergeStrategy.UNION).setBigFileThreshold(10 * 2 ** 20).call();
await git.blame().setFilePath("data.csv").setBigFileThreshold(10 * 2 ** 20).call();
```

Diff, merge and blame read sizes from object headers first and never load a file above `bigFileThreshold` (50 MiB by default, git's `core.bigFileThreshold`). They check whether a file is binary as git does, from a NUL byte in its first 8000 bytes, and read only that prefix (`probeBlob` from `@statewalker/vcs-core`). Text under the threshold is still loaded whole, because the diff algorithms need it, by the same single read that checked it (`probeBlob(..., { loadText: true })`).

- `DiffFormatter` shows a big or binary file as `Binary files a/<path> and b/<path> differ` and loads neither side. `oldContent` and `newContent` are set for text files only.
- `merge()` never content-merges a big or binary file. With `ContentMergeStrategy.OURS` or `THEIRS` it takes that side's file whole, as `git merge -X ours` does; with `UNION`, or without a content strategy, the path is a conflict.
- `blame()` rejects for a file above the threshold. A parent version above it is not compared, so the lines stay with the child commit, and it is never a rename candidate.

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

### Checking a repository: fsck and verify-pack

```typescript
const result = await git.fsck().setRepositoryFiles({ files }).setUnreachable(true).call();
process.stdout.write(result.output); // "dangling commit 1234…", "missing blob 5678…"
process.stderr.write(result.errorOutput); // "error in tree 9abc…: duplicateEntries: …"
process.exitCode = result.exitCode; // git's bits: 1 objects, 2 reachability, 4 packs, 8 refs

const packs = await git.verifyPack().setRepositoryFiles({ files })
  .addPack(".git/objects/pack/pack-1234….idx").setVerbose(true).call();
```

`fsck()` prints what `git fsck` prints, in git's order: the object checks use git's message ids and severities (`fsck.<msg-id>` config, `setStrict`), and `missing`, `dangling` and `unreachable` objects come out in the order of git's object hash table. With `setRepositoryFiles` it also reads loose objects from their files and verifies packs (checksums, CRC-32s, hashes); without it, it checks the objects of `history.objects` (memory, KV and SQL stores). By default it reproduces `git fsck --no-references` of git 2.45 and later (HEAD's own checks moved to `git refs verify`, which is not implemented); `setCompatibility("2.43")` reproduces git 2.43, HEAD checks included.

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

`resolveRef()` tries, in order: the name as given (`refs/heads/main`, `HEAD`), `refs/heads/<name>`, `refs/tags/<name>`, `refs/remotes/<name>`, `refs/remotes/<name>/HEAD`, then a full commit id. A leading `@{-N}` is the branch (or detached commit) the Nth most recent `checkout: moving from` line of HEAD's reflog left, as git's `interpret_nth_prior_checkout` reads it (`@{-1}~1` works too). Names containing `~` or `^` are walked through parents (`HEAD~2`, `HEAD^2`). Annotated tags are peeled to commits. Abbreviated commit ids are not resolved; they fail with `Ref not found: <name>`.

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

- `status()` reads as `git status` does: HEAD against the index, the worktree against the index (`modified`, `missing`, `untracked`), renames (`renamed`, as `status.renames=true`; `setRenames(false)` is `--no-renames`) and the content of populated submodules (`setIgnoreSubmodules()`). `formatStatusPorcelain(status, 1 | 2)` prints `--porcelain[=v2] --untracked-files=all`. Copies (`status.renames=copies`) are detected as renames only.
- `stashCreate()` on a working copy with an index and a worktree uses a built-in provider; `setWorkingTreeProvider(provider)` replaces it.
- `merge()` with several heads (`include("a").include("b")`) is an octopus, as git's octopus strategy; with several merge bases it builds git's virtual merge base. Merge drivers named by the `merge` attribute are callbacks registered with `installMergeDrivers(workingCopy, { name: createMergeDriver(fn) })`: git's `merge.<driver>.driver` shell command is not run.
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
