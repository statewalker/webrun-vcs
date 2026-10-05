# Architecture Overview

This document describes the architecture of the WebRTC P2P Git Sync demo application.

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│                              Application                                  │
├──────────────────────────────────────────────────────────────────────────┤
│  Views                    │  Controllers            │  APIs               │
│  ┌─────────────────────┐  │  ┌──────────────────┐   │  ┌──────────────┐   │
│  │ ConnectionView      │  │  │ SessionController│   │  │ PeerJS API   │   │
│  │ SharingView         │──┼──│ SyncController   │───┼──│ Timer API    │   │
│  │ FileListView        │  │  │ RepositoryCtrl   │   │  │ Git API      │   │
│  │ CommitHistoryView   │  │  └──────────────────┘   │  └──────────────┘   │
│  │ ActivityLogView     │  │                         │                     │
│  └─────────────────────┘  │                         │                     │
│           │               │            │            │                     │
│           ▼               │            ▼            │                     │
│  ┌─────────────────────┐  │  ┌──────────────────┐   │                     │
│  │   UserActionsModel  │──┼──│      Models      │   │                     │
│  │   (action dispatch) │  │  │ ┌──────────────┐ │   │                     │
│  └─────────────────────┘  │  │ │SessionModel │ │   │                     │
│                           │  │ │ PeersModel   │ │   │                     │
│                           │  │ │ SyncModel    │ │   │                     │
│                           │  │ │ RepoModel    │ │   │                     │
│                           │  │ │ ActivityLog  │ │   │                     │
│                           │  │ └──────────────┘ │   │                     │
│                           │  └──────────────────┘   │                     │
└──────────────────────────────────────────────────────────────────────────┘
```

## Core Components

### Models (Data Layer)

Models are pure state containers with change notification. They hold **zero business logic**.

| Model | Purpose |
|-------|---------|
| `UserActionsModel` | Type-safe action queue with batching and multi-listener dispatch |
| `SessionModel` | P2P connection state (mode, session ID, share URL, QR code) |
| `PeersModel` | Connected peers map with status tracking |
| `SyncModel` | Sync progress (phase, objects transferred, bytes) |
| `RepositoryModel` | Git state (files, commits, staging, branch) |
| `ActivityLogModel` | User-facing event log (circular buffer) |

All models extend `BaseClass` which provides `onUpdate(listener)` subscription.

```typescript
// Models notify listeners when state changes
const repoModel = getRepositoryModel(ctx);
repoModel.onUpdate(() => {
  console.log("Repository state changed:", repoModel.getState());
});
```

### Views (Presentation Layer)

Views are **render functions** that:
1. Subscribe to model state changes
2. Render HTML based on current state
3. Bind DOM events to **enqueue actions** (never call controllers directly)
4. Return a cleanup function

```typescript
export function createFileListView(ctx: AppContext, container: HTMLElement): () => void {
  const repoModel = getRepositoryModel(ctx);
  const actionsModel = getUserActionsModel(ctx);

  function render(): void {
    const { files } = repoModel.getState();
    container.innerHTML = files.map(f => `<li>${f.name}</li>`).join("");

    // Bind events to enqueue actions
    addBtn.onclick = () => enqueueAddFileAction(actionsModel, { name, content });
  }

  const unsubscribe = repoModel.onUpdate(render);
  render(); // Initial render

  return unsubscribe;
}
```

**Views NEVER call controllers directly.** This separation enables:
- Easy testing of views with just models
- Swappable UI implementations (DOM, CLI, React, Vue, etc.)
- Clear separation of concerns

### Controllers (Business Logic Layer)

Controllers respond to user actions and perform business logic:
1. Listen to typed actions via action adapters
2. Perform async operations (Git, P2P)
3. Update models with results
4. Enqueue follow-up actions if needed

```typescript
export function createRepositoryController(ctx: AppContext): () => void {
  const actionsModel = getUserActionsModel(ctx);
  const [register, cleanup] = newRegistry();

  register(listenAddFileAction(actionsModel, async (actions) => {
    const git = getGit(ctx)!;
    for (const { name, content } of actions) {
      await git.add().addFilepattern(name).call();
      // ... commit changes
    }
    // Update model
    await refreshRepositoryState(ctx);
  }));

  return cleanup;
}
```

### APIs (External Services)

APIs provide abstractions over external services with testable interfaces:

| API | Purpose |
|-----|---------|
| `PeerJsApi` | WebRTC peer creation and connection management |
| `TimerApi` | Timer abstraction for debouncing/delays |
| Git packages | Porcelain Git operations via `@statewalker/vcs-commands` |

APIs are injected via context adapters, enabling mock injection in tests.

## Strategic Patterns

### Context Adapter Pattern

Type-safe dependency injection using a simple context object.

```typescript
// Define adapter with optional lazy factory
export const [getSessionModel, setSessionModel] = newAdapter<SessionModel>(
  "session-model",
  () => new SessionModel()
);

