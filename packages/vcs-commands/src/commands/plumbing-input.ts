/**
 * The standard input of the plumbing commands that read paths or entries line by line
 * (`update-index --stdin`/`--index-info`, `checkout-index --stdin`): git's
 * `strbuf_getline_lf` / `strbuf_getline_nul` and `unquote_c_style`.
 */

import { decodeGitPath, encodeGitPath, unquoteGitPath } from "@statewalker/vcs-utils/encoding";

/** The lines of `input` (LF- or, with `nul`, NUL-separated; a last empty one dropped). */
export function inputLines(input: string | Uint8Array, nul: boolean): string[] {
  const text = typeof input === "string" ? input : decodeGitPath(input);
  const lines = text.split(nul ? "\0" : "\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * `unquote_c_style` of a line starting with `"` (what follows the closing quote ignored);
 * undefined when it is badly quoted.
 */
export function unquoteLine(line: string): string | undefined {
  return unquoteGitPath(encodeGitPath(line))?.path;
}

/**
 * `--stdin`'s paths: {@link inputLines}, each LF-separated line starting with `"`
 * unquoted; `badlyQuoted` is thrown for one that cannot be.
 */
export function inputPaths(
  input: string | Uint8Array,
  nul: boolean,
  badlyQuoted: () => never,
): string[] {
  const lines = inputLines(input, nul);
  if (nul) return lines;
  return lines.map((line) => (line.startsWith('"') ? (unquoteLine(line) ?? badlyQuoted()) : line));
}
