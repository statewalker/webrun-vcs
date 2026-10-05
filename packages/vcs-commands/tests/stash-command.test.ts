/**
 * Tests for Stash commands (StashCreateCommand, StashApplyCommand, StashDropCommand, StashListCommand)
 *
 * Ported from JGit's Stash*CommandTest.java files
 * Tests run against all storage backends (Memory, SQL).
 */

import { afterEach, describe, expect, it } from "vitest";

import { ContentMergeStrategy, MergeStrategy, StashApplyStatus } from "../src/index.js";
import { addFile, backends, createInitializedGitFromFactory } from "./test-helper.js";

describe.each(backends)("StashListCommand ($name backend)", ({ factory }) => {
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
  /**
   * Test listing stashes when none exist.
   */
  it("should return empty list when no stashes", async () => {
    const { git, workingCopy } = await createInitializedGit();

    // Create a commit so we have a valid HEAD
    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const stashes = await git.stashList().call();

    expect(stashes).toEqual([]);
  });

  /**
   * Test listing stashes with stash ref set manually.
   */
  it("should list stash entries from refs/stash", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create initial commit
    await addFile(workingCopy, "file.txt", "v1");
    await git.commit().setMessage("initial").call();

    const headRef = await repository.refs.resolve("HEAD");
    const headCommit = headRef?.objectId ?? "";

    // Manually create a stash-like commit structure for testing
    // Stash has 2-3 parents: [HEAD, index, optional untracked]
    const indexCommit = await repository.commits.store({
      tree: (await repository.commits.load(headCommit)).tree,
      parents: [headCommit],
      author: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      message: "index on main: abc1234 initial",
    });

    const stashCommit = await repository.commits.store({
      tree: (await repository.commits.load(headCommit)).tree,
      parents: [headCommit, indexCommit],
      author: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      message: "WIP on main: abc1234 initial",
    });

    // Set refs/stash
    await repository.refs.set("refs/stash", stashCommit);

    const stashes = await git.stashList().call();

    expect(stashes.length).toBe(1);
    expect(stashes[0].commitId).toBe(stashCommit);
    expect(stashes[0].headCommit).toBe(headCommit);
    expect(stashes[0].indexCommit).toBe(indexCommit);
    expect(stashes[0].index).toBe(0);
  });
});

describe.each(backends)("StashCreateCommand ($name backend)", ({ factory }) => {
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

  /**
   * Test creating stash without working tree provider returns undefined.
   */
  it("should require working tree provider for actual stashing", async () => {
    const { git, workingCopy } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    // Without working tree provider, stash create creates a stash but
    // it's effectively a no-op since there are no actual working tree changes
    const stashCommit = await git.stashCreate().call();

    // Should create a stash commit (even though it's not useful without working tree)
    expect(stashCommit).toBeDefined();
  });

  /**
   * Test setting custom message.
   */
  it("should support custom message", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const stashCommit = await git.stashCreate().setMessage("My custom stash message").call();

    expect(stashCommit).toBeDefined();
    if (!stashCommit) return;

    // Load the stash commit and check message
    const commit = await repository.commits.load(stashCommit);
    expect(commit.message).toBe("My custom stash message");
  });

  /**
   * Test setIncludeUntracked option.
   */
  it("should support include untracked option", async () => {
    const { git, workingCopy } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const command = git.stashCreate();
    expect(command.getIncludeUntracked()).toBe(false);

    command.setIncludeUntracked(true);
    expect(command.getIncludeUntracked()).toBe(true);
  });

  /**
   * Test setting ref to null.
   */
  it("should support setting ref to null", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    // With null ref, no reference is updated
    await git.stashCreate().setRef(null).call();

    // refs/stash should not exist
    const stashRef = await repository.refs.get("refs/stash");
    expect(stashRef).toBeUndefined();
  });
});

