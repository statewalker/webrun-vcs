# @statewalker/vcs-store-files

File-backed storage backend for StateWalker VCS — reads and writes a standard on-disk `.git` directory (loose objects, packfiles, refs, index) over a `@statewalker/webrun-files` `FilesApi`.

## Overview

`@statewalker/vcs-store-files` implements the vcs-core storage seam against a filesystem (or any `FilesApi`), so a StateWalker repository is a real, native-git-compatible `.git` directory. It provides file-backed raw/pack object storage, refs, GC/repack, and a working-tree staging + worktree, plus convenience factories that assemble a `History` over a `.git` dir. It is a storage adapter over the `@statewalker/webrun-storage` seam — see [ADR-0001](../../docs/adr/0001-two-axis-architecture.md).

## Installation

```bash
pnpm add @statewalker/vcs-store-files
```

## Quick Start

```typescript
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { createGitFilesBackend } from "@statewalker/vcs-store-files";

// Open (or create) a real on-disk .git repository via a FilesApi
const files = new NodeFilesApi({ rootDir: "./my-repo" });
const { history, objects } = createGitFilesBackend(files, ".git");
await history.initialize();

// history.blobs / trees / commits / refs now read + write the .git directory,
// interoperable with the native `git` binary.
```

## API

- **`createGitFilesBackend(files, gitDir)`** — build a `History` + object store over an on-disk `.git`.
- **`createGitFilesHistoryWithOps(...)`** — a history bundled with maintenance operations (gc/repack).
- **`GitPackStore`, `FileRawStorage`** — file-backed packfile + raw (loose) object storage over `FilesApi`.
- **`FileStagingStore`, `createFileWorktree`** — filesystem-backed index/staging + worktree.
- **`gc` / `repack` / gc-strategy** — packfile garbage collection and repacking.
- **`refs`** — file-backed ref storage.

## Notes

- Backed entirely by `@statewalker/webrun-files` `FilesApi` — use `NodeFilesApi` on disk, or any FilesApi (browser, in-memory) for other environments.
- Produces the standard Git on-disk layout, so repositories interoperate with the native `git` binary (verified in the integration tests).
- Built red/green TDD.
