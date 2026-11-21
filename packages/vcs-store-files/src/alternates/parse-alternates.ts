/**
 * git's `parse_alternates` (odb.c; `link_alt_odb_entries` in 2.43): the entries of an
 * `objects/info/alternates` file (separated by `\n`) or of `$GIT_ALTERNATE_OBJECT_DIRECTORIES`
 * (separated by `:`).
 *
 * @example
 * ```typescript
 * parseAlternates('# shared\n../../other/.git/objects\n"/srv/a\\tb/objects"\n', "\n");
 * // ["../../other/.git/objects", "/srv/a\tb/objects"]
 * parseAlternates("/a/objects:/b/objects", ":"); // ["/a/objects", "/b/objects"]
 * ```
 *
 * An entry starting with `#` is a comment up to the next separator; one starting with `"` is a
 * C-quoted path (`unquote_c_style`), after whose closing quote one character is skipped
 * whatever it is (git's `if (*end) end++`); broken quoting reads the entry unquoted. Empty
 * entries are skipped. Nothing is trimmed: a `\r` stays part of its path, as in git.
 */

import { decodeGitPath, unquoteGitPath } from "@statewalker/vcs-utils/encoding";

/** The entries of `bytes` (the file's or variable's bytes), as written: relative ones unresolved. */
export function parseAlternates(bytes: Uint8Array | string, sep: "\n" | ":"): string[] {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const sepByte = sep.charCodeAt(0);
  const out: string[] = [];
  const endOfEntry = (from: number) => {
    const at = data.indexOf(sepByte, from);
    return at < 0 ? data.length : at;
  };
  let i = 0;
  while (i < data.length) {
    let entry = "";
    let end: number;
    if (data[i] === 0x23) {
      // a comment, up to the next separator
      end = endOfEntry(i);
    } else {
      const quoted = data[i] === 0x22 ? unquoteGitPath(data, i) : undefined;
      if (quoted) {
        entry = quoted.path;
        end = quoted.end;
      } else {
        end = endOfEntry(i);
        entry = decodeGitPath(data.subarray(i, end));
      }
    }
    i = end < data.length ? end + 1 : end;
    if (entry !== "") out.push(entry);
  }
  return out;
}
