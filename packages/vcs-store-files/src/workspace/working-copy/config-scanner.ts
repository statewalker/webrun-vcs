/**
 * git's config parser primitives (config.c's `get_next_char`, `get_base_var`, `parse_value`,
 * `section_name_match`), shared by the config reader and writer
 * ({@link GitWorkingCopyConfig}) and the file editor of `git config` (`config-file-edit.ts`).
 */

/** C's `isalnum` or `-`: git's `iskeychar`. */
export const isAsciiKeyChar = (c: string) =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "-";

/**
 * git's `section_name_match`: where a header line naming the section `name`
 * (`branch.feat`) ends, the whitespace after it included, or 0 when it names another one.
 * The header is matched as written, case and all (`[Branch "feat"]` is not `branch.feat`).
 */
export function headerNames(text: string, name: string): number {
  const isSpace = isConfigSpace;
  let i = 0;
  while (isSpace(text[i])) i++;
  if (text[i] !== "[") return 0;
  let j = 0;
  let dot = false;
  for (i++; i < text.length && text[i] !== "]"; i++) {
    if (!dot && isSpace(text[i])) {
      dot = true;
      if (name[j++] !== ".") break;
      for (i++; isSpace(text[i]); i++);
      if (text[i] !== '"') break;
      continue;
    }
    if (text[i] === "\\" && dot) i++;
    else if (text[i] === '"' && dot) {
      for (i++; isSpace(text[i]); i++);
      break;
    }
    if (text[i] !== name[j++]) break;
  }
  if (text[i] === "]" && j === name.length) {
    for (i++; isSpace(text[i]); i++);
    return i;
  }
  return 0;
}

/** git's `isspace` (`sane_ctype`): space, tab, newline and carriage return, not `\v` or `\f` */
export const isConfigSpace = (c: string | undefined) =>
  c === " " || c === "\t" || c === "\n" || c === "\r";
export const isAlpha = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
/** git's `iskeychar`: alphanumeric or `-` */
export const isKeyChar = (c: string) => isAlpha(c) || (c >= "0" && c <= "9") || c === "-";

/** git's `config_source` reading a string: `get_next_char` with its line counter. */
export class ConfigCursor {
  private pos = 0;
  /** git's `linenr`: from 1, one more for each newline read and for each read at the end */
  linenr = 1;
  /** The physical line (from 0) of the next character */
  physical = 0;
  /** The physical line of the character read last */
  last = 0;
  eof = false;

  constructor(private readonly text: string) {}

  /** git's `ftell`: the offset of the next character (both characters of a `\r\n` read) */
  get offset(): number {
    return this.pos;
  }

  next(): string {
    if (this.pos >= this.text.length) {
      this.eof = true;
      this.linenr++;
      this.last = this.physical;
      return "\n";
    }
    let c = this.text[this.pos++];
    // DOS line ends: `\r\n` reads as `\n`, a lone `\r` as itself
    if (c === "\r" && this.text[this.pos] === "\n") {
      this.pos++;
      c = "\n";
    }
    this.last = this.physical;
    if (c === "\n") {
      this.linenr++;
      this.physical++;
    }
    return c;
  }
}

/**
 * git's `get_base_var` / `get_extended_base_var` after the `[`: `section`, `section.sub`
 * (lower-cased) or `section "sub"` (the subsection's case kept, a backslash escaping the
 * next character, `"]` closing it); undefined where git refuses it.
 */
export function readSectionHeader(
  cs: ConfigCursor,
  state?: SectionHeaderState,
): string | undefined {
  const st = state ?? { name: "", extended: false };
  st.name = "";
  st.extended = false;
  for (;;) {
    let c = cs.next();
    if (cs.eof) return undefined;
    if (c === "]") return st.name;
    if (isConfigSpace(c)) {
      st.extended = true;
      do {
        if (c === "\n") {
          cs.linenr--;
          return undefined;
        }
        c = cs.next();
      } while (isConfigSpace(c));
      if (c !== '"') return undefined;
      st.name += ".";
      for (;;) {
        let s = cs.next();
        if (s === "\n") {
          cs.linenr--;
          return undefined;
        }
        if (s === '"') break;
        if (s === "\\") {
          s = cs.next();
          if (s === "\n") {
            cs.linenr--;
            return undefined;
          }
        }
        st.name += s;
      }
      return cs.next() === "]" ? st.name : undefined;
    }
    if (!isKeyChar(c) && c !== ".") return undefined;
    st.name += c.toLowerCase();
  }
}

/**
 * What {@link readSectionHeader} read, also when it refused the header: the name so far (git's
 * `cs->var`, which names the section in `invalid section name '<name>'`), and whether the
 * header is of the `[section "sub"]` form (git's `subsection_case_sensitive` cleared).
 */
export interface SectionHeaderState {
  name: string;
  extended: boolean;
}

/**
 * git's `parse_value`, after the `=`: blanks around the value dropped, `"..."` keeping them
 * (and `#`, `;`), `\n` `\t` `\b` `\"` `\\` unescaped, a backslash at the end of a line
 * joining the next one, an unquoted `#` or `;` starting a comment; undefined (git refuses
 * the line) for another escape or a quote still open at the end of the line.
 */
export function readConfigValue(cs: ConfigCursor): string | undefined {
  let quote = false;
  let comment = false;
  let trimLength = 0;
  let value = "";
  for (;;) {
    let c = cs.next();
    if (c === "\n") {
      if (quote) {
        cs.linenr--;
        return undefined;
      }
      return trimLength ? value.slice(0, trimLength) : value;
    }
    if (comment) continue;
    if (isConfigSpace(c) && !quote) {
      if (!trimLength) trimLength = value.length;
      if (value.length) value += c;
      continue;
    }
    if (!quote && (c === ";" || c === "#")) {
      comment = true;
      continue;
    }
    trimLength = 0;
    if (c === "\\") {
      c = cs.next();
      switch (c) {
        case "\n":
          continue;
        case "t":
          c = "\t";
          break;
        case "b":
          c = "\b";
          break;
        case "n":
          c = "\n";
          break;
        case "\\":
        case '"':
          break;
        default:
          return undefined;
      }
      value += c;
      continue;
    }
    if (c === '"') {
      quote = !quote;
      continue;
    }
    value += c;
  }
}
