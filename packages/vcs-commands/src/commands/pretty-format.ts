/**
 * git's user formats (`--format=<format>`, `rebase.instructionFormat`): the placeholders
 * pretty.c's format_commit_message expands for one commit.
 *
 * @example
 * ```typescript
 * await formatCommitPretty("# %s (%an)", commit, id, { abbreviate });
 * // "# Fix the parser (A U Thor)"
 * const decorations = await loadRefDecorations({ refs, tags });
 * await formatCommitPretty("%h%d", commit, id, { abbreviate, decorations });
 * // "1a2b3c4 (HEAD -> main, tag: v1, origin/main)"
 * ```
 *
 * Supported: `%H %h %T %t %P %p`, the author and committer parts `%an %aN %ae %aE %al %aL
 * %ad %aD %ar %at %ai %aI %as %ah` (and `%c…`; `%aN`, `%aE`, `%aL` through the mailmap given, `%ad` in the date mode given),
 * `%s %f %b %B %e`, `%n %%` and `%x<hex>` (a byte above 0x7f as the repository's byte strings
 * keep a raw byte: U+DC80 to U+DCFF, which `encodeGitPath` writes back as that byte), `%d %D`
 * and `%(decorate:…)` from {@link loadRefDecorations}, `%m` (`>`, or the mark given), `%G?`
 * (`N` unsigned; a signed commit is `E`, as git prints for a signature it cannot check) and
 * the other `%G` parts (empty; `%GT` `undefined`), `%N` (the notes given, else kept as
 * written, as git's sequencer keeps it), `%gd %gD %gs %gn %gN %ge %gE` (the reflog entry
 * given, else empty), colors (`%Cred`, `%C(...)`: written only with `color`, or `always,`),
 * padding (`%<(N)`, `%>(N)`, `%><(N)`, `%>>(N)`, the `|` column forms, `trunc`, `ltrunc`,
 * `mtrunc`), wrapping (`%w(width,indent1,indent2)`), the `%+`, `%-` and `% ` magic,
 * `%(trailers[:options])` (trailer.c's block detection and formatting, with the
 * {@link TrailerConfig} given), `%(describe[:options])` (with the describer given), `%S`
 * (the source given) and git 2.5x's `%(count)`/`%(total)`. A placeholder git does not
 * know is kept as written, as git keeps an unknown one.
 *
 * @module
 */

import type { ObjectId, PersonIdent } from "@statewalker/vcs-core";
import { gitCharWidth } from "@statewalker/vcs-utils/encoding";
import { formatRfc2822Date } from "./git-date.js";
import type { DescribeOptions } from "./git-describe.js";
import {
  createRefDecorationFilter,
  decorateFullRefs,
  type RefDecorationFilterOptions,
} from "./ref-decoration-filter.js";
import { formatGitDate } from "./sequencer-support.js";
import { appendTrailers, type TrailerConfig, type TrailerFormatOptions } from "./trailers.js";

/** What a format reads of the commit besides its fields. */
export interface PrettyFormatOptions {
  /**
   * The abbreviation of an id for `%h`, `%t`, `%p` (git's find_unique_abbrev with the
   * context's `abbrev`); the full id when absent, as with an abbrev of 0
   */
  abbreviate?: (id: ObjectId) => Promise<string>;
  /** Now, in seconds since the epoch, for `%ar` and `%ah` (default: the clock) */
  now?: number;
  /**
   * The local time zone's offset east of UTC, in minutes, at a time in seconds (`%ah` hides
   * the zone of a date in it); default: the host's (`Date.getTimezoneOffset`)
   */
  localTzOffset?: (time: number) => number;
  /** The decorations `%d`, `%D` and `%(decorate)` show (see {@link loadRefDecorations}) */
  decorations?: RefDecorations;
  /** `%m`: the commit's mark (`<`, `>`, `-` boundary, `^` uninteresting); default `>` */
  mark?: string;
  /** `%N`: the commit's notes; without, `%N` is kept as written (git's sequencer) */
  notes?: string;
  /** `%gd`, `%gD`, `%gs`, `%gn`…: the reflog entry shown; empty without */
  reflog?: { selector?: string; shortSelector?: string; message?: string; ident?: PersonIdent };
  /** Whether colors are written (git's want_color; default false, as without a terminal) */
  color?: boolean;
  /**
   * `%(trailers)`: the trailer configuration (`trailer.separators`, `trailer.<name>.key`,
   * the comment prefix; see {@link trailerConfigOf}); default git's (`:`, `#`, no items)
   */
  trailers?: TrailerConfig;
  /**
   * `%(describe)`: git describe of a commit (see {@link createDescriber}); without, the
   * placeholder is kept as written
   */
  describe?: (id: ObjectId, options: DescribeOptions) => Promise<string>;
  /**
   * `%S`: the name on the command line the commit was reached from (`git log --source`, or
   * a `%S` in log's format); without, `%S` is kept as written, as git keeps it without a
   * revision walk's sources
   */
  source?: string;
  /**
   * `%(count)` and `%(total)` (git 2.5x): the walk's number of this commit and the count
   * (`git log` gives 0 and 0, `format-patch` the patch numbers); without, git's "not
   * supported by this command"
   */
  count?: { nr: number; total: number };
  /**
   * `%ad` and `%cd`: the date in the walk's date mode (`--date`, `log.date`); default git's
   * default mode
   */
  formatDate?: (ident: PersonIdent) => string;
  /**
   * `%aN`, `%aE`, `%aL` (and `%c…`): the identity through the mailmap (see `Mailmap`);
   * without, they are `%an`, `%ae`, `%al`
   */
  mailmap?: (name: string, email: string) => { name: string; email: string };
}

/** One name a commit is decorated with (log-tree.c's name_decoration). */
export interface RefDecoration {
  type: "head" | "local" | "remote" | "tag" | "stash" | "grafted" | "none";
  /** The full ref name, `HEAD`, `grafted` or `replaced` */
  name: string;
}

