/**
 * git's colored diff output (diff.c's `emit_*` functions, ws.c's `ws_check_emit`) and its
 * moved-line detection (`--color-moved`: `add_lines_to_move_detection`,
 * `mark_color_as_moved`, `dim_moved_lines`), byte for byte as `git diff --color=always`
 * prints them.
 *
 * @example
 * ```typescript
 * const colors = { ...DEFAULT_DIFF_COLORS, old: parseGitColor("magenta") ?? "" };
 * const patch = await formatPatch(pairs, { colors, colorMoved: "zebra" });
 * // "\x1b[1mdiff --git a/f b/f\x1b[m\n...\x1b[31m-old line\x1b[m\n..."
 * ```
 *
 * The palette ({@link DiffColors}) holds the escape sequence of each of git's
 * `color.diff.<slot>` slots; an empty string is git's `normal` (nothing written before the
 * text, a reset still written after it). With a palette, every `+` line (`-` and context
 * lines too, with `--ws-error-highlight`) shows the whitespace errors of the path's
 * whitespace rule (`core.whitespace`, the `whitespace` attribute) in the `whitespace` color.
 * Moved lines are found over all the files of one diff: a writer buffers the lines in a
 * {@link MovedLineBuffer} and {@link MovedLineBuffer.flushTo} marks and prints them.
 *
 * @module
 */

import { ByteSink, XDF_WHITESPACE_FLAGS, xdlHashRecord, xdlRecmatch } from "@statewalker/vcs-utils";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  checkBlankAtEof,
  isGitSpace,
  WS_BLANK_AT_EOF,
  WS_INCOMPLETE_LINE,
  WS_RULE_MASK,
  WS_TAB_WIDTH_MASK,
  wsBlankLine,
  wsCheckEmit,
} from "../whitespace/index.js";

/** git's color slots of the diff (`color.diff.<slot>`, diff.c's `color_diff_slots`) */
export const DIFF_COLOR_SLOTS = [
  "context",
  "meta",
  "frag",
  "old",
  "new",
  "commit",
  "whitespace",
  "func",
  "oldMoved",
  "oldMovedAlternative",
  "oldMovedDimmed",
  "oldMovedAlternativeDimmed",
  "newMoved",
  "newMovedAlternative",
  "newMovedDimmed",
  "newMovedAlternativeDimmed",
  "contextDimmed",
  "oldDimmed",
  "newDimmed",
  "contextBold",
  "oldBold",
  "newBold",
] as const;

/** One of {@link DIFF_COLOR_SLOTS} */
export type DiffColorSlot = (typeof DIFF_COLOR_SLOTS)[number];

/** The escape sequence of each slot ("" for `normal`), and the reset that ends one */
export type DiffColors = Record<DiffColorSlot, string> & { reset: string };

/** diff.c's `diff_colors`: git's default palette */
export const DEFAULT_DIFF_COLORS: Readonly<DiffColors> = Object.freeze({
  reset: "\x1b[m",
  context: "",
  meta: "\x1b[1m",
  frag: "\x1b[36m",
  old: "\x1b[31m",
  new: "\x1b[32m",
  commit: "\x1b[33m",
  whitespace: "\x1b[41m",
  func: "",
  oldMoved: "\x1b[1;35m",
  oldMovedAlternative: "\x1b[1;34m",
  oldMovedDimmed: "\x1b[2m",
  oldMovedAlternativeDimmed: "\x1b[2;3m",
  newMoved: "\x1b[1;36m",
  newMovedAlternative: "\x1b[1;33m",
  newMovedDimmed: "\x1b[2m",
  newMovedAlternativeDimmed: "\x1b[2;3m",
  contextDimmed: "\x1b[2m",
  oldDimmed: "\x1b[2;31m",
  newDimmed: "\x1b[2;32m",
  contextBold: "\x1b[1m",
  oldBold: "\x1b[1;31m",
  newBold: "\x1b[1;32m",
});

