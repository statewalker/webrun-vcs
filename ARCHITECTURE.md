# StateWalker VCS Architecture

> **Superseded.** This document describes the original single-core design and is no longer
> authoritative. The current architecture is the **two-axis** design pinned in the Architecture
> Decision Records under [`docs/adr/`](docs/adr/) — [ADR-0001 (two-axis
> spine)](docs/adr/0001-two-axis-architecture.md), [ADR-0002 (transport
> substrate)](docs/adr/0002-transport-substrate.md), and [ADR-0003 (large-object
> plane)](docs/adr/0003-large-object-plane.md). Read ADR-0001..0003 for the authoritative,
> as-implemented architecture; the sections below are retained for historical context only.

This document explains the overall architecture of the StateWalker VCS monorepo, covering design philosophy, package organization, and how the components work together.

## Design Philosophy

### Git Compatibility Without Git Dependencies

StateWalker VCS implements Git's object model and protocols entirely in TypeScript. Applications can read and write Git repositories without native Git binaries, making the library portable across Node.js, browsers, edge functions, and any JavaScript runtime.

The implementation produces identical output to native Git: same object IDs, same pack file formats, same protocol messages. Repositories created with StateWalker VCS work with standard Git tools and vice versa.

### Three-Part Architecture

The VCS model separates concerns into three distinct layers:

```
┌─────────────────────────────────────────────────────────────┐
│  History (immutable)                                         │
│  Content-addressed objects: blobs, trees, commits, tags      │
│  References: branches, tags, HEAD                            │
├─────────────────────────────────────────────────────────────┤
│  Checkout (mutable local state)                              │
│  Staging area, HEAD pointer, operation state                 │
│  Stash, transformation state (merge, rebase, etc.)           │
├─────────────────────────────────────────────────────────────┤
│  Worktree (filesystem access)                                │
│  Working directory read/write, file tracking                 │
│  Ignore patterns, file modes                                 │
└─────────────────────────────────────────────────────────────┘
```

This separation enables:
- **Multiple worktrees**: Share history across working directories (like `git worktree`)
- **Offline-first**: History can sync independently of checkout state
- **Testing flexibility**: Swap filesystem for memory without affecting logic

### Streaming by Default

Large repositories can contain files of any size. Rather than loading entire files into memory, all content flows through `AsyncIterable<Uint8Array>` streams. This design keeps memory consumption bounded regardless of file size.

### JGit-Inspired Implementation

The type system and algorithms align with Eclipse JGit, a mature Java implementation of Git. This alignment provides proven patterns for Git compatibility and clear precedent for edge cases.

## Package Dependency Graph

```
                    ┌──────────────────┐
                    │    commands      │
                    │   (Git API)      │
                    └────────┬─────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────┐  ┌──────────────┐  ┌──────────────┐
│   transport     │  │  store-mem   │  │  store-sql   │
│  (protocols)    │  │  (testing)   │  │  (persist)   │
└────────┬────────┘  └──────┬───────┘  └──────┬───────┘
         │                  │                 │
         └──────────────────┼─────────────────┘
                            │
                            ▼
                   ┌──────────────────┐
                   │       core       │
                   │ (history, stores,│
                   │  workspace, packs)│
                   └────────┬─────────┘
                            │
                            ▼
                      ┌───────────┐
                      │   utils   │
                      │(algorithms)│
                      └───────────┘
```

### Foundation Layer

**@statewalker/vcs-utils** provides pure algorithmic implementations with zero VCS-specific dependencies:
- Cryptographic hashing (SHA-1, CRC32, rolling checksums)
- JGit-compatible rolling hash (16-byte blocks with T[]/U[] lookup tables)
- Compression (zlib via pako, optional Node.js native)
- Diff algorithms (Myers text diff, binary delta encoding)
- Git delta format encoding/decoding
- Varint encoding for pack files
- Streaming utilities

