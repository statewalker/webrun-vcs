import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, deflateSync, inflateSync } from "node:zlib";
import { inflate as pakoInflate } from "pako";
import { describe, expect, it } from "vitest";
import {
  createInflaterPool,
  InflateError,
  InflateOverflowError,
  inflateWhole,
  TruncatedStreamError,
} from "../../../src/compression/index.js";

/** A deterministic generator, so a failing case can be replayed. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 2 ** 32;
  };
}

/** Text-like bytes (repeats and a small alphabet), random bytes, or runs. */
function sample(r: () => number, n: number): Uint8Array {
  const out = new Uint8Array(n);
  const kind = Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    if (kind === 0) out[i] = 97 + Math.floor(r() * 8);
    else if (kind === 1) out[i] = Math.floor(r() * 256);
    else out[i] = i > 4 && r() < 0.9 ? (out[i - 4] as number) : Math.floor(r() * 256);
  }
  return out;
}

const deflaters: { name: string; opts: object }[] = [
  { name: "default", opts: {} },
  { name: "level 0 (stored)", opts: { level: 0 } },
  { name: "level 1", opts: { level: 1 } },
  { name: "level 9", opts: { level: 9 } },
  { name: "fixed Huffman", opts: { strategy: constants.Z_FIXED } },
  { name: "Huffman only", opts: { strategy: constants.Z_HUFFMAN_ONLY } },
  { name: "RLE", opts: { strategy: constants.Z_RLE } },
  { name: "small window", opts: { windowBits: 9 } },
];

/** pako's verdict: the output, or an error */
function viaPako(z: Uint8Array): Uint8Array | Error {
  try {
    const out = pakoInflate(z);
    return out ?? new Error("pako: no output");
  } catch (e) {
    return e as Error;
  }
}

function viaWhole(z: Uint8Array): Uint8Array | Error {
  try {
    const r = inflateWhole(z, { maxSize: 1 << 22 });
    return r.data.subarray(0, r.length);
  } catch (e) {
    return e as Error;
  }
}

