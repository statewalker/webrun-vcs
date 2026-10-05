/**
 * History Operations Integration Tests
 *
 * Tests from apps/examples/05-history-operations (5 steps):
 * Step 01: Log Traversal - maxCount, skip, ordering
 * Step 02: Commit Ancestry - isAncestor, merge base
 * Step 03: Diff Commits - ADD/DELETE/MODIFY/RENAME
 * Step 04: Blame - line attribution
 * Step 05: File History - changes to specific files
 */

import { ChangeType } from "@statewalker/vcs-commands";
import { afterEach, describe, expect, it } from "vitest";

import { addFile, backends, createInitializedGitFromFactory, toArray } from "./test-helper.js";

describe.each(backends)("History Operations ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  // Step 1: Log Traversal
  describe("Step 1: Log Traversal", () => {
    it("should traverse commit history", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // Create commits
      await addFile(store, "file1.txt", "1");
      await store.staging.write();
      await git.commit().setMessage("First").call();

      await addFile(store, "file2.txt", "2");
      await store.staging.write();
      await git.commit().setMessage("Second").call();

      await addFile(store, "file3.txt", "3");
      await store.staging.write();
      await git.commit().setMessage("Third").call();

      const commits = await toArray(await git.log().call());

      expect(commits.length).toBe(4); // Initial + 3
      expect(commits[0].message).toBe("Third");
      expect(commits[1].message).toBe("Second");
      expect(commits[2].message).toBe("First");
      expect(commits[3].message).toBe("Initial commit");
    });

    it("should support maxCount", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      for (let i = 1; i <= 10; i++) {
        await addFile(store, `file${i}.txt`, `${i}`);
        await store.staging.write();
        await git.commit().setMessage(`Commit ${i}`).call();
      }

      const commits = await toArray(await git.log().setMaxCount(3).call());

      expect(commits.length).toBe(3);
      expect(commits[0].message).toBe("Commit 10");
      expect(commits[2].message).toBe("Commit 8");
    });

    it("should support skip", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      for (let i = 1; i <= 5; i++) {
        await addFile(store, `file${i}.txt`, `${i}`);
        await store.staging.write();
        await git.commit().setMessage(`Commit ${i}`).call();
      }

      const commits = await toArray(await git.log().setSkip(2).setMaxCount(2).call());

      expect(commits.length).toBe(2);
      expect(commits[0].message).toBe("Commit 3");
      expect(commits[1].message).toBe("Commit 2");
    });
  });

  // Step 2: Commit Ancestry
  describe("Step 2: Commit Ancestry", () => {
    it("should walk commit ancestry", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { store } = result;

      const emptyTreeId = await store.trees.store([]);

      const commit1 = await store.commits.store({
        tree: emptyTreeId,
        parents: [],
        author: { name: "A", email: "a@b.c", timestamp: 1, tzOffset: "+0000" },
        committer: { name: "A", email: "a@b.c", timestamp: 1, tzOffset: "+0000" },
        message: "First",
      });

      const commit2 = await store.commits.store({
        tree: emptyTreeId,
        parents: [commit1],
        author: { name: "A", email: "a@b.c", timestamp: 2, tzOffset: "+0000" },
        committer: { name: "A", email: "a@b.c", timestamp: 2, tzOffset: "+0000" },
        message: "Second",
      });

      const commit3 = await store.commits.store({
        tree: emptyTreeId,
        parents: [commit2],
        author: { name: "A", email: "a@b.c", timestamp: 3, tzOffset: "+0000" },
        committer: { name: "A", email: "a@b.c", timestamp: 3, tzOffset: "+0000" },
        message: "Third",
      });

      const ancestry = await toArray(store.commits.walkAncestry(commit3));

      expect(ancestry).toEqual([commit3, commit2, commit1]);
    });

    it("should find merge base for divergent branches", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { store } = result;

      const emptyTreeId = await store.trees.store([]);

      // Create base commit
      const baseCommit = await store.commits.store({
        tree: emptyTreeId,
        parents: [],
        author: { name: "A", email: "a@b.c", timestamp: 1, tzOffset: "+0000" },
        committer: { name: "A", email: "a@b.c", timestamp: 1, tzOffset: "+0000" },
        message: "Base",
      });

      // Branch 1
      const branch1Commit = await store.commits.store({
        tree: emptyTreeId,
        parents: [baseCommit],
        author: { name: "A", email: "a@b.c", timestamp: 2, tzOffset: "+0000" },
        committer: { name: "A", email: "a@b.c", timestamp: 2, tzOffset: "+0000" },
        message: "Branch 1",
      });

      // Branch 2
      const branch2Commit = await store.commits.store({
        tree: emptyTreeId,
        parents: [baseCommit],
        author: { name: "A", email: "a@b.c", timestamp: 3, tzOffset: "+0000" },
        committer: { name: "A", email: "a@b.c", timestamp: 3, tzOffset: "+0000" },
        message: "Branch 2",
      });

      // Both branches should have baseCommit in their ancestry
      const ancestry1 = await toArray(store.commits.walkAncestry(branch1Commit));
      const ancestry2 = await toArray(store.commits.walkAncestry(branch2Commit));

      expect(ancestry1).toContain(baseCommit);
      expect(ancestry2).toContain(baseCommit);
    });
  });

  // Step 3: Diff Commits
  describe("Step 3: Diff Commits", () => {
    it("should detect added files", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      const head1 = await store.refs.resolve("HEAD");
      const commit1Id = head1?.objectId ?? "";

      await addFile(store, "new-file.txt", "new content");
      await store.staging.write();
      const commit2 = await git.commit().setMessage("Add file").call();
      const commit2Id = await store.commits.store(commit2);

      const diff = await git.diff().setOldTree(commit1Id).setNewTree(commit2Id).call();

      const added = diff.find((d) => d.changeType === ChangeType.ADD);
      expect(added).toBeDefined();
      expect(added?.newPath).toBe("new-file.txt");
    });

    it("should detect modified files", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      await addFile(store, "file.txt", "original content");
      await store.staging.write();
      const commit1 = await git.commit().setMessage("Add file").call();
      const commit1Id = await store.commits.store(commit1);

      await addFile(store, "file.txt", "modified content");
      await store.staging.write();
      const commit2 = await git.commit().setMessage("Modify file").call();
      const commit2Id = await store.commits.store(commit2);

      const diff = await git.diff().setOldTree(commit1Id).setNewTree(commit2Id).call();

      const modified = diff.find((d) => d.changeType === ChangeType.MODIFY);
      expect(modified).toBeDefined();
      expect(modified?.newPath).toBe("file.txt");
    });

    it("should detect deleted files", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      await addFile(store, "file1.txt", "content1");
      await addFile(store, "file2.txt", "content2");
      await store.staging.write();
      const commit1 = await git.commit().setMessage("Add files").call();
      const commit1Id = await store.commits.store(commit1);

      // Remove file2 by rebuilding staging without it
      const builder = store.staging.createBuilder();
      for await (const entry of store.staging.entries()) {
        if (entry.path !== "file2.txt") {
          builder.add(entry);
        }
      }
      await builder.finish();
      await store.staging.write();
      const commit2 = await git.commit().setMessage("Delete file").call();
      const commit2Id = await store.commits.store(commit2);

      const diff = await git.diff().setOldTree(commit1Id).setNewTree(commit2Id).call();

      const deleted = diff.find((d) => d.changeType === ChangeType.DELETE);
      expect(deleted).toBeDefined();
      expect(deleted?.oldPath).toBe("file2.txt");
    });

    it("should compare trees across multiple commits", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      const head0 = await store.refs.resolve("HEAD");
      const commit0Id = head0?.objectId ?? "";

      await addFile(store, "file1.txt", "content1");
      await store.staging.write();
      await git.commit().setMessage("Add file1").call();

      await addFile(store, "file2.txt", "content2");
      await store.staging.write();
      const commit2 = await git.commit().setMessage("Add file2").call();
      const commit2Id = await store.commits.store(commit2);

      // Compare initial (empty) to final (2 files)
      const diff = await git.diff().setOldTree(commit0Id).setNewTree(commit2Id).call();

      expect(diff.length).toBe(2);
      expect(diff.every((d) => d.changeType === ChangeType.ADD)).toBe(true);
    });
  });

  // Step 4: Blame
  describe("Step 4: Blame", () => {
    it("should attribute lines to commits", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // Create file with initial content
      await addFile(store, "src/config.ts", "// Line 1\n// Line 2\n// Line 3\n");
      await store.staging.write();
      await git.commit().setMessage("Initial config").call();

      // Run blame
      const blameResult = await git.blame().setFilePath("src/config.ts").call();

      expect(blameResult.path).toBe("src/config.ts");
      expect(blameResult.lineCount).toBeGreaterThanOrEqual(3); // 3 content lines
      expect(blameResult.entries.length).toBeGreaterThan(0);
    });

    it("should track line changes across commits", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // First commit
      await addFile(store, "file.txt", "Line A\nLine B\n");
      await store.staging.write();
      await git.commit().setMessage("Add file").call();

      // Second commit - add a line
      await addFile(store, "file.txt", "Line A\nLine B\nLine C\n");
      await store.staging.write();
      await git.commit().setMessage("Add Line C").call();

      const blameResult = await git.blame().setFilePath("file.txt").call();

      expect(blameResult.entries.length).toBeGreaterThanOrEqual(1);
    });
  });

  // Step 5: File History
  describe("Step 5: File History", () => {
    it("should track changes to a specific file", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // Create and modify a file across commits
      await addFile(store, "tracked.txt", "v1");
      await store.staging.write();
      await git.commit().setMessage("Add tracked file v1").call();

      await addFile(store, "other.txt", "other");
      await store.staging.write();
      await git.commit().setMessage("Add other file").call();

      await addFile(store, "tracked.txt", "v2");
      await store.staging.write();
      await git.commit().setMessage("Update tracked file to v2").call();

      // Get all commits
      const commits = await toArray(await git.log().call());

      // Filter commits that touched tracked.txt by comparing trees
      const touchedTrackedFile: string[] = [];
      for (let i = 0; i < commits.length - 1; i++) {
        const commitId = await store.commits.store(commits[i]);
        const parentId = await store.commits.store(commits[i + 1]);

        const diff = await git.diff().setOldTree(parentId).setNewTree(commitId).call();

        if (diff.some((d) => d.oldPath === "tracked.txt" || d.newPath === "tracked.txt")) {
          touchedTrackedFile.push(commits[i].message);
        }
      }

      expect(touchedTrackedFile).toContain("Update tracked file to v2");
      expect(touchedTrackedFile).toContain("Add tracked file v1");
      expect(touchedTrackedFile).not.toContain("Add other file");
    });
  });
});
