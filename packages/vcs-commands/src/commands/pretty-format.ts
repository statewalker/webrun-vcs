/**
 * git's user formats (`--format=<format>`, `rebase.instructionFormat`): the placeholders
 * pretty.c's format_commit_message expands for one commit.
 *
 * @example
 * ```typescript
 * await formatCommitPretty("# %s (%an)", commit, id, { abbreviate });
 * // "# Fix the parser (A U Thor)"
 * ```
 *
 * Supported: `%H %h %T %t %P %p`, the author and committer parts `%an %aN %ae %aE %al %aL
 * %ad %aD %ar %at %ai %aI %as` (and `%c…`; the mailmap is not read, so `%aN` is `%an`),
 * `%s %f %b %B %e`, `%n %%` and `%x<hex>`, colors (`%Cred`, `%C(...)`; no color is written,
 * as git writes none without a terminal), and the `%+`, `%-` and `% ` magic. A placeholder
 * git does not know, or one this does not support (`%d`, `%(trailers)`, `%<(…)`, `%w(…)`,
 * `%G?`, `%ah`), is kept as written, as git keeps an unknown one.
 *
 * @module
 */

import type { ObjectId, PersonIdent } from "@statewalker/vcs-core";
import { formatRfc2822Date } from "./git-date.js";
import { formatGitDate } from "./sequencer-support.js";

/** What a format reads of the commit besides its fields. */
export interface PrettyFormatOptions {
  /**
   * The abbreviation of an id for `%h`, `%t`, `%p` (git's find_unique_abbrev with the
   * context's `abbrev`); the full id when absent, as with an abbrev of 0
   */
  abbreviate?: (id: ObjectId) => Promise<string>;
  /** Now, in seconds since the epoch, for `%ar` (default: the clock) */
  now?: number;
}

/** What {@link formatCommitPretty} reads of a commit. */
export interface PrettyCommit {
  tree: ObjectId;
  parents: ObjectId[];
  author: PersonIdent;
  committer: PersonIdent;
  message: string;
  encoding?: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** The ident's time shifted into its own zone, as a UTC Date, and the zone in minutes. */
function zoned(ident: PersonIdent): { d: Date; minutes: number; tz: string } {
  const tz = /^[+-]\d{4}$/.test(ident.tzOffset) ? ident.tzOffset : "+0000";
  const sign = tz.startsWith("-") ? -1 : 1;
  const minutes = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
  return { d: new Date((ident.timestamp + minutes * 60) * 1000), minutes, tz };
}

/** git's DATE_ISO8601: `2005-04-07 22:13:13 +0200`. */
function isoDate(ident: PersonIdent): string {
  const { d, tz } = zoned(ident);
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} ${tz}`
  );
}

/** git's DATE_ISO8601_STRICT (2.5x): `2005-04-07T22:13:13+02:00`, `Z` for UTC. */
function strictIsoDate(ident: PersonIdent): string {
  const { d, minutes, tz } = zoned(ident);
  const zone = minutes === 0 ? "Z" : `${tz.slice(0, 3)}:${tz.slice(3)}`;
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}${zone}`
  );
}

/** git's DATE_SHORT: `2005-04-07`. */
function shortDate(ident: PersonIdent): string {
  const { d } = zoned(ident);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** git's show_date_relative: `5 minutes ago`, `2 years, 3 months ago`, `in the future`. */
export function relativeDate(time: number, now: number): string {
  if (now < time) return "in the future";
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;
  let diff = now - time;
  if (diff < 90) return `${n(diff, "second")} ago`;
  diff = Math.floor((diff + 30) / 60);
  if (diff < 90) return `${n(diff, "minute")} ago`;
  diff = Math.floor((diff + 30) / 60);
  if (diff < 36) return `${n(diff, "hour")} ago`;
  diff = Math.floor((diff + 12) / 24);
  if (diff < 14) return `${n(diff, "day")} ago`;
  if (diff < 70) return `${n(Math.floor((diff + 3) / 7), "week")} ago`;
  if (diff < 365) return `${n(Math.floor((diff + 15) / 30), "month")} ago`;
  if (diff < 1825) {
    const total = Math.floor((diff * 12 * 2 + 365) / (365 * 2));
    const years = Math.floor(total / 12);
    const months = total % 12;
    return months ? `${n(years, "year")}, ${n(months, "month")} ago` : `${n(years, "year")} ago`;
  }
  return `${n(Math.floor((diff + 183) / 365), "year")} ago`;
}

/** The message's lines: each with its line end. */
function lineAt(msg: string, at: number): { line: string; next: number } {
  const nl = msg.indexOf("\n", at);
  const next = nl < 0 ? msg.length : nl + 1;
  return { line: msg.slice(at, next), next };
}

const isBlank = (line: string) => line.trim() === "";

/** pretty.c's skip_blank_lines. */
function skipBlankLines(msg: string, at: number): number {
  let i = at;
  while (i < msg.length) {
    const { line, next } = lineAt(msg, i);
    if (!isBlank(line)) break;
    i = next;
  }
  return i;
}

/** pretty.c's format_subject: the first paragraph's lines, right-trimmed, joined by `sep`. */
function formatSubject(msg: string, at: number, sep: string): { text: string; end: number } {
  const parts: string[] = [];
  let i = at;
  while (i < msg.length) {
    const { line, next } = lineAt(msg, i);
    i = next;
    const trimmed = line.replace(/\s+$/, "");
    if (trimmed === "") break;
    parts.push(trimmed);
  }
  return { text: parts.join(sep), end: i };
}

const isTitleChar = (c: string) => /^[A-Za-z0-9._]$/.test(c);

/** pretty.c's format_sanitized_subject: `Fix the parser.` → `Fix-the-parser`. */
export function sanitizedSubject(line: string): string {
  let out = "";
  let space = 2;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] as string;
    if (isTitleChar(c)) {
      if (space === 1) out += "-";
      space = 0;
      out += c;
      if (c === ".") while (line[i + 1] === ".") i++;
    } else space |= 1;
  }
  return out.replace(/[.-]+$/, "");
}

