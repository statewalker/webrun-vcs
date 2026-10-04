/**
 * Tests for CherryPickCommand
 *
 * Ported from JGit's CherryPickCommandTest.java
 * Tests run against all storage backends (Memory, SQL).
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  CherryPickStatus,
  ContentMergeStrategy,
  MergeStrategy,
  MultipleParentsNotAllowedError,
} from "../src/index.js";
import { addFile, backends, createInitializedGitFromFactory, removeFile } from "./test-helper.js";

describe.each(backends)("CherryPickCommand ($name backend)", ({ factory }) => {
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
   * Test basic cherry-pick operation with conflict.
   *
   * Based on JGit's testCherryPick prepareCherryPick pattern.
   */
  it("should detect conflicts when both sides modify same file", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create file a on main
    await addFile(workingCopy, "a.txt", "a");
    await git.commit().setMessage("first master").call();
    const firstMaster = await repository.refs.resolve("HEAD");

    // Create and checkout side branch
    await git
      .branchCreate()
      .setName("side")
      .setStartPoint(firstMaster?.objectId ?? "")
      .call();
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");
    const firstCommit = await repository.commits.load(firstMaster?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, firstCommit.tree);

    // Modify a on side branch
    await addFile(workingCopy, "a.txt", "a(side)");
    await git.commit().setMessage("side").call();
    const sideCommit = await repository.refs.resolve("HEAD");

    // Checkout main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    await workingCopy.checkout.staging.readTree(repository.trees, firstCommit.tree);

    // Modify a on main differently
    await addFile(workingCopy, "a.txt", "a(master)");
    await git.commit().setMessage("second master").call();

    // Cherry-pick side commit - should conflict
    const result = await git
      .cherryPick()
      .include(sideCommit?.objectId ?? "")
      .call();

    expect(result.status).toBe(CherryPickStatus.CONFLICTING);
    expect(result.conflicts).toContain("a.txt");

    // Verify conflict stages in staging
    const hasConflicts = await workingCopy.checkout.staging.hasConflicts();
    expect(hasConflicts).toBe(true);

    // Check that we have entries at different stages
    const entries = await workingCopy.checkout.staging.getEntries("a.txt");
    expect(entries.length).toBeGreaterThan(1);
  });

  /**
   * Test cherry-pick with noCommit option.
   *
   * Based on JGit's testCherryPickNoCommit.
   */
  it("should cherry-pick without committing when noCommit is true", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create initial state
    await addFile(workingCopy, "a.txt", "initial");
    await git.commit().setMessage("initial").call();
    const initialCommit = await repository.refs.resolve("HEAD");

    // Create side branch
    await git
      .branchCreate()
      .setName("side")
      .setStartPoint(initialCommit?.objectId ?? "")
      .call();
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");
    const firstCommitData = await repository.commits.load(initialCommit?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, firstCommitData.tree);

    // Add new file on side branch
    await addFile(workingCopy, "b.txt", "side file");
    await git.commit().setMessage("add b on side").call();
    const sideCommit = await repository.refs.resolve("HEAD");

    // Checkout main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    await workingCopy.checkout.staging.readTree(repository.trees, firstCommitData.tree);

    // Cherry-pick with noCommit
    const result = await git
      .cherryPick()
      .include(sideCommit?.objectId ?? "")
      .setNoCommit(true)
      .call();

    expect(result.status).toBe(CherryPickStatus.OK);

    // HEAD should not have moved
    const newHeadRef = await repository.refs.resolve("HEAD");
    expect(newHeadRef?.objectId).toBe(initialCommit?.objectId);

    // But staging should have the new file
    const entry = await workingCopy.checkout.staging.getEntry("b.txt");
    expect(entry).toBeDefined();
  });

  /**
   * Test sequential cherry-picking of multiple commits.
   *
   * Based on JGit's testSequentialCherryPick.
   */
  it("should cherry-pick multiple commits sequentially", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create file a
    await addFile(workingCopy, "a.txt", "line 1\n");
    await git.commit().setMessage("create a").call();
    const commit1 = await repository.refs.resolve("HEAD");

    // Modify file a
    await addFile(workingCopy, "a.txt", "line 1\nline 2\n");
    await git.commit().setMessage("modify a").call();
    const commit2 = await repository.refs.resolve("HEAD");

    // Further modify file a
    await addFile(workingCopy, "a.txt", "line 1\nline 2\nline 3\n");
    await git.commit().setMessage("further modify a").call();
    const commit3 = await repository.refs.resolve("HEAD");

    // Create side branch at commit1
    await git
      .branchCreate()
      .setName("side")
      .setStartPoint(commit1?.objectId ?? "")
      .call();

    // Checkout side
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");
    const commit1Data = await repository.commits.load(commit1?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, commit1Data.tree);

    // Add different file on side
    await addFile(workingCopy, "b.txt", "side content");
    await git.commit().setMessage("create b on side").call();

    // Cherry-pick both commits from main
    const result = await git
      .cherryPick()
      .include(commit2?.objectId ?? "")
      .include(commit3?.objectId ?? "")
      .call();

    expect(result.status).toBe(CherryPickStatus.OK);
    expect(result.cherryPickedRefs).toHaveLength(2);

    // Verify commit history
    const commits: string[] = [];
    for await (const commit of await git.log().call()) {
      commits.push(commit.message);
    }

    expect(commits[0]).toBe("further modify a");
    expect(commits[1]).toBe("modify a");
    expect(commits[2]).toBe("create b on side");
    expect(commits[3]).toBe("create a");
  });

  /**
   * Test cherry-picking a merge commit requires mainline parent.
   *
   * Based on JGit's testCherryPickMerge.
   */
  it("should throw error when cherry-picking merge commit without mainline parent", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create base
    await addFile(workingCopy, "file.txt", "base");
    await git.commit().setMessage("base").call();
    const baseCommit = await repository.refs.resolve("HEAD");

    // Create side branch
    await git
      .branchCreate()
      .setName("side")
      .setStartPoint(baseCommit?.objectId ?? "")
      .call();

    // Modify on main
    await addFile(workingCopy, "main.txt", "main");
    await git.commit().setMessage("main change").call();
    const mainHead = await repository.refs.resolve("HEAD");

    // Checkout side and modify
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");
    const baseCommitData = await repository.commits.load(baseCommit?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);
    await addFile(workingCopy, "side.txt", "side");
    await git.commit().setMessage("side change").call();

    // Merge main into side
    const mergeResult = await git
      .merge()
      .include(mainHead?.objectId ?? "")
      .call();
    const mergeCommit = mergeResult.newHead;

    // Create target branch to cherry-pick onto
    await git
      .branchCreate()
      .setName("target")
      .setStartPoint(baseCommit?.objectId ?? "")
      .call();
    await repository.refs.setSymbolic("HEAD", "refs/heads/target");
    await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);

    // Try to cherry-pick merge commit without mainline parent
    await expect(
      git
        .cherryPick()
        .include(mergeCommit ?? "")
        .call(),
    ).rejects.toThrow(MultipleParentsNotAllowedError);
  });

  /**
   * Test cherry-picking a merge commit with mainline parent specified.
   *
   * Based on JGit's testCherryPickMerge (success cases).
   */
  it("should cherry-pick merge commit when mainline parent is specified", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create base commit
    await addFile(workingCopy, "file.txt", "base content");
    await git.commit().setMessage("base").call();
    const baseCommit = await repository.refs.resolve("HEAD");

    // Create side branch
    await git
      .branchCreate()
      .setName("side")
      .setStartPoint(baseCommit?.objectId ?? "")
      .call();

    // Modify on main - add a new file
    await addFile(workingCopy, "main-file.txt", "from main");
    await git.commit().setMessage("main add").call();
    const mainHead = await repository.refs.resolve("HEAD");

    // Checkout side and add different file
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");
    const baseCommitData = await repository.commits.load(baseCommit?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);
    await addFile(workingCopy, "side-file.txt", "from side");
    await git.commit().setMessage("side add").call();

    // Merge main into side
    const mergeResult = await git
      .merge()
      .include(mainHead?.objectId ?? "")
      .call();
    const mergeCommit = mergeResult.newHead;

    // Create target branch from base
    await git
      .branchCreate()
      .setName("target")
      .setStartPoint(baseCommit?.objectId ?? "")
      .call();
    await repository.refs.setSymbolic("HEAD", "refs/heads/target");
    await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);

    // Cherry-pick with mainline parent 1 (side is parent 1)
    // This means we diff merge commit against side, so we get main's changes
    const result = await git
      .cherryPick()
      .include(mergeCommit ?? "")
      .setMainlineParentNumber(1)
      .call();

    expect(result.status).toBe(CherryPickStatus.OK);

    // Should have the main-file.txt from cherry-pick
    const entry = await workingCopy.checkout.staging.getEntry("main-file.txt");
    expect(entry).toBeDefined();
  });

  /**
   * Test error when specifying invalid mainline parent number.
   */
  it("should throw error for invalid mainline parent number", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create a merge commit
    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("base").call();
    const baseCommit = await repository.refs.resolve("HEAD");

    await git
      .branchCreate()
      .setName("side")
      .setStartPoint(baseCommit?.objectId ?? "")
      .call();

    await addFile(workingCopy, "main.txt", "main");
    await git.commit().setMessage("main").call();
    const mainHead = await repository.refs.resolve("HEAD");

    await repository.refs.setSymbolic("HEAD", "refs/heads/side");
    const baseCommitData = await repository.commits.load(baseCommit?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);
    await addFile(workingCopy, "side.txt", "side");
    await git.commit().setMessage("side").call();

    const mergeResult = await git
      .merge()
      .include(mainHead?.objectId ?? "")
      .call();
    const mergeCommit = mergeResult.newHead;

    // Go to target
    await git
      .branchCreate()
      .setName("target")
      .setStartPoint(baseCommit?.objectId ?? "")
      .call();
    await repository.refs.setSymbolic("HEAD", "refs/heads/target");
    await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);

    // Try with invalid parent number 3 (merge has only 2 parents)
    await expect(
      git
        .cherryPick()
        .include(mergeCommit ?? "")
        .setMainlineParentNumber(3)
        .call(),
    ).rejects.toThrow("Invalid mainline parent: 3");
  });

  /**
   * Test cherry-pick where file is added in cherry-picked commit.
   */
  it("should handle file addition in cherry-pick", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create base
    await addFile(workingCopy, "existing.txt", "exists");
    await git.commit().setMessage("base").call();
    const baseCommit = await repository.refs.resolve("HEAD");

    // Create side branch
    await git
      .branchCreate()
      .setName("side")
      .setStartPoint(baseCommit?.objectId ?? "")
      .call();

    // Add new file on main
    await addFile(workingCopy, "new-main.txt", "from main");
    await git.commit().setMessage("add file on main").call();

    // Checkout side and add different file
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");
    const baseCommitData = await repository.commits.load(baseCommit?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);
    await addFile(workingCopy, "new-side.txt", "from side");
    await git.commit().setMessage("add file on side").call();
    const sideCommit = await repository.refs.resolve("HEAD");

    // Checkout main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    const mainRef = await repository.refs.resolve("refs/heads/main");
    const mainData = await repository.commits.load(mainRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, mainData.tree);

    // Cherry-pick side - should add new-side.txt cleanly
    const result = await git
      .cherryPick()
      .include(sideCommit?.objectId ?? "")
      .call();

    expect(result.status).toBe(CherryPickStatus.OK);

    // Both files should exist
    const mainFile = await workingCopy.checkout.staging.getEntry("new-main.txt");
    const sideFile = await workingCopy.checkout.staging.getEntry("new-side.txt");
    expect(mainFile).toBeDefined();
    expect(sideFile).toBeDefined();
  });

  /**
   * Test cherry-pick where file is deleted in cherry-picked commit.
   */
  it("should handle file deletion in cherry-pick", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create base with two files
    await addFile(workingCopy, "keep.txt", "keep");
    await addFile(workingCopy, "delete.txt", "delete");
    await git.commit().setMessage("base").call();
    const baseCommit = await repository.refs.resolve("HEAD");

    // Create side branch
    await git
      .branchCreate()
      .setName("side")
      .setStartPoint(baseCommit?.objectId ?? "")
      .call();

    // On main, just keep files as is (empty commit)
    await git.commit().setMessage("main no change").setAllowEmpty(true).call();

    // Checkout side and delete the file
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");
    const baseCommitData = await repository.commits.load(baseCommit?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);

    // Remove delete.txt from staging
    await removeFile(workingCopy, "delete.txt");
    await git.commit().setMessage("delete file on side").call();
    const sideCommit = await repository.refs.resolve("HEAD");

    // Checkout main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    const mainRef = await repository.refs.resolve("refs/heads/main");
    const mainData = await repository.commits.load(mainRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, mainData.tree);

    // Cherry-pick side - should delete delete.txt
    const result = await git
      .cherryPick()
      .include(sideCommit?.objectId ?? "")
      .call();

    expect(result.status).toBe(CherryPickStatus.OK);

    // delete.txt should be gone, keep.txt should exist
    const keepFile = await workingCopy.checkout.staging.getEntry("keep.txt");
    const deleteFile = await workingCopy.checkout.staging.getEntry("delete.txt");
    expect(keepFile).toBeDefined();
    expect(deleteFile).toBeUndefined();
  });

  /**
   * Test cherry-pick delete/modify conflict.
   */
  it("should detect delete/modify conflict", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create base with file
    await addFile(workingCopy, "conflict.txt", "original");
    await git.commit().setMessage("base").call();
    const baseCommit = await repository.refs.resolve("HEAD");

    // Create side branch
    await git
      .branchCreate()
      .setName("side")
      .setStartPoint(baseCommit?.objectId ?? "")
      .call();

    // On main, delete the file
    await removeFile(workingCopy, "conflict.txt");
    await git.commit().setMessage("delete on main").call();

    // Checkout side and modify the file
    await repository.refs.setSymbolic("HEAD", "refs/heads/side");
    const baseCommitData = await repository.commits.load(baseCommit?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);
    await addFile(workingCopy, "conflict.txt", "modified");
    await git.commit().setMessage("modify on side").call();
    const sideCommit = await repository.refs.resolve("HEAD");

    // Checkout main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");
    const mainRef = await repository.refs.resolve("refs/heads/main");
    const mainData = await repository.commits.load(mainRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, mainData.tree);

    // Cherry-pick side - should conflict (we deleted, they modified)
    const result = await git
      .cherryPick()
      .include(sideCommit?.objectId ?? "")
      .call();

    expect(result.status).toBe(CherryPickStatus.CONFLICTING);
    expect(result.conflicts).toContain("conflict.txt");
  });
});

