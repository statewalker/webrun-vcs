/**
 * `git config --type=<type>` (builtin/config.c `format_config`, `normalize_value`): a config
 * value canonicalised as git prints it on `get` and writes it on `set`.
 *
 * ```typescript
 * await formatConfigValue("int", "pack.window", "1k", source, context); // { ok: "1024" }
 * await formatConfigValue("bool", "core.bare", "yes", source, context); // { ok: "true" }
 * await formatConfigValue("color", "color.diff.old", "red", source, context); // { ok: "\x1b[31m" }
 * normalizeConfigValue("bool-or-int", "x.y", "on"); // "true"
 * ```
 *
 * Where git dies (`bad numeric config value`, `bad boolean config value`) a
 * {@link ConfigValueDeath} is thrown carrying git's lines; where git's formatter returns an
 * error after printing its `error:` line (a path without a value, a date or color it cannot
 * parse), the result is `{ error: [lines] }`; `{ skip: true }` is a value git treats as absent
 * (`:(optional)` naming a missing file, 2.5x). The gentle mode (`git config list --type`,
 * 2.5x) drops values that do not canonicalise without a word, except git's `error:` lines
 * for a path without a value.
 *
 * @module
 */

import { approxidateCareful } from "@statewalker/vcs-utils";
import { parseColorSpec } from "./pretty-format.js";

/** git's `--type` values (`--bool`, `--int`, ... are the same types). */
export type ConfigValueType =
  | "bool"
  | "int"
  | "bool-or-int"
  | "bool-or-str"
  | "path"
  | "expiry-date"
  | "color";

/** The types `--type=<type>` names. */
export const CONFIG_VALUE_TYPES: readonly ConfigValueType[] = [
  "bool",
  "int",
  "bool-or-int",
  "bool-or-str",
  "path",
  "expiry-date",
  "color",
];

/** Where a value was read (git's `key_value_info`), for git's messages. */
export interface ConfigValueSource {
  /** git's origin type: a file, a blob, the command line (`-c`, `--default`) */
  origin: "file" | "blob" | "command line" | "standard input" | "";
  /** The file or blob as git names it; empty for the command line */
  name: string;
}

/** What a value needs from its surroundings. */
export interface ConfigValueContext {
  /** git's version where the types differ (`:(optional)`, `#rgb` colors: 2.5x) */
  compatibility: "2.43" | "2.56";
  /** `$HOME` for `~/` (undefined: git's "failed to expand user dir") */
  home: string | undefined;
  /** `~user`'s home directory, when the host can tell */
  userHome?: (name: string) => Promise<string | undefined>;
  /** Whether a path names nothing (git's `is_missing_file`), for `:(optional)` */
  isMissing?: (path: string) => Promise<boolean>;
  /** The current time in seconds, for relative expiry dates */
  now: number;
}

/** git died: its exit status 128 and its lines. */
export class ConfigValueDeath extends Error {
  readonly exitCode = 128;
  constructor(readonly lines: string[]) {
    super(lines.join("\n"));
    this.name = "ConfigValueDeath";
  }
}

/** A value as git formats it. */
export type FormattedConfigValue = { ok: string } | { skip: true } | { error: string[] };

const INT64_MAX = (1n << 63n) - 1n;
const INT_MAX = 2147483647n;

/**
 * git's `git_parse_signed`: strtoimax (leading whitespace, sign, base 0) and a `k`/`m`/`g`
 * unit; the reason git refuses a value otherwise (errno: `invalid unit` or `out of range`).
 */
export function parseGitSigned(
  value: string | undefined,
  max: bigint = INT64_MAX,
): { value: bigint } | { reason: "invalid unit" | "out of range" } {
  if (value === undefined || value === "") return { reason: "invalid unit" };
  const m = /^[ \t\n\v\f\r]*([+-]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)/.exec(value);
  if (!m) return { reason: "invalid unit" };
  const negative = m[1] === "-";
  const digits = m[2] as string;
  const magnitude =
    digits.length > 1 && (digits[1] === "x" || digits[1] === "X")
      ? BigInt(digits)
      : digits.length > 1 && digits[0] === "0"
        ? BigInt(`0o${digits.slice(1)}`)
        : BigInt(digits);
  let val = negative ? -magnitude : magnitude;
  // strtoimax: ERANGE beyond intmax_t
  if (val > INT64_MAX || val < -INT64_MAX - 1n) return { reason: "out of range" };
  const unit = value.slice(m[0].length).toLowerCase();
  const factor =
    unit === ""
      ? 1n
      : unit === "k"
        ? 1024n
        : unit === "m"
          ? 1n << 20n
          : unit === "g"
            ? 1n << 30n
            : 0n;
  if (factor === 0n) return { reason: "invalid unit" };
  if ((val < 0n && (-max - 1n) / factor > val) || (val > 0n && max / factor < val)) {
    return { reason: "out of range" };
  }
  val *= factor;
  return { value: val };
}

