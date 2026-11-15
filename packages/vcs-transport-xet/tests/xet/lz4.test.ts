import { describe, expect, it } from "vitest";
import { lz4BlockEncode, lz4FrameDecode, lz4FrameEncode, xxh32 } from "../../src/index.js";

describe("H8 LZ4 frames", () => {
  /** an LZ4 frame put together by hand */
  function frame(
    blocks: { bytes: number[]; raw?: boolean }[],
    o: {
      independent?: boolean;
      blockChecksum?: boolean;
      contentSize?: number;
      contentChecksum?: boolean;
      endMark?: boolean;
    } = {},
  ): Uint8Array {
    const flg =
      0x40 |
      (o.independent ? 0x20 : 0) |
      (o.blockChecksum ? 0x10 : 0) |
      (o.contentSize !== undefined ? 0x08 : 0) |
      (o.contentChecksum ? 0x04 : 0);
    const out = [0x04, 0x22, 0x4d, 0x18, flg, 0x40];
    if (o.contentSize !== undefined)
      for (let i = 0; i < 8; i++) out.push(i === 0 ? o.contentSize : 0);
    out.push(0x00); // header checksum (not checked)
    const u32 = (v: number) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    for (const b of blocks) {
      out.push(...u32(b.bytes.length | (b.raw ? 0x80000000 : 0)), ...b.bytes);
      if (o.blockChecksum) out.push(0, 0, 0, 0);
    }
    if (o.endMark !== false) out.push(0, 0, 0, 0);
    if (o.contentChecksum) out.push(0, 0, 0, 0);
    return Uint8Array.from(out);
  }
  const text = (b: Uint8Array) => new TextDecoder().decode(b);
  const lits = (s: string) => [s.length << 4, ...new TextEncoder().encode(s)]; // a literals-only block

  it("LZ4 frames: uncompressed and linked blocks, content size, checksums", () => {
    expect(
      text(
        lz4FrameDecode(frame([{ bytes: [...new TextEncoder().encode("plain")], raw: true }]), 5),
      ),
    ).toBe("plain");
    // block 2 starts with a match 4 bytes back into block 1 ("abcd"), then a literal
    const linked = frame([{ bytes: lits("abcd") }, { bytes: [0x00, 4, 0, ...lits("Z")] }]);
    expect(text(lz4FrameDecode(linked, 9))).toBe("abcdabcdZ");
    const all = frame([{ bytes: lits("hello") }], {
      contentSize: 5,
      blockChecksum: true,
      contentChecksum: true,
    });
    expect(text(lz4FrameDecode(all, 5))).toBe("hello");
  });

  it("LZ4 frames that lie are refused", () => {
    // literals running past their block, padded to the expected size
    expect(() => lz4FrameDecode(frame([{ bytes: [0xf0, 0x0a, 0x41] }]), 25)).toThrow(/lz4/);
    // no end mark
    expect(() => lz4FrameDecode(frame([{ bytes: lits("abc") }], { endMark: false }), 3)).toThrow(
      /lz4/,
    );
    // independent blocks: a match into the previous block
    expect(() =>
      lz4FrameDecode(
        frame([{ bytes: lits("abcd") }, { bytes: [0x00, 4, 0, ...lits("Z")] }], {
          independent: true,
        }),
        9,
      ),
    ).toThrow(/lz4/);
  });
});
/**
 * LZ4's end-of-block rules, which decoders may rely on (ours does not check them): the last 5
 * bytes are literals, no match starts within the last 12, offsets reach only bytes already
 * written; and the block decodes to `data`.
 */
function checkBlockRules(block: Uint8Array, data: Uint8Array, name: string) {
  const out = new Uint8Array(data.length);
  let at = 0;
  let o = 0;
  while (at < block.length) {
    const token = block[at++] as number;
    let lit = token >> 4;
    if (lit === 15) for (let b = 255; b === 255; lit += b) b = block[at++] as number;
    out.set(block.subarray(at, at + lit), o);
    at += lit;
    o += lit;
    if (at >= block.length) break;
    const offset = (block[at] as number) | ((block[at + 1] as number) << 8);
    at += 2;
    let len = (token & 15) + 4;
    if ((token & 15) === 15) for (let b = 255; b === 255; len += b) b = block[at++] as number;
    // plain comparisons (thousands per block); an assertion only on a failure
    if (o > data.length - 12) expect.fail(`${name}: a match starts within the last 12 bytes`);
    if (offset < 1 || offset > o) expect.fail(`${name}: offset ${offset} at ${o}`);
    for (let i = 0; i < len; i++) out[o + i] = out[o - offset + i] as number;
    o += len;
    if (o > data.length - 5) expect.fail(`${name}: a match covers the last 5 bytes`);
  }
  if (o !== data.length || !Buffer.from(out).equals(Buffer.from(data)))
    expect.fail(`${name}: does not decode back`);
}

