/**
 * What `git check-attr` and `git check-ignore` share: their `--stdin` records (lines, a line
 * starting with `"` unquoted as a C string, or NUL-terminated with `-z`) and their paths read
 * against the current directory (`prefix_path`).
 */

import { decodeGitPath, unquoteGitPath } from "@statewalker/vcs-utils/encoding";

/**
 * `--stdin`'s records: `strbuf_getline_lf` lines (only the LF dropped), each starting with
 * `"` unquoted (`unquote_c_style`, anything after the closing quote ignored), or with `nul`
 * NUL-terminated records taken as they are. Undefined at the first line git cannot unquote
 * (`fatal: line is badly quoted`), with the records before it.
 */
export function inputRecords(
  input: Uint8Array,
  nul: boolean,
): { records: string[]; badlyQuoted: boolean } {
  const records: string[] = [];
  const sep = nul ? 0 : 0x0a;
  let pos = 0;
  while (pos < input.length) {
    const end = input.indexOf(sep, pos);
    const stop = end < 0 ? input.length : end;
    const line = input.subarray(pos, stop);
    pos = stop + 1;
    if (!nul && line[0] === 0x22) {
      const unquoted = unquoteGitPath(line, 0);
      if (!unquoted) return { records, badlyQuoted: true };
      records.push(unquoted.path);
    } else records.push(decodeGitPath(line));
  }
  return { records, badlyQuoted: false };
}

/**
 * git's `prefix_path`: `path` read against the current directory `prefix` (`""` at the
 * top, else ending with `/`) and normalized (`//`, `.` and `..` resolved; a trailing `/`
 * kept); undefined when it climbs above the top.
 */
export function prefixPath(prefix: string, path: string): string | undefined {
  const full = path.startsWith("/") ? path : prefix + path;
  const out: string[] = [];
  const parts = full.split("/");
  const trailing = parts.length > 1 && parts[parts.length - 1] === "";
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  return trailing && joined !== "" ? `${joined}/` : joined;
}

/** A current directory as `prefixPath` takes it: `""`, or the path with one trailing `/`. */
export function directoryPrefix(dir: string): string {
  const trimmed = dir.replace(/^\/+|\/+$/g, "");
  return trimmed === "" || trimmed === "." ? "" : `${trimmed}/`;
}
