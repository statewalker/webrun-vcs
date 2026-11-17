/**
 * Utility functions for hash operations
 */

/**
 * Convert hex string to Uint8Array
 *
 * Upper- and lowercase digits are accepted. Anything else (an odd number of
 * digits, a character that is not a hex digit) throws, so a malformed object id
 * or key is never silently turned into zero bytes.
 *
 * @param hex Hexadecimal string (e.g., "deadbeef")
 * @returns Uint8Array of bytes
 * @throws Error when `hex` has odd length or a non-hex character
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd length (${hex.length}): ${preview(hex)}`);
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const hi = hexDigit(hex.charCodeAt(i * 2));
    const lo = hexDigit(hex.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) {
      throw new Error(`hexToBytes: not hex at ${i * 2}: ${preview(hex)}`);
    }
    bytes[i] = (hi << 4) | lo;
  }
  return bytes;
}

function hexDigit(c: number): number {
  if (c >= 48 && c <= 57) return c - 48; // 0-9
  if (c >= 97 && c <= 102) return c - 87; // a-f
  if (c >= 65 && c <= 70) return c - 55; // A-F
  return -1;
}

function preview(s: string): string {
  return JSON.stringify(s.length > 80 ? `${s.slice(0, 80)}...` : s);
}

/** "00" to "ff", by byte value. */
const HEX_PAIRS: string[] = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, "0"));

/**
 * Convert Uint8Array to hex string
 *
 * @param bytes Uint8Array of bytes
 * @returns Hexadecimal string (lowercase)
 */
export function bytesToHex(bytes: Uint8Array): string {
  const n = bytes.length;
  if (n === 20) {
    // an object id: one flat string from its 40 char codes. Concatenating pairs builds a rope
    // of 20 pieces that is flattened again (copied) the first time the id is hashed or read.
    const codes = ID_CODES;
    for (let i = 0; i < 20; i++) {
      const b = bytes[i] as number;
      codes[2 * i] = HEX_CODES[b >> 4] as number;
      codes[2 * i + 1] = HEX_CODES[b & 15] as number;
    }
    return String.fromCharCode.apply(null, codes);
  }
  let out = "";
  for (let i = 0; i < n; i++) out += HEX_PAIRS[bytes[i]];
  return out;
}

/** The char codes of "0" to "f". */
const HEX_CODES = Uint8Array.from("0123456789abcdef", (c) => c.charCodeAt(0));
/** The char codes of the id `bytesToHex` is converting (it never awaits: one array serves all). */
const ID_CODES: number[] = new Array(40).fill(0);
