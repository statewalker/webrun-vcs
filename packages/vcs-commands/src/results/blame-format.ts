/**
 * `git blame` output of a {@link BlameResult}: the porcelain formats (`--porcelain`,
 * `--line-porcelain`) and the default one, byte for byte as git prints them.
 *
 * @example
 * ```typescript
 * const result = await git.blame().setFilePath("README.md").call();
 * process.stdout.write(formatBlamePorcelain(result));
 * process.stdout.write(formatBlame(result)); // ^1234567 (Alice 2024-01-02 10:00:00 +0100 1) line
 * ```
 *
 * @module
 */

import { approxidateCareful, ByteSink } from "@statewalker/vcs-utils";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import type { BlameEntry, BlameResult } from "../commands/blame-command.js";
import { parseGitColor } from "../commands/config-value-types.js";
import {
  type DateMode,
  parseDateMode,
  type ShowDateContext,
  showDate,
} from "../commands/date-format.js";
import { displayWidth } from "./diff-output.js";
import { quotePath } from "./quote-path.js";

/** Options of {@link formatBlamePorcelain} */
export interface BlamePorcelainOptions {
  /** Repeat the commit details on every line (`--line-porcelain`) */
  linePorcelain?: boolean;
  /** `core.quotePath` (default true) */
  quotePath?: boolean;
  /** An `ignored` line under each ignored line (default the result's `markIgnoredLines`) */
  markIgnoredLines?: boolean;
  /** An `unblamable` line under each (default the result's `markUnblamableLines`) */
  markUnblamableLines?: boolean;
  /**
   * Whether the `ignored`/`unblamable` lines are written at all: git 2.50+ writes them
   * (default true), older git marks only its default output
   */
  lineMarks?: boolean;
}

/** Options of {@link formatBlame} (git's default output) */
export interface BlameFormatOptions {
  /** Show the source path (`-f`); on by itself when a line comes from another path */
  showName?: boolean;
  /** Show the source line number (`-n`) */
  showNumber?: boolean;
  /** Full object ids (`-l`) */
  longObjectName?: boolean;
  /** Raw timestamps (`-t`) */
  rawTimestamp?: boolean;
  /** The author's email instead of the name (`-e`, `blame.showEmail`) */
  showEmail?: boolean;
  /** No author and date (`-s`) */
  noAuthor?: boolean;
  /** Blank object ids for boundary commits (`-b`, `blame.blankBoundary`) */
  blankBoundary?: boolean;
  /** Abbreviated id length (`--abbrev`); unset, the automatic length (`autoAbbrev`) */
  abbrev?: number;
  /**
   * The automatic length git finds without `--abbrev` (`BlameResult.autoAbbrev()`: the
   * commits' unique abbreviations, from `core.abbrev`); default 7
   */
  autoAbbrev?: number;
  /**
   * One more hex digit always (room for a `^`), as git before 2.5x printed; newer git adds
   * it only when a boundary commit is shown (default false)
   */
  alwaysWidenAbbrev?: boolean;
  /** `?` before the ids of ignored lines (default the result's `markIgnoredLines`) */
  markIgnoredLines?: boolean;
  /** `*` before the ids of unblamable lines (default the result's `markUnblamableLines`) */
  markUnblamableLines?: boolean;
  /**
   * git annotate's columns (`-c`): `<id>\t(<author>\t<date>\t<line>)<text>`, no boundary
   * marks and no colors
   */
  annotate?: boolean;
  /**
   * The date mode (`--date`, a `DateMode` or as written; default the result's `blame.date`,
   * else `iso`)
   */
  date?: DateMode | string;
  /** What relative and human dates and `color.blame.highlightRecent` are relative to */
  dateContext?: ShowDateContext;
  /**
   * Color the metadata of a line repeating the previous line's commit (`--color-lines`).
   * With neither this nor `colorByAge`, the result's `blame.coloring` applies.
   */
  colorLines?: boolean;
  /** Color the metadata by the author's date (`--color-by-age`) */
  colorByAge?: boolean;
  /**
   * `--color-lines` repeats only within an entry, not across adjacent entries of one commit
   * (git before 2.54, whose `--ignore-rev` left such entries; default false)
   */
  colorLinesWithinEntries?: boolean;
  /** `color.blame.repeatedLines`'s escape sequence (default the result's, else cyan) */
  repeatedLinesColor?: string;
  /**
   * `color.blame.highlightRecent`: `<color>,<date>,<color>,...` (default the result's, else
   * `blue,12 month ago,white,1 month ago,red`)
   */
  highlightRecent?: string;
}

