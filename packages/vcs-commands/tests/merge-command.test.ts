/**
 * Tests for MergeCommand
 *
 * Based on JGit's MergeCommandTest.java
 * Tests run against all storage backends (Memory, SQL).
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  ContentMergeStrategy,
  FastForwardMode,
  InvalidMergeHeadsError,
  MergeStatus,
  MergeStrategy,
  NotFastForwardError,
} from "../src/index.js";
import {
  addFile,
  backends,
  createInitializedGitFromFactory,
  removeFile,
  toArray,
} from "./test-helper.js";

describe.each(backends)("MergeCommand ($name backend)", ({ factory }) => {
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
  // ===== Already Up To Date =====

  describe("already up to date", () => {
    /**
     * JGit: testMergeInItself
     */
    it("should report ALREADY_UP_TO_DATE when merging HEAD into itself", async () => {
      const { git, initialCommitId } = await createInitializedGit();

      const result = await git.merge().include("HEAD").call();

      expect(result.status).toBe(MergeStatus.ALREADY_UP_TO_DATE);
      expect(result.newHead).toBe(initialCommitId);
    });

    /**
     * JGit: testAlreadyUpToDate
     */
    it("should report ALREADY_UP_TO_DATE when source is ancestor of HEAD", async () => {
      const { git, repository, initialCommitId } = await createInitializedGit();

      // Create a branch at initial commit
      await git.branchCreate().setName("branch1").setStartPoint(initialCommitId).call();

      // Add another commit on main
      const second = await git.commit().setMessage("second").setAllowEmpty(true).call();
      const secondId = await repository.commits.store(second);

      // Merge branch1 (which is behind) into main
      const result = await git.merge().include("branch1").call();

      expect(result.status).toBe(MergeStatus.ALREADY_UP_TO_DATE);
      expect(result.newHead).toBe(secondId);
    });
  });

  // ===== Fast Forward =====

  describe("fast-forward merge", () => {
    /**
     * JGit: testFastForward
     */
    it("should fast-forward when HEAD is ancestor of source", async () => {
      const { git, repository } = await createInitializedGit();

      // Create branch1 at initial commit
      await git.branchCreate().setName("branch1").call();

      // Add commit on main
      await git.commit().setMessage("second").setAllowEmpty(true).call();

      // Get main's HEAD for later
      const mainHead = await repository.refs.resolve("refs/heads/main");

      // Switch to branch1 (simulated by updating HEAD)
      await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");

      // Merge main into branch1
      const result = await git.merge().include("refs/heads/main").call();

      expect(result.status).toBe(MergeStatus.FAST_FORWARD);
      expect(result.newHead).toBe(mainHead?.objectId);

      // branch1 should now point to same commit as main
      const branch1 = await repository.refs.resolve("refs/heads/branch1");
      expect(branch1?.objectId).toBe(mainHead?.objectId);
    });

    it("should update staging area on fast-forward", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create branch1 at current commit
      await git.branchCreate().setName("branch1").call();

      // Add file and commit on main
      await addFile(workingCopy, "new-file.txt", "content");
      await git.commit().setMessage("add file").call();

      // Switch to branch1
      await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
      // Reset staging to branch1's tree (simulating checkout)
      const branch1Ref = await repository.refs.resolve("refs/heads/branch1");
      const branch1Commit = await repository.commits.load(branch1Ref?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, branch1Commit.tree);

      // Merge main into branch1
      await git.merge().include("refs/heads/main").call();

      // Staging should now have the new file
      const entry = await workingCopy.checkout.staging.getEntry("new-file.txt");
      expect(entry).toBeDefined();
    });

    /**
     * JGit: testFastForwardOnly
     */
    it("should fail with FF_ONLY when fast-forward not possible", async () => {
      const { git, repository } = await createInitializedGit();

      // Create divergent branches
      await git.branchCreate().setName("branch1").call();

      // Add commit on main
      await git.commit().setMessage("main commit").setAllowEmpty(true).call();

      // Switch to branch1 and add commit there too
      await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
      await git.commit().setMessage("branch commit").setAllowEmpty(true).call();

      // Try to merge main with FF_ONLY
      await expect(
        git.merge().include("refs/heads/main").setFastForwardMode(FastForwardMode.FF_ONLY).call(),
      ).rejects.toThrow(NotFastForwardError);
    });
  });

  // ===== Three-Way Merge =====

  describe("three-way merge", () => {
    /**
     * JGit: testMergeNoFastForward
     */
    it("should create merge commit with NO_FF", async () => {
      const { git, repository } = await createInitializedGit();

      // Create branch1 at initial commit
      await git.branchCreate().setName("branch1").call();

      // Add commit on main
      await git.commit().setMessage("main commit").setAllowEmpty(true).call();

      // Switch to branch1
      await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");

      // Merge with NO_FF should create merge commit even though FF is possible
      const result = await git
        .merge()
        .include("refs/heads/main")
        .setFastForwardMode(FastForwardMode.NO_FF)
        .call();

      expect(result.status).toBe(MergeStatus.MERGED);

      // New HEAD should be a merge commit with 2 parents
      const newCommit = await repository.commits.load(result.newHead ?? "");
      expect(newCommit.parents.length).toBe(2);
    });

    it("should merge divergent branches without conflicts", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create branch1
      await git.branchCreate().setName("branch1").call();

      // Add file on main and commit
      await addFile(workingCopy, "file-a.txt", "content a");
      await git.commit().setMessage("add file-a").call();

      // Switch to branch1
      await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
      // Reset staging to branch1's tree
      const branch1Ref = await repository.refs.resolve("refs/heads/branch1");
      const branch1Commit = await repository.commits.load(branch1Ref?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, branch1Commit.tree);

      // Add different file on branch1 and commit
      await addFile(workingCopy, "file-b.txt", "content b");
      await git.commit().setMessage("add file-b").call();

      // Merge main into branch1
      const result = await git.merge().include("refs/heads/main").call();

      expect(result.status).toBe(MergeStatus.MERGED);

      // Both files should be in staging
      const entryA = await workingCopy.checkout.staging.getEntry("file-a.txt");
      const entryB = await workingCopy.checkout.staging.getEntry("file-b.txt");
      expect(entryA).toBeDefined();
      expect(entryB).toBeDefined();
    });

    it("should use custom merge message", async () => {
      const { git, repository } = await createInitializedGit();

      // Create branch1
      await git.branchCreate().setName("branch1").call();

      // Add commit on main
      await git.commit().setMessage("main commit").setAllowEmpty(true).call();

      // Switch to branch1 and add commit
      await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
      await git.commit().setMessage("branch commit").setAllowEmpty(true).call();

      // Merge with custom message
      const result = await git
        .merge()
        .include("refs/heads/main")
        .setMessage("Custom merge message")
        .call();

      expect(result.status).toBe(MergeStatus.MERGED);

      const mergeCommit = await repository.commits.load(result.newHead ?? "");
      expect(mergeCommit.message).toBe("Custom merge message");
    });
  });

  // ===== Conflict Handling =====

  describe("conflict handling", () => {
    it("should detect conflicts when same file modified differently", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Add a file on initial commit
      await addFile(workingCopy, "conflict.txt", "original");
      await git.commit().setMessage("add file").call();

      // Create branch1 at current commit
      await git.branchCreate().setName("branch1").call();

      // Modify file on main
      await addFile(workingCopy, "conflict.txt", "main version");
      await git.commit().setMessage("main change").call();

      // Switch to branch1
      await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
      // Reset staging to branch1's tree
      const branch1Ref = await repository.refs.resolve("refs/heads/branch1");
      const branch1Commit = await repository.commits.load(branch1Ref?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, branch1Commit.tree);

      // Modify same file differently on branch1
      await addFile(workingCopy, "conflict.txt", "branch version");
      await git.commit().setMessage("branch change").call();

      // Merge main into branch1 - should conflict
      const result = await git.merge().include("refs/heads/main").call();

      expect(result.status).toBe(MergeStatus.CONFLICTING);
      expect(result.conflicts).toContain("conflict.txt");
    });

    it("should write conflict stages to staging area", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Add a file
      await addFile(workingCopy, "conflict.txt", "original");
      await git.commit().setMessage("add file").call();

      // Create branch1
      await git.branchCreate().setName("branch1").call();

      // Modify on main
      await addFile(workingCopy, "conflict.txt", "main version");
      await git.commit().setMessage("main change").call();

      // Switch to branch1 and modify
      await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
      const branch1Ref = await repository.refs.resolve("refs/heads/branch1");
      const branch1Commit = await repository.commits.load(branch1Ref?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, branch1Commit.tree);
      await addFile(workingCopy, "conflict.txt", "branch version");
      await git.commit().setMessage("branch change").call();

      // Merge
      await git.merge().include("refs/heads/main").call();

      // Should have conflict entries
      const hasConflicts = await workingCopy.checkout.staging.hasConflicts();
      expect(hasConflicts).toBe(true);

      // Should have multiple stages for the conflict path
      const entries = await workingCopy.checkout.staging.getEntries("conflict.txt");
      expect(entries.length).toBeGreaterThan(1);
    });
  });

  // ===== Squash Merge =====

  describe("squash merge", () => {
    it("should stage changes but not commit with squash (fast-forward case)", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create branch1 at initial commit
      await git.branchCreate().setName("branch1").call();

      // Add commits on main
      await addFile(workingCopy, "file1.txt", "content1");
      await git.commit().setMessage("add file1").call();

      // Switch to branch1
      await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
      const branch1Ref = await repository.refs.resolve("refs/heads/branch1");

      // Squash merge main (this is a fast-forward scenario)
      const result = await git.merge().include("refs/heads/main").setSquash(true).call();

      expect(result.status).toBe(MergeStatus.FAST_FORWARD_SQUASHED);

      // HEAD should still be at original position (not moved)
      const newBranch1 = await repository.refs.resolve("refs/heads/branch1");
      expect(newBranch1?.objectId).toBe(branch1Ref?.objectId);

      // But staging should have the file
      const entry = await workingCopy.checkout.staging.getEntry("file1.txt");
      expect(entry).toBeDefined();
    });
  });

  // ===== No Commit Mode =====

  describe("no-commit mode", () => {
    it("should merge but not commit with setCommit(false)", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create branch1
      await git.branchCreate().setName("branch1").call();

      // Add commit on main
      await addFile(workingCopy, "file1.txt", "content");
      await git.commit().setMessage("main commit").call();

      // Switch to branch1 and add different file
      await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
      const branch1Before = await repository.refs.resolve("refs/heads/branch1");
      const branch1Commit = await repository.commits.load(branch1Before?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, branch1Commit.tree);
      await addFile(workingCopy, "file2.txt", "content2");
      await git.commit().setMessage("branch commit").call();

      const branch1After = await repository.refs.resolve("refs/heads/branch1");

      // Merge with no-commit
      const result = await git.merge().include("refs/heads/main").setCommit(false).call();

      expect(result.status).toBe(MergeStatus.MERGED_NOT_COMMITTED);

      // HEAD should be unchanged
      const branch1Final = await repository.refs.resolve("refs/heads/branch1");
      expect(branch1Final?.objectId).toBe(branch1After?.objectId);

      // But staging should have merged content
      const entry1 = await workingCopy.checkout.staging.getEntry("file1.txt");
      const entry2 = await workingCopy.checkout.staging.getEntry("file2.txt");
      expect(entry1).toBeDefined();
      expect(entry2).toBeDefined();
    });
  });

  // ===== Error Cases =====

  describe("error handling", () => {
    it("should throw when no merge head specified", async () => {
      const { git } = await createInitializedGit();

      await expect(git.merge().call()).rejects.toThrow(InvalidMergeHeadsError);
    });

    it("should throw when multiple merge heads specified", async () => {
      const { git } = await createInitializedGit();

      await expect(git.merge().include("branch1").include("branch2").call()).rejects.toThrow(
        InvalidMergeHeadsError,
      );
    });

    it("should not be callable twice", async () => {
      const { git } = await createInitializedGit();

      const cmd = git.merge().include("HEAD");
      await cmd.call();

      await expect(cmd.call()).rejects.toThrow(/already been called/);
    });
  });

  // ===== Branch Resolution =====

  describe("branch resolution", () => {
    it("should resolve branch name to commit", async () => {
      const { git, repository } = await createInitializedGit();

      // Create and checkout feature branch
      await git.branchCreate().setName("feature").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/feature");

      // Add commit on feature
      await git.commit().setMessage("feature commit").setAllowEmpty(true).call();
      const featureRef = await repository.refs.resolve("refs/heads/feature");

      // Switch back to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");

      // Merge using branch name
      const result = await git.merge().include("feature").call();

      expect(result.status).toBe(MergeStatus.FAST_FORWARD);
      expect(result.newHead).toBe(featureRef?.objectId);
    });

    it("should resolve commit ID directly", async () => {
      const { git, repository } = await createInitializedGit();

      // Create branch and add commit
      await git.branchCreate().setName("feature").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/feature");
      await git.commit().setMessage("feature commit").setAllowEmpty(true).call();
      const featureRef = await repository.refs.resolve("refs/heads/feature");

      // Switch to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");

      // Merge using commit ID
      const result = await git
        .merge()
        .include(featureRef?.objectId ?? "")
        .call();

      expect(result.status).toBe(MergeStatus.FAST_FORWARD);
    });
  });
});

