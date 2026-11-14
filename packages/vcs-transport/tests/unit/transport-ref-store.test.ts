import { MemoryRefs } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";
import { createTransportRefStore } from "../../src/index.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const ZERO = "0".repeat(40);

describe("createTransportRefStore", () => {
  it("deletes a ref for the zero id instead of storing zeros", async () => {
    const refs = new MemoryRefs();
    await refs.set("refs/heads/x", A);
    const store = createTransportRefStore(refs);
    await store.update("refs/heads/x", ZERO);
    expect(await refs.has("refs/heads/x")).toBe(false);
  });

  it("lists symbolic refs by their resolved id and reports symref targets", async () => {
    const refs = new MemoryRefs();
    await refs.set("refs/heads/main", A);
    await refs.setSymbolic("HEAD", "refs/heads/main");
    const store = createTransportRefStore(refs);
    expect([...(await store.listAll())].sort()).toEqual([
      ["HEAD", A],
      ["refs/heads/main", A],
    ]);
    expect(await store.getSymrefTarget?.("HEAD")).toBe("refs/heads/main");
    expect(await store.isRefTip?.(A)).toBe(true);
  });

  it("passes batches through to Refs.batch", async () => {
    const refs = new MemoryRefs();
    await refs.set("refs/heads/main", A);
    const store = createTransportRefStore(refs);
    expect(
      await store.batch?.([
        { name: "refs/heads/main", old: A, new: B },
        { name: "refs/heads/new", old: null, new: A },
      ]),
    ).toEqual({ ok: true, rejected: [] });
    expect(await store.get("refs/heads/main")).toBe(B);
  });
});
