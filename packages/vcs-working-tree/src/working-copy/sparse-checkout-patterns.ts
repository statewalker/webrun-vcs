/**
 * git's sparse-checkout patterns (`$GIT_DIR/info/sparse-checkout`) and its
 * `path_in_sparse_checkout` (dir.c): which paths the sparse checkout includes.
 */

import { foldAsciiCase } from "@statewalker/vcs-utils/encoding";
import { createIgnoreRule, trimTrailingSpaces, wildmatch } from "../ignore/index.js";

/**
 * The hashsets of a cone-mode pattern list (git's `recursive_hashmap` and `parent_hashmap`):
 * slash-led directory names, unescaped (`dup_and_filter_pattern`), in the order they were
 * added. Both are multisets, as git's hashmaps hold equal entries more than once.
 */
export interface SparseConeSets {
  /** `/*` was given (and not taken back by a later `!/*\/`): every path is in */
  readonly full: boolean;
  /** Directories whose whole contents are in (`/k/`) */
  readonly recursive: readonly string[];
  /** Directories whose files directly inside are in (`/p/` with `!/p/*\/`) */
  readonly parent: readonly string[];
}

/** The sparse checkout's definition, as git reads it for `path_in_sparse_checkout`. */
export interface SparseCheckoutPatterns {
  /** Whether cone matching is used (`core.sparseCheckoutCone` and cone-shaped patterns). */
  readonly cone: boolean;
  /**
   * git's `path_in_sparse_checkout`: for the path of an index entry (a file), or, with a
   * trailing `/` (`sub/`), for a directory as git asks for an embedded repository.
   */
  includes(path: string): boolean;
  /**
   * What git warns about while it loads the patterns in cone mode (`add_pattern_to_hashsets`),
   * without the `warning: ` prefix: `unrecognized pattern: '<p>'`, `unrecognized negative
   * pattern: '<p>'`, a repeated pattern, then `disabling cone pattern matching`.
   */
  readonly warnings: readonly string[];
  /** The patterns as read (each line of the file, trailing spaces trimmed) */
  readonly lines: readonly string[];
  /** In cone mode: the recursive and parent directories */
  readonly coneSets?: SparseConeSets;
}

/** Every path is in the checkout: git without a sparse-checkout file. */
const EVERYTHING: SparseCheckoutPatterns = {
  cone: false,
  includes: () => true,
  warnings: [],
  lines: [],
};

/**
 * The patterns of a sparse-checkout file (`content`, undefined when there is none: every
 * path is then included, as git accepts a path when the patterns cannot be read), matched
 * in cone mode when `cone` (`core.sparseCheckoutCone`) and the patterns have the cone's
 * shape (git's `add_pattern_to_hashsets`, which otherwise warns and falls back to the
 * gitignore-style matching of non-cone mode). With `ignoreCase` (`core.ignoreCase`) ASCII
 * letters match in either case, in both modes (git's `fspathhash` and `fspathncmp`,
 * `WM_CASEFOLD`).
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
  return sparsePatternsFromLines(splitPatternLines(content), cone, ignoreCase);
}

/**
 * The lines of a pattern file as git's `add_patterns_from_buffer` reads them: empty lines
 * and `#` comments skipped, a CR and unescaped trailing spaces dropped.
 */
export function splitPatternLines(content: string): string[] {
  const lines: string[] = [];
  for (const raw of content.split("\n")) {
    // (git's buffer always ends with a newline: text after the last one is a line too)
    if (raw.length === 0 || raw.startsWith("#")) continue;
    lines.push(trimTrailingSpaces(raw.endsWith("\r") ? raw.slice(0, -1) : raw));
  }
  return lines;
}

/**
 * Patterns given one by one, as git's `add_pattern` takes them (nothing trimmed or skipped:
 * `sparse-checkout set --no-cone <patterns>`, a `--rules-file` read in non-cone mode), in
 * cone mode when `cone` and they have the cone's shape.
 */
export function sparsePatternsFromLines(
  lines: readonly string[],
  cone: boolean,
  ignoreCase = false,
): SparseCheckoutPatterns {
  const fold = ignoreCase ? foldAsciiCase : (s: string) => s;
  const warnings: string[] = [];
  const sets = cone ? coneHashsets(lines, fold, warnings) : undefined;
  if (sets) return { ...coneMatcher(sets, fold), warnings, lines: [...lines], coneSets: sets };
  return { cone: false, includes: nonConeMatcher(lines, ignoreCase), warnings, lines: [...lines] };
}

/** The patterns of cone-mode hashsets built directly (git's `insert_recursive_pattern`). */
export function sparsePatternsFromCone(
  sets: SparseConeSets,
  ignoreCase = false,
): SparseCheckoutPatterns {
  const fold = ignoreCase ? foldAsciiCase : (s: string) => s;
  return { ...coneMatcher(sets, fold), warnings: [], lines: [], coneSets: sets };
}

