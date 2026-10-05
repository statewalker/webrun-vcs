/**
 * Parametrized test suite for Staging implementations
 *
 * This suite tests the core Staging interface contract.
 * All storage implementations must pass these tests.
 */

import type { Trees } from "@statewalker/vcs-core";
import { FileMode } from "@statewalker/vcs-core";
import type { Staging, StagingEntry, StagingEntryOptions } from "@statewalker/vcs-working-tree";
import { MergeStage } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Context provided by the storage factory
 */
export interface StagingStoreTestContext {
  stagingStore: Staging;
  trees?: Trees;
  cleanup?: () => Promise<void>;
}

/**
 * Factory function to create a storage instance for testing
 */
export type StagingStoreFactory = () => Promise<StagingStoreTestContext>;

/**
 * Helper function to generate a fake object ID (for testing)
 */
function fakeObjectId(seed: string): string {
  return seed.padEnd(40, "0").slice(0, 40);
}

/**
 * Helper function to create a staging entry
 */
function createEntry(path: string, options?: Partial<StagingEntryOptions>): StagingEntryOptions {
  return {
    path,
    mode: options?.mode ?? FileMode.REGULAR_FILE,
    objectId: options?.objectId ?? fakeObjectId(path),
    stage: options?.stage ?? MergeStage.MERGED,
    size: options?.size ?? 100,
    mtime: options?.mtime ?? Date.now(),
  };
}

/**
 * Helper function to collect staging entries into an array
 */
async function collectEntries(iterable: AsyncIterable<StagingEntry>): Promise<StagingEntry[]> {
  const entries: StagingEntry[] = [];
  for await (const entry of iterable) {
    entries.push(entry);
  }
  return entries;
}

/**
 * Create the StagingStore test suite with a specific factory
 *
 * @param name Name of the storage implementation (e.g., "Memory", "SQL", "KV")
 * @param factory Factory function to create storage instances
 */
