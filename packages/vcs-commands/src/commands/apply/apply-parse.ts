/**
 * The patch reader of `git apply` (apply.c): finds each file's header (git diffs with their
 * extended headers, or traditional `---`/`+++` pairs), its hunks and binary hunks, and
 * records whitespace errors on the lines it adds. A port of git's parser: what it accepts,
 * guesses and complains about (with git's messages) follows apply.c line by line.
 */

import { createInflater } from "@statewalker/vcs-utils";

import {
  BINARY_DELTA,
  BINARY_LITERAL,
  canonMode,
  type FilePatch,
  isLink,
  type PatchFragment,
  type WsErrorAction,
} from "./apply-types.js";
import { bytesToLatin1, cQuote, cUnquote, latin1ToBytes } from "./latin1.js";
import {
  isGitSpace,
  WS_CR_AT_EOL,
  WS_INCOMPLETE_LINE,
  whitespaceErrorString,
  wsCheck,
} from "./whitespace.js";

const TERM_SPACE = 1;
const TERM_TAB = 2;

/** Verbosity: -1 quiet, 0 normal, 1 verbose. */
export type ApplyVerbosity = -1 | 0 | 1;

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isSpaceCh = (c: string | undefined) => c !== undefined && isGitSpace(c.charCodeAt(0));

/** `linelen`: bytes up to and including the next LF, at most `size`. */
export function linelen(buf: string, at: number, size: number): number {
  if (size <= 0) return 0;
  const nl = buf.indexOf("\n", at);
  if (nl < 0 || nl - at + 1 > size) return Math.min(size, buf.length - at);
  return nl - at + 1;
}

function isDevNull(buf: string, at: number): boolean {
  return buf.startsWith("/dev/null", at) && isSpaceCh(buf[at + 9]);
}

function squashSlash(name: string | null): string | null {
  if (name === null) return null;
  return name.replace(/\/\/+/g, "/");
}

/** strtoul in base `radix` from `at`: the value and where it stopped. */
function strtoul(buf: string, at: number, radix: number): { value: number; end: number } {
  let i = at;
  while (buf[i] === " " || buf[i] === "\t") i++;
  if (buf[i] === "+") i++;
  let value = 0;
  const start = i;
  for (;;) {
    const c = buf[i];
    if (c === undefined) break;
    const d = Number.parseInt(c, radix);
    if (Number.isNaN(d) || (radix === 10 && !isDigit(c))) break;
    value = value * radix + d;
    i++;
  }
  return i === start ? { value: 0, end: at } : { value, end: i };
}

function sizeOfTz(line: string, len: number): number {
  const n = 6; // " +0500"
  if (len < n || line[len - n] !== " ") return 0;
  const tz = len - n;
  if (line[tz + 1] !== "+" && line[tz + 1] !== "-") return 0;
  for (let p = tz + 2; p !== len; p++) if (!isDigit(line[p])) return 0;
  return len - tz;
}

function tzWithColonLen(line: string, len: number): number {
  if (len < 7 || line[len - 3] !== ":") return 0;
  const tz = len - 7;
  if (line[tz] !== " " || (line[tz + 1] !== "+" && line[tz + 1] !== "-")) return 0;
  let p = tz + 2;
  if (
    !isDigit(line[p++]) ||
    !isDigit(line[p++]) ||
    line[p++] !== ":" ||
    !isDigit(line[p++]) ||
    !isDigit(line[p++])
  )
    return 0;
  return len - tz;
}

function dateLen(line: string, len: number): number {
  if (len < 8 || line[len - 3] !== "-") return 0;
  let date = len - 8;
  let p = date;
  if (
    !isDigit(line[p++]) ||
    !isDigit(line[p++]) ||
    line[p++] !== "-" ||
    !isDigit(line[p++]) ||
    !isDigit(line[p++]) ||
    line[p++] !== "-" ||
    !isDigit(line[p++]) ||
    !isDigit(line[p++])
  )
    return 0;
  if (date >= 2 && isDigit(line[date - 1]) && isDigit(line[date - 2])) date -= 2;
  return len - date;
}

function shortTimeLen(line: string, len: number): number {
  if (len < 9 || line[len - 3] !== ":") return 0;
  const time = len - 9;
  let p = time;
  if (
    line[p++] !== " " ||
    !isDigit(line[p++]) ||
    !isDigit(line[p++]) ||
    line[p++] !== ":" ||
    !isDigit(line[p++]) ||
    !isDigit(line[p++]) ||
    line[p++] !== ":" ||
    !isDigit(line[p++]) ||
    !isDigit(line[p++])
  )
    return 0;
  return len - time;
}

function fractionalTimeLen(line: string, len: number): number {
  if (!len || !isDigit(line[len - 1])) return 0;
  let p = len - 1;
  while (p > 0 && isDigit(line[p])) p--;
  if (line[p] !== ".") return 0;
  const n = shortTimeLen(line, p);
  if (!n) return 0;
  return len - p + n;
}

function trailingSpacesLen(line: string, len: number): number {
  if (!len || line[len - 1] !== " ") return 0;
  let p = len;
  while (p !== 0) {
    p--;
    if (line[p] !== " ") return len - (p + 1);
  }
  return len;
}