**@statewalker/vcs-core** defines the VCS contracts and object model:
- History interface (Blobs, Trees, Commits, Tags, Refs)
- Workspace interfaces (Staging, Checkout, Worktree)
- Storage abstractions (RawStorage, ChunkAccess, GitObjectStore)
- Pack file format and delta compression
- TransformationStore for operation state (merge, rebase, cherry-pick)
- ResolutionStore for conflict management with rerere support

### Storage Layer

Storage backends implement core interfaces for different systems:

| Package | Storage Target | Use Case |
|---------|---------------|----------|
| `@statewalker/vcs-store-files` | Git `.git/` directory over a FilesApi | Native Git compatibility |
| `@statewalker/vcs-store-mem` | Memory | Testing, ephemeral repos |
| `@statewalker/vcs-store-sql` | SQL (sql.js adapter included) | Server deployments |
| `@statewalker/vcs-store-kv` | Key-value stores | Custom backends |

### Protocol Layer

**@statewalker/vcs-transport** implements Git's network protocols:
- HTTP smart protocol (v1 and v2)
- Pkt-line encoding
- Capability negotiation
- Pack transfer
- Server-side handlers (UploadPack, ReceivePack)

### Command Layer

**@statewalker/vcs-commands** provides high-level operations:
- Clone, fetch, push
- Commit, checkout
- Branch management
- Merge, rebase, cherry-pick

## History Interface

The History interface provides unified access to all immutable repository objects:

```typescript
interface History {
  readonly blobs: Blobs;     // File content (streaming)
  readonly trees: Trees;     // Directory snapshots
  readonly commits: Commits; // Version history with ancestry
  readonly tags: Tags;       // Annotated tags
  readonly refs: Refs;       // Branch/tag pointers

  initialize(): Promise<void>;
  close(): Promise<void>;
  collectReachableObjects(wants, exclude): AsyncIterable<ObjectId>;
}
```

### ObjectStorage Base Interface

All object stores share a common base interface:

```typescript
interface ObjectStorage<V> {
  store(value: V): Promise<ObjectId>;      // Store and get content-addressed ID
  load(id: ObjectId): Promise<V | undefined>;
  has(id: ObjectId): Promise<boolean>;
  remove(id: ObjectId): Promise<boolean>;
  keys(): AsyncIterable<ObjectId>;
}
```

### Semantic Stores

Built on ObjectStorage, each store adds domain-specific operations:

- **Blobs**: Raw file content with size queries
- **Trees**: Directory snapshots with entry lookup and empty tree ID
- **Commits**: Ancestry traversal, merge base detection, commit graph walking
- **Tags**: Annotated tags with target resolution (peeling)
- **Refs**: Named pointers with symbolic ref support

## Workspace Architecture

The workspace layer manages mutable local state:

### Staging Interface

```typescript
interface Staging {
  // Entry management
  getEntry(path: string): StagingEntry | undefined;
  setEntry(path: string, entry: StagingEntry): void;
  removeEntry(path: string): boolean;

  // Conflict handling
  hasConflicts(): boolean;
  getConflictedPaths(): string[];
  resolveConflict(path: string, resolution: ConflictResolution): void;

  // Tree operations
  writeTree(): Promise<ObjectId>;
  readTree(treeId: ObjectId): Promise<void>;
}
```

### Checkout Interface

```typescript
interface Checkout {
  readonly staging: Staging;

  // HEAD management
  getHead(): Promise<ObjectId | undefined>;
  setHead(target: ObjectId | string): Promise<void>;
  getCurrentBranch(): Promise<string | undefined>;
  isDetached(): Promise<boolean>;

  // Operation state
  getOperationState(): Promise<CheckoutOperationState>;
  hasOperationInProgress(): Promise<boolean>;
  abortOperation(): Promise<void>;
}
```

### Worktree Interface

