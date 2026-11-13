import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  createBlake3,
  createSha1,
  createSha256,
  type Hasher,
} from "../../../src/hash/index.js";
import {
  computeObjectId,
  computeObjectIdFromStream,
  SizeMismatchError,
} from "../../../src/pack/index.js";

const enc = new TextEncoder();

/** Deterministic test input: 0, 1, …, 250, 0, 1, … */
function vectorInput(len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = i % 251;
  return out;
}

function feed(h: Hasher, bytes: Uint8Array, step: number): Uint8Array {
  for (let i = 0; i < bytes.length; i += step) h.update(bytes.subarray(i, i + step));
  return h.digest();
}

describe("createSha1", () => {
  it("matches FIPS 180 vectors", () => {
    expect(bytesToHex(createSha1().digest())).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    expect(bytesToHex(createSha1().update(enc.encode("abc")).digest())).toBe(
      "a9993e364706816aba3e25717850c26c9cd0d89d",
    );
  });

  it("gives the same digest however the input is split", () => {
    const data = vectorInput(10_000);
    const whole = bytesToHex(createSha1().update(data).digest());
    for (const step of [1, 63, 64, 65, 4096]) {
      expect(bytesToHex(feed(createSha1(), data, step))).toBe(whole);
    }
  });

  it("matches the FIPS 180 long-message vectors", () => {
    expect(
      bytesToHex(
        createSha1()
          .update(enc.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))
          .digest(),
      ),
    ).toBe("84983e441c3bd26ebaae4aa1f95129e5e54670f1");
    const h = createSha1();
    const block = new Uint8Array(1000).fill(0x61);
    for (let i = 0; i < 1000; i++) h.update(block);
    expect(bytesToHex(h.digest())).toBe("34aa973cd4c4daa4f61eeb2bdbad27316534016f");
  });

  it("is spent after digest: digest, update and clone then throw", () => {
    const h = createSha1().update(enc.encode("abc"));
    const kept = h.clone();
    h.digest();
    expect(() => h.digest()).toThrow(/already digested/);
    expect(() => h.update(enc.encode("x"))).toThrow(/already digested/);
    expect(() => h.clone()).toThrow(/already digested/);
    expect(bytesToHex(kept.digest())).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
  });

  it("clones an intermediate state without disturbing the original", () => {
    const h = createSha1().update(enc.encode("Hello"));
    const branch = h.clone().update(enc.encode(" Universe"));
    h.update(enc.encode(" World"));
    expect(bytesToHex(h.digest())).toBe(
      bytesToHex(createSha1().update(enc.encode("Hello World")).digest()),
    );
    expect(bytesToHex(branch.digest())).toBe(
      bytesToHex(createSha1().update(enc.encode("Hello Universe")).digest()),
    );
  });
});

describe("computeObjectId", () => {
  it("gives git's ids", async () => {
    expect(await computeObjectId("blob", new Uint8Array(0))).toBe(
      "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    );
    expect(await computeObjectId("blob", enc.encode("hello\n"))).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
    expect(await computeObjectId("tree", new Uint8Array(0))).toBe(
      "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    );
  });
});

describe("computeObjectId on large content", () => {
  it("gives the same id on the native path (64 KiB and up) as the stream", async () => {
    for (const len of [64 * 1024 - 1, 64 * 1024, 300_000]) {
      const content = vectorInput(len);
      expect(await computeObjectId("blob", content), `len ${len}`).toBe(
        await computeObjectIdFromStream("blob", len, [content]),
      );
    }
  });
});

describe("computeObjectIdFromStream", () => {
  async function* chunks(...parts: string[]) {
    for (const p of parts) yield enc.encode(p);
  }

  it("hashes a stream in one pass to the same id as the bytes", async () => {
    expect(await computeObjectIdFromStream("blob", 6, chunks("hel", "lo", "\n"))).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
    expect(await computeObjectIdFromStream("blob", 0, [])).toBe(
      "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    );
  });

  it("accepts a synchronous iterable", async () => {
    expect(await computeObjectIdFromStream("blob", 6, [enc.encode("hello\n")])).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
  });

  it("refuses a stream shorter than declared", async () => {
    const err = await computeObjectIdFromStream("blob", 7, chunks("hello\n")).catch((e) => e);
    expect(err).toBeInstanceOf(SizeMismatchError);
    expect(err).toMatchObject({ declared: 7, actual: 6 });
  });

  it("refuses a stream longer than declared as soon as it overruns", async () => {
    let pulled = 0;
    async function* endless() {
      for (;;) {
        pulled++;
        yield enc.encode("x");
      }
    }
    const err = await computeObjectIdFromStream("blob", 3, endless()).catch((e) => e);
    expect(err).toBeInstanceOf(SizeMismatchError);
    expect(err).toMatchObject({ declared: 3, actual: 4 });
    expect(pulled).toBe(4);
  });

  it("refuses a size that is not a non-negative safe integer", async () => {
    for (const size of [-1, 1.5, Number.NaN, 2 ** 53]) {
      await expect(computeObjectIdFromStream("blob", size, [])).rejects.toThrow(RangeError);
    }
  });
});