describe.each(backends)("MergeCommand with log verification ($name backend)", ({ factory }) => {
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

  it("should show merge commit in log with correct parents", async () => {
    const { git, repository } = await createInitializedGit();

    // Create divergent branches
    await git.branchCreate().setName("feature").call();

    await git.commit().setMessage("main commit").setAllowEmpty(true).call();
    const mainHead = await repository.refs.resolve("refs/heads/main");

    await repository.refs.setSymbolic("HEAD", "refs/heads/feature");
    await git.commit().setMessage("feature commit").setAllowEmpty(true).call();
    const featureHead = await repository.refs.resolve("refs/heads/feature");

    // Merge main into feature
    const result = await git.merge().include("refs/heads/main").call();

    expect(result.status).toBe(MergeStatus.MERGED);

    // Log should show merge commit
    const commits = await toArray(await git.log().call());
    expect(commits.length).toBe(4); // merge + feature + main + initial

    // First commit should be the merge
    const mergeCommit = commits[0];
    expect(mergeCommit.parents.length).toBe(2);
    expect(mergeCommit.parents).toContain(featureHead?.objectId);
    expect(mergeCommit.parents).toContain(mainHead?.objectId);
  });
});

// ===== JGit Ported Tests =====

describe.each(backends)("MergeCommand - JGit deletion tests ($name backend)", ({ factory }) => {
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
   * JGit: testSingleDeletion
   * Tests merging a deletion from one branch into another.
   */
  it("should merge when one side deletes a file (single deletion)", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Setup: add files a, b, c, d
    await addFile(workingCopy, "a", "1\na\n3\n");
    await addFile(workingCopy, "b", "1\nb\n3\n");
    await addFile(workingCopy, "c/c/c", "1\nc\n3\n");
    await addFile(workingCopy, "d", "1\nd\n3\n");
    await git.commit().setMessage("initial").call();

    // Create side branch
    await git.branchCreate().setName("side").call();
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");

    // Reset staging to side's tree
    const sideRef = await repository.refs.resolve("refs/heads/side");
    const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

    // Delete file b on side branch
    await removeFile(workingCopy, "b");
    await git.commit().setMessage("side - delete b").call();

    // Switch back to main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    const mainRef = await repository.refs.resolve("refs/heads/main");
    const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

    // Modify files a and c on main
    await addFile(workingCopy, "a", "1\na\n3(main)\n");
    await addFile(workingCopy, "c/c/c", "1\nc(main)\n3\n");
    await git.commit().setMessage("main - modify a and c").call();

    // Merge side into main - should succeed with b deleted
    const result = await git.merge().include("refs/heads/side").call();

    expect(result.status).toBe(MergeStatus.MERGED);

    // File b should be deleted in merged tree
    const entry = await workingCopy.checkout.staging.getEntry("b");
    expect(entry).toBeUndefined();

    // File a should have main's content
    const entryA = await workingCopy.checkout.staging.getEntry("a");
    expect(entryA).toBeDefined();
  });

  /**
   * JGit: testMultipleDeletions
   * Both sides delete the same file.
   */
  it("should merge when both sides delete same file", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Add file a
    await addFile(workingCopy, "a", "1\na\n3\n");
    await git.commit().setMessage("initial").call();

    // Create side branch
    await git.branchCreate().setName("side").call();
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");

    // Reset staging
    const sideRef = await repository.refs.resolve("refs/heads/side");
    const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

    // Delete file a on side
    await removeFile(workingCopy, "a");
    await git.commit().setMessage("side - delete a").call();

    // Switch to main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    const mainRef = await repository.refs.resolve("refs/heads/main");
    const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

    // Delete file a on main too
    await removeFile(workingCopy, "a");
    await git.commit().setMessage("main - delete a").call();

    // Merge side into main
    const result = await git.merge().include("refs/heads/side").call();

    expect(result.status).toBe(MergeStatus.MERGED);
  });

  /**
   * JGit: testDeletionAndConflict
   * One side deletes a file, other side has unrelated conflict.
   */
  it("should handle deletion with unrelated conflict", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Setup files
    await addFile(workingCopy, "a", "1\na\n3\n");
    await addFile(workingCopy, "b", "1\nb\n3\n");
    await addFile(workingCopy, "c/c/c", "1\nc\n3\n");
    await addFile(workingCopy, "d", "1\nd\n3\n");
    await git.commit().setMessage("initial").call();

    // Create side branch
    await git.branchCreate().setName("side").call();
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");

    const sideRef = await repository.refs.resolve("refs/heads/side");
    const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

    // Delete b and modify a on side
    await removeFile(workingCopy, "b");
    await addFile(workingCopy, "a", "1\na\n3(side)\n");
    await git.commit().setMessage("side changes").call();

    // Switch to main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    const mainRef = await repository.refs.resolve("refs/heads/main");
    const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

    // Modify a differently on main (will conflict) and c
    await addFile(workingCopy, "a", "1\na\n3(main)\n");
    await addFile(workingCopy, "c/c/c", "1\nc(main)\n3\n");
    await git.commit().setMessage("main changes").call();

    // Merge should conflict on a, but b deletion should be applied
    const result = await git.merge().include("refs/heads/side").call();

    expect(result.status).toBe(MergeStatus.CONFLICTING);
    expect(result.conflicts).toContain("a");
  });

  /**
   * JGit: testDeletionOnSideConflict
   * Side deletes a file, main modifies it - should conflict.
   */
  it("should conflict when side deletes what main modified", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Add files
    await addFile(workingCopy, "a", "1\na\n3\n");
    await addFile(workingCopy, "b", "1\nb\n3\n");
    await git.commit().setMessage("initial").call();

    // Create side branch and delete a
    await git.branchCreate().setName("side").call();
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");

    const sideRef = await repository.refs.resolve("refs/heads/side");
    const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

    await removeFile(workingCopy, "a");
    await git.commit().setMessage("side - delete a").call();

    // Switch to main and modify a
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    const mainRef = await repository.refs.resolve("refs/heads/main");
    const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

    await addFile(workingCopy, "a", "1\na(main)\n3\n");
    await git.commit().setMessage("main - modify a").call();

    // Merge - should conflict
    const result = await git.merge().include("refs/heads/side").call();

    expect(result.status).toBe(MergeStatus.CONFLICTING);
    expect(result.conflicts).toContain("a");
  });

  /**
   * JGit: testDeletionOnMasterConflict
   * Main deletes a file, side modifies it - should conflict.
   */
  it("should conflict when main deletes what side modified", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Add files
    await addFile(workingCopy, "a", "1\na\n3\n");
    await addFile(workingCopy, "b", "1\nb\n3\n");
    await git.commit().setMessage("initial").call();

    // Create side branch and modify a
    await git.branchCreate().setName("side").call();
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");

    const sideRef = await repository.refs.resolve("refs/heads/side");
    const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

    await addFile(workingCopy, "a", "1\na(side)\n3\n");
    await git.commit().setMessage("side - modify a").call();

    // Switch to main and delete a
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    const mainRef = await repository.refs.resolve("refs/heads/main");
    const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

    await removeFile(workingCopy, "a");
    await git.commit().setMessage("main - delete a").call();

    // Merge - should conflict
    const result = await git.merge().include("refs/heads/side").call();

    expect(result.status).toBe(MergeStatus.CONFLICTING);
    expect(result.conflicts).toContain("a");
  });
});

