/**
 * Parametrized test suite for StashStore implementations
 *
 * This suite tests the core StashStore interface contract.
 * All storage implementations must pass these tests.
 *
 * Note: StashStore operations require a working repository context
 * with staging area and commits. This suite tests the interface
 * contract for stores that support standalone stash operations.
 */

import type { StashEntry, StashStore } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Context provided by the storage factory
 */
export interface StashStoreTestContext {
  stashStore: StashStore;
  /**
   * Helper to set up staged changes that can be stashed.
   * Implementations should stage some changes before stash operations.
   */
  setupStagedChanges?: () => Promise<void>;
  cleanup?: () => Promise<void>;
}

/**
 * Factory function to create a storage instance for testing
 */
export type StashStoreFactory = () => Promise<StashStoreTestContext>;

/**
 * Helper to collect async iterable to array
 */
async function toArray<T>(input: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of input) {
    result.push(item);
  }
  return result;
}

/**
 * Create the StashStore test suite with a specific factory
 *
 * @param name Name of the storage implementation (e.g., "Memory", "Git")
 * @param factory Factory function to create storage instances
 */
export function createStashStoreTests(name: string, factory: StashStoreFactory): void {
  describe(`StashStore [${name}]`, () => {
    let ctx: StashStoreTestContext;

    beforeEach(async () => {
      ctx = await factory();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    describe("List Operations", () => {
      it("list returns empty for new repository", async () => {
        const stashes = await toArray(ctx.stashStore.list());
        expect(stashes.length).toBe(0);
      });

      it("list returns stash entries after push", async () => {
        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }

        await ctx.stashStore.push("Test stash");
        const stashes = await toArray(ctx.stashStore.list());

        expect(stashes.length).toBe(1);
        expect(stashes[0].index).toBe(0);
        expect(stashes[0].message).toContain("Test stash");
      });

      it("list returns stashes in order (newest first)", async () => {
        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }

        await ctx.stashStore.push("First stash");

        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }

        await ctx.stashStore.push("Second stash");
        const stashes = await toArray(ctx.stashStore.list());

        expect(stashes.length).toBe(2);
        expect(stashes[0].index).toBe(0);
        expect(stashes[0].message).toContain("Second stash");
        expect(stashes[1].index).toBe(1);
        expect(stashes[1].message).toContain("First stash");
      });
    });

    describe("Push Operation", () => {
      it("push creates stash entry with message", async () => {
        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }

        const commitId = await ctx.stashStore.push("My stash message");

        expect(commitId).toMatch(/^[0-9a-f]{40}$/);

        const stashes = await toArray(ctx.stashStore.list());
        expect(stashes.length).toBe(1);
        expect(stashes[0].message).toContain("My stash message");
      });

      it("push with options object", async () => {
        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }

        const commitId = await ctx.stashStore.push({ message: "Options stash" });

        expect(commitId).toMatch(/^[0-9a-f]{40}$/);

        const stashes = await toArray(ctx.stashStore.list());
        expect(stashes.length).toBe(1);
      });

      it("push without message uses default", async () => {
        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }

        const commitId = await ctx.stashStore.push();

        expect(commitId).toMatch(/^[0-9a-f]{40}$/);

        const stashes = await toArray(ctx.stashStore.list());
        expect(stashes.length).toBe(1);
        // Default message should contain "WIP" or similar
        expect(stashes[0].message.length).toBeGreaterThan(0);
      });
    });

    describe("Pop Operation", () => {
      it("pop restores and removes most recent stash", async () => {
        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }

        await ctx.stashStore.push("To be popped");

        let stashes = await toArray(ctx.stashStore.list());
        expect(stashes.length).toBe(1);

        await ctx.stashStore.pop();

        stashes = await toArray(ctx.stashStore.list());
        expect(stashes.length).toBe(0);
      });

      it("pop throws when stash is empty", async () => {
        await expect(ctx.stashStore.pop()).rejects.toThrow();
      });
    });

    describe("Apply Operation", () => {
      it("apply restores stash without removing it", async () => {
        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }

        await ctx.stashStore.push("To be applied");

        await ctx.stashStore.apply();

        // Stash should still exist
        const stashes = await toArray(ctx.stashStore.list());
        expect(stashes.length).toBe(1);
      });

      it("apply with index applies specific stash", async () => {
        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }
        await ctx.stashStore.push("First");

        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }
        await ctx.stashStore.push("Second");

        // Apply index 1 (first stash)
        await ctx.stashStore.apply(1);

        // Both stashes should still exist
        const stashes = await toArray(ctx.stashStore.list());
        expect(stashes.length).toBe(2);
      });

      it("apply throws for invalid index", async () => {
        await expect(ctx.stashStore.apply(99)).rejects.toThrow();
      });
    });

    describe("Drop Operation", () => {
      it("drop removes most recent stash by default", async () => {
        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }

        await ctx.stashStore.push("First");

        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }

        await ctx.stashStore.push("Second");

        await ctx.stashStore.drop();

        const stashes = await toArray(ctx.stashStore.list());
        expect(stashes.length).toBe(1);
        expect(stashes[0].message).toContain("First");
      });

      it("drop with index removes specific stash", async () => {
        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }
        await ctx.stashStore.push("First");

        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }
        await ctx.stashStore.push("Second");

        // Drop index 1 (first stash)
        await ctx.stashStore.drop(1);

        const stashes = await toArray(ctx.stashStore.list());
        expect(stashes.length).toBe(1);
        expect(stashes[0].message).toContain("Second");
      });

      it("drop throws for invalid index", async () => {
        await expect(ctx.stashStore.drop(99)).rejects.toThrow();
      });

      it("drop throws when stash is empty", async () => {
        await expect(ctx.stashStore.drop()).rejects.toThrow();
      });
    });

    describe("Clear Operation", () => {
      it("clear removes all stashes", async () => {
        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }
        await ctx.stashStore.push("First");

        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }
        await ctx.stashStore.push("Second");

        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }
        await ctx.stashStore.push("Third");

        await ctx.stashStore.clear();

        const stashes = await toArray(ctx.stashStore.list());
        expect(stashes.length).toBe(0);
      });

      it("clear on empty stash does not throw", async () => {
        await expect(ctx.stashStore.clear()).resolves.not.toThrow();
      });
    });

    describe("Stash Entry Properties", () => {
      it("stash entry has required properties", async () => {
        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }

        await ctx.stashStore.push("Test entry");
        const stashes = await toArray(ctx.stashStore.list());
        const entry: StashEntry = stashes[0];

        expect(typeof entry.index).toBe("number");
        expect(entry.index).toBe(0);
        expect(typeof entry.commitId).toBe("string");
        expect(entry.commitId).toMatch(/^[0-9a-f]{40}$/);
        expect(typeof entry.message).toBe("string");
        expect(typeof entry.timestamp).toBe("number");
        expect(entry.timestamp).toBeGreaterThan(0);
      });

      it("stash entries have sequential indices", async () => {
        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }
        await ctx.stashStore.push("First");

        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }
        await ctx.stashStore.push("Second");

        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }
        await ctx.stashStore.push("Third");

        const stashes = await toArray(ctx.stashStore.list());
        expect(stashes[0].index).toBe(0);
        expect(stashes[1].index).toBe(1);
        expect(stashes[2].index).toBe(2);
      });
    });

    describe("Edge Cases", () => {
      it("handles multiple push/pop cycles", async () => {
        for (let i = 0; i < 3; i++) {
          if (ctx.setupStagedChanges) {
            await ctx.setupStagedChanges();
          }
          await ctx.stashStore.push(`Cycle ${i}`);
          await ctx.stashStore.pop();
        }

        const stashes = await toArray(ctx.stashStore.list());
        expect(stashes.length).toBe(0);
      });

      it("handles stash with special characters in message", async () => {
        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }

        await ctx.stashStore.push("Special: @#$%^&*()");

        const stashes = await toArray(ctx.stashStore.list());
        expect(stashes.length).toBe(1);
      });

      it("handles stash with newlines in message", async () => {
        if (ctx.setupStagedChanges) {
          await ctx.setupStagedChanges();
        }

        await ctx.stashStore.push("Line 1\nLine 2\nLine 3");

        const stashes = await toArray(ctx.stashStore.list());
        expect(stashes.length).toBe(1);
      });
    });
  });
}
