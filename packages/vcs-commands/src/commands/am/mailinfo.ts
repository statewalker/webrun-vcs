/**
 * git's mail tools as `git am` runs them: `mailsplit` (an mbox, or mboxrd, cut into one
 * file per message) and `mailinfo` (a message's author, date and subject, its commit
 * message and its patch: RFC 2047 headers, charsets converted to UTF-8, quoted-printable
 * and base64 bodies, in-body `From:`/`Subject:`/`Date:` headers, scissors lines, the
 * `---` that starts the patch). Ports of builtin/mailsplit.c and mailinfo.c on binary
 * strings (one character per byte).
 */

import { bytesToLatin1, latin1ToBytes } from "../apply/latin1.js";

// git's isspace (sane_ctype): space, tab, LF, CR
const gitSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

/** `is_from_line` of mailsplit: an mbox "From " separator. */
function isFromLine(line: string): boolean {
  const len = line.length;
  if (len < 20 || !line.startsWith("From ")) return false;
  let colon = len - 2;
  const start = 5;
  for (;;) {
    if (colon < start) return false;
    if (line[--colon] === ":") break;
  }
  if (
    !isDigit(line[colon - 4]) ||
    !isDigit(line[colon - 2]) ||
    !isDigit(line[colon - 1]) ||
    !isDigit(line[colon + 1]) ||
    !isDigit(line[colon + 2])
  )
    return false;
  const year = Number.parseInt(line.slice(colon + 3), 10);
  if (!(year > 90)) return false;
  return true;
}

function linesOf(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl + 1;
    out.push(text.slice(at, end));
    at = end;
  }
  return out;
}

/**
 * `git mailsplit -b`: the messages of an mbox (binary string). Throws "corrupt mailbox"
 * where git exits; an empty mbox gives none.
 */
export function mailsplit(
  mbox: string,
  options: { keepCr?: boolean; mboxrd?: boolean } = {},
): string[] {
  let at = 0;
  while (at < mbox.length && gitSpace(mbox[at])) at++;
  const lines = linesOf(mbox.slice(at));
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let line = lines[i] as string;
    const bare = !isFromLine(line);
    let msg = "";
    for (;;) {
      if (!options.keepCr && line.length > 1 && line.endsWith("\r\n"))
        line = `${line.slice(0, -2)}\n`;
      if (options.mboxrd && /^>+From /.test(line)) line = line.slice(1);
      msg += line;
      i++;
      if (i >= lines.length) break;
      line = lines[i] as string;
      if (!bare && isFromLine(line)) break;
    }
    out.push(msg);
    if (bare) break;
  }
  return out;
}

/** What mailinfo found in a message. */
export interface MailInfo {
  /** The `info` file: `Author:`, `Email:`, `Subject:`, `Date:` lines and a blank line */
  info: string;
  /** The commit message (the body up to the patch) */
  msg: string;
  /** The patch */
  patch: string;
  /** Lines of the patch */
  patchLines: number;
  author: string;
  email: string;
  subject: string;
  date: string;
  /** Warnings and errors git prints */
  errors: string;
  formatFlowed: boolean;
  failed: boolean;
}

/** Options of {@link mailinfo}. */
export interface MailInfoOptions {
  /** `-k`: keep the subject as it is */
  keepSubject?: boolean;
  /** `-b`: keep brackets that do not hold "PATCH" */
  keepNonPatchBrackets?: boolean;
  /** `-m`: the Message-ID added to the message */
  addMessageId?: boolean;
  /** `--scissors` (true) / `--no-scissors` (false) */
  useScissors?: boolean;
  /** Convert to UTF-8 (`-u`, default); false keeps the bytes (`-n`) */
  utf8?: boolean;
  /**
   * The charset `-u` converts to (git's `metainfo_charset`: am's commit output encoding,
   * `i18n.commitEncoding`); UTF-8 by default
   */
  charset?: string;
  /** `--quoted-cr=<action>` (default warn) */
  quotedCr?: "nowarn" | "warn" | "strip";
}

