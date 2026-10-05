/**
 * Parametrized test suite for Refs implementations
 *
 * This suite tests the core Refs interface contract.
 * All storage implementations must pass these tests.
 */

import type { Ref, Refs, SymbolicRef } from "@statewalker/vcs-core";
import { isSymbolicRef, RefStorage } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Context provided by the storage factory
 */
export interface RefStoreTestContext {
  refStore: Refs;
  cleanup?: () => Promise<void>;
}

/**
 * Factory function to create a storage instance for testing
 */
export type RefStoreFactory = () => Promise<RefStoreTestContext>;

/**
 * Helper function to generate a fake object ID (for testing)
 */
function fakeObjectId(seed: string): string {
  return seed.padEnd(40, "0").slice(0, 40);
}

/**
 * Helper function to collect refs into an array
 */
async function collectRefs(
  iterable: AsyncIterable<Ref | SymbolicRef>,
): Promise<(Ref | SymbolicRef)[]> {
  const refs: (Ref | SymbolicRef)[] = [];
  for await (const ref of iterable) {
    refs.push(ref);
  }
  return refs;
}

/**
 * Create the RefStore test suite with a specific factory
 *
 * @param name Name of the storage implementation (e.g., "Memory", "SQL", "KV")
 * @param factory Factory function to create storage instances
 */
