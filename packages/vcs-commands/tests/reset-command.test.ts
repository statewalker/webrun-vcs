/**
 * Tests for ResetCommand
 *
 * Based on JGit's ResetCommandTest.java
 * Tests run against all storage backends (Memory, SQL).
 */

import { FileMode } from "@statewalker/vcs-core";
import type { Worktree } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";
import { RefNotFoundError } from "../src/errors/index.js";
import { ResetMode } from "../src/index.js";
import type { MockWorktree } from "./mock-worktree-store.js";
import {
  backends,
  createCommit,
  createInitializedGitFromFactory,
  testAuthor,
  toArray,
} from "./test-helper.js";

describe.each(backends)("ResetCommand ($name backend)", ({ factory }) => {
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

  describe("ResetCommand", () => {
    it("should reset to HEAD by default", async () => {
      const { git } = await createInitializedGit();

      // Create commits
      await git.commit().setMessage("Second").setAllowEmpty(true).call();

      const ref = await git.reset().call();

      expect(ref).toBeDefined();
    });

    it("should soft reset (move HEAD only)", async () => {
      const { git, repository, initialCommitId } = await createInitializedGit();

      // Create commit
      await git.commit().setMessage("Second").setAllowEmpty(true).call();

      // Soft reset to initial commit
      await git.reset().setRef(initialCommitId).setMode(ResetMode.SOFT).call();

      // HEAD should point to initial commit
      const headRef = await repository.refs.resolve("HEAD");
      expect(headRef?.objectId).toBe(initialCommitId);

      // Staging should remain unchanged (soft reset doesn't touch it)
      // This is verified by the fact that writeTree would produce same tree
    });

    it("should mixed reset (move HEAD and reset staging)", async () => {
      const { git, workingCopy, repository, initialCommitId } = await createInitializedGit();

      // Create commit
      await git.commit().setMessage("Second").setAllowEmpty(true).call();

      // Mixed reset to initial commit
      await git.reset().setRef(initialCommitId).setMode(ResetMode.MIXED).call();

      // HEAD should point to initial commit
      const headRef = await repository.refs.resolve("HEAD");
      expect(headRef?.objectId).toBe(initialCommitId);

      // Staging should match initial commit's tree
      const treeId = await workingCopy.checkout.staging.writeTree(repository.trees);
      const initialCommit = await repository.commits.load(initialCommitId);
      expect(treeId).toBe(initialCommit.tree);
    });

    it("should reset with HEAD~N notation", async () => {
      const { git, repository, initialCommitId } = await createInitializedGit();

      // Create commits
      await git.commit().setMessage("Second").setAllowEmpty(true).call();
      await git.commit().setMessage("Third").setAllowEmpty(true).call();

      // Reset to HEAD~2 (should be initial commit)
      await git.reset().setRef("HEAD~2").call();

      const headRef = await repository.refs.resolve("HEAD");
      expect(headRef?.objectId).toBe(initialCommitId);
    });

    it("should reset with HEAD^ notation", async () => {
      const { git, repository } = await createInitializedGit();

      // Create commit
      const second = await git.commit().setMessage("Second").setAllowEmpty(true).call();
      const secondId = await repository.commits.store(second);

      await git.commit().setMessage("Third").setAllowEmpty(true).call();

      // Reset to HEAD^ (should be second commit)
      await git.reset().setRef("HEAD^").call();

      const headRef = await repository.refs.resolve("HEAD");
      expect(headRef?.objectId).toBe(secondId);
    });

    it("should throw when ref cannot be resolved", async () => {
      const { git } = await createInitializedGit();

      await expect(git.reset().setRef("nonexistent").call()).rejects.toThrow(RefNotFoundError);
    });

    it("should throw when relative ref goes beyond history", async () => {
      const { git } = await createInitializedGit();

      // Initial commit has no parent
      await expect(git.reset().setRef("HEAD~10").call()).rejects.toThrow(RefNotFoundError);
    });

    it("should update branch ref", async () => {
      const { git, repository, initialCommitId } = await createInitializedGit();

      // Create commits
      await git.commit().setMessage("Second").setAllowEmpty(true).call();

      // Reset
      await git.reset().setRef(initialCommitId).call();

      // Branch should be updated
      const branchRef = await repository.refs.resolve("refs/heads/main");
      expect(branchRef?.objectId).toBe(initialCommitId);
    });

    it("should work with detached HEAD", async () => {
      const { git, repository, initialCommitId } = await createInitializedGit();

      // Create commit
      const second = await git.commit().setMessage("Second").setAllowEmpty(true).call();
      const secondId = await repository.commits.store(second);

      // Detach HEAD
      await repository.refs.set("HEAD", secondId);

      // Reset
      await git.reset().setRef(initialCommitId).call();

      // HEAD should be updated directly
      const head = await repository.refs.get("HEAD");
      expect(head && "objectId" in head ? head.objectId : null).toBe(initialCommitId);
    });

    it("should not be callable twice", async () => {
      const { git } = await createInitializedGit();

      const cmd = git.reset();
      await cmd.call();

      await expect(cmd.call()).rejects.toThrow(/already been called/);
    });
  });

  describe("ResetCommand with log verification", () => {
    it("should affect log after reset", async () => {
      const { git, initialCommitId } = await createInitializedGit();

      // Create commits
      await git.commit().setMessage("Second").setAllowEmpty(true).call();
      await git.commit().setMessage("Third").setAllowEmpty(true).call();

      // Before reset: 3 commits visible
      let commits = await toArray(await git.log().call());
      expect(commits.length).toBe(3);

      // Reset to initial commit
      await git.reset().setRef(initialCommitId).call();

      // After reset: only initial commit visible
      commits = await toArray(await git.log().call());
      expect(commits.length).toBe(1);
      expect(commits[0].message).toBe("Initial commit");
    });
  });

  /**
   * HARD reset must change the *working tree*, not only HEAD and staging.
   *
   * Every assertion below reads the worktree back, because a Ref returned from
   * call() says nothing about whether the user's files were restored. Fixtures
   * commit real files with real content — never the empty initial tree, whose
   * well-known id a content-addressed store can answer for without ever having
   * been given it.
   */
  describe("ResetCommand HARD working-tree reset", () => {
    /** Read a worktree file back as text. */
    async function readWorktreeText(worktree: Worktree, path: string): Promise<string> {
      const chunks: Uint8Array[] = [];
      for await (const chunk of worktree.readContent(path)) {
        chunks.push(chunk);
      }
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      return new TextDecoder().decode(joined);
    }

    function worktreeOf(workingCopy: { worktree?: Worktree }): MockWorktree {
      if (!workingCopy.worktree) throw new Error("test setup: WorkingCopy has no worktree");
      return workingCopy.worktree as MockWorktree;
    }

    it("should restore a modified file's content in the working tree", async () => {
      const { git, workingCopy } = await createInitializedGit();
      const commitId = await createCommit(workingCopy, "Add data", {
        "data.txt": "committed content",
      });
      const worktree = worktreeOf(workingCopy);

      // The user mangles the file.
      worktree.setFile("data.txt", "LOCAL GARBAGE");
      expect(await readWorktreeText(worktree, "data.txt")).toBe("LOCAL GARBAGE");

      await git.reset().setRef(commitId).setMode(ResetMode.HARD).call();

      // The real consequence: the file on disk is the committed content again.
      expect(await readWorktreeText(worktree, "data.txt")).toBe("committed content");
    });

    it("should restore a file the user deleted from the working tree", async () => {
      const { git, workingCopy } = await createInitializedGit();
      const commitId = await createCommit(workingCopy, "Add data", {
        "data.txt": "committed content",
      });
      const worktree = worktreeOf(workingCopy);
      worktree.setFile("data.txt", "committed content");

      worktree.deleteFile("data.txt");
      expect(await worktree.exists("data.txt")).toBe(false);

      await git.reset().setRef(commitId).setMode(ResetMode.HARD).call();

      expect(await worktree.exists("data.txt")).toBe(true);
      expect(await readWorktreeText(worktree, "data.txt")).toBe("committed content");
    });

    it("should restore nested files under their full path", async () => {
      const { git, workingCopy } = await createInitializedGit();
      const commitId = await createCommit(workingCopy, "Add nested", {
        "src/deep/nested.ts": "export const x = 1;",
      });
      const worktree = worktreeOf(workingCopy);
      worktree.setFile("src/deep/nested.ts", "CLOBBERED");

      await git.reset().setRef(commitId).setMode(ResetMode.HARD).call();

      expect(await readWorktreeText(worktree, "src/deep/nested.ts")).toBe("export const x = 1;");
    });

    it("should delete a tracked file that is absent from the target commit", async () => {
      const { git, workingCopy } = await createInitializedGit();
      const baseId = await createCommit(workingCopy, "Base", { "keep.txt": "base content" });
      await createCommit(workingCopy, "Add extra", { "extra.txt": "extra content" });

      const worktree = worktreeOf(workingCopy);
      worktree.setFile("keep.txt", "base content");
      worktree.setFile("extra.txt", "extra content");

      await git.reset().setRef(baseId).setMode(ResetMode.HARD).call();

      // extra.txt was tracked but does not exist in the target tree.
      expect(await worktree.exists("extra.txt")).toBe(false);
      expect(await readWorktreeText(worktree, "keep.txt")).toBe("base content");
    });

    it("should leave untracked files alone", async () => {
      const { git, workingCopy } = await createInitializedGit();
      const commitId = await createCommit(workingCopy, "Add data", {
        "data.txt": "committed content",
      });
      const worktree = worktreeOf(workingCopy);
      worktree.setFile("data.txt", "committed content");
      worktree.setFile("scratch.txt", "my untracked notes");

      await git.reset().setRef(commitId).setMode(ResetMode.HARD).call();

      // `git reset --hard` does not remove untracked files; that is `git clean`.
      expect(await worktree.exists("scratch.txt")).toBe(true);
      expect(await readWorktreeText(worktree, "scratch.txt")).toBe("my untracked notes");
    });

    it("should NOT touch the working tree in MIXED mode", async () => {
      const { git, workingCopy } = await createInitializedGit();
      const commitId = await createCommit(workingCopy, "Add data", {
        "data.txt": "committed content",
      });
      const worktree = worktreeOf(workingCopy);
      worktree.setFile("data.txt", "LOCAL GARBAGE");

      await git.reset().setRef(commitId).setMode(ResetMode.MIXED).call();

      expect(await readWorktreeText(worktree, "data.txt")).toBe("LOCAL GARBAGE");
    });

    it("should NOT touch the working tree in SOFT mode", async () => {
      const { git, workingCopy } = await createInitializedGit();
      const commitId = await createCommit(workingCopy, "Add data", {
        "data.txt": "committed content",
      });
      const worktree = worktreeOf(workingCopy);
      worktree.setFile("data.txt", "LOCAL GARBAGE");

      await git.reset().setRef(commitId).setMode(ResetMode.SOFT).call();

      expect(await readWorktreeText(worktree, "data.txt")).toBe("LOCAL GARBAGE");
    });

    it("should fail loudly rather than half-restore when a blob is missing", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();
      const commitId = await createCommit(workingCopy, "Add data", {
        "data.txt": "committed content",
      });
      const worktree = worktreeOf(workingCopy);
      worktree.setFile("data.txt", "LOCAL GARBAGE");

      // Simulate a store that cannot produce the content it was asked for.
      const blobs = repository.blobs as unknown as { load: (id: string) => unknown };
      blobs.load = async () => undefined;

      await expect(git.reset().setRef(commitId).setMode(ResetMode.HARD).call()).rejects.toThrow(
        /data\.txt/,
      );
    });

    it("should leave EARLIER files untouched when a LATER file cannot be restored", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();
      // Two files; only the second one is unrestorable. Tree order is by name,
      // so "a.txt" is planned and would be written before "z-broken.txt".
      const commitId = await createCommit(workingCopy, "Add two files", {
        "a.txt": "content a",
        "z-broken.txt": "content z",
      });
      const worktree = worktreeOf(workingCopy);
      worktree.setFile("a.txt", "LOCAL GARBAGE A");

      // Only the LAST file's blob is unavailable. Without an up-front scan the
      // command would happily rewrite a.txt and only then discover it cannot
      // finish, leaving the working tree in a state matching no commit.
      const brokenId = await repository.blobs.store([new TextEncoder().encode("content z")]);
      const realHas = repository.blobs.has.bind(repository.blobs);
      const blobs = repository.blobs as unknown as {
        has: (id: string) => Promise<boolean>;
      };
      blobs.has = async (id: string) => (id === brokenId ? false : realHas(id));

      await expect(git.reset().setRef(commitId).setMode(ResetMode.HARD).call()).rejects.toThrow(
        /z-broken\.txt/,
      );

      // The real consequence: a.txt was never rewritten.
      expect(await readWorktreeText(worktree, "a.txt")).toBe("LOCAL GARBAGE A");
    });

    it("should refuse to restore a symlink rather than write it as a regular file", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();
      await createCommit(workingCopy, "Add data", { "data.txt": "committed content" });

      // Build a tree containing a symlink entry; the Worktree interface has no
      // way to create one, so restoring it faithfully is impossible.
      const targetBlob = await repository.blobs.store([new TextEncoder().encode("data.txt")]);
      const treeId = await repository.trees.store([
        { name: "link", mode: FileMode.SYMLINK, id: targetBlob },
      ]);
      const symlinkCommitId = await repository.commits.store({
        tree: treeId,
        parents: [],
        author: testAuthor(),
        committer: testAuthor(),
        message: "Symlink commit",
      });

      const worktree = worktreeOf(workingCopy);
      worktree.setFile("data.txt", "LOCAL GARBAGE");

      await expect(
        git.reset().setRef(symlinkCommitId).setMode(ResetMode.HARD).call(),
      ).rejects.toThrow(/symbolic links/);

      // It refused before writing anything, so "link" was not faked as a file.
      expect(await worktree.exists("link")).toBe(false);
    });

    it("should still move HEAD and staging for a repository with no worktree", async () => {
      const { git, workingCopy, repository } = await createInitializedGit();
      const baseId = await createCommit(workingCopy, "Base", { "keep.txt": "base content" });
      await createCommit(workingCopy, "Add extra", { "extra.txt": "extra content" });

      (workingCopy as { worktree?: Worktree }).worktree = undefined;

      await git.reset().setRef(baseId).setMode(ResetMode.HARD).call();

      const headRef = await repository.refs.resolve("HEAD");
      expect(headRef?.objectId).toBe(baseId);
      expect(await workingCopy.checkout.staging.getEntry("extra.txt")).toBeUndefined();
    });
  });
});
