# @statewalker/vcs-testing

Shared, parametrized Vitest suites that check a storage backend against the `@statewalker/vcs-core` and `@statewalker/vcs-working-tree` interfaces (blobs, trees, commits, tags, refs, staging, stash, worktree, raw storage, deltas), plus small byte helpers for writing such tests. Private to this workspace; not published.

## Why one set of suites for every backend

`@statewalker/vcs-store-mem`, `@statewalker/vcs-store-kv`, `@statewalker/vcs-store-sql` and `@statewalker/vcs-store-files` implement the same interfaces. Commands and the transport only see those interfaces, so every backend must behave the same way: same object ids for the same content, same errors for missing objects, same ref and index semantics. Each backend calls these suites from its own tests instead of keeping its own copy of the checks. The suites test behavior through the public interface only.

## How to use it

Add it as a dev dependency of a workspace package:

```json
{
  "devDependencies": {
    "@statewalker/vcs-testing": "workspace:^"
  }
}
```

`vitest` is a peer dependency. The `exports` entry points at `dist/`, so either build the package first (`pnpm --filter @statewalker/vcs-testing build`) or alias it to source in your `vitest.config.ts`, as the store packages do:

```typescript
{ find: "@statewalker/vcs-testing", replacement: path.resolve(import.meta.dirname, "../testing/src/index.ts") }
```

Every suite has the same shape: `createXxxTests(name, factory)`, where `factory` is `async () => context` and runs before each test. If the context has `cleanup`, it runs after each test.

| Suite | Context fields |
|-------|----------------|
| `createBlobStoreTests` | `blobStore: Blobs` |
| `createTreeStoreTests` | `treeStore: Trees` |
| `createCommitStoreTests` | `commitStore: Commits` |
| `createTagStoreTests` | `tagStore: Tags` |
| `createRefStoreTests` | `refStore: Refs` |
| `createGitObjectStoreTests` | `objectStore: GitObjectStore` |
| `createStagingStoreTests` | `stagingStore: Staging`, `trees?: Trees` |
| `createStashStoreTests` | `stashStore: StashStore`, `setupStagedChanges?` |
| `createWorktreeStoreTests` | `worktreeStore: Worktree`, `setupFiles?` |
| `createRawStorageTests` | `rawStorage: RawStorage` |
| `createVolatileStoreTests` | `volatileStore: VolatileStore` |
| `createDeltaApiTests` | `deltaApi: DeltaApi`, `createTestBlobs?` |
| `createStreamingStoresTests` | `stores: History` |
| `createGitCompatibilityTests` | `stores: History` |
| `createCrossBackendTests(backends)` | `[{ name, factory }]` of streaming-store factories; round-trips objects between every pair |

Helpers: `encode`, `decode`, `toAsyncIterable`, `toAsyncIterableMulti`, `collectContent`, `concatArrays`, `randomContent(size, seed?)`, `patternContent(size, pattern?)`, `allBytesContent()`.

## Examples

Run suites against a backend (modeled on `packages/store-mem/tests/memory-stores.test.ts`):

```typescript
import {
  createBlobStoreTests,
  createRefStoreTests,
  createStagingStoreTests,
} from "@statewalker/vcs-testing";
import {
  createMemoryObjectStores,
  MemoryRefStore,
  MemoryStagingStore,
  MemoryTreeStore,
} from "@statewalker/vcs-store-mem";

createBlobStoreTests("Memory", async () => ({ blobStore: createMemoryObjectStores().blobs }));
createRefStoreTests("Memory", async () => ({ refStore: new MemoryRefStore() }));
createStagingStoreTests("Memory", async () => ({
  stagingStore: new MemoryStagingStore(),
  trees: new MemoryTreeStore(),
}));
```

Use the helpers in your own tests:

```typescript
import { collectContent, randomContent, toAsyncIterable } from "@statewalker/vcs-testing";

const data = randomContent(1024); // deterministic for a given seed
const id = await blobs.store(toAsyncIterable(data));
const stream = await blobs.load(id); // undefined if missing
const back = stream ? await collectContent(stream) : undefined;
```

## Internals

### What will surprise you

- Optional context fields gate tests silently. `createStagingStoreTests` skips its tree tests (`writeTree`, `readTree`) when `trees` is missing; they pass without running. The field is `trees`, not `treeStore`.
- `createCheckoutStoreTests` is not exported; its suite file is disabled in `src/suites/index.ts`.
- The package has no tests of its own; `pnpm --filter @statewalker/vcs-testing test` passes with `--passWithNoTests`.

### Dependencies and why

- `@statewalker/vcs-core`, `@statewalker/vcs-working-tree`: the interfaces and helper types the suites test.
- `vitest` (peer): the suites call `describe`, `it`, `beforeEach`, `expect` directly, so they must share the consumer's Vitest instance.

### Commands

| Command | What it does |
|---------|--------------|
| `pnpm --filter @statewalker/vcs-testing build` | Bundle to `dist/` with rolldown and emit `.d.ts` |
| `pnpm --filter @statewalker/vcs-testing typecheck` | `tsc --noEmit` |
| `pnpm --filter @statewalker/vcs-testing lint` | `biome lint src` |
