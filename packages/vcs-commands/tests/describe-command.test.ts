/**
 * Tests for DescribeCommand
 *
 * Ported from JGit's DescribeCommandTest.java
 * Tests run against all storage backends (Memory, SQL).
 */

import { afterEach, describe, expect, it } from "vitest";

import { addFile, backends, createInitializedGitFromFactory } from "./test-helper.js";

describe.each(backends)("DescribeCommand ($name backend)", ({ factory }) => {
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
   * Test describe when commit matches a tag exactly.
   *
   * Based on JGit's testDescribe.
   */
  it("should return tag name when commit matches tag exactly", async () => {
    const { git, workingCopy } = await createInitializedGit();

    // Create a commit
    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    // Create a tag
    await git.tag().setName("v1.0.0").call();

    // Describe should return the tag name
    const result = await git.describe().setTags(true).call();

    expect(result.description).toBe("v1.0.0");
    expect(result.tag).toBe("v1.0.0");
    expect(result.depth).toBe(0);
  });

  /**
   * Test describe with commits after the tag.
   */
  it("should return tag-depth-gSHA format when commits exist after tag", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create initial commit
    await addFile(workingCopy, "file.txt", "v1");
    await git.commit().setMessage("initial").call();

    // Create tag
    await git.tag().setName("v1.0.0").call();

    // Create more commits
    await addFile(workingCopy, "file.txt", "v2");
    await git.commit().setMessage("second").call();

    await addFile(workingCopy, "file.txt", "v3");
    await git.commit().setMessage("third").call();

    const head = await repository.refs.resolve("HEAD");

    // Describe should return tag-depth-gSHA format
    const result = await git.describe().setTags(true).call();

    expect(result.tag).toBe("v1.0.0");
    expect(result.depth).toBe(2);
    expect(result.description).toMatch(/^v1\.0\.0-2-g.+$/);
    expect(result.abbrevHash).toBe(head?.objectId?.slice(0, 7));
  });

  /**
   * Test describe with long format enabled.
   */
  it("should always use long format when setLong(true)", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create a commit and tag
    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();
    await git.tag().setName("v1.0.0").call();

    const head = await repository.refs.resolve("HEAD");

    // Even though commit matches tag, should use long format
    const result = await git.describe().setTags(true).setLong(true).call();

    expect(result.description).toMatch(/^v1\.0\.0-0-g.+$/);
    expect(result.tag).toBe("v1.0.0");
    expect(result.depth).toBe(0);
    expect(result.abbrevHash).toBe(head?.objectId?.slice(0, 7));
  });

  /**
   * Test describe with always option when no tags exist.
   */
  it("should return abbreviated commit hash when always is true and no tags", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create a commit without tags
    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const head = await repository.refs.resolve("HEAD");

    // Should return abbreviated hash when always is true
    const result = await git.describe().setAlways(true).call();

    expect(result.description).toBe(head?.objectId?.slice(0, 7));
    expect(result.tag).toBeUndefined();
    expect(result.abbrevHash).toBe(head?.objectId?.slice(0, 7));
  });

  /**
   * Test describe returns undefined when no tags and always is false.
   */
  it("should return undefined when no tags and always is false", async () => {
    const { git, workingCopy } = await createInitializedGit();

    // Create a commit without tags
    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    // Should return undefined when no matching tag
    const result = await git.describe().call();

    expect(result.description).toBeUndefined();
    expect(result.tag).toBeUndefined();
  });

  /**
   * Test describe with custom abbreviation length.
   */
  it("should use custom abbreviation length", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "v1");
    await git.commit().setMessage("initial").call();
    await git.tag().setName("v1.0.0").call();

    await addFile(workingCopy, "file.txt", "v2");
    await git.commit().setMessage("second").call();

    const head = await repository.refs.resolve("HEAD");

    const result = await git.describe().setTags(true).setAbbrev(10).call();

    expect(result.abbrevHash).toBe(head?.objectId?.slice(0, 10));
    expect(result.description).toMatch(/^v1\.0\.0-1-g.{10}$/);
  });

  /**
   * Test describe with match pattern.
   */
  it("should only match tags matching pattern", async () => {
    const { git, workingCopy } = await createInitializedGit();

    // Create commits and tags
    await addFile(workingCopy, "file.txt", "v1");
    await git.commit().setMessage("initial").call();
    await git.tag().setName("release-1.0").call();

    await addFile(workingCopy, "file.txt", "v2");
    await git.commit().setMessage("second").call();
    await git.tag().setName("v2.0.0").call();

    // Match only v* tags
    const result = await git.describe().setTags(true).setMatch("v*").call();

    expect(result.tag).toBe("v2.0.0");
    expect(result.depth).toBe(0);
  });

  /**
   * Test describe with exclude pattern.
   */
  it("should exclude tags matching exclude pattern", async () => {
    const { git, workingCopy } = await createInitializedGit();

    // Create commits and tags
    await addFile(workingCopy, "file.txt", "v1");
    await git.commit().setMessage("initial").call();
    await git.tag().setName("v1.0.0").call();

    await addFile(workingCopy, "file.txt", "v2");
    await git.commit().setMessage("second").call();
    await git.tag().setName("v2.0.0-rc1").call();

    // Exclude release candidate tags
    const result = await git.describe().setTags(true).setExclude("*-rc*").call();

    // Should skip v2.0.0-rc1 and use v1.0.0
    expect(result.tag).toBe("v1.0.0");
    expect(result.depth).toBe(1);
  });

  /**
   * Test describe with specific target commit.
   */
  it("should describe specific target commit", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create commits
    await addFile(workingCopy, "file.txt", "v1");
    await git.commit().setMessage("first").call();
    const firstCommit = await repository.refs.resolve("HEAD");

    await git.tag().setName("v1.0.0").call();

    await addFile(workingCopy, "file.txt", "v2");
    await git.commit().setMessage("second").call();

    await addFile(workingCopy, "file.txt", "v3");
    await git.commit().setMessage("third").call();

    // Describe the first commit
    const result = await git
      .describe()
      .setTarget(firstCommit?.objectId ?? "")
      .setTags(true)
      .call();

    expect(result.description).toBe("v1.0.0");
    expect(result.tag).toBe("v1.0.0");
    expect(result.depth).toBe(0);
  });

  /**
   * Test describe picks closest tag when multiple ancestors have tags.
   */
  it("should pick the closest tag", async () => {
    const { git, workingCopy } = await createInitializedGit();

    // Create first commit with tag
    await addFile(workingCopy, "file.txt", "v1");
    await git.commit().setMessage("first").call();
    await git.tag().setName("v1.0.0").call();

    // Create second commit with tag
    await addFile(workingCopy, "file.txt", "v2");
    await git.commit().setMessage("second").call();
    await git.tag().setName("v2.0.0").call();

    // Create third commit (no tag)
    await addFile(workingCopy, "file.txt", "v3");
    await git.commit().setMessage("third").call();

    // Should pick v2.0.0 (depth 1) over v1.0.0 (depth 2)
    const result = await git.describe().setTags(true).call();

    expect(result.tag).toBe("v2.0.0");
    expect(result.depth).toBe(1);
  });
});

