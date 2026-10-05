/**
 * T3.10: Workflow Integration Tests
 *
 * Tests complete multi-command Git workflows simulating real-world
 * development scenarios:
 * - Feature branch workflow (branch → commit → merge)
 * - Release workflow (tag → cherry-pick → merge back)
 * - Hotfix workflow (branch from tag → fix → merge)
 * - Conflict resolution workflow
 * - Stash workflow across branches
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  CherryPickStatus,
  FastForwardMode,
  MergeStatus,
  ResetMode,
  RevertStatus,
} from "../src/index.js";
import { addFile, backends, createInitializedGitFromFactory, toArray } from "./test-helper.js";

describe.each(backends)("Workflow Integration ($name backend)", ({ factory }) => {
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

  describe("feature branch workflow", () => {
    it("create feature → commit → merge back to main", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Setup main with a base file
      await addFile(workingCopy, "readme.txt", "# Project");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add readme").call();

      // Create feature branch
      await git.branchCreate().setName("feature/auth").call();

      // Continue main with another commit
      await addFile(workingCopy, "config.txt", "version=1.0");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add config").call();

      // Switch to feature branch
      await repository.refs.setSymbolic("HEAD", "refs/heads/feature/auth");
      const featureRef = await repository.refs.resolve("refs/heads/feature/auth");
      const featureCommit = await repository.commits.load(featureRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, featureCommit.tree);

      // Make feature commits
      await addFile(workingCopy, "auth.txt", "login logic");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add auth module").call();

      await addFile(workingCopy, "auth-test.txt", "auth tests");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add auth tests").call();

      // Switch back to main and merge
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      const mergeResult = await git.merge().include("refs/heads/feature/auth").call();
      expect(mergeResult.status).toBe(MergeStatus.MERGED);

      // Verify merge commit has two parents
      const headRef = await repository.refs.resolve("HEAD");
      const head = await repository.commits.load(headRef?.objectId ?? "");
      expect(head.parents.length).toBe(2);

      // Verify all files present
      const files: string[] = [];
      for await (const entry of (await repository.trees.load(head.tree)) ?? []) {
        files.push(entry.name);
      }
      expect(files).toContain("readme.txt");
      expect(files).toContain("config.txt");
      expect(files).toContain("auth.txt");
      expect(files).toContain("auth-test.txt");

      // Delete feature branch after merge
      await git.branchDelete().setBranchNames("feature/auth").call();
      const branches = await git.branchList().call();
      const branchNames = branches.map((b) => b.name);
      expect(branchNames).not.toContain("refs/heads/feature/auth");
    });

    it("fast-forward merge when feature is ahead of main", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create feature branch at main
      await git.branchCreate().setName("feature/simple").call();

      // Switch to feature and add commits (main doesn't advance)
      await repository.refs.setSymbolic("HEAD", "refs/heads/feature/simple");

      await addFile(workingCopy, "feature.txt", "feature content");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Feature work").call();

      // Switch back to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");

      // Merge feature (should fast-forward)
      const result = await git.merge().include("refs/heads/feature/simple").call();
      expect(result.status).toBe(MergeStatus.FAST_FORWARD);

      // Main and feature should point to same commit
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const featureRef = await repository.refs.resolve("refs/heads/feature/simple");
      expect(mainRef?.objectId).toBe(featureRef?.objectId);
    });
  });

  describe("release workflow", () => {
    it("tag release → cherry-pick fix → tag patch", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Build up to v1.0.0
      await addFile(workingCopy, "app.txt", "v1.0.0 code");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Release v1.0.0").call();
      await git.tag().setName("v1.0.0").setMessage("Release v1.0.0").call();

      // Continue development on main
      await addFile(workingCopy, "new-feature.txt", "new feature");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add new feature").call();

      // Bug found - fix on main
      await addFile(workingCopy, "app.txt", "v1.0.0 code - bugfix");
      await workingCopy.checkout.staging.write();
      const fixCommit = await git.commit().setMessage("Fix critical bug").call();
      const fixCommitId = await repository.commits.store(fixCommit);

      // Create release branch from v1.0.0 tag
      await git.branchCreate().setName("release/1.0.x").setStartPoint("v1.0.0").call();

      // Switch to release branch
      await repository.refs.setSymbolic("HEAD", "refs/heads/release/1.0.x");
      const releaseRef = await repository.refs.resolve("refs/heads/release/1.0.x");
      const releaseCommit = await repository.commits.load(releaseRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, releaseCommit.tree);

      // Cherry-pick the fix
      const cpResult = await git.cherryPick().include(fixCommitId).call();
      expect(cpResult.status).toBe(CherryPickStatus.OK);

      // Tag the patch release
      await git.tag().setName("v1.0.1").setMessage("Patch release v1.0.1").call();

      // Verify release branch has the fix
      const commits = await toArray(await git.log().call());
      expect(commits[0].message).toBe("Fix critical bug");

      // Verify both tags exist
      const tags = await git.tagList().call();
      const tagNames = tags.map((t) => t.name);
      expect(tagNames).toContain("refs/tags/v1.0.0");
      expect(tagNames).toContain("refs/tags/v1.0.1");
    });
  });

  describe("hotfix workflow", () => {
    it("branch from release → fix → merge back", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create release
      await addFile(workingCopy, "app.txt", "production code");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Production release").call();
      await git.tag().setName("v2.0.0").call();

      // Main continues
      await addFile(workingCopy, "next.txt", "next version work");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Next version work").call();

      // Create hotfix branch from tag
      await git.branchCreate().setName("hotfix/critical").setStartPoint("v2.0.0").call();

      // Switch to hotfix
      await repository.refs.setSymbolic("HEAD", "refs/heads/hotfix/critical");
      const hotfixRef = await repository.refs.resolve("refs/heads/hotfix/critical");
      const hotfixCommit = await repository.commits.load(hotfixRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, hotfixCommit.tree);

      // Apply hotfix
      await addFile(workingCopy, "app.txt", "production code - hotfix applied");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Critical hotfix").call();

      // Merge hotfix into main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      const mergeResult = await git.merge().include("refs/heads/hotfix/critical").call();
      expect(mergeResult.status).toBe(MergeStatus.MERGED);

      // Verify hotfix is in main's history
      const commits = await toArray(await git.log().call());
      const messages = commits.map((c) => c.message);
      expect(messages).toContain("Critical hotfix");

      // Clean up hotfix branch
      await git.branchDelete().setBranchNames("hotfix/critical").call();
    });
  });

  describe("conflict detection workflow", () => {
    it("detects merge conflict from divergent changes", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create shared base
      await addFile(workingCopy, "shared.txt", "original content");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add shared file").call();

      // Create feature branch
      await git.branchCreate().setName("feature").call();

      // Modify on main
      await addFile(workingCopy, "shared.txt", "main's version");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Main change").call();

      // Switch to feature and modify same file differently
      await repository.refs.setSymbolic("HEAD", "refs/heads/feature");
      const featureRef = await repository.refs.resolve("refs/heads/feature");
      const featureCommit = await repository.commits.load(featureRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, featureCommit.tree);

      await addFile(workingCopy, "shared.txt", "feature's version");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Feature change").call();

      // Switch to main and attempt merge
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      const mergeResult = await git
        .merge()
        .include("refs/heads/feature")
        .setFastForwardMode(FastForwardMode.NO_FF)
        .call();

      // Should detect conflict
      expect(mergeResult.status).toBe(MergeStatus.CONFLICTING);
      expect(mergeResult.conflicts.length).toBeGreaterThan(0);
    });

    it("non-conflicting merge of different files", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create feature branch
      await git.branchCreate().setName("feature").call();

      // Add file on main
      await addFile(workingCopy, "main-file.txt", "main content");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Main file").call();

      // Switch to feature, add different file
      await repository.refs.setSymbolic("HEAD", "refs/heads/feature");
      const featureRef = await repository.refs.resolve("refs/heads/feature");
      const featureCommit = await repository.commits.load(featureRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, featureCommit.tree);

      await addFile(workingCopy, "feature-file.txt", "feature content");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Feature file").call();

      // Merge on main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      const result = await git
        .merge()
        .include("refs/heads/feature")
        .setFastForwardMode(FastForwardMode.NO_FF)
        .call();
      expect(result.status).toBe(MergeStatus.MERGED);
    });
  });

  describe("multi-step development simulation", () => {
    it("simulate iterative development with multiple contributors", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Alice sets up the project
      await addFile(workingCopy, "package.json", '{"name":"myapp","version":"0.1.0"}');
      await workingCopy.checkout.staging.write();
      await git
        .commit()
        .setMessage("Initial project setup")
        .setAuthor("Alice", "alice@example.com")
        .call();

      // Bob creates a feature branch
      await git.branchCreate().setName("bob/feature").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/bob/feature");

      await addFile(workingCopy, "feature.txt", "Bob's feature");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add feature").setAuthor("Bob", "bob@example.com").call();

      // Alice continues on main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      await addFile(workingCopy, "docs.txt", "Documentation");
      await workingCopy.checkout.staging.write();
      await git
        .commit()
        .setMessage("Add documentation")
        .setAuthor("Alice", "alice@example.com")
        .call();

      // Merge Bob's feature
      const mergeResult = await git.merge().include("refs/heads/bob/feature").call();
      expect(mergeResult.status).toBe(MergeStatus.MERGED);

      // Tag the merged result
      await git.tag().setName("v0.2.0").setMessage("Feature release").call();

      // Verify final state
      const commits = await toArray(await git.log().call());
      expect(commits.length).toBeGreaterThanOrEqual(4); // merge + docs + feature + setup + initial

      // Verify different authors
      const authors = new Set(commits.map((c) => c.author.name));
      expect(authors.has("Alice")).toBe(true);
      expect(authors.has("Bob")).toBe(true);

      // Verify tag exists
      const tags = await git.tagList().call();
      expect(tags.some((t) => t.name === "refs/tags/v0.2.0")).toBe(true);
    });

    it("revert and redo cycle", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create a series of commits adding different files (no conflict on revert)
      await addFile(workingCopy, "v1.txt", "version 1");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Version 1").call();

      await addFile(workingCopy, "v2.txt", "version 2");
      await workingCopy.checkout.staging.write();
      const v2Commit = await git.commit().setMessage("Version 2").call();
      const v2CommitId = await repository.commits.store(v2Commit);

      await addFile(workingCopy, "v3.txt", "version 3");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Version 3").call();

      // Revert v2 (removes v2.txt, non-conflicting since v3 added a different file)
      const revertResult = await git.revert().include(v2CommitId).call();
      expect(revertResult.status).toBe(RevertStatus.OK);

      // Verify history has 5 commits
      let commits = await toArray(await git.log().call());
      expect(commits.length).toBe(5); // revert + v3 + v2 + v1 + initial

      // Reset back to before the revert
      await git.reset().setRef("HEAD~1").setMode(ResetMode.HARD).call();

      // Verify we're back to v3
      commits = await toArray(await git.log().call());
      expect(commits.length).toBe(4);
      expect(commits[0].message).toBe("Version 3");
    });

    it("branch management lifecycle", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Create several branches
      await git.branchCreate().setName("develop").call();
      await git.branchCreate().setName("staging").call();
      await git.branchCreate().setName("release/1.0").call();

      // List all branches
      let branches = await git.branchList().call();
      expect(branches.length).toBe(4); // main + 3 created

      // Rename develop to dev
      await git.branchRename().setOldName("develop").setNewName("dev").call();

      branches = await git.branchList().call();
      const names = branches.map((b) => b.name);
      expect(names).toContain("refs/heads/dev");
      expect(names).not.toContain("refs/heads/develop");

      // Delete staging (it's merged - same commit as main)
      await git.branchDelete().setBranchNames("staging").call();

      branches = await git.branchList().call();
      expect(branches.length).toBe(3); // main + dev + release/1.0

      // Add a commit, verify branches diverge
      await addFile(workingCopy, "new.txt", "content");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("New commit on main").call();

      // main is now ahead of dev and release/1.0
      const mainRef = await git.workingCopy.history.refs.resolve("refs/heads/main");
      const devRef = await git.workingCopy.history.refs.resolve("refs/heads/dev");
      expect(mainRef?.objectId).not.toBe(devRef?.objectId);
    });
  });
});
