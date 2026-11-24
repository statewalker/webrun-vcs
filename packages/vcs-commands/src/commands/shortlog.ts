/**
 * git's shortlog (builtin/shortlog.c): commits grouped by author (or committer, trailer
 * values, formatted fields), each group's subjects oldest first, sorted by name or by count.
 * {@link ShortlogCommand} walks a repository's history into it, `format-patch`'s cover letter
 * uses it for its summary, and {@link readShortlogInput} reads `git log` output into it as
 * `git log | git shortlog` does.
 *
 * @example
 * ```typescript
 * const log = new Shortlog({ wrap: { width: 76, indent1: 6, indent2: 9 } });
 * log.insert("A U Thor", "Second commit");
 * log.insert("A U Thor", "First commit");
 * log.text(); // "A U Thor (2):\n      First commit\n      Second commit\n\n"
 * ```
 *
 * @module
 */

import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { GitApiError } from "../errors/index.js";
import type { Mailmap } from "./mailmap.js";
import { wrapText } from "./pretty-format.js";
import { compareBytes } from "./ref-filter/ref-filter.js";

/** `-w[<width>[,<indent1>[,<indent2>]]]`: how each subject is wrapped. */
export interface ShortlogWrap {
  /** The width (0: indented, not wrapped) */
  width: number;
  /** The first line's indent */
  indent1: number;
  /** The other lines' indent */
  indent2: number;
}

/** How a {@link Shortlog} prints. */
export interface ShortlogOptions {
  /** `-s`: only each group's count */
  summary?: boolean;
  /** `-n`: groups sorted by count, largest first (else by name, in byte order) */
  numbered?: boolean;
  /** `-w`: subjects wrapped (else indented by six spaces) */
  wrap?: ShortlogWrap;
}

/** One group of a shortlog: its name and its subjects (oldest first) or count. */
export interface ShortlogEntry {
  /** The group's name (an author's name, with `-e` its email too; a trailer's value...) */
  ident: string;
  /** How many commits the group has */
  count: number;
  /** The subjects, oldest first (empty with `-s`) */
  subjects: string[];
}

const LATIN1_NAME = /^(iso[-_]?8859-1|iso8859-1|latin-?1|l1|iso-ir-100|cp819|ibm819|csisolatin1)$/i;

/** The bytes of a text whose characters are all below 256, one byte each. */
const latin1Bytes = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/**
 * How a commit's records are written in the log output encoding (logmsg_reencode): in
 * `output` when its text (`text`, as UTF-8) converts, else in the commit's own encoding
 * (`stored`), else as stored (UTF-8, bytes that are no UTF-8 kept as they were). Only UTF-8
 * and ISO-8859-1 are converted.
 */
export function outputEncoderFor(
  output: string,
  text: string,
  stored: string,
): (s: string) => Uint8Array {
  const fitsLatin1 = (t: string) => {
    for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) > 0xff) return false;
    return true;
  };
  const encoderFor = (charset: string) =>
    /^utf-?8$/i.test(charset)
      ? encodeGitPath
      : LATIN1_NAME.test(charset) && fitsLatin1(text)
        ? latin1Bytes
        : undefined;
  return encoderFor(output) ?? encoderFor(stored) ?? encodeGitPath;
}

/** git's `-w` without a value. */
export const SHORTLOG_DEFAULT_WRAP: ShortlogWrap = { width: 76, indent1: 6, indent2: 9 };

/** git's isspace: space, tab, LF, CR */
const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

/**
 * pretty.c's format_subject: the lines of the first paragraph, each without its trailing
 * blanks, joined by `separator`.
 */
export function formatSubject(text: string, separator = " "): string {
  const parts: string[] = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl + 1;
    let len = end - at;
    while (len > 0 && isSpace(text[at + len - 1])) len--;
    if (len === 0) break;
    parts.push(text.slice(at, at + len));
    at = end;
  }
  return parts.join(separator);
}

/**
 * A commit message's `%s`: its first paragraph after any blank lines, the lines joined by
 * spaces (pretty.c's subject).
 */
export function commitSubject(message: string): string {
  let at = 0;
  while (at < message.length) {
    const nl = message.indexOf("\n", at);
    const end = nl < 0 ? message.length : nl + 1;
    let blank = true;
    for (let i = at; i < end; i++) if (!isSpace(message[i])) blank = false;
    if (!blank) break;
    at = end;
  }
  return formatSubject(message.slice(at));
}

/**
 * The groups of a shortlog, as builtin/shortlog.c keeps them: a sorted list of names, each
 * with its subjects (insert_one_record) or its count (`-s`). A tag passed with a record
 * comes back with its output (format-patch encodes each line as its commit asks).
 */
