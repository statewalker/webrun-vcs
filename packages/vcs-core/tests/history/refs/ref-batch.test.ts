import { memKvStore } from "@statewalker/webrun-storage";
import { describe, expect, it } from "vitest";
import { isUpdatableRefName, planRefBatch } from "../../../src/history/refs/index.js";
import { kvStoreRefs } from "../../../src/storage/adapters/index.js";

const oid = (n: number) => n.toString(16).padStart(40, "a");

describe("isUpdatableRefName", () => {
  it("accepts HEAD and valid names under refs/ only", () => {
    expect(isUpdatableRefName("HEAD")).toBe(true);
    expect(isUpdatableRefName("refs/heads/main")).toBe(true);
    for (const name of ["main", "ORIG_HEAD", "refs/heads/a..b", "heads/main", "refs/"]) {
      expect(isUpdatableRefName(name), name).toBe(false);
    }
  });
});

describe("planRefBatch", () => {
  /** A view over refs/s0 -> refs/s1 -> … -> refs/s{n} (direct). */
  const chainView = (symrefs: number) => ({
    read: (name: string) => {
      const i = Number(name.slice("refs/s".length));
      if (!name.startsWith("refs/s") || i > symrefs) return undefined;
      return i < symrefs
        ? { name, target: `refs/s${i + 1}`, storage: "loose" as never }
        : { name, objectId: oid(1), storage: "loose" as never, peeled: false };
    },
    hasChildren: () => false,
  });

  it("follows 4 symbolic refs (5 refs read, git's read limit) and refuses 5", async () => {
    const four = await planRefBatch([{ name: "refs/s0", new: oid(2) }], chainView(4));
    expect(four.ok && four.updates[0]?.name).toBe("refs/s4");
    const five = await planRefBatch([{ name: "refs/s0", new: oid(2) }], chainView(5));
    expect(five).toEqual({ ok: false, rejected: [{ name: "refs/s0", reason: "invalid-command" }] });
  });

  it("reports the requested name and the symbolic refs a command went through", async () => {
    const plan = await planRefBatch([{ name: "HEAD", new: oid(2) }], {
      read: (name) =>
        name === "HEAD"
          ? { name, target: "refs/heads/main", storage: "loose" as never }
          : name === "refs/heads/main"
            ? { name, objectId: oid(1), storage: "loose" as never, peeled: false }
            : undefined,
      hasChildren: () => false,
    });
    expect(plan).toEqual({
      ok: true,
      updates: [
        {
          name: "refs/heads/main",
          requested: "HEAD",
          current: { name: "refs/heads/main", objectId: oid(1), storage: "loose", peeled: false },
          oldValue: oid(1),
          newValue: oid(2),
          reflogAlso: ["HEAD"],
        },
      ],
    });
  });
});

describe("planRefBatch: reflogs and noDeref", () => {
  const headView = {
    read: (name: string) =>
      name === "HEAD"
        ? { name, target: "refs/heads/main", storage: "loose" as never }
        : name === "refs/heads/main"
          ? { name, objectId: oid(1), storage: "loose" as never, peeled: false }
          : undefined,
    hasChildren: () => false,
  };

  it("logs HEAD too when its branch is updated by name, as git does", async () => {
    const plan = await planRefBatch([{ name: "refs/heads/main", new: oid(2) }], headView);
    expect(plan.ok && plan.updates[0]?.reflogAlso).toEqual(["HEAD"]);
  });

  it("with noDeref, writes the symbolic ref itself but compares old with its target's value", async () => {
    const plan = await planRefBatch(
      [{ name: "HEAD", old: oid(1), new: oid(2), noDeref: true }],
      headView,
    );
    expect(plan.ok && plan.updates[0]).toMatchObject({
      name: "HEAD",
      current: { target: "refs/heads/main" },
      oldValue: oid(1),
      reflogAlso: [],
    });
    const mustNotExist = await planRefBatch(
      [{ name: "HEAD", old: null, new: oid(2), noDeref: true }],
      headView,
    );
    expect(mustNotExist).toEqual({ ok: false, rejected: [{ name: "HEAD", reason: "mismatch" }] });
  });
});

describe("interim single-ref batch (kvStoreRefs)", () => {
  it("applies one command with the batch rules, and refuses several as not-atomic", async () => {
    const refs = kvStoreRefs(memKvStore());
    expect(await refs.batch([{ name: "refs/heads/a", old: null, new: oid(1) }])).toEqual({
      ok: true,
      rejected: [],
    });
    expect(await refs.batch([{ name: "refs/heads/a", old: oid(9), new: oid(2) }])).toEqual({
      ok: false,
      rejected: [{ name: "refs/heads/a", reason: "mismatch" }],
    });
    expect((await refs.batch([{ name: "bad name", new: oid(2) }])).rejected).toEqual([
      { name: "bad name", reason: "invalid-name" },
    ]);
    const several = await refs.batch([
      { name: "refs/heads/b", new: oid(3) },
      { name: "refs/heads/c", new: oid(4) },
    ]);
    expect(several.rejected.map((r) => r.reason)).toEqual(["unsupported", "unsupported"]);
    expect(await refs.has("refs/heads/b")).toBe(false);
    expect(await refs.batch([{ name: "refs/heads/a", old: oid(1), new: null }])).toEqual({
      ok: true,
      rejected: [],
    });
    expect(await refs.has("refs/heads/a")).toBe(false);
    // Deleting a missing ref is a no-op, as in git.
    expect(await refs.batch([{ name: "refs/heads/a", new: null }])).toEqual({
      ok: true,
      rejected: [],
    });
  });
});
