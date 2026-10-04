# StateWalker VCS

A TypeScript implementation of Git-compatible version control, designed for content-addressable storage with delta compression. This library enables reading and writing Git repositories directly in JavaScript environments, including browsers.

## Goal

StateWalker VCS provides a portable, streaming-oriented implementation of Git's core object model. It allows applications to work with Git repositories without relying on native Git binaries or specific file system APIs.

The library focuses on three main capabilities:

**Content-Addressable Storage** - Store and retrieve objects by their SHA-1 hash. Identical content automatically deduplicates, making storage efficient for version control workloads.

**Delta Compression** - Reduce storage requirements by computing and storing differences between similar objects. The implementation supports multiple delta strategies including rsync-style rolling checksums and Myers diff algorithm.

**Git Compatibility** - Read and write standard Git pack files, loose objects, and refs. Repositories created with StateWalker VCS work with native Git tools and vice versa.

## Architecture

The codebase is organized around a **two-axis architecture**. Axis A is the working-copy plane (file synchronisation); Axis B is the history plane (the Git object model, working tree, commands, and transport). A thin orchestration layer composes the two. Large objects (LFS/Xet) live on a separate transfer plane on top of a content-addressed store.

The authoritative design records are the ADRs — read these before making structural changes:

- [ADR-0001 — Two-Axis Architecture](docs/adr/0001-two-axis-architecture.md)
- [ADR-0002 — Transport Substrate](docs/adr/0002-transport-substrate.md)
- [ADR-0003 — Large-Object Plane](docs/adr/0003-large-object-plane.md)

## Package Structure

The monorepo contains 21 packages under `packages/`, grouped by role. Each package has its own `README.md` with details.

### Shared infrastructure

Domain-neutral building blocks, reusable outside VCS.

| Package | Directory | Role |
|---------|-----------|------|
| `@statewalker/webrun-merge` | [packages/webrun-merge](packages/webrun-merge) | Three-way merge/diff engine over the `webrun-files` FilesApi |
| `@statewalker/webrun-storage` | [packages/webrun-storage](packages/webrun-storage) | Byte-persistence seam (`BlobStore` + `KvStore` with CAS) |
| `@statewalker/webrun-content-store` | [packages/webrun-content-store](packages/webrun-content-store) | Content-addressed large-object store with content-defined chunking |
| `@statewalker/webrun-content-transfer` | [packages/webrun-content-transfer](packages/webrun-content-transfer) | Resumable, chunk-aware content transfer over `webrun-streams` |

### Axis A — working-copy plane

| Package | Directory | Role |
|---------|-----------|------|
| `@statewalker/webrun-files-sync` | [packages/webrun-files-sync](packages/webrun-files-sync) | rclone-like file-synchronisation engine (copy/sync/bisync/move/check) |

### Axis B — history plane

| Package | Directory | Role |
|---------|-----------|------|
| `@statewalker/vcs-core` | [packages/core](packages/core) | Core object model (blobs, trees, commits, tags), storage interfaces, and history management |
| `@statewalker/vcs-working-tree` | [packages/working-tree](packages/working-tree) | Index/staging, status, checkout, ignore, worktree, and merge/rebase operation state |
| `@statewalker/vcs-commands` | [packages/commands](packages/commands) | Git-like porcelain commands (commit, checkout, merge, diff, log) |
| `@statewalker/vcs-transport` | [packages/transport](packages/transport) | Git transport protocol (fetch, push, clone over HTTP/WebSocket/WebRTC) |
| `@statewalker/vcs-transport-lfs` | [packages/transport-lfs](packages/transport-lfs) | Standard Git LFS batch protocol + basic whole-object transfer |
| `@statewalker/vcs-transport-xet` | [packages/transport-xet](packages/transport-xet) | LFS custom transfer agent (Xet) — chunk-dedup transfer, falls back to basic LFS |

### Orchestration

| Package | Directory | Role |
|---------|-----------|------|
| `@statewalker/vcs-workspace` | [packages/workspace](packages/workspace) | Thin cross-axis orchestration (publish/update/checkpoint/restore) composing files-sync + working-tree + transport |

### Storage adapters

