# @statewalker/vcs-working-tree

The git working-tree layer — index/staging, status, checkout, ignore, worktree, and merge/transformation state — over `@statewalker/vcs-core`.

## Overview

`vcs-working-tree` is the git working-tree / versioning surface of Axis B: the mutable local state that sits over the immutable objects in `@statewalker/vcs-core`. It owns the **index/staging** area (git-compatible three-state semantics), **status** calculation (working ↔ index ↔ HEAD), **checkout**, **`.gitignore`** handling, the **worktree** filesystem view, and the **transformation** state for merge / rebase / cherry-pick / revert. It was extracted from `vcs-core` so the pure object model and the mutable working-tree logic live in separate packages.

It depends on `@statewalker/vcs-core` (objects/refs/index primitives) and `@statewalker/vcs-utils`, and — by design — **never** depends on `@statewalker/webrun-files-sync` (the hard Axis A ✗↔ Axis B ban). Memory implementations ship here; file-backed implementations live in `@statewalker/vcs-store-files`.

## Installation

```bash
pnpm add @statewalker/vcs-working-tree
```

## Quick Start

```typescript
import { createMemoryGitStaging } from "@statewalker/vcs-working-tree/staging";
import { createIgnoreManager, createStatusCalculator } from "@statewalker/vcs-working-tree";

// The git index as a staging area (in-memory).
const staging = createMemoryGitStaging();
await staging.setEntry({ path: "src/index.ts", mode: 0o100644, objectId, stage: 0 });
console.log(await staging.getEntryCount(), await staging.hasConflicts());

// .gitignore matching.
const ignore = createIgnoreManager();
ignore.addIgnoreFile("/", "node_modules/\n*.log\n");
ignore.isIgnored("node_modules/x", true); // true

// Status = 3-way diff of working ↔ index ↔ HEAD.
const status = createStatusCalculator({ staging, worktree, head });
const result = await status.calculateStatus({ includeUntracked: true });
```

## API

The package barrel re-exports the working-tree building blocks:

- **Staging / index** — `createGitStaging(files, indexPath)`, `createMemoryGitStaging()`, the `Staging` interface (`setEntry` / `getEntry` / `entries` / `writeTree` / `readTree` / `hasConflicts` / `resolveConflict` …), plus the DIRC `index-format` parser/serializer.
- **Status** — `createStatusCalculator(options)`, `StatusCalculator.calculateStatus(...)`, `FileStatus`, index-diff calculators.
- **Ignore** — `createIgnoreManager(options?)`, `createIgnoreNode`, `createIgnoreRule`.
- **Checkout** — `createMemoryCheckout(options)`, the `Checkout` interface.
- **Worktree** — `createMemoryWorktree(options)`, the `Worktree` interface.
- **Working copy** — `createMemoryWorkingCopy(options)` (links history + checkout + worktree + staging), `createMemoryStashStore()`, repository-state helpers.

### Sub-path exports

| Path | Contents |
|------|----------|
| `@statewalker/vcs-working-tree/staging` | Staging interface, git-index implementation, DIRC format |
| `@statewalker/vcs-working-tree/transformation` | merge / rebase / cherry-pick / revert state + `ResolutionStore` |

The `transformation` types are **not** re-exported from the root barrel (their names — `MergeState`, `RebaseState`, `ConflictInfo`, `ResolutionStrategy`, … — collide with staging and working-copy types); import them from the `/transformation` sub-path.

## Notes

- **Extracted from `vcs-core`.** Immutable object model stays in `vcs-core`; this package is the mutable working-tree half.
- **Index as a tree.** `status` is a 3-way diff (`staged` = index vs HEAD, `unstaged` = working vs index); merge applies a `merge-core` result into the index and surfaces conflicts.
- **Axis ban.** It never imports `files-sync`; cross-axis composition happens only in `@statewalker/vcs-workspace`.
- Memory-only implementations here; file-backed ones in `@statewalker/vcs-store-files`. Built red/green TDD.
