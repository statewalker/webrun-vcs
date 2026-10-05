/**
 * Tests for CleanCommand
 *
 * These tests assert the *real consequence* of a clean: whether an untracked
 * file that exists in the worktree before the call is still there after it.
 * A result object with a plausible shape is not evidence that anything was
 * deleted, so every assertion here goes through `worktree.exists()`.
 *
 * Tests run against all storage backends (Memory, SQL).
 */

import type { Worktree } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";

import type { MockWorktree } from "./mock-worktree-store.js";
import { backends, createCommit, createInitializedGitFromFactory } from "./test-helper.js";

/**
 * Get the WorkingCopy's worktree as the mock, which exposes test-only setters.
 */
function asMock(worktree: Worktree | undefined): MockWorktree {
  if (!worktree) throw new Error("test setup: WorkingCopy has no worktree");
  return worktree as MockWorktree;
}

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

describe.each(backends)("CleanCommand ($name backend)", ({ factory }) => {
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

  /**
   * Repository with one *real* tracked file (committed with real content, not
   * the empty initial tree) plus one untracked file sitting in the worktree.
   */
  async function withTrackedAndUntracked() {
    const ctx = await createInitializedGit();
    await createCommit(ctx.workingCopy, "Add tracked file", {
      "tracked.txt": "tracked content",
    });

    const worktree = asMock(ctx.workingCopy.worktree);
    worktree.setFile("tracked.txt", "tracked content");
    worktree.setFile("junk.log", "untracked garbage");

    // Guard the fixture itself: both files must really be on the worktree.
    expect(await worktree.exists("tracked.txt")).toBe(true);
    expect(await worktree.exists("junk.log")).toBe(true);

    return { ...ctx, worktree };
  }

  describe("dryRun: false — actually deletes", () => {
    it("should remove the untracked file from the worktree", async () => {
      const { git, worktree } = await withTrackedAndUntracked();

      const result = await git.clean().setDryRun(false).call();

      // The real consequence: the file is gone from the worktree.
      expect(await worktree.exists("junk.log")).toBe(false);
      expect(result.cleaned.has("junk.log")).toBe(true);
    });

    it("should report dryRun: false — the caller's request, not a constant", async () => {
      const { git } = await withTrackedAndUntracked();

      const result = await git.clean().setDryRun(false).call();

      expect(result.dryRun).toBe(false);
    });

    it("should never delete a tracked file", async () => {
      const { git, worktree } = await withTrackedAndUntracked();

      await git.clean().setDryRun(false).call();

      expect(await worktree.exists("tracked.txt")).toBe(true);
      expect(await readWorktreeText(worktree, "tracked.txt")).toBe("tracked content");
    });

    it("should not delete untracked files outside the requested paths", async () => {
      const { git, worktree } = await withTrackedAndUntracked();
      worktree.setFile("build/out.o", "other garbage");

      await git
        .clean()
        .setDryRun(false)
        .setPaths(new Set(["build"]))
        .call();

      expect(await worktree.exists("build/out.o")).toBe(false);
      expect(await worktree.exists("junk.log")).toBe(true);
    });

    it("should not delete an ignored file while ignore is respected", async () => {
      const { git, worktree } = await withTrackedAndUntracked();
      worktree.setFile("secret.env", "ignored content");
      worktree.setIgnored("secret.env");

      await git.clean().setDryRun(false).call();

      expect(await worktree.exists("secret.env")).toBe(true);
      expect(await worktree.exists("junk.log")).toBe(false);
    });
  });

  describe("dryRun: true — the safe default path", () => {
    it("should leave the untracked file in place when dryRun is explicitly true", async () => {
      const { git, worktree } = await withTrackedAndUntracked();

      const result = await git.clean().setDryRun(true).call();

      // Reported as cleanable, but still present: nothing was destroyed.
      expect(result.cleaned.has("junk.log")).toBe(true);
      expect(await worktree.exists("junk.log")).toBe(true);
      expect(result.dryRun).toBe(true);
    });

    it("should leave the untracked file in place when dryRun is not set at all", async () => {
      const { git, worktree } = await withTrackedAndUntracked();

      const result = await git.clean().call();

      expect(await worktree.exists("junk.log")).toBe(true);
      expect(result.dryRun).toBe(true);
    });
  });

  describe("preconditions", () => {
    it("should throw when the WorkingCopy has no worktree", async () => {
      const { git, workingCopy } = await createInitializedGit();
      (workingCopy as { worktree?: Worktree }).worktree = undefined;

      await expect(git.clean().setDryRun(false).call()).rejects.toThrow(/worktree/i);
    });
  });
});