/** `diff_timestamp_len`: the length of a diff's date after a name, 0 when there is none. */
function diffTimestampLen(line: string, len: number): number {
  let end = len;
  if (!isDigit(line[end - 1])) return 0;
  let n = sizeOfTz(line, end);
  if (!n) n = tzWithColonLen(line, end);
  end -= n;
  n = shortTimeLen(line, end);
  if (!n) n = fractionalTimeLen(line, end);
  end -= n;
  n = dateLen(line, end);
  if (!n) return 0;
  end -= n;
  if (end === 0) return 0;
  if (line[end - 1] === "\t") {
    end--;
    return len - end;
  }
  if (line[end - 1] !== " ") return 0;
  end -= trailingSpacesLen(line, end);
  return len - end;
}

function hasEpochTimestamp(buf: string, at: number): boolean {
  let timestamp = -1;
  let cp = at;
  for (; buf[cp] !== "\n" && cp < buf.length; cp++) if (buf[cp] === "\t") timestamp = cp + 1;
  if (timestamp < 0) return false;
  let epochHour: number;
  let rest = buf.slice(timestamp, buf.indexOf("\n", timestamp) + 1 || undefined);
  if (rest.startsWith("1969-12-31 ")) epochHour = 24;
  else if (rest.startsWith("1970-01-01 ")) epochHour = 0;
  else return false;
  rest = rest.slice(11);
  const m = /^([0-2][0-9]):([0-5][0-9]):00(\.0+)? ([-+])([0-2][0-9]):?([0-5][0-9])\n/.exec(rest);
  if (!m) return false;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  let zone = Number(m[5]) * 60 + Number(m[6]);
  if (m[4] === "-") zone = -zone;
  return hour * 60 + minute - zone === epochHour * 60;
}

function skipTreePrefix(pValue: number, line: string, at: number, llen: number): number {
  if (!pValue) return llen && line[at] === "/" ? -1 : at;
  let nslash = pValue;
  for (let i = 0; i < llen; i++) {
    if (line[at + i] === "/" && --nslash <= 0) return i === 0 ? -1 : at + i + 1;
  }
  return -1;
}

/** `git_header_name`: the name the `diff --git` line names twice, when it does. */
function gitHeaderName(pValue: number, buf: string, lineAt: number, llen0: number): string | null {
  const line = lineAt + 11;
  const llen = llen0 - 11;
  const lineEnd = line + llen;
  if (buf[line] === '"') {
    const first = cUnquote(buf, line);
    if (!first) return null;
    let cp = skipTreePrefix(pValue, first.name, 0, first.name.length);
    if (cp < 0) return null;
    const firstName = first.name.slice(cp);
    let second = first.end;
    while (second < lineEnd && isSpaceCh(buf[second])) second++;
    if (lineEnd <= second) return null;
    if (buf[second] === '"') {
      const sp = cUnquote(buf, second);
      if (!sp) return null;
      cp = skipTreePrefix(pValue, sp.name, 0, sp.name.length);
      if (cp < 0) return null;
      if (sp.name.slice(cp) !== firstName) return null;
      return firstName;
    }
    cp = skipTreePrefix(pValue, buf, second, lineEnd - second);
    if (cp < 0) return null;
    if (lineEnd - cp !== firstName.length || buf.slice(cp, lineEnd) !== firstName) return null;
    return firstName;
  }
  const name = skipTreePrefix(pValue, buf, line, llen);
  if (name < 0) return null;
  for (let second = name; second < lineEnd; second++) {
    if (buf[second] === '"') {
      const sp = cUnquote(buf, second);
      if (!sp) return null;
      const np = skipTreePrefix(pValue, sp.name, 0, sp.name.length);
      if (np < 0) return null;
      const len = sp.name.length - np;
      if (
        len < second - name &&
        buf.slice(name, name + len) === sp.name.slice(np) &&
        isSpaceCh(buf[name + len])
      ) {
        return sp.name.slice(np);
      }
      return null;
    }
  }
  const nl = buf.indexOf("\n", name);
  if (nl < 0) return null;
  const lineLen = nl - name;
  for (let len = 0; ; len++) {
    const c = buf[name + len];
    if (c === "\n" || c === undefined) return null;
    if (c === "\t" || c === " ") {
      if (buf[name + len + 1] === undefined) return null;
      const second = skipTreePrefix(pValue, buf, name + len + 1, lineLen - (len + 1));
      if (second < 0) continue;
      if (
        buf[second + len] === "\n" &&
        buf.slice(name, name + len) === buf.slice(second, second + len)
      )
        return buf.slice(name, name + len);
    }
  }
}

/** Options and state the reader shares with the applier (apply.c's `apply_state`). */
export class ApplyParser {
  root = "";
  pValue = 1;
  pValueKnown = false;
  linenr = 1;
  patchInputFile = "<stdin>";
  /** git before 2.46 named lines without the patch file ("corrupt patch at line 5") */
  legacyMessages = false;
  applyInReverse = false;
  wsErrorAction: WsErrorAction = "warn";
  squelchWhitespaceErrors = 5;
  whitespaceError = 0;
  verbosity: ApplyVerbosity = 0;
  apply = true;
  check = false;
  limitByName: { pattern: string; include: boolean }[] = [];
  hasInclude = false;
  quotePathFully = true;
  stderr = "";
  stdout = "";

  error(message: string): number {
    if (this.verbosity > -1) this.stderr += vreportf("error: ", message);
    return -1;
  }

