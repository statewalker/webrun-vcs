/**
 * A write copies the bytes of the entries it read (or last wrote) instead of encoding them
 * again (`IndexEncoding`): whatever was added, removed, replaced or reflagged since, the
 * index written is byte for byte the one a fresh encode writes, and an entry whose bytes the
 * encoder would not write as read (an extended-flags word with no flag) is encoded afresh.
 */
import { sha1 } from "@statewalker/vcs-utils";
import { describe, expect, it } from "vitest";

import {
  encodeIndexFileBytes,
  INDEX_VERSION_2,
  type IndexEncoding,
  parseIndexFile,
} from "../../src/staging/index-format.js";
import type { StagingEntry } from "../../src/staging/types.js";

const id = (n: number) => n.toString(16).padStart(40, "0");

function entry(path: string, n: number, extra: Partial<StagingEntry> = {}): StagingEntry {
  return {
    path,
    mode: 0o100644,
    objectId: id(n + 1),
    stage: 0,
    size: n,
    mtime: 1_700_000_000_000 + n * 1000 + 123,
    mtimeNs: 123_456_789,
    ctime: 1_700_000_000_000 + n * 1000,
    ctimeNs: 7,
    dev: 1,
    ino: n,
    uid: 0,
    gid: 0,
    ...extra,
  };
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  expect(a.length).toBe(b.length);
  let diff = -1;
  for (let i = 0; i < a.length && diff < 0; i++) if (a[i] !== b[i]) diff = i;
  expect(diff).toBe(-1);
};

/** mulberry32 */
function rng(seed: number): (n: number) => number {
  let a = seed >>> 0;
  return (n) => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

describe("index writes copy the entries' bytes as read", () => {
  it("writes what a fresh encode writes, through random edits", async () => {
    const next = rng(5);
    let entries: StagingEntry[] = [];
    for (let i = 0; i < 300; i++) entries.push(entry(`d${i % 7}/f${i}.txt`, i));
    entries.sort((a, b) => (a.path < b.path ? -1 : 1));
    const first = await encodeIndexFileBytes(entries, INDEX_VERSION_2);
    const parsed = await parseIndexFile(first.bytes.slice(), { keepEncoding: true });
    let source: IndexEncoding | undefined = parsed.encoding;
    expect(source?.offsets.length).toBe(entries.length + 1);
    entries = parsed.entries;
    let counter = 1000;
    for (let round = 0; round < 40; round++) {
      const edited = entries.slice();
      for (let k = 0; k < 1 + next(6); k++) {
        const at = next(edited.length);
        const old = edited[at] as StagingEntry;
        const kind = next(5);
        if (kind === 0) edited.splice(at, 1);
        else if (kind === 1) edited[at] = { ...old, objectId: id(counter++) };
        else if (kind === 2) edited[at] = { ...old, skipWorktree: !old.skipWorktree };
        else if (kind === 3) edited.splice(at, 0, entry(`${old.path}-new${counter}`, counter++));
        else edited.splice(at, next(20));
      }
      edited.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const copied = await encodeIndexFileBytes(edited, INDEX_VERSION_2, [], { source });
      const fresh = await encodeIndexFileBytes(
        edited.map((e) => ({ ...e })),
        INDEX_VERSION_2,
      );
      sameBytes(copied.bytes, fresh.bytes);
      // the offsets describe the bytes written: each entry parses back from where it starts
      const again = await parseIndexFile(copied.bytes.slice(), { keepEncoding: true });
      expect(again.entries.map((e) => e.path)).toEqual(edited.map((e) => e.path));
      for (let i = 0; i <= edited.length; i++) {
        expect(copied.encoding?.offsets[i]).toBe(again.encoding?.offsets[i]);
      }
      source = round % 3 === 0 ? again.encoding : copied.encoding;
      entries = round % 3 === 0 ? again.entries : edited;
    }
  });

  it("encodes afresh an entry whose extended-flags word holds no flag", async () => {
    const entries = [entry("a", 1), entry("b", 2, { skipWorktree: true }), entry("c", 3)];
    const { bytes } = await encodeIndexFileBytes(entries, INDEX_VERSION_2);
    // clear b's skip-worktree bit, keeping its extended-flags word (git never writes this)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const parsedOnce = await parseIndexFile(bytes.slice(), { keepEncoding: true });
    const bAt = parsedOnce.encoding?.offsets[1] as number;
    view.setUint16(bAt + 62, 0);
    const body = bytes.subarray(0, bytes.length - 20);
    bytes.set(await sha1(body), bytes.length - 20);
    const parsed = await parseIndexFile(bytes.slice(), { keepEncoding: true });
    expect(parsed.entries[1]?.skipWorktree).toBe(false);
    expect(parsed.encoding?.offsets[1]).toBeLessThan(0);
    const copied = await encodeIndexFileBytes(parsed.entries, parsed.version, [], {
      source: parsed.encoding,
    });
    const fresh = await encodeIndexFileBytes(
      parsed.entries.map((e) => ({ ...e })),
      parsed.version,
    );
    sameBytes(copied.bytes, fresh.bytes);
    // no entry has a flag left: version 2, every entry without the extended word
    expect(new DataView(copied.bytes.buffer).getUint32(4)).toBe(2);
  });

  it("keeps the parsed list for the copy: a caller editing its entries list in place is safe", async () => {
    const entries = [entry("a", 1), entry("b", 2), entry("c", 3)];
    const { bytes } = await encodeIndexFileBytes(entries, INDEX_VERSION_2);
    const parsed = await parseIndexFile(bytes.slice(), { keepEncoding: true });
    parsed.entries.push(entry("d", 4));
    const copied = await encodeIndexFileBytes(parsed.entries, INDEX_VERSION_2, [], {
      source: parsed.encoding,
    });
    const fresh = await encodeIndexFileBytes(
      parsed.entries.map((e) => ({ ...e })),
      INDEX_VERSION_2,
    );
    sameBytes(copied.bytes, fresh.bytes);
  });
});
