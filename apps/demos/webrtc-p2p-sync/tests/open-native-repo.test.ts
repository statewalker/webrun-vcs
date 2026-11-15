/**
 * Test: Opening an existing native git repository.
 *
 * Reproduces the bug where clicking "Open Repository" and selecting
 * a folder with an existing git repo shows nothing on screen.
 *
 * Uses native git to create a real repository, then opens it via
 * initializeGitFromFiles with a Node.js FilesApi.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enqueueRefreshRepoAction } from "../src/actions/index.js";
import { MockTimerApi, setPeerJsApi, setTimerApi } from "../src/apis/index.js";
import type { AppContext } from "../src/controllers/index.js";
import {
  createRepositoryController,
  getGit,
  getHistory,
  initializeGitFromFiles,
} from "../src/controllers/index.js";
import {
  getActivityLogModel,
  getRepositoryModel,
  getUserActionsModel,
} from "../src/models/index.js";

/**
 * Run a git command in a directory.
 */
function git(args: string[], cwd: string): string {
  const quotedArgs = args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg));
  return execSync(`git ${quotedArgs.join(" ")}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/**
 * Wait for a condition to become true.
 */
async function waitFor(condition: () => boolean, timeout = 2000, interval = 10): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

/**
 * Mock PeerJsApi (minimal — only needed to satisfy context creation).
 */
const mockPeerJsApi = {
  createPeer: () => {
    throw new Error("PeerJS not available in this test");
  },
};

describe("Open Native Git Repository", () => {
  let testDir: string;
  let repoDir: string;
  let ctx: AppContext;
  let cleanup: () => void;

  beforeEach(async () => {
    // Create a temp directory with a native git repository
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "vcs-open-native-repo-"));
    repoDir = path.join(testDir, "repo");
    await fs.mkdir(repoDir);

    // Initialize with native git
    git(["init"], repoDir);
    git(["config", "user.email", "test@example.com"], repoDir);
    git(["config", "user.name", "Test User"], repoDir);

    // Create files and commits
    await fs.writeFile(path.join(repoDir, "README.md"), "# Test Repository\n");
    git(["add", "README.md"], repoDir);
    git(["commit", "-m", "Initial commit"], repoDir);

    await fs.writeFile(path.join(repoDir, "hello.txt"), "Hello, World!\n");
    git(["add", "hello.txt"], repoDir);
    git(["commit", "-m", "Add hello.txt"], repoDir);

    await fs.writeFile(path.join(repoDir, "data.json"), '{"key": "value"}\n');
    git(["add", "data.json"], repoDir);
    git(["commit", "-m", "Add data.json"], repoDir);
  });

  afterEach(async () => {
    if (cleanup) cleanup();
    try {
      execSync(`chmod -R u+w "${testDir}"`, { stdio: "ignore" });
    } catch {
      // Ignore chmod errors
    }
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("should read commits from a native git repository", async () => {
    // Create app context
    ctx = {};

    // Initialize git infrastructure from the native repo
    const files = createNodeFilesApi({ rootDir: repoDir });
    await initializeGitFromFiles(ctx, files);

    // Inject mock APIs (needed by controller infrastructure)
    setPeerJsApi(ctx, mockPeerJsApi as never);
    setTimerApi(ctx, new MockTimerApi());

    // Create controller
    cleanup = createRepositoryController(ctx);

    // Get models
    const repoModel = getRepositoryModel(ctx);
    const actionsModel = getUserActionsModel(ctx);
    const logModel = getActivityLogModel(ctx);

    // Trigger refresh
    enqueueRefreshRepoAction(actionsModel);

    // Wait for model to be populated
    await waitFor(() => repoModel.getState().initialized, 3000);

    // Verify model state
    const state = repoModel.getState();
    expect(state.initialized).toBe(true);
    expect(state.commitCount).toBe(3);
    expect(state.commits).toHaveLength(3);

    // Verify commit messages (newest first)
    expect(state.commits[0].message).toBe("Add data.json\n");
    expect(state.commits[1].message).toBe("Add hello.txt\n");
    expect(state.commits[2].message).toBe("Initial commit\n");

    // Verify files from HEAD tree
    const fileNames = state.files.map((f) => f.name).sort();
    expect(fileNames).toEqual(["README.md", "data.json", "hello.txt"]);

    // Verify branch
    expect(state.branch).toMatch(/^(main|master)$/);

    // Verify no errors in log
    const errors = logModel.getEntries().filter((e) => e.level === "error");
    expect(errors).toHaveLength(0);
  });

  it("should read commits directly via git.log()", async () => {
    ctx = {};
    const files = createNodeFilesApi({ rootDir: repoDir });
    await initializeGitFromFiles(ctx, files);

    const git = getGit(ctx);
    expect(git).not.toBeNull();
    if (!git) return;

    // Read commits via porcelain API
    const commits: Array<{ message: string; id: string }> = [];
    for await (const commit of await git.log().call()) {
      commits.push({ message: commit.message, id: commit.id });
    }

    expect(commits).toHaveLength(3);
    expect(commits[0].message).toBe("Add data.json\n");
    expect(commits[1].message).toBe("Add hello.txt\n");
    expect(commits[2].message).toBe("Initial commit\n");
  });

  it("should resolve HEAD ref from native git repo", async () => {
    ctx = {};
    const files = createNodeFilesApi({ rootDir: repoDir });
    await initializeGitFromFiles(ctx, files);

    const history = getHistory(ctx);
    expect(history).not.toBeNull();
    if (!history) return;

    // Read HEAD symbolic ref
    const headRef = await history.refs.get("HEAD");
    expect(headRef).toBeDefined();
    expect(headRef).toHaveProperty("target");
    if (headRef && "target" in headRef) {
      expect(headRef.target).toMatch(/^refs\/heads\/(main|master)$/);
    }

    // Resolve HEAD to a commit SHA
    const resolved = await history.refs.resolve("HEAD");
    expect(resolved).toBeDefined();
    expect(resolved?.objectId).toBeTruthy();
    expect(resolved?.objectId).toHaveLength(40);
  });

  it("should read blob content from native git repo", async () => {
    ctx = {};
    const files = createNodeFilesApi({ rootDir: repoDir });
    await initializeGitFromFiles(ctx, files);

    const history = getHistory(ctx);
    expect(history).not.toBeNull();
    if (!history) return;

    // Get HEAD commit
    const headRef = await history.refs.resolve("HEAD");
    expect(headRef?.objectId).toBeTruthy();
    const headOid = headRef?.objectId;
    if (!headOid) throw new Error("HEAD does not resolve");
    const commit = await history.commits.load(headOid);
    expect(commit).toBeDefined();
    if (!commit) return;

    // Read tree
    const tree = await history.trees.load(commit.tree);
    expect(tree).toBeDefined();
    if (!tree) return;

    // Find hello.txt
    let helloBlobId: string | undefined;
    for await (const entry of tree) {
      if (entry.name === "hello.txt") {
        helloBlobId = entry.id;
      }
    }
    expect(helloBlobId).toBeDefined();

    // Read blob content
    const blobStream = await history.blobs.load(helloBlobId!);
    expect(blobStream).toBeDefined();
    if (!blobStream) return;

    const chunks: Uint8Array[] = [];
    for await (const chunk of blobStream) {
      chunks.push(chunk);
    }
    const content = new TextDecoder().decode(
      chunks.reduce((result, chunk) => {
        const combined = new Uint8Array(result.length + chunk.length);
        combined.set(result);
        combined.set(chunk, result.length);
        return combined;
      }, new Uint8Array(0)),
    );
    expect(content).toBe("Hello, World!\n");
  });
});