export class Shortlog<T = undefined> {
  private readonly groups = new Map<string, { subjects: { text: string; tag?: T }[]; n: number }>();

  constructor(private readonly options: ShortlogOptions = {}) {}

  /** insert_one_record: a commit's `oneline` (its subject, or the format's output) under `ident`. */
  insert(ident: string, oneline: string, tag?: T): void {
    let group = this.groups.get(ident);
    if (!group) {
      group = { subjects: [], n: 0 };
      this.groups.set(ident, group);
    }
    group.n++;
    if (this.options.summary) return;
    let at = 0;
    while (at < oneline.length && isSpace(oneline[at])) at++;
    let eol = oneline.indexOf("\n", at);
    if (eol < 0) eol = oneline.length;
    if (oneline.startsWith("[PATCH", at)) {
      const eob = oneline.indexOf("]", at);
      if (eob >= 0 && eob < eol) at = eob + 1;
    }
    while (at < oneline.length && isSpace(oneline[at]) && oneline[at] !== "\n") at++;
    const subject = formatSubject(oneline.slice(at));
    group.subjects.push(tag !== undefined ? { text: subject, tag } : { text: subject });
  }

  /** The groups in output order (by name in byte order, or by count with `-n`). */
  entries(): ShortlogEntry[] {
    return this.sorted().map(([ident, g]) => ({
      ident,
      count: g.n,
      subjects: g.subjects.map((s) => s.text).reverse(),
    }));
  }

  private sorted() {
    const list = [...this.groups.entries()].sort((a, b) => compareBytes(a[0], b[0]));
    // STABLE_QSORT by count, largest first
    if (this.options.numbered) list.sort((a, b) => b[1].n - a[1].n);
    return list;
  }

  /**
   * shortlog_output: the text, in pieces, each with the tag of the record it shows (a
   * group's header has its first record's tag; separators have none).
   */
  pieces(): { text: string; tag?: T }[] {
    const out: { text: string; tag?: T }[] = [];
    const wrap = this.options.wrap;
    for (const [ident, g] of this.sorted()) {
      if (this.options.summary) {
        out.push({ text: `${String(g.n).padStart(6)}\t${ident}\n` });
        continue;
      }
      const first = g.subjects[0]?.tag;
      out.push(
        first !== undefined
          ? { text: `${ident} (${g.subjects.length}):\n`, tag: first }
          : { text: `${ident} (${g.subjects.length}):\n` },
      );
      for (let j = g.subjects.length; j >= 1; j--) {
        const s = g.subjects[j - 1] as { text: string; tag?: T };
        const text = wrap
          ? `${wrapText(s.text, wrap.indent1, wrap.indent2, wrap.width)}\n`
          : `      ${s.text}\n`;
        out.push(s.tag !== undefined ? { text, tag: s.tag } : { text });
      }
      out.push({ text: "\n" });
    }
    return out;
  }

  /** shortlog_output's text. */
  text(): string {
    return this.pieces()
      .map((p) => p.text)
      .join("");
  }
}

/** The usage line git prints for a bad `-w`. */
const WRAP_USAGE = "-w[<width>[,<indent1>[,<indent2>]]]";

/**
 * parse_wrap_args: `-w` (undefined: 76, 6, 9) or `-w<width>[,<indent1>[,<indent2>]]`, each
 * omitted number its default; throws git's `error: -w[...]` (exit 129) for a bad one.
 *
 * @example
 * ```typescript
 * parseShortlogWrap("60,2"); // { width: 60, indent1: 2, indent2: 9 }
 * ```
 */
export function parseShortlogWrap(arg?: string): ShortlogWrap {
  if (arg === undefined) return { ...SHORTLOG_DEFAULT_WRAP };
  let rest = arg;
  let bad = false;
  // parse_uint: strtoul up to `comma` (or the end), the default when no digit came first
  const parseUint = (comma: string, fallback: number): number => {
    const m = /^[ \t\n\v\f\r]*[+-]?\d*/.exec(rest) as RegExpExecArray;
    let digits = m[0];
    // strtoul reads "" (or a lone sign) as no number
    if (!/\d/.test(digits)) digits = "";
    const after = rest.slice(digits.length);
    if (after !== "" && after[0] !== comma) {
      bad = true;
      return -1;
    }
    let value = digits === "" ? fallback : Number(digits.trim());
    // strtoul wraps a negative number to a huge one, which is above INT_MAX
    if (value < 0 || value > 0x7fffffff) {
      bad = true;
      value = -1;
    }
    rest = after === "" ? "" : after.slice(1);
    return value;
  };
  const width = parseUint(",", SHORTLOG_DEFAULT_WRAP.width);
  const indent1 = bad ? -1 : parseUint(",", SHORTLOG_DEFAULT_WRAP.indent1);
  const indent2 = bad ? -1 : parseUint("\0", SHORTLOG_DEFAULT_WRAP.indent2);
  if (bad || (width && ((indent1 && width <= indent1) || (indent2 && width <= indent2))))
    throw new GitApiError(`error: ${WRAP_USAGE}`, { exitCode: 129 });
  return { width, indent1, indent2 };
}