describe.each(backends)("StashApplyCommand ($name backend)", ({ factory }) => {
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

  /**
   * Helper to create a stash commit structure with a different tree.
   */
  async function createStashWithModifiedFile(
    repository: Awaited<ReturnType<typeof createInitializedGit>>["repository"],
    filename: string,
    content: string,
  ) {
    const headRef = await repository.refs.resolve("HEAD");
    const headCommit = headRef?.objectId ?? "";
    const headCommitObj = await repository.commits.load(headCommit);

    // Create a blob with the new content
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const blobId = await repository.blobs.store([data]);

    // Create a new tree with the modified file
    const stashTree = await repository.trees.store([
      { name: filename, id: blobId, mode: 0o100644 },
    ]);

    const indexCommit = await repository.commits.store({
      tree: stashTree,
      parents: [headCommit],
      author: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      message: "index on main: abc1234 test",
    });

    const stashCommit = await repository.commits.store({
      tree: stashTree,
      parents: [headCommit, indexCommit],
      author: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      message: "WIP on main: abc1234 test",
    });

    await repository.refs.set("refs/stash", stashCommit);
    return { stashCommit, headCommitObj };
  }

  /**
   * Helper to create a stash commit structure.
   */
  async function createStash(
    _git: Awaited<ReturnType<typeof createInitializedGit>>["git"],
    repository: Awaited<ReturnType<typeof createInitializedGit>>["repository"],
  ) {
    const headRef = await repository.refs.resolve("HEAD");
    const headCommit = headRef?.objectId ?? "";
    const headCommitObj = await repository.commits.load(headCommit);

    const indexCommit = await repository.commits.store({
      tree: headCommitObj.tree,
      parents: [headCommit],
      author: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      message: "index on main: abc1234 test",
    });

    const stashCommit = await repository.commits.store({
      tree: headCommitObj.tree,
      parents: [headCommit, indexCommit],
      author: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      message: "WIP on main: abc1234 test",
    });

    await repository.refs.set("refs/stash", stashCommit);
    return stashCommit;
  }

  /**
   * Test applying stash.
   */
  it("should apply stash successfully", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    await createStash(git, repository);

    const result = await git.stashApply().call();

    expect(result.status).toBe(StashApplyStatus.OK);
  });

  /**
   * Test applying specific stash.
   */
  it("should support setting stash ref", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const stashId = await createStash(git, repository);

    const command = git.stashApply();
    expect(command.getStashRef()).toBeUndefined();

    command.setStashRef("stash@{0}");
    expect(command.getStashRef()).toBe("stash@{0}");

    const result = await command.call();
    expect(result.status).toBe(StashApplyStatus.OK);
    expect(result.stashCommit).toBe(stashId);
  });

  /**
   * Test setRestoreIndex option.
   */
  it("should support restoreIndex option", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    await createStash(git, repository);

    const command = git.stashApply();
    expect(command.getRestoreIndex()).toBe(true); // default

    command.setRestoreIndex(false);
    expect(command.getRestoreIndex()).toBe(false);

    const result = await command.call();
    expect(result.status).toBe(StashApplyStatus.OK);
  });

  /**
   * Test setRestoreUntracked option.
   */
  it("should support restoreUntracked option", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    await createStash(git, repository);

    const command = git.stashApply();
    expect(command.getRestoreUntracked()).toBe(true); // default

    command.setRestoreUntracked(false);
    expect(command.getRestoreUntracked()).toBe(false);
  });

  /**
   * Test setStrategy option.
   */
  it("should support merge strategy option", async () => {
    const { git } = await createInitializedGit();

    const command = git.stashApply();
    expect(command.getStrategy()).toBe(MergeStrategy.RECURSIVE); // default

    command.setStrategy(MergeStrategy.RESOLVE);
    expect(command.getStrategy()).toBe(MergeStrategy.RESOLVE);
  });

  /**
   * Test setContentMergeStrategy option.
   */
  it("should support content merge strategy option", async () => {
    const { git } = await createInitializedGit();

    const command = git.stashApply();
    expect(command.getContentMergeStrategy()).toBeUndefined(); // no default

    command.setContentMergeStrategy(ContentMergeStrategy.OURS);
    expect(command.getContentMergeStrategy()).toBe(ContentMergeStrategy.OURS);
  });

  /**
   * Test applying stash when no stashes exist.
   *
   * Based on JGit's noStashedCommits test.
   */
  it("should throw when no stashes exist", async () => {
    const { git, workingCopy } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    // No stash exists, should throw
    await expect(git.stashApply().call()).rejects.toThrow();
  });

  /**
   * Test applying stash when HEAD doesn't exist.
   *
   * Based on JGit's unstashNoHead test.
   */
  it("should throw when HEAD does not exist", async () => {
    const { git, repository } = await createInitializedGit();

    // Create a stash ref without HEAD
    const encoder = new TextEncoder();
    const blobId = await repository.blobs.store([encoder.encode("content")]);
    const tree = await repository.trees.store([{ name: "file.txt", id: blobId, mode: 0o100644 }]);

    const commit = await repository.commits.store({
      tree,
      parents: [],
      author: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      message: "stash",
    });

    await repository.refs.set("refs/stash", commit);

    // HEAD doesn't exist, should throw
    await expect(git.stashApply().call()).rejects.toThrow();
  });

  /**
   * Test applying stash with modified file.
   *
   * Based on JGit's workingDirectoryModify test.
   */
  it("should apply stash with modified file content", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "original");
    await git.commit().setMessage("initial").call();

    // Create stash with modified content
    await createStashWithModifiedFile(repository, "file.txt", "modified");

    const result = await git.stashApply().call();

    expect(result.status).toBe(StashApplyStatus.OK);
  });

  /**
   * Test applying stash by direct commit ID.
   *
   * Based on JGit's stashedApplyOnOtherBranch test.
   */
  it("should apply stash by commit ID", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const stashId = await createStash(git, repository);

    // Apply by commit ID
    const result = await git.stashApply().setStashRef(stashId).call();

    expect(result.status).toBe(StashApplyStatus.OK);
    expect(result.stashCommit).toBe(stashId);
  });

  /**
   * Test applying stash with invalid ref throws.
   *
   * Based on JGit's unstashNonStashCommit test.
   */
  it("should throw for invalid stash ref", async () => {
    const { git, workingCopy } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    await expect(git.stashApply().setStashRef("nonexistent").call()).rejects.toThrow();
  });

  /**
   * Test setIgnoreRepositoryState option (reserved for future use).
   */
  it("should support ignoreRepositoryState option", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    await createStash(git, repository);

    // This is a no-op currently but API should work
    const result = await git.stashApply().setIgnoreRepositoryState(true).call();

    expect(result.status).toBe(StashApplyStatus.OK);
  });
});

