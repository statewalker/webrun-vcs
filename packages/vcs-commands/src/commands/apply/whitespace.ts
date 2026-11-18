/**
 * git's whitespace rules (`ws.c`): the `core.whitespace` / `whitespace` attribute rules, the
 * check `git apply` and `git diff --check` run on added lines, and the fix
 * `--whitespace=fix` applies.
 *
 * Lines are "binary strings": one character per byte (latin1), so a line's length is its
 * byte count and any encoding passes through unchanged.
 *
 * @example
 * ```typescript
 * const rule = parseWhitespaceRule("trailing-space,-space-before-tab");
 * wsCheck("x \n", rule); // WS_BLANK_AT_EOL
 * wsFixCopy("x \n", rule).text; // "x\n"
 * ```
 */

export const WS_BLANK_AT_EOL = 1 << 6;
export const WS_SPACE_BEFORE_TAB = 1 << 7;
export const WS_INDENT_WITH_NON_TAB = 1 << 8;
export const WS_CR_AT_EOL = 1 << 9;
export const WS_BLANK_AT_EOF = 1 << 10;
export const WS_TAB_IN_INDENT = 1 << 11;
export const WS_INCOMPLETE_LINE = 1 << 12;
export const WS_TRAILING_SPACE = WS_BLANK_AT_EOL | WS_BLANK_AT_EOF;
export const WS_DEFAULT_RULE = WS_TRAILING_SPACE | WS_SPACE_BEFORE_TAB | 8;
export const WS_TAB_WIDTH_MASK = (1 << 6) - 1;

/** The tab width a rule carries (`ws_tab_width`). */
export function wsTabWidth(rule: number): number {
  return rule & WS_TAB_WIDTH_MASK;
}

const RULE_NAMES: { name: string; bits: number; loosens: boolean; excludeDefault: boolean }[] = [
  { name: "trailing-space", bits: WS_TRAILING_SPACE, loosens: false, excludeDefault: false },
  { name: "space-before-tab", bits: WS_SPACE_BEFORE_TAB, loosens: false, excludeDefault: false },
  {
    name: "indent-with-non-tab",
    bits: WS_INDENT_WITH_NON_TAB,
    loosens: false,
    excludeDefault: false,
  },
  { name: "cr-at-eol", bits: WS_CR_AT_EOL, loosens: true, excludeDefault: false },
  { name: "blank-at-eol", bits: WS_BLANK_AT_EOL, loosens: false, excludeDefault: false },
  { name: "blank-at-eof", bits: WS_BLANK_AT_EOF, loosens: false, excludeDefault: false },
  { name: "tab-in-indent", bits: WS_TAB_IN_INDENT, loosens: false, excludeDefault: true },
  { name: "incomplete-line", bits: WS_INCOMPLETE_LINE, loosens: false, excludeDefault: false },
];

/** git's `isspace`: space, tab, LF and CR only (not VT or FF). */
export function isGitSpace(ch: number): boolean {
  return ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d;
}

/** An invalid rule combination (git dies). */
export class WhitespaceRuleError extends Error {}

/**
 * Parses a `core.whitespace` value (or a `whitespace=<rules>` attribute) as
 * `parse_whitespace_rule` does: comma-separated names, `-name` to turn one off,
 * `tabwidth=<n>`.
 */
export function parseWhitespaceRule(value: string, warn?: (message: string) => void): number {
  let rule = WS_DEFAULT_RULE;
  let at = 0;
  while (at <= value.length) {
    while (at < value.length && ", \t\n\r".includes(value[at] as string)) at++;
    let ep = value.indexOf(",", at);
    if (ep < 0) ep = value.length;
    let start = at;
    let len = ep - start;
    let negated = false;
    if (value[start] === "-") {
      negated = true;
      start++;
      len--;
    }
    if (len <= 0) break;
    const word = value.slice(start, start + len);
    for (const r of RULE_NAMES) {
      // strncmp(rule_name, string, len): a prefix of a name selects it
      if (r.name.slice(0, len) !== word || (len > r.name.length && word !== r.name)) continue;
      if (negated) rule &= ~r.bits;
      else rule |= r.bits;
      break;
    }
    if (value.startsWith("tabwidth=", start)) {
      const arg = value.slice(start + 9, ep);
      const tabwidth = Number.parseInt(arg, 10) || 0;
      if (tabwidth > 0 && tabwidth < 0o100) {
        rule &= ~WS_TAB_WIDTH_MASK;
        rule |= tabwidth;
      } else {
        warn?.(`tabwidth ${arg} out of range`);
      }
    }
    if (ep >= value.length) break;
    at = ep;
  }
  if (rule & WS_TAB_IN_INDENT && rule & WS_INDENT_WITH_NON_TAB) {
    throw new WhitespaceRuleError("cannot enforce both tab-in-indent and indent-with-non-tab");
  }
  return rule;
}

/**
 * The rule for one path (`whitespace_rule`): from its `whitespace` attribute (true, false,
 * unset or a rule list), `configRule` (`core.whitespace`) by default.
 */
export function whitespaceRuleOf(
  attribute: boolean | string | undefined,
  configRule: number,
): number {
  if (attribute === true) {
    let all = wsTabWidth(configRule);
    for (const r of RULE_NAMES) if (!r.loosens && !r.excludeDefault) all |= r.bits;
    return all;
  }
  if (attribute === false) return wsTabWidth(configRule);
  if (attribute === undefined) return configRule;
  return parseWhitespaceRule(attribute);
}

