/**
 * The trailers of a commit message as git's trailer.c finds them (`%(trailers)` of a pretty
 * format, `git interpret-trailers --parse`): the last paragraph when every line of it is a
 * trailer, or when it has a git-generated one (`Signed-off-by: `, `(cherry picked from
 * commit `) and at least a quarter of its lines are trailers, continuation lines folded in.
 *
 * @example
 * ```typescript
 * const message = "Fix\n\nBody.\n\nSigned-off-by: A <a@b>\nAcked-by: C <c@d>\n";
 * formatTrailersOf(message, { onlyTrailers: true, valueOnly: true, separator: ", " });
 * // "A <a@b>, C <c@d>"
 * ```
 *
 * @module
 */

import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import { RemoteConfigStore } from "../remote-config/index.js";
import { commentPrefixOf } from "./message-cleanup.js";

/** The configuration trailers are read with (`trailer.*`, `core.commentChar`). */
export interface TrailerConfig {
  /** `trailer.separators`: the characters that end a trailer's key (default `:`) */
  separators?: string;
  /** `core.commentChar` / `core.commentString` (default `#`) */
  commentString?: string;
  /**
   * The `trailer.<name>.*` sections in the configuration's order: a trailer whose key starts
   * a name (or its `key`) is recognized, and shown with the `key` given
   */
  items?: readonly { name: string; key?: string }[];
}

/** What git's process_trailer_options carries for formatting trailers. */
export interface TrailerFormatOptions {
  /** Only the trailers, not the other lines of the block (`only`) */
  onlyTrailers?: boolean;
  /** Continuation lines joined into one (`unfold`) */
  unfold?: boolean;
  /** Only the keys (`keyonly`) */
  keyOnly?: boolean;
  /** Only the values (`valueonly`) */
  valueOnly?: boolean;
  /** Between trailers, instead of each one's line end (`separator=`) */
  separator?: string;
  /** Between a key and its value, instead of `: ` (`key_value_separator=`) */
  keyValueSeparator?: string;
  /** Only the trailers with one of these keys, matched without case (`key=`) */
  keys?: readonly string[];
}

/** The trailer configuration of a working copy (`trailer.separators`, `trailer.<name>.key`). */
export function trailerConfigOf(workingCopy: WorkingCopy): TrailerConfig {
  const config = RemoteConfigStore.from(workingCopy);
  const items: { name: string; key?: string }[] = [];
  const variables = ["key", "command", "cmd", "where", "ifexists", "ifmissing"];
  for (const name of config.subsections("trailer")) {
    if (!variables.some((v) => config.values(`trailer.${name}.${v}`).length > 0)) continue;
    // get_conf_item: the names are one item without case
    const known = items.find((i) => lowerAscii(i.name) === lowerAscii(name));
    const key = config.value(`trailer.${name}.key`);
    if (known) {
      if (key !== undefined) known.key = key;
    } else items.push(key !== undefined ? { name, key } : { name });
  }
  const separators = config.value("trailer.separators");
  return {
    ...(separators ? { separators } : {}),
    commentString: commentPrefixOf(workingCopy),
    items,
  };
}

const lowerAscii = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
/** strncasecmp(a, b, n) === 0 */
const sameStart = (a: string, b: string, n: number) =>
  a.length >= n && b.length >= n && lowerAscii(a.slice(0, n)) === lowerAscii(b.slice(0, n));
/** git's isspace (sane_ctype): space, tab, LF, CR */
const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";
const isAlnum = (c: string | undefined) => c !== undefined && /^[A-Za-z0-9]$/.test(c);
const trim = (s: string) => s.replace(/^[ \t\n\r]+/, "").replace(/[ \t\n\r]+$/, "");

/** git's is_blank_line: only spaces up to the line's end. */
function isBlankLine(buf: string, at: number): boolean {
  let i = at;
  while (i < buf.length && buf[i] !== "\n" && isSpace(buf[i])) i++;
  return i >= buf.length || buf[i] === "\n";
}

