/**
 * Git Index File Format Tests
 *
 * Tests for parsing and serializing Git index (DIRC) files.
 * Verifies compatibility with Git's index format versions 2, 3, and 4.
 *
 * Based on JGit DirCache format tests and Git source documentation.
 */

import { bytesToHex, sha1 } from "@statewalker/vcs-utils";
import { describe, expect, it } from "vitest";

import {
  encodeIndexFile,
  encodeIndexFileBytes,
  INDEX_SIGNATURE,
  INDEX_VERSION_2,
  INDEX_VERSION_3,
  INDEX_VERSION_4,
  type IndexVersion,
  parseIndexFile,
  serializeIndexFile,
} from "../../src/staging/index-format.js";
import type { StagingEntry } from "../../src/staging/types.js";

/**
 * Create a minimal valid index file for testing.
 */
async function createMinimalIndex(version: IndexVersion = INDEX_VERSION_2): Promise<Uint8Array> {
  // Header only (12 bytes) + checksum (20 bytes)
  const header = new Uint8Array(12);
  const view = new DataView(header.buffer);
  view.setUint32(0, INDEX_SIGNATURE);
  view.setUint32(4, version);
  view.setUint32(8, 0); // entry count

  const checksum = await sha1(header);
  const result = new Uint8Array(32);
  result.set(header, 0);
  result.set(checksum, 12);
  return result;
}