describe.each(backends)("MergeCommand - JGit creation tests ($name backend)", ({ factory }) => {
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
   * JGit: testMultipleCreations
   * Both sides create same file with different content - should conflict.
   */
  it("should conflict when both sides create same file differently", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Add initial file
    await addFile(workingCopy, "a", "1\na\n3\n");
    await git.commit().setMessage("initial").call();

    // Create side branch
    await git.branchCreate().setName("side").call();
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");

    const sideRef = await repository.refs.resolve("refs/heads/side");
    const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

    // Create file b on side
    await addFile(workingCopy, "b", "1\nb(side)\n3\n");
    await git.commit().setMessage("side - add b").call();

    // Switch to main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    const mainRef = await repository.refs.resolve("refs/heads/main");
    const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

    // Create file b with different content on main
    await addFile(workingCopy, "b", "1\nb(main)\n3\n");
    await git.commit().setMessage("main - add b").call();

    // Merge - should conflict
    const result = await git.merge().include("refs/heads/side").call();

    expect(result.status).toBe(MergeStatus.CONFLICTING);
    expect(result.conflicts).toContain("b");
  });

  /**
   * JGit: testMultipleCreationsSameContent
   * Both sides create same file with same content - should merge cleanly.
   */
  it("should merge when both sides create same file with same content", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Add initial file
    await addFile(workingCopy, "a", "1\na\n3\n");
    await git.commit().setMessage("initial").call();

    // Create side branch
    await git.branchCreate().setName("side").call();
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");

    const sideRef = await repository.refs.resolve("refs/heads/side");
    const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

    // Create file b on side
    await addFile(workingCopy, "b", "1\nb(same)\n3\n");
    await git.commit().setMessage("side - add b").call();

    // Switch to main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    const mainRef = await repository.refs.resolve("refs/heads/main");
    const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

    // Create file b with same content on main
    await addFile(workingCopy, "b", "1\nb(same)\n3\n");
    await git.commit().setMessage("main - add b").call();

    // Merge - should succeed
    const result = await git.merge().include("refs/heads/side").call();

    expect(result.status).toBe(MergeStatus.MERGED);

    // File b should exist
    const entry = await workingCopy.checkout.staging.getEntry("b");
    expect(entry).toBeDefined();
  });
});

