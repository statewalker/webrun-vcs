/**
 * Integration tests for the Open Repository intent flow.
 *
 * Tests:
 * - Controller dispatches intent on repo:open action
 * - Handler resolves with MemFilesApi
 * - Git infrastructure initializes from FilesApi
 * - Repository model updates after opening
 * - Commits and files work with file-backed storage
 */

import { Git } from "@statewalker/vcs-commands";
import type { History, SerializationApi } from "@statewalker/vcs-core";
import { createMemoryHistory, DefaultSerializationApi } from "@statewalker/vcs-core";
import {
  createMemoryGitStaging,
  MemoryCheckout,
  MemoryWorkingCopy,
  MemoryWorktree,
} from "@statewalker/vcs-working-tree";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// Mock window.location for Node.js environment
beforeAll(() => {
  if (typeof globalThis.window === "undefined") {
    (globalThis as unknown as { window: unknown }).window = {
      location: {
        origin: "http://localhost:3000",
        pathname: "/",
      },
    };
  }
});

import {
  enqueueAddFileAction,
  enqueueInitRepoAction,
  enqueueOpenRepoAction,
  enqueueRefreshRepoAction,
} from "../src/actions/index.js";
import { MockTimerApi, setTimerApi } from "../src/apis/index.js";
import {
  MemoryConnectionProvider,
  MemoryPeerRegistry,
} from "../src/apis/memory-connection-provider.js";
import type { AppContext } from "../src/controllers/index.js";
import {
  createRepositoryController,
  getGit,
  getHistory,
  getIntents,
  getStorageLabel,
  setConnectionProvider,
  setGit,
  setHistory,
  setSerializationApi,
  setWorkingCopy,
  setWorktree,
} from "../src/controllers/index.js";
import { handleOpenRepositoryIntent } from "../src/intents/index.js";
import {
  getActivityLogModel,
  getRepositoryModel,
  getUserActionsModel,
} from "../src/models/index.js";

function createSerializationApi(history: History): SerializationApi {
  return new DefaultSerializationApi({ history });
}

/**
 * Create a test context with in-memory Git infrastructure.
 */
async function createTestAppContext(registry: MemoryPeerRegistry): Promise<AppContext> {
  const ctx: AppContext = {};

  // Initialize Git infrastructure using Three-Part Architecture
  const history = createMemoryHistory();
  await history.initialize();
  await history.refs.setSymbolic("HEAD", "refs/heads/main");
  setHistory(ctx, history);

  const staging = createMemoryGitStaging();
  const checkout = new MemoryCheckout({
    staging,
    initialHead: { type: "symbolic", target: "refs/heads/main" },
  });

  const worktree = new MemoryWorktree({
    blobs: history.blobs,
    trees: history.trees,
  });
  setWorktree(ctx, worktree);

  const workingCopy = new MemoryWorkingCopy({
    history,
    checkout,
    worktree,
  });
  setWorkingCopy(ctx, workingCopy);

  const git = Git.fromWorkingCopy(workingCopy);
  setGit(ctx, git);

  const serialization = createSerializationApi(history);
  setSerializationApi(ctx, serialization);

  setConnectionProvider(ctx, new MemoryConnectionProvider(registry));
  setTimerApi(ctx, new MockTimerApi());

  return ctx;
}

/**
 * Wait for async operations to complete.
 */
async function flushPromises(iterations = 10): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface SubscribableModel {
  onUpdate(callback: () => void): () => void;
}

async function waitModel<M extends SubscribableModel>(
  model: M,
  check: (model: M) => boolean,
  timeout = 5000,
): Promise<void> {
  if (check(model)) return;

  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    unsubscribe = model.onUpdate(() => {
      if (check(model)) {
        cleanup();
        resolve();
      }
    });

    timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error(`waitModel timeout: condition not satisfied within ${timeout}ms`));
    }, timeout);

    if (check(model)) {
      cleanup();
      resolve();
    }
  });
}

