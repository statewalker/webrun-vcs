import { readFileSync } from "node:fs";
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

interface VectorCase {
  input_len: number;
  hash: string;
  keyed_hash: string;
  derive_key: string;
}
const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/blake3-test-vectors.json", import.meta.url), "utf8"),
) as { key: string; context_string: string; cases: VectorCase[] };

/** The official vectors' input: 0, 1, …, 250, 0, 1, … */
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

describe("createSha256", () => {
  it("matches FIPS 180 vectors", () => {
    expect(bytesToHex(createSha256().update(enc.encode("abc")).digest())).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("createBlake3", () => {
  const key = enc.encode(vectors.key);
  const context = enc.encode(vectors.context_string);

  it("matches every official vector in hash, keyed and derive-key modes", () => {
    for (const c of vectors.cases) {
      const input = vectorInput(c.input_len);
      expect(bytesToHex(createBlake3().update(input).digest()), `hash ${c.input_len}`).toBe(
        c.hash.slice(0, 64),
      );
      expect(bytesToHex(createBlake3({ key }).update(input).digest()), `keyed ${c.input_len}`).toBe(
        c.keyed_hash.slice(0, 64),
      );
      expect(
        bytesToHex(createBlake3({ context }).update(input).digest()),
        `derive ${c.input_len}`,
      ).toBe(c.derive_key.slice(0, 64));
    }
  });

  it("produces extended output with dkLen", () => {
    const c = vectors.cases[3];
    const out = createBlake3({ dkLen: c.hash.length / 2 })
      .update(vectorInput(c.input_len))
      .digest();
    expect(bytesToHex(out)).toBe(c.hash);
  });

  it("refuses a key that is not 32 bytes", () => {
    expect(() => createBlake3({ key: new Uint8Array(31) })).toThrow();
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
    expect(err).toMatchObject({ declared: 3 });
    expect(pulled).toBe(4);
  });

  it("refuses a size that is not a non-negative safe integer", async () => {
    for (const size of [-1, 1.5, Number.NaN, 2 ** 53]) {
      await expect(computeObjectIdFromStream("blob", size, [])).rejects.toThrow(RangeError);
    }
  });
});