describe("inflateWhole", () => {
  it("inflates what zlib deflates, at every level and strategy, sizes 0 to 70000", () => {
    const r = rng(7);
    for (const { name, opts } of deflaters) {
      for (const n of [0, 1, 2, 3, 100, 257, 258, 259, 1000, 5000, 33000, 70000]) {
        const raw = sample(r, n);
        const z = new Uint8Array(deflateSync(raw, opts));
        const got = inflateWhole(z, { size: n });
        expect(got.length, `${name} ${n}`).toBe(n);
        expect(Buffer.from(got.data).equals(Buffer.from(raw)), `${name} ${n}`).toBe(true);
        expect(got.consumed, `${name} ${n}`).toBe(z.length);
      }
    }
  });

  it("writes into a given buffer, grows when the size is unknown, reports where the stream ends", () => {
    const raw = new TextEncoder().encode("tree 1234\nparent 5678\n\nmessage\n".repeat(20));
    const z = new Uint8Array(deflateSync(raw));
    const withTail = new Uint8Array(z.length + 5);
    withTail.set(z);
    const into = new Uint8Array(raw.length);
    const a = inflateWhole(withTail, { into });
    expect(a.data).toBe(into);
    expect(a.consumed).toBe(z.length);
    const b = inflateWhole(z);
    expect(Buffer.from(b.data.subarray(0, b.length)).equals(Buffer.from(raw))).toBe(true);
  });

  it("refuses output past the expected size, and past maxSize when growing", () => {
    const raw = new Uint8Array(1000).fill(7);
    const z = new Uint8Array(deflateSync(raw));
    expect(() => inflateWhole(z, { size: 999 })).toThrow(InflateOverflowError);
    expect(() => inflateWhole(z, { into: new Uint8Array(10) })).toThrow(InflateOverflowError);
    expect(() => inflateWhole(z, { maxSize: 999 })).toThrow(InflateOverflowError);
    // a shorter stream is reported by its length, for the caller to judge
    expect(inflateWhole(z, { size: 2000 }).length).toBe(1000);
  });

  it("fails on truncation (TruncatedStreamError) and on a bad checksum or header (InflateError)", () => {
    const raw = sample(rng(3), 3000);
    const z = new Uint8Array(deflateSync(raw));
    for (const cut of [0, 1, 2, 3, 10, z.length - 5, z.length - 1]) {
      expect(() => inflateWhole(z.subarray(0, cut), { size: 3000 })).toThrow(TruncatedStreamError);
    }
    const badSum = z.slice();
    badSum[badSum.length - 1] = (badSum[badSum.length - 1] as number) ^ 1;
    expect(() => inflateWhole(badSum, { size: 3000 })).toThrow(/incorrect data check/);
    const badHeader = z.slice();
    badHeader[1] = (badHeader[1] as number) ^ 1;
    expect(() => inflateWhole(badHeader, { size: 3000 })).toThrow(InflateError);
    const dict = new Uint8Array(deflateSync(raw, { dictionary: Buffer.from("abc") }));
    expect(() => inflateWhole(dict, { size: 3000 })).toThrow(/preset dictionary/);
  });

  it("agrees with pako on damaged streams: same bytes, or both fail", () => {
    const r = rng(11);
    let failures = 0;
    for (let round = 0; round < 1500; round++) {
      const { opts } = deflaters[round % deflaters.length] as { opts: object };
      const raw = sample(r, Math.floor(r() * 2000));
      const z = new Uint8Array(deflateSync(raw, opts));
      const bad = z.slice();
      const flips = 1 + Math.floor(r() * 3);
      for (let k = 0; k < flips; k++) {
        // damage the deflate data (past the 2-byte header), or the trailer
        const at = 2 + Math.floor(r() * (bad.length - 2));
        bad[at] = (bad[at] as number) ^ (1 << Math.floor(r() * 8));
      }
      const want = viaPako(bad);
      const got = viaWhole(bad);
      if (want instanceof Error) {
        expect(got, `round ${round}`).toBeInstanceOf(Error);
        failures++;
      } else {
        expect(got, `round ${round}: ${(got as Error).message}`).toBeInstanceOf(Uint8Array);
        expect(Buffer.from(got as Uint8Array).equals(Buffer.from(want)), `round ${round}`).toBe(
          true,
        );
      }
    }
    expect(failures).toBeGreaterThan(1000);
  });

  it("decodes the same as the pooled stream inflater for a handcrafted single-code distance set", () => {
    // a stream from a deflater that uses one distance code (zlib allows the incomplete set)
    const raw = new Uint8Array(600);
    for (let i = 0; i < raw.length; i++) raw[i] = i % 3 === 0 ? 1 : 2;
    const z = new Uint8Array(deflateSync(raw, { level: 9 }));
    const pool = createInflaterPool();
    const viaPool = pool.acquire().push(z);
    expect(viaPool.done).toBe(true);
    const got = inflateWhole(z, { size: raw.length });
    expect(Buffer.from(got.data).equals(Buffer.from(raw))).toBe(true);
  });

  it("stops at a full output without an error when partial (to read a header)", () => {
    const raw = new TextEncoder().encode(`blob 5000\0${"x".repeat(5000)}`);
    const z = new Uint8Array(deflateSync(raw));
    const probe = new Uint8Array(300);
    const r = inflateWhole(z, { into: probe, partial: true });
    expect(r.ended).toBe(false);
    expect(r.consumed).toBe(-1);
    expect(r.length).toBeGreaterThan(32);
    expect(new TextDecoder().decode(probe.subarray(0, 10))).toBe("blob 5000\0");
    // a stream that fits ends as usual
    const small = new Uint8Array(deflateSync(raw.subarray(0, 100)));
    const whole = inflateWhole(small, { into: probe, partial: true });
    expect(whole).toMatchObject({ length: 100, consumed: small.length, ended: true });
    // corrupt data still throws
    const bad = small.slice();
    bad[bad.length - 1] = (bad[bad.length - 1] as number) ^ 1;
    expect(() => inflateWhole(bad, { into: probe, partial: true })).toThrow(InflateError);
  });
});