/** An error git dies with on a bad `color.blame.highlightRecent` */
export class BlameColorError extends Error {}

const GIT_COLOR_RESET = "\x1b[m";
const GIT_COLOR_CYAN = "\x1b[36m";
const DEFAULT_HIGHLIGHT_RECENT = "blue,12 month ago,white,1 month ago,red";

/** The commit's subject as `find_commit_subject` finds it: its first non-blank line */
function subjectOf(message: string, id: string): string {
  const lines = message.split("\n");
  let i = 0;
  while (i < lines.length && /^[ \t\r\v\f]*$/.test(lines[i]) && i < lines.length - 1) i++;
  const subject = i < lines.length && !/^[ \t\r\v\f]*$/.test(lines[i]) ? lines[i] : "";
  return subject.length > 0 ? subject : `(${id})`;
}

/** The lines of the blamed file, each with its terminator */
function fileLines(content: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === 0x0a) {
      out.push(content.subarray(start, i + 1));
      start = i + 1;
    }
  }
  if (start < content.length) out.push(content.subarray(start));
  return out;
}

/** Commits blamed for more than one path (git's `MORE_THAN_ONE_PATH`) */
function multiPathCommits(entries: BlameEntry[]): Set<string> {
  const paths = new Map<string, Set<string>>();
  for (const e of entries) {
    let set = paths.get(e.commitId);
    if (!set) {
      set = new Set();
      paths.set(e.commitId, set);
    }
    set.add(e.sourcePath);
  }
  const out = new Set<string>();
  for (const [id, set] of paths) if (set.size > 1) out.add(id);
  return out;
}

/** `git blame --porcelain` (or `--line-porcelain`) */
export function formatBlamePorcelain(
  result: BlameResult,
  options: BlamePorcelainOptions = {},
): Uint8Array {
  const quote = options.quotePath ?? true;
  const repeat = options.linePorcelain ?? false;
  const lineMarks = options.lineMarks ?? true;
  const markIgnored = lineMarks && (options.markIgnoredLines ?? result.markIgnoredLines ?? false);
  const markUnblamable =
    lineMarks && (options.markUnblamableLines ?? result.markUnblamableLines ?? false);
  // emit_porcelain_per_line_details
  const perLine = (e: BlameEntry) => {
    if (markUnblamable && e.unblamable) sink.text("unblamable\n");
    if (markIgnored && e.ignored) sink.text("ignored\n");
  };
  const lines = fileLines(result.content ?? new Uint8Array(0));
  const multi = multiPathCommits(result.entries);
  const shown = new Set<string>();
  const sink = new ByteSink();
  const details = (e: BlameEntry, force: boolean) => {
    let wrote = false;
    if (force || !shown.has(e.commitId)) {
      shown.add(e.commitId);
      const c = e.commit;
      sink.text(
        `author ${c.author.name}\nauthor-mail <${c.author.email}>\nauthor-time ${c.author.timestamp}\nauthor-tz ${c.author.tzOffset}\n` +
          `committer ${c.committer.name}\ncommitter-mail <${c.committer.email}>\ncommitter-time ${c.committer.timestamp}\ncommitter-tz ${c.committer.tzOffset}\n` +
          `summary ${subjectOf(c.message, e.commitId)}\n`,
      );
      if (e.boundary) sink.text("boundary\n");
      wrote = true;
    }
    if (wrote || multi.has(e.commitId)) {
      if (e.previous)
        sink.text(`previous ${e.previous.commitId} ${quotePath(e.previous.path, quote)}\n`);
      sink.text(`filename ${quotePath(e.sourcePath, quote)}\n`);
    }
  };
  for (const e of result.entries) {
    sink.text(`${e.commitId} ${e.sourceStart} ${e.resultStart} ${e.lineCount}\n`);
    details(e, repeat);
    perLine(e);
    let last: Uint8Array | undefined;
    for (let cnt = 0; cnt < e.lineCount; cnt++) {
      if (cnt) {
        sink.text(`${e.commitId} ${e.sourceStart + cnt} ${e.resultStart + cnt}\n`);
        if (repeat) details(e, true);
        perLine(e);
      }
      last = lines[e.resultStart - 1 + cnt] ?? new Uint8Array(0);
      sink.text("\t");
      sink.push(last);
    }
    if (last && last.length > 0 && last[last.length - 1] !== 0x0a) sink.text("\n");
  }
  return sink.bytes();
}