```typescript
interface Worktree {
  // File operations
  readContent(path: string): AsyncIterable<Uint8Array>;
  writeContent(path: string, content: AsyncIterable<Uint8Array>): Promise<void>;
  exists(path: string): Promise<boolean>;
  isIgnored(path: string): Promise<boolean>;

  // Directory walking
  walk(options?: WalkOptions): AsyncIterable<WalkEntry>;

  // Checkout operations
  checkoutTree(treeId: ObjectId): Promise<void>;
  checkoutPaths(paths: string[], source: ObjectId): Promise<void>;
}
```

## Transformation System

The TransformationStore provides unified state management for multi-commit operations:

```typescript
interface TransformationStore {
  readonly merge: MergeStateStore;
  readonly rebase: RebaseStateStore;
  readonly cherryPick: CherryPickStateStore;
  readonly revert: RevertStateStore;
  readonly sequencer: SequencerStore;
  readonly resolution?: ResolutionStore;

  getState(): Promise<TransformationState | undefined>;
  getCapabilities(): Promise<TransformationCapabilities>;
  hasOperationInProgress(): Promise<boolean>;
  abortCurrent(): Promise<void>;
}
```

### ResolutionStore

Conflict tracking with rerere-like functionality:

```typescript
interface ResolutionStore {
  // Conflict detection
  getConflicts(): Promise<ConflictInfo[]>;
  hasConflicts(): Promise<boolean>;

  // Resolution workflow
  markResolved(path: string, strategy: ResolutionStrategy): Promise<void>;
  acceptOurs(path: string): Promise<void>;
  acceptTheirs(path: string): Promise<void>;

  // Rerere (reuse recorded resolution)
  recordResolution(path: string): Promise<void>;
  getSuggestedResolution(path: string): Promise<RecordedResolution | undefined>;
  autoResolve(): Promise<string[]>;
}
```

## Storage Architecture

The `HistoryWithOperations` interface provides unified access to Git objects and storage operations:

```
┌─────────────────────────────────────────────────────────────┐
│                   HistoryWithOperations                      │
│  Unified entry point for all storage operations              │
├─────────────────────────────────────────────────────────────┤
│  History            │   DeltaApi      │   SerializationApi   │
│  (object access)    │   (compression) │   (pack handling)    │
├─────────────────────┼─────────────────┼─────────────────────┤
│  blobs, trees       │   BlobDeltaApi  │   Pack encoding      │
│  commits, tags      │   Batch ops     │   Object serializing │
│  refs               │   Chain queries │   Import/export      │
└─────────────────────────────────────────────────────────────┘
```

### Creating Storage

Use factory functions to create storage:

```typescript
// From registered backend type
const history = await createHistory("git-files", { path: ".git" });

// Specific factories
const history = createMemoryHistoryWithOperations();
const history = createGitFilesHistory(config);
```

### RawStorage - The Backend Boundary

The lowest layer provides key-value byte storage:

```typescript
interface RawStorage {
  store(key: string, content: AsyncIterable<Uint8Array>): Promise<void>;
  load(key: string, options?: { start?: number; end?: number }): AsyncIterable<Uint8Array>;
  has(key: string): Promise<boolean>;
  remove(key: string): Promise<boolean>;
  keys(): AsyncIterable<string>;
  size(key: string): Promise<number>;
}
```

Implementations:
- **MemoryRawStorage**: In-memory Map-based storage for testing
- **FileRawStorage**: Git-compatible two-level directory structure (XX/XXXXXX)
- **CompressedRawStorage**: Decorator adding zlib compression
- **ChunkedRawStorage**: Splits large objects into fixed-size chunks

### ChunkAccess - Chunked Storage

For storage backends with size limits (like browser storage):

```typescript
interface ChunkAccess {
  storeChunk(key: string, index: number, data: Uint8Array): Promise<void>;
  loadChunk(key: string, index: number): Promise<Uint8Array>;
  getChunkCount(key: string): Promise<number>;
  removeChunks(key: string): Promise<void>;
  hasKey(key: string): Promise<boolean>;
  keys(): AsyncIterable<string>;
}
```

## Content-Addressable Storage

Every object's ID derives from its content via SHA-1:

```
SHA-1("<type> <size>\0<content>") = ObjectId
```