describe("inflateWhole differential fuzz against node zlib", () => {
  /** node zlib's verdict, as inflateWhole's error classes: "ok", "truncated" or "corrupt" */
  function zlibVerdict(z: Uint8Array): { kind: string; out?: Uint8Array } {
    try {
      return { kind: "ok", out: new Uint8Array(inflateSync(z)) };
    } catch (e) {
      return { kind: (e as { code?: string }).code === "Z_BUF_ERROR" ? "truncated" : "corrupt" };
    }
  }

  function wholeVerdict(
    z: Uint8Array,
    options: Parameters<typeof inflateWhole>[1],
  ): { kind: string; out?: Uint8Array; consumed?: number; ended?: boolean } {
    try {
      const r = inflateWhole(z, options);
      return {
        kind: "ok",
        out: r.data.subarray(0, r.length),
        consumed: r.consumed,
        ended: r.ended,
      };
    } catch (e) {
      if (e instanceof InflateOverflowError) return { kind: "overflow" };
      if (e instanceof TruncatedStreamError) return { kind: "truncated" };
      if (e instanceof InflateError) return { kind: "corrupt" };
      throw e;
    }
  }

  /** A stream to inflate: zlib's output damaged by flips, cuts or a random byte, or random data. */
  function damagedStream(r: () => number, round: number): Uint8Array {
    const { opts } = deflaters[round % deflaters.length] as { opts: object };
    let z = new Uint8Array(deflateSync(sample(r, Math.floor(r() ** 2 * 3000)), opts));
    const damage = Math.floor(r() * 6);
    if (damage === 1 || damage === 4) {
      for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
        const at = 2 + Math.floor(r() * (z.length - 2));
        z[at] = (z[at] as number) ^ (1 << Math.floor(r() * 8));
      }
    }
    if (damage === 2 || damage === 4) z = z.subarray(0, Math.floor(r() * z.length));
    if (damage === 3) {
      // a block header or code lengths, most likely
      z[2 + Math.floor(r() * Math.min(z.length - 2, 64))] = Math.floor(r() * 256);
    }
    if (damage === 5) {
      // a valid zlib header and random bits: random block types and code sets
      z = new Uint8Array(2 + Math.floor(r() * 200));
      z[0] = 0x78;
      z[1] = 0x9c;
      for (let i = 2; i < z.length; i++) z[i] = Math.floor(r() * 256);
    }
    return z;
  }

  it("decodes the same bytes, or fails as zlib fails (truncated or corrupt), for 4000 seeded streams", () => {
    const r = rng(20261117);
    const seen = { ok: 0, truncated: 0, corrupt: 0 };
    for (let round = 0; round < 4000; round++) {
      const z = damagedStream(r, round);
      const want = zlibVerdict(z);
      const got = wholeVerdict(z, { maxSize: 1 << 22 });
      expect(got.kind, `round ${round}`).toBe(want.kind);
      seen[want.kind as keyof typeof seen]++;
      if (want.out) {
        expect(
          Buffer.from(got.out as Uint8Array).equals(Buffer.from(want.out)),
          `round ${round}`,
        ).toBe(true);
        // the same stream into an exact buffer, a short one, and a short one read partially
        const n = want.out.length;
        expect(wholeVerdict(z, { size: n }).out?.length, `round ${round}`).toBe(n);
        if (n > 0) {
          const cut = Math.floor(r() * n);
          expect(wholeVerdict(z, { size: cut }).kind, `round ${round}`).toBe("overflow");
          const part = wholeVerdict(z, { into: new Uint8Array(cut), partial: true });
          expect(part.kind, `round ${round}`).toBe("ok");
          expect(part.ended, `round ${round}`).toBe(false);
          expect(
            Buffer.from(part.out as Uint8Array).equals(
              Buffer.from(want.out.subarray(0, part.out?.length)),
            ),
            `round ${round}`,
          ).toBe(true);
        }
      }
    }
    // every outcome is exercised
    expect(seen.ok).toBeGreaterThan(400);
    expect(seen.truncated).toBeGreaterThan(400);
    expect(seen.corrupt).toBeGreaterThan(400);
  }, 30_000); // ~1 s alone, more under the whole monorepo's parallel test run
});

describe("inflateWhole on a code set zlib accepts oddly", () => {
  it("reads a code length code without codes as zlib does: lengths of 0, one bit each, until the input ends", () => {
    // a dynamic block whose 4 code length code lengths are all 0: zlib's table then decodes
    // every bit as a length of 0, and the input runs out before the 258 lengths
    const z = Uint8Array.from([0x78, 0x9c, 0xad, 0x00, 0x00, 0x00, 0x00, 0x01]);
    expect(() => inflateSync(z)).toThrow(/unexpected end of file/);
    expect(() => inflateWhole(z, { maxSize: 1000 })).toThrow(TruncatedStreamError);
  });
});

