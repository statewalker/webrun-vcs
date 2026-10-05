/**
 * Tests for MemoryTreeDeltaApi
 */

import { createMemoryObjectStores } from "@statewalker/vcs-store-mem";
import { beforeEach, describe, expect, it } from "vitest";
import type { TreeEntry } from "../../src/history/trees/tree-entry.js";
import { MemoryTreeDeltaApi } from "../../src/storage/delta/memory-tree-delta-api.js";
import { serializeStructuralDelta } from "../../src/storage/delta/structural-tree-delta.js";
import type { StructuralTreeDelta } from "../../src/storage/delta/tree-delta-api.js";

/** Create a fake 40-char hex SHA-1 from a short seed */
function oid(seed: string): string {
  return seed.padStart(40, "0");
}

function entry(name: string, id: string, mode = 0o100644): TreeEntry {
  return { name, id: oid(id), mode };
}

describe("MemoryTreeDeltaApi", () => {
  let trees: ReturnType<typeof createMemoryObjectStores>["trees"];
  let api: MemoryTreeDeltaApi;

  beforeEach(() => {
    const stores = createMemoryObjectStores();
    trees = stores.trees;
    api = new MemoryTreeDeltaApi(trees);
  });

  it("isTreeDelta returns false for non-delta trees", async () => {
    const id = await trees.store([entry("a.txt", "111")]);
    expect(await api.isTreeDelta(id)).toBe(false);
  });

  it("deltifyTreeFromEntries stores structural delta", async () => {
    const baseEntries = [entry("a.txt", "111"), entry("b.txt", "222")];
    const targetEntries = [entry("a.txt", "111"), entry("c.txt", "333")];

    const baseId = await trees.store(baseEntries);
    const targetId = await trees.store(targetEntries);

    await api.deltifyTreeFromEntries(targetId, baseId, baseEntries, targetEntries);

    expect(await api.isTreeDelta(targetId)).toBe(true);

    const stored = api.getStoredDelta(targetId);
    expect(stored).toBeDefined();
    expect(stored?.baseId).toBe(baseId);
    expect(stored?.changes).toHaveLength(2); // delete b.txt + add c.txt
  });

  it("resolveTreeEntries reconstructs full tree from delta", async () => {
    const baseEntries = [entry("a.txt", "111"), entry("b.txt", "222")];
    const targetEntries = [entry("a.txt", "111"), entry("c.txt", "333")];

    const baseId = await trees.store(baseEntries);
    const targetId = await trees.store(targetEntries);

    await api.deltifyTreeFromEntries(targetId, baseId, baseEntries, targetEntries);

    const resolved = await api.resolveTreeEntries(targetId);
    expect(resolved).toEqual(targetEntries);
  });

  it("undeltifyTree expands delta and stores full tree", async () => {
    const baseEntries = [entry("a.txt", "111")];
    const targetEntries = [entry("a.txt", "111"), entry("b.txt", "222")];

    const baseId = await trees.store(baseEntries);
    const targetId = await trees.store(targetEntries);

    await api.deltifyTreeFromEntries(targetId, baseId, baseEntries, targetEntries);
    expect(await api.isTreeDelta(targetId)).toBe(true);

    await api.undeltifyTree(targetId);
    expect(await api.isTreeDelta(targetId)).toBe(false);
  });

  it("getTreeDeltaChain returns chain info", async () => {
    const entries1 = [entry("a.txt", "111")];
    const entries2 = [entry("a.txt", "111"), entry("b.txt", "222")];
    const entries3 = [entry("a.txt", "111"), entry("b.txt", "222"), entry("c.txt", "333")];

    const id1 = await trees.store(entries1);
    const id2 = await trees.store(entries2);
    const id3 = await trees.store(entries3);

    // Chain: id3 -> id2 -> id1
    await api.deltifyTreeFromEntries(id2, id1, entries1, entries2);
    await api.deltifyTreeFromEntries(id3, id2, entries2, entries3);

    const chain = await api.getTreeDeltaChain(id3);
    expect(chain).toBeDefined();
    expect(chain?.depth).toBe(2);
    expect(chain?.baseIds).toEqual([id2, id1]);
  });

  it("getTreeDeltaChain returns undefined for non-delta", async () => {
    const id = await trees.store([entry("a.txt", "111")]);
    const chain = await api.getTreeDeltaChain(id);
    expect(chain).toBeUndefined();
  });

  it("deltifyTree from serialized delta", async () => {
    const baseEntries = [entry("a.txt", "111")];
    const targetEntries = [entry("a.txt", "222")];

    const baseId = await trees.store(baseEntries);
    const targetId = await trees.store(targetEntries);

    // Create serialized structural delta
    const delta: StructuralTreeDelta = {
      baseTreeId: baseId,
      changes: [{ type: "modify", name: "a.txt", mode: 0o100644, objectId: oid("222") }],
    };
    const serialized = serializeStructuralDelta(delta);

    async function* toStream(data: Uint8Array): AsyncIterable<Uint8Array> {
      yield data;
    }

    await api.deltifyTree(targetId, baseId, toStream(serialized));
    expect(await api.isTreeDelta(targetId)).toBe(true);

    const resolved = await api.resolveTreeEntries(targetId);
    expect(resolved).toEqual(targetEntries);
  });

  it("resolves chained deltas correctly", async () => {
    const entries1 = [entry("a.txt", "111")];
    const entries2 = [entry("a.txt", "111"), entry("b.txt", "222")];
    const entries3 = [entry("b.txt", "222"), entry("c.txt", "333")];

    const id1 = await trees.store(entries1);
    const id2 = await trees.store(entries2);
    const id3 = await trees.store(entries3);

    await api.deltifyTreeFromEntries(id2, id1, entries1, entries2);
    await api.deltifyTreeFromEntries(id3, id2, entries2, entries3);

    const resolved = await api.resolveTreeEntries(id3);
    expect(resolved).toEqual(entries3);
  });

  it("findTreeDelta returns null (memory backend)", async () => {
    const id = await trees.store([entry("a.txt", "111")]);
    async function* empty(): AsyncIterable<string> {}

    const result = await api.findTreeDelta(id, empty());
    expect(result).toBeNull();
  });
});
