import { describe, expect, it } from "vitest";

import {
  CheckoutConflictType,
  classifyThreeWayEntry,
  collectThreeWayEntries,
  compareThreeWayTrees,
  flattenTree,
  isConflictChange,
  mergeTreesThreeWay,
  shouldDelete,
  shouldTakeOurs,
  shouldTakeTheirs,
  ThreeWayChange,
  type ThreeWayEntry,
} from "../../src/working-copy/checkout-utils.js";
import { createMockTreeStore } from "../mocks/mock-tree-store.js";

describe("ThreeWayChange constants", () => {
  it("exports all expected change types", () => {
    expect(ThreeWayChange.UNCHANGED).toBe("UNCHANGED");
    expect(ThreeWayChange.ADDED_BY_US).toBe("ADDED_BY_US");
    expect(ThreeWayChange.ADDED_BY_THEM).toBe("ADDED_BY_THEM");
    expect(ThreeWayChange.ADDED_BOTH_SAME).toBe("ADDED_BOTH_SAME");
    expect(ThreeWayChange.ADDED_BOTH_DIFFER).toBe("ADDED_BOTH_DIFFER");
    expect(ThreeWayChange.DELETED_BY_US).toBe("DELETED_BY_US");
    expect(ThreeWayChange.DELETED_BY_THEM).toBe("DELETED_BY_THEM");
    expect(ThreeWayChange.DELETED_BOTH).toBe("DELETED_BOTH");
    expect(ThreeWayChange.MODIFIED_BY_US).toBe("MODIFIED_BY_US");
    expect(ThreeWayChange.MODIFIED_BY_THEM).toBe("MODIFIED_BY_THEM");
    expect(ThreeWayChange.MODIFIED_BOTH_SAME).toBe("MODIFIED_BOTH_SAME");
    expect(ThreeWayChange.MODIFIED_BOTH_DIFFER).toBe("MODIFIED_BOTH_DIFFER");
    expect(ThreeWayChange.DELETE_MODIFY_CONFLICT).toBe("DELETE_MODIFY_CONFLICT");
    expect(ThreeWayChange.MODIFY_DELETE_CONFLICT).toBe("MODIFY_DELETE_CONFLICT");
  });
});

describe("CheckoutConflictType constants", () => {
  it("exports all expected conflict types", () => {
    expect(CheckoutConflictType.DIRTY_WORKTREE).toBe("DIRTY_WORKTREE");
    expect(CheckoutConflictType.DIRTY_INDEX).toBe("DIRTY_INDEX");
    expect(CheckoutConflictType.UNTRACKED_FILE).toBe("UNTRACKED_FILE");
    expect(CheckoutConflictType.NOT_DELETED_DIR).toBe("NOT_DELETED_DIR");
  });
});

