/**
 * `git log`'s output: the commits of a walk printed as git prints them (log-tree.c's
 * log_tree_commit and show_log, pretty.c's pretty_print_commit), with the history graph
 * (graph.c, see {@link LogGraph}) and each commit's diff.
 *
 * @example
 * ```typescript
 * const text = await git.log().setMaxCount(3).callText({ pretty: "oneline", graph: true });
 * // "* 1a2b3c4 Merge branch 'topic'\n|\\  \n| * 5d6e7f8 Topic work\n..."
 * const patch = await git.log().addPath("src").callText({ patch: true, stat: true });
 * ```
 *
 * The options are `git log`'s: `pretty` takes what `--pretty=`/`--format=` take (`medium`,
 * `short`, `full`, `fuller`, `reference`, `email`, `mboxrd`, `raw`, `oneline`, a
 * `pretty.<name>` alias, `format:<fmt>`, `tformat:<fmt>`, or a format with a `%`), `date`
 * what `--date=` takes, and so on; unset, the configuration's defaults apply (`format.pretty`,
 * `log.date`, `log.abbrevCommit`, `log.decorate`, `log.showRoot`, `log.mailmap`,
 * `log.follow`, `log.graphIndent`, `log.excludeDecoration`, `notes.displayRef`...). Colors
 * are never written (git without a terminal).
 *
 * A commit with an `encoding` header is shown in UTF-8 (git's default `i18n.logOutputEncoding`);
 * another output encoding is not supported. One quirk of git is not reproduced: where its C
 * code takes a user format's output as a NUL-terminated string under `--graph`, a `%x00`
 * can cut what git prints; the whole text is printed here.
 *
 * @module
 */

import type { Commit, ObjectId, PersonIdent } from "@statewalker/vcs-core";
import { encodeGitPath, gitCharWidth } from "@statewalker/vcs-utils/encoding";

import { InvalidArgumentError } from "../errors/index.js";
import { type DateMode, DEFAULT_DATE_MODE, parseDateMode, showDate } from "./date-format.js";
import type { DiffOutputFormat, DiffTextOptions } from "./diff-command.js";
import { LogGraph } from "./log-graph.js";
import type { Mailmap } from "./mailmap.js";
import { parsePathspecItem } from "./pathspec.js";
import {
  formatCommitPretty,
  formatRefDecorations,
  type PrettyCommit,
  PrettyFormatError,
  type RefDecorations,
  wrapText,
} from "./pretty-format.js";

/** How `git log` treats merges in its diffs (`--diff-merges=<mode>`, `-m`, `-c`, `--cc`). */
export type LogDiffMerges = "off" | "first-parent" | "separate" | "combined" | "dense-combined";

/** What `git log` prints of each commit (its command-line options). */
export interface LogOutputOptions {
  /** `--pretty=<format>` / `--format=<format>` (default `format.pretty`, else `medium`) */
  pretty?: string;
  /** `--oneline`: `--pretty=oneline --abbrev-commit` */
  oneline?: boolean;
  /** `--abbrev-commit` / `--no-abbrev-commit` (default `log.abbrevCommit`, false) */
  abbrevCommit?: boolean;
  /**
   * `--abbrev=<n>` (default `core.abbrev`, automatic): at least n digits (4 to 40, as git
   * clamps it), in the commits' ids and in the diffs' `index` lines
   */
  abbrev?: number;
  /** `--no-abbrev`: full ids everywhere */
  noAbbrev?: boolean;
  /** `--date=<mode>` (default `log.date`, else `default`) */
  date?: string;
  /**
   * `--decorate[=short|full|auto|no]` / `--no-decorate` (default `log.decorate`, else none,
   * as without a terminal); `true` is `short`
   */
  decorate?: boolean | "short" | "full" | "auto" | "no";
  /** `--decorate-refs=<pattern>` */
  decorateRefs?: string[];
  /** `--decorate-refs-exclude=<pattern>` */
  decorateRefsExclude?: string[];
  /** `--clear-decorations` */
  clearDecorations?: boolean;
  /** `--graph` */
  graph?: boolean;
  /** `--graph-indent` / `--no-graph-indent` (git 2.5x; default `log.graphIndent`, true) */
  graphIndent?: boolean;
  /** `--graph-lane-limit=<n>` (git 2.5x) */
  graphLaneLimit?: number;
  /** `--topo-order` (`--graph` implies it) */
  topoOrder?: boolean;
  /** `--reverse` */
  reverse?: boolean;
  /** `-p` / `--patch` */
  patch?: boolean;
  /** `-s` / `--no-patch`: no diff output, whatever else asks for it */
  noPatch?: boolean;
  /** `--stat` */
  stat?: boolean;
  /** `--shortstat` */
  shortstat?: boolean;
  /** `--numstat` */
  numstat?: boolean;
  /** `--name-only` */
  nameOnly?: boolean;
  /** `--name-status` */
  nameStatus?: boolean;
  /** `-m`: merges' diffs against each parent (`log.diffMerges`, default `separate`) */
  m?: boolean;
  /** `-c`: combined diffs of merges (implies `-p`) */
  c?: boolean;
  /** `--cc`: dense combined diffs of merges (implies `-p`) */
  cc?: boolean;
  /** `--diff-merges=<mode>` */
  diffMerges?: LogDiffMerges;
  /**
   * `--full-diff`: a path-limited log shows the commits' whole diffs (against their parents
   * before `--graph` rewrote them)
   */
  fullDiff?: boolean;
  /**
   * `--follow`: follow the one path given across renames and copies (default `log.follow`,
   * which needs exactly one plain path; `--follow` throws git's error otherwise)
   */
  follow?: boolean;
  /** `--root` / `log.showRoot` (default true): a root commit's diff against the empty tree */
  showRoot?: boolean;
  /**
   * `--notes` / `--no-notes` (default: notes shown unless a format is given, or the format
   * has `%N`)
   */
  notes?: boolean;
  /** `--use-mailmap` / `--no-mailmap` (default `log.mailmap`, true) */
  mailmap?: boolean;
  /** Options of the diff text (context, algorithm, `--stat=<width>`...) */
  diff?: DiffTextOptions;
  /** Now, in seconds, for relative and human dates (git's GIT_TEST_DATE_NOW) */
  now?: number;
  /** The local zone's offset east of UTC in minutes at a time (default the host's) */
  localTzOffset?: (time: number) => number;
  /** The local zone's name at a time, for `%Z` of `format-local:` (default `Intl`'s) */
  localTzName?: (time: number) => string;
}

