# @statewalker/vcs-commands Architecture

This document explains the internal architecture of the commands package, covering the command pattern implementation, class hierarchy, and integration with core stores and transport.

## Design Philosophy

### JGit-Inspired Command Pattern

The package mirrors Eclipse JGit's approach to Git operations. Each operation becomes a command object that you configure before execution. This pattern provides:

- **Discoverability**: IDE autocomplete reveals available options
- **Type safety**: Invalid configurations fail at compile time
- **Single-use semantics**: Commands can't be accidentally reused
- **Testability**: Commands can be inspected before execution

### Fluent Builder API

Commands use method chaining for configuration:

```typescript
await git.commit()
  .setMessage("feat: add login")
  .setAuthor("Dev", "dev@example.com")
  .setAmend(true)
  .call();
```

Each setter returns `this`, enabling fluent chains. The final `call()` executes the operation and returns the result.

### WorkingCopy Abstraction

Commands work with the `WorkingCopy` interface from `@statewalker/vcs-working-tree`, which provides unified access to repository components:

```typescript
interface WorkingCopy {
  readonly history: History;     // blobs, trees, commits, refs, tags
  readonly checkout: Checkout;   // HEAD, staging (index), operation state
  readonly worktree: Worktree;   // filesystem access
  readonly stash: StashStore;
  readonly config: WorkingCopyConfig;
  // ... HEAD and state methods
}
```

This abstraction enables commands to work identically across filesystem, SQL, memory, or cloud storage backends.

## Class Hierarchy

```
GitCommand<T> (abstract base)
├── Local Commands
│   ├── AddCommand
│   ├── CommitCommand
│   ├── StatusCommand
│   ├── CheckoutCommand
│   ├── CreateBranchCommand
│   ├── DeleteBranchCommand
│   ├── ListBranchCommand
│   ├── MergeCommand
│   ├── RebaseCommand
│   ├── ResetCommand
│   ├── CherryPickCommand
│   ├── RevertCommand
│   ├── LogCommand
│   ├── DiffCommand
│   ├── TagCommand
│   ├── DeleteTagCommand
│   ├── ListTagCommand
│   ├── StashCreateCommand
│   ├── StashApplyCommand
│   ├── StashDropCommand
│   ├── StashListCommand
│   ├── BlameCommand, CleanCommand, DescribeCommand, ReflogCommand
│   ├── GarbageCollectCommand, PackRefsCommand
│   ├── RemoteAddCommand, RemoteRemoveCommand, RemoteListCommand, RemoteSetUrlCommand
│   └── ...
└── TransportCommand<T> (extends GitCommand)
    ├── FetchCommand
    ├── PushCommand
    ├── PullCommand
    ├── CloneCommand
    └── LsRemoteCommand

InitCommand (standalone: creates a new repository, no WorkingCopy needed)
```

### GitCommand Base Class

All commands extend `GitCommand<T>` where `T` is the return type:

```typescript
abstract class GitCommand<T> {
  protected readonly _workingCopy: WorkingCopy;
  private callable = true;

  constructor(workingCopy: WorkingCopy) { ... }

  // Each command implements call(); it starts with
  //   this.checkCallable(); this.setCallable(false);
  abstract call(): Promise<T>;

  protected checkCallable(): void {
    if (!this.callable) {
      throw new Error(`Command ${this.constructor.name} has already been called`);
    }
  }
  protected setCallable(value: boolean): void { ... }
}
```

The base class provides common utilities:

| Member | Purpose |
|--------|---------|
| `blobs`, `trees`, `commits`, `tagsStore`, `refsStore` | Stores from `workingCopy.history` |
| `staging` | `workingCopy.checkout.staging` |
| `worktreeAccess` | `workingCopy.worktree` (may be undefined) |
| `resolveHead()` | Get commit ID that HEAD points to (`NoHeadError` if none) |
| `resolveRef(name)` | Resolve any ref to ObjectId (`RefNotFoundError` if none) |
| `getCurrentBranch()` | Full name of the current branch, or undefined when detached |

### Ref Resolution