describe.each(backends)("MergeCommand - JGit squash tests ($name backend)", ({ factory }) => {
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
   * JGit: testSquashFastForward
   * Squash merge when fast-forward is possible.
   */
  it("should return FAST_FORWARD_SQUASHED when squashing fast-forward merge", async () => {
    const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

    // Create branch1 at initial commit
    await git.branchCreate().setName("branch1").call();

    // Stay on main, checkout branch1
    await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");

    // Add files on branch1
    await addFile(workingCopy, "file2", "file2 content");
    await git.commit().setMessage("second commit").call();

    await addFile(workingCopy, "file3", "file3 content");
    await git.commit().setMessage("third commit").call();

    // Switch back to main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(initialCommitId)).tree,
    );

    // Squash merge branch1 into main
    const result = await git.merge().include("refs/heads/branch1").setSquash(true).call();

    expect(result.status).toBe(MergeStatus.FAST_FORWARD_SQUASHED);
    // HEAD should not move
    expect(result.newHead).toBe(initialCommitId);

    // But staging should have the files
    const entry2 = await workingCopy.checkout.staging.getEntry("file2");
    const entry3 = await workingCopy.checkout.staging.getEntry("file3");
    expect(entry2).toBeDefined();
    expect(entry3).toBeDefined();
  });

  /**
   * JGit: testSquashMerge
   * Squash merge with divergent branches.
   */
  it("should return MERGED_SQUASHED when squashing three-way merge", async () => {
    const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

    // Create branch1 at initial commit
    await git.branchCreate().setName("branch1").call();

    // Add file on main
    await addFile(workingCopy, "file2", "file2");
    await git.commit().setMessage("second commit on main").call();
    const mainHead = await repository.refs.resolve("refs/heads/main");

    // Switch to branch1
    await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(initialCommitId)).tree,
    );

    // Add file on branch1
    await addFile(workingCopy, "file3", "file3");
    await git.commit().setMessage("third commit on branch1").call();

    // Switch back to main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(mainHead?.objectId ?? "")).tree,
    );

    // Squash merge branch1
    const result = await git.merge().include("refs/heads/branch1").setSquash(true).call();

    expect(result.status).toBe(MergeStatus.MERGED_SQUASHED);
    // HEAD should not move
    expect(result.newHead).toBe(mainHead?.objectId);

    // Staging should have both files
    const entry2 = await workingCopy.checkout.staging.getEntry("file2");
    const entry3 = await workingCopy.checkout.staging.getEntry("file3");
    expect(entry2).toBeDefined();
    expect(entry3).toBeDefined();
  });

  /**
   * JGit: testSquashMergeConflict
   * Squash merge with conflict.
   */
  it("should return CONFLICTING when squash merge has conflicts", async () => {
    const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

    // Create branch1
    await git.branchCreate().setName("branch1").call();

    // Add file on main
    await addFile(workingCopy, "file", "main content");
    await git.commit().setMessage("main commit").call();
    const mainHead = await repository.refs.resolve("refs/heads/main");

    // Switch to branch1
    await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(initialCommitId)).tree,
    );

    // Add same file with different content on branch1
    await addFile(workingCopy, "file", "branch content");
    await git.commit().setMessage("branch commit").call();

    // Switch back to main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(mainHead?.objectId ?? "")).tree,
    );

    // Squash merge - should conflict
    const result = await git.merge().include("refs/heads/branch1").setSquash(true).call();

    expect(result.status).toBe(MergeStatus.CONFLICTING);
    expect(result.conflicts).toContain("file");
  });
});

describe.each(backends)("MergeCommand - JGit fast-forward tests ($name backend)", ({ factory }) => {
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
   * JGit: testFastForwardNoCommit
   * Fast-forward with setCommit(false) - should still fast-forward.
   */
  it("should fast-forward even with setCommit(false)", async () => {
    const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

    // Create branch1 at initial commit
    await git.branchCreate().setName("branch1").call();

    // Add commit on main
    await git.commit().setMessage("second commit").setAllowEmpty(true).call();
    const mainHead = await repository.refs.resolve("refs/heads/main");

    // Switch to branch1
    await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(initialCommitId)).tree,
    );

    // Fast-forward merge with no-commit flag
    const result = await git.merge().include("refs/heads/main").setCommit(false).call();

    // Should still fast-forward (no-commit doesn't affect FF)
    expect(result.status).toBe(MergeStatus.FAST_FORWARD);
    expect(result.newHead).toBe(mainHead?.objectId);
  });

  /**
   * JGit: testFastForwardOnly
   * FF_ONLY mode when fast-forward is possible.
   */
  it("should fast-forward when FF_ONLY and fast-forward possible", async () => {
    const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

    // Create branch1
    await git.branchCreate().setName("branch1").call();

    // Add commit on main
    await git.commit().setMessage("second commit").setAllowEmpty(true).call();
    const mainHead = await repository.refs.resolve("refs/heads/main");

    // Switch to branch1
    await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(initialCommitId)).tree,
    );

    // FF_ONLY merge
    const result = await git
      .merge()
      .include("refs/heads/main")
      .setFastForwardMode(FastForwardMode.FF_ONLY)
      .call();

    expect(result.status).toBe(MergeStatus.FAST_FORWARD);
    expect(result.newHead).toBe(mainHead?.objectId);
  });

  /**
   * JGit: testNoFastForward
   * NO_FF mode - always create merge commit.
   */
  it("should create merge commit when NO_FF even if fast-forward possible", async () => {
    const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

    // Create branch1
    await git.branchCreate().setName("branch1").call();

    // Add commit on main
    await git.commit().setMessage("second commit").setAllowEmpty(true).call();

    // Switch to branch1
    await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(initialCommitId)).tree,
    );

    // NO_FF merge
    const result = await git
      .merge()
      .include("refs/heads/main")
      .setFastForwardMode(FastForwardMode.NO_FF)
      .call();

    expect(result.status).toBe(MergeStatus.MERGED);

    // Should have created merge commit with 2 parents
    const newCommit = await repository.commits.load(result.newHead ?? "");
    expect(newCommit.parents.length).toBe(2);
  });

  /**
   * JGit: testNoFastForwardNoCommit
   * NO_FF with setCommit(false) - merge but don't commit.
   */
  it("should merge but not commit when NO_FF with setCommit(false)", async () => {
    const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

    // Create branch1
    await git.branchCreate().setName("branch1").call();

    // Add commit on main
    await git.commit().setMessage("second commit").setAllowEmpty(true).call();

    // Switch to branch1
    await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
    const branch1Before = await repository.refs.resolve("refs/heads/branch1");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(initialCommitId)).tree,
    );

    // NO_FF merge with no-commit
    const result = await git
      .merge()
      .include("refs/heads/main")
      .setFastForwardMode(FastForwardMode.NO_FF)
      .setCommit(false)
      .call();

    expect(result.status).toBe(MergeStatus.MERGED_NOT_COMMITTED);

    // HEAD should not have moved
    const branch1After = await repository.refs.resolve("refs/heads/branch1");
    expect(branch1After?.objectId).toBe(branch1Before?.objectId);
  });

  /**
   * JGit: testFastForwardWithFiles
   * Fast-forward merge updates staging area with new files.
   */
  it("should update staging with files on fast-forward merge", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Add file1 on initial
    await addFile(workingCopy, "file1", "file1 content");
    await git.commit().setMessage("add file1").call();

    // Create branch1
    await git.branchCreate().setName("branch1").call();

    // Add file2 on main
    await addFile(workingCopy, "file2", "file2 content");
    await git.commit().setMessage("add file2").call();
    const mainHead = await repository.refs.resolve("refs/heads/main");

    // Switch to branch1 (which doesn't have file2)
    await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
    const branch1Ref = await repository.refs.resolve("refs/heads/branch1");
    const branch1Tree = (await repository.commits.load(branch1Ref?.objectId ?? "")).tree;
    await workingCopy.checkout.staging.readTree(repository.trees, branch1Tree);

    // Verify file2 not in staging
    const entry2Before = await workingCopy.checkout.staging.getEntry("file2");
    expect(entry2Before).toBeUndefined();

    // Fast-forward merge main into branch1
    const result = await git.merge().include("refs/heads/main").call();

    expect(result.status).toBe(MergeStatus.FAST_FORWARD);
    expect(result.newHead).toBe(mainHead?.objectId);

    // Now file2 should be in staging
    const entry2After = await workingCopy.checkout.staging.getEntry("file2");
    expect(entry2After).toBeDefined();
  });
});

