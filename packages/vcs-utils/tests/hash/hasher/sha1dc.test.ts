/**
 * sha1dc, git's SHA-1 collision detection: digests of ordinary data stay plain SHA-1 on the
 * JavaScript and WebAssembly paths (about one block in twenty meets some DV's conditions and is
 * recompressed without finding anything), and the colliding blocks of git's t0013 SHAttered PDF
 * are caught however they are fed. The native twins are vcs-commands' `sha1dc-native.test.ts`.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { dcBlocks } from "../../../src/hash/hasher/sha1dc-blocks.js";
import { ubcCheck } from "../../../src/hash/hasher/sha1dc-tables.js";
import {
  bytesToHex,
  createSha1,
  createSha1Unsafe,
  SHA1_OBJECT_FORMAT,
  Sha1,
  Sha1CollisionError,
  sha1Of,
  sha1Wasm,
} from "../../../src/hash/index.js";

/** The first 320 bytes of git's t/t0013/shattered-1.pdf: the prefix and the two colliding blocks. */
const SHATTERED_PREFIX = new Uint8Array(
  Buffer.from(
    "JVBERi0xLjMKJeLjz9MKCgoxIDAgb2JqCjw8L1dpZHRoIDIgMCBSL0hlaWdodCAzIDAgUi9UeXBlIDQgMCBSL1N1" +
      "YnR5cGUgNSAwIFIvRmlsdGVyIDYgMCBSL0NvbG9yU3BhY2UgNyAwIFIvTGVuZ3RoIDggMCBSL0JpdHNQZXJDb21w" +
      "b25lbnQgOD4+CnN0cmVhbQr/2P/+ACRTSEEtMSBpcyBkZWFkISEhISGFL+wJIzl1nDmxocY8TJfh//4Bc0bckWa2" +
      "fhGPApq2IbJWD/nKZ8yox/hbqEx5AwwrPeIY+G2zqQkB1d9FwU8m/t+z3DjpasIv571yjw5FvOBG0jxXD+sUE5i7" +
      "VS71oKgr4zH+pIA3uLXXHw4zLt+TrDUA603cDezBqGR5DHgsdiFWYN0wl5HQa9CvP5jNpLxGKbE=",
    "base64",
  ),
);
/** Its SHA-1, as git's death names it. */
const PREFIX_ID = "f92d74e3874587aaf443d1db961d4e26dde13e9c";

const native = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex");

