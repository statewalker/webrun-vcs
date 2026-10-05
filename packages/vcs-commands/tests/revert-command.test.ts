/**
 * Tests for RevertCommand
 *
 * Ported from JGit's RevertCommandTest.java
 * Tests run against all storage backends (Memory, SQL).
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  ContentMergeStrategy,
  MergeStrategy,
  MultipleParentsNotAllowedError,
  RevertStatus,
} from "../src/index.js";
import { addFile, backends, createInitializedGitFromFactory, removeFile } from "./test-helper.js";

describe.each(backends)("RevertCommand ($name backend)", ({ factory }) => {
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
   * Test basic revert operation.
   *
   * Based on JGit's testRevert.
   */
  it("should revert a commit and generate correct message", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create file a
    await addFile(workingCopy, "a.txt", "first line\nsec. line\nthird line\n");
    await git.commit().setMessage("create a").call();

    // Create file b
    await addFile(workingCopy, "b.txt", "content\n");
    await git.commit().setMessage("create b").call();

    // Enlarge a
    await addFile(workingCopy, "a.txt", "first line\nsec. line\nthird line\nfourth line\n");
    await git.commit().setMessage("enlarged a").call();

    // Fix a
    await addFile(workingCopy, "a.txt", "first line\nsecond line\nthird line\nfourth line\n");
    await git.commit().setMessage("fixed a").call();
    const fixingARef = await repository.refs.resolve("HEAD");
    const fixingAId = fixingARef?.objectId ?? "";

    // Fix b
    await addFile(workingCopy, "b.txt", "first line\n");
    await git.commit().setMessage("fixed b").call();

    // Revert the fixingA commit
    const result = await git.revert().include(fixingAId).call();

    expect(result.status).toBe(RevertStatus.OK);
    expect(result.newHead).toBeDefined();
    expect(result.revertedRefs).toContain(fixingAId);

    // Check the revert commit message
    const revertCommit = await repository.commits.load(result.newHead ?? "");
    expect(revertCommit.message).toContain('Revert "fixed a"');
    expect(revertCommit.message).toContain("This reverts commit");
    expect(revertCommit.message).toContain(fixingAId);

    // Check commit history
    const commits: string[] = [];
    for await (const commit of await git.log().call()) {
      commits.push(commit.message.split("\n")[0]);
    }

    expect(commits[0]).toBe('Revert "fixed a"');
    expect(commits[1]).toBe("fixed b");
    expect(commits[2]).toBe("fixed a");
    expect(commits[3]).toBe("enlarged a");
    expect(commits[4]).toBe("create b");
    expect(commits[5]).toBe("create a");
  });

  /**
   * Test reverting multiple commits sequentially.
   *
   * Based on JGit's testRevertMultiple.
   */
  it("should revert multiple commits in order", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create initial state
    await addFile(workingCopy, "a.txt", "first\n");
    await git.commit().setMessage("add first").call();

    // Add second line
    await addFile(workingCopy, "a.txt", "first\nsecond\n");
    await git.commit().setMessage("add second").call();
    const secondCommitRef = await repository.refs.resolve("HEAD");
    const secondCommit = secondCommitRef?.objectId ?? "";

    // Add third line
    await addFile(workingCopy, "a.txt", "first\nsecond\nthird\n");
    await git.commit().setMessage("add third").call();
    const thirdCommitRef = await repository.refs.resolve("HEAD");
    const thirdCommit = thirdCommitRef?.objectId ?? "";

    // Revert both commits (third first, then second)
    const result = await git.revert().include(thirdCommit).include(secondCommit).call();

    expect(result.status).toBe(RevertStatus.OK);
    expect(result.revertedRefs).toHaveLength(2);

    // Check commit history - should have two revert commits
    const commits: string[] = [];
    for await (const commit of await git.log().call()) {
      commits.push(commit.message.split("\n")[0]);
    }

    expect(commits[0]).toBe('Revert "add second"');
    expect(commits[1]).toBe('Revert "add third"');
    expect(commits[2]).toBe("add third");
    expect(commits[3]).toBe("add second");
    expect(commits[4]).toBe("add first");
  });

  /**
   * Test revert with conflict.
   *
   * Based on JGit's testRevertConflictResolution.
   */
  it("should detect conflicts when reverting", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create file a
    await addFile(workingCopy, "a.txt", "a");
    await git.commit().setMessage("first master").call();

    // Modify a - this is the commit we'll revert
    await addFile(workingCopy, "a.txt", "a(previous)");
    await git.commit().setMessage("second master").call();
    const oldCommitRef = await repository.refs.resolve("HEAD");
    const oldCommit = oldCommitRef?.objectId ?? "";

    // Modify a again - creates conflict with revert
    await addFile(workingCopy, "a.txt", "a(latest)");
    await git.commit().setMessage("side").call();

    // Try to revert - should conflict
    const result = await git.revert().include(oldCommit).call();

    expect(result.status).toBe(RevertStatus.CONFLICTING);
    expect(result.conflicts).toContain("a.txt");

    // Verify conflict stages in staging
    const hasConflicts = await workingCopy.checkout.staging.hasConflicts();
    expect(hasConflicts).toBe(true);

    const entries = await workingCopy.checkout.staging.getEntries("a.txt");
    expect(entries.length).toBeGreaterThan(1);
  });

  /**
   * Test revert with noCommit option.
   */
  it("should revert without committing when noCommit is true", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create base file
    await addFile(workingCopy, "a.txt", "original");
    await git.commit().setMessage("base").call();
    const baseCommitRef = await repository.refs.resolve("HEAD");
    const baseCommit = baseCommitRef?.objectId ?? "";

    // Modify file
    await addFile(workingCopy, "a.txt", "modified");
    await git.commit().setMessage("modify").call();
    const modifyCommitRef = await repository.refs.resolve("HEAD");
    const modifyCommit = modifyCommitRef?.objectId ?? "";

    const beforeRevertHead = await repository.refs.resolve("HEAD");

    // Revert with noCommit
    const result = await git.revert().include(modifyCommit).setNoCommit(true).call();

    expect(result.status).toBe(RevertStatus.OK);

    // HEAD should not have moved
    const afterRevertHead = await repository.refs.resolve("HEAD");
    expect(afterRevertHead?.objectId).toBe(beforeRevertHead?.objectId);

    // But staging should reflect the reverted content
    const entry = await workingCopy.checkout.staging.getEntry("a.txt");
    expect(entry).toBeDefined();

    // The tree in staging should match the base commit's tree content
    const baseCommitData = await repository.commits.load(baseCommit);
    const stagingTreeId = await workingCopy.checkout.staging.writeTree(repository.trees);
    // The trees should be identical since we reverted to base
    expect(stagingTreeId).toBe(baseCommitData.tree);
  });

  /**
   * Test reverting a merge commit requires mainline parent.
   */
  it("should throw error when reverting merge commit without mainline parent", async () => {
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

    // Try to revert merge commit without mainline parent
    await expect(
      git
        .revert()
        .include(mergeCommit ?? "")
        .call(),
    ).rejects.toThrow(MultipleParentsNotAllowedError);
  });

  /**
   * Test reverting a merge commit with mainline parent specified.
   */
  it("should revert merge commit when mainline parent is specified", async () => {
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

    // Revert with mainline parent 1 (side is parent 1)
    // This means we diff merge commit against side, and revert main's changes
    const result = await git
      .revert()
      .include(mergeCommit ?? "")
      .setMainlineParentNumber(1)
      .call();

    expect(result.status).toBe(RevertStatus.OK);

    // main-file.txt should be removed (reverted)
    const mainFileEntry = await workingCopy.checkout.staging.getEntry("main-file.txt");
    expect(mainFileEntry).toBeUndefined();

    // side-file.txt should still exist
    const sideFileEntry = await workingCopy.checkout.staging.getEntry("side-file.txt");
    expect(sideFileEntry).toBeDefined();
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

    // Try with invalid parent number 3 (merge has only 2 parents)
    await expect(
      git
        .revert()
        .include(mergeCommit ?? "")
        .setMainlineParentNumber(3)
        .call(),
    ).rejects.toThrow("Invalid mainline parent: 3");
  });

  /**
   * Test revert where file is added in reverted commit (should be deleted).
   */
  it("should handle file addition revert (delete the file)", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create base
    await addFile(workingCopy, "existing.txt", "exists");
    await git.commit().setMessage("base").call();

    // Add new file
    await addFile(workingCopy, "new-file.txt", "new content");
    await git.commit().setMessage("add new file").call();
    const addCommitRef = await repository.refs.resolve("HEAD");
    const addCommit = addCommitRef?.objectId ?? "";

    // Verify file exists
    let entry = await workingCopy.checkout.staging.getEntry("new-file.txt");
    expect(entry).toBeDefined();

    // Revert the add - should delete the file
    const result = await git.revert().include(addCommit).call();

    expect(result.status).toBe(RevertStatus.OK);

    // new-file.txt should be gone
    entry = await workingCopy.checkout.staging.getEntry("new-file.txt");
    expect(entry).toBeUndefined();

    // existing.txt should still exist
    const existingEntry = await workingCopy.checkout.staging.getEntry("existing.txt");
    expect(existingEntry).toBeDefined();
  });

  /**
   * Test revert where file is deleted in reverted commit (should be restored).
   */
  it("should handle file deletion revert (restore the file)", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create base with file
    await addFile(workingCopy, "deleteme.txt", "content to restore");
    await addFile(workingCopy, "keep.txt", "keep this");
    await git.commit().setMessage("base").call();

    // Delete file
    await removeFile(workingCopy, "deleteme.txt");
    await git.commit().setMessage("delete file").call();
    const deleteCommitRef = await repository.refs.resolve("HEAD");
    const deleteCommit = deleteCommitRef?.objectId ?? "";

    // Verify file is gone
    let entry = await workingCopy.checkout.staging.getEntry("deleteme.txt");
    expect(entry).toBeUndefined();

    // Revert the delete - should restore the file
    const result = await git.revert().include(deleteCommit).call();

    expect(result.status).toBe(RevertStatus.OK);

    // deleteme.txt should be restored
    entry = await workingCopy.checkout.staging.getEntry("deleteme.txt");
    expect(entry).toBeDefined();
  });

  /**
   * Test revert delete/modify conflict.
   */
  it("should detect delete/modify conflict when reverting", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create base with file
    await addFile(workingCopy, "conflict.txt", "original");
    await git.commit().setMessage("base").call();

    // Delete the file - this is the commit we'll revert
    await removeFile(workingCopy, "conflict.txt");
    await git.commit().setMessage("delete file").call();
    const deleteCommit2Ref = await repository.refs.resolve("HEAD");
    const deleteCommit2 = deleteCommit2Ref?.objectId ?? "";

    // Add a different file - so we have a clean new state
    await addFile(workingCopy, "other.txt", "other");
    await git.commit().setMessage("add other").call();

    // Now modify the staging to have conflict.txt with different content
    // (simulating concurrent work that added it back differently)
    await addFile(workingCopy, "conflict.txt", "different content");
    await git.commit().setMessage("add back with different content").call();

    // Revert the delete commit - should conflict because:
    // - Revert wants to restore "original"
    // - Current state has "different content"
    const result = await git.revert().include(deleteCommit2).call();

    expect(result.status).toBe(RevertStatus.CONFLICTING);
    expect(result.conflicts).toContain("conflict.txt");
  });
});