/** git's `git_parse_maybe_bool_text`: 1, 0, or -1 for no boolean spelling. */
function maybeBoolText(value: string | undefined): number {
  if (value === undefined) return 1;
  if (value === "") return 0;
  const lower = value.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "on") return 1;
  if (lower === "false" || lower === "no" || lower === "off") return 0;
  return -1;
}

/** git's `git_parse_maybe_bool`: the text spellings, else an `int`; -1 when neither. */
export function gitParseMaybeBool(value: string | undefined): number {
  const v = maybeBoolText(value);
  if (v >= 0) return v;
  const n = parseGitSigned(value, INT_MAX);
  return "value" in n ? (n.value !== 0n ? 1 : 0) : -1;
}

/** git's `die_bad_number` lines for a value of `source`. */
function badNumber(
  key: string,
  value: string | undefined,
  reason: string,
  source: ConfigValueSource,
): ConfigValueDeath {
  const v = value ?? "";
  if (!source.name) {
    return new ConfigValueDeath([`fatal: bad numeric config value '${v}' for '${key}': ${reason}`]);
  }
  const where =
    source.origin === "blob"
      ? `in blob ${source.name}`
      : source.origin === "file"
        ? `in file ${source.name}`
        : source.origin === "standard input"
          ? "in standard input"
          : source.origin === "command line"
            ? `in command line ${source.name}`
            : `in ${source.name}`;
  return new ConfigValueDeath([
    `fatal: bad numeric config value '${v}' for '${key}' ${where}: ${reason}`,
  ]);
}

/** git's `git_config_bool`: true/false, or git's death. */
export function gitConfigBool(key: string, value: string | undefined): boolean {
  const v = gitParseMaybeBool(value);
  if (v < 0) {
    throw new ConfigValueDeath([`fatal: bad boolean config value '${value}' for '${key}'`]);
  }
  return v === 1;
}

/** git's `git_config_int` (32 bits) / `git_config_int64`, or git's death. */
function configInt(
  key: string,
  value: string | undefined,
  source: ConfigValueSource,
  max: bigint,
): bigint {
  const parsed = parseGitSigned(value, max);
  if ("reason" in parsed) throw badNumber(key, value, parsed.reason, source);
  return parsed.value;
}

