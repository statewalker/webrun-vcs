/**
 * The quoting styles of `for-each-ref --shell/--perl/--python/--tcl` (quote.c's
 * `sq_quote_buf`, `perl_quote_buf`, `python_quote_buf`, `tcl_quote_buf`).
 *
 * @example
 * ```typescript
 * quoteRefValue("it's", "shell"); // "'it'\\''s'"
 * quoteRefValue("a\nb", "python"); // "'a\\nb'"
 * ```
 *
 * @module
 */

/** How `for-each-ref` quotes each atom's value. */
export type RefQuoteStyle = "none" | "shell" | "perl" | "python" | "tcl";

/**
 * `value` quoted in `style`. C strings end at a NUL, so every style but `perl` with a
 * known length (`sized`, git's `perl_quote_buf_with_len` for `%(raw)`) stops there.
 */
export function quoteRefValue(value: string, style: RefQuoteStyle, sized = false): string {
  const nul = value.indexOf("\0");
  const text =
    nul >= 0 && !(sized && (style === "perl" || style === "none")) ? value.slice(0, nul) : value;
  switch (style) {
    case "none":
      return text;
    case "shell":
      return `'${text.replace(/['!]/g, (c) => `'\\${c}'`)}'`;
    case "perl":
      return `'${text.replace(/['\\]/g, (c) => `\\${c}`)}'`;
    case "python":
      return `'${text.replace(/['\\\n]/g, (c) => (c === "\n" ? "\\n" : `\\${c}`))}'`;
    case "tcl": {
      let out = '"';
      for (const c of text) {
        switch (c) {
          case "[":
          case "]":
          case "{":
          case "}":
          case "$":
          case "\\":
          case '"':
            out += `\\${c}`;
            break;
          case "\f":
            out += "\\f";
            break;
          case "\r":
            out += "\\r";
            break;
          case "\n":
            out += "\\n";
            break;
          case "\t":
            out += "\\t";
            break;
          case "\v":
            out += "\\v";
            break;
          default:
            out += c;
        }
      }
      return `${out}"`;
    }
  }
}
