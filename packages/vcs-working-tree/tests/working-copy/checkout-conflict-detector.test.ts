import { describe, expect, it } from "vitest";

import {
  createCheckoutConflictDetector,
  detectCheckoutConflicts,
} from "../../src/working-copy/checkout-conflict-detector.js";
import { CheckoutConflictType } from "../../src/working-copy/checkout-utils.js";
import { createMockStaging, createStagingEntry } from "../mocks/mock-staging-store.js";
import { createMockTreeStore } from "../mocks/mock-tree-store.js";
import { createMockWorktree, createWorktreeEntry } from "../mocks/mock-worktree.js";

describe("detectCheckoutConflicts", () => {
  describe("no conflicts", () => {
    it("returns empty result when HEAD and target are identical", async () => {
      const trees = createMockTreeStore({
        tree1: [{ name: "file.txt", id: "blob1", mode: 0o100644 }],
      });
      const staging = createMockStaging([createStagingEntry("file.txt", "blob1")]);
      const worktree = createMockWorktree(
        [createWorktreeEntry("file.txt")],
        new Map([["file.txt", "blob1"]]),
      );

      const result = await detectCheckoutConflicts({ trees, staging, worktree }, "tree1", "tree1");

      expect(result.canCheckout).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    it("returns empty result for empty repository", async () => {
      const trees = createMockTreeStore({
        empty: [],
      });
      const staging = createMockStaging([]);
      const worktree = createMockWorktree([]);

      const result = await detectCheckoutConflicts(
        { trees, staging, worktree },
        undefined,
        "empty",
      );

      expect(result.canCheckout).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    it("allows checkout when files are unchanged", async () => {
      const trees = createMockTreeStore({
        head: [{ name: "file.txt", id: "blob1", mode: 0o100644 }],
        target: [{ name: "file.txt", id: "blob2", mode: 0o100644 }],
      });
      const staging = createMockStaging([createStagingEntry("file.txt", "blob1")]);
      const worktree = createMockWorktree(
        [createWorktreeEntry("file.txt")],
        new Map([["file.txt", "blob1"]]),
      );

      const result = await detectCheckoutConflicts({ trees, staging, worktree }, "head", "target");

      expect(result.canCheckout).toBe(true);
    });
  });

  describe("dirty index conflicts", () => {
    it("detects staged changes that differ from HEAD", async () => {
      const trees = createMockTreeStore({
        head: [{ name: "file.txt", id: "blob1", mode: 0o100644 }],
        target: [{ name: "file.txt", id: "blob3", mode: 0o100644 }],
      });
      const staging = createMockStaging([
        createStagingEntry("file.txt", "blob2"), // Staged different from HEAD
      ]);
      const worktree = createMockWorktree(
        [createWorktreeEntry("file.txt")],
        new Map([["file.txt", "blob2"]]),
      );

      const result = await detectCheckoutConflicts({ trees, staging, worktree }, "head", "target");

      expect(result.canCheckout).toBe(false);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].type).toBe(CheckoutConflictType.DIRTY_INDEX);
      expect(result.conflicts[0].path).toBe("file.txt");
      expect(result.summary.dirtyIndex).toBe(1);
    });
  });

  describe("dirty worktree conflicts", () => {
    it("detects local modifications that would be overwritten", async () => {
      const trees = createMockTreeStore({
        head: [{ name: "file.txt", id: "blob1", mode: 0o100644 }],
        target: [{ name: "file.txt", id: "blob2", mode: 0o100644 }],
      });
      const staging = createMockStaging([
        createStagingEntry("file.txt", "blob1", 0, { size: 100 }),
      ]);
      const worktree = createMockWorktree(
        [createWorktreeEntry("file.txt", { size: 200 })], // Different size
        new Map([["file.txt", "modified-hash"]]),
      );

      const result = await detectCheckoutConflicts({ trees, staging, worktree }, "head", "target");

      expect(result.canCheckout).toBe(false);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].type).toBe(CheckoutConflictType.DIRTY_WORKTREE);
      expect(result.summary.dirtyWorktree).toBe(1);
    });

    it("detects file deleted in worktree", async () => {
      const trees = createMockTreeStore({
        head: [{ name: "file.txt", id: "blob1", mode: 0o100644 }],
        target: [{ name: "file.txt", id: "blob2", mode: 0o100644 }],
      });
      const staging = createMockStaging([createStagingEntry("file.txt", "blob1")]);
      const worktree = createMockWorktree([], new Map()); // File deleted

      const result = await detectCheckoutConflicts({ trees, staging, worktree }, "head", "target");

      expect(result.canCheckout).toBe(false);
      expect(result.conflicts[0].type).toBe(CheckoutConflictType.DIRTY_WORKTREE);
    });

    it("detects modified file would be deleted by checkout", async () => {
      const trees = createMockTreeStore({
        head: [{ name: "file.txt", id: "blob1", mode: 0o100644 }],
        target: [], // File will be deleted
      });
      const staging = createMockStaging([
        createStagingEntry("file.txt", "blob1", 0, { size: 100 }),
      ]);
      const worktree = createMockWorktree(
        [createWorktreeEntry("file.txt", { size: 200 })], // Modified
        new Map([["file.txt", "modified-hash"]]),
      );

      const result = await detectCheckoutConflicts({ trees, staging, worktree }, "head", "target");

      expect(result.canCheckout).toBe(false);
      expect(result.conflicts[0].type).toBe(CheckoutConflictType.DIRTY_WORKTREE);
      expect(result.conflicts[0].message).toContain("deleted");
    });
  });

  describe("untracked file conflicts", () => {
    it("detects untracked file would be overwritten", async () => {
      const trees = createMockTreeStore({
        head: [],
        target: [{ name: "new-file.txt", id: "blob1", mode: 0o100644 }],
      });
      const staging = createMockStaging([]);
      const worktree = createMockWorktree([createWorktreeEntry("new-file.txt")], new Map());

      const result = await detectCheckoutConflicts({ trees, staging, worktree }, "head", "target");

      expect(result.canCheckout).toBe(false);
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].type).toBe(CheckoutConflictType.UNTRACKED_FILE);
      expect(result.summary.untrackedFiles).toBe(1);
    });

    it("ignores ignored files", async () => {
      const trees = createMockTreeStore({
        head: [],
        target: [{ name: "build/output.txt", id: "blob1", mode: 0o100644 }],
      });
      const staging = createMockStaging([]);
      const worktree = createMockWorktree(
        [createWorktreeEntry("build/output.txt", { isIgnored: true })],
        new Map(),
      );

      const result = await detectCheckoutConflicts({ trees, staging, worktree }, "head", "target");

      expect(result.canCheckout).toBe(true);
      expect(result.conflicts).toHaveLength(0);
    });

    it("can skip untracked file check", async () => {
      const trees = createMockTreeStore({
        head: [],
        target: [{ name: "new-file.txt", id: "blob1", mode: 0o100644 }],
      });
      const staging = createMockStaging([]);
      const worktree = createMockWorktree([createWorktreeEntry("new-file.txt")], new Map());

      const result = await detectCheckoutConflicts({ trees, staging, worktree }, "head", "target", {
        skipUntracked: true,
      });

      expect(result.canCheckout).toBe(true);
    });
  });

  describe("path filtering", () => {
    it("only checks specified paths", async () => {
      const trees = createMockTreeStore({
        head: [{ name: "src", id: "tree-src", mode: 0o040000 }],
        "tree-src": [{ name: "file.txt", id: "blob1", mode: 0o100644 }],
        target: [{ name: "src", id: "tree-src-new", mode: 0o040000 }],
        "tree-src-new": [{ name: "file.txt", id: "blob2", mode: 0o100644 }],
      });
      const staging = createMockStaging([
        createStagingEntry("src/file.txt", "modified", 0, { size: 100 }),
      ]);
      const worktree = createMockWorktree(
        [createWorktreeEntry("src/file.txt", { size: 200 })],
        new Map([["src/file.txt", "modified-hash"]]),
      );

      // Without path filter - should detect conflict
      const result1 = await detectCheckoutConflicts({ trees, staging, worktree }, "head", "target");
      expect(result1.canCheckout).toBe(false);

      // With path filter excluding the conflicting path
      const result2 = await detectCheckoutConflicts(
        { trees, staging, worktree },
        "head",
        "target",
        { paths: ["docs"] },
      );
      expect(result2.canCheckout).toBe(true);
    });
  });

  describe("multiple conflicts", () => {
    it("reports all conflicts", async () => {
      const trees = createMockTreeStore({
        head: [
          { name: "staged.txt", id: "blob1", mode: 0o100644 },
          { name: "modified.txt", id: "blob2", mode: 0o100644 },
        ],
        target: [
          { name: "staged.txt", id: "blob-new1", mode: 0o100644 },
          { name: "modified.txt", id: "blob-new2", mode: 0o100644 },
          { name: "untracked.txt", id: "blob3", mode: 0o100644 },
        ],
      });
      const staging = createMockStaging([
        createStagingEntry("staged.txt", "staged-change"),
        createStagingEntry("modified.txt", "blob2", 0, { size: 100 }),
      ]);
      const worktree = createMockWorktree(
        [
          createWorktreeEntry("staged.txt"),
          createWorktreeEntry("modified.txt", { size: 200 }),
          createWorktreeEntry("untracked.txt"),
        ],
        new Map([
          ["staged.txt", "staged-change"],
          ["modified.txt", "modified-hash"],
        ]),
      );

      const result = await detectCheckoutConflicts({ trees, staging, worktree }, "head", "target");

      expect(result.canCheckout).toBe(false);
      expect(result.conflicts.length).toBeGreaterThanOrEqual(2);
      expect(result.summary.dirtyIndex).toBe(1);
      expect(result.summary.dirtyWorktree).toBe(1);
      expect(result.summary.untrackedFiles).toBe(1);
    });
  });
});

describe("createCheckoutConflictDetector", () => {
  it("creates a pre-bound detector function", async () => {
    const trees = createMockTreeStore({
      head: [{ name: "file.txt", id: "blob1", mode: 0o100644 }],
      target: [{ name: "file.txt", id: "blob1", mode: 0o100644 }],
    });
    const staging = createMockStaging([createStagingEntry("file.txt", "blob1")]);
    const worktree = createMockWorktree(
      [createWorktreeEntry("file.txt")],
      new Map([["file.txt", "blob1"]]),
    );

    const detect = createCheckoutConflictDetector({ trees, staging, worktree });
    const result = await detect("head", "target");

    expect(result.canCheckout).toBe(true);
  });
});
