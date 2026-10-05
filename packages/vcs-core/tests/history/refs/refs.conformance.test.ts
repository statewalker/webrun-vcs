import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObjectId } from "../../../src/history/object-storage.js";
import type { RefEntry, Refs } from "../../../src/history/refs/refs.js";

// This file exports a conformance test factory, not direct tests.
// Implementations use refsConformanceTests() to run tests.
describe("Refs conformance test factory", () => {
  it("exports conformance test function", () => {
    expect(typeof refsConformanceTests).toBe("function");
  });
});

/**
 * Conformance test suite for Refs implementations
 *
 * Run these tests against any Refs implementation to verify
 * it correctly implements the interface contract.
 */
export function refsConformanceTests(
  name: string,
  createStore: () => Promise<Refs>,
  cleanup: () => Promise<void>,
) {
  describe(`${name} Refs conformance`, () => {
    let store: Refs;

    beforeEach(async () => {
      store = await createStore();
    });

    afterEach(async () => {
      await cleanup();
    });

    // Helper to create object IDs (40 hex chars)
    function objectId(n: number): ObjectId {
      return n.toString(16).padStart(40, "0");
    }

    describe("set/get round-trip", () => {
      it("sets and gets direct ref", async () => {
        const oid = objectId(1);
        await store.set("refs/heads/main", oid);

        const ref = await store.get("refs/heads/main");
        expect(ref).toBeDefined();
        expect("objectId" in ref!).toBe(true);
        expect((ref as { objectId: ObjectId }).objectId).toBe(oid);
      });

      it("sets and gets multiple refs", async () => {
        await store.set("refs/heads/main", objectId(1));
        await store.set("refs/heads/feature", objectId(2));
        await store.set("refs/tags/v1.0.0", objectId(3));

        const main = await store.get("refs/heads/main");
        const feature = await store.get("refs/heads/feature");
        const tag = await store.get("refs/tags/v1.0.0");

        expect(main).toBeDefined();
        expect(feature).toBeDefined();
        expect(tag).toBeDefined();
      });

      it("overwrites existing ref", async () => {
        await store.set("refs/heads/main", objectId(1));
        await store.set("refs/heads/main", objectId(2));

        const ref = await store.get("refs/heads/main");
        expect((ref as { objectId: ObjectId }).objectId).toBe(objectId(2));
      });
    });

    describe("setSymbolic", () => {
      it("sets and gets symbolic ref", async () => {
        await store.set("refs/heads/main", objectId(1));
        await store.setSymbolic("HEAD", "refs/heads/main");

        const ref = await store.get("HEAD");
        expect(ref).toBeDefined();
        expect("target" in ref!).toBe(true);
        expect((ref as { target: string }).target).toBe("refs/heads/main");
      });
    });

    describe("resolve", () => {
      it("resolves direct ref", async () => {
        const oid = objectId(1);
        await store.set("refs/heads/main", oid);

        const resolved = await store.resolve("refs/heads/main");
        expect(resolved).toBeDefined();
        expect(resolved?.objectId).toBe(oid);
      });

      it("resolves symbolic ref to final object", async () => {
        const oid = objectId(1);
        await store.set("refs/heads/main", oid);
        await store.setSymbolic("HEAD", "refs/heads/main");

        const resolved = await store.resolve("HEAD");
        expect(resolved).toBeDefined();
        expect(resolved?.objectId).toBe(oid);
      });

      it("resolves chain of symbolic refs", async () => {
        const oid = objectId(1);
        await store.set("refs/heads/main", oid);
        await store.setSymbolic("refs/heads/alias", "refs/heads/main");
        await store.setSymbolic("HEAD", "refs/heads/alias");

        const resolved = await store.resolve("HEAD");
        expect(resolved).toBeDefined();
        expect(resolved?.objectId).toBe(oid);
      });

      it("returns undefined for non-existent ref", async () => {
        const resolved = await store.resolve("refs/heads/nonexistent");
        expect(resolved).toBeUndefined();
      });

      it("returns undefined for broken symbolic ref chain", async () => {
        await store.setSymbolic("HEAD", "refs/heads/nonexistent");

        const resolved = await store.resolve("HEAD");
        expect(resolved).toBeUndefined();
      });
    });

    describe("get returns undefined for non-existent", () => {
      it("returns undefined for non-existent ref", async () => {
        const ref = await store.get("refs/heads/nonexistent");
        expect(ref).toBeUndefined();
      });
    });

    describe("has", () => {
      it("returns false for non-existent ref", async () => {
        expect(await store.has("refs/heads/nonexistent")).toBe(false);
      });

      it("returns true for existing direct ref", async () => {
        await store.set("refs/heads/main", objectId(1));
        expect(await store.has("refs/heads/main")).toBe(true);
      });

      it("returns true for existing symbolic ref", async () => {
        await store.setSymbolic("HEAD", "refs/heads/main");
        expect(await store.has("HEAD")).toBe(true);
      });
    });

    describe("remove", () => {
      it("returns false for non-existent ref", async () => {
        expect(await store.remove("refs/heads/nonexistent")).toBe(false);
      });

      it("removes existing ref and returns true", async () => {
        await store.set("refs/heads/main", objectId(1));
        expect(await store.remove("refs/heads/main")).toBe(true);
        expect(await store.has("refs/heads/main")).toBe(false);
      });

      it("removes symbolic ref", async () => {
        await store.setSymbolic("HEAD", "refs/heads/main");
        expect(await store.remove("HEAD")).toBe(true);
        expect(await store.has("HEAD")).toBe(false);
      });

      it("get returns undefined after remove", async () => {
        await store.set("refs/heads/main", objectId(1));
        await store.remove("refs/heads/main");
        expect(await store.get("refs/heads/main")).toBeUndefined();
      });
    });

    describe("list", () => {
      it("returns empty iterable when no refs", async () => {
        const refs: RefEntry[] = [];
        for await (const ref of store.list()) {
          refs.push(ref);
        }
        expect(refs).toHaveLength(0);
      });

      it("returns all refs", async () => {
        await store.set("refs/heads/main", objectId(1));
        await store.set("refs/heads/feature", objectId(2));
        await store.set("refs/tags/v1.0.0", objectId(3));

        const refs: RefEntry[] = [];
        for await (const ref of store.list()) {
          refs.push(ref);
        }

        expect(refs).toHaveLength(3);
        const names = refs.map((r) => r.name).sort();
        expect(names).toEqual(["refs/heads/feature", "refs/heads/main", "refs/tags/v1.0.0"]);
      });

      it("filters by prefix", async () => {
        await store.set("refs/heads/main", objectId(1));
        await store.set("refs/heads/feature", objectId(2));
        await store.set("refs/tags/v1.0.0", objectId(3));

        const refs: RefEntry[] = [];
        for await (const ref of store.list("refs/heads/")) {
          refs.push(ref);
        }

        expect(refs).toHaveLength(2);
        const names = refs.map((r) => r.name).sort();
        expect(names).toEqual(["refs/heads/feature", "refs/heads/main"]);
      });
    });

    describe("compareAndSwap", () => {
      it("succeeds when expected value matches", async () => {
        await store.set("refs/heads/main", objectId(1));

        const result = await store.compareAndSwap("refs/heads/main", objectId(1), objectId(2));

        expect(result.success).toBe(true);

        const ref = await store.get("refs/heads/main");
        expect((ref as { objectId: ObjectId }).objectId).toBe(objectId(2));
      });

      it("fails when expected value does not match", async () => {
        await store.set("refs/heads/main", objectId(1));

        const result = await store.compareAndSwap(
          "refs/heads/main",
          objectId(99), // wrong expected value
          objectId(2),
        );

        expect(result.success).toBe(false);

        // Value should not have changed
        const ref = await store.get("refs/heads/main");
        expect((ref as { objectId: ObjectId }).objectId).toBe(objectId(1));
      });

      it("creates new ref when expected is undefined and ref does not exist", async () => {
        const result = await store.compareAndSwap("refs/heads/new", undefined, objectId(1));

        expect(result.success).toBe(true);
        expect(await store.has("refs/heads/new")).toBe(true);
      });

      it("fails to create when expected is undefined but ref exists", async () => {
        await store.set("refs/heads/existing", objectId(1));

        const result = await store.compareAndSwap("refs/heads/existing", undefined, objectId(2));

        expect(result.success).toBe(false);
      });
    });
  });
}
