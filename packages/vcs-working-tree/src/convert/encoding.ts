/**
 * The `working-tree-encoding` attribute, for the Unicode encodings Web APIs can express:
 * UTF-16 and UTF-32 in every byte order, with and without a BOM. Content is kept as UTF-8
 * in the repository, as git keeps it, and re-encoded on checkout.
 *
 * As git on glibc: `UTF-16` / `UTF-32` are written little-endian with a BOM and must carry
 * one when read; the `LE` / `BE` spellings carry none (a BOM is refused); `UTF-16LE-BOM` /
 * `UTF-16BE-BOM` write one. Other encodings (Shift-JIS, Latin-1, ...) would need a converter
 * Web APIs do not offer in both directions: they fail as an encoding iconv cannot open fails
 * in git ("failed to encode ...").
 */

/** git's `same_utf_encoding`: `UTF-16le` and `utf16LE` name the same encoding. */
export function sameUtfEncoding(a: string, b: string): boolean {
  const strip = (s: string) => {
    if (!/^utf/i.test(s)) return undefined;
    let rest = s.slice(3);
    if (rest.startsWith("-")) rest = rest.slice(1);
    return rest.toLowerCase();
  };
  const x = strip(a);
  const y = strip(b);
  return x !== undefined && y !== undefined && x === y;
}

/** git's `same_encoding`. */
export function sameEncoding(a: string, b: string): boolean {
  return sameUtfEncoding(a, b) || a.toLowerCase() === b.toLowerCase();
}

type Unit = 2 | 4;
interface Codec {
  unit: Unit;
  /** Byte order written (and assumed when no BOM is read) */
  littleEndian: boolean;
  /** A BOM is written */
  writeBom: boolean;
  /** A BOM decides the byte order when read (and is dropped) */
  readBom: boolean;
}

/** The codec of an encoding name, or undefined when it is not one handled here. */
function codecOf(encoding: string): Codec | undefined {
  const is = (name: string) => sameUtfEncoding(encoding, name);
  if (is("UTF-16")) return { unit: 2, littleEndian: true, writeBom: true, readBom: true };
  if (is("UTF-16LE")) return { unit: 2, littleEndian: true, writeBom: false, readBom: false };
  if (is("UTF-16BE")) return { unit: 2, littleEndian: false, writeBom: false, readBom: false };
  if (is("UTF-16LE-BOM")) return { unit: 2, littleEndian: true, writeBom: true, readBom: true };
  if (is("UTF-16BE-BOM")) return { unit: 2, littleEndian: false, writeBom: true, readBom: true };
  if (is("UTF-32")) return { unit: 4, littleEndian: true, writeBom: true, readBom: true };
  if (is("UTF-32LE")) return { unit: 4, littleEndian: true, writeBom: false, readBom: false };
  if (is("UTF-32BE")) return { unit: 4, littleEndian: false, writeBom: false, readBom: false };
  return undefined;
}

/** Whether `encoding` can be converted here (otherwise conversions fail as in git). */
export function isSupportedEncoding(encoding: string): boolean {
  return codecOf(encoding) !== undefined || sameUtfEncoding(encoding, "UTF-8");
}

const startsWith = (data: Uint8Array, prefix: number[]) =>
  data.length >= prefix.length && prefix.every((b, i) => data[i] === b);
const UTF16_BE_BOM = [0xfe, 0xff];
const UTF16_LE_BOM = [0xff, 0xfe];
const UTF32_BE_BOM = [0, 0, 0xfe, 0xff];
const UTF32_LE_BOM = [0xff, 0xfe, 0, 0];