describe.each(backends)(
  "CherryPickCommand - Strategy and options ($name backend)",
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
     * Test setStrategy/getStrategy.
     *
     * Based on JGit's setStrategy pattern.
     */
    it("should support setting merge strategy", async () => {
      const { git } = await createInitializedGit();

      const command = git.cherryPick();
      expect(command.getStrategy()).toBe(MergeStrategy.RECURSIVE); // default

      command.setStrategy(MergeStrategy.RESOLVE);
      expect(command.getStrategy()).toBe(MergeStrategy.RESOLVE);

      command.setStrategy(MergeStrategy.OURS);
      expect(command.getStrategy()).toBe(MergeStrategy.OURS);
    });

    /**
     * Test setContentMergeStrategy/getContentMergeStrategy.
     *
     * Based on JGit's content merge strategy options.
     */
    it("should support setting content merge strategy", async () => {
      const { git } = await createInitializedGit();

      const command = git.cherryPick();
      expect(command.getContentMergeStrategy()).toBeUndefined(); // no default

      command.setContentMergeStrategy(ContentMergeStrategy.OURS);
      expect(command.getContentMergeStrategy()).toBe(ContentMergeStrategy.OURS);

      command.setContentMergeStrategy(ContentMergeStrategy.THEIRS);
      expect(command.getContentMergeStrategy()).toBe(ContentMergeStrategy.THEIRS);
    });

    /**
     * Test setOurCommitName/getOurCommitName.
     *
     * Based on JGit's setOurCommitName for conflict markers.
     */
    it("should support setting our commit name for conflict markers", async () => {
      const { git } = await createInitializedGit();

      const command = git.cherryPick();
      expect(command.getOurCommitName()).toBeUndefined(); // default

      command.setOurCommitName("feature-branch");
      expect(command.getOurCommitName()).toBe("feature-branch");
    });

    /**
     * Test setReflogPrefix/getReflogPrefix.
     *
     * Based on JGit's reflog handling.
     */
    it("should support setting reflog prefix", async () => {
      const { git } = await createInitializedGit();

      const command = git.cherryPick();
      expect(command.getReflogPrefix()).toBe("cherry-pick:"); // default

      command.setReflogPrefix("revert:");
      expect(command.getReflogPrefix()).toBe("revert:");
    });

    /**
     * Test that options are correctly maintained through fluent API.
     */
    it("should chain all options fluently", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create setup for cherry-pick
      await addFile(workingCopy, "a.txt", "a");
      await git.commit().setMessage("base").call();
      const baseCommit = await repository.refs.resolve("HEAD");

      await git
        .branchCreate()
        .setName("side")
        .setStartPoint(baseCommit?.objectId ?? "")
        .call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const baseCommitData = await repository.commits.load(baseCommit?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);

      await addFile(workingCopy, "b.txt", "b");
      await git.commit().setMessage("side commit").call();
      const sideCommit = await repository.refs.resolve("HEAD");

      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);

      // Chain all options
      const result = await git
        .cherryPick()
        .include(sideCommit?.objectId ?? "")
        .setStrategy(MergeStrategy.RECURSIVE)
        .setContentMergeStrategy(ContentMergeStrategy.OURS)
        .setOurCommitName("HEAD")
        .setReflogPrefix("cherry-pick:")
        .call();

      expect(result.status).toBe(CherryPickStatus.OK);
    });
  },
);

