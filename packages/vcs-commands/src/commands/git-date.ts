/**
 * git's `parse_date` (date.c), ported field for field, so that `GIT_AUTHOR_DATE` and
 * `GIT_COMMITTER_DATE` give the same timestamps and offsets as native git.
 *
 * @example
 * ```typescript
 * parseGitDate("1700000000 +0100");                // { timestamp: 1700000000, tzOffset: "+0100" }
 * parseGitDate("@1700000000 +0160");               // { timestamp: 1700000000, tzOffset: "+0200" }
 * parseGitDate("Tue, 14 Nov 2023 23:13:20 +0100"); // { timestamp: 1700000000, tzOffset: "+0100" }
 * parseGitDate("2023-11-14 23:13:20");             // the local time, in its local offset
 * parseGitDate("17000000 +0100");                  // undefined: git refuses it
 * ```
 *
 * The parser walks the text as git does. Words are month names, weekdays, git's zone names,
 * `AM` / `PM` and ISO's `T`; other words are skipped. Numbers are seconds since the epoch
 * (nine digits or more, before any other field), `H:M[:S]` times, `Y-M-D`, `M/D/Y` and
 * `D.M.Y` dates (with git's guesses when a field is out of range), `YYYYMMDD` and
 * `HHMMSS`, four-digit years, offsets written without a sign (`0100`), days, months and
 * two-digit years. `+HHMM`, `+HH:MM` and `+HH` are offsets; one git finds invalid is
 * ignored. The date must fall in 1970..2099, as git's `tm_to_time_t` requires.
 *
 * Without an offset the time is local. Its offset is the one glibc's `mktime` finds with
 * `tm_isdst = -1`: a time in a spring-forward gap keeps the offset before the change, and
 * an ambiguous time takes the offset the search reaches first from UTC.
 *
 * `@<seconds> <+-HHMM>` is git's raw form: the seconds as they are (even 0), the offset's
 * minutes carried into hours (`+0160` is `+0200`).
 */

/** git's `struct tm` as `parse_date_basic` fills it: -1 for a field not seen yet. */
interface Tm {
  year: number;
  mon: number;
  mday: number;
  hour: number;
  min: number;
  sec: number;
}

interface ParseState {
  tm: Tm;
  /** The offset in minutes; -1 while none was seen (git's sentinel, even for `-0001`) */
  offset: number;
  /** Whether the fields came from seconds since the epoch (`gmtime_r`) */
  gmt: boolean;
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAY_NAMES = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
];
/** git's `timezone_names`: name, offset in hours, summer time (one hour more). */
const TIMEZONE_NAMES: [string, number, number][] = [
  ["IDLW", -12, 0],
  ["NT", -11, 0],
  ["CAT", -10, 0],
  ["HST", -10, 0],
  ["HDT", -10, 1],
  ["YST", -9, 0],
  ["YDT", -9, 1],
  ["PST", -8, 0],
  ["PDT", -8, 1],
  ["MST", -7, 0],
  ["MDT", -7, 1],
  ["CST", -6, 0],
  ["CDT", -6, 1],
  ["EST", -5, 0],
  ["EDT", -5, 1],
  ["AST", -3, 0],
  ["ADT", -3, 1],
  ["WAT", -1, 0],
  ["GMT", 0, 0],
  ["UTC", 0, 0],
  ["Z", 0, 0],
  ["WET", 0, 0],
  ["BST", 0, 1],
  ["CET", 1, 0],
  ["MET", 1, 0],
  ["MEWT", 1, 0],
  ["MEST", 1, 1],
  ["CEST", 1, 1],
  ["MESZ", 1, 1],
  ["FWT", 1, 0],
  ["FST", 1, 1],
  ["EET", 2, 0],
  ["EEST", 2, 1],
  ["WAST", 7, 0],
  ["WADT", 7, 1],
  ["CCT", 8, 0],
  ["JST", 9, 0],
  ["EAST", 10, 0],
  ["EADT", 10, 1],
  ["GST", 10, 0],
  ["NZT", 12, 0],
  ["NZST", 12, 0],
  ["NZDT", 12, 1],
  ["IDLE", 12, 0],
];

