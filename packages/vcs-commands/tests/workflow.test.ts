/**
 * Integration tests for Phase 1 and Phase 2 workflows
 *
 * Phase 1: commit → log → branch → reset
 * Phase 2: merge → diff
 * Tests run against all storage backends (Memory, SQL).
 */

import { afterEach, describe, expect, it } from "vitest";

import { ChangeType, FastForwardMode, MergeStatus, ResetMode } from "../src/index.js";
import { addFile, backends, createInitializedGitFromFactory, toArray } from "./test-helper.js";

describe.each(backends)("Phase 1 Integration Workflow ($name backend)", ({ factory }) => {
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
  it("should support complete workflow: commit → log → branch → reset", async () => {
    const { git, repository } = await createInitializedGit();

    // === STEP 1: Create commits ===
    const _commit1 = await git
      .commit()
      .setMessage("Feature: Add user authentication")
      .setAuthor("Alice", "alice@example.com")
      .setAllowEmpty(true)
      .call();

    const _commit2 = await git
      .commit()
      .setMessage("Fix: Authentication bug")
      .setAuthor("Bob", "bob@example.com")
      .setAllowEmpty(true)
      .call();

    // === STEP 2: Verify log shows commits ===
    let commits = await toArray(await git.log().call());
    expect(commits.length).toBe(3); // Initial + 2 new commits
    expect(commits[0].message).toBe("Fix: Authentication bug");
    expect(commits[1].message).toBe("Feature: Add user authentication");
    expect(commits[2].message).toBe("Initial commit");

    // === STEP 3: Create branches ===
    const featureBranch = await git.branchCreate().setName("feature/new-api").call();

    expect(featureBranch.name).toBe("refs/heads/feature/new-api");

    // List branches
    const branches = await git.branchList().call();
    const branchNames = branches.map((b) => b.name);
    expect(branchNames).toContain("refs/heads/main");
    expect(branchNames).toContain("refs/heads/feature/new-api");

    // === STEP 4: Create tag ===
    const tag = await git.tag().setName("v1.0.0").setMessage("First stable release").call();

    expect(tag.name).toBe("refs/tags/v1.0.0");

    // List tags
    const tags = await git.tagList().call();
    expect(tags.length).toBe(1);
    expect(tags[0].name).toBe("refs/tags/v1.0.0");

    // === STEP 5: Soft reset ===
    // Remember current HEAD
    const headBefore = await repository.refs.resolve("HEAD");

    // Soft reset to previous commit
    await git.reset().setRef("HEAD~1").setMode(ResetMode.SOFT).call();

    // Verify HEAD moved
    const headAfter = await repository.refs.resolve("HEAD");
    expect(headAfter?.objectId).not.toBe(headBefore?.objectId);

    // Log should now show 2 commits
    commits = await toArray(await git.log().call());
    expect(commits.length).toBe(2);
    expect(commits[0].message).toBe("Feature: Add user authentication");

    // === STEP 6: Reset back to original ===
    // Reset to the tag (which still points to commit2)
    await git.reset().setRef("v1.0.0").call();

    // Log should show all 3 commits again
    commits = await toArray(await git.log().call());
    expect(commits.length).toBe(3);
  });

  it("should support branch switching simulation", async () => {
    const { git, repository } = await createInitializedGit();

    // Create commits on main
    await git.commit().setMessage("Main commit 1").setAllowEmpty(true).call();

    const mainCommit2 = await git.commit().setMessage("Main commit 2").setAllowEmpty(true).call();

    const _mainCommit2Id = await repository.commits.store(mainCommit2);

    // Create feature branch from commit 1
    await git.branchCreate().setName("feature").setStartPoint("HEAD~1").call();

    // Simulate checkout to feature branch
    await repository.refs.setSymbolic("HEAD", "refs/heads/feature");

    // Create commit on feature branch
    await git.commit().setMessage("Feature commit").setAllowEmpty(true).call();

    // Log on feature branch
    let commits = await toArray(await git.log().call());
    expect(commits.length).toBe(3);
    expect(commits[0].message).toBe("Feature commit");
    expect(commits[1].message).toBe("Main commit 1");

    // Switch back to main
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");

    // Log on main
    commits = await toArray(await git.log().call());
    expect(commits.length).toBe(3);
    expect(commits[0].message).toBe("Main commit 2");
  });

  it("should support tag workflow", async () => {
    const { git, repository } = await createInitializedGit();

    // Create release commits
    await git.commit().setMessage("Release 1.0.0").setAllowEmpty(true).call();

    const _release1 = await repository.refs.resolve("HEAD");

    await git.tag().setName("v1.0.0").call();

    await git.commit().setMessage("Release 1.0.1 - bugfix").setAllowEmpty(true).call();

    await git.tag().setName("v1.0.1").call();

    await git.commit().setMessage("Release 1.1.0 - new features").setAllowEmpty(true).call();

    await git
      .tag()
      .setName("v1.1.0")
      .setMessage("Major feature release")
      .setTagger("Release Manager", "release@example.com")
      .call();

    // List all tags
    const tags = await git.tagList().call();
    expect(tags.length).toBe(3);

    const tagNames = tags.map((t) => t.name);
    expect(tagNames).toEqual(["refs/tags/v1.0.0", "refs/tags/v1.0.1", "refs/tags/v1.1.0"]);

    // Reset to v1.0.0
    await git.reset().setRef("v1.0.0").call();

    // Log should show only commits up to v1.0.0
    const commits = await toArray(await git.log().call());
    expect(commits.length).toBe(2); // Initial + Release 1.0.0
    expect(commits[0].message).toBe("Release 1.0.0");
  });

  it("should support branch cleanup", async () => {
    const { git } = await createInitializedGit();

    // Create commit
    await git.commit().setMessage("Base commit").setAllowEmpty(true).call();

    // Create multiple feature branches
    await git.branchCreate().setName("feature-1").call();
    await git.branchCreate().setName("feature-2").call();
    await git.branchCreate().setName("feature-3").call();

    // List branches
    let branches = await git.branchList().call();
    expect(branches.length).toBe(4); // main + 3 features

    // Delete feature branches (they're merged since same commit)
    await git.branchDelete().setBranchNames("feature-1", "feature-2").call();

    // List remaining branches
    branches = await git.branchList().call();
    expect(branches.length).toBe(2); // main + feature-3

    // Rename remaining feature branch
    await git.branchRename().setOldName("feature-3").setNewName("develop").call();

    branches = await git.branchList().call();
    const branchNames = branches.map((b) => b.name);
    expect(branchNames).toContain("refs/heads/main");
    expect(branchNames).toContain("refs/heads/develop");
    expect(branchNames).not.toContain("refs/heads/feature-3");
  });

  it("should support log filtering by count", async () => {
    const { git } = await createInitializedGit();

    // Create 10 commits
    for (let i = 1; i <= 10; i++) {
      await git.commit().setMessage(`Commit ${i}`).setAllowEmpty(true).call();
    }

    // Get all commits
    let commits = await toArray(await git.log().call());
    expect(commits.length).toBe(11); // Initial + 10

    // Get last 5
    commits = await toArray(await git.log().setMaxCount(5).call());
    expect(commits.length).toBe(5);
    expect(commits[0].message).toBe("Commit 10");
    expect(commits[4].message).toBe("Commit 6");

    // Skip 3, get next 3
    commits = await toArray(await git.log().setSkip(3).setMaxCount(3).call());
    expect(commits.length).toBe(3);
    expect(commits[0].message).toBe("Commit 7");
    expect(commits[2].message).toBe("Commit 5");
  });
});