// Usage
const ctx: AppContext = {};
const model = getSessionModel(ctx);  // Creates on first access
setSessionModel(ctx, mockModel);     // Override for testing
```

**Benefits:**
- Encapsulates string keys
- Full type safety at compile time
- Lazy initialization with optional factory
- Easy to test with mock injection
- Zero framework overhead

### User Action Adapters (`newUserAction`)

Type-safe, decoupled event system between Views and Controllers.

```typescript
// 1. Define action adapter (actions/commit-actions.ts)
type CreateCommitPayload = { message: string };
export const [enqueueCreateCommitAction, listenCreateCommitAction] =
  newUserAction<CreateCommitPayload>("commit:create");

// 2. View enqueues action
enqueueCreateCommitAction(actionsModel, { message: "Fix bug" });

// 3. Controller listens
listenCreateCommitAction(actionsModel, (actions) => {
  for (const { message } of actions) {
    await commitChanges(message);
  }
});
```

**Key features:**
- **Type safety:** Payload types enforced at compile time
- **Batching:** Multiple enqueues in same tick delivered as array
- **Multi-listener:** Multiple controllers can respond to same action
- **Decoupling:** Views don't know about controllers

## Tactical Patterns

### Registry Pattern

Collect cleanup functions and execute them all at once.

```typescript
const [register, cleanup] = newRegistry();

// Register cleanup functions
register(model.onUpdate(render));
register(listener.unsubscribe);
register(() => socket.close());

// Later, call all cleanups
cleanup();
```

This pattern is used throughout the application:
- Views register model subscriptions
- Controllers register action listeners
- Main app registers view/controller cleanups

### Observable Base Class

All models extend `BaseClass` which provides reactive updates:

```typescript
class SessionModel extends BaseClass {
  private state = { mode: "disconnected", sessionId: null };

  setMode(mode: string): void {
    this.state.mode = mode;
    this.notify();  // Notifies all listeners
  }
}

// Subscribe to changes
model.onUpdate(() => console.log("State changed"));
```

## Data Flow

### Complete Request Cycle

```
User clicks "Add File"
         │
         ▼
View calls enqueueAddFileAction(actionsModel, { name, content })
         │
         ▼
UserActionsModel.enqueue() → schedules dispatch for next microtask
         │
         ▼
UserActionsModel.dispatchAll() → calls all listeners for "file:add"
         │
         ▼
RepositoryController listener receives [{ name, content }]
         │
         ▼
Controller performs git.add() + git.commit()
         │
         ▼
Controller calls refreshRepositoryState()
         │
         ▼
RepositoryModel.setState() → calls notify()
         │
         ▼
FileListView receives update callback
         │
         ▼
View re-renders with new files
```

### View → Model Communication

Views communicate with the rest of the app **only through models**:

```typescript
// ✅ CORRECT - Views enqueue actions
enqueueAddFileAction(actionsModel, { name: "test.txt", content: "hello" });

// ✅ CORRECT - Views read from models
const { files } = repoModel.getState();

// ✅ CORRECT - Views subscribe to model changes
repoModel.onUpdate(() => render());

// ❌ WRONG - Views never call controllers
controller.handleAddFile("test.txt", "content");
```

## API Usage

### Git Porcelain API

The application uses the Git porcelain API from `@statewalker/vcs-commands`:

```typescript
// git: a Git built by Git.fromWorkingCopy(workingCopy), see below