/** 2099-12-31T23:59:59Z: the last second `tm_to_time_t` can give (git 2.5x's bound). */
const TIMESTAMP_MAX = ((2100 - 1970) * 365 + 32) * 24 * 60 * 60 - 1;
const MDAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isAlpha = (c: string | undefined) =>
  c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
const isAlnum = (c: string | undefined) => isDigit(c) || isAlpha(c);
const isSpace = (c: string | undefined) => c !== undefined && " \t\n\v\f\r".includes(c);
const upper = (c: string) => (c >= "a" && c <= "z" ? c.toUpperCase() : c);
/** C's conversion of a wide integer to `int`. */
const toInt = (n: number) => (Number.isFinite(n) ? Number(BigInt.asIntN(32, BigInt(n))) : -1);

/** C's `strtol` / `strtoul` at `start`: whitespace, a sign, digits; `end` at start if none. */
function strtol(s: string, start: number): { value: number; end: number } {
  let i = start;
  while (isSpace(s[i])) i++;
  let sign = 1;
  if (s[i] === "+" || s[i] === "-") {
    if (s[i] === "-") sign = -1;
    i++;
  }
  const from = i;
  while (isDigit(s[i])) i++;
  if (i === from) return { value: 0, end: start };
  return { value: sign * Number(s.slice(from, i)), end: i };
}

/** The digits at `start` (which is one): their value and where they end. */
function digitsAt(s: string, start: number): { value: number; text: string; end: number } {
  let i = start;
  while (isDigit(s[i])) i++;
  const text = s.slice(start, i);
  return { value: Number(text), text, end: i };
}

/** git's `tm_to_time_t`: the fields as UTC seconds, -1 outside 1970..2099. */
function tmToTime(tm: Tm): number {
  const year = tm.year - 70;
  const month = tm.mon;
  let day = tm.mday;
  if (year < 0 || year > 129) return -1;
  if (month < 0 || month > 11) return -1;
  if (month < 2 || (year + 2) % 4) day--;
  if (tm.hour < 0 || tm.min < 0 || tm.sec < 0) return -1;
  return (
    (year * 365 + Math.trunc((year + 1) / 4) + MDAYS[month] + day) * 24 * 60 * 60 +
    tm.hour * 60 * 60 +
    tm.min * 60 +
    tm.sec
  );
}

/** `gmtime_r`: the UTC fields of `seconds` (a year past git's range when too large). */
function gmtime(seconds: number): Tm {
  if (!(Math.abs(seconds) < 8.64e12)) {
    return { year: 1_000_000, mon: 0, mday: 1, hour: 0, min: 0, sec: 0 };
  }
  const d = new Date(seconds * 1000);
  return {
    year: d.getUTCFullYear() - 1900,
    mon: d.getUTCMonth(),
    mday: d.getUTCDate(),
    hour: d.getUTCHours(),
    min: d.getUTCMinutes(),
    sec: d.getUTCSeconds(),
  };
}

/** The local offset, in seconds east of UTC, at the instant `seconds`. */
function localOffsetAt(seconds: number): number {
  return -new Date(seconds * 1000).getTimezoneOffset() * 60;
}

/**
 * glibc's `mktime` with `tm_isdst = -1` for the local time `wall` (its fields read as UTC
 * seconds): from a guess of UTC, each step moves by the local offset found, until it
 * settles. In a spring-forward gap the steps swing between two instants; glibc then takes
 * the one in summer time (the larger offset), which is the wall time in the offset before
 * the change.
 */
