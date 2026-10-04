/**
 * Transport test helpers for @statewalker/vcs-commands
 *
 * Provides test infrastructure for remote operations (fetch, push, clone, pull).
 * Uses an in-memory Git HTTP server for testing with createVcsRepositoryAccess.
 */

import {
  type Blobs,
  type Commits,
  DefaultSerializationApi,
  type GitObjectStore,
  type History,
  type HistoryWithOperations,
  isSymbolicRef,
  type ObjectId,
  type Refs,
  type SerializationApi,
  type Tags,
  type Trees,
} from "@statewalker/vcs-core";
import {
  createMemoryObjectStores,
  MemoryRefStore,
  MemoryStagingStore,
  MemoryTagStore,
} from "@statewalker/vcs-store-mem";
import {
  createFetchHandler,
  createRepositoryFacade,
  type RefStore,
} from "@statewalker/vcs-transport";
import type { Staging, WorkingCopy, Worktree } from "@statewalker/vcs-working-tree";

import { Git } from "../src/index.js";
import { testAuthor } from "./test-helper.js";

/**
 * Transport test store configuration.
 * Contains all the stores needed for transport operations.
 */
export interface TransportTestStores {
  /** Low-level Git object store for pack operations */
  objects: GitObjectStore;
  /** Blob storage */
  blobs: Blobs;
  /** Tree storage */
  trees: Trees;
  /** Commit storage */
  commits: Commits;
  /** Reference storage */
  refs: Refs;
  /** Tag storage */
  tags: Tags;
  /** Staging area */
  staging: Staging;
}

/**
 * Create transport test stores with Git-format object storage.
 *
 * All stores coordinate to use Git-format SHA-1 IDs, making this
 * compatible with createVcsRepositoryAccess.
 */
export function createTransportTestStores(): TransportTestStores {
  const objectStores = createMemoryObjectStores();
  return {
    blobs: objectStores.blobs,
    trees: objectStores.trees,
    commits: objectStores.commits,
    refs: new MemoryRefStore(),
    staging: new MemoryStagingStore(),
    tags: new MemoryTagStore(),
  };
}

/**
 * Create a minimal WorkingCopy from transport test stores.
 */
export function createWorkingCopyFromStores(stores: TransportTestStores): WorkingCopy {
  // Create a History-like wrapper
  const repository = {
    blobs: stores.blobs,
    trees: stores.trees,
    commits: stores.commits,
    tags: stores.tags,
    refs: stores.refs,
    async initialize() {},
    async close() {},
    isInitialized() {
      return true;
    },
    collectReachableObjects() {
      throw new Error("Not implemented in test helper");
    },
  } as unknown as History;

  return {
    history: repository as unknown as History,
    checkout: {
      staging: stores.staging,
    } as never,
    worktree: {} as unknown as Worktree,
    stash: {} as never,
    config: {} as never,
    async getHead() {
      const ref = await stores.refs.resolve("HEAD");
      return ref?.objectId;
    },
    async getCurrentBranch() {
      const ref = await stores.refs.get("HEAD");
      if (ref && "target" in ref) {
        return ref.target.replace("refs/heads/", "");
      }
      return undefined;
    },
    async setHead() {},
    async isDetachedHead() {
      return false;
    },
    async getMergeState() {
      return undefined;
    },
    async getRebaseState() {
      return undefined;
    },
    async getCherryPickState() {
      return undefined;
    },
    async getRevertState() {
      return undefined;
    },
    async hasOperationInProgress() {
      return false;
    },
    async getStatus() {
      return {
        files: [],
        staged: [],
        unstaged: [],
        untracked: [],
        isClean: true,
        hasStaged: false,
        hasUnstaged: false,
        hasUntracked: false,
        hasConflicts: false,
      };
    },
  } as unknown as WorkingCopy;
}

/**
 * Test server setup result.
 */
export interface TestServer {
  /** The Git HTTP server fetch function (for Request objects) */
  fetch: (request: Request) => Promise<Response>;
  /** Mock fetch function that can replace globalThis.fetch */
  mockFetch: typeof globalThis.fetch;
  /** Base URL for the server */
  baseUrl: string;
  /** The server-side stores */
  serverStores: TransportTestStores;
  /** The server-side WorkingCopy */
  serverWorkingCopy: WorkingCopy;
  /** The server-side Git facade */
  serverGit: Git;
}

/**
 * Create a mock fetch function from a test server.
 */
