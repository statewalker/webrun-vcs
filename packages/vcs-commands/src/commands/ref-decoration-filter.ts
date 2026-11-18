/**
 * Which refs `git log` decorates commits with: builtin/log.c's decoration filter
 * (`--decorate-refs`, `--decorate-refs-exclude`, `--clear-decorations`, and the
 * `log.excludeDecoration`, `log.initialDecorationSet` and `log.decorate` settings) and
 * log-tree.c's ref_filter_match.
 *
 * @example
 * ```typescript
 * const decorates = createRefDecorationFilter({ config: RemoteConfigStore.from(workingCopy) });
 * decorates("refs/heads/main"); // true
 * decorates("refs/notes/commits"); // false: not in the default set
 * ```
 */

import { parseGitBool } from "@statewalker/vcs-utils";
import { wildmatch } from "@statewalker/vcs-working-tree";

/** The configuration the filter reads (a `RemoteConfigStore` is one). */
export interface RefDecorationConfig {
  /** Every value of a variable, in the configuration's order */
  values(key: string): string[];
}

/** Options of {@link createRefDecorationFilter}. */
export interface RefDecorationFilterOptions {
  /** `--decorate-refs=<pattern>`: only refs matching one of them are decorated */
  decorateRefs?: readonly string[];
  /** `--decorate-refs-exclude=<pattern>`: refs matching one of them are not decorated */
  decorateRefsExclude?: readonly string[];
  /**
   * `--clear-decorations`: no default set (every ref, unless patterns say otherwise). The
   * patterns given before it on a command line are cleared by it: pass only those after.
   */
  clearDecorations?: boolean;
  /**
   * The configuration: `log.excludeDecoration` (patterns not decorated, unless
   * `--decorate-refs` includes them) and `log.initialDecorationSet` (`all`: no default set)
   */
  config?: RefDecorationConfig;
  /** Where replace refs live (`GIT_REPLACE_REF_BASE`; default `refs/replace/`) */
  replaceRefBase?: string;
}

/**
 * The refs git decorates by default (ref_namespace's entries with a decoration type): HEAD,
 * branches, tags, remote-tracking refs, the stash and the replace refs.
 */
function defaultDecorationSet(replaceRefBase: string): string[] {
  return ["HEAD", "refs/heads/", "refs/tags/", "refs/remotes/", "refs/stash", replaceRefBase];
}

/** A pattern as normalize_glob_ref makes it: a glob, or a prefix matched at a `/`. */
interface RefPattern {
  text: string;
  glob: boolean;
}

/**
 * git's normalize_glob_ref (without a prefix): `refs/` put in front unless the pattern starts
 * with it or is `HEAD`, one trailing slash dropped; a pattern with `?`, `*` or `[` is a glob.
 */
function normalizeGlobRef(pattern: string): RefPattern {
  let text = pattern.startsWith("refs/") || pattern === "HEAD" ? pattern : `refs/${pattern}`;
  if (text.endsWith("/")) text = text.slice(0, -1);
  return { text, glob: /[?*[]/.test(pattern) };
}

/** log-tree.c's match_ref_pattern. */
function matchRefPattern(name: string, pattern: RefPattern): boolean {
  if (pattern.glob) return wildmatch(pattern.text, name);
  if (!name.startsWith(pattern.text)) return false;
  const rest = name.slice(pattern.text.length);
  return rest === "" || rest.startsWith("/");
}

/**
 * Whether git's `git log` decorates commits with a ref (log-tree.c's ref_filter_match over
 * the filter builtin/log.c sets up): a ref matching an excluding pattern is not; with
 * including patterns, only a ref matching one of them is; else one matching a pattern of
 * `log.excludeDecoration` is not. Without patterns on the command line or in the
 * configuration, only the default set is decorated (HEAD, `refs/heads/`, `refs/tags/`,
 * `refs/remotes/`, `refs/stash`, the replace refs), unless `--clear-decorations` or
 * `log.initialDecorationSet=all` asks for every ref.
 */
export function createRefDecorationFilter(
  options: RefDecorationFilterOptions = {},
): (refName: string) => boolean {
  const exclude = (options.decorateRefsExclude ?? []).map(normalizeGlobRef);
  const includeGiven = [...(options.decorateRefs ?? [])];
  const configExclude = (options.config?.values("log.excludeDecoration") ?? []).map(
    normalizeGlobRef,
  );
  // set_default_decoration_filter: log.initialDecorationSet=all turns the default set off,
  // as --clear-decorations does
  let useDefault = !options.clearDecorations;
  if (useDefault && options.config?.values("log.initialDecorationSet").at(-1) === "all") {
    useDefault = false;
  }
  if (useDefault && !exclude.length && !includeGiven.length && !configExclude.length) {
    includeGiven.push(...defaultDecorationSet(options.replaceRefBase ?? "refs/replace/"));
  }
  const include = includeGiven.map(normalizeGlobRef);
  return (name) => {
    if (exclude.some((p) => matchRefPattern(name, p))) return false;
    if (include.length) return include.some((p) => matchRefPattern(name, p));
    return !configExclude.some((p) => matchRefPattern(name, p));
  };
}

/**
 * Whether `log.decorate` asks for full ref names (`full`): `%d` and friends then show
 * `refs/heads/main` where they show `main` by default (`short`, a boolean, `auto`).
 */
export function decorateFullRefs(config: RefDecorationConfig | undefined): boolean {
  const value = config?.values("log.decorate").at(-1);
  if (value === undefined || parseGitBool(value) !== undefined) return false;
  return value === "full";
}