function mktimeLocal(wall: number): number {
  const seen: number[] = [];
  let t = wall;
  for (let probe = 0; probe < 8; probe++) {
    const next = wall - localOffsetAt(t);
    if (next === t) return t;
    if (seen.length > 0 && next === seen[seen.length - 1]) {
      return localOffsetAt(t) >= localOffsetAt(next) ? t : next;
    }
    seen.push(t);
    t = next;
  }
  return t;
}

/** git's `match_string`: how many characters of `str` the text at `i` spells. */
function matchString(s: string, i: number, str: string): number {
  let k = 0;
  for (; i + k < s.length; k++) {
    const c = s[i + k];
    const d = str[k] ?? "";
    if (c === d) continue;
    if (d !== "" && upper(c) === upper(d)) continue;
    if (!isAlnum(c)) break;
    return 0;
  }
  return k;
}

/** git's `match_alpha`: a month, a weekday, a zone, AM / PM, ISO's `T`, or skipped. */
function matchAlpha(s: string, i: number, state: ParseState): number {
  const { tm } = state;
  for (const [index, name] of MONTH_NAMES.entries()) {
    const match = matchString(s, i, name);
    if (match >= 3) {
      tm.mon = index;
      return match;
    }
  }
  for (const name of WEEKDAY_NAMES) {
    const match = matchString(s, i, name);
    if (match >= 3) return match;
  }
  for (const [name, hours, dst] of TIMEZONE_NAMES) {
    const match = matchString(s, i, name);
    if (match >= 3 || match === name.length) {
      // git: bogus, but we like summer; a zone name only when nothing better was seen
      if (state.offset === -1) state.offset = 60 * (hours + dst);
      return match;
    }
  }
  if (matchString(s, i, "PM") === 2) {
    tm.hour = (tm.hour % 12) + 12;
    return 2;
  }
  if (matchString(s, i, "AM") === 2) {
    tm.hour = (tm.hour % 12) + 0;
    return 2;
  }
  // ISO 8601's yyyymmDD'T'HHMMSS, with less precision
  if (s[i] === "T" && isDigit(s[i + 1]) && tm.hour === -1) {
    tm.min = 0;
    tm.sec = 0;
    return 1;
  }
  // skip_alpha
  let k = 1;
  while (isAlpha(s[i + k])) k++;
  return k;
}

/** git's `set_date`: 0 when taken, else non-zero (`tm` may still have changed). */
function setDate(
  year: number,
  month: number,
  day: number,
  nowTm: Tm | undefined,
  now: number,
  tm: Tm,
): number {
  if (!(month > 0 && month < 13 && day > 0 && day < 32)) return -1;
  const r = nowTm ? { ...tm } : tm;
  r.mon = month - 1;
  r.mday = day;
  if (year === -1) {
    if (!nowTm) return 1;
    r.year = nowTm.year;
  } else if (year >= 1970 && year < 2100) r.year = year - 1900;
  else if (year > 70 && year < 100) r.year = year;
  else if (year < 38) r.year = year + 100;
  else return -1;
  if (!nowTm) return 0;
  const specified = tmToTime(r);
  // no date more than ten days in the future
  if (specified !== -1 && now + 10 * 24 * 3600 < specified) return -1;
  tm.mon = r.mon;
  tm.mday = r.mday;
  if (year !== -1) tm.year = r.year;
  return 0;
}

/** git's `set_time`: 0 when in range (the 61st second for a leap second). */
function setTime(hour: number, minute: number, second: number, tm: Tm): number {
  if (0 <= hour && hour <= 24 && 0 <= minute && minute < 60 && 0 <= second && second <= 60) {
    tm.hour = hour;
    tm.min = minute;
    tm.sec = second;
    return 0;
  }
  return -1;
}

const isDateKnown = (tm: Tm) => tm.year !== -1 && tm.mon !== -1 && tm.mday !== -1;
const noDate = (tm: Tm) =>
  tm.year < 0 && tm.mon < 0 && tm.mday < 0 && tm.hour < 0 && tm.min < 0 && tm.sec < 0;
const maybeIso8601 = (tm: Tm) => tm.hour === -1 && tm.min === 0 && tm.sec === 0;

