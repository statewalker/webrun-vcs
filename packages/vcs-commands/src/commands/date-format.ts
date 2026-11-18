/**
 * git's date modes (`--date=<mode>`, `log.date`): date.c's parse_date_format and show_date.
 *
 * @example
 * ```typescript
 * const mode = parseDateMode("iso");
 * showDate(1112911993, "+0200", mode); // "2005-04-08 00:13:13 +0200"
 * showDate(1112911993, "+0200", parseDateMode("format:%Y/%m/%d")); // "2005/04/08"
 * showDate(1112911993, "+0200", parseDateMode("relative"), { now }); // "19 years ago"
 * ```
 *
 * The modes: `default` (`Thu Apr 7 22:13:13 2005 +0200`), `relative`, `local` (default in
 * the local zone, without it), `iso`/`iso8601`, `iso-strict`/`iso8601-strict`, `rfc`/`rfc2822`,
 * `short`, `raw`, `unix`, `human` and `format:<strftime>` (the C locale's names); each but
 * `relative`, `raw`... may end in `-local` to be shown in the local zone. `auto:<mode>` is the
 * default mode, as git without a terminal takes it.
 *
 * @module
 */

import { relativeDate } from "./pretty-format.js";

/** A parsed date mode (date.c's struct date_mode). */
export interface DateMode {
  type:
    | "normal"
    | "relative"
    | "short"
    | "iso8601"
    | "iso8601-strict"
    | "rfc2822"
    | "strftime"
    | "raw"
    | "unix"
    | "human";
  /** Shown in the local zone (`-local`, `local`) */
  local: boolean;
  /** The strftime format of `format:` */
  strftime?: string;
}

/** What {@link showDate} reads besides the date. */
export interface ShowDateContext {
  /** Now, in seconds (`relative`, `human`); default the clock */
  now?: number;
  /** The local zone's offset east of UTC in minutes at a time (default the host's) */
  localTzOffset?: (time: number) => number;
  /**
   * The local zone's name at a time, as `%Z` of a `format-local:` date shows it (default
   * {@link hostZoneName})
   */
  localTzName?: (time: number) => string;
}

/** An error git reports for a date mode it does not know (`fatal: unknown date format`). */
export class DateModeError extends Error {}

const TYPES: [string, DateMode["type"]][] = [
  ["relative", "relative"],
  ["iso8601-strict", "iso8601-strict"],
  ["iso-strict", "iso8601-strict"],
  ["iso8601", "iso8601"],
  ["iso", "iso8601"],
  ["rfc2822", "rfc2822"],
  ["rfc", "rfc2822"],
  ["short", "short"],
  ["default", "normal"],
  ["human", "human"],
  ["raw", "raw"],
  ["unix", "unix"],
  ["format", "strftime"],
];

/** date.c's parse_date_format. */
export function parseDateMode(spec: string): DateMode {
  let format = spec;
  // "auto:foo": foo on a terminal, else the default
  if (format.startsWith("auto:")) format = "default";
  if (format === "local") format = "default-local";
  const found = TYPES.find(([name]) => format.startsWith(name));
  if (!found) throw new DateModeError(`fatal: unknown date format ${spec}`);
  let rest = format.slice(found[0].length);
  const mode: DateMode = { type: found[1], local: false };
  if (rest.startsWith("-local")) {
    mode.local = true;
    rest = rest.slice(6);
  }
  if (mode.type === "strftime") {
    if (!rest.startsWith(":")) {
      throw new DateModeError(`fatal: date format missing colon separator: ${spec}`);
    }
    mode.strftime = rest.slice(1);
  } else if (rest !== "") throw new DateModeError(`fatal: unknown date format ${spec}`);
  return mode;
}

/** The default date mode. */
export const DEFAULT_DATE_MODE: DateMode = { type: "normal", local: false };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
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
const pad = (n: number, width = 2, fill = "0") => String(n).padStart(width, fill);

