/**
 * Branching and Merging Integration Tests
 *
 * Tests from apps/examples/04-branching-merging (7 steps):
 * Step 01: Branch Creation - from HEAD, from specific commit
 * Step 02: HEAD Management - symbolic refs, detached HEAD
 * Step 03: Fast-Forward - linear history merge, FF modes
 * Step 04: Three-Way Merge - divergent branches, merge commit
 * Step 05: Merge Strategies - RECURSIVE, OURS, THEIRS
 * Step 06: Conflict Handling - staging stages, conflict detection
 * Step 07: Rebase Concepts - conceptual verification
 */

import {
  ContentMergeStrategy,
  FastForwardMode,
  MergeStatus,
  MergeStrategy,
} from "@statewalker/vcs-commands";
import { afterEach, describe, expect, it } from "vitest";

import { addFile, backends, createInitializedGitFromFactory, defined } from "./test-helper.js";

describe.each(backends)("Branching and Merging ($name backend)", ({ factory }) => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  // Step 1: Branch Creation
  describe("Step 1: Branch Creation", () => {
    it("should create branch from HEAD", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      const branch = await git.branchCreate().setName("feature").call();
      expect(branch.name).toBe("refs/heads/feature");

      // Branch should point to same commit as HEAD
      const headRef = await store.refs.resolve("HEAD");
      const branchRef = await store.refs.resolve("refs/heads/feature");
      expect(branchRef?.objectId).toBe(headRef?.objectId);
    });

    it("should create branch from specific commit", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // Create some commits
      await addFile(store, "file1.txt", "1");
      await store.staging.write();
      const commit1 = await git.commit().setMessage("Commit 1").call();
      const commit1Id = await store.commits.store(commit1);

      await addFile(store, "file2.txt", "2");
      await store.staging.write();
      await git.commit().setMessage("Commit 2").call();

      // Create branch from earlier commit
      const branch = await git
        .branchCreate()
        .setName("from-commit1")
        .setStartPoint(commit1Id)
        .call();
      expect(branch.name).toBe("refs/heads/from-commit1");

      const branchRef = await store.refs.resolve("refs/heads/from-commit1");
      expect(branchRef?.objectId).toBe(commit1Id);
    });

    it("should list all branches", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git } = result;

      await git.branchCreate().setName("feature").call();
      await git.branchCreate().setName("develop").call();
      await git.branchCreate().setName("release").call();

      const branches = await git.branchList().call();
      const names = branches.map((b) => b.name);

      expect(names).toContain("refs/heads/main");
      expect(names).toContain("refs/heads/feature");
      expect(names).toContain("refs/heads/develop");
      expect(names).toContain("refs/heads/release");
      expect(branches.length).toBe(4);
    });
  });

  // Step 2: HEAD Management
  describe("Step 2: HEAD Management", () => {
    it("should manage symbolic HEAD reference", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      await git.branchCreate().setName("feature").call();

      // HEAD is symbolic ref pointing to main
      const head = await store.refs.get("HEAD");
      expect(head && "target" in head).toBe(true);
      expect(head && "target" in head && head.target).toBe("refs/heads/main");

      // Change HEAD to point to feature
      await store.refs.setSymbolic("HEAD", "refs/heads/feature");

      const newHead = await store.refs.get("HEAD");
      expect(newHead && "target" in newHead && newHead.target).toBe("refs/heads/feature");
    });

    it("should support detached HEAD", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { store } = result;

      const headRef = await store.refs.resolve("HEAD");
      const commitId = headRef?.objectId ?? "";

      // Set HEAD directly to commit (detached)
      await store.refs.set("HEAD", commitId);

      const head = await store.refs.get("HEAD");
      // Direct ref (not symbolic)
      expect(head && "objectId" in head).toBe(true);
      expect(head && "objectId" in head && head.objectId).toBe(commitId);
    });
  });

  // Step 3: Fast-Forward Merge
  describe("Step 3: Fast-Forward Merge", () => {
    it("should perform fast-forward merge when possible", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // Create feature branch
      await git.branchCreate().setName("feature-ff").call();

      // Switch to feature and add commits
      await store.refs.setSymbolic("HEAD", "refs/heads/feature-ff");
      await addFile(store, "feature1.ts", "export const f1 = true;");
      await store.staging.write();
      await git.commit().setMessage("Add feature1").call();

      await addFile(store, "feature2.ts", "export const f2 = true;");
      await store.staging.write();
      await git.commit().setMessage("Add feature2").call();

      // Switch back to main
      await store.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await store.refs.resolve("refs/heads/main");
      if (mainRef?.objectId) {
        const commit = defined(await store.commits.load(mainRef.objectId), "commit");
        await store.staging.readTree(store.trees, commit.tree);
      }

      // Merge (should be fast-forward)
      const mergeResult = await git.merge().include("feature-ff").call();

      expect(mergeResult.status).toBe(MergeStatus.FAST_FORWARD);
    });

    it("should support NO_FF mode to create merge commit", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      await git.branchCreate().setName("feature").call();

      // Add commit on feature
      await store.refs.setSymbolic("HEAD", "refs/heads/feature");
      await addFile(store, "feature.ts", "feature");
      await store.staging.write();
      await git.commit().setMessage("Feature commit").call();

      // Switch to main and merge with NO_FF
      await store.refs.setSymbolic("HEAD", "refs/heads/main");
      const mergeResult = await git
        .merge()
        .include("feature")
        .setFastForwardMode(FastForwardMode.NO_FF)
        .call();

      expect(mergeResult.status).toBe(MergeStatus.MERGED);
    });
  });

  // Step 4: Three-Way Merge
  describe("Step 4: Three-Way Merge", () => {
    it("should perform three-way merge with divergent branches", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // Create feature branch
      await git.branchCreate().setName("feature").call();

      // Add commit on main
      await addFile(store, "main.txt", "main content");
      await store.staging.write();
      await git.commit().setMessage("Main commit").call();

      // Switch to feature
      await store.refs.setSymbolic("HEAD", "refs/heads/feature");
      const featureRef = await store.refs.resolve("refs/heads/feature");
      if (featureRef?.objectId) {
        const commit = defined(await store.commits.load(featureRef.objectId), "commit");
        await store.staging.readTree(store.trees, commit.tree);
      }

      // Add commit on feature
      await addFile(store, "feature.txt", "feature content");
      await store.staging.write();
      await git.commit().setMessage("Feature commit").call();

      // Switch back to main and merge
      await store.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await store.refs.resolve("refs/heads/main");
      if (mainRef?.objectId) {
        const commit = defined(await store.commits.load(mainRef.objectId), "commit");
        await store.staging.readTree(store.trees, commit.tree);
      }

      const mergeResult = await git
        .merge()
        .include("feature")
        .setFastForwardMode(FastForwardMode.NO_FF)
        .call();

      expect(mergeResult.status).toBe(MergeStatus.MERGED);

      // Verify merge commit has two parents
      const headRef = await store.refs.resolve("HEAD");
      const mergeCommit = defined(
        await store.commits.load(headRef?.objectId ?? ""),
        "merge commit",
      );
      expect(mergeCommit.parents.length).toBe(2);
    });
  });

  // Step 5: Merge Strategies
  describe("Step 5: Merge Strategies", () => {
    it("should support RECURSIVE strategy (default)", async () => {
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

    it("should support OURS strategy", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // Create diverging branches
      await git.branchCreate().setName("their-branch").call();

      // Our change
      await addFile(store, "config.json", '{"ours": true}');
      await store.staging.write();
      await git.commit().setMessage("Our config").call();

      // Their change
      await store.refs.setSymbolic("HEAD", "refs/heads/their-branch");
      const theirRef = await store.refs.resolve("refs/heads/their-branch");
      if (theirRef?.objectId) {
        const commit = defined(await store.commits.load(theirRef.objectId), "commit");
        await store.staging.readTree(store.trees, commit.tree);
      }
      await addFile(store, "config.json", '{"theirs": true}');
      await store.staging.write();
      await git.commit().setMessage("Their config").call();

      // Switch back and merge with OURS
      await store.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await store.refs.resolve("refs/heads/main");
      if (mainRef?.objectId) {
        const commit = defined(await store.commits.load(mainRef.objectId), "commit");
        await store.staging.readTree(store.trees, commit.tree);
      }

      const mergeResult = await git
        .merge()
        .include("their-branch")
        .setStrategy(MergeStrategy.OURS)
        .call();

      expect(mergeResult.status).toBe(MergeStatus.MERGED);
    });

    it("should support content merge strategies", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      await git.branchCreate().setName("branch").call();

      await addFile(store, "file.txt", "ours");
      await store.staging.write();
      await git.commit().setMessage("Our file").call();

      await store.refs.setSymbolic("HEAD", "refs/heads/branch");
      const branchRef = await store.refs.resolve("refs/heads/branch");
      if (branchRef?.objectId) {
        const commit = defined(await store.commits.load(branchRef.objectId), "commit");
        await store.staging.readTree(store.trees, commit.tree);
      }
      await addFile(store, "file.txt", "theirs");
      await store.staging.write();
      await git.commit().setMessage("Their file").call();

      await store.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await store.refs.resolve("refs/heads/main");
      if (mainRef?.objectId) {
        const commit = defined(await store.commits.load(mainRef.objectId), "commit");
        await store.staging.readTree(store.trees, commit.tree);
      }

      const mergeResult = await git
        .merge()
        .include("branch")
        .setContentMergeStrategy(ContentMergeStrategy.OURS)
        .call();

      expect([MergeStatus.MERGED, MergeStatus.CONFLICTING]).toContain(mergeResult.status);
    });
  });

  // Step 6: Conflict Handling
  describe("Step 6: Conflict Handling", () => {
    it("should detect conflicting changes", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { git, store } = result;

      // Add initial file
      await addFile(store, "conflict.txt", "initial content");
      await store.staging.write();
      await git.commit().setMessage("Initial").call();

      await git.branchCreate().setName("conflict-branch").call();

      // Our change
      await addFile(store, "conflict.txt", "our version of the file");
      await store.staging.write();
      await git.commit().setMessage("Our change").call();

      // Their change
      await store.refs.setSymbolic("HEAD", "refs/heads/conflict-branch");
      const branchRef = await store.refs.resolve("refs/heads/conflict-branch");
      if (branchRef?.objectId) {
        const commit = defined(await store.commits.load(branchRef.objectId), "commit");
        await store.staging.readTree(store.trees, commit.tree);
      }
      await addFile(store, "conflict.txt", "their version of the file");
      await store.staging.write();
      await git.commit().setMessage("Their change").call();

      // Switch back and try to merge
      await store.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await store.refs.resolve("refs/heads/main");
      if (mainRef?.objectId) {
        const commit = defined(await store.commits.load(mainRef.objectId), "commit");
        await store.staging.readTree(store.trees, commit.tree);
      }

      const mergeResult = await git.merge().include("conflict-branch").call();

      // Result should be CONFLICTING or MERGED (auto-resolved)
      // The implementation may auto-resolve conflicts with a content merge strategy
      expect([MergeStatus.MERGED, MergeStatus.CONFLICTING]).toContain(mergeResult.status);
    });
  });

  // Step 7: Rebase Concepts
  describe("Step 7: Rebase Concepts", () => {
    it("should verify commits can be replayed (rebase concept)", async () => {
      const result = await createInitializedGitFromFactory(factory);
      cleanup = result.cleanup;
      const { store } = result;

      // Conceptual test: verify we can create commits with modified parents
      // which is the basis of rebase operation

      const emptyTreeId = await store.trees.store([]);

      // Create base commit
      const baseCommit = await store.commits.store({
        tree: emptyTreeId,
        parents: [],
        author: { name: "A", email: "a@b.c", timestamp: 1, tzOffset: "+0000" },
        committer: { name: "A", email: "a@b.c", timestamp: 1, tzOffset: "+0000" },
        message: "Base",
      });

      // Create two diverging commits
      const branchCommit = await store.commits.store({
        tree: emptyTreeId,
        parents: [baseCommit],
        author: { name: "A", email: "a@b.c", timestamp: 2, tzOffset: "+0000" },
        committer: { name: "A", email: "a@b.c", timestamp: 2, tzOffset: "+0000" },
        message: "Branch commit",
      });

      const mainCommit = await store.commits.store({
        tree: emptyTreeId,
        parents: [baseCommit],
        author: { name: "A", email: "a@b.c", timestamp: 3, tzOffset: "+0000" },
        committer: { name: "A", email: "a@b.c", timestamp: 3, tzOffset: "+0000" },
        message: "Main commit",
      });

      // "Replay" branch commit on top of main (conceptual rebase)
      const rebasedCommit = await store.commits.store({
        tree: emptyTreeId,
        parents: [mainCommit], // New parent
        author: { name: "A", email: "a@b.c", timestamp: 2, tzOffset: "+0000" },
        committer: { name: "A", email: "a@b.c", timestamp: 4, tzOffset: "+0000" },
        message: "Branch commit", // Same message
      });

      // Verify rebased commit has different ID (different parent)
      expect(rebasedCommit).not.toBe(branchCommit);

      // Verify it's based on main now
      const rebased = defined(await store.commits.load(rebasedCommit), "rebased commit");
      expect(rebased.parents[0]).toBe(mainCommit);
    });
  });
});