/** git's `validate_encoding`: the error for a BOM that is refused or missing, if any. */
export function validateEncoding(
  path: string,
  encoding: string,
  data: Uint8Array,
): { error: string; advice: string } | undefined {
  if (!/^utf/i.test(encoding)) return undefined;
  let stripped = encoding.slice(3);
  if (stripped.startsWith("-")) stripped = stripped.slice(1);
  const is = (name: string) => sameUtfEncoding(encoding, name);
  const prohibited =
    ((is("UTF-16BE") || is("UTF-16LE")) &&
      (startsWith(data, UTF16_BE_BOM) || startsWith(data, UTF16_LE_BOM))) ||
    ((is("UTF-32BE") || is("UTF-32LE")) &&
      (startsWith(data, UTF32_BE_BOM) || startsWith(data, UTF32_LE_BOM)));
  if (prohibited) {
    const base = stripped.slice(0, stripped.length - 2);
    return {
      error: `BOM is prohibited in '${path}' if encoded as ${encoding}`,
      advice: `The file '${path}' contains a byte order mark (BOM). Please use UTF-${base} as working-tree-encoding.`,
    };
  }
  const missing =
    (is("UTF-16") && !(startsWith(data, UTF16_BE_BOM) || startsWith(data, UTF16_LE_BOM))) ||
    (is("UTF-32") && !(startsWith(data, UTF32_BE_BOM) || startsWith(data, UTF32_LE_BOM)));
  if (missing) {
    return {
      error: `BOM is required in '${path}' if encoded as ${encoding}`,
      advice: `The file '${path}' is missing a byte order mark (BOM). Please use UTF-${stripped}BE or UTF-${stripped}LE (depending on the byte order) as working-tree-encoding.`,
    };
  }
  return undefined;
}

/** Thrown for content the encoding cannot represent (iconv's EILSEQ / EINVAL). */
class EncodingError extends Error {}

/** Decodes `data` in `encoding` to a string; undefined for an unsupported encoding. */
function decode(data: Uint8Array, encoding: string): string | undefined {
  if (sameUtfEncoding(encoding, "UTF-8")) {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
  }
  const codec = codecOf(encoding);
  if (!codec) return undefined;
  let little = codec.littleEndian;
  let body = data;
  if (codec.readBom) {
    if (codec.unit === 2 && startsWith(data, UTF16_LE_BOM)) {
      little = true;
      body = data.subarray(2);
    } else if (codec.unit === 2 && startsWith(data, UTF16_BE_BOM)) {
      little = false;
      body = data.subarray(2);
    } else if (codec.unit === 4 && startsWith(data, UTF32_LE_BOM)) {
      little = true;
      body = data.subarray(4);
    } else if (codec.unit === 4 && startsWith(data, UTF32_BE_BOM)) {
      little = false;
      body = data.subarray(4);
    }
  }
  if (body.length % codec.unit !== 0) throw new EncodingError("incomplete character");
  if (codec.unit === 2) {
    return new TextDecoder(little ? "utf-16le" : "utf-16be", {
      fatal: true,
      ignoreBOM: true,
    }).decode(body);
  }
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  let out = "";
  for (let i = 0; i < body.length; i += 4) {
    const cp = view.getUint32(i, little);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new EncodingError("invalid");
    out += String.fromCodePoint(cp);
  }
  return out;
}

/** Encodes `text` in `encoding`; undefined for an unsupported encoding. */
function encode(text: string, encoding: string): Uint8Array | undefined {
  if (sameUtfEncoding(encoding, "UTF-8")) return new TextEncoder().encode(text);
  const codec = codecOf(encoding);
  if (!codec) return undefined;
  const codePoints: number[] = [];
  for (const ch of text) codePoints.push(ch.codePointAt(0) ?? 0);
  const units: number[] = [];
  if (codec.unit === 2) {
    for (const cp of codePoints) {
      if (cp >= 0x10000) {
        const v = cp - 0x10000;
        units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      } else units.push(cp);
    }
  } else units.push(...codePoints);
  const bom = codec.writeBom ? 1 : 0;
  const out = new Uint8Array((units.length + bom) * codec.unit);
  const view = new DataView(out.buffer);
  let at = 0;
  const put = (u: number) => {
    if (codec.unit === 2) view.setUint16(at, u, codec.littleEndian);
    else view.setUint32(at, u, codec.littleEndian);
    at += codec.unit;
  };
  if (bom) put(0xfeff);
  for (const u of units) put(u);
  return out;
}

/**
 * Re-encodes `data` from `from` to `to` (git's `reencode_string_len`); undefined when the
 * content is not valid in `from` or an encoding is not supported (iconv failing).
 */
export function reencode(data: Uint8Array, to: string, from: string): Uint8Array | undefined {
  try {
    const text = decode(data, from);
    if (text === undefined) return undefined;
    return encode(text, to);
  } catch {
    return undefined;
  }
}