/** git's next_line: past the next line end (or at the end). */
function nextLine(buf: string, at: number): number {
  const nl = buf.indexOf("\n", at);
  return nl < 0 ? buf.length : nl + 1;
}

/** git's last_line: where the last line of `buf[0, len)` starts; -1 when empty. */
function lastLine(buf: string, len: number): number {
  if (len === 0) return -1;
  if (len === 1) return 0;
  for (let i = len - 2; i >= 0; i--) if (buf[i] === "\n") return i + 1;
  return 0;
}

/**
 * git's find_separator: where the separator of `<token><optional blanks><separator>` is in
 * `line`, -1 when it is not a trailer line (a `://` right after the token is a URL).
 */
function findSeparator(line: string, at: number, separators: string): number {
  let whitespace = false;
  for (let c = at; c < line.length && line[c] !== "\n"; c++) {
    const ch = line[c] as string;
    if (separators.includes(ch)) {
      if (!whitespace && line.startsWith("://", c)) return -1;
      return c - at;
    }
    if (!whitespace && (isAlnum(ch) || ch === "-")) continue;
    if (c !== at && (ch === " " || ch === "\t")) {
      whitespace = true;
      continue;
    }
    break;
  }
  return -1;
}

/** git's token_len_without_separator: the token without its final punctuation. */
function tokenLength(token: string): number {
  let len = token.length;
  while (len > 0 && !isAlnum(token[len - 1])) len--;
  return len;
}

const GIT_GENERATED_PREFIXES = ["Signed-off-by: ", "(cherry picked from commit "];
const CUT_LINE = "------------------------ >8 ------------------------";

/** commit.c's ignored_log_message_bytes: the trailing comments, blank lines, scissors. */
function ignoredBytes(buf: string, len: number, comment: string): number {
  // wt_status_locate_end
  let cutoff = len;
  const pattern = `\n${comment} ${CUT_LINE}\n`;
  if (buf.startsWith(pattern.slice(1))) cutoff = 0;
  else {
    const p = buf.indexOf(pattern);
    if (p >= 0 && p + 1 < len) cutoff = p + 1;
  }
  let boc = 0;
  let bol = 0;
  let inConflicts = false;
  while (bol < cutoff) {
    const nl = buf.indexOf("\n", bol);
    const next = nl < 0 || nl >= len ? len : nl + 1;
    if (buf.slice(bol, cutoff).startsWith(comment) || buf[bol] === "\n") {
      if (!boc) boc = bol;
    } else if (buf.startsWith("Conflicts:\n", bol)) {
      inConflicts = true;
      if (!boc) boc = bol;
    } else if (inConflicts && buf[bol] === "\t") {
      // a path in the conflicts block
    } else if (boc) {
      boc = 0;
      inConflicts = false;
    }
    bol = next;
  }
  return boc ? len - boc : len - cutoff;
}

/** One line of the trailer block: a trailer (`token`), else another line. */
interface TrailerItem {
  token?: string;
  value: string;
}