describe("Index Format", () => {
  describe("parseIndexFile", () => {
    it("should reject files that are too small", async () => {
      const tooSmall = new Uint8Array(10);
      await expect(parseIndexFile(tooSmall)).rejects.toThrow("Index file too small");
    });

    it("should reject invalid signature", async () => {
      const data = new Uint8Array(32);
      // Wrong signature (not DIRC)
      data[0] = 0x42;
      data[1] = 0x41;
      data[2] = 0x44;
      data[3] = 0x00;
      await expect(parseIndexFile(data)).rejects.toThrow("Invalid index file signature");
    });

    it("should reject unsupported versions", async () => {
      const data = new Uint8Array(32);
      const view = new DataView(data.buffer);
      view.setUint32(0, INDEX_SIGNATURE);
      view.setUint32(4, 1); // Version 1 not supported
      view.setUint32(8, 0);
      // Add valid checksum
      const checksum = await sha1(data.subarray(0, 12));
      data.set(checksum, 12);
      await expect(parseIndexFile(data)).rejects.toThrow("Unsupported index version");
    });

    it("should reject corrupted checksum", async () => {
      const valid = await createMinimalIndex();
      // Corrupt the checksum
      valid[valid.length - 1] ^= 0xff;
      await expect(parseIndexFile(valid)).rejects.toThrow("checksum mismatch");
    });

    it("should parse empty index version 2", async () => {
      const data = await createMinimalIndex(INDEX_VERSION_2);
      const result = await parseIndexFile(data);
      expect(result.version).toBe(INDEX_VERSION_2);
      expect(result.entries).toHaveLength(0);
    });

    it("should parse empty index version 3", async () => {
      const data = await createMinimalIndex(INDEX_VERSION_3);
      const result = await parseIndexFile(data);
      expect(result.version).toBe(INDEX_VERSION_3);
      expect(result.entries).toHaveLength(0);
    });

    it("should parse empty index version 4", async () => {
      const data = await createMinimalIndex(INDEX_VERSION_4);
      const result = await parseIndexFile(data);
      expect(result.version).toBe(INDEX_VERSION_4);
      expect(result.entries).toHaveLength(0);
    });
  });

  describe("serializeIndexFile", () => {
    it("should serialize empty index", async () => {
      const data = await serializeIndexFile([]);

      // Verify structure
      expect(data.length).toBe(32); // 12 header + 20 checksum
      const view = new DataView(data.buffer, data.byteOffset);
      expect(view.getUint32(0)).toBe(INDEX_SIGNATURE);
      expect(view.getUint32(4)).toBe(INDEX_VERSION_2);
      expect(view.getUint32(8)).toBe(0);

      // Verify checksum
      const contentWithoutChecksum = data.subarray(0, 12);
      const storedChecksum = data.subarray(12);
      const computedChecksum = await sha1(contentWithoutChecksum);
      expect(storedChecksum).toEqual(computedChecksum);
    });

    it("should serialize with specified version", async () => {
      const data = await serializeIndexFile([], INDEX_VERSION_4);
      const view = new DataView(data.buffer, data.byteOffset);
      expect(view.getUint32(4)).toBe(INDEX_VERSION_4);
    });

    it("writes version 3 exactly when an entry has an extended flag, as git", async () => {
      const entry: StagingEntry = {
        path: "a.txt",
        mode: 0o100644,
        objectId: "a".repeat(40),
        stage: 0,
        size: 1,
        mtime: 1,
      };
      const versionOf = async (entries: StagingEntry[], version: IndexVersion) =>
        new DataView((await serializeIndexFile(entries, version)).buffer).getUint32(4);
      // do_write_index: 3 is demoted to 2 when it is not needed, 2 promoted when it is
      expect(await versionOf([entry], INDEX_VERSION_3)).toBe(INDEX_VERSION_2);
      expect(await versionOf([{ ...entry, skipWorktree: true }], INDEX_VERSION_2)).toBe(
        INDEX_VERSION_3,
      );
      expect(await versionOf([{ ...entry, intentToAdd: true }], INDEX_VERSION_2)).toBe(
        INDEX_VERSION_3,
      );
      expect(await versionOf([{ ...entry, skipWorktree: true }], INDEX_VERSION_4)).toBe(
        INDEX_VERSION_4,
      );
      // only a flagged entry carries the extended flags word
      const parsed = await parseIndexFile(
        await serializeIndexFile([entry, { ...entry, path: "b.txt", skipWorktree: true }], 3),
      );
      expect(parsed.entries.map((e) => e.skipWorktree === true)).toEqual([false, true]);
    });

    it("should reject invalid paths", async () => {
      const entries: StagingEntry[] = [
        {
          path: "/absolute/path",
          mode: 0o100644,
          objectId: "0".repeat(40),
          stage: 0,
          size: 0,
          mtime: 0,
        },
      ];
      await expect(serializeIndexFile(entries)).rejects.toThrow("Invalid path");
    });

    it("should reject paths with .git component", async () => {
      const entries: StagingEntry[] = [
        {
          path: "foo/.git/bar",
          mode: 0o100644,
          objectId: "0".repeat(40),
          stage: 0,
          size: 0,
          mtime: 0,
        },
      ];
      await expect(serializeIndexFile(entries)).rejects.toThrow("contains .git");
    });
  });

  describe("roundtrip", () => {
    it("should roundtrip single entry", async () => {
      const entries: StagingEntry[] = [
        {
          path: "file.txt",
          mode: 0o100644,
          objectId: "a".repeat(40),
          stage: 0,
          size: 100,
          mtime: 1234567890000,
        },
      ];

      const serialized = await serializeIndexFile(entries);
      const parsed = await parseIndexFile(serialized);

      expect(parsed.entries).toHaveLength(1);
      expect(parsed.entries[0].path).toBe("file.txt");
      expect(parsed.entries[0].mode).toBe(0o100644);
      expect(parsed.entries[0].objectId).toBe("a".repeat(40));
      expect(parsed.entries[0].stage).toBe(0);
      expect(parsed.entries[0].size).toBe(100);
    });

    it("should roundtrip multiple entries sorted", async () => {
      // Add entries out of order - they should be sorted
      const entries: StagingEntry[] = [
        {
          path: "z.txt",
          mode: 0o100644,
          objectId: "f".repeat(40),
          stage: 0,
          size: 0,
          mtime: 0,
        },
        {
          path: "a.txt",
          mode: 0o100644,
          objectId: "a".repeat(40),
          stage: 0,
          size: 0,
          mtime: 0,
        },
        {
          path: "m.txt",
          mode: 0o100644,
          objectId: "c".repeat(40),
          stage: 0,
          size: 0,
          mtime: 0,
        },
      ];

      const serialized = await serializeIndexFile(entries);
      const parsed = await parseIndexFile(serialized);

      expect(parsed.entries).toHaveLength(3);
      expect(parsed.entries.map((e) => e.path)).toEqual(["a.txt", "m.txt", "z.txt"]);
    });

    it("should roundtrip executable file mode", async () => {
      const entries: StagingEntry[] = [
        {
          path: "script.sh",
          mode: 0o100755,
          objectId: "b".repeat(40),
          stage: 0,
          size: 50,
          mtime: 0,
        },
      ];

      const serialized = await serializeIndexFile(entries);
      const parsed = await parseIndexFile(serialized);

      expect(parsed.entries[0].mode).toBe(0o100755);
    });

    it("should roundtrip symlink mode", async () => {
      const entries: StagingEntry[] = [
        {
          path: "link",
          mode: 0o120000,
          objectId: "c".repeat(40),
          stage: 0,
          size: 10,
          mtime: 0,
        },
      ];

      const serialized = await serializeIndexFile(entries);
      const parsed = await parseIndexFile(serialized);

      expect(parsed.entries[0].mode).toBe(0o120000);
    });

    it("should roundtrip nested paths", async () => {
      const entries: StagingEntry[] = [
        {
          path: "src/deep/nested/file.txt",
          mode: 0o100644,
          objectId: "d".repeat(40),
          stage: 0,
          size: 0,
          mtime: 0,
        },
        {
          path: "src/shallow.txt",
          mode: 0o100644,
          objectId: "e".repeat(40),
          stage: 0,
          size: 0,
          mtime: 0,
        },
      ];

      const serialized = await serializeIndexFile(entries);
      const parsed = await parseIndexFile(serialized);

      expect(parsed.entries).toHaveLength(2);
      expect(parsed.entries[0].path).toBe("src/deep/nested/file.txt");
      expect(parsed.entries[1].path).toBe("src/shallow.txt");
    });

    it("should roundtrip conflict stages", async () => {
      // Same path with different stages (conflict markers)
      const entries: StagingEntry[] = [
        {
          path: "conflict.txt",
          mode: 0o100644,
          objectId: "1".repeat(40),
          stage: 1, // base
          size: 0,
          mtime: 0,
        },
        {
          path: "conflict.txt",
          mode: 0o100644,
          objectId: "2".repeat(40),
          stage: 2, // ours
          size: 0,
          mtime: 0,
        },
        {
          path: "conflict.txt",
          mode: 0o100644,
          objectId: "3".repeat(40),
          stage: 3, // theirs
          size: 0,
          mtime: 0,
        },
      ];

      const serialized = await serializeIndexFile(entries);
      const parsed = await parseIndexFile(serialized);

      expect(parsed.entries).toHaveLength(3);
      expect(parsed.entries[0].stage).toBe(1);
      expect(parsed.entries[1].stage).toBe(2);
      expect(parsed.entries[2].stage).toBe(3);
      expect(parsed.entries[0].objectId).toBe("1".repeat(40));
      expect(parsed.entries[1].objectId).toBe("2".repeat(40));
      expect(parsed.entries[2].objectId).toBe("3".repeat(40));
    });

    it("should roundtrip version 3 with extended flags", async () => {
      const entries: StagingEntry[] = [
        {
          path: "file.txt",
          mode: 0o100644,
          objectId: "f".repeat(40),
          stage: 0,
          size: 0,
          mtime: 0,
          intentToAdd: true,
        },
        {
          path: "sparse.txt",
          mode: 0o100644,
          objectId: "0".repeat(40),
          stage: 0,
          size: 0,
          mtime: 0,
          skipWorktree: true,
        },
      ];

      const serialized = await serializeIndexFile(entries, INDEX_VERSION_3);
      const parsed = await parseIndexFile(serialized);

      expect(parsed.version).toBe(INDEX_VERSION_3);
      expect(parsed.entries[0].intentToAdd).toBe(true);
      expect(parsed.entries[1].skipWorktree).toBe(true);
    });

    it("should roundtrip version 4 with path compression", async () => {
      const entries: StagingEntry[] = [
        {
          path: "src/components/button.tsx",
          mode: 0o100644,
          objectId: "a".repeat(40),
          stage: 0,
          size: 0,
          mtime: 0,
        },
        {
          path: "src/components/input.tsx",
          mode: 0o100644,
          objectId: "b".repeat(40),
          stage: 0,
          size: 0,
          mtime: 0,
        },
        {
          path: "src/components/select.tsx",
          mode: 0o100644,
          objectId: "c".repeat(40),
          stage: 0,
          size: 0,
          mtime: 0,
        },
      ];

      const serialized = await serializeIndexFile(entries, INDEX_VERSION_4);
      const parsed = await parseIndexFile(serialized);

      expect(parsed.version).toBe(INDEX_VERSION_4);
      expect(parsed.entries).toHaveLength(3);
      expect(parsed.entries.map((e) => e.path)).toEqual([
        "src/components/button.tsx",
        "src/components/input.tsx",
        "src/components/select.tsx",
      ]);
    });

    it("should roundtrip long paths (>= 0xfff bytes)", async () => {
      const longPath = `${"a/".repeat(2000)}file.txt`;
      const entries: StagingEntry[] = [
        {
          path: longPath,
          mode: 0o100644,
          objectId: "e".repeat(40),
          stage: 0,
          size: 0,
          mtime: 0,
        },
      ];

      const serialized = await serializeIndexFile(entries);
      const parsed = await parseIndexFile(serialized);

      expect(parsed.entries[0].path).toBe(longPath);
    });

    it("should roundtrip timestamp precision", async () => {
      const entries: StagingEntry[] = [
        {
          path: "file.txt",
          mode: 0o100644,
          objectId: "0".repeat(40),
          stage: 0,
          size: 0,
          mtime: 1703851234567, // With milliseconds
          ctime: 1703851234123,
        },
      ];

      const serialized = await serializeIndexFile(entries);
      const parsed = await parseIndexFile(serialized);

      // Note: Git index stores nanoseconds, so we lose sub-millisecond precision
      // but milliseconds should roundtrip
      expect(parsed.entries[0].mtime).toBe(1703851234567);
      expect(parsed.entries[0].ctime).toBe(1703851234123);
    });

    it("should roundtrip assume-valid flag", async () => {
      const entries: StagingEntry[] = [
        {
          path: "cached.txt",
          mode: 0o100644,
          objectId: "0".repeat(40),
          stage: 0,
          size: 0,
          mtime: 0,
          assumeValid: true,
        },
      ];

      const serialized = await serializeIndexFile(entries);
      const parsed = await parseIndexFile(serialized);

      expect(parsed.entries[0].assumeValid).toBe(true);
    });
  });

  describe("Git sort order", () => {
    it("should sort entries in correct Git order", async () => {
      // Git uses byte-by-byte comparison for paths
      const entries: StagingEntry[] = [
        { path: "a0b", mode: 0o100644, objectId: "0".repeat(40), stage: 0, size: 0, mtime: 0 },
        { path: "a-", mode: 0o100644, objectId: "0".repeat(40), stage: 0, size: 0, mtime: 0 },
        { path: "a.b", mode: 0o100644, objectId: "0".repeat(40), stage: 0, size: 0, mtime: 0 },
      ];

      const serialized = await serializeIndexFile(entries);
      const parsed = await parseIndexFile(serialized);

      // Git order: a- < a.b < a0b (by ASCII code)
      expect(parsed.entries.map((e) => e.path)).toEqual(["a-", "a.b", "a0b"]);
    });

    it("should sort entries with same path by stage", async () => {
      const entries: StagingEntry[] = [
        { path: "file.txt", mode: 0o100644, objectId: "3".repeat(40), stage: 3, size: 0, mtime: 0 },
        { path: "file.txt", mode: 0o100644, objectId: "1".repeat(40), stage: 1, size: 0, mtime: 0 },
        { path: "file.txt", mode: 0o100644, objectId: "2".repeat(40), stage: 2, size: 0, mtime: 0 },
      ];

      const serialized = await serializeIndexFile(entries);
      const parsed = await parseIndexFile(serialized);

      expect(parsed.entries[0].stage).toBe(1);
      expect(parsed.entries[1].stage).toBe(2);
      expect(parsed.entries[2].stage).toBe(3);
    });
  });

  describe("path validation", () => {
    it("should reject empty paths", async () => {
      const entries: StagingEntry[] = [
        { path: "", mode: 0o100644, objectId: "0".repeat(40), stage: 0, size: 0, mtime: 0 },
      ];
      await expect(serializeIndexFile(entries)).rejects.toThrow("Empty path");
    });

    it("should reject paths starting with /", async () => {
      const entries: StagingEntry[] = [
        { path: "/root", mode: 0o100644, objectId: "0".repeat(40), stage: 0, size: 0, mtime: 0 },
      ];
      await expect(serializeIndexFile(entries)).rejects.toThrow("starts with /");
    });

    it("should reject paths ending with /", async () => {
      const entries: StagingEntry[] = [
        { path: "dir/", mode: 0o100644, objectId: "0".repeat(40), stage: 0, size: 0, mtime: 0 },
      ];
      await expect(serializeIndexFile(entries)).rejects.toThrow("ends with /");
    });

    it("should reject paths with //", async () => {
      const entries: StagingEntry[] = [
        { path: "a//b", mode: 0o100644, objectId: "0".repeat(40), stage: 0, size: 0, mtime: 0 },
      ];
      await expect(serializeIndexFile(entries)).rejects.toThrow("contains //");
    });

    it("should reject paths containing null bytes", async () => {
      const entries: StagingEntry[] = [
        { path: "a\0b", mode: 0o100644, objectId: "0".repeat(40), stage: 0, size: 0, mtime: 0 },
      ];
      await expect(serializeIndexFile(entries)).rejects.toThrow("contains null");
    });

    it("should reject .git in path components (case insensitive)", async () => {
      const entries: StagingEntry[] = [
        {
          path: ".GIT/config",
          mode: 0o100644,
          objectId: "0".repeat(40),
          stage: 0,
          size: 0,
          mtime: 0,
        },
      ];
      await expect(serializeIndexFile(entries)).rejects.toThrow("contains .git");
    });
  });
});