const HEADERS = ["From", "Subject", "Date"] as const;

function cleanupSpace(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (gitSpace(s[i])) {
      out += " ";
      while (gitSpace(s[i + 1])) i++;
    } else out += s[i];
  }
  return out;
}

function trim(s: string): string {
  let a = 0;
  let z = s.length;
  while (a < z && gitSpace(s[a])) a++;
  while (z > a && gitSpace(s[z - 1])) z--;
  return s.slice(a, z);
}

function rtrim(s: string): string {
  let z = s.length;
  while (z > 0 && gitSpace(s[z - 1])) z--;
  return s.slice(0, z);
}

/** `skip_header`: the value after `<hdr>:` (case-insensitive), blanks skipped. */
function skipHeader(line: string, hdr: string): string | undefined {
  if (line.slice(0, hdr.length).toLowerCase() !== hdr.toLowerCase()) return undefined;
  let at = hdr.length;
  if (line[at++] !== ":") return undefined;
  while (gitSpace(line[at])) at++;
  return line.slice(at);
}

function hex2chr(s: string, at: number): number {
  const h = s.slice(at, at + 2);
  return /^[0-9a-fA-F]{2}$/.test(h) ? Number.parseInt(h, 16) : -1;
}

function decodeQ(seg: string, rfc2047: boolean): string {
  let out = "";
  for (let i = 0; i < seg.length; i++) {
    let c = seg[i] as string;
    if (c === "\0") break;
    if (c === "=") {
      const d = seg[i + 1];
      if (d === "\n" || d === undefined) break;
      const ch = hex2chr(seg, i + 1);
      if (ch >= 0) {
        out += String.fromCharCode(ch);
        i += 2;
        continue;
      }
    }
    if (rfc2047 && c === "_") c = " ";
    out += c;
  }
  return out;
}

function decodeB(seg: string): string {
  let out = "";
  let pos = 0;
  let acc = 0;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i] as string;
    let c: number;
    if (ch === "+") c = 62;
    else if (ch === "/") c = 63;
    else if (ch >= "A" && ch <= "Z") c = ch.charCodeAt(0) - 65;
    else if (ch >= "a" && ch <= "z") c = ch.charCodeAt(0) - 97 + 26;
    else if (ch >= "0" && ch <= "9") c = ch.charCodeAt(0) - 48 + 52;
    else continue;
    switch (pos++) {
      case 0:
        acc = c << 2;
        break;
      case 1:
        out += String.fromCharCode((acc | (c >> 4)) & 0xff);
        acc = (c & 15) << 4;
        break;
      case 2:
        out += String.fromCharCode((acc | (c >> 2)) & 0xff);
        acc = (c & 3) << 6;
        break;
      case 3:
        out += String.fromCharCode((acc | c) & 0xff);
        acc = pos = 0;
        break;
    }
  }
  return out;
}

function sameEncoding(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
  return norm(a) === norm(b);
}

/** `cleanup_subject`: "Re:", "[PATCH ...]" prefixes and blanks removed. */
function cleanupSubject(subject: string, keepNonPatch: boolean): string {
  let s = subject;
  let at = 0;
  while (at < s.length) {
    const c = s[at];
    if (c === "r" || c === "R") {
      if (s.length <= at + 3) break;
      if ((s[at + 1] === "e" || s[at + 1] === "E") && s[at + 2] === ":") {
        s = s.slice(0, at) + s.slice(at + 3);
        continue;
      }
      at++;
      break;
    }
    if (c === " " || c === "\t" || c === ":") {
      s = s.slice(0, at) + s.slice(at + 1);
      continue;
    }
    if (c === "[") {
      const pos = s.indexOf("]", at);
      if (pos < 0) break;
      const remove = pos - at + 1;
      if (!keepNonPatch || (remove >= 7 && s.slice(at, at + remove).includes("PATCH"))) {
        s = s.slice(0, at) + s.slice(at + remove);
      } else {
        at += remove;
        if (gitSpace(s[at])) at += 1;
      }
      continue;
    }
    break;
  }
  return trim(s);
}