describe("classifyThreeWayEntry", () => {
  const makeEntry = (id: string, mode = 0o100644) => ({ id, mode, name: "file" });

  it("classifies unchanged entries", () => {
    const entry: ThreeWayEntry = {
      path: "file.txt",
      base: makeEntry("abc123"),
      ours: makeEntry("abc123"),
      theirs: makeEntry("abc123"),
    };
    const result = classifyThreeWayEntry(entry);
    expect(result.change).toBe(ThreeWayChange.UNCHANGED);
    expect(result.isConflict).toBe(false);
    expect(result.resolvedEntry).toBeDefined();
  });

  it("classifies added by us", () => {
    const entry: ThreeWayEntry = {
      path: "new-file.txt",
      base: undefined,
      ours: makeEntry("abc123"),
      theirs: undefined,
    };
    const result = classifyThreeWayEntry(entry);
    expect(result.change).toBe(ThreeWayChange.ADDED_BY_US);
    expect(result.isConflict).toBe(false);
  });

  it("classifies added by them", () => {
    const entry: ThreeWayEntry = {
      path: "new-file.txt",
      base: undefined,
      ours: undefined,
      theirs: makeEntry("abc123"),
    };
    const result = classifyThreeWayEntry(entry);
    expect(result.change).toBe(ThreeWayChange.ADDED_BY_THEM);
    expect(result.isConflict).toBe(false);
  });

  it("classifies added both same", () => {
    const entry: ThreeWayEntry = {
      path: "new-file.txt",
      base: undefined,
      ours: makeEntry("abc123"),
      theirs: makeEntry("abc123"),
    };
    const result = classifyThreeWayEntry(entry);
    expect(result.change).toBe(ThreeWayChange.ADDED_BOTH_SAME);
    expect(result.isConflict).toBe(false);
  });

  it("classifies added both differ as conflict", () => {
    const entry: ThreeWayEntry = {
      path: "new-file.txt",
      base: undefined,
      ours: makeEntry("abc123"),
      theirs: makeEntry("def456"),
    };
    const result = classifyThreeWayEntry(entry);
    expect(result.change).toBe(ThreeWayChange.ADDED_BOTH_DIFFER);
    expect(result.isConflict).toBe(true);
  });

  it("classifies deleted by us", () => {
    const entry: ThreeWayEntry = {
      path: "file.txt",
      base: makeEntry("abc123"),
      ours: undefined,
      theirs: makeEntry("abc123"),
    };
    const result = classifyThreeWayEntry(entry);
    expect(result.change).toBe(ThreeWayChange.DELETED_BY_US);
    expect(result.isConflict).toBe(false);
  });

  it("classifies deleted by them", () => {
    const entry: ThreeWayEntry = {
      path: "file.txt",
      base: makeEntry("abc123"),
      ours: makeEntry("abc123"),
      theirs: undefined,
    };
    const result = classifyThreeWayEntry(entry);
    expect(result.change).toBe(ThreeWayChange.DELETED_BY_THEM);
    expect(result.isConflict).toBe(false);
  });

  it("classifies deleted both", () => {
    const entry: ThreeWayEntry = {
      path: "file.txt",
      base: makeEntry("abc123"),
      ours: undefined,
      theirs: undefined,
    };
    const result = classifyThreeWayEntry(entry);
    expect(result.change).toBe(ThreeWayChange.DELETED_BOTH);
    expect(result.isConflict).toBe(false);
  });

  it("classifies modified by us", () => {
    const entry: ThreeWayEntry = {
      path: "file.txt",
      base: makeEntry("abc123"),
      ours: makeEntry("modified"),
      theirs: makeEntry("abc123"),
    };
    const result = classifyThreeWayEntry(entry);
    expect(result.change).toBe(ThreeWayChange.MODIFIED_BY_US);
    expect(result.isConflict).toBe(false);
  });

  it("classifies modified by them", () => {
    const entry: ThreeWayEntry = {
      path: "file.txt",
      base: makeEntry("abc123"),
      ours: makeEntry("abc123"),
      theirs: makeEntry("modified"),
    };
    const result = classifyThreeWayEntry(entry);
    expect(result.change).toBe(ThreeWayChange.MODIFIED_BY_THEM);
    expect(result.isConflict).toBe(false);
  });

  it("classifies modified both same", () => {
    const entry: ThreeWayEntry = {
      path: "file.txt",
      base: makeEntry("abc123"),
      ours: makeEntry("modified"),
      theirs: makeEntry("modified"),
    };
    const result = classifyThreeWayEntry(entry);
    expect(result.change).toBe(ThreeWayChange.MODIFIED_BOTH_SAME);
    expect(result.isConflict).toBe(false);
  });

  it("classifies modified both differ as conflict", () => {
    const entry: ThreeWayEntry = {
      path: "file.txt",
      base: makeEntry("abc123"),
      ours: makeEntry("ours-mod"),
      theirs: makeEntry("theirs-mod"),
    };
    const result = classifyThreeWayEntry(entry);
    expect(result.change).toBe(ThreeWayChange.MODIFIED_BOTH_DIFFER);
    expect(result.isConflict).toBe(true);
  });

  it("classifies delete/modify conflict", () => {
    const entry: ThreeWayEntry = {
      path: "file.txt",
      base: makeEntry("abc123"),
      ours: undefined,
      theirs: makeEntry("modified"),
    };
    const result = classifyThreeWayEntry(entry);
    expect(result.change).toBe(ThreeWayChange.DELETE_MODIFY_CONFLICT);
    expect(result.isConflict).toBe(true);
  });

  it("classifies modify/delete conflict", () => {
    const entry: ThreeWayEntry = {
      path: "file.txt",
      base: makeEntry("abc123"),
      ours: makeEntry("modified"),
      theirs: undefined,
    };
    const result = classifyThreeWayEntry(entry);
    expect(result.change).toBe(ThreeWayChange.MODIFY_DELETE_CONFLICT);
    expect(result.isConflict).toBe(true);
  });

  it("considers mode differences as changes", () => {
    const entry: ThreeWayEntry = {
      path: "script.sh",
      base: makeEntry("abc123", 0o100644),
      ours: makeEntry("abc123", 0o100755),
      theirs: makeEntry("abc123", 0o100644),
    };
    const result = classifyThreeWayEntry(entry);
    expect(result.change).toBe(ThreeWayChange.MODIFIED_BY_US);
  });
});