/** trailer.c's find_trailer_block_start: where the block starts, `len` when there is none. */
function trailerBlockStart(buf: string, len: number, config: Required<TrailerConfig>): number {
  const comment = config.commentString;
  let s = 0;
  for (; s < len; s = nextLine(buf, s)) {
    if (buf.slice(s, len).startsWith(comment)) continue;
    if (isBlankLine(buf, s)) break;
  }
  const endOfTitle = s;
  let onlySpaces = true;
  let recognizedPrefix = false;
  let trailerLines = 0;
  let nonTrailerLines = 0;
  let possibleContinuationLines = 0;
  for (let l = lastLine(buf, len); l >= endOfTitle; l = lastLine(buf, l)) {
    if (buf.slice(l, len).startsWith(comment)) {
      nonTrailerLines += possibleContinuationLines;
      possibleContinuationLines = 0;
      continue;
    }
    if (isBlankLine(buf, l)) {
      if (onlySpaces) continue;
      nonTrailerLines += possibleContinuationLines;
      if (recognizedPrefix && trailerLines * 3 >= nonTrailerLines) return nextLine(buf, l);
      if (trailerLines && !nonTrailerLines) return nextLine(buf, l);
      return len;
    }
    onlySpaces = false;
    if (GIT_GENERATED_PREFIXES.some((p) => buf.startsWith(p, l))) {
      trailerLines++;
      possibleContinuationLines = 0;
      recognizedPrefix = true;
      continue;
    }
    const separatorPos = findSeparator(buf, l, config.separators);
    if (separatorPos >= 1 && !isSpace(buf[l])) {
      trailerLines++;
      possibleContinuationLines = 0;
      if (recognizedPrefix) continue;
      const line = buf.slice(l);
      if (config.items.some((item) => tokenMatches(line, item, separatorPos))) {
        recognizedPrefix = true;
      }
    } else if (isSpace(buf[l])) possibleContinuationLines++;
    else {
      nonTrailerLines++;
      nonTrailerLines += possibleContinuationLines;
      possibleContinuationLines = 0;
    }
  }
  return len;
}

/** git's token_matches_item: `tok`'s first `len` characters start the item's name or key. */
function tokenMatches(tok: string, item: { name: string; key?: string }, len: number): boolean {
  if (sameStart(tok, item.name, len)) return true;
  return item.key !== undefined && sameStart(tok, item.key, len);
}

/** git's unfold_value: each line end and the blanks after it one space, then trimmed. */
function unfoldValue(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; ) {
    let c = value[i++] as string;
    if (c === "\n") {
      while (i < value.length && isSpace(value[i])) i++;
      c = " ";
    }
    out += c;
  }
  return trim(out);
}

/**
 * trailer.c's trailer_block_get (no `---` divider): where the block is and its lines, a
 * continuation (a line starting with a blank) joined to the trailer before it.
 */
function trailerBlock(
  message: string,
  config: Required<TrailerConfig>,
): { start: number; end: number; lines: string[] } {
  const end = message.length - ignoredBytes(message, message.length, config.commentString);
  const start = trailerBlockStart(message, end, config);
  const lines: string[] = [];
  let lastIsTrailer = false;
  for (let i = start; i < end; ) {
    const next = Math.min(nextLine(message, i), end);
    const line = message.slice(i, next);
    i = next;
    if (lastIsTrailer && isSpace(line[0])) {
      lines[lines.length - 1] += line;
      continue;
    }
    lines.push(line);
    lastIsTrailer = findSeparator(line, 0, config.separators) >= 1;
  }
  return { start, end, lines };
}

/** The configuration with git's defaults. */
function withDefaults(trailerConfig: TrailerConfig): Required<TrailerConfig> {
  return {
    separators: trailerConfig.separators || ":",
    commentString: trailerConfig.commentString || "#",
    items: trailerConfig.items ?? [],
  };
}

/**
 * sequencer.c's append_signoff (no footer to ignore; `dedup` is APPEND_SIGNOFF_DEDUP): `sob` (`Signed-off-by:
 * <ident>` and a line end) appended to `message`, after a blank line unless the message
 * ends with a trailer block; nothing appended when the block's last line is `sob` already
 * (has_conforming_footer), or when the message is `sob` alone.
 *
 * @example
 * ```typescript
 * appendSignoff("Fix\n", "Signed-off-by: A <a@b>\n");
 * // "Fix\n\nSigned-off-by: A <a@b>\n"
 * ```
 */
export function appendSignoff(
  message: string,
  sob: string,
  trailerConfig: TrailerConfig = {},
  dedup = false,
): string {
  // strbuf_complete_line
  let out = message.length > 0 && !message.endsWith("\n") ? `${message}\n` : message;
  let footer: 0 | 1 | 2 | 3;
  if (out === sob) footer = 3;
  else {
    const { lines } = trailerBlock(out, withDefaults(trailerConfig));
    let found = 0;
    lines.forEach((line, k) => {
      if (line.startsWith(sob)) found = k + 1;
    });
    footer = lines.length === 0 ? 0 : found === lines.length ? 3 : found ? 2 : 1;
  }
  if (footer === 0) {
    if (out.length === 0) out = "\n\n";
    else if (out.length === 1) out += "\n";
    else if (out[out.length - 2] !== "\n") out += "\n";
  }
  // APPEND_SIGNOFF_DEDUP: not added again when the footer has it anywhere
  if (footer !== 3 && !(dedup && footer === 2)) out += sob;
  return out;
}