describe.each(backends)(
  "MergeCommand - JGit content merge tests ($name backend)",
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
     * JGit: testSuccessfulContentMerge (adapted)
     *
     * Note: The current implementation does FILE-LEVEL merge only,
     * not content-level (line-by-line) merge. When both sides modify
     * the same file differently, it's marked as conflict even if the
     * changes are in different parts of the file.
     *
     * This test is adapted to verify file-level merge behavior:
     * - Each side modifies DIFFERENT files
     * - Same-file modifications result in conflict
     */
    it("should merge when each side modifies different files", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Setup initial files
      await addFile(workingCopy, "a", "1\na\n3\n");
      await addFile(workingCopy, "b", "1\nb\n3\n");
      await addFile(workingCopy, "c/c/c", "1\nc\n3\n");
      await git.commit().setMessage("initial").call();

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");

      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Modify only b on side (not a)
      await addFile(workingCopy, "b", "1\nb(side)\n3\n");
      await git.commit().setMessage("side changes").call();

      // Switch to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Modify only a and c on main (not b)
      await addFile(workingCopy, "a", "1\na\n3(main)\n");
      await addFile(workingCopy, "c/c/c", "1\nc(main)\n3\n");
      await git.commit().setMessage("main changes").call();

      // Merge - should succeed (no file modified by both sides)
      const result = await git.merge().include("refs/heads/side").call();

      expect(result.status).toBe(MergeStatus.MERGED);
      expect(result.conflicts).toBeUndefined();

      // Verify merge commit has 2 parents
      const mergeCommit = await repository.commits.load(result.newHead ?? "");
      expect(mergeCommit.parents.length).toBe(2);
    });

    /**
     * Content-level merge limitation test.
     *
     * When both sides modify the same file (even in different parts),
     * the current file-level merge marks it as conflict.
     */
    it("should conflict when both sides modify same file (file-level merge)", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Setup initial file
      await addFile(workingCopy, "a", "1\na\n3\n");
      await git.commit().setMessage("initial").call();

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");

      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Modify file a on side (first line)
      await addFile(workingCopy, "a", "1(side)\na\n3\n");
      await git.commit().setMessage("side changes").call();

      // Switch to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Modify file a on main (last line)
      await addFile(workingCopy, "a", "1\na\n3(main)\n");
      await git.commit().setMessage("main changes").call();

      // Merge - conflicts because same file modified by both (file-level merge)
      const result = await git.merge().include("refs/heads/side").call();

      expect(result.status).toBe(MergeStatus.CONFLICTING);
      expect(result.conflicts).toContain("a");
    });

    /**
     * JGit: testSuccessfulContentMergeNoCommit
     * Non-overlapping merge with setCommit(false).
     */
    it("should merge non-overlapping changes without commit when setCommit(false)", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Setup
      await addFile(workingCopy, "a", "1\na\n3\n");
      await addFile(workingCopy, "b", "1\nb\n3\n");
      await git.commit().setMessage("initial").call();

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");

      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Modify b on side
      await addFile(workingCopy, "b", "1\nb(side)\n3\n");
      await git.commit().setMessage("side changes").call();

      // Switch to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Modify a on main
      await addFile(workingCopy, "a", "1\na(main)\n3\n");
      await git.commit().setMessage("main changes").call();
      const mainHeadBefore = await repository.refs.resolve("refs/heads/main");

      // Merge with no-commit
      const result = await git.merge().include("refs/heads/side").setCommit(false).call();

      expect(result.status).toBe(MergeStatus.MERGED_NOT_COMMITTED);

      // HEAD should not have moved
      const mainHeadAfter = await repository.refs.resolve("refs/heads/main");
      expect(mainHeadAfter?.objectId).toBe(mainHeadBefore?.objectId);
    });

    /**
     * JGit: testMergeTag
     * Merge using a tag reference.
     */
    it("should resolve and merge a tag", async () => {
      const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

      // Create a commit on main
      await git.commit().setMessage("second commit").setAllowEmpty(true).call();
      const mainHead = await repository.refs.resolve("refs/heads/main");

      // Create a tag pointing to main
      await repository.refs.set("refs/tags/v1.0", mainHead?.objectId ?? "");

      // Create branch1 at initial commit
      await git.branchCreate().setName("branch1").setStartPoint(initialCommitId).call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
      await workingCopy.checkout.staging.readTree(
        repository.trees,
        (await repository.commits.load(initialCommitId)).tree,
      );

      // Merge the tag
      const result = await git.merge().include("refs/tags/v1.0").call();

      expect(result.status).toBe(MergeStatus.FAST_FORWARD);
      expect(result.newHead).toBe(mainHead?.objectId);
    });
  },
);

