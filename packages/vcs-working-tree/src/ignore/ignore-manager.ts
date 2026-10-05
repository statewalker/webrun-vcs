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
   * @returns true if ignored, false if explicitly not ignored, undefined if no match
   */
  checkIgnored(entryPath: string, isDirectory: boolean): boolean | undefined;

  /** All rules in this node */
  readonly rules: readonly IgnoreRule[];

  /**
   * Parse ignore rules from text content.
   *
   * @param content Content of gitignore file
   */
  parse(content: string): void;
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
   * @returns true if the path should be ignored
   */
  isIgnored(path: string, isDirectory: boolean): boolean;

  /**
   * Get detailed ignore status for a path.
   *
   * @param path Path relative to repository root
   * @param isDirectory Whether the path is a directory
   * @returns Match result with full status
   */
  getStatus(path: string, isDirectory: boolean): MatchResultValue;

  /**
   * Add ignore patterns from a gitignore file at a specific path.
   *
   * @param dirPath Directory path where the .gitignore is located
   * @param content Content of the .gitignore file
   */
  addIgnoreFile(dirPath: string, content: string): void;

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