/**
 * builtin/blame.c's `parse_color_fields`: the colors and the dates they end at (the last
 * one never ends)
 */
function parseColorFields(spec: string, now?: number): Array<{ hop: number; color: string }> {
  const fields: Array<{ hop: number; color: string }> = [];
  let color: string | undefined;
  for (const item of spec.split(",")) {
    if (color === undefined) {
      const parsed = parseGitColor(item);
      if (parsed === undefined) throw new BlameColorError(`fatal: expecting a color: ${item}`);
      color = parsed;
    } else {
      fields.push({ hop: approxidateCareful(item, now).timestamp, color });
      color = undefined;
    }
  }
  if (color === undefined) throw new BlameColorError("fatal: must end with a color");
  fields.push({ hop: Number.POSITIVE_INFINITY, color });
  return fields;
}

/** The width git pads dates to (`blame_date_width`) */
function dateWidth(mode: DateMode): number {
  switch (mode.type) {
    case "rfc2822":
      return "Thu, 19 Oct 2006 16:00:04 -0700".length;
    case "iso8601-strict":
      return "2006-10-19T16:00:04-07:00".length;
    case "iso8601":
      return "2006-10-19 16:00:04 -0700".length;
    case "raw":
      return "1161298804 -0700".length;
    case "unix":
      return "1161298804".length;
    case "short":
      return "2006-10-19".length;
    case "relative":
      return "4 years, 11 months ago".length;
    case "human":
      return "Thu Oct 19 16:00".length;
    case "normal":
      return "Thu Oct 19 16:00:04 2006 -0700".length;
    case "strftime":
      return new TextEncoder().encode(showDate(0, "+0000", mode)).length;
  }
}

/** printf's `%*s`: right-aligned in `width` bytes */
function padBytes(text: string, width: number): string {
  const n = new TextEncoder().encode(text).length;
  return n >= width ? text : " ".repeat(width - n) + text;
}

/**
 * git's default `blame` output (and `blame -c`, git annotate's columns, with `annotate`)
 *
 * @throws BlameColorError for a `highlightRecent` git cannot parse
 */