function createMockFetch(
  serverFetch: (request: Request) => Promise<Response>,
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    // The transport client may call this either Fetch-API style with a fully
    // formed Request (its current form: `fetch(new Request(url, { method, body, … }))`)
    // or as a (url, init) pair. A real `globalThis.fetch` honours a Request's own
    // method/headers/body, so forward it as-is; only build a Request when given a
    // url/init pair (dropping to `new Request(url, undefined)` here would lose the
    // POST + body and the server would 405).
    if (input instanceof Request && init === undefined) {
      return serverFetch(input);
    }
    let url: string;
    if (typeof input === "string") {
      url = input;
    } else if (input instanceof URL) {
      url = input.href;
    } else if (input instanceof Request) {
      url = input.url;
    } else {
      throw new Error(`Invalid fetch input: ${typeof input}`);
    }
    // Add duplex option when body is present (required by Node.js for streaming requests)
    const requestInit = init?.body ? { ...init, duplex: "half" } : init;
    const request = new Request(url, requestInit as RequestInit);
    return serverFetch(request);
  };
}

/**
 * Create a transport RefStore adapter from a vcs-core Refs.
 */
function createTransportRefStoreAdapter(refs: Refs): RefStore {
  return {
    async get(name: string): Promise<string | undefined> {
      const ref = await refs.resolve(name);
      return ref?.objectId;
    },

    async update(name: string, oid: string): Promise<void> {
      await refs.set(name, oid);
    },

    async listAll(): Promise<Iterable<[string, string]>> {
      const result: Array<[string, string]> = [];
      for await (const ref of refs.list()) {
        if (!isSymbolicRef(ref) && ref.objectId) {
          result.push([ref.name, ref.objectId]);
        }
      }
      return result;
    },

    async getSymrefTarget(name: string): Promise<string | undefined> {
      const ref = await refs.get(name);
      if (ref && isSymbolicRef(ref)) {
        return ref.target;
      }
      return undefined;
    },

    async isRefTip(oid: string): Promise<boolean> {
      for await (const ref of refs.list()) {
        if (!isSymbolicRef(ref) && ref.objectId === oid) {
          return true;
        }
      }
      return false;
    },
  };
}

/**
 * Create a mock HistoryWithOperations for transport tests.
 *
 * Wraps stores to provide the interface expected by createRepositoryFacade.
 */
function createMockHistoryWithOperations(
  stores: TransportTestStores,
  serialization: SerializationApi,
): HistoryWithOperations {
  // Stores already implement the new interfaces - just pass them through
  // with any necessary method adaptations
  const refsAdapter = {
    get: (name: string) => stores.refs.get(name),
    set: (name: string, oid: string) => stores.refs.set(name, oid),
    setSymbolic: (name: string, target: string) => stores.refs.setSymbolic(name, target),
    delete: (name: string) => stores.refs.remove(name),
    list: () => stores.refs.list(),
    resolve: (name: string) => stores.refs.resolve(name),
  };

  return {
    blobs: stores.blobs,
    trees: stores.trees,
    commits: stores.commits,
    tags: stores.tags,
    refs: refsAdapter,
    serialization,
    delta: {} as never,
    capabilities: {
      nativeBlobDeltas: false,
      nativeTreeDeltas: false,
      nativeCommitDeltas: false,
      randomAccess: false,
      atomicBatch: false,
      nativeGitFormat: false,
    },
    async initialize() {},
    async close() {},
    collectReachableObjects: async function* (wants: Set<string>, exclude: Set<string>) {
      // Proper implementation - traverse commit graph to find all reachable objects
      const visited = new Set<string>();

      async function* traverseTree(treeId: string): AsyncIterable<string> {
        if (visited.has(treeId) || exclude.has(treeId)) return;
        visited.add(treeId);
        yield treeId;

        // Traverse tree entries
        const treeEntries = await stores.trees.load(treeId);
        if (treeEntries) {
          for await (const entry of treeEntries) {
            if (entry.mode === 0o040000) {
              // Subtree
              yield* traverseTree(entry.id);
            } else {
              // Blob
              if (!visited.has(entry.id) && !exclude.has(entry.id)) {
                visited.add(entry.id);
                yield entry.id;
              }
            }
          }
        }
      }

      async function* traverseCommit(commitId: string): AsyncIterable<string> {
        if (visited.has(commitId) || exclude.has(commitId)) return;
        visited.add(commitId);
        yield commitId;

        const commit = await stores.commits.load(commitId);
        if (commit) {
          // Traverse tree
          yield* traverseTree(commit.tree);

          // Queue parents (don't recurse to avoid stack overflow)
          for (const parent of commit.parents) {
            if (!visited.has(parent) && !exclude.has(parent)) {
              yield* traverseCommit(parent);
            }
          }
        }
      }

      for (const want of wants) {
        if (exclude.has(want)) continue;

        // Try as commit first
        const commit = await stores.commits.load(want);
        if (commit) {
          yield* traverseCommit(want);
          continue;
        }

        // Try as tree
        const tree = await stores.trees.load(want);
        if (tree) {
          yield* traverseTree(want);
          continue;
        }

        // Try as blob
        if (await stores.blobs.has(want)) {
          if (!visited.has(want)) {
            visited.add(want);
            yield want;
          }
          continue;
        }

        // Try as tag
        const tag = await stores.tags.load(want);
        if (tag) {
          if (!visited.has(want)) {
            visited.add(want);
            yield want;
          }
        }
      }
    },
  } as unknown as HistoryWithOperations;
}