/** Deterministic pseudo-random bytes. */
function random(len: number, seed: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = seed;
  for (let i = 0; i < len; i++) {
    x = (x + 0x6d2b79f5) | 0;
    let t = Math.imul(x ^ (x >>> 15), x | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = (t ^ (t >>> 14)) >>> 24;
  }
  return out;
}

function chunked(bytes: Uint8Array, step: number, hasher = createSha1()): string {
  for (let at = 0; at < bytes.length; at += step) hasher.update(bytes.subarray(at, at + step));
  return bytesToHex(hasher.digest());
}

/** The expanded words of the 64-byte block of `p` at `at`. */
function expanded(p: Uint8Array, at: number): Int32Array {
  const w = new Int32Array(80);
  const view = new DataView(p.buffer, p.byteOffset + at, 64);
  for (let i = 0; i < 16; i++) w[i] = view.getInt32(4 * i);
  for (let i = 16; i < 80; i++) {
    const x =
      (w[i - 3] as number) ^ (w[i - 8] as number) ^ (w[i - 14] as number) ^ (w[i - 16] as number);
    w[i] = (x << 1) | (x >>> 31);
  }
  return w;
}

describe("sha1dc", () => {
  it("has the WebAssembly block functions on Node", () => {
    expect(sha1Wasm()).toBeDefined();
  });

  it("random data: many blocks meet some DV's conditions, none is an attack", () => {
    const data = random(64 * 4000, 7);
    let flagged = 0;
    for (let at = 0; at < data.length; at += 64) if (ubcCheck(expanded(data, at)) !== 0) flagged++;
    // about 4.7% of random blocks: the recompression runs on each of them
    expect(flagged).toBeGreaterThan(100);
    const expected = native(data);
    expect(bytesToHex(createSha1().update(data).digest())).toBe(expected); // WebAssembly
    expect(chunked(data, 64)).toBe(expected); // JavaScript, block by block
    expect(chunked(data, 1)).toBe(expected);
    expect(bytesToHex(sha1Of(data.subarray(0, 9), data.subarray(9)))).toBe(expected);
  });

  it("matches Node's SHA-1 for lengths around the block and padding edges, both hashes", () => {
    const data = random(1100, 3);
    for (let n = 0; n <= 1100; n += n < 200 ? 1 : 37) {
      const bytes = data.subarray(0, n);
      for (const make of [createSha1, createSha1Unsafe]) {
        expect(chunked(bytes, Math.max(1, n), make())).toBe(native(bytes));
        expect(chunked(bytes, 7, make())).toBe(native(bytes));
      }
      expect(bytesToHex(sha1Of(bytes))).toBe(native(bytes));
    }
  });

  it("an input larger than the WebAssembly memory is hashed in runs", () => {
    const data = random((1 << 20) * 2 + 1000, 11);
    expect(bytesToHex(createSha1().update(data).digest())).toBe(native(data));
    expect(bytesToHex(sha1Of(data.subarray(0, 5), data.subarray(5)))).toBe(native(data));
  });

  it("the SHAttered blocks are an attack, with git's message", () => {
    expect(native(SHATTERED_PREFIX)).toBe(PREFIX_ID);
    let error: unknown;
    try {
      createSha1().update(SHATTERED_PREFIX).digest();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Sha1CollisionError);
    expect((error as Sha1CollisionError).id).toBe(PREFIX_ID);
    expect((error as Error).message).toBe(
      `SHA-1 appears to be part of a collision attack: ${PREFIX_ID}`,
    );
  });

  it("finds them on either path, however the bytes are split", () => {
    for (const step of [1, 5, 63, 64, 65, 128, 192, 320]) {
      expect(() => chunked(SHATTERED_PREFIX, step)).toThrow(PREFIX_ID);
    }
    expect(() => sha1Of(SHATTERED_PREFIX)).toThrow(Sha1CollisionError);
    expect(() => sha1Of(SHATTERED_PREFIX.subarray(0, 100), SHATTERED_PREFIX.subarray(100))).toThrow(
      Sha1CollisionError,
    );
    expect(() => SHA1_OBJECT_FORMAT.hashObject(new Uint8Array(0), SHATTERED_PREFIX)).toThrow(
      Sha1CollisionError,
    );
    // followed by more data, in the middle of a larger WebAssembly run
    const longer = new Uint8Array(SHATTERED_PREFIX.length + 70000);
    longer.set(SHATTERED_PREFIX);
    longer.set(random(70000, 5), SHATTERED_PREFIX.length);
    expect(() => createSha1().update(longer).digest()).toThrow(native(longer));
  });

  it("the JavaScript block function alone finds them", () => {
    const s = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
    expect(dcBlocks(s, SHATTERED_PREFIX, 0, 320)).toBe(true);
    const plain = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
    expect(dcBlocks(plain, random(64 * 500, 9), 0, 64 * 500)).toBe(false);
  });

  it("one changed byte in a colliding block is no attack", () => {
    const changed = SHATTERED_PREFIX.slice();
    changed[200] = (changed[200] as number) ^ 1;
    expect(chunked(changed, 320)).toBe(native(changed));
    expect(chunked(changed, 1)).toBe(native(changed));
  });

  it("a clone keeps what was found; the unsafe hash finds nothing", () => {
    const h = createSha1().update(SHATTERED_PREFIX);
    const copy = h.clone();
    expect(() => copy.digest()).toThrow(Sha1CollisionError);
    expect(() => h.digest()).toThrow(Sha1CollisionError);
    expect(bytesToHex(createSha1Unsafe().update(SHATTERED_PREFIX).digest())).toBe(PREFIX_ID);
    expect(bytesToHex(new Sha1(false).update(SHATTERED_PREFIX).digest())).toBe(PREFIX_ID);
    expect(
      bytesToHex(SHA1_OBJECT_FORMAT.createUnsafeHasher().update(SHATTERED_PREFIX).digest()),
    ).toBe(PREFIX_ID);
  });
});
