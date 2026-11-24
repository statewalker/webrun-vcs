/**
 * `--dirstat` (diff.c's `show_dirstat`, `show_dirstat_by_line`, `gather_dirstat`): how much
 * of the change each directory holds, as a percentage of the whole.
 *
 * @example
 * ```typescript
 * formatDirstat([{ name: "a/x", changed: 3 }, { name: "b/y", changed: 1 }], DEFAULT_DIRSTAT);
 * // "  75.0% a/\n  25.0% b/\n"
 * ```
 */

import { compareGitPaths } from "@statewalker/vcs-utils/encoding";

/** The dirstat's parameters (`diff_options`' dirstat flags and `dirstat_permille`) */
export interface DirstatParams {
  /** `lines`: damage from the diffstat's line counts */
  byLine: boolean;
  /** `files`: each changed file counts one */
  byFile: boolean;
  /** `cumulative`: a directory's count includes its subdirectories' */
  cumulative: boolean;
  /** The cut-off, in tenths of a percent (default 30: 3%) */
  permille: number;
}

/** git's defaults: `changes,noncumulative,3` */
export const DEFAULT_DIRSTAT: DirstatParams = {
  byLine: false,
  byFile: false,
  cumulative: false,
  permille: 30,
};

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

/**
 * diff.c's `parse_dirstat_params`: the comma-separated parameters applied over `params`;
 * returns git's error lines (`  Unknown dirstat parameter '<p>'`), the valid ones applied.
 */
export function parseDirstatParams(text: string, params: DirstatParams): string[] {
  const errors: string[] = [];
  if (text === "") return errors;
  for (const p of text.split(",")) {
    if (p === "changes") {
      params.byLine = false;
      params.byFile = false;
    } else if (p === "lines") {
      params.byLine = true;
      params.byFile = false;
    } else if (p === "files") {
      params.byLine = false;
      params.byFile = true;
    } else if (p === "noncumulative") params.cumulative = false;
    else if (p === "cumulative") params.cumulative = true;
    else if (isDigit(p[0])) {
      let at = 0;
      while (isDigit(p[at])) at++;
      let permille = Number(p.slice(0, at)) * 10;
      if (p[at] === "." && isDigit(p[at + 1])) {
        // only the first digit counts, the others are ignored
        permille += p.charCodeAt(at + 1) - 48;
        at += 2;
        while (isDigit(p[at])) at++;
      }
      if (at === p.length) params.permille = permille;
      else errors.push(`  Failed to parse dirstat cut-off percentage '${p}'`);
    } else errors.push(`  Unknown dirstat parameter '${p}'`);
  }
  return errors;
}

/** One file's damage (`struct dirstat_file`) */
export interface DirstatFile {
  name: string;
  changed: number;
}

/** `conclude_dirstat` / `gather_dirstat`: the directories at or above the cut-off */
export function formatDirstat(files: readonly DirstatFile[], params: DirstatParams): string {
  let total = 0;
  for (const f of files) total += f.changed;
  // everything renamed: nothing changed
  if (!total) return "";
  const sorted = [...files].sort((a, b) => compareGitPaths(a.name, b.name));
  let at = 0;
  let out = "";
  const gather = (base: string): number => {
    let sum = 0;
    let sources = 0;
    while (at < sorted.length) {
      const f = sorted[at] as DirstatFile;
      if (!f.name.startsWith(base)) break;
      const slash = f.name.indexOf("/", base.length);
      let changes: number;
      if (slash >= 0) {
        changes = gather(f.name.slice(0, slash + 1));
        sources++;
      } else {
        changes = f.changed;
        at++;
        sources += 2;
      }
      sum += changes;
    }
    // no line for the top level, or a directory whose changes all come from one subdirectory
    if (base && sources !== 1 && sum) {
      const permille = Math.trunc((sum * 1000) / total);
      if (permille >= params.permille) {
        out += `${String(Math.trunc(permille / 10)).padStart(4)}.${permille % 10}% ${base}\n`;
        if (!params.cumulative) return 0;
      }
    }
    return sum;
  };
  gather("");
  return out;
}
