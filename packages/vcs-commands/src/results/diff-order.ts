/**
 * git's `diffcore-order.c` (`-O<orderfile>`, `diff.orderFile`): file pairs reordered by the
 * glob patterns of an order file.
 *
 * @example
 * ```typescript
 * const patterns = parseOrderFile(new TextEncoder().encode("*.h\n# headers first\n*.c\n"));
 * orderByPatterns(["b.c", "a.h", "README"], patterns, (p) => p);
 * // ["a.h", "b.c", "README"]
 * ```
 *
 * Each line of the file is a pattern, taken as it is (no trimming); empty lines and lines
 * starting with `#` are skipped. A path's rank is the first pattern that matches it or one
 * of its leading directories (wildmatch without `WM_PATHNAME`, so `*` also matches `/`);
 * paths no pattern matches come last, and paths of the same rank keep their order.
 *
 * @module
 */

import { wildmatch } from "@statewalker/vcs-working-tree";

/** The patterns of an order file (git's `prepare_order`) */
export function parseOrderFile(content: Uint8Array): string[] {
  const decoder = new TextDecoder();
  const patterns: string[] = [];
  let start = 0;
  while (start < content.length) {
    let end = start;
    while (end < content.length && content[end] !== 0x0a) end++;
    // an empty line or a comment
    if (content[start] !== 0x0a && content[start] !== 0x23) {
      patterns.push(decoder.decode(content.subarray(start, end)));
    }
    start = end < content.length ? end + 1 : end;
  }
  return patterns;
}

/** The rank of `path`: the first pattern matching it or a leading directory (`match_order`) */
export function orderRank(patterns: readonly string[], path: string): number {
  for (let i = 0; i < patterns.length; i++) {
    let p = path;
    while (p) {
      if (wildmatch(patterns[i], p)) return i;
      const slash = p.lastIndexOf("/");
      if (slash < 0) break;
      p = p.slice(0, slash);
    }
  }
  return patterns.length;
}

/** The items ordered by the rank of their paths, stably (`order_objects`) */
export function orderByPatterns<T>(
  items: readonly T[],
  patterns: readonly string[],
  pathOf: (item: T) => string,
): T[] {
  return items
    .map((item, index) => ({ item, index, rank: orderRank(patterns, pathOf(item)) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((e) => e.item);
}