describe("index extensions", () => {
  it("lists the extension signatures after the entries", async () => {
    const base = await serializeIndexFile([
      {
        path: "a.txt",
        mode: 0o100644,
        objectId: "a".repeat(40),
        stage: 0,
        size: 1,
        mtime: 0,
      },
    ]);
    expect((await parseIndexFile(base)).extensions).toEqual([]);
    const body = base.subarray(0, base.length - 20);
    const ext = (sig: string, size: number) => {
      const out = new Uint8Array(8 + size);
      out.set(new TextEncoder().encode(sig), 0);
      new DataView(out.buffer).setUint32(4, size);
      return out;
    };
    const parts = [body, ext("TREE", 6), ext("link", 20)];
    const content = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      content.set(p, at);
      at += p.length;
    }
    const file = new Uint8Array(content.length + 20);
    file.set(content, 0);
    file.set(await sha1(content), content.length);
    const parsed = await parseIndexFile(file);
    expect(parsed.extensions).toEqual(["TREE", "link"]);
    expect(parsed.entries.map((e) => e.path)).toEqual(["a.txt"]);
  });
});

describe("encodeIndexFile: streamed chunks", () => {
  /** Entries of every shape: modes, stages, flags, and a path longer than 0xFFF bytes. */
  function fixtureEntries(): StagingEntry[] {
    const out: StagingEntry[] = [];
    for (let i = 0; i < 300; i++) {
      const hex = ((i * 2654435761) >>> 0).toString(16).padStart(8, "0");
      out.push({
        path: `dir${i % 7}/sub${i % 3}/file-${i}.${i % 2 ? "txt" : "bin"}`,
        mode: i % 11 === 0 ? 0o100755 : i % 13 === 0 ? 0o120000 : 0o100644,
        objectId: hex.repeat(5),
        stage: (i % 17 === 0 ? 2 : 0) as 0 | 2,
        size: i * 37,
        mtime: 1_700_000_000_000 + i * 1001,
        ctime: 1_600_000_000_000 + i * 7,
        dev: 2049,
        ino: 100_000 + i,
        assumeValid: i % 19 === 0,
        intentToAdd: i % 23 === 0,
        skipWorktree: i % 29 === 0,
      });
    }
    out.push({
      path: `${"a-very-long-path/".repeat(300)}x`,
      mode: 0o100644,
      objectId: "e".repeat(40),
      stage: 0,
      size: 1,
      mtime: 0,
    });
    return out;
  }

  function join(chunks: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }

  // SHA-1 of what the one-buffer encoder (before encodeIndexFile) wrote for fixtureEntries(),
  // the entries with flags making it version 3 whether 2 or 3 is asked for (git's
  // do_write_index), the extended flags word only on those entries
  const GOLDEN: Record<IndexVersion, string> = {
    2: "5384cce41dd7bb8241c53acbc8dd4cd2db063c7a",
    3: "5384cce41dd7bb8241c53acbc8dd4cd2db063c7a",
    4: "ea7a27f6f440e183a101165c6b34e4955b4bf55b",
  };

  for (const version of [INDEX_VERSION_2, INDEX_VERSION_3, INDEX_VERSION_4] as const) {
    it(`is byte-identical to the one-buffer encoder (v${version})`, async () => {
      const chunks = [...encodeIndexFile(fixtureEntries(), version)];
      const bytes = join(chunks);
      expect(bytesToHex(await sha1(bytes))).toBe(GOLDEN[version]);
      expect(bytesToHex(await sha1(await serializeIndexFile(fixtureEntries(), version)))).toBe(
        GOLDEN[version],
      );
      const parsed = await parseIndexFile(bytes);
      expect(parsed.entries).toHaveLength(301);
    });
  }

  it("yields many bounded chunks, the trailing SHA-1 last", async () => {
    const entries = fixtureEntries();
    for (let i = 0; i < 3000; i++) {
      entries.push({
        path: `bulk/${i}`,
        mode: 0o100644,
        objectId: "1".repeat(40),
        stage: 0,
        size: 0,
        mtime: 0,
      });
    }
    const chunks = [...encodeIndexFile(entries)];
    expect(chunks.length).toBeGreaterThan(2);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThan(total / 2);
    const last = chunks[chunks.length - 1] as Uint8Array;
    expect(last.length).toBe(20);
    const body = join(chunks.slice(0, -1));
    expect(last).toEqual(await sha1(body));
  });

  it("validates paths before it yields anything", () => {
    const bad: StagingEntry[] = [
      { path: "ok.txt", mode: 0o100644, objectId: "a".repeat(40), stage: 0, size: 0, mtime: 0 },
      { path: "a//b", mode: 0o100644, objectId: "a".repeat(40), stage: 0, size: 0, mtime: 0 },
    ];
    expect(() => encodeIndexFile(bad)).toThrow("contains //");
  });
});