  warning(message: string): void {
    if (this.verbosity > -1) this.stderr += vreportf("warning: ", message);
  }

  /**
   * `inflate_it`: the data inflated into exactly `size` bytes, undefined otherwise; a
   * corrupt stream reports zlib's error as `git_inflate` does.
   */
  private inflateIt(data: Uint8Array, size: number): Uint8Array | undefined {
    const inflater = createInflater();
    let out: Uint8Array[];
    let done: boolean;
    try {
      ({ out, done } = inflater.push(data));
    } catch (error) {
      const message = (error as Error).message ?? "";
      if (message.includes("preset dictionary"))
        this.error("inflate: needs dictionary (no message)");
      else if (message.startsWith("inflate failed: "))
        this.error(`inflate: data stream error (${message.slice(16)})`);
      return undefined;
    } finally {
      inflater.abort();
    }
    if (!done) return undefined;
    let total = 0;
    for (const o of out) total += o.length;
    if (total !== size) return undefined;
    const result = new Uint8Array(total);
    let at = 0;
    for (const o of out) {
      result.set(o, at);
      at += o.length;
    }
    return result;
  }

  /** "at <file>:<line>" (git 2.46+) or "<legacy> <line>" ("on line 5", "at line 5"). */
  protected at(linenr: number, legacy = "at line"): string {
    return this.legacyMessages ? `${legacy} ${linenr}` : `at ${this.patchInputFile}:${linenr}`;
  }

  protected quote(name: string): string {
    return cQuote(name, this.quotePathFully);
  }

  /** `use_patch`: whether --include/--exclude keep the patch. */
  usePatch(p: FilePatch, wildmatch: (pattern: string, text: string) => boolean): boolean {
    const pathname = (p.newName ?? p.oldName) as string;
    for (const it of this.limitByName) {
      if (wildmatch(it.pattern, pathname)) return it.include;
    }
    return !this.hasInclude;
  }

  private findNameGnu(buf: string, at: number, pValue: number): string | null {
    const q = cUnquote(buf, at);
    if (!q) return null;
    let cp = 0;
    for (; pValue; pValue--) {
      const s = q.name.indexOf("/", cp);
      if (s < 0) return null;
      cp = s + 1;
    }
    return squashSlash(this.root + q.name.slice(cp));
  }

  private findNameCommon(
    buf: string,
    at: number,
    def: string | null,
    pValue: number,
    end: number,
    terminate: number,
  ): string | null {
    let line = at;
    let start = -1;
    if (pValue === 0) start = line;
    while (line !== end) {
      const c = buf[line];
      if (c === undefined) break;
      if (end < 0 && isSpaceCh(c)) {
        if (c === "\n") break;
        if (!(c === " " && !(terminate & TERM_SPACE)) && !(c === "\t" && !(terminate & TERM_TAB)))
          break;
      }
      line++;
      if (c === "/" && !--pValue) start = line;
    }
    if (start < 0) return squashSlash(def);
    const len = line - start;
    if (!len) return squashSlash(def);
    if (def !== null) {
      if (def.length < len && buf.startsWith(def, start)) return squashSlash(def);
    }
    return squashSlash(this.root + buf.slice(start, start + len));
  }

  private findName(
    buf: string,
    at: number,
    def: string | null,
    pValue: number,
    terminate: number,
  ): string | null {
    if (buf[at] === '"') {
      const name = this.findNameGnu(buf, at, pValue);
      if (name !== null) return name;
    }
    return this.findNameCommon(buf, at, def, pValue, -1, terminate);
  }

  private findNameTraditional(
    buf: string,
    at: number,
    def: string | null,
    pValue: number,
  ): string | null {
    if (buf[at] === '"') {
      const name = this.findNameGnu(buf, at, pValue);
      if (name !== null) return name;
    }
    let nl = buf.indexOf("\n", at);
    if (nl < 0) nl = buf.length;
    let len = nl - at;
    const line = buf.slice(at, nl);
    const dl = diffTimestampLen(line, len);
    if (!dl) return this.findNameCommon(buf, at, def, pValue, -1, TERM_TAB);
    len -= dl;
    return this.findNameCommon(buf, at, def, pValue, at + len, 0);
  }

  private guessPValue(buf: string, at: number): number {
    if (isDevNull(buf, at)) return -1;
    const name = this.findNameTraditional(buf, at, null, 0);
    if (name === null) return -1;
    return name.includes("/") ? -1 : 0;
  }

  private parseTraditionalPatch(
    buf: string,
    first: number,
    second: number,
    patch: FilePatch,
  ): number {
    first += 4;
    second += 4;
    if (!this.pValueKnown) {
      let p = this.guessPValue(buf, first);
      const q = this.guessPValue(buf, second);
      if (p < 0) p = q;
      if (0 <= p && p === q) {
        this.pValue = p;
        this.pValueKnown = true;
      }
    }
    let name: string | null;
    if (isDevNull(buf, first)) {
      patch.isNew = 1;
      patch.isDelete = 0;
      name = this.findNameTraditional(buf, second, null, this.pValue);
      patch.newName = name;
    } else if (isDevNull(buf, second)) {
      patch.isNew = 0;
      patch.isDelete = 1;
      name = this.findNameTraditional(buf, first, null, this.pValue);
      patch.oldName = name;
    } else {
      const firstName = this.findNameTraditional(buf, first, null, this.pValue);
      name = this.findNameTraditional(buf, second, firstName, this.pValue);
      if (hasEpochTimestamp(buf, first)) {
        patch.isNew = 1;
        patch.isDelete = 0;
        patch.newName = name;
      } else if (hasEpochTimestamp(buf, second)) {
        patch.isNew = 0;
        patch.isDelete = 1;
        patch.oldName = name;
      } else {
        patch.oldName = name;
        patch.newName = name;
      }
    }
    if (name === null)
      return this.error(`unable to find filename in patch ${this.at(this.linenr)}`);
    return 0;
  }

