/**
 * Tests for RebaseCommand
 *
 * Ported from JGit's RebaseCommandTest.java
 * Tests run against all storage backends (Memory, SQL).
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  ContentMergeStrategy,
  MergeStrategy,
  RebaseOperation,
  RebaseStatus,
} from "../src/index.js";
import { addFile, backends, createInitializedGitFromFactory } from "./test-helper.js";

describe.each(backends)("RebaseCommand ($name backend)", ({ factory }) => {
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
   * Test rebase when already up to date.
   *
   * Based on JGit's testUpToDate.
   */
  it("should return UP_TO_DATE when current commit is ancestor of upstream", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create commits on main
    await addFile(workingCopy, "file.txt", "v1");
    await git.commit().setMessage("initial").call();

    const headRef = await repository.refs.resolve("HEAD");
    const headCommit = headRef?.objectId ?? "";

    // Rebase onto itself should be up to date
    const result = await git.rebase().setUpstream(headCommit).call();

    expect(result.status).toBe(RebaseStatus.UP_TO_DATE);
  });

  /**
   * Test fast-forward rebase.
   *
   * Based on JGit's testFastForward.
   */
  it("should fast-forward when possible", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create initial commit
    await addFile(workingCopy, "file.txt", "v1");
    await git.commit().setMessage("initial").call();

    const initialHead = await repository.refs.resolve("HEAD");
    const initialCommit = initialHead?.objectId ?? "";

    // Create second commit
    await addFile(workingCopy, "file.txt", "v2");
    await git.commit().setMessage("second").call();

    const secondHead = await repository.refs.resolve("HEAD");
    const secondCommit = secondHead?.objectId ?? "";

    // Reset back to initial commit
    await git.reset().setRef(initialCommit).setMode("hard").call();

    // Rebase onto second commit should fast-forward
    const result = await git.rebase().setUpstream(secondCommit).call();

    expect(result.status).toBe(RebaseStatus.FAST_FORWARD);
    expect(result.newHead).toBe(secondCommit);
  });

  /**
   * Test basic rebase with commits to replay.
   *
   * Based on JGit's testRebase.
   */
  it("should replay commits onto upstream", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create initial commit
    await addFile(workingCopy, "a.txt", "a");
    await git.commit().setMessage("initial").call();

    const _baseCommit = (await repository.refs.resolve("HEAD"))?.objectId ?? "";

    // Create branch at base
    await git.branchCreate().setName("feature").call();

    // Add commits to main
    await addFile(workingCopy, "b.txt", "b");
    await git.commit().setMessage("main-1").call();

    const mainHead = (await repository.refs.resolve("HEAD"))?.objectId ?? "";

    // Switch to feature and add commits
    await git.checkout().setName("feature").call();

    await addFile(workingCopy, "c.txt", "c");
    await git.commit().setMessage("feature-1").call();

    // Rebase feature onto main
    const result = await git.rebase().setUpstream(mainHead).call();

    expect(result.status).toBe(RebaseStatus.OK);
    expect(result.newHead).toBeDefined();
    expect(result.newHead).not.toBe(mainHead);
  });

  /**
   * Test abort operation.
   */
  it("should abort rebase", async () => {
    const { git, workingCopy } = await createInitializedGit();

    // Create initial commit
    await addFile(workingCopy, "file.txt", "v1");
    await git.commit().setMessage("initial").call();

    // Abort without a rebase in progress should succeed
    const result = await git.rebase().setOperation(RebaseOperation.ABORT).call();

    expect(result.status).toBe(RebaseStatus.ABORTED);
  });
});

describe.each(backends)("RebaseCommand - API options ($name backend)", ({ factory }) => {
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
   */
  it("should support setting merge strategy", async () => {
    const { git } = await createInitializedGit();

    const command = git.rebase();
    expect(command.getStrategy()).toBe(MergeStrategy.RECURSIVE); // default

    command.setStrategy(MergeStrategy.RESOLVE);
    expect(command.getStrategy()).toBe(MergeStrategy.RESOLVE);

    command.setStrategy(MergeStrategy.OURS);
    expect(command.getStrategy()).toBe(MergeStrategy.OURS);
  });

  /**
   * Test setContentMergeStrategy/getContentMergeStrategy.
   */
  it("should support setting content merge strategy", async () => {
    const { git } = await createInitializedGit();

    const command = git.rebase();
    expect(command.getContentMergeStrategy()).toBeUndefined(); // no default

    command.setContentMergeStrategy(ContentMergeStrategy.OURS);
    expect(command.getContentMergeStrategy()).toBe(ContentMergeStrategy.OURS);

    command.setContentMergeStrategy(ContentMergeStrategy.THEIRS);
    expect(command.getContentMergeStrategy()).toBe(ContentMergeStrategy.THEIRS);
  });

  /**
   * Test setPreserveMerges/getPreserveMerges.
   */
  it("should support preserve merges option", async () => {
    const { git } = await createInitializedGit();

    const command = git.rebase();
    expect(command.getPreserveMerges()).toBe(false); // default

    command.setPreserveMerges(true);
    expect(command.getPreserveMerges()).toBe(true);
  });

  /**
   * Test setOperation/getOperation.
   */
  it("should support setting operation", async () => {
    const { git } = await createInitializedGit();

    const command = git.rebase();
    expect(command.getOperation()).toBe(RebaseOperation.BEGIN); // default

    command.setOperation(RebaseOperation.ABORT);
    expect(command.getOperation()).toBe(RebaseOperation.ABORT);

    command.setOperation(RebaseOperation.CONTINUE);
    expect(command.getOperation()).toBe(RebaseOperation.CONTINUE);

    command.setOperation(RebaseOperation.SKIP);
    expect(command.getOperation()).toBe(RebaseOperation.SKIP);
  });

  /**
   * Test fluent API chaining.
   */
  it("should support fluent API chaining", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const head = (await repository.refs.resolve("HEAD"))?.objectId ?? "";

    // All options should be chainable
    const result = await git
      .rebase()
      .setUpstream(head)
      .setStrategy(MergeStrategy.RECURSIVE)
      .setContentMergeStrategy(ContentMergeStrategy.OURS)
      .setPreserveMerges(false)
      .call();

    expect(result.status).toBe(RebaseStatus.UP_TO_DATE);
  });
});
