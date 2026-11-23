/**
 * The reftable reader on tables built in memory (`reftable-fixture.ts`): what well-formed
 * tables read as, the merged view of a stack, the read-only ref store, and crafted or corrupt
 * tables, each refused with a clear error rather than read past its bounds. The twins against
 * native git's tables are vcs-commands' `reftable-read-git3-native.test.ts`.
 */
import { deflateSync } from "node:zlib";
import { createInMemoryFilesApi, isSymbolicRef } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";

import {
  createReftableRefStore,
  createReftableStackReader,
  mergeReftables,
  openReftable,
  REFTABLE_READ_CEILING,
  ReftableFormatError,
  ReftableReadBudget,
  ReftableUnsupportedError,
  ReftableWriteUnsupportedError,
} from "../../src/refs/reftable/index.js";
import { buildReftable, type FixtureTable, fixFooterCrc, varint } from "./reftable-fixture.js";

/**
 * The whole table as the eager reader gave it: opened, verified block by block (`verify`),
 * and every ref and log record listed.
 */
function parseReftable(bytes: Uint8Array, name?: string) {
  const table = openReftable(bytes, name);
  const { blocks } = table.verify();
  const { version, minUpdateIndex, maxUpdateIndex } = table;
  return {
    version,
    minUpdateIndex,
    maxUpdateIndex,
    blocks,
    refs: [...table.refs()],
    logs: [...table.logs()],
  };
}

const A = "1111111111111111111111111111111111111111";
const B = "2222222222222222222222222222222222222222";
const C = "3333333333333333333333333333333333333333";
const Z = "0000000000000000000000000000000000000000";

const update = (oldId: string, newId: string, message: string, time = 1700000000) => ({
  oldId,
  newId,
  who: "Tester",
  email: "t@example.com",
  time,
  tzMinutes: -480,
  message: `${message}\n`,
});

const sample: FixtureTable = {
  minUpdateIndex: 1,
  maxUpdateIndex: 3,
  restartInterval: 2,
  refs: [
    { name: "HEAD", updateIndex: 1, target: "refs/heads/main" },
    { name: "refs/heads/main", updateIndex: 2, id: A },
    { name: "refs/heads/main2", updateIndex: 2, id: B },
    { name: "refs/tags/v1", updateIndex: 3, id: C, peeled: A },
  ],
  logs: [
    { name: "HEAD", updateIndex: 2, update: update(A, B, "commit: two") },
    { name: "HEAD", updateIndex: 1, update: update(Z, A, "commit (initial): one") },
    { name: "refs/heads/main", updateIndex: 2, update: update(A, B, "commit: two") },
  ],
};

function expectFormatError(bytes: Uint8Array, detail: RegExp) {
  let error: unknown;
  try {
    parseReftable(bytes, "t.ref");
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ReftableFormatError);
  expect((error as Error).message).toMatch(/^reftable: corrupt table 't\.ref': /);
  expect((error as Error).message).toMatch(detail);
}