  private verifyName(
    buf: string,
    at: number,
    isNull: boolean,
    side: "old" | "new",
    patch: FilePatch,
    linenr: number,
  ): number {
    const key = side === "old" ? "oldName" : "newName";
    const current = patch[key];
    if (current === null && !isNull) {
      patch[key] = this.findName(buf, at, null, this.pValue, TERM_TAB);
      return 0;
    }
    if (current !== null) {
      if (isNull) {
        return this.error(
          `git apply: bad git-diff - expected /dev/null, got ${current} ${this.at(linenr, "on line")}`,
        );
      }
      const another = this.findName(buf, at, null, this.pValue, TERM_TAB);
      if (another === null || another !== current) {
        return this.error(
          `git apply: bad git-diff - inconsistent ${side} filename ${this.at(linenr, "on line")}`,
        );
      }
    } else if (!isDevNull(buf, at)) {
      return this.error(
        `git apply: bad git-diff - expected /dev/null ${this.at(linenr, "on line")}`,
      );
    }
    return 0;
  }

  private parseModeLine(buf: string, at: number, linenr: number): number {
    const { value, end } = strtoul(buf, at, 8);
    if (end === at || !isSpaceCh(buf[end])) {
      // git prints the rest of the patch: the line is not cut at its end
      const nul = buf.indexOf("\0", at);
      const line = buf.slice(at, nul < 0 ? undefined : nul);
      if (this.legacyMessages) this.error(`invalid mode on line ${linenr}: ${line}`);
      else this.error(`invalid mode at ${this.patchInputFile}:${linenr}: ${line}`);
      return -1;
    }
    return canonMode(value);
  }

  private checkHeaderLine(linenr: number, patch: FilePatch): number {
    const extensions =
      (patch.isDelete === 1 ? 1 : 0) +
      (patch.isNew === 1 ? 1 : 0) +
      (patch.isRename ? 1 : 0) +
      (patch.isCopy ? 1 : 0);
    if (extensions > 1)
      return this.error(`inconsistent header lines ${patch.extensionLinenr} and ${linenr}`);
    if (extensions && !patch.extensionLinenr) patch.extensionLinenr = linenr;
    return 0;
  }

  /** One extended header line; 1 ends the header, -1 fails. */
  private gitdiffLine(
    buf: string,
    at: number,
    len: number,
    patch: FilePatch,
    linenr: number,
  ): number {
    const p = this.pValue;
    const sub = p ? p - 1 : 0;
    const mode = (off: number, set: (m: number) => void) => {
      const m = this.parseModeLine(buf, at + off, linenr);
      if (m < 0) return -1;
      set(m);
      return 0;
    };
    const starts = (s: string) => len >= s.length && buf.startsWith(s, at);
    if (starts("@@ -")) return 1;
    if (starts("--- "))
      return this.verifyName(buf, at + 4, patch.isNew === 1, "old", patch, linenr);
    if (starts("+++ "))
      return this.verifyName(buf, at + 4, patch.isDelete === 1, "new", patch, linenr);
    if (starts("old mode ")) return mode(9, (m) => (patch.oldMode = m));
    if (starts("new mode ")) return mode(9, (m) => (patch.newMode = m));
    if (starts("deleted file mode ")) {
      patch.isDelete = 1;
      patch.oldName = patch.defName;
      return mode(18, (m) => (patch.oldMode = m));
    }
    if (starts("new file mode ")) {
      patch.isNew = 1;
      patch.newName = patch.defName;
      return mode(14, (m) => (patch.newMode = m));
    }
    if (starts("copy from ")) {
      patch.isCopy = true;
      patch.oldName = this.findName(buf, at + 10, null, sub, 0);
      return 0;
    }
    if (starts("copy to ")) {
      patch.isCopy = true;
      patch.newName = this.findName(buf, at + 8, null, sub, 0);
      return 0;
    }
    if (starts("rename old ")) {
      patch.isRename = true;
      patch.oldName = this.findName(buf, at + 11, null, sub, 0);
      return 0;
    }
    if (starts("rename new ")) {
      patch.isRename = true;
      patch.newName = this.findName(buf, at + 11, null, sub, 0);
      return 0;
    }
    if (starts("rename from ")) {
      patch.isRename = true;
      patch.oldName = this.findName(buf, at + 12, null, sub, 0);
      return 0;
    }
    if (starts("rename to ")) {
      patch.isRename = true;
      patch.newName = this.findName(buf, at + 10, null, sub, 0);
      return 0;
    }
    if (starts("similarity index ") || starts("dissimilarity index ")) {
      const off = starts("similarity index ") ? 17 : 20;
      const { value } = strtoul(buf, at + off, 10);
      if (value <= 100) patch.score = value;
      return 0;
    }
    if (starts("index ")) {
      const line = at + 6;
      const dot = buf.indexOf(".", line);
      const eol0 = buf.indexOf("\n", line);
      const eol = eol0 < 0 ? buf.length : eol0;
      if (dot < 0 || buf[dot + 1] !== "." || 40 < dot - line) return 0;
      const oldPrefix = buf.slice(line, dot);
      const l2 = dot + 2;
      let ptr = buf.indexOf(" ", l2);
      if (ptr < 0 || eol < ptr) ptr = eol;
      if (40 < ptr - l2) return 0;
      patch.oldOidPrefix = oldPrefix;
      patch.newOidPrefix = buf.slice(l2, ptr);
      if (buf[ptr] === " ") return mode(ptr + 1 - at, (m) => (patch.oldMode = m));
      return 0;
    }
    return 1;
  }

