/**
 * The author and committer of the commits (and the tagger of the tags) our commands write,
 * resolved as git's `ident.c` resolves them, so that the same commands run with the same
 * environment give the same object ids as native git.
 *
 * @example
 * ```typescript
 * const env = { readFile: async () => undefined, committer: { date: "1700000000 +0100" } };
 * const config = { value: (key: string) => ({ "user.name": "Ada", "user.email": "ada@example.com" })[key] };
 * resolveCommitterIdent(env, config);
 * // { name: "Ada", email: "ada@example.com", timestamp: 1700000000, tzOffset: "+0100" }
 * ```
 *
 * The order, per field, is git's `fmt_ident`:
 *
 * - the name and email: `GIT_AUTHOR_*` / `GIT_COMMITTER_*` (the host environment's `author` /
 *   `committer`), then `author.name` / `committer.name` (and `.email`), then `user.name` /
 *   `user.email`, then `$EMAIL` for the email (the host environment's `defaultEmail`);
 * - with `user.useConfigOnly`, a commit or tag refuses an identity the configuration does not
 *   give, with git's message ({@link IdentityUnknownError});
 * - the date: `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` in any form {@link parseGitDate} reads,
 *   else the clock with the local timezone offset.
 *
 * Where git would ask the system (the user's full name from passwd, `user@host`), a portable
 * host knows nothing: the command's other identity is used when it was given one explicitly
 * (a commit with only `setAuthor` is committed by that author, as before), else
 * {@link DEFAULT_IDENT}, the identity the ref stores write in reflogs. Never "Unknown".
 */

import type { PersonIdent } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { GitHostEnvironment, WorkingCopy } from "@statewalker/vcs-working-tree";

import { GitApiError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";

/** The identity of a commit nobody is configured for (the ref stores' reflog identity). */
export const DEFAULT_IDENT = { name: "webrun-vcs", email: "vcs@localhost" } as const;

/** What the resolver reads of the configuration: a value by its key, undefined when unset. */
export interface IdentConfig {
  value(key: string): string | undefined;
}

/** Whose identity: git's `WANT_AUTHOR_IDENT` / `WANT_COMMITTER_IDENT`. */
export type IdentRole = "author" | "committer";

/** How an identity is resolved. */
export interface ResolveIdentOptions {
  /** The clock, in seconds, when the variables give no date (default: now) */
  now?: number;
  /**
   * The identity used when neither the environment nor the configuration names anyone (a
   * command's other, explicitly given identity: its name, email and, unless the variables
   * give a date, its date); {@link DEFAULT_IDENT} now otherwise
   */
  fallback?: Pick<PersonIdent, "name" | "email"> & Partial<PersonIdent>;
  /**
   * git's `IDENT_STRICT` (default true, as for commits and tags): `user.useConfigOnly`
   * refuses an identity the configuration does not give. Reflog lines are not strict.
   */
  strict?: boolean;
}

/**
 * git's refusal of an identity it may not guess (`user.useConfigOnly`): the hint git prints
 * and its `fatal:` line, as the message.
 */
export class IdentityUnknownError extends GitApiError {
  readonly role: IdentRole;
  constructor(role: IdentRole, what: "name" | "email") {
    super(
      [
        `${role === "author" ? "Author" : "Committer"} identity unknown`,
        "",
        "*** Please tell me who you are.",
        "",
        "Run",
        "",
        '  git config --global user.email "you@example.com"',
        '  git config --global user.name "Your Name"',
        "",
        "to set your account's default identity.",
        "Omit --global to set the identity only in this repository.",
        "",
        `fatal: no ${what} was given and auto-detection is disabled`,
      ].join("\n"),
    );
    this.name = "IdentityUnknownError";
    this.role = role;
  }
}

/** git's refusal of a `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` it cannot read. */
export class InvalidDateError extends GitApiError {
  readonly date: string;
  constructor(date: string) {
    super(`fatal: invalid date format: ${date}`);
    this.name = "InvalidDateError";
    this.date = date;
  }
}

/** A timezone offset in minutes as git writes it (`+HHMM`). */
function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
}

/**
 * The local timezone offset at `timestamp` (seconds; default now) as git writes it
 * (`+HHMM`): `Date#getTimezoneOffset`, which every JavaScript host has.
 */