This provides:
- **Automatic deduplication**: Identical files produce identical IDs
- **Integrity verification**: Corrupted objects have wrong IDs
- **Efficient sync**: Only transfer objects not already present
- **Immutability**: Changing content changes the ID

## Delta Compression

Similar objects are stored as differences from a base object:

```
Source: [----A----][----B----][----C----]
Target: [----B----][--new--][----A----]

Delta:
  COPY from source offset 10, length 10  (block B)
  INSERT [--new--]                       (new data)
  COPY from source offset 0, length 10   (block A)
```

### Blobs-Only Delta Strategy

Delta compression is applied only to blob objects:

**Rationale:**
- **90%+ of storage is blobs**: File content dominates repository size
- **Trees/commits are small**: Typically < 1KB, delta overhead exceeds savings
- **Simpler GC**: No tree delta chains to manage during garbage collection
- **Faster access**: Commits/trees don't require delta reconstruction

## Transport Protocol

The transport layer implements Git's smart HTTP protocol:

```
Client                          Server
   │                               │
   │ ── GET /info/refs ──────────► │  Discover refs
   │ ◄── refs + capabilities ───── │
   │                               │
   │ ── POST git-upload-pack ────► │  Request objects
   │    want <oid>                 │
   │    have <oid>                 │
   │    done                       │
   │ ◄── pack data (sideband) ──── │  Receive pack
   │                               │
```

Features:
- Protocol v1 and v2 support
- Capability negotiation (multi_ack, thin-pack, side-band-64k)
- Shallow clone support
- Server implementation using Web Standard APIs (Request/Response)

## Extension Points

### Custom Storage Backends

Implement RawStorage for your storage system:

```typescript
class MyRawStorage implements RawStorage {
  async store(key: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    // Your storage logic
  }
  // ... other methods
}
```

Then create a History using factory functions:

```typescript
import { createHistoryWithOperations } from "@statewalker/vcs-core";

const history = await createHistoryWithOperations({ backend: myBackend });
await history.initialize();
```

### Custom Compression

The compression layer supports pluggable implementations:

```typescript
import { setCompressionUtils } from "@statewalker/vcs-utils/compression";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";

setCompressionUtils(createNodeCompression()); // Use native zlib
```

### Repository Resolution

The HTTP server has no built-in authentication hooks. It resolves each request's repository
through `resolveRepository`; returning `null` answers `404 Repository not found`. Put authentication in front of
`handleRequest`:

```typescript
import { createGitHttpServer } from "@statewalker/vcs-transport";

const server = createGitHttpServer({
  resolveRepository: async (repoPath) => {
    // Return { repository, refStore } for a known repository, or null.
    return null;
  },
});
// server.handleRequest(request) -> Promise<HttpResponse>
```

## Browser Compatibility

The core packages work in browsers without polyfills:
- **@statewalker/vcs-utils**: Pure TypeScript algorithms
- **@statewalker/vcs-core**: Interface definitions and format handling
- **@statewalker/vcs-transport**: Web Standard APIs (fetch, Request/Response)

Storage backends may have platform requirements:
- **store-files (Git storage)**: Requires a FilesApi implementation
- **store-sql**: Needs a SQL database client; the bundled sql.js adapter runs in browsers and Node.js
- **store-mem**: Works everywhere
- **store-kv**: Works with any key-value backend (IndexedDB, LocalStorage, etc.)

## Performance Considerations

### Streaming Everything

Never buffer entire objects in memory. Use async generators:

```typescript
async function* processContent(input: AsyncIterable<Uint8Array>) {
  for await (const chunk of input) {
    yield transform(chunk);
  }
}
```

### Lazy Loading

Load objects only when needed. The `has()` method checks existence without loading content.

### Delta Chain Limits

Configure chain depth to balance compression ratio against reconstruction cost. Deep chains save space but slow random access.

### Pack File Optimization

Large repositories benefit from periodic repacking to optimize delta relationships and reduce file count.
