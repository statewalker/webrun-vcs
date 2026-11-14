import { describe, expect, it } from "vitest";
import {
  carryIndexExtensions,
  encodeResolveUndo,
  type IndexExtension,
  parseIndexFile,
  parseResolveUndo,
  type ResolveUndoRecord,
  serializeIndexFile,
  UnsupportedIndexExtensionError,
} from "../../src/staging/index.js";
import type { StagingEntry } from "../../src/staging/types.js";

const entry = (path: string): StagingEntry => ({
  path,
  mode: 0o100644,
  objectId: "a".repeat(40),
  stage: 0,
  size: 0,
  mtime: 0,
});
const ext = (signature: string, ...bytes: number[]): IndexExtension => ({
  signature,
  data: new Uint8Array(bytes),
});
const reuc = (...paths: string[]): IndexExtension => ({
  signature: "REUC",
  data: encodeResolveUndo(
    paths.map(
      (path): ResolveUndoRecord => ({
        path,
        modes: [0o100644, 0o100644, 0],
        objectIds: ["1".repeat(40), "2".repeat(40), undefined],
      }),
    ),
  ),
});

describe("carryIndexExtensions", () => {
  const all = [
    ext("TREE", 1),
    reuc("a.txt", "gone.txt"),
    ext("UNTR", 2),
    ext("EOIE", 3),
    ext("ZZZZ", 4),
  ];

  it("keeps all but the offset extensions when the entries did not change", () => {
    const kept = carryIndexExtensions(all, [entry("a.txt")], false);
    expect(kept.map((e) => e.signature)).toEqual(["TREE", "REUC", "UNTR", "ZZZZ"]);
  });

  it("drops TREE and UNTR when the entries changed, filters REUC, keeps unknown optional ones", () => {
    const kept = carryIndexExtensions(all, [entry("a.txt")], true);
    expect(kept.map((e) => e.signature)).toEqual(["REUC", "ZZZZ"]);
    const records = parseResolveUndo((kept[0] as IndexExtension).data);
    expect(records.map((r) => r.path)).toEqual(["a.txt"]);
    expect(records[0]?.objectIds).toEqual(["1".repeat(40), "2".repeat(40), undefined]);
  });

  it("drops REUC when none of its paths is left", () => {
    expect(carryIndexExtensions([reuc("gone.txt")], [entry("a.txt")], true)).toEqual([]);
  });

  it("refuses a required (lowercase) extension", () => {
    expect(() => carryIndexExtensions([ext("link", 0)], [], false)).toThrow(
      UnsupportedIndexExtensionError,
    );
    expect(() => carryIndexExtensions([ext("sdir")], [], true)).toThrow("'sdir'");
  });
});

describe("encodeIndexFile writes extensions", () => {
  it("round-trips extension payloads in order", async () => {
    const extensions = [reuc("a.txt"), ext("ZZZZ", 9, 8, 7)];
    const parsed = await parseIndexFile(await serializeIndexFile([entry("a.txt")], 2, extensions));
    expect(parsed.extensions).toEqual(["REUC", "ZZZZ"]);
    expect(Array.from(parsed.extensionData[1]?.data ?? [])).toEqual([9, 8, 7]);
    expect(parsed.entries.map((e) => e.path)).toEqual(["a.txt"]);
  });
});