/** `parse_diff_color_slot`: the slot a `color.diff.<name>` names (any case), `plain` the context */
export function diffColorSlotOf(name: string): DiffColorSlot | undefined {
  const lower = name.toLowerCase();
  if (lower === "plain") return "context";
  return DIFF_COLOR_SLOTS.find((s) => s.toLowerCase() === lower);
}

/** `--color-moved=<mode>` (`default` is `zebra`) */
export type ColorMovedMode = "no" | "plain" | "blocks" | "zebra" | "dimmed-zebra";

/**
 * `parse_color_moved`: a boolean (`true` is `zebra`), `no`, `plain`, `blocks`, `zebra`,
 * `default`, `dimmed-zebra` (or `dimmed_zebra`); undefined for anything else
 */
export function parseColorMoved(arg: string | undefined): ColorMovedMode | undefined {
  const bool = maybeBool(arg);
  if (bool === false) return "no";
  if (bool === true) return "zebra";
  switch (arg) {
    case "no":
      return "no";
    case "plain":
    case "blocks":
    case "zebra":
      return arg;
    case "default":
      return "zebra";
    case "dimmed-zebra":
    case "dimmed_zebra":
      return "dimmed-zebra";
    default:
      return undefined;
  }
}

/** git's `git_parse_maybe_bool` (no value is true) */
function maybeBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return true;
  const v = value.toLowerCase();
  if (v === "" || v === "false" || v === "no" || v === "off") return false;
  if (v === "true" || v === "yes" || v === "on") return true;
  if (/^[-+]?\d+$/.test(v)) return Number(v) !== 0;
  return undefined;
}

/** The message git gives a `--color-moved` mode it does not know */
export const COLOR_MOVED_MODE_ERROR =
  "error: color moved setting must be one of 'no', 'default', 'blocks', 'zebra', 'dimmed-zebra', 'plain'";

/** `COLOR_MOVED_WS_ALLOW_INDENTATION_CHANGE` (the `XDF_*` whitespace bits are xdiff's) */
export const COLOR_MOVED_WS_ALLOW_INDENTATION_CHANGE = 1 << 5;
const XDF_IGNORE_WHITESPACE = 1 << 1;
const XDF_IGNORE_WHITESPACE_CHANGE = 1 << 2;
const XDF_IGNORE_WHITESPACE_AT_EOL = 1 << 3;

/**
 * `parse_color_moved_ws`: the comma-separated modes as flags, with git's `error:` lines
 * for the modes it refuses (the flags are not to be used then)
 */
export function parseColorMovedWs(arg: string): { flags: number; errors: string[] } {
  let flags = 0;
  const errors: string[] = [];
  for (const raw of arg.split(",")) {
    const item = raw.trim();
    if (item === "no") flags = 0;
    else if (item === "ignore-space-change") flags |= XDF_IGNORE_WHITESPACE_CHANGE;
    else if (item === "ignore-space-at-eol") flags |= XDF_IGNORE_WHITESPACE_AT_EOL;
    else if (item === "ignore-all-space") flags |= XDF_IGNORE_WHITESPACE;
    else if (item === "allow-indentation-change") flags |= COLOR_MOVED_WS_ALLOW_INDENTATION_CHANGE;
    else {
      errors.push(
        `error: unknown color-moved-ws mode '${item}', possible values are 'ignore-space-change', 'ignore-space-at-eol', 'ignore-all-space', 'allow-indentation-change'`,
      );
    }
  }
  if (flags & COLOR_MOVED_WS_ALLOW_INDENTATION_CHANGE && flags & XDF_WHITESPACE_FLAGS) {
    errors.push(
      "error: color-moved-ws: allow-indentation-change cannot be combined with other whitespace modes",
    );
  }
  return { flags, errors };
}

/** `WSEH_NEW`: whitespace errors highlighted on `+` lines */
export const WSEH_NEW = 1 << 16;
/** `WSEH_CONTEXT`: on context lines */
export const WSEH_CONTEXT = 1 << 17;
/** `WSEH_OLD`: on `-` lines */
export const WSEH_OLD = 1 << 18;