describe.each(backends)("DescribeCommand - API options ($name backend)", ({ factory }) => {
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
   * Test getAbbrev returns set value.
   */
  it("should track abbrev setting", async () => {
    const { git } = await createInitializedGit();

    const command = git.describe();
    expect(command.getAbbrev()).toBe(7); // default

    command.setAbbrev(12);
    expect(command.getAbbrev()).toBe(12);
  });

  /**
   * Test abbrev is clamped to valid range.
   */
  it("should clamp abbrev to valid range", async () => {
    const { git } = await createInitializedGit();

    const command = git.describe();

    // Too small - should clamp to 4
    command.setAbbrev(2);
    expect(command.getAbbrev()).toBe(4);

    // Too large - should clamp to 40
    command.setAbbrev(100);
    expect(command.getAbbrev()).toBe(40);
  });

  /**
   * Test fluent API chaining.
   */
  it("should support fluent API chaining", async () => {
    const { git, workingCopy } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    // All options should be chainable
    const result = await git
      .describe()
      .setTags(true)
      .setLong(false)
      .setAlways(true)
      .setAbbrev(8)
      .setMatch("v*")
      .setExclude("*-beta*")
      .setAll(false)
      .setMaxCandidates(5)
      .call();

    // Should still return something (always is true)
    expect(result.description).toBeDefined();
  });
});
