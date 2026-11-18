/**
 * "Binary strings": bytes held one per character (latin1), so that `git apply` and the
 * mail tools can port git's byte-oriented C string handling while passing any encoding
 * through unchanged.
 */

import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";

const CHUNK = 0x8000;

/** The bytes as a binary string. */
export function bytesToLatin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return out;
}

/** The binary string's bytes. */
export function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

const utf8 = new TextDecoder("utf-8");
const utf8Encoder = new TextEncoder();

/** The binary string read as UTF-8 text (as a terminal shows git's output). */
export function latin1ToText(text: string): string {
  return utf8.decode(latin1ToBytes(text));
}

/** The UTF-8 bytes of `text` as a binary string. */
export function textToLatin1(text: string): string {
  return bytesToLatin1(utf8Encoder.encode(text));
}

/** A path held as a binary string, as the repository's path strings (`decodeGitPath`). */
export function latin1ToPath(name: string): string {
  return decodeGitPath(latin1ToBytes(name));
}

/** A repository path string as a binary string of its bytes. */
export function pathToLatin1(path: string): string {
  return bytesToLatin1(encodeGitPath(path));
}

/** quote.c's escape of one byte: a letter, 1 for octal, -1 for none. */
function cqLookup(ch: number): string | number {
  if (ch >= 0x80) return 0;
  switch (ch) {
    case 0x07:
      return "a";
    case 0x08:
      return "b";
    case 0x09:
      return "t";
    case 0x0a:
      return "n";
    case 0x0b:
      return "v";
    case 0x0c:
      return "f";
    case 0x0d:
      return "r";
    case 0x22:
      return '"';
    case 0x5c:
      return "\\";
    case 0x7f:
      return 1;
  }
  return ch < 0x20 ? 1 : -1;
}

function mustQuote(ch: number, fully: boolean): boolean {
  const v = cqLookup(ch);
  return typeof v === "string" || v + (fully ? 1 : 0) > 0;
}

/** Whether `quote_c_style` would quote the name. */
export function needsCQuote(name: string, fully = true): boolean {
  for (let i = 0; i < name.length; i++) if (mustQuote(name.charCodeAt(i), fully)) return true;
  return false;
}

/** The name's `quote_c_style` body (no surrounding quotes), escaping as needed. */
export function cQuoteBody(name: string, fully = true): string {
  let out = "";
  for (let i = 0; i < name.length; i++) {
    const b = name.charCodeAt(i);
    if (!mustQuote(b, fully)) {
      out += name[i];
      continue;
    }
    const v = cqLookup(b);
    out += typeof v === "string" ? `\\${v}` : `\\${(b >> 6) & 3}${(b >> 3) & 7}${b & 7}`;
  }
  return out;
}

/** `quote_c_style` of a binary-string name: quoted with C escapes when it needs to be. */
export function cQuote(name: string, fully = true): string {
  return needsCQuote(name, fully) ? `"${cQuoteBody(name, fully)}"` : name;
}

/**
 * `unquote_c_style`: the name quoted at `start` (which holds `"`), and the index one past
 * its closing quote; undefined when it is not a valid quoted name.
 */
export function cUnquote(text: string, start = 0): { name: string; end: number } | undefined {
  if (text[start] !== '"') return undefined;
  let out = "";
  let i = start + 1;
  for (;;) {
    if (i >= text.length) return undefined;
    const ch = text[i] as string;
    if (ch === '"') return { name: out, end: i + 1 };
    if (ch === "\0") return undefined;
    if (ch !== "\\") {
      out += ch;
      i++;
      continue;
    }
    i++;
    const e = text[i];
    switch (e) {
      case "a":
        out += "\x07";
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "v":
        out += "\v";
        break;
      case "\\":
      case '"':
        out += e;
        break;
      case "0":
      case "1":
      case "2":
      case "3": {
        const d1 = text.charCodeAt(i + 1) - 48;
        const d2 = text.charCodeAt(i + 2) - 48;
        if (d1 < 0 || d1 > 7 || d2 < 0 || d2 > 7) return undefined;
        out += String.fromCharCode(((e.charCodeAt(0) - 48) << 6) | (d1 << 3) | d2);
        i += 2;
        break;
      }
      default:
        return undefined;
    }
    i++;
  }
}
