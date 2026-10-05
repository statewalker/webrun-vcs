# StateWalker VCS

A TypeScript implementation of Git-compatible version control for browsers and Node.js.

## About

StateWalker VCS is a Git-compatible version control system that runs entirely in
JavaScript/TypeScript. It needs no native Git binary. Storage backends include in-memory,
file-backed (Git on-disk layout over a `FilesApi`), SQL (sql.js) and key-value stores (IndexedDB,
LocalStorage and similar).

## Features

- Full Git object model (blobs, trees, commits, tags, refs)
- Delta compression and pack files
- Index, checkout, status, merge, rebase, stash
- Git protocol v1/v2 fetch, push and clone over HTTP or any duplex stream (WebSocket, WebRTC)
- Git LFS batch protocol with whole-object and chunk-dedup (xet) transfer
- Multiple storage backends

## Links

- [GitHub Repository](https://github.com/statewalker/webrun-vcs)
- [Architecture Documentation](https://github.com/statewalker/webrun-vcs/blob/main/ARCHITECTURE.md)

## Quick Start

```bash
pnpm add @statewalker/vcs-commands @statewalker/vcs-core @statewalker/vcs-working-tree
```

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
const git = Git.fromWorkingCopy(createMemoryWorkingCopy({ history, checkout, worktree }));

await worktree.writeContent("README.md", new TextEncoder().encode("# Hello\n"));
await git.add().addFilepattern(".").call();
const commit = await git.commit().setMessage("Initial commit").call();
console.log(commit.id);
```