/** color.c's `color_parse`: the escape sequence, undefined when git cannot parse it. */
export function parseGitColor(
  value: string,
  compatibility: "2.43" | "2.56" = "2.56",
): string | undefined {
  // 2.43 has no 12-bit `#rgb`
  if (
    compatibility === "2.43" &&
    value.split(/[ \t\n\v\f\r]+/).some((w) => /^#[0-9a-fA-F]{3}$/.test(w))
  ) {
    return undefined;
  }
  try {
    return parseColorSpec(value);
  } catch {
    return undefined;
  }
}

/** git's `interpolate_path` (without `%(prefix)/`); undefined when `~` cannot be expanded. */
async function interpolatePath(
  value: string,
  context: ConfigValueContext,
): Promise<string | undefined> {
  if (!value.startsWith("~")) return value;
  const slash = value.indexOf("/");
  const end = slash < 0 ? value.length : slash;
  const user = value.slice(1, end);
  const home = user === "" ? context.home : await context.userHome?.(user);
  if (home === undefined) return undefined;
  return home + value.slice(end);
}

/** git's `missing value for '<key>'` (config_error_nonbool). */
const nonBool = (key: string) => ({ error: [`error: missing value for '${key}'`] });

/**
 * builtin/config.c's `format_config` of one value (without the key, origin and scope git
 * prints before it). `gently` is 2.5x's `list --type`.
 *
 * @throws ConfigValueDeath where git dies
 */
export async function formatConfigValue(
  type: ConfigValueType,
  key: string,
  value: string | undefined,
  source: ConfigValueSource,
  context: ConfigValueContext,
  gently = false,
): Promise<FormattedConfigValue> {
  switch (type) {
    case "int": {
      if (gently) {
        const parsed = parseGitSigned(value);
        return "value" in parsed ? { ok: parsed.value.toString() } : { error: [] };
      }
      return { ok: configInt(key, value ?? "", source, INT64_MAX).toString() };
    }
    case "bool": {
      if (gently) {
        const v = gitParseMaybeBool(value);
        return v < 0 ? { error: [] } : { ok: v ? "true" : "false" };
      }
      return { ok: gitConfigBool(key, value) ? "true" : "false" };
    }
    case "bool-or-int": {
      const b = maybeBoolText(value);
      if (b >= 0) return { ok: b ? "true" : "false" };
      if (gently) {
        const parsed = parseGitSigned(value, INT_MAX);
        return "value" in parsed ? { ok: parsed.value.toString() } : { error: [] };
      }
      return { ok: configInt(key, value, source, INT_MAX).toString() };
    }
    case "bool-or-str": {
      const v = gitParseMaybeBool(value);
      return { ok: v < 0 ? (value ?? "") : v ? "true" : "false" };
    }
    case "path": {
      if (value === undefined) return nonBool(key);
      let text = value;
      const optional = context.compatibility !== "2.43" && text.startsWith(":(optional)");
      if (optional) text = text.slice(":(optional)".length);
      const path = await interpolatePath(text, context);
      if (path === undefined) {
        throw new ConfigValueDeath([`fatal: failed to expand user dir in: '${text}'`]);
      }
      if (optional && (await context.isMissing?.(path)))
        return gently ? { error: [] } : { skip: true };
      return { ok: path };
    }
    case "expiry-date": {
      if (value === undefined) return gently ? { error: [] } : nonBool(key);
      if (value === "never" || value === "false") return { ok: "0" };
      if (value === "all" || value === "now") return { ok: "18446744073709551615" };
      const parsed = approxidateCareful(value, context.now);
      if (parsed.error) {
        return gently
          ? { error: [] }
          : { error: [`error: '${value}' for '${key}' is not a valid timestamp`] };
      }
      return { ok: String(parsed.timestamp) };
    }
    case "color": {
      if (value === undefined) return gently ? { error: [] } : nonBool(key);
      const color = parseGitColor(value, context.compatibility);
      if (color === undefined) {
        return gently ? { error: [] } : { error: [`error: invalid color value: ${value}`] };
      }
      return { ok: color };
    }
  }
}

/**
 * builtin/config.c's `normalize_value`: the value `set` writes under `--type` (paths and
 * dates as given; a color checked but written as given).
 *
 * @throws ConfigValueDeath where git dies
 */
export function normalizeConfigValue(
  type: ConfigValueType | undefined,
  key: string,
  value: string,
  compatibility: "2.43" | "2.56" = "2.56",
): string {
  const param: ConfigValueSource = { origin: "", name: "" };
  switch (type) {
    case undefined:
    case "path":
    case "expiry-date":
      return value;
    case "int":
      return configInt(key, value, param, INT64_MAX).toString();
    case "bool":
      return gitConfigBool(key, value) ? "true" : "false";
    case "bool-or-int": {
      const b = maybeBoolText(value);
      if (b >= 0) return b ? "true" : "false";
      return configInt(key, value, param, INT_MAX).toString();
    }
    case "bool-or-str": {
      const v = gitParseMaybeBool(value);
      return v < 0 ? value : v ? "true" : "false";
    }
    case "color":
      if (parseGitColor(value, compatibility) === undefined) {
        throw new ConfigValueDeath([
          `error: invalid color value: ${value}`,
          `fatal: cannot parse color '${value}'`,
        ]);
      }
      return value;
  }
}

/** color.c's `git_config_colorbool`: never, always, auto, or (from a boolean) never/auto. */
export function gitConfigColorBool(
  key: string,
  value: string | undefined,
): "never" | "always" | "auto" {
  if (value !== undefined) {
    const lower = value.toLowerCase();
    if (lower === "never") return "never";
    if (lower === "always") return "always";
    if (lower === "auto") return "auto";
  }
  return gitConfigBool(key, value) ? "auto" : "never";
}
