/**
 * git's text statistics and binary heuristics (`convert.c`: `gather_stats`,
 * `convert_is_binary`, `gather_convert_stats_ascii`).
 */

/** NUL, CR, LF and CRLF counts, and an approximation of printable characters. */
export interface TextStats {
  nul: number;
  lonecr: number;
  lonelf: number;
  crlf: number;
  printable: number;
  nonprintable: number;
}

/** git's `gather_stats`. */
export function gatherTextStats(buf: Uint8Array): TextStats {
  const stats: TextStats = { nul: 0, lonecr: 0, lonelf: 0, crlf: 0, printable: 0, nonprintable: 0 };
  const size = buf.length;
  for (let i = 0; i < size; i++) {
    const c = buf[i];
    if (c === 13) {
      if (i + 1 < size && buf[i + 1] === 10) {
        stats.crlf++;
        i++;
      } else stats.lonecr++;
      continue;
    }
    if (c === 10) {
      stats.lonelf++;
      continue;
    }
    if (c === 127) stats.nonprintable++;
    else if (c < 32) {
      // BS, HT, ESC and FF
      if (c === 8 || c === 9 || c === 27 || c === 12) stats.printable++;
      else {
        if (c === 0) stats.nul++;
        stats.nonprintable++;
      }
    } else stats.printable++;
  }
  // a trailing ^Z (DOS EOF) is not counted as non-printable
  if (size >= 1 && buf[size - 1] === 0x1a) stats.nonprintable--;
  return stats;
}

/**
 * git's `convert_is_binary` (the same heuristics as `diff.c`'s `mmfile_is_binary`): a lone
 * CR, a NUL, or more than one non-printable character per 128 printable ones.
 */
export function isBinaryStats(stats: TextStats): boolean {
  if (stats.lonecr) return true;
  if (stats.nul) return true;
  if (stats.printable >> 7 < stats.nonprintable) return true;
  return false;
}

/** Whether git takes `content` for binary when it guesses (`text=auto`, `core.autocrlf`). */
export function isBinaryContent(content: Uint8Array): boolean {
  return isBinaryStats(gatherTextStats(content));
}

/**
 * The line endings of `content` as `git ls-files --eol` shows them (`i/` and `w/`
 * columns): `-text` (binary), `lf`, `crlf`, `mixed`, or `none` (no line ending, or empty).
 */
export function eolStatsAscii(content: Uint8Array | undefined): string {
  if (!content || content.length === 0) return "none";
  const stats = gatherTextStats(content);
  if (isBinaryStats(stats)) return "-text";
  const crlf = stats.crlf > 0;
  const lf = stats.lonelf > 0;
  if (crlf && lf) return "mixed";
  if (crlf) return "crlf";
  if (lf) return "lf";
  return "none";
}