/** One `--group` of a shortlog. */
export type ShortlogGroup =
  | { kind: "author" }
  | { kind: "committer" }
  | { kind: "trailer"; key: string }
  | { kind: "format"; format: string };

/**
 * parse_group_option: `author`, `committer` (without case), `trailer:<key>`,
 * `format:<format>`, or a format with a `%` in it; throws git's `error: unknown group
 * type: <arg>` (exit 129) for anything else.
 */
export function parseShortlogGroup(arg: string): ShortlogGroup {
  const lower = arg.replace(/[A-Z]/g, (c) => c.toLowerCase());
  if (lower === "author") return { kind: "author" };
  if (lower === "committer") return { kind: "committer" };
  if (arg.startsWith("trailer:")) return { kind: "trailer", key: arg.slice(8) };
  if (arg.startsWith("format:")) return { kind: "format", format: arg.slice(7) };
  if (arg.includes("%")) return { kind: "format", format: arg };
  throw new GitApiError(`error: unknown group type: ${arg}`, { exitCode: 129 });
}

/**
 * ident.c's split_ident_line, for the name and the email: the name before the first `<`
 * (without trailing blanks), the email up to the first `>` after it; undefined without both.
 */
export function splitIdent(text: string): { name: string; email: string } | undefined {
  const lt = text.indexOf("<");
  if (lt < 0) return undefined;
  const gt = text.indexOf(">", lt + 1);
  if (gt < 0) return undefined;
  let end = lt;
  while (end > 0 && isSpace(text[end - 1])) end--;
  return { name: text.slice(0, end), email: text.slice(lt + 1, gt) };
}

/**
 * shortlog.c's parse_ident: an identity (`Name <email> ...`) through the mailmap, as a
 * group's name (`Name`, with `email` `Name <email>`); undefined when it does not parse.
 */
export function shortlogIdent(
  text: string,
  mailmap: Mailmap | undefined,
  email: boolean,
): string | undefined {
  const split = splitIdent(text);
  if (!split) return undefined;
  const mapped = mailmap ? mailmap.map(split.name, split.email) : split;
  return email ? `${mapped.name} <${mapped.email}>` : mapped.name;
}

/** The lines of a text as strbuf_getline_lf reads them (the LF dropped, a CR kept). */
export function inputLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * read_from_stdin: the commits of `git log` output (any format with `Author:`/`author `
 * or, for committers, `Commit:`/`committer ` lines: medium, full, raw...) added to `log`, each
 * under its identity through `mailmap` (with `email`, `Name <email>`) and the first
 * non-blank line after its headers. Only one group, author or committer, can be read: git's
 * errors (exit 128) for the others.
 *
 * @example
 * ```typescript
 * const log = new Shortlog();
 * readShortlogInput(logText, log, { group: "author" });
 * ```
 */
export function readShortlogInput<T>(
  text: string,
  log: Shortlog<T>,
  options: { groups?: ShortlogGroup[]; mailmap?: Mailmap; email?: boolean } = {},
): void {
  const groups = options.groups?.length ? options.groups : [{ kind: "author" } as const];
  const kinds = new Set(groups.map((g) => g.kind));
  if (kinds.size > 1)
    throw new GitApiError("fatal: using multiple --group options with stdin is not supported");
  const [kind] = [...kinds];
  if (kind === "trailer" || kind === "format")
    throw new GitApiError(`fatal: using --group=${kind} with stdin is not supported`);
  const match = kind === "committer" ? ["Commit: ", "committer "] : ["Author: ", "author "];
  const lines = inputLines(text);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i++] as string;
    const prefix = match.find((m) => line.startsWith(m));
    if (prefix === undefined) continue;
    // the headers, up to the blank line, then the blank lines
    while (i < lines.length && lines[i] !== "") i++;
    if (i < lines.length) i++;
    while (i < lines.length && lines[i] === "") i++;
    // the next line (empty at the end of the input)
    const oneline = i < lines.length ? (lines[i++] as string) : "";
    const ident = shortlogIdent(line.slice(prefix.length), options.mailmap, !!options.email);
    if (ident === undefined) continue;
    log.insert(ident, oneline);
  }
}