/** The block of `message` and its items (trailer.c's parse_trailers, no `---` divider). */
function parseTrailers(
  message: string,
  options: TrailerFormatOptions,
  config: Required<TrailerConfig>,
): { start: number; end: number; items: TrailerItem[] } {
  const { start, end, lines } = trailerBlock(message, config);
  const items: TrailerItem[] = [];
  for (const trailer of lines) {
    if (trailer.startsWith(config.commentString)) continue;
    const separatorPos = findSeparator(trailer, 0, config.separators);
    if (separatorPos >= 1) {
      // parse_trailer: the token as configured (an item's key, when it names one)
      let token = trim(trailer.slice(0, separatorPos));
      let value = trim(trailer.slice(separatorPos + 1));
      const len = tokenLength(token);
      const item = config.items.find((i) => tokenMatches(token, i, len));
      if (item?.key !== undefined) token = item.key;
      if (options.unfold) value = unfoldValue(value);
      items.push({ token, value });
    } else if (!options.onlyTrailers) {
      items.push({ value: trailer.endsWith("\n") ? trailer.slice(0, -1) : trailer });
    }
  }
  return { start, end, items };
}

/**
 * trailer.c's format_trailers_from_commit: the trailer block of `message` (from its
 * subject), whole when no option changes it, else each trailer formatted. `before` is what
 * the output already holds (git trims the blanks it ends with after a non-trailer line when
 * a separator is given); the result is `before` with the trailers after it.
 */
export function appendTrailers(
  before: string,
  message: string,
  options: TrailerFormatOptions = {},
  trailerConfig: TrailerConfig = {},
): string {
  const config = withDefaults(trailerConfig);
  const block = parseTrailers(message, options, config);
  const filtered = options.keys !== undefined;
  if (
    !options.onlyTrailers &&
    !options.unfold &&
    !filtered &&
    options.separator === undefined &&
    !options.keyOnly &&
    !options.valueOnly &&
    options.keyValueSeparator === undefined
  ) {
    return before + message.slice(block.start, block.end);
  }
  let out = before;
  const origLength = out.length;
  for (const item of block.items) {
    if (item.token !== undefined) {
      const token = item.token;
      const keep =
        !filtered ||
        (options.keys ?? []).some((key) => {
          // format_trailer_match_cb: the key without a final `:`, the same length
          const len = key.endsWith(":") ? key.length - 1 : key.length;
          return token.length === len && sameStart(key, token, len);
        });
      if (!keep) continue;
      if (options.separator !== undefined && out.length !== origLength) out += options.separator;
      if (!options.valueOnly) out += token;
      if (!options.keyOnly && !options.valueOnly) {
        if (options.keyValueSeparator !== undefined) out += options.keyValueSeparator;
        else {
          const last = token.replace(/[ \t\n\r]+$/, "").slice(-1);
          if (last && !config.separators.includes(last)) out += `${config.separators[0]} `;
        }
      }
      if (!options.keyOnly) out += item.value;
      if (options.separator === undefined) out += "\n";
    } else if (!options.onlyTrailers) {
      if (options.separator !== undefined && out.length !== origLength) out += options.separator;
      out += item.value;
      if (options.separator !== undefined) out = out.replace(/[ \t\n\r]+$/, "");
      else out += "\n";
    }
  }
  return out;
}

/** {@link appendTrailers} of `message` alone. */
export function formatTrailersOf(
  message: string,
  options: TrailerFormatOptions = {},
  config: TrailerConfig = {},
): string {
  return appendTrailers("", message, options, config);
}