/** git's `path_matches_pattern_list` in cone mode, over the hashsets. */
function coneMatcher(
  sets: SparseConeSets,
  fold: (s: string) => string,
): { cone: true; includes: (path: string) => boolean } {
  const recursive = new Set(sets.recursive.map(fold));
  const parent = new Set(sets.parent.map(fold));
  const full = sets.full;
  const has = (set: Set<string>, key: string) => set.has(fold(key));
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

/** git's `path_in_sparse_checkout_1` over gitignore-style patterns (non-cone mode). */
function nonConeMatcher(lines: readonly string[], ignoreCase: boolean): (path: string) => boolean {
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
  return (path) => {
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
  };
}

/** glob characters, as git's `is_glob_special` */
const isGlobSpecial = (c: string | undefined) => c === "*" || c === "?" || c === "[" || c === "\\";

/**
 * git's `add_pattern_to_hashsets` over every pattern: the recursive and parent directory
 * sets (slash-led, unescaped; multisets, as git's hashmaps, compared after `fold`), or
 * undefined when a pattern is not of the cone's shape, with git's warnings pushed onto
 * `warnings` (the pattern as `parse_path_pattern` leaves it: no `!`, no trailing `/`).
 */
function coneHashsets(
  lines: readonly string[],
  fold: (s: string) => string,
  warnings: string[],
): SparseConeSets | undefined {
  let full = false;
  const recursive: string[] = [];
  const parent: string[] = [];
  const indexIn = (list: string[], key: string) => {
    const folded = fold(key);
    return list.findIndex((e) => fold(e) === folded);
  };
  const disable = (message: string) => {
    warnings.push(message, "disabling cone pattern matching");
    return undefined;
  };
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
    if (pattern.length < 2 || !pattern.startsWith("/") || pattern.includes("**")) {
      return disable(`unrecognized pattern: '${pattern}'`);
    }
    if (!mustBeDir && pattern !== "/*") return disable(`unrecognized pattern: '${pattern}'`);
    for (let i = 1; i < pattern.length; i++) {
      const prev = pattern[i - 1];
      const cur = pattern[i];
      const next = pattern[i + 1];
      if (!isGlobSpecial(cur) || prev === "\\") continue;
      if (cur === "\\" && isGlobSpecial(next)) continue;
      if (prev === "/" && cur === "*" && next === undefined) continue;
      return disable(`unrecognized pattern: '${pattern}'`);
    }
    const filtered = filterConePattern(pattern);
    if (pattern.length > 2 && pattern.endsWith("/*")) {
      if (!negative) return disable(`unrecognized pattern: '${pattern}'`);
      const at = indexIn(recursive, filtered);
      if (at < 0) return disable(`unrecognized negative pattern: '${pattern}'`);
      parent.push(filtered);
      recursive.splice(at, 1);
      continue;
    }
    if (negative) return disable(`unrecognized negative pattern: '${pattern}'`);
    recursive.push(filtered);
    if (indexIn(parent, filtered) >= 0) {
      return disable(`your sparse-checkout file may have issues: pattern '${pattern}' is repeated`);
    }
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

/**
 * The matcher of a `sparse:oid=<blob>` partial clone filter: the blob's patterns
 * (`add_patterns_from_blob_to_list`: a UTF-8 BOM skipped, read as a sparse-checkout file)
 * matched gitignore-style, never in cone mode, as git's `path_matches_pattern_list` answers
 * list-objects-filter.c's `filter_sparse`: true when the last matching pattern includes the
 * path, false when it is negated, undefined when none matches (the directory's answer then
 * applies).
 *
 * @example
 * ```typescript
 * const match = sparseFilterMatcher("/docs/\n!/docs/big/\n");
 * match("docs", "docs", true); // true
 * match("docs/big", "big", true); // false
 * match("src/a.c", "a.c", false); // undefined
 * ```
 */
export function sparseFilterMatcher(
  text: string,
): (pathname: string, basename: string, isDirectory: boolean) => boolean | undefined {
  const lines = splitPatternLines(text.startsWith("\uFEFF") ? text.slice(1) : text);
  const rules = lines.map((line) => {
    const negated = line.startsWith("!");
    const rule = createIgnoreRule(line);
    // the root tree ("") is asked by its empty basename: only a pattern without a slash
    // (git's NODIR) can match it
    let body = negated ? line.slice(1) : line;
    const mustBeDir = body.endsWith("/");
    if (mustBeDir) body = body.slice(0, -1);
    const root = !body.includes("/") && wildmatch(body, "");
    return {
      negated,
      matches: (path: string, isDirectory: boolean) =>
        path === "" ? root && isDirectory : rule.matchesPath?.(path, isDirectory) === true,
    };
  });
  return (pathname, _basename, isDirectory) => {
    for (let i = rules.length - 1; i >= 0; i--) {
      const rule = rules[i] as (typeof rules)[number];
      if (rule.matches(pathname, isDirectory)) return !rule.negated;
    }
    return undefined;
  };
}