The base class handles Git's flexible ref syntax:

```typescript
// Direct refs
"refs/heads/main" → refs.get("refs/heads/main")

// Short names
"main" → refs.get("refs/heads/main")
"v1.0.0" → refs.get("refs/tags/v1.0.0")

// Relative refs
"HEAD~1" → parent of HEAD
"HEAD~3" → 3rd ancestor of HEAD
"HEAD^2" → second parent (for merge commits)

// Full commit IDs (abbreviated IDs are not resolved)
"<40-hex id>" → commits.has(id)
```

Annotated tags are peeled to the commit they point at.

### TransportCommand Extension

Remote operations extend `TransportCommand<T>` which adds:

```typescript
abstract class TransportCommand<T> extends GitCommand<T> {
  protected credentials?: Credentials;
  protected headers?: Record<string, string>;
  protected timeout?: number;
  protected progressCallback?: ProgressCallback;
  protected progressMessageCallback?: (message: string) => void;

  setCredentials(credentials: Credentials): this { ... }
  setCredentialsProvider(username: string, password: string): this { ... }
  setHeaders(headers: Record<string, string>): this { ... }
  setTimeout(timeout: number): this { ... }
  setProgressMonitor(callback: ProgressCallback): this { ... }
  setProgressMessageCallback(callback: (message: string) => void): this { ... }
}
```

## Directory Structure

```
packages/commands/src/
├── index.ts              # Main exports
├── git.ts                # Git facade class
├── git-command.ts        # Base command class
├── transport-command.ts  # Transport command base
├── types.ts              # ResetMode, ListBranchMode, re-exported core types
├── commands/             # Command implementations
│   ├── index.ts          # Re-exports all commands
│   ├── add-command.ts
│   ├── commit-command.ts
│   ├── checkout-command.ts
│   ├── merge-command.ts
│   ├── fetch-command.ts
│   ├── push-command.ts
│   └── ... (31 command modules)
├── core-commands/        # Add/Checkout interfaces + impls (not exported)
├── pack-import/          # Import received packs into History
├── remote-config/        # [remote "<name>"] config read/write (internal)
├── rename/               # Similarity index for rename detection
├── tree-merge/           # Shared three-way tree merge
├── errors/               # Error types
│   ├── index.ts
│   ├── git-api-error.ts
│   ├── command-errors.ts
│   ├── ref-errors.ts
│   ├── merge-errors.ts
│   └── ... (12 modules)
└── results/              # Result types
    ├── index.ts
    ├── merge-result.ts
    ├── fetch-result.ts
    ├── push-result.ts
    └── ... (13 modules)
```

### commands/

Each command lives in its own file following the pattern `<name>-command.ts`:

| File | Command | Purpose |
|------|---------|---------|
| `add-command.ts` | AddCommand | Stage files for commit |
| `commit-command.ts` | CommitCommand | Create commits |
| `checkout-command.ts` | CheckoutCommand | Switch branches/restore files |
| `merge-command.ts` | MergeCommand | Merge branches |
| `rebase-command.ts` | RebaseCommand | Rebase commits |
| `reset-command.ts` | ResetCommand | Reset HEAD position |
| `fetch-command.ts` | FetchCommand | Fetch from remote |
| `push-command.ts` | PushCommand | Push to remote |
| `pull-command.ts` | PullCommand | Fetch and merge/rebase |
| `clone-command.ts` | CloneCommand | Clone repository |

### errors/

Error types organized by domain:

| Module | Errors |
|--------|--------|
| `git-api-error.ts` | `GitApiError` base class |
| `command-errors.ts` | `MissingArgumentError`, `InvalidArgumentError`, `NotImplementedError` |
| `ref-errors.ts` | `RefNotFoundError`, `RefAlreadyExistsError` |
| `commit-errors.ts` | `NoMessageError`, `EmptyCommitError` |
| `merge-errors.ts` | `MergeConflictError`, `NotFastForwardError` |
| `checkout-errors.ts` | `PathNotInIndexError`, `PathNotFoundInTreeError`, `NotADirectoryError` |
| `rebase-errors.ts` | `NoRebaseInProgressError` |
| `stash-errors.ts` | `InvalidStashIndexError`, `StashNotFoundError`, `StashApplyFailedError` |
| `transport-errors.ts` | `AuthenticationError`, `PushRejectedException` |

