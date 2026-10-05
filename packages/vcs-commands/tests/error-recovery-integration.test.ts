/**
 * T3.11: Error Recovery Integration Tests
 *
 * Tests graceful degradation and recovery across components:
 * - Merge conflict detection and state preservation
 * - Failed operations leave repository in consistent state
 * - Command validation prevents invalid operations
 * - Recovery from error states
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  EmptyCommitError,
  FastForwardMode,
  InvalidRefNameError,
  MergeStatus,
  NoFilepatternError,
  NoMessageError,
  RefNotFoundError,
  ResetMode,
} from "../src/index.js";
import { addFile, backends, createInitializedGitFromFactory, toArray } from "./test-helper.js";

describe.each(backends)("Error Recovery Integration ($name backend)", ({ factory }) => {
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

  describe("merge conflict recovery", () => {
    it("conflict leaves repository in recoverable state", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create shared base
      await addFile(workingCopy, "file.txt", "base content");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Base").call();

      // Create branch
      await git.branchCreate().setName("feature").call();

      // Modify on main
      await addFile(workingCopy, "file.txt", "main change");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Main change").call();

      // Save main HEAD before merge attempt
      const mainHeadBefore = await repository.refs.resolve("HEAD");

      // Switch to feature and modify same file
      await repository.refs.setSymbolic("HEAD", "refs/heads/feature");
      const featureRef = await repository.refs.resolve("refs/heads/feature");
      const featureCommit = await repository.commits.load(featureRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, featureCommit.tree);

      await addFile(workingCopy, "file.txt", "feature change");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Feature change").call();

      // Switch back to main and attempt merge
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      const result = await git
        .merge()
        .include("refs/heads/feature")
        .setFastForwardMode(FastForwardMode.NO_FF)
        .call();

      expect(result.status).toBe(MergeStatus.CONFLICTING);

      // Main ref should still point to the same commit (merge didn't complete)
      const mainHeadAfter = await repository.refs.resolve("refs/heads/main");
      expect(mainHeadAfter?.objectId).toBe(mainHeadBefore?.objectId);

      // After conflict, we can still do other operations
      const commits = await toArray(await git.log().call());
      expect(commits.length).toBeGreaterThanOrEqual(2);
    });

    it("can continue working after merge conflict", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Setup conflicting branches
      await addFile(workingCopy, "conflict.txt", "original");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Original").call();

      await git.branchCreate().setName("other").call();

      await addFile(workingCopy, "conflict.txt", "main version");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Main update").call();

      await repository.refs.setSymbolic("HEAD", "refs/heads/other");
      const otherRef = await repository.refs.resolve("refs/heads/other");
      const otherCommit = await repository.commits.load(otherRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, otherCommit.tree);

      await addFile(workingCopy, "conflict.txt", "other version");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Other update").call();

      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Merge conflicts
      const mergeResult = await git
        .merge()
        .include("refs/heads/other")
        .setFastForwardMode(FastForwardMode.NO_FF)
        .call();
      expect(mergeResult.status).toBe(MergeStatus.CONFLICTING);

      // Reset staging to HEAD tree (abort merge) and continue working
      const headRef = await repository.refs.resolve("HEAD");
      const headCommit = await repository.commits.load(headRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, headCommit.tree);

      // Add a new file and commit on a clean staging
      await addFile(workingCopy, "new-file.txt", "new content after conflict");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Continue after conflict").call();

      // Verify the new commit exists
      const commits = await toArray(await git.log().setMaxCount(1).call());
      expect(commits[0].message).toBe("Continue after conflict");
    });
  });

  describe("command validation errors", () => {
    it("commit without message fails gracefully", async () => {
      const { git } = await createInitializedGit();

      await expect(git.commit().call()).rejects.toThrow(NoMessageError);
    });

    it("empty commit without --allow-empty fails", async () => {
      const { git } = await createInitializedGit();

      await expect(git.commit().setMessage("Empty").call()).rejects.toThrow(EmptyCommitError);
    });

    it("add without file pattern fails", async () => {
      const { git } = await createInitializedGit();

      await expect(git.add().call()).rejects.toThrow(NoFilepatternError);
    });

    it("invalid branch name rejected", async () => {
      const { git } = await createInitializedGit();

      await expect(git.branchCreate().setName("feature..bad").call()).rejects.toThrow(
        InvalidRefNameError,
      );
    });

    it("reset to nonexistent ref fails", async () => {
      const { git } = await createInitializedGit();

      await expect(git.reset().setRef("nonexistent-ref").call()).rejects.toThrow(RefNotFoundError);
    });
  });

  describe("state consistency after failures", () => {
    it("failed commit preserves staging", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Stage a file
      await addFile(workingCopy, "staged.txt", "staged content");

      // Attempt commit without message (should fail)
      await expect(git.commit().call()).rejects.toThrow();

      // Staging should still have the file
      const status = await git.status().call();
      expect(status.added.has("staged.txt")).toBe(true);

      // Can still commit with message
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Recovered commit").call();

      const status2 = await git.status().call();
      expect(status2.isClean()).toBe(true);
    });

    it("failed branch create preserves existing branches", async () => {
      const { git } = await createInitializedGit();

      // Create valid branch
      await git.branchCreate().setName("valid-branch").call();

      // Try invalid branch name
      await expect(git.branchCreate().setName("bad..name").call()).rejects.toThrow();

      // Valid branch still exists
      const branches = await git.branchList().call();
      const names = branches.map((b) => b.name);
      expect(names).toContain("refs/heads/valid-branch");
    });

    it("hard reset restores clean state after failed merge", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create base + conflicting branches
      await addFile(workingCopy, "data.txt", "original");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Base").call();

      await git.branchCreate().setName("conflict-branch").call();

      await addFile(workingCopy, "data.txt", "main version");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Main update").call();

      const mainHead = await repository.refs.resolve("HEAD");

      await repository.refs.setSymbolic("HEAD", "refs/heads/conflict-branch");
      const branchRef = await repository.refs.resolve("refs/heads/conflict-branch");
      const branchCommit = await repository.commits.load(branchRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, branchCommit.tree);

      await addFile(workingCopy, "data.txt", "branch version");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Branch update").call();

      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Attempt merge (will conflict)
      const mergeResult = await git
        .merge()
        .include("refs/heads/conflict-branch")
        .setFastForwardMode(FastForwardMode.NO_FF)
        .call();
      expect(mergeResult.status).toBe(MergeStatus.CONFLICTING);

      // Hard reset to restore clean state
      await git
        .reset()
        .setRef(mainHead?.objectId ?? "")
        .setMode(ResetMode.HARD)
        .call();

      // Verify clean state
      const status = await git.status().call();
      expect(status.isClean()).toBe(true);

      // HEAD should be at the pre-merge commit
      const currentHead = await repository.refs.resolve("HEAD");
      expect(currentHead?.objectId).toBe(mainHead?.objectId);
    });
  });

  describe("command-called-once enforcement", () => {
    it("rejects second call to same command", async () => {
      const { git } = await createInitializedGit();

      const command = git.commit().setMessage("First").setAllowEmpty(true);
      await command.call();

      await expect(command.call()).rejects.toThrow(/already been called/);
    });
  });

  describe("ref error recovery", () => {
    it("branch delete of nonexistent branch fails cleanly", async () => {
      const { git } = await createInitializedGit();

      await expect(git.branchDelete().setBranchNames("nonexistent").call()).rejects.toThrow();

      // Repository is still functional
      const branches = await git.branchList().call();
      expect(branches.length).toBeGreaterThan(0);
    });

    it("can create branch after failed attempt", async () => {
      const { git } = await createInitializedGit();

      // Fail: invalid name
      await expect(git.branchCreate().setName("bad..name").call()).rejects.toThrow();

      // Succeed: valid name
      const ref = await git.branchCreate().setName("good-name").call();
      expect(ref.name).toBe("refs/heads/good-name");
    });

    it("recover from detached HEAD by creating branch", async () => {
      const { git, repository, initialCommitId } = await createInitializedGit();

      // Detach HEAD
      await repository.refs.set("HEAD", initialCommitId);

      // Create a branch at current HEAD to recover
      await git.branchCreate().setName("recovery").setStartPoint(initialCommitId).call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/recovery");

      // Verify we're on the recovery branch
      const commits = await toArray(await git.log().call());
      expect(commits.length).toBe(1);
    });
  });

  describe("multi-error workflow resilience", () => {
    it("repository remains functional after multiple errors", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Error 1: empty commit
      await expect(git.commit().setMessage("Empty").call()).rejects.toThrow(EmptyCommitError);

      // Error 2: invalid branch
      await expect(git.branchCreate().setName("a..b").call()).rejects.toThrow();

      // Error 3: add without pattern
      await expect(git.add().call()).rejects.toThrow(NoFilepatternError);

      // Error 4: reset to bad ref
      await expect(git.reset().setRef("bad-ref").call()).rejects.toThrow();

      // Repository should still work perfectly
      await addFile(workingCopy, "recovery.txt", "recovered");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Recovery commit").call();

      const commits = await toArray(await git.log().call());
      expect(commits[0].message).toBe("Recovery commit");
      expect(commits.length).toBe(2); // initial + recovery
    });
  });
});
