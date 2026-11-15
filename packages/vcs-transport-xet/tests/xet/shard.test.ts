import { describe, expect, it } from "vitest";
import {
  type ChunkRef,
  dedupeIndex,
  fileHash,
  hashFromString,
  hashToString,
  keyedChunkHash,
  metadataSha256,
  rangeHash,
  readShard,
  type Shard,
  termsFor,
  writeShard,
  xorbHash,
} from "../../src/index.js";
import { CSV, fixture, fixtureBytes, hex, referenceChunks, SHARDS, XORB } from "./helpers.js";

// Reference vectors: the specification's four reference shards (base, with verification, the
// upload form without footer, a global-dedupe answer), byte for byte.

/** the reference CSV's SHA-256 (its LFS oid on the Hub), as the shard's metadata extension holds it */
const referenceSha256 = async (): Promise<Uint8Array> =>
  metadataSha256(Uint8Array.from(Buffer.from(fixture(`${CSV}.sha256`).trim(), "hex")));

describe("U1 (X11b) shards written byte for byte as the specification's reference shards", () => {
  it("base, with verification, the upload form (no footer), and a global-dedupe answer", async () => {
    const chunks = referenceChunks();
    const xorb = hashFromString(XORB);
    const file = hashFromString(fixture(`${CSV}.xet-file-hash`).trim());
    const range = hashFromString(fixture(`${XORB}.xorb.range-hash`).trim());
    const sha256 = await referenceSha256();
    const term = { xorbHash: xorb, bytes: 63_527_244, start: 0, end: 796 };
    const xorbs = [{ xorbHash: xorb, chunks }];
    // the footers' timestamps and the dedupe key are the reference shards' own inputs
    const want: Record<keyof typeof SHARDS, Shard> = {
      base: {
        files: [{ fileHash: file, terms: [term], sha256 }],
        xorbs,
        footer: { creationTimestamp: 1758141909 },
      },
      verification: {
        files: [{ fileHash: file, terms: [{ ...term, rangeHash: range }], sha256 }],
        xorbs,
        footer: { keyExpiry: 1760478341 },
      },
      upload: {
        files: [{ fileHash: file, terms: [{ ...term, rangeHash: range }], sha256 }],
        xorbs,
      },
      dedupe: {
        files: [],
        xorbs,
        footer: {
          chunkHashKey: hashFromString("12345678".repeat(8)),
          creationTimestamp: 1758663941,
          keyExpiry: 1760478341,
        },
      },
    };
    for (const k of Object.keys(SHARDS) as (keyof typeof SHARDS)[])
      expect(hex(writeShard(want[k])), k).toBe(hex(fixtureBytes(SHARDS[k])));
  }, 300_000);

  it("each reference shard read and written again is the same bytes", () => {
    for (const name of Object.values(SHARDS)) {
      const bytes = fixtureBytes(name);
      const shard = readShard(bytes);
      expect(hex(writeShard(shard)), name).toBe(hex(bytes));
    }
    const dedupe = readShard(fixtureBytes(SHARDS.dedupe));
    expect(dedupe.files).toEqual([]);
    expect(hashToString(dedupe.footer?.chunkHashKey as Uint8Array)).toBe("12345678".repeat(8));
  });
});

describe("U2 (X11b) an upload deduplicated against a global-dedupe shard", () => {
  it("every chunk found by its keyed hash; the terms make the reference upload shard", async () => {
    const chunks = referenceChunks();
    const locate = dedupeIndex([readShard(fixtureBytes(SHARDS.dedupe))]);
    chunks.forEach((c, i) => {
      const at = locate(c.hash);
      expect(at && hashToString(at.xorbHash), `chunk ${i}`).toBe(XORB);
      expect(at?.index).toBe(i);
    });
    // a chunk no shard holds; and the dedupe shard does not hold plain hashes
    expect(locate(new Uint8Array(32).fill(7))).toBeUndefined();
    const stored = readShard(fixtureBytes(SHARDS.dedupe)).xorbs[0]?.chunks[0]?.hash as Uint8Array;
    expect(hex(stored)).toBe(
      hex(keyedChunkHash(chunks[0]?.hash as Uint8Array, hashFromString("12345678".repeat(8)))),
    );
    const terms = termsFor(chunks, (h) => {
      const at = locate(h);
      if (!at) throw new Error("not deduplicated");
      return at;
    });
    expect(terms.length).toBe(1);
    expect(hashToString(terms[0]?.rangeHash as Uint8Array)).toBe(
      fixture(`${XORB}.xorb.range-hash`).trim(),
    );
    const upload = writeShard({
      files: [{ fileHash: fileHash(chunks), terms, sha256: await referenceSha256() }],
      xorbs: [{ xorbHash: xorbHash(chunks), chunks }],
    });
    expect(hex(upload)).toBe(hex(fixtureBytes(SHARDS.upload)));
  }, 300_000);

  it("terms split where the chunks leave a xorb or skip an index; each with its own range hash", () => {
    const chunks = referenceChunks().slice(0, 10);
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    // chunks 0-3 in a at 5..8, 4-5 in b at 0..1, 6 in a at 20, 7-9 in a at 21..23
    const where = [5, 6, 7, 8, 0, 1, 20, 21, 22, 23];
    const terms = termsFor(chunks, (_h, i) => ({
      xorbHash: i >= 4 && i < 6 ? b : a,
      index: where[i] as number,
    }));
    expect(terms.map((t) => [t.xorbHash[0], t.start, t.end])).toEqual([
      [1, 5, 9],
      [2, 0, 2],
      [1, 20, 24],
    ]);
    expect(terms.map((t) => t.bytes)).toEqual([
      chunks.slice(0, 4).reduce((n, c) => n + c.length, 0),
      chunks.slice(4, 6).reduce((n, c) => n + c.length, 0),
      chunks.slice(6).reduce((n, c) => n + c.length, 0),
    ]);
    expect(hex(terms[1]?.rangeHash as Uint8Array)).toBe(
      hex(rangeHash(chunks.slice(4, 6).map((c) => c.hash))),
    );
  });

  it("refuses: verification for some terms only, a damaged tag, a truncated shard, bytes after an unfooted shard", () => {
    const chunks = referenceChunks().slice(0, 2);
    const t = { xorbHash: new Uint8Array(32), bytes: 1, start: 0, end: 1 };
    expect(() =>
      writeShard({
        files: [
          { fileHash: new Uint8Array(32), terms: [{ ...t, rangeHash: new Uint8Array(32) }] },
          { fileHash: new Uint8Array(32), terms: [t] },
        ],
        xorbs: [],
      }),
    ).toThrow(/some terms only/);
    const good = writeShard({ files: [], xorbs: [{ xorbHash: new Uint8Array(32), chunks }] });
    const bad = good.slice();
    bad[3] = (bad[3] as number) ^ 1;
    expect(() => readShard(bad)).toThrow(/header tag/);
    expect(() => readShard(good.subarray(0, good.length - 1))).toThrow(/truncated/);
    const extra = new Uint8Array(good.length + 1);
    extra.set(good);
    expect(() => readShard(extra)).toThrow(/after the CAS section/);
  });
});

