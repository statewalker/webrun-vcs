/**
 * Parametrized test suite for atomic ref batches (`Refs.batch`).
 *
 * The cases follow `git update-ref --stdin` (checked against git 2.43): a batch
 * applies all of its commands or none, refuses invalid and duplicate names and
 * directory/file conflicts, and updates through symbolic refs unless told not to.
 */

import type { BatchResult, ObjectId, Ref, Refs } from "@statewalker/vcs-core";
import { isSymbolicRef } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

export interface RefBatchTestContext {
  refs: Refs;
  cleanup?: () => Promise<void>;
}

export type RefBatchFactory = () => Promise<RefBatchTestContext>;

/** Deterministic fake object ids; object existence is not checked by ref stores. */
const oid = (n: number): ObjectId => n.toString(16).padStart(40, "a");

async function snapshot(refs: Refs, prefix = "refs/"): Promise<string> {
  const out: string[] = [];
  for await (const ref of refs.list(prefix)) {
    if (!isSymbolicRef(ref)) out.push(`${ref.name}=${(ref as Ref).objectId?.slice(-4)}`);
  }
  return out.sort().join(",");
}

const reasons = (r: BatchResult): string =>
  r.rejected
    .map((x) => `${x.name}:${x.reason}`)
    .sort()
    .join(",");

/**
 * Create the ref batch test suite for a `Refs` implementation.
 *
 * @param name Name of the implementation (e.g. "Memory", "SQL")
 * @param factory Creates an empty store per test
 */