function isScissorsLine(line: string): boolean {
  let scissors = 0;
  let gap = 0;
  let first = -1;
  let last = -1;
  let perforation = 0;
  let inPerforation = false;
  for (let c = 0; c < line.length; c++) {
    const ch = line[c] as string;
    if (gitSpace(ch)) {
      if (inPerforation) {
        perforation++;
        gap++;
      }
      continue;
    }
    last = c;
    if (first < 0) first = c;
    if (ch === "-") {
      inPerforation = true;
      perforation++;
      continue;
    }
    const two = line.slice(c, c + 2);
    if (two === ">8" || two === "8<" || two === ">%" || two === "%<") {
      inPerforation = true;
      perforation += 2;
      scissors += 2;
      c++;
      continue;
    }
    inPerforation = false;
  }
  const visible = first >= 0 && last >= 0 ? last - first + 1 : 0;
  return scissors > 0 && visible >= 8 && visible < perforation * 3 && gap * 2 < perforation;
}

function patchbreak(line: string): boolean {
  if (line.startsWith("diff -")) return true;
  if (line.startsWith("Index: ")) return true;
  if (line.length < 4) return false;
  if (line.startsWith("---")) {
    if (line[3] === " " && !gitSpace(line[4])) return true;
    for (let i = 3; i < line.length; i++) {
      const c = line[i];
      if (c === "\n") return true;
      if (!gitSpace(c)) break;
    }
  }
  return false;
}

function isRfc2822Header(line: string): boolean {
  if (line.startsWith("From ") || line.startsWith(">From ")) return true;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charCodeAt(i);
    if (ch === 0x3a) return true;
    if ((ch >= 33 && ch <= 57) || (ch >= 59 && ch <= 126)) continue;
    break;
  }
  return false;
}

function isFormatPatchSeparator(line: string): boolean {
  const SAMPLE = "From e6807f3efca28b30decfecb1732a56c7db1137ee Mon Sep 17 00:00:00 2001\n";
  if (line.length !== SAMPLE.length || !line.startsWith("From ")) return false;
  if (!/^[0-9a-f]{40}/.test(line.slice(5))) return false;
  return line.slice(45) === SAMPLE.slice(45);
}

const LATIN1 = new Set([
  "iso-8859-1",
  "iso8859-1",
  "iso_8859-1",
  "iso88591",
  "latin1",
  "latin-1",
  "l1",
  "cp819",
  "ibm819",
  "iso-ir-100",
  "csisolatin1",
]);
const ASCII = new Set([
  "us-ascii",
  "ascii",
  "us",
  "ansi_x3.4-1968",
  "iso646-us",
  "iso-ir-6",
  "cp367",
  "ibm367",
  "csascii",
  "646",
]);

const GB2312 = new Set([
  "gb2312",
  "euc-cn",
  "euccn",
  "csgb2312",
  "gb_2312-80",
  "iso-ir-58",
  "chinese",
]);
const SHIFT_JIS = new Set(["shift_jis", "shift-jis", "sjis", "ms_kanji", "csshiftjis", "x-sjis"]);
const BIG5 = new Set(["big5", "csbig5", "cn-big5", "x-x-big5", "big-5"]);

/**
 * Whether the bytes keep to the byte ranges of the strict charset glibc's iconv converts,
 * where TextDecoder's decoder for the label is a superset: GB2312 (EUC-CN; TextDecoder
 * decodes GBK), Shift_JIS (TextDecoder: windows-31j) and Big5 (TextDecoder: Big5-HKSCS).
 * Only the byte structure is checked: an unassigned code point inside the ranges still
 * decodes as TextDecoder decodes it.
 */
