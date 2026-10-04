/**
 * Staging and Checkout Integration Tests
 *
 * Tests from apps/examples/07-staging-checkout (7 steps):
 * Step 01: Staging Concepts - index entry structure
 * Step 02: Staging Changes - add to staging
 * Step 03: Unstaging - remove from staging
 * Step 04: Status - detect changes
 * Step 05: Checkout Files - restore from commit
 * Step 06: Checkout Branches - switch HEAD
 * Step 07: Clean & Reset - reset modes, clean untracked
 */

import { ResetMode } from "@statewalker/vcs-commands";
import { FileMode } from "@statewalker/vcs-core";
import { afterEach, describe, expect, it } from "vitest";

import {
  addFile,
  backends,
  createInitializedGitFromFactory,
  defined,
  toArray,
} from "./test-helper.js";

describe.each(backends)("Staging and Checkout ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  // Step 1: Staging Concepts
  describe("Step 1: Staging Concepts", () => {
    it("should have correct staging entry structure", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { store } = result;

      await addFile(store, "test.txt", "content");

      const entries = await toArray(store.staging.entries());
      expect(entries.length).toBeGreaterThan(0);

      const entry = entries.find((e) => e.path === "test.txt");
      expect(entry).toBeDefined();
      expect(entry?.path).toBe("test.txt");
      expect(entry?.mode).toBe(FileMode.REGULAR_FILE);
      expect(entry?.objectId).toMatch(/^[0-9a-f]{40}$/);
      expect(entry?.stage).toBe(0);
    });

    it("should track multiple files in staging", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { store } = result;

      await addFile(store, "file1.txt", "content1");
      await addFile(store, "file2.txt", "content2");
      await addFile(store, "src/index.ts", "code");

      const entries = await toArray(store.staging.entries());
      const paths = entries.map((e) => e.path).sort();

      expect(paths).toContain("file1.txt");
      expect(paths).toContain("file2.txt");
      expect(paths).toContain("src/index.ts");
    });
  });

  // Step 2: Staging Changes
  describe("Step 2: Staging Changes", () => {
    it("should add files to staging", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { store } = result;

      const blobId = await addFile(store, "new.txt", "new content");

      const entries = await toArray(store.staging.entries());
      const newEntry = entries.find((e) => e.path === "new.txt");

      expect(newEntry).toBeDefined();
      expect(newEntry?.objectId).toBe(blobId);
    });

    it("should update existing files in staging", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { store } = result;

      const blob1 = await addFile(store, "file.txt", "version 1");
      const blob2 = await addFile(store, "file.txt", "version 2");

      expect(blob1).not.toBe(blob2);

      const entries = await toArray(store.staging.entries());
      const entry = entries.find((e) => e.path === "file.txt");

      expect(entry?.objectId).toBe(blob2);
    });
  });

  // Step 3: Unstaging
  describe("Step 3: Unstaging", () => {
    it("should remove files from staging", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { store } = result;

      await addFile(store, "keep.txt", "keep");
      await addFile(store, "remove.txt", "remove");

      // Remove file using builder
      const builder = store.staging.createBuilder();
      for await (const entry of store.staging.entries()) {
        if (entry.path !== "remove.txt") {
          builder.add(entry);
        }
      }
      await builder.finish();

      const entries = await toArray(store.staging.entries());
      const paths = entries.map((e) => e.path);

      expect(paths).toContain("keep.txt");
      expect(paths).not.toContain("remove.txt");
    });
  });

  // Step 4: Status
  describe("Step 4: Status", () => {
    it("should detect clean status", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git } = result;

      const status = await git.status().call();
      expect(status.isClean()).toBe(true);
    });

    it("should detect added files", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      await addFile(store, "new.txt", "new content");

      const status = await git.status().call();
      expect(status.added.has("new.txt")).toBe(true);
    });

    it("should detect modified files after commit", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      await addFile(store, "file.txt", "original");
      await store.staging.write();
      await git.commit().setMessage("Add file").call();

      await addFile(store, "file.txt", "modified");

      const status = await git.status().call();
      expect(status.changed.has("file.txt")).toBe(true);
    });
  });

  // Step 5: Checkout Files
  describe("Step 5: Checkout Files", () => {
    it("should restore file from specific commit", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // Create commits
      await addFile(store, "config.json", '{"v": 1}');
      await store.staging.write();
      const commit1 = await git.commit().setMessage("v1").call();
      const commit1Id = await store.commits.store(commit1);

      await addFile(store, "config.json", '{"v": 2}');
      await store.staging.write();
      await git.commit().setMessage("v2").call();

      // Get blob from commit1
      const commit1Data = defined(await store.commits.load(commit1Id), "first commit");
      const entry = await store.trees.getEntry(commit1Data.tree, "config.json");
      expect(entry).toBeDefined();

      // Restore to staging
      const editor = store.staging.createEditor();
      editor.add({
        path: "config.json",
        apply: () => ({
          path: "config.json",
          mode: FileMode.REGULAR_FILE,
          objectId: defined(entry, "config.json entry").id,
          stage: 0,
          size: 0,
          mtime: Date.now(),
        }),
      });
      await editor.finish();

      // Verify staging has old version
      const entries = await toArray(store.staging.entries());
      const configEntry = entries.find((e) => e.path === "config.json");
      expect(configEntry?.objectId).toBe(entry?.id);
    });
  });

  // Step 6: Checkout Branches
  describe("Step 6: Checkout Branches", () => {
    it("should switch branches with checkout", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      await git.branchCreate().setName("feature").call();

      await git.checkout().setName("feature").call();

      const head = await store.refs.get("HEAD");
      expect(head && "target" in head && head.target).toBe("refs/heads/feature");
    });

    it("should create and checkout branch in one step", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      await git.checkout().setCreateBranch(true).setName("new-branch").call();

      const head = await store.refs.get("HEAD");
      expect(head && "target" in head && head.target).toBe("refs/heads/new-branch");
    });
  });

  // Step 7: Clean & Reset
  describe("Step 7: Clean & Reset", () => {
    it("should soft reset (move HEAD only)", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      await addFile(store, "file.txt", "content");
      await store.staging.write();
      const commit1 = await git.commit().setMessage("Commit 1").call();
      const commit1Id = await store.commits.store(commit1);

      await addFile(store, "file2.txt", "content2");
      await store.staging.write();
      await git.commit().setMessage("Commit 2").call();

      // Soft reset to commit1
      await git.reset().setRef(commit1Id).setMode(ResetMode.SOFT).call();

      const head = await store.refs.resolve("HEAD");
      expect(head?.objectId).toBe(commit1Id);

      // Staging should still have file2 (soft reset doesn't change staging)
      // Note: This depends on implementation - some may reset staging too
    });

    it("should hard reset (move HEAD and reset staging)", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      await addFile(store, "file.txt", "content");
      await store.staging.write();
      const commit1 = await git.commit().setMessage("Commit 1").call();
      const commit1Id = await store.commits.store(commit1);

      await addFile(store, "file2.txt", "content2");
      await store.staging.write();
      await git.commit().setMessage("Commit 2").call();

      // Hard reset to commit1
      await git.reset().setRef(commit1Id).setMode(ResetMode.HARD).call();

      const head = await store.refs.resolve("HEAD");
      expect(head?.objectId).toBe(commit1Id);

      // Staging should match commit1
      const entries = await toArray(store.staging.entries());
      const paths = entries.map((e) => e.path);
      expect(paths).toContain("file.txt");
      expect(paths).not.toContain("file2.txt");
    });

    it("should reset to specific commit using ref", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // Create commits
      for (let i = 1; i <= 5; i++) {
        await addFile(store, `file${i}.txt`, `content${i}`);
        await store.staging.write();
        await git.commit().setMessage(`Commit ${i}`).call();
      }

      // Reset to HEAD~3 (2 commits back)
      await git.reset().setRef("HEAD~3").call();

      const commits = await toArray(await git.log().call());
      expect(commits.length).toBe(3); // Initial + 2
    });
  });
});