describe("helper functions", () => {
  describe("shouldTakeTheirs", () => {
    it("returns true for theirs-specific changes", () => {
      expect(shouldTakeTheirs(ThreeWayChange.ADDED_BY_THEM)).toBe(true);
      expect(shouldTakeTheirs(ThreeWayChange.MODIFIED_BY_THEM)).toBe(true);
      expect(shouldTakeTheirs(ThreeWayChange.DELETED_BY_US)).toBe(true);
    });

    it("returns false for other changes", () => {
      expect(shouldTakeTheirs(ThreeWayChange.ADDED_BY_US)).toBe(false);
      expect(shouldTakeTheirs(ThreeWayChange.UNCHANGED)).toBe(false);
    });
  });

  describe("shouldTakeOurs", () => {
    it("returns true for ours-specific changes", () => {
      expect(shouldTakeOurs(ThreeWayChange.ADDED_BY_US)).toBe(true);
      expect(shouldTakeOurs(ThreeWayChange.MODIFIED_BY_US)).toBe(true);
      expect(shouldTakeOurs(ThreeWayChange.DELETED_BY_THEM)).toBe(true);
      expect(shouldTakeOurs(ThreeWayChange.UNCHANGED)).toBe(true);
    });

    it("returns false for theirs changes", () => {
      expect(shouldTakeOurs(ThreeWayChange.ADDED_BY_THEM)).toBe(false);
    });
  });

  describe("shouldDelete", () => {
    it("returns true only for deleted both", () => {
      expect(shouldDelete(ThreeWayChange.DELETED_BOTH)).toBe(true);
      expect(shouldDelete(ThreeWayChange.DELETED_BY_US)).toBe(false);
      expect(shouldDelete(ThreeWayChange.DELETED_BY_THEM)).toBe(false);
    });
  });

  describe("isConflictChange", () => {
    it("returns true for conflict types", () => {
      expect(isConflictChange(ThreeWayChange.ADDED_BOTH_DIFFER)).toBe(true);
      expect(isConflictChange(ThreeWayChange.MODIFIED_BOTH_DIFFER)).toBe(true);
      expect(isConflictChange(ThreeWayChange.DELETE_MODIFY_CONFLICT)).toBe(true);
      expect(isConflictChange(ThreeWayChange.MODIFY_DELETE_CONFLICT)).toBe(true);
    });

    it("returns false for non-conflict types", () => {
      expect(isConflictChange(ThreeWayChange.UNCHANGED)).toBe(false);
      expect(isConflictChange(ThreeWayChange.ADDED_BY_US)).toBe(false);
      expect(isConflictChange(ThreeWayChange.MODIFIED_BOTH_SAME)).toBe(false);
    });
  });
});

describe("flattenTree", () => {
  it("returns empty map for undefined tree", async () => {
    const trees = createMockTreeStore();
    const result = await flattenTree(trees, undefined);
    expect(result.size).toBe(0);
  });

  it("flattens a simple tree", async () => {
    const trees = createMockTreeStore({
      tree1: [
        { name: "file1.txt", id: "blob1", mode: 0o100644 },
        { name: "file2.txt", id: "blob2", mode: 0o100644 },
      ],
    });

    const result = await flattenTree(trees, "tree1");
    expect(result.size).toBe(2);
    expect(result.get("file1.txt")?.id).toBe("blob1");
    expect(result.get("file2.txt")?.id).toBe("blob2");
  });

  it("flattens nested trees", async () => {
    const trees = createMockTreeStore({
      root: [
        { name: "file.txt", id: "blob1", mode: 0o100644 },
        { name: "src", id: "subtree", mode: 0o040000 },
      ],
      subtree: [
        { name: "main.ts", id: "blob2", mode: 0o100644 },
        { name: "lib", id: "subtree2", mode: 0o040000 },
      ],
      subtree2: [{ name: "utils.ts", id: "blob3", mode: 0o100644 }],
    });

    const result = await flattenTree(trees, "root");
    expect(result.size).toBe(3);
    expect(result.get("file.txt")?.id).toBe("blob1");
    expect(result.get("src/main.ts")?.id).toBe("blob2");
    expect(result.get("src/lib/utils.ts")?.id).toBe("blob3");
  });
});