/** git's `match_multi_number`: `num<c>num2[<c>num3]`, a time or a date; 0 when neither. */
function matchMultiNumber(
  num: number,
  c: string,
  s: string,
  start: number,
  at: number,
  tm: Tm,
  nowArg = 0,
) {
  let end = at;
  const second = strtol(s, end + 1);
  const num2 = second.value;
  end = second.end;
  let num3 = -1;
  if (s[end] === c && isDigit(s[end + 1])) {
    const third = strtol(s, end + 1);
    num3 = third.value;
    end = third.end;
  }
  if (c === ":") {
    if (num3 < 0) num3 = 0;
    if (setTime(num, num2, num3, tm) !== 0) return 0;
    // a fraction of the second after a known date, discarded
    if (s[end] === "." && isDigit(s[end + 1]) && isDateKnown(tm)) end = strtol(s, end + 1).end;
    return end - start;
  }
  // parse_date passes 0 (the current time), approxidate its own now
  const now = nowArg || Math.floor(Date.now() / 1000);
  const refuseFuture = gmtime(now);
  const [n1, n2, n3] = [toInt(num), toInt(num2), toInt(num3)];
  if (num > 70) {
    // yyyy-mm-dd, yyyy-dd-mm
    if (setDate(n1, n2, n3, undefined, now, tm) === 0) return end - start;
    if (setDate(n1, n3, n2, undefined, now, tm) === 0) return end - start;
  }
  // mm/dd/yy[yy] first unless the separator is '.'
  if (c !== "." && setDate(n3, n1, n2, refuseFuture, now, tm) === 0) return end - start;
  // European dd.mm.yy[yy] or funny US dd/mm/yy[yy]
  if (setDate(n3, n2, n1, refuseFuture, now, tm) === 0) return end - start;
  // funny European mm.dd.yy
  if (c === "." && setDate(n3, n1, n2, refuseFuture, now, tm) === 0) return end - start;
  return 0;
}

/** git's `match_digit`: seconds, a time, a date, a year, an offset, a day or a month. */
function matchDigit(s: string, i: number, state: ParseState): number {
  const { tm } = state;
  const { value: num, end } = digitsAt(s, i);
  // nine digits or more, before anything else: seconds since 1970
  if (num >= 100000000 && noDate(tm)) {
    state.tm = gmtime(num);
    state.gmt = true;
    return end - i;
  }
  if (":./-".includes(s[end] ?? "x") && isDigit(s[end + 1])) {
    const match = matchMultiNumber(num, s[end], s, i, end, tm);
    if (match) return match;
  }
  const n = end - i;
  // YYYYMMDD and HHMMSS: ISO 8601's compact forms
  if (n === 8 || n === 6) {
    const num1 = Math.trunc(num / 10000);
    const num2 = Math.trunc((num % 10000) / 100);
    const num3 = num % 100;
    let after = end;
    if (n === 8) setDate(num1, num2, num3, undefined, 0, tm);
    else if (setTime(num1, num2, num3, tm) === 0 && s[end] === "." && isDigit(s[end + 1])) {
      after = strtol(s, end + 1).end;
    }
    return after - i;
  }
  // ISO 8601's HHMM or HH after a `T`
  if (maybeIso8601(tm)) {
    let num1 = num;
    let num2 = 0;
    if (n === 4) {
      num1 = Math.trunc(num / 100);
      num2 = num % 100;
    }
    if ((n === 4 || n === 2) && !noDate(tm) && setTime(num1, num2, 0, tm) === 0) return n;
    tm.min = -1;
    tm.sec = -1;
  }
  // a four-digit year, or an offset without its sign
  if (n === 4) {
    if (num <= 1400 && state.offset === -1) {
      state.offset = Math.trunc(num / 100) * 60 + (num % 100);
    } else if (num > 1900 && num < 2100) tm.year = num - 1900;
    return n;
  }
  if (n > 2) return n;
  // a day before a month or a year (01 Apr 05 is April 1st, 2005)
  if (num > 0 && num < 32 && tm.mday < 0) {
    tm.mday = num;
    return n;
  }
  // a two-digit year
  if (n === 2 && tm.year < 0) {
    if (num < 10 && tm.mday >= 0) {
      tm.year = num + 100;
      return n;
    }
    if (num >= 70) {
      tm.year = num;
      return n;
    }
  }
  if (num > 0 && num < 13 && tm.mon < 0) tm.mon = num - 1;
  return n;
}