### results/

Result types with status enums:

| Module | Types |
|--------|-------|
| `merge-result.ts` | `MergeResult`, `MergeStatus`, `FastForwardMode` |
| `fetch-result.ts` | `FetchResult`, tracking ref updates |
| `push-result.ts` | `PushResult`, `PushStatus`, remote updates |
| `rebase-result.ts` | `RebaseResult`, `RebaseStatus` |
| `cherry-pick-result.ts` | `CherryPickResult` |
| `clone-result.ts` | `CloneResult` |
| `stash-result.ts` | `StashEntry`, `StashApplyResult`, `StashApplyStatus` |
| `diff-entry.ts` | `DiffEntry`, file change info |

## Git Facade Class

The `Git` class acts as the entry point and command factory:

```typescript
class Git implements Disposable {
  private readonly _workingCopy: WorkingCopy;

  // Factory methods
  static fromWorkingCopy(workingCopy: WorkingCopy): Git { ... }
  static init(): InitCommand { ... }

  // Command factories (~40)
  add(): AddCommand { return new AddCommand(this._workingCopy); }
  commit(): CommitCommand { return new CommitCommand(this._workingCopy); }
  checkout(): CheckoutCommand { return new CheckoutCommand(this._workingCopy); }
  // ...

  // Component access
  get workingCopy(): WorkingCopy { ... }
  get history(): History | undefined { ... }
  get checkoutState(): Checkout | undefined { ... }
  get worktree(): Worktree | undefined { ... }

  // Lifecycle: after close(), factory methods throw "Git instance is closed"
  close(): void { ... }
  [Symbol.dispose](): void { this.close(); }
}
```

### Factory Pattern Benefits

Creating commands through the facade:

1. **Consistent initialization**: Commands always get the right store
2. **Discoverable API**: Autocomplete shows all available operations
3. **Future flexibility**: Can add command caching, logging, or interception
4. **Type safety**: Factory methods have correct return types

## Command Implementation Patterns

### Configuration Validation

Commands validate configuration in `call()` before execution:

```typescript
class CommitCommand extends GitCommand<CommitResult> {
  private message?: string;
  private amend = false;

  async call(): Promise<CommitResult> {
    this.checkCallable();
    this.setCallable(false);
    if (!this.message && !this.amend) {
      throw new NoMessageError(); // "Commit message is required"
    }
    // ... rest of implementation
  }
}
```

### Multi-Step Workflows

Complex operations compose multiple store operations:

```typescript
class CommitCommand extends GitCommand<CommitResult> {
  async call(): Promise<CommitResult> {
    // 1. Resolve current HEAD
    const headRef = await this.refsStore.resolve("HEAD");
    const parentId = headRef?.objectId;

    // 2. Build tree from staging
    const treeId = await this.staging.writeTree(this.trees);

    // 3. Create commit object
    const commit: Commit = {
      tree: treeId,
      parents: parentId ? [parentId] : [],
      author: this.author,
      committer: this.committer,
      message: this.message,
    };
    const id = await this.commits.store(commit);

    // 4. Update the branch HEAD points to (or HEAD itself when detached)
    await this.refsStore.set(currentBranchOrHead, id);

    return { ...commit, id };
  }
}
```

### Progress Reporting

Transport commands pass their callbacks to the `@statewalker/vcs-transport` operations:

```typescript
class FetchCommand extends TransportCommand<FetchResult> {
  async call(): Promise<FetchResult> {
    // ...
    const transportResult = await transportFetch({
      url: remoteUrl,
      auth: this.credentials,
      headers: this.headers,
      timeout: this.timeout,
      depth: this.depth,
      onProgressMessage: this.progressMessageCallback,
    });
    // ... map refs through refspecs, import the pack into history
  }
}
```

