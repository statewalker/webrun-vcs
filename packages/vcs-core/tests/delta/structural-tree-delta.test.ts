/**
 * Tests for structural tree delta computation and application
 */

import { describe, expect, it } from "vitest";

import type { TreeEntry } from "../../src/history/trees/tree-entry.js";
import {
  applyStructuralTreeDelta,
  computeStructuralTreeDelta,
  parseStructuralDelta,
  serializeStructuralDelta,
} from "../../src/storage/delta/structural-tree-delta.js";
import type { StructuralTreeDelta } from "../../src/storage/delta/tree-delta-api.js";

function entry(name: string, id: string, mode = 0o100644): TreeEntry {
  return { name, id, mode };
}

describe("computeStructuralTreeDelta", () => {
  it("detects added entries", () => {
    const base: TreeEntry[] = [entry("README.md", "aaa")];
    const target: TreeEntry[] = [entry("LICENSE", "bbb"), entry("README.md", "aaa")];

    const changes = computeStructuralTreeDelta(base, target);
    expect(changes).toEqual([{ type: "add", name: "LICENSE", mode: 0o100644, objectId: "bbb" }]);
  });

  it("detects deleted entries", () => {
    const base: TreeEntry[] = [entry("LICENSE", "bbb"), entry("README.md", "aaa")];
    const target: TreeEntry[] = [entry("README.md", "aaa")];

    const changes = computeStructuralTreeDelta(base, target);
    expect(changes).toEqual([{ type: "delete", name: "LICENSE" }]);
  });

  it("detects modified entries (content change)", () => {
    const base: TreeEntry[] = [entry("README.md", "aaa")];
    const target: TreeEntry[] = [entry("README.md", "bbb")];

    const changes = computeStructuralTreeDelta(base, target);
    expect(changes).toEqual([
      { type: "modify", name: "README.md", mode: 0o100644, objectId: "bbb" },
    ]);
  });

  it("detects modified entries (mode change)", () => {
    const base: TreeEntry[] = [entry("script.sh", "aaa", 0o100644)];
    const target: TreeEntry[] = [entry("script.sh", "aaa", 0o100755)];

    const changes = computeStructuralTreeDelta(base, target);
    expect(changes).toEqual([
      { type: "modify", name: "script.sh", mode: 0o100755, objectId: "aaa" },
    ]);
  });

  it("returns empty array for identical trees", () => {
    const base: TreeEntry[] = [entry("a.txt", "111"), entry("b.txt", "222")];
    const target: TreeEntry[] = [entry("a.txt", "111"), entry("b.txt", "222")];

    const changes = computeStructuralTreeDelta(base, target);
    expect(changes).toEqual([]);
  });

  it("handles empty base (all adds)", () => {
    const base: TreeEntry[] = [];
    const target: TreeEntry[] = [entry("a.txt", "aaa"), entry("b.txt", "bbb")];

    const changes = computeStructuralTreeDelta(base, target);
    expect(changes).toHaveLength(2);
    expect(changes[0].type).toBe("add");
    expect(changes[1].type).toBe("add");
  });

  it("handles empty target (all deletes)", () => {
    const base: TreeEntry[] = [entry("a.txt", "aaa"), entry("b.txt", "bbb")];
    const target: TreeEntry[] = [];

    const changes = computeStructuralTreeDelta(base, target);
    expect(changes).toHaveLength(2);
    expect(changes[0].type).toBe("delete");
    expect(changes[1].type).toBe("delete");
  });

  it("handles mixed add/modify/delete", () => {
    const base: TreeEntry[] = [
      entry("delete-me.txt", "111"),
      entry("keep.txt", "222"),
      entry("modify-me.txt", "333"),
    ];
    const target: TreeEntry[] = [
      entry("added.txt", "444"),
      entry("keep.txt", "222"),
      entry("modify-me.txt", "555"),
    ];

    const changes = computeStructuralTreeDelta(base, target);
    const types = changes.map((c) => c.type).sort();
    expect(types).toEqual(["add", "delete", "modify"]);

    const add = changes.find((c) => c.type === "add")!;
    expect(add.name).toBe("added.txt");
    expect(add.objectId).toBe("444");

    const modify = changes.find((c) => c.type === "modify")!;
    expect(modify.name).toBe("modify-me.txt");
    expect(modify.objectId).toBe("555");

    const del = changes.find((c) => c.type === "delete")!;
    expect(del.name).toBe("delete-me.txt");
  });

  it("detects directory entries (subtrees)", () => {
    const base: TreeEntry[] = [entry("src", "tree1", 0o040000)];
    const target: TreeEntry[] = [entry("src", "tree2", 0o040000)];

    const changes = computeStructuralTreeDelta(base, target);
    expect(changes).toEqual([{ type: "modify", name: "src", mode: 0o040000, objectId: "tree2" }]);
  });
});