describe("collectThreeWayEntries", () => {
  it("yields entries from all three trees", async () => {
    const trees = createMockTreeStore({
      base: [{ name: "file1.txt", id: "base1", mode: 0o100644 }],
      ours: [
        { name: "file1.txt", id: "ours1", mode: 0o100644 },
        { name: "file2.txt", id: "ours2", mode: 0o100644 },
      ],
      theirs: [
        { name: "file1.txt", id: "theirs1", mode: 0o100644 },
        { name: "file3.txt", id: "theirs3", mode: 0o100644 },
      ],
    });

    const entries: ThreeWayEntry[] = [];
    for await (const entry of collectThreeWayEntries(trees, "base", "ours", "theirs")) {
      entries.push(entry);
    }

    expect(entries.length).toBe(3);
    expect(entries.map((e) => e.path).sort()).toEqual(["file1.txt", "file2.txt", "file3.txt"]);

    const file1 = entries.find((e) => e.path === "file1.txt");
    expect(file1?.base?.id).toBe("base1");
    expect(file1?.ours?.id).toBe("ours1");
    expect(file1?.theirs?.id).toBe("theirs1");

    const file2 = entries.find((e) => e.path === "file2.txt");
    expect(file2?.base).toBeUndefined();
    expect(file2?.ours?.id).toBe("ours2");
    expect(file2?.theirs).toBeUndefined();
  });
});

describe("compareThreeWayTrees", () => {
  it("separates resolved and conflicts", async () => {
    const trees = createMockTreeStore({
      base: [
        { name: "unchanged.txt", id: "same", mode: 0o100644 },
        { name: "conflict.txt", id: "base", mode: 0o100644 },
      ],
      ours: [
        { name: "unchanged.txt", id: "same", mode: 0o100644 },
        { name: "conflict.txt", id: "ours-change", mode: 0o100644 },
      ],
      theirs: [
        { name: "unchanged.txt", id: "same", mode: 0o100644 },
        { name: "conflict.txt", id: "theirs-change", mode: 0o100644 },
      ],
    });

    const result = await compareThreeWayTrees(trees, "base", "ours", "theirs");

    expect(result.resolved.length).toBe(1);
    expect(result.resolved[0].path).toBe("unchanged.txt");
    expect(result.resolved[0].change).toBe(ThreeWayChange.UNCHANGED);

    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].path).toBe("conflict.txt");
    expect(result.conflicts[0].change).toBe(ThreeWayChange.MODIFIED_BOTH_DIFFER);
  });
});

describe("mergeTreesThreeWay", () => {
  it("merges non-conflicting changes", async () => {
    const trees = createMockTreeStore({
      base: [{ name: "file.txt", id: "base", mode: 0o100644 }],
      ours: [
        { name: "file.txt", id: "base", mode: 0o100644 },
        { name: "new-ours.txt", id: "new1", mode: 0o100644 },
      ],
      theirs: [
        { name: "file.txt", id: "theirs-mod", mode: 0o100644 },
        { name: "new-theirs.txt", id: "new2", mode: 0o100644 },
      ],
    });

    const result = await mergeTreesThreeWay(trees, "base", "ours", "theirs");

    expect(result.conflicts.length).toBe(0);
    expect(result.merged.length).toBe(3);

    const paths = result.merged.map((m) => m.path).sort();
    expect(paths).toEqual(["file.txt", "new-ours.txt", "new-theirs.txt"]);

    // file.txt should take theirs version (only they modified)
    const fileTxt = result.merged.find((m) => m.path === "file.txt");
    expect(fileTxt?.entry.id).toBe("theirs-mod");
  });

  it("reports conflicts with all three versions", async () => {
    const trees = createMockTreeStore({
      base: [{ name: "conflict.txt", id: "base", mode: 0o100644 }],
      ours: [{ name: "conflict.txt", id: "ours", mode: 0o100644 }],
      theirs: [{ name: "conflict.txt", id: "theirs", mode: 0o100644 }],
    });

    const result = await mergeTreesThreeWay(trees, "base", "ours", "theirs");

    expect(result.merged.length).toBe(0);
    expect(result.conflicts.length).toBe(1);

    const conflict = result.conflicts[0];
    expect(conflict.path).toBe("conflict.txt");
    expect(conflict.base?.id).toBe("base");
    expect(conflict.ours?.id).toBe("ours");
    expect(conflict.theirs?.id).toBe("theirs");
  });
});
