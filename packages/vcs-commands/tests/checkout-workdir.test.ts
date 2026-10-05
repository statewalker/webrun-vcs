/**
 * Tests for CheckoutCommand working directory updates
 *
 * Tests the checkout command's ability to write files to the working
 * directory when a FilesApi and workTreeRoot are configured.
 *
 * Reference: Issue webrun-vcs-djl5
 */

import { createInMemoryFilesApi, type FilesApi } from "@statewalker/vcs-core";
import { createFileWorktree } from "@statewalker/vcs-store-files";
import {
  createMemoryObjectStores,
  MemoryRefStore,
  MemoryStagingStore,
} from "@statewalker/vcs-store-mem";
import { MemoryWorkingCopy, type WorkingCopy, type Worktree } from "@statewalker/vcs-working-tree";
import { describe, expect, it } from "vitest";

import { CheckoutStatus } from "../src/commands/checkout-command.js";
import { Git } from "../src/index.js";
import { createSimpleHistory } from "./simple-history-store.js";
import { testAuthor } from "./test-helper.js";

/**
 * Local store type for tests - used to construct WorkingCopy.
 */
interface TestStores {
  blobs: ReturnType<typeof createMemoryObjectStores>["blobs"];
  trees: ReturnType<typeof createMemoryObjectStores>["trees"];
  commits: ReturnType<typeof createMemoryObjectStores>["commits"];
  tags: ReturnType<typeof createMemoryObjectStores>["tags"];
  refs: MemoryRefStore;
  staging: MemoryStagingStore;
  worktree?: Worktree;
}

/**
 * Create a WorkingCopy from test stores using MemoryWorkingCopy.
 */
function createWorkingCopyFromTestStores(stores: TestStores): WorkingCopy {
  const repository = createSimpleHistory({
    objects: (stores.blobs as { objects?: unknown }).objects,
    blobs: stores.blobs,
    trees: stores.trees,
    commits: stores.commits,
    tags: stores.tags,
    refs: stores.refs,
  });

  return new MemoryWorkingCopy({
    history: repository,
    checkout: { staging: stores.staging } as never,
    worktree: stores.worktree,
  });
}

/**
 * Add a file to test stores and stage it.
 */
async function addFileToStore(stores: TestStores, path: string, content: string): Promise<string> {
  const blobId = await stores.blobs.store([new TextEncoder().encode(content)]);
  // Handle both Staging (createEditor) and StagingStore (editor) interfaces
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
      size: content.length,
      mtime: Date.now(),
    }),
  });
  await editor.finish();
  return blobId;
}

/**
 * Read file content from FilesApi as string.
 */
async function readFileContent(files: FilesApi, path: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of files.read(path)) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(result);
}

/**
 * Check if a file exists in FilesApi.
 */
async function fileExists(files: FilesApi, path: string): Promise<boolean> {
  try {
    const stats = await files.stats(path);
    return stats !== undefined;
  } catch {
    return false;
  }
}

/**
 * Create test stores with files and worktree for working directory tests.
 * Returns both stores and a WorkingCopy.
 */
function createStoresWithFiles(
  files: FilesApi,
  workTreeRoot: string,
): { stores: TestStores; workingCopy: WorkingCopy } {
  const objectStores = createMemoryObjectStores();
  const staging = new MemoryStagingStore();
  const worktree = createFileWorktree({
    files,
    rootPath: workTreeRoot,
    gitDir: ".git",
  });

  const stores: TestStores = {
    blobs: objectStores.blobs,
    trees: objectStores.trees,
    commits: objectStores.commits,
    refs: new MemoryRefStore(),
    staging,
    tags: objectStores.tags,
    worktree,
  };

  return { stores, workingCopy: createWorkingCopyFromTestStores(stores) };
}

/**
 * Create bare test stores (no files or worktree).
 * Returns both stores and a WorkingCopy.
 */
