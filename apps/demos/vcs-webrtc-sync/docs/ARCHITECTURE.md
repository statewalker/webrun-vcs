# Architecture Documentation

This document describes the internal architecture of the VCS WebRTC Sync demo application.

## Overview

The application enables peer-to-peer Git repository synchronization between browsers using WebRTC. The architecture follows an MVC pattern with context-based dependency injection.

```
┌─────────────┐         ┌─────────────┐
│   Peer A    │◄───────►│   Peer B    │
│  (Browser)  │  WebRTC │  (Browser)  │
└─────────────┘   Data  └─────────────┘
                Channel
```

## MVC Architecture

### Data Flow

```
User Input → View → UserActionsModel → Controller → External API
                                                         ↓
User sees ← View ← Model updates ← Controller ← API response
```

Views communicate with Controllers exclusively through Models. This ensures loose coupling and testability.

### Models Layer

**Purpose**: Pure data containers with change notification.

**Principles**:
- NO business logic
- NO API calls
- NO direct UI manipulation
- Models extend `BaseClass` for observable state
- Changes emit via `notify()`, consumers subscribe via `onUpdate()`

**Models**:

| Model | Purpose |
|-------|---------|
| `RepositoryModel` | Repository status, branch, HEAD commit |
| `FileListModel` | Working directory files with status |
| `StagingModel` | Files staged for next commit |
| `CommitHistoryModel` | Recent commits list |
| `CommitFormModel` | Commit message input state |
| `ConnectionModel` | WebRTC connection state |
| `SharingFormModel` | Signaling form state (offer/answer) |
| `ActivityLogModel` | Application event log |
| `UserActionsModel` | User action requests |

### Views Layer

**Purpose**: Render Model state to DOM, capture user input.

**Principles**:
- ISOLATED from external world
- NO direct API calls (fetch, WebRTC, localStorage)
- NO direct controller calls
- ONLY interact with Models via context adapters
- Update `UserActionsModel` for user actions

**Pattern**:
```typescript
function createXxxView(ctx: AppContext, container: HTMLElement): () => void {
  const model = getXxxModel(ctx);

  function render(): void {
    container.innerHTML = `...`;
    // Bind event handlers that call model methods
  }

  const cleanup = model.onUpdate(render);
  render();

  return cleanup;
}
```

**Views**:

| View | Panel |
|------|-------|
| `ConnectionView` | WebRTC connection/signaling UI |
| `SharingView` | Share/Connect signaling workflow |
| `StorageView` | Storage selection and repo controls |
| `FileListView` | Working directory file list |
| `StagingView` | Staged files for commit |
| `CommitFormView` | Commit message input |
| `CommitHistoryView` | Commit history with restore |
| `ActivityLogView` | Event log display |

### Controllers Layer

**Purpose**: Business logic, external API interaction.

**Principles**:
- React to Model changes
- Update Models based on API responses
- Subscribe to `UserActionsModel` for user-initiated actions
- Use API interfaces from context (not implementations)

**Pattern**:
```typescript
function createXxxController(ctx: AppContext): () => void {
  const [register, cleanup] = newRegistry();
  const model = getXxxModel(ctx);
  const actionsModel = getUserActionsModel(ctx);

  register(actionsModel.onUpdate(() => {
    // Handle user action requests
  }));

  return cleanup;
}
```

**Controllers**:

| Controller | Responsibility |
|------------|----------------|
| `MainController` | Orchestrates sub-controllers, routes user actions |
| `StorageController` | File system access, storage backend management |
| `RepositoryController` | Git operations (commit, stage, history) |
| `WebRtcController` | WebRTC connection lifecycle |
| `SyncController` | Git object transfer over WebRTC |

## Context Adapter Pattern

### Purpose

Dependency injection for loose coupling and testability.

### Implementation

```typescript
// Define adapter
const [getXxxModel, setXxxModel] = newAdapter<XxxModel>(
  "xxx-model",
  () => new XxxModel()
);

// Usage in components
const model = getXxxModel(ctx);  // Lazy creation

// Inject mock in tests
setXxxModel(ctx, mockModel);
```