describe("parseReftable", () => {
  it("reads ref records: prefix compression, restarts, every value type", () => {
    const table = parseReftable(buildReftable(sample).bytes, "t.ref");
    expect(table.version).toBe(1);
    expect(table.minUpdateIndex).toBe(1);
    expect(table.maxUpdateIndex).toBe(3);
    expect(table.refs.map((r) => [r.name, r.updateIndex, r.value])).toEqual([
      ["HEAD", 1, { type: "symref", target: "refs/heads/main" }],
      ["refs/heads/main", 2, { type: "id", id: A }],
      ["refs/heads/main2", 2, { type: "id", id: B }],
      ["refs/tags/v1", 3, { type: "peeled", id: C, peeled: A }],
    ]);
    expect(table.blocks).toEqual({ ref: 1, index: 0, obj: 0, log: 1 });
  });

  it("reads deflated log records, newest update index first within a ref", () => {
    const table = parseReftable(buildReftable(sample).bytes, "t.ref");
    expect(table.logs.map((l) => [l.refName, l.updateIndex, l.update?.message])).toEqual([
      ["HEAD", 2, "commit: two\n"],
      ["HEAD", 1, "commit (initial): one\n"],
      ["refs/heads/main", 2, "commit: two\n"],
    ]);
    expect(table.logs[0]?.update).toMatchObject({
      oldId: A,
      newId: B,
      name: "Tester",
      email: "t@example.com",
      time: 1700000000,
      tzOffset: -480,
    });
  });

  it("reads deletions of refs and logs, and an empty table", () => {
    const table = parseReftable(
      buildReftable({
        refs: [{ name: "refs/heads/gone", updateIndex: 1, deleted: true }],
        logs: [{ name: "refs/heads/gone", updateIndex: 1 }],
      }).bytes,
    );
    expect(table.refs[0]?.value).toEqual({ type: "deletion" });
    expect(table.logs[0]?.update).toBeUndefined();
    const empty = parseReftable(buildReftable({}).bytes);
    expect(empty.refs).toEqual([]);
    expect(empty.logs).toEqual([]);
  });

  it("reads a log-only table, its log block at the header", () => {
    const table = parseReftable(
      buildReftable({ logs: [{ name: "HEAD", updateIndex: 1, update: update(Z, A, "x") }] }).bytes,
    );
    expect(table.logs).toHaveLength(1);
    expect(table.refs).toEqual([]);
  });

  it("reads version 2 tables with the sha1 hash id and refuses SHA-256 ones", () => {
    const v2 = parseReftable(buildReftable({ ...sample, version: 2 }).bytes);
    expect(v2.version).toBe(2);
    expect(v2.refs).toHaveLength(4);
    expect(() =>
      parseReftable(buildReftable({ ...sample, version: 2, hashId: "s256" }).bytes, "t.ref"),
    ).toThrow(ReftableUnsupportedError);
    expectFormatError(buildReftable({ ...sample, version: 2, hashId: "md5!" }).bytes, /hash id/);
  });
});