describe("applyStructuralTreeDelta", () => {
  it("applies add changes", () => {
    const base: TreeEntry[] = [entry("a.txt", "111")];
    const result = applyStructuralTreeDelta(base, [
      { type: "add", name: "b.txt", mode: 0o100644, objectId: "222" },
    ]);

    expect(result).toHaveLength(2);
    expect(result.map((e) => e.name)).toEqual(["a.txt", "b.txt"]);
  });

  it("applies delete changes", () => {
    const base: TreeEntry[] = [entry("a.txt", "111"), entry("b.txt", "222")];
    const result = applyStructuralTreeDelta(base, [{ type: "delete", name: "a.txt" }]);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("b.txt");
  });

  it("applies modify changes", () => {
    const base: TreeEntry[] = [entry("a.txt", "111")];
    const result = applyStructuralTreeDelta(base, [
      { type: "modify", name: "a.txt", mode: 0o100755, objectId: "222" },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("222");
    expect(result[0].mode).toBe(0o100755);
  });

  it("returns sorted results", () => {
    const base: TreeEntry[] = [];
    const result = applyStructuralTreeDelta(base, [
      { type: "add", name: "z.txt", mode: 0o100644, objectId: "333" },
      { type: "add", name: "a.txt", mode: 0o100644, objectId: "111" },
      { type: "add", name: "m.txt", mode: 0o100644, objectId: "222" },
    ]);

    expect(result.map((e) => e.name)).toEqual(["a.txt", "m.txt", "z.txt"]);
  });
});

describe("computeStructuralTreeDelta + applyStructuralTreeDelta roundtrip", () => {
  it("roundtrips a complex diff", () => {
    const base: TreeEntry[] = [
      entry("a.txt", "111"),
      entry("b.txt", "222"),
      entry("c.txt", "333"),
      entry("src", "tree1", 0o040000),
    ];
    const target: TreeEntry[] = [
      entry("a.txt", "111"), // unchanged
      entry("b.txt", "444"), // modified
      entry("d.txt", "555"), // added
      entry("src", "tree2", 0o040000), // subtree modified
    ];

    const changes = computeStructuralTreeDelta(base, target);
    const reconstructed = applyStructuralTreeDelta(base, changes);

    expect(reconstructed).toEqual(target);
  });

  it("roundtrips empty to populated", () => {
    const base: TreeEntry[] = [];
    const target: TreeEntry[] = [entry("a.txt", "111"), entry("b.txt", "222")];

    const changes = computeStructuralTreeDelta(base, target);
    const reconstructed = applyStructuralTreeDelta(base, changes);

    expect(reconstructed).toEqual(target);
  });

  it("roundtrips populated to empty", () => {
    const base: TreeEntry[] = [entry("a.txt", "111"), entry("b.txt", "222")];
    const target: TreeEntry[] = [];

    const changes = computeStructuralTreeDelta(base, target);
    const reconstructed = applyStructuralTreeDelta(base, changes);

    expect(reconstructed).toEqual(target);
  });
});

describe("serializeStructuralDelta / parseStructuralDelta roundtrip", () => {
  it("roundtrips a delta with all change types", () => {
    const delta: StructuralTreeDelta = {
      baseTreeId: "abc123def456abc123def456abc123def456abc1",
      changes: [
        { type: "add", name: "new-file.txt", mode: 0o100644, objectId: "111222333444555666" },
        { type: "modify", name: "changed.txt", mode: 0o100755, objectId: "aabbccdd" },
        { type: "delete", name: "removed.txt" },
      ],
    };

    const serialized = serializeStructuralDelta(delta);
    const parsed = parseStructuralDelta(serialized);

    expect(parsed).toEqual(delta);
  });

  it("roundtrips an empty delta", () => {
    const delta: StructuralTreeDelta = {
      baseTreeId: "0000000000000000000000000000000000000000",
      changes: [],
    };

    const serialized = serializeStructuralDelta(delta);
    const parsed = parseStructuralDelta(serialized);

    expect(parsed).toEqual(delta);
  });

  it("handles unicode filenames", () => {
    const delta: StructuralTreeDelta = {
      baseTreeId: "abcdef1234567890abcdef1234567890abcdef12",
      changes: [
        { type: "add", name: "файл.txt", mode: 0o100644, objectId: "aabb" },
        { type: "add", name: "文件.md", mode: 0o100644, objectId: "ccdd" },
      ],
    };

    const serialized = serializeStructuralDelta(delta);
    const parsed = parseStructuralDelta(serialized);

    expect(parsed).toEqual(delta);
  });
});