export function localTimezoneOffset(timestamp?: number): string {
  const date = timestamp === undefined ? new Date() : new Date(timestamp * 1000);
  return formatOffset(-date.getTimezoneOffset());
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
/** git's `timezone_names`: the offset in hours, and whether it is a summer time (+1 hour). */
const ZONES: Record<string, [number, boolean]> = {
  IDLW: [-12, false],
  NT: [-11, false],
  CAT: [-10, false],
  HST: [-10, false],
  HDT: [-10, true],
  YST: [-9, false],
  YDT: [-9, true],
  PST: [-8, false],
  PDT: [-8, true],
  MST: [-7, false],
  MDT: [-7, true],
  CST: [-6, false],
  CDT: [-6, true],
  EST: [-5, false],
  EDT: [-5, true],
  AST: [-4, false],
  ADT: [-4, true],
  WAT: [-1, false],
  GMT: [0, false],
  UTC: [0, false],
  Z: [0, false],
  WET: [0, false],
  BST: [0, true],
  CET: [1, false],
  MET: [1, false],
  MEWT: [1, false],
  MEST: [1, true],
  CEST: [1, true],
  MESZ: [1, true],
  FWT: [1, false],
  FST: [1, true],
  EET: [2, false],
  EEST: [2, true],
  WAST: [7, false],
  WADT: [7, true],
  CCT: [8, false],
  JST: [9, false],
  EAST: [10, false],
  EADT: [10, true],
  GST: [10, false],
  NZT: [12, false],
  NZST: [12, false],
  NZDT: [12, true],
  IDLE: [12, false],
};

/**
 * A date as git's `parse_date` reads `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`, undefined
 * when unreadable (git dies: `invalid date format`).
 *
 * @example
 * ```typescript
 * parseGitDate("1700000000 +0100");                // { timestamp: 1700000000, tzOffset: "+0100" }
 * parseGitDate("@1700000000");                     // the local offset at that time
 * parseGitDate("Tue, 14 Nov 2023 23:13:20 +0100"); // RFC 2822: its offset kept
 * parseGitDate("2023-11-14T23:13:20+01:00");       // ISO 8601: its offset kept
 * parseGitDate("2023-11-14 23:13:20");             // local time, the local offset
 * ```
 *
 * The forms: git's raw `<seconds> <+-HHMM>` (also `@<seconds> ...`); seconds alone (nine
 * digits or more, with `@` or without) in the local offset at that time, as git's
 * `match_digit` and `mktime` give it; and dates with a time: RFC 2822, ISO 8601 (`T` or a
 * space, fractions ignored), git's own `Tue Nov 14 23:13:20 2023 +0100`, `YYYY.MM.DD`,
 * `MM/DD/YYYY`, `DD.MM.YYYY`, with an offset (`+HHMM`, `+HH:MM`, `+HH`), a zone name (`UTC`,
 * `Z`, `CET`, `PST`, ...) or neither (the local time and its offset).
 */
export function parseGitDate(text: string): { timestamp: number; tzOffset: string } | undefined {
  const trimmed = text.trim();
  const raw = /^@?(\d+)\s+([+-])(\d{2})(\d{2})$/.exec(trimmed);
  if (raw) {
    return { timestamp: Number(raw[1]), tzOffset: `${raw[2]}${raw[3]}${raw[4]}` };
  }

  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  let time: [number, number, number] | undefined;
  let offset: number | undefined;
  let epoch: number | undefined;
  let pm: boolean | undefined;
  const numbers: number[] = [];

  let rest = trimmed;
  /** The token `pattern` matches at the start of what is left, consumed. */
  const take = (pattern: RegExp): RegExpExecArray | null => {
    const m = pattern.exec(rest);
    if (m) rest = rest.slice(m[0].length);
    return m;
  };
  while (rest.length > 0) {
    const word = take(/^[A-Za-z]+/);
    if (word) {
      const lower = word[0].toLowerCase();
      const zone = ZONES[word[0].toUpperCase()];
      if (lower.length >= 3 && MONTHS.some((name) => lower.startsWith(name))) {
        month = MONTHS.findIndex((name) => lower.startsWith(name)) + 1;
      } else if (lower.length >= 3 && WEEKDAYS.some((name) => lower.startsWith(name))) {
        // the weekday says nothing git uses
      } else if (zone) {
        offset = (zone[0] + (zone[1] ? 1 : 0)) * 60;
      } else if (lower === "am" || lower === "pm") {
        pm = lower === "pm";
      } else if (lower !== "t") {
        return undefined;
      }
      continue;
    }
    const clock = take(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?/);
    if (clock) {
      time = [Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0)];
      continue;
    }
    const ymd = take(/^(\d{4})([-./])(\d{1,2})\2(\d{1,2})(?!\d)/);
    if (ymd) {
      [year, month, day] = [Number(ymd[1]), Number(ymd[3]), Number(ymd[4])];
      continue;
    }
    const dmy = take(/^(\d{1,2})([./-])(\d{1,2})\2(\d{4})(?!\d)/);
    if (dmy) {
      // git: `MM/DD/YYYY` with slashes, `DD.MM.YYYY` (and `DD-MM-YYYY`) otherwise
      const [a, b] = [Number(dmy[1]), Number(dmy[3])];
      [month, day] = dmy[2] === "/" ? [a, b] : [b, a];
      year = Number(dmy[4]);
      continue;
    }
    // an offset follows a time or the seconds: `+HHMM`, `+HH:MM`, `+HH`
    const tz =
      time !== undefined || epoch !== undefined ? take(/^([+-])(\d{2})(?::?(\d{2}))?(?!\d)/) : null;
    if (tz) {
      const minutes = Number(tz[2]) * 60 + Number(tz[3] ?? 0);
      offset = tz[1] === "-" ? -minutes : minutes;
      continue;
    }
    const digits = take(/^\d+/);
    if (digits) {
      const value = Number(digits[0]);
      // git's match_digit: nine digits or more are seconds since the epoch
      if (value >= 100000000 && year === undefined && time === undefined) epoch = value;
      else numbers.push(value);
      continue;
    }
    if (!take(/^(?:[\s,@]+|[-./])/)) return undefined;
  }

  if (epoch !== undefined) {
    if (time !== undefined || year !== undefined || numbers.length > 0) return undefined;
    return {
      timestamp: epoch,
      tzOffset: offset !== undefined ? formatOffset(offset) : localTimezoneOffset(epoch),
    };
  }
  // the day and year of `14 Nov 2023` and `Nov 14 2023`
  for (const value of numbers) {
    if (value > 31 && year === undefined) year = value;
    else if (value >= 1 && value <= 31 && day === undefined) day = value;
    else if (year === undefined) year = value;
    else return undefined;
  }
  if (year === undefined || month === undefined || day === undefined || time === undefined) {
    return undefined;
  }
  let [hour, minute, second] = time;
  if (pm !== undefined && hour <= 12) hour = (hour % 12) + (pm ? 12 : 0);
  if (year < 100) year += year < 70 ? 2000 : 1900;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 24 || minute > 59 || second > 60) {
    return undefined;
  }
  if (offset !== undefined) {
    const utc = Date.UTC(year, month - 1, day, hour, minute, second) / 1000;
    return { timestamp: utc - offset * 60, tzOffset: formatOffset(offset) };
  }
  // no offset: the local time, in the local offset of that date (git's mktime)
  const local = new Date(year, month - 1, day, hour, minute, second);
  return {
    timestamp: Math.floor(local.getTime() / 1000),
    tzOffset: formatOffset(-local.getTimezoneOffset()),
  };
}