describe("parseReftable refuses crafted and corrupt tables", () => {
  it("refuses truncated files at every length", () => {
    const { bytes } = buildReftable(sample);
    for (let n = 0; n < bytes.length; n++) {
      expect(() => parseReftable(bytes.slice(0, n), "t.ref")).toThrow(ReftableFormatError);
    }
  });

  it("refuses a bad magic and an unknown version", () => {
    const { bytes } = buildReftable(sample);
    const magic = bytes.slice();
    magic[0] = 0x58;
    expectFormatError(magic, /bad magic/);
    const version = bytes.slice();
    version[4] = 3;
    expectFormatError(version, /unknown version 3/);
  });

  it("refuses a bad footer CRC, and a footer that does not repeat the header", () => {
    const { bytes, footerStart } = buildReftable(sample);
    const crc = bytes.slice();
    crc[crc.length - 1] = (crc[crc.length - 1] as number) ^ 1;
    expectFormatError(crc, /CRC-32 mismatch/);
    const header = bytes.slice();
    header[footerStart + 10] = (header[footerStart + 10] as number) ^ 1;
    expectFormatError(header, /does not repeat the header/);
  });

  it("refuses section positions past the blocks", () => {
    const { bytes, footerStart, headerSize } = buildReftable(sample);
    const log = bytes.slice();
    // log_position: the 4th uint64 after the header copy
    log[footerStart + headerSize + 3 * 8 + 6] = 0x7f;
    fixFooterCrc(log, footerStart);
    expectFormatError(log, /log_position .* past the last block/);
  });

  it("refuses restart offsets out of range or out of order", () => {
    const built = buildReftable(sample);
    const { bytes, refRestartsAt } = built;
    const past = bytes.slice();
    past.set([0xff, 0xff, 0xff], refRestartsAt);
    expectFormatError(past, /restart offset 16777215 out of range/);
    const inHeader = bytes.slice();
    inHeader.set([0, 0, 2], refRestartsAt);
    expectFormatError(inHeader, /restart offset 2 out of range/);
    // a restart count that puts the table over the block header
    const count = bytes.slice();
    count.set([0xff, 0xff], built.refBlockLen - 2);
    expectFormatError(count, /restart table overlaps its header/);
    const none = bytes.slice();
    none.set([0, 0], built.refBlockLen - 2);
    expectFormatError(none, /no restart point/);
    // a restart that is not a record start
    const mid = bytes.slice();
    mid.set([0, 0, 29], refRestartsAt);
    expectFormatError(mid, /restart|key|record/);
  });

  it("refuses block lengths past the section or shorter than a block", () => {
    const { bytes, headerSize } = buildReftable(sample);
    const long = bytes.slice();
    long.set([0x00, 0xff, 0xff], headerSize + 1);
    expectFormatError(long, /runs past its section/);
    const short = bytes.slice();
    short.set([0, 0, 5], headerSize + 1);
    expectFormatError(short, /too short/);
    const huge = bytes.slice();
    huge.set([0xff, 0xff, 0xff], headerSize + 1);
    expectFormatError(huge, /runs past its section/);
  });

  it("refuses a log block that does not inflate to its length", () => {
    const built = buildReftable(sample);
    const len = built.bytes.slice();
    const at = built.logPosition + 1;
    len.set([0, 0, (len[at + 2] as number) + 1], at);
    expectFormatError(len, /log block at \d+ (inflates to|does not inflate)/);
    const data = built.bytes.slice();
    data[built.logPosition + 6] = (data[built.logPosition + 6] as number) ^ 0xff;
    expectFormatError(data, /log block|log records|log key|varint|runs past/);
  });

  it("refuses a key prefix longer than the previous key, and an unknown value type", () => {
    const table: FixtureTable = {
      restartInterval: 16,
      refs: [
        { name: "refs/heads/a", updateIndex: 1, id: A },
        { name: "refs/heads/b", updateIndex: 1, id: B },
      ],
    };
    const { bytes, headerSize } = buildReftable(table);
    const recordsStart = headerSize + 4;
    // the first record: prefix 0, (12 << 3) | 1, the name, delta 0, the id
    const firstLen = 1 + varint(12 * 8 + 1).length + 12 + 1 + 20;
    const prefix = bytes.slice();
    prefix[recordsStart + firstLen] = 40;
    expectFormatError(prefix, /key prefix longer than the last key/);
    const type = bytes.slice();
    // (12 << 3) | 5 = 101: one varint byte, as (12 << 3) | 1 was
    type[recordsStart + 1] = 101;
    expectFormatError(type, /unknown ref value type 5/);
  });

  it("refuses ref records out of order", () => {
    const { bytes, headerSize } = buildReftable({
      restartInterval: 1,
      refs: [
        { name: "refs/heads/a", updateIndex: 1, id: A },
        { name: "refs/heads/b", updateIndex: 1, id: B },
      ],
    });
    const swapped = bytes.slice();
    // the second record's name ends in 'b': make it 'a' (a duplicate key)
    const second = headerSize + 4 + 1 + 1 + 12 + 1 + 20;
    swapped[second + 1 + 1 + 11] = 0x61;
    expectFormatError(swapped, /out of order/);
  });

  it("never reads past the buffer: every single-byte change is refused or parsed", () => {
    const { bytes } = buildReftable(sample);
    for (let i = 0; i < bytes.length; i++) {
      for (const flip of [0x01, 0x80, 0xff]) {
        const copy = bytes.slice();
        copy[i] = (copy[i] as number) ^ flip;
        try {
          parseReftable(copy, "t.ref");
        } catch (error) {
          expect(
            error instanceof ReftableFormatError || error instanceof ReftableUnsupportedError,
          ).toBe(true);
        }
      }
    }
  });
});