| Package | Directory | Role |
|---------|-----------|------|
| `@statewalker/vcs-store-mem` | [packages/store-mem](packages/store-mem) | In-memory backend for testing and development |
| `@statewalker/vcs-store-kv` | [packages/store-kv](packages/store-kv) | Key-value backend (IndexedDB, LocalStorage, LevelDB, …) |
| `@statewalker/vcs-store-sql` | [packages/store-sql](packages/store-sql) | SQL backend (better-sqlite3) |
| `@statewalker/vcs-store-files` | [packages/store-files](packages/store-files) | File-backed backend over a FilesApi |

### Utilities & development

| Package | Directory | Role |
|---------|-----------|------|
| `@statewalker/vcs-utils` | [packages/utils](packages/utils) | Hashing (SHA-1, CRC32), compression, delta encoding, streams |
| `@statewalker/vcs-utils-node` | [packages/utils-node](packages/utils-node) | Node.js-specific utilities: native compression, filesystem adapters |
| `@statewalker/vcs-transport-adapters` | [packages/transport-adapters](packages/transport-adapters) | Adapters bridging core interfaces to the transport layer |
| `@statewalker/vcs-testing` | [packages/testing](packages/testing) | Shared test utilities and fixtures |
| `@statewalker/vcs-integration-tests` | [packages/integration-tests](packages/integration-tests) | Cross-package integration tests (example apps as use-case tests) |

## Installation

```bash
# Install all dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test
```

## Usage

### Basic Repository Operations

The object model is exposed through the `History` interface. This condensed version mirrors [apps/examples/01-quick-start](apps/examples/01-quick-start):

```typescript
import { createMemoryHistory, FileMode, type History } from "@statewalker/vcs-core";

// Initialize an in-memory history
const history: History = createMemoryHistory();
await history.initialize();
await history.refs.setSymbolic("HEAD", "refs/heads/main");

// Store a file as a blob (content-addressable)
const content = new TextEncoder().encode("Hello, World!");
const blobId = await history.blobs.store([content]);

// Create a tree (directory snapshot)
const treeId = await history.trees.store([
  { mode: FileMode.REGULAR_FILE, name: "README.md", id: blobId },
]);

// Create a commit
const now = Date.now() / 1000;
const commitId = await history.commits.store({
  tree: treeId,
  parents: [],
  author: { name: "Alice", email: "alice@example.com", timestamp: now, tzOffset: "+0000" },
  committer: { name: "Alice", email: "alice@example.com", timestamp: now, tzOffset: "+0000" },
  message: "Initial commit",
});

// Update the branch reference
await history.refs.set("refs/heads/main", commitId);

await history.close();
```

> **Runnable example:** [apps/examples/01-quick-start/src/main.ts](apps/examples/01-quick-start/src/main.ts) — `pnpm --filter @statewalker/vcs-example-01-quick-start start`

### Using the Commands API

For a higher-level (porcelain) API, use `@statewalker/vcs-commands` with a working copy from `@statewalker/vcs-working-tree`:

```typescript
import { Git } from "@statewalker/vcs-commands";
import { createMemoryHistory } from "@statewalker/vcs-core";
import {
  createMemoryCheckout,
  createMemoryGitStaging,
  createMemoryWorkingCopy,
  createMemoryWorktree,
} from "@statewalker/vcs-working-tree";

// Compose the object store, staging, checkout, and worktree into a working copy
const history = createMemoryHistory();
await history.initialize();
await history.refs.setSymbolic("HEAD", "refs/heads/main");

const staging = createMemoryGitStaging();
const checkout = createMemoryCheckout({ staging });
const worktree = createMemoryWorktree({ blobs: history.blobs, trees: history.trees });
const workingCopy = createMemoryWorkingCopy({ history, checkout, worktree });

// Drive it through the Git facade
const git = Git.fromWorkingCopy(workingCopy);

// Stage files via the staging area, then commit / inspect
// (staging lives at workingCopy.checkout.staging)
const commit = await git.commit().setMessage("Initial commit").call();
const status = await git.status().call();
```

> **Runnable examples:** [apps/examples/02-porcelain-commands](apps/examples/02-porcelain-commands) (`pnpm --filter @statewalker/vcs-example-02-porcelain-commands start`) and [apps/examples/07-staging-checkout](apps/examples/07-staging-checkout) for the full staging/checkout flow.