export function createStagingStoreTests(name: string, factory: StagingStoreFactory): void {
  describe(`StagingStore [${name}]`, () => {
    let ctx: StagingStoreTestContext;

    beforeEach(async () => {
      ctx = await factory();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    describe("Builder Pattern", () => {
      it("adds entries via builder", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("file.txt"));
        builder.add(createEntry("dir/nested.txt"));
        await builder.finish();

        expect(await ctx.stagingStore.hasEntry("file.txt")).toBe(true);
        expect(await ctx.stagingStore.hasEntry("dir/nested.txt")).toBe(true);
      });

      it("replaces all entries on builder finish", async () => {
        // Initial entries
        const builder1 = ctx.stagingStore.createBuilder();
        builder1.add(createEntry("old.txt"));
        await builder1.finish();

        // Replace with new entries
        const builder2 = ctx.stagingStore.createBuilder();
        builder2.add(createEntry("new.txt"));
        await builder2.finish();

        expect(await ctx.stagingStore.hasEntry("old.txt")).toBe(false);
        expect(await ctx.stagingStore.hasEntry("new.txt")).toBe(true);
      });

      it("keeps specified entries from existing index", async () => {
        // Initial entries
        const builder1 = ctx.stagingStore.createBuilder();
        builder1.add(createEntry("keep.txt"));
        builder1.add(createEntry("remove.txt"));
        await builder1.finish();

        // Build new index, keeping first entry
        const builder2 = ctx.stagingStore.createBuilder();
        builder2.keep(0, 1); // Keep first entry
        builder2.add(createEntry("new.txt"));
        await builder2.finish();

        expect(await ctx.stagingStore.hasEntry("keep.txt")).toBe(true);
        expect(await ctx.stagingStore.hasEntry("remove.txt")).toBe(false);
        expect(await ctx.stagingStore.hasEntry("new.txt")).toBe(true);
      });

      it("throws on duplicate entries", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("file.txt"));
        builder.add(createEntry("file.txt")); // Duplicate

        await expect(builder.finish()).rejects.toThrow();
      });

      it("validates stage constraints", async () => {
        const builder = ctx.stagingStore.createBuilder();
        // Stage 0 cannot coexist with other stages for same path
        builder.add(createEntry("file.txt", { stage: MergeStage.MERGED }));
        builder.add(createEntry("file.txt", { stage: MergeStage.OURS }));

        await expect(builder.finish()).rejects.toThrow();
      });
    });

    describe("Entry Retrieval", () => {
      it("gets entry by path", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("file.txt", { objectId: fakeObjectId("content") }));
        await builder.finish();

        const entry = await ctx.stagingStore.getEntry("file.txt");
        expect(entry).toBeDefined();
        expect(entry?.path).toBe("file.txt");
        expect(entry?.objectId).toBe(fakeObjectId("content"));
      });

      it("returns undefined for missing entry", async () => {
        const entry = await ctx.stagingStore.getEntry("nonexistent.txt");
        expect(entry).toBeUndefined();
      });

      it("gets entry by stage", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(
          createEntry("conflict.txt", { stage: MergeStage.BASE, objectId: fakeObjectId("base") }),
        );
        builder.add(
          createEntry("conflict.txt", { stage: MergeStage.OURS, objectId: fakeObjectId("ours") }),
        );
        builder.add(
          createEntry("conflict.txt", {
            stage: MergeStage.THEIRS,
            objectId: fakeObjectId("theirs"),
          }),
        );
        await builder.finish();

        const base = await ctx.stagingStore.getEntry("conflict.txt", MergeStage.BASE);
        const ours = await ctx.stagingStore.getEntry("conflict.txt", MergeStage.OURS);
        const theirs = await ctx.stagingStore.getEntry("conflict.txt", MergeStage.THEIRS);

        expect(base?.objectId).toBe(fakeObjectId("base"));
        expect(ours?.objectId).toBe(fakeObjectId("ours"));
        expect(theirs?.objectId).toBe(fakeObjectId("theirs"));
      });

      it("gets all entries for a path", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("conflict.txt", { stage: MergeStage.BASE }));
        builder.add(createEntry("conflict.txt", { stage: MergeStage.OURS }));
        builder.add(createEntry("conflict.txt", { stage: MergeStage.THEIRS }));
        await builder.finish();

        const entries = await ctx.stagingStore.getEntries("conflict.txt");
        expect(entries.length).toBe(3);
      });
    });

    describe("Entry Listing", () => {
      it("lists all entries", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("a.txt"));
        builder.add(createEntry("b.txt"));
        builder.add(createEntry("c.txt"));
        await builder.finish();

        const entries = await collectEntries(ctx.stagingStore.entries());
        expect(entries.length).toBe(3);
      });

      it("lists entries in sorted order", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("z.txt"));
        builder.add(createEntry("a.txt"));
        builder.add(createEntry("m.txt"));
        await builder.finish();

        const entries = await collectEntries(ctx.stagingStore.entries());
        expect(entries[0].path).toBe("a.txt");
        expect(entries[1].path).toBe("m.txt");
        expect(entries[2].path).toBe("z.txt");
      });

      /**
       * JGit: DirCacheBuilderTest.testAdd_InGitSortOrder
       * Git sort order uses byte comparison with special handling for '/'
       */
      it("maintains Git sort order with special characters", async () => {
        // Git sort order: a- < a.b < a/b < a0b
        const paths = ["a-", "a.b", "a/b", "a0b"];
        const builder = ctx.stagingStore.createBuilder();
        for (const path of paths) {
          builder.add(createEntry(path));
        }
        await builder.finish();

        const entries = await collectEntries(ctx.stagingStore.entries());
        expect(entries.length).toBe(4);
        expect(entries[0].path).toBe("a-");
        expect(entries[1].path).toBe("a.b");
        expect(entries[2].path).toBe("a/b");
        expect(entries[3].path).toBe("a0b");
      });

      /**
       * JGit: DirCacheBuilderTest.testAdd_ReverseGitSortOrder
       * Entries added in reverse order should still be sorted
       */
      it("sorts entries added in reverse order", async () => {
        const paths = ["a-", "a.b", "a/b", "a0b"];
        const builder = ctx.stagingStore.createBuilder();
        // Add in reverse order
        for (let i = paths.length - 1; i >= 0; i--) {
          builder.add(createEntry(paths[i]));
        }
        await builder.finish();

        const entries = await collectEntries(ctx.stagingStore.entries());
        expect(entries.length).toBe(4);
        expect(entries[0].path).toBe("a-");
        expect(entries[1].path).toBe("a.b");
        expect(entries[2].path).toBe("a/b");
        expect(entries[3].path).toBe("a0b");
      });

      /**
       * JGit: DirCacheBasicTest.testFindOnEmpty
       * Finding entry on empty cache returns undefined
       */
      it("returns undefined when finding entry on empty cache", async () => {
        const entry = await ctx.stagingStore.getEntry("nonexistent");
        expect(entry).toBeUndefined();
      });

      it("lists entries under prefix", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("src/a.txt"));
        builder.add(createEntry("src/b.txt"));
        builder.add(createEntry("test/c.txt"));
        await builder.finish();

        const srcEntries = await collectEntries(ctx.stagingStore.entries({ prefix: "src" }));
        expect(srcEntries.length).toBe(2);
        expect(srcEntries.every((e) => e.path.startsWith("src/"))).toBe(true);
      });

      it("returns entry count", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("a.txt"));
        builder.add(createEntry("b.txt"));
        await builder.finish();

        expect(await ctx.stagingStore.getEntryCount()).toBe(2);
      });

      it("returns zero for empty staging", async () => {
        expect(await ctx.stagingStore.getEntryCount()).toBe(0);
      });
    });

    describe("Conflict Detection", () => {
      it("detects conflicts", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("normal.txt", { stage: MergeStage.MERGED }));
        builder.add(createEntry("conflict.txt", { stage: MergeStage.BASE }));
        builder.add(createEntry("conflict.txt", { stage: MergeStage.OURS }));
        builder.add(createEntry("conflict.txt", { stage: MergeStage.THEIRS }));
        await builder.finish();

        expect(await ctx.stagingStore.hasConflicts()).toBe(true);
      });

      it("reports no conflicts when all stage 0", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("a.txt", { stage: MergeStage.MERGED }));
        builder.add(createEntry("b.txt", { stage: MergeStage.MERGED }));
        await builder.finish();

        expect(await ctx.stagingStore.hasConflicts()).toBe(false);
      });

      it("lists conflict paths", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("normal.txt", { stage: MergeStage.MERGED }));
        builder.add(createEntry("conflict1.txt", { stage: MergeStage.OURS }));
        builder.add(createEntry("conflict1.txt", { stage: MergeStage.THEIRS }));
        builder.add(createEntry("conflict2.txt", { stage: MergeStage.BASE }));
        builder.add(createEntry("conflict2.txt", { stage: MergeStage.OURS }));
        await builder.finish();

        const conflicts = await ctx.stagingStore.getConflictedPaths();

        expect(conflicts.length).toBe(2);
        expect(conflicts).toContain("conflict1.txt");
        expect(conflicts).toContain("conflict2.txt");
      });
    });

    describe("Clear", () => {
      it("clears all entries", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("file.txt"));
        await builder.finish();

        await ctx.stagingStore.clear();

        expect(await ctx.stagingStore.getEntryCount()).toBe(0);
        expect(await ctx.stagingStore.hasEntry("file.txt")).toBe(false);
      });

      /**
       * JGit: DirCacheBuilderTest.testBuilderClear
       * Finishing an empty builder clears all existing entries
       */
      it("clears entries when empty builder is finished", async () => {
        // Add some entries first
        const builder1 = ctx.stagingStore.createBuilder();
        builder1.add(createEntry("a-"));
        builder1.add(createEntry("a.b"));
        builder1.add(createEntry("a/b"));
        builder1.add(createEntry("a0b"));
        await builder1.finish();

        expect(await ctx.stagingStore.getEntryCount()).toBe(4);

        // Finish an empty builder - should clear everything
        const builder2 = ctx.stagingStore.createBuilder();
        await builder2.finish();

        expect(await ctx.stagingStore.getEntryCount()).toBe(0);
      });

      /**
       * JGit: DirCacheBasicTest.testBuildThenClear
       * Build entries, verify hasConflicts, then clear
       */
      it("clears conflict state after clear", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("file.txt", { stage: MergeStage.OURS }));
        builder.add(createEntry("file.txt", { stage: MergeStage.THEIRS }));
        await builder.finish();

        expect(await ctx.stagingStore.hasConflicts()).toBe(true);

        await ctx.stagingStore.clear();

        expect(await ctx.stagingStore.getEntryCount()).toBe(0);
        expect(await ctx.stagingStore.hasConflicts()).toBe(false);
      });
    });

    describe("Editor Pattern", () => {
      it("updates existing entry via editor", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("file.txt", { objectId: fakeObjectId("old") }));
        await builder.finish();

        const editor = ctx.stagingStore.createEditor();
        editor.add({
          path: "file.txt",
          apply: (_existing) => ({
            path: "file.txt",
            mode: FileMode.REGULAR_FILE,
            objectId: fakeObjectId("new"),
            stage: MergeStage.MERGED,
            size: 100,
            mtime: Date.now(),
          }),
        });
        await editor.finish();

        const entry = await ctx.stagingStore.getEntry("file.txt");
        expect(entry?.objectId).toBe(fakeObjectId("new"));
      });

      it("deletes entry via editor returning undefined", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("file.txt"));
        await builder.finish();

        const editor = ctx.stagingStore.createEditor();
        editor.add({
          path: "file.txt",
          apply: () => undefined,
        });
        await editor.finish();

        expect(await ctx.stagingStore.hasEntry("file.txt")).toBe(false);
      });

      it("adds new entry via editor", async () => {
        const editor = ctx.stagingStore.createEditor();
        editor.add({
          path: "new.txt",
          apply: () => ({
            path: "new.txt",
            mode: FileMode.REGULAR_FILE,
            objectId: fakeObjectId("new"),
            stage: MergeStage.MERGED,
            size: 100,
            mtime: Date.now(),
          }),
        });
        await editor.finish();

        expect(await ctx.stagingStore.hasEntry("new.txt")).toBe(true);
      });
    });

    describe("Entry Properties", () => {
      it("preserves file mode", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("exec.sh", { mode: FileMode.EXECUTABLE_FILE }));
        builder.add(createEntry("regular.txt", { mode: FileMode.REGULAR_FILE }));
        builder.add(createEntry("link", { mode: FileMode.SYMLINK }));
        await builder.finish();

        expect((await ctx.stagingStore.getEntry("exec.sh"))?.mode).toBe(FileMode.EXECUTABLE_FILE);
        expect((await ctx.stagingStore.getEntry("regular.txt"))?.mode).toBe(FileMode.REGULAR_FILE);
        expect((await ctx.stagingStore.getEntry("link"))?.mode).toBe(FileMode.SYMLINK);
      });

      it("preserves size", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("file.txt", { size: 12345 }));
        await builder.finish();

        expect((await ctx.stagingStore.getEntry("file.txt"))?.size).toBe(12345);
      });

      it("preserves mtime", async () => {
        const mtime = 1234567890000;
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("file.txt", { mtime }));
        await builder.finish();

        expect((await ctx.stagingStore.getEntry("file.txt"))?.mtime).toBe(mtime);
      });

      it("preserves optional flags", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add({
          ...createEntry("file.txt"),
          assumeValid: true,
          intentToAdd: true,
          skipWorktree: true,
        });
        await builder.finish();

        const entry = await ctx.stagingStore.getEntry("file.txt");
        expect(entry?.assumeValid).toBe(true);
        expect(entry?.intentToAdd).toBe(true);
        expect(entry?.skipWorktree).toBe(true);
      });
    });

    describe("Tree Operations", () => {
      it("writes tree from staging area", async () => {
        if (!ctx.trees) {
          // Skip test if treeStore not provided
          return;
        }

        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("file.txt"));
        builder.add(createEntry("dir/nested.txt"));
        await builder.finish();

        const treeId = await ctx.stagingStore.writeTree(ctx.trees);
        expect(treeId).toBeDefined();
        expect(typeof treeId).toBe("string");
      });

      it("throws writeTree with conflicts", async () => {
        if (!ctx.trees) {
          // Skip test if treeStore not provided
          return;
        }

        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("conflict.txt", { stage: MergeStage.OURS }));
        builder.add(createEntry("conflict.txt", { stage: MergeStage.THEIRS }));
        await builder.finish();

        await expect(ctx.stagingStore.writeTree(ctx.trees)).rejects.toThrow();
      });

      it("reads tree into staging area", async () => {
        if (!ctx.trees) {
          // Skip test if treeStore not provided
          return;
        }

        // Create a tree first
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("file.txt", { objectId: fakeObjectId("content") }));
        await builder.finish();

        const treeId = await ctx.stagingStore.writeTree(ctx.trees);

        // Clear and read back
        await ctx.stagingStore.clear();
        await ctx.stagingStore.readTree(ctx.trees, treeId);

        expect(await ctx.stagingStore.hasEntry("file.txt")).toBe(true);
      });
    });

    describe("Persistence", () => {
      it("read and write do not throw", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("file.txt"));
        await builder.finish();

        await expect(ctx.stagingStore.write()).resolves.not.toThrow();
        await expect(ctx.stagingStore.read()).resolves.not.toThrow();
      });

      it("isOutdated returns boolean", async () => {
        const result = await ctx.stagingStore.isOutdated();
        expect(typeof result).toBe("boolean");
      });

      it("getUpdateTime returns number", async () => {
        const result = ctx.stagingStore.getUpdateTime();
        expect(typeof result).toBe("number");
      });
    });

    describe("Path Handling", () => {
      it("handles deep nested paths", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("a/b/c/d/e/file.txt"));
        await builder.finish();

        expect(await ctx.stagingStore.hasEntry("a/b/c/d/e/file.txt")).toBe(true);
      });

      it("handles unicode paths", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("文件夹/文件.txt"));
        builder.add(createEntry("папка/файл.txt"));
        await builder.finish();

        expect(await ctx.stagingStore.hasEntry("文件夹/文件.txt")).toBe(true);
        expect(await ctx.stagingStore.hasEntry("папка/файл.txt")).toBe(true);
      });

      it("handles paths with special characters", async () => {
        const builder = ctx.stagingStore.createBuilder();
        builder.add(createEntry("file-name_test.txt"));
        builder.add(createEntry("file.multiple.dots.txt"));
        await builder.finish();

        expect(await ctx.stagingStore.hasEntry("file-name_test.txt")).toBe(true);
        expect(await ctx.stagingStore.hasEntry("file.multiple.dots.txt")).toBe(true);
      });
    });
  });
}
