/**
 * Git paths are bytes, not text: a tree or index entry may name a file `caf\xe9.txt`
 * (latin-1), which is no valid UTF-8. Paths are strings everywhere in this code, so the
 * bytes cross into strings and back through this reversible encoding (Python's
 * `surrogateescape`): valid UTF-8 decodes as usual, and each byte that is not part of a
 * valid UTF-8 sequence becomes the lone surrogate U+DC80..U+DCFF (U+DC00 + the byte).
 * Encoding turns those back into the bytes, so a name read from a tree or the index and
 * written again keeps its bytes (and the tree or index its id).
 *
 * @example
 * ```typescript
 * const name = decodeGitPath(new Uint8Array([0x63, 0x61, 0x66, 0xe9])); // "caf\udce9"
 * encodeGitPath(name); // Uint8Array [0x63, 0x61, 0x66, 0xe9]
 * decodeGitPath(new TextEncoder().encode("café")); // "café", as TextDecoder decodes it
 * ```
 *
 * A UTF-8 path never holds a lone surrogate, so it is the same string as before; only
 * paths that are not valid UTF-8 carry the escapes. They print as git prints them through
 * `encodeGitPath` (octal escapes with `core.quotePath`), and hosts whose file names are
 * bytes (Linux) get the original bytes back.
 *
 * @module
 */

const fatalDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const SURROGATE = /[\uD800-\uDFFF]/;

/** Whether `path` holds an escaped byte (or any lone surrogate): not plain UTF-8 text. */
export function hasEscapedBytes(path: string): boolean {
  return SURROGATE.test(path);
}

/** The length of the valid UTF-8 sequence at `i`, 0 when the byte there starts none. */
function sequenceLength(bytes: Uint8Array, i: number): number {
  const b0 = bytes[i];
  if (b0 < 0x80) return 1;
  const n = bytes.length;
  const cont = (k: number, lo = 0x80, hi = 0xbf) =>
    i + k < n && bytes[i + k] >= lo && bytes[i + k] <= hi;
  if (b0 >= 0xc2 && b0 <= 0xdf) return cont(1) ? 2 : 0;
  if (b0 === 0xe0) return cont(1, 0xa0) && cont(2) ? 3 : 0;
  if ((b0 >= 0xe1 && b0 <= 0xec) || b0 === 0xee || b0 === 0xef) {
    return cont(1) && cont(2) ? 3 : 0;
  }
  if (b0 === 0xed) return cont(1, 0x80, 0x9f) && cont(2) ? 3 : 0;
  if (b0 === 0xf0) return cont(1, 0x90) && cont(2) && cont(3) ? 4 : 0;
  if (b0 >= 0xf1 && b0 <= 0xf3) return cont(1) && cont(2) && cont(3) ? 4 : 0;
  if (b0 === 0xf4) return cont(1, 0x80, 0x8f) && cont(2) && cont(3) ? 4 : 0;
  return 0;
}

/**
 * A path's bytes as a string: UTF-8 decoded, each byte outside a valid UTF-8 sequence
 * escaped as U+DC00 + byte. A leading BOM is kept.
 */
export function decodeGitPath(bytes: Uint8Array): string {
  let ascii = true;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) {
    // short names (the common case) without a decoder
    if (bytes.length <= 64) return String.fromCharCode(...bytes);
    return fatalDecoder.decode(bytes);
  }
  try {
    return fatalDecoder.decode(bytes);
  } catch {
    // not valid UTF-8: decoded sequence by sequence below
  }
  let out = "";
  let start = 0;
  let i = 0;
  while (i < bytes.length) {
    const len = sequenceLength(bytes, i);
    if (len > 0) {
      i += len;
      continue;
    }
    if (i > start) out += fatalDecoder.decode(bytes.subarray(start, i));
    out += String.fromCharCode(0xdc00 + bytes[i]);
    i++;
    start = i;
  }
  if (i > start) out += fatalDecoder.decode(bytes.subarray(start, i));
  return out;
}

/**
 * A path's bytes: UTF-8, with each escaped byte (U+DC80..U+DCFF, as {@link decodeGitPath}
 * makes them) back as that byte. Any other lone surrogate becomes U+FFFD, as TextEncoder
 * encodes it.
 */