/** The decorations of each object, as load_ref_decorations collects them. */
export interface RefDecorations {
  /** An object's decorations, in git's order (the last added first) */
  get(id: ObjectId): readonly RefDecoration[] | undefined;
  /** The branch HEAD names (`refs/heads/main`); undefined when detached */
  headBranch?: string;
  /** Full ref names are shown (`log.decorate=full`, `--decorate=full`); short ones by default */
  fullRefs?: boolean;
}

/** Options of {@link loadRefDecorations}. */
export interface LoadRefDecorationsOptions {
  /** The refs decorated (every ref, then HEAD) */
  refs: {
    list(prefix?: string): AsyncIterable<{ name: string; objectId?: ObjectId; target?: string }>;
    resolve(name: string): Promise<{ objectId?: ObjectId } | undefined>;
  };
  /** Annotated tags: a tag ref decorates each object of its chain */
  tags?: {
    has(id: ObjectId): Promise<boolean>;
    load(id: ObjectId): Promise<{ object: ObjectId } | undefined>;
  };
  /**
   * `git log`'s default decoration filter: only HEAD, `refs/heads/`, `refs/tags/`,
   * `refs/remotes/`, `refs/stash` and the replace refs (default false: every ref, as git's
   * sequencer loads them)
   */
  logFilter?: boolean;
  /**
   * `git log`'s decoration options and settings (see `createRefDecorationFilter`):
   * `--decorate-refs`, `--decorate-refs-exclude`, `--clear-decorations`, and the
   * configuration's `log.excludeDecoration`, `log.initialDecorationSet` and `log.decorate`
   * (`full`: full ref names). Given, the refs are filtered as `git log` filters them, as with
   * `logFilter`.
   */
  logOptions?: Omit<RefDecorationFilterOptions, "replaceRefBase"> & {
    /** `--decorate=short|full` (default `log.decorate`, else short) */
    decorate?: "short" | "full";
  };
  /** Where replace refs live (default `refs/replace/`); their originals read `replaced` */
  replaceRefBase?: string;
  /** Whether replace refs apply (default true); off, they decorate nothing */
  useReplaceRefs?: boolean;
  /** The grafted commits (and shallow ones), each decorated `grafted` */
  grafted?: Iterable<ObjectId>;
  /** Whether an object is stored (a replaced original that is not is not decorated) */
  hasObject?: (id: ObjectId) => Promise<boolean>;
  /**
   * Receives what git prints on stderr while decorating: `warning: invalid replace ref
   * <name>` for a ref under the replace base that does not start with an object id below it
   */
  onWarning?: (message: string) => void;
}

/**
 * The decorations of a repository's objects, as git's load_ref_decorations makes them: each
 * ref in name order, then HEAD, then each graft, every one put before those its object
 * already has; a ref is typed by its namespace, an annotated tag decorates every object of
 * its chain as a tag, a replace ref decorates the object it replaces as `replaced`.
 */
export async function loadRefDecorations(
  options: LoadRefDecorationsOptions,
): Promise<RefDecorations> {
  const map = new Map<ObjectId, RefDecoration[]>();
  const add = (id: ObjectId, decoration: RefDecoration) => {
    const list = map.get(id);
    if (list) list.unshift(decoration);
    else map.set(id, [decoration]);
  };
  const replaceBase = options.replaceRefBase ?? "refs/replace/";
  const logOptions = options.logOptions;
  const included =
    options.logFilter || logOptions
      ? createRefDecorationFilter({ ...logOptions, replaceRefBase: replaceBase })
      : () => true;
  const fullRefs = logOptions?.decorate
    ? logOptions.decorate === "full"
    : decorateFullRefs(logOptions?.config);
  const typeOf = (name: string): RefDecoration["type"] => {
    if (name === "HEAD") return "head";
    if (name.startsWith("refs/heads/")) return "local";
    if (name.startsWith("refs/tags/")) return "tag";
    if (name.startsWith("refs/remotes/")) return "remote";
    if (name === "refs/stash") return "stash";
    return "none";
  };
  const decorateRef = async (name: string, value: ObjectId | undefined) => {
    if (!included(name)) return;
    if (name.startsWith(replaceBase)) {
      if (options.useReplaceRefs === false) return;
      const hex = name.slice(replaceBase.length);
      const hexLength = /^[0-9a-fA-F]{64}/.test(hex) ? 64 : 40;
      if (!/^[0-9a-fA-F]{40}/.test(hex)) {
        // add_ref_decoration: get_oid_hex of what follows the base
        options.onWarning?.(`warning: invalid replace ref ${name}`);
        return;
      }
      const original = hex.slice(0, hexLength).toLowerCase();
      if (options.hasObject && !(await options.hasObject(original))) return;
      add(original, { type: "grafted", name: "replaced" });
      return;
    }
    if (!value) return;
    add(value, { type: typeOf(name), name });
    // an annotated tag: each object of its chain is decorated as a tag
    let id = value;
    for (let depth = 0; depth < 32 && options.tags && (await options.tags.has(id)); depth++) {
      const tag = await options.tags.load(id);
      if (!tag) break;
      id = tag.object;
      add(id, { type: "tag", name });
    }
  };
  const names: { name: string; objectId?: ObjectId; target?: string }[] = [];
  for await (const ref of options.refs.list()) {
    if (ref.name === "HEAD" || !ref.name.startsWith("refs/")) continue;
    names.push(ref);
  }
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ref of names) {
    const value =
      ref.objectId && ref.target === undefined
        ? ref.objectId
        : (await options.refs.resolve(ref.name))?.objectId;
    await decorateRef(ref.name, value);
  }
  let headBranch: string | undefined;
  for await (const ref of options.refs.list("HEAD")) {
    if (ref.name === "HEAD" && ref.target !== undefined) headBranch = ref.target;
  }
  await decorateRef("HEAD", (await options.refs.resolve("HEAD"))?.objectId);
  for (const id of options.grafted ?? []) add(id, { type: "grafted", name: "grafted" });
  return {
    get: (id) => map.get(id),
    ...(headBranch?.startsWith("refs/") ? { headBranch } : {}),
    ...(fullRefs ? { fullRefs } : {}),
  };
}

