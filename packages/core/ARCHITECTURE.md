# @statewalker/vcs-core Architecture

This document explains the internal architecture of the core package, covering design decisions, module organization, and extension points.

> **Names in this document.** The public facade is `History` with the typed stores `Blobs`, `Trees`, `Commits`, `Tags` and `Refs` (`src/history/history.ts`). Where the text below says `HistoryStore`, `BlobStore`, `TreeStore`, `CommitStore` or `TagStore`, read the corresponding current interface; the method names are `store()` / `load()` on every typed store. The low-level byte interface is `RawStorage` (`src/storage/raw/raw-storage.ts`). Working-directory state (staging, status, checkout, worktree, working copy, ignore rules) lives in `@statewalker/vcs-working-tree`, and high-level commands in `@statewalker/vcs-commands`; the sections describing them are kept for orientation.

## Design Philosophy

### Separation of Interfaces from Implementations

The core package defines contracts, not concrete implementations. Each store interface specifies what operations must be supported without dictating how backends implement them. This separation enables:

- **Multiple backends**: The same VCS logic works with filesystem storage, SQLite, IndexedDB, or cloud storage
- **Testing flexibility**: In-memory implementations enable fast unit tests
- **Gradual migration**: Applications can switch backends without changing business logic

When you see a file like `commits.ts` alongside `commits.impl.ts`, the former defines the interface while the latter provides a reference implementation that delegates to lower-level stores.

### Storage-Agnostic Design

The package never directly touches the filesystem or database. All I/O flows through abstract interfaces:

```
Application Code
       ↓
   Core Interfaces (this package)
       ↓
   Storage Backend (@statewalker/vcs-store-*)
       ↓
   Actual Storage (filesystem, SQLite, IndexedDB, etc.)
```

This architecture means the same commit logic, tree building, and reference management work identically regardless of where data lives.

### Streaming for Memory Efficiency

Large repositories can contain files of any size. Rather than loading entire files into memory, all content flows through `AsyncIterable<Uint8Array>` streams:

```typescript
interface BlobStore {
  store(content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<ObjectId>;
  load(id: ObjectId): AsyncIterable<Uint8Array>;
}
```

This design keeps memory consumption bounded. A 1GB file streams through with constant memory overhead rather than requiring 1GB+ of RAM.

### JGit-Inspired Architecture

The type system and constants align with Eclipse JGit, a mature Java implementation of Git. This alignment provides:

- Proven patterns for Git compatibility
- Clear precedent for edge cases
- Familiar concepts for developers coming from JGit

## Object Model Architecture

Git's content-addressable storage forms the foundation:

```
GitObject (conceptual base)
├── Blob (type 3)
│   └── Raw binary content, no parsing
├── Tree (type 2)
│   └── Sorted list of TreeEntry { mode, name, id }
├── Commit (type 1)
│   └── tree + parents[] + author + committer + message
└── Tag (type 4)
    └── object + objectType + tag + tagger + message
```

### Why Content-Addressable Storage

Every object's ID derives from its content via SHA-1 hashing. This provides:

1. **Automatic deduplication**: Identical files produce identical IDs
2. **Integrity verification**: Corrupted objects have wrong IDs
3. **Efficient synchronization**: Only transfer objects not already present
4. **Immutability guarantees**: Changing content changes the ID

### Object ID Generation

The ID comes from hashing the object with its Git header:

```
SHA-1("<type> <size>\0<content>")
```

For example, a blob containing "hello" produces:

```
SHA-1("blob 5\0hello") = "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0"
```

### Serialization Format

Objects serialize to Git's wire format for compatibility:

**Tree entries**: `<mode-octal> <name>\0<20-byte-hash>`
**Commits**: Header fields as `<key> <value>\n`, blank line, then message
**Tags**: Same format as commits with different header fields

The `format/` module handles streaming serialization and deserialization.

## Store Hierarchy

The package organizes stores in layers, each building on the one below:

```
┌─────────────────────────────────────────────────────────────┐
│                      HistoryStore                            │
│  Unified entry point with lifecycle management               │
├─────────────────────────────────────────────────────────────┤
│  CommitStore    TreeStore    BlobStore    TagStore           │
│  Semantic operations on specific object types                │
├─────────────────────────────────────────────────────────────┤
│                    GitObjectStore                            │
│  Unified object storage with type headers                    │
├─────────────────────────────────────────────────────────────┤
│               BinStore (binary storage)                      │
│  Combines raw storage with delta compression                 │
├─────────────────────────────────────────────────────────────┤
│    RawStore              DeltaStore                          │
│    (key-value bytes)     (delta relationships)               │
└─────────────────────────────────────────────────────────────┘
```

### Two-Tier API Design

The HistoryStore exposes both `GitObjectStore` and typed stores (`blobs`, `trees`, `commits`, `tags`) because they serve different purposes:

**GitObjectStore** provides low-level, type-agnostic, format-aware access. It works with raw Git objects including their headers (`"blob 123\0content"`), enabling operations that need the wire format: transport protocols, pack file generation, and object introspection.

**Typed stores** provide high-level, type-specific, parsed interfaces. They parse object content into structured data (`Commit`, `TreeEntry[]`, etc.) and handle serialization automatically. Application code typically uses these for everyday VCS operations.

Both layers are necessary. Transport code needs raw bytes with headers to build pack files. Application code needs parsed commits to display history. The architecture exposes both rather than forcing one abstraction for all use cases.

### RawStorage - Foundation Layer

The lowest layer stores raw bytes by string key:

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

Backends handle compression internally. Git-compatible stores use zlib deflate; others may use different compression or none at all.

### BinStore - Combined Storage

Combines raw storage with optional delta compression:

```typescript
interface BinStore {
  raw: RawStore;
  delta: DeltaStore;
  flush(): Promise<void>;
  close(): Promise<void>;
  refresh(): Promise<void>;
}
```

### GitObjectStore - Type-Aware Layer

Adds Git object semantics (type headers, content hashing):

```typescript
interface GitObjectStore {
  store(type: ObjectTypeString, content: AsyncIterable<Uint8Array>): Promise<ObjectId>;
  loadRaw(id: ObjectId): AsyncIterable<Uint8Array>;  // With header
  load(id: ObjectId): AsyncIterable<Uint8Array>;     // Without header
  loadWithHeader(id: ObjectId): Promise<[GitObjectHeader, AsyncGenerator<Uint8Array>]>;
  getHeader(id: ObjectId): Promise<GitObjectHeader>;
  has(id: ObjectId): Promise<boolean>;
  delete(id: ObjectId): Promise<boolean>;
  list(): AsyncIterable<ObjectId>;                   // All object IDs
}
```

The distinction between `loadRaw()` and `load()` matters for different use cases. Transport protocols need `loadRaw()` to get the complete Git object with header for pack file generation. Application code uses `load()` to get just the content, or works through typed stores that handle parsing.

### Semantic Stores

Built on GitObjectStore, these provide domain-specific operations:

| Store | Key Operations |
|-------|----------------|
| `BlobStore` | `store(content)`, `load(id)` |
| `TreeStore` | `storeTree(entries)`, `loadTree(id)`, `getEntry(treeId, name)` |
| `CommitStore` | `storeCommit()`, `loadCommit()`, `walkAncestry()`, `findMergeBase()` |
| `TagStore` | `storeTag()`, `loadTag()`, `getTarget(id, peel?)` |

### Why `objects` is Exposed in the Public API

The current `History` interface does not carry an `objects` property: the `GitObjectStore` is created with `createGitObjectStore(rawStorage)` and passed to the typed-store factories and history factories, and callers that need raw access keep a reference to it (for example `createGitFilesBackend()` in `@statewalker/vcs-store-files` returns `{ history, objects, ... }`). This design choice enables several important use cases:

**Transport and Protocol Operations**

Git's HTTP and SSH protocols transfer objects in pack files, which contain raw objects with their Git headers. The transport layer needs direct access to `objects` for building pack files during push and receiving objects during fetch. `createCoreRepositoryAccess()` in `@statewalker/vcs-transport-adapters` builds protocol access directly from an object store and a ref store:

```typescript
import { createCoreRepositoryAccess } from "@statewalker/vcs-transport-adapters";

const repositoryAccess = createCoreRepositoryAccess({ objectStore, refStore });
```

**Object Introspection**

Sometimes you need to query an object's type and size without parsing its content. The `getHeader()` method provides this efficiently:

```typescript
const header = await historyStore.objects.getHeader(unknownId);
console.log(`Type: ${header.type}, Size: ${header.size} bytes`);
```

**Raw Object Streaming**

The `loadRaw()` method streams objects with their Git headers intact, essential for network transfer and pack file generation:

```typescript
// Collect raw object for push operation
for await (const chunk of historyStore.objects.loadRaw(id)) {
  chunks.push(chunk);
}
const rawData = concatBytes(chunks);
const header = parseHeader(rawData);
const content = extractGitObjectContent(rawData);
```

**Unified Object Iteration**

The `list()` method returns all object IDs regardless of type, useful for garbage collection, repository analysis, and migration tools:

```typescript
for await (const id of historyStore.objects.list()) {
  const header = await historyStore.objects.getHeader(id);
  console.log(`${id}: ${header.type}`);
}
```

**Internal Composition**

The typed stores are thin wrappers that delegate to `GitObjectStore`. For example, `BlobStore.store()` simply calls `objects.store("blob", content)`. Exposing `objects` allows advanced users to bypass the typed layer when needed while keeping the common case simple.

## Directory Structure Deep Dive

The package is organized into four logical layers, plus transversal modules:

```
src/
├── common/           # Shared types: id, person, files (re-exported from @statewalker/vcs-utils/files)
├── history/          # Version control objects: objects, commits, trees, blobs, tags, refs, format, hash
├── storage/          # Byte storage: raw, binary, chunked, delta, adapters (webrun-storage seam)
├── pack/             # Pack files: reader/parser, writer, indexer, index reader/writer
├── serialization/    # SerializationApi: loose objects and packs over a History
├── backend/          # Backend registry, capabilities, memory and git-files backends
├── gc/               # GC orchestration and strategies
└── vcs-core/         # VcsCore facade over @statewalker/webrun-storage
```

Working-directory modules (`worktree`, `staging`, `status`, `checkout`, `working-copy`, `ignore`) are in `@statewalker/vcs-working-tree`; `add` and `checkout` commands are in `@statewalker/vcs-commands`.

### common/ - Shared Types

Foundation types used across all layers.

#### common/id/

| File | Purpose |
|------|---------|
| `object-id.ts` | `ObjectId` type, format constants |

```typescript
type ObjectId = string; // 40-char hex for SHA-1

const GitFormat = {
  OBJECT_ID_LENGTH: 20,        // Bytes
  OBJECT_ID_STRING_LENGTH: 40, // Hex characters
};
```

#### common/person/

| File | Purpose |
|------|---------|
| `person-ident.ts` | `PersonIdent` interface |

```typescript
interface PersonIdent {
  name: string;
  email: string;
  timestamp: number;  // Unix seconds
  tzOffset: string;   // "+0000" format
}
```

Git format: `"Name <email> 1234567890 +0100"`

#### common/format/

| File | Purpose |
|------|---------|
| `person-ident.ts` | Author/committer identity formatting |
| `types.ts` | `CommitEntry`, `TagEntry` for streaming parse |

The streaming design uses discriminated unions:

```typescript
type CommitEntry =
  | { type: "tree"; value: string }
  | { type: "parent"; value: string }
  | { type: "author"; value: PersonIdent }
  | { type: "committer"; value: PersonIdent }
  | { type: "message"; value: string };
```

#### common/files/

| File | Purpose |
|------|---------|
| `file-mode.ts` | `FileMode` constants matching Git |

```typescript
FileMode.TREE           // 0o040000
FileMode.REGULAR_FILE   // 0o100644
FileMode.EXECUTABLE_FILE // 0o100755
FileMode.SYMLINK        // 0o120000
FileMode.GITLINK        // 0o160000
```

### storage/ - Binary Storage Layer