  /** `parse_git_diff_header`: the header's length, or -128. */
  private parseGitDiffHeader(
    buf: string,
    at: number,
    len: number,
    size: number,
    patch: FilePatch,
  ): number {
    patch.isNew = 0;
    patch.isDelete = 0;
    patch.defName = gitHeaderName(this.pValue, buf, at, len);
    if (patch.defName !== null && this.root) patch.defName = this.root + patch.defName;
    let line = at + len;
    size -= len;
    this.linenr++;
    let offset = len;
    for (; size > 0; offset += len, size -= len, line += len, this.linenr++) {
      len = linelen(buf, line, size);
      if (!len || buf[line + len - 1] !== "\n") break;
      const res = this.gitdiffLine(buf, line, len, patch, this.linenr);
      if (res < 0) return -1;
      if (this.checkHeaderLine(this.linenr, patch)) return -1;
      if (res > 0) break;
    }
    if (patch.oldName === null && patch.newName === null) {
      if (patch.defName === null) {
        const n = this.pValue;
        const comp = n === 1 ? "component" : "components";
        if (this.legacyMessages)
          this.error(
            `git diff header lacks filename information when removing ${n} leading pathname ${comp} (line ${this.linenr})`,
          );
        else
          this.error(
            `git diff header lacks filename information when removing ${n} leading pathname ${comp} at ${this.patchInputFile}:${this.linenr}`,
          );
        return -128;
      }
      patch.oldName = patch.defName;
      patch.newName = patch.defName;
    }
    if ((patch.newName === null && !patch.isDelete) || (patch.oldName === null && !patch.isNew)) {
      if (this.legacyMessages)
        this.error(`git diff header lacks filename information (line ${this.linenr})`);
      else
        this.error(
          `git diff header lacks filename information at ${this.patchInputFile}:${this.linenr}`,
        );
      return -128;
    }
    patch.isToplevelRelative = true;
    return offset;
  }

  /** `find_header`: the header's offset (and `hdrsize`), -1 when none, -128 on error. */
  private findHeader(
    buf: string,
    at: number,
    size: number,
    patch: FilePatch,
  ): { offset: number; hdrsize: number } {
    patch.isToplevelRelative = false;
    patch.isRename = patch.isCopy = false;
    patch.isNew = patch.isDelete = -1;
    patch.oldMode = patch.newMode = 0;
    patch.oldName = patch.newName = null;
    let len = 0;
    for (
      let offset = 0, line = at;
      size > 0;
      offset += len, size -= len, line += len, this.linenr++
    ) {
      len = linelen(buf, line, size);
      if (!len) break;
      if (len < 6) continue;
      if (buf.startsWith("@@ -", line)) {
        const dummy = emptyFragment();
        if (parseFragmentHeader(buf, line, len, dummy) < 0) continue;
        const shown = buf.slice(line, line + len - 1);
        if (this.legacyMessages)
          this.error(`patch fragment without header at line ${this.linenr}: ${shown}`);
        else
          this.error(
            `patch fragment without header at ${this.patchInputFile}:${this.linenr}: ${shown}`,
          );
        return { offset: -128, hdrsize: 0 };
      }
      if (size < len + 6) break;
      if (buf.startsWith("diff --git ", line)) {
        const git = this.parseGitDiffHeader(buf, line, len, size, patch);
        if (git < 0) return { offset: -128, hdrsize: 0 };
        if (git <= len) continue;
        return { offset, hdrsize: git };
      }
      if (!buf.startsWith("--- ", line) || !buf.startsWith("+++ ", line + len)) continue;
      const nextlen = linelen(buf, line + len, size - len);
      if (size < nextlen + 14 || !buf.startsWith("@@ -", line + len + nextlen)) continue;
      if (this.parseTraditionalPatch(buf, line, line + len, patch))
        return { offset: -128, hdrsize: 0 };
      this.linenr += 2;
      return { offset, hdrsize: len + nextlen };
    }
    return { offset: -1, hdrsize: 0 };
  }

  /** `record_ws_error`. */
  protected recordWsError(result: number, line: string, linenr: number): void {
    if (!result) return;
    this.whitespaceError++;
    if (this.squelchWhitespaceErrors && this.squelchWhitespaceErrors < this.whitespaceError) return;
    const err = whitespaceErrorString(result);
    if (this.verbosity > -1) this.stderr += `${this.patchInputFile}:${linenr}: ${err}.\n${line}\n`;
  }

