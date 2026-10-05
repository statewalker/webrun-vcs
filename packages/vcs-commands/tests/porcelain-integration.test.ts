/**
 * T3.9: Porcelain Command Integration Tests
 *
 * Tests high-level Git commands working together through the Git class facade,
 * exercising complete multi-command workflows that aren't covered by
 * individual command tests or basic workflow tests.
 *
 * Scenarios:
 * - Cherry-pick across branches
 * - Revert workflow
 * - Status tracking across operations
 * - RM + commit workflow
 * - Reset modes with staging verification
 * - Multi-command composition workflows
 */

import { afterEach, describe, expect, it } from "vitest";

import { ChangeType, CherryPickStatus, ResetMode, RevertStatus } from "../src/index.js";
import {
  addFile,
  backends,
  createInitializedGitFromFactory,
  removeFile,
  toArray,
} from "./test-helper.js";

describe.each(backends)("Porcelain Integration ($name backend)", ({ factory }) => {
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

  describe("cherry-pick workflow", () => {
    it("cherry-pick commit from feature to main", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create feature branch
      await git.branchCreate().setName("feature").call();

      // Add file on main
      await addFile(workingCopy, "main.txt", "main content");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Main work").call();

      // Switch to feature
      await repository.refs.setSymbolic("HEAD", "refs/heads/feature");
      const featureRef = await repository.refs.resolve("refs/heads/feature");
      const featureCommit = await repository.commits.load(featureRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, featureCommit.tree);

      // Add commits on feature
      await addFile(workingCopy, "feat-a.txt", "feature A");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Feature A").call();

      const featBId = await (async () => {
        await addFile(workingCopy, "feat-b.txt", "feature B - the one we want");
        await workingCopy.checkout.staging.write();
        const c = await git.commit().setMessage("Feature B").call();
        return repository.commits.store(c);
      })();

      await addFile(workingCopy, "feat-c.txt", "feature C");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Feature C").call();

      // Switch back to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Cherry-pick Feature B onto main
      const result = await git.cherryPick().include(featBId).call();
      expect(result.status).toBe(CherryPickStatus.OK);

      // Verify main now has feat-b.txt
      const headRef = await repository.refs.resolve("HEAD");
      const headCommit = await repository.commits.load(headRef?.objectId ?? "");
      const treeEntries: string[] = [];
      for await (const entry of (await repository.trees.load(headCommit.tree)) ?? []) {
        treeEntries.push(entry.name);
      }
      expect(treeEntries).toContain("feat-b.txt");
      expect(treeEntries).toContain("main.txt");
      // Should NOT have feat-a.txt or feat-c.txt
      expect(treeEntries).not.toContain("feat-a.txt");
      expect(treeEntries).not.toContain("feat-c.txt");
    });

    it("cherry-pick preserves original commit message", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create feature branch
      await git.branchCreate().setName("feature").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/feature");

      await addFile(workingCopy, "feature.txt", "feature content");
      await workingCopy.checkout.staging.write();
      const featCommit = await git.commit().setMessage("Important fix XYZ").call();
      const featCommitId = await repository.commits.store(featCommit);

      // Switch back to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");

      // Cherry-pick
      const result = await git.cherryPick().include(featCommitId).call();
      expect(result.status).toBe(CherryPickStatus.OK);

      // Verify message preserved
      const commits = await toArray(await git.log().setMaxCount(1).call());
      expect(commits[0].message).toBe("Important fix XYZ");
    });
  });

  describe("revert workflow", () => {
    it("revert a commit and verify history", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create base file
      await addFile(workingCopy, "app.txt", "version 1");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("v1").call();

      // Create a bad commit
      await addFile(workingCopy, "app.txt", "broken version");
      await workingCopy.checkout.staging.write();
      const badCommit = await git.commit().setMessage("Break things").call();
      const badCommitId = await repository.commits.store(badCommit);

      // Verify broken state
      const commitsBeforeRevert = await toArray(await git.log().call());
      expect(commitsBeforeRevert[0].message).toBe("Break things");

      // Revert the bad commit
      const result = await git.revert().include(badCommitId).call();
      expect(result.status).toBe(RevertStatus.OK);

      // Verify revert created a new commit
      const commitsAfterRevert = await toArray(await git.log().call());
      expect(commitsAfterRevert.length).toBe(commitsBeforeRevert.length + 1);
      expect(commitsAfterRevert[0].message).toContain("Revert");

      // Verify content is back to v1 by checking blob
      const headRef = await repository.refs.resolve("HEAD");
      const headCommit = await repository.commits.load(headRef?.objectId ?? "");
      const tree = await repository.trees.load(headCommit.tree);
      let appBlobId = "";
      for await (const entry of tree ?? []) {
        if (entry.name === "app.txt") appBlobId = entry.id;
      }
      expect(appBlobId).not.toBe("");

      const blobChunks: Uint8Array[] = [];
      const blob = await repository.blobs.load(appBlobId);
      if (blob) {
        for await (const chunk of blob) blobChunks.push(chunk);
      }
      const totalLen = blobChunks.reduce((s, c) => s + c.length, 0);
      const allBytes = new Uint8Array(totalLen);
      let offset = 0;
      for (const chunk of blobChunks) {
        allBytes.set(chunk, offset);
        offset += chunk.length;
      }
      const content = new TextDecoder().decode(allBytes);
      expect(content).toBe("version 1");
    });

    it("revert middle commit in a chain", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create chain of commits
      await addFile(workingCopy, "a.txt", "file a");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add a").call();

      await addFile(workingCopy, "b.txt", "file b");
      await workingCopy.checkout.staging.write();
      const commitB = await git.commit().setMessage("Add b").call();
      const commitBId = await repository.commits.store(commitB);

      await addFile(workingCopy, "c.txt", "file c");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add c").call();

      // Revert the middle commit (Add b)
      const revertResult = await git.revert().include(commitBId).call();
      expect(revertResult.status).toBe(RevertStatus.OK);

      // Log should have 5 entries: revert + add c + add b + add a + initial
      const commits = await toArray(await git.log().call());
      expect(commits.length).toBe(5);
      expect(commits[0].message).toContain("Revert");

      // Verify b.txt is gone from the tree
      const headRef = await repository.refs.resolve("HEAD");
      const headCommit = await repository.commits.load(headRef?.objectId ?? "");
      const files: string[] = [];
      for await (const entry of (await repository.trees.load(headCommit.tree)) ?? []) {
        files.push(entry.name);
      }
      expect(files).toContain("a.txt");
      expect(files).not.toContain("b.txt");
      expect(files).toContain("c.txt");
    });
  });

  describe("status tracking across operations", () => {
    it("tracks status through add → commit → modify cycle", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Initially clean
      let status = await git.status().call();
      expect(status.isClean()).toBe(true);

      // Add file → status shows added
      await addFile(workingCopy, "tracked.txt", "initial");
      status = await git.status().call();
      expect(status.added.has("tracked.txt")).toBe(true);

      // Commit → status clean
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add tracked file").call();
      status = await git.status().call();
      expect(status.isClean()).toBe(true);

      // Modify → status shows changed
      await addFile(workingCopy, "tracked.txt", "modified");
      status = await git.status().call();
      expect(status.changed.has("tracked.txt")).toBe(true);

      // Commit modification → clean again
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Modify tracked file").call();
      status = await git.status().call();
      expect(status.isClean()).toBe(true);
    });

    it("tracks status through add → remove → commit", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Add files
      await addFile(workingCopy, "keep.txt", "keep this");
      await addFile(workingCopy, "remove-me.txt", "will be removed");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add files").call();

      // Remove one file
      await removeFile(workingCopy, "remove-me.txt");
      const status = await git.status().call();
      expect(status.removed.has("remove-me.txt")).toBe(true);

      // Commit the removal
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Remove file").call();

      // Verify clean
      const statusAfter = await git.status().call();
      expect(statusAfter.isClean()).toBe(true);
    });

    it("status reflects multiple staged changes", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Add multiple files
      await addFile(workingCopy, "a.txt", "a");
      await addFile(workingCopy, "b.txt", "b");
      await addFile(workingCopy, "c.txt", "c");

      const status = await git.status().call();
      expect(status.added.size).toBe(3);
      expect(status.added.has("a.txt")).toBe(true);
      expect(status.added.has("b.txt")).toBe(true);
      expect(status.added.has("c.txt")).toBe(true);
    });
  });

  describe("rm + commit workflow", () => {
    it("rm files and commit the removal", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Create files
      await addFile(workingCopy, "a.txt", "file a");
      await addFile(workingCopy, "b.txt", "file b");
      await addFile(workingCopy, "c.txt", "file c");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add three files").call();

      // Remove using rm command
      await git.rm().addFilepattern("b.txt").call();

      // Status should show removal
      const status = await git.status().call();
      expect(status.removed.has("b.txt")).toBe(true);

      // Commit the removal
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Remove b.txt").call();

      // Log should show both commits
      const commits = await toArray(await git.log().call());
      expect(commits[0].message).toBe("Remove b.txt");
      expect(commits[1].message).toBe("Add three files");

      // Diff between the two commits
      const commit0Id = await repository.commits.store(commits[0]);
      const commit1Id = await repository.commits.store(commits[1]);
      const diff = await git.diff().setOldTree(commit1Id).setNewTree(commit0Id).call();

      const deleted = diff.find((e) => e.changeType === ChangeType.DELETE);
      expect(deleted?.oldPath).toBe("b.txt");
    });

    it("rm multiple files", async () => {
      const { git, workingCopy } = await createInitializedGit();

      // Create files
      await addFile(workingCopy, "x.txt", "x");
      await addFile(workingCopy, "y.txt", "y");
      await addFile(workingCopy, "z.txt", "z");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add files").call();

      // Remove two files
      await git.rm().addFilepattern("x.txt").addFilepattern("y.txt").call();

      const status = await git.status().call();
      expect(status.removed.has("x.txt")).toBe(true);
      expect(status.removed.has("y.txt")).toBe(true);
      expect(status.removed.has("z.txt")).toBe(false);
    });
  });

  describe("reset modes comparison", () => {
    it("soft reset preserves staging", async () => {
      const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

      // Add file and commit
      await addFile(workingCopy, "file.txt", "content");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add file").call();

      // Soft reset to initial
      await git.reset().setRef(initialCommitId).setMode(ResetMode.SOFT).call();

      // HEAD moved back
      const head = await repository.refs.resolve("HEAD");
      expect(head?.objectId).toBe(initialCommitId);

      // But staging still has the file (shows as added)
      const status = await git.status().call();
      expect(status.added.has("file.txt")).toBe(true);
    });

    it("mixed reset clears staging to match target", async () => {
      const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

      // Add file and commit
      await addFile(workingCopy, "file.txt", "content");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add file").call();

      // Mixed reset to initial
      await git.reset().setRef(initialCommitId).setMode(ResetMode.MIXED).call();

      // HEAD moved back
      const head = await repository.refs.resolve("HEAD");
      expect(head?.objectId).toBe(initialCommitId);

      // Staging is reset too (clean)
      const status = await git.status().call();
      expect(status.isClean()).toBe(true);
    });

    it("hard reset clears everything", async () => {
      const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

      // Add file and commit
      await addFile(workingCopy, "file.txt", "content");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add file").call();

      // Hard reset to initial
      await git.reset().setRef(initialCommitId).setMode(ResetMode.HARD).call();

      // HEAD moved back
      const head = await repository.refs.resolve("HEAD");
      expect(head?.objectId).toBe(initialCommitId);

      // Staging clean
      const status = await git.status().call();
      expect(status.isClean()).toBe(true);
    });

    it("soft vs mixed: staging difference after reset", async () => {
      const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

      // Create two commits
      await addFile(workingCopy, "file1.txt", "content1");
      await workingCopy.checkout.staging.write();
      const commit1 = await git.commit().setMessage("Commit 1").call();
      const commit1Id = await repository.commits.store(commit1);

      await addFile(workingCopy, "file2.txt", "content2");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Commit 2").call();

      // Soft reset: HEAD moves, staging keeps file2
      await git.reset().setRef(commit1Id).setMode(ResetMode.SOFT).call();
      let status = await git.status().call();
      expect(status.added.has("file2.txt")).toBe(true);

      // Now do a mixed reset from commit1 to initial
      await git.reset().setRef(initialCommitId).setMode(ResetMode.MIXED).call();
      status = await git.status().call();
      // After mixed reset, staging matches initial commit (empty tree)
      expect(status.isClean()).toBe(true);
    });
  });

  describe("multi-command composition", () => {
    it("branch → cherry-pick → tag → log", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Setup: commits on main
      await addFile(workingCopy, "base.txt", "base");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Base").call();

      // Create feature branch and add a commit
      await git.branchCreate().setName("feature").call();
      await repository.refs.setSymbolic("HEAD", "refs/heads/feature");

      await addFile(workingCopy, "feature.txt", "useful feature");
      await workingCopy.checkout.staging.write();
      const featCommit = await git.commit().setMessage("Useful feature").call();
      const featCommitId = await repository.commits.store(featCommit);

      // Switch back to main
      await repository.refs.setSymbolic("HEAD", "refs/heads/main");
      const mainRef = await repository.refs.resolve("refs/heads/main");
      const mainCommit = await repository.commits.load(mainRef?.objectId ?? "");
      await workingCopy.checkout.staging.readTree(repository.trees, mainCommit.tree);

      // Cherry-pick the feature commit onto main
      const cpResult = await git.cherryPick().include(featCommitId).call();
      expect(cpResult.status).toBe(CherryPickStatus.OK);

      // Tag the result
      await git.tag().setName("v1.0.0").setMessage("Release with cherry-picked feature").call();

      // Verify via log
      const commits = await toArray(await git.log().call());
      // Should have: cherry-pick commit, base, initial
      expect(commits.length).toBe(3);

      // Verify tag
      const tags = await git.tagList().call();
      expect(tags.length).toBe(1);
      expect(tags[0].name).toBe("refs/tags/v1.0.0");
    });

    it("add → commit → rm → commit → revert → verify restored", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();

      // Add and commit
      await addFile(workingCopy, "important.txt", "important data");
      await workingCopy.checkout.staging.write();
      await git.commit().setMessage("Add important file").call();

      // Remove and commit
      await git.rm().addFilepattern("important.txt").call();
      await workingCopy.checkout.staging.write();
      const rmCommit = await git.commit().setMessage("Remove important file").call();
      const rmCommitId = await repository.commits.store(rmCommit);

      // Verify file is gone
      let headRef = await repository.refs.resolve("HEAD");
      let headCommit = await repository.commits.load(headRef?.objectId ?? "");
      let files: string[] = [];
      for await (const entry of (await repository.trees.load(headCommit.tree)) ?? []) {
        files.push(entry.name);
      }
      expect(files).not.toContain("important.txt");

      // Revert the removal
      const revertResult = await git.revert().include(rmCommitId).call();
      expect(revertResult.status).toBe(RevertStatus.OK);

      // Verify file is restored
      headRef = await repository.refs.resolve("HEAD");
      headCommit = await repository.commits.load(headRef?.objectId ?? "");
      files = [];
      for await (const entry of (await repository.trees.load(headCommit.tree)) ?? []) {
        files.push(entry.name);
      }
      expect(files).toContain("important.txt");
    });

    it("commit → diff → reset → diff shows no changes", async () => {
      const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

      // Add files
      await addFile(workingCopy, "new-file.txt", "new content");
      await workingCopy.checkout.staging.write();
      const newCommit = await git.commit().setMessage("Add new file").call();
      const newCommitId = await repository.commits.store(newCommit);

      // Diff between initial and new
      let diff = await git.diff().setOldTree(initialCommitId).setNewTree(newCommitId).call();
      expect(diff.length).toBe(1);
      expect(diff[0].changeType).toBe(ChangeType.ADD);
      expect(diff[0].newPath).toBe("new-file.txt");

      // Reset to initial
      await git.reset().setRef(initialCommitId).setMode(ResetMode.HARD).call();

      // Diff between current HEAD and initial should be empty
      const currentHead = await repository.refs.resolve("HEAD");
      diff = await git
        .diff()
        .setOldTree(initialCommitId)
        .setNewTree(currentHead?.objectId ?? "")
        .call();
      expect(diff.length).toBe(0);
    });
  });
});