Low-level storage abstractions for bytes, packs, and deltas.

#### storage/raw/ and storage/binary/

| File | Purpose |
|------|---------|
| `raw/raw-storage.ts` | `RawStorage` interface for key-value byte storage |
| `raw/memory-raw-storage.ts` | In-memory RawStorage implementation |
| `raw/compressed-raw-storage.ts` | Zlib-compressed RawStorage wrapper |
| `raw/combined-raw-storage.ts`, `raw/composite-raw-storage.ts` | RawStorage composed from several storages |
| `binary/bin-store.ts` | `BinStore`: raw storage plus delta storage |
| `binary/volatile-store.ts` | `VolatileStore` interface for transient data |
| `binary/volatile-store.memory.ts` | In-memory VolatileStore implementation |

File-based RawStorage lives in `@statewalker/vcs-store-files`; the webrun-storage adapter `blobStoreToRawStorage()` is in `storage/adapters/`. The `RawStorage` interface is implemented by each storage backend. All higher layers build on this abstraction.

#### pack/ (`src/pack`, exported through `backend`)

| File | Purpose |
|------|---------|
| `pack-entries-parser.ts` | Parse pack entries |
| `pack-indexer.ts` | Build .idx files |
| `pack-index-reader.ts` | Read .idx files |
| `pack-index-writer.ts` | Write .idx files |
| `pack-writer.ts` | Write .pack files |
| `streaming-pack-writer.ts` | Streaming pack writer |
| `pending-pack.ts` | In-progress pack buffer |
| `git-pack-store.ts` | Pack-based object storage with the RawStorage interface |
| `delta-reverse-index.ts` | Reverse index for delta lookups |
| `delta-instruction-analyzer.ts`, `random-access-delta.ts` | Random access into delta-reconstructed content |
| `varint.ts` | Pack varint encoding |
| `types.ts` | Pack-related types |

Pack directory management and pack-based delta storage for Git repositories on disk are in `@statewalker/vcs-store-files`.

Pack files bundle multiple objects efficiently for storage and transfer. The .idx file provides random access by object ID.

#### storage/delta/

| File | Purpose |
|------|---------|
| `delta-store.ts` | `DeltaStore` interface |
| `delta-binary-format.ts` | Delta instruction encoding |
| `gc-controller.ts` | Garbage collection coordination |
| `packing-orchestrator.ts` | Batch delta computation |
| `raw-store-with-delta.ts` | Raw store with delta resolution |
| `storage-analyzer.ts` | Analyze storage for optimization |
| `types.ts` | Delta-related type definitions |
| `strategies/` | Delta candidate selection strategies |

Delta compression stores objects as differences from similar objects. The system manages:
- **Delta chains**: A → B → C where C is delta of B, B is delta of A
- **Chain depth limits**: Prevent excessively long chains
- **Candidate selection**: Find good base objects for deltaification

### history/ - Version Control Objects

Git object model: objects, commits, trees, blobs, tags, and refs.

#### history/objects/

| File | Purpose |
|------|---------|
| `object-store.ts` | `GitObjectStore` interface |
| `object-store.impl.ts` | Implementation |
| `object-header.ts` | Header encoding/decoding |
| `object-types.ts` | Type codes and strings |
| `load-with-header.ts` | Combined header+content loading |

Header format: `"<type> <size>\0"`

```typescript
encodeObjectHeader("blob", 1234) // Uint8Array of "blob 1234\0"
parseHeader(data) // { type: "blob", size: 1234, contentOffset: 10 }
```

#### history/blobs/

Simplest object type - raw file contents.

| File | Purpose |
|------|---------|
| `blob-store.ts` | `BlobStore` interface |
| `blob-store.impl.ts` | Implementation delegating to `GitObjectStore` |

Blobs have no internal structure to parse. They're stored as-is with a Git header.

#### history/commits/

| File | Purpose |
|------|---------|
| `commit-store.ts` | `CommitStore` interface with traversal operations |
| `commit-store.impl.ts` | Implementation with graph algorithms |
| `commit-format.ts` | Serialization/deserialization |