/** git's prettify_refname: `refs/heads/`, `refs/tags/`, `refs/remotes/` dropped. */
function prettifyRefName(name: string): string {
  for (const prefix of ["refs/heads/", "refs/tags/", "refs/remotes/"]) {
    if (name.startsWith(prefix)) return name.slice(prefix.length);
  }
  return name;
}

/**
 * log-tree.c's format_decorations, without colors: ` (HEAD -> main, tag: v1)` by default,
 * the separators given otherwise; empty when the object has no decorations.
 */
export function formatRefDecorations(
  decorations: RefDecorations | undefined,
  id: ObjectId,
  opts: { prefix?: string; suffix?: string; separator?: string; pointer?: string; tag?: string },
): string {
  const list = decorations?.get(id);
  if (!list) return "";
  let prefix = opts.prefix ?? " (";
  const suffix = opts.suffix ?? ")";
  const separator = opts.separator ?? ", ";
  const pointer = opts.pointer ?? " -> ";
  const tag = opts.tag ?? "tag: ";
  // current_pointed_by_HEAD: HEAD's branch, when both are in the list
  const head = list.find((d) => d.type === "head");
  const current =
    head && decorations?.headBranch
      ? list.find((d) => d.type === "local" && d.name === decorations.headBranch)
      : undefined;
  let out = "";
  for (const d of list) {
    if (d === current) continue;
    out += prefix;
    if (tag && d.type === "tag") out += tag;
    // show_name: full names with --decorate=full
    const show = (name: string) => (decorations?.fullRefs ? name : prettifyRefName(name));
    out += show(d.name);
    if (current && d.type === "head") out += pointer + show(current.name);
    prefix = separator;
  }
  return out + suffix;
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * git's DATE_HUMAN (date.c show_date_normal with the current time): today's dates relative,
 * this week's `Wed 14:03`, this year's `Mar 3`, older ones `Mar 3 2019`; the zone shown only
 * when it is not the local one (and the date is near).
 */
export function humanDate(
  ident: PersonIdent,
  now: number,
  localTzOffset: (time: number) => number,
): string {
  const { d, tz } = zoned(ident);
  const nowMinutes = localTzOffset(now);
  const human = new Date((now + nowMinutes * 60) * 1000);
  const sign = nowMinutes < 0 ? "-" : "+";
  const abs = Math.abs(nowMinutes);
  const humanTz = `${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
  const hide = { year: false, date: false, wday: false, time: false, seconds: false, tz: false };
  hide.tz = tz === humanTz;
  hide.year = d.getUTCFullYear() === human.getUTCFullYear();
  if (hide.year && d.getUTCMonth() === human.getUTCMonth()) {
    if (d.getUTCDate() > human.getUTCDate()) {
      // a future date: think time zones
    } else if (d.getUTCDate() === human.getUTCDate()) {
      hide.date = hide.wday = true;
    } else if (d.getUTCDate() + 5 > human.getUTCDate()) {
      hide.date = true;
    }
  }
  if (hide.wday) return relativeDate(ident.timestamp, now);
  hide.seconds = true;
  hide.tz ||= !hide.date;
  hide.wday = hide.time = !hide.year;
  let out = "";
  if (!hide.wday) out += `${WEEKDAYS[d.getUTCDay()]} `;
  if (!hide.date) out += `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()} `;
  if (!hide.time) out += `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  else out = out.replace(/[ \t\n\r]+$/, "");
  if (!hide.year) out += ` ${d.getUTCFullYear()}`;
  if (!hide.tz) out += ` ${tz}`;
  return out;
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

/** git's isspace (sane_ctype): space, tab, LF and CR only, never NBSP or other spaces */
const GIT_SPACE = /[ \t\n\r]/;
const TRAILING_SPACE = /[ \t\n\r]+$/;
const isBlank = (line: string) => line.replace(TRAILING_SPACE, "") === "";

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
    const trimmed = line.replace(TRAILING_SPACE, "");
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

/** A byte of `%x`: ASCII as itself, a byte above 0x7f as the byte strings keep it raw. */
const rawByte = (n: number) => String.fromCharCode(n < 0x80 ? n : 0xdc00 + n);

/** git's hex2chr: two hex digits; -1 when not. */
function hex2chr(text: string, at: number): number {
  const hex = /^[0-9a-fA-F]{2}/.exec(text.slice(at, at + 2));
  return hex ? Number.parseInt(hex[0], 16) : -1;
}

/** strbuf_expand_literal: `%n` and `%x<hex>`; 0 when the placeholder is neither. */
function expandLiteral(fmt: string, at: number): { text: string; taken: number } {
  if (fmt[at] === "n") return { text: "\n", taken: 1 };
  if (fmt[at] === "x") {
    const ch = hex2chr(fmt, at + 1);
    if (ch >= 0) return { text: rawByte(ch), taken: 3 };
  }
  return { text: "", taken: 0 };
}

/** pretty.c's expand_string_arg: an argument's `%n`, `%x<hex>` and `%%` expanded. */
export function expandStringArg(arg: string): string {
  let out = "";
  for (let i = 0; i < arg.length; i++) {
    if (arg[i] !== "%") {
      out += arg[i];
      continue;
    }
    if (arg[i + 1] === "%") {
      out += "%";
      i++;
      continue;
    }
    const literal = expandLiteral(arg, i + 1);
    if (literal.taken > 0) {
      out += literal.text;
      i += literal.taken;
    } else out += "%";
  }
  return out;
}

const ANSI_COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const ATTRS: Record<string, [number, number]> = {
  bold: [1, 22],
  dim: [2, 22],
  italic: [3, 23],
  ul: [4, 24],
  blink: [5, 25],
  reverse: [7, 27],
  strike: [9, 29],
};

/** Thrown for a color git cannot parse ("unable to parse --pretty format"). */
export class PrettyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrettyFormatError";
  }
}