describe.each(backends)(
  "CherryPickCommand - JGit additional tests ($name backend)",
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
     * Test cherry-picking preserves original author.
     */
    it("should preserve original commit author", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create base
      await addFile(workingCopy, "a.txt", "a");
      await git.commit().setMessage("base").call();
      const baseCommit = await repository.refs.resolve("HEAD");

      // Create side with custom author
      await git
        .branchCreate()
        .setName("side")
        .setStartPoint(baseCommit?.objectId ?? "")
        .call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const baseCommitData = await repository.commits.load(baseCommit?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);

      // Add file with custom author
      await addFile(workingCopy, "b.txt", "new content");
      await git
        .commit()
        .setMessage("commit with custom author")
        .setAuthor("Custom Author", "custom@example.com")
        .call();
      const sideCommit = await repository.refs.resolve("HEAD");

      // Checkout main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);

      // Cherry-pick
      const result = await git
        .cherryPick()
        .include(sideCommit?.objectId ?? "")
        .call();

      expect(result.status).toBe(CherryPickStatus.OK);

      // Check the new commit preserves the original author
      const newCommit = await repository.commits.load(result.newHead ?? "");
      expect(newCommit.author.name).toBe("Custom Author");
      expect(newCommit.author.email).toBe("custom@example.com");
    });

    /**
     * Test cherry-picking preserves original commit message.
     */
    it("should preserve original commit message", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create base
      await addFile(workingCopy, "a.txt", "a");
      await git.commit().setMessage("base").call();
      const baseCommit = await repository.refs.resolve("HEAD");

      await git
        .branchCreate()
        .setName("side")
        .setStartPoint(baseCommit?.objectId ?? "")
        .call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const baseCommitData = await repository.commits.load(baseCommit?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);

      const detailedMessage =
        "This is a detailed commit message\n\nWith multiple lines\nAnd description";
      await addFile(workingCopy, "b.txt", "new file");
      await git.commit().setMessage(detailedMessage).call();
      const sideCommit = await repository.refs.resolve("HEAD");

      // Checkout main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);

      // Cherry-pick
      const result = await git
        .cherryPick()
        .include(sideCommit?.objectId ?? "")
        .call();

      expect(result.status).toBe(CherryPickStatus.OK);

      const newCommit = await repository.commits.load(result.newHead ?? "");
      expect(newCommit.message).toBe(detailedMessage);
    });

    /**
     * Test that cherry-picked commits have correct parentage.
     */
    it("should set correct parent for cherry-picked commit", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create base
      await addFile(workingCopy, "a.txt", "a");
      await git.commit().setMessage("base").call();
      const baseCommit = await repository.refs.resolve("HEAD");

      await git
        .branchCreate()
        .setName("side")
        .setStartPoint(baseCommit?.objectId ?? "")
        .call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const baseCommitData = await repository.commits.load(baseCommit?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);

      await addFile(workingCopy, "b.txt", "b");
      await git.commit().setMessage("side commit").call();
      const sideCommit = await repository.refs.resolve("HEAD");

      // Checkout main and make another commit
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);
      await addFile(workingCopy, "c.txt", "c");
      await git.commit().setMessage("main commit 2").call();
      const mainCommit2 = await repository.refs.resolve("HEAD");

      // Cherry-pick
      const result = await git
        .cherryPick()
        .include(sideCommit?.objectId ?? "")
        .call();

      expect(result.status).toBe(CherryPickStatus.OK);

      // The new commit's parent should be mainCommit2
      const newCommit = await repository.commits.load(result.newHead ?? "");
      expect(newCommit.parents).toHaveLength(1);
      expect(newCommit.parents[0]).toBe(mainCommit2?.objectId);
    });

    /**
     * Test cherry-picking a root commit (first commit with no parent).
     *
     * Based on JGit's testRootCherryPick.
     */
    it("should cherry-pick a root commit", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create root commit on main branch
      await addFile(workingCopy, "a.txt", "a content");
      await git.commit().setMessage("root commit").call();
      const rootCommit = await repository.refs.resolve("HEAD");

      // Create orphan branch (start fresh)
      await git.branchCreate().setName("orphan").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/orphan");

      // Create a different root on orphan branch
      await addFile(workingCopy, "b.txt", "b content");
      await git.commit().setMessage("orphan root").call();

      // Cherry-pick the original root commit onto orphan branch
      const result = await git
        .cherryPick()
        .include(rootCommit?.objectId ?? "")
        .call();

      expect(result.status).toBe(CherryPickStatus.OK);

      // Should have both files now
      const aEntry = await workingCopy.checkout.staging.getEntry("a.txt");
      const bEntry = await workingCopy.checkout.staging.getEntry("b.txt");
      expect(aEntry).toBeDefined();
      expect(bEntry).toBeDefined();
    });

    /**
     * Test cherry-pick with conflict and noCommit option.
     *
     * Based on JGit's testCherryPickConflictResolutionNoCommit.
     */
    it("should handle conflict with noCommit option", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create file a on main
      await addFile(workingCopy, "a.txt", "first master");
      await git.commit().setMessage("first master").call();
      const firstMaster = await repository.refs.resolve("HEAD");

      // Create side branch
      await git
        .branchCreate()
        .setName("side")
        .setStartPoint(firstMaster?.objectId ?? "")
        .call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const firstCommit = await repository.commits.load(firstMaster?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, firstCommit.tree);

      // Modify a on side branch
      await addFile(workingCopy, "a.txt", "a(side)");
      await git.commit().setMessage("side").call();
      const sideCommit = await repository.refs.resolve("HEAD");

      // Checkout main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      await workingCopy.checkout.staging.readTree(repository.trees, firstCommit.tree);

      // Modify a on main differently
      await addFile(workingCopy, "a.txt", "a(master)");
      await git.commit().setMessage("second master").call();
      const beforeCherryPick = await repository.refs.resolve("HEAD");

      // Cherry-pick side commit with noCommit - should conflict
      const result = await git
        .cherryPick()
        .include(sideCommit?.objectId ?? "")
        .setNoCommit(true)
        .call();

      expect(result.status).toBe(CherryPickStatus.CONFLICTING);
      expect(result.conflicts).toContain("a.txt");

      // HEAD should not have moved
      const afterCherryPick = await repository.refs.resolve("HEAD");
      expect(afterCherryPick?.objectId).toBe(beforeCherryPick?.objectId);
    });

    /**
     * Test command cannot be reused after call.
     */
    it("should not allow command reuse after call", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      await addFile(workingCopy, "a.txt", "a");
      await git.commit().setMessage("base").call();
      const baseCommit = await repository.refs.resolve("HEAD");

      await git
        .branchCreate()
        .setName("side")
        .setStartPoint(baseCommit?.objectId ?? "")
        .call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const baseCommitData = await repository.commits.load(baseCommit?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);

      await addFile(workingCopy, "b.txt", "b");
      await git.commit().setMessage("side commit").call();
      const sideCommit = await repository.refs.resolve("HEAD");

      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      await workingCopy.checkout.staging.readTree(repository.trees, baseCommitData.tree);

      const command = git.cherryPick().include(sideCommit?.objectId ?? "");
      await command.call();

      // Attempting to call again should throw
      await expect(command.call()).rejects.toThrow();
    });
  },
);