  /** `check_whitespace` of a hunk line (its first byte the +/-/space). */
  private checkWhitespace(line: string, wsRule: number, incomplete: boolean): void {
    const body = line.slice(1);
    const result = wsCheck(body, wsRule);
    // the shown line: without its LF, but an incomplete line keeps its last byte
    let shown = body.length - 1;
    if (result & WS_INCOMPLETE_LINE) shown++;
    void incomplete;
    this.recordWsError(result, body.slice(0, Math.max(0, shown)), this.linenr);
  }

  private parseFragment(
    buf: string,
    at: number,
    size: number,
    patch: FilePatch,
    fragment: PatchFragment,
  ): number {
    let len = linelen(buf, at, size);
    if (patch.wsRule & WS_INCOMPLETE_LINE) {
      const mode = this.applyInReverse
        ? patch.oldMode
        : patch.newMode
          ? patch.newMode
          : patch.oldMode;
      if (mode && isLink(mode)) patch.wsRule &= ~WS_INCOMPLETE_LINE;
    }
    let offset = parseFragmentHeader(buf, at, len, fragment);
    if (offset < 0) return -1;
    if (offset > 0 && patch.recount) this.recountDiff(buf, at + offset, size - offset, fragment);
    let oldlines = fragment.oldlines;
    let newlines = fragment.newlines;
    let leading = 0;
    let trailing = 0;
    let line = at + len;
    size -= len;
    this.linenr++;
    let added = 0;
    let deleted = 0;
    for (offset = len; size > 0; offset += len, size -= len, line += len, this.linenr++) {
      if (!oldlines && !newlines) break;
      len = linelen(buf, line, size);
      if (!len || buf[line + len - 1] !== "\n") return -1;
      let skipLen = adjustIncomplete(buf, line, len, size);
      if (skipLen) {
        len--;
        skipLen++;
      }
      const text = buf.slice(line, line + len);
      switch (buf[line]) {
        case "\n":
        case " ":
          oldlines--;
          newlines--;
          if (!deleted && !added) leading++;
          trailing++;
          checkOldForCrlf(patch, text);
          if (!this.applyInReverse && this.wsErrorAction === "fix") {
            this.checkWhitespace(buf[line] === "\n" ? " \n" : text, patch.wsRule, skipLen > 0);
          }
          break;
        case "-":
          if (!this.applyInReverse) checkOldForCrlf(patch, text);
          if (this.applyInReverse && this.wsErrorAction !== "nowarn")
            this.checkWhitespace(text, patch.wsRule, skipLen > 0);
          deleted++;
          oldlines--;
          trailing = 0;
          break;
        case "+":
          if (this.applyInReverse) checkOldForCrlf(patch, text);
          if (!this.applyInReverse && this.wsErrorAction !== "nowarn")
            this.checkWhitespace(text, patch.wsRule, skipLen > 0);
          added++;
          newlines--;
          trailing = 0;
          break;
        default:
          return -1;
      }
      if (skipLen) {
        len += skipLen;
        this.linenr++;
      }
    }
    if (oldlines || newlines) return -1;
    if (!patch.recount && !deleted && !added) return -1;
    fragment.leading = leading;
    fragment.trailing = trailing;
    patch.linesAdded += added;
    patch.linesDeleted += deleted;
    if (0 < patch.isNew && oldlines) return this.error("new file depends on old contents");
    if (0 < patch.isDelete && newlines) return this.error("deleted file still has contents");
    return offset;
  }

  private recountDiff(buf: string, at: number, size: number, fragment: PatchFragment): void {
    let oldlines = 0;
    let newlines = 0;
    if (size < 1) {
      this.warning("recount: ignore empty hunk");
      return;
    }
    let line = at;
    for (;;) {
      const len = linelen(buf, line, size);
      size -= len;
      line += len;
      if (size < 1) break;
      let ret = 0;
      switch (buf[line]) {
        case " ":
        case "\n":
          newlines++;
          oldlines++;
          continue;
        case "-":
          oldlines++;
          continue;
        case "+":
          newlines++;
          continue;
        case "\\":
          continue;
        case "@":
          ret = size < 3 || !buf.startsWith("@@ ", line) ? 1 : 0;
          break;
        case "d":
          ret = size < 5 || !buf.startsWith("diff ", line) ? 1 : 0;
          break;
        default:
          ret = -1;
      }
      if (ret) {
        this.warning(
          `recount: unexpected line: ${buf.slice(line, line + linelen(buf, line, size))}`,
        );
        return;
      }
      break;
    }
    fragment.oldlines = oldlines;
    fragment.newlines = newlines;
  }

  private parseSinglePatch(buf: string, at: number, size: number, patch: FilePatch): number {
    let offset = 0;
    let oldlines = 0;
    let newlines = 0;
    let context = 0;
    let line = at;
    while (size > 4 && buf.startsWith("@@ -", line)) {
      const fragment = emptyFragment();
      fragment.linenr = this.linenr;
      const len = this.parseFragment(buf, line, size, patch, fragment);
      if (len <= 0) return this.error(`corrupt patch ${this.at(this.linenr)}`);
      fragment.patch = buf.slice(line, line + len);
      fragment.size = len;
      oldlines += fragment.oldlines;
      newlines += fragment.newlines;
      context += fragment.leading + fragment.trailing;
      patch.fragments.push(fragment);
      offset += len;
      line += len;
      size -= len;
    }
    if (patch.isNew < 0 && (oldlines || patch.fragments.length > 1)) patch.isNew = 0;
    if (patch.isDelete < 0 && (newlines || patch.fragments.length > 1)) patch.isDelete = 0;
    if (0 < patch.isNew && oldlines)
      return this.error(`new file ${patch.newName} depends on old contents`);
    if (0 < patch.isDelete && newlines)
      return this.error(`deleted file ${patch.oldName} still has contents`);
    if (!patch.isDelete && !newlines && context && this.verbosity > -1)
      this.stderr += `** warning: file ${patch.newName} becomes empty but is not deleted\n`;
    return offset;
  }