/** The message naming the errors in `ws` (`whitespace_error_string`). */
export function whitespaceErrorString(ws: number): string {
  const parts: string[] = [];
  if ((ws & WS_TRAILING_SPACE) === WS_TRAILING_SPACE) parts.push("trailing whitespace");
  else {
    if (ws & WS_BLANK_AT_EOL) parts.push("trailing whitespace");
    if (ws & WS_BLANK_AT_EOF) parts.push("new blank line at EOF");
  }
  if (ws & WS_SPACE_BEFORE_TAB) parts.push("space before tab in indent");
  if (ws & WS_INDENT_WITH_NON_TAB) parts.push("indent with spaces");
  if (ws & WS_TAB_IN_INDENT) parts.push("tab in indent");
  if (ws & WS_INCOMPLETE_LINE) parts.push("no newline at the end of file");
  return parts.join(", ");
}

/** The whitespace errors of one line (with or without its LF), as `ws_check` finds them. */
export function wsCheck(line: string, rule: number): number {
  let result = 0;
  let len = line.length;
  let trailingNewline = false;
  if (len > 0 && line.charCodeAt(len - 1) === 0x0a) {
    trailingNewline = true;
    len--;
  }
  if (rule & WS_CR_AT_EOL && len > 0 && line.charCodeAt(len - 1) === 0x0d) len--;
  let trailing = -1;
  if (rule & WS_BLANK_AT_EOL) {
    for (let i = len - 1; i >= 0; i--) {
      if (isGitSpace(line.charCodeAt(i))) {
        trailing = i;
        result |= WS_BLANK_AT_EOL;
      } else break;
    }
  }
  if (trailing === -1) trailing = len;
  if (!trailingNewline && rule & WS_INCOMPLETE_LINE) result |= WS_INCOMPLETE_LINE;
  let written = 0;
  let i = 0;
  for (; i < trailing; i++) {
    const ch = line.charCodeAt(i);
    if (ch === 0x20) continue;
    if (ch !== 0x09) break;
    if (rule & WS_SPACE_BEFORE_TAB && written < i) result |= WS_SPACE_BEFORE_TAB;
    else if (rule & WS_TAB_IN_INDENT) result |= WS_TAB_IN_INDENT;
    written = i + 1;
  }
  if (rule & WS_INDENT_WITH_NON_TAB && i - written >= wsTabWidth(rule)) {
    result |= WS_INDENT_WITH_NON_TAB;
  }
  return result;
}

/** Whether a line holds whitespace only (`ws_blank_line`). */
export function wsBlankLine(line: string, start = 0, end = line.length): boolean {
  for (let i = start; i < end; i++) if (!isGitSpace(line.charCodeAt(i))) return false;
  return true;
}

/**
 * The line with its whitespace errors fixed (`ws_fix_copy`); `fixed` tells whether anything
 * changed.
 */
export function wsFixCopy(src: string, rule: number): { text: string; fixed: boolean } {
  let len = src.length;
  let start = 0;
  let addNl = false;
  let addCr = false;
  let fixed = false;
  let lastTab = -1;
  let lastSpace = -1;
  let needFix = false;
  if (rule & WS_INCOMPLETE_LINE && len > 0 && src.charCodeAt(len - 1) !== 0x0a) {
    fixed = true;
    addNl = true;
  }
  if (rule & WS_BLANK_AT_EOL) {
    if (len > 0 && src.charCodeAt(len - 1) === 0x0a) {
      addNl = true;
      len--;
      if (len > 0 && src.charCodeAt(len - 1) === 0x0d) {
        addCr = (rule & WS_CR_AT_EOL) !== 0;
        len--;
      }
    }
    if (len > 0 && isGitSpace(src.charCodeAt(len - 1))) {
      while (len > 0 && isGitSpace(src.charCodeAt(len - 1))) len--;
      fixed = true;
    }
  }
  for (let i = 0; i < len; i++) {
    const ch = src.charCodeAt(i);
    if (ch === 0x09) {
      lastTab = i;
      if (rule & WS_SPACE_BEFORE_TAB && lastSpace >= 0) needFix = true;
    } else if (ch === 0x20) {
      lastSpace = i;
      if (rule & WS_INDENT_WITH_NON_TAB && wsTabWidth(rule) <= i - lastTab) needFix = true;
    } else break;
  }
  let out = "";
  const width = wsTabWidth(rule);
  if (needFix) {
    let consecutive = 0;
    let last = lastTab + 1;
    if (rule & WS_INDENT_WITH_NON_TAB) last = lastTab < lastSpace ? lastSpace + 1 : lastTab + 1;
    for (let i = 0; i < last; i++) {
      const ch = src[i] as string;
      if (ch !== " ") {
        consecutive = 0;
        out += ch;
      } else {
        consecutive++;
        if (consecutive === width) {
          out += "\t";
          consecutive = 0;
        }
      }
    }
    while (consecutive-- > 0) out += " ";
    start = last;
    fixed = true;
  } else if (rule & WS_TAB_IN_INDENT && lastTab >= 0) {
    const last = lastTab + 1;
    for (let i = 0; i < last; i++) {
      if (src[i] === "\t") {
        do {
          out += " ";
        } while (out.length % width);
      } else out += src[i];
    }
    start = last;
    fixed = true;
  }
  out += src.slice(start, len);
  if (addCr) out += "\r";
  if (addNl) out += "\n";
  return { text: out, fixed };
}