`CloneCommand` also passes `onProgress: this.progressCallback` (structured `ProgressInfo`: `stage`, `current`, `total`, `percent`). `FetchCommand` and `PushCommand` pass only the raw message callback.

### Result Objects

Commands return structured results, not just success/failure:

```typescript
interface MergeResult {
  readonly status: MergeStatus;
  readonly newHead?: ObjectId;
  readonly mergeBase?: ObjectId;
  readonly mergedCommits: ObjectId[];
  readonly conflicts?: string[];
  readonly failingPaths?: Map<string, MergeFailureReason>;
  readonly message?: string;
}

// Usage
const result = await git.merge().include("feature").call();
if (result.status === MergeStatus.CONFLICTING) {
  for (const path of result.conflicts!) {
    console.log(`Conflict: ${path}`);
  }
}
```

## Integration Points

### Core Store Integration

Commands depend on the interfaces from `@statewalker/vcs-core` (history) and `@statewalker/vcs-working-tree` (staging, worktree):

```
AddCommand
    ↓ uses
Staging.createEditor()    → Stage file changes
Blobs.store()             → Store file contents
Worktree.walk()           → Read filesystem
WorktreeEntry.isIgnored   → Skip ignored files
```

```
CommitCommand
    ↓ uses
Staging.writeTree()       → Build tree from index
Commits.store()           → Store commit object
Refs.set()                → Update branch ref
```

```
MergeCommand
    ↓ uses
Commits.findMergeBase()   → Find common ancestor
Trees.loadTree()          → Load trees to merge
Commits.store()           → Create merge commit
Staging.createBuilder()   → Build merged index
```

### Transport Integration

Remote commands delegate to `@statewalker/vcs-transport`:

```
FetchCommand
    ↓ calls
transport.fetch({
  url,               → Remote URL (from setRemote / [remote] config)
  auth, headers,     → Credentials and custom headers
  timeout, depth,
  onProgressMessage, → Raw progress messages
})
    ↓ then
importPackIntoHistory(history, packData)
```

```
PushCommand
    ↓ calls
transport.push({
  url, refspecs,
  auth, headers, timeout,
  force, atomic,
  exportPack,        → Builds the pack from local history
  getLocalRef,       → Resolves source refs
  onProgressMessage,
})
```

### Storage Backend Integration

Use `Git.fromWorkingCopy()` to bridge between repositories and the commands package:

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
const workingCopy = createMemoryWorkingCopy({
  history,
  checkout: createMemoryCheckout({ staging: createMemoryGitStaging() }),
  worktree: createMemoryWorktree({ blobs: history.blobs, trees: history.trees }),
});

const git = Git.fromWorkingCopy(workingCopy);
```

File-backed working copies (`GitWorkingCopy`) live in `@statewalker/vcs-store-files`.

## Error Handling Strategy

### Exception Hierarchy

All errors extend `GitApiError`:

```typescript
class GitApiError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GitApiError";
  }
}

class RefNotFoundError extends GitApiError {
  readonly refName: string;
  constructor(refName: string, message?: string) {
    super(message ?? `Ref not found: ${refName}`);
    this.name = "RefNotFoundError";
    this.refName = refName;
  }
}
```

### Rich Error Context

Errors carry context for debugging:

```typescript
class MergeConflictError extends GitApiError {
  readonly conflicts: string[];
  constructor(conflicts: string[] = [], message?: string) {
    super(message ?? `Merge conflicts in ${conflicts.length} file(s)`);
    this.conflicts = conflicts;
  }
}

class PushRejectedException extends TransportError {
  readonly refName: string;
  readonly reason: string;
}
```

`MergeCommand` reports conflicts through `MergeResult.status === MergeStatus.CONFLICTING` rather than throwing. `PushCommand.call()` returns per-ref statuses; `callOrThrow()` throws `NonFastForwardError` / `PushRejectedException`.

### Error Categories

| Category | When Thrown |
|----------|-------------|
| **Argument errors** | Missing or invalid command configuration |
| **Ref errors** | Branch/tag doesn't exist or already exists |
| **State errors** | Repository in unexpected state (conflicts, rebase in progress) |
| **Transport errors** | Network failures, auth issues, push rejection |

## Extension Points

### Adding New Commands

Create a new command by extending `GitCommand` (`ShowCommand` here is a hypothetical example):

```typescript
// commands/show-command.ts
export class ShowCommand extends GitCommand<ShowResult> {
  private path?: string;
  private rev?: string;