describe("the merged view of a stack", () => {
  const base = openReftable(buildReftable(sample).bytes, "base.ref");
  const top = openReftable(
    buildReftable({
      minUpdateIndex: 4,
      maxUpdateIndex: 5,
      refs: [
        { name: "refs/heads/main", updateIndex: 4, id: C },
        { name: "refs/heads/main2", updateIndex: 5, deleted: true },
      ],
      logs: [
        { name: "HEAD", updateIndex: 4, update: update(B, C, "commit: three") },
        // a log deletion hides the entry of an older table
        { name: "HEAD", updateIndex: 1 },
      ],
    }).bytes,
    "top.ref",
  );

  it("takes the newest table's record and hides deleted refs", () => {
    const view = mergeReftables([base, top]);
    expect([...view.refs()].map((r) => [r.name, r.value])).toEqual([
      ["HEAD", { type: "symref", target: "refs/heads/main" }],
      ["refs/heads/main", { type: "id", id: C }],
      ["refs/tags/v1", { type: "peeled", id: C, peeled: A }],
    ]);
    expect(view.getRef("refs/heads/main2")).toBeUndefined();
  });

  it("orders logs newest first and lets deletions hide entries", () => {
    const view = mergeReftables([base, top]);
    expect([...view.logs("HEAD")].map((l) => [l.updateIndex, l.update?.message])).toEqual([
      [4, "commit: three\n"],
      [2, "commit: two\n"],
    ]);
    expect(view.hasLogs("refs/heads/main")).toBe(true);
    expect(view.hasLogs("refs/heads/none")).toBe(false);
  });
});

async function repository(tables: Record<string, FixtureTable>, list = Object.keys(tables)) {
  const files = createInMemoryFilesApi();
  for (const [name, table] of Object.entries(tables)) {
    await files.write(`.git/reftable/${name}`, [buildReftable(table).bytes]);
  }
  await files.write(".git/reftable/tables.list", [
    new TextEncoder().encode(list.map((n) => `${n}\n`).join("")),
  ]);
  await files.write(".git/HEAD", [new TextEncoder().encode("ref: refs/heads/.invalid\n")]);
  return files;
}

