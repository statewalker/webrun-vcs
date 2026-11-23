/**
 * The index file of a SHA-256 repository: entries of 74-byte fixed parts (a 32-byte id), a
 * SHA-256 trailer (or a null one, `index.skipHash`), and the extensions holding ids (`TREE`,
 * `REUC`, `link`, `UNTR`) with 32-byte ids. The native-git comparisons (git's bytes read and
 * re-encoded, git reading ours) live in vcs-commands/tests/sha256-packs-native.test.ts.
 */

import { createInMemoryFilesApi } from "@statewalker/vcs-utils/files";
import { SHA256_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import { describe, expect, it } from "vitest";
import {
  encodeCacheTree,
  parseCacheTree,
  repairCacheTree,
  storeCacheTree,
  treeIdOfEntries,
  updateCacheTree,
} from "../../src/staging/cache-tree.js";
import { encodeResolveUndo, parseResolveUndo } from "../../src/staging/index-extensions.js";
import { IndexFile } from "../../src/staging/index-file.js";
import {
  encodeIndexFileBytes,
  encodeIndexInOrder,
  INDEX_VERSION_2,
  INDEX_VERSION_4,
  IndexCorruptError,
  parseIndexFile,
} from "../../src/staging/index-format.js";
import { encodeLinkExtension, parseLinkExtension } from "../../src/staging/split-index.js";
import type { StagingEntry } from "../../src/staging/types.js";
import {
  Ewah as EwahBitmap,
  encodeUntrackedCache,
  newUntrackedCache,
  newUntrackedCacheDir,
  parseUntrackedCache,
} from "../../src/status/untracked-cache.js";

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);
const format = SHA256_OBJECT_FORMAT;

const entry = (
  path: string,
  objectId: string,
  extra: Partial<StagingEntry> = {},
): StagingEntry => ({
  path,
  mode: 0o100644,
  objectId,
  stage: 0,
  size: 3,
  mtime: 1_700_000_000_000,
  ctime: 1_700_000_000_000,
  ...extra,
});