  private async parseBinaryHunk(
    buf: string,
    state: { at: number; size: number },
  ): Promise<{ status: number; used: number; frag?: PatchFragment }> {
    let at = state.at;
    let size = state.size;
    let llen = linelen(buf, at, size);
    let used = llen;
    let method: number;
    let origlen: number;
    if (buf.startsWith("delta ", at)) {
      method = BINARY_DELTA;
      origlen = strtoul(buf, at + 6, 10).value;
    } else if (buf.startsWith("literal ", at)) {
      method = BINARY_LITERAL;
      origlen = strtoul(buf, at + 8, 10).value;
    } else return { status: 0, used: 0 };
    this.linenr++;
    at += llen;
    size -= llen;
    const data: number[] = [];
    const corrupt = () => {
      this.error(
        `corrupt binary patch ${this.at(this.linenr - 1)}: ${buf.slice(at, at + llen - 1)}`,
      );
      return { status: -1, used: 0 };
    };
    for (;;) {
      llen = linelen(buf, at, size);
      used += llen;
      this.linenr++;
      if (llen === 1) {
        at++;
        size--;
        break;
      }
      if (llen < 7 || (llen - 2) % 5) return corrupt();
      const max = ((llen - 2) / 5) * 4;
      const c = buf.charCodeAt(at);
      let byteLength: number;
      if (c >= 65 && c <= 90) byteLength = c - 65 + 1;
      else if (c >= 97 && c <= 122) byteLength = c - 97 + 27;
      else return corrupt();
      if (max < byteLength || byteLength <= max - 4) return corrupt();
      const bad = decode85(data, buf, at + 1, byteLength);
      if (bad !== undefined) {
        this.error(bad);
        return corrupt();
      }
      at += llen;
      size -= llen;
    }
    const inflated = this.inflateIt(new Uint8Array(data), origlen);
    if (!inflated) return corrupt();
    state.at = at;
    state.size = size;
    const frag = emptyFragment();
    frag.patch = bytesToLatin1(inflated);
    frag.size = origlen;
    frag.binaryMethod = method;
    return { status: 0, used, frag };
  }

  private async parseBinary(
    buf: string,
    at: number,
    size: number,
    patch: FilePatch,
  ): Promise<number> {
    const state = { at, size };
    const forward = await this.parseBinaryHunk(buf, state);
    if (!forward.frag && !forward.status)
      return this.error(`unrecognized binary patch ${this.at(this.linenr - 1)}`);
    if (forward.status || !forward.frag) return forward.status;
    let used = forward.used;
    const reverse = await this.parseBinaryHunk(buf, state);
    if (reverse.frag) used += reverse.used;
    else if (reverse.status) return reverse.status;
    patch.fragments = reverse.frag ? [forward.frag, reverse.frag] : [forward.frag];
    patch.isBinary = true;
    return used;
  }

  /**
   * `parse_chunk`: reads one file's patch at `at`; the bytes it took, -1 when there is no
   * more, -128 on a fatal error.
   */
  async parseChunk(
    buf: string,
    at: number,
    size: number,
    patch: FilePatch,
    wsRuleOf: (patch: FilePatch) => Promise<number>,
  ): Promise<number> {
    const { offset, hdrsize } = this.findHeader(buf, at, size, patch);
    if (offset < 0) return offset;
    patch.wsRule = await wsRuleOf(patch);
    let patchsize = this.parseSinglePatch(
      buf,
      at + offset + hdrsize,
      size - offset - hdrsize,
      patch,
    );
    if (patchsize < 0) return -128;
    if (!patchsize) {
      const gitBinary = "GIT binary patch\n";
      const hd = at + hdrsize + offset;
      const rest = size - hdrsize - offset;
      const llen = linelen(buf, hd, rest);
      if (llen === gitBinary.length && buf.startsWith(gitBinary, hd)) {
        this.linenr++;
        const used = await this.parseBinary(buf, hd + llen, rest - llen, patch);
        if (used < 0) return -1;
        patchsize = used ? used + llen : 0;
      } else if (buf.slice(hd + llen - 8, hd + llen) === " differ\n") {
        for (const h of ["Binary files ", "Files "]) {
          if (h.length < rest && buf.startsWith(h, hd)) {
            this.linenr++;
            patch.isBinary = true;
            patchsize = llen;
            break;
          }
        }
      }
      if ((this.apply || this.check) && !patch.isBinary && !metadataChanges(patch)) {
        this.error(`patch with only garbage ${this.at(this.linenr)}`);
        return -128;
      }
    }
    return offset + hdrsize + patchsize;
  }
}