Key algorithms:
- **walkAncestry**: Breadth-first traversal through parent links
- **findMergeBase**: Common ancestor detection for three-way merges
- **isAncestor**: Reachability test between commits

#### history/trees/

| File | Purpose |
|------|---------|
| `tree-store.ts` | `TreeStore` interface |
| `tree-store.impl.ts` | Implementation |
| `tree-entry.ts` | `TreeEntry` type |
| `tree-format.ts` | Binary format |

Tree entries are sorted canonically (directories sort as if they had trailing `/`). This canonical ordering ensures identical trees always produce identical IDs.

#### history/tags/

| File | Purpose |
|------|---------|
| `tag-store.ts` | `TagStore` interface |
| `tag-store.impl.ts` | Implementation |
| `tag-format.ts` | Serialization |

Annotated tags can point to any object type and optionally chain (tag pointing to tag). The `getTarget(id, peel)` method resolves chains to the final target.

#### history/refs/

| File | Purpose |
|------|---------|
| `ref-store.ts` | `RefStore` interface |
| `ref-store.files.ts` | File-based RefStore implementation |
| `ref-store.memory.ts` | In-memory RefStore implementation |
| `ref-types.ts` | `Ref`, `SymbolicRef`, `RefStorage` |
| `ref-reader.ts` | Read loose refs |
| `ref-writer.ts` | Write loose refs |
| `ref-directory.ts` | Refs directory structure |
| `packed-refs-reader.ts` | Read packed-refs |
| `packed-refs-writer.ts` | Write packed-refs |

Reference types:

```typescript
interface Ref {
  name: string;           // "refs/heads/main"
  objectId: ObjectId;
  storage: RefStorage;    // LOOSE, PACKED, or LOOSE_PACKED
}

interface SymbolicRef {
  name: string;           // "HEAD"
  target: string;         // "refs/heads/main"
  storage: RefStorage;
}
```

The `compareAndSwap` operation enables atomic updates:

```typescript
refs.compareAndSwap("refs/heads/main", expectedOldId, newId)
```

#### history/history-store.ts

Main entry point combining all history stores (HistoryStore interface).

### workspace/ - Working Directory State

Working tree, staging, status, checkout, and working copy management. These modules are in `@statewalker/vcs-working-tree` (`src/worktree`, `src/staging`, `src/status`, `src/checkout`, `src/working-copy`, `src/ignore`), not in this package.

#### workspace/worktree/

| File | Purpose |
|------|---------|
| `worktree-store.ts` | `WorktreeStore` interface |
| `worktree-store.impl.ts` | Implementation |

Provides platform-agnostic filesystem iteration with:
- Ignore pattern matching
- File mode detection
- Content hashing (Git blob format)

#### workspace/staging/

| File | Purpose |
|------|---------|
| `staging-store.ts` | `StagingStore` interface |
| `staging-edits.ts` | `StagingEdit` for modifications |
| `staging-store.files.ts` | File-based implementation |
| `staging-store.memory.ts` | In-memory implementation |
| `index-format.ts` | Git index format parsing |
| `conflict-utils.ts` | Merge conflict handling |

Modification patterns:

```typescript
// Builder: bulk modifications, replaces entire index
const builder = staging.builder();
await builder.addTree(trees, treeId, "");
await builder.finish();

// Editor: targeted modifications, preserves unaffected entries
const editor = staging.editor();
editor.add({ path: "file.txt", apply: (existing) => newEntry });
await editor.finish();
```

Merge stages:

```typescript
const MergeStage = {
  MERGED: 0,   // Normal, no conflict
  BASE: 1,     // Common ancestor version
  OURS: 2,     // Current branch version
  THEIRS: 3,  // Incoming branch version
};
```

#### workspace/status/

| File | Purpose |
|------|---------|
| `status-calculator.ts` | `StatusCalculator` interface |
| `status-calculator.impl.ts` | Implementation |

Three-way comparison:

```
HEAD (last commit)
  ↓ compare
Index (staging area)
  ↓ compare
Working Tree (filesystem)
```

Each file gets two statuses: `indexStatus` (vs HEAD) and `workTreeStatus` (vs index).