describe.each(backends)("RevertCommand - Strategy and options ($name backend)", ({ factory }) => {
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

    const command = git.revert();
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

    const command = git.revert();
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

    const command = git.revert();
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

    const command = git.revert();
    expect(command.getReflogPrefix()).toBe("revert:"); // default

    command.setReflogPrefix("custom:");
    expect(command.getReflogPrefix()).toBe("custom:");
  });

  /**
   * Test that options are correctly maintained through fluent API.
   */
  it("should chain all options fluently", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create setup for revert
    await addFile(workingCopy, "a.txt", "a");
    await git.commit().setMessage("base").call();

    await addFile(workingCopy, "a.txt", "b");
    await git.commit().setMessage("modify a").call();
    const modifyCommitRef = await repository.refs.resolve("HEAD");
    const modifyCommit = modifyCommitRef?.objectId ?? "";

    // Chain all options
    const result = await git
      .revert()
      .include(modifyCommit)
      .setStrategy(MergeStrategy.RECURSIVE)
      .setContentMergeStrategy(ContentMergeStrategy.OURS)
      .setOurCommitName("HEAD")
      .setReflogPrefix("revert:")
      .call();

    expect(result.status).toBe(RevertStatus.OK);
  });
});

describe.each(backends)("RevertCommand - JGit additional tests ($name backend)", ({ factory }) => {
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
   * Test that reverted commits have correct parentage.
   */
  it("should set correct parent for revert commit", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create base with file a
    await addFile(workingCopy, "a.txt", "a");
    await git.commit().setMessage("base").call();

    // Add a new file b - this is the commit we'll revert
    await addFile(workingCopy, "b.txt", "b content");
    await git.commit().setMessage("add b").call();
    const addBCommitRef = await repository.refs.resolve("HEAD");
    const addBCommit = addBCommitRef?.objectId ?? "";

    // Add another file c - so we have a clean HEAD to revert onto
    await addFile(workingCopy, "c.txt", "c content");
    await git.commit().setMessage("add c").call();
    const headBeforeRevertRef = await repository.refs.resolve("HEAD");
    const headBeforeRevert = headBeforeRevertRef?.objectId ?? "";

    // Revert the add b commit (should cleanly delete b.txt)
    const result = await git.revert().include(addBCommit).call();

    expect(result.status).toBe(RevertStatus.OK);

    // The new commit's parent should be headBeforeRevert
    const revertCommit = await repository.commits.load(result.newHead ?? "");
    expect(revertCommit.parents).toHaveLength(1);
    expect(revertCommit.parents[0]).toBe(headBeforeRevert);
  });

  /**
   * Test revert message format with multi-line original message.
   */
  it("should use only first line of original message in revert title", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create base
    await addFile(workingCopy, "a.txt", "a");
    await git.commit().setMessage("base").call();

    // Create commit with multi-line message
    await addFile(workingCopy, "a.txt", "b");
    const detailedMessage = "Fix the bug\n\nThis is a detailed description\nWith multiple lines";
    await git.commit().setMessage(detailedMessage).call();
    const fixCommitRef = await repository.refs.resolve("HEAD");
    const fixCommit = fixCommitRef?.objectId ?? "";

    // Make another commit so revert is clean
    await addFile(workingCopy, "c.txt", "c");
    await git.commit().setMessage("add c").call();

    // Revert
    const result = await git.revert().include(fixCommit).call();

    expect(result.status).toBe(RevertStatus.OK);

    // Check message uses only first line in title
    const revertCommit = await repository.commits.load(result.newHead ?? "");
    expect(revertCommit.message).toContain('Revert "Fix the bug"');
    expect(revertCommit.message).not.toContain("This is a detailed description");
  });

  /**
   * Test that revert of a file modification produces original content.
   */
  it("should restore original content when reverting modification", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create base with specific content
    const originalContent = "original content here";
    await addFile(workingCopy, "file.txt", originalContent);
    await git.commit().setMessage("base").call();
    const baseCommit2Ref = await repository.refs.resolve("HEAD");
    const baseCommit2 = baseCommit2Ref?.objectId ?? "";

    // Modify the file
    await addFile(workingCopy, "file.txt", "modified content");
    await git.commit().setMessage("modify file").call();
    const modifyCommit2Ref = await repository.refs.resolve("HEAD");
    const modifyCommit2 = modifyCommit2Ref?.objectId ?? "";

    // Revert the modification
    const result = await git.revert().include(modifyCommit2).call();

    expect(result.status).toBe(RevertStatus.OK);

    // Read the tree to verify content matches base
    const revertCommit = await repository.commits.load(result.newHead ?? "");
    const baseCommitData = await repository.commits.load(baseCommit2);

    // Get file entry from both trees
    let revertFileId: string | undefined;
    let baseFileId: string | undefined;

    if (revertCommit) {
      const revertEntries = await repository.trees.load(revertCommit.tree);
      for await (const entry of revertEntries ?? []) {
        if (entry.name === "file.txt") {
          revertFileId = entry.id;
        }
      }
    }

    if (baseCommitData) {
      const baseEntries = await repository.trees.load(baseCommitData.tree);
      for await (const entry of baseEntries ?? []) {
        if (entry.name === "file.txt") {
          baseFileId = entry.id;
        }
      }
    }

    // The blob IDs should match (same content)
    expect(revertFileId).toBe(baseFileId);
  });

  /**
   * Test reverting multiple commits where one fails.
   *
   * Based on JGit's testRevertMultipleWithFail.
   */
  it("should stop on first conflict when reverting multiple commits", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create base
    await addFile(workingCopy, "a.txt", "base");
    await git.commit().setMessage("base").call();

    // First modification - will revert cleanly
    await addFile(workingCopy, "a.txt", "first change");
    await git.commit().setMessage("first").call();
    const firstCommit = await repository.refs.resolve("HEAD");

    // Second modification - will cause conflict when reverted
    await addFile(workingCopy, "a.txt", "second change");
    await git.commit().setMessage("second").call();
    const secondCommit = await repository.refs.resolve("HEAD");

    // Third modification - makes reverting second conflict
    await addFile(workingCopy, "a.txt", "third change");
    await git.commit().setMessage("third").call();

    // Try to revert second and first
    // Reverting second should conflict because current state is "third change"
    // and revert expects to change "second change" -> "first change"
    const result = await git
      .revert()
      .include(secondCommit?.objectId ?? "")
      .include(firstCommit?.objectId ?? "")
      .call();

    // Should fail on second (first in revert order)
    expect(result.status).toBe(RevertStatus.CONFLICTING);
    expect(result.conflicts).toContain("a.txt");

    // Should have only processed one revert before failing
    expect(result.revertedRefs).toHaveLength(0);
  });

  /**
   * Test command cannot be reused after call.
   */
  it("should not allow command reuse after call", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "a.txt", "a");
    await git.commit().setMessage("base").call();

    await addFile(workingCopy, "a.txt", "b");
    await git.commit().setMessage("modify").call();
    const modifyCommit = await repository.refs.resolve("HEAD");

    const command = git.revert().include(modifyCommit?.objectId ?? "");
    await command.call();

    // Attempting to call again should throw
    await expect(command.call()).rejects.toThrow();
  });
});
