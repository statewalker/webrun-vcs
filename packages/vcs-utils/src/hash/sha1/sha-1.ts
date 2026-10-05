/**
 * SHA-1 hash implementation in TypeScript.
 *
 * Based on js-sha1 library:
 * [js-sha1]{@link https://github.com/emn178/js-sha1}
 * Core changes:
 * - Added TypeScript types.
 * - Ensured finalize() is idempotent.
 * - Added support for cloning hash state to allow intermediate hashes.
 * - Improved error handling for finalized hashes.
 *
 * @version 0.6.0
 * @author Chen, Yi-Cyuan [emn178@gmail.com]
 * @copyright Chen, Yi-Cyuan 2014-2017
 * @license MIT
 */

/** A 20-byte SHA-1 hash result */
export type Sha1Hash = Uint8Array;

/** Input types accepted for hashing */
export type Sha1Input = Uint8Array | number[];

const EXTRA = [-2147483648, 8388608, 32768, 128];
const SHIFT = [24, 16, 8, 0];

/**
 * SHA-1 hash implementation.
 *
 * ```javascript
 *  const encoder = new TextEncoder();
 *  const token1 = encoder.encode("Hello");
 *  const token2 = encoder.encode(" ");
 *  const token3 = encoder.encode("World");
 *
 *  // Example 1: chained methods calls
 *  const sha1 = new Sha1()
 *   .update(token1)
 *   .update(token2)
 *   .update(token3)
 *   .finalize();
 *
 *  // Example 2: using newSha1 helper
 *  const sha1 = newSha1(token1, token2, token3);
 *
 *  // Example 3: intermediate hashes with clone
 *  const hash = new Sha1();
 *  hash.update(token1);
 *  const intermediate = hash.clone().finalize();
 *  hash.update(token2).update(token3);
 *  const final = hash.finalize();
 * ```
 */
export class Sha1 {
  private blocks: number[] = new Array(17).fill(0);
  private h0 = 0x67452301;
  private h1 = 0xefcdab89;
  private h2 = 0x98badcfe;
  private h3 = 0x10325476;
  private h4 = 0xc3d2e1f0;
  private block = 0;
  private start = 0;
  private bytes = 0;
  private hBytes = 0;
  private hashed = false;
  private lastByteIndex = 0;
  private _finalized = false;

  constructor(...messages: Sha1Input[]) {
    for (const message of messages) {
      this.update(message);
    }
  }

  get finalized(): boolean {
    return this._finalized;
  }

  private checkFinalized(): void {
    if (this._finalized) throw new Error("Hash was finalized");
  }

  update(data: Sha1Input, offset = 0, len: number = data.length - offset): this {
    this.checkFinalized();
    let index = offset;
    let i: number;
    const end = offset + len;

    while (index < end) {
      if (this.hashed) {
        this.hashed = false;
        this.blocks[0] = this.block;
        this.blocks.fill(0, 1, 17);
      }

      for (i = this.start; index < end && i < 64; ++index) {
        this.blocks[i >> 2] |= data[index] << SHIFT[i++ & 3];
      }

      this.lastByteIndex = i;
      this.bytes += i - this.start;
      if (i >= 64) {
        this.block = this.blocks[16];
        this.start = i - 64;
        this.hash();
        this.hashed = true;
      } else {
        this.start = i;
      }
    }
    if (this.bytes > 4294967295) {
      this.hBytes += (this.bytes / 4294967296) << 0;
      this.bytes = this.bytes % 4294967296;
    }
    return this;
  }

  finalize(): Sha1Hash {
    if (!this._finalized) {
      this._finalized = true;
      const i = this.lastByteIndex;
      this.blocks[16] = this.block;
      this.blocks[i >> 2] |= EXTRA[i & 3];
      this.block = this.blocks[16];
      if (i >= 56) {
        if (!this.hashed) {
          this.hash();
        }
        this.blocks[0] = this.block;
        this.blocks.fill(0, 1, 17);
      }
      this.blocks[14] = (this.hBytes << 3) | (this.bytes >>> 29);
      this.blocks[15] = this.bytes << 3;
      this.hash();
    }
    return new Uint8Array([
      (this.h0 >> 24) & 0xff,
      (this.h0 >> 16) & 0xff,
      (this.h0 >> 8) & 0xff,
      this.h0 & 0xff,
      (this.h1 >> 24) & 0xff,
      (this.h1 >> 16) & 0xff,
      (this.h1 >> 8) & 0xff,
      this.h1 & 0xff,
      (this.h2 >> 24) & 0xff,
      (this.h2 >> 16) & 0xff,
      (this.h2 >> 8) & 0xff,
      this.h2 & 0xff,
      (this.h3 >> 24) & 0xff,
      (this.h3 >> 16) & 0xff,
      (this.h3 >> 8) & 0xff,
      this.h3 & 0xff,
      (this.h4 >> 24) & 0xff,
      (this.h4 >> 16) & 0xff,
      (this.h4 >> 8) & 0xff,
      this.h4 & 0xff,
    ]);
  }

  clone(): Sha1 {
    const cloned = new Sha1();
    cloned.blocks = [...this.blocks];
    cloned.h0 = this.h0;
    cloned.h1 = this.h1;
    cloned.h2 = this.h2;
    cloned.h3 = this.h3;
    cloned.h4 = this.h4;
    cloned.block = this.block;
    cloned.start = this.start;
    cloned.bytes = this.bytes;
    cloned.hBytes = this.hBytes;
    cloned.hashed = this.hashed;
    cloned.lastByteIndex = this.lastByteIndex;
    cloned._finalized = this._finalized;
    return cloned;
  }