function strictMultibyte(name: string, bytes: Uint8Array): boolean {
  const inRange = (b: number | undefined, lo: number, hi: number) =>
    b !== undefined && b >= lo && b <= hi;
  if (GB2312.has(name)) {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] as number;
      if (b < 0x80) continue;
      if (!(inRange(b, 0xa1, 0xa9) || inRange(b, 0xb0, 0xf7))) return false;
      if (!inRange(bytes[++i], 0xa1, 0xfe)) return false;
    }
    return true;
  }
  if (SHIFT_JIS.has(name)) {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] as number;
      if (b < 0x80 || inRange(b, 0xa1, 0xdf)) continue;
      if (!(inRange(b, 0x81, 0x9f) || inRange(b, 0xe0, 0xef))) return false;
      const t = bytes[++i];
      if (!(inRange(t, 0x40, 0x7e) || inRange(t, 0x80, 0xfc))) return false;
    }
    return true;
  }
  if (BIG5.has(name)) {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] as number;
      if (b < 0x80) continue;
      if (!inRange(b, 0xa1, 0xf9)) return false;
      const t = bytes[++i];
      if (!(inRange(t, 0x40, 0x7e) || inRange(t, 0xa1, 0xfe))) return false;
    }
    return true;
  }
  return true;
}

/** A charset's bytes (binary string) decoded, as iconv reads them; undefined on failure. */
function decodeCharset(bytes: string, name: string): string | undefined {
  if (LATIN1.has(name)) return bytes;
  if (ASCII.has(name)) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the bytes above ASCII
    return /[^\x00-\x7f]/.test(bytes) ? undefined : bytes;
  }
  const raw = latin1ToBytes(bytes);
  if (!strictMultibyte(name, raw)) return undefined;
  try {
    const text = new TextDecoder(name, { fatal: true, ignoreBOM: true }).decode(raw);
    // windows-125x: TextDecoder maps the bytes these code pages leave undefined (0x81,
    // 0x8d, 0x8f, 0x90, 0x9d of windows-1252) to C1 controls, iconv refuses them
    if (/^(windows-|cp|x-cp)125\d$/.test(name) && /[\x80-\x9f]/.test(text)) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

/**
 * `reencode_string_len` (iconv) of a charset's bytes to the target charset (UTF-8 by
 * default): undefined when a charset is unknown, the bytes are not valid in the source or
 * do not fit the target. ISO-8859-1 is Latin-1 (TextDecoder's label would be
 * windows-1252) and US-ASCII refuses bytes above 0x7f, as iconv does. UTF-7 is not
 * supported (TextDecoder has no decoder for it): it fails as an unknown charset. Targets
 * are UTF-8, ISO-8859-1, US-ASCII and the single-byte charsets TextDecoder decodes; other
 * targets convert ASCII only.
 */
function reencode(bytes: string, charset: string, target = "UTF-8"): string | undefined {
  const text = decodeCharset(bytes, charset.toLowerCase());
  if (text === undefined) return undefined;
  const to = target.toLowerCase();
  if (/^utf-?8$/.test(to)) return bytesToLatin1(new TextEncoder().encode(text));
  const max = LATIN1.has(to) ? 0xff : ASCII.has(to) ? 0x7f : -1;
  if (max >= 0) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > max) return undefined;
    return text;
  }
  const table = singleByteTable(to);
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) as number;
    const byte = code < 0x80 ? code : table?.get(ch);
    // an ASCII-compatible multibyte target (EUC, Shift_JIS, ...): ASCII converts as itself
    if (byte === undefined) return undefined;
    out += String.fromCharCode(byte);
  }
  return out;
}

const singleByteTables = new Map<string, Map<string, number> | undefined>();

/**
 * The characters of a single-byte charset TextDecoder knows (KOI8-R, windows-125x,
 * ISO-8859-x) to their bytes, inverted from its decoder; undefined for other charsets.
 */