/** A broken-down time (struct tm). */
interface Tm {
  year: number;
  mon: number;
  mday: number;
  hour: number;
  min: number;
  sec: number;
  wday: number;
  yday: number;
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** The first day of each month in a common year (date.c's mdays). */
const MDAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/**
 * gmtime: the broken-down UTC time of `t` seconds, with integer arithmetic only (no `Date`,
 * whose range ends in the year 275760: git shows `9999999999999 +0000` as the year 318857).
 * Undefined when the year does not fit a C int (glibc's gmtime fails then).
 */
function gmtime(t: number): Tm | undefined {
  let days = Math.floor(t / 86400);
  const rem = t - days * 86400;
  const hour = Math.floor(rem / 3600);
  const min = Math.floor((rem % 3600) / 60);
  const sec = rem % 60;
  const wday = (((days + 4) % 7) + 7) % 7;
  // civil from days (Howard Hinnant's algorithm), the era of 400 years first
  days += 719468;
  const era = Math.floor(days / 146097);
  const doe = days - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const mday = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const mon = mp < 10 ? mp + 2 : mp - 10;
  const year = yoe + era * 400 + (mon < 2 ? 1 : 0);
  if (year - 1900 > 2147483647 || year - 1900 < -2147483648) return undefined;
  const yday = (mon < 2 ? 0 : isLeap(year) ? 1 : 0) + (MDAYS[mon] as number) + mday - 1;
  return { year, mon, mday, hour, min, sec, wday, yday };
}

/**
 * git's "decimal parse of tz" (`-0130` is -130) as minutes east of UTC, as gm_time_t takes
 * it: `+0060` is 60 minutes.
 */
function tzMinutes(tz: number): number {
  const abs = Math.abs(tz);
  const minutes = Math.trunc(abs / 100) * 60 + (abs % 100);
  return tz < 0 ? -minutes : minutes;
}

/** Minutes east of UTC in git's decimal form (date.c's local_time_tzoffset). */
function tzDecimal(minutes: number): number {
  const abs = Math.abs(minutes);
  const value = (abs % 60) + Math.trunc(abs / 60) * 100;
  return minutes < 0 ? -value : value;
}

/** An ident's zone as git reads it (show_ident_date's strtol): `+0200` is 200. */
function tzValue(tz: string): number {
  const m = /^\s*([+-]?)(\d+)/.exec(tz);
  if (!m) return 0;
  const value = Number(m[2]) * (m[1] === "-" ? -1 : 1);
  return value >= 2147483647 || value <= -2147483648 ? 0 : value;
}

/** printf's `%+05d` */
function tzText(tz: number): string {
  return `${tz < 0 ? "-" : "+"}${pad(Math.abs(tz), 4)}`;
}

/** date.c's tm_to_time_t: only 1970..2099 (-1 elsewhere) */
function tmToTimeT(tm: Tm): number {
  const year = tm.year - 1970;
  if (year < 0 || year > 129) return -1;
  let day = tm.mday;
  if (tm.mon < 2 || (year + 2) % 4) day--;
  return (
    (year * 365 + Math.trunc((year + 1) / 4) + (MDAYS[tm.mon] as number) + day) * 86400 +
    tm.hour * 3600 +
    tm.min * 60 +
    tm.sec
  );
}

/** The seconds of a broken-down time read as UTC (no range limit). */
function utcSeconds(tm: Tm): number {
  const y = tm.mon < 2 ? tm.year - 1 : tm.year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = tm.mon < 2 ? tm.mon + 10 : tm.mon - 2;
  const doy = Math.floor((153 * mp + 2) / 5) + tm.mday - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  const days = era * 146097 + doe - 719468;
  return days * 86400 + tm.hour * 3600 + tm.min * 60 + tm.sec;
}

/** What strftime reads besides the broken-down time. */
interface StrftimeZone {
  /** The zone's name (`tm_zone`: GMT for git's shifted times, the local zone's otherwise) */
  name: string;
  /** The local zone's offset east of UTC in minutes at a time (mktime, for `%s`) */
  localTz: (time: number) => number;
  /** `tm_gmtoff` in minutes (`%z` with flags): 0 for git's shifted times, local otherwise */
  gmtoff: number;
}

/** glibc's iso_week_days */
function isoWeekDays(yday: number, wday: number): number {
  const big = 378;
  return yday - ((yday - wday + 4 + big) % 7) + 4 - 1;
}

/**
 * glibc's strftime in the C locale (time/strftime_l.c): the flags `_` `-` `0` `^` `#`, a
 * field width, the `E` and `O` modifiers (no era or alternative digits in the C locale), and
 * a conversion it does not know copied as written.
 */
function glibcStrftime(fmt: string, tm: Tm, zone: StrftimeZone): string {
  let out = "";
  const hour12 = tm.hour > 12 ? tm.hour - 12 : tm.hour === 0 ? 12 : tm.hour;
  for (let f = 0; f < fmt.length; f++) {
    if (fmt[f] !== "%") {
      out += fmt[f];
      continue;
    }
    const start = f;
    let pad = "";
    let toUpper = false;
    let toLower = false;
    let changeCase = false;
    let width = -1;
    for (;;) {
      const c = fmt[++f];
      if (c === "_" || c === "-" || c === "0") pad = c;
      else if (c === "^") toUpper = true;
      else if (c === "#") changeCase = true;
      else break;
    }
    if (f < fmt.length && fmt[f] >= "0" && fmt[f] <= "9") {
      width = 0;
      while (f < fmt.length && fmt[f] >= "0" && fmt[f] <= "9") {
        width = Math.min(2147483647, width * 10 + (fmt.charCodeAt(f) - 48));
        f++;
      }
    }
    let modifier = "";
    if (fmt[f] === "E" || fmt[f] === "O") modifier = fmt[f++] as string;
    const add = (s: string) => {
      const delta = width - s.length;
      if (delta > 0) out += (pad === "0" ? "0" : " ").repeat(delta);
      out += s;
    };
    const cpy = (s: string) => add(toLower ? s.toLowerCase() : toUpper ? s.toUpperCase() : s);
    const subformat = (sub: string) => {
      const text = glibcStrftime(sub, tm, zone);
      add(toUpper ? text.toUpperCase() : text);
    };
    const badFormat = () => cpy(fmt.slice(start, f + 1));
    /** do_number (`exact`: the digits not widened, as `%s` jumps past DO_NUMBER) */
    const number = (d: number, value: number, spacepad = false, exact = false) => {
      if (spacepad && pad !== "0" && pad !== "-") pad = "_";
      const digits = exact || d > width ? d : width;
      const negative = value < 0;
      let buf = String(Math.abs(value));
      if (negative) buf = `-${buf}`;
      if (pad !== "-") {
        const padding = digits - buf.length;
        if (padding > 0) {
          if (pad === "_") {
            out += " ".repeat(padding);
            width = width > padding ? width - padding : 0;
          } else {
            if (negative) {
              out += "-";
              buf = buf.slice(1);
            }
            out += "0".repeat(padding);
            width = 0;
          }
        }
      }
      cpy(buf);
    };
    const c = fmt[f];
    switch (c) {
      case "%":
        if (modifier) badFormat();
        else add("%");
        break;
      case "a":
      case "A":
        if (modifier) {
          badFormat();
          break;
        }
        if (changeCase) [toUpper, toLower] = [true, false];
        cpy(c === "a" ? (WEEKDAYS[tm.wday] as string).slice(0, 3) : (WEEKDAYS[tm.wday] as string));
        break;
      case "b":
      case "h":
      case "B":
        if (changeCase) [toUpper, toLower] = [true, false];
        if (modifier === "E") badFormat();
        else cpy(c === "B" ? (MONTHS[tm.mon] as string) : (MONTHS[tm.mon] as string).slice(0, 3));
        break;
      case "c":
        if (modifier === "O") badFormat();
        else subformat("%a %b %e %H:%M:%S %Y");
        break;
      case "C": {
        const year = tm.year;
        number(1, Math.trunc(year / 100) - (year % 100 < 0 ? 1 : 0));
        break;
      }
      case "x":
        if (modifier === "O") badFormat();
        else subformat("%m/%d/%y");
        break;
      case "D":
        if (modifier) badFormat();
        else subformat("%m/%d/%y");
        break;
      case "d":
        if (modifier === "E") badFormat();
        else number(2, tm.mday);
        break;
      case "e":
        if (modifier === "E") badFormat();
        else number(2, tm.mday, true);
        break;
      case "F":
        if (modifier) badFormat();
        else subformat("%Y-%m-%d");
        break;
      case "H":
        if (modifier === "E") badFormat();
        else number(2, tm.hour);
        break;
      case "I":
        if (modifier === "E") badFormat();
        else number(2, hour12);
        break;
      case "k":
        if (modifier === "E") badFormat();
        else number(2, tm.hour, true);
        break;
      case "l":
        if (modifier === "E") badFormat();
        else number(2, hour12, true);
        break;
      case "j":
        if (modifier === "E") badFormat();
        else number(3, tm.yday + 1);
        break;
      case "M":
        if (modifier === "E") badFormat();
        else number(2, tm.min);
        break;
      case "m":
        if (modifier === "E") badFormat();
        else number(2, tm.mon + 1);
        break;
      case "n":
        add("\n");
        break;
      case "t":
        add("\t");
        break;
      case "P":
      case "p":
        if (c === "P") toLower = true;
        if (changeCase) [toUpper, toLower] = [false, true];
        cpy(tm.hour > 11 ? "PM" : "AM");
        break;
      case "R":
        subformat("%H:%M");
        break;
      case "r":
        subformat("%I:%M:%S %p");
        break;
      case "S":
        if (modifier === "E") badFormat();
        else number(2, tm.sec);
        break;
      case "s": {
        // mktime: the broken-down time read in the local zone
        const t = utcSeconds(tm);
        const seconds = t - zone.localTz(t) * 60;
        number(1, seconds, false, true);
        break;
      }
      case "X":
        if (modifier === "O") badFormat();
        else subformat("%H:%M:%S");
        break;
      case "T":
        subformat("%H:%M:%S");
        break;
      case "u":
        number(1, ((tm.wday - 1 + 7) % 7) + 1);
        break;
      case "U":
        if (modifier === "E") badFormat();
        else number(2, Math.trunc((tm.yday - tm.wday + 7) / 7));
        break;
      case "V":
      case "g":
      case "G": {
        if (modifier === "E") {
          badFormat();
          break;
        }
        let year = tm.year;
        let days = isoWeekDays(tm.yday, tm.wday);
        if (days < 0) {
          year--;
          days = isoWeekDays(tm.yday + (365 + (isLeap(year) ? 1 : 0)), tm.wday);
        } else {
          const d = isoWeekDays(tm.yday - (365 + (isLeap(year) ? 1 : 0)), tm.wday);
          if (d >= 0) {
            year++;
            days = d;
          }
        }
        if (c === "g") number(2, ((year % 100) + 100) % 100);
        else if (c === "G") number(1, year);
        else number(2, Math.trunc(days / 7) + 1);
        break;
      }
      case "W":
        if (modifier === "E") badFormat();
        else number(2, Math.trunc((tm.yday - ((tm.wday - 1 + 7) % 7) + 7) / 7));
        break;
      case "w":
        if (modifier === "E") badFormat();
        else number(1, tm.wday);
        break;
      case "Y":
        if (modifier === "O") badFormat();
        else number(1, tm.year);
        break;
      case "y":
        number(2, ((tm.year % 100) + 100) % 100);
        break;
      case "Z":
        if (changeCase) [toUpper, toLower] = [false, true];
        cpy(zone.name);
        break;
      case "z": {
        // tm_gmtoff
        let diff = zone.gmtoff;
        if (diff < 0) {
          add("-");
          diff = -diff;
        } else add("+");
        number(4, Math.trunc(diff / 60) * 100 + (diff % 60));
        break;
      }
      case undefined:
        // a "%" at the end: copied with its flags
        f--;
        badFormat();
        break;
      default:
        badFormat();
    }
  }
  return out;
}

/**
 * git's strbuf_addftime: `%z` (the zone given), `%s` (from the time and that zone) and, when
 * `suppressTz`, `%Z` handled before glibc's strftime gets the rest.
 */
function strftime(
  fmt: string,
  tm: Tm,
  tz: number,
  suppressTz: boolean,
  zone: StrftimeZone,
): string {
  let munged = "";
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== "%") {
      munged += c;
      continue;
    }
    const next = fmt[i + 1];
    if (next === "%") {
      munged += "%%";
      i++;
    } else if (next === "s") {
      // timestamp_t arithmetic: unsigned (tm_to_time_t's -1 for a year past 2099 wraps)
      const seconds = BigInt(3600 * Math.trunc(tz / 100) + 60 * (tz % 100));
      munged += String(BigInt.asUintN(64, BigInt(tmToTimeT(tm)) - seconds));
      i++;
    } else if (next === "z") {
      munged += tzText(tz);
      i++;
    } else if (suppressTz && next === "Z") {
      i++;
    } else munged += "%";
  }
  return glibcStrftime(munged, tm, zone);
}