  private hash(): void {
    let a = this.h0,
      b = this.h1,
      c = this.h2,
      d = this.h3,
      e = this.h4;
    let f: number, j: number, t: number;

    for (j = 16; j < 80; ++j) {
      t = this.blocks[j - 3] ^ this.blocks[j - 8] ^ this.blocks[j - 14] ^ this.blocks[j - 16];
      this.blocks[j] = (t << 1) | (t >>> 31);
    }

    for (j = 0; j < 20; j += 5) {
      f = (b & c) | (~b & d);
      t = (a << 5) | (a >>> 27);
      e = (t + f + e + 1518500249 + this.blocks[j]) << 0;
      b = (b << 30) | (b >>> 2);

      f = (a & b) | (~a & c);
      t = (e << 5) | (e >>> 27);
      d = (t + f + d + 1518500249 + this.blocks[j + 1]) << 0;
      a = (a << 30) | (a >>> 2);

      f = (e & a) | (~e & b);
      t = (d << 5) | (d >>> 27);
      c = (t + f + c + 1518500249 + this.blocks[j + 2]) << 0;
      e = (e << 30) | (e >>> 2);

      f = (d & e) | (~d & a);
      t = (c << 5) | (c >>> 27);
      b = (t + f + b + 1518500249 + this.blocks[j + 3]) << 0;
      d = (d << 30) | (d >>> 2);

      f = (c & d) | (~c & e);
      t = (b << 5) | (b >>> 27);
      a = (t + f + a + 1518500249 + this.blocks[j + 4]) << 0;
      c = (c << 30) | (c >>> 2);
    }

    for (; j < 40; j += 5) {
      f = b ^ c ^ d;
      t = (a << 5) | (a >>> 27);
      e = (t + f + e + 1859775393 + this.blocks[j]) << 0;
      b = (b << 30) | (b >>> 2);

      f = a ^ b ^ c;
      t = (e << 5) | (e >>> 27);
      d = (t + f + d + 1859775393 + this.blocks[j + 1]) << 0;
      a = (a << 30) | (a >>> 2);

      f = e ^ a ^ b;
      t = (d << 5) | (d >>> 27);
      c = (t + f + c + 1859775393 + this.blocks[j + 2]) << 0;
      e = (e << 30) | (e >>> 2);

      f = d ^ e ^ a;
      t = (c << 5) | (c >>> 27);
      b = (t + f + b + 1859775393 + this.blocks[j + 3]) << 0;
      d = (d << 30) | (d >>> 2);

      f = c ^ d ^ e;
      t = (b << 5) | (b >>> 27);
      a = (t + f + a + 1859775393 + this.blocks[j + 4]) << 0;
      c = (c << 30) | (c >>> 2);
    }

    for (; j < 60; j += 5) {
      f = (b & c) | (b & d) | (c & d);
      t = (a << 5) | (a >>> 27);
      e = (t + f + e - 1894007588 + this.blocks[j]) << 0;
      b = (b << 30) | (b >>> 2);

      f = (a & b) | (a & c) | (b & c);
      t = (e << 5) | (e >>> 27);
      d = (t + f + d - 1894007588 + this.blocks[j + 1]) << 0;
      a = (a << 30) | (a >>> 2);

      f = (e & a) | (e & b) | (a & b);
      t = (d << 5) | (d >>> 27);
      c = (t + f + c - 1894007588 + this.blocks[j + 2]) << 0;
      e = (e << 30) | (e >>> 2);

      f = (d & e) | (d & a) | (e & a);
      t = (c << 5) | (c >>> 27);
      b = (t + f + b - 1894007588 + this.blocks[j + 3]) << 0;
      d = (d << 30) | (d >>> 2);

      f = (c & d) | (c & e) | (d & e);
      t = (b << 5) | (b >>> 27);
      a = (t + f + a - 1894007588 + this.blocks[j + 4]) << 0;
      c = (c << 30) | (c >>> 2);
    }

    for (; j < 80; j += 5) {
      f = b ^ c ^ d;
      t = (a << 5) | (a >>> 27);
      e = (t + f + e - 899497514 + this.blocks[j]) << 0;
      b = (b << 30) | (b >>> 2);

      f = a ^ b ^ c;
      t = (e << 5) | (e >>> 27);
      d = (t + f + d - 899497514 + this.blocks[j + 1]) << 0;
      a = (a << 30) | (a >>> 2);

      f = e ^ a ^ b;
      t = (d << 5) | (d >>> 27);
      c = (t + f + c - 899497514 + this.blocks[j + 2]) << 0;
      e = (e << 30) | (e >>> 2);

      f = d ^ e ^ a;
      t = (c << 5) | (c >>> 27);
      b = (t + f + b - 899497514 + this.blocks[j + 3]) << 0;
      d = (d << 30) | (d >>> 2);

      f = c ^ d ^ e;
      t = (b << 5) | (b >>> 27);
      a = (t + f + a - 899497514 + this.blocks[j + 4]) << 0;
      c = (c << 30) | (c >>> 2);
    }

    this.h0 = (this.h0 + a) << 0;
    this.h1 = (this.h1 + b) << 0;
    this.h2 = (this.h2 + c) << 0;
    this.h3 = (this.h3 + d) << 0;
    this.h4 = (this.h4 + e) << 0;
  }
}

/**
 * Convenience function to create SHA-1 hashes.
 * If called with arguments, returns the hash directly.
 * If called without arguments, returns a new Sha1 instance.
 */
export function newSha1(message: Sha1Input, ...messages: Sha1Input[]): Sha1Hash;
export function newSha1(): Sha1;
export function newSha1(...messages: Sha1Input[]): Sha1Hash | Sha1 {
  const sha1 = new Sha1();
  if (messages.length) {
    for (const message of messages) {
      sha1.update(message);
    }
    return sha1.finalize();
  }
  return sha1;
}