### Benefits

- Components don't know how dependencies are created
- Easy to inject mocks in tests
- Single source of truth (same instance everywhere)
- Lazy initialization

## User Actions Pattern

Views communicate user intent through `UserActionsModel`:

```typescript
// View captures user action
button.onclick = () => {
  actionsModel.requestCommit(message);
};

// Controller handles action
register(actionsModel.onUpdate(() => {
  const action = actionsModel.commitAction;
  if (action) {
    actionsModel.clearCommitAction();
    performCommit(action.message);
  }
}));
```

This pattern:
- Keeps Views isolated from business logic
- Makes user actions testable
- Provides a clear audit trail of user intent

## File Structure

```
src/
├── main.ts                     # Bootstrap
├── utils/
│   ├── base-class.ts          # Observable state base
│   ├── adapter.ts             # Context adapter factory
│   ├── registry.ts            # Cleanup registration
│   └── index.ts
├── models/
│   ├── repository-model.ts
│   ├── file-list-model.ts
│   ├── staging-model.ts
│   ├── commit-history-model.ts
│   ├── commit-form-model.ts
│   ├── connection-model.ts
│   ├── sharing-form-model.ts
│   ├── activity-log-model.ts
│   ├── user-actions-model.ts
│   └── index.ts
├── views/
│   ├── connection-view.ts
│   ├── sharing-view.ts
│   ├── storage-view.ts
│   ├── file-list-view.ts
│   ├── staging-view.ts
│   ├── commit-form-view.ts
│   ├── commit-history-view.ts
│   ├── activity-log-view.ts
│   ├── main-view.ts
│   └── index.ts
├── controllers/
│   ├── main-controller.ts
│   ├── storage-controller.ts
│   ├── repository-controller.ts
│   ├── webrtc-controller.ts
│   ├── sync-controller.ts
│   └── index.ts
└── styles/
    └── main.css
tests/
├── test-utils.ts
└── models.test.ts
```

## Testing Strategy

### Unit Tests

**Models**: Verify state updates trigger listeners correctly.

```typescript
it("should notify on state change", () => {
  const listener = spy();
  model.onUpdate(listener);
  model.setSomeValue("test");
  expect(listener.calls).toHaveLength(1);
});
```

**Controllers**: Test with mock models, verify correct model updates.

### Test Utilities

- `createTestContext()` - Fresh context with all models
- `spy()` - Simple function call recorder

## Key Design Decisions

### Why Views Don't Call Controllers

Controllers may be asynchronous, may fail, may have side effects. By routing through Models:
- Views stay synchronous and predictable
- Controllers can be tested independently
- User actions are traceable

### Why Context Instead of Globals

- Each test gets isolated state
- Multiple app instances possible
- Clear dependency graph
- Easy mocking

### Why Manual Cleanup Registration

The `newRegistry()` pattern ensures all subscriptions are properly cleaned up:

```typescript
const [register, cleanup] = newRegistry();
register(model1.onUpdate(handler1));
register(model2.onUpdate(handler2));
// Later...
cleanup();  // Removes all subscriptions
```

## External Dependencies

| Package | Purpose |
|---------|---------|
| `@statewalker/vcs-core` | Git primitives (blobs, trees, commits) |
| `@statewalker/vcs-commands` | High-level Git operations |
| `@statewalker/vcs-transport` | Git fetch/push over a duplex |
| `@statewalker/vcs-transport-adapters` | History to transport adapters |
| `@statewalker/vcs-working-tree` | Staging, checkout, worktree |
| `@statewalker/vcs-store-files` | Git layout over a FilesApi |
| `@statewalker/webrun-streams`, `@statewalker/webrun-streams-signaling` | WebRTC duplex streams and signaling |
| `@statewalker/webrun-files` | Filesystem abstraction |
| `@statewalker/webrun-files-browser` | File System Access API backend |
| `@statewalker/webrun-files-mem` | In-memory filesystem |
