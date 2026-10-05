# Example Applications

This document catalogs the runnable applications in the StateWalker VCS monorepo. They live under `apps/` in three families:

- **`apps/examples/`** — a numbered tutorial progression (01–11). Node programs, each run with `start`.
- **`apps/demos/`** — real-world scenarios. Node demos run with `start`; browser demos run with `dev`/`build` (Vite).
- **`apps/benchmarks/`** — performance benchmarks. Node programs, run with `start`.

Package names follow `@statewalker/vcs-example-<name>`, `@statewalker/vcs-demo-<name>`, and `@statewalker/vcs-benchmark-<name>`. Confirm the exact name and scripts in each app's `package.json`.

## Quick Reference

| Application | Family | Purpose |
|-------------|--------|---------|
| [01-quick-start](#01-quick-start) | example | Object model in 5 minutes |
| [02-porcelain-commands](#02-porcelain-commands) | example | Full workflow via the Commands API |
| [03-object-model](#03-object-model) | example | Blobs, trees, commits, tags internals |
| [04-branching-merging](#04-branching-merging) | example | Branch operations and merge strategies |
| [05-history-operations](#05-history-operations) | example | Log, diff, blame, ancestry |
| [06-internal-storage](#06-internal-storage) | example | Loose objects, packs, GC, deltas |
| [07-staging-checkout](#07-staging-checkout) | example | Working directory and staging area |
| [08-transport-basics](#08-transport-basics) | example | List refs, clone, fetch over HTTP |
| [09-repository-access](#09-repository-access) | example | Serving repositories over transport |
| [10-custom-storage](#10-custom-storage) | example | Building storage backends from components |
| [11-delta-strategies](#11-delta-strategies) | example | Storage optimization with the DeltaApi |
| [browser-vcs-app](#browser-vcs-app) | demo | Browser VCS with swappable storage |
| [git-cli-sandbox](#git-cli-sandbox) | demo | Git CLI over the porcelain API |
| [git-workflow-complete](#git-workflow-complete) | demo | End-to-end porcelain workflow |
| [http-server-scratch](#http-server-scratch) | demo | Git HTTP server from scratch |
| [livekit-p2p-sync](#livekit-p2p-sync) | demo | LiveKit peer-to-peer sync |
| [offline-first-pwa](#offline-first-pwa) | demo | Offline-first PWA |
| [vcs-webrtc-sync](#vcs-webrtc-sync) | demo | WebRTC peer-to-peer sync |
| [versioned-documents](#versioned-documents) | demo | DOCX/ODF document versioning |
| [webrtc-p2p-sync](#webrtc-p2p-sync) | demo | WebRTC sync with QR signaling |
| [lfs-download-huggingface](#lfs-download-huggingface) | demo | Real HuggingFace LFS download (SHA-256-verified) |
| [xet-transfer-huggingface](#xet-transfer-huggingface) | demo | Xet chunk-dedup transfer of HF bytes |
| [delta-compression](#delta-compression) | benchmark | Delta encode/decode performance |
| [pack-operations](#pack-operations) | benchmark | Pack read/write performance |
| [real-repo-perf](#real-repo-perf) | benchmark | Realistic workflow performance |

---

## Examples

Numbered tutorials that build understanding from the object model up to transport and custom storage. Each runs standalone; the multi-step ones also expose `step:NN` scripts.

### 01-quick-start

**Location:** [apps/examples/01-quick-start](../apps/examples/01-quick-start)

The five-minute introduction. Initializes an in-memory `History`, stores a blob, builds a tree, makes two commits, updates `refs/heads/main`, and walks the ancestry — the whole object-model loop in one file.

```bash
pnpm --filter @statewalker/vcs-example-01-quick-start start
```

### 02-porcelain-commands

**Location:** [apps/examples/02-porcelain-commands](../apps/examples/02-porcelain-commands)

The complete Git workflow through the porcelain `Git` facade (`@statewalker/vcs-commands`) over an in-memory working copy: init and commit, branching, checkout, merge, log/diff, status, tag, and stash — one `step:NN` per topic.

```bash
pnpm --filter @statewalker/vcs-example-02-porcelain-commands start
pnpm --filter @statewalker/vcs-example-02-porcelain-commands step:04   # merge
```

### 03-object-model

**Location:** [apps/examples/03-object-model](../apps/examples/03-object-model)

A deep look at Git's internal object model: blob storage, tree structure, commit anatomy, tags, and content-addressed deduplication.

```bash
pnpm --filter @statewalker/vcs-example-03-object-model start
```

### 04-branching-merging

**Location:** [apps/examples/04-branching-merging](../apps/examples/04-branching-merging)

Branch operations and merge strategies: branch creation, HEAD management, fast-forward and three-way merges, merge strategies, conflict handling, and rebase concepts.

```bash
pnpm --filter @statewalker/vcs-example-04-branching-merging start
```

### 05-history-operations

**Location:** [apps/examples/05-history-operations](../apps/examples/05-history-operations)

Reading repository history: log traversal, commit ancestry, diffing commits, blame, and per-file history.

```bash
pnpm --filter @statewalker/vcs-example-05-history-operations start
```

### 06-internal-storage

**Location:** [apps/examples/06-internal-storage](../apps/examples/06-internal-storage)

Low-level object and pack operations for application integration: loose objects, pack files, garbage collection, direct content-addressable storage, and delta internals.

```bash
pnpm --filter @statewalker/vcs-example-06-internal-storage start
```

### 07-staging-checkout

**Location:** [apps/examples/07-staging-checkout](../apps/examples/07-staging-checkout)

Working directory and staging area operations: staging concepts, staging and unstaging changes, status, checking out files and branches, and clean/reset. Staging is accessed at `workingCopy.checkout.staging`.

```bash
pnpm --filter @statewalker/vcs-example-07-staging-checkout start
```

### 08-transport-basics

**Location:** [apps/examples/08-transport-basics](../apps/examples/08-transport-basics)

Git transport over the HTTP smart protocol against a real remote (`octocat/Hello-World`): listing remote refs (`lsRemote`), cloning, and fetching updates via `@statewalker/vcs-transport`.

```bash
pnpm --filter @statewalker/vcs-example-08-transport-basics start
```

### 09-repository-access

**Location:** [apps/examples/09-repository-access](../apps/examples/09-repository-access)

Exposing a repository for transport: build a `RepositoryAccess`/`RepositoryFacade` from a `History`, adapt core `Refs` to the transport `RefStore`, and serve/fetch over a duplex channel with `serveOverDuplex`/`fetchOverDuplex`.

```bash
pnpm --filter @statewalker/vcs-example-09-repository-access start
```

### 10-custom-storage

**Location:** [apps/examples/10-custom-storage](../apps/examples/10-custom-storage)

Building `History` instances from components: `createMemoryHistory()`, `createMemoryHistoryWithOperations()`, `createHistoryFromComponents()` with raw storage + object store, and `createHistoryFromStores()` with explicit stores — plus the `HistoryWithOperations` vs `History` distinction.

```bash
pnpm --filter @statewalker/vcs-example-10-custom-storage start
```

### 11-delta-strategies

**Location:** [apps/examples/11-delta-strategies](../apps/examples/11-delta-strategies)

Storage optimization with the `DeltaApi`: inspecting delta state and chains, batch (atomic) repacking, and the low-level delta primitives (`createDeltaRanges`, `createDelta`, `applyDelta`) from `@statewalker/vcs-utils/diff`.

```bash
pnpm --filter @statewalker/vcs-example-11-delta-strategies start
```

---

## Demos

Scenario-driven applications. Node demos print to the console; browser demos are Vite apps served with `dev`.

### browser-vcs-app

**Location:** [apps/demos/browser-vcs-app](../apps/demos/browser-vcs-app) — **browser**

A browser-based VCS application with swappable storage backends, demonstrating the library running fully in-page.

```bash
pnpm --filter @statewalker/vcs-demo-browser-app dev
```

### git-cli-sandbox

**Location:** [apps/demos/git-cli-sandbox](../apps/demos/git-cli-sandbox) — **node**

A Git CLI sandbox (init, clone, add, rm, status, commit, branch, checkout, merge, log, diff, remote, and fetch/pull/push over HTTP) built on the VCS porcelain API over a file-backed store (`@statewalker/vcs-store-files`).

```bash
pnpm --filter @statewalker/vcs-demo-git-cli-sandbox start
```

### git-workflow-complete

**Location:** [apps/demos/git-workflow-complete](../apps/demos/git-workflow-complete) — **node**

An end-to-end workflow using **only** porcelain commands: `Git.init`, `add`, `commit`, `checkout`, `merge`, `log`, `diff`, `gc`, and `status` — no low-level or native Git. Nine `step:NN` scripts break it down.

```bash
pnpm --filter @statewalker/vcs-demo-git-workflow-complete start
```

### http-server-scratch

**Location:** [apps/demos/http-server-scratch](../apps/demos/http-server-scratch) — **node**

Builds a Git HTTP server from scratch (no `git http-backend`) and drives a full roundtrip: create a remote with VCS, serve it, clone with VCS transport, verify with native git, commit + branch, push, and verify again. Listens on port 8080 by default (`start -- --port 9000` to change it) and needs native `git` on `PATH` for the verification steps.

```bash
pnpm --filter @statewalker/vcs-demo-http-server-scratch start
```

### livekit-p2p-sync

**Location:** [apps/demos/livekit-p2p-sync](../apps/demos/livekit-p2p-sync) — **browser**

Browser VCS with LiveKit peer-to-peer synchronization between clients.

```bash
pnpm --filter @statewalker/vcs-demo-livekit-p2p-sync dev
```

### offline-first-pwa

**Location:** [apps/demos/offline-first-pwa](../apps/demos/offline-first-pwa) — **browser**

An offline-first Progressive Web App performing Git operations entirely in the browser.

```bash
pnpm --filter @statewalker/vcs-demo-offline-pwa dev
```

### vcs-webrtc-sync

**Location:** [apps/demos/vcs-webrtc-sync](../apps/demos/vcs-webrtc-sync) — **browser**

Browser VCS with WebRTC peer-to-peer synchronization.

```bash
pnpm --filter @statewalker/vcs-demo-webrtc-sync dev
```

### versioned-documents

**Location:** [apps/demos/versioned-documents](../apps/demos/versioned-documents) — **browser**

Document versioning in the browser, decomposing DOCX/ODF files so their internal parts version and diff meaningfully.

```bash
pnpm --filter @statewalker/vcs-demo-versioned-documents dev
```

### webrtc-p2p-sync

**Location:** [apps/demos/webrtc-p2p-sync](../apps/demos/webrtc-p2p-sync) — **browser**

WebRTC peer-to-peer Git synchronization with QR-code signaling for connecting peers.

```bash
pnpm --filter @statewalker/vcs-demo-webrtc-p2p-sync dev
```

### lfs-download-huggingface

**Location:** [apps/demos/lfs-download-huggingface](../apps/demos/lfs-download-huggingface) — **node**

Downloads a real HuggingFace model's large object (`pytorch_model.bin` from `hf-internal-testing/tiny-random-gpt2`) over the **standard Git-LFS batch + basic (whole-object) transfer** using `@statewalker/vcs-transport-lfs`. Runs live against huggingface.co: it reads and parses the LFS pointer, `lfsDownload(...)` streams the bytes into a content-store while verifying SHA-256 == oid, then the demo independently re-verifies the whole-file SHA-256 and byte length. Part of the large-object plane (ADR-0003).

```bash
pnpm --filter @statewalker/vcs-demo-lfs-huggingface start
```

### xet-transfer-huggingface

**Location:** [apps/demos/xet-transfer-huggingface](../apps/demos/xet-transfer-huggingface) — **node**

Demonstrates the **Xet custom transfer agent** (`@statewalker/vcs-transport-xet`), which negotiates a `xet` transfer in the standard LFS batch and moves only the missing CDC chunks via `@statewalker/webrun-content-transfer`. Because HuggingFace's production Xet uses a different wire protocol, this demo fetches real HF model bytes once (standard LFS) and then transfers them between two local content-stores over an in-process **loopback** (`serveXet` ↔ `xetDownload`), proving via a `putChunk` spy that only the missing chunks move and re-verifying the reconstructed object's SHA-256. Also shows the basic-LFS fallback path.

```bash
pnpm --filter @statewalker/vcs-demo-xet-huggingface start
```

---

## Benchmarks

Performance measurements. Each writes results to the console.

### delta-compression

**Location:** [apps/benchmarks/delta-compression](../apps/benchmarks/delta-compression)

Measures delta encoding and decoding performance across file sizes and mutation rates, using the `@statewalker/vcs-utils/diff` primitives.

```bash
pnpm --filter @statewalker/vcs-benchmark-delta-compression start
```

### pack-operations

**Location:** [apps/benchmarks/pack-operations](../apps/benchmarks/pack-operations)

Measures pack file writing and reading performance (`writePack`, `writePackIndex`, `readPackIndex`).

```bash
pnpm --filter @statewalker/vcs-benchmark-pack-operations start
```

### real-repo-perf

**Location:** [apps/benchmarks/real-repo-perf](../apps/benchmarks/real-repo-perf)

Simulates realistic Git workflows over low-level repository operations, measuring initialization, object storage, history traversal, and reference operations.

```bash
pnpm --filter @statewalker/vcs-benchmark-real-repo-perf start
```

---

## Related Documentation

- [ADR-0001 — Two-Axis Architecture](adr/0001-two-axis-architecture.md) — the authoritative design
- [ADR-0002 — Transport Substrate](adr/0002-transport-substrate.md)
- [ADR-0003 — Large-Object Plane](adr/0003-large-object-plane.md) — LFS/Xet
- [Package Dependencies](package-dependencies.md) — package relationship diagram
- [ARCHITECTURE.md](../ARCHITECTURE.md) — system architecture overview
- [README.md](../README.md) — getting started guide