/** color.c's color_parse_mem: the escape sequence of a color spec (`bold red`, `#ff0000`). */
export function parseColorSpec(spec: string): string {
  const words = spec.split(/[ \t\n\r]+/).filter((w) => w !== "");
  if (words.length === 0) return "";
  type Color =
    | { kind: "normal" }
    | { kind: "ansi"; value: number }
    | { kind: "256"; value: number }
    | { kind: "rgb"; r: number; g: number; b: number };
  const parseOne = (word: string): Color | undefined => {
    const w = word.toLowerCase();
    if (w === "normal") return { kind: "normal" };
    if ((word.length === 7 || word.length === 4) && word[0] === "#") {
      const per = word.length === 7 ? 2 : 1;
      const parts = [1, 1 + per, 1 + 2 * per].map((at) => word.slice(at, at + per));
      if (parts.every((p) => /^[0-9a-fA-F]+$/.test(p))) {
        const [r, g, b] = parts.map((p) => Number.parseInt(per === 1 ? p + p : p, 16)) as [
          number,
          number,
          number,
        ];
        return { kind: "rgb", r, g, b };
      }
    }
    if (w === "default") return { kind: "ansi", value: 39 };
    let base = 30;
    let name = w;
    if (name.startsWith("bright")) {
      base = 90;
      name = name.slice(6);
    }
    const index = ANSI_COLORS.indexOf(name);
    if (index >= 0) return { kind: "ansi", value: base + index };
    if (/^-?\d+$/.test(word)) {
      const val = Number(word);
      if (val === -1) return { kind: "normal" };
      if (val >= 0 && val < 8) return { kind: "ansi", value: 30 + val };
      if (val >= 8 && val < 16) return { kind: "ansi", value: 90 + val - 8 };
      if (val >= 16 && val < 256) return { kind: "256", value: val };
    }
    return undefined;
  };
  let reset = false;
  let attr = 0;
  let fg: Color | undefined;
  let bg: Color | undefined;
  for (const word of words) {
    if (word.toLowerCase() === "reset") {
      reset = true;
      continue;
    }
    const color = parseOne(word);
    if (color) {
      if (!fg) fg = color;
      else if (!bg) bg = color;
      else throw new PrettyFormatError("fatal: unable to parse --pretty format");
      continue;
    }
    let name = word.toLowerCase();
    let negate = false;
    if (name.startsWith("no")) {
      negate = true;
      name = name.slice(2).replace(/^-/, "");
    }
    const a = ATTRS[name];
    if (!a) throw new PrettyFormatError("fatal: unable to parse --pretty format");
    attr |= 1 << (negate ? a[1] : a[0]);
  }
  const output = (c: Color, background: boolean): string | undefined => {
    const offset = background ? 10 : 0;
    switch (c.kind) {
      case "normal":
        return undefined;
      case "ansi":
        return String(c.value + offset);
      case "256":
        return `${38 + offset};5;${c.value}`;
      case "rgb":
        return `${38 + offset};2;${c.r};${c.g};${c.b}`;
    }
  };
  const fgOut = fg ? output(fg, false) : undefined;
  const bgOut = bg ? output(bg, true) : undefined;
  if (!reset && attr === 0 && fgOut === undefined && bgOut === undefined) return "";
  const parts: string[] = [];
  if (reset) parts.push("");
  for (let i = 0; attr; i++) {
    if (!(attr & (1 << i))) continue;
    attr &= ~(1 << i);
    parts.push(String(i));
  }
  if (fgOut !== undefined) parts.push(fgOut);
  if (bgOut !== undefined) parts.push(bgOut);
  // a reset is an empty first field: "\x1b[;31m"
  return `\x1b[${parts.join(";")}m`;
}

/** The length of the ANSI color sequence at `at` (display_mode_esc_sequence_len); 0 if none. */
function escapeLength(text: string, at: number): number {
  if (text[at] !== "\x1b" || text[at + 1] !== "[") return 0;
  let i = at + 2;
  while (i < text.length && /[0-9;]/.test(text[i] as string)) i++;
  return text[i] === "m" ? i + 1 - at : 0;
}

/**
 * The columns a code point takes (git's utf8_width, its unicode-width tables: wide East Asian
 * 2, combining and other non-spacing 0), a control character none.
 */
function charWidth(cp: number): number {
  return Math.max(gitCharWidth(cp), 0);
}