// ---------------------------------------------------------------- X11b: xorbs written

describe("U4 (review of #121) shards and dedupe beyond the reference files", () => {
  it("several files and xorbs, a file of no terms, chunk flags and sizes on disk: round trip and footer totals", () => {
    const h = (b: number) => new Uint8Array(32).fill(b);
    const shard: Shard = {
      files: [
        { fileHash: h(1), terms: [] },
        {
          fileHash: h(2),
          terms: [
            { xorbHash: h(10), bytes: 7, start: 0, end: 2 },
            { xorbHash: h(11), bytes: 8, start: 1, end: 2 },
          ],
          sha256: h(3),
        },
      ],
      xorbs: [
        {
          xorbHash: h(10),
          chunks: [
            { hash: h(20), length: 3 },
            { hash: h(21), length: 4 },
          ],
          bytesOnDisk: 30,
          chunkFlags: [0x80000000, 1],
        },
        {
          xorbHash: h(11),
          chunks: [
            { hash: h(22), length: 0 },
            { hash: h(23), length: 8 },
          ],
          bytesOnDisk: 17,
          chunkFlags: [0, 0],
        },
      ],
      footer: { creationTimestamp: 5 },
    };
    const bytes = writeShard(shard);
    const back = readShard(bytes);
    expect(hex(writeShard(back))).toBe(hex(bytes));
    expect(back.xorbs.map((x) => x.chunkFlags)).toEqual([
      [0x80000000, 1],
      [0, 0],
    ]);
    expect(back.xorbs.map((x) => x.bytesOnDisk)).toEqual([30, 17]);
    expect(back.files[0]?.terms).toEqual([]);
    const f = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 200);
    const u64 = (at: number) => Number(f.getBigUint64(at, true));
    expect([u64(8), u64(168), u64(176), u64(184), u64(192)]).toEqual([
      48,
      47, // on disk: 30 + 17
      15, // materialized: the terms' bytes
      15, // stored: the chunks' bytes
      bytes.length - 200,
    ]);
    // a hostile entry count is refused before anything is read for it
    const hostile = bytes.slice();
    new DataView(hostile.buffer).setUint32(48 + 36, 0xffffffff, true);
    expect(() => readShard(hostile)).toThrow(/truncated/);
  });

  it("dedupe over plain, keyed and mixed shards; duplicate chunks start new terms; keyed hashes stay out of uploads", () => {
    const chunks = referenceChunks().slice(0, 6);
    const key = hashFromString("12345678".repeat(8));
    const a = new Uint8Array(32).fill(0xa);
    const b = new Uint8Array(32).fill(0xb);
    const plain: Shard = { files: [], xorbs: [{ xorbHash: a, chunks: chunks.slice(0, 3) }] };
    const keyed = readShard(
      writeShard({
        files: [],
        xorbs: [{ xorbHash: b, chunks: chunks.slice(3) }],
        footer: { chunkHashKey: key },
      }),
    );
    const locate = dedupeIndex([plain, keyed]);
    chunks.forEach((c, i) => {
      const at = locate(c.hash);
      expect(at?.xorbHash[0], `chunk ${i}`).toBe(i < 3 ? 0xa : 0xb);
      expect(at?.index).toBe(i % 3);
    });
    // an in-memory shard with a footer key holds plain hashes until written
    const unwritten: Shard = {
      files: [],
      xorbs: [{ xorbHash: b, chunks: chunks.slice(3) }],
      footer: { chunkHashKey: key },
    };
    expect(dedupeIndex([unwritten])(chunks[4]?.hash as Uint8Array)?.index).toBe(1);
    // the same chunk twice: two terms (an index does not repeat within one term)
    const twice = [chunks[0], chunks[0]] as ChunkRef[];
    expect(termsFor(twice, () => ({ xorbHash: a, index: 0 })).length).toBe(2);
    // keyed hashes written without their key would reach the server as if plain
    expect(() => writeShard({ ...keyed, footer: undefined })).toThrow(/without the footer key/);
  });
});