#### workspace/checkout/

CheckoutStore for managing local checkout state.

| File | Purpose |
|------|---------|
| `checkout-store.ts` | `CheckoutStore` interface definition |
| `checkout-store.files.ts` | File-based implementation |
| `checkout-store.memory.ts` | In-memory implementation |

The CheckoutStore manages local checkout state:
- **HEAD Management**: Current branch or detached commit
- **In-progress Operations**: Merge, rebase, cherry-pick, revert state
- **Linked Stores**: Staging area and stash operations

Multiple CheckoutStores can share a single HistoryStore (like git worktree).

#### workspace/working-copy/

Working copy management, stash, and repository state detection.

| File | Purpose |
|------|---------|
| `working-copy.ts` | `WorkingCopy` interface |
| `repository-state.ts` | Repository state detection (merge, rebase, etc.) |
| `stash-store.ts` | `StashStore` interface |
| `stash-store.files.ts` | File-based stash implementation |
| `checkout-utils.ts` | Three-way merge utilities |
| `checkout-conflict-detector.ts` | Conflict detection |

#### workspace/ignore/

| File | Purpose |
|------|---------|
| `ignore-manager.ts` | `IgnoreManager` interface |
| `ignore-manager.impl.ts` | Implementation |
| `ignore-node.ts` | Trie node for efficient matching |
| `ignore-rule.ts` | Individual pattern parsing |

The implementation uses a trie structure for efficient path matching against potentially many ignore patterns.

#### workspace/working-copy.ts

Main `WorkingCopy` interface definition.

### commands/ - High-Level Operations

These are in `@statewalker/vcs-commands`, not in this package.

| File | Purpose |
|------|---------|
| `add.command.ts` | `Add` interface for staging files |
| `add.command.impl.ts` | Implementation |
| `checkout.command.ts` | `Checkout` interface for materializing trees |
| `checkout.command.impl.ts` | Implementation with conflict detection |

Commands encapsulate multi-step workflows:
- `Add`: Hash files, update staging entries, handle ignore patterns
- `Checkout`: Compare trees, detect conflicts, update worktree

### Repository Access (Moved)

**Note:** The `RepositoryAccess` interface and its implementations (`GitNativeRepositoryAccess`, `SerializingRepositoryAccess`) have been moved to the `@statewalker/vcs-transport-adapters` package.

These provide byte-level access to Git objects in wire format for transport operations (fetch, push, clone). See the transport-adapters package for:

- `RepositoryAccess` interface
- `createVcsRepositoryAccess` - adapts VCS stores to RepositoryAccess
- `createCoreRepositoryAccess` - adapts GitObjectStore + RefStore to RepositoryAccess
- `GitNativeRepositoryAccess` - direct passthrough for object-only operations

```typescript
import { createVcsRepositoryAccess } from "@statewalker/vcs-transport-adapters";

const repositoryAccess = createVcsRepositoryAccess({ history });
```

### History factories

Factory functions live in `history/create-history.ts`:

| Function | Result |
|----------|--------|
| `createMemoryHistory()` | In-memory `History` |
| `createMemoryHistoryWithOperations()` | In-memory `HistoryWithOperations` (delta + serialization) |
| `createGitFilesHistory(config)` | `HistoryWithOperations` over pre-built Git-file stores |
| `createHistoryFromStores(config)` / `createHistoryFromComponents(config)` | `History` from your own stores |

```typescript
import { createMemoryHistory } from "@statewalker/vcs-core";

// In-memory repository
const memHistory = createMemoryHistory();
await memHistory.initialize();

// File-based repository: the stores are built by @statewalker/vcs-store-files
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { createGitFilesBackend } from "@statewalker/vcs-store-files";
const files = createNodeFilesApi({ rootDir: "/path/to/project" });
const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
```

## Key Algorithms

### Commit Ancestry Traversal

The `walkAncestry` method performs breadth-first traversal:

```
       C1 (start)
      /  \
    C2    C3
    |     |
    C4    C5
     \   /
      C6
```

With `firstParentOnly: true`, follows only first parent for linear history.