export function formatBlame(result: BlameResult, options: BlameFormatOptions = {}): Uint8Array {
  const lines = fileLines(result.content ?? new Uint8Array(0));
  const entries = result.entries;
  const config = result.output ?? {};
  const annotate = options.annotate ?? false;
  let showName = options.showName ?? false;
  let longestFile = 0;
  let longestAuthor = 0;
  let longestSrc = 0;
  let longestDst = 0;
  let maxMarks = 0;
  const seen = new Set<string>();
  const showEmail = options.showEmail ?? config.showEmail ?? false;
  const blankBoundary = options.blankBoundary ?? config.blankBoundary ?? false;
  const authorOf = (e: BlameEntry) =>
    showEmail ? `<${e.commit.author.email}>` : e.commit.author.name;
  const markIgnored = options.markIgnoredLines ?? result.markIgnoredLines ?? false;
  const markUnblamable = options.markUnblamableLines ?? result.markUnblamableLines ?? false;
  /** print_marks: `^` for a boundary (not with -b or -c), `*` unblamable, `?` ignored */
  const marksOf = (e: BlameEntry) =>
    (e.boundary && !blankBoundary && !annotate ? "^" : "") +
    (markUnblamable && e.unblamable ? "*" : "") +
    (markIgnored && e.ignored ? "?" : "");
  for (const e of entries) {
    const marks = marksOf(e).length;
    if (maxMarks < marks) maxMarks = marks;
    if (e.sourcePath !== result.path) showName = true;
    const len = encodeGitPath(e.sourcePath).length;
    if (longestFile < len) longestFile = len;
    if (!seen.has(e.commitId)) {
      seen.add(e.commitId);
      const w = displayWidth(authorOf(e));
      if (longestAuthor < w) longestAuthor = w;
    }
    longestSrc = Math.max(longestSrc, e.sourceStart - 1 + e.lineCount);
    longestDst = Math.max(longestDst, e.resultStart - 1 + e.lineCount);
  }
  const maxOrigDigits = String(longestSrc).length;
  const maxDigits = String(longestDst).length;
  // git 2.5x widens by the marks shown (a "^"); older git always by one (`--abbrev=0` and
  // a full automatic length aside)
  const auto = options.abbrev === undefined;
  let abbrev = auto ? (options.autoAbbrev ?? 7) : options.abbrev || 40;
  if (!options.alwaysWidenAbbrev) {
    if (abbrev < 40) abbrev = Math.min(40, abbrev + maxMarks);
  } else if (auto || abbrev < 40) {
    abbrev += 1;
  }

  const dateOption = options.date ?? config.date ?? "iso";
  const mode = typeof dateOption === "string" ? parseDateMode(dateOption) : dateOption;
  const width = dateWidth(mode);
  const context = options.dateContext ?? {};
  const formatTime = (c: BlameEntry["commit"]) => {
    if (options.rawTimestamp) return `${c.author.timestamp} ${c.author.tzOffset}`;
    const text = showDate(c.author.timestamp, c.author.tzOffset, mode, context);
    const w = displayWidth(text);
    return w < width ? text + " ".repeat(width - w) : text;
  };

  // colors: the command line's, else blame.coloring; never with -c
  let colorLines = options.colorLines ?? false;
  let colorByAge = options.colorByAge ?? false;
  if (!colorLines && !colorByAge) {
    colorLines = config.colorLines ?? false;
    colorByAge = config.colorByAge ?? false;
  }
  if (annotate) colorLines = colorByAge = false;
  const repeatedColor =
    (options.repeatedLinesColor ?? config.repeatedLinesColor ?? "") || GIT_COLOR_CYAN;
  const colorFields = parseColorFields(
    options.highlightRecent ?? config.highlightRecent ?? DEFAULT_HIGHLIGHT_RECENT,
    context.now,
  );

  const sink = new ByteSink();
  let prev: BlameEntry | undefined;
  for (const e of entries) {
    const c = e.commit;
    let defaultColor: string | undefined;
    let color: string | undefined;
    let reset: string | undefined;
    if (colorByAge) {
      // determine_line_heat
      let i = 0;
      while (i < colorFields.length - 1 && c.author.timestamp > colorFields[i].hop) i++;
      defaultColor = colorFields[i].color;
      color = defaultColor;
      reset = GIT_COLOR_RESET;
    }
    let last: Uint8Array | undefined;
    for (let cnt = 0; cnt < e.lineCount; cnt++) {
      if (colorLines) {
        if (cnt > 0 || (!options.colorLinesWithinEntries && prev && prev.commitId === e.commitId)) {
          color = repeatedColor;
          reset = GIT_COLOR_RESET;
        } else {
          color = defaultColor;
          reset = defaultColor ? GIT_COLOR_RESET : undefined;
        }
      }
      let length = options.longObjectName ? 40 : abbrev;
      let hex = e.commitId;
      if (e.boundary && blankBoundary) hex = " ".repeat(hex.length);
      const marks = marksOf(e);
      let line = (color ?? "") + marks;
      length -= marks.length;
      line += hex.slice(0, Math.max(0, Math.min(length, 40)));
      if (annotate) {
        line += `\t(${padBytes(authorOf(e), 10)}\t${padBytes(formatTime(c), 10)}\t${
          e.resultStart + cnt
        })`;
      } else {
        if (showName) {
          const pad = Math.max(0, longestFile - encodeGitPath(e.sourcePath).length);
          line += ` ${e.sourcePath}${" ".repeat(pad)}`;
        }
        if (options.showNumber) {
          line += ` ${String(e.sourceStart + cnt).padStart(maxOrigDigits)}`;
        }
        if (!options.noAuthor) {
          const name = authorOf(e);
          const pad = Math.max(0, longestAuthor - displayWidth(name));
          line += ` (${name}${" ".repeat(pad)} ${padBytes(formatTime(c), 10)}`;
        }
        line += ` ${String(e.resultStart + cnt).padStart(maxDigits)}) `;
      }
      if (reset) line += reset;
      sink.text(line);
      last = lines[e.resultStart - 1 + cnt] ?? new Uint8Array(0);
      sink.push(last);
    }
    if (last && last.length > 0 && last[last.length - 1] !== 0x0a) sink.text("\n");
    prev = e;
  }
  return sink.bytes();
}