describe("the reftable ref store", () => {
  it("resolves, lists in name order and reads reflogs", async () => {
    const files = await repository({ "0x01-0x03-aa.ref": sample });
    const refs = createReftableRefStore({ files, gitDir: ".git" });
    const head = await refs.get("HEAD");
    expect(head && isSymbolicRef(head) ? head.target : undefined).toBe("refs/heads/main");
    expect((await refs.resolve("HEAD"))?.objectId).toBe(A);
    const listed: string[] = [];
    for await (const r of refs.list()) listed.push(r.name);
    expect(listed).toEqual(["HEAD", "refs/heads/main", "refs/heads/main2", "refs/tags/v1"]);
    const heads: string[] = [];
    for await (const r of refs.list("refs/heads/")) heads.push(r.name);
    expect(heads).toEqual(["refs/heads/main", "refs/heads/main2"]);
    const tag = await refs.get("refs/tags/v1");
    expect(tag).toMatchObject({ objectId: C, peeledObjectId: A });
    const log = await refs.getReflog("HEAD");
    expect(await log?.getReverseEntries()).toEqual([
      {
        oldId: A,
        newId: B,
        who: { name: "Tester", email: "t@example.com", timestamp: 1700000000, tzOffset: "-0800" },
        comment: "commit: two",
      },
      {
        oldId: Z,
        newId: A,
        who: { name: "Tester", email: "t@example.com", timestamp: 1700000000, tzOffset: "-0800" },
        comment: "commit (initial): one",
      },
    ]);
    expect(await refs.getReflog("refs/heads/main2")).toBeUndefined();
  });

  it("refuses every write with ReftableWriteUnsupportedError, changing nothing", async () => {
    const files = await repository({ "0x01-0x03-aa.ref": sample });
    const refs = createReftableRefStore({ files, gitDir: ".git" });
    const writes = [
      () => refs.set("refs/heads/x", A),
      () => refs.setSymbolic("HEAD", "refs/heads/x"),
      () => refs.remove("refs/heads/main"),
      () => refs.removeAll(["refs/heads/main"]),
      () => refs.batch([{ name: "refs/heads/x", new: A }]),
      () => refs.compareAndSwap("refs/heads/main", A, B),
      () => refs.deleteReflogEntry("HEAD", 0),
      () => refs.packRefs([], { all: true }),
      () => refs.optimize(),
      () => refs.setShallow([A]),
    ];
    for (const write of writes) {
      await expect(write()).rejects.toBeInstanceOf(ReftableWriteUnsupportedError);
    }
    await expect(refs.set("refs/heads/x", A)).rejects.toThrow(
      "cannot lock ref 'refs/heads/x': writing the reftable ref storage (extensions.refStorage = reftable) is not supported",
    );
    expect(refs.writeRefusal()).toBeInstanceOf(ReftableWriteUnsupportedError);
    expect((await refs.resolve("refs/heads/main"))?.objectId).toBe(A);
  });

  it("reads a stack whose newest table hides refs, and starts over when it changes", async () => {
    const files = await repository({
      "0x01-0x03-aa.ref": sample,
      "0x04-0x04-bb.ref": {
        minUpdateIndex: 4,
        maxUpdateIndex: 4,
        refs: [{ name: "refs/heads/main", updateIndex: 4, deleted: true }],
      },
    });
    const refs = createReftableRefStore({ files, gitDir: ".git" });
    expect(await refs.get("refs/heads/main")).toBeUndefined();
    expect(await refs.resolve("HEAD")).toBeUndefined();
    await files.write(".git/reftable/tables.list", [
      new TextEncoder().encode("0x01-0x03-aa.ref\n"),
    ]);
    expect((await refs.resolve("HEAD"))?.objectId).toBe(A);
  });

  it("reads a linked worktree's own refs from its stack, the shared ones from the repository's", async () => {
    const files = await repository({ "0x01-0x03-aa.ref": sample });
    await files.write(".git/worktrees/wt/reftable/0x01-0x01-cc.ref", [
      buildReftable({
        refs: [
          { name: "HEAD", updateIndex: 1, target: "refs/heads/main2" },
          { name: "refs/bisect/bad", updateIndex: 1, id: C },
        ],
      }).bytes,
    ]);
    await files.write(".git/worktrees/wt/reftable/tables.list", [
      new TextEncoder().encode("0x01-0x01-cc.ref\n"),
    ]);
    const wt = createReftableRefStore({
      files,
      gitDir: ".git/worktrees/wt",
      commonDir: ".git",
    });
    expect((await wt.resolve("HEAD"))?.objectId).toBe(B);
    expect((await wt.resolve("main-worktree/HEAD"))?.objectId).toBe(A);
    const listed: string[] = [];
    for await (const r of wt.list()) listed.push(r.name);
    expect(listed).toEqual([
      "HEAD",
      "refs/bisect/bad",
      "refs/heads/main",
      "refs/heads/main2",
      "refs/tags/v1",
    ]);
    const main = createReftableRefStore({ files, gitDir: ".git" });
    expect((await main.resolve("worktrees/wt/HEAD"))?.objectId).toBe(B);
    expect(await main.get("refs/bisect/bad")).toBeUndefined();
  });

  it("refuses a tables.list naming a file outside the stack, and a table gone for good", async () => {
    const files = await repository({ "0x01-0x03-aa.ref": sample }, ["../../config.ref"]);
    const refs = createReftableRefStore({ files, gitDir: ".git" });
    await expect(refs.get("HEAD")).rejects.toThrow(/bad table name '\.\.\/\.\.\/config\.ref'/);
    const gone = await repository({ "0x01-0x03-aa.ref": sample }, ["0x09-0x09-zz.ref"]);
    const stack = createReftableStackReader(gone, ".git/reftable");
    await expect(stack.read()).rejects.toBeInstanceOf(ReftableFormatError);
  });

  it("reads a missing stack as no refs", async () => {
    const refs = createReftableRefStore({ files: createInMemoryFilesApi(), gitDir: ".git" });
    expect(await refs.get("HEAD")).toBeUndefined();
  });
});