### Merge Base Detection

Finding common ancestors for three-way merge:

1. Mark ancestors of commit A
2. Find first marked ancestor reachable from B
3. Handle octopus merges by finding all merge bases

### Delta Chain Resolution

When loading a deltified object:

1. Find base object(s) in chain
2. Load base content
3. Apply delta instructions sequentially
4. Cache intermediate results for efficiency

## Delta Compression Architecture

The package provides a composition-based delta compression system with clear separation of concerns.

### DeltaEngine Interface

The `DeltaEngine` orchestrates delta compression by combining a compressor, candidate finder, and decision strategy:

```typescript
interface DeltaEngine {
  findBestDelta(target: DeltaTarget): Promise<BestDeltaResult | null>;
  processBatch(targets: AsyncIterable<DeltaTarget>): AsyncIterable<DeltaProcessResult>;
}
```

The `DefaultDeltaEngine` implementation:
1. Checks if target should be deltified (via `DeltaDecisionStrategy`)
2. Finds candidate base objects (via `CandidateFinder`)
3. Computes deltas for each candidate (via `DeltaCompressor`)
4. Selects the best delta based on ratio/savings

### Component Interfaces

| Interface | Purpose | Key Methods |
|-----------|---------|-------------|
| `DeltaCompressor` | Pure delta algorithm | `computeDelta()`, `applyDelta()`, `estimateDeltaQuality()` |
| `CandidateFinder` | Find delta base candidates | `findCandidates()` returns similarity-ordered candidates |
| `DeltaDecisionStrategy` | Decide when to deltify | `shouldAttemptDelta()`, `shouldUseDelta()`, `maxChainDepth` |

### Pre-configured Strategies

The package provides factory functions for common use cases:

```typescript
import {
  createGitNativeStrategy,
  createBlobOnlyStrategy,
  createPackStrategy,
  createNetworkStrategy,
} from "@statewalker/vcs-core";

// Standard Git behavior - all object types, balanced thresholds
const gitStrategy = createGitNativeStrategy();

// Blobs only - higher compression ratio threshold (2.0)
const blobStrategy = createBlobOnlyStrategy();

// Aggressive - for pack file generation (1.1 ratio threshold)
const packStrategy = createPackStrategy();

// Network-optimized - balanced for streaming transfers
const networkStrategy = createNetworkStrategy();
```

### DeltaApi and BlobDeltaApi

The `DeltaApi` provides storage operations for delta-compressed objects:

```typescript
interface DeltaApi {
  blobs: BlobDeltaApi;
  isDelta(id: ObjectId): Promise<boolean>;
  getDeltaChain(id: ObjectId): Promise<BlobDeltaChainInfo | undefined>;
  listDeltas(): AsyncIterable<StorageDeltaRelationship>;
  getDependents(baseId: ObjectId): AsyncIterable<ObjectId>;
  startBatch(): void;
  endBatch(): Promise<void>;
}
```

The `BlobDeltaApi` handles blob-specific delta operations (trees and commits are not deltified):

```typescript
interface BlobDeltaApi {
  findBlobDelta(targetId, candidates): Promise<StreamingDeltaResult | null>;
  deltifyBlob(targetId, baseId, delta): Promise<void>;
  undeltifyBlob(id): Promise<void>;
  isBlobDelta(id): Promise<boolean>;
  getBlobDeltaChain(id): Promise<BlobDeltaChainInfo | undefined>;
}
```

## Garbage Collection

The `GCController` manages storage optimization through delta compression and unreachable object removal.

### GCController

```typescript
class GCController {
  // Track new blobs for quick-pack threshold
  onBlob(blobId: ObjectId): Promise<void>;

  // Lightweight deltification of pending blobs
  quickPack(): Promise<number>;

  // Check if GC should run based on thresholds
  shouldRunGC(): Promise<boolean>;

  // Run GC if thresholds are met
  maybeRunGC(options?: RepackOptions): Promise<RepackResult | null>;

  // Force GC run
  runGC(options?: RepackOptions): Promise<RepackResult>;

  // Remove blobs unreachable from roots
  collectGarbage(roots: ObjectId[], expire?: Date): Promise<GCResult>;
}
```

