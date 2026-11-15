/**
 * The one-by-one fallback of the remote commands' multi-ref moves, for a store whose batch
 * refuses several refs (vcs-core's interim `kvStoreRefs`): a new name is created only if
 * it does not exist, before the old one goes, so no ref is overwritten or lost.
 */

import { MemoryRefs, type RefCommand, type Refs } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";

import { moveRefs } from "../src/remote-config/index.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

/** Memory refs whose batch refuses more than one command, as `batchBySingleRef` does. */
function singleRefStore(): Refs {
  const refs = new MemoryRefs();
  const batch = refs.batch.bind(refs);
  refs.batch = async (commands: RefCommand[], options) =>
    commands.length > 1
      ? { ok: false, rejected: commands.map((c) => ({ name: c.name, reason: "unsupported" })) }
      : batch(commands, options);
  return refs;
}

describe("moveRefs on a store without multi-ref batches", () => {
  it("moves each ref to its new name", async () => {
    const refs = singleRefStore();
    await refs.set("refs/remotes/old/main", A);
    await refs.set("refs/remotes/old/next", B);
    await refs.setSymbolic("refs/remotes/old/HEAD", "refs/remotes/old/main");
    await moveRefs(
      refs,
      ["main", "next", "HEAD"].map((n) => ({
        from: `refs/remotes/old/${n}`,
        to: `refs/remotes/new/${n}`,
      })),
      (target) => target.replace("refs/remotes/old/", "refs/remotes/new/"),
    );
    expect((await refs.resolve("refs/remotes/new/main"))?.objectId).toBe(A);
    expect((await refs.resolve("refs/remotes/new/next"))?.objectId).toBe(B);
    expect(await refs.get("refs/remotes/new/HEAD")).toMatchObject({
      target: "refs/remotes/new/main",
    });
    expect(await refs.get("refs/remotes/old/main")).toBeUndefined();
    expect(await refs.get("refs/remotes/old/HEAD")).toBeUndefined();
  });

  it("stops at a new name that exists: neither overwritten nor the old ref lost", async () => {
    const refs = singleRefStore();
    await refs.set("refs/remotes/old/main", A);
    await refs.set("refs/remotes/new/main", B);
    await expect(
      moveRefs(refs, [{ from: "refs/remotes/old/main", to: "refs/remotes/new/main" }], (t) => t),
    ).rejects.toThrow("refs/remotes/new/main exists");
    expect((await refs.resolve("refs/remotes/new/main"))?.objectId).toBe(B);
    expect((await refs.resolve("refs/remotes/old/main"))?.objectId).toBe(A);
  });
});
