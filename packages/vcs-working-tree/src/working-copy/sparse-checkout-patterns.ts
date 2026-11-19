/**
 * git's sparse-checkout patterns (`$GIT_DIR/info/sparse-checkout`) and its
 * `path_in_sparse_checkout` (dir.c): which paths the sparse checkout includes.
 */

import { foldAsciiCase } from "@statewalker/vcs-utils/encoding";
import { createIgnoreRule, trimTrailingSpaces } from "../ignore/index.js";

/** The sparse checkout's definition, as git reads it for `path_in_sparse_checkout`. */
export interface SparseCheckoutPatterns {
  /** Whether cone matching is used (`core.sparseCheckoutCone` and cone-shaped patterns). */
  readonly cone: boolean;
  /**
   * git's `path_in_sparse_checkout`: for the path of an index entry (a file), or, with a
   * trailing `/` (`sub/`), for a directory as git asks for an embedded repository.
   */
  includes(path: string): boolean;
}

/** Every path is in the checkout: git without a sparse-checkout file. */
const EVERYTHING: SparseCheckoutPatterns = { cone: false, includes: () => true };

/**
 * The patterns of a sparse-checkout file (`content`, undefined when there is none: every
 * path is then included, as git accepts a path when the patterns cannot be read), matched
 * in cone mode when `cone` (`core.sparseCheckoutCone`) and the patterns have the cone's
 * shape (git's `add_pattern_to_hashsets`, which otherwise falls back to the gitignore-style
 * matching of non-cone mode). With `ignoreCase` (`core.ignoreCase`) ASCII letters match in
 * either case, in both modes (git's `fspathhash` and `fspathncmp`, `WM_CASEFOLD`).
 *
 * The lines are read as git's `add_patterns_from_buffer` reads them: an empty line or one
 * starting with `#` is skipped; any other line loses its CR and unescaped trailing spaces,
 * so a line of spaces is an empty pattern (one that is not of the cone's shape).
 *
 * @example
 * ```typescript
 * const sparse = parseSparseCheckoutPatterns("/*\n!/*\/\n/k/\n", true);
 * sparse.includes("k/a"); // true
 * sparse.includes("s/b"); // false
 * sparse.includes("top"); // true (cone mode keeps the root's files)
 * sparse.includes("sub/"); // false (a directory outside the cone)
 * ```
 */
export function parseSparseCheckoutPatterns(
  content: string | undefined,
  cone: boolean,
  ignoreCase = false,
): SparseCheckoutPatterns {
  if (content === undefined) return EVERYTHING;
  const lines: string[] = [];
  for (const raw of content.split("\n")) {
    // (git's buffer always ends with a newline: text after the last one is a line too)
    if (raw.length === 0 || raw.startsWith("#")) continue;
    lines.push(trimTrailingSpaces(raw.endsWith("\r") ? raw.slice(0, -1) : raw));
  }
  const fold = ignoreCase ? foldAsciiCase : (s: string) => s;
  const hashsets = cone ? coneHashsets(lines, fold) : undefined;
  if (hashsets) {
    const { full, recursive, parent } = hashsets;
    const has = (set: Map<string, number>, key: string) => set.has(fold(key));
    return {
      cone: true,
      includes: (path) => {
        if (!path || full) return true;
        // git's path_matches_pattern_list in cone mode: a directory (`sub/`) is asked as a
        // file directly inside it (`sub/-`)
        const slashed = `/${path}`;
        const directory = slashed.endsWith("/");
        const slash = directory ? slashed.length - 1 : slashed.lastIndexOf("/");
        if (has(recursive, directory ? `${slashed}-` : slashed)) return true;
        if (slash <= 0) return true;
        if (has(parent, slashed.slice(0, slash))) return true;
        // hashmap_contains_parent
        for (let k = slashed.lastIndexOf("/"); k > 0; k = slashed.lastIndexOf("/", k - 1)) {
          if (has(recursive, slashed.slice(0, k))) return true;
        }
        return false;
      },
    };
  }
  const rules = lines.map((line) => {
    // an empty pattern (`""`, `"!"`) takes an empty basename (git's match_basename): a
    // directory asked as `sub/`
    const negated = line.startsWith("!");
    if (line === "" || line === "!") {
      return { negated, matches: (path: string) => path.endsWith("/") };
    }
    const rule = createIgnoreRule(line);
    return {
      negated,
      matches: (path: string, isDirectory: boolean) =>
        rule.matchesPath?.(path, isDirectory, ignoreCase) === true,
    };
  });
  // git's last_matching_pattern_from_list: the last pattern that matches decides
  const matchOf = (path: string, isDirectory: boolean): boolean | undefined => {
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i] as (typeof rules)[number];
      if (rule.matches(path, isDirectory)) return !rule.negated;
    }
    return undefined;
  };
  return {
    cone: false,
    includes: (path) => {
      if (!path) return true;
      // path_in_sparse_checkout_1: the path's own answer, else its parent directories'
      // (UNDECIDED climbs), else out; `sub/` is asked first as itself (empty basename)
      let isDirectory = false;
      for (let end = path.length; end > 0; ) {
        let slash = end - 1;
        while (slash > 0 && path[slash] !== "/") slash--;
        const matched = matchOf(path.slice(0, end), isDirectory);
        if (matched !== undefined) return matched;
        isDirectory = true;
        end = slash;
      }
      return false;
    },
  };
}

/** glob characters, as git's `is_glob_special` */
const isGlobSpecial = (c: string | undefined) => c === "*" || c === "?" || c === "[" || c === "\\";

/** A multiset of keys, as git's hashmap holds equal entries more than once. */
type Multiset = Map<string, number>;
const addTo = (set: Multiset, key: string) => set.set(key, (set.get(key) ?? 0) + 1);
const removeOne = (set: Multiset, key: string) => {
  const n = set.get(key) ?? 0;
  if (n <= 1) set.delete(key);
  else set.set(key, n - 1);
};

/**
 * git's `add_pattern_to_hashsets` over every pattern: the recursive and parent directory
 * sets (slash-led, unescaped, case folded by `fold`; multisets, as git's hashmaps), or
 * undefined when a pattern is not of the cone's shape.
 */
function coneHashsets(
  lines: string[],
  fold: (s: string) => string,
): { full: boolean; recursive: Multiset; parent: Multiset } | undefined {
  let full = false;
  const recursive: Multiset = new Map();
  const parent: Multiset = new Map();
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
    const filtered = fold(filterConePattern(pattern));
    if (pattern.length > 2 && pattern.endsWith("/*")) {
      if (!negative || !recursive.has(filtered)) return undefined;
      addTo(parent, filtered);
      removeOne(recursive, filtered);
      continue;
    }
    if (negative) return undefined;
    addTo(recursive, filtered);
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