describe("inflateWhole partial: the part of a block or match that fits", () => {
  it("copies the start of a stored block longer than the output, as zlib does", () => {
    // incompressible content: zlib stores it, so the header is the start of a stored block
    const r = rng(7);
    for (const n of [10, 31, 32, 33, 100, 5000, 65535, 65536, 70000, 200000]) {
      const body = new Uint8Array(n);
      for (let i = 0; i < n; i++) body[i] = Math.floor(r() * 256);
      const raw = new Uint8Array([...new TextEncoder().encode(`blob ${n}\0`), ...body]);
      for (const opts of [{ level: 0 }, {}]) {
        const z = new Uint8Array(deflateSync(raw, opts));
        const probe = new Uint8Array(32);
        const got = inflateWhole(z, { into: probe, partial: true });
        const want = Math.min(32, raw.length);
        expect(got.length, `n ${n}`).toBe(want);
        expect(got.ended, `n ${n}`).toBe(raw.length <= 32);
        expect(
          Buffer.from(probe.subarray(0, want)).equals(Buffer.from(raw.subarray(0, want))),
        ).toBe(true);
      }
    }
  });

  it("fills a growable buffer up to maxSize with the start of a stored block", () => {
    const raw = new Uint8Array(1000).map((_, i) => (i * 7919) & 255);
    const z = new Uint8Array(deflateSync(raw, { level: 0 }));
    const got = inflateWhole(z, { maxSize: 600, partial: true });
    expect(got).toMatchObject({ length: 600, ended: false, consumed: -1 });
    expect(Buffer.from(got.data.subarray(0, 600)).equals(Buffer.from(raw.subarray(0, 600)))).toBe(
      true,
    );
    // without partial, the overflow is still an error
    expect(() => inflateWhole(z, { maxSize: 600 })).toThrow(InflateOverflowError);
    expect(() => inflateWhole(z, { size: 999 })).toThrow(InflateOverflowError);
  });

  it("copies the start of a match longer than the output", () => {
    // "abc" then a long run: one literal triple then matches of 258
    const raw = new TextEncoder().encode(`abc${"abc".repeat(400)}`);
    const z = new Uint8Array(deflateSync(raw));
    for (const cut of [4, 5, 32, 100, 259, 1000]) {
      const got = inflateWhole(z, { into: new Uint8Array(cut), partial: true });
      expect(got.length).toBe(cut);
      expect(new TextDecoder().decode(got.data.subarray(0, cut))).toBe(
        new TextDecoder().decode(raw.subarray(0, cut)),
      );
    }
  });

  it("stops after a truncated stored block only when the part that fits is there", () => {
    const raw = new Uint8Array(500).map((_, i) => (i * 31) & 255);
    const z = new Uint8Array(deflateSync(raw, { level: 0 }));
    // zlib header (2) + block header (1) + LEN/NLEN (4) + 40 bytes of the block
    const cutInput = z.subarray(0, 7 + 40);
    expect(inflateWhole(cutInput, { into: new Uint8Array(32), partial: true }).length).toBe(32);
    expect(() => inflateWhole(cutInput, { into: new Uint8Array(64), partial: true })).toThrow(
      TruncatedStreamError,
    );
  });

  it("gives exactly the prefix node zlib produces, for every output length shorter than the stream", () => {
    const r = rng(20261118);
    for (let round = 0; round < 600; round++) {
      const { opts } = deflaters[round % deflaters.length] as { opts: object };
      const raw = sample(r, 1 + Math.floor(r() ** 2 * 80000));
      const z = new Uint8Array(deflateSync(raw, opts));
      // a truncated input too: zlib's sync flush gives what the bytes there inflate to
      const input = r() < 0.5 ? z : z.subarray(0, 2 + Math.floor(r() * (z.length - 2)));
      const want = new Uint8Array(inflateSync(input, { finishFlush: constants.Z_SYNC_FLUSH }));
      if (want.length === 0) continue;
      for (let k = 0; k < 3; k++) {
        const cut = Math.floor(r() * want.length);
        const got = inflateWhole(input, { into: new Uint8Array(cut), partial: true });
        expect(got.length, `round ${round} cut ${cut}`).toBe(cut);
        expect(got.ended, `round ${round}`).toBe(false);
        expect(
          Buffer.from(got.data.subarray(0, cut)).equals(Buffer.from(want.subarray(0, cut))),
          `round ${round} cut ${cut}`,
        ).toBe(true);
      }
    }
  });
});

