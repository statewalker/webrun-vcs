/**
 * git's boolean config values (`git_config_bool`, through `git_parse_maybe_bool`).
 *
 * @example
 * ```typescript
 * parseGitBool(true); // true: `[core] bare` (a key with no `=`)
 * parseGitBool(""); // false: `[core] bare =` (an empty value)
 * parseGitBool("Yes"); // true
 * parseGitBool("0x10"); // true: an integer, read as strtoimax with base 0
 * parseGitBool("0k"); // false
 * parseGitBool(" true"); // undefined: git refuses it ("bad boolean config value")
 * ```
 *
 * A key written without `=` has no value at all, which git reads as true; the config
 * readers here hand it over as the boolean `true`. A key written as `key =` has the empty
 * string as its value, which git reads as false. The spellings `true`/`yes`/`on` and
 * `false`/`no`/`off` match in any case; anything else must be an integer as `git_parse_int`
 * reads it (leading whitespace, a sign, decimal, `0x` hex or `0` octal digits, an optional
 * `k`/`m`/`g` unit), true when it is not zero.
 *
 * @module
 */

const INTEGER = /^[ \t\n\v\f\r]*[+-]?(?:0[xX]([0-9a-fA-F]+)|([0-9]+))[kKmMgG]?$/;

/**
 * A git boolean config value (`git_parse_maybe_bool`): `true` for a key with no `=`
 * (passed as the boolean `true`), false for the empty string, the boolean spellings in any
 * case, an integer (non-zero is true); undefined when unset or not a boolean, which git
 * refuses.
 */
export function parseGitBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value !== 0 : undefined;
  const text = String(value);
  if (text === "") return false;
  const lower = text.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "on") return true;
  if (lower === "false" || lower === "no" || lower === "off") return false;
  const m = INTEGER.exec(text);
  if (!m) return undefined;
  const digits = m[1] ?? m[2];
  if (m[1] === undefined && digits.length > 1 && digits[0] === "0" && /[89]/.test(digits)) {
    return undefined; // not an octal number: strtoimax stops at the 8 or 9
  }
  return /[^0]/.test(digits);
}