### Configuration

```typescript
interface GCScheduleOptions {
  deltaEngine: DeltaEngine;
  looseBlobThreshold?: number;  // Default: 100
  maxChainDepth?: number;       // Default: 50
  minInterval?: number;         // Default: 60000ms
  quickPackThreshold?: number;  // Default: 5
}
```

### GC Results

```typescript
interface RepackResult {
  objectsProcessed: number;
  deltasCreated: number;
  deltasRemoved: number;
  spaceSaved: number;
  duration: number;
}

interface GCResult {
  blobsRemoved: number;
  bytesFreed: number;
  durationMs: number;
}
```

### GC Workflow

1. **Quick Pack**: Triggered when `quickPackThreshold` loose blobs accumulate
   - Deltifies recent blobs using the DeltaEngine
   - Lightweight, runs frequently during writes

2. **Full GC**: Triggered when `looseBlobThreshold` is exceeded
   - Analyzes all blobs for delta opportunities
   - May recompute deltas for better compression
   - Respects `minInterval` to avoid repeated runs

3. **Garbage Collection**: On-demand removal of unreachable objects
   - Walks from provided root commits
   - Removes blobs not reachable from any root
   - Supports expiration time for safety

## Extension Points

### Implementing Custom Storage Backends

Create implementations of the core interfaces:

```typescript
class MyRawStorage implements RawStorage {
  async store(key: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    // Your storage logic
  }
  // ... other methods
}
```

Then compose higher-level stores using the provided implementations:

```typescript
const rawStorage = new MyRawStorage();
const objects = createGitObjectStore(rawStorage);
const commits = createCommits(objects);
```

### Custom Delta Strategies

Implement `CandidateFinder` for domain-specific delta base selection:

```typescript
interface CandidateFinder {
  findCandidates(target: DeltaTarget): AsyncIterable<DeltaCandidate>;
}
```

Built-in finders: `SizeSimilarityCandidateFinder`, `PathBasedCandidateFinder`, `CommitTreeCandidateFinder`, `WindowCandidateFinder`, `CompositeCandidateFinder` (combine with `combineFinders()`), `EmptyCandidateFinder`.

### Custom Ignore Rules

The `IgnoreManager` interface (in `@statewalker/vcs-working-tree`) allows custom ignore logic beyond `.gitignore`:

```typescript
interface IgnoreManager {
  isIgnored(path: string): boolean;
  addPattern(pattern: string): void;
}
```

## Performance Considerations

### Streaming Everything

Never buffer entire objects in memory. Use generators:

```typescript
async function* processContent(
  input: AsyncIterable<Uint8Array>
): AsyncIterable<Uint8Array> {
  for await (const chunk of input) {
    yield transform(chunk);
  }
}
```

### Lazy Loading

Load objects only when needed. The `has()` method checks existence without loading content.

### Delta Chain Limits

Configure `maxChainDepth` to balance compression ratio against reconstruction cost. Deep chains save space but slow random access.

### Packed Refs

Call `refs.optimize?.()` periodically to pack loose refs. Many loose ref files slow directory operations.

## Testing Patterns

### In-Memory Backend

Use `createMemoryHistory()` for in-memory tests:

```typescript
import { createMemoryHistory } from "@statewalker/vcs-core";

const history = createMemoryHistory();
await history.initialize();
// Tests run fast with no filesystem I/O
```

### Interface-Based Mocking

Since everything is interface-based, create focused mocks:

```typescript
const mockCommits: Commits = {
  store: vi.fn().mockResolvedValue("abc123"),
  load: vi.fn().mockResolvedValue(testCommit),
  // ...
};
```

### Parametrized Tests

The workspace-private `@statewalker/vcs-testing` package (`packages/testing`) provides test suites that verify any backend:

```typescript
import { createCommitStoreTests } from "@statewalker/vcs-testing";

createCommitStoreTests("MyCustomStorage", async () => ({
  commitStore: createCommits(createGitObjectStore(new MyRawStorage())),
  cleanup: async () => {},
}));
```