/**
 * `parse_ws_error_highlight`: `none`, `default`, `all`, `new`, `old`, `context`, comma
 * separated; undefined for anything else
 */
export function parseWsErrorHighlight(arg: string): number | undefined {
  const r = wsErrorHighlightOf(arg);
  return typeof r === "number" ? r : undefined;
}

/**
 * {@link parseWsErrorHighlight}, or for a value git refuses the text before the token it
 * stopped at (what its error message quotes)
 */
export function wsErrorHighlightOf(arg: string): number | { badPrefix: string } {
  let val = 0;
  let at = 0;
  const tokens: [string, (v: number) => number][] = [
    ["none", () => 0],
    ["default", () => WSEH_NEW],
    ["all", () => WSEH_NEW | WSEH_OLD | WSEH_CONTEXT],
    ["new", (v) => v | WSEH_NEW],
    ["old", (v) => v | WSEH_OLD],
    ["context", (v) => v | WSEH_CONTEXT],
  ];
  while (at < arg.length) {
    const found = tokens.find(
      ([t]) =>
        arg.startsWith(t, at) && (at + t.length === arg.length || arg[at + t.length] === ","),
    );
    if (!found) return { badPrefix: arg.slice(0, at) };
    val = found[1](val);
    at += found[0].length;
    if (at < arg.length) at++;
  }
  return val;
}

// flags of the emitted lines (diff.c's DIFF_SYMBOL_*)
const BLANK_LINE_EOF = 1 << 19;
const MOVED_LINE = 1 << 20;
const MOVED_LINE_ALT = 1 << 21;
const MOVED_LINE_UNINTERESTING = 1 << 22;
const ZEBRA_MASK = MOVED_LINE | MOVED_LINE_ALT;
const CONTENT_WS_MASK = WSEH_NEW | WSEH_OLD | WSEH_CONTEXT | WS_RULE_MASK;

/** `COLOR_MOVED_MIN_ALNUM_COUNT` */
const MIN_ALNUM_COUNT = 20;

/** git's `isalnum` (ASCII) */
const isAlnum = (c: number) =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** Bytes written as the colored output is built */
class Out {
  private parts: Uint8Array[] = [];
  private size = 0;

  str(s: string): void {
    if (s.length === 0) return;
    this.bytes(encodeGitPath(s));
  }

  bytes(b: Uint8Array): void {
    if (b.length === 0) return;
    this.parts.push(b);
    this.size += b.length;
  }

  byte(c: number): void {
    this.bytes(Uint8Array.of(c));
  }