function createBareStores(): { stores: TestStores; workingCopy: WorkingCopy } {
  const objectStores = createMemoryObjectStores();
  const stores: TestStores = {
    blobs: objectStores.blobs,
    trees: objectStores.trees,
    commits: objectStores.commits,
    refs: new MemoryRefStore(),
    staging: new MemoryStagingStore(),
    tags: objectStores.tags,
  };

  return { stores, workingCopy: createWorkingCopyFromTestStores(stores) };
}

/**
 * Initialize stores with an empty initial commit and set up HEAD.
 */
async function initializeStores(stores: TestStores): Promise<string> {
  // Create and store empty tree
  const emptyTreeId = await stores.trees.store([]);

  // Create initial commit
  const initialCommit = {
    tree: emptyTreeId,
    parents: [],
    author: testAuthor(),
    committer: testAuthor(),
    message: "Initial commit",
  };

  const initialCommitId = await stores.commits.store(initialCommit);

  // Set up refs
  await stores.refs.set("refs/heads/main", initialCommitId);
  await stores.refs.setSymbolic("HEAD", "refs/heads/main");

  // Initialize staging with empty tree
  await stores.staging.readTree(stores.trees, emptyTreeId);

  return initialCommitId;
}

describe("CheckoutCommand working directory updates", () => {
  describe("checkout writes files to working directory", () => {
    it("should write files to working directory on checkout", async () => {
      // Create in-memory filesystem
      const files = createInMemoryFilesApi();
      const { stores, workingCopy } = createStoresWithFiles(files, "");
      const git = Git.fromWorkingCopy(workingCopy);

      // Initialize repository
      await initializeStores(stores);

      // Create initial commit with files
      await addFileToStore(stores, "file1.txt", "content1");
      await addFileToStore(stores, "file2.txt", "content2");
      await git.commit().setMessage("Add files").call();

      // Create a new branch
      await git.branchCreate().setName("feature").call();

      // Switch to feature branch and modify
      await git.checkout().setName("feature").call();
      await addFileToStore(stores, "file1.txt", "modified content");
      await git.commit().setMessage("Modify file1").call();

      // Switch back to main (force to bypass conflict detection since staging changed)
      const result = await git.checkout().setName("main").setForced(true).call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // Verify files exist in working directory
      expect(await fileExists(files, "file1.txt")).toBe(true);
      expect(await fileExists(files, "file2.txt")).toBe(true);

      // Verify file content is main's version
      const content1 = await readFileContent(files, "file1.txt");
      expect(content1).toBe("content1");
    });
  });

  describe("checkout updates modified files", () => {
    it("should update file content when checking out different commit", async () => {
      // Create in-memory filesystem
      const files = createInMemoryFilesApi();
      const { stores, workingCopy } = createStoresWithFiles(files, "");
      const git = Git.fromWorkingCopy(workingCopy);

      // Initialize repository
      await initializeStores(stores);

      // Create commit with file content "v1"
      await addFileToStore(stores, "version.txt", "v1");
      const commit1 = await git.commit().setMessage("Version 1").call();

      // Create commit with file content "v2"
      await addFileToStore(stores, "version.txt", "v2");
      await git.commit().setMessage("Version 2").call();

      // Checkout the first commit (detached HEAD) - force to bypass conflict detection
      const result = await git.checkout().setName(commit1.id).setForced(true).call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // Verify file content is "v1"
      const content = await readFileContent(files, "version.txt");
      expect(content).toBe("v1");
    });

    it("should update file when switching between branches", async () => {
      // Create in-memory filesystem
      const files = createInMemoryFilesApi();
      const { stores, workingCopy } = createStoresWithFiles(files, "");
      const git = Git.fromWorkingCopy(workingCopy);

      // Initialize repository
      await initializeStores(stores);

      // Create initial commit on main with file
      await addFileToStore(stores, "data.txt", "main-data");
      await git.commit().setMessage("Main commit").call();

      // Create and checkout feature branch
      await git.checkout().setCreateBranch(true).setName("feature").call();

      // Modify file on feature branch
      await addFileToStore(stores, "data.txt", "feature-data");
      await git.commit().setMessage("Feature commit").call();

      // Checkout main branch (force to bypass conflict detection)
      const result = await git.checkout().setName("main").setForced(true).call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // Verify file content is now main's version
      const content = await readFileContent(files, "data.txt");
      expect(content).toBe("main-data");
    });
  });

  describe("checkout creates nested directories", () => {
    it("should create nested directory structure when checking out", async () => {
      // Create in-memory filesystem
      const files = createInMemoryFilesApi();
      const { stores, workingCopy } = createStoresWithFiles(files, "");
      const git = Git.fromWorkingCopy(workingCopy);

      // Initialize repository
      await initializeStores(stores);

      // Create commit with nested path "a/b/c/file.txt"
      await addFileToStore(stores, "a/b/c/file.txt", "nested content");
      await git.commit().setMessage("Add nested file").call();

      // Create and checkout a new branch (to force checkout back)
      await git.checkout().setCreateBranch(true).setName("empty").call();

      // Clear the file by removing it from staging (simulate empty branch)
      await stores.staging.clear();
      await git.commit().setMessage("Empty commit").setAllowEmpty(true).call();

      // Checkout main to restore the nested file (force to bypass conflict detection)
      const result = await git.checkout().setName("main").setForced(true).call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // Verify nested path exists in working directory
      expect(await fileExists(files, "a/b/c/file.txt")).toBe(true);

      // Verify content
      const content = await readFileContent(files, "a/b/c/file.txt");
      expect(content).toBe("nested content");
    });

    it("should handle deeply nested paths", async () => {
      // Create in-memory filesystem
      const files = createInMemoryFilesApi();
      const { stores, workingCopy } = createStoresWithFiles(files, "");
      const git = Git.fromWorkingCopy(workingCopy);

      // Initialize repository
      await initializeStores(stores);

      // Create commit with deep nested paths
      await addFileToStore(
        stores,
        "src/components/ui/button/index.ts",
        "export const Button = () => {};",
      );
      await addFileToStore(stores, "src/utils/helpers/format.ts", "export function format() {}");
      await git.commit().setMessage("Add source files").call();

      // Create feature branch and switch back
      await git.checkout().setCreateBranch(true).setName("feature").call();
      await git.checkout().setName("main").call();

      // Verify all nested files exist
      expect(await fileExists(files, "src/components/ui/button/index.ts")).toBe(true);
      expect(await fileExists(files, "src/utils/helpers/format.ts")).toBe(true);

      // Verify contents
      const buttonContent = await readFileContent(files, "src/components/ui/button/index.ts");
      expect(buttonContent).toBe("export const Button = () => {};");
    });
  });

  describe("checkout skips workdir for bare repos", () => {
    it("should update HEAD and staging for bare repos without file errors", async () => {
      // Create a bare store (no files/workTreeRoot)
      const { stores, workingCopy } = createBareStores();
      const git = Git.fromWorkingCopy(workingCopy);

      // Initialize repository
      await initializeStores(stores);

      // Create initial commit with file
      await addFileToStore(stores, "test.txt", "content");
      await git.commit().setMessage("Initial content").call();

      // Create feature branch
      await git.branchCreate().setName("feature").call();

      // Checkout feature branch
      await git.checkout().setName("feature").call();

      // Modify file on feature branch
      await addFileToStore(stores, "test.txt", "feature content");
      await git.commit().setMessage("Feature change").call();

      // Checkout main branch - should not throw even without files/workTreeRoot
      const result = await git.checkout().setName("main").call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // Verify HEAD updated to main
      const headRaw = await stores.refs.get("HEAD");
      expect(headRaw).toBeDefined();
      if (headRaw && "target" in headRaw) {
        expect(headRaw.target).toBe("refs/heads/main");
      }

      // Verify staging updated to main's content
      const entry = await stores.staging.getEntry("test.txt");
      expect(entry).toBeDefined();

      // Load blob content to verify staging has correct version
      const blobStream = await stores.blobs.load(entry?.objectId ?? "");
      expect(blobStream).toBeDefined();
      if (!blobStream) throw new Error("unreachable");
      const chunks: Uint8Array[] = [];
      for await (const chunk of blobStream) {
        chunks.push(chunk);
      }
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const content = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        content.set(chunk, offset);
        offset += chunk.length;
      }
      const text = new TextDecoder().decode(content);
      expect(text).toBe("content");
    });

    it("should not attempt file writes when files is undefined", async () => {
      // Create a bare store
      const { stores, workingCopy } = createBareStores();
      const git = Git.fromWorkingCopy(workingCopy);

      // Verify worktree is undefined (bare repo)
      expect(stores.worktree).toBeUndefined();

      // Initialize repository
      await initializeStores(stores);

      // Create commits on two branches
      await addFileToStore(stores, "file.txt", "main content");
      await git.commit().setMessage("Main commit").call();

      await git.checkout().setCreateBranch(true).setName("other").call();
      await addFileToStore(stores, "file.txt", "other content");
      await git.commit().setMessage("Other commit").call();

      // Checkout should complete without throwing
      const result = await git.checkout().setName("main").call();

      // Checkout should succeed
      expect(result.status).toBe(CheckoutStatus.OK);
    });

    it("should handle detached HEAD checkout in bare repo", async () => {
      // Create a bare store
      const { stores, workingCopy } = createBareStores();
      const git = Git.fromWorkingCopy(workingCopy);

      // Initialize repository
      await initializeStores(stores);

      // Create two commits
      await addFileToStore(stores, "version.txt", "v1");
      const commit1 = await git.commit().setMessage("Version 1").call();

      await addFileToStore(stores, "version.txt", "v2");
      await git.commit().setMessage("Version 2").call();

      // Checkout first commit (detached HEAD) - should not throw
      const result = await git.checkout().setName(commit1.id).call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // Verify HEAD is detached at commit1
      const head = await stores.refs.resolve("HEAD");
      expect(head?.objectId).toBe(commit1.id);

      // Verify staging has v1 content
      const entry = await stores.staging.getEntry("version.txt");
      expect(entry).toBeDefined();

      const blobStream2 = await stores.blobs.load(entry?.objectId ?? "");
      expect(blobStream2).toBeDefined();
      if (!blobStream2) throw new Error("unreachable");
      const chunks: Uint8Array[] = [];
      for await (const chunk of blobStream2) {
        chunks.push(chunk);
      }
      // Combine chunks into single array for decoding
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }
      const text = new TextDecoder().decode(combined);
      expect(text).toBe("v1");
    });
  });

  describe("checkout with workTreeRoot prefix", () => {
    it("should write files under workTreeRoot when specified", async () => {
      // Create in-memory filesystem
      const files = createInMemoryFilesApi();

      // Use a non-empty workTreeRoot
      const { stores, workingCopy } = createStoresWithFiles(files, "/project");
      const git = Git.fromWorkingCopy(workingCopy);

      // Initialize repository
      await initializeStores(stores);

      // Create commit with file
      await addFileToStore(stores, "readme.txt", "Hello World");
      await git.commit().setMessage("Add readme").call();

      // Create branch and switch back
      await git.checkout().setCreateBranch(true).setName("feature").call();
      await git.checkout().setName("main").call();

      // Verify file exists under workTreeRoot
      expect(await fileExists(files, "/project/readme.txt")).toBe(true);

      // Verify content
      const content = await readFileContent(files, "/project/readme.txt");
      expect(content).toBe("Hello World");
    });
  });
});
