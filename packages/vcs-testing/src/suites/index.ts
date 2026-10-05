/**
 * Parametrized test suites for storage implementations
 *
 * These test suites verify implementations of the storage interfaces
 * defined in @statewalker/vcs-core.
 *
 * ## Standardized Test Factory Pattern
 *
 * All test suites follow a consistent factory pattern:
 *
 * ```typescript
 * // 1. Define a context interface with the store and optional cleanup
 * interface StoreTestContext<T> {
 *   store: T;
 *   cleanup?: () => Promise<void>;
 * }
 *
 * // 2. Define a factory type that creates context instances
 * type StoreFactory<T> = () => Promise<StoreTestContext<T>>;
 *
 * // 3. Create the test suite function
 * function createStoreTests(name: string, factory: StoreFactory<T>): void {
 *   describe(`Store [${name}]`, () => {
 *     let ctx: StoreTestContext<T>;
 *
 *     beforeEach(async () => {
 *       ctx = await factory();
 *     });
 *
 *     afterEach(async () => {
 *       await ctx.cleanup?.();
 *     });
 *
 *     // Test cases...
 *   });
 * }
 * ```
 *
 * ## Adding New Implementations
 *
 * To wire a new backend implementation to an existing test suite:
 *
 * ```typescript
 * import { createBlobStoreTests } from "@statewalker/vcs-testing";
 * import { MyBlobStore } from "./my-blob-store.js";
 *
 * createBlobStoreTests("MyBackend", async () => {
 *   const store = new MyBlobStore();
 *   return {
 *     blobStore: store,
 *     cleanup: async () => {
 *       await store.close();
 *     },
 *   };
 * });
 * ```
 *
 * ## Available Test Suites
 *
 * ### Core Store Suites
 * - `createBlobStoreTests` - BlobStore interface
 * - `createGitObjectStoreTests` - GitObjectStore interface
 * - `createCommitStoreTests` - CommitStore interface
 * - `createTreeStoreTests` - TreeStore interface
 * - `createTagStoreTests` - TagStore interface
 * - `createRefStoreTests` - RefStore interface
 *
 * ### Workspace Store Suites
 * - `createStagingStoreTests` - StagingStore interface
 * - `createCheckoutStoreTests` - CheckoutStore interface
 * - `createStashStoreTests` - StashStore interface
 * - `createWorktreeStoreTests` - WorktreeStore interface
 *
 * ### Storage Backend Suites
 * - `createRawStorageTests` - RawStorage interface
 * - `createVolatileStoreTests` - VolatileStore interface
 * - `createDeltaApiTests` - DeltaApi interface
 *
 * ### Combined/Integration Suites
 * - `createStreamingStoresTests` - All streaming stores together
 * - `createGitCompatibilityTests` - Git format compatibility
 * - `createCrossBackendTests` - Cross-backend roundtrip
 */

export * from "./blob-store.suite.js";
// Disabled: export * from "./checkout-store.suite.js";
export * from "./commit-store.suite.js";
export * from "./delta-api.suite.js";
export * from "./git-compatibility.suite.js";
export * from "./git-object-store.suite.js";
export * from "./raw-store.suite.js";
export * from "./ref-store.suite.js";
export * from "./staging-store.suite.js";
export * from "./stash-store.suite.js";
export * from "./streaming-stores.suite.js";
export * from "./tag-store.suite.js";
export * from "./tree-store.suite.js";
export * from "./volatile-store.suite.js";
export * from "./worktree-store.suite.js";