/** git's `match_tz`: `+HHMM`, `+HH:MM`, `+HH`; out of range ones ignored. */
function matchTz(s: string, i: number, state: ParseState): number {
  const digits = digitsAt(s, i + 1);
  let hour = digits.value;
  let end = digits.end;
  const n = end - (i + 1);
  let min = 0;
  if (n === 4) {
    min = hour % 100;
    hour = Math.trunc(hour / 100);
  } else if (n !== 2) {
    min = 99;
  } else if (s[end] === ":") {
    const minutes = strtol(s, end + 1);
    min = minutes.value;
    end = minutes.end;
    if (end - (i + 1) !== 5) min = 99;
  }
  if (min < 60 && hour < 24) {
    const offset = hour * 60 + min;
    state.offset = s[i] === "-" ? -offset : offset;
  }
  return end - i;
}

/** git's `match_object_header_date`: `<seconds> <+-HHMM>` after an `@`, alone. */
function matchObjectHeaderDate(
  s: string,
  i: number,
): { timestamp: number; offset: number } | undefined {
  if (!isDigit(s[i])) return undefined;
  const stamp = digitsAt(s, i);
  if (s[stamp.end] !== " ") return undefined;
  if (BigInt(stamp.text) >= 2n ** 64n - 1n) return undefined;
  const sign = s[stamp.end + 1];
  if (sign !== "+" && sign !== "-") return undefined;
  const at = stamp.end + 2;
  const ofs = strtol(s, at);
  const after = s[ofs.end];
  if ((after !== undefined && after !== "\n") || ofs.end !== at + 4) return undefined;
  let offset = Math.trunc(ofs.value / 100) * 60 + (ofs.value % 100);
  if (sign === "-") offset = -offset;
  return { timestamp: stamp.value, offset };
}