describe("a crafted table cannot make the parser allocate without bound", () => {
  /**
   * Each record reuses its predecessor's whole key and adds one byte: a few bytes of table
   * per record, a key copy as long as the key. Without a bound the copies are quadratic
   * (a ~600 KiB table needed over 20 GB); the merge gate of statewalker/webrun-vcs#225.
   */
  function longPrefixTable(firstKey: number, records: number): Uint8Array {
    const header = [0x52, 0x45, 0x46, 0x54, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    const updateMax = [0, 0, 0, 0, 0, 0, 0, 1];
    const head = [...header, ...updateMax];
    const recs: number[] = [...varint(0), ...varint(firstKey * 8)];
    for (let i = 0; i < firstKey; i++) recs.push(0x61);
    recs.push(0); // update index delta of a deletion record
    let length = firstKey;
    for (let i = 0; i < records; i++) {
      recs.push(...varint(length), ...varint(1 * 8), 0x61, 0);
      length++;
    }
    const restart = [0, 0, 28, 0, 1]; // one restart, at the first record
    const blockLen = head.length + 4 + recs.length + restart.length;
    const block = [
      0x72,
      (blockLen >> 16) & 255,
      (blockLen >> 8) & 255,
      blockLen & 255,
      ...recs,
      ...restart,
    ];
    const footer = [...head, ...new Array(40).fill(0), 0, 0, 0, 0];
    const bytes = Uint8Array.from([...head, ...block, ...footer]);
    fixFooterCrc(bytes, head.length + block.length);
    return bytes;
  }

  it("refuses a listing whose names expand past the per-read ceiling", () => {
    const bytes = longPrefixTable(2000, 30000);
    const started = Date.now();
    const table = openReftable(bytes, "crafted.ref");
    // a lookup scans keys in one scratch buffer: no name is built but the one it returns
    expect(table.getRef("b")).toBeUndefined();
    expect(table.getRef("a".repeat(2010))?.name.length).toBe(2010);
    expect(() => [...table.refs()]).toThrow(/one read decodes more than 268435456 bytes/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("still reads the same shape when it stays small", () => {
    const table = parseReftable(longPrefixTable(20, 50), "small.ref");
    expect(table.refs).toHaveLength(51);
  });
});

describe("a crafted log block cannot inflate into gigabytes of records", () => {
  /**
   * One log block of `blockLen` inflated bytes holding deletion records of a few bytes each,
   * prefix compressed and deflated to almost nothing: a 124 KiB table of 5.5 million records
   * took 2.6 GB before the budget was charged against the file's own bytes (pass 2 of the
   * merge gate of statewalker/webrun-vcs#225).
   */
  function logBomb(blockLen: number): Uint8Array {
    const header = Buffer.alloc(24);
    header.write("REFT", 0);
    header[4] = 1;
    header.writeUIntBE(4096, 5, 3);
    header.writeBigUInt64BE(1n, 8);
    header.writeBigUInt64BE(1n, 16);
    const skip = 28;
    const ref = Buffer.from("refs/heads/b");
    const body = Buffer.alloc(blockLen);
    let pos = 0;
    let last: Buffer | undefined;
    for (let c = 0; ; c++) {
      const k = Buffer.alloc(ref.length + 9);
      ref.copy(k);
      k.writeBigUInt64BE(0xffffffffff000000n + BigInt(c), ref.length + 1);
      let p = 0;
      if (last) while (p < k.length && k[p] === last[p]) p++;
      const rec = [...varint(p), ...varint((k.length - p) * 8), ...k.subarray(p)];
      if (skip + pos + rec.length + 5 > blockLen) break;
      for (const x of rec) body[pos++] = x;
      last = k;
    }
    const len = skip + pos + 5;
    const inflated = Buffer.alloc(len - skip);
    body.copy(inflated, 0, 0, pos);
    inflated.writeUIntBE(28, pos, 3);
    inflated.writeUInt16BE(1, pos + 3);
    const blockHead = Buffer.from([0x67, (len >> 16) & 255, (len >> 8) & 255, len & 255]);
    const footer = Buffer.alloc(68);
    header.copy(footer, 0);
    const bytes = new Uint8Array(
      Buffer.concat([header, blockHead, deflateSync(inflated, { level: 9 }), footer]),
    );
    fixFooterCrc(bytes, bytes.length - 68);
    return bytes;
  }

  it("reads a block of a million tombstones one record at a time, keeping none", () => {
    // each record is a fraction of a file byte, as git's `reflog expire` tombstones are: the
    // reader inflates the one block and streams its records; a reflog read drops them all
    const bytes = logBomb(4 << 20);
    expect(bytes.length).toBeLessThan(64 << 10);
    const started = Date.now();
    const table = openReftable(bytes, "bomb.ref");
    let count = 0;
    for (const log of table.logs("refs/heads/b")) if (log.update === undefined) count++;
    expect(count).toBeGreaterThan(1_000_000);
    expect([...mergeReftables([table]).logs("refs/heads/b")]).toEqual([]);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("the lazy reader holds one block, whatever the table stands for", () => {
  /**
   * One ref block of records each repeating the whole previous key plus one `byte` (0x80:
   * not UTF-8), about five file bytes a record: the eager parser kept some 830 times the
   * file in memory (3 MB took 2.4 GB; 6.5 MB aborted V8 in DecodeUTF8), pass 3 of the merge
   * gate of statewalker/webrun-vcs#225. Lookups scan it in one scratch buffer; listings
   * meet the per-read ceiling.
   */
  function refBomb(size: number, byte: number): Uint8Array {
    const head = [0x52, 0x45, 0x46, 0x54, 1, 0, 0, 0, ...[0, 0, 0, 0, 0, 0, 0, 1]];
    head.push(...[0, 0, 0, 0, 0, 0, 0, 1]);
    const records = new Uint8Array(size);
    let pos = 0;
    records.set([0, 8, 0x72, 0], pos); // "r", a deletion record
    pos += 4;
    for (let length = 1; pos + 8 < size; length++) {
      const v = varint(length);
      records.set([...v, 8, byte, 0], pos);
      pos += v.length + 3;
    }
    const blockLen = head.length + 4 + pos + 5;
    const bytes = new Uint8Array(blockLen + 68);
    bytes.set(head, 0);
    bytes.set([0x72, (blockLen >> 16) & 255, (blockLen >> 8) & 255, blockLen & 255], 24);
    bytes.set(records.subarray(0, pos), 28);
    bytes.set([0, 0, 28, 0, 1], 28 + pos);
    bytes.set(head, blockLen);
    fixFooterCrc(bytes, blockLen);
    return bytes;
  }

  for (const byte of [0x80, 0x61]) {
    it(`looks up and lists a 3 MB long-prefix ref block (suffix 0x${byte.toString(16)})`, async () => {
      const bytes = refBomb(3 << 20, byte);
      const started = Date.now();
      const table = openReftable(bytes, "refbomb.ref");
      expect(table.getRef("refs/heads/main")).toBeUndefined();
      expect(table.getRef("r")?.value).toEqual({ type: "deletion" });
      expect([...table.refs("refs/")]).toEqual([]);
      expect(() => [...table.refs()]).toThrow(ReftableFormatError);
      expect(() => [...table.refs()]).toThrow(/per-read ceiling/);
      // the ref store lists refs under refs/ only: nothing, at once
      const files = createInMemoryFilesApi();
      await files.write(".git/reftable/0x01-0x01-bb.ref", [bytes]);
      await files.write(".git/reftable/tables.list", [
        new TextEncoder().encode("0x01-0x01-bb.ref\n"),
      ]);
      const refs = createReftableRefStore({ files, gitDir: ".git" });
      const listed: string[] = [];
      for await (const r of refs.list()) listed.push(r.name);
      expect(listed).toEqual([]);
      expect(await refs.get("refs/heads/main")).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(10000);
    });
  }

  /** `blocks` deflated log blocks of `blockLen` bytes, each of tombstones of one ref. */
  function logBombs(blocks: number, blockLen: number): Uint8Array {
    const parts: Buffer[] = [];
    const header = Buffer.alloc(24);
    header.write("REFT", 0);
    header[4] = 1;
    header.writeBigUInt64BE(1n, 8);
    header.writeBigUInt64BE(1n, 16);
    parts.push(header);
    for (let b = 0; b < blocks; b++) {
      const skip = b === 0 ? 28 : 4;
      const ref = Buffer.from(`refs/heads/b${b}`);
      const body = Buffer.alloc(blockLen);
      let pos = 0;
      let last: Buffer | undefined;
      for (let c = 0; ; c++) {
        const k = Buffer.alloc(ref.length + 9);
        ref.copy(k);
        k.writeBigUInt64BE(0xffffffffff000000n + BigInt(c), ref.length + 1);
        let p = 0;
        if (last) while (p < k.length && k[p] === last[p]) p++;
        const rec = [...varint(p), ...varint((k.length - p) * 8), ...k.subarray(p)];
        if (skip + pos + rec.length + 5 > blockLen) break;
        for (const x of rec) body[pos++] = x;
        last = k;
      }
      const len = skip + pos + 5;
      const inflated = Buffer.alloc(len - skip);
      body.copy(inflated, 0, 0, pos);
      inflated.writeUIntBE(skip, pos, 3);
      inflated.writeUInt16BE(1, pos + 3);
      parts.push(Buffer.from([0x67, (len >> 16) & 255, (len >> 8) & 255, len & 255]));
      parts.push(deflateSync(inflated, { level: 9 }));
    }
    const footer = Buffer.alloc(68);
    header.copy(footer, 0);
    parts.push(footer);
    const bytes = new Uint8Array(Buffer.concat(parts));
    fixFooterCrc(bytes, bytes.length - 68);
    return bytes;
  }

  it("reads one ref's log across deflated bombs, and refuses a walk of all past a ceiling", () => {
    const bytes = logBombs(3, 1 << 20);
    expect(bytes.length).toBeLessThan(64 << 10);
    const table = openReftable(bytes, "logbomb.ref");
    // the seek inflates the blocks one at a time to find the ref's first key
    let count = 0;
    for (const log of table.logs("refs/heads/b2")) {
      expect(log.update).toBeUndefined();
      expect(log.refName).toBe("refs/heads/b2");
      count++;
    }
    expect(count).toBeGreaterThan(250_000);
    expect([...table.logs("refs/heads/none")]).toEqual([]);
    // a walk of every record charges each one: refused past a (here small) ceiling
    expect(() => {
      for (const _ of table.logs(undefined, new ReftableReadBudget(16 << 20)));
    }).toThrow(/one read decodes more than 16777216 bytes/);
    expect(REFTABLE_READ_CEILING).toBe(256 << 20);
  });

  it("follows a log block bound: a block may not inflate past its header's length", () => {
    const bytes = logBombs(1, 1 << 16);
    const copy = bytes.slice();
    // block_len one byte short of what the stream inflates to
    copy[26] = (copy[26] as number) - 1;
    expect(() => [...openReftable(copy, "t.ref").logs()]).toThrow(
      /log block at 0 (inflates to|does not inflate)/,
    );
  });
});