/**
 * The host's name for the local zone at a time (strftime's `%Z` of a local date): the
 * abbreviation `Intl` knows (`PST`, `CEST`), else, for a zone tzdata only names by its offset
 * (`Asia/Kathmandu`), the offset as glibc prints it (`+0545`).
 */
export function hostZoneName(time: number, localTz: (time: number) => number): string {
  const date = new Date(time * 1000);
  const named = (locale: string) => {
    try {
      return new Intl.DateTimeFormat(locale, { timeZoneName: "short" })
        .formatToParts(date)
        .find((p) => p.type === "timeZoneName")?.value;
    } catch {
      return undefined;
    }
  };
  const isOffset = (name: string | undefined) => !name || /^(GMT|UTC)[+-]/.test(name);
  let name = named("en-US");
  if (isOffset(name)) name = isOffset(named("en-GB")) ? undefined : named("en-GB");
  if (name) return name;
  const minutes = localTz(time);
  if (Number.isNaN(date.getTime())) return "";
  return tzText(tzDecimal(minutes));
}

/** date.c's show_date_normal (with `human` the parts near now hidden). */
function showDateNormal(
  time: number,
  tm: Tm,
  tz: number,
  human: { tm: Tm; tz: number } | undefined,
  local: boolean,
  now: number,
): string {
  const hide = { year: false, date: false, wday: false, time: false, seconds: false, tz: false };
  // without `human`, git compares with a zeroed struct tm and a zone of -1: a date in the
  // zone -0001 shows no zone (and one in 1900 no year)
  const humanTm = human?.tm ?? { year: 1900, mon: 0, mday: 0 };
  hide.tz = local || tz === (human ? human.tz : -1);
  hide.year = tm.year === humanTm.year;
  if (hide.year && tm.mon === humanTm.mon) {
    if (tm.mday > humanTm.mday) {
      // a future date: think time zones
    } else if (tm.mday === humanTm.mday) {
      hide.date = hide.wday = true;
    } else if (tm.mday + 5 > humanTm.mday) {
      hide.date = true;
    }
  }
  if (hide.wday) return relativeDate(time, now);
  if (human && human.tm.year !== 1900) {
    hide.seconds = true;
    hide.tz ||= !hide.date;
    hide.wday = hide.time = !hide.year;
  }
  let out = "";
  if (!hide.wday) out += `${(WEEKDAYS[tm.wday] as string).slice(0, 3)} `;
  if (!hide.date) out += `${(MONTHS[tm.mon] as string).slice(0, 3)} ${tm.mday} `;
  if (!hide.time) {
    out += `${pad(tm.hour)}:${pad(tm.min)}`;
    if (!hide.seconds) out += `:${pad(tm.sec)}`;
  } else out = out.replace(/[ \t\n\r]+$/, "");
  if (!hide.year) out += ` ${tm.year}`;
  if (!hide.tz) out += ` ${tzText(tz)}`;
  return out;
}

