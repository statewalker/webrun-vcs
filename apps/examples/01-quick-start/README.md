# 01-quick-start

## What it is

A single script that walks through the smallest useful Git workflow with the low-level `History` API of `@statewalker/vcs-core`: create an in-memory history, store a file as a blob, wrap it in a tree, commit it, point `refs/heads/main` at the commit, make a second commit, and walk the history back. Nothing touches the disk and nothing goes over the network.

## Layout

```
apps/examples/01-quick-start/
├── package.json     # name: @statewalker/vcs-example-01-quick-start
├── tsconfig.json
└── src/
    └── main.ts      # the whole example, top to bottom
```

The only runtime dependency is `@statewalker/vcs-core`.

## How to run it

Requires Node 24 and pnpm.

```bash
# from the repository root
pnpm install
pnpm --filter @statewalker/vcs-example-01-quick-start start
```

`start` runs `tsx src/main.ts`. `pnpm --filter @statewalker/vcs-example-01-quick-start typecheck` runs `tsc --noEmit`.

## The workflow, step by step

All code below is taken from [src/main.ts](src/main.ts).

### A history is five stores behind one object

`createMemoryHistory()` returns a `History` whose `blobs`, `trees`, `commits`, `tags` and `refs` live in memory. `initialize()` must be called before use.

```typescript
import { createMemoryHistory, FileMode, type History } from "@statewalker/vcs-core";

const history: History = createMemoryHistory();
await history.initialize();
await history.refs.setSymbolic("HEAD", "refs/heads/main");
```

`initialize()` already creates `HEAD -> refs/heads/main` when `HEAD` is missing, so the explicit `setSymbolic` call is there to show the API, not because it is required.

### File content is stored as a content-addressed blob

```typescript
const encoder = new TextEncoder();
const content = encoder.encode("# My Project\n\nWelcome to my first VCS project!");
const blobId = await history.blobs.store([content]);
```

`blobs.store()` takes an iterable or async iterable of `Uint8Array` chunks and returns the SHA-1 object id. The same bytes always give the same id, so storing a file twice stores it once. `blobs.load(id)` returns the content as an `AsyncIterable<Uint8Array>` (or `undefined` if missing), and `blobs.size(id)` returns its length.

### A tree is a directory snapshot of (mode, name, id) entries

```typescript
const treeId = await history.trees.store([
  { mode: FileMode.REGULAR_FILE, name: "README.md", id: blobId },
]);
```

`trees.load(id)` returns the entries as an async iterable; `trees.getEntry(treeId, name)` looks up one entry.

| Mode     | Constant                   | Meaning          |
| -------- | -------------------------- | ---------------- |
| `040000` | `FileMode.TREE`            | Directory        |
| `100644` | `FileMode.REGULAR_FILE`    | Regular file     |
| `100755` | `FileMode.EXECUTABLE_FILE` | Executable file  |
| `120000` | `FileMode.SYMLINK`         | Symbolic link    |
| `160000` | `FileMode.GITLINK`         | Submodule        |

### A commit links a tree to its parents

```typescript
const now = Date.now() / 1000;
const commitId = await history.commits.store({
  tree: treeId,
  parents: [], // empty for the first commit
  author: { name: "Developer", email: "dev@example.com", timestamp: now, tzOffset: "+0000" },
  committer: { name: "Developer", email: "dev@example.com", timestamp: now, tzOffset: "+0000" },
  message: "Initial commit",
});
```

`timestamp` is in seconds. The serializer floors it, so the fractional value from `Date.now() / 1000` is safe. `commits.load(id)` returns the `Commit` (`tree`, `parents`, `author`, `committer`, `message`).

### A branch is a ref that points at a commit

```typescript
await history.refs.set("refs/heads/main", commitId);

const headRef = await history.refs.resolve("HEAD");
console.log(`HEAD points to: ${headRef?.objectId?.slice(0, 7)}`);
```

`refs.resolve("HEAD")` follows the symbolic `HEAD` to `refs/heads/main` and returns a `Ref` whose `objectId` is the commit.

### History is walked from a commit back through its parents

The script then stores a second blob, tree and commit with `parents: [commitId]`, moves `refs/heads/main` to it, and walks back:

```typescript
for await (const id of history.commits.walkAncestry(commitId2)) {
  const c = await history.commits.load(id);
  if (c) console.log(`  - ${c.message}`);
}

await history.close();
```

`walkAncestry()` yields commit ids (not commit objects) and accepts `{ limit, stopAt, firstParentOnly }`.

### What the output looks like

From a real run (ids differ on every run, see below):

```
Repository initialized!
Blob stored: 3fb837f
Tree stored: e0a607d
Commit created: 20a8f97
Branch updated: refs/heads/main

HEAD points to: 20a8f97
Commit message: "Initial commit"
Commit tree: e0a607d

Second commit: a76b208

Commit history:
  - Add features section (parent: 20a8f97)
  - Initial commit (initial)

Quick Start completed successfully!
```

## Why it is the way it is

- **In-memory history.** `createMemoryHistory()` needs no directory, no cleanup and no permissions, so the example runs the same anywhere. Other backends implement the same `History` interface; only the factory changes.
- **Low-level API first.** The example builds blobs, trees and commits by hand so the object model is visible. The porcelain layer that does the same with `add`/`commit` is shown in [02-porcelain-commands](../02-porcelain-commands/).
- **HEAD is just a symbolic ref.** The `History` interface holds immutable objects and refs; the staging area and working directory live in other layers (`@statewalker/vcs-working-tree`).

## What will surprise you

- **Commit ids change on every run.** The commits use the current time, so `Commit created`, `HEAD points to` and `Second commit` differ between runs. The blob and tree ids (`3fb837f`, `e0a607d`) are stable because they depend only on content.
- **Nothing persists.** When the process exits, the repository is gone. There is no `.git` directory to inspect.
- **`load()` returns `undefined` for unknown ids** instead of throwing; the script guards with `if (commit)`.

## Reference

| What | Where |
| ---- | ----- |
| `History` interface | [packages/core/src/history/history.ts](../../../packages/core/src/history/history.ts) |
| `createMemoryHistory()` | [packages/core/src/history/create-history.ts](../../../packages/core/src/history/create-history.ts) |
| `Blobs` | [packages/core/src/history/blobs/](../../../packages/core/src/history/blobs/) |
| `Trees` | [packages/core/src/history/trees/](../../../packages/core/src/history/trees/) |
| `Commits` | [packages/core/src/history/commits/](../../../packages/core/src/history/commits/) |
| `Refs` | [packages/core/src/history/refs/](../../../packages/core/src/history/refs/) |

Next: [02-porcelain-commands](../02-porcelain-commands/) for the high-level commands API, [03-object-model](../03-object-model/) for a closer look at each object type.