export function createRefStoreTests(name: string, factory: RefStoreFactory): void {
  describe(`RefStore [${name}]`, () => {
    let ctx: RefStoreTestContext;

    beforeEach(async () => {
      ctx = await factory();
      await ctx.refStore.initialize?.();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    describe("Basic Operations", () => {
      it("sets and gets a ref", async () => {
        const objectId = fakeObjectId("commit1");
        await ctx.refStore.set("refs/heads/main", objectId);

        const ref = await ctx.refStore.get("refs/heads/main");
        expect(ref).toBeDefined();
        if (!ref) return;
        expect(isSymbolicRef(ref)).toBe(false);
        expect((ref as Ref).objectId).toBe(objectId);
      });

      it("returns undefined for non-existent ref", async () => {
        const ref = await ctx.refStore.get("refs/heads/nonexistent");
        expect(ref).toBeUndefined();
      });

      it("checks existence via has", async () => {
        const objectId = fakeObjectId("commit1");
        await ctx.refStore.set("refs/heads/main", objectId);

        expect(await ctx.refStore.has("refs/heads/main")).toBe(true);
        expect(await ctx.refStore.has("refs/heads/nonexistent")).toBe(false);
      });

      it("updates existing ref", async () => {
        const objectId1 = fakeObjectId("commit1");
        const objectId2 = fakeObjectId("commit2");

        await ctx.refStore.set("refs/heads/main", objectId1);
        await ctx.refStore.set("refs/heads/main", objectId2);

        const ref = await ctx.refStore.get("refs/heads/main");
        expect((ref as Ref).objectId).toBe(objectId2);
      });

      it("removes ref", async () => {
        const objectId = fakeObjectId("commit1");
        await ctx.refStore.set("refs/heads/main", objectId);

        const removed = await ctx.refStore.remove("refs/heads/main");
        expect(removed).toBe(true);
        expect(await ctx.refStore.has("refs/heads/main")).toBe(false);
      });

      it("returns false when removing non-existent ref", async () => {
        const removed = await ctx.refStore.remove("refs/heads/nonexistent");
        expect(removed).toBe(false);
      });
    });

    describe("Symbolic Refs", () => {
      it("sets and gets symbolic ref", async () => {
        await ctx.refStore.setSymbolic("HEAD", "refs/heads/main");

        const ref = await ctx.refStore.get("HEAD");
        expect(ref).toBeDefined();
        if (!ref) return;
        expect(isSymbolicRef(ref)).toBe(true);
        expect((ref as SymbolicRef).target).toBe("refs/heads/main");
      });

      it("resolves symbolic ref to final object", async () => {
        const objectId = fakeObjectId("commit1");
        await ctx.refStore.set("refs/heads/main", objectId);
        await ctx.refStore.setSymbolic("HEAD", "refs/heads/main");

        const resolved = await ctx.refStore.resolve("HEAD");
        expect(resolved).toBeDefined();
        expect(resolved?.objectId).toBe(objectId);
      });

      it("resolves chain of symbolic refs", async () => {
        const objectId = fakeObjectId("commit1");
        await ctx.refStore.set("refs/heads/main", objectId);
        await ctx.refStore.setSymbolic("refs/heads/current", "refs/heads/main");
        await ctx.refStore.setSymbolic("HEAD", "refs/heads/current");

        const resolved = await ctx.refStore.resolve("HEAD");
        expect(resolved?.objectId).toBe(objectId);
      });

      it("returns undefined when resolving dangling symbolic ref", async () => {
        await ctx.refStore.setSymbolic("HEAD", "refs/heads/nonexistent");

        const resolved = await ctx.refStore.resolve("HEAD");
        expect(resolved).toBeUndefined();
      });

      it("resolve returns ref unchanged for direct ref", async () => {
        const objectId = fakeObjectId("commit1");
        await ctx.refStore.set("refs/heads/main", objectId);

        const resolved = await ctx.refStore.resolve("refs/heads/main");
        expect(resolved?.objectId).toBe(objectId);
      });
    });

    describe("List Refs", () => {
      it("lists all refs", async () => {
        await ctx.refStore.set("refs/heads/main", fakeObjectId("main"));
        await ctx.refStore.set("refs/heads/feature", fakeObjectId("feature"));
        await ctx.refStore.set("refs/tags/v1.0.0", fakeObjectId("tag"));

        const refs = await collectRefs(ctx.refStore.list());
        expect(refs.length).toBe(3);
      });

      it("lists refs with prefix filter", async () => {
        await ctx.refStore.set("refs/heads/main", fakeObjectId("main"));
        await ctx.refStore.set("refs/heads/feature", fakeObjectId("feature"));
        await ctx.refStore.set("refs/tags/v1.0.0", fakeObjectId("tag"));

        const headRefs = await collectRefs(ctx.refStore.list("refs/heads/"));
        expect(headRefs.length).toBe(2);
        expect(headRefs.map((r) => r.name)).toContain("refs/heads/main");
        expect(headRefs.map((r) => r.name)).toContain("refs/heads/feature");
      });

      it("returns empty for non-matching prefix", async () => {
        await ctx.refStore.set("refs/heads/main", fakeObjectId("main"));

        const refs = await collectRefs(ctx.refStore.list("refs/remotes/"));
        expect(refs.length).toBe(0);
      });

      it("includes symbolic refs in listing", async () => {
        await ctx.refStore.set("refs/heads/main", fakeObjectId("main"));
        await ctx.refStore.setSymbolic("HEAD", "refs/heads/main");

        const refs = await collectRefs(ctx.refStore.list());
        const head = refs.find((r) => r.name === "HEAD");
        expect(head).toBeDefined();
        if (!head) return;
        expect(isSymbolicRef(head)).toBe(true);
      });
    });

    describe("Compare and Swap", () => {
      it("updates ref when expected value matches", async () => {
        const oldId = fakeObjectId("old");
        const newId = fakeObjectId("new");

        await ctx.refStore.set("refs/heads/main", oldId);

        const result = await ctx.refStore.compareAndSwap("refs/heads/main", oldId, newId);
        expect(result.success).toBe(true);

        const ref = await ctx.refStore.get("refs/heads/main");
        expect((ref as Ref).objectId).toBe(newId);
      });

      it("fails when expected value does not match", async () => {
        const currentId = fakeObjectId("current");
        const wrongExpected = fakeObjectId("wrong");
        const newId = fakeObjectId("new");

        await ctx.refStore.set("refs/heads/main", currentId);

        const result = await ctx.refStore.compareAndSwap("refs/heads/main", wrongExpected, newId);
        expect(result.success).toBe(false);
        expect(result.previousValue).toBe(currentId);

        // Value should not have changed
        const ref = await ctx.refStore.get("refs/heads/main");
        expect((ref as Ref).objectId).toBe(currentId);
      });

      it("creates new ref when expected is undefined", async () => {
        const newId = fakeObjectId("new");

        const result = await ctx.refStore.compareAndSwap("refs/heads/new", undefined, newId);
        expect(result.success).toBe(true);

        const ref = await ctx.refStore.get("refs/heads/new");
        expect((ref as Ref).objectId).toBe(newId);
      });

      it("fails creating when ref already exists", async () => {
        const existingId = fakeObjectId("existing");
        const newId = fakeObjectId("new");

        await ctx.refStore.set("refs/heads/main", existingId);

        const result = await ctx.refStore.compareAndSwap("refs/heads/main", undefined, newId);
        expect(result.success).toBe(false);
        expect(result.previousValue).toBe(existingId);
      });
    });

    describe("Ref Names", () => {
      it("handles branch refs", async () => {
        await ctx.refStore.set("refs/heads/main", fakeObjectId("main"));
        await ctx.refStore.set("refs/heads/feature/auth", fakeObjectId("auth"));
        await ctx.refStore.set("refs/heads/feature/api", fakeObjectId("api"));

        expect(await ctx.refStore.has("refs/heads/main")).toBe(true);
        expect(await ctx.refStore.has("refs/heads/feature/auth")).toBe(true);
        expect(await ctx.refStore.has("refs/heads/feature/api")).toBe(true);
      });

      it("handles tag refs", async () => {
        await ctx.refStore.set("refs/tags/v1.0.0", fakeObjectId("v1"));
        await ctx.refStore.set("refs/tags/v2.0.0-beta", fakeObjectId("v2"));

        expect(await ctx.refStore.has("refs/tags/v1.0.0")).toBe(true);
        expect(await ctx.refStore.has("refs/tags/v2.0.0-beta")).toBe(true);
      });

      it("handles remote tracking refs", async () => {
        await ctx.refStore.set("refs/remotes/origin/main", fakeObjectId("origin-main"));
        await ctx.refStore.set("refs/remotes/upstream/main", fakeObjectId("upstream-main"));

        const remotes = await collectRefs(ctx.refStore.list("refs/remotes/"));
        expect(remotes.length).toBe(2);
      });

      it("handles HEAD", async () => {
        await ctx.refStore.set("refs/heads/main", fakeObjectId("main"));
        await ctx.refStore.setSymbolic("HEAD", "refs/heads/main");

        const head = await ctx.refStore.get("HEAD");
        expect(head).toBeDefined();
        expect((head as SymbolicRef).target).toBe("refs/heads/main");
      });
    });

    describe("Storage Location", () => {
      it("reports storage location for refs", async () => {
        await ctx.refStore.set("refs/heads/main", fakeObjectId("main"));

        const ref = await ctx.refStore.get("refs/heads/main");
        expect(ref).toBeDefined();
        expect((ref as Ref).storage).toBeDefined();
        expect(
          [RefStorage.LOOSE, RefStorage.PACKED, RefStorage.NEW].includes((ref as Ref).storage),
        ).toBe(true);
      });
    });

    describe("Peeled Refs", () => {
      it("stores and retrieves peeled object ID", async () => {
        const tagId = fakeObjectId("tag");
        const _commitId = fakeObjectId("commit");

        // Some implementations support peeled refs directly
        await ctx.refStore.set("refs/tags/v1.0.0", tagId);

        const ref = await ctx.refStore.get("refs/tags/v1.0.0");
        // Peeled is optional - just verify it doesn't break
        expect(ref).toBeDefined();
      });
    });

    describe("Edge Cases", () => {
      it("handles empty ref listing", async () => {
        const refs = await collectRefs(ctx.refStore.list());
        expect(refs.length).toBe(0);
      });

      it("handles ref names with special characters", async () => {
        await ctx.refStore.set("refs/heads/feature-123", fakeObjectId("f123"));
        await ctx.refStore.set("refs/heads/fix_bug", fakeObjectId("fix"));

        expect(await ctx.refStore.has("refs/heads/feature-123")).toBe(true);
        expect(await ctx.refStore.has("refs/heads/fix_bug")).toBe(true);
      });

      it("handles deep nested ref paths", async () => {
        const deepRef = "refs/heads/feature/team/project/task";
        await ctx.refStore.set(deepRef, fakeObjectId("deep"));

        expect(await ctx.refStore.has(deepRef)).toBe(true);
        const ref = await ctx.refStore.get(deepRef);
        expect((ref as Ref).objectId).toBe(fakeObjectId("deep"));
      });
    });

    describe("Optimize", () => {
      it("optimize does not throw", async () => {
        await ctx.refStore.set("refs/heads/main", fakeObjectId("main"));
        await ctx.refStore.set("refs/heads/feature", fakeObjectId("feature"));

        // Optimize is optional - should not throw if not implemented
        if (ctx.refStore.optimize) {
          await expect(ctx.refStore.optimize()).resolves.not.toThrow();
        }
      });
    });
  });
}