function singleByteTable(name: string): Map<string, number> | undefined {
  if (singleByteTables.has(name)) return singleByteTables.get(name);
  let table: Map<string, number> | undefined;
  try {
    const decoder = new TextDecoder(name);
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    if ([...decoder.decode(all)].length === 256 && !/^utf-?(16|32)/.test(name)) {
      table = new Map();
      for (let b = 0x80; b < 0x100; b++) {
        const ch = decoder.decode(Uint8Array.of(b));
        // a byte the code page leaves undefined (a C1 control of windows-125x) converts
        // no character
        if (
          ch === "\ufffd" ||
          (/^(windows-|cp|x-cp)125\d$/.test(name) && b < 0xa0 && ch.charCodeAt(0) === b)
        )
          continue;
        if (!table.has(ch)) table.set(ch, b);
      }
    }
  } catch {
    table = undefined;
  }
  singleByteTables.set(name, table);
  return table;
}

/** git's `mailinfo` of one message (binary string). */
export function mailinfo(message: string, options: MailInfoOptions = {}): MailInfo {
  const utf8 = options.utf8 ?? true;
  const pHdr: (string | undefined)[] = [undefined, undefined, undefined];
  let sHdr: (string | undefined)[] = [undefined, undefined, undefined];
  let errors = "";
  let inputError = false;
  let charset = "";
  let te: "qp" | "base64" | undefined;
  let formatFlowed = false;
  let delsp = false;
  const contentStack: string[] = [];
  let messageId: string | undefined;
  let logMessage = "";
  let patch = "";
  let patchLines = 0;
  let filterStage = 0;
  let headerStage = true;
  let inbodyAccum = "";
  let haveQuotedCr = false;
  const quotedCr = options.quotedCr ?? "warn";
  const useScissors = options.useScissors ?? false;

  // metainfo_charset: what the message is converted to
  const target = options.charset ?? "UTF-8";
  const convert = (s: string, cs: string): string | undefined => {
    if (!utf8 || !cs || sameEncoding(target, cs)) return s;
    const out = reencode(s, cs, target);
    if (out === undefined) {
      inputError = true;
      errors += `error: cannot convert from ${cs} to ${target}\n`;
    }
    return out;
  };

  const decodeHeader = (it: string): string => {
    let out = "";
    let at = 0;
    for (;;) {
      const ep0 = it.indexOf("=?", at);
      if (ep0 < 0) break;
      if (at !== ep0) {
        let scan = at;
        while (scan < ep0 && gitSpace(it[scan])) scan++;
        if (scan !== ep0 || at === 0) out += it.slice(at, ep0);
      }
      const ep = ep0 + 2;
      const cp = it.indexOf("?", ep);
      if (ep >= it.length || cp < 0 || cp + 3 > it.length) {
        inputError = true;
        return it;
      }
      const cs = it.slice(ep, cp);
      const encoding = it[cp + 1];
      if (!encoding || it[cp + 2] !== "?") {
        inputError = true;
        return it;
      }
      const end = it.indexOf("?=", cp + 3);
      if (end < 0) {
        inputError = true;
        return it;
      }
      const piece = it.slice(cp + 3, end);
      let dec: string;
      const e = encoding.toLowerCase();
      if (e === "b") dec = decodeB(piece);
      else if (e === "q") dec = decodeQ(piece, true);
      else {
        inputError = true;
        return it;
      }
      const converted = convert(dec, cs);
      if (converted === undefined) return it;
      out += converted;
      at = end + 2;
    }
    return out + it.slice(at);
  };

  const handleContentType = (line: string) => {
    const attr = (name: string): string | undefined => {
      const at = line.toLowerCase().indexOf(name);
      if (at < 0) return undefined;
      let ap = at + name.length;
      let ends = "; \t";
      if (line[ap] === '"') {
        ap++;
        ends = '"';
      }
      let z = ap;
      while (z < line.length && !ends.includes(line[z] as string)) z++;
      return line.slice(ap, z);
    };
    formatFlowed = attr("format=")?.toLowerCase() === "flowed";
    delsp = attr("delsp=")?.toLowerCase() === "yes";
    const boundary = attr("boundary=");
    if (boundary !== undefined) contentStack.push(`--${boundary}`);
    charset = attr("charset=") ?? "";
  };

  const checkHeader = (line: string, hdr: (string | undefined)[], overwrite: boolean): boolean => {
    for (let i = 0; i < HEADERS.length; i++) {
      if (hdr[i] === undefined || overwrite) {
        const v = skipHeader(line, HEADERS[i] as string);
        if (v !== undefined) {
          hdr[i] = decodeHeader(v);
          return true;
        }
      }
    }
    let v = skipHeader(line, "Content-Type");
    if (v !== undefined) {
      handleContentType(decodeHeader(v));
      return true;
    }
    v = skipHeader(line, "Content-Transfer-Encoding");
    if (v !== undefined) {
      const val = decodeHeader(v).toLowerCase();
      te = val.includes("base64") ? "base64" : val.includes("quoted-printable") ? "qp" : undefined;
      return true;
    }
    v = skipHeader(line, "Message-ID");
    if (v !== undefined) {
      if (options.addMessageId) messageId = decodeHeader(v);
      return true;
    }
    return false;
  };

  // input lines
  let pos = 0;
  while (pos < message.length && gitSpace(message[pos])) pos++;
  const input = message;
  const getline = (): string | undefined => {
    if (pos >= input.length) return undefined;
    const nl = input.indexOf("\n", pos);
    const end = nl < 0 ? input.length : nl + 1;
    const line = input.slice(pos, end);
    pos = end;
    return line;
  };
  const readHeaderLine = (): { header: boolean; line: string } | undefined => {
    const raw = getline();
    if (raw === undefined) return undefined;
    let line = rtrim(raw.endsWith("\n") ? raw.slice(0, -1) : raw);
    if (!line.length || !isRfc2822Header(line)) return { header: false, line: `${line}\n` };
    for (;;) {
      const peek = input[pos];
      if (peek !== " " && peek !== "\t") break;
      const cont = getline();
      if (cont === undefined) break;
      let c = cont.endsWith("\n") ? cont.slice(0, -1) : cont;
      c = rtrim(` ${c.slice(1)}`);
      line += c;
    }
    return { header: true, line };
  };

  if (pos >= message.length) {
    return {
      info: "",
      msg: "",
      patch: "",
      patchLines: 0,
      author: "",
      email: "",
      subject: "",
      date: "",
      errors: "error: empty patch\n",
      formatFlowed: false,
      failed: true,
    };
  }

  let line = "";
  for (;;) {
    const h = readHeaderLine();
    if (!h) {
      line = "";
      break;
    }
    if (!h.header) {
      line = h.line;
      break;
    }
    checkHeader(h.line, pHdr, true);
  }

  const flushInbody = () => {
    if (!inbodyAccum) return;
    checkHeader(inbodyAccum, sHdr, false);
    inbodyAccum = "";
  };
  const isInbodyHeader = (l: string) => {
    for (let i = 0; i < HEADERS.length; i++)
      if (sHdr[i] === undefined && skipHeader(l, HEADERS[i] as string) !== undefined) return true;
    return false;
  };
  const checkInbodyHeader = (l: string): boolean => {
    if (inbodyAccum && (l[0] === " " || l[0] === "\t")) {
      if (useScissors && isScissorsLine(l)) {
        flushInbody();
        return false;
      }
      if (inbodyAccum.endsWith("\n")) inbodyAccum = inbodyAccum.slice(0, -1);
      inbodyAccum += l;
      return true;
    }
    flushInbody();
    if (l.startsWith(">From") && gitSpace(l[5])) return isFormatPatchSeparator(l.slice(1));
    if (l.startsWith("[PATCH]") && gitSpace(l[7])) {
      sHdr[1] = l;
      return true;
    }
    if (isInbodyHeader(l)) {
      inbodyAccum += l;
      return true;
    }
    return false;
  };
  const handleCommitMsg = (l0: string): boolean => {
    let l = l0;
    if (headerStage) {
      if (!l.length || l === "\n") {
        if (inbodyAccum) {
          flushInbody();
          headerStage = false;
        }
        return false;
      }
    }
    if (headerStage) {
      headerStage = checkInbodyHeader(l);
      if (headerStage) return false;
    } else headerStage = false;
    const converted = convert(l, charset);
    if (converted === undefined) return false;
    l = converted;
    if (useScissors && isScissorsLine(l)) {
      logMessage = "";
      headerStage = true;
      sHdr = [undefined, undefined, undefined];
      return false;
    }
    if (patchbreak(l)) {
      if (messageId) logMessage += `Message-ID: ${messageId}\n`;
      return true;
    }
    logMessage += l;
    return false;
  };
  const handleFilter = (l: string) => {
    if (filterStage === 0) {
      if (!handleCommitMsg(l)) return;
      filterStage++;
    }
    patch += l;
    patchLines++;
  };
  let prev = "";
  const handleFilterFlowed = (l0: string) => {
    let l = l0;
    let len = l.length;
    if (!formatFlowed) {
      if (len >= 2 && l.endsWith("\r\n")) {
        haveQuotedCr = true;
        if (quotedCr === "strip") l = `${l.slice(0, -2)}\n`;
      }
      handleFilter(l);
      return;
    }
    if (l.endsWith("\n")) {
      len--;
      if (len && l[len - 1] === "\r") len--;
    }
    if (l.startsWith("-- ") && len === 3) {
      if (prev) {
        handleFilter(prev);
        prev = "";
      }
      handleFilter(l);
      return;
    }
    if (len && l[0] === " ") {
      l = l.slice(1);
      len--;
    }
    if (len && l[len - 1] === " ") {
      prev += l.slice(0, len - (delsp ? 1 : 0));
      return;
    }
    l = prev + l;
    prev = "";
    handleFilter(l);
  };
  const summarizeQuotedCr = () => {
    if (haveQuotedCr && quotedCr === "warn") errors += "warning: quoted CRLF detected\n";
  };
  const isBoundary = (l: string) => {
    const top = contentStack[contentStack.length - 1];
    return top !== undefined && l.startsWith(top);
  };
  const findBoundary = (): string | undefined => {
    for (;;) {
      const l = getline();
      if (l === undefined) return undefined;
      const s = l.endsWith("\n") ? l.slice(0, -1) : l;
      if (contentStack.length && isBoundary(s)) return s;
    }
  };
  const handleBoundary = (l0: string): string | undefined => {
    let l = l0;
    for (;;) {
      const top = contentStack[contentStack.length - 1] as string;
      if (l.length >= top.length + 2 && l.slice(top.length, top.length + 2) === "--") {
        // content_top steps back (content[0], no boundary, ends the multipart)
        contentStack.pop();
        handleFilter("\n");
        if (inputError) return undefined;
        const next = findBoundary();
        if (next === undefined) return undefined;
        l = next;
        continue;
      }
      break;
    }
    te = undefined;
    charset = "";
    for (;;) {
      const h = readHeaderLine();
      if (!h?.header) break;
      checkHeader(h.line, pHdr, false);
    }
    const next = getline();
    if (next === undefined) return undefined;
    return next.endsWith("\n") ? next : `${next}\n`;
  };

  // handle_body
  const handleBody = (): void => {
    let cur: string | undefined = line;
    if (contentStack.length) {
      cur = findBoundary();
      if (cur === undefined) return;
    }
    do {
      if (contentStack.length && isBoundary(cur.endsWith("\n") ? cur.slice(0, -1) : cur)) {
        if (prev) {
          handleFilter(prev);
          prev = "";
        }
        summarizeQuotedCr();
        haveQuotedCr = false;
        const next = handleBoundary(cur.endsWith("\n") ? cur.slice(0, -1) : cur);
        if (next === undefined) return;
        cur = next;
      }
      if (te === "qp") cur = decodeQ(cur, false);
      else if (te === "base64") cur = decodeB(cur);
      if (te) {
        const all = prev + cur;
        prev = "";
        const parts = linesOf(all);
        for (let k = 0; k < parts.length; k++) {
          const sb = parts[k] as string;
          if (k === parts.length - 1 && !sb.endsWith("\n")) {
            prev += sb;
            break;
          }
          handleFilterFlowed(sb);
        }
      } else handleFilterFlowed(cur);
      if (inputError) break;
      cur = getline();
    } while (cur !== undefined);
    if (prev) handleFilter(prev);
    summarizeQuotedCr();
    flushInbody();
  };
  handleBody();

  // handle_info
  let info = "";
  let author = "";
  let email = "";
  let subject = "";
  let date = "";
  for (let i = 0; i < HEADERS.length; i++) {
    let hdr: string | undefined;
    if (patchLines && sHdr[i] !== undefined) hdr = sHdr[i];
    else if (pHdr[i] !== undefined) hdr = pHdr[i];
    else continue;
    let h = hdr as string;
    if (h.includes("\0")) {
      errors += `error: a NUL byte in '${HEADERS[i]}' is not allowed.\n`;
      inputError = true;
    }
    if (HEADERS[i] === "Subject") {
      if (!options.keepSubject) {
        h = cleanupSubject(h, options.keepNonPatchBrackets ?? false);
        h = cleanupSpace(h);
      }
      subject = h;
      for (const part of h.split("\n")) info += `Subject: ${part}\n`;
    } else if (HEADERS[i] === "From") {
      h = cleanupSpace(h);
      const r = handleFrom(h, { name: author, email });
      author = r.name;
      email = r.email;
      info += `Author: ${author}\nEmail: ${email}\n`;
    } else {
      h = cleanupSpace(h);
      date = h;
      info += `${HEADERS[i]}: ${h}\n`;
    }
  }
  info += "\n";
  return {
    info,
    msg: logMessage,
    patch,
    patchLines,
    author,
    email,
    subject,
    date,
    errors,
    formatFlowed,
    failed: inputError,
  };
}