describe.each(backends)("Phase 2 Integration Workflow ($name backend)", ({ factory }) => {
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
  it("should support merge workflow: branch → commit → merge", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // === STEP 1: Create feature branch ===
    await git.branchCreate().setName("feature").call();

    // === STEP 2: Add commits on main ===
    await addFile(workingCopy, "main.txt", "main content");
    await workingCopy.checkout.staging.write();
    await git.commit().setMessage("Add main.txt").call();

    // === STEP 3: Switch to feature and add commits ===
    await repository.refs.setSymbolic("HEAD", "refs/heads/feature");

    await addFile(workingCopy, "feature.txt", "feature content");
    await workingCopy.checkout.staging.write();
    await git.commit().setMessage("Add feature.txt").call();

    // === STEP 4: Switch back to main ===
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");

    // === STEP 5: Merge feature into main ===
    const result = await git
      .merge()
      .include("refs/heads/feature")
      .setFastForwardMode(FastForwardMode.NO_FF)
      .call();

    expect(result.status).toBe(MergeStatus.MERGED);

    // === STEP 6: Verify merge commit has both parents ===
    const headRef = await repository.refs.resolve("HEAD");
    expect(headRef?.objectId).toBeDefined();
    const mergeCommit = await repository.commits.load(headRef?.objectId ?? "");
    expect(mergeCommit.parents.length).toBe(2);

    // === STEP 7: Log should show all commits ===
    const commits = await toArray(await git.log().call());
    expect(commits.length).toBeGreaterThanOrEqual(4); // initial + main + feature + merge
  });

  it("should support fast-forward merge workflow", async () => {
    const { git, repository } = await createInitializedGit();

    // Create feature branch at initial commit
    await git.branchCreate().setName("feature").call();

    // Add commits on main
    await git.commit().setMessage("Main commit 1").setAllowEmpty(true).call();
    await git.commit().setMessage("Main commit 2").setAllowEmpty(true).call();

    // Switch to feature
    await repository.refs.setSymbolic("HEAD", "refs/heads/feature");

    // Feature is behind main - merge main into feature (fast-forward)
    const result = await git.merge().include("refs/heads/main").call();

    expect(result.status).toBe(MergeStatus.FAST_FORWARD);

    // Feature branch should now be at same commit as main
    const featureRef = await repository.refs.resolve("refs/heads/feature");
    const mainRef = await repository.refs.resolve("refs/heads/main");
    expect(featureRef?.objectId).toBe(mainRef?.objectId);
  });

  it("should support diff workflow: compare branches", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create feature branch
    await git.branchCreate().setName("feature").call();

    // Add file on main
    await addFile(workingCopy, "main-only.txt", "main content");
    await workingCopy.checkout.staging.write();
    await git.commit().setMessage("Add main file").call();

    // Switch to feature - reset staging to match feature branch (initial empty tree)
    await repository.refs.setSymbolic("HEAD", "refs/heads/feature");
    const featureRef = await repository.refs.resolve("refs/heads/feature");
    const featureCommit = await repository.commits.load(featureRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, featureCommit.tree);

    // Add different file on feature
    await addFile(workingCopy, "feature-only.txt", "feature content");
    await workingCopy.checkout.staging.write();
    await git.commit().setMessage("Add feature file").call();

    // === Diff feature vs main ===
    const entries = await git
      .diff()
      .setOldTree("refs/heads/feature")
      .setNewTree("refs/heads/main")
      .call();

    // Should show: main-only.txt added, feature-only.txt deleted
    expect(entries.length).toBe(2);

    const added = entries.find((e) => e.changeType === ChangeType.ADD);
    const deleted = entries.find((e) => e.changeType === ChangeType.DELETE);

    expect(added?.newPath).toBe("main-only.txt");
    expect(deleted?.oldPath).toBe("feature-only.txt");
  });

  it("should support diff workflow: track changes across commits", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // Create file and commit
    await addFile(workingCopy, "changing.txt", "version 1");
    await workingCopy.checkout.staging.write();
    const commit1 = await git.commit().setMessage("v1").call();
    const commit1Id = await repository.commits.store(commit1);

    // Modify file
    await addFile(workingCopy, "changing.txt", "version 2");
    await workingCopy.checkout.staging.write();
    await git.commit().setMessage("v2").call();

    // Add new file
    await addFile(workingCopy, "new.txt", "new content");
    await workingCopy.checkout.staging.write();
    const commit3 = await git.commit().setMessage("v3").call();
    const commit3Id = await repository.commits.store(commit3);

    // === Diff v1 vs v3 ===
    const entries = await git.diff().setOldTree(commit1Id).setNewTree(commit3Id).call();

    expect(entries.length).toBe(2);

    const modified = entries.find((e) => e.changeType === ChangeType.MODIFY);
    const added = entries.find((e) => e.changeType === ChangeType.ADD);

    expect(modified?.newPath).toBe("changing.txt");
    expect(added?.newPath).toBe("new.txt");
  });

  it("should support complete workflow: branch → diff → merge → verify", async () => {
    const { git, workingCopy, repository } = await createInitializedGit();

    // === Setup: Create diverging branches ===

    // Add base file
    await addFile(workingCopy, "shared.txt", "base content");
    await workingCopy.checkout.staging.write();
    await git.commit().setMessage("Add shared file").call();

    // Create feature branch
    await git.branchCreate().setName("feature").call();

    // Add file on main
    await addFile(workingCopy, "main-feature.txt", "main feature");
    await workingCopy.checkout.staging.write();
    await git.commit().setMessage("Main feature").call();

    // Switch to feature branch - reset staging to match feature's tree
    await repository.refs.setSymbolic("HEAD", "refs/heads/feature");
    const featureRef = await repository.refs.resolve("refs/heads/feature");
    const featureCommit = await repository.commits.load(featureRef?.objectId ?? "");
    await workingCopy.checkout.staging.readTree(repository.trees, featureCommit.tree);

    // Add different file on feature
    await addFile(workingCopy, "feature-feature.txt", "feature work");
    await workingCopy.checkout.staging.write();
    await git.commit().setMessage("Feature work").call();

    // === Diff: See what's different ===
    const diffBeforeMerge = await git
      .diff()
      .setOldTree("refs/heads/main")
      .setNewTree("refs/heads/feature")
      .call();

    // main has main-feature.txt, feature has feature-feature.txt
    expect(diffBeforeMerge.length).toBe(2);

    // === Merge: Combine branches ===
    // Switch to main first
    await repository.refs.setSymbolic("HEAD", "refs/heads/main");

    const mergeResult = await git.merge().include("refs/heads/feature").call();

    expect(mergeResult.status).toBe(MergeStatus.MERGED);

    // === Verify: All files present after merge ===
    const mainRef = await repository.refs.resolve("refs/heads/main");
    expect(mainRef?.objectId).toBeDefined();
    const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
    const entries = new Map<string, boolean>();

    if (mainCommit) {
      const treeEntries = await repository.trees.load(mainCommit.tree);
      for await (const entry of treeEntries ?? []) {
        entries.set(entry.name, true);
      }
    }

    expect(entries.has("shared.txt")).toBe(true);
    expect(entries.has("main-feature.txt")).toBe(true);
    expect(entries.has("feature-feature.txt")).toBe(true);

    // === Diff: Should be empty when comparing same commit ===
    const diffAfterMerge = await git
      .diff()
      .setOldTree("refs/heads/main")
      .setNewTree("refs/heads/main")
      .call();

    expect(diffAfterMerge.length).toBe(0);
  });
});
