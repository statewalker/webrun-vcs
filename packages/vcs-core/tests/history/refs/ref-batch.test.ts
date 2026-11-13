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
  it("refuses a symbolic-ref chain deeper than git's 5 levels", async () => {
    const chain = new Map<string, string>();
    for (let i = 0; i < 6; i++) chain.set(`refs/s${i}`, `refs/s${i + 1}`);
    const plan = await planRefBatch([{ name: "refs/s0", new: oid(1) }], {
      read: (name) => {
        const target = chain.get(name);
        return target ? { name, target, storage: "loose" as never } : undefined;
      },
      hasChildren: () => false,
    });
    expect(plan).toEqual({ ok: false, rejected: [{ name: "refs/s0", reason: "invalid-command" }] });
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
          via: ["HEAD"],
          oldValue: oid(1),
          newValue: oid(2),
        },
      ],
    });
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
    expect(several.rejected.map((r) => r.reason)).toEqual(["not-atomic", "not-atomic"]);
    expect(await refs.has("refs/heads/b")).toBe(false);
    expect(await refs.batch([{ name: "refs/heads/a", old: oid(1), new: null }])).toEqual({
      ok: true,
      rejected: [],
    });
    expect(await refs.has("refs/heads/a")).toBe(false);
  });
});