describe("U3 LZ4 frames written: round trips and xxHash32", () => {
  it("xxHash32 matches its published values (the frame's header checksum)", () => {
    const t = (s: string) => xxh32(new TextEncoder().encode(s));
    expect(t("")).toBe(0x02cc5d05);
    expect(t("abc")).toBe(0x32d153ff);
    expect(t("Nobody inspects the spammish repetition")).toBe(0xe2293b2f);
  });

  it("LZ4 frames round trip: empty, tiny, incompressible, runs, matches up to 64 KiB back", () => {
    const rand = (n: number, seed: number) => {
      const out = new Uint8Array(n);
      let x = seed;
      for (let i = 0; i < n; i++) {
        x = (Math.imul(x, 1103515245) + 12345) >>> 0;
        out[i] = x >>> 24;
      }
      return out;
    };
    const far = new Uint8Array(200_000);
    far.set(rand(1000, 3), 0);
    far.set(rand(1000, 3), 65_000); // 65,000 back: within the 16-bit offset
    far.set(rand(1000, 3), 140_000); // 75,000 after the second: too far, found again from it
    const cases: [string, Uint8Array][] = [
      ["empty", new Uint8Array(0)],
      ...[1, 5, 12, 13, 17].map((n): [string, Uint8Array] => [`${n} bytes`, rand(n, n)]),
      ["incompressible 128 KiB", rand(128 * 1024, 7)],
      ["a run of one byte", new Uint8Array(100_000).fill(42)],
      ["text", new TextEncoder().encode("the quick brown fox ".repeat(5000))],
      ["far repeats", far],
      ["long literals then a match", new Uint8Array([...rand(300, 9), ...rand(300, 9)])],
    ];
    for (const [name, data] of cases) {
      const frame = lz4FrameEncode(data);
      expect(Buffer.from(lz4FrameDecode(frame, data.length)).equals(Buffer.from(data)), name).toBe(
        true,
      );
    }
    for (const [name, data] of cases) checkBlockRules(lz4BlockEncode(data), data, name);
    expect(lz4BlockEncode(new Uint8Array(100_000).fill(42)).length).toBeLessThan(500);
    expect(lz4FrameEncode(rand(4096, 1)).length).toBeLessThanOrEqual(4096 + 15); // stored
  });
});

describe("U4 (review of #121) LZ4 frames beyond the reference files", () => {
  const rand = (n: number, seed: number, alphabet = 256) => {
    const out = new Uint8Array(n);
    let x = seed;
    for (let i = 0; i < n; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      out[i] = (x >>> 24) % alphabet;
    }
    return out;
  };

  it("the empty frame's bytes (the header checksum as liblz4 writes it for 60 70)", () => {
    expect(Buffer.from(lz4FrameEncode(new Uint8Array(0))).toString("hex")).toBe(
      "04224d1860707300000000",
    );
  });

  it("a chunk over 4 MiB: blocks of at most 4 MiB; a block past the frame's maximum is refused", () => {
    const big = new Uint8Array(6 * 1024 * 1024);
    for (let at = 0; at < big.length; at += 4096) big.set(rand(4096, at % 65536, 16), at);
    const frame = lz4FrameEncode(big);
    let at = 7;
    const sizes: number[] = [];
    for (;;) {
      const word = new DataView(frame.buffer, frame.byteOffset).getUint32(at, true);
      if (word === 0) break;
      sizes.push(word & 0x7fffffff);
      at += 4 + (word & 0x7fffffff);
    }
    expect(sizes.length).toBe(2);
    for (const n of sizes) expect(n).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(Buffer.from(lz4FrameDecode(frame, big.length)).equals(Buffer.from(big))).toBe(true);
    // a frame declaring 64 KiB blocks (BD 0x40) that holds a 70,000-byte stored block
    const lying = new Uint8Array(7 + 4 + 70_000 + 4);
    lying.set([0x04, 0x22, 0x4d, 0x18, 0x60, 0x40, 0x00]);
    new DataView(lying.buffer).setUint32(7, (70_000 | 0x80000000) >>> 0, true);
    expect(() => lz4FrameDecode(lying, 70_000)).toThrow(/maximum/);
  });

  it("2,000 random inputs: every block keeps LZ4's end-of-block rules and decodes back", () => {
    for (let k = 0; k < 2000; k++) {
      const n = (k * 7919) % 20_000;
      const data = rand(n, k + 1, 2 + (k % 6));
      checkBlockRules(lz4BlockEncode(data), data, `input ${k} (${n} bytes)`);
    }
  });
});
