/**
 * Gitignore pattern matching interfaces
 *
 * Based on JGit's FastIgnoreRule and IgnoreNode patterns.
 * Implements gitignore syntax as specified at:
 * https://www.kernel.org/pub/software/scm/git/docs/gitignore.html
 */

/**
 * Result from checking if a path is ignored.
 */
export const MatchResult = {
  /** The file is not ignored, due to a rule explicitly un-ignoring it. */
  NOT_IGNORED: "NOT_IGNORED",
  /** The file is ignored due to a matching rule. */
  IGNORED: "IGNORED",
  /** The ignore status is unknown, check parent directory rules. */
  CHECK_PARENT: "CHECK_PARENT",
} as const;

export type MatchResultValue = (typeof MatchResult)[keyof typeof MatchResult];

/**
 * A single ignore rule parsed from a gitignore pattern.
 *
 * Each rule can:
 * - Match files or directories
 * - Be negated (starts with !)
 * - Be directory-only (ends with /)
 * - Use wildcards (*, ?, **)
 * - Use character classes ([a-z], [!abc])
 */
export interface IgnoreRule {
  /**
   * Check if this rule matches the given path.
   *
   * @param path Path relative to the ignore file location (uses '/')
   * @param isDirectory Whether the target is a directory
   * @returns true if the pattern matches
   */
  isMatch(path: string, isDirectory: boolean): boolean;

  /**
   * Check if this rule matches the given path (with path match mode).
   *
   * @param path Path relative to the ignore file location
   * @param isDirectory Whether the target is a directory
   * @param pathMatch Whether to do exact path matching vs prefix matching
   * @returns true if the pattern matches
   */
  isMatchWithMode(path: string, isDirectory: boolean, pathMatch: boolean): boolean;

  /**
   * Whether the rule matches the path itself as git's `.gitignore` matching decides
   * (`match_basename` / `match_pathname` with wildmatch): a pattern without a slash
   * against the last component, one with a slash against the whole path relative to the
   * ignore file's directory, a directory-only pattern only against a directory. Directories
   * above the path are the caller's to check. Absent: `isMatchWithMode(path, dir, true)`.
   * With `ignoreCase` (`core.ignoreCase`) ASCII letters match in either case, as in git.
   */
  matchesPath?(path: string, isDirectory: boolean, ignoreCase?: boolean): boolean;

  /** Whether this is a negation rule (starts with !) */
  readonly isNegated: boolean;

  /** Whether this rule only applies to directories (ends with /) */
  readonly dirOnly: boolean;

  /** Whether this rule is empty (comment or invalid pattern) */
  readonly isEmpty: boolean;

  /** The original pattern string */
  readonly pattern: string;
}

/**
 * A collection of ignore rules from a single source (e.g., one .gitignore file).
 */
export interface IgnoreNode {
  /**
   * Check if a path is ignored by rules in this node.
   *
   * @param entryPath Path relative to this node's directory
   * @param isDirectory Whether the path is a directory
   * @returns Match result indicating ignore status
   */
  isIgnored(entryPath: string, isDirectory: boolean): MatchResultValue;

  /**
   * Check if a path is ignored by rules in this node.
   *
   * @param entryPath Path relative to this node's directory
   * @param isDirectory Whether the path is a directory
   * @param ignoreCase Fold ASCII case (`core.ignoreCase`), as git does
   * @returns true if ignored, false if explicitly not ignored, undefined if no match
   */
  checkIgnored(entryPath: string, isDirectory: boolean, ignoreCase?: boolean): boolean | undefined;

  /**
   * The last rule matching a path (negated or not) and its line in the parsed text (git's
   * `last_matching_pattern_from_list`); undefined when none matches.
   */
  matchingRule?(
    entryPath: string,
    isDirectory: boolean,
    ignoreCase?: boolean,
  ): { rule: IgnoreRule; line: number } | undefined;

  /** All rules in this node */
  readonly rules: readonly IgnoreRule[];

  /**
   * Parse ignore rules from text content.
   *
   * @param content Content of gitignore file
   */
  parse(content: string): void;
}

