/**
 * JGit Compatibility Tests for CheckoutCommand
 *
 * These tests are aligned with JGit's CheckoutCommandTest.java patterns
 * to validate Git-compatible behavior. Focus is on core functionality
 * that our staging-only implementation supports.
 *
 * Reference: tmp/jgit/org.eclipse.jgit.test/tst/org/eclipse/jgit/api/CheckoutCommandTest.java
 * Reference: tmp/jgit/org.eclipse.jgit.test/tst/org/eclipse/jgit/api/PathCheckoutCommandTest.java
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

/**
 * Read file content from staging as string.
 */
async function readStagedFile(
  workingCopy: {
    staging: { getEntry(path: string): Promise<{ objectId: string } | undefined> };
  },
  repository: {
    blobs: { load(id: string): AsyncIterable<Uint8Array> };
  },
  path: string,
): Promise<string> {
  const entry = await workingCopy.checkout.staging.getEntry(path);
  if (!entry) {
    throw new Error(`File not found in staging: ${path}`);
  }
  const blobContent = await repository.blobs.load(entry.objectId);
  if (!blobContent) throw new Error(`Blob not found: ${entry.objectId}`);
  const content = await collectBytes(blobContent);
  return new TextDecoder().decode(content);
}

describe.each(backends)("CheckoutCommand JGit Compatibility ($name backend)", ({ factory }) => {
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

  describe("JGit: testDetachedHeadOnCheckout", () => {
    /**
     * JGit: testDetachedHeadOnCheckout
     *
     * Checkout a specific commit (not branch) results in detached HEAD.
     * In JGit, when you checkout a commit by its ID, HEAD becomes
     * detached (points directly to commit, not to a branch).
     */
    it("should detach HEAD when checking out by commit ID", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create initial commit on main
      await addFile(workingCopy, "Test.txt", "Hello world");
      await git.commit().setMessage("Initial commit").call();

      // Create test branch and switch to it
      await git.branchCreate().setName("test").call();
      await git.checkout().setName("test").call();

      // Commit something on test branch
      await addFile(workingCopy, "Test.txt", "Some change");
      await git.commit().setMessage("Second commit").call();

      // Checkout master by name first
      await git.checkout().setName("main").call();

      // Get the commit ID for main
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const commitId = mainRef?.objectId;
      expect(commitId).toBeDefined();
      if (!commitId) throw new Error("Expected commitId to be defined");

      // Now checkout by commit ID - this should detach HEAD
      await git.checkout().setName(commitId).call();

      // HEAD should be detached (not symbolic)
      const headRaw = await repository.refs.get("HEAD");
      expect(headRaw).toBeDefined();

      // When HEAD is detached, it should be a direct ref (has objectId)
      // not a symbolic ref (has target)
      if (headRaw && "objectId" in headRaw) {
        expect(headRaw.objectId).toBe(commitId);
      } else {
        // If it's still symbolic, that's a failure
        throw new Error("Expected HEAD to be detached, but it is symbolic");
      }
    });

    it("should have correct staging content after detached checkout", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create first commit
      await addFile(workingCopy, "Test.txt", "Version 1");
      const commit1 = await git.commit().setMessage("First").call();

      // Create second commit with different content
      await addFile(workingCopy, "Test.txt", "Version 2");
      await git.commit().setMessage("Second").call();

      // Checkout first commit by ID (detached)
      await git.checkout().setName(commit1.id).call();

      // Verify staging has first commit's content
      const content = await readStagedFile(workingCopy, repository, "Test.txt");
      expect(content).toBe("Version 1");
    });
  });

  describe("JGit: testCheckoutOrphanBranch", () => {
    /**
     * JGit: testCheckoutOrphanBranch
     *
     * Creating new branch with --orphan flag creates a branch
     * that has no parent commits. HEAD points to the new branch
     * symbolically, but the branch ref doesn't exist yet.
     */
    it("should create orphan branch with symbolic HEAD", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create some content and commit on main
      await addFile(workingCopy, "Test.txt", "Hello world");
      await git.commit().setMessage("Initial commit").call();

      // Create orphan branch
      const result = await git.checkout().setOrphan(true).setName("orphanbranch").call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // HEAD should be symbolic pointing to orphanbranch
      const headRaw = await repository.refs.get("HEAD");
      expect(headRaw).toBeDefined();
      if (headRaw && "target" in headRaw) {
        expect(headRaw.target).toBe("refs/heads/orphanbranch");
      } else {
        throw new Error("Expected HEAD to be symbolic for orphan branch");
      }
    });

    it("orphan branch should not resolve to any commit yet", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      await addFile(workingCopy, "Test.txt", "content");
      await git.commit().setMessage("Initial").call();

      await git.checkout().setOrphan(true).setName("orphan").call();

      // The orphan branch ref should not exist yet
      // (it will be created on first commit to that branch)
      const orphanRef = await repository.refs.get("refs/heads/orphan");
      expect(orphanRef).toBeUndefined();
    });
  });

  describe("JGit: testCheckoutWithModifiedFileThatHasSameContentAsTarget", () => {
    /**
     * JGit: Checkout should succeed when modified file matches target.
     *
     * If staging content matches HEAD (no modifications), there should be
     * no conflict when checking out another branch, even if that branch
     * has different content.
     */
    it("should allow checkout when staging matches HEAD", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create initial commit with a file
      await addFile(workingCopy, "Test.txt", "main content");
      await git.commit().setMessage("Initial").call();

      // Create test branch with different content
      await git.branchCreate().setName("test").call();
      await git.checkout().setName("test").call();
      await addFile(workingCopy, "Test.txt", "test content");
      await git.commit().setMessage("Test commit").call();

      // Go back to main - staging matches HEAD (no uncommitted changes)
      await git.checkout().setName("main").call();

      // Checkout test should succeed - staging matches HEAD, no conflict
      const result = await git.checkout().setName("test").call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // Content should be from test branch now
      const content = await readStagedFile(workingCopy, repository, "Test.txt");
      expect(content).toBe("test content");
    });

    it("should detect conflict when staged content differs from both", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Create initial commit
      await addFile(workingCopy, "Test.txt", "main content");
      await git.commit().setMessage("Initial").call();

      // Create test branch with different content
      await git.branchCreate().setName("test").call();
      await git.checkout().setName("test").call();
      await addFile(workingCopy, "Test.txt", "test content");
      await git.commit().setMessage("Test commit").call();

      // Go back to main
      await git.checkout().setName("main").call();

      // Stage different content that doesn't match HEAD or target
      await addFile(workingCopy, "Test.txt", "staged different");

      // Checkout test should detect conflict
      const result = await git.checkout().setName("test").call();

      expect(result.status).toBe(CheckoutStatus.CONFLICTS);
      expect(result.conflicts).toContain("Test.txt");
    });
  });

  describe("JGit: testCheckoutBranchThenCreateNewBranch", () => {
    /**
     * JGit pattern: Checkout existing branch, then checkout -b new branch.
     *
     * Common workflow of switching branches and creating new ones.
     */
    it("should checkout existing then create new branch", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Initial commit on main
      await addFile(workingCopy, "Test.txt", "main content");
      await git.commit().setMessage("Initial").call();

      // Create and checkout test branch
      await git.branchCreate().setName("test").call();
      const result1 = await git.checkout().setName("test").call();
      expect(result1.status).toBe(CheckoutStatus.OK);

      // Add commit on test branch
      await addFile(workingCopy, "Test.txt", "test content");
      await git.commit().setMessage("Test commit").call();

      // Now create and checkout a new branch from test
      const result2 = await git.checkout().setCreateBranch(true).setName("test2").call();

      expect(result2.status).toBe(CheckoutStatus.OK);

      // Verify test2 was created
      const test2Ref = await repository.refs.resolve("refs/heads/test2");
      expect(test2Ref).toBeDefined();

      // Verify HEAD points to test2
      const headRaw = await repository.refs.get("HEAD");
      if (headRaw && "target" in headRaw) {
        expect(headRaw.target).toBe("refs/heads/test2");
      }

      // Verify test2 points to same commit as test
      const testRef = await repository.refs.resolve("refs/heads/test");
      expect(test2Ref?.objectId).toBe(testRef?.objectId);
    });

    it("should create branch at specific start point", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create two commits
      await addFile(workingCopy, "a.txt", "A");
      const first = await git.commit().setMessage("First").call();

      await addFile(workingCopy, "b.txt", "B");
      await git.commit().setMessage("Second").call();

      // Create new branch at first commit
      await git
        .checkout()
        .setCreateBranch(true)
        .setName("from-first")
        .setStartPoint(first.id)
        .call();

      // Verify branch points to first commit
      const branchRef = await repository.refs.resolve("refs/heads/from-first");
      expect(branchRef?.objectId).toBe(first.id);

      // Staging should have first commit's content
      const entryA = await workingCopy.checkout.staging.getEntry("a.txt");
      expect(entryA).toBeDefined();

      // b.txt should not exist in staging (wasn't in first commit)
      const entryB = await workingCopy.checkout.staging.getEntry("b.txt");
      expect(entryB).toBeUndefined();
    });
  });

  describe("JGit: testCheckoutPath", () => {
    /**
     * JGit: testCheckoutPath / PathCheckoutCommandTest patterns
     *
     * Checkout specific paths from index or commits.
     */
    it("should checkout single path from index", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create files and commit
      await addFile(workingCopy, "a.txt", "original a");
      await addFile(workingCopy, "b.txt", "original b");
      await git.commit().setMessage("Initial").call();

      // Modify files in staging
      await addFile(workingCopy, "a.txt", "modified a");
      await addFile(workingCopy, "b.txt", "modified b");

      // Checkout only a.txt from index
      // Since we modified staging, this should restore from HEAD
      const result = await git.checkout().setStartPoint("HEAD").addPath("a.txt").call();

      expect(result.status).toBe(CheckoutStatus.OK);
      expect(result.updated).toContain("a.txt");

      // a.txt should be restored to original
      const contentA = await readStagedFile(workingCopy, repository, "a.txt");
      expect(contentA).toBe("original a");

      // b.txt should still be modified
      const contentB = await readStagedFile(workingCopy, repository, "b.txt");
      expect(contentB).toBe("modified b");
    });

    it("should checkout path from specific commit", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create first commit
      await addFile(workingCopy, "file.txt", "version 1");
      const commit1 = await git.commit().setMessage("First").call();

      // Create second commit
      await addFile(workingCopy, "file.txt", "version 2");
      await git.commit().setMessage("Second").call();

      // Create third commit
      await addFile(workingCopy, "file.txt", "version 3");
      await git.commit().setMessage("Third").call();

      // Checkout file from first commit
      const result = await git.checkout().setStartPoint(commit1.id).addPath("file.txt").call();

      expect(result.status).toBe(CheckoutStatus.OK);
      expect(result.updated).toContain("file.txt");

      // File should have version 1 content
      const content = await readStagedFile(workingCopy, repository, "file.txt");
      expect(content).toBe("version 1");
    });

    it("should checkout multiple paths", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create files
      await addFile(workingCopy, "a.txt", "A");
      await addFile(workingCopy, "b.txt", "B");
      await addFile(workingCopy, "c.txt", "C");
      const commit1 = await git.commit().setMessage("First").call();

      // Modify all files
      await addFile(workingCopy, "a.txt", "A modified");
      await addFile(workingCopy, "b.txt", "B modified");
      await addFile(workingCopy, "c.txt", "C modified");
      await git.commit().setMessage("Second").call();

      // Checkout a.txt and b.txt from first commit
      const result = await git
        .checkout()
        .setStartPoint(commit1.id)
        .addPath("a.txt")
        .addPath("b.txt")
        .call();

      expect(result.status).toBe(CheckoutStatus.OK);
      expect(result.updated).toContain("a.txt");
      expect(result.updated).toContain("b.txt");

      // a and b should have original content
      expect(await readStagedFile(workingCopy, repository, "a.txt")).toBe("A");
      expect(await readStagedFile(workingCopy, repository, "b.txt")).toBe("B");

      // c should still have modified content
      expect(await readStagedFile(workingCopy, repository, "c.txt")).toBe("C modified");
    });

    it("should checkout directory recursively via setAllPaths", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create files in subdirectory
      await addFile(workingCopy, "dir/a.txt", "A");
      await addFile(workingCopy, "dir/sub/b.txt", "B");
      const commit1 = await git.commit().setMessage("First").call();

      // Modify both files
      await addFile(workingCopy, "dir/a.txt", "A modified");
      await addFile(workingCopy, "dir/sub/b.txt", "B modified");
      await git.commit().setMessage("Second").call();

      // Checkout all paths from first commit
      const result = await git.checkout().setStartPoint(commit1.id).setAllPaths(true).call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // Both files should be restored
      expect(await readStagedFile(workingCopy, repository, "dir/a.txt")).toBe("A");
      expect(await readStagedFile(workingCopy, repository, "dir/sub/b.txt")).toBe("B");
    });

    it("should report conflict for non-existing path", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "exists.txt", "content");
      await git.commit().setMessage("Initial").call();

      // Try to checkout non-existing path
      const result = await git.checkout().addPath("nonexistent.txt").call();

      expect(result.status).toBe(CheckoutStatus.CONFLICTS);
      expect(result.conflicts).toContain("nonexistent.txt");
    });
  });

  describe("Additional JGit-aligned tests", () => {
    /**
     * JGit: testCheckoutForced
     *
     * Force checkout should succeed even with conflicts.
     */
    it("should force checkout despite staged changes", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create initial commit
      await addFile(workingCopy, "Test.txt", "original");
      await git.commit().setMessage("Initial").call();

      // Create test branch with different content
      await git.branchCreate().setName("test").call();
      await git.checkout().setName("test").call();
      await addFile(workingCopy, "Test.txt", "test-version");
      await git.commit().setMessage("Test").call();

      // Go back to main
      await git.checkout().setName("main").call();

      // Stage different content (would conflict)
      await addFile(workingCopy, "Test.txt", "main-staged");

      // Normal checkout should fail
      const conflictResult = await git.checkout().setName("test").call();
      expect(conflictResult.status).toBe(CheckoutStatus.CONFLICTS);

      // Force checkout should succeed
      const forceResult = await git.checkout().setName("test").setForced(true).call();
      expect(forceResult.status).toBe(CheckoutStatus.OK);

      // Content should be from test branch
      expect(await readStagedFile(workingCopy, repository, "Test.txt")).toBe("test-version");
    });

    /**
     * JGit: testCheckoutToNonExistingBranch
     */
    it("should throw RefNotFoundError for non-existing branch", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "Test.txt", "content");
      await git.commit().setMessage("Initial").call();

      await expect(git.checkout().setName("nonexistent").call()).rejects.toThrow(RefNotFoundError);
    });

    /**
     * JGit: testCreateBranchOnCheckout
     */
    it("should create branch on checkout with -b flag", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      await addFile(workingCopy, "Test.txt", "content");
      await git.commit().setMessage("Initial").call();

      const result = await git.checkout().setCreateBranch(true).setName("newbranch").call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // Verify branch exists
      const branchRef = await repository.refs.resolve("refs/heads/newbranch");
      expect(branchRef).toBeDefined();

      // Verify HEAD points to new branch
      const headRaw = await repository.refs.get("HEAD");
      if (headRaw && "target" in headRaw) {
        expect(headRaw.target).toBe("refs/heads/newbranch");
      }
    });

    /**
     * JGit: Staging should be updated on branch switch
     */
    it("should update staging on branch checkout", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create files on main
      await addFile(workingCopy, "a.txt", "main-a");
      await addFile(workingCopy, "b.txt", "main-b");
      await git.commit().setMessage("Main commit").call();

      // Create test branch with different files
      await git.branchCreate().setName("test").call();
      await git.checkout().setName("test").call();
      await addFile(workingCopy, "a.txt", "test-a");
      await addFile(workingCopy, "c.txt", "test-c");
      // Remove b.txt
      const editor = workingCopy.checkout.staging.createEditor();
      editor.add(new DeleteStagingEntry("b.txt"));
      await editor.finish();
      await git.commit().setMessage("Test commit").call();

      // Switch back to main
      const result = await git.checkout().setName("main").call();

      expect(result.status).toBe(CheckoutStatus.OK);

      // Verify staging has main's files
      expect(await readStagedFile(workingCopy, repository, "a.txt")).toBe("main-a");
      expect(await readStagedFile(workingCopy, repository, "b.txt")).toBe("main-b");

      // c.txt should not exist
      const entryC = await workingCopy.checkout.staging.getEntry("c.txt");
      expect(entryC).toBeUndefined();
    });

    /**
     * JGit: testCheckoutWithStartPoint
     */
    it("should create branch at start point and checkout", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      await addFile(workingCopy, "a.txt", "A");
      const first = await git.commit().setMessage("First").call();

      await addFile(workingCopy, "a.txt", "other");
      await git.commit().setMessage("Other").call();

      // Create branch at first commit and checkout
      await git
        .checkout()
        .setCreateBranch(true)
        .setName("from-first")
        .setStartPoint(first.id)
        .call();

      // Staging should have first commit's content
      expect(await readStagedFile(workingCopy, repository, "a.txt")).toBe("A");
    });

    /**
     * Test command can only be called once
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
});