/** Options of {@link formatAnnotate} */
export type AnnotateFormatOptions = Omit<
  BlameFormatOptions,
  "annotate" | "date" | "colorLines" | "colorByAge" | "showName" | "showNumber" | "noAuthor"
>;

/**
 * `git annotate`: blame's `-c` columns with ISO dates whatever `--date` says (only the
 * `-local` of `blame.date` is kept, as git keeps it)
 */
export function formatAnnotate(
  result: BlameResult,
  options: AnnotateFormatOptions = {},
): Uint8Array {
  const configured = result.output?.date;
  let local = false;
  if (configured !== undefined) {
    try {
      local = parseDateMode(configured).local;
    } catch {
      local = false;
    }
  }
  return formatBlame(result, { ...options, annotate: true, date: { type: "iso8601", local } });
}

/** `git blame --incremental`: each entry as blame found it, with its commit's details once */
export function formatBlameIncremental(
  result: BlameResult,
  options: Pick<BlamePorcelainOptions, "quotePath"> = {},
): Uint8Array {
  const quote = options.quotePath ?? true;
  const shown = new Set<string>();
  const sink = new ByteSink();
  for (const e of result.incremental ?? []) {
    sink.text(`${e.commitId} ${e.sourceStart} ${e.resultStart} ${e.lineCount}\n`);
    if (!shown.has(e.commitId)) {
      shown.add(e.commitId);
      const c = e.commit;
      sink.text(
        `author ${c.author.name}\nauthor-mail <${c.author.email}>\nauthor-time ${c.author.timestamp}\nauthor-tz ${c.author.tzOffset}\n` +
          `committer ${c.committer.name}\ncommitter-mail <${c.committer.email}>\ncommitter-time ${c.committer.timestamp}\ncommitter-tz ${c.committer.tzOffset}\n` +
          `summary ${subjectOf(c.message, e.commitId)}\n`,
      );
      if (e.boundary) sink.text("boundary\n");
    }
    if (e.previous) {
      sink.text(`previous ${e.previous.commitId} ${quotePath(e.previous.path, quote)}\n`);
    }
    sink.text(`filename ${quotePath(e.sourcePath, quote)}\n`);
  }
  return sink.bytes();
}