/** A timezone offset in minutes as git writes it (`+HHMM`). */
export function formatOffset(minutes: number): string {
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

/**
 * A date as git's `parse_date` reads `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`, undefined
 * where git refuses it (`fatal: invalid date format`). See the module comment for the forms.
 */
export function parseGitDate(text: string): { timestamp: number; tzOffset: string } | undefined {
  const s = text.split("\0")[0];
  if (s[0] === "@") {
    const raw = matchObjectHeaderDate(s, 1);
    if (raw) {
      if (!Number.isSafeInteger(raw.timestamp)) return undefined;
      return { timestamp: raw.timestamp, tzOffset: formatOffset(raw.offset) };
    }
  }
  const state: ParseState = {
    tm: { year: -1, mon: -1, mday: -1, hour: -1, min: -1, sec: -1 },
    offset: -1,
    gmt: false,
  };
  let i = 0;
  while (i < s.length && s[i] !== "\n") {
    const c = s[i];
    let match = 0;
    if (isAlpha(c)) match = matchAlpha(s, i, state);
    else if (isDigit(c)) match = matchDigit(s, i, state);
    else if ((c === "-" || c === "+") && isDigit(s[i + 1])) match = matchTz(s, i, state);
    i += match || 1;
  }

  // not mktime(), which reads the fields in the local timezone
  let timestamp = tmToTime(state.tm);
  if (timestamp === -1) return undefined;
  let offset = state.offset;
  if (offset === -1) {
    const local = mktimeLocal(timestamp);
    offset = Math.trunc((timestamp - local) / 60);
  }
  if (!state.gmt) {
    // git 2.5x: no date before 1970 or after 2099 once the offset is applied
    if (offset > 0 && offset * 60 > timestamp) return undefined;
    if (offset < 0 && -offset * 60 > TIMESTAMP_MAX - timestamp) return undefined;
    timestamp -= offset * 60;
  }
  return { timestamp, tzOffset: formatOffset(offset) };
}

/* ------------------------------------------------------------------ approxidate */

/** git's `struct tm` as `approxidate_str` fills it: local fields, -1 where not seen yet. */
interface ApproxTm extends Tm {
  wday: number;
  /** `tm_isdst`: 1 in summer time, 0 outside it (what `localtime_r` gave last) */
  isdst: number;
}

/** The standard and the summer offsets (seconds east of UTC) of the year `seconds` is in. */
function yearOffsets(seconds: number): { std: number; dst: number } {
  const year = new Date(seconds * 1000).getUTCFullYear();
  const jan = localOffsetAt(Date.UTC(year, 0, 1) / 1000);
  const jul = localOffsetAt(Date.UTC(year, 6, 1) / 1000);
  return { std: Math.min(jan, jul), dst: Math.max(jan, jul) };
}

/** `localtime_r`: the local fields of `seconds`, `tm_isdst` included. */
function localtime(seconds: number): ApproxTm {
  const d = new Date(seconds * 1000);
  const { std, dst } = yearOffsets(seconds);
  return {
    year: d.getFullYear() - 1900,
    mon: d.getMonth(),
    mday: d.getDate(),
    hour: d.getHours(),
    min: d.getMinutes(),
    sec: d.getSeconds(),
    wday: d.getDay(),
    isdst: dst !== std && localOffsetAt(seconds) === dst ? 1 : 0,
  };
}

/**
 * glibc's `mktime`: the local fields as seconds since the epoch, out-of-range fields
 * carried. `tm_isdst` is honoured as glibc honours it: a time on the other side of a
 * summer-time change from what `isdst` says is read in the offset `isdst` names (git's
 * approxidate keeps now's `tm_isdst`, so "june" asked in November is an hour off).
 */
function mktime(tm: ApproxTm): number {
  const d = new Date(0);
  d.setUTCFullYear(tm.year + 1900, tm.mon, tm.mday);
  d.setUTCHours(tm.hour, tm.min, tm.sec);
  const wall = Math.floor(d.getTime() / 1000);
  const t = mktimeLocal(wall);
  if (tm.isdst < 0) return t;
  const { std, dst } = yearOffsets(t);
  if (std === dst) return t;
  const actual = localOffsetAt(t) === dst ? 1 : 0;
  if (actual === (tm.isdst > 0 ? 1 : 0)) return t;
  return wall - (tm.isdst > 0 ? dst : std);
}

/** git's `update_tm`: the missing fields from `now`, `sec` seconds back; `tm` refilled. */
function updateTm(tm: ApproxTm, now: ApproxTm, sec: number): number {
  let back = sec;
  if (tm.mday < 0) {
    const offset = tm.mday + 1;
    if (back === 0 && offset < 0) back = -offset * 24 * 60 * 60;
    tm.mday = now.mday;
  }
  if (tm.mon < 0) tm.mon = now.mon;
  if (tm.year < 0) {
    tm.year = now.year;
    if (tm.mon > now.mon) tm.year--;
  }
  const n = mktime(tm) - back;
  Object.assign(tm, localtime(n));
  return n;
}

/** git's `pending_number`: a number seen last is a day, a month or a year. */
function pendingNumber(tm: ApproxTm, num: { value: number }): void {
  const number = num.value;
  if (!number) return;
  num.value = 0;
  if (tm.mday < 0 && number < 32) tm.mday = number;
  else if (tm.mon < 0 && number < 13) tm.mon = number - 1;
  else if (tm.year < 0) {
    if (number > 1969 && number < 2100) tm.year = number - 1900;
    else if (number > 69 && number < 100) tm.year = number;
    else if (number < 38) tm.year = 100 + number;
  }
}

/** git's `date_time`: `hour` o'clock, yesterday's when today's is still to come. */
function dateTime(tm: ApproxTm, hour: number): void {
  if (tm.mday < 0 && tm.hour < hour) tm.mday = -2;
  tm.hour = hour;
  tm.min = 0;
  tm.sec = 0;
}

type Special = (tm: ApproxTm, now: ApproxTm, num: { value: number }) => void;

/** git's `special` words. */
const SPECIALS: [string, Special][] = [
  [
    "yesterday",
    (tm, now, num) => {
      num.value = 0;
      tm.mday = -1;
      updateTm(tm, now, 24 * 60 * 60);
    },
  ],
  [
    "noon",
    (tm, _now, num) => {
      pendingNumber(tm, num);
      dateTime(tm, 12);
    },
  ],
  [
    "midnight",
    (tm, _now, num) => {
      pendingNumber(tm, num);
      dateTime(tm, 0);
    },
  ],
  [
    "tea",
    (tm, _now, num) => {
      pendingNumber(tm, num);
      dateTime(tm, 17);
    },
  ],
  [
    "PM",
    (tm, _now, num) => {
      let hour = tm.hour;
      if (num.value) {
        hour = num.value;
        tm.min = 0;
        tm.sec = 0;
      }
      num.value = 0;
      tm.hour = (hour % 12) + 12;
    },
  ],
  [
    "AM",
    (tm, _now, num) => {
      let hour = tm.hour;
      if (num.value) {
        hour = num.value;
        tm.min = 0;
        tm.sec = 0;
      }
      num.value = 0;
      tm.hour = hour % 12;
    },
  ],
  [
    "never",
    (tm, _now, num) => {
      Object.assign(tm, localtime(0));
      num.value = 0;
    },
  ],
  [
    "now",
    (tm, now, num) => {
      num.value = 0;
      updateTm(tm, now, 0);
    },
  ],
  [
    "today",
    (tm, now, num) => {
      if (tm.hour === now.hour && tm.min === now.min && tm.sec === now.sec) dateTime(tm, 0);
      num.value = 0;
      tm.mday = -1;
      updateTm(tm, now, 0);
    },
  ],
];

const NUMBER_NAMES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];