### Delta Compression

The library uses format-agnostic delta storage for efficient pack files. The raw delta primitives live in `@statewalker/vcs-utils/diff`:

```typescript
import { applyDelta, createDelta, createDeltaRanges } from "@statewalker/vcs-utils/diff";

const baseContent = new TextEncoder().encode("Original file content");
const newContent = new TextEncoder().encode("Original file content with additions");

// Step 1: Compute delta ranges (identifies copy vs insert regions)
const ranges = [...createDeltaRanges(baseContent, newContent)];

// Step 2: Create delta instructions from ranges
const delta = [...createDelta(baseContent, newContent, ranges)];

// Step 3: Apply delta to reconstruct new content
const chunks = [...applyDelta(baseContent, delta)];
const reconstructed = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
let offset = 0;
for (const chunk of chunks) {
  reconstructed.set(chunk, offset);
  offset += chunk.length;
}
```

> **Runnable example:** [apps/examples/11-delta-strategies/src/main.ts](apps/examples/11-delta-strategies/src/main.ts) — `pnpm --filter @statewalker/vcs-example-11-delta-strategies start`

## Core Interfaces

### History - Immutable Repository Objects

The `History` interface provides unified access to content-addressed objects:

```typescript
interface History {
  readonly blobs: Blobs;     // File content (streaming)
  readonly trees: Trees;     // Directory snapshots
  readonly commits: Commits; // Version history with ancestry
  readonly tags: Tags;       // Annotated tags
  readonly refs: Refs;       // Branch/tag pointers

  initialize(): Promise<void>;
  close(): Promise<void>;
}
```

### Working copy - Mutable local state

The working-tree layer (`@statewalker/vcs-working-tree`) manages checkout state:

- **Staging**: index/staging area with conflict handling
- **Checkout**: HEAD management and operation state
- **Worktree**: working directory file access
- **WorkingCopy**: unified interface linking all three

### TransformationStore - Operation state

For multi-commit operations (merge, rebase, cherry-pick, revert):

```typescript
interface TransformationStore {
  readonly merge: MergeStateStore;
  readonly rebase: RebaseStateStore;
  readonly cherryPick: CherryPickStateStore;
  readonly revert: RevertStateStore;
  readonly resolution?: ResolutionStore;  // Conflict management with rerere
}
```

## Example Applications

The `apps/` directory holds three families of runnable programs. See [docs/example-applications.md](docs/example-applications.md) for detailed documentation of each.

### Examples — `apps/examples/` (tutorial progression, node)

Numbered tutorials, each run with `pnpm --filter @statewalker/vcs-example-<name> start`:

| # | Example | Focus |
|---|---------|-------|
| 01 | [quick-start](apps/examples/01-quick-start) | Object model in 5 minutes |
| 02 | [porcelain-commands](apps/examples/02-porcelain-commands) | Commands API: init, commit, branch, merge, log, status, tag, stash |
| 03 | [object-model](apps/examples/03-object-model) | Blobs, trees, commits, tags internals |
| 04 | [branching-merging](apps/examples/04-branching-merging) | Branch operations and merge strategies |
| 05 | [history-operations](apps/examples/05-history-operations) | Log, diff, blame, ancestry |
| 06 | [internal-storage](apps/examples/06-internal-storage) | Low-level object and pack operations |
| 07 | [staging-checkout](apps/examples/07-staging-checkout) | Working directory and staging area |
| 08 | [transport-basics](apps/examples/08-transport-basics) | Clone, fetch, push |
| 09 | [repository-access](apps/examples/09-repository-access) | Serving repositories over transport |
| 10 | [custom-storage](apps/examples/10-custom-storage) | Building storage backends from components |
| 11 | [delta-strategies](apps/examples/11-delta-strategies) | Storage optimization with the DeltaApi |

### Demos — `apps/demos/`

Real-world scenarios. Node demos run with `start`; browser demos run with `dev`/`build` (Vite). Package names are `@statewalker/vcs-demo-<name>` (see each `package.json`).

