/**
 * git's sparse-checkout patterns (`$GIT_DIR/info/sparse-checkout`) and its
 * `path_in_sparse_checkout` (dir.c): which paths the sparse checkout includes.
 */

import { createIgnoreNode, trimTrailingSpaces } from "../ignore/index.js";

/** The sparse checkout's definition, as git reads it for `path_in_sparse_checkout`. */
export interface SparseCheckoutPatterns {
  /** Whether cone matching is used (`core.sparseCheckoutCone` and cone-shaped patterns). */
  readonly cone: boolean;
  /** git's `path_in_sparse_checkout` for the path of an index entry (a file). */
  includes(path: string): boolean;
}

/** Every path is in the checkout: git without a sparse-checkout file. */
const EVERYTHING: SparseCheckoutPatterns = { cone: false, includes: () => true };

/**
 * The patterns of a sparse-checkout file (`content`, undefined when there is none: every
 * path is then included, as git accepts a path when the patterns cannot be read), matched
 * in cone mode when `cone` (`core.sparseCheckoutCone`) and the patterns have the cone's
 * shape (git's `add_pattern_to_hashsets`, which otherwise falls back to the gitignore-style
 * matching of non-cone mode).
 *
 * @example
 * ```typescript
 * const sparse = parseSparseCheckoutPatterns("/*\n!/*\/\n/k/\n", true);
 * sparse.includes("k/a"); // true
 * sparse.includes("s/b"); // false
 * sparse.includes("top"); // true (cone mode keeps the root's files)
 * ```
 */
export function parseSparseCheckoutPatterns(
  content: string | undefined,
  cone: boolean,
): SparseCheckoutPatterns {
  if (content === undefined) return EVERYTHING;
  const lines = content
    .split("\n")
    .map((line) => trimTrailingSpaces(line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  const hashsets = cone ? coneHashsets(lines) : undefined;
  if (hashsets) {
    const { full, recursive, parent } = hashsets;
    return {
      cone: true,
      includes: (path) => {
        if (!path || full) return true;
        // git's path_matches_pattern_list in cone mode, for a file
        const slashed = `/${path}`;
        if (recursive.has(slashed)) return true;
        const slash = slashed.lastIndexOf("/");
        if (slash <= 0) return true;
        if (parent.has(slashed.slice(0, slash))) return true;
        for (let k = slash; k > 0; k = slashed.lastIndexOf("/", k - 1)) {
          if (recursive.has(slashed.slice(0, k))) return true;
        }
        return false;
      },
    };
  }
  const node = createIgnoreNode();
  node.parse(lines.join("\n"));
  return {
    cone: false,
    includes: (path) => {
      if (!path) return true;
      // the path's own answer, else its parent directories' (UNDECIDED climbs), else out
      let isDirectory = false;
      for (let end = path.length; end > 0; end = path.lastIndexOf("/", end - 1)) {
        const matched = node.checkIgnored(path.slice(0, end), isDirectory);
        if (matched !== undefined) return matched;
        isDirectory = true;
      }
      return false;
    },
  };
}

/** glob characters, as git's `is_glob_special` */
const isGlobSpecial = (c: string | undefined) => c === "*" || c === "?" || c === "[" || c === "\\";

/**
 * git's `add_pattern_to_hashsets` over every pattern: the recursive and parent directory
 * sets (slash-led, unescaped), or undefined when a pattern is not of the cone's shape.
 */
function coneHashsets(
  lines: string[],
): { full: boolean; recursive: Set<string>; parent: Set<string> } | undefined {
  let full = false;
  const recursive = new Set<string>();
  const parent = new Set<string>();
  for (const line of lines) {
    let pattern = line;
    let negative = false;
    if (pattern.startsWith("!")) {
      negative = true;
      pattern = pattern.slice(1);
    }
    let mustBeDir = false;
    if (pattern.endsWith("/")) {
      mustBeDir = true;
      pattern = pattern.slice(0, -1);
    }
    if (negative && mustBeDir && pattern === "/*") {
      full = false;
      continue;
    }
    // (git's flags: neither `!` nor a trailing `/`; "/*" holds a slash and no leading `*`)
    if (!negative && !mustBeDir && pattern === "/*") {
      full = true;
      continue;
    }
    if (pattern.length < 2 || !pattern.startsWith("/") || pattern.includes("**")) return undefined;
    if (!mustBeDir) return undefined;
    for (let i = 1; i < pattern.length; i++) {
      const prev = pattern[i - 1];
      const cur = pattern[i];
      const next = pattern[i + 1];
      if (!isGlobSpecial(cur) || prev === "\\") continue;
      if (cur === "\\" && isGlobSpecial(next)) continue;
      if (prev === "/" && cur === "*" && next === undefined) continue;
      return undefined;
    }
    const filtered = filterConePattern(pattern);
    if (pattern.length > 2 && pattern.endsWith("/*")) {
      if (!negative || !recursive.has(filtered)) return undefined;
      parent.add(filtered);
      recursive.delete(filtered);
      continue;
    }
    if (negative) return undefined;
    recursive.add(filtered);
    if (parent.has(filtered)) return undefined;
  }
  return { full, recursive, parent };
}

/** git's `dup_and_filter_pattern`: escapes dropped (once), a trailing `/*` cut. */
function filterConePattern(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") i++;
    if (i < pattern.length) out += pattern[i];
  }
  return out.length > 2 && out.endsWith("/*") ? out.slice(0, -2) : out;
}