describe("inflateWhole partial: input that ends where the output fills", () => {
  it("returns the full buffer, as zlib does (Z_OK), when the input ends exactly at the fill point", () => {
    const r = rng(20261119);
    let checked = 0;
    for (let round = 0; round < 300; round++) {
      const { opts } = deflaters[round % deflaters.length] as { opts: object };
      const raw = sample(r, 1 + Math.floor(r() ** 2 * 20000));
      const z = new Uint8Array(deflateSync(raw, opts));
      // the shortest input whose sync-flushed output reaches `cut` bytes
      const cut = 1 + Math.floor(r() * raw.length);
      let lo = 2;
      let hi = z.length;
      const reach = (n: number) =>
        new Uint8Array(inflateSync(z.subarray(0, n), { finishFlush: constants.Z_SYNC_FLUSH }))
          .length >= cut;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (reach(mid)) hi = mid;
        else lo = mid + 1;
      }
      const input = z.subarray(0, lo);
      const got = inflateWhole(input, { into: new Uint8Array(cut), partial: true });
      expect(got.length, `round ${round}`).toBe(cut);
      expect(
        Buffer.from(got.data.subarray(0, cut)).equals(Buffer.from(raw.subarray(0, cut))),
        `round ${round}`,
      ).toBe(true);
      if (lo < z.length) checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("stops on a literal stream cut right after the byte that fills the output", () => {
    // fixed Huffman literals: the input ends inside the code after the 32nd byte
    const raw = new TextEncoder().encode("blob 40\0abcdefghijklmnopqrstuvwxyz0123456789ABCD");
    const z = new Uint8Array(deflateSync(raw, { strategy: constants.Z_FIXED }));
    for (let n = 2; n < z.length; n++) {
      const part = new Uint8Array(
        inflateSync(z.subarray(0, n), { finishFlush: constants.Z_SYNC_FLUSH }),
      );
      if (part.length < 32) continue;
      const got = inflateWhole(z.subarray(0, n), { into: new Uint8Array(32), partial: true });
      expect(got).toMatchObject({ length: 32, ended: false });
      // without partial, the same input is a truncated stream
      expect(() => inflateWhole(z.subarray(0, n), { size: raw.length })).toThrow(
        TruncatedStreamError,
      );
    }
  });
});

describe("inflateWhole differential fuzz on git objects", () => {
  /** A 20-byte object id from the generator. */
  function rawId(r: () => number): number[] {
    return Array.from({ length: 20 }, () => Math.floor(r() * 256));
  }
  const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join("");
  const enc = new TextEncoder();
  /** The bytes git hashes and stores: `<type> <size>\0` and the content. */
  function framed(type: string, body: Uint8Array): Uint8Array {
    const head = enc.encode(`${type} ${body.length}\0`);
    const out = new Uint8Array(head.length + body.length);
    out.set(head);
    out.set(body, head.length);
    return out;
  }
  /** This package's sources, as blobs. */
  const sources: Uint8Array[] = (() => {
    const out: Uint8Array[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".ts")) out.push(new Uint8Array(readFileSync(p)));
      }
    };
    walk(fileURLToPath(new URL("../../../src", import.meta.url)));
    return out;
  })();

  /** A commit, tree, blob or tag shaped as git writes them. */
  function gitObject(r: () => number, i: number): Uint8Array {
    const kind = i % 4;
    const when = 1_600_000_000 + Math.floor(r() * 1e8);
    if (kind === 0) {
      const parents = Math.floor(r() * 3);
      let s = `tree ${hex(rawId(r))}\n`;
      for (let p = 0; p < parents; p++) s += `parent ${hex(rawId(r))}\n`;
      s += `author A U Thor <author@example.com> ${when} +0200\n`;
      s += `committer C O Mitter <committer@example.com> ${when + 60} -0700\n\n`;
      s += `Subject line ${i}\n\n${"Body text wrapping at seventy-two columns. ".repeat(Math.floor(r() * 8))}\n`;
      return framed("commit", enc.encode(s));
    }
    if (kind === 1) {
      const parts: number[] = [];
      for (let e = Math.floor(r() * 60); e >= 0; e--) {
        const mode = r() < 0.2 ? "40000" : r() < 0.1 ? "100755" : "100644";
        const name = `${["src", "file", "index", "test", "README"][Math.floor(r() * 5)]}-${e}.${["ts", "md", "json"][e % 3]}`;
        parts.push(...enc.encode(`${mode} ${name}`), 0, ...rawId(r));
      }
      return framed("tree", new Uint8Array(parts));
    }
    if (kind === 2) {
      const src = sources[Math.floor(r() * sources.length)] as Uint8Array;
      const from = Math.floor(r() * src.length);
      return framed("blob", src.subarray(from, from + Math.floor(r() ** 3 * 20_000)));
    }
    const s = `object ${hex(rawId(r))}\ntype commit\ntag v${i}.0\ntagger T Agger <t@example.com> ${when} +0000\n\nRelease ${i}\n`;
    return framed("tag", enc.encode(s));
  }

  const strategies = [
    constants.Z_DEFAULT_STRATEGY,
    constants.Z_FILTERED,
    constants.Z_HUFFMAN_ONLY,
    constants.Z_RLE,
    constants.Z_FIXED,
  ];

  /** zlib's verdict on a stream with bytes after it: the output and where the stream ended. */
  function zlibRun(z: Uint8Array): { kind: string; out?: Uint8Array; consumed?: number } {
    try {
      const { buffer, engine } = inflateSync(z, { info: true }) as unknown as {
        buffer: Buffer;
        engine: { bytesWritten: number };
      };
      return { kind: "ok", out: new Uint8Array(buffer), consumed: engine.bytesWritten };
    } catch (e) {
      return { kind: (e as { code?: string }).code === "Z_BUF_ERROR" ? "truncated" : "corrupt" };
    }
  }
  function wholeRun(z: Uint8Array, size?: number) {
    try {
      const r = inflateWhole(z, size === undefined ? { maxSize: 1 << 22 } : { size });
      return { kind: "ok", out: r.data.subarray(0, r.length), consumed: r.consumed };
    } catch (e) {
      if (e instanceof InflateOverflowError) return { kind: "overflow" };
      if (e instanceof TruncatedStreamError) return { kind: "truncated" };
      if (e instanceof InflateError) return { kind: "corrupt" };
      throw e;
    }
  }

  it("inflates every object type at levels 0 to 9 and every strategy as zlib does, stopping where its stream ends", () => {
    const r = rng(4280);
    const types = new Set<number>();
    for (let i = 0; i < 1200; i++) {
      const raw = gitObject(r, i);
      const level = i % 10;
      const strategy = strategies[Math.floor(i / 10) % strategies.length];
      const z = new Uint8Array(deflateSync(raw, { level, strategy }));
      types.add(((z[2] as number) >> 1) & 3);
      // the next object follows the stream in a pack: bytes after it are not read
      const tail = new Uint8Array(z.length + 7);
      tail.set(z);
      for (let k = z.length; k < tail.length; k++) tail[k] = Math.floor(r() * 256);
      const got = wholeRun(tail, raw.length);
      expect(got.kind, `object ${i}`).toBe("ok");
      expect(got.consumed, `object ${i}`).toBe(z.length);
      expect(Buffer.from(got.out as Uint8Array).equals(Buffer.from(raw)), `object ${i}`).toBe(true);
    }
    // stored, fixed and dynamic first blocks all occur
    expect([...types].sort()).toEqual([0, 1, 2]);
  });

  it("accepts and refuses damaged git objects as zlib does, with the same bytes and end", () => {
    const r = rng(4281);
    const seen = { ok: 0, truncated: 0, corrupt: 0 };
    for (let i = 0; i < 3000; i++) {
      const raw = gitObject(r, i);
      let z = new Uint8Array(
        deflateSync(raw, {
          level: i % 10,
          strategy: strategies[Math.floor(i / 10) % strategies.length],
        }),
      );
      const damage = i % 5;
      if (damage === 1) {
        for (let k = 1 + Math.floor(r() * 3); k > 0; k--) {
          const at = Math.floor(r() * z.length);
          z[at] = (z[at] as number) ^ (1 << Math.floor(r() * 8));
        }
      } else if (damage === 2) z = z.subarray(0, Math.floor(r() * z.length));
      else if (damage === 3)
        z[2 + Math.floor(r() * Math.min(z.length - 2, 48))] = Math.floor(r() * 256);
      else if (damage === 4) {
        // a flipped bit in the Adler-32 trailer or just before it
        const at = z.length - 1 - Math.floor(r() * 6);
        z[at] = (z[at] as number) ^ (1 << Math.floor(r() * 8));
      }
      const want = zlibRun(z);
      const got = wholeRun(z);
      expect(got.kind, `object ${i}`).toBe(want.kind);
      seen[want.kind as keyof typeof seen]++;
      if (want.out) {
        expect(got.consumed, `object ${i}`).toBe(want.consumed);
        expect(
          Buffer.from(got.out as Uint8Array).equals(Buffer.from(want.out)),
          `object ${i}`,
        ).toBe(true);
      }
    }
    expect(seen.ok).toBeGreaterThan(600);
    expect(seen.truncated).toBeGreaterThan(300);
    expect(seen.corrupt).toBeGreaterThan(600);
  }, 30_000);

  it("decodes 15-bit codes, sub-tables and far distances as zlib does", () => {
    const r = rng(4282);
    for (let i = 0; i < 40; i++) {
      // byte values with a geometric spread (Huffman codes up to 15 bits), repeats from far back
      const n = 1000 + Math.floor(r() * 60_000);
      const raw = new Uint8Array(n);
      for (let k = 0; k < n; k++) {
        if (k > 40_000 && r() < 0.3) raw[k] = raw[k - 32_000 - Math.floor(r() * 700)] as number;
        else raw[k] = Math.min(255, Math.floor(-Math.log2(r() + 1e-12) * (1 + (i % 4))));
      }
      const z = new Uint8Array(
        deflateSync(raw, { level: 1 + (i % 9), strategy: strategies[i % strategies.length] }),
      );
      const got = wholeRun(z, n);
      expect(got.kind, `stream ${i}`).toBe("ok");
      expect(got.consumed, `stream ${i}`).toBe(z.length);
      expect(Buffer.from(got.out as Uint8Array).equals(Buffer.from(raw)), `stream ${i}`).toBe(true);
    }
  });
});