export function metadataChanges(patch: FilePatch): boolean {
  return (
    patch.isRename ||
    patch.isCopy ||
    patch.isNew > 0 ||
    patch.isDelete !== 0 ||
    (patch.oldMode !== 0 && patch.newMode !== 0 && patch.oldMode !== patch.newMode)
  );
}

function emptyFragment(): PatchFragment {
  return {
    leading: 0,
    trailing: 0,
    oldpos: 0,
    oldlines: 0,
    newpos: 0,
    newlines: 0,
    patch: "",
    size: 0,
    linenr: 0,
    rejected: false,
  };
}

function checkOldForCrlf(patch: FilePatch, line: string): void {
  const len = line.length;
  if (len >= 2 && line[len - 1] === "\n" && line[len - 2] === "\r") {
    patch.wsRule |= WS_CR_AT_EOL;
    patch.crlfInOld = true;
  }
}

function adjustIncomplete(buf: string, at: number, len: number, size: number): number {
  const c = buf[at];
  if (c !== "\n" && c !== " " && c !== "+" && c !== "-") return 0;
  if (size - len < 12 || !buf.startsWith("\\ ", at + len)) return 0;
  const nextlen = linelen(buf, at + len, size - len);
  if (nextlen < 12) return 0;
  return nextlen;
}

function parseNum(buf: string, at: number): { digits: number; value: number } {
  if (!isDigit(buf[at])) return { digits: 0, value: 0 };
  let i = at;
  let value = 0;
  while (isDigit(buf[i])) value = value * 10 + (buf.charCodeAt(i++) - 48);
  return { digits: i - at, value };
}

function parseRange(
  buf: string,
  at: number,
  len: number,
  offset: number,
  expect: string,
): { offset: number; p1: number; p2: number } {
  if (offset < 0 || offset >= len) return { offset: -1, p1: 0, p2: 0 };
  let line = at + offset;
  len -= offset;
  const n1 = parseNum(buf, line);
  if (!n1.digits) return { offset: -1, p1: 0, p2: 0 };
  offset += n1.digits;
  line += n1.digits;
  len -= n1.digits;
  let p2 = 1;
  if (buf[line] === ",") {
    const n2 = parseNum(buf, line + 1);
    if (!n2.digits) return { offset: -1, p1: 0, p2: 0 };
    p2 = n2.value;
    offset += n2.digits + 1;
    line += n2.digits + 1;
    len -= n2.digits + 1;
  }
  if (expect.length > len) return { offset: -1, p1: 0, p2: 0 };
  if (!buf.startsWith(expect, line)) return { offset: -1, p1: 0, p2: 0 };
  return { offset: offset + expect.length, p1: n1.value, p2 };
}

/** `parse_fragment_header` of "@@ -a,b +c,d @@": the header's length, or -1. */
function parseFragmentHeader(
  buf: string,
  at: number,
  len: number,
  fragment: PatchFragment,
): number {
  if (!len || buf[at + len - 1] !== "\n") return -1;
  const o = parseRange(buf, at, len, 4, " +");
  fragment.oldpos = o.p1;
  fragment.oldlines = o.p2;
  const n = parseRange(buf, at, len, o.offset, " @@");
  fragment.newpos = n.p1;
  fragment.newlines = n.p2;
  return n.offset;
}

const DE85: Int16Array = (() => {
  const table = new Int16Array(256).fill(0);
  const chars =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
  for (let i = 0; i < chars.length; i++) table[chars.charCodeAt(i)] = i + 1;
  return table;
})();

/** base85.c's `decode_85`: appends `len` decoded bytes to `out`; its error on bad data. */
function decode85(out: number[], buf: string, at: number, len: number): string | undefined {
  let i = at;
  // a NUL ends the message (vsnprintf's %c, then vreportf stops at it)
  const alphabet = (ch: number) =>
    `invalid base85 alphabet ${Number.isNaN(ch) ? "\0" : String.fromCharCode(ch)}`;
  while (len) {
    let acc = 0;
    let cnt = 4;
    let de: number;
    do {
      const ch = buf.charCodeAt(i++);
      de = DE85[ch & 0xff] ?? 0;
      if (Number.isNaN(ch) || --de < 0) return alphabet(ch);
      acc = acc * 85 + de;
    } while (--cnt);
    const ch = buf.charCodeAt(i++);
    de = DE85[ch & 0xff] ?? 0;
    if (Number.isNaN(ch) || --de < 0) return alphabet(ch);
    if (0xffffffff / 85 < acc || 0xffffffff - de < acc * 85)
      return `invalid base85 sequence ${buf.slice(i - 5, i)}`;
    acc = acc * 85 + de;
    cnt = len < 4 ? len : 4;
    len -= cnt;
    do {
      acc = ((acc << 8) | (acc >>> 24)) >>> 0;
      out.push(acc & 0xff);
    } while (--cnt);
  }
  return undefined;
}

/**
 * usage.c's `vreportf`: the prefixed message cut at a NUL and at 4095 bytes, control
 * characters but tab and newline shown as `?`, ended by a newline.
 */
export function vreportf(prefix: string, message: string): string {
  let msg = prefix + message;
  const nul = msg.indexOf("\0", prefix.length);
  if (nul >= 0) msg = msg.slice(0, nul);
  if (msg.length > 4095) msg = msg.slice(0, 4095);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: git's iscntrl
  msg = msg.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "?");
  return `${msg}\n`;
}

export { latin1ToBytes };