/** git's `crud`: what `strbuf_addstr_without_crud` trims from the ends of a name or email. */
const isCrud = (c: string) => c <= " " || ",:;<>\"\\'".includes(c);

/**
 * A name or email as git writes it (`strbuf_addstr_without_crud`): crud trimmed from both
 * ends, `<`, `>` and newlines dropped inside.
 */
export function withoutCrud(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isCrud(text[start])) start++;
  while (end > start && isCrud(text[end - 1])) end--;
  return text.slice(start, end).replace(/[<>\n]/g, "");
}

/** The configuration's value, set and not empty. */
function configured(config: IdentConfig | undefined, key: string): string | undefined {
  const value = config?.value(key);
  return value === undefined || value === "" ? undefined : value;
}

/**
 * git's `fmt_ident` for `role`: the identity named by the environment and the
 * configuration, undefined when neither names anyone (no name, email or date): a caller
 * then decides (the reflog's store identity, a command's fallback).
 */
export function findIdent(
  role: IdentRole,
  environment: GitHostEnvironment | undefined,
  config: IdentConfig | undefined,
  options: Omit<ResolveIdentOptions, "fallback"> = {},
): PersonIdent | undefined {
  const vars = environment?.[role];
  const roleName = configured(config, `${role}.name`);
  const roleEmail = configured(config, `${role}.email`);
  const userName = configured(config, "user.name");
  const userEmail = configured(config, "user.email");
  const name = vars?.name ?? roleName ?? userName;
  const email = vars?.email ?? roleEmail ?? userEmail ?? environment?.defaultEmail;
  const dateText = vars?.date !== undefined && vars.date !== "" ? vars.date : undefined;
  if (options.strict !== false && parseGitBool(config?.value("user.useConfigOnly")) === true) {
    // git's ident_config_given: any of the six variables counts as given
    const mailGiven =
      [roleEmail, userEmail, configured(config, `${other(role)}.email`)].some(Boolean) ||
      vars?.email !== undefined;
    const nameGiven =
      [roleName, userName, configured(config, `${other(role)}.name`)].some(Boolean) ||
      vars?.name !== undefined;
    if (!mailGiven) throw new IdentityUnknownError(role, "email");
    if (!nameGiven) {
      throw new IdentityUnknownError(role, "name");
    }
  }
  if (name === undefined && email === undefined && dateText === undefined) return undefined;
  const date = dateText !== undefined ? parseGitDate(dateText) : undefined;
  if (dateText !== undefined && !date) throw new InvalidDateError(dateText);
  const timestamp = date?.timestamp ?? options.now ?? Math.floor(Date.now() / 1000);
  return {
    name: withoutCrud(name ?? DEFAULT_IDENT.name),
    email: withoutCrud(email ?? DEFAULT_IDENT.email),
    timestamp,
    tzOffset: date?.tzOffset ?? localTimezoneOffset(timestamp),
  };
}