/** A commit the walk shows, with the parents it is shown with (rewritten under `--graph`). */
export interface LogOutputEntry {
  id: ObjectId;
  commit: Commit;
  parents: ObjectId[];
  /** The parents before `--graph` rewrote them (git's saved parents, for `--full-diff`) */
  savedParents?: ObjectId[];
}

/** What the printer reads of the repository (see `LogCommand.callBytes`). */
export interface LogOutputHost {
  /** A configuration value (the last), undefined when unset */
  config(key: string): string | undefined;
  /** Every value of a configuration key */
  configAll(key: string): string[];
  /** The names configured under `<section>.` (for `pretty.<name>`) */
  configNames(section: string): string[];
  /** An id abbreviated to at least `minLength` digits (default: automatic, `core.abbrev`) */
  abbreviate(id: ObjectId, minLength?: number): Promise<string>;
  /** The commit as stored, decoded as paths decode (header and message) */
  rawCommit(id: ObjectId): Promise<string | undefined>;
  /** The decorations shown (loaded when asked for) */
  decorations(options: {
    decorate: "short" | "full";
    decorateRefs?: string[];
    decorateRefsExclude?: string[];
    clearDecorations?: boolean;
  }): Promise<RefDecorations>;
  /** The notes of a commit in each display notes ref: the ref and the note's text */
  notes(id: ObjectId): Promise<{ ref: string; text: string }[]>;
  /** The mailmap */
  mailmap(): Promise<Mailmap>;
  /**
   * The diff of a commit against a parent (the empty tree for none): undefined bytes when
   * nothing differs; `follow` the path followed, `followPath` the path to follow in the
   * parent
   */
  diff(
    entry: LogOutputEntry,
    parent: ObjectId | undefined,
    formats: DiffOutputFormat[],
    options: { statWidth?: number; follow?: string; fullDiff?: boolean; abbrev?: number },
  ): Promise<{ bytes?: Uint8Array; followPath?: string }>;
  /**
   * The combined diff of a merge (`-c`, `--cc`): the paths that differ from every parent,
   * `names` as `--name-only` / `--name-status` list them (undefined for neither), `patch`
   * the combined patch (when asked); `follow` the one path `--follow` limits it to
   */
  combinedDiff(
    entry: LogOutputEntry,
    options: {
      dense: boolean;
      names?: "name-only" | "name-status";
      patch: boolean;
      follow?: string;
      /** With `follow`: the path each parent has it under (a rename or copy found) */
      parentPaths?: string[];
      abbrev?: number;
    },
  ): Promise<{ paths: number; names: Uint8Array; patch: Uint8Array }>;
}

type Fmt = "raw" | "medium" | "short" | "email" | "mboxrd" | "fuller" | "full" | "oneline" | "user";

interface CommitFormat {
  fmt: Fmt;
  user?: string;
  useTerminator: boolean;
  expandTabs: number;
  dateShort?: boolean;
}

const BUILTIN_FORMATS: { name: string; fmt: Fmt; terminator: boolean; tabs: number }[] = [
  { name: "raw", fmt: "raw", terminator: false, tabs: 0 },
  { name: "medium", fmt: "medium", terminator: false, tabs: 8 },
  { name: "short", fmt: "short", terminator: false, tabs: 0 },
  { name: "email", fmt: "email", terminator: false, tabs: 0 },
  { name: "mboxrd", fmt: "mboxrd", terminator: false, tabs: 0 },
  { name: "fuller", fmt: "fuller", terminator: false, tabs: 8 },
  { name: "full", fmt: "full", terminator: false, tabs: 8 },
  { name: "oneline", fmt: "oneline", terminator: true, tabs: 0 },
  { name: "reference", fmt: "user", terminator: true, tabs: 0 },
];

/** pretty.c's get_commit_format (with the `pretty.<name>` aliases of the configuration). */
function parseCommitFormat(arg: string | undefined, host: LogOutputHost): CommitFormat {
  if (arg === undefined) return { fmt: "medium", useTerminator: false, expandTabs: 8 };
  if (arg.startsWith("format:")) {
    return { fmt: "user", user: arg.slice(7), useTerminator: false, expandTabs: 0 };
  }
  if (arg === "" || arg.startsWith("tformat:") || arg.includes("%")) {
    const user = arg.startsWith("tformat:") ? arg.slice(8) : arg;
    return { fmt: "user", user, useTerminator: true, expandTabs: 0 };
  }
  // find_commit_format: the shortest name that starts with it, aliases followed
  const custom = host
    .configNames("pretty")
    .filter((name) => !BUILTIN_FORMATS.some((b) => b.name === name));
  const names = [...BUILTIN_FORMATS.map((b) => b.name), ...custom];
  let sought = arg;
  for (let depth = 0; depth <= names.length; depth++) {
    const lower = sought.toLowerCase();
    let found: string | undefined;
    for (const name of names) {
      if (!name.toLowerCase().startsWith(lower)) continue;
      if (found === undefined || found.length > name.length) found = name;
    }
    if (found === undefined) throw new PrettyFormatError(`fatal: invalid --pretty format: ${arg}`);
    const builtin = BUILTIN_FORMATS.find((b) => b.name === found);
    if (builtin) {
      if (builtin.name === "reference") {
        return {
          fmt: "user",
          user: "%C(auto)%h (%s, %ad)",
          useTerminator: true,
          expandTabs: 0,
          dateShort: true,
        };
      }
      return { fmt: builtin.fmt, useTerminator: builtin.terminator, expandTabs: builtin.tabs };
    }
    const value = host.config(`pretty.${found}`) ?? "";
    if (value.startsWith("format:")) {
      return { fmt: "user", user: value.slice(7), useTerminator: false, expandTabs: 0 };
    }
    if (value.startsWith("tformat:")) {
      return { fmt: "user", user: value.slice(8), useTerminator: true, expandTabs: 0 };
    }
    if (value.includes("%"))
      return { fmt: "user", user: value, useTerminator: true, expandTabs: 0 };
    sought = value;
  }
  throw new PrettyFormatError(
    `fatal: invalid --pretty format: '${arg}' references an alias which points to itself`,
  );
}