/**
 * date.c's show_date: `time` (seconds) in its zone `tzOffset` (`+HHMM`, read as git reads
 * it: `+0060` stays `+0060`) as the mode shows it.
 */
export function showDate(
  time: number,
  tzOffset: string,
  mode: DateMode,
  context: ShowDateContext = {},
): string {
  if (mode.type === "unix") return String(time);
  const now = context.now ?? Math.floor(Date.now() / 1000);
  const localTz = context.localTzOffset ?? ((t: number) => -new Date(t * 1000).getTimezoneOffset());
  const localMinutes = (t: number) => {
    const m = localTz(t);
    return Number.isFinite(m) ? m : 0;
  };
  let tz = tzValue(tzOffset);
  let human: { tm: Tm; tz: number } | undefined;
  if (mode.type === "human") {
    const minutes = localMinutes(now);
    human = { tm: gmtime(now + minutes * 60) ?? (gmtime(0) as Tm), tz: tzDecimal(minutes) };
  }
  if (mode.local) tz = tzDecimal(localMinutes(time));
  if (mode.type === "raw") return `${time} ${tzText(tz)}`;
  if (mode.type === "relative") return relativeDate(time, now);
  let tm = gmtime(time + (mode.local ? localMinutes(time) : tzMinutes(tz)) * 60);
  if (!tm) {
    tm = gmtime(0) as Tm;
    tz = 0;
  }
  switch (mode.type) {
    case "short":
      return `${pad(tm.year, 4)}-${pad(tm.mon + 1)}-${pad(tm.mday)}`;
    case "iso8601":
      return (
        `${pad(tm.year, 4)}-${pad(tm.mon + 1)}-${pad(tm.mday)} ` +
        `${pad(tm.hour)}:${pad(tm.min)}:${pad(tm.sec)} ${tzText(tz)}`
      );
    case "iso8601-strict": {
      let out =
        `${pad(tm.year, 4)}-${pad(tm.mon + 1)}-${pad(tm.mday)}T` +
        `${pad(tm.hour)}:${pad(tm.min)}:${pad(tm.sec)}`;
      if (tz === 0) out += "Z";
      else {
        const abs = Math.abs(tz);
        out += `${tz >= 0 ? "+" : "-"}${pad(Math.trunc(abs / 100))}:${pad(abs % 100)}`;
      }
      return out;
    }
    case "rfc2822":
      return (
        `${(WEEKDAYS[tm.wday] as string).slice(0, 3)}, ${tm.mday} ` +
        `${(MONTHS[tm.mon] as string).slice(0, 3)} ${tm.year} ` +
        `${pad(tm.hour)}:${pad(tm.min)}:${pad(tm.sec)} ${tzText(tz)}`
      );
    case "strftime": {
      if (!mode.strftime) return "";
      const zone: StrftimeZone = {
        // a shifted UTC time is GMT to strftime; a local one has the local zone's name
        name: mode.local
          ? (context.localTzName ?? ((t: number) => hostZoneName(t, localMinutes)))(time)
          : "GMT",
        localTz: localMinutes,
        gmtoff: mode.local ? localMinutes(time) : 0,
      };
      return strftime(mode.strftime, tm, tz, !mode.local, zone);
    }
    default:
      return showDateNormal(time, tm, tz, human, mode.local, now);
  }
}