/**
 * Create a test HTTP server for Git operations.
 *
 * @param serverStores Optional pre-configured server stores
 * @returns Test server configuration
 */
export function createTestServer(serverStores?: TransportTestStores): TestServer {
  const stores = serverStores ?? createTransportTestStores();
  const workingCopy = createWorkingCopyFromStores(stores);

  // Create serialization API for pack operations
  const serialization = new DefaultSerializationApi({
    history: {
      blobs: stores.blobs,
      trees: stores.trees,
      commits: stores.commits,
      tags: stores.tags,
    },
  });

  // Create a mock HistoryWithOperations for the repository facade
  const mockHistory = createMockHistoryWithOperations(stores, serialization);

  // Create repository facade for transport operations
  const repository = createRepositoryFacade({
    history: mockHistory,
  });

  // Create transport ref store adapter
  const refStore = createTransportRefStoreAdapter(stores.refs);

  const serverFetch = createFetchHandler({
    async resolveRepository(repoPath) {
      if (repoPath) {
        return { repository, refStore };
      }
      return null;
    },
  });

  const baseUrl = "http://localhost:3000";

  return {
    fetch: serverFetch,
    mockFetch: createMockFetch(serverFetch),
    baseUrl,
    serverStores: stores,
    serverWorkingCopy: workingCopy,
    serverGit: Git.fromWorkingCopy(workingCopy),
  };
}

/**
 * Create an initialized test server with an initial commit.
 */
export async function createInitializedTestServer(): Promise<
  TestServer & { initialCommitId: string }
> {
  const stores = createTransportTestStores();
  const workingCopy = createWorkingCopyFromStores(stores);
  const git = Git.fromWorkingCopy(workingCopy);

  // Create and store empty tree
  const emptyTreeId = await stores.trees.store([]);

  // Create initial commit
  const initialCommit = {
    tree: emptyTreeId,
    parents: [] as string[],
    author: testAuthor(),
    committer: testAuthor(),
    message: "Initial commit",
  };

  const initialCommitId = await stores.commits.store(initialCommit);

  // Set up refs
  await stores.refs.set("refs/heads/main", initialCommitId);
  await stores.refs.setSymbolic("HEAD", "refs/heads/main");

  // Initialize staging
  await stores.staging.readTree(stores.trees, emptyTreeId);

  // Create serialization API for pack operations
  const serialization = new DefaultSerializationApi({
    history: {
      blobs: stores.blobs,
      trees: stores.trees,
      commits: stores.commits,
      tags: stores.tags,
    },
  });

  // Create a mock HistoryWithOperations for the repository facade
  const mockHistory = createMockHistoryWithOperations(stores, serialization);

  // Create repository facade for transport operations
  const repository = createRepositoryFacade({
    history: mockHistory,
  });

  // Create transport ref store adapter
  const refStore = createTransportRefStoreAdapter(stores.refs);

  const serverFetch = createFetchHandler({
    async resolveRepository(repoPath) {
      if (repoPath) {
        return { repository, refStore };
      }
      return null;
    },
  });

  const baseUrl = "http://localhost:3000";

  return {
    fetch: serverFetch,
    mockFetch: createMockFetch(serverFetch),
    baseUrl,
    serverStores: stores,
    serverWorkingCopy: workingCopy,
    serverGit: git,
    initialCommitId,
  };
}

