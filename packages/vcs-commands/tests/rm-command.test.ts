/**
 * Tests for RmCommand
 *
 * Ported from JGit's RmCommandTest.java
 * Tests run against all storage backends (Memory, SQL).
 */

import { afterEach, describe, expect, it } from "vitest";

import { addFile, backends, createInitializedGitFromFactory } from "./test-helper.js";

describe.each(backends)("RmCommand ($name backend)", ({ factory }) => {
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
   * Test removing a single file.
   *
   * Based on JGit's testRemove.
   */
  it("should remove a file from the index", async () => {
    const { git, workingCopy } = await createInitializedGit();

    // Add and commit a file
    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    // Verify file is in staging
    await workingCopy.checkout.staging.read();
    let hasFile = false;
    for await (const entry of workingCopy.checkout.staging.entries()) {
      if (entry.path === "file.txt") {
        hasFile = true;
        break;
      }
    }
    expect(hasFile).toBe(true);

    // Remove the file
    const result = await git.rm().addFilepattern("file.txt").call();

    expect(result.removedPaths).toContain("file.txt");

    // Verify file is no longer in staging
    await workingCopy.checkout.staging.read();
    hasFile = false;
    for await (const entry of workingCopy.checkout.staging.entries()) {
      if (entry.path === "file.txt") {
        hasFile = true;
        break;
      }
    }
    expect(hasFile).toBe(false);
  });

  /**
   * Test removing multiple files.
   */
  it("should remove multiple files", async () => {
    const { git, workingCopy } = await createInitializedGit();

    // Add and commit files
    await addFile(workingCopy, "a.txt", "a");
    await addFile(workingCopy, "b.txt", "b");
    await addFile(workingCopy, "c.txt", "c");
    await git.commit().setMessage("initial").call();

    // Remove two files
    const result = await git.rm().addFilepattern("a.txt").addFilepattern("b.txt").call();

    expect(result.removedPaths).toContain("a.txt");
    expect(result.removedPaths).toContain("b.txt");
    expect(result.removedPaths).not.toContain("c.txt");

    // Verify only c.txt remains
    await workingCopy.checkout.staging.read();
    const remaining: string[] = [];
    for await (const entry of workingCopy.checkout.staging.entries()) {
      remaining.push(entry.path);
    }
    expect(remaining).toEqual(["c.txt"]);
  });

  /**
   * Test removing a directory pattern.
   */
  it("should remove files by directory pattern", async () => {
    const { git, workingCopy } = await createInitializedGit();

    // Add files in different directories
    await addFile(workingCopy, "src/a.txt", "a");
    await addFile(workingCopy, "src/b.txt", "b");
    await addFile(workingCopy, "lib/c.txt", "c");
    await git.commit().setMessage("initial").call();

    // Remove src/ directory
    const result = await git.rm().addFilepattern("src/").call();

    expect(result.removedPaths).toContain("src/a.txt");
    expect(result.removedPaths).toContain("src/b.txt");
    expect(result.removedPaths).not.toContain("lib/c.txt");

    // Verify only lib/c.txt remains
    await workingCopy.checkout.staging.read();
    const remaining: string[] = [];
    for await (const entry of workingCopy.checkout.staging.entries()) {
      remaining.push(entry.path);
    }
    expect(remaining).toEqual(["lib/c.txt"]);
  });

  /**
   * Test removing non-existent file doesn't error.
   */
  it("should succeed when removing non-existent file", async () => {
    const { git, workingCopy } = await createInitializedGit();

    // Add a file
    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    // Remove a file that doesn't exist
    const result = await git.rm().addFilepattern("nonexistent.txt").call();

    expect(result.removedPaths).toEqual([]);

    // Original file should still be there
    await workingCopy.checkout.staging.read();
    const entries: string[] = [];
    for await (const entry of workingCopy.checkout.staging.entries()) {
      entries.push(entry.path);
    }
    expect(entries).toContain("file.txt");
  });

  /**
   * Test setCached option.
   */
  it("should support cached option", async () => {
    const { git, workingCopy } = await createInitializedGit();

    // Add a file
    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    // Create rm command with cached option
    const command = git.rm().addFilepattern("file.txt").setCached(true);

    expect(command.getCached()).toBe(true);

    // Execute
    const result = await command.call();
    expect(result.removedPaths).toContain("file.txt");
  });

  /**
   * Test error when no pattern specified.
   */
  it("should throw error when no pattern specified", async () => {
    const { git, workingCopy } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    await expect(git.rm().call()).rejects.toThrow("At least one file pattern is required");
  });

  /**
   * Test glob pattern matching.
   */
  it("should support glob patterns", async () => {
    const { git, workingCopy } = await createInitializedGit();

    // Add files
    await addFile(workingCopy, "test1.txt", "1");
    await addFile(workingCopy, "test2.txt", "2");
    await addFile(workingCopy, "other.md", "3");
    await git.commit().setMessage("initial").call();

    // Remove with glob pattern
    const result = await git.rm().addFilepattern("*.txt").call();

    expect(result.removedPaths).toContain("test1.txt");
    expect(result.removedPaths).toContain("test2.txt");
    expect(result.removedPaths).not.toContain("other.md");
  });
});

describe.each(backends)("RmCommand - API options ($name backend)", ({ factory }) => {
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
   * Test fluent API.
   */
  it("should support fluent API", async () => {
    const { git, workingCopy } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const result = await git.rm().addFilepattern("file.txt").setCached(true).call();

    expect(result.removedPaths).toContain("file.txt");
  });

  /**
   * Test command cannot be reused.
   */
  it("should not allow command reuse after call", async () => {
    const { git, workingCopy } = await createInitializedGit();

    await addFile(workingCopy, "file.txt", "content");
    await git.commit().setMessage("initial").call();

    const command = git.rm().addFilepattern("file.txt");
    await command.call();

    // Attempting to call again should throw
    await expect(command.call()).rejects.toThrow();
  });
});