  setPath(path: string): this {
    this.checkCallable();
    this.path = path;
    return this;
  }

  setRev(rev: string): this {
    this.checkCallable();
    this.rev = rev;
    return this;
  }

  async call(): Promise<ShowResult> {
    this.checkCallable();
    this.setCallable(false);
    if (!this.path) {
      throw new MissingArgumentError("path");
    }

    const commitId = await this.resolveRef(this.rev ?? "HEAD");
    // ... implementation
  }
}
```

Export it from `commands/index.ts` and add it to the Git facade:

```typescript
class Git {
  show(): ShowCommand {
    this.checkClosed();
    return new ShowCommand(this._workingCopy);
  }
}
```

### Custom Result Types

Define structured results for new commands:

```typescript
// results/show-result.ts
export interface ShowResult {
  path: string;
  commitId: ObjectId;
  content: Uint8Array;
}
```

### Custom Error Types

Add domain-specific errors:

```typescript
// errors/show-errors.ts
export class FileNotInCommitError extends GitApiError {
  constructor(
    public readonly path: string,
    public readonly commitId: ObjectId
  ) {
    super(`File '${path}' not found in commit ${commitId}`);
  }
}
```

## Testing Patterns

### In-Memory Testing

Use memory storage for fast tests. The package tests use helpers in `tests/test-helper.ts` (`createTestWorkingCopy()`, and `backends` to run one suite over memory and SQL backends):

```typescript
import { Git } from "@statewalker/vcs-commands";
import { createTestWorkingCopy } from "./test-helper.js";

describe("CommitCommand", () => {
  let git: Git;

  beforeEach(() => {
    const { workingCopy } = createTestWorkingCopy();
    git = Git.fromWorkingCopy(workingCopy);
  });

  it("creates commit with message", async () => {
    const commit = await git.commit().setMessage("test").setAllowEmpty(true).call();
    expect(commit.id).toBeDefined();
  });
});
```

### Mocking Transport

Test transport commands without network:

```typescript
vi.mock("@statewalker/vcs-transport", async (importOriginal) => ({
  ...(await importOriginal()),
  fetch: vi.fn().mockResolvedValue({ refs: new Map(), bytesReceived: 0 /* ... */ }),
}));

it("fetches from remote", async () => {
  await git.fetch().setRemote("https://example.com/repo.git").call();
  expect(transport.fetch).toHaveBeenCalledWith(
    expect.objectContaining({ url: "https://example.com/repo.git" })
  );
});
```

The package's own transport tests (`tests/transport-test-helper.ts`) run against an in-memory Git HTTP server instead of mocks.

### Error Testing

Verify commands throw appropriate errors:

```typescript
it("throws NoMessageError without message", async () => {
  await expect(git.commit().call()).rejects.toThrow(NoMessageError);
});

it("throws RefNotFoundError for missing branch", async () => {
  await expect(
    git.checkout().setName("nonexistent").call()
  ).rejects.toThrow(RefNotFoundError);
});
```

## Performance Considerations

### Command Reuse Prevention

Commands are single-use to prevent state leakage:

```typescript
const commit = git.commit().setMessage("test");
await commit.call();
await commit.call(); // Throws: Command CommitCommand has already been called
```

Create new instances for repeated operations.

### Streaming Results

Some commands return async iterables for large results:

```typescript
// LogCommand.call() resolves to AsyncIterable<LogResult>
for await (const commit of await git.log().setMaxCount(100).call()) {
  // Process one at a time, not all in memory
}
```

### Lazy Store Access

Commands access stores lazily during execution, not construction. This allows pre-configuring commands before the repository is fully ready.
