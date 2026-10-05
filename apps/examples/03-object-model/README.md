# 03-object-model

## What it is

A step-by-step look at the four Git object types (blobs, trees, commits, annotated tags) and at refs, using the low-level `History` API of `@statewalker/vcs-core`. Five step scripts store objects in an in-memory history, read them back and print what they contain. Nothing is written to disk and nothing goes over the network.

## Layout

```
apps/examples/03-object-model/
├── package.json                # name: @statewalker/vcs-example-03-object-model
└── src/
    ├── main.ts                 # runs steps 1-5 in order on one shared history
    ├── shared.ts               # getHistory(), storeBlob(), readBlob(), mode helpers
    └── steps/
        ├── 01-blob-storage.ts
        ├── 02-tree-structure.ts
        ├── 03-commit-anatomy.ts
        ├── 04-tags.ts
        └── 05-deduplication.ts
```

The only runtime dependency is `@statewalker/vcs-core`.

## How to run it

Requires Node 24 and pnpm.

```bash
# from the repository root
pnpm install
pnpm --filter @statewalker/vcs-example-03-object-model start
```

Each step also runs on its own:

```bash
pnpm --filter @statewalker/vcs-example-03-object-model step:01  # blob storage
pnpm --filter @statewalker/vcs-example-03-object-model step:02  # tree structure
pnpm --filter @statewalker/vcs-example-03-object-model step:03  # commit anatomy
pnpm --filter @statewalker/vcs-example-03-object-model step:04  # tags
pnpm --filter @statewalker/vcs-example-03-object-model step:05  # deduplication
```

## The walk-through

[src/shared.ts](src/shared.ts) creates the history once and gives two helpers used throughout:

```typescript
import { createMemoryHistory, type History, type ObjectId } from "@statewalker/vcs-core";

const history = createMemoryHistory();
await history.initialize();

async function storeBlob(history: History, content: string): Promise<ObjectId> {
  return history.blobs.store([new TextEncoder().encode(content)]);
}

async function readBlob(history: History, id: ObjectId): Promise<string> {
  const stream = await history.blobs.load(id);
  if (!stream) throw new Error(`Blob not found: ${id}`);
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  // concatenate chunks, then decode
  ...
}
```

### Step 1: a blob is raw bytes, named by their hash

[src/steps/01-blob-storage.ts](src/steps/01-blob-storage.ts):

```typescript
const blobId = await storeBlob(history, "Hello, World! This is my first blob.");
const retrieved = await readBlob(history, blobId);
const size = await history.blobs.size(blobId); // 36
```

The id is the SHA-1 of `"blob <size>\0"` followed by the content, so it matches what `git hash-object` gives for the same bytes. A blob has no filename or mode; those live in the tree that points at it. `blobs.load()` returns the content as chunks, which `readBlob()` joins before decoding, because content may arrive in more than one chunk.

### Step 2: a tree is a list of (mode, name, id) entries

[src/steps/02-tree-structure.ts](src/steps/02-tree-structure.ts):

```typescript
import { FileMode } from "@statewalker/vcs-core";

const treeId = await history.trees.store([
  { mode: FileMode.REGULAR_FILE, name: "README.md", id: readmeId },
  { mode: FileMode.REGULAR_FILE, name: "index.js", id: indexId },
  { mode: FileMode.REGULAR_FILE, name: "package.json", id: packageId },
]);

const entries = await history.trees.load(treeId); // AsyncIterable<TreeEntry> | undefined
if (entries) {
  for await (const entry of entries) console.log(entry.mode, entry.name, entry.id);
}

// A subdirectory is an entry with FileMode.TREE pointing at another tree
const srcTreeId = await history.trees.store([
  { mode: FileMode.REGULAR_FILE, name: "index.js", id: indexId },
  { mode: FileMode.REGULAR_FILE, name: "utils.js", id: utilsId },
]);
const rootTreeId = await history.trees.store([
  { mode: FileMode.REGULAR_FILE, name: "README.md", id: readmeId },
  { mode: FileMode.REGULAR_FILE, name: "package.json", id: packageId },
  { mode: FileMode.TREE, name: "src", id: srcTreeId },
]);

const entry = await history.trees.getEntry(rootTreeId, "README.md");
```