/**
 * Create a Git URL for testing.
 */
export function createTestUrl(baseUrl: string, repoName = "test.git"): string {
  return `${baseUrl}/${repoName}`;
}

/**
 * HTTP client that routes requests through the test server.
 */
export function createTestFetch(server: TestServer): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // Add duplex option when body is present (required by Node.js for streaming requests)
    const requestInit = init?.body ? { ...init, duplex: "half" } : init;
    const request = new Request(url, requestInit as RequestInit);
    return server.fetch(request);
  };
}

/**
 * Add a file to a WorkingCopy and create a commit.
 *
 * This function stores objects in Git format, compatible with
 * transport operations.
 */
export async function addFileAndCommitWc(
  wc: WorkingCopy,
  path: string,
  content: string,
  message: string,
): Promise<ObjectId> {
  // Store blob
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const blobId = await wc.history.blobs.store([data]);

  // Update staging
  const staging = wc.checkout.staging as unknown as {
    createEditor?: () => { add(edit: unknown): void; finish(): Promise<void> };
    editor?: () => { add(edit: unknown): void; finish(): Promise<void> };
  };
  const editorFn = staging.createEditor ?? staging.editor;
  if (!editorFn) {
    throw new Error("Staging must have either createEditor() or editor() method");
  }
  const editor = editorFn.call(staging);
  editor.add({
    path,
    apply: () => ({
      path,
      mode: 0o100644,
      objectId: blobId,
      stage: 0,
      size: data.length,
      mtime: Date.now(),
    }),
  });
  await editor.finish();

  // Write tree
  const treeId = await wc.checkout.staging.writeTree(wc.history.trees);

  // Get parent
  let parents: ObjectId[] = [];
  try {
    const headRef = await wc.history.refs.resolve("HEAD");
    if (headRef?.objectId) {
      parents = [headRef.objectId];
    }
  } catch {
    // No HEAD yet
  }

  // Create commit
  const commit = {
    tree: treeId,
    parents,
    author: testAuthor(),
    committer: testAuthor(),
    message,
  };

  const commitId = await wc.history.commits.store(commit);

  // Update HEAD
  const head = await wc.history.refs.get("HEAD");
  if (head && "target" in head) {
    await wc.history.refs.set(head.target, commitId);
  } else {
    await wc.history.refs.set("HEAD", commitId);
  }

  // Update staging
  await wc.checkout.staging.readTree(wc.history.trees, treeId);

  return commitId;
}

/**
 * Add a file to stores and create a commit.
 *
 * This function stores objects in Git format, compatible with
 * createVcsRepositoryAccess.
 */
export async function addFileAndCommit(
  stores: TransportTestStores,
  path: string,
  content: string,
  message: string,
): Promise<ObjectId> {
  // Store blob using BlobStore (handles Git header automatically)
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const blobId = await stores.blobs.store([data]);

  // Update staging - handle both Staging (createEditor) and StagingStore (editor) interfaces
  const staging = stores.staging as unknown as {
    createEditor?: () => { add(edit: unknown): void; finish(): Promise<void> };
    editor?: () => { add(edit: unknown): void; finish(): Promise<void> };
  };
  const editorFn = staging.createEditor ?? staging.editor;
  if (!editorFn) {
    throw new Error("Staging must have either createEditor() or editor() method");
  }
  const editor = editorFn.call(staging);
  editor.add({
    path,
    apply: () => ({
      path,
      mode: 0o100644,
      objectId: blobId,
      stage: 0,
      size: data.length,
      mtime: Date.now(),
    }),
  });
  await editor.finish();

  // Write tree
  const treeId = await stores.staging.writeTree(stores.trees);

  // Get parent
  let parents: ObjectId[] = [];
  try {
    const headRef = await stores.refs.resolve("HEAD");
    if (headRef?.objectId) {
      parents = [headRef.objectId];
    }
  } catch {
    // No HEAD yet
  }

  // Create commit
  const commit = {
    tree: treeId,
    parents,
    author: testAuthor(),
    committer: testAuthor(),
    message,
  };

  const commitId = await stores.commits.store(commit);

  // Update HEAD
  const head = await stores.refs.get("HEAD");
  if (head && "target" in head) {
    await stores.refs.set(head.target, commitId);
  } else {
    await stores.refs.set("HEAD", commitId);
  }

  // Update staging
  await stores.staging.readTree(stores.trees, treeId);

  return commitId;
}