export function createRefBatchTests(name: string, factory: RefBatchFactory): void {
  describe(`Refs.batch [${name}]`, () => {
    let ctx: RefBatchTestContext;
    let refs: Refs;

    beforeEach(async () => {
      ctx = await factory();
      refs = ctx.refs;
      await refs.initialize?.();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    it("applies a batch of creates; get, resolve and list agree", async () => {
      const r = await refs.batch([
        { name: "refs/heads/main", old: null, new: oid(1) },
        { name: "refs/tags/v1", old: null, new: oid(2) },
        { name: "refs/heads/dev", new: oid(3) },
      ]);
      expect(r).toEqual({ ok: true, rejected: [] });
      expect(((await refs.get("refs/heads/main")) as Ref).objectId).toBe(oid(1));
      expect((await refs.resolve("refs/tags/v1"))?.objectId).toBe(oid(2));
      expect(await snapshot(refs)).toBe(
        "refs/heads/dev=aaa3,refs/heads/main=aaa1,refs/tags/v1=aaa2",
      );
    });

    it("an empty batch succeeds and changes nothing", async () => {
      expect(await refs.batch([])).toEqual({ ok: true, rejected: [] });
      expect(await snapshot(refs)).toBe("");
    });

    it("one mismatching old value rejects the whole batch", async () => {
      await refs.batch([
        { name: "refs/heads/a", new: oid(1) },
        { name: "refs/heads/b", new: oid(2) },
      ]);
      const r = await refs.batch([
        { name: "refs/heads/a", old: oid(1), new: oid(10) },
        { name: "refs/heads/b", old: oid(99), new: oid(20) },
        { name: "refs/heads/c", old: null, new: oid(30) },
      ]);
      expect(r.ok).toBe(false);
      expect(reasons(r)).toBe("refs/heads/b:mismatch");
      expect(await snapshot(refs)).toBe("refs/heads/a=aaa1,refs/heads/b=aaa2");
    });

    it("'must not exist' on an existing ref is a mismatch", async () => {
      await refs.batch([{ name: "refs/heads/a", new: oid(1) }]);
      const r = await refs.batch([
        { name: "refs/heads/a", old: null, new: oid(2) },
        { name: "refs/heads/z", old: null, new: oid(3) },
      ]);
      expect(reasons(r)).toBe("refs/heads/a:mismatch");
      expect(await snapshot(refs)).toBe("refs/heads/a=aaa1");
    });

    it("creates, updates and deletes in one batch apply together", async () => {
      await refs.batch([
        { name: "refs/heads/a", new: oid(1) },
        { name: "refs/heads/b", new: oid(2) },
      ]);
      const r = await refs.batch([
        { name: "refs/heads/a", old: oid(1), new: oid(0x11) },
        { name: "refs/heads/b", old: oid(2), new: null },
        { name: "refs/heads/c", old: null, new: oid(3) },
      ]);
      expect(r.ok).toBe(true);
      expect(await snapshot(refs)).toBe("refs/heads/a=aa11,refs/heads/c=aaa3");
      expect(await refs.has("refs/heads/b")).toBe(false);
    });

    it("an invalid name rejects the whole batch", async () => {
      for (const bad of [
        "refs/heads/a..b",
        "refs/heads/x.lock",
        "refs/heads/sp ace",
        "foo",
        "refs/heads/@{x}",
        "refs/heads/end/",
      ]) {
        const r = await refs.batch([
          { name: "refs/heads/ok", new: oid(1) },
          { name: bad, new: oid(2) },
        ]);
        expect(r.ok, bad).toBe(false);
        expect(r.rejected, bad).toContainEqual({ name: bad, reason: "invalid-name" });
      }
      expect(await snapshot(refs)).toBe("");
    });

    it("refuses a name twice in one batch, and a delete that must not exist", async () => {
      const dup = await refs.batch([
        { name: "refs/heads/a", new: oid(1) },
        { name: "refs/heads/a", new: oid(2) },
      ]);
      expect(dup.rejected).toContainEqual({ name: "refs/heads/a", reason: "duplicate" });
      const bad = await refs.batch([{ name: "refs/heads/a", old: null, new: null }]);
      expect(bad.rejected).toContainEqual({ name: "refs/heads/a", reason: "invalid-command" });
      expect(await snapshot(refs)).toBe("");
    });

    it("refuses directory/file conflicts as git does", async () => {
      await refs.batch([
        { name: "refs/x", new: oid(1) },
        { name: "refs/p/q", new: oid(2) },
      ]);
      // git refuses a create below an existing ref even when the same batch deletes it.
      const below = await refs.batch([
        { name: "refs/x", old: oid(1), new: null },
        { name: "refs/x/y", old: null, new: oid(3) },
      ]);
      const above = await refs.batch([{ name: "refs/p", new: oid(4) }]);
      const pair = await refs.batch([
        { name: "refs/z", new: oid(5) },
        { name: "refs/z/w", new: oid(6) },
      ]);
      for (const r of [below, above, pair]) {
        expect(r.ok).toBe(false);
        expect(r.rejected.some((x) => x.reason === "df-conflict")).toBe(true);
      }
      expect(await snapshot(refs)).toBe("refs/p/q=aaa2,refs/x=aaa1");
    });

    it("updates through a symbolic HEAD, and keeps HEAD symbolic", async () => {
      await refs.batch([{ name: "refs/heads/main", new: oid(1) }]);
      await refs.setSymbolic("HEAD", "refs/heads/main");
      const r = await refs.batch([{ name: "HEAD", old: oid(1), new: oid(2) }]);
      expect(r.ok).toBe(true);
      const head = await refs.get("HEAD");
      expect(head && isSymbolicRef(head)).toBe(true);
      expect((await refs.resolve("refs/heads/main"))?.objectId).toBe(oid(2));
    });

    it("noDeref updates HEAD itself (detaches it)", async () => {
      await refs.batch([{ name: "refs/heads/main", new: oid(1) }]);
      await refs.setSymbolic("HEAD", "refs/heads/main");
      const r = await refs.batch([{ name: "HEAD", new: oid(7), noDeref: true }]);
      expect(r.ok).toBe(true);
      const head = await refs.get("HEAD");
      expect(head && isSymbolicRef(head)).toBe(false);
      expect((head as Ref).objectId).toBe(oid(7));
      expect((await refs.resolve("refs/heads/main"))?.objectId).toBe(oid(1));
    });

    it("a detached HEAD cannot join a multi-ref batch (not atomic on git files)", async () => {
      const r = await refs.batch([
        { name: "HEAD", new: oid(1), noDeref: true },
        { name: "refs/heads/a", new: oid(2) },
      ]);
      expect(r.rejected).toContainEqual({ name: "HEAD", reason: "not-atomic" });
      expect(await refs.has("refs/heads/a")).toBe(false);
    });

    it("compareAndSwap is a one-command batch", async () => {
      expect((await refs.compareAndSwap("refs/heads/m", undefined, oid(1))).success).toBe(true);
      const lost = await refs.compareAndSwap("refs/heads/m", oid(9), oid(2));
      expect(lost).toMatchObject({ success: false, previousValue: oid(1) });
      expect((await refs.compareAndSwap("refs/heads/m", oid(1), oid(2))).success).toBe(true);
      expect((await refs.resolve("refs/heads/m"))?.objectId).toBe(oid(2));
    });

    it("20 concurrent two-ref batches with retry: both refs count every success", async () => {
      const count = (n: number): ObjectId => n.toString(16).padStart(40, "0");
      await refs.batch([
        { name: "refs/heads/left", new: count(0) },
        { name: "refs/heads/right", new: count(0) },
      ]);
      const bump = async () => {
        for (let attempt = 0; attempt < 500; attempt++) {
          const n = Number.parseInt((await refs.resolve("refs/heads/left"))?.objectId ?? "0", 16);
          const r = await refs.batch([
            { name: "refs/heads/left", old: count(n), new: count(n + 1) },
            { name: "refs/heads/right", old: count(n), new: count(n + 1) },
          ]);
          if (r.ok) return;
          expect(reasons(r)).toMatch(/mismatch|locked/);
        }
        throw new Error("no progress");
      };
      await Promise.all(Array.from({ length: 20 }, bump));
      expect((await refs.resolve("refs/heads/left"))?.objectId).toBe(count(20));
      expect((await refs.resolve("refs/heads/right"))?.objectId).toBe(count(20));
    });
  });
}