| Mode     | Constant                   | Meaning          |
| -------- | -------------------------- | ---------------- |
| `040000` | `FileMode.TREE`            | Directory        |
| `100644` | `FileMode.REGULAR_FILE`    | Regular file     |
| `100755` | `FileMode.EXECUTABLE_FILE` | Executable file  |
| `120000` | `FileMode.SYMLINK`         | Symbolic link    |
| `160000` | `FileMode.GITLINK`         | Submodule        |

```
root tree 9366c3f
├── 100644 blob 17ca765  README.md
├── 100644 blob f455ce3  package.json
└── 040000 tree e84889e  src
                ├── 100644 blob db98c02  index.js
                └── 100644 blob ...      utils.js
```

### Step 3: a commit is a tree plus parents plus who and why

[src/steps/03-commit-anatomy.ts](src/steps/03-commit-anatomy.ts):

```typescript
const now = Date.now() / 1000;
const author = { name: "Alice Developer", email: "alice@example.com", timestamp: now, tzOffset: "-0500" };

const commitId = await history.commits.store({
  tree: treeId,
  parents: [], // initial commit
  author,
  committer: author,
  message: "Initial commit\n\nThis is the first commit in the repository.",
});

const commit = await history.commits.load(commitId);
if (!commit) throw new Error(`Commit not found: ${commitId}`);

const commit2Id = await history.commits.store({
  tree: treeV2Id,
  parents: [commitId], // links the second commit to the first
  author: { name: "Bob Developer", email: "bob@example.com", timestamp: now + 3600, tzOffset: "-0500" },
  committer: { name: "Bob Developer", email: "bob@example.com", timestamp: now + 3600, tzOffset: "-0500" },
  message: "Update README with version 2",
});

await history.refs.set("refs/heads/main", commit2Id);
```

A `Commit` has `tree`, `parents` (none for the first commit, one for a normal commit, two or more for a merge), `author`, `committer` and `message`, plus optional `encoding` and `gpgSignature`. `timestamp` is in seconds; `tzOffset` is a `"+HHMM"`/`"-HHMM"` string.

### Step 4: a lightweight tag is a ref; an annotated tag is an object

[src/steps/04-tags.ts](src/steps/04-tags.ts):

```typescript
import { ObjectType } from "@statewalker/vcs-core";

// Lightweight: a ref that points straight at the commit
await history.refs.set("refs/tags/v1.0.0", commitId);

// Annotated: a tag object, then a ref that points at the tag object
const tagId = await history.tags.store({
  object: commitId,
  objectType: ObjectType.COMMIT,
  tag: "v2.0.0",
  tagger: { name: "Release Manager", email: "release@example.com", timestamp: now, tzOffset: "+0000" },
  message: "Version 2.0.0 release\n\nThis is a major version with breaking changes.",
});
await history.refs.set("refs/tags/v2.0.0", tagId);

const tag = await history.tags.load(tagId); // { object, objectType, tag, tagger, message }
```

`ObjectType` codes are `COMMIT = 1`, `TREE = 2`, `BLOB = 3`, `TAG = 4`.

|             | Lightweight     | Annotated           |
| ----------- | --------------- | ------------------- |
| Stored as   | Ref only        | Tag object + ref    |
| Tagger      | No              | Yes                 |
| Message     | No              | Yes                 |
| Signature   | No              | Optional (`gpgSignature`) |

### Step 5: storing the same content twice stores it once

[src/steps/05-deduplication.ts](src/steps/05-deduplication.ts) stores one string three times and gets the same id each time, then stores five files of which three share content and counts three unique blobs:

```typescript
const id1 = await storeBlob(history, "Hello, World! This is some content.");
const id2 = await storeBlob(history, "Hello, World! This is some content.");
console.log(id1 === id2); // true
```

### What the output looks like

Excerpt from a real `start` run. Blob and tree ids are stable across runs; commit and tag ids are not.

```
--- Step 1: Blob Storage ---
  Content: "Hello, World! This is my first blob."
  Blob ID: 84a0f9880351631dfc38c6ec19bc36504342a3fe
  Object size: 36 bytes

--- Step 2: Tree Structure ---
  Tree entries (like 'git ls-tree'):
    100644 blob 17ca765  README.md
    100644 blob db98c02  index.js
    100644 blob f455ce3  package.json

--- Step 4: Tags ---
    v1.0.0 (lightweight): fabff1a
    v2.0.0 (annotated tag object): 7fc9bb8
    v2.0.0 (target commit): fabff1a

--- Step 5: Deduplication ---
  First store:  b603bc276cf5686b24ec3cc4073c0f9236282406
  Second store: b603bc276cf5686b24ec3cc4073c0f9236282406
  Third store:  b603bc276cf5686b24ec3cc4073c0f9236282406
```

## Why it is the way it is

- **The objects are built by hand.** No commands layer is involved, so every field that ends up in a blob, tree, commit or tag is visible in the code. For the same operations through `git.commit()` and `git.tag()`, see [02-porcelain-commands](../02-porcelain-commands/).
- **One history for `start`, a fresh one per `step:NN`.** `getHistory()` caches the history, so step 4 tags the commit that step 3 put on `refs/heads/main`. Run alone, step 4 finds no `main` and creates a "Release v1.0" commit first, so each step script also works by itself.
- **Ids are Git-compatible.** Objects are hashed with the same header and serialization as Git, so the same content gives the same SHA-1 here and in Git.

## What will surprise you

- **The printed `.git/objects/...` and `.git/refs/tags/...` paths do not exist.** Steps 1 and 4 print where Git would put these objects on disk, but this example uses an in-memory history and writes no files.
- **Resolving an annotated tag ref gives the tag object, not the commit.** `refs.resolve("refs/tags/v2.0.0")` returns the tag object id (`7fc9bb8` above); you reach the commit through `tags.load(tagId).object`. The step 4 heading "Both types of tags resolve to the same commit" refers to that second hop.
- **`load()` returns `undefined` for unknown ids** rather than throwing. The scripts turn that into `Blob not found: <id>`, `Commit not found: <id>` or `Tag not found: <id>`, print `Error:` and exit with code 1.
- **Commit and tag ids change on every run**, because they include the current time.

## Reference

| Script          | Runs                               |
| --------------- | ---------------------------------- |
| `start`         | `tsx src/main.ts` (all steps)      |
| `step:01`-`05`  | `tsx src/steps/NN-*.ts`            |
| `typecheck`     | `tsc --noEmit`                     |

| What | Where |
| ---- | ----- |
| `History` | [packages/vcs-core/src/history/history.ts](../../../packages/vcs-core/src/history/history.ts) |
| `Blobs` | [packages/vcs-core/src/history/blobs/](../../../packages/vcs-core/src/history/blobs/) |
| `Trees`, `TreeEntry` | [packages/vcs-core/src/history/trees/](../../../packages/vcs-core/src/history/trees/) |
| `Commits`, `Commit` | [packages/vcs-core/src/history/commits/](../../../packages/vcs-core/src/history/commits/) |
| `Tags`, `AnnotatedTag` | [packages/vcs-core/src/history/tags/](../../../packages/vcs-core/src/history/tags/) |
| `Refs` | [packages/vcs-core/src/history/refs/](../../../packages/vcs-core/src/history/refs/) |
| `ObjectType` | [packages/vcs-core/src/history/objects/object-types.ts](../../../packages/vcs-core/src/history/objects/object-types.ts) |

Previous: [01-quick-start](../01-quick-start/). Next: [04-branching-merging](../04-branching-merging/).