export function encodeGitPath(path: string): Uint8Array {
  if (!SURROGATE.test(path)) return encoder.encode(path);
  const out: number[] = [];
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < path.length) {
      const d = path.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f),
        );
        i++;
      } else out.push(0xef, 0xbf, 0xbd);
    } else if (c >= 0xdc80 && c <= 0xdcff) out.push(c - 0xdc00);
    else if (c >= 0xd800 && c <= 0xdfff) out.push(0xef, 0xbf, 0xbd);
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

/**
 * Two paths in the order of their bytes (git's `memcmp` order of names), as
 * {@link encodeGitPath} encodes them. Code units compare directly up to the first that
 * differs; only a surrogate there (an escaped byte or a character beyond U+FFFF) needs the
 * bytes.
 */
export function compareGitPaths(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    if ((x & 0xf800) !== 0xd800 && (y & 0xf800) !== 0xd800) return x - y;
    // a surrogate: the bytes of the rest decide (the prefix up to i is the same)
    const start = i > 0 && (a.charCodeAt(i - 1) & 0xfc00) === 0xd800 ? i - 1 : i;
    const ea = encodeGitPath(a.slice(start));
    const eb = encodeGitPath(b.slice(start));
    const m = Math.min(ea.length, eb.length);
    for (let k = 0; k < m; k++) if (ea[k] !== eb[k]) return ea[k] - eb[k];
    return ea.length - eb.length;
  }
  return a.length - b.length;
}

/**
 * A file of patterns or paths (`.gitignore`, `info/exclude`, `core.excludesFile`,
 * `.gitattributes`) as git reads it: bytes, so a pattern written in latin-1 matches the
 * same path bytes it matches in git. A leading UTF-8 BOM is skipped (git's
 * `skip_utf8_bom`); the rest decodes through {@link decodeGitPath}.
 *
 * @example
 * ```typescript
 * decodeGitPatternFile(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a])); // "caf\udce9\n"
 * ```
 */
export function decodeGitPatternFile(bytes: Uint8Array): string {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  return decodeGitPath(bom ? bytes.subarray(3) : bytes);
}

const C_ESCAPES: Record<number, number> = {
  97: 0x07, // a
  98: 0x08, // b
  102: 0x0c, // f
  110: 0x0a, // n
  114: 0x0d, // r
  116: 0x09, // t
  118: 0x0b, // v
  92: 0x5c, // \
  34: 0x22, // "
};

/**
 * git's `unquote_c_style`: the C-quoted path that starts with `"` at `start` of `bytes`, as
 * a string ({@link decodeGitPath}, so octal escapes of a name that is no UTF-8 stay its
 * bytes), and the offset after the closing quote. Undefined when no valid quoted string
 * starts there.
 *
 * @example
 * ```typescript
 * unquoteGitPath(new TextEncoder().encode('"caf\\351.txt" rest'), 0);
 * // { path: "caf\udce9.txt", end: 13 }
 * ```
 */
export function unquoteGitPath(
  bytes: Uint8Array,
  start = 0,
  end = bytes.length,
): { path: string; end: number } | undefined {
  if (bytes[start] !== 0x22) return undefined;
  const out: number[] = [];
  let i = start + 1;
  const isOctal = (k: number, hi: number) => k < end && bytes[k] >= 0x30 && bytes[k] <= hi;
  while (i < end) {
    const c = bytes[i];
    if (c === 0x22) return { path: decodeGitPath(new Uint8Array(out)), end: i + 1 };
    if (c !== 0x5c) {
      out.push(c);
      i++;
      continue;
    }
    i++;
    if (i >= end) return undefined;
    const e = bytes[i];
    const simple = C_ESCAPES[e];
    if (simple !== undefined) {
      out.push(simple);
      i++;
    } else if (isOctal(i, 0x33) && isOctal(i + 1, 0x37) && isOctal(i + 2, 0x37)) {
      out.push(((bytes[i] - 0x30) << 6) | ((bytes[i + 1] - 0x30) << 3) | (bytes[i + 2] - 0x30));
      i += 3;
    } else return undefined;
  }
  return undefined;
}