const other = (role: IdentRole): IdentRole => (role === "author" ? "committer" : "author");

function resolveIdent(
  role: IdentRole,
  environment: GitHostEnvironment | undefined,
  config: IdentConfig | undefined,
  options: ResolveIdentOptions,
): PersonIdent {
  const found = findIdent(role, environment, config, options);
  const vars = environment?.[role];
  const named =
    vars?.name !== undefined ||
    vars?.email !== undefined ||
    configured(config, `${role}.name`) !== undefined ||
    configured(config, `${role}.email`) !== undefined ||
    configured(config, "user.name") !== undefined ||
    configured(config, "user.email") !== undefined ||
    environment?.defaultEmail !== undefined;
  if (found && named) return found;
  // nobody named: the command's other identity (its date too, unless the variables give
  // one), else the store's
  const who: Partial<PersonIdent> = options.fallback ?? DEFAULT_IDENT;
  if (found) return { ...found, name: who.name ?? found.name, email: who.email ?? found.email };
  const timestamp = who.timestamp ?? options.now ?? Math.floor(Date.now() / 1000);
  return {
    name: who.name ?? DEFAULT_IDENT.name,
    email: who.email ?? DEFAULT_IDENT.email,
    timestamp,
    tzOffset: who.tzOffset ?? localTimezoneOffset(timestamp),
  };
}

/**
 * The committer of a commit or the tagger of a tag made now, as git's
 * `git_committer_info(IDENT_STRICT)` resolves it (see the module comment for the order).
 */
export function resolveCommitterIdent(
  environment: GitHostEnvironment | undefined,
  config: IdentConfig | undefined,
  options: ResolveIdentOptions = {},
): PersonIdent {
  return resolveIdent("committer", environment, config, options);
}

/**
 * The author of a commit made now, as git's `git_author_info(IDENT_STRICT)` resolves it
 * (see the module comment for the order).
 */
export function resolveAuthorIdent(
  environment: GitHostEnvironment | undefined,
  config: IdentConfig | undefined,
  options: ResolveIdentOptions = {},
): PersonIdent {
  return resolveIdent("author", environment, config, options);
}

/**
 * The date of an identity made now for `role`: `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`, else
 * `now` (default the clock) in the local offset. git's date of `commit --author=<who>`.
 */
export function resolveIdentDate(
  role: IdentRole,
  environment: GitHostEnvironment | undefined,
  now?: number,
): Pick<PersonIdent, "timestamp" | "tzOffset"> {
  const text = environment?.[role]?.date;
  if (text !== undefined && text !== "") {
    const date = parseGitDate(text);
    if (!date) throw new InvalidDateError(text);
    return date;
  }
  const timestamp = now ?? Math.floor(Date.now() / 1000);
  return { timestamp, tzOffset: localTimezoneOffset(timestamp) };
}

/** The host environment a working copy's configuration carries, if any. */
export function hostEnvironmentOf(workingCopy: WorkingCopy): GitHostEnvironment | undefined {
  return (workingCopy.config as { environment?: GitHostEnvironment } | undefined)?.environment;
}

/** The configuration of a working copy as the resolver reads it. */
export function identConfigOf(workingCopy: WorkingCopy): IdentConfig | undefined {
  return workingCopy.config ? RemoteConfigStore.from(workingCopy) : undefined;
}

/** {@link resolveCommitterIdent} on a working copy's environment and configuration. */
export function committerIdentOf(
  workingCopy: WorkingCopy,
  options: ResolveIdentOptions = {},
): PersonIdent {
  return resolveCommitterIdent(hostEnvironmentOf(workingCopy), identConfigOf(workingCopy), options);
}

/** {@link resolveAuthorIdent} on a working copy's environment and configuration. */
export function authorIdentOf(
  workingCopy: WorkingCopy,
  options: ResolveIdentOptions = {},
): PersonIdent {
  return resolveAuthorIdent(hostEnvironmentOf(workingCopy), identConfigOf(workingCopy), options);
}