  done(): Uint8Array {
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const p of this.parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}

/**
 * diff.c's `emit_line_0` (no line prefix): `setSign` before the sign, `set` before the
 * text, the reset after them, the CR and LF of the line after the reset
 */
function emitLine0(
  out: Out,
  setSign: string | undefined,
  set: string | undefined,
  reset: string,
  first: number,
  line: Uint8Array,
): void {
  let len = line.length;
  let needsReset = false;
  const hasNewline = len > 0 && line[len - 1] === 0x0a;
  if (hasNewline) len--;
  const hasCr = len > 0 && line[len - 1] === 0x0d;
  if (hasCr) len--;
  if (len > 0 || first) {
    if (setSign !== undefined) {
      out.str(setSign);
      needsReset = true;
    }
    if (first) out.byte(first);
    if (len > 0) {
      if (set !== undefined) {
        out.str(set);
        needsReset = true;
      }
      out.bytes(line.subarray(0, len));
      needsReset = true;
    }
  }
  if (needsReset) out.str(reset);
  if (hasCr) out.byte(0x0d);
  if (hasNewline) out.byte(0x0a);
}

/** What the colored writer needs besides the palette */
export interface ColoredLineOptions {
  colors: DiffColors;
  /** `--ws-error-highlight` (`WSEH_*` bits, default {@link WSEH_NEW}) */
  wsErrorHighlight: number;
}

/** diff.c's `emit_line_ws_markup` */
function emitLineWsMarkup(
  out: Out,
  o: ColoredLineOptions,
  set: string,
  sign: number,
  line: Uint8Array,
  wsRule: number,
  blankAtEof: boolean,
): void {
  const { reset } = o.colors;
  let ws: string | undefined;
  if (o.wsErrorHighlight & wsRule) {
    ws = o.colors.whitespace;
    if (!ws) ws = undefined;
  }
  if (ws === undefined) emitLine0(out, set, undefined, reset, sign, line);
  else if (blankAtEof) emitLine0(out, ws, undefined, reset, sign, line);
  else {
    emitLine0(out, set, undefined, reset, sign, new Uint8Array(0));
    wsCheckEmit(line, wsRule, out, set, reset, ws);
  }
}

/** A `+` or `-` line kept for move detection (diff.c's `emitted_diff_symbol`) */
interface ContentSymbol {
  kind: "+" | "-";
  /** The line without its sign, its LF included */
  line: Uint8Array;
  flags: number;
  id: number;
  indentOff: number;
  indentWidth: number;
}

/** Already printed bytes (headers, context lines), or a `+`/`-` line printed at the end */
type BufferedSymbol = { kind: "raw"; bytes: Uint8Array } | ContentSymbol;

/** diff.c's `DIFF_SYMBOL_PLUS` and `DIFF_SYMBOL_MINUS` */
function renderContent(out: Out, o: ColoredLineOptions, s: ContentSymbol): void {
  const c = o.colors;
  const moved = s.flags & (MOVED_LINE | MOVED_LINE_ALT | MOVED_LINE_UNINTERESTING);
  const plus = s.kind === "+";
  let set: string;
  switch (moved) {
    case MOVED_LINE | MOVED_LINE_ALT | MOVED_LINE_UNINTERESTING:
      set = plus ? c.newMovedAlternativeDimmed : c.oldMovedAlternativeDimmed;
      break;
    case MOVED_LINE | MOVED_LINE_ALT:
      set = plus ? c.newMovedAlternative : c.oldMovedAlternative;
      break;
    case MOVED_LINE | MOVED_LINE_UNINTERESTING:
      set = plus ? c.newMovedDimmed : c.oldMovedDimmed;
      break;
    case MOVED_LINE:
      set = plus ? c.newMoved : c.oldMoved;
      break;
    default:
      set = plus ? c.new : c.old;
  }
  emitLineWsMarkup(
    out,
    o,
    set,
    plus ? 0x2b : 0x2d,
    s.line,
    s.flags & CONTENT_WS_MASK,
    plus && (s.flags & BLANK_LINE_EOF) !== 0,
  );
}

/**
 * The output of one diff's patches while moved lines are looked for: what the writers push
 * is kept, `+` and `-` lines apart ({@link MovedLineBuffer.content}), until
 * {@link MovedLineBuffer.flushTo} marks the moved lines and prints everything.
 */
export class MovedLineBuffer extends ByteSink {
  private readonly symbols: BufferedSymbol[] = [];
  private buffered = 0;

  constructor(
    private readonly mode: Exclude<ColorMovedMode, "no">,
    /** `--color-moved-ws` flags */
    private readonly wsFlags: number,
  ) {
    super();
  }

  override push(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.symbols.push({ kind: "raw", bytes });
    this.buffered += bytes.length;
  }

  override get length(): number {
    return this.buffered;
  }

  override bytes(): Uint8Array {
    throw new Error("MovedLineBuffer: flushTo() prints the buffered output");
  }

  /** A `+` or `-` line (the line without its sign, LF included) and its flags */
  content(kind: "+" | "-", line: Uint8Array, flags: number): void {
    this.symbols.push({ kind, line, flags, id: 0, indentOff: 0, indentWidth: 0 });
    // the printed size does not matter, only that something was printed
    this.buffered += line.length + 1;
  }

