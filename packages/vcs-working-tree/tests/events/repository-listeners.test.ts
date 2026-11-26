import { createMemoryRefs } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";

import { observeRefWrites, type RepositoryEvent, RepositoryListeners } from "../../src/index.js";

const ID_A = "a".repeat(40);
const ID_B = "b".repeat(40);

describe("RepositoryListeners", () => {
  it("tells each listener in order, by kind, until removed", () => {
    const listeners = new RepositoryListeners();
    const all: string[] = [];
    const refs: string[] = [];
    const stopAll = listeners.addListener((e: RepositoryEvent) => all.push(e.type));
    listeners.addRefsChangedListener((e) => refs.push(e.type));
    listeners.addListener(() => {
      throw new Error("a failing listener");
    });
    listeners.dispatch({ type: "index-changed" });
    listeners.dispatch({ type: "refs-changed" });
    stopAll();
    listeners.dispatch({ type: "config-changed" });
    expect(all).toEqual(["index-changed", "refs-changed"]);
    expect(refs).toEqual(["refs-changed"]);
  });
});

describe("observeRefWrites", () => {
  it("tells once per write that changed refs, nested writes once", async () => {
    const refs = createMemoryRefs();
    let told = 0;
    const stop = observeRefWrites(refs, () => told++);
    await refs.set("refs/heads/main", ID_A);
    expect(told).toBe(1);
    await refs.setSymbolic("HEAD", "refs/heads/main");
    expect(told).toBe(2);
    const cas = await refs.compareAndSwap("refs/heads/main", ID_B, ID_A);
    expect(cas.success).toBe(false);
    expect(told).toBe(2);
    expect(await refs.remove("refs/heads/none")).toBe(false);
    expect(told).toBe(2);
    await refs.batch([{ name: "refs/heads/main", new: ID_B }]);
    expect(told).toBe(3);
    stop();
    await refs.set("refs/heads/main", ID_A);
    expect(told).toBe(3);
    // a second observer on the same store
    let other = 0;
    observeRefWrites(refs, () => other++);
    await refs.remove("refs/heads/main");
    expect(other).toBe(1);
  });

  it("tells a change of concurrent writes once, even when the last one fails", async () => {
    const refs = createMemoryRefs();
    let told = 0;
    observeRefWrites(refs, () => told++);
    const [, cas] = await Promise.all([
      refs.set("refs/heads/a", ID_A),
      refs.compareAndSwap("refs/heads/b", ID_B, ID_A),
    ]);
    expect(cas.success).toBe(false);
    expect(told).toBe(1);
  });
});