describe("inflateWhole on handcrafted dynamic blocks", () => {
  /** Bits written LSB first, as deflate packs them. */
  class BitWriter {
    bytes: number[] = [0x78, 0x01];
    acc = 0;
    n = 0;
    put(v: number, len: number) {
      for (let i = 0; i < len; i++) {
        this.acc |= ((v >> i) & 1) << this.n;
        if (++this.n === 8) {
          this.bytes.push(this.acc);
          this.acc = 0;
          this.n = 0;
        }
      }
    }
    /** A Huffman code: its bits from the first. */
    code(c: number, len: number) {
      for (let i = len - 1; i >= 0; i--) this.put((c >> i) & 1, 1);
    }
    end(raw: Uint8Array): Uint8Array {
      if (this.n) this.bytes.push(this.acc);
      let a = 1;
      let b = 0;
      for (const x of raw) {
        a = (a + x) % 65521;
        b = (b + a) % 65521;
      }
      const s = ((b << 16) | a) >>> 0;
      this.bytes.push(s >>> 24, (s >>> 16) & 255, (s >>> 8) & 255, s & 255);
      return new Uint8Array(this.bytes);
    }
  }
  /** Canonical codes for code lengths. */
  function canonical(lens: number[]): number[] {
    const count = new Array(16).fill(0);
    for (const l of lens) if (l) count[l]++;
    const next = new Array(16).fill(0);
    let code = 0;
    for (let l = 1; l < 16; l++) {
      code = (code + count[l - 1] * (l > 1 ? 1 : 0)) << 1;
      next[l] = code;
    }
    return lens.map((l) => (l ? next[l]++ : 0));
  }

  it("reads the extra bits of a 15-bit far distance code at every bit position", () => {
    // literals 9 bits, end of block and length 10 (symbol 264) 2 bits; distances 0..13 of 1..14
    // bits, 14 and 29 (24577 + 13 extra bits) of 15
    const litLens = new Array(265).fill(0);
    for (let s = 0; s < 256; s++) litLens[s] = 9;
    litLens[256] = 2;
    litLens[264] = 2;
    const distLens = new Array(30).fill(0);
    for (let s = 0; s < 14; s++) distLens[s] = s + 1;
    distLens[14] = 15;
    distLens[29] = 15;
    const litCodes = canonical(litLens);
    const distCodes = canonical(distLens);
    const w = new BitWriter();
    w.put(1, 1); // last block
    w.put(2, 2); // dynamic
    w.put(265 - 257, 5);
    w.put(30 - 1, 5);
    w.put(19 - 4, 4);
    // code length code: 0..15 of 4 bits each (complete), in the header's order
    const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
    for (const s of order) w.put(s < 16 ? 4 : 0, 3);
    for (const l of [...litLens, ...distLens]) w.code(l, 4); // symbol l has code l
    const r = rng(4283);
    const raw: number[] = [];
    while (raw.length < 25_000) {
      const b = Math.floor(r() * 256);
      raw.push(b);
      w.code(litCodes[b] as number, 9);
    }
    for (let m = 0; m < 400; m++) {
      for (let k = Math.floor(r() * 4); k > 0; k--) {
        const b = Math.floor(r() * 256);
        raw.push(b);
        w.code(litCodes[b] as number, 9);
      }
      const extra = Math.floor(r() * 8192);
      const dist = 24577 + extra;
      if (dist > raw.length) continue;
      w.code(litCodes[264] as number, 2);
      w.code(distCodes[29] as number, 15);
      w.put(extra, 13);
      for (let k = 0; k < 10; k++) raw.push(raw[raw.length - dist] as number);
    }
    w.code(litCodes[256] as number, 2);
    const want = new Uint8Array(raw);
    const z = w.end(want);
    expect(Buffer.from(inflateSync(z)).equals(Buffer.from(want))).toBe(true);
    const got = inflateWhole(z, { size: want.length });
    expect(got.consumed).toBe(z.length);
    expect(Buffer.from(got.data).equals(Buffer.from(want))).toBe(true);
  });
});

