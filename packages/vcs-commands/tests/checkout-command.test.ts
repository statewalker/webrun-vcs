/**
 * Tests for CheckoutCommand
 *
 * Based on JGit's CheckoutCommandTest.java patterns.
 * Adapted for staging-only operations (no working tree).
 * Tests run against all storage backends (Memory, SQL).
 *
 * Reference: tmp/jgit/org.eclipse.jgit.test/tst/org/eclipse/jgit/api/CheckoutCommandTest.java
 */

import { DeleteStagingEntry } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";
import { CheckoutStatus } from "../src/commands/checkout-command.js";
import { RefNotFoundError } from "../src/errors/index.js";
import { addFile, backends, createInitializedGitFromFactory } from "./test-helper.js";

/**
 * Collect async iterable bytes into single Uint8Array.
 */
async function collectBytes(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

describe.each(backends)("CheckoutCommand ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  async function createInitializedGit() {
    const result = await createInitializedGitFromFactory(factory);
    cleanup = result.cleanup;
    return result;
  }

  describe("branch checkout", () => {
    /**
     * JGit: testSimpleCheckout
     * Simple checkout should work.
     */
    it("testSimpleCheckout - should checkout existing branch", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create initial commit on main
      await addFile(workingCopy, "Test.txt", "Hello world");
      await git.commit().setMessage("Initial commit").call();

      // Create test branch
      await git.branchCreate().setName("test").call();

      // Checkout test branch
      const result = await git.checkout().setName("test").call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // Verify HEAD points to test branch
      const headRaw = await repository.refs.get("HEAD");
      expect(headRaw).toBeDefined();
      if (headRaw && "target" in headRaw) {
        expect(headRaw.target).toBe("refs/heads/test");
      }
    });

    /**
     * JGit: testCheckout
     * Checkout should switch branches and update staging.
     */
    it("testCheckout - should switch branch and update staging", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Initial commit on main
      await addFile(workingCopy, "Test.txt", "Hello world");
      await git.commit().setMessage("Initial commit").call();

      // Create and checkout test branch
      await git.branchCreate().setName("test").call();
      await git.checkout().setName("test").call();

      // Modify file on test branch
      await addFile(workingCopy, "Test.txt", "Some change");
      await git.commit().setMessage("Second commit").call();

      // Checkout main - staging should update
      const result = await git.checkout().setName("main").call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // Verify staging has main's version
      const entry = await workingCopy.checkout.staging.getEntry("Test.txt");
      const blobContent = await repository.blobs.load(entry?.objectId ?? "");
      if (!blobContent) throw new Error("Blob not found");
      const content = await collectBytes(blobContent);
      const text = new TextDecoder().decode(content);
      expect(text).toBe("Hello world");

      // Verify HEAD points to main
      const headRaw = await repository.refs.get("HEAD");
      if (headRaw && "target" in headRaw) {
        expect(headRaw.target).toBe("refs/heads/main");
      }
    });

    /**
     * JGit: testCheckoutToNonExistingBranch
     * Checkout to non-existing branch should throw.
     */
    it("testCheckoutToNonExistingBranch - should throw for non-existing branch", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "Test.txt", "content");
      await git.commit().setMessage("Initial").call();

      await expect(git.checkout().setName("nonexistent").call()).rejects.toThrow(RefNotFoundError);
    });

    /**
     * Checkout to detached HEAD (commit ID).
     */
    it("should checkout to detached HEAD for commit ID", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      await addFile(workingCopy, "Test.txt", "Hello world");
      const commit1 = await git.commit().setMessage("Initial").call();

      await addFile(workingCopy, "Test.txt", "Changed");
      await git.commit().setMessage("Second").call();

      // Checkout by commit ID (detached HEAD)
      const result = await git.checkout().setName(commit1.id).call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // HEAD should be detached (direct ref, not symbolic)
      const head = await repository.refs.resolve("HEAD");
      expect(head?.objectId).toBe(commit1.id);

      // Staging should have first commit's content
      const entry = await workingCopy.checkout.staging.getEntry("Test.txt");
      const blobContent = await repository.blobs.load(entry?.objectId ?? "");
      if (!blobContent) throw new Error("Blob not found");
      const content = await collectBytes(blobContent);
      const text = new TextDecoder().decode(content);
      expect(text).toBe("Hello world");
    });
  });

  describe("branch creation", () => {
    /**
     * JGit: testCreateBranchOnCheckout
     * Create branch with -b flag.
     */
    it("testCreateBranchOnCheckout - should create branch on checkout", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      await addFile(workingCopy, "Test.txt", "content");
      await git.commit().setMessage("Initial").call();

      const result = await git.checkout().setCreateBranch(true).setName("test2").call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // Verify branch was created
      const branch = await repository.refs.resolve("refs/heads/test2");
      expect(branch).toBeDefined();

      // Verify HEAD points to new branch
      const headRaw = await repository.refs.get("HEAD");
      if (headRaw && "target" in headRaw) {
        expect(headRaw.target).toBe("refs/heads/test2");
      }
    });

    /**
     * Create branch at specific start point.
     */
    it("should create branch at specific start point", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      await addFile(workingCopy, "Test.txt", "v1");
      const commit1 = await git.commit().setMessage("First").call();

      await addFile(workingCopy, "Test.txt", "v2");
      await git.commit().setMessage("Second").call();

      // Create branch at first commit
      await git
        .checkout()
        .setCreateBranch(true)
        .setName("from-first")
        .setStartPoint(commit1.id)
        .call();

      // Verify branch points to first commit
      const branch = await repository.refs.resolve("refs/heads/from-first");
      expect(branch?.objectId).toBe(commit1.id);
    });
  });

  describe("path checkout", () => {
    /**
     * JGit: testCheckoutPath
     * Checkout specific path from index.
     */
    it("testCheckoutPath - should checkout path from index", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Create files
      await addFile(workingCopy, "a.txt", "original a");
      await addFile(workingCopy, "b.txt", "original b");
      await git.commit().setMessage("Initial").call();

      // Modify in staging
      await addFile(workingCopy, "a.txt", "modified a");

      // Path checkout should restore from committed state
      const result = await git.checkout().addPath("a.txt").call();

      expect(result.status).toBe(CheckoutStatus.OK);
      expect(result.updated).toContain("a.txt");
      expect(result.ref).toBeNull(); // No ref for path checkout
    });

    /**
     * Checkout path from specific commit.
     */
    it("should checkout path from specific commit", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      await addFile(workingCopy, "Test.txt", "version 1");
      const commit1 = await git.commit().setMessage("First").call();

      await addFile(workingCopy, "Test.txt", "version 2");
      await git.commit().setMessage("Second").call();

      // Checkout file from first commit
      const result = await git.checkout().setStartPoint(commit1.id).addPath("Test.txt").call();

      expect(result.status).toBe(CheckoutStatus.OK);
      expect(result.updated).toContain("Test.txt");

      // Verify staging has version 1
      const entry = await workingCopy.checkout.staging.getEntry("Test.txt");
      const blobContent = await repository.blobs.load(entry?.objectId ?? "");
      if (!blobContent) throw new Error("Blob not found");
      const content = await collectBytes(blobContent);
      const text = new TextDecoder().decode(content);
      expect(text).toBe("version 1");
    });

    /**
     * JGit: testCheckoutAllPaths
     * Checkout all paths.
     */
    it("testCheckoutAllPaths - should checkout all paths", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "a.txt", "a");
      await addFile(workingCopy, "b.txt", "b");
      await git.commit().setMessage("Initial").call();

      // Modify both files
      await addFile(workingCopy, "a.txt", "modified a");
      await addFile(workingCopy, "b.txt", "modified b");

      // Checkout all paths
      const result = await git.checkout().setAllPaths(true).call();

      expect(result.status).toBe(CheckoutStatus.OK);
    });

    /**
     * Path checkout from non-existing path should report conflict.
     */
    it("should report conflict for non-existing path", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "existing.txt", "content");
      await git.commit().setMessage("Initial").call();

      const result = await git.checkout().addPath("nonexistent.txt").call();

      expect(result.status).toBe(CheckoutStatus.CONFLICTS);
      expect(result.conflicts).toContain("nonexistent.txt");
    });
  });

  describe("orphan branch", () => {
    /**
     * JGit: testOrphanBranch
     * Create orphan branch.
     */
    it("testOrphanBranch - should create orphan branch", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      await addFile(workingCopy, "Test.txt", "content");
      await git.commit().setMessage("Initial").call();

      const result = await git.checkout().setOrphan(true).setName("orphan").call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // HEAD should point to orphan branch symbolically
      const headRaw = await repository.refs.get("HEAD");
      expect(headRaw).toBeDefined();
      if (headRaw && "target" in headRaw) {
        expect(headRaw.target).toBe("refs/heads/orphan");
      }
    });
  });

  describe("error cases", () => {
    /**
     * Checkout without name should throw.
     */
    it("should throw when name not set for branch checkout", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "Test.txt", "content");
      await git.commit().setMessage("Initial").call();

      await expect(git.checkout().call()).rejects.toThrow("Branch name is required for checkout");
    });

    /**
     * Command can only be called once.
     */
    it("should throw if called twice", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "Test.txt", "content");
      await git.commit().setMessage("Initial").call();
      await git.branchCreate().setName("test").call();

      const cmd = git.checkout().setName("test");
      await cmd.call();

      await expect(cmd.call()).rejects.toThrow(/already been called/);
    });
  });

  describe("conflict detection", () => {
    /**
     * Force checkout should bypass conflict detection.
     */
    it("should force checkout despite staged changes", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Create initial commit on main
      await addFile(workingCopy, "Test.txt", "original");
      await git.commit().setMessage("Initial").call();

      // Create test branch with different content
      await git.branchCreate().setName("test").call();
      await git.checkout().setName("test").call();
      await addFile(workingCopy, "Test.txt", "test-version");
      await git.commit().setMessage("Test commit").call();

      // Switch back to main
      await git.checkout().setName("main").call();

      // Stage a change on main
      await addFile(workingCopy, "Test.txt", "main-modified");

      // Non-force checkout should fail due to staged changes
      const conflictResult = await git.checkout().setName("test").call();
      expect(conflictResult.status).toBe(CheckoutStatus.CONFLICTS);
      expect(conflictResult.conflicts).toContain("Test.txt");

      // Force checkout should succeed
      const forceResult = await git.checkout().setName("test").setForced(true).call();
      expect(forceResult.status).toBe(CheckoutStatus.OK);
    });

    /**
     * Checkout should detect staged changes that differ from HEAD.
     */
    it("should detect staged changes conflict", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Create initial commit on main
      await addFile(workingCopy, "file.txt", "v1");
      await git.commit().setMessage("Initial").call();

      // Create feature branch with changes
      await git.branchCreate().setName("feature").call();
      await git.checkout().setName("feature").call();
      await addFile(workingCopy, "file.txt", "feature-v2");
      await git.commit().setMessage("Feature change").call();

      // Switch back to main and stage different content
      await git.checkout().setName("main").call();
      await addFile(workingCopy, "file.txt", "main-staged");

      // Checkout feature should detect conflict
      const result = await git.checkout().setName("feature").call();

      expect(result.status).toBe(CheckoutStatus.CONFLICTS);
      expect(result.conflicts.length).toBeGreaterThan(0);
    });

    /**
     * Checkout should succeed when staging matches HEAD.
     */
    it("should allow checkout when staging matches HEAD", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Create initial commit on main
      await addFile(workingCopy, "file.txt", "original");
      await git.commit().setMessage("Initial").call();

      // Create test branch with changes
      await git.branchCreate().setName("test").call();
      await git.checkout().setName("test").call();
      await addFile(workingCopy, "file.txt", "test-version");
      await git.commit().setMessage("Test").call();

      // Switch back to main - staging matches HEAD, no conflict
      const result = await git.checkout().setName("main").call();

      expect(result.status).toBe(CheckoutStatus.OK);
    });

    /**
     * Checkout should detect conflict when file exists in both branches
     * and we've staged different content on current branch.
     */
    it("should detect staged file differs from HEAD when target differs too", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Create initial commit with a shared file
      await addFile(workingCopy, "shared.txt", "original");
      await git.commit().setMessage("Initial").call();

      // Create test branch with modified version
      await git.branchCreate().setName("test").call();
      await git.checkout().setName("test").call();
      await addFile(workingCopy, "shared.txt", "test-version");
      await git.commit().setMessage("Modify on test").call();

      // Go back to main - the file will be restored to "original"
      await git.checkout().setName("main").call();

      // Stage a different modification on main (differs from HEAD "original")
      await addFile(workingCopy, "shared.txt", "main-staged-different");

      // Checkout test should detect conflict (staged differs from HEAD)
      const result = await git.checkout().setName("test").call();

      expect(result.status).toBe(CheckoutStatus.CONFLICTS);
      expect(result.conflicts).toContain("shared.txt");
    });
  });

  describe("staging updates", () => {
    /**
     * Branch checkout should update staging to match target tree.
     */
    it("should update staging on branch checkout", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create initial state on main
      await addFile(workingCopy, "a.txt", "main-a");
      await addFile(workingCopy, "b.txt", "main-b");
      await git.commit().setMessage("Main commit").call();

      // Create test branch with different files
      await git.branchCreate().setName("test").call();
      await git.checkout().setName("test").call();

      await addFile(workingCopy, "a.txt", "test-a");
      await addFile(workingCopy, "c.txt", "test-c");
      // Remove b.txt from test branch
      const editor = workingCopy.checkout.staging.createEditor();
      editor.add(new DeleteStagingEntry("b.txt"));
      await editor.finish();
      await git.commit().setMessage("Test commit").call();

      // Switch back to main
      const result = await git.checkout().setName("main").call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // Verify staging has main's files
      const entryA = await workingCopy.checkout.staging.getEntry("a.txt");
      const entryB = await workingCopy.checkout.staging.getEntry("b.txt");
      const entryC = await workingCopy.checkout.staging.getEntry("c.txt");

      expect(entryA).toBeDefined();
      expect(entryB).toBeDefined();
      expect(entryC).toBeUndefined(); // c.txt only in test branch

      // Verify content
      const blobContentA = await repository.blobs.load(entryA?.objectId ?? "");
      if (!blobContentA) throw new Error("Blob not found");
      const contentA = await collectBytes(blobContentA);
      expect(new TextDecoder().decode(contentA)).toBe("main-a");
    });
  });
});