  /** diff_flush_patch_all_file_pairs' end: marks the moved lines and prints everything */
  flushTo(sink: ByteSink, o: ColoredLineOptions): void {
    const list = addLinesToMoveDetection(this.symbols, this.wsFlags);
    markColorAsMoved(this.symbols, list, this.mode, this.wsFlags);
    if (this.mode === "dimmed-zebra") dimMovedLines(this.symbols);
    for (const s of this.symbols) {
      if (s.kind === "raw") sink.push(s.bytes);
      else {
        const out = new Out();
        renderContent(out, o, s);
        sink.push(out.done());
      }
    }
    this.symbols.length = 0;
    this.buffered = 0;
  }
}

const INDENT_BLANKLINE = -2147483648;

/** `fill_es_indent_data` */
function fillIndentData(s: ContentSymbol): void {
  const line = s.line;
  const len = line.length;
  const tabWidth = s.flags & WS_TAB_WIDTH_MASK;
  let off = 0;
  let width = 0;
  while (
    off < len &&
    (line[off] === 0x0c || line[off] === 0x0b || (off < len - 1 && line[off] === 0x0d))
  )
    off++;
  for (;;) {
    if (line[off] === 0x20) {
      width++;
      off++;
    } else if (line[off] === 0x09) {
      width += tabWidth - (width % tabWidth);
      while (line[++off] === 0x09) width += tabWidth;
    } else break;
  }
  let i = off;
  for (; i < len; i++) if (!isGitSpace(line[i] as number)) break;
  if (i === len) {
    s.indentWidth = INDENT_BLANKLINE;
    s.indentOff = len;
  } else {
    s.indentOff = off;
    s.indentWidth = width;
  }
}

interface MovedEntry {
  es: ContentSymbol;
  nextLine?: MovedEntry;
  nextMatch?: MovedEntry;
}

interface MovedBlock {
  match: MovedEntry | undefined;
  wsd: number;
}

/** `add_lines_to_move_detection`: each `+`/`-` line's id, and the lines of each id */
function addLinesToMoveDetection(
  symbols: BufferedSymbol[],
  wsFlags: number,
): { add?: MovedEntry; del?: MovedEntry }[] {
  const flags = wsFlags & XDF_WHITESPACE_FLAGS;
  const interned = new Map<number, ContentSymbol[]>();
  const list: { add?: MovedEntry; del?: MovedEntry }[] = [];
  let prev: MovedEntry | undefined;
  for (const l of symbols) {
    if (l.kind === "raw") {
      prev = undefined;
      continue;
    }
    if (wsFlags & COLOR_MOVED_WS_ALLOW_INDENTATION_CHANGE) fillIndentData(l);
    const hash = xdlHashRecord(l.line, l.indentOff, l.line.length, flags);
    let bucket = interned.get(hash);
    if (!bucket) {
      bucket = [];
      interned.set(hash, bucket);
    }
    const same = bucket.find((s) =>
      xdlRecmatch(s.line, s.indentOff, s.line.length, l.line, l.indentOff, l.line.length, flags),
    );
    if (same) l.id = same.id;
    else {
      l.id = list.length;
      list.push({});
      bucket.push(l);
    }
    const entry: MovedEntry = { es: l };
    if (prev && prev.es.kind === l.kind) prev.nextLine = entry;
    prev = entry;
    const slot = list[l.id] as { add?: MovedEntry; del?: MovedEntry };
    if (l.kind === "+") {
      entry.nextMatch = slot.add;
      slot.add = entry;
    } else {
      entry.nextMatch = slot.del;
      slot.del = entry;
    }
  }
  return list;
}

/** `cmp_in_block_with_wsd`: whether `l` does not continue the block (true: no match) */
function cmpInBlockWithWsd(cur: MovedEntry, l: ContentSymbol, pmb: MovedBlock): boolean {
  if (cur.es.id !== l.id) return true;
  const aWidth = cur.es.indentWidth;
  if (aWidth === INDENT_BLANKLINE) return false;
  const delta = l.indentWidth - aWidth;
  if (pmb.wsd === INDENT_BLANKLINE) pmb.wsd = delta;
  return delta !== pmb.wsd;
}

/** `compute_ws_delta` */
function computeWsDelta(a: ContentSymbol, b: ContentSymbol): number {
  if (a.indentWidth === INDENT_BLANKLINE && b.indentWidth === INDENT_BLANKLINE)
    return INDENT_BLANKLINE;
  return a.indentWidth - b.indentWidth;
}

/** `mark_color_as_moved` */
function markColorAsMoved(
  symbols: BufferedSymbol[],
  list: { add?: MovedEntry; del?: MovedEntry }[],
  mode: Exclude<ColorMovedMode, "no">,
  wsFlags: number,
): void {
  const allowIndent = (wsFlags & COLOR_MOVED_WS_ALLOW_INDENTATION_CHANGE) !== 0;
  let pmb: MovedBlock[] = [];
  let flippedBlock = 0;
  let blockLength = 0;
  let movedSymbol: "+" | "-" | undefined;

  /** `adjust_last_block`: unmarks a block of too few alphanumerics; whether it stays */
  const adjustLastBlock = (n: number, length: number): boolean => {
    if (mode === "plain") return length !== 0;
    let alnum = 0;
    for (let i = 1; i < length + 1; i++) {
      const s = symbols[n - i] as BufferedSymbol;
      const line = s.kind === "raw" ? s.bytes : s.line;
      for (let k = 0; k < line.length && line[k] !== 0; k++) {
        if (!isAlnum(line[k] as number)) continue;
        alnum++;
        if (alnum >= MIN_ALNUM_COUNT) return true;
      }
    }
    for (let i = 1; i < length + 1; i++) {
      const s = symbols[n - i] as BufferedSymbol;
      if (s.kind !== "raw") s.flags &= ~ZEBRA_MASK;
    }
    return false;
  };

  let n = 0;
  for (; n < symbols.length; n++) {
    const l = symbols[n] as BufferedSymbol;
    let match: MovedEntry | undefined;
    if (l.kind === "+") match = list[l.id]?.del;
    else if (l.kind === "-") match = list[l.id]?.add;
    else flippedBlock = 0;

    if (pmb.length > 0 && (!match || l.kind !== movedSymbol)) {
      if (!adjustLastBlock(n, blockLength) && blockLength > 1) {
        // rewind in case there is another match starting at the second line of the block
        match = undefined;
        n -= blockLength;
      }
      pmb = [];
      blockLength = 0;
      flippedBlock = 0;
    }
    if (!match || l.kind === "raw") {
      movedSymbol = undefined;
      continue;
    }
    if (mode === "plain") {
      l.flags |= MOVED_LINE;
      continue;
    }

    // pmb_advance_or_null
    const kept: MovedBlock[] = [];
    for (const block of pmb) {
      const prev = block.match;
      const cur = prev?.nextLine;
      const ok = allowIndent
        ? cur !== undefined && !cmpInBlockWithWsd(cur, l, block)
        : cur !== undefined && cur.es.id === l.id;
      if (ok) {
        block.match = cur;
        kept.push(block);
      }
    }
    pmb = kept;

    if (pmb.length === 0) {
      const contiguous = adjustLastBlock(n, blockLength);
      if (!contiguous && blockLength > 1) {
        // rewind in case there is another match starting at the second line of the block
        n -= blockLength;
      } else {
        // fill_potential_moved_blocks
        for (let m: MovedEntry | undefined = match; m; m = m.nextMatch) {
          pmb.push({ match: m, wsd: allowIndent ? computeWsDelta(l, m.es) : 0 });
        }
      }
      if (contiguous && pmb.length > 0 && movedSymbol === l.kind)
        flippedBlock = (flippedBlock + 1) % 2;
      else flippedBlock = 0;
      movedSymbol = pmb.length > 0 ? l.kind : undefined;
      blockLength = 0;
    }

    if (pmb.length > 0) {
      blockLength++;
      l.flags |= MOVED_LINE;
      if (flippedBlock && mode !== "blocks") l.flags |= MOVED_LINE_ALT;
    }
  }
  adjustLastBlock(n, blockLength);
}

/** `dim_moved_lines` */
function dimMovedLines(symbols: BufferedSymbol[]): void {
  for (let n = 0; n < symbols.length; n++) {
    const l = symbols[n] as BufferedSymbol;
    if (l.kind === "raw") continue;
    if (!(l.flags & MOVED_LINE)) continue;
    let prev = n > 0 ? symbols[n - 1] : undefined;
    let next = n < symbols.length - 1 ? symbols[n + 1] : undefined;
    if (prev && prev.kind === "raw") prev = undefined;
    if (next && next.kind === "raw") next = undefined;
    const p = prev as ContentSymbol | undefined;
    const x = next as ContentSymbol | undefined;
    if (
      p &&
      (p.flags & ZEBRA_MASK) === (l.flags & ZEBRA_MASK) &&
      x &&
      (x.flags & ZEBRA_MASK) === (l.flags & ZEBRA_MASK)
    ) {
      l.flags |= MOVED_LINE_UNINTERESTING;
      continue;
    }
    if (p && p.flags & MOVED_LINE && (p.flags & MOVED_LINE_ALT) !== (l.flags & MOVED_LINE_ALT))
      continue;
    if (x && x.flags & MOVED_LINE && (x.flags & MOVED_LINE_ALT) !== (l.flags & MOVED_LINE_ALT))
      continue;
    l.flags |= MOVED_LINE_UNINTERESTING;
  }
}

/** A text line of a hunk as {@link writeColoredHunks} gets it */
export interface ColoredHunkLine {
  kind: " " | "-" | "+";
  /** The line without its sign; an incomplete last line without LF */
  bytes: Uint8Array;
}

/** A hunk: its header (as git prints it, LF included) and lines */
export interface ColoredHunk {
  header: Uint8Array;
  oldStart: number;
  newStart: number;
  lines: ColoredHunkLine[];
}

/** What {@link writeColoredHunks} knows of the pair */
export interface ColoredPatchContext extends ColoredLineOptions {
  /** The whitespace rule of the path (`whitespace_rule`) */
  wsRule: number;
  /** The two sides' contents, for `blank-at-eof` (`check_blank_at_eof`) */
  oldContent: Uint8Array;
  newContent: Uint8Array;
}

/**
 * The hunks of a text pair as diff.c's `fn_out_consume` prints them in color: the header
 * in `frag` (`func` for its function line), each line in its color with its whitespace
 * errors marked; into a {@link MovedLineBuffer}, the `+` and `-` lines are kept for move
 * detection.
 */
export function writeColoredHunks(
  sink: ByteSink,
  hunks: readonly ColoredHunk[],
  ctx: ColoredPatchContext,
): void {
  const c = ctx.colors;
  const reset = c.reset;
  const buffer = sink instanceof MovedLineBuffer ? sink : undefined;
  // check_blank_at_eof
  let blankPre = 0;
  let blankPost = 0;
  if (ctx.wsRule & WS_BLANK_AT_EOF) {
    const at = checkBlankAtEof(ctx.oldContent, ctx.newContent);
    blankPre = at.preimage;
    blankPost = at.postimage;
  }
  const emit = (out: Out) => sink.push(out.done());
  for (const hunk of hunks) {
    emit(hunkHeader(hunk.header, c));
    let lnoPre = hunk.oldStart;
    let lnoPost = hunk.newStart;
    let lastKind = "";
    for (const line of hunk.lines) {
      const complete = line.bytes.length > 0 && line.bytes[line.bytes.length - 1] === 0x0a;
      // xdl_emit_diffrec: an incomplete line gets its LF, then the marker
      const text = complete ? line.bytes : withNewline(line.bytes);
      if (line.kind === "+") {
        lnoPost++;
        let flags = WSEH_NEW | ctx.wsRule;
        if (
          ctx.wsRule & WS_BLANK_AT_EOF &&
          blankPre &&
          blankPost &&
          blankPre <= lnoPre &&
          blankPost <= lnoPost &&
          wsBlankLine(text, 0, text.length)
        )
          flags |= BLANK_LINE_EOF;
        if (buffer) buffer.content("+", text, flags);
        else {
          const out = new Out();
          renderContent(out, ctx, {
            kind: "+",
            line: text,
            flags,
            id: 0,
            indentOff: 0,
            indentWidth: 0,
          });
          emit(out);
        }
      } else if (line.kind === "-") {
        lnoPre++;
        const flags = WSEH_OLD | ctx.wsRule;
        if (buffer) buffer.content("-", text, flags);
        else {
          const out = new Out();
          renderContent(out, ctx, {
            kind: "-",
            line: text,
            flags,
            id: 0,
            indentOff: 0,
            indentWidth: 0,
          });
          emit(out);
        }
      } else {
        lnoPre++;
        lnoPost++;
        const out = new Out();
        emitLineWsMarkup(
          out,
          ctx,
          c.context,
          0x20,
          text,
          (WSEH_CONTEXT | ctx.wsRule) & CONTENT_WS_MASK,
          false,
        );
        emit(out);
      }
      lastKind = line.kind;
      if (!complete && line.bytes.length > 0) {
        // emit_incomplete_line_marker
        lnoPre++;
        const flags =
          (lastKind === "+" ? WSEH_NEW : lastKind === "-" ? WSEH_OLD : WSEH_CONTEXT) | ctx.wsRule;
        const set =
          flags & WS_INCOMPLETE_LINE && flags & ctx.wsErrorHighlight ? c.whitespace : c.context;
        const out = new Out();
        emitLine0(out, set, undefined, reset, 0, NO_NEWLINE);
        emit(out);
      }
    }
  }
}

const NO_NEWLINE = encodeGitPath("\\ No newline at end of file\n");

function withNewline(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  out[bytes.length] = 0x0a;
  return out;
}

/** diff.c's `emit_hunk_header` (the header as xdiff made it, LF included) */
function hunkHeader(line: Uint8Array, c: DiffColors): Out {
  const out = new Out();
  const orgLen = line.length;
  let len = orgLen;
  // the second "@@"
  let ep = -1;
  for (let i = 2; i + 1 < len; i++) {
    if (line[i] === 0x40 && line[i + 1] === 0x40) {
      ep = i;
      break;
    }
  }
  if (len < 10 || line[0] !== 0x40 || line[1] !== 0x40 || ep < 0) {
    // DIFF_SYMBOL_CONTEXT_MARKER
    emitLine0(out, c.context, undefined, c.reset, 0, line);
    return out;
  }
  ep += 2;
  out.str(c.frag);
  out.bytes(line.subarray(0, ep));
  out.str(c.reset);
  // trailing "\r\n", as git counts it
  for (let i = 1; i < 3; i++) {
    const ch = line[len - i];
    if (ch === 0x0d || ch === 0x0a) len--;
  }
  const cp = ep;
  while (ep < len && (line[ep] === 0x20 || line[ep] === 0x09)) ep++;
  if (ep !== cp) {
    out.str(c.context);
    out.bytes(line.subarray(cp, ep));
    out.str(c.reset);
  }
  if (ep < len) {
    out.str(c.func);
    out.bytes(line.subarray(ep, len));
    out.str(c.reset);
  }
  out.bytes(line.subarray(len, orgLen));
  // strbuf_complete_line
  if (orgLen === len || line[orgLen - 1] !== 0x0a) out.byte(0x0a);
  return out;
}

/**
 * diff.c's `emit_hunk_header` in color: the `@@ ... @@` part in `frag`, the function line in
 * `func` (the header as xdiff made it, LF included)
 */
export function coloredHunkHeader(line: Uint8Array, c: DiffColors): Uint8Array {
  return hunkHeader(line, c).done();
}