describe("Open Repository Intent", () => {
  let registry: MemoryPeerRegistry;
  let ctx: AppContext;
  let controllerCleanup: () => void;
  let intentCleanup: () => void;

  beforeEach(async () => {
    registry = new MemoryPeerRegistry();
    ctx = await createTestAppContext(registry);

    // Register test intent handler: always resolves with MemFilesApi
    const intents = getIntents(ctx);
    intentCleanup = handleOpenRepositoryIntent(intents, (intent) => {
      intent.resolve({ files: new MemFilesApi(), label: "test-memory" });
      return true;
    });

    controllerCleanup = createRepositoryController(ctx);
  });

  afterEach(() => {
    controllerCleanup();
    intentCleanup();
    registry.reset();
  });

  it("should dispatch intent on repo:open action and initialize git from files", async () => {
    const actionsModel = getUserActionsModel(ctx);
    const logModel = getActivityLogModel(ctx);

    // Trigger repo:open action
    enqueueOpenRepoAction(actionsModel);
    await flushPromises(20);

    // Verify the intent resolved and git infrastructure was set up
    const logs = logModel.getEntries();
    const openLog = logs.find((e) => e.message.includes("Opened repository: test-memory"));
    expect(openLog).toBeDefined();

    // Verify storage label was set
    const label = getStorageLabel(ctx);
    expect(label).toBe("test-memory");

    // Verify git is operational — we should be able to write files and commit
    const history = getHistory(ctx);
    expect(history).not.toBeNull();

    const git = getGit(ctx);
    expect(git).not.toBeNull();
  });

  it("should allow creating commits after opening file-backed repository", async () => {
    const actionsModel = getUserActionsModel(ctx);
    const repoModel = getRepositoryModel(ctx);

    // Open repository via intent
    enqueueOpenRepoAction(actionsModel);
    await flushPromises(20);

    // Initialize the repo (creates initial commit)
    enqueueInitRepoAction(actionsModel);
    await waitModel(repoModel, (m) => m.getState().initialized, 5000);

    expect(repoModel.getState().commitCount).toBe(1);
    expect(repoModel.getState().branch).toBe("main");

    // Add more files
    enqueueAddFileAction(actionsModel, {
      name: "test-file.txt",
      content: "Hello from file-backed repo!",
    });
    await waitModel(repoModel, (m) => m.getState().commitCount === 2, 5000);

    expect(repoModel.getState().commitCount).toBe(2);

    // Verify file appears in the repository
    const files = repoModel.getState().files.filter((f) => f.type === "file");
    const testFile = files.find((f) => f.name === "test-file.txt");
    expect(testFile).toBeDefined();
  });

  it("should open an existing repository with commits", async () => {
    const actionsModel = getUserActionsModel(ctx);
    const logModel = getActivityLogModel(ctx);

    // Create a pre-populated MemFilesApi with a git repository
    const preparedFiles = new MemFilesApi();

    // First, open with prepared files by registering a custom handler
    intentCleanup(); // Remove the default handler
    const intents = getIntents(ctx);
    intentCleanup = handleOpenRepositoryIntent(intents, (intent) => {
      intent.resolve({ files: preparedFiles, label: "prepared-repo" });
      return true;
    });

    // Open the repo (will create .git structure since it's empty)
    enqueueOpenRepoAction(actionsModel);
    await flushPromises(20);

    // Now init and create commits in this file-backed repo
    enqueueInitRepoAction(actionsModel);
    await flushPromises(30);

    enqueueAddFileAction(actionsModel, {
      name: "persistent-file.txt",
      content: "This file lives in FilesApi storage",
    });
    await flushPromises(30);

    // Verify the file exists in the FilesApi
    const gitDirExists = await preparedFiles.exists(".git");
    expect(gitDirExists).toBe(true);

    const objectsDirExists = await preparedFiles.exists(".git/objects");
    expect(objectsDirExists).toBe(true);

    // Now "re-open" the same prepared files (simulating page reload)
    enqueueOpenRepoAction(actionsModel);
    await flushPromises(20);

    const logs = logModel.getEntries();
    const reopenLog = logs.filter((e) => e.message.includes("Opened repository: prepared-repo"));
    expect(reopenLog.length).toBe(2); // Opened twice

    // After reopening, refresh to see existing commits
    enqueueRefreshRepoAction(actionsModel);
    await flushPromises(20);

    // The history should have the commits from before
    const history = getHistory(ctx);
    expect(history).not.toBeNull();
    const headRef = await history?.refs.resolve("HEAD");
    expect(headRef?.objectId).toBeTruthy();
  });

  it("should persist .git/index and preserve all files across commits", async () => {
    const actionsModel = getUserActionsModel(ctx);
    const repoModel = getRepositoryModel(ctx);

    // Use a shared MemFilesApi so we can inspect .git/index
    const sharedFiles = new MemFilesApi();

    intentCleanup();
    const intents = getIntents(ctx);
    intentCleanup = handleOpenRepositoryIntent(intents, (intent) => {
      intent.resolve({ files: sharedFiles, label: "index-test" });
      return true;
    });

    // Open and initialize
    enqueueOpenRepoAction(actionsModel);
    await flushPromises(20);
    enqueueInitRepoAction(actionsModel);
    await waitModel(repoModel, (m) => m.getState().initialized, 5000);

    // Add first file
    enqueueAddFileAction(actionsModel, { name: "file-a.txt", content: "aaa" });
    await waitModel(repoModel, (m) => m.getState().commitCount === 2, 5000);

    // Verify .git/index exists on disk
    const indexExists = await sharedFiles.exists(".git/index");
    expect(indexExists).toBe(true);

    // Add second file — the commit tree must include BOTH files
    enqueueAddFileAction(actionsModel, { name: "file-b.txt", content: "bbb" });
    await waitModel(repoModel, (m) => m.getState().commitCount === 3, 5000);

    // Both files should be in HEAD tree
    const files = repoModel.getState().files.filter((f) => f.type === "file");
    const fileNames = files.map((f) => f.name).sort();
    expect(fileNames).toContain("README.md");
    expect(fileNames).toContain("file-a.txt");
    expect(fileNames).toContain("file-b.txt");
  });

  it("should preserve tracked files after reopening repository", async () => {
    const actionsModel = getUserActionsModel(ctx);
    const repoModel = getRepositoryModel(ctx);

    // Use a persistent MemFilesApi
    const persistentFiles = new MemFilesApi();

    intentCleanup();
    const intents = getIntents(ctx);
    intentCleanup = handleOpenRepositoryIntent(intents, (intent) => {
      intent.resolve({ files: persistentFiles, label: "reopen-test" });
      return true;
    });

    // Open, init, add two files
    enqueueOpenRepoAction(actionsModel);
    await flushPromises(20);
    enqueueInitRepoAction(actionsModel);
    await waitModel(repoModel, (m) => m.getState().initialized, 5000);

    enqueueAddFileAction(actionsModel, { name: "first.txt", content: "111" });
    await waitModel(repoModel, (m) => m.getState().commitCount === 2, 5000);

    enqueueAddFileAction(actionsModel, { name: "second.txt", content: "222" });
    await waitModel(repoModel, (m) => m.getState().commitCount === 3, 5000);

    // Verify 3 files present before reopen
    const filesBefore = repoModel.getState().files.filter((f) => f.type === "file");
    expect(filesBefore).toHaveLength(3); // README.md + first.txt + second.txt

    // Simulate page reload: reopen the same files
    enqueueOpenRepoAction(actionsModel);
    await flushPromises(20);
    enqueueRefreshRepoAction(actionsModel);
    await flushPromises(20);

    // All 3 files should still be in the repository
    const filesAfter = repoModel.getState().files.filter((f) => f.type === "file");
    expect(filesAfter).toHaveLength(3);

    // Add a third file after reopen — all 4 must be in the commit
    enqueueAddFileAction(actionsModel, { name: "third.txt", content: "333" });
    await waitModel(repoModel, (m) => m.getState().commitCount === 4, 5000);

    const filesAfterAdd = repoModel.getState().files.filter((f) => f.type === "file");
    expect(filesAfterAdd).toHaveLength(4);
    const names = filesAfterAdd.map((f) => f.name).sort();
    expect(names).toEqual(["README.md", "first.txt", "second.txt", "third.txt"]);
  });
});
