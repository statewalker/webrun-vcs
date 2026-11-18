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

/** A broken-down time (struct tm), from a UTC Date shifted into the zone. */
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

function tmOf(time: number, tzMinutes: number): Tm {
  const d = new Date((time + tzMinutes * 60) * 1000);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return {
    year: d.getUTCFullYear(),
    mon: d.getUTCMonth(),
    mday: d.getUTCDate(),
    hour: d.getUTCHours(),
    min: d.getUTCMinutes(),
    sec: d.getUTCSeconds(),
    wday: d.getUTCDay(),
    yday: Math.floor((d.getTime() - start) / 86400000),
  };
}

/** An offset `+HHMM` as minutes east of UTC (0 when malformed). */
function offsetMinutes(tz: string): number {
  if (!/^[+-]\d{4}$/.test(tz)) return 0;
  const sign = tz.startsWith("-") ? -1 : 1;
  return sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
}

/** Minutes as git's `%+05d` of the `HHMM` decimal form. */
function tzText(minutes: number): string {
  const abs = Math.abs(minutes);
  const value = Math.floor(abs / 60) * 100 + (abs % 60);
  return `${minutes < 0 ? "-" : "+"}${pad(value, 4)}`;
}

/** ISO 8601 week-based year and week (strftime's %G and %V). */
function isoWeek(tm: Tm): { year: number; week: number } {
  const wday = (tm.wday + 6) % 7; // Monday 0
  let year = tm.year;
  let week = Math.floor((tm.yday - wday + 10) / 7);
  const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (week < 1) {
    year--;
    const days = isLeap(year) ? 366 : 365;
    week = Math.floor((tm.yday + days - wday + 10) / 7);
  } else if (week === 53) {
    const days = isLeap(year) ? 366 : 365;
    if (tm.yday - wday + 3 >= days) {
      year++;
      week = 1;
    }
  }
  return { year, week };
}

/** strftime in the C locale, with git's handling of %z, %Z and %s (strbuf_addftime). */
function strftime(fmt: string, tm: Tm, time: number, tzMinutes: number, suppressTz: boolean) {
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c !== "%") {
      out += c;
      continue;
    }
    const f = fmt[++i];
    switch (f) {
      case undefined:
        out += "%";
        break;
      case "%":
        out += "%";
        break;
      case "a":
        out += (WEEKDAYS[tm.wday] as string).slice(0, 3);
        break;
      case "A":
        out += WEEKDAYS[tm.wday];
        break;
      case "b":
      case "h":
        out += (MONTHS[tm.mon] as string).slice(0, 3);
        break;
      case "B":
        out += MONTHS[tm.mon];
        break;
      case "c":
        out += `${strftime("%a %b %e %H:%M:%S %Y", tm, time, tzMinutes, suppressTz)}`;
        break;
      case "C":
        out += pad(Math.floor(tm.year / 100));
        break;
      case "d":
        out += pad(tm.mday);
        break;
      case "D":
      case "x":
        out += `${pad(tm.mon + 1)}/${pad(tm.mday)}/${pad(tm.year % 100)}`;
        break;
      case "e":
        out += pad(tm.mday, 2, " ");
        break;
      case "F":
        out += `${tm.year}-${pad(tm.mon + 1)}-${pad(tm.mday)}`;
        break;
      case "g":
        out += pad(isoWeek(tm).year % 100);
        break;
      case "G":
        out += String(isoWeek(tm).year);
        break;
      case "H":
        out += pad(tm.hour);
        break;
      case "I":
        out += pad(tm.hour % 12 || 12);
        break;
      case "j":
        out += pad(tm.yday + 1, 3);
        break;
      case "k":
        out += pad(tm.hour, 2, " ");
        break;
      case "l":
        out += pad(tm.hour % 12 || 12, 2, " ");
        break;
      case "m":
        out += pad(tm.mon + 1);
        break;
      case "M":
        out += pad(tm.min);
        break;
      case "n":
        out += "\n";
        break;
      case "p":
        out += tm.hour < 12 ? "AM" : "PM";
        break;
      case "P":
        out += tm.hour < 12 ? "am" : "pm";
        break;
      case "r":
        out += `${pad(tm.hour % 12 || 12)}:${pad(tm.min)}:${pad(tm.sec)} ${tm.hour < 12 ? "AM" : "PM"}`;
        break;
      case "R":
        out += `${pad(tm.hour)}:${pad(tm.min)}`;
        break;
      case "s":
        out += String(time);
        break;
      case "S":
        out += pad(tm.sec);
        break;
      case "t":
        out += "\t";
        break;
      case "T":
      case "X":
        out += `${pad(tm.hour)}:${pad(tm.min)}:${pad(tm.sec)}`;
        break;
      case "u":
        out += String(tm.wday || 7);
        break;
      case "U":
        out += pad(Math.floor((tm.yday + 7 - tm.wday) / 7));
        break;
      case "V":
        out += pad(isoWeek(tm).week);
        break;
      case "w":
        out += String(tm.wday);
        break;
      case "W":
        out += pad(Math.floor((tm.yday + 7 - ((tm.wday + 6) % 7)) / 7));
        break;
      case "y":
        out += pad(tm.year % 100);
        break;
      case "Y":
        out += String(tm.year);
        break;
      case "z":
        out += tzText(tzMinutes);
        break;
      case "Z":
        // the zone's name: none in a zone git only knows by its offset
        if (!suppressTz) out += tzMinutes === 0 ? "UTC" : "";
        break;
      default:
        out += `%${f}`;
    }
  }
  return out;
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
  hide.tz = local || (human !== undefined && tz === human.tz);
  hide.year = human !== undefined && tm.year === human.tm.year;
  if (hide.year && human && tm.mon === human.tm.mon) {
    if (tm.mday > human.tm.mday) {
      // a future date: think time zones
    } else if (tm.mday === human.tm.mday) {
      hide.date = hide.wday = true;
    } else if (tm.mday + 5 > human.tm.mday) {
      hide.date = true;
    }
  }
  if (hide.wday) return relativeDate(time, now);
  if (human) {
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
 * date.c's show_date: `time` (seconds) in its zone `tzOffset` (`+HHMM`) as the mode shows
 * it.
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
  let tz = offsetMinutes(tzOffset);
  let human: { tm: Tm; tz: number } | undefined;
  if (mode.type === "human") {
    const humanTz = localTz(now);
    human = { tm: tmOf(now, humanTz), tz: humanTz };
  }
  if (mode.local) tz = localTz(time);
  if (mode.type === "raw") return `${time} ${tzText(tz)}`;
  if (mode.type === "relative") return relativeDate(time, now);
  const tm = tmOf(time, tz);
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
        out += `${tz >= 0 ? "+" : "-"}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
      }
      return out;
    }
    case "rfc2822":
      return (
        `${(WEEKDAYS[tm.wday] as string).slice(0, 3)}, ${tm.mday} ` +
        `${(MONTHS[tm.mon] as string).slice(0, 3)} ${tm.year} ` +
        `${pad(tm.hour)}:${pad(tm.min)}:${pad(tm.sec)} ${tzText(tz)}`
      );
    case "strftime":
      return mode.strftime ? strftime(mode.strftime, tm, time, tz, !mode.local) : "";
    default:
      return showDateNormal(time, tm, tz, human, mode.local, now);
  }
}
