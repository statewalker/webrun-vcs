/**
 * MD5 (RFC 1321), which Web Crypto does not offer. Only for protocols that require it (HTTP
 * Digest authentication, RFC 7616's `algorithm=MD5`): never for object ids or integrity.
 *
 * @example
 * ```ts
 * md5Hex("abc"); // "900150983cd24fb0d6963f7d28e17f72"
 * md5(new Uint8Array([0x61])); // the 16 bytes of MD5("a")
 * ```
 */

/** Per-round left rotations (RFC 1321 3.4). */
const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** T[i] = floor(2^32 * |sin(i + 1)|) */
const T = (() => {
  const table = new Int32Array(64);
  for (let i = 0; i < 64; i++) table[i] = Math.floor(2 ** 32 * Math.abs(Math.sin(i + 1))) | 0;
  return table;
})();

/** The 16-byte MD5 digest of `data` (a string is hashed as its UTF-8 bytes). */
export function md5(data: Uint8Array | string): Uint8Array {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const length = bytes.length;
  // the message, a 0x80 byte, zeros up to 56 mod 64, then the bit length (little-endian)
  const padded = new Uint8Array((((length + 8) >>> 6) + 1) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = length * 8;
  view.setUint32(padded.length - 8, bits >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bits / 2 ** 32), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476;
  const m = new Int32Array(16);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let j = 0; j < 16; j++) m[j] = view.getInt32(offset + j * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const sum = (a + f + (T[i] as number) + (m[g] as number)) | 0;
      const s = SHIFTS[i] as number;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << s) | (sum >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, a0, true);
  outView.setInt32(4, b0, true);
  outView.setInt32(8, c0, true);
  outView.setInt32(12, d0, true);
  return out;
}

/** The MD5 digest of `data` as 32 lowercase hex digits. */
export function md5Hex(data: Uint8Array | string): string {
  let hex = "";
  for (const byte of md5(data)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