// Repository operations
await git.add().addFilepattern("file.txt").call();
await git.commit().setMessage("Add file").setAuthor("user", "email").call();
await git.checkout().setName("main").call();
await git.log().call();  // Returns commit history
await git.status().call();  // Returns staged/unstaged/untracked
```

### Git Initialization

`src/controllers/git-infrastructure.ts` builds the repository in one of two ways:

- `initializeGitInMemory(ctx)`: `createMemoryHistory()`, `createMemoryGitStaging()` and an
  in-memory checkout and worktree, combined into a `WorkingCopy`.
- `initializeGitFromFiles(ctx, files)`: a Git `.git` layout over a `FilesApi`, using
  `createGitObjectStore` over `FileRawStorage`, `createFileRefStore`, `createHistoryFromComponents`,
  `createGitStaging` and `FileWorktree` from `@statewalker/vcs-store-files`.

Both end with `Git.fromWorkingCopy(workingCopy)` from `@statewalker/vcs-commands`.

### P2P Transport

The sync controller implements a custom protocol over PeerJS DataConnection:

```typescript
// Message types
{ type: "repo-info", data: { request?, head, branch, objectCount } }
{ type: "send-objects", data: { type, id, data: number[] } }
{ type: "sync-complete", data: { head, objectCount } }
{ type: "error", data: string }
```

**Sync flow:**
1. Exchange repository info (HEAD, branch, object count)
2. Send local objects (commits, trees, blobs recursively)
3. Receive remote objects
4. Update refs with received HEAD
5. Checkout to update working directory

## Directory Structure

```
src/
├── main.ts                 # Entry point
├── controllers/            # Business logic
│   ├── index.ts           # Context setup, adapters
│   ├── main-controller.ts # Factory for all controllers
│   ├── session-controller.ts
│   ├── sync-controller.ts
│   └── repository-controller.ts
├── models/                 # State containers
│   ├── index.ts
│   ├── user-actions-model.ts
│   ├── session-model.ts
│   ├── peers-model.ts
│   ├── sync-model.ts
│   ├── repository-model.ts
│   └── activity-log-model.ts
├── views/                  # UI rendering
│   ├── index.ts
│   ├── connection-view.ts
│   ├── sharing-view.ts
│   ├── file-list-view.ts
│   ├── commit-form-view.ts
│   ├── commit-history-view.ts
│   ├── staging-view.ts
│   ├── activity-log-view.ts
│   └── storage-view.ts
├── actions/                # Action type definitions
│   ├── index.ts
│   ├── connection-actions.ts
│   ├── sync-actions.ts
│   ├── repo-actions.ts
│   ├── file-actions.ts
│   ├── commit-actions.ts
│   └── storage-actions.ts
├── apis/                   # External API adapters
│   ├── index.ts
│   ├── peerjs-api.ts
│   └── timer-api.ts
├── utils/                  # Shared utilities
│   ├── index.ts
│   ├── adapter.ts          # Context adapter pattern
│   ├── registry.ts         # Cleanup registry
│   └── base-class.ts       # Observable base
└── lib/                    # Helper functions
    ├── index.ts
    ├── session-id.ts
    └── qr-generator.ts
```

## Testing

The architecture enables easy testing at each layer:

```typescript
// Test controllers with mock models
const ctx = createTestContext();
setRepositoryModel(ctx, mockRepoModel);
const cleanup = createRepositoryController(ctx);
enqueueAddFileAction(getUserActionsModel(ctx), { name: "test.txt", content: "..." });
expect(mockRepoModel.getState().files).toContain("test.txt");

// Test views with just models (no controllers needed)
const ctx = {};
const repoModel = new RepositoryModel();
setRepositoryModel(ctx, repoModel);
const cleanup = createFileListView(ctx, container);
repoModel.setState({ files: ["a.txt", "b.txt"] });
expect(container.querySelectorAll("li")).toHaveLength(2);
```

## Key Design Decisions

1. **Views only talk to models** - Enables UI framework swaps and integration testing
2. **Action-based communication** - Decouples views from controllers completely
3. **Context adapters** - Lightweight DI without framework overhead
4. **Cleanup registries** - Prevents memory leaks from subscriptions
5. **Microtask batching** - Multiple actions in same tick delivered together