describe("SHA-256 index file", () => {
  it("writes 32-byte ids and a SHA-256 trailer, and reads them back (versions 2 and 4)", async () => {
    const entries = [entry("a.txt", ID_A), entry("dir/b.txt", ID_B)];
    for (const version of [INDEX_VERSION_2, INDEX_VERSION_4]) {
      const { bytes, checksum } = await encodeIndexFileBytes(entries, version, [], {
        objectFormat: format,
      });
      expect(checksum).toHaveLength(32);
      expect(Buffer.from(checksum)).toEqual(
        Buffer.from(await format.digest(bytes.subarray(0, bytes.length - 32))),
      );
      if (version === INDEX_VERSION_2) {
        // 12 + (74 + "a.txt" + NUL padded to 8: 80) + (74 + 9 + NUL: 88) + 32
        expect(bytes.length).toBe(12 + 80 + 88 + 32);
      }
      const parsed = await parseIndexFile(bytes, { objectFormat: format, verifyChecksum: true });
      expect(parsed.version).toBe(version);
      expect(parsed.entries.map((e) => [e.path, e.objectId])).toEqual([
        ["a.txt", ID_A],
        ["dir/b.txt", ID_B],
      ]);
      // a SHA-1 read of it is refused, never read as 20-byte ids
      await expect(parseIndexFile(bytes, { verifyChecksum: true })).rejects.toThrow(
        IndexCorruptError,
      );
    }
  });

  it("refuses ids of the other format", async () => {
    await expect(
      encodeIndexFileBytes([entry("a.txt", "a".repeat(40))], INDEX_VERSION_2, [], {
        objectFormat: format,
      }),
    ).rejects.toThrow();
  });

  it("writes a null trailer under index.skipHash", async () => {
    const { bytes } = await encodeIndexFileBytes([entry("a.txt", ID_A)], INDEX_VERSION_2, [], {
      objectFormat: format,
      skipHash: true,
    });
    expect(bytes.subarray(bytes.length - 32).every((b) => b === 0)).toBe(true);
    const parsed = await parseIndexFile(bytes, { objectFormat: format, verifyChecksum: true });
    expect(parsed.entries).toHaveLength(1);
  });

  it("encodes and parses TREE, REUC, link and UNTR with 32-byte ids", () => {
    const tree = {
      entryCount: 2,
      id: ID_A,
      subtrees: [{ name: "dir", tree: { entryCount: 1, id: ID_B, subtrees: [] } }],
    };
    expect(parseCacheTree(encodeCacheTree(tree, 32), 32)).toEqual(tree);
    const records = [
      {
        path: "a.txt",
        modes: [0o100644, 0, 0o100644] as [number, number, number],
        objectIds: [ID_A, undefined, ID_B] as [
          string | undefined,
          string | undefined,
          string | undefined,
        ],
      },
    ];
    expect(parseResolveUndo(encodeResolveUndo(records, 32), 32)).toEqual(records);
    const deleted = new EwahBitmap();
    deleted.set(1);
    const link = encodeLinkExtension(ID_A, deleted, new EwahBitmap(), 32);
    expect(parseLinkExtension(link, 32)).toEqual({ baseId: ID_A, deleted: [1], replaced: [] });
    const cache = newUntrackedCache("Location /w, system Linux", 6, format);
    expect(cache.infoExclude.oid).toBe(format.nullId);
    cache.root = newUntrackedCacheDir("", format.nullId);
    cache.root.excludeOid = ID_B;
    cache.root.recurse = true;
    cache.root.valid = true;
    const untr = encodeUntrackedCache(cache);
    const back = parseUntrackedCache(untr, format);
    expect(back?.root?.excludeOid).toBe(ID_B);
    expect(back?.infoExclude.oid).toBe(format.nullId);
    expect(encodeUntrackedCache(back as NonNullable<typeof back>)).toEqual(untr);
  });

  it("writes a split index whose link names a SHA-256 shared index", async () => {
    const link = encodeLinkExtension(format.nullId, new EwahBitmap(), new EwahBitmap(), 32);
    const { bytes } = await encodeIndexInOrder(
      [{ entry: entry("a.txt", ID_A), path: "a.txt" }],
      INDEX_VERSION_2,
      [{ signature: "link", data: link }],
      { objectFormat: format },
    );
    const parsed = await parseIndexFile(bytes, { objectFormat: format, verifyChecksum: true });
    expect(parsed.extensions).toEqual(["link"]);
    expect(parseLinkExtension(parsed.extensionData[0]?.data as Uint8Array, 32).baseId).toBe(
      format.nullId,
    );
  });

  it("IndexFile reads and writes in the format it is given or looks up", async () => {
    const files = createInMemoryFilesApi();
    const file = new IndexFile(files, ".git/index", { objectFormat: async () => format });
    await file.read();
    await file.write([entry("a.txt", ID_A)]);
    expect(file.objectFormat).toBe(format);
    expect(file.currentChecksum).toMatch(/^[0-9a-f]{64}$/);
    const again = new IndexFile(files, ".git/index", { objectFormat: format });
    const read = await again.read();
    expect(read?.entries.map((e) => e.objectId)).toEqual([ID_A]);
    // a write after another writer is refused by checksum, as in SHA-1
    await again.write([entry("a.txt", ID_B)]);
    await expect(file.write([entry("a.txt", ID_A)])).rejects.toThrow();
  });

  // review of #236 (C1): `read-tree --empty` wrote SHA-1's 20-byte empty tree into a SHA-256
  // index's TREE, the format guessed from the (absent) entries
  it("computes cache-trees in the format given, never guessed from the entries", async () => {
    const has = async (id: string) => id === format.emptyTreeId;
    const empty = await repairCacheTree({ has }, [], format);
    expect(empty).toEqual({ entryCount: 0, id: format.emptyTreeId, subtrees: [] });
    const bytes = encodeCacheTree(empty as NonNullable<typeof empty>, format.rawLength);
    // "", NUL, "0 0\n", then the 32-byte id
    expect(bytes.length).toBe(5 + 32);
    expect(parseCacheTree(bytes, 32).id).toBe(format.emptyTreeId);
    const stored = await storeCacheTree(async () => format.emptyTreeId, [], format);
    expect(stored?.id).toBe(format.emptyTreeId);
    expect(await treeIdOfEntries([], format)).toBe(format.emptyTreeId);
    const updated = await updateCacheTree(
      { load: async () => undefined, has: async () => false, entries: async () => [] },
      format.emptyTreeId,
      undefined,
      format,
    );
    expect(updated.id).toBe(format.emptyTreeId);
  });

  it("encoders refuse ids of another width than the index's", () => {
    const sha1Tree = {
      entryCount: 0,
      id: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      subtrees: [],
    };
    expect(() => encodeCacheTree(sha1Tree, 32)).toThrow();
    expect(() => encodeCacheTree({ entryCount: 0, id: ID_A, subtrees: [] }, 20)).toThrow();
    const record = {
      path: "a.txt",
      modes: [0o100644, 0, 0] as [number, number, number],
      objectIds: ["a".repeat(40), undefined, undefined] as [
        string | undefined,
        string | undefined,
        string | undefined,
      ],
    };
    expect(() => encodeResolveUndo([record], 32)).toThrow();
    expect(() =>
      encodeLinkExtension("a".repeat(40), new EwahBitmap(), new EwahBitmap(), 32),
    ).toThrow();
  });
});