describe.each(backends)("MergeCommand - Merge strategies ($name backend)", ({ factory }) => {
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
   * JGit: testMergeStrategyOurs
   * OURS strategy keeps our tree unchanged, ignoring their changes.
   */
  it("should keep our tree with OURS strategy", async () => {
    const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

    // Create side branch from initial commit (before main changes)
    await git.branchCreate().setName("side").setStartPoint(initialCommitId).call();

    // Add file on main
    await addFile(workingCopy, "file", "main content");
    await git.commit().setMessage("main commit").call();
    const mainHead = await repository.refs.resolve("refs/heads/main");
    const mainTree = (await repository.commits.load(mainHead?.objectId ?? "")).tree;

    // Switch to side branch and add different content
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(initialCommitId)).tree,
    );

    // Add different file on side
    await addFile(workingCopy, "file", "side content");
    await git.commit().setMessage("side commit").call();

    // Switch back to main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    await workingCopy.checkout.staging.readTree(repository.trees, mainTree);

    // Merge with OURS strategy - should NOT conflict, keeps our tree
    const result = await git
      .merge()
      .include("refs/heads/side")
      .setStrategy(MergeStrategy.OURS)
      .call();

    expect(result.status).toBe(MergeStatus.MERGED);
    expect(result.conflicts).toBeUndefined();

    // Verify merge commit was created with 2 parents
    const mergeCommit = await repository.commits.load(result.newHead ?? "");
    expect(mergeCommit.parents.length).toBe(2);

    // Verify tree is unchanged (same as our tree)
    expect(mergeCommit.tree).toBe(mainTree);
  });

  /**
   * JGit: testMergeStrategyTheirs
   * THEIRS strategy replaces our tree with theirs.
   */
  it("should use their tree with THEIRS strategy", async () => {
    const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

    // Create side branch from initial commit (before main changes)
    await git.branchCreate().setName("side").setStartPoint(initialCommitId).call();

    // Add file on main
    await addFile(workingCopy, "file", "main content");
    await git.commit().setMessage("main commit").call();
    const mainHead = await repository.refs.resolve("refs/heads/main");
    const mainTree = (await repository.commits.load(mainHead?.objectId ?? "")).tree;

    // Switch to side branch and add different content
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(initialCommitId)).tree,
    );

    // Add different file on side
    await addFile(workingCopy, "file", "side content");
    await git.commit().setMessage("side commit").call();
    const sideHeadAfter = await repository.refs.resolve("refs/heads/side");
    const sideTree = (await repository.commits.load(sideHeadAfter?.objectId ?? "")).tree;

    // Switch back to main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    await workingCopy.checkout.staging.readTree(repository.trees, mainTree);

    // Merge with THEIRS strategy - should NOT conflict, uses their tree
    const result = await git
      .merge()
      .include("refs/heads/side")
      .setStrategy(MergeStrategy.THEIRS)
      .call();

    expect(result.status).toBe(MergeStatus.MERGED);
    expect(result.conflicts).toBeUndefined();

    // Verify merge commit was created with 2 parents
    const mergeCommit = await repository.commits.load(result.newHead ?? "");
    expect(mergeCommit.parents.length).toBe(2);

    // Verify tree is theirs
    expect(mergeCommit.tree).toBe(sideTree);
  });

  /**
   * OURS strategy with no-commit.
   */
  it("should stage our tree with OURS strategy and setCommit(false)", async () => {
    const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

    // Create side branch from initial commit (before main changes)
    await git.branchCreate().setName("side").setStartPoint(initialCommitId).call();

    // Add file on main
    await addFile(workingCopy, "file", "main content");
    await git.commit().setMessage("main commit").call();
    const mainHead = await repository.refs.resolve("refs/heads/main");
    const mainTree = (await repository.commits.load(mainHead?.objectId ?? "")).tree;

    // Switch to side branch and add different content
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(initialCommitId)).tree,
    );

    // Add different file on side
    await addFile(workingCopy, "file", "side content");
    await git.commit().setMessage("side commit").call();

    // Switch back to main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    await workingCopy.checkout.staging.readTree(repository.trees, mainTree);

    // Merge with OURS strategy and no-commit
    const result = await git
      .merge()
      .include("refs/heads/side")
      .setStrategy(MergeStrategy.OURS)
      .setCommit(false)
      .call();

    expect(result.status).toBe(MergeStatus.MERGED_NOT_COMMITTED);
    expect(result.newHead).toBe(mainHead?.objectId);

    // Staging should have our tree
    const treeId = await workingCopy.checkout.staging.writeTree(repository.trees);
    expect(treeId).toBe(mainTree);
  });

  /**
   * THEIRS strategy with no-commit.
   */
  it("should stage their tree with THEIRS strategy and setCommit(false)", async () => {
    const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

    // Create side branch from initial commit (before main changes)
    await git.branchCreate().setName("side").setStartPoint(initialCommitId).call();

    // Add file on main
    await addFile(workingCopy, "file", "main content");
    await git.commit().setMessage("main commit").call();
    const mainHead = await repository.refs.resolve("refs/heads/main");
    const mainTree = (await repository.commits.load(mainHead?.objectId ?? "")).tree;

    // Switch to side branch and add different content
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(initialCommitId)).tree,
    );

    // Add different file on side
    await addFile(workingCopy, "file", "side content");
    await git.commit().setMessage("side commit").call();
    const sideHeadAfter = await repository.refs.resolve("refs/heads/side");
    const sideTree = (await repository.commits.load(sideHeadAfter?.objectId ?? "")).tree;

    // Switch back to main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    await workingCopy.checkout.staging.readTree(repository.trees, mainTree);

    // Merge with THEIRS strategy and no-commit
    const result = await git
      .merge()
      .include("refs/heads/side")
      .setStrategy(MergeStrategy.THEIRS)
      .setCommit(false)
      .call();

    expect(result.status).toBe(MergeStatus.MERGED_NOT_COMMITTED);
    expect(result.newHead).toBe(mainHead?.objectId);

    // Staging should have their tree
    const treeId = await workingCopy.checkout.staging.writeTree(repository.trees);
    expect(treeId).toBe(sideTree);
  });

  /**
   * OURS strategy should still fast-forward when possible by default.
   */
  it("should fast-forward with OURS strategy when possible", async () => {
    const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

    // Create branch1 at initial commit
    await git.branchCreate().setName("branch1").call();

    // Add commit on main
    await git.commit().setMessage("second commit").setAllowEmpty(true).call();
    const mainHead = await repository.refs.resolve("refs/heads/main");

    // Switch to branch1
    await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(initialCommitId)).tree,
    );

    // Merge main into branch1 with OURS strategy (but FF is possible)
    const result = await git
      .merge()
      .include("refs/heads/main")
      .setStrategy(MergeStrategy.OURS)
      .call();

    // Should still fast-forward since we're behind
    expect(result.status).toBe(MergeStatus.FAST_FORWARD);
    expect(result.newHead).toBe(mainHead?.objectId);
  });

  /**
   * THEIRS strategy should still fast-forward when possible by default.
   */
  it("should fast-forward with THEIRS strategy when possible", async () => {
    const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

    // Create branch1 at initial commit
    await git.branchCreate().setName("branch1").call();

    // Add commit on main
    await git.commit().setMessage("second commit").setAllowEmpty(true).call();
    const mainHead = await repository.refs.resolve("refs/heads/main");

    // Switch to branch1
    await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(initialCommitId)).tree,
    );

    // Merge main into branch1 with THEIRS strategy (but FF is possible)
    const result = await git
      .merge()
      .include("refs/heads/main")
      .setStrategy(MergeStrategy.THEIRS)
      .call();

    // Should still fast-forward since we're behind
    expect(result.status).toBe(MergeStatus.FAST_FORWARD);
    expect(result.newHead).toBe(mainHead?.objectId);
  });

  /**
   * OURS strategy with NO_FF should create merge commit.
   */
  it("should create merge commit with OURS strategy and NO_FF", async () => {
    const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

    // Create branch1 at initial commit
    await git.branchCreate().setName("branch1").call();

    // Add commit on main
    await git.commit().setMessage("second commit").setAllowEmpty(true).call();

    // Switch to branch1
    await repository.refs.setSymbolic("HEAD", "refs/heads/branch1");
    await workingCopy.checkout.staging.readTree(
      repository.trees,
      (await repository.commits.load(initialCommitId)).tree,
    );

    // Merge main with OURS + NO_FF
    const result = await git
      .merge()
      .include("refs/heads/main")
      .setStrategy(MergeStrategy.OURS)
      .setFastForwardMode(FastForwardMode.NO_FF)
      .call();

    expect(result.status).toBe(MergeStatus.MERGED);

    // Should have created merge commit with 2 parents
    const mergeCommit = await repository.commits.load(result.newHead ?? "");
    expect(mergeCommit.parents.length).toBe(2);
  });

  /**
   * JGit parity: Additional merge algorithm conflict tests.
   * Ported from MergeAlgorithmTest.java patterns adapted for tree-level merge.
   */
  describe("merge algorithm conflict scenarios (JGit parity)", () => {
    /**
     * JGit: testTwoConflictingModifications pattern
     * Both sides modify the same file differently - should conflict.
     */
    it("should conflict when both sides modify same file with different content", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Base content
      await addFile(workingCopy, "file.txt", "line1\nline2\nline3\n");
      await git.commit().setMessage("base").call();

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Modify on side
      await addFile(workingCopy, "file.txt", "line1\nmodified-side\nline3\n");
      await git.commit().setMessage("side modification").call();

      // Switch to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Modify same file differently on main
      await addFile(workingCopy, "file.txt", "line1\nmodified-main\nline3\n");
      await git.commit().setMessage("main modification").call();

      // Merge should conflict
      const result = await git.merge().include("refs/heads/side").call();
      expect(result.status).toBe(MergeStatus.CONFLICTING);
      expect(result.conflicts).toContain("file.txt");
    });

    /**
     * JGit: testNoAgainstOneModification pattern
     * Only one side modifies - should merge cleanly.
     */
    it("should merge cleanly when only one side modifies a file", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Base with two files
      await addFile(workingCopy, "unchanged.txt", "unchanged content\n");
      await addFile(workingCopy, "modified.txt", "original content\n");
      await git.commit().setMessage("base").call();

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Modify file on side only
      await addFile(workingCopy, "modified.txt", "modified by side\n");
      await git.commit().setMessage("side modification").call();

      // Switch to main - don't modify anything
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Create an empty commit on main to force non-fast-forward
      await addFile(workingCopy, "new-main.txt", "new on main\n");
      await git.commit().setMessage("main commit").call();

      // Merge should succeed without conflict
      const result = await git.merge().include("refs/heads/side").call();
      expect(result.status).toBe(MergeStatus.MERGED);
      expect(result.conflicts).toBeUndefined();
    });

    /**
     * JGit: testTwoNonConflictingModifications pattern
     * Both sides modify different files - should merge cleanly.
     */
    it("should merge cleanly when both sides modify different files", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Base with two files
      await addFile(workingCopy, "file-a.txt", "content a\n");
      await addFile(workingCopy, "file-b.txt", "content b\n");
      await git.commit().setMessage("base").call();

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Modify file-b on side
      await addFile(workingCopy, "file-b.txt", "modified by side\n");
      await git.commit().setMessage("side modifies b").call();

      // Switch to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Modify file-a on main
      await addFile(workingCopy, "file-a.txt", "modified by main\n");
      await git.commit().setMessage("main modifies a").call();

      // Merge should succeed
      const result = await git.merge().include("refs/heads/side").call();
      expect(result.status).toBe(MergeStatus.MERGED);
      expect(result.conflicts).toBeUndefined();
    });

    /**
     * JGit: testSameModification pattern
     * Both sides make identical modification - should merge cleanly.
     */
    it("should merge cleanly when both sides make identical changes", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Base
      await addFile(workingCopy, "file.txt", "original\n");
      await git.commit().setMessage("base").call();

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Make identical modification on side
      await addFile(workingCopy, "file.txt", "identical change\n");
      await git.commit().setMessage("side makes change").call();

      // Switch to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Make identical modification on main
      await addFile(workingCopy, "file.txt", "identical change\n");
      await git.commit().setMessage("main makes same change").call();

      // Merge should succeed (identical changes converge)
      const result = await git.merge().include("refs/heads/side").call();
      expect(result.status).toBe(MergeStatus.MERGED);
      expect(result.conflicts).toBeUndefined();
    });

    /**
     * JGit: testDeleteVsModify pattern
     * One side deletes, other modifies - should conflict.
     */
    it("should conflict when one side deletes and other modifies", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Base
      await addFile(workingCopy, "file.txt", "content\n");
      await git.commit().setMessage("base").call();

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Delete on side
      await removeFile(workingCopy, "file.txt");
      await git.commit().setMessage("side deletes file").call();

      // Switch to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Modify on main
      await addFile(workingCopy, "file.txt", "modified\n");
      await git.commit().setMessage("main modifies file").call();

      // Merge should conflict
      const result = await git.merge().include("refs/heads/side").call();
      expect(result.status).toBe(MergeStatus.CONFLICTING);
      expect(result.conflicts).toContain("file.txt");
    });

    /**
     * JGit: testInsertVsModify pattern (adapted)
     * One side adds new file, other modifies different file - no conflict.
     */
    it("should merge cleanly when one side adds file and other modifies different file", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Base
      await addFile(workingCopy, "existing.txt", "content\n");
      await git.commit().setMessage("base").call();

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Add new file on side
      await addFile(workingCopy, "new-file.txt", "new content\n");
      await git.commit().setMessage("side adds file").call();

      // Switch to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Modify existing file on main
      await addFile(workingCopy, "existing.txt", "modified\n");
      await git.commit().setMessage("main modifies existing").call();

      // Merge should succeed
      const result = await git.merge().include("refs/heads/side").call();
      expect(result.status).toBe(MergeStatus.MERGED);
      expect(result.conflicts).toBeUndefined();
    });
  });

  /**
   * Content merge strategy integration tests.
   *
   * Tests for OURS, THEIRS, and UNION content merge strategies using MergeCommand.
   * These test the integration between MergeCommand and the merge algorithm.
   */
  describe("content merge strategies", () => {
    /**
     * Helper to convert single-character-per-line notation to actual content.
     * Each character becomes a line: "abc" -> "a\nb\nc\n"
     */
    function toLines(text: string): string {
      if (text === "") return "";
      return `${text.split("").join("\n")}\n`;
    }

    /**
     * Helper to collect bytes from an async iterable.
     */
    async function collectBytes(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
      const chunks: Uint8Array[] = [];
      for await (const chunk of iterable) {
        chunks.push(chunk);
      }
      if (chunks.length === 0) return new Uint8Array(0);
      if (chunks.length === 1) return chunks[0];
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    }

    /**
     * Test OURS content merge strategy resolves conflicts by taking our version.
     */
    it("should resolve conflicts using OURS content strategy", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Base content
      await addFile(workingCopy, "file.txt", toLines("abc"));
      await git.commit().setMessage("base").call();

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Modify file on side (b -> Y)
      await addFile(workingCopy, "file.txt", toLines("aYc"));
      await git.commit().setMessage("side modification").call();

      // Switch to main and modify differently (b -> Z)
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);
      await addFile(workingCopy, "file.txt", toLines("aZc"));
      await git.commit().setMessage("main modification").call();

      // Merge with OURS content strategy - should resolve without conflict
      const result = await git
        .merge()
        .include("refs/heads/side")
        .setContentMergeStrategy(ContentMergeStrategy.OURS)
        .call();

      expect(result.status).toBe(MergeStatus.MERGED);
      expect(result.conflicts).toBeUndefined();

      // Verify merged content is ours (Z)
      const entry = await workingCopy.checkout.staging.getEntry("file.txt");
      expect(entry).toBeDefined();
      const blobContent = await repository.blobs.load(entry?.objectId ?? "");
      if (!blobContent) throw new Error("Blob not found");
      const content = await collectBytes(blobContent);
      expect(new TextDecoder().decode(content)).toBe(toLines("aZc"));
    });

    /**
     * Test THEIRS content merge strategy resolves conflicts by taking their version.
     */
    it("should resolve conflicts using THEIRS content strategy", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Base content
      await addFile(workingCopy, "file.txt", toLines("abc"));
      await git.commit().setMessage("base").call();

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Modify file on side (b -> Y)
      await addFile(workingCopy, "file.txt", toLines("aYc"));
      await git.commit().setMessage("side modification").call();

      // Switch to main and modify differently (b -> Z)
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);
      await addFile(workingCopy, "file.txt", toLines("aZc"));
      await git.commit().setMessage("main modification").call();

      // Merge with THEIRS content strategy - should resolve without conflict
      const result = await git
        .merge()
        .include("refs/heads/side")
        .setContentMergeStrategy(ContentMergeStrategy.THEIRS)
        .call();

      expect(result.status).toBe(MergeStatus.MERGED);
      expect(result.conflicts).toBeUndefined();

      // Verify merged content is theirs (Y)
      const entry = await workingCopy.checkout.staging.getEntry("file.txt");
      expect(entry).toBeDefined();
      const blobContent = await repository.blobs.load(entry?.objectId ?? "");
      if (!blobContent) throw new Error("Blob not found");
      const content = await collectBytes(blobContent);
      expect(new TextDecoder().decode(content)).toBe(toLines("aYc"));
    });

    /**
     * Test UNION content merge strategy concatenates both sides.
     */
    it("should resolve conflicts using UNION content strategy", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Base content
      await addFile(workingCopy, "file.txt", toLines("abc"));
      await git.commit().setMessage("base").call();

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Modify file on side (b -> Y)
      await addFile(workingCopy, "file.txt", toLines("aYc"));
      await git.commit().setMessage("side modification").call();

      // Switch to main and modify differently (b -> Z)
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);
      await addFile(workingCopy, "file.txt", toLines("aZc"));
      await git.commit().setMessage("main modification").call();

      // Merge with UNION content strategy - should resolve without conflict
      const result = await git
        .merge()
        .include("refs/heads/side")
        .setContentMergeStrategy(ContentMergeStrategy.UNION)
        .call();

      expect(result.status).toBe(MergeStatus.MERGED);
      expect(result.conflicts).toBeUndefined();

      // Verify merged content has both Z and Y (union)
      const entry = await workingCopy.checkout.staging.getEntry("file.txt");
      expect(entry).toBeDefined();
      const blobContent = await repository.blobs.load(entry?.objectId ?? "");
      if (!blobContent) throw new Error("Blob not found");
      const content = await collectBytes(blobContent);
      const contentStr = new TextDecoder().decode(content);
      // UNION puts ours first, then theirs (skipping duplicates)
      expect(contentStr).toBe(toLines("aZYc"));
    });

    /**
     * Test UNION does not duplicate when both sides make same change.
     */
    it("should not duplicate with UNION when both sides make same change", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Base content
      await addFile(workingCopy, "file.txt", toLines("abc"));
      await git.commit().setMessage("base").call();

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Modify file on side (b -> Z)
      await addFile(workingCopy, "file.txt", toLines("aZc"));
      await git.commit().setMessage("side modification").call();

      // Switch to main and make same modification (b -> Z)
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);
      await addFile(workingCopy, "file.txt", toLines("aZc"));
      await git.commit().setMessage("main modification").call();

      // Merge with UNION - should not conflict and not duplicate
      const result = await git
        .merge()
        .include("refs/heads/side")
        .setContentMergeStrategy(ContentMergeStrategy.UNION)
        .call();

      expect(result.status).toBe(MergeStatus.MERGED);

      // Verify no duplication
      const entry = await workingCopy.checkout.staging.getEntry("file.txt");
      const blobContent = await repository.blobs.load(entry?.objectId ?? "");
      if (!blobContent) throw new Error("Blob not found");
      const content = await collectBytes(blobContent);
      expect(new TextDecoder().decode(content)).toBe(toLines("aZc"));
    });

    /**
     * Test content merge still applies non-conflicting changes.
     */
    it("should merge non-conflicting changes with content strategy", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Base content with two files
      await addFile(workingCopy, "file-a.txt", toLines("abc"));
      await addFile(workingCopy, "file-b.txt", "original");
      await git.commit().setMessage("base").call();

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Modify file-a on side (b -> Y) and file-b
      await addFile(workingCopy, "file-a.txt", toLines("aYc"));
      await addFile(workingCopy, "file-b.txt", "side version");
      await git.commit().setMessage("side modifications").call();

      // Switch to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Modify file-a differently (b -> Z)
      await addFile(workingCopy, "file-a.txt", toLines("aZc"));
      await git.commit().setMessage("main modification").call();

      // Merge with OURS - file-a conflict resolved with ours, file-b from theirs
      const result = await git
        .merge()
        .include("refs/heads/side")
        .setContentMergeStrategy(ContentMergeStrategy.OURS)
        .call();

      expect(result.status).toBe(MergeStatus.MERGED);

      // file-a should have ours (Z)
      const entryA = await workingCopy.checkout.staging.getEntry("file-a.txt");
      const blobContentA = await repository.blobs.load(entryA?.objectId ?? "");
      if (!blobContentA) throw new Error("Blob not found");
      const contentA = await collectBytes(blobContentA);
      expect(new TextDecoder().decode(contentA)).toBe(toLines("aZc"));

      // file-b should have theirs (side version) since only they changed it
      const entryB = await workingCopy.checkout.staging.getEntry("file-b.txt");
      const blobContentB = await repository.blobs.load(entryB?.objectId ?? "");
      if (!blobContentB) throw new Error("Blob not found");
      const contentB = await collectBytes(blobContentB);
      expect(new TextDecoder().decode(contentB)).toBe("side version");
    });

    /**
     * Test without content strategy - conflict is still reported.
     */
    it("should report conflict without content strategy", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Base content
      await addFile(workingCopy, "file.txt", toLines("abc"));
      await git.commit().setMessage("base").call();

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Modify file on side
      await addFile(workingCopy, "file.txt", toLines("aYc"));
      await git.commit().setMessage("side modification").call();

      // Switch to main and modify differently
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);
      await addFile(workingCopy, "file.txt", toLines("aZc"));
      await git.commit().setMessage("main modification").call();

      // Merge WITHOUT content strategy - should conflict
      const result = await git.merge().include("refs/heads/side").call();

      expect(result.status).toBe(MergeStatus.CONFLICTING);
      expect(result.conflicts).toContain("file.txt");
    });
  });
});