/** git_parse_maybe_bool */
function bool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === "true" || v === "yes" || v === "on" || v === "1") return true;
  if (v === "false" || v === "no" || v === "off" || v === "0" || v === "") return false;
  if (/^-?\d+$/.test(v)) return Number(v) !== 0;
  return undefined;
}

/** log-tree.c's parse_decoration_style */
function decorationStyle(value: string | boolean | undefined): "short" | "full" | undefined {
  if (value === undefined) return undefined;
  if (value === true) return "short";
  if (value === false) return undefined;
  const b = bool(value);
  if (b !== undefined) return b ? "short" : undefined;
  if (value === "full") return "full";
  if (value === "short") return "short";
  // auto: decorated only on a terminal
  return undefined;
}

const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

/** The text with git's isspace trimmed at the end (strbuf_rtrim). */
function rtrim(text: string): string {
  let end = text.length;
  while (end > 0 && isSpace(text[end - 1])) end--;
  return text.slice(0, end);
}

/** The lines of a message, each with its newline (get_one_line). */
function linesOf(msg: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < msg.length) {
    const nl = msg.indexOf("\n", at);
    const next = nl < 0 ? msg.length : nl + 1;
    out.push(msg.slice(at, next));
    at = next;
  }
  return out;
}

/** pretty.c's skip_blank_lines over line arrays: the index of the first non-blank line */
function skipBlank(lines: string[], from: number): number {
  let i = from;
  while (i < lines.length && rtrim(lines[i] as string) === "") i++;
  return i;
}

/** pp_utf8_width: the columns of a text, -1 when it has a control or invalid character */
function utf8Width(text: string): number {
  let w = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) as number;
    i += cp > 0xffff ? 2 : 1;
    if (cp >= 0xd800 && cp <= 0xdfff) return -1;
    const cw = gitCharWidth(cp);
    if (cw < 0) return -1;
    w += cw;
  }
  return w;
}

/** strbuf_add_tabexpand */
function tabExpand(line: string, tabWidth: number): string {
  let out = "";
  let rest = line;
  for (let tab = rest.indexOf("\t"); tab >= 0; tab = rest.indexOf("\t")) {
    const width = utf8Width(rest.slice(0, tab));
    if (width < 0) break;
    out += rest.slice(0, tab) + " ".repeat(tabWidth - (width % tabWidth));
    rest = rest.slice(tab + 1);
  }
  return out + rest;
}

/** The UTF-8 bytes of a string whose raw bytes are escaped as paths escape them */
const bytesOf = encodeGitPath;

const hasNonAscii = (text: string) => [...text].some((c) => c.charCodeAt(0) > 0x7f);

/** pretty.c's needs_rfc2047_encoding */
function needsRfc2047(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x80 || c === 0x0a) return true;
    if (c === 0x3d && text[i + 1] === "?") return true;
  }
  return false;
}

const RFC822_SPECIALS = '()<>[]:;@,."\\';

/** pretty.c's last_line_length, in bytes */
function lastLineLength(sb: string): number {
  const nl = sb.lastIndexOf("\n");
  return bytesOf(sb.slice(nl + 1)).length;
}

/** pretty.c's add_rfc2047 (the encoding UTF-8) */
function addRfc2047(sb: string, text: string, address: boolean): string {
  const max = 76;
  let lineLen = lastLineLength(sb);
  let out = "=?UTF-8?q?";
  lineLen += 5 + 5;
  const bytes = bytesOf(text);
  const special = (ch: number) => {
    if (ch >= 0x80 || ch < 0x20 || ch === 0x7f) return true;
    if (ch === 0x20 || ch === 0x09 || ch === 0x3d || ch === 0x3f || ch === 0x5f) return true;
    if (!address) return false;
    const c = String.fromCharCode(ch);
    return !(/[A-Za-z0-9]/.test(c) || "!*+-/".includes(c));
  };
  for (let i = 0; i < bytes.length; ) {
    const lead = bytes[i] as number;
    let len = 1;
    if (lead >= 0xc0) {
      const want = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
      let ok = i + want <= bytes.length;
      for (let k = 1; ok && k < want; k++) ok = ((bytes[i + k] as number) & 0xc0) === 0x80;
      if (ok) len = want;
    }
    const isSpecial = len > 1 || special(lead);
    const encodedLen = isSpecial ? 3 * len : 1;
    if (lineLen + encodedLen + 2 > max) {
      out += "?=\n =?UTF-8?q?";
      lineLen = 5 + 5 + 1;
    }
    for (let k = 0; k < len; k++) {
      const b = bytes[i + k] as number;
      out += isSpecial
        ? `=${b.toString(16).toUpperCase().padStart(2, "0")}`
        : String.fromCharCode(b);
    }
    lineLen += encodedLen;
    i += len;
  }
  return `${out}?=`;
}

/** The parts of a commit as git's pretty printer reads them. */
interface ParsedCommit {
  headerLines: string[];
  body: string;
}

function parseRaw(raw: string): ParsedCommit {
  const lines = linesOf(raw);
  const headerLines: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line === "\n") {
      i++;
      break;
    }
    headerLines.push(line);
  }
  return { headerLines, body: lines.slice(i).join("") };
}

/** utf8.c's is_encoding_utf8 */
const isUtf8 = (name: string) => /^utf-?8$/i.test(name);

