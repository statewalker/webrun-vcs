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

import { ByteSink } from "@statewalker/vcs-utils";
import type { BlameEntry, BlameResult } from "../commands/blame-command.js";
import { displayWidth } from "./diff-output.js";
import { quotePath } from "./quote-path.js";

/** Options of {@link formatBlamePorcelain} */
export interface BlamePorcelainOptions {
  /** Repeat the commit details on every line (`--line-porcelain`) */
  linePorcelain?: boolean;
  /** `core.quotePath` (default true) */
  quotePath?: boolean;
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
}

const encoder = new TextEncoder();

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

function tzValue(tz: string): number {
  const n = Number.parseInt(tz, 10);
  return Number.isNaN(n) ? 0 : n;
}

/** `show_date` with `DATE_ISO8601`: "2005-04-07 15:13:13 -0700" in the given zone */
function isoDate(time: number, tz: string): string {
  const t = tzValue(tz);
  const minutes = Math.sign(t) * (Math.floor(Math.abs(t) / 100) * 60 + (Math.abs(t) % 100));
  const d = new Date((time + minutes * 60) * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const zone = `${t < 0 ? "-" : "+"}${p(Math.abs(t), 4)}`;
  return `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(
    d.getUTCHours(),
  )}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${zone}`;
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
    let last: Uint8Array | undefined;
    for (let cnt = 0; cnt < e.lineCount; cnt++) {
      if (cnt) {
        sink.text(`${e.commitId} ${e.sourceStart + cnt} ${e.resultStart + cnt}\n`);
        if (repeat) details(e, true);
      }
      last = lines[e.resultStart - 1 + cnt] ?? new Uint8Array(0);
      sink.text("\t");
      sink.push(last);
    }
    if (last && last.length > 0 && last[last.length - 1] !== 0x0a) sink.text("\n");
  }
  return sink.bytes();
}

/** git's default `blame` output */
export function formatBlame(result: BlameResult, options: BlameFormatOptions = {}): Uint8Array {
  const lines = fileLines(result.content ?? new Uint8Array(0));
  const entries = result.entries;
  let showName = options.showName ?? false;
  let longestFile = 0;
  let longestAuthor = 0;
  let longestSrc = 0;
  let longestDst = 0;
  let maxMarks = 0;
  const seen = new Set<string>();
  const authorOf = (e: BlameEntry) =>
    options.showEmail ? `<${e.commit.author.email}>` : e.commit.author.name;
  for (const e of entries) {
    const marks = e.boundary && !options.blankBoundary ? 1 : 0;
    if (maxMarks < marks) maxMarks = marks;
    if (e.sourcePath !== result.path) showName = true;
    const len = encoder.encode(e.sourcePath).length;
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

  const sink = new ByteSink();
  for (const e of entries) {
    const c = e.commit;
    let last: Uint8Array | undefined;
    for (let cnt = 0; cnt < e.lineCount; cnt++) {
      let length = options.longObjectName ? 40 : abbrev;
      let hex = e.commitId;
      if (e.boundary && options.blankBoundary) hex = " ".repeat(hex.length);
      let line = "";
      if (e.boundary && !options.blankBoundary) {
        line += "^";
        length--;
      }
      line += hex.slice(0, Math.min(length, 40));
      if (showName) {
        const pad = Math.max(0, longestFile - encoder.encode(e.sourcePath).length);
        line += ` ${e.sourcePath}${" ".repeat(pad)}`;
      }
      if (options.showNumber) {
        line += ` ${String(e.sourceStart + cnt).padStart(maxOrigDigits)}`;
      }
      if (!options.noAuthor) {
        const name = authorOf(e);
        const pad = Math.max(0, longestAuthor - displayWidth(name));
        const time = options.rawTimestamp
          ? `${c.author.timestamp} ${c.author.tzOffset}`
          : isoDate(c.author.timestamp, c.author.tzOffset);
        line += ` (${name}${" ".repeat(pad)} ${time.padStart(10)}`;
      }
      line += ` ${String(e.resultStart + cnt).padStart(maxDigits)}) `;
      sink.text(line);
      last = lines[e.resultStart - 1 + cnt] ?? new Uint8Array(0);
      sink.push(last);
    }
    if (last && last.length > 0 && last[last.length - 1] !== 0x0a) sink.text("\n");
  }
  return sink.bytes();
}