describe("inflateWhole differential fuzz: small objects back to back", () => {
  it("decodes runs of small streams as node zlib does, each into its own view of a shared slab", () => {
    // as a pack read does it: many small objects in a row (the dynamic tables and scratch
    // state of one call left behind for the next), each written into a slab view whose
    // neighbours must stay untouched
    const r = rng(0x5eed479);
    const slab = new Uint8Array(32 * 1024);
    let used = 0;
    for (let round = 0; round < 3000; round++) {
      const n = r() < 0.1 ? Math.floor(r() * 8) : Math.floor(r() * 2048);
      const raw = sample(r, n);
      // a git object header in front, as loose objects and pack entries hold
      const framed = new Uint8Array(Buffer.concat([Buffer.from(`blob ${n}\0`), raw]));
      const d = deflaters[Math.floor(r() * deflaters.length)] as (typeof deflaters)[number];
      const z = new Uint8Array(deflateSync(framed, d.opts));
      const want = inflateSync(z);
      if (used + framed.length + 16 > slab.length) {
        slab.fill(0);
        used = 0;
      }
      const at = used + 8;
      slab.fill(0xa5, used, at); // a guard before the view
      slab.fill(0x5a, at + framed.length, at + framed.length + 8); // and after it
      const into = slab.subarray(at, at + framed.length);
      // with the next object's bytes after the stream, as a pack window has them
      const input = new Uint8Array(z.length + 16);
      input.set(z);
      input.fill(0x78, z.length);
      const got = inflateWhole(input, { into });
      expect(got.length, `round ${round} (${d.name}, ${n} bytes)`).toBe(want.length);
      expect(got.consumed, `round ${round}`).toBe(z.length);
      expect(Buffer.from(into).equals(want), `round ${round} (${d.name})`).toBe(true);
      for (let k = used; k < at; k++) expect(slab[k]).toBe(0xa5);
      for (let k = at + framed.length; k < at + framed.length + 8; k++) expect(slab[k]).toBe(0x5a);
      used = at + framed.length + 8;
    }
  });
});