function getSaneName(name: string, email: string): string {
  if (!name.length || name.length > 60 || /[@<>]/.test(name)) return email;
  return name;
}

function unquoteQuotedPair(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i++] as string;
    if (c === '"') {
      let lit = false;
      while (i < line.length) {
        const d = line[i++] as string;
        if (lit) lit = false;
        else if (d === "\\") {
          lit = true;
          continue;
        } else if (d === '"') break;
        out += d;
      }
      continue;
    }
    if (c === "(") {
      out += "(";
      let lit = false;
      let depth = 1;
      while (i < line.length) {
        const d = line[i++] as string;
        if (lit) lit = false;
        else if (d === "\\") {
          lit = true;
          continue;
        } else if (d === "(") {
          out += "(";
          depth++;
          continue;
        } else if (d === ")") {
          out += ")";
          if (!--depth) break;
          continue;
        }
        out += d;
      }
      continue;
    }
    out += c;
  }
  return out;
}

/** `handle_from`: the author's name and email from a From: header. */
function handleFrom(
  from: string,
  current: { name: string; email: string },
): { name: string; email: string } {
  let f = unquoteQuotedPair(from);
  let at = f.indexOf("@");
  if (at < 0) {
    // parse_bogus_from
    if (current.email) return current;
    const bra = from.indexOf("<");
    if (bra < 0) return current;
    const ket = from.indexOf(">", bra);
    if (ket < 0) return current;
    const email = from.slice(bra + 1, ket);
    const name = trim(from.slice(0, bra));
    return { name: getSaneName(name, email), email };
  }
  if (current.email && f.indexOf("@", at + 1) >= 0) return current;
  while (at > 0) {
    const c = f[at - 1];
    if (gitSpace(c)) break;
    if (c === "<") {
      f = `${f.slice(0, at - 1)} ${f.slice(at)}`;
      break;
    }
    at--;
  }
  let el = 0;
  while (at + el < f.length && !" \n\t\r\v\f>".includes(f[at + el] as string)) el++;
  const email = f.slice(at, at + el);
  f = f.slice(0, at) + f.slice(at + el + (at + el < f.length ? 1 : 0));
  f = trim(cleanupSpace(f));
  if (f[0] === "(" && f.length && f[f.length - 1] === ")") f = f.slice(1, -1);
  return { name: getSaneName(f, email), email };
}