describe("encoding into one buffer (versions 2 and 3)", () => {
  const entry = (path: string, i: number, extra: Partial<StagingEntry> = {}): StagingEntry => ({
    path,
    mode: 0o100644,
    objectId: i.toString(16).padStart(40, "0"),
    stage: 0,
    size: i,
    mtime: 1_700_000_000_123 + i,
    mtimeNs: 123_456_789,
    ctime: 1_700_000_000_000,
    dev: 1,
    ino: i,
    ...extra,
  });
  const join = (chunks: Iterable<Uint8Array>) =>
    Buffer.concat([...chunks].map((c) => Buffer.from(c)));

  it("writes ASCII and non-ASCII paths, extended flags and stages as git reads them", async () => {
    const entries = [
      entry("a.txt", 1),
      entry("caf\u00e9/x", 2, { intentToAdd: true }),
      entry("d/\udce9", 3, { skipWorktree: true }),
      entry("z", 4, { stage: 1 }),
      entry("z", 5, { stage: 2, assumeValid: true }),
    ];
    const { bytes } = await encodeIndexFileBytes(entries);
    const parsed = await parseIndexFile(bytes);
    expect(parsed.version).toBe(INDEX_VERSION_3);
    expect(parsed.entries.map((e) => [e.path, e.stage, e.objectId, e.size])).toEqual(
      entries.map((e) => [e.path, e.stage, e.objectId, e.size]),
    );
    expect(parsed.entries[1]?.intentToAdd).toBe(true);
    expect(parsed.entries[2]?.skipWorktree).toBe(true);
    expect(parsed.entries[4]?.assumeValid).toBe(true);
    // the streamed chunks are the same bytes
    expect(join(encodeIndexFile(entries)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("encodes an entry written before to the same bytes, wherever they last were", async () => {
    const entries = Array.from({ length: 3000 }, (_, i) =>
      entry(`dir${i % 7}/file-${String(i).padStart(5, "0")}`, i),
    ).sort((a, b) => (a.path < b.path ? -1 : 1));
    const first = Buffer.from((await encodeIndexFileBytes(entries)).bytes);
    // the streamed form copies the known entries into a buffer of its own
    expect(join(encodeIndexFile(entries)).equals(first)).toBe(true);
    // a new entry among known ones: the known ones copied, the new one written
    const changed = [...entries];
    changed[10] = entry(entries[10]?.path as string, 99_999);
    const second = Buffer.from((await encodeIndexFileBytes(changed)).bytes);
    const fresh = Buffer.from((await encodeIndexFileBytes(changed.map((e) => ({ ...e })))).bytes);
    expect(second.equals(fresh)).toBe(true);
    expect(join(encodeIndexFile(entries)).equals(first)).toBe(true);
  });

  it("refuses an object id that is not 40 lowercase hex digits, before any byte", () => {
    for (const objectId of ["A".repeat(40), "a".repeat(39), `${"a".repeat(39)}\u00e9`]) {
      expect(() => encodeIndexFile([entry("x", 1, { objectId })])).toThrow(/not an object id/);
    }
  });
});
