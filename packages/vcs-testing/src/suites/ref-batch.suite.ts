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

export interface RefBatchSuiteOptions {
  /**
   * Whether the store applies multi-command batches. Stores on the interim
   * single-command batch pass `false`: multi-command cases then only check that
   * nothing is applied.
   */
  multiRef?: boolean;
  /** Whether the store keeps symbolic refs (some KV adapters do not). */
  symbolicRefs?: boolean;
  /** Whether the store keeps reflogs (written by `batch`, read by `getReflog`). */
  reflog?: boolean;
}

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
export function createRefBatchTests(
  name: string,
  factory: RefBatchFactory,
  options: RefBatchSuiteOptions = {},
): void {
  const multi = options.multiRef !== false;
  const itMulti = multi ? it : it.skip;
  const itSym = options.symbolicRefs === false ? it.skip : it;
  const itMultiSym = multi && options.symbolicRefs !== false ? it : it.skip;
  const itLog = options.reflog ? it : it.skip;
  const IDENT = "A U Thor <author@example.com> 1700000000 +0000";
  const Z = "0".repeat(40);
  describe(`Refs.batch [${name}]`, () => {
    let ctx: RefBatchTestContext;
    let refs: Refs;
    /** Reflog lines, oldest first, as "old>new:message" with ids shortened to their last 4 chars. */
    const logOf = async (name: string): Promise<string[]> => {
      const log = await refs.getReflog?.(name);
      const entries = (await log?.getReverseEntries()) ?? [];
      return entries.reverse().map((e) => `${e.oldId.slice(-4)}>${e.newId.slice(-4)}:${e.comment}`);
    };
    /** Set up refs one command at a time (works on every store). */
    const seed = async (...pairs: [string, ObjectId][]) => {
      for (const [ref, id] of pairs) {
        const r = await refs.batch([{ name: ref, new: id }]);
        expect(r, `seed ${ref}`).toEqual({ ok: true, rejected: [] });
      }
    };

    beforeEach(async () => {
      ctx = await factory();
      refs = ctx.refs;
      await refs.initialize?.();
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    itMulti("applies a batch of creates; get, resolve and list agree", async () => {
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

    itMulti("one mismatching old value rejects the whole batch", async () => {
      await seed(["refs/heads/a", oid(1)], ["refs/heads/b", oid(2)]);
      const r = await refs.batch([
        { name: "refs/heads/a", old: oid(1), new: oid(10) },
        { name: "refs/heads/b", old: oid(99), new: oid(20) },
        { name: "refs/heads/c", old: null, new: oid(30) },
      ]);
      expect(r.ok).toBe(false);
      expect(reasons(r)).toBe("refs/heads/b:mismatch");
      expect(await snapshot(refs)).toBe("refs/heads/a=aaa1,refs/heads/b=aaa2");
    });

    itMulti("'must not exist' on an existing ref is a mismatch", async () => {
      await seed(["refs/heads/a", oid(1)]);
      const r = await refs.batch([
        { name: "refs/heads/a", old: null, new: oid(2) },
        { name: "refs/heads/z", old: null, new: oid(3) },
      ]);
      expect(reasons(r)).toBe("refs/heads/a:mismatch");
      expect(await snapshot(refs)).toBe("refs/heads/a=aaa1");
    });

    itMulti("creates, updates and deletes in one batch apply together", async () => {
      await seed(["refs/heads/a", oid(1)], ["refs/heads/b", oid(2)]);
      const r = await refs.batch([
        { name: "refs/heads/a", old: oid(1), new: oid(0x11) },
        { name: "refs/heads/b", old: oid(2), new: null },
        { name: "refs/heads/c", old: null, new: oid(3) },
      ]);
      expect(r.ok).toBe(true);
      expect(await snapshot(refs)).toBe("refs/heads/a=aa11,refs/heads/c=aaa3");
      expect(await refs.has("refs/heads/b")).toBe(false);
    });

    itMulti("an invalid name rejects the whole batch", async () => {
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

    itMulti("refuses a name twice in one batch, and a delete that must not exist", async () => {
      const dup = await refs.batch([
        { name: "refs/heads/a", new: oid(1) },
        { name: "refs/heads/a", new: oid(2) },
      ]);
      expect(dup.rejected).toContainEqual({ name: "refs/heads/a", reason: "duplicate" });
      const bad = await refs.batch([{ name: "refs/heads/a", old: null, new: null }]);
      expect(bad.rejected).toContainEqual({ name: "refs/heads/a", reason: "invalid-command" });
      expect(await snapshot(refs)).toBe("");
    });

    itMulti("refuses directory/file conflicts as git does", async () => {
      await seed(["refs/x", oid(1)], ["refs/p/q", oid(2)]);
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

    itSym("updates through a symbolic HEAD, and keeps HEAD symbolic", async () => {
      await seed(["refs/heads/main", oid(1)]);
      await refs.setSymbolic("HEAD", "refs/heads/main");
      const r = await refs.batch([{ name: "HEAD", old: oid(1), new: oid(2) }]);
      expect(r.ok).toBe(true);
      const head = await refs.get("HEAD");
      expect(head && isSymbolicRef(head)).toBe(true);
      expect((await refs.resolve("refs/heads/main"))?.objectId).toBe(oid(2));
    });

    itMultiSym("noDeref compares old with the value HEAD resolves to, as git does", async () => {
      await seed(["refs/heads/main", oid(1)]);
      await refs.setSymbolic("HEAD", "refs/heads/main");
      const exists = await refs.batch([{ name: "HEAD", old: null, new: oid(2), noDeref: true }]);
      expect(exists.rejected).toEqual([{ name: "HEAD", reason: "mismatch" }]);
      const r = await refs.batch([{ name: "HEAD", old: oid(1), new: oid(2), noDeref: true }]);
      expect(r.ok).toBe(true);
      const head = await refs.get("HEAD");
      expect(head && isSymbolicRef(head)).toBe(false);
      expect((await refs.resolve("refs/heads/main"))?.objectId).toBe(oid(1));
    });

    itMultiSym("noDeref updates HEAD itself (detaches it)", async () => {
      await seed(["refs/heads/main", oid(1)]);
      await refs.setSymbolic("HEAD", "refs/heads/main");
      const r = await refs.batch([{ name: "HEAD", new: oid(7), noDeref: true }]);
      expect(r.ok).toBe(true);
      const head = await refs.get("HEAD");
      expect(head && isSymbolicRef(head)).toBe(false);
      expect((head as Ref).objectId).toBe(oid(7));
      expect((await refs.resolve("refs/heads/main"))?.objectId).toBe(oid(1));
    });

    itMultiSym("a detached HEAD cannot join a multi-ref batch (a project policy)", async () => {
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

    it("checks one command's name, old value and D/F conflicts", async () => {
      await seed(["refs/heads/a", oid(1)], ["refs/p/q", oid(2)]);
      expect(
        (await refs.batch([{ name: "refs/heads/a", old: oid(9), new: oid(3) }])).rejected,
      ).toEqual([{ name: "refs/heads/a", reason: "mismatch" }]);
      expect(
        (await refs.batch([{ name: "refs/heads/a", old: null, new: oid(3) }])).rejected,
      ).toEqual([{ name: "refs/heads/a", reason: "mismatch" }]);
      expect((await refs.batch([{ name: "refs/heads/a..b", new: oid(3) }])).rejected).toEqual([
        { name: "refs/heads/a..b", reason: "invalid-name" },
      ]);
      expect((await refs.batch([{ name: "refs/p", new: oid(3) }])).rejected).toEqual([
        { name: "refs/p", reason: "df-conflict" },
      ]);
      expect((await refs.batch([{ name: "refs/heads/a/b", new: oid(3) }])).rejected).toEqual([
        { name: "refs/heads/a/b", reason: "df-conflict" },
      ]);
      expect((await refs.batch([{ name: "refs/heads/a", old: oid(1), new: oid(4) }])).ok).toBe(
        true,
      );
      expect(await snapshot(refs)).toBe("refs/heads/a=aaa4,refs/p/q=aaa2");
    });

    it("deletes with a matching old value; deleting a missing ref is a no-op", async () => {
      await seed(["refs/heads/a", oid(1)]);
      expect(await refs.batch([{ name: "refs/heads/gone", new: null }])).toEqual({
        ok: true,
        rejected: [],
      });
      expect((await refs.batch([{ name: "refs/heads/a", old: oid(2), new: null }])).ok).toBe(false);
      expect(await refs.batch([{ name: "refs/heads/a", old: oid(1), new: null }])).toEqual({
        ok: true,
        rejected: [],
      });
      expect(await refs.has("refs/heads/a")).toBe(false);
    });

    itSym(
      "a delete through a symbolic ref deletes its target and keeps the symbolic ref",
      async () => {
        await seed(["refs/heads/main", oid(1)]);
        await refs.setSymbolic("refs/heads/alias", "refs/heads/main");
        expect((await refs.batch([{ name: "refs/heads/alias", old: oid(1), new: null }])).ok).toBe(
          true,
        );
        expect(await refs.has("refs/heads/main")).toBe(false);
        const alias = await refs.get("refs/heads/alias");
        expect(alias && isSymbolicRef(alias)).toBe(true);
      },
    );

    itSym("an update through a dangling symbolic ref creates its target", async () => {
      await refs.setSymbolic("HEAD", "refs/heads/unborn");
      expect((await refs.batch([{ name: "HEAD", old: null, new: oid(1) }])).ok).toBe(true);
      expect((await refs.resolve("refs/heads/unborn"))?.objectId).toBe(oid(1));
    });

    itMultiSym("HEAD and its target in one batch are the same ref twice", async () => {
      await seed(["refs/heads/main", oid(1)]);
      await refs.setSymbolic("HEAD", "refs/heads/main");
      const r = await refs.batch([
        { name: "HEAD", new: oid(2) },
        { name: "refs/heads/main", new: oid(3) },
      ]);
      expect(r.ok).toBe(false);
      expect(r.rejected.some((x) => x.reason === "duplicate")).toBe(true);
      expect((await refs.resolve("refs/heads/main"))?.objectId).toBe(oid(1));
    });

    it("refuses a multi-command batch whole, or applies it whole", async () => {
      const r = await refs.batch([
        { name: "refs/heads/m1", new: oid(1) },
        { name: "refs/heads/m2", new: oid(2) },
      ]);
      if (multi) {
        expect(r.ok).toBe(true);
        expect(await snapshot(refs)).toBe("refs/heads/m1=aaa1,refs/heads/m2=aaa2");
      } else {
        expect(r.ok).toBe(false);
        expect(r.rejected.every((x) => x.reason === "unsupported")).toBe(true);
        expect(await snapshot(refs)).toBe("");
      }
    });

    itMulti("a listing never shows half of a batch", async () => {
      await seed(["refs/heads/a", oid(1)], ["refs/heads/b", oid(1)]);
      const it = refs.list("refs/heads/")[Symbol.asyncIterator]();
      const seen: string[] = [];
      const first = await it.next();
      if (!first.done && !isSymbolicRef(first.value))
        seen.push((first.value as Ref).objectId ?? "");
      await refs.batch([
        { name: "refs/heads/a", old: oid(1), new: oid(2) },
        { name: "refs/heads/b", old: oid(1), new: oid(2) },
      ]);
      for (let r = await it.next(); !r.done; r = await it.next()) {
        if (!isSymbolicRef(r.value)) seen.push((r.value as Ref).objectId ?? "");
      }
      expect(seen).toHaveLength(2);
      expect(new Set(seen).size).toBe(1);
    });

    itLog("writes reflog lines with old and new ids, identity and message", async () => {
      await refs.batch([{ name: "refs/heads/a", old: null, new: oid(1) }], {
        ident: IDENT,
        message: "create",
      });
      await refs.batch([{ name: "refs/heads/a", old: oid(1), new: oid(2) }], {
        ident: IDENT,
        message: "move   it",
      });
      expect(await logOf("refs/heads/a")).toEqual([
        `${Z.slice(-4)}>aaa1:create`,
        "aaa1>aaa2:move it", // whitespace runs collapsed, as git
      ]);
      const last = await (await refs.getReflog?.("refs/heads/a"))?.getLastEntry();
      expect(last?.who).toMatchObject({ name: "A U Thor", email: "author@example.com" });
    });

    itLog("logs HEAD too when its branch moves, even when named directly", async () => {
      await refs.batch([{ name: "refs/heads/main", new: oid(1) }], {
        ident: IDENT,
        message: "init",
      });
      await refs.setSymbolic("HEAD", "refs/heads/main");
      await refs.batch([{ name: "HEAD", old: oid(1), new: oid(2) }], {
        ident: IDENT,
        message: "via HEAD",
      });
      await refs.batch([{ name: "refs/heads/main", old: oid(2), new: oid(3) }], {
        ident: IDENT,
        message: "direct",
      });
      expect(await logOf("refs/heads/main")).toEqual([
        `${Z.slice(-4)}>aaa1:init`,
        "aaa1>aaa2:via HEAD",
        "aaa2>aaa3:direct",
      ]);
      expect(await logOf("HEAD")).toEqual(["aaa1>aaa2:via HEAD", "aaa2>aaa3:direct"]);
    });

    itLog(
      "a no-op update logs HEAD but not the branch; a delete drops the branch log",
      async () => {
        await refs.batch([{ name: "refs/heads/main", new: oid(1) }], {
          ident: IDENT,
          message: "init",
        });
        await refs.setSymbolic("HEAD", "refs/heads/main");
        await refs.batch([{ name: "refs/heads/main", old: oid(1), new: oid(1) }], {
          ident: IDENT,
          message: "noop",
        });
        expect(await logOf("refs/heads/main")).toEqual([`${Z.slice(-4)}>aaa1:init`]);
        expect(await logOf("HEAD")).toEqual(["aaa1>aaa1:noop"]);
        await refs.batch([{ name: "refs/heads/main", old: oid(1), new: null }], {
          ident: IDENT,
          message: "delete",
        });
        expect(await logOf("refs/heads/main")).toEqual([]);
        expect((await logOf("HEAD")).at(-1)).toBe(`aaa1>${Z.slice(-4)}:delete`);
      },
    );

    itLog("creates logs for branches, not for tags (git's logAllRefUpdates)", async () => {
      await refs.batch([{ name: "refs/heads/b", new: oid(1) }], { ident: IDENT, message: "b" });
      await refs.batch([{ name: "refs/tags/t", new: oid(1) }], { ident: IDENT, message: "t" });
      expect(await logOf("refs/heads/b")).toEqual([`${Z.slice(-4)}>aaa1:b`]);
      expect(await logOf("refs/tags/t")).toEqual([]);
    });

    itLog("logs each symbolic ref an update goes through, not only HEAD", async () => {
      await refs.batch([{ name: "refs/remotes/origin/main", new: oid(1) }], {
        ident: IDENT,
        message: "fetch",
      });
      await refs.setSymbolic("refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      await refs.batch([{ name: "refs/remotes/origin/HEAD", old: oid(1), new: oid(2) }], {
        ident: IDENT,
        message: "via origin/HEAD",
      });
      expect(await logOf("refs/remotes/origin/main")).toEqual([
        `${Z.slice(-4)}>aaa1:fetch`,
        "aaa1>aaa2:via origin/HEAD",
      ]);
      expect(await logOf("refs/remotes/origin/HEAD")).toEqual(["aaa1>aaa2:via origin/HEAD"]);
    });

    itLog("a rejected batch writes no reflog lines", async () => {
      await refs.batch([{ name: "refs/heads/a", new: oid(1) }], { ident: IDENT, message: "a" });
      const r = await refs.batch(
        [
          { name: "refs/heads/a", old: oid(1), new: oid(2) },
          { name: "refs/heads/b", old: oid(9), new: oid(2) },
        ],
        { ident: IDENT, message: "rejected" },
      );
      expect(r.ok).toBe(false);
      expect(await logOf("refs/heads/a")).toEqual([`${Z.slice(-4)}>aaa1:a`]);
      expect(await logOf("refs/heads/b")).toEqual([]);
    });

    itLog("a multi-ref batch logs every ref, and HEAD once for its branch", async () => {
      await refs.batch([{ name: "refs/heads/main", new: oid(1) }], {
        ident: IDENT,
        message: "init",
      });
      await refs.setSymbolic("HEAD", "refs/heads/main");
      await refs.batch(
        [
          { name: "refs/heads/main", old: oid(1), new: oid(2) },
          { name: "refs/heads/other", old: null, new: oid(2) },
        ],
        { ident: IDENT, message: "both" },
      );
      expect(await logOf("HEAD")).toEqual(["aaa1>aaa2:both"]);
      expect(await logOf("refs/heads/other")).toEqual([`${Z.slice(-4)}>aaa2:both`]);
      const log = await refs.getReflog?.("refs/heads/main");
      expect((await log?.getReverseEntry(0))?.comment).toBe("both");
      expect((await log?.getReverseEntries(1))?.map((e) => e.comment)).toEqual(["both"]);
    });

    itMulti("20 concurrent two-ref batches with retry: both refs count every success", async () => {
      const count = (n: number): ObjectId => n.toString(16).padStart(40, "0");
      await seed(["refs/heads/left", count(0)], ["refs/heads/right", count(0)]);
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
