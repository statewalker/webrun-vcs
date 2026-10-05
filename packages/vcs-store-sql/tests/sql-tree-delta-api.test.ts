/**
 * Tests for SqlTreeDeltaApi
 *
 * Verifies structural tree delta storage and retrieval in SQL tables.
 */

import {
  type StructuralTreeDelta,
  serializeStructuralDelta,
  type TreeDeltaChange,
} from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import { SqlTreeDeltaApi } from "../src/sql-tree-delta-api.js";

function oid(seed: string): string {
  return seed.padStart(40, "0");
}

async function* toStream(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

function createDelta(baseId: string, changes: TreeDeltaChange[]): Uint8Array {
  const delta: StructuralTreeDelta = { baseTreeId: baseId, changes };
  return serializeStructuralDelta(delta);
}

describe("SqlTreeDeltaApi", () => {
  let db: SqlJsAdapter;
  let api: SqlTreeDeltaApi;

  beforeEach(async () => {
    db = await SqlJsAdapter.create();
    api = new SqlTreeDeltaApi(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it("isTreeDelta returns false for non-delta", async () => {
    expect(await api.isTreeDelta(oid("1"))).toBe(false);
  });

  it("deltifyTree stores delta and isTreeDelta returns true", async () => {
    const targetId = oid("target1");
    const baseId = oid("base1");
    const changes: TreeDeltaChange[] = [
      { type: "add", name: "file.txt", mode: 0o100644, objectId: oid("file1") },
    ];
    const deltaBytes = createDelta(baseId, changes);

    await api.deltifyTree(targetId, baseId, toStream(deltaBytes));
    expect(await api.isTreeDelta(targetId)).toBe(true);
  });

  it("undeltifyTree removes delta", async () => {
    const targetId = oid("target1");
    const baseId = oid("base1");
    const changes: TreeDeltaChange[] = [
      { type: "add", name: "file.txt", mode: 0o100644, objectId: oid("file1") },
    ];
    await api.deltifyTree(targetId, baseId, toStream(createDelta(baseId, changes)));
    expect(await api.isTreeDelta(targetId)).toBe(true);

    await api.undeltifyTree(targetId);
    expect(await api.isTreeDelta(targetId)).toBe(false);
  });

  it("getTreeDeltaChain returns chain info", async () => {
    const id1 = oid("1");
    const id2 = oid("2");
    const id3 = oid("3");

    // Chain: id3 -> id2 -> id1
    await api.deltifyTree(
      id2,
      id1,
      toStream(
        createDelta(id1, [{ type: "add", name: "a.txt", mode: 0o100644, objectId: oid("a") }]),
      ),
    );
    await api.deltifyTree(
      id3,
      id2,
      toStream(
        createDelta(id2, [{ type: "add", name: "b.txt", mode: 0o100644, objectId: oid("b") }]),
      ),
    );

    const chain = await api.getTreeDeltaChain(id3);
    expect(chain).toBeDefined();
    expect(chain?.depth).toBe(2);
    expect(chain?.baseIds).toEqual([id2, id1]);
  });

  it("getTreeDeltaChain returns undefined for non-delta", async () => {
    expect(await api.getTreeDeltaChain(oid("nonexistent"))).toBeUndefined();
  });

  it("loadDeltaChanges returns stored changes", async () => {
    const targetId = oid("target1");
    const baseId = oid("base1");
    const changes: TreeDeltaChange[] = [
      { type: "add", name: "new.txt", mode: 0o100644, objectId: oid("new1") },
      { type: "delete", name: "old.txt" },
      { type: "modify", name: "changed.txt", mode: 0o100644, objectId: oid("changed1") },
    ];
    await api.deltifyTree(targetId, baseId, toStream(createDelta(baseId, changes)));

    const result = await api.loadDeltaChanges(targetId);
    expect(result).toBeDefined();
    expect(result?.baseId).toBe(baseId);
    expect(result?.changes).toHaveLength(3);
    expect(result?.changes.find((c) => c.name === "new.txt")?.type).toBe("add");
    expect(result?.changes.find((c) => c.name === "old.txt")?.type).toBe("delete");
    expect(result?.changes.find((c) => c.name === "changed.txt")?.type).toBe("modify");
  });

  it("loadDeltaChanges returns undefined for non-delta", async () => {
    expect(await api.loadDeltaChanges(oid("nonexistent"))).toBeUndefined();
  });

  it("deltifyTree replaces existing delta", async () => {
    const targetId = oid("target1");
    const baseId1 = oid("base1");
    const baseId2 = oid("base2");

    await api.deltifyTree(
      targetId,
      baseId1,
      toStream(
        createDelta(baseId1, [{ type: "add", name: "a.txt", mode: 0o100644, objectId: oid("a") }]),
      ),
    );

    await api.deltifyTree(
      targetId,
      baseId2,
      toStream(
        createDelta(baseId2, [{ type: "add", name: "b.txt", mode: 0o100644, objectId: oid("b") }]),
      ),
    );

    const result = await api.loadDeltaChanges(targetId);
    expect(result?.baseId).toBe(baseId2);
    expect(result?.changes).toHaveLength(1);
    expect(result?.changes[0].name).toBe("b.txt");
  });

  it("findTreeDelta returns null", async () => {
    async function* empty(): AsyncIterable<string> {}
    expect(await api.findTreeDelta(oid("1"), empty())).toBeNull();
  });

  it("loadDeltaChanges preserves mode and objectId for add/modify", async () => {
    const targetId = oid("target1");
    const baseId = oid("base1");
    const changes: TreeDeltaChange[] = [
      { type: "add", name: "exec.sh", mode: 0o100755, objectId: oid("exec1") },
      { type: "modify", name: "readme.md", mode: 0o100644, objectId: oid("readme1") },
    ];
    await api.deltifyTree(targetId, baseId, toStream(createDelta(baseId, changes)));

    const result = await api.loadDeltaChanges(targetId);
    expect(result).toBeDefined();

    const addChange = result?.changes.find((c) => c.name === "exec.sh");
    expect(addChange?.mode).toBe(0o100755);
    expect(addChange?.objectId).toBe(oid("exec1"));

    const modifyChange = result?.changes.find((c) => c.name === "readme.md");
    expect(modifyChange?.mode).toBe(0o100644);
    expect(modifyChange?.objectId).toBe(oid("readme1"));
  });

  it("loadDeltaChanges omits mode and objectId for delete", async () => {
    const targetId = oid("target1");
    const baseId = oid("base1");
    const changes: TreeDeltaChange[] = [{ type: "delete", name: "removed.txt" }];
    await api.deltifyTree(targetId, baseId, toStream(createDelta(baseId, changes)));

    const result = await api.loadDeltaChanges(targetId);
    expect(result).toBeDefined();
    expect(result?.changes).toHaveLength(1);
    expect(result?.changes[0].type).toBe("delete");
    expect(result?.changes[0].mode).toBeUndefined();
    expect(result?.changes[0].objectId).toBeUndefined();
  });

  it("undeltifyTree is idempotent", async () => {
    const targetId = oid("target1");

    // Should not throw for non-existent delta
    await api.undeltifyTree(targetId);
    expect(await api.isTreeDelta(targetId)).toBe(false);
  });

  it("getTreeDeltaChain single depth", async () => {
    const targetId = oid("target1");
    const baseId = oid("base1");
    const changes: TreeDeltaChange[] = [
      { type: "add", name: "file.txt", mode: 0o100644, objectId: oid("file1") },
    ];
    await api.deltifyTree(targetId, baseId, toStream(createDelta(baseId, changes)));

    const chain = await api.getTreeDeltaChain(targetId);
    expect(chain).toBeDefined();
    expect(chain?.depth).toBe(1);
    expect(chain?.baseIds).toEqual([baseId]);
  });
});
