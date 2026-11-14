import type { Trees } from "@statewalker/vcs-core";
import { createInMemoryFilesApi, type FilesApi } from "@statewalker/vcs-utils/files";
import { describe, expect, it } from "vitest";
import {
  carryIndexExtensions,
  createGitStaging,
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

  it("keeps the known extensions, drops offsets and unknown optional ones, when the entries did not change", () => {
    const kept = carryIndexExtensions(all, [entry("a.txt")], false);
    expect(kept.map((e) => e.signature)).toEqual(["TREE", "REUC", "UNTR"]);
  });

  it("drops TREE and UNTR when the entries changed and keeps every REUC record, as git does", () => {
    const kept = carryIndexExtensions(all, [entry("a.txt")], true);
    expect(kept.map((e) => e.signature)).toEqual(["REUC"]);
    const records = parseResolveUndo((kept[0] as IndexExtension).data);
    // a path resolved by removing it (git rm) keeps its record too
    expect(records.map((r) => r.path)).toEqual(["a.txt", "gone.txt"]);
    expect(records[0]?.objectIds).toEqual(["1".repeat(40), "2".repeat(40), undefined]);
  });

  it("keeps REUC when none of its paths is left", () => {
    const kept = carryIndexExtensions([reuc("gone.txt")], [entry("a.txt")], true);
    expect(kept.map((e) => e.signature)).toEqual(["REUC"]);
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

describe("carryIndexExtensions: unknown and corrupt extensions", () => {
  it("drops unknown optional extensions whether or not the entries changed", () => {
    for (const changed of [false, true]) {
      const kept = carryIndexExtensions(
        [ext("ZZZZ", 4), ext("FSMN", 5), ext("ABCD", 6)],
        [entry("a.txt")],
        changed,
      );
      expect(kept.map((e) => e.signature)).toEqual(changed ? [] : ["FSMN"]);
    }
  });

  it("drops a corrupt REUC instead of failing", () => {
    const corrupt = ext("REUC", 0x61, 0x2e, 0x74); // a path with no terminating NUL
    expect(() => parseResolveUndo(corrupt.data)).toThrow();
    expect(carryIndexExtensions([corrupt, ext("TREE", 1)], [entry("a.txt")], false)).toEqual([
      ext("TREE", 1),
    ]);
    expect(carryIndexExtensions([corrupt], [entry("a.txt")], true)).toEqual([]);
  });
});

describe("GitStaging.readTree clears resolve-undo, as git read-tree and reset do", () => {
  const trees = {
    load: async () =>
      (async function* () {
        yield { name: "a.txt", mode: 0o100644, id: "c".repeat(40) };
      })(),
  } as unknown as Trees;

  async function indexWithReuc(): Promise<FilesApi> {
    const files = createInMemoryFilesApi();
    await files.write("index", [await serializeIndexFile([entry("a.txt")], 2, [reuc("a.txt")])]);
    return files;
  }
  const extensionsOf = async (files: FilesApi) => {
    const parts: Uint8Array[] = [];
    for await (const c of files.read("index")) parts.push(c);
    return (await parseIndexFile(new Uint8Array(Buffer.concat(parts)))).extensions;
  };

  it("drops REUC after a full readTree", async () => {
    const files = await indexWithReuc();
    const staging = createGitStaging(files, "index");
    await staging.read();
    await staging.readTree(trees, "d".repeat(40));
    await staging.write();
    expect(await extensionsOf(files)).toEqual([]);
  });

  it("keeps REUC after a readTree that keeps the existing entries", async () => {
    const files = await indexWithReuc();
    const staging = createGitStaging(files, "index");
    await staging.read();
    await staging.readTree(trees, "d".repeat(40), { keepExisting: true, prefix: "sub" });
    await staging.write();
    expect(await extensionsOf(files)).toEqual(["REUC"]);
  });
});