/** The ISO-8859-1 names iconv knows (TextDecoder reads them as windows-1252). */
const LATIN1 = /^(iso[-_]?8859-1|iso8859-1|latin-?1|l1|iso-ir-100|cp819|ibm819|csisolatin1)$/i;

/** Bytes in a character set as text; undefined when it is unknown or the bytes are not in it */
function decodeCharset(bytes: Uint8Array, charset: string): string | undefined {
  if (LATIN1.test(charset)) {
    let out = "";
    for (const b of bytes) out += String.fromCharCode(b);
    return out;
  }
  try {
    return new TextDecoder(charset, { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * pretty.c's repo_logmsg_reencode into UTF-8 (`i18n.logOutputEncoding`, `i18n.commitEncoding`
 * default): a commit with an `encoding` header is converted from it and the header dropped
 * (an `encoding UTF-8` header too); one whose bytes do not convert (or names a character set
 * this host does not know) is kept as it is, header and all, as git keeps it when iconv
 * fails. Undefined when nothing changes.
 */
function reencodeCommit(raw: string, parsed: ParsedCommit): string | undefined {
  const at = parsed.headerLines.findIndex((l) => l.startsWith("encoding "));
  if (at < 0) return undefined;
  const charset = (parsed.headerLines[at] as string).slice(9).replace(/\n$/, "");
  let text = raw;
  if (!isUtf8(charset)) {
    const decoded = decodeCharset(encodeGitPath(raw), charset);
    if (decoded === undefined) return undefined;
    text = decoded;
  }
  // replace_encoding_header: the first `encoding ` line of the header removed
  const lines = linesOf(text);
  const k = lines.findIndex((l, i) => l.startsWith("encoding ") && i < parsed.headerLines.length);
  if (k >= 0) lines.splice(k, 1);
  return lines.join("");
}

/** An `author`/`committer` header line's ident (`Name <email> time zone`) */
function identOf(line: string): PersonIdent | undefined {
  const m = /^[a-z]+ (.*?) ?<([^>]*)> ?(\d*) ?([+-]?\d*)\n?$/.exec(line);
  if (!m) return undefined;
  return {
    name: m[1] as string,
    email: m[2] as string,
    timestamp: Number(m[3] || 0),
    tzOffset: m[4] || "+0000",
  };
}

/** A commit's raw text synthesized from its fields (a store that keeps no raw bytes). */
function synthesizeRaw(commit: Commit): string {
  const ident = (p: PersonIdent) => `${p.name} <${p.email}> ${p.timestamp} ${p.tzOffset}`;
  let out = `tree ${commit.tree}\n`;
  for (const p of commit.parents) out += `parent ${p}\n`;
  out += `author ${ident(commit.author)}\ncommitter ${ident(commit.committer)}\n`;
  if (commit.encoding) out += `encoding ${commit.encoding}\n`;
  return `${out}\n${commit.message}`;
}

/** A sink of text and bytes. */
class Output {
  private readonly chunks: Uint8Array[] = [];
  private pendingText = "";

  text(s: string): void {
    this.pendingText += s;
  }

  bytes(b: Uint8Array): void {
    this.flush();
    this.chunks.push(b);
  }

  private flush(): void {
    if (this.pendingText) {
      this.chunks.push(bytesOf(this.pendingText));
      this.pendingText = "";
    }
  }

  result(): Uint8Array {
    this.flush();
    const size = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

/**
 * Each line of `bytes` with `prefix` before it (diff_line_prefix); `bare` lines are left
 * without it (combine-diff.c prints its `mode` and `Binary files differ` lines with a plain
 * printf, without the prefix).
 */
function prefixLines(
  bytes: Uint8Array,
  prefix: string,
  bare?: (line: string) => boolean,
): Uint8Array {
  if (!prefix || bytes.length === 0) return bytes;
  const p = bytesOf(prefix);
  let lines = 0;
  for (let at = bytes.indexOf(0x0a); at >= 0; at = bytes.indexOf(0x0a, at + 1)) lines++;
  const out = new Uint8Array(bytes.length + (lines + 1) * p.length);
  let size = 0;
  let at = 0;
  while (at < bytes.length) {
    let end = bytes.indexOf(0x0a, at);
    end = end < 0 ? bytes.length : end + 1;
    const head = bare ? String.fromCharCode(...bytes.subarray(at, Math.min(end, at + 19))) : "";
    if (!bare?.(head)) {
      out.set(p, size);
      size += p.length;
    }
    out.set(bytes.subarray(at, end), size);
    size += end - at;
    at = end;
  }
  return out.subarray(0, size);
}

const combinedBare = (head: string) =>
  head.startsWith("mode ") || head.startsWith("Binary files differ");

/** The commit printer: git's rev_info output state over one walk. */
export class LogPrinter {
  private readonly out = new Output();
  private readonly format: CommitFormat;
  private readonly dateMode: DateMode;
  private readonly abbrevCommit: boolean;
  private readonly abbrevLength: number | undefined;
  private readonly formats: DiffOutputFormat[];
  /** git's `revs->diff`: every commit's diff is run (diff formats asked for, `-c`, `--follow`) */
  private readonly allNeedDiff: boolean;
  private readonly diffMerges: LogDiffMerges | undefined;
  private readonly mergesNeedDiff: boolean;
  /** git's `simplify_history` turned off (`-m`, `--diff-merges=separate`) */
  readonly fullHistory: boolean;
  private readonly showRoot: boolean;
  private readonly useMailmap: boolean;
  private readonly showNotes: boolean;
  private readonly decorate: "short" | "full" | undefined;
  private readonly follow: boolean;
  private decorations?: RefDecorations;
  private mailmap?: Mailmap;
  private graph?: LogGraph;
  private shownOne = false;
  private missingNewline = false;
  private shownDashes = false;
  /** The path `--follow` follows in each commit still to come */
  private readonly followPaths = new Map<ObjectId, string>();
  private followPath: string | undefined;

  constructor(
    private readonly host: LogOutputHost,
    private readonly options: LogOutputOptions,
    private readonly walk: {
      interesting: (id: ObjectId) => boolean;
      firstParentOnly: boolean;
      paths: string[];
    },
  ) {
    const prettyGiven = options.pretty !== undefined || !!options.oneline;
    const pretty = options.oneline ? "oneline" : (options.pretty ?? host.config("format.pretty"));
    this.format = parseCommitFormat(pretty, host);
    const dateSpec = options.date ?? host.config("log.date");
    this.dateMode = dateSpec
      ? parseDateMode(dateSpec)
      : this.format.dateShort
        ? { type: "short", local: false }
        : DEFAULT_DATE_MODE;
    if (options.date === undefined && this.format.dateShort) {
      this.dateMode = { type: "short", local: false };
    }
    const raw = prettyGiven && this.format.fmt === "raw";
    this.abbrevCommit =
      options.abbrevCommit ??
      (options.oneline ? true : raw ? false : (bool(host.config("log.abbrevCommit")) ?? false));
    // --abbrev=<n> is clamped to 4..40 (an --abbrev=0 is 4)
    if (options.noAbbrev) this.abbrevLength = 40;
    else if (options.abbrev !== undefined) {
      this.abbrevLength = Math.min(40, Math.max(4, Math.trunc(options.abbrev)));
    }
    // decorations: a user format decorates only when it shows them
    let decorate =
      options.decorate !== undefined
        ? decorationStyle(options.decorate)
        : raw
          ? undefined
          : decorationStyle(host.config("log.decorate"));
    if (this.format.fmt === "user") {
      const wants = /%(d|D|\(decorate)/.test(this.format.user ?? "");
      decorate = wants ? (decorate ?? "short") : undefined;
    }
    this.decorate = decorate;
    // diffs
    const formats: DiffOutputFormat[] = [];
    if (options.nameOnly) formats.push("name-only");
    else if (options.nameStatus) formats.push("name-status");
    if (options.numstat) formats.push("numstat");
    if (options.stat) formats.push("stat");
    if (options.shortstat) formats.push("shortstat");
    if (options.patch) formats.push("patch");
    // revs->diff: decided from the formats asked for before the merges' default patch
    const userDiff = !options.noPatch && formats.length > 0;
    let diffMerges: LogDiffMerges | undefined = options.diffMerges;
    let mergesNeedDiff = diffMerges !== undefined && diffMerges !== "off";
    let implyPatch = false;
    // diff-merges.c's set_separate turns simplify_history off, and nothing turns it back on
    const configuredMerges = host.config("log.diffMerges");
    const mDefault = configuredMerges ? mergesMode(configuredMerges) : "separate";
    this.fullHistory =
      diffMerges === "separate" ||
      diffMerges === "first-parent" ||
      (!!options.m && (mDefault === "separate" || mDefault === "first-parent"));
    if (options.cc) {
      diffMerges = "dense-combined";
      mergesNeedDiff = true;
      implyPatch = true;
    } else if (options.c) {
      diffMerges = "combined";
      mergesNeedDiff = true;
      implyPatch = true;
    } else if (options.m && diffMerges === undefined) {
      diffMerges = mDefault;
      mergesNeedDiff = false;
    }
    if (diffMerges === undefined && walk.firstParentOnly) diffMerges = "first-parent";
    if ((implyPatch || mergesNeedDiff) && formats.length === 0) formats.push("patch");
    // --name-only and --name-status turn the other formats off (diff_setup_done)
    const names = formats.find((f) => f === "name-only" || f === "name-status");
    this.formats = options.noPatch ? [] : names ? [names] : formats;
    this.diffMerges = diffMerges;
    this.mergesNeedDiff = mergesNeedDiff;
    this.showRoot = options.showRoot ?? bool(host.config("log.showRoot")) ?? true;
    this.useMailmap = options.mailmap ?? bool(host.config("log.mailmap")) ?? true;
    this.showNotes = options.notes ?? (!prettyGiven || /%N/.test(this.format.user ?? ""));
    // --follow needs one path, without magic but `:(top)` and `:(literal)`
    // (diff_check_follow_pathspec); log.follow is ignored otherwise
    const followPath = followPathOf(walk.paths, options.follow === true);
    this.follow = (options.follow ?? bool(host.config("log.follow")) ?? false) && !!followPath;
    if (this.follow) this.followPath = followPath;
    this.allNeedDiff = userDiff || implyPatch || this.follow;
  }

  /** Whether commits not shown (their diff empty) do not count (`--follow`) */
  get alwaysShowHeader(): boolean {
    return !this.follow;
  }

  /** Prepares what the format reads (decorations, mailmap) and the graph */
  async start(): Promise<void> {
    if (this.decorate) {
      this.decorations = await this.host.decorations({
        decorate: this.decorate,
        ...(this.options.decorateRefs ? { decorateRefs: this.options.decorateRefs } : {}),
        ...(this.options.decorateRefsExclude
          ? { decorateRefsExclude: this.options.decorateRefsExclude }
          : {}),
        ...(this.options.clearDecorations ? { clearDecorations: true } : {}),
      });
    }
    this.mailmap = await this.host.mailmap();
  }

  /** Starts the graph over the entries shown */
  useGraph(parentsOf: (id: ObjectId) => readonly ObjectId[]): void {
    const indent = this.options.graphIndent ?? bool(this.host.config("log.graphIndent")) ?? true;
    this.graph = new LogGraph({
      parents: parentsOf,
      interesting: this.walk.interesting,
      firstParentOnly: this.walk.firstParentOnly,
      indent,
      ...(this.options.graphLaneLimit ? { maxLanes: this.options.graphLaneLimit } : {}),
    });
  }

  private padding(): string {
    return this.graph ? this.graph.showPadding() : "";
  }

  private oneline(): string {
    return this.graph ? this.graph.showOneline() : "";
  }

  private async abbrevId(id: ObjectId, abbreviated: boolean): Promise<string> {
    if (!abbreviated || this.abbrevLength === 40) return id;
    return this.host.abbreviate(id, this.abbrevLength);
  }

  private formatDate(ident: PersonIdent, mode: DateMode = this.dateMode): string {
    return showDate(ident.timestamp, ident.tzOffset, mode, {
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
      ...(this.options.localTzOffset ? { localTzOffset: this.options.localTzOffset } : {}),
      ...(this.options.localTzName ? { localTzName: this.options.localTzName } : {}),
    });
  }

  private mapped(ident: PersonIdent): { name: string; email: string } {
    if (this.useMailmap && this.mailmap && !this.mailmap.empty) {
      return this.mailmap.map(ident.name, ident.email);
    }
    return { name: ident.name, email: ident.email };
  }

  /**
   * One commit (log_tree_commit): its header and message, and its diff; false when it was
   * not shown (`--follow` and nothing of the path changed).
   */
  async showCommit(entry: LogOutputEntry, lookahead: ObjectId[]): Promise<boolean> {
    this.graph?.update(entry.id, lookahead);
    if (this.follow) {
      const stored = this.followPaths.get(entry.id);
      if (stored !== undefined) this.followPath = stored;
    }
    const log = { pending: true, parent: undefined as ObjectId | undefined };
    let shown = await this.logTreeDiff(entry, log);
    if (!shown && log.pending && this.alwaysShowHeader) {
      log.parent = undefined;
      await this.showLog(entry, log);
      shown = true;
    }
    if (this.follow) {
      const parents = entry.parents;
      if (parents.length > 1) {
        // each parent gets the path its own diff follows to
        for (const p of parents) {
          const r = await this.host.diff(entry, p, [], { follow: this.followPath as string });
          if (r.followPath !== undefined) this.followPaths.set(p, r.followPath);
        }
      } else if (parents.length === 1 && this.followPath !== undefined) {
        this.followPaths.set(parents[0] as ObjectId, this.followPath);
      }
    }
    return shown;
  }

  /** log-tree.c's log_tree_diff: true when it showed the log */
  private async logTreeDiff(
    entry: LogOutputEntry,
    log: { pending: boolean; parent: ObjectId | undefined },
  ): Promise<boolean> {
    const allNeedDiff = this.allNeedDiff;
    if (!allNeedDiff && !this.mergesNeedDiff) return false;
    const parents = this.diffParents(entry);
    const isMerge = parents.length > 1;
    if (!isMerge && !allNeedDiff) return false;
    if (parents.length === 0) {
      if (this.showRoot) await this.diffFlush(entry, undefined, log);
      return !log.pending;
    }
    const firstParentMerges = this.diffMerges === "first-parent";
    if (isMerge) {
      if (this.diffMerges === "combined" || this.diffMerges === "dense-combined") {
        await this.combined(entry, log, this.diffMerges === "dense-combined");
        return !log.pending;
      }
      if (this.diffMerges === "separate" || this.diffMerges === "first-parent") {
        if (!firstParentMerges) log.parent = parents[0];
      } else return false;
    }
    let showed = false;
    for (let k = 0; k < parents.length; k++) {
      await this.diffFlush(entry, parents[k], log);
      showed ||= !log.pending;
      if (k + 1 >= parents.length || firstParentMerges) break;
      log.parent = parents[k + 1];
      log.pending = true;
    }
    return showed;
  }

  /** get_saved_parents: the parents before rewriting under `--full-diff`, else as shown */
  private diffParents(entry: LogOutputEntry): ObjectId[] {
    return this.options.fullDiff && entry.savedParents ? entry.savedParents : entry.parents;
  }

  /** The `--abbrev=<n>` of the diffs' `index` lines (revs->diffopt.abbrev) */
  private diffAbbrev(): { abbrev?: number } {
    return this.options.abbrev !== undefined && !this.options.noAbbrev && this.abbrevLength
      ? { abbrev: this.abbrevLength }
      : {};
  }

  private formatIsEmpty(): boolean {
    return this.format.fmt === "user" && this.format.user === "";
  }

  /** log-tree.c's log_tree_diff_flush */
  private async diffFlush(
    entry: LogOutputEntry,
    parent: ObjectId | undefined,
    log: { pending: boolean; parent: ObjectId | undefined },
  ): Promise<void> {
    this.shownDashes = false;
    const width = this.graph ? this.graph.getWidth() : 0;
    const result = await this.host.diff(entry, parent, this.formats, {
      ...(width ? { statWidth: 80 - width } : {}),
      ...(this.follow && this.followPath !== undefined ? { follow: this.followPath } : {}),
      ...(this.options.fullDiff ? { fullDiff: true } : {}),
      ...this.diffAbbrev(),
    });
    if (this.follow && result.followPath !== undefined) this.followPath = result.followPath;
    if (!result.bytes) return;
    if (log.pending) {
      await this.showLog(entry, log);
      if (this.formats.length > 0 && this.format.fmt !== "oneline" && !this.formatIsEmpty()) {
        this.out.text(this.padding());
        if (!this.shownDashes && this.formats.includes("stat") && this.formats.includes("patch")) {
          this.out.text("---");
        }
        this.out.text("\n");
      }
    }
    this.out.bytes(prefixLines(result.bytes, this.padding()));
  }

  /** combine-diff.c's diff_tree_combined for a merge */
  private async combined(
    entry: LogOutputEntry,
    log: { pending: boolean; parent: ObjectId | undefined },
    dense: boolean,
  ): Promise<void> {
    if (log.pending) {
      await this.showLog(entry, log);
      if (this.formats.length > 0 && !this.formatIsEmpty()) {
        this.out.text(`${this.padding()}\n`);
      }
    }
    // find_paths_generic prints the stat of the diff against the first parent as it scans
    const stats = this.formats.filter((f) => f === "numstat" || f === "stat" || f === "shortstat");
    const follow = this.follow && this.followPath !== undefined ? this.followPath : undefined;
    const first = this.diffParents(entry)[0];
    if (stats.length > 0 && first) {
      const width = this.graph ? this.graph.getWidth() : 0;
      const r = await this.host.diff(entry, first, stats, {
        ...(width ? { statWidth: 80 - width } : {}),
        ...(this.options.fullDiff ? { fullDiff: true } : {}),
        ...(follow !== undefined ? { follow } : {}),
      });
      if (r.bytes) this.out.bytes(prefixLines(r.bytes, this.padding()));
    }
    const names = this.formats.includes("name-only")
      ? "name-only"
      : this.formats.includes("name-status")
        ? "name-status"
        : undefined;
    const patch = this.formats.includes("patch");
    const parents = this.diffParents(entry);
    // --follow: each parent's diff looks for the file it was renamed or copied from
    let parentPaths: string[] | undefined;
    if (follow !== undefined) {
      parentPaths = [];
      for (const p of parents) {
        const r = await this.host.diff(entry, p, [], { follow });
        parentPaths.push(r.followPath ?? follow);
      }
    }
    const result = await this.host.combinedDiff(
      { ...entry, parents },
      {
        dense,
        ...(names ? { names } : {}),
        patch,
        ...(follow !== undefined ? { follow } : {}),
        ...(parentPaths ? { parentPaths } : {}),
        ...this.diffAbbrev(),
      },
    );
    if (!result.paths) return;
    // show_raw_diff writes names without the line prefix
    this.out.bytes(result.names);
    const needsep =
      names !== undefined ||
      this.formats.some((f) => f === "stat" || f === "numstat" || f === "shortstat");
    if (patch) {
      if (needsep) this.out.text(`${this.padding()}\n`);
      this.out.bytes(prefixLines(result.patch, this.padding(), combinedBare));
    }
  }

  /** log-tree.c's show_log */
  private async showLog(
    entry: LogOutputEntry,
    log: { pending: boolean; parent: ObjectId | undefined },
  ): Promise<void> {
    log.pending = false;
    const { fmt } = this.format;
    if (this.shownOne && !this.format.useTerminator) {
      if (!this.missingNewline) this.out.text(this.padding());
      this.out.text("\n");
    }
    this.shownOne = true;
    if (this.graph) this.out.text(this.graph.showCommit());
    const isMail = fmt === "email" || fmt === "mboxrd";
    if (isMail) {
      this.out.text(`From ${entry.id} Mon Sep 17 00:00:00 2001\n`);
      this.out.text(this.oneline());
    } else if (fmt !== "user") {
      if (fmt !== "oneline") this.out.text("commit ");
      this.out.text(await this.abbrevId(entry.id, this.abbrevCommit));
      if (log.parent)
        this.out.text(` (from ${await this.abbrevId(log.parent, this.abbrevCommit)})`);
      if (this.decorate) this.out.text(formatRefDecorations(this.decorations, entry.id, {}));
      if (fmt === "oneline") this.out.text(" ");
      else {
        this.out.text("\n");
        this.out.text(this.oneline());
      }
    }
    let notes: string | undefined;
    if (this.showNotes) notes = await this.notesText(entry.id, fmt === "user");
    let msg = await this.prettyPrint(entry, notes ?? "");
    if (fmt !== "user" && notes) {
      if (isMail) {
        msg += this.shownDashes ? "\n" : "---\n";
        this.shownDashes = true;
      }
      msg += notes;
    }
    this.missingNewline = !msg.endsWith("\n");
    this.out.text(this.graph ? this.graph.showCommitMessage(msg) : msg);
    if (this.format.useTerminator && !this.formatIsEmpty()) {
      if (!this.missingNewline) this.out.text(this.padding());
      this.out.text("\n");
    }
  }

  /** notes.c's format_display_notes */
  private async notesText(id: ObjectId, raw: boolean): Promise<string> {
    let out = "";
    for (const { ref, text } of await this.host.notes(id)) {
      let msg = text;
      if (msg.endsWith("\n")) msg = msg.slice(0, -1);
      if (!raw) {
        if (ref === "refs/notes/commits") out += "\nNotes:\n";
        else out += `\nNotes (${ref.replace(/^refs\//, "").replace(/^notes\//, "")}):\n`;
      }
      if (msg === "") continue;
      for (const line of msg.split("\n")) out += `${raw ? "" : "    "}${line}\n`;
    }
    return out;
  }

  /** pretty.c's pretty_print_commit */
  private async prettyPrint(entry: LogOutputEntry, notes: string): Promise<string> {
    const { fmt } = this.format;
    const stored = (await this.host.rawCommit(entry.id)) ?? synthesizeRaw(entry.commit);
    let parsed = parseRaw(stored);
    // the message and the idents in UTF-8 (logmsg_reencode); the idents read from the
    // converted header then
    const reencoded = reencodeCommit(stored, parsed);
    if (reencoded !== undefined) parsed = parseRaw(reencoded);
    // the idents as the (converted) header has them: bytes that are no UTF-8 kept
    const author = parsed.headerLines.find((l) => l.startsWith("author "));
    const committer = parsed.headerLines.find((l) => l.startsWith("committer "));
    const idents: { author: PersonIdent; committer: PersonIdent } = {
      author: (author && identOf(author)) || entry.commit.author,
      committer: (committer && identOf(committer)) || entry.commit.committer,
    };
    if (fmt === "user") {
      const commit: PrettyCommit = {
        ...entry.commit,
        ...idents,
        parents: entry.parents,
        message: parsed.body,
      };
      const mailmap = this.mailmap;
      return formatCommitPretty(this.format.user ?? "", commit, entry.id, {
        abbreviate: (id) => this.abbrevId(id, this.abbrevLength !== 40),
        ...(this.decorations ? { decorations: this.decorations } : {}),
        mark: this.graph ? "*" : "",
        // %N stays as written unless notes are shown
        ...(this.showNotes ? { notes } : {}),
        formatDate: (ident) => this.formatDate(ident),
        ...(mailmap && !mailmap.empty ? { mailmap: (n, e) => mailmap.map(n, e) } : {}),
        ...(this.options.now !== undefined ? { now: this.options.now } : {}),
        ...(this.options.localTzOffset ? { localTzOffset: this.options.localTzOffset } : {}),
      });
    }
    const isMail = fmt === "email" || fmt === "mboxrd";
    const indent = fmt === "oneline" || isMail ? 0 : 4;
    let sb = "";
    // pp_header
    if (fmt === "raw") {
      for (const line of parsed.headerLines) sb += line;
    } else {
      if (fmt !== "oneline" && !isMail && entry.parents.length > 1) {
        sb += "Merge:";
        for (const p of entry.parents) sb += ` ${await this.abbrevId(p, this.abbrevLength !== 40)}`;
        sb += "\n";
      }
      if (fmt !== "oneline") {
        sb = this.userInfo(sb, "Author", idents.author, isMail);
        if (fmt === "full" || fmt === "fuller") {
          sb = this.userInfo(sb, "Commit", idents.committer, false);
        }
      }
    }
    if (fmt !== "oneline" && !isMail) sb += "\n";
    const lines = linesOf(parsed.body);
    let at = skipBlank(lines, 0);
    if (fmt === "oneline" || isMail) {
      const parts: string[] = [];
      for (; at < lines.length; at++) {
        const trimmed = rtrim(lines[at] as string);
        if (trimmed === "") {
          at++;
          break;
        }
        parts.push(trimmed);
      }
      const title = parts.join(" ");
      if (fmt === "oneline") sb += `${title}\n`;
      else {
        sb += "Subject: [PATCH] ";
        if (needsRfc2047(title)) sb += addRfc2047(sb, title, false);
        else sb += wrapText(title, -lastLineLength(sb), 1, 78);
        sb += "\n";
        // need_8bit_cte: a body (after the header) with a byte above 0x7f
        if (hasNonAscii(parsed.body)) {
          sb +=
            "MIME-Version: 1.0\nContent-Type: text/plain; charset=UTF-8\nContent-Transfer-Encoding: 8bit\n";
        }
        sb += "\n";
      }
    }
    const beginningOfBody = sb.length;
    if (fmt !== "oneline") {
      // pp_remainder
      let first = true;
      for (; at < lines.length; at++) {
        const line = rtrim(lines[at] as string);
        if (line === "") {
          if (first) continue;
          if (fmt === "short") break;
        }
        first = false;
        const tabs = this.format.expandTabs;
        if (indent) sb += " ".repeat(indent) + (tabs ? tabExpand(line, tabs) : line);
        else if (tabs) sb += tabExpand(line, tabs);
        else {
          if (fmt === "mboxrd" && line.length > 4 && line.replace(/^>*/, "").startsWith("From ")) {
            sb += ">";
          }
          sb += line;
        }
        sb += "\n";
      }
    }
    sb = rtrim(sb);
    if (fmt !== "oneline") sb += "\n";
    if (isMail && sb.length <= beginningOfBody) sb += "\n";
    return sb;
  }

  /** pretty.c's pp_user_info */
  private userInfo(sb: string, what: string, ident: PersonIdent, mail: boolean): string {
    const { name, email } = this.mapped(ident);
    let out = sb;
    if (mail) {
      let max = 78;
      out += "From: ";
      if (needsRfc2047(name)) {
        out += addRfc2047(out, name, true);
        max = 76;
      } else if ([...name].some((c) => RFC822_SPECIALS.includes(c))) {
        const quoted = `"${name.replace(/["\\]/g, (c) => `\\${c}`)}"`;
        out += wrapText(quoted, -6, 1, max);
      } else out += wrapText(name, -6, 1, max);
      if (max < lastLineLength(out) + 2 + bytesOf(email).length + 1) out += "\n";
      out += ` <${email}>\n`;
    } else {
      out += `${what}: `;
      if (this.format.fmt === "fuller") out += "    ";
      out += `${name} <${email}>\n`;
    }
    switch (this.format.fmt) {
      case "medium":
        out += `Date:   ${this.formatDate(ident)}\n`;
        break;
      case "email":
      case "mboxrd":
        out += `Date: ${this.formatDate(ident, { type: "rfc2822", local: false })}\n`;
        break;
      case "fuller":
        out += `${what}Date: ${this.formatDate(ident)}\n`;
        break;
    }
    return out;
  }

  /** The output so far */
  result(): Uint8Array {
    return this.out.result();
  }
}

/** pathspec.c's magic names, as git lists them in its errors */
const MAGIC_NAMES: [keyof { glob: 1; icase: 1; exclude: 1 }, string][] = [
  ["glob", "'glob'"],
  ["icase", "'icase'"],
  ["exclude", "'exclude' (mnemonic: '!')"],
];

/**
 * The path `--follow` follows (diff_check_follow_pathspec): exactly one element, with no
 * magic but `:(top)` and `:(literal)`; undefined otherwise, or git's error when `--follow`
 * was given.
 */
function followPathOf(paths: string[], explicit: boolean): string | undefined {
  if (paths.length !== 1) {
    if (explicit) {
      throw new InvalidArgumentError("follow", paths, "--follow requires exactly one pathspec");
    }
    return undefined;
  }
  const item = parsePathspecItem(paths[0] as string, { attr: true });
  const names = MAGIC_NAMES.filter(([key]) => item[key]).map(([, name]) => name);
  if (item.attr) names.push("'attr'");
  if (names.length > 0) {
    if (explicit) {
      throw new InvalidArgumentError(
        "follow",
        paths,
        `pathspec magic not supported by --follow: ${names.join(", ")}`,
      );
    }
    return undefined;
  }
  return item.match;
}

/** diff-merges.c's func_by_opt */
export function mergesMode(value: string): LogDiffMerges | undefined {
  switch (value) {
    case "off":
    case "none":
      return "off";
    case "1":
    case "first-parent":
      return "first-parent";
    case "separate":
    case "m":
    case "on":
      return "separate";
    case "c":
    case "combined":
      return "combined";
    case "cc":
    case "dense-combined":
      return "dense-combined";
    default:
      return undefined;
  }
}