const COLORS = ["reset", "red", "green", "blue"];

/**
 * One placeholder at `fmt[at]` (after `%`): its expansion and the characters it takes; 0
 * taken for one git does not know (or this does not support).
 */
async function formatOne(
  fmt: string,
  at: number,
  commit: PrettyCommit,
  id: ObjectId,
  options: PrettyFormatOptions,
): Promise<{ text: string; taken: number }> {
  const c = fmt[at];
  const abbrev = (oid: ObjectId) => (options.abbreviate ? options.abbreviate(oid) : oid);
  const none = { text: "", taken: 0 };
  switch (c) {
    case "n":
      return { text: "\n", taken: 1 };
    case "x": {
      const hex = /^[0-9a-fA-F]{2}/.exec(fmt.slice(at + 1));
      return hex ? { text: String.fromCharCode(Number.parseInt(hex[0], 16)), taken: 3 } : none;
    }
    case "C": {
      for (const name of COLORS) {
        if (fmt.startsWith(name, at + 1)) return { text: "", taken: 1 + name.length };
      }
      if (fmt[at + 1] === "(") {
        const end = fmt.indexOf(")", at + 2);
        return end < 0 ? none : { text: "", taken: end - at + 1 };
      }
      return none;
    }
    case "H":
      return { text: id, taken: 1 };
    case "h":
      return { text: await abbrev(id), taken: 1 };
    case "T":
      return { text: commit.tree, taken: 1 };
    case "t":
      return { text: await abbrev(commit.tree), taken: 1 };
    case "P":
      return { text: commit.parents.join(" "), taken: 1 };
    case "p": {
      const parts: string[] = [];
      for (const p of commit.parents) parts.push(await abbrev(p));
      return { text: parts.join(" "), taken: 1 };
    }
    case "a":
    case "c": {
      const ident = c === "a" ? commit.author : commit.committer;
      const part = formatPersonPart(ident, fmt[at + 1], options);
      return part === undefined ? none : { text: part, taken: 2 };
    }
    case "e":
      return { text: commit.encoding ?? "", taken: 1 };
    case "B":
      return { text: commit.message, taken: 1 };
    case "s": {
      const start = skipBlankLines(commit.message, 0);
      return { text: formatSubject(commit.message, start, " ").text, taken: 1 };
    }
    case "f": {
      const start = skipBlankLines(commit.message, 0);
      const nl = commit.message.indexOf("\n", start);
      const line = commit.message.slice(start, nl < 0 ? commit.message.length : nl);
      return { text: sanitizedSubject(line), taken: 1 };
    }
    case "b": {
      const start = skipBlankLines(commit.message, 0);
      const { end } = formatSubject(commit.message, start, " ");
      return { text: commit.message.slice(skipBlankLines(commit.message, end)), taken: 1 };
    }
    default:
      return none;
  }
}

/** pretty.c's format_person_part; undefined for a part it does not know. */
function formatPersonPart(
  ident: PersonIdent,
  part: string | undefined,
  options: PrettyFormatOptions,
): string | undefined {
  switch (part) {
    case "n":
    case "N":
      return ident.name;
    case "e":
    case "E":
      return ident.email;
    case "l":
    case "L": {
      const at = ident.email.indexOf("@");
      return at < 0 ? ident.email : ident.email.slice(0, at);
    }
    case "t":
      return String(ident.timestamp);
    case "d":
      return formatGitDate(ident);
    case "D":
      return formatRfc2822Date(ident.timestamp, zoned(ident).tz);
    case "r":
      return relativeDate(ident.timestamp, options.now ?? Math.floor(Date.now() / 1000));
    case "i":
      return isoDate(ident);
    case "I":
      return strictIsoDate(ident);
    case "s":
      return shortDate(ident);
    default:
      return undefined;
  }
}

/**
 * `format` expanded for commit `id` as git's format_commit_message expands a user format:
 * each `%<placeholder>`, with the `%+` (a newline before a non-empty expansion), `%-` (the
 * newlines before an empty one removed) and `% ` (a space before a non-empty one) magic.
 */
export async function formatCommitPretty(
  format: string,
  commit: PrettyCommit,
  id: ObjectId,
  options: PrettyFormatOptions = {},
): Promise<string> {
  let out = "";
  let i = 0;
  while (i < format.length) {
    const pct = format.indexOf("%", i);
    if (pct < 0) {
      out += format.slice(i);
      break;
    }
    out += format.slice(i, pct);
    i = pct + 1;
    if (format[i] === "%") {
      out += "%";
      i++;
      continue;
    }
    let magic = format[i];
    if (magic === "+" || magic === "-" || magic === " ") {
      i++;
      // `%+w()` cannot be handled: refused, kept as written
      if (format[i] === "w") magic = "!";
    } else magic = "";
    const one =
      magic === "!" ? { text: "", taken: 0 } : await formatOne(format, i, commit, id, options);
    if (one.taken === 0) {
      // git: not a placeholder, the `%` is written and what follows read as text
      out += "%";
      if (magic) i--;
      continue;
    }
    i += one.taken;
    if (magic === "-" && one.text === "") out = out.replace(/\n+$/, "");
    else if (one.text !== "") {
      if (magic === "+") out += "\n";
      else if (magic === " ") out += " ";
    }
    out += one.text;
  }
  return out;
}