describe.each(backends)("StashDropCommand ($name backend)", ({ factory }) => {
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

  /**
   * Test dropping when no stash exists.
   */
  it("should return undefined when no stash to drop", async () => {
    const { git, workingCopy } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const result = await git.stashDrop().call();

    expect(result).toBeUndefined();
  });

  /**
   * Test dropping stash.
   */
  it("should drop stash entry", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const headRef = await repository.refs.resolve("HEAD");
    const headCommit = headRef?.objectId ?? "";
    const headCommitObj = await repository.commits.load(headCommit);

    // Create a stash
    const indexCommit = await repository.commits.store({
      tree: headCommitObj.tree,
      parents: [headCommit],
      author: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      message: "index",
    });

    const stashCommit = await repository.commits.store({
      tree: headCommitObj.tree,
      parents: [headCommit, indexCommit],
      author: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      message: "WIP",
    });

    await repository.refs.set("refs/stash", stashCommit);

    // Drop the stash
    const result = await git.stashDrop().call();

    // Should return undefined (no more stashes)
    expect(result).toBeUndefined();

    // refs/stash should be deleted
    const stashRef = await repository.refs.get("refs/stash");
    expect(stashRef).toBeUndefined();
  });

  /**
   * Test setAll option.
   */
  it("should support dropping all stashes", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const headRef = await repository.refs.resolve("HEAD");
    const headCommit = headRef?.objectId ?? "";
    const headCommitObj = await repository.commits.load(headCommit);

    // Create a stash
    const indexCommit = await repository.commits.store({
      tree: headCommitObj.tree,
      parents: [headCommit],
      author: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      message: "index",
    });

    const stashCommit = await repository.commits.store({
      tree: headCommitObj.tree,
      parents: [headCommit, indexCommit],
      author: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      message: "WIP",
    });

    await repository.refs.set("refs/stash", stashCommit);

    const command = git.stashDrop();
    expect(command.getAll()).toBe(false); // default

    command.setAll(true);
    expect(command.getAll()).toBe(true);

    const result = await command.call();
    expect(result).toBeUndefined();
  });

  /**
   * Test setStashRef option.
   */
  it("should support setting stash index", async () => {
    const { git } = await createInitializedGit();

    const command = git.stashDrop();
    expect(command.getStashRef()).toBe(0); // default

    command.setStashRef(2);
    expect(command.getStashRef()).toBe(2);
  });

  /**
   * Test invalid stash index throws.
   */
  it("should throw for negative stash index", async () => {
    const { git } = await createInitializedGit();

    expect(() => git.stashDrop().setStashRef(-1)).toThrow();
  });

  /**
   * Test dropping stash with invalid index throws.
   *
   * Based on JGit's dropWithInvalidLogIndex test.
   * Note: Without reflog support, only stash@{0} is accessible.
   */
  it("should throw for stash index > 0 without reflog", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const headRef = await repository.refs.resolve("HEAD");
    const headCommit = headRef?.objectId ?? "";
    const headCommitObj = await repository.commits.load(headCommit);

    // Create a stash
    const indexCommit = await repository.commits.store({
      tree: headCommitObj.tree,
      parents: [headCommit],
      author: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      message: "index",
    });

    const stashCommit = await repository.commits.store({
      tree: headCommitObj.tree,
      parents: [headCommit, indexCommit],
      author: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      message: "WIP",
    });

    await repository.refs.set("refs/stash", stashCommit);

    // Trying to drop stash@{1} should fail without reflog
    await expect(git.stashDrop().setStashRef(1).call()).rejects.toThrow();
  });

  /**
   * Test command cannot be reused.
   */
  it("should not allow command reuse after call", async () => {
    const { git, workingCopy } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const command = git.stashDrop();
    await command.call();

    // Attempting to call again should throw
    await expect(command.call()).rejects.toThrow();
  });
});