/** Where an ignore rule was read (see {@link IgnoreMatch}). */
export type IgnoreSource =
  /** The `.gitignore` of a directory ("" for the top) */
  | { kind: "directory"; directory: string }
  /** A named exclude file (`info/exclude`, `core.excludesFile`) */
  | { kind: "exclude"; name: string }
  /** The patterns given by `addGlobalPatterns` */
  | { kind: "global" }
  /** The command line's rules (`EXC_CMDL`) */
  | { kind: "commandLine" };

/**
 * The pattern that decides whether a path is ignored, as `git check-ignore -v` reports it:
 * an excluded leading directory's (whatever the path's own rules say), else the path's last
 * matching one, negated or not.
 */
export interface IgnoreMatch {
  source: IgnoreSource;
  /** Its line in its file, from 1 (0 for patterns not read from a file) */
  line: number;
  /** The pattern as written (a leading `!` and a trailing `/` included) */
  pattern: string;
  /** Whether it re-includes (`!`) */
  negated: boolean;
}

/**
 * Options for creating an IgnoreManager.
 */
export interface IgnoreManagerOptions {
  /** Repository root path */
  rootPath: string;

  /** Additional global patterns to always apply */
  globalPatterns?: string[];

  /** Whether to read .git/info/exclude */
  useInfoExclude?: boolean;
}

/**
 * Manages ignore rules from multiple sources.
 *
 * Sources checked (in order of priority):
 * 1. Patterns from .gitignore files (directory-specific)
 * 2. Patterns from .git/info/exclude
 * 3. Global patterns from configuration
 *
 * Later rules take precedence over earlier rules.
 */
export interface IgnoreManager {
  /**
   * Check if a path should be ignored.
   *
   * @param path Path relative to repository root
   * @param isDirectory Whether the path is a directory
   * @param commandLine Rules given on the command line (git's `EXC_CMDL`, `git clean -e`):
   *   asked before every other source, for this check only
   * @returns true if the path should be ignored
   */
  isIgnored(path: string, isDirectory: boolean, commandLine?: IgnoreNode): boolean;

  /**
   * Get detailed ignore status for a path.
   *
   * @param path Path relative to repository root
   * @param isDirectory Whether the path is a directory
   * @param commandLine Rules given on the command line, asked first (see {@link isIgnored})
   * @returns Match result with full status
   */
  getStatus(path: string, isDirectory: boolean, commandLine?: IgnoreNode): MatchResultValue;

  /**
   * git's `last_matching_pattern`: the pattern of the first leading directory an ignoring
   * pattern excludes, else the path's own last matching pattern (negated ones too); undefined
   * when nothing matches.
   */
  matchingPattern?(path: string, isDirectory: boolean): IgnoreMatch | undefined;

  /**
   * Add ignore patterns from a gitignore file at a specific path.
   *
   * @param dirPath Directory path where the .gitignore is located
   * @param content Content of the .gitignore file
   */
  addIgnoreFile(dirPath: string, content: string): void;

  /**
   * Set (replace) the rules of the `.gitignore` in `dirPath`; `undefined` removes them
   * (the file is gone). Rules read again never pile up on the old ones.
   */
  setIgnoreFile?(dirPath: string, content: string | undefined): void;

  /**
   * Set (replace) the rules of a named exclude file (`info/exclude`, `core.excludesFile`),
   * checked after every `.gitignore`, in the order first set; `undefined` removes them.
   */
  setExcludeFile?(source: string, content: string | undefined): void;

  /**
   * Match ASCII letters in either case from now on (`core.ignoreCase`), as git does: `*.TXT`
   * then ignores `a.txt`, while `É` and `é` stay different bytes.
   */
  setIgnoreCase?(ignoreCase: boolean): void;

  /**
   * Add global patterns that apply to all paths.
   *
   * @param patterns Array of gitignore patterns
   */
  addGlobalPatterns(patterns: string[]): void;

  /**
   * Clear all loaded rules.
   */
  clear(): void;
}

/**
 * Create an ignore rule from a pattern string.
 */
export interface IgnoreRuleFactory {
  create(pattern: string): IgnoreRule;
}

/**
 * Create an ignore node to hold multiple rules.
 */
export interface IgnoreNodeFactory {
  create(): IgnoreNode;
}