| Demo | Kind | Description |
|------|------|-------------|
| [browser-vcs-app](apps/demos/browser-vcs-app) | browser | VCS app with swappable storage backends |
| [git-cli-sandbox](apps/demos/git-cli-sandbox) | node | Git CLI sandbox over the porcelain API (WIP) |
| [git-workflow-complete](apps/demos/git-workflow-complete) | node | End-to-end workflow: init → commit → branch → merge → GC → checkout |
| [http-server-scratch](apps/demos/http-server-scratch) | node | Git HTTP server built from scratch, full clone/push cycle |
| [livekit-p2p-sync](apps/demos/livekit-p2p-sync) | browser | Browser VCS with LiveKit peer-to-peer sync |
| [offline-first-pwa](apps/demos/offline-first-pwa) | browser | Offline-first PWA with in-browser Git |
| [vcs-webrtc-sync](apps/demos/vcs-webrtc-sync) | browser | Browser VCS with WebRTC peer-to-peer sync |
| [versioned-documents](apps/demos/versioned-documents) | browser | Document versioning with DOCX/ODF decomposition |
| [webrtc-p2p-sync](apps/demos/webrtc-p2p-sync) | browser | WebRTC peer-to-peer sync with QR-code signaling |
| **[lfs-download-huggingface](apps/demos/lfs-download-huggingface)** | node | Downloads a real HuggingFace model's LFS object via the standard Git-LFS batch + basic transfer, SHA-256-verified |
| **[xet-transfer-huggingface](apps/demos/xet-transfer-huggingface)** | node | Chunk-dedup transfer of real HuggingFace model bytes over the Xet custom-transfer agent (loopback) |

The two HuggingFace demos exercise the large-object plane (ADR-0003): `lfs-download-huggingface` uses `@statewalker/vcs-transport-lfs` against HF's live LFS endpoint, and `xet-transfer-huggingface` uses `@statewalker/vcs-transport-xet` to move only the missing CDC chunks between two local content-stores.

Run a demo with, e.g.:

```bash
pnpm --filter @statewalker/vcs-demo-lfs-huggingface start   # node demo
pnpm --filter @statewalker/vcs-demo-browser-app dev         # browser demo
```

> **Build first.** The example and demo apps import the packages from their
> built output (`dist/`), so run `pnpm build` (all packages) once after
> `pnpm install` before starting any app. The browser demos use
> `@statewalker/webrun-files-browser`, which is likewise consumed from its
> built `dist` — a stale or missing build surfaces as an unresolved import at
> dev-server start.

### Benchmarks — `apps/benchmarks/` (node)

Run with `pnpm --filter @statewalker/vcs-benchmark-<name> start`:

| Benchmark | Measures |
|-----------|----------|
| [delta-compression](apps/benchmarks/delta-compression) | Delta encoding/decoding performance |
| [pack-operations](apps/benchmarks/pack-operations) | Pack file read/write performance |
| [real-repo-perf](apps/benchmarks/real-repo-perf) | Realistic Git workflow performance |

Run any example, for instance:

```bash
pnpm --filter @statewalker/vcs-example-01-quick-start start
```

## Cross-repo dependencies

This repository depends on:

| Repository | Packages used |
| --- | --- |
| [`webrun-files`](https://github.com/statewalker/webrun-files) | `@statewalker/webrun-files`, `@statewalker/webrun-files-browser`, `@statewalker/webrun-files-mem`, `@statewalker/webrun-files-node` |
| [`webrun-wire`](https://github.com/statewalker/webrun-wire) | `@statewalker/webrun-http-streams`, `@statewalker/webrun-streams`, `@statewalker/webrun-streams-livekit`, `@statewalker/webrun-streams-signaling` |

Cross-repo dependencies are declared `workspace:*` rather than `catalog:`. This is
deliberate: turbo derives its task graph from `workspace:` specifiers and does **not**
resolve `catalog:`, so a `catalog:` cross-repo dependency is invisible to the scheduler
and its consumer can be built before it.

## Development

```bash
# Build a specific package
pnpm --filter @statewalker/vcs-core build

# Run tests for a specific package
pnpm --filter @statewalker/vcs-core test

# Lint and format
pnpm lint
pnpm format
```

The project uses:
- **pnpm** for package management with workspaces
- **Turborepo** for build orchestration
- **Rolldown** for bundling
- **Vitest** for testing
- **Biome** for linting and formatting

## Requirements

- Node.js 18 or later
- pnpm 9.15.0 or later

## License

MIT