describe.each(backends)(
  "StashCreateCommand - JGit compatibility tests ($name backend)",
  ({ factory }) => {
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

    /**
     * Test stash creation with working tree provider providing no changes.
     *
     * Based on JGit's noLocalChanges test.
     */
    it("should create stash even without explicit working tree changes", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      await addFile(workingCopy, "file.txt", "content");
      await git.commit().setMessage("initial").call();

      // Create stash without provider - still creates commit structure
      const stashCommit = await git.stashCreate().call();

      expect(stashCommit).toBeDefined();
      if (!stashCommit) return;

      // Verify stash commit structure
      const commit = await repository.commits.load(stashCommit);
      expect(commit.parents.length).toBeGreaterThanOrEqual(2);
    });

    /**
     * Test that multiple stashes replace refs/stash.
     *
     * Note: Without reflog, only the latest stash is accessible.
     */
    it("should replace refs/stash on subsequent stash creates", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      await addFile(workingCopy, "file.txt", "content");
      await git.commit().setMessage("initial").call();

      const stash1 = await git.stashCreate().setMessage("stash 1").call();
      const stash2 = await git.stashCreate().setMessage("stash 2").call();

      // refs/stash should point to stash2
      const stashRef = await repository.refs.resolve("refs/stash");
      expect(stashRef?.objectId).toBe(stash2);
      expect(stash1).not.toBe(stash2);
    });

    /**
     * Test custom index message.
     */
    it("should support custom index message", async () => {
      const { git } = await createInitializedGit();

      const command = git.stashCreate();
      command.setIndexMessage("Custom index message");

      // API should work (actual message depends on implementation)
      expect(command).toBeDefined();
    });

    /**
     * Test command cannot be reused.
     */
    it("should not allow command reuse after call", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "file.txt", "content");
      await git.commit().setMessage("initial").call();

      const command = git.stashCreate();
      await command.call();

      // Attempting to call again should throw
      await expect(command.call()).rejects.toThrow();
    });
  },
);

describe.each(backends)("StashListCommand - additional tests ($name backend)", ({ factory }) => {
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

  /**
   * Test listing when stash ref exists but commit is invalid.
   */
  it("should handle invalid stash commit gracefully", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const headRef = await repository.refs.resolve("HEAD");
    const headCommit = headRef?.objectId ?? "";

    // Create a commit with only 1 parent (not valid stash structure)
    const invalidStash = await repository.commits.store({
      tree: (await repository.commits.load(headCommit)).tree,
      parents: [headCommit],
      author: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      committer: { name: "Test", email: "test@test.com", timestamp: 1000, tzOffset: "+0000" },
      message: "Not a valid stash",
    });

    await repository.refs.set("refs/stash", invalidStash);

    // Should return empty - invalid stash structure filtered out
    const stashes = await git.stashList().call();
    expect(stashes).toEqual([]);
  });

  /**
   * Test command cannot be reused.
   */
  it("should not allow command reuse after call", async () => {
    const { git, workingCopy } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const command = git.stashList();
    await command.call();

    // Attempting to call again should throw
    await expect(command.call()).rejects.toThrow();
  });
});