/** utf8_strnwidth with skip_ansi: the columns of `text`, color sequences taking none. */
function displayWidth(text: string): number {
  let w = 0;
  for (let i = 0; i < text.length; ) {
    const esc = escapeLength(text, i);
    if (esc) {
      i += esc;
      continue;
    }
    const cp = text.codePointAt(i) as number;
    w += charWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  return w;
}

/** strbuf_utf8_replace: the columns [pos, pos + width) of `text` replaced by `subst`. */
function utf8Replace(text: string, pos: number, width: number, subst: string): string {
  let out = "";
  let w = 0;
  let replaced = false;
  for (let i = 0; i < text.length; ) {
    const esc = escapeLength(text, i);
    if (esc) {
      out += text.slice(i, i + esc);
      i += esc;
      continue;
    }
    const cp = text.codePointAt(i) as number;
    const len = cp > 0xffff ? 2 : 1;
    const cw = charWidth(cp);
    // a character of no width (a combining mark) is kept, attached to what precedes it
    if (cw && w >= pos && w < pos + width) {
      if (!replaced) {
        out += subst;
        replaced = true;
      }
    } else out += text.slice(i, i + len);
    w += cw;
    i += len;
  }
  if (!replaced) out += subst;
  return out;
}

const isAlnum = (c: string | undefined) => c !== undefined && /^[A-Za-z0-9]$/.test(c);

/** utf8.c's strbuf_add_wrapped_text: `text` wrapped at `width` columns. */
export function wrapText(text: string, indent1: number, indent2: number, width: number): string {
  if (width <= 0) {
    // strbuf_add_indented_text
    let out = "";
    let indent = Math.max(indent1, 0);
    let i = 0;
    while (i < text.length) {
      const nl = text.indexOf("\n", i);
      const eol = nl < 0 ? text.length : nl + 1;
      out += " ".repeat(indent) + text.slice(i, eol);
      i = eol;
      indent = indent2;
    }
    return out;
  }
  let out = "";
  let bol = 0;
  let w = indent1;
  let indent = indent1;
  let space: number | undefined;
  if (indent < 0) {
    w = -indent;
    space = 0;
  }
  let i = 0;
  for (;;) {
    let esc = escapeLength(text, i);
    while (esc) {
      i += esc;
      esc = escapeLength(text, i);
    }
    const c = text[i];
    if (c === undefined || GIT_SPACE.test(c)) {
      if (w <= width || space === undefined) {
        let start = bol;
        if (c === undefined && i === start) return out;
        if (space !== undefined) start = space;
        else out += " ".repeat(Math.max(indent, 0));
        out += text.slice(start, i);
        if (c === undefined) return out;
        space = i;
        if (c === "\t") w |= 0x07;
        else if (c === "\n") {
          space++;
          if (text[space] === "\n") {
            out += "\n";
            // new line
            out += "\n";
            bol = space + (GIT_SPACE.test(text[space] ?? "") ? 1 : 0);
            i = bol;
            space = undefined;
            w = indent = indent2;
            continue;
          } else if (!isAlnum(text[space])) {
            out += "\n";
            bol = space + (GIT_SPACE.test(text[space] ?? "") ? 1 : 0);
            i = bol;
            space = undefined;
            w = indent = indent2;
            continue;
          } else out += " ";
        }
        w++;
        i++;
      } else {
        out += "\n";
        bol = space + (GIT_SPACE.test(text[space] ?? "") ? 1 : 0);
        i = bol;
        space = undefined;
        w = indent = indent2;
      }
      continue;
    }
    const cp = text.codePointAt(i) as number;
    // utf8_width as is: a control character takes a column back (-1)
    w += gitCharWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
}

/** The output being built, and the state git's format_commit_context keeps. */
interface FormatState {
  sb: string;
  /** %w: where the text to wrap starts, and the wrapping in force */
  wrapStart: number;
  width: number;
  indent1: number;
  indent2: number;
  /** %<( and friends: the padding of the next placeholder */
  flush: "none" | "left" | "right" | "both" | "left-steal";
  padding: number;
  truncate: "none" | "left" | "middle" | "right";
  /** whether %C(auto) is in force (colors only with options.color) */
  autoColor: boolean;
}

/** git's rewrap_message_tail. */
function rewrapTail(st: FormatState, width: number, indent1: number, indent2: number): void {
  if (st.width === width && st.indent1 === indent1 && st.indent2 === indent2) return;
  if (st.wrapStart < st.sb.length) {
    st.sb =
      st.sb.slice(0, st.wrapStart) +
      wrapText(st.sb.slice(st.wrapStart), st.indent1, st.indent2, st.width);
  }
  st.wrapStart = st.sb.length;
  st.width = width;
  st.indent1 = indent1;
  st.indent2 = indent2;
}

/** git's FORMATTING_LIMIT */
const FORMATTING_LIMIT = 16 * 1024;

/** pretty.c's parse_padding_placeholder; 0 when it is none. */
function parsePadding(fmt: string, at: number, st: FormatState): number {
  let ch = at;
  let flush: FormatState["flush"];
  const first = fmt[ch++];
  if (first === "<") flush = "right";
  else if (first === ">") {
    if (fmt[ch] === "<") {
      flush = "both";
      ch++;
    } else if (fmt[ch] === ">") {
      flush = "left-steal";
      ch++;
    } else flush = "left";
  } else return 0;
  let toColumn = false;
  if (fmt[ch] === "|") {
    toColumn = true;
    ch++;
  }
  if (fmt[ch] !== "(") return 0;
  const start = ch + 1;
  let end = start;
  while (end < fmt.length && fmt[end] !== "," && fmt[end] !== ")") end++;
  if (end >= fmt.length || end === start) return 0;
  const num = /^[ \t\n\r]*[+-]?\d+/.exec(fmt.slice(start, end));
  if (!num) return 0;
  let width = Number.parseInt(num[0], 10);
  if (width < -FORMATTING_LIMIT || width > FORMATTING_LIMIT || width === 0) return 0;
  if (width < 0) {
    // the terminal's width: 80 without a terminal
    if (toColumn) width += 80;
    if (width < 0) return 0;
  }
  let truncate: FormatState["truncate"] = "none";
  let close = end;
  if (fmt[end] === ",") {
    const s = end + 1;
    close = fmt.indexOf(")", s);
    if (close < 0 || close === s) return 0;
    const rest = fmt.slice(s);
    if (rest.startsWith("trunc)")) truncate = "right";
    else if (rest.startsWith("ltrunc)")) truncate = "left";
    else if (rest.startsWith("mtrunc)")) truncate = "middle";
    else return 0;
  }
  st.padding = toColumn ? -width : width;
  st.flush = flush;
  st.truncate = truncate;
  return close - at + 1;
}

/**
 * pretty.c's match_placeholder_arg_value: `<name>` or `<name>=<value>` at `at`, followed by
 * `,` (taken) or `)` (left); the value runs to the next `,` or `)`.
 */
export function matchArgValue(
  fmt: string,
  at: number,
  name: string,
): { value?: string; end: number } | undefined {
  if (!fmt.startsWith(name, at)) return undefined;
  let p = at + name.length;
  let value: string | undefined;
  if (fmt[p] === "=") {
    let e = p + 1;
    while (e < fmt.length && fmt[e] !== "," && fmt[e] !== ")") e++;
    value = fmt.slice(p + 1, e);
    p = e;
  } else if (fmt[p] !== "," && fmt[p] !== ")") return undefined;
  if (fmt[p] === ",") return { ...(value !== undefined ? { value } : {}), end: p + 1 };
  if (fmt[p] === ")") return { ...(value !== undefined ? { value } : {}), end: p };
  return undefined;
}

/** git_parse_maybe_bool: true/yes/on, false/no/off, "" (false), a number; else -1. */
export function parseMaybeBool(value: string): boolean | undefined {
  const v = value.toLowerCase();
  if (v === "true" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "no" || v === "off" || v === "") return false;
  const n = /^([+-]?\d+)([kmg]?)$/.exec(v);
  if (n) return Number(n[1]) !== 0;
  return undefined;
}

/** pretty.c's match_placeholder_bool_arg: `<name>` (true) or `<name>=<bool>`. */
export function matchBoolArg(
  fmt: string,
  at: number,
  name: string,
): { value: boolean; end: number } | undefined {
  const arg = matchArgValue(fmt, at, name);
  if (!arg) return undefined;
  if (arg.value === undefined) return { value: true, end: arg.end };
  const value = parseMaybeBool(arg.value);
  return value === undefined ? undefined : { value, end: arg.end };
}

/** The commit and what the format reads besides it. */
interface FormatContext {
  commit: PrettyCommit;
  id: ObjectId;
  options: PrettyFormatOptions;
}

/**
 * pretty.c's format_commit_one: one placeholder at `fmt[at]` (after `%`) expanded at the end
 * of `st.sb`; the characters it takes, 0 for one git does not know (or this does not
 * support).
 */
async function formatOne(
  fmt: string,
  at: number,
  st: FormatState,
  cx: FormatContext,
): Promise<number> {
  const { commit, id, options } = cx;
  const literal = expandLiteral(fmt, at);
  if (literal.taken > 0) {
    st.sb += literal.text;
    return literal.taken;
  }
  const c = fmt[at];
  const abbrev = (oid: ObjectId) => (options.abbreviate ? options.abbreviate(oid) : oid);
  switch (c) {
    case "C": {
      if (fmt.startsWith("(auto)", at + 1)) {
        st.autoColor = !!options.color;
        if (options.color && st.sb.length > 0) st.sb += "\x1b[m";
        return 7;
      }
      if (fmt[at + 1] === "(") {
        const end = fmt.indexOf(")", at + 2);
        if (end < 0) return 0;
        let spec = fmt.slice(at + 2, end);
        let want = !!options.color;
        if (spec.startsWith("auto,")) spec = spec.slice(5);
        else if (spec.startsWith("always,")) {
          spec = spec.slice(7);
          want = true;
        }
        st.autoColor = false;
        if (!want) return end - at + 1;
        st.sb += parseColorSpec(spec);
        return end - at + 1;
      }
      const basic: Record<string, string> = {
        red: "\x1b[31m",
        green: "\x1b[32m",
        blue: "\x1b[34m",
        reset: "\x1b[m",
      };
      for (const name of ["red", "green", "blue", "reset"]) {
        if (fmt.startsWith(name, at + 1)) {
          st.autoColor = false;
          if (options.color) st.sb += basic[name];
          return 1 + name.length;
        }
      }
      // %C<unknown> is a literal and the previous %C(auto) stays
      return 0;
    }
    case "w": {
      if (fmt[at + 1] !== "(") return 0;
      const end = fmt.indexOf(")", at + 2);
      if (end < 0) return 0;
      const args = fmt.slice(at + 2, end);
      let width = 0;
      let indent1 = 0;
      let indent2 = 0;
      if (args !== "") {
        const m = /^[ \t\n\r]*\+?(\d*)(?:,[ \t\n\r]*\+?(\d*)(?:,[ \t\n\r]*\+?(\d*))?)?$/.exec(args);
        if (!m) return 0;
        width = Number(m[1] || 0);
        indent1 = Number(m[2] || 0);
        indent2 = Number(m[3] || 0);
      }
      if (width > FORMATTING_LIMIT || indent1 > FORMATTING_LIMIT || indent2 > FORMATTING_LIMIT)
        return 0;
      rewrapTail(st, width, indent1, indent2);
      return end - at + 1;
    }
    case "<":
    case ">":
      return parsePadding(fmt, at, st);
  }
  switch (c) {
    case "H":
      st.sb += id;
      return 1;
    case "h":
      st.sb += await abbrev(id);
      return 1;
    case "T":
      st.sb += commit.tree;
      return 1;
    case "t":
      st.sb += await abbrev(commit.tree);
      return 1;
    case "P":
      st.sb += commit.parents.join(" ");
      return 1;
    case "p": {
      const parts: string[] = [];
      for (const p of commit.parents) parts.push(await abbrev(p));
      st.sb += parts.join(" ");
      return 1;
    }
    case "m":
      st.sb += options.mark ?? ">";
      return 1;
    case "d":
      st.sb += formatRefDecorations(options.decorations, id, {});
      return 1;
    case "D":
      st.sb += formatRefDecorations(options.decorations, id, { prefix: "", suffix: "" });
      return 1;
    case "g": {
      const reflog = options.reflog;
      switch (fmt[at + 1]) {
        case "d":
          st.sb += reflog?.selector ?? "";
          return 2;
        case "D":
          st.sb += reflog?.selector ?? "";
          return 2;
        case "s":
          st.sb += reflog?.message ?? "";
          return 2;
        case "n":
        case "N":
        case "e":
        case "E": {
          if (!reflog?.ident) return 2;
          const part = formatPersonPart(reflog.ident, fmt[at + 1], options);
          if (part !== undefined) st.sb += part;
          return 2;
        }
      }
      return 0;
    }
    case "N":
      if (options.notes === undefined) return 0;
      st.sb += options.notes;
      return 1;
    case "G": {
      const signed = !!(commit as { gpgSignature?: string }).gpgSignature;
      switch (fmt[at + 1]) {
        case "?":
          st.sb += signed ? "E" : "N";
          return 2;
        case "G":
        case "S":
        case "K":
        case "F":
        case "P":
          return 2;
        case "T":
          st.sb += "undefined";
          return 2;
      }
      return 0;
    }
  }
  if (fmt.startsWith("(decorate", at)) {
    let i = at + 9;
    const opts: Record<string, string> = {};
    if (fmt[i] === ":") {
      i++;
      for (;;) {
        const m = /^(prefix|suffix|separator|pointer|tag)=/.exec(fmt.slice(i));
        if (!m) break;
        // match_placeholder_arg_value: the value runs to the next "," or ")"
        const valueStart = i + m[0].length;
        let valueEnd = valueStart;
        while (valueEnd < fmt.length && fmt[valueEnd] !== "," && fmt[valueEnd] !== ")") valueEnd++;
        if (valueEnd >= fmt.length) break;
        opts[m[1] as string] = expandStringArg(fmt.slice(valueStart, valueEnd));
        i = fmt[valueEnd] === "," ? valueEnd + 1 : valueEnd;
      }
    }
    if (fmt[i] !== ")") return 0;
    st.sb += formatRefDecorations(options.decorations, id, opts);
    return i - at + 1;
  }
  if (fmt.startsWith("(describe", at)) {
    let i = at + 9;
    const describeOptions: { tags?: boolean; abbrev?: number; match: string[]; exclude: string[] } =
      { match: [], exclude: [] };
    if (fmt[i] === ":") {
      i++;
      // parse_describe_args: the options it knows, up to the first it does not
      for (;;) {
        const tagsArg = matchBoolArg(fmt, i, "tags");
        if (tagsArg) {
          describeOptions.tags = tagsArg.value;
          i = tagsArg.end;
          continue;
        }
        const abbrevArg = matchArgValue(fmt, i, "abbrev");
        if (abbrevArg) {
          if (abbrevArg.value === undefined || !/^[+-]?\d+$/.test(abbrevArg.value)) return 0;
          let n = Number.parseInt(abbrevArg.value, 10);
          // parse_opt_abbrev_cb: at least 4 (MINIMUM_ABBREV), at most the hash's length
          if (n && n < 4) n = 4;
          else if (n > 40) n = 40;
          describeOptions.abbrev = n;
          i = abbrevArg.end;
          continue;
        }
        const listArg = matchArgValue(fmt, i, "exclude") ?? matchArgValue(fmt, i, "match");
        if (listArg) {
          if (!listArg.value) return 0;
          (fmt.startsWith("exclude", i) ? describeOptions.exclude : describeOptions.match).push(
            listArg.value,
          );
          i = listArg.end;
          continue;
        }
        break;
      }
    }
    if (fmt[i] !== ")" || !options.describe) return 0;
    const out = await options.describe(id, {
      ...(describeOptions.tags !== undefined ? { tags: describeOptions.tags } : {}),
      ...(describeOptions.abbrev !== undefined ? { abbrev: describeOptions.abbrev } : {}),
      ...(describeOptions.match.length ? { match: describeOptions.match } : {}),
      ...(describeOptions.exclude.length ? { exclude: describeOptions.exclude } : {}),
    });
    st.sb += out.replace(/[ \t\n\r]+$/, "");
    return i - at + 1;
  }
  if (fmt.startsWith("(count)", at) || fmt.startsWith("(total)", at)) {
    const name = fmt.slice(at, at + 7);
    if (!options.count)
      throw new PrettyFormatError(`fatal: %${name} is not supported by this command`);
    const { nr, total } = options.count;
    st.sb +=
      name === "(count)" ? String(nr).padStart(String(Math.abs(total)).length, "0") : String(total);
    return 7;
  }
  if (c === "S") {
    if (options.source === undefined || options.source === "") return 0;
    st.sb += options.source;
    return 1;
  }
  if (fmt.startsWith("(trailers", at)) {
    let i = at + 9;
    const trailerOptions: TrailerFormatOptions & { keys?: string[] } = {};
    if (fmt[i] === ":") {
      i++;
      // format_set_trailers_options
      for (;;) {
        if (fmt[i] === ")") break;
        const key = matchArgValue(fmt, i, "key");
        if (key) {
          if (key.value === undefined) return 0;
          trailerOptions.keys = [...(trailerOptions.keys ?? []), key.value];
          trailerOptions.onlyTrailers = true;
          i = key.end;
          continue;
        }
        const separator = matchArgValue(fmt, i, "separator");
        if (separator) {
          trailerOptions.separator = expandStringArg(separator.value ?? "");
          i = separator.end;
          continue;
        }
        const kvSeparator = matchArgValue(fmt, i, "key_value_separator");
        if (kvSeparator) {
          trailerOptions.keyValueSeparator = expandStringArg(kvSeparator.value ?? "");
          i = kvSeparator.end;
          continue;
        }
        const flag = (
          [
            ["only", "onlyTrailers"],
            ["unfold", "unfold"],
            ["keyonly", "keyOnly"],
            ["valueonly", "valueOnly"],
          ] as const
        ).find(([name]) => matchBoolArg(fmt, i, name));
        if (!flag) return 0;
        const arg = matchBoolArg(fmt, i, flag[0]) as { value: boolean; end: number };
        trailerOptions[flag[1]] = arg.value;
        i = arg.end;
      }
    }
    if (fmt[i] !== ")") return 0;
    const start = skipBlankLines(commit.message, 0);
    st.sb = appendTrailers(st.sb, commit.message.slice(start), trailerOptions, options.trailers);
    return i - at + 1;
  }
  switch (c) {
    case "a":
    case "c": {
      const ident = c === "a" ? commit.author : commit.committer;
      const part = formatPersonPart(ident, fmt[at + 1], options);
      if (part === undefined) return 0;
      st.sb += part;
      return 2;
    }
    case "e":
      st.sb += commit.encoding ?? "";
      return 1;
    case "B":
      st.sb += commit.message;
      return 1;
    case "s": {
      const start = skipBlankLines(commit.message, 0);
      st.sb += formatSubject(commit.message, start, " ").text;
      return 1;
    }
    case "f": {
      const start = skipBlankLines(commit.message, 0);
      const nl = commit.message.indexOf("\n", start);
      const line = commit.message.slice(start, nl < 0 ? commit.message.length : nl);
      st.sb += sanitizedSubject(line);
      return 1;
    }
    case "b": {
      const start = skipBlankLines(commit.message, 0);
      const { end } = formatSubject(commit.message, start, " ");
      st.sb += commit.message.slice(skipBlankLines(commit.message, end));
      return 1;
    }
  }
  return 0;
}

/** pretty.c's format_and_pad_commit: the next placeholder, padded or truncated. */
async function formatAndPad(
  fmt: string,
  at: number,
  st: FormatState,
  cx: FormatContext,
): Promise<number> {
  let padding = st.padding;
  if (padding < 0) {
    const nl = st.sb.lastIndexOf("\n");
    const occupied = displayWidth(nl < 0 ? st.sb : st.sb.slice(nl));
    padding = -padding - occupied;
  }
  const outer = st.sb;
  st.sb = "";
  const flushType = st.flush;
  const truncate = st.truncate;
  st.flush = "none";
  let total = 0;
  let p = at;
  for (;;) {
    const modifier = fmt[p] === "C";
    const consumed = await formatOne(fmt, p, st, cx);
    total += consumed;
    if (!modifier) break;
    p += consumed;
    if (fmt[p] !== "%") break;
    p++;
    total++;
  }
  let local = st.sb;
  let sb = outer;
  const len = displayWidth(local);
  let flush = flushType;
  if (flush === "left-steal") {
    // take the spaces (and keep the colors) at the end of what is already written
    let ch = sb.length - 1;
    while (len > padding && ch > 0) {
      if (sb[ch] === " ") {
        ch--;
        padding++;
        continue;
      }
      if (sb[ch] !== "m") break;
      let q = ch - 1;
      while (q > 0 && ch - q < 10 && sb[q] !== "\x1b") q--;
      if (sb[q] !== "\x1b" || ch + 1 - q !== escapeLength(sb, q)) break;
      local = sb.slice(q, ch + 1) + local;
      ch = q - 1;
    }
    sb = sb.slice(0, ch + 1);
    flush = "left";
  }
  if (len > padding) {
    switch (truncate) {
      case "left":
        local = utf8Replace(local, 0, len - (padding - 2), "..");
        break;
      case "middle":
        local = utf8Replace(local, Math.trunc(padding / 2) - 1, len - (padding - 2), "..");
        break;
      case "right":
        local = utf8Replace(local, padding - 2, len - (padding - 2), "..");
        break;
    }
    sb += local;
  } else {
    let offset = 0;
    if (flush === "left") offset = padding - len;
    else if (flush === "both") offset = Math.trunc((padding - len) / 2);
    sb += " ".repeat(offset) + local + " ".repeat(padding - len - offset);
  }
  st.sb = sb;
  return total;
}

/** pretty.c's format_person_part; undefined for a part it does not know. */
function formatPersonPart(
  ident: PersonIdent,
  part: string | undefined,
  options: PrettyFormatOptions,
): string | undefined {
  let { name, email } = ident;
  if ((part === "N" || part === "E" || part === "L") && options.mailmap) {
    ({ name, email } = options.mailmap(name, email));
  }
  switch (part) {
    case "n":
    case "N":
      return name;
    case "e":
    case "E":
      return email;
    case "l":
    case "L": {
      const at = email.indexOf("@");
      return at < 0 ? email : email.slice(0, at);
    }
    case "t":
      return String(ident.timestamp);
    case "d":
      return options.formatDate ? options.formatDate(ident) : formatGitDate(ident);
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
    case "h":
      return humanDate(
        ident,
        options.now ?? Math.floor(Date.now() / 1000),
        options.localTzOffset ?? ((time) => -new Date(time * 1000).getTimezoneOffset()),
      );
    default:
      return undefined;
  }
}

/**
 * `format` expanded for commit `id` as git's format_commit_message expands a user format:
 * each `%<placeholder>`, with the `%+` (a newline before a non-empty expansion), `%-` (the
 * newlines before an empty one removed) and `% ` (a space before a non-empty one) magic,
 * the padding a `%<(…)` gives the next placeholder, and the wrapping of `%w(…)`.
 */
export async function formatCommitPretty(
  format: string,
  commit: PrettyCommit,
  id: ObjectId,
  options: PrettyFormatOptions = {},
): Promise<string> {
  const st: FormatState = {
    sb: "",
    wrapStart: 0,
    width: 0,
    indent1: 0,
    indent2: 0,
    flush: "none",
    padding: 0,
    truncate: "none",
    autoColor: false,
  };
  const cx: FormatContext = { commit, id, options };
  let i = 0;
  while (i < format.length) {
    const pct = format.indexOf("%", i);
    if (pct < 0) {
      st.sb += format.slice(i);
      break;
    }
    st.sb += format.slice(i, pct);
    i = pct + 1;
    if (format[i] === "%") {
      st.sb += "%";
      i++;
      continue;
    }
    const consumed = await formatItem(format, i, st, cx);
    if (consumed === 0) st.sb += "%";
    else i += consumed;
  }
  rewrapTail(st, 0, 0, 0);
  return st.sb;
}

/** pretty.c's format_commit_item: the magic, then the placeholder (padded when asked). */
async function formatItem(
  fmt: string,
  at: number,
  st: FormatState,
  cx: FormatContext,
): Promise<number> {
  const first = fmt[at];
  const magic = first === "-" || first === "+" || first === " " ? first : "";
  let p = at;
  if (magic) {
    p++;
    // `%+w()` cannot be handled: refused, kept as written
    if (fmt[p] === "w") return 0;
  }
  const before = st.sb.length;
  const consumed =
    st.flush === "none" ? await formatOne(fmt, p, st, cx) : await formatAndPad(fmt, p, st, cx);
  if (!magic) return consumed;
  if (st.sb.length === before && magic === "-") st.sb = st.sb.replace(/\n+$/, "");
  else if (st.sb.length !== before) {
    if (magic === "+") st.sb = `${st.sb.slice(0, before)}\n${st.sb.slice(before)}`;
    else if (magic === " ") st.sb = `${st.sb.slice(0, before)} ${st.sb.slice(before)}`;
  }
  return consumed + 1;
}