const TYPE_LENGTHS: [string, number][] = [
  ["seconds", 1],
  ["minutes", 60],
  ["hours", 60 * 60],
  ["days", 24 * 60 * 60],
  ["weeks", 7 * 24 * 60 * 60],
];

/** git's `approxidate_alpha`: a word; returns where it ends. */
function approxidateAlpha(
  s: string,
  i: number,
  tm: ApproxTm,
  now: ApproxTm,
  num: { value: number },
  touched: { value: boolean },
): number {
  let end = i + 1;
  while (isAlpha(s[end])) end++;
  for (let m = 0; m < 12; m++) {
    if (matchString(s, i, MONTH_NAMES[m] ?? "") >= 3) {
      tm.mon = m;
      touched.value = true;
      return end;
    }
  }
  for (const [name, fn] of SPECIALS) {
    if (matchString(s, i, name) === name.length) {
      fn(tm, now, num);
      touched.value = true;
      return end;
    }
  }
  if (!num.value) {
    for (let n = 1; n < 11; n++) {
      const name = NUMBER_NAMES[n] ?? "";
      if (matchString(s, i, name) === name.length) {
        num.value = n;
        touched.value = true;
        return end;
      }
    }
    if (matchString(s, i, "last") === 4) {
      num.value = 1;
      touched.value = true;
    }
    return end;
  }
  for (const [type, length] of TYPE_LENGTHS) {
    if (matchString(s, i, type) >= type.length - 1) {
      updateTm(tm, now, length * num.value);
      num.value = 0;
      touched.value = true;
      return end;
    }
  }
  for (let w = 0; w < 7; w++) {
    if (matchString(s, i, WEEKDAY_NAMES[w] ?? "") >= 3) {
      let n = num.value - 1;
      num.value = 0;
      let diff = tm.wday - w;
      if (diff <= 0) n++;
      diff += 7 * n;
      updateTm(tm, now, diff * 24 * 60 * 60);
      touched.value = true;
      return end;
    }
  }
  if (matchString(s, i, "months") >= 5) {
    updateTm(tm, now, 0);
    let n = tm.mon - num.value;
    num.value = 0;
    while (n < 0) {
      n += 12;
      tm.year--;
    }
    tm.mon = n;
    touched.value = true;
    return end;
  }
  if (matchString(s, i, "years") >= 4) {
    updateTm(tm, now, 0);
    tm.year -= num.value;
    num.value = 0;
    touched.value = true;
    return end;
  }
  return end;
}

