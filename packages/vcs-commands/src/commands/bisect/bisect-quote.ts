/**
 * git's shell quoting of `quote.c`, as `git bisect` writes it to `BISECT_LOG` and
 * `BISECT_NAMES` and reads it back.
 *
 * @example
 * ```typescript
 * sqQuoteArgv(["main", "it's"]); // " 'main' 'it'\''s'"
 * sqDequoteToArgv("'main' 'it'\\''s'"); // ["main", "it's"]
 * ```
 */

/** quote.c's need_bs_quote: the characters a single-quoted string leaves for a backslash. */
const needBsQuote = (c: string | undefined) => c === "'" || c === "!";

/** git's sq_quote_buf: `'...'`, each `'` and `!` as `'\''` and `'\!'`. */
export function sqQuote(value: string): string {
  let out = "'";
  for (const c of value) out += needBsQuote(c) ? `'\\${c}'` : c;
  return `${out}'`;
}

/** git's sq_quote_argv: each argument after a space, quoted. */
export function sqQuoteArgv(argv: readonly string[]): string {
  return argv.map((arg) => ` ${sqQuote(arg)}`).join("");
}

/** git's isspace (sane_ctype's GIT_SPACE): space, tab, LF and CR; not VT or FF. */
const isSpace = (c: string | undefined) => c === " " || c === "\t" || c === "\n" || c === "\r";

/** git's strbuf_rtrim: the trailing spaces (git's isspace) removed. */
export function strbufRtrim(text: string): string {
  let end = text.length;
  while (end > 0 && isSpace(text[end - 1])) end--;
  return text.slice(0, end);
}

/** git's strbuf_trim: the leading and trailing spaces (git's isspace) removed. */
export function strbufTrim(text: string): string {
  let start = 0;
  while (start < text.length && isSpace(text[start])) start++;
  return strbufRtrim(text.slice(start));
}

/**
 * git's sq_dequote_to_strvec: the words of a line of single-quoted words. `ok` is false
 * where git's reading fails (badly quoted), `argv` holding the words read before.
 */
export function sqDequoteToArgv(text: string): { argv: string[]; ok: boolean } {
  const argv: string[] = [];
  if (text.length === 0) return { argv, ok: true };
  let i = 0;
  for (;;) {
    // sq_dequote_step
    if (text[i] !== "'") return { argv, ok: false };
    let word = "";
    let next: number | undefined;
    for (;;) {
      i++;
      const c = text[i];
      if (c === undefined) return { argv, ok: false };
      if (c !== "'") {
        word += c;
        continue;
      }
      i++;
      const after = text[i];
      if (after === undefined) {
        next = undefined;
        break;
      }
      if (after === "\\" && needBsQuote(text[i + 1]) && text[i + 2] === "'") {
        word += text[i + 1];
        i += 2;
        continue;
      }
      next = i;
      break;
    }
    argv.push(word);
    if (next === undefined) return { argv, ok: true };
    i = next;
    if (!isSpace(text[i])) {
      argv.pop();
      return { argv, ok: false };
    }
    while (isSpace(text[i])) i++;
    if (i >= text.length) {
      // git reads past the spaces into the terminating NUL: no quote there
      return { argv, ok: false };
    }
  }
}
