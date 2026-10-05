/**
 * Tests for BlameCommand.
 *
 * Tests line-by-line authorship tracking using diff algorithm.
 */

import { afterEach, describe, expect, it } from "vitest";

import { addFile, backends, createInitializedGitFromFactory } from "./test-helper.js";

describe.each(backends)("BlameCommand ($name backend)", ({ factory }) => {
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

  describe("basic blame", () => {
    it("should blame all lines to initial commit", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Add a file with 3 lines
      await addFile(workingCopy, "file.txt", "line 1\nline 2\nline 3\n");
      await git.commit().setMessage("Add file with 3 lines").call();

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.path).toBe("file.txt");
      expect(result.lineCount).toBe(3);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].lineCount).toBe(3);
    });

    it("should track line additions across commits", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create first commit with one line
      await addFile(workingCopy, "file.txt", "line 1\n");
      await git.commit().setMessage("First commit").call();

      // Get the first commit's ID
      const firstCommitRef = await repository.refs.resolve("HEAD");
      const firstCommitId = firstCommitRef?.objectId ?? "";

      // Create second commit adding more lines
      await addFile(workingCopy, "file.txt", "line 1\nline 2\nline 3\n");
      await git.commit().setMessage("Add lines 2 and 3").call();

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(3);

      // Line 1 should be blamed to first commit
      const entry1 = result.getEntry(1);
      expect(entry1?.commitId).toBe(firstCommitId);

      // Lines 2 and 3 should be blamed to second commit
      const entry2 = result.getEntry(2);
      expect(entry2?.commitId).not.toBe(firstCommitId);

      const entry3 = result.getEntry(3);
      expect(entry3?.commitId).not.toBe(firstCommitId);
    });

    it("should handle line modifications", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create first commit with 3 lines
      await addFile(workingCopy, "file.txt", "original line 1\noriginal line 2\noriginal line 3\n");
      await git.commit().setMessage("Initial commit").call();

      const firstCommitRef = await repository.refs.resolve("HEAD");
      const firstCommitId = firstCommitRef?.objectId ?? "";

      // Modify line 2
      await addFile(workingCopy, "file.txt", "original line 1\nmodified line 2\noriginal line 3\n");
      await git.commit().setMessage("Modify line 2").call();

      const secondCommitRef = await repository.refs.resolve("HEAD");
      const secondCommitId = secondCommitRef?.objectId ?? "";

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(3);

      // Lines 1 and 3 should be blamed to first commit
      expect(result.getEntry(1)?.commitId).toBe(firstCommitId);
      expect(result.getEntry(3)?.commitId).toBe(firstCommitId);

      // Line 2 should be blamed to second commit (modified)
      expect(result.getEntry(2)?.commitId).toBe(secondCommitId);
    });

    it("should handle insertions in the middle", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create first commit with 2 lines
      await addFile(workingCopy, "file.txt", "line 1\nline 3\n");
      await git.commit().setMessage("Initial commit").call();

      const firstCommitRef = await repository.refs.resolve("HEAD");
      const firstCommitId = firstCommitRef?.objectId ?? "";

      // Insert line 2 in the middle
      await addFile(workingCopy, "file.txt", "line 1\nline 2\nline 3\n");
      await git.commit().setMessage("Insert line 2").call();

      const secondCommitRef = await repository.refs.resolve("HEAD");
      const secondCommitId = secondCommitRef?.objectId ?? "";

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(3);

      // Line 1 should be blamed to first commit
      expect(result.getEntry(1)?.commitId).toBe(firstCommitId);

      // Line 2 should be blamed to second commit (inserted)
      expect(result.getEntry(2)?.commitId).toBe(secondCommitId);

      // Line 3 should be blamed to first commit
      expect(result.getEntry(3)?.commitId).toBe(firstCommitId);
    });

    it("should handle multiple commits with different authors", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Create first commit with author A
      await addFile(workingCopy, "file.txt", "author A line\n");
      await git.commit().setMessage("Commit by A").setAuthor("Author A", "a@test.com").call();

      // Create second commit with author B adding a line
      await addFile(workingCopy, "file.txt", "author A line\nauthor B line\n");
      await git.commit().setMessage("Commit by B").setAuthor("Author B", "b@test.com").call();

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(2);

      // Line 1 should be by Author A
      expect(result.getSourceAuthor(1)?.name).toBe("Author A");

      // Line 2 should be by Author B
      expect(result.getSourceAuthor(2)?.name).toBe("Author B");
    });
  });

  describe("edge cases", () => {
    it("should handle empty file", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "empty.txt", "");
      await git.commit().setMessage("Add empty file").call();

      const result = await git.blame().setFilePath("empty.txt").call();

      expect(result.lineCount).toBe(0);
      expect(result.entries).toHaveLength(0);
    });

    it("should throw for non-existent file", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "file.txt", "content");
      await git.commit().setMessage("Initial commit").call();

      await expect(git.blame().setFilePath("nonexistent.txt").call()).rejects.toThrow(
        "File not found",
      );
    });

    it("should throw when file path not set", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "file.txt", "content");
      await git.commit().setMessage("Initial commit").call();

      await expect(git.blame().call()).rejects.toThrow("File path must be set");
    });

    it("should blame at specific commit", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create first commit
      await addFile(workingCopy, "file.txt", "line 1\n");
      await git.commit().setMessage("First commit").call();

      const firstCommitRef = await repository.refs.resolve("HEAD");
      const firstCommitId = firstCommitRef?.objectId ?? "";

      // Create second commit
      await addFile(workingCopy, "file.txt", "line 1\nline 2\n");
      await git.commit().setMessage("Second commit").call();

      // Blame at first commit (only 1 line)
      const result = await git.blame().setFilePath("file.txt").setStartCommit(firstCommitId).call();

      expect(result.lineCount).toBe(1);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].commitId).toBe(firstCommitId);
    });

    it("should handle file with no trailing newline", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "file.txt", "line 1\nline 2"); // No trailing newline
      await git.commit().setMessage("Add file").call();

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(2);
    });
  });

  /**
   * JGit parity tests for line deletion tracking.
   * Ported from BlameCommandTest.java
   */
  describe("line deletion tracking (JGit parity)", () => {
    /**
     * JGit: testDeleteTrailingLines
     * Tests that when trailing lines are added then removed,
     * the original lines retain their blame to the first commit.
     */
    it("should correctly blame after deleting trailing lines", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Step 1: Create file with 2 lines
      await addFile(workingCopy, "file.txt", "a\nb\n");
      await git.commit().setMessage("create file").call();
      const commit1Ref = await repository.refs.resolve("HEAD");
      const commit1 = commit1Ref?.objectId ?? "";

      // Step 2: Add trailing lines (a, b, c, d)
      await addFile(workingCopy, "file.txt", "a\nb\nc\nd\n");
      await git.commit().setMessage("edit file").call();

      // Step 3: Delete trailing lines (back to a, b)
      await addFile(workingCopy, "file.txt", "a\nb\n");
      await git.commit().setMessage("edit file").call();

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(2);
      expect(result.getEntry(1)?.commitId).toBe(commit1);
      expect(result.getEntry(2)?.commitId).toBe(commit1);
    });

    /**
     * JGit: testDeleteMiddleLines
     * Tests that when middle lines are added then removed,
     * the surrounding lines retain their blame to the first commit.
     */
    it("should correctly blame after deleting middle lines", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Step 1: Create file with 3 lines (a, c, e)
      await addFile(workingCopy, "file.txt", "a\nc\ne\n");
      await git.commit().setMessage("create file").call();
      const commit1Ref = await repository.refs.resolve("HEAD");
      const commit1 = commit1Ref?.objectId ?? "";

      // Step 2: Add middle lines (a, b, c, d, e)
      await addFile(workingCopy, "file.txt", "a\nb\nc\nd\ne\n");
      await git.commit().setMessage("edit file").call();

      // Step 3: Delete middle lines (back to a, c, e)
      await addFile(workingCopy, "file.txt", "a\nc\ne\n");
      await git.commit().setMessage("edit file").call();

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(3);
      expect(result.getEntry(1)?.commitId).toBe(commit1);
      expect(result.getEntry(2)?.commitId).toBe(commit1);
      expect(result.getEntry(3)?.commitId).toBe(commit1);
    });

    /**
     * JGit: testEditAllLines
     * Tests that when all lines are modified, all lines are blamed
     * to the commit that modified them.
     */
    it("should blame all lines to second commit when all edited", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Step 1: Create file with original content
      await addFile(workingCopy, "file.txt", "a\n1\n");
      await git.commit().setMessage("create file").call();

      // Step 2: Edit all lines
      await addFile(workingCopy, "file.txt", "b\n2\n");
      await git.commit().setMessage("edit file").call();
      const commit2Ref = await repository.refs.resolve("HEAD");
      const commit2 = commit2Ref?.objectId ?? "";

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(2);
      expect(result.getEntry(1)?.commitId).toBe(commit2);
      expect(result.getEntry(2)?.commitId).toBe(commit2);
    });

    /**
     * JGit: testMiddleClearAllLines
     * Tests that when file is cleared then repopulated with same content,
     * all lines are blamed to the commit that repopulated them.
     */
    it("should blame all lines to third commit after clear and repopulate", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Step 1: Create file with content
      await addFile(workingCopy, "file.txt", "a\nb\nc\n");
      await git.commit().setMessage("create file").call();

      // Step 2: Clear the file
      await addFile(workingCopy, "file.txt", "");
      await git.commit().setMessage("clear file").call();

      // Step 3: Repopulate with same content
      await addFile(workingCopy, "file.txt", "a\nb\nc\n");
      await git.commit().setMessage("repopulate file").call();
      const commit3Ref = await repository.refs.resolve("HEAD");
      const commit3 = commit3Ref?.objectId ?? "";

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(3);
      expect(result.getEntry(1)?.commitId).toBe(commit3);
      expect(result.getEntry(2)?.commitId).toBe(commit3);
      expect(result.getEntry(3)?.commitId).toBe(commit3);
    });
  });

  /**
   * JGit parity tests for rename tracking.
   * Ported from BlameCommandTest.java
   *
   * TODO: These tests require implementing actual rename tracking in BlameCommand.
   * Currently setFollowRenames(true) is a no-op.
   */
  describe("rename tracking (JGit parity)", () => {
    /**
     * Helper to rename a file in staging.
     */
    async function renameFile(
      wc: Awaited<ReturnType<typeof createInitializedGit>>["workingCopy"],
      oldPath: string,
      newPath: string,
    ): Promise<void> {
      const entries: Array<{ path: string; objectId: string; mode: number }> = [];

      // Collect all entries except the old path
      for await (const entry of wc.checkout.staging.entries()) {
        if (entry.path !== oldPath) {
          entries.push({ path: entry.path, objectId: entry.objectId, mode: entry.mode });
        } else {
          // Add the entry with new path
          entries.push({ path: newPath, objectId: entry.objectId, mode: entry.mode });
        }
      }

      // Rebuild staging with renamed file
      const builder = wc.checkout.staging.createBuilder();
      for (const entry of entries) {
        builder.add({
          path: entry.path,
          objectId: entry.objectId as ReturnType<typeof entry.objectId.toString>,
          mode: entry.mode,
          stage: 0,
          size: 100,
          mtime: Date.now(),
        });
      }
      await builder.finish();
    }

    /**
     * JGit: testRename
     * Tests blame following a simple file rename.
     */
    it("should follow simple file rename", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create file with 3 lines
      await addFile(workingCopy, "file1.txt", "a\nb\nc\n");
      await git.commit().setMessage("create file").call();

      const commit1Ref = await repository.refs.resolve("HEAD");
      const commit1 = commit1Ref?.objectId ?? "";

      // Rename file1.txt to file2.txt
      await renameFile(workingCopy, "file1.txt", "file2.txt");
      await git.commit().setMessage("moving file").call();

      // Edit last line
      await addFile(workingCopy, "file2.txt", "a\nb\nc2\n");
      await git.commit().setMessage("editing file").call();

      const commit3Ref = await repository.refs.resolve("HEAD");
      const commit3 = commit3Ref?.objectId ?? "";

      const result = await git.blame().setFilePath("file2.txt").setFollowRenames(true).call();

      expect(result.lineCount).toBe(3);

      // Lines 1 and 2 should be blamed to first commit (before rename)
      expect(result.getEntry(1)?.commitId).toBe(commit1);
      expect(result.getEntry(1)?.sourcePath).toBe("file1.txt");

      expect(result.getEntry(2)?.commitId).toBe(commit1);
      expect(result.getEntry(2)?.sourcePath).toBe("file1.txt");

      // Line 3 should be blamed to third commit (after edit)
      expect(result.getEntry(3)?.commitId).toBe(commit3);
      expect(result.getEntry(3)?.sourcePath).toBe("file2.txt");
    });

    /**
     * JGit: testRenameInSubDir
     * Tests blame following a file rename within the same subdirectory.
     */
    it("should follow rename in subdirectory", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create file in subdirectory
      await addFile(workingCopy, "subdir/file1.txt", "a\nb\nc\n");
      await git.commit().setMessage("create file").call();

      const commit1Ref = await repository.refs.resolve("HEAD");
      const commit1 = commit1Ref?.objectId ?? "";

      // Rename within same directory
      await renameFile(workingCopy, "subdir/file1.txt", "subdir/file2.txt");
      await git.commit().setMessage("moving file").call();

      // Edit last line
      await addFile(workingCopy, "subdir/file2.txt", "a\nb\nc2\n");
      await git.commit().setMessage("editing file").call();

      const commit3Ref = await repository.refs.resolve("HEAD");
      const commit3 = commit3Ref?.objectId ?? "";

      const result = await git
        .blame()
        .setFilePath("subdir/file2.txt")
        .setFollowRenames(true)
        .call();

      expect(result.lineCount).toBe(3);

      // Lines 1 and 2 traced back to original file
      expect(result.getEntry(1)?.commitId).toBe(commit1);
      expect(result.getEntry(1)?.sourcePath).toBe("subdir/file1.txt");

      expect(result.getEntry(2)?.commitId).toBe(commit1);
      expect(result.getEntry(2)?.sourcePath).toBe("subdir/file1.txt");

      // Line 3 from the edit
      expect(result.getEntry(3)?.commitId).toBe(commit3);
      expect(result.getEntry(3)?.sourcePath).toBe("subdir/file2.txt");
    });

    /**
     * JGit: testMoveToOtherDir
     * Tests blame following a file move to a different directory.
     */
    it("should follow move to different directory", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create file in subdirectory
      await addFile(workingCopy, "subdir/file1.txt", "a\nb\nc\n");
      await git.commit().setMessage("create file").call();

      const commit1Ref = await repository.refs.resolve("HEAD");
      const commit1 = commit1Ref?.objectId ?? "";

      // Move to different directory
      await renameFile(workingCopy, "subdir/file1.txt", "otherdir/file1.txt");
      await git.commit().setMessage("moving file").call();

      // Edit last line
      await addFile(workingCopy, "otherdir/file1.txt", "a\nb\nc2\n");
      await git.commit().setMessage("editing file").call();

      const commit3Ref = await repository.refs.resolve("HEAD");
      const commit3 = commit3Ref?.objectId ?? "";

      const result = await git
        .blame()
        .setFilePath("otherdir/file1.txt")
        .setFollowRenames(true)
        .call();

      expect(result.lineCount).toBe(3);

      // Lines 1 and 2 traced back to original location
      expect(result.getEntry(1)?.commitId).toBe(commit1);
      expect(result.getEntry(1)?.sourcePath).toBe("subdir/file1.txt");

      expect(result.getEntry(2)?.commitId).toBe(commit1);
      expect(result.getEntry(2)?.sourcePath).toBe("subdir/file1.txt");

      // Line 3 from the edit
      expect(result.getEntry(3)?.commitId).toBe(commit3);
      expect(result.getEntry(3)?.sourcePath).toBe("otherdir/file1.txt");
    });

    /**
     * JGit: testTwoRenames
     * Tests blame following a file through two consecutive renames.
     */
    it("should follow two consecutive renames", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create file.txt
      await addFile(workingCopy, "file.txt", "a\n");
      await git.commit().setMessage("create file").call();

      const commit1Ref = await repository.refs.resolve("HEAD");
      const commit1 = commit1Ref?.objectId ?? "";

      // Rename to file1.txt
      await renameFile(workingCopy, "file.txt", "file1.txt");
      await git.commit().setMessage("moving file").call();

      // Edit and add line
      await addFile(workingCopy, "file1.txt", "a\nb\n");
      await git.commit().setMessage("editing file").call();

      const commit3Ref = await repository.refs.resolve("HEAD");
      const commit3 = commit3Ref?.objectId ?? "";

      // Rename to file2.txt
      await renameFile(workingCopy, "file1.txt", "file2.txt");
      await git.commit().setMessage("moving file again").call();

      const result = await git.blame().setFilePath("file2.txt").setFollowRenames(true).call();

      expect(result.lineCount).toBe(2);

      // Line 1 traced back through two renames to original file
      expect(result.getEntry(1)?.commitId).toBe(commit1);
      expect(result.getEntry(1)?.sourcePath).toBe("file.txt");

      // Line 2 added during first rename
      expect(result.getEntry(2)?.commitId).toBe(commit3);
      expect(result.getEntry(2)?.sourcePath).toBe("file1.txt");
    });
  });

  /**
   * JGit parity tests for CRLF line ending handling.
   * Ported from BlameCommandTest.java
   *
   * Tests that blame correctly handles files with Windows-style line endings (CRLF).
   */
  describe("CRLF handling (JGit parity)", () => {
    /**
     * JGit: testCoreAutoCrlf pattern
     * Tests blame with CRLF line endings in file content.
     */
    it("should correctly count lines with CRLF endings", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // File with Windows-style line endings (CRLF)
      await addFile(workingCopy, "file.txt", "a\r\nb\r\nc\r\n");
      await git.commit().setMessage("create file").call();

      const commitRef = await repository.refs.resolve("HEAD");
      const commitId = commitRef?.objectId ?? "";

      const result = await git.blame().setFilePath("file.txt").call();

      // Should recognize 3 lines despite CRLF endings
      expect(result.lineCount).toBe(3);
      expect(result.getEntry(1)?.commitId).toBe(commitId);
      expect(result.getEntry(2)?.commitId).toBe(commitId);
      expect(result.getEntry(3)?.commitId).toBe(commitId);
    });

    /**
     * Tests blame tracking changes across CRLF and LF mixed content.
     */
    it("should track changes in files with mixed line endings", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Start with CRLF file
      await addFile(workingCopy, "file.txt", "line1\r\nline2\r\n");
      await git.commit().setMessage("create file").call();

      const commit1Ref = await repository.refs.resolve("HEAD");
      const commit1 = commit1Ref?.objectId ?? "";

      // Add a new line (keeping CRLF)
      await addFile(workingCopy, "file.txt", "line1\r\nline2\r\nline3\r\n");
      await git.commit().setMessage("add line").call();

      const commit2Ref = await repository.refs.resolve("HEAD");
      const commit2 = commit2Ref?.objectId ?? "";

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(3);
      expect(result.getEntry(1)?.commitId).toBe(commit1);
      expect(result.getEntry(2)?.commitId).toBe(commit1);
      expect(result.getEntry(3)?.commitId).toBe(commit2);
    });

    /**
     * Tests blame with only CR line endings (old Mac style).
     * CR-only line endings are now supported by RawText.
     */
    it("should handle CR-only line endings", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // File with old Mac-style line endings (CR only)
      await addFile(workingCopy, "file.txt", "a\rb\rc\r");
      await git.commit().setMessage("create file").call();

      const commitRef = await repository.refs.resolve("HEAD");
      const commitId = commitRef?.objectId ?? "";

      const result = await git.blame().setFilePath("file.txt").call();

      // CR-only should be treated as line endings
      expect(result.lineCount).toBe(3);
      expect(result.getEntry(1)?.commitId).toBe(commitId);
    });
  });

  /**
   * JGit parity tests for blame after merge conflicts.
   * Ported from BlameCommandTest.java
   *
   * Tests that blame correctly tracks authorship after merges,
   * especially when conflicts were resolved.
   *
   * TODO: The current blame algorithm walks commit history linearly and
   * doesn't implement proper multi-parent blame tracking. JGit's BlameGenerator
   * uses a more sophisticated approach that follows all parent commits and
   * tracks line origins across merge boundaries. These tests document the
   * expected behavior for when multi-parent blame is implemented.
   */
  describe("merge conflict tracking (JGit parity)", () => {
    /**
     * JGit: testConflictingMerge1 pattern
     * Tests blame after resolving a merge conflict.
     * Lines from different sources should be attributed correctly.
     */
    it("should correctly attribute lines after merge conflict resolution", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Base: create file with 5 lines
      await addFile(workingCopy, "file.txt", "0\n1\n2\n3\n4\n");
      await git.commit().setMessage("base commit").call();

      const baseRef = await repository.refs.resolve("HEAD");
      const baseCommitId = baseRef?.objectId ?? "";

      // Create side branch
      await git.branchCreate().setName("side").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/side");
      const sideRef = await repository.refs.resolve("refs/heads/side");
      const sideCommit = await repository.commits.load(sideRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, sideCommit.tree);

      // Modify on side branch
      await addFile(workingCopy, "file.txt", "0\n1 side\n2\n3 on side\n4\n");
      await git.commit().setMessage("side changes").call();

      const sideModRef = await repository.refs.resolve("HEAD");
      const sideModCommitId = sideModRef?.objectId ?? "";

      // Switch to main and modify differently
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Remove line on main (will conflict with side's modification)
      await addFile(workingCopy, "file.txt", "0\n1\n2\n");
      await git.commit().setMessage("main removes lines").call();

      // Get the main commit ID before merge
      const mainModRef = await repository.refs.resolve("HEAD");
      const mainModCommitId = mainModRef?.objectId ?? "";

      // Resolve conflict manually - keep side's changes plus resolution
      // This creates a merge commit with TWO parents (main + side)
      await addFile(workingCopy, "file.txt", "0\n1 side\n2\n3 resolved\n4\n");
      await git
        .commit()
        .setMessage("merge resolution")
        .setParentIds(mainModCommitId, sideModCommitId)
        .call();

      const mergeRef = await repository.refs.resolve("HEAD");
      const mergeCommitId = mergeRef?.objectId ?? "";

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(5);

      // Line 0: from base (unchanged)
      expect(result.getEntry(1)?.commitId).toBe(baseCommitId);

      // Line "1 side": from side branch
      expect(result.getEntry(2)?.commitId).toBe(sideModCommitId);

      // Line 2: from base (unchanged)
      expect(result.getEntry(3)?.commitId).toBe(baseCommitId);

      // Line "3 resolved": new in merge resolution
      expect(result.getEntry(4)?.commitId).toBe(mergeCommitId);

      // Line 4: from base (preserved from side)
      // Note: This line survived from base through side branch
    });

    /**
     * Tests blame with multiple parents (merge commit).
     */
    it("should handle files modified in merge commits", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create base file
      await addFile(workingCopy, "file.txt", "base line\n");
      await git.commit().setMessage("initial").call();

      const baseRef = await repository.refs.resolve("HEAD");
      const baseCommitId = baseRef?.objectId ?? "";

      // Create branch and add line
      await git.branchCreate().setName("feature").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/feature");
      const featureRef = await repository.refs.resolve("refs/heads/feature");
      const featureCommit = await repository.commits.load(featureRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, featureCommit.tree);

      await addFile(workingCopy, "file.txt", "base line\nfeature line\n");
      await git.commit().setMessage("feature addition").call();

      const featureModRef = await repository.refs.resolve("HEAD");
      const featureModCommitId = featureModRef?.objectId ?? "";

      // Switch back to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommitId = mainRef?.objectId ?? "";
      const mainCommit = await repository.commits.load(mainCommitId);
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Merge feature (should be clean merge)
      // Create a merge commit with TWO parents (main + feature)
      await addFile(workingCopy, "file.txt", "base line\nfeature line\n");
      await git
        .commit()
        .setMessage("merge feature")
        .setParentIds(mainCommitId, featureModCommitId)
        .call();

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(2);
      expect(result.getEntry(1)?.commitId).toBe(baseCommitId);
      expect(result.getEntry(2)?.commitId).toBe(featureModCommitId);
    });
  });

  /**
   * JGit parity tests from BlameGeneratorTest.java.
   * Tests for advanced blame scenarios with boundary conditions.
   */
  describe("BlameGenerator advanced tests (JGit parity)", () => {
    /**
     * JGit: testBoundLineDelete
     * Tests that when a line is inserted at the beginning, the original lines
     * are correctly attributed to the first commit.
     */
    it("should correctly track lines when line inserted at beginning", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Step 1: Create file with 2 lines
      await addFile(workingCopy, "file.txt", "first\nsecond\n");
      await git.commit().setMessage("create file").call();

      const commit1Ref = await repository.refs.resolve("HEAD");
      const commit1 = commit1Ref?.objectId ?? "";

      // Step 2: Insert a line at the beginning (third, first, second)
      await addFile(workingCopy, "file.txt", "third\nfirst\nsecond\n");
      await git.commit().setMessage("add line at start").call();

      const commit2Ref = await repository.refs.resolve("HEAD");
      const commit2 = commit2Ref?.objectId ?? "";

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(3);

      // Line 1 (third) should be from commit2
      expect(result.getEntry(1)?.commitId).toBe(commit2);
      expect(result.getEntry(1)?.resultStart).toBe(1);

      // Lines 2 and 3 (first, second) should be from commit1
      expect(result.getEntry(2)?.commitId).toBe(commit1);
      expect(result.getEntry(3)?.commitId).toBe(commit1);
    });

    /**
     * JGit: testRenamedBoundLineDelete
     * Tests blame after rename with line insertion at beginning.
     * Lines should be traced back through rename to original file.
     */
    it("should track lines through rename with insertion at start", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      const FILENAME_1 = "subdir/file1.txt";
      const FILENAME_2 = "subdir/file2.txt";

      // Step 1: Create file with 2 lines
      await addFile(workingCopy, FILENAME_1, "first\nsecond\n");
      await git.commit().setMessage("create file1").call();

      const commit1Ref = await repository.refs.resolve("HEAD");
      const commit1 = commit1Ref?.objectId ?? "";

      // Step 2: Rename file1.txt to file2.txt
      // Need to implement renameFile helper
      const entries: Array<{ path: string; objectId: string; mode: number }> = [];
      for await (const entry of workingCopy.checkout.staging.entries()) {
        if (entry.path !== FILENAME_1) {
          entries.push({ path: entry.path, objectId: entry.objectId, mode: entry.mode });
        } else {
          entries.push({ path: FILENAME_2, objectId: entry.objectId, mode: entry.mode });
        }
      }
      const builder = workingCopy.checkout.staging.createBuilder();
      for (const entry of entries) {
        builder.add({
          path: entry.path,
          objectId: entry.objectId as ReturnType<typeof entry.objectId.toString>,
          mode: entry.mode,
          stage: 0,
          size: 100,
          mtime: Date.now(),
        });
      }
      await builder.finish();
      await git.commit().setMessage("rename file1.txt to file2.txt").call();

      // Step 3: Add line at beginning
      await addFile(workingCopy, FILENAME_2, "third\nfirst\nsecond\n");
      await git.commit().setMessage("change file2").call();

      const commit3Ref = await repository.refs.resolve("HEAD");
      const commit3 = commit3Ref?.objectId ?? "";

      const result = await git.blame().setFilePath(FILENAME_2).setFollowRenames(true).call();

      expect(result.lineCount).toBe(3);

      // Line 1 (third) should be from commit3
      expect(result.getEntry(1)?.commitId).toBe(commit3);
      expect(result.getEntry(1)?.sourcePath).toBe(FILENAME_2);

      // Lines 2 and 3 should be traced back to commit1 through rename
      expect(result.getEntry(2)?.commitId).toBe(commit1);
      expect(result.getEntry(2)?.sourcePath).toBe(FILENAME_1);

      expect(result.getEntry(3)?.commitId).toBe(commit1);
      expect(result.getEntry(3)?.sourcePath).toBe(FILENAME_1);
    });

    /**
     * JGit: testLinesAllDeletedShortenedWalk
     * Tests that when content is cleared and restored, blame correctly
     * attributes to the restoration commit.
     */
    it("should attribute lines to restoration commit after clear", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Step 1: Create file with 3 lines
      await addFile(workingCopy, "file.txt", "first\nsecond\nthird\n");
      await git.commit().setMessage("create file").call();

      // Step 2: Clear file (empty content)
      await addFile(workingCopy, "file.txt", "");
      await git.commit().setMessage("clear file").call();

      // Step 3: Restore content
      await addFile(workingCopy, "file.txt", "first\nsecond\nthird\n");
      await git.commit().setMessage("restore file").call();

      const commit3Ref = await repository.refs.resolve("HEAD");
      const commit3 = commit3Ref?.objectId ?? "";

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(3);

      // All lines should be from commit3 (restoration)
      expect(result.getEntry(1)?.commitId).toBe(commit3);
      expect(result.getEntry(2)?.commitId).toBe(commit3);
      expect(result.getEntry(3)?.commitId).toBe(commit3);
    });
  });

  /**
   * JGit parity tests for NUL byte handling in blame.
   * Ported from BlameCommandTest.java
   */
  describe("NUL byte handling (JGit parity)", () => {
    /**
     * Helper to add binary content to staging.
     */
    async function addBinaryFile(
      wc: Awaited<ReturnType<typeof createInitializedGit>>["workingCopy"],
      repo: Awaited<ReturnType<typeof createInitializedGit>>["repository"],
      filePath: string,
      content: Uint8Array,
    ): Promise<void> {
      const objectId = await repo.blobs.store([content]);
      const editor = wc.checkout.staging.createEditor();
      editor.add({
        path: filePath,
        apply: () => ({
          path: filePath,
          objectId,
          mode: 0o100644,
          size: content.length,
          mtime: Date.now(),
          stage: 0,
        }),
      });
      await editor.finish();
    }

    /**
     * JGit: testBlameWithNulByteInHistory
     * Tests blame when a NUL byte appears and is later removed.
     */
    it("should handle NUL byte appearing and being removed in history", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Step 1: Create file
      await addFile(workingCopy, "file.txt", "First line\nAnother line\n");
      await git.commit().setMessage("create file").call();

      const commit1Ref = await repository.refs.resolve("HEAD");
      const commit1 = commit1Ref?.objectId ?? "";

      // Step 2: Add line with NUL byte (using Uint8Array for binary control)
      const encoder = new TextEncoder();
      const line1 = encoder.encode("First line\n");
      const lineWithNul = new Uint8Array([
        ...encoder.encode("Second line with NUL >"),
        0x00,
        ...encoder.encode("<\n"),
      ]);
      const line3 = encoder.encode("Another line\n");
      const contentWithNul = new Uint8Array([...line1, ...lineWithNul, ...line3]);
      await addBinaryFile(workingCopy, repository, "file.txt", contentWithNul);
      await git.commit().setMessage("add line with NUL").call();

      // Step 3: Modify third line
      const line3Modified = encoder.encode("Third line\n");
      const contentModified = new Uint8Array([...line1, ...lineWithNul, ...line3Modified]);
      await addBinaryFile(workingCopy, repository, "file.txt", contentModified);
      await git.commit().setMessage("change third line").call();

      const commit3Ref = await repository.refs.resolve("HEAD");
      const commit3 = commit3Ref?.objectId ?? "";

      // Step 4: Fix NUL line
      await addFile(
        workingCopy,
        "file.txt",
        "First line\nSecond line with NUL >\\000<\nThird line\n",
      );
      await git.commit().setMessage("fix NUL line").call();

      const commit4Ref = await repository.refs.resolve("HEAD");
      const commit4 = commit4Ref?.objectId ?? "";

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(3);
      expect(result.getEntry(1)?.commitId).toBe(commit1);
      expect(result.getEntry(2)?.commitId).toBe(commit4);
      expect(result.getEntry(3)?.commitId).toBe(commit3);
    });

    /**
     * JGit: testBlameWithNulByteInTopRevision
     * Tests blame when the current revision contains a NUL byte.
     */
    it("should handle NUL byte in current revision", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Step 1: Create file
      await addFile(workingCopy, "file.txt", "First line\nAnother line\n");
      await git.commit().setMessage("create file").call();

      const commit1Ref = await repository.refs.resolve("HEAD");
      const commit1 = commit1Ref?.objectId ?? "";

      // Step 2: Add line with NUL byte
      const encoder = new TextEncoder();
      const line1 = encoder.encode("First line\n");
      const lineWithNul = new Uint8Array([
        ...encoder.encode("Second line with NUL >"),
        0x00,
        ...encoder.encode("<\n"),
      ]);
      const line3 = encoder.encode("Another line\n");
      const contentWithNul = new Uint8Array([...line1, ...lineWithNul, ...line3]);
      await addBinaryFile(workingCopy, repository, "file.txt", contentWithNul);
      await git.commit().setMessage("add line with NUL").call();

      const commit2Ref = await repository.refs.resolve("HEAD");
      const commit2 = commit2Ref?.objectId ?? "";

      // Step 3: Change third line (keep NUL in second line)
      const line3Modified = encoder.encode("Third line\n");
      const contentModified = new Uint8Array([...line1, ...lineWithNul, ...line3Modified]);
      await addBinaryFile(workingCopy, repository, "file.txt", contentModified);
      await git.commit().setMessage("change third line").call();

      const commit3Ref = await repository.refs.resolve("HEAD");
      const commit3 = commit3Ref?.objectId ?? "";

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.lineCount).toBe(3);
      expect(result.getEntry(1)?.commitId).toBe(commit1);
      expect(result.getEntry(2)?.commitId).toBe(commit2);
      expect(result.getEntry(3)?.commitId).toBe(commit3);
    });
  });

  describe("BlameResult methods", () => {
    it("getEntry should return correct entry for line", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "file.txt", "line 1\nline 2\nline 3\n");
      await git.commit().setMessage("Initial").call();

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.getEntry(1)).toBeDefined();
      expect(result.getEntry(2)).toBeDefined();
      expect(result.getEntry(3)).toBeDefined();
      expect(result.getEntry(0)).toBeUndefined(); // 0 is out of range (1-based)
      expect(result.getEntry(4)).toBeUndefined(); // Out of range
    });

    it("getSourceCommit should return commit for line", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "file.txt", "line 1\n");
      await git.commit().setMessage("Initial").call();

      const result = await git.blame().setFilePath("file.txt").call();

      const commit = result.getSourceCommit(1);
      expect(commit).toBeDefined();
      expect(commit?.message).toContain("Initial");
    });

    it("getSourceAuthor should return author for line", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "file.txt", "line 1\n");
      await git.commit().setMessage("Initial").setAuthor("Test Author", "test@example.com").call();

      const result = await git.blame().setFilePath("file.txt").call();

      const author = result.getSourceAuthor(1);
      expect(author?.name).toBe("Test Author");
      expect(author?.email).toBe("test@example.com");
    });

    it("getSourceLine should return original line number in source", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Create file with 3 lines
      await addFile(workingCopy, "file.txt", "a\nc\ne\n");
      await git.commit().setMessage("create file").call();

      // Add middle lines (a, b, c, d, e)
      await addFile(workingCopy, "file.txt", "a\nb\nc\nd\ne\n");
      await git.commit().setMessage("edit file").call();

      // Delete middle lines (back to a, c, e)
      await addFile(workingCopy, "file.txt", "a\nc\ne\n");
      await git.commit().setMessage("edit file").call();

      const result = await git.blame().setFilePath("file.txt").call();

      // All lines should map back to their original positions in commit1
      expect(result.getSourceLine(1)).toBe(1); // "a" -> line 1 in source
      expect(result.getSourceLine(2)).toBe(2); // "c" -> line 2 in source
      expect(result.getSourceLine(3)).toBe(3); // "e" -> line 3 in source
    });

    it("getSourcePath should return source path", async () => {
      const { git, workingCopy } = await createInitializedGit();

      await addFile(workingCopy, "file.txt", "line 1\n");
      await git.commit().setMessage("Initial").call();

      const result = await git.blame().setFilePath("file.txt").call();

      expect(result.getSourcePath(1)).toBe("file.txt");
    });

    it("getLineTracking should return detailed tracking for all lines", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create first commit with author A
      await addFile(workingCopy, "file.txt", "line A\n");
      await git.commit().setMessage("Commit by A").setAuthor("Author A", "a@test.com").call();

      const commit1Ref = await repository.refs.resolve("HEAD");
      const commit1Id = commit1Ref?.objectId ?? "";

      // Create second commit with author B adding a line
      await addFile(workingCopy, "file.txt", "line A\nline B\n");
      await git.commit().setMessage("Commit by B").setAuthor("Author B", "b@test.com").call();

      const commit2Ref = await repository.refs.resolve("HEAD");
      const commit2Id = commit2Ref?.objectId ?? "";

      const result = await git.blame().setFilePath("file.txt").call();
      const tracking = result.getLineTracking();

      expect(tracking).toHaveLength(2);

      // Line 1 tracking
      expect(tracking[0].resultLine).toBe(1);
      expect(tracking[0].commitId).toBe(commit1Id);
      expect(tracking[0].sourcePath).toBe("file.txt");
      expect(tracking[0].sourceLine).toBe(1);
      expect(tracking[0].commit.author.name).toBe("Author A");

      // Line 2 tracking
      expect(tracking[1].resultLine).toBe(2);
      expect(tracking[1].commitId).toBe(commit2Id);
      expect(tracking[1].sourcePath).toBe("file.txt");
      expect(tracking[1].sourceLine).toBe(2);
      expect(tracking[1].commit.author.name).toBe("Author B");
    });

    it("getLineTracking should track through renames", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create file1.txt with 2 lines
      await addFile(workingCopy, "file1.txt", "a\nb\n");
      await git.commit().setMessage("create file").call();

      const commit1Ref = await repository.refs.resolve("HEAD");
      const commit1Id = commit1Ref?.objectId ?? "";

      // Rename to file2.txt
      const entries: Array<{ path: string; objectId: string; mode: number }> = [];
      for await (const entry of workingCopy.checkout.staging.entries()) {
        if (entry.path !== "file1.txt") {
          entries.push({ path: entry.path, objectId: entry.objectId, mode: entry.mode });
        } else {
          entries.push({ path: "file2.txt", objectId: entry.objectId, mode: entry.mode });
        }
      }
      const builder = workingCopy.checkout.staging.createBuilder();
      for (const entry of entries) {
        builder.add({
          path: entry.path,
          objectId: entry.objectId as ReturnType<typeof entry.objectId.toString>,
          mode: entry.mode,
          stage: 0,
          size: 100,
          mtime: Date.now(),
        });
      }
      await builder.finish();
      await git.commit().setMessage("rename file").call();

      const result = await git.blame().setFilePath("file2.txt").setFollowRenames(true).call();
      const tracking = result.getLineTracking();

      expect(tracking).toHaveLength(2);

      // Both lines should be traced back to file1.txt in commit1
      expect(tracking[0].resultLine).toBe(1);
      expect(tracking[0].commitId).toBe(commit1Id);
      expect(tracking[0].sourcePath).toBe("file1.txt");
      expect(tracking[0].sourceLine).toBe(1);

      expect(tracking[1].resultLine).toBe(2);
      expect(tracking[1].commitId).toBe(commit1Id);
      expect(tracking[1].sourcePath).toBe("file1.txt");
      expect(tracking[1].sourceLine).toBe(2);
    });
  });
});