/** git's `approxidate_digit`: a number, or a date or time written with numbers. */
function approxidateDigit(
  s: string,
  i: number,
  tm: ApproxTm,
  num: { value: number },
  now: number,
): number {
  const { value: number, end } = digitsAt(s, i);
  if (":./-".includes(s[end] ?? "x") && isDigit(s[end + 1])) {
    const match = matchMultiNumber(number, s[end] ?? "", s, i, end, tm, now);
    if (match) return i + match;
  }
  // zero-padding only for small numbers ("Dec 02", never "Dec 0002")
  if (s[i] !== "0" || end - i <= 2) num.value = toInt(number);
  return end;
}

/**
 * git's `approxidate_careful`: a date as `parse_date` reads it, else git's approximate
 * forms (`yesterday`, `2.weeks.ago`, `noon`, `last friday`, `3 hours ago`, `Dec 6`), in
 * local time relative to `now` (seconds, default the current time). `error` is set when
 * nothing in the text was a date (git then rejects `<ref>@{<text>}`).
 *
 * @example
 * ```typescript
 * approxidateCareful("1700000000 +0000"); // { timestamp: 1700000000, error: false }
 * approxidateCareful("2.hours.ago");      // { timestamp: now - 7200, error: false }
 * approxidateCareful("blah");             // { error: true, ... }
 * ```
 */
export function approxidateCareful(
  text: string,
  now: number = Math.floor(Date.now() / 1000),
): { timestamp: number; error: boolean } {
  const parsed = parseGitDate(text);
  if (parsed) return { timestamp: parsed.timestamp, error: false };
  const nowTm = localtime(now);
  const tm: ApproxTm = { ...nowTm, year: -1, mon: -1, mday: -1 };
  const num = { value: 0 };
  const touched = { value: false };
  const s = text.split("\0")[0] ?? "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (isDigit(c)) {
      pendingNumber(tm, num);
      i = approxidateDigit(s, i, tm, num, now);
      touched.value = true;
      continue;
    }
    if (isAlpha(c)) {
      i = approxidateAlpha(s, i, tm, nowTm, num, touched);
      continue;
    }
    i++;
  }
  pendingNumber(tm, num);
  return { timestamp: updateTm(tm, nowTm, 0), error: !touched.value };
}

const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS = MONTH_NAMES.map((m) => m.slice(0, 3));

/**
 * A timestamp in git's RFC 2822 date mode (`show_date(..., DATE_RFC2822)`), in the given
 * offset: `Thu, 7 Apr 2005 22:13:13 +0000`.
 */
export function formatRfc2822Date(timestamp: number, tzOffset: string): string {
  const sign = tzOffset.startsWith("-") ? -1 : 1;
  const digits = tzOffset.replace(/^[+-]/, "").padStart(4, "0");
  const minutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  const d = new Date((timestamp + minutes * 60) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${SHORT_WEEKDAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${SHORT_MONTHS[d.getUTCMonth()]} ` +
    `${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:` +
    `${pad(d.getUTCSeconds())} ${formatOffset(minutes)}`
  );
}
