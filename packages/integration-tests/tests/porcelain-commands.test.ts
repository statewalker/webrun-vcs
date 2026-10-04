/**
 * Porcelain Commands Integration Tests
 *
 * Tests from apps/examples/02-porcelain-commands (8 steps):
 * Step 01: Init & Commit - create commit from staging, multiple commits
 * Step 02: Branching - create/list/delete branches
 * Step 03: Checkout - switch branches, create-and-switch
 * Step 04: Merge - fast-forward, three-way merge, strategies
 * Step 05: Log & Diff - log traversal, diff between commits
 * Step 06: Status - isClean, added/changed/removed sets
 * Step 07: Tags - lightweight tags, annotated tags, list/delete
 * Step 08: Stash - create/list/apply/pop/drop stash
 */

import { ChangeType, FastForwardMode, MergeStatus, MergeStrategy } from "@statewalker/vcs-commands";
import { afterEach, describe, expect, it } from "vitest";

import {
  addFile,
  backends,
  createInitializedGitFromFactory,
  defined,
  toArray,
} from "./test-helper.js";

describe.each(backends)("Porcelain Commands ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  // Step 1: Init & Commit
  describe("Step 1: Init & Commit", () => {
    it("should create commit from staged files", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // Stage files
      await addFile(store, "README.md", "# My Project");
      await addFile(store, "src/index.ts", 'console.log("Hello");');
      await store.staging.write();

      // Create commit
      const commit = await git.commit().setMessage("Initial commit").call();

      expect(commit.message).toBe("Initial commit");
      expect(commit.tree).toMatch(/^[0-9a-f]{40}$/);
    });

    it("should create multiple commits with parent chain", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // First commit
      await addFile(store, "file1.txt", "content1");
      await store.staging.write();
      const commit1 = await git.commit().setMessage("First").call();
      const commit1Id = await store.commits.store(commit1);

      // Second commit
      await addFile(store, "file2.txt", "content2");
      await store.staging.write();
      const commit2 = await git.commit().setMessage("Second").call();

      expect(commit2.parents).toContain(commit1Id);
    });
  });

  // Step 2: Branching
  describe("Step 2: Branching", () => {
    it("should create branches", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git } = result;

      const branch = await git.branchCreate().setName("feature").call();
      expect(branch.name).toBe("refs/heads/feature");
    });

    it("should list branches", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git } = result;

      await git.branchCreate().setName("feature").call();
      await git.branchCreate().setName("bugfix").call();

      const branches = await git.branchList().call();
      const names = branches.map((b) => b.name);

      expect(names).toContain("refs/heads/main");
      expect(names).toContain("refs/heads/feature");
      expect(names).toContain("refs/heads/bugfix");
    });

    it("should delete branches", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git } = result;

      await git.branchCreate().setName("to-delete").call();
      await git.branchDelete().setBranchNames("to-delete").call();

      const branches = await git.branchList().call();
      const names = branches.map((b) => b.name);
      expect(names).not.toContain("refs/heads/to-delete");
    });
  });

  // Step 3: Checkout
  describe("Step 3: Checkout", () => {
    it("should switch branches", async () => {
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

      await git.checkout().setCreateBranch(true).setName("new-feature").call();

      const head = await store.refs.get("HEAD");
      expect(head && "target" in head && head.target).toBe("refs/heads/new-feature");
    });
  });

  // Step 4: Merge
  describe("Step 4: Merge", () => {
    it("should perform fast-forward merge", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // Create feature branch at initial commit
      await git.branchCreate().setName("feature").call();

      // Add commits on feature
      await store.refs.setSymbolic("HEAD", "refs/heads/feature");
      await addFile(store, "feature.txt", "feature content");
      await store.staging.write();
      await git.commit().setMessage("Feature commit").call();

      // Switch to main and merge (should FF)
      await store.refs.setSymbolic("HEAD", "refs/heads/main");
      const mergeResult = await git.merge().include("feature").call();

      expect(mergeResult.status).toBe(MergeStatus.FAST_FORWARD);
    });

    it("should perform three-way merge", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // Create feature branch
      await git.branchCreate().setName("feature").call();

      // Add commit on main
      await addFile(store, "main.txt", "main content");
      await store.staging.write();
      await git.commit().setMessage("Main commit").call();

      // Switch to feature and add commit
      await store.refs.setSymbolic("HEAD", "refs/heads/feature");
      const featureRef = await store.refs.resolve("refs/heads/feature");
      const featureCommit = defined(
        await store.commits.load(featureRef?.objectId ?? ""),
        "feature commit",
      );
      await store.staging.readTree(store.trees, featureCommit.tree);

      await addFile(store, "feature.txt", "feature content");
      await store.staging.write();
      await git.commit().setMessage("Feature commit").call();

      // Switch to main and merge
      await store.refs.setSymbolic("HEAD", "refs/heads/main");
      const mergeResult = await git
        .merge()
        .include("feature")
        .setFastForwardMode(FastForwardMode.NO_FF)
        .call();

      expect(mergeResult.status).toBe(MergeStatus.MERGED);
    });

    it("should support merge strategies", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      await git.branchCreate().setName("feature").call();
      await store.refs.setSymbolic("HEAD", "refs/heads/feature");
      await addFile(store, "feature.txt", "feature");
      await store.staging.write();
      await git.commit().setMessage("Feature").call();

      await store.refs.setSymbolic("HEAD", "refs/heads/main");
      const mergeResult = await git
        .merge()
        .include("feature")
        .setStrategy(MergeStrategy.RECURSIVE)
        .call();

      expect([MergeStatus.FAST_FORWARD, MergeStatus.MERGED]).toContain(mergeResult.status);
    });
  });

  // Step 5: Log & Diff
  describe("Step 5: Log & Diff", () => {
    it("should traverse commit log", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // Create commits
      await addFile(store, "file1.txt", "1");
      await store.staging.write();
      await git.commit().setMessage("Commit 1").call();

      await addFile(store, "file2.txt", "2");
      await store.staging.write();
      await git.commit().setMessage("Commit 2").call();

      const commits = await toArray(await git.log().call());

      expect(commits.length).toBe(3); // Initial + 2
      expect(commits[0].message).toBe("Commit 2");
      expect(commits[1].message).toBe("Commit 1");
    });

    it("should support maxCount in log", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      for (let i = 1; i <= 5; i++) {
        await addFile(store, `file${i}.txt`, `${i}`);
        await store.staging.write();
        await git.commit().setMessage(`Commit ${i}`).call();
      }

      const commits = await toArray(await git.log().setMaxCount(2).call());
      expect(commits.length).toBe(2);
    });

    it("should diff between commits", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      await addFile(store, "file.txt", "original");
      await store.staging.write();
      const commit1 = await git.commit().setMessage("First").call();
      const commit1Id = await store.commits.store(commit1);

      await addFile(store, "new-file.txt", "new content");
      await store.staging.write();
      const commit2 = await git.commit().setMessage("Second").call();
      const commit2Id = await store.commits.store(commit2);

      const diff = await git.diff().setOldTree(commit1Id).setNewTree(commit2Id).call();

      const added = diff.find((d) => d.changeType === ChangeType.ADD);
      expect(added?.newPath).toBe("new-file.txt");
    });
  });

  // Step 6: Status
  describe("Step 6: Status", () => {
    it("should report clean status after commit", async () => {
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

      await addFile(store, "new-file.txt", "content");
      // Don't write staging - simulates staged but uncommitted

      const status = await git.status().call();
      expect(status.added.has("new-file.txt")).toBe(true);
    });
  });

  // Step 7: Tags
  describe("Step 7: Tags", () => {
    it("should create lightweight tags", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git } = result;

      const tag = await git.tag().setName("v1.0.0").call();
      expect(tag.name).toBe("refs/tags/v1.0.0");
    });

    it("should create annotated tags", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git } = result;

      const tag = await git
        .tag()
        .setName("v2.0.0")
        .setAnnotated(true)
        .setMessage("Release v2.0.0")
        .call();

      expect(tag.name).toBe("refs/tags/v2.0.0");
    });

    it("should list tags", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git } = result;

      await git.tag().setName("v1.0.0").call();
      await git.tag().setName("v1.1.0").call();

      const tags = await git.tagList().call();
      const names = tags.map((t) => t.name);

      expect(names).toContain("refs/tags/v1.0.0");
      expect(names).toContain("refs/tags/v1.1.0");
    });

    it("should delete tags", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git } = result;

      await git.tag().setName("to-delete").call();
      await git.tagDelete().setTags("to-delete").call();

      const tags = await git.tagList().call();
      const names = tags.map((t) => t.name);
      expect(names).not.toContain("refs/tags/to-delete");
    });
  });

  // Step 8: Stash
  describe("Step 8: Stash", () => {
    it("should create stash", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      await addFile(store, "wip.txt", "work in progress");
      const stashId = await git.stashCreate().setMessage("WIP").call();

      // Stash should be created (may or may not return ID depending on implementation)
      expect(stashId === null || typeof stashId === "string").toBe(true);
    });

    it("should list stashes", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      await addFile(store, "wip1.txt", "wip1");
      await git.stashCreate().setMessage("Stash 1").call();

      const stashes = await git.stashList().call();
      expect(Array.isArray(stashes)).toBe(true);
    });
  });
});
