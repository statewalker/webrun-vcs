/**
 * Git ignore manager implementation.
 *
 * Manages ignore rules from multiple sources:
 * - Per-directory .gitignore files
 * - Repository .git/info/exclude
 * - Global patterns
 *
 * Rules are evaluated in order, with later rules taking precedence. As in git, a path
 * inside an ignored directory is ignored and cannot be re-included (`build/` then
 * `!build/keep.txt` leaves keep.txt ignored). Each source is replaced, never appended to,
 * when it is set again, so a reread file never leaves its old rules behind.
 */

import { foldAsciiCase } from "@statewalker/vcs-utils/encoding";

import type {
  IgnoreManager,
  IgnoreMatch,
  IgnoreNode,
  IgnoreSource,
  MatchResultValue,
} from "./ignore-manager.js";
import { MatchResult } from "./ignore-manager.js";
import { createIgnoreNode } from "./ignore-node.js";
import { createIgnoreRule } from "./ignore-rule.js";

/**
 * Options for creating a GitIgnoreManager.
 */
export interface GitIgnoreManagerOptions {
  /** Global patterns that apply to all paths */
  globalPatterns?: string[];
  /** Match ASCII letters in either case (`core.ignoreCase`); default false */
  ignoreCase?: boolean;
}

/**
 * Create a GitIgnoreManager.
 */
export function createIgnoreManager(options?: GitIgnoreManagerOptions): IgnoreManager {
  return new GitIgnoreManagerImpl(options);
}

/**
 * git's `EXC_CMDL` pattern list: rules given on the command line (`git clean -e <pattern>`),
 * each taken whole as `add_pattern` takes it (no comment lines, no trailing-space trimming),
 * relative to the top of the worktree. Pass it to {@link IgnoreManager.isIgnored} (or a
 * walk's `excludePatterns`): it is asked before the `.gitignore` files and exclude files.
 *
 * @example
 * ```typescript
 * const cmdl = createCommandLineExcludes(["*.o", "!keep.o"]);
 * commandLineExcluded(cmdl, "a.o", false); // true
 * ```
 */
export function createCommandLineExcludes(patterns: readonly string[]): IgnoreNode {
  // add_pattern never reads a comment: a leading `#` (after `!` too) is part of the pattern,
  // escaped here so the rule parser (a .gitignore line's) takes it literally
  const literal = (p: string) =>
    p.startsWith("#") ? `\\${p}` : p.startsWith("!#") ? `!\\${p.slice(1)}` : p;
  const rules = patterns.filter((p) => p.length > 0).map((p) => createIgnoreRule(literal(p)));
  return createIgnoreNode(rules.filter((rule) => !rule.isEmpty));
}

/**
 * Whether command-line rules alone exclude `path`: the path itself, or one of its leading
 * directories (git's `prep_exclude` keeps an excluded directory's pattern for everything
 * below it). What `git clean -x -e <pattern>` asks, with no standard excludes set up.
 */
export function commandLineExcluded(
  node: IgnoreNode,
  path: string,
  isDirectory: boolean,
  ignoreCase = false,
): boolean {
  const parts = path.split("/").filter((p) => p.length > 0);
  for (let k = 1; k <= parts.length; k++) {
    const last = k === parts.length;
    if (node.checkIgnored(parts.slice(0, k).join("/"), last ? isDirectory : true, ignoreCase)) {
      return true;
    }
  }
  return false;
}

/**
 * Node tracking ignore rules for a specific directory.
 */
interface DirectoryIgnoreNode {
  /** Directory path (relative to root, no trailing slash) */
  path: string;
  /** Ignore rules for this directory */
  node: IgnoreNode;
}

class GitIgnoreManagerImpl implements IgnoreManager {
  /** Global patterns (from git config, etc.) */
  private globalNode: IgnoreNode;

  /** Per-directory ignore nodes, sorted by path depth (deepest first) */
  private directoryNodes: DirectoryIgnoreNode[] = [];

  /** Named exclude files (`info/exclude`, `core.excludesFile`), in precedence order */
  private excludeNodes = new Map<string, IgnoreNode>();

  /** `core.ignoreCase`: rules match ASCII letters in either case */
  private ignoreCase: boolean;

  constructor(options?: GitIgnoreManagerOptions) {
    this.ignoreCase = options?.ignoreCase === true;
    this.globalNode = createIgnoreNode();
    if (options?.globalPatterns) {
      this.globalNode.parse(options.globalPatterns.join("\n"));
    }
  }

  isIgnored(path: string, isDirectory: boolean, commandLine?: IgnoreNode): boolean {
    const status = this.getStatus(path, isDirectory, commandLine);
    return status === MatchResult.IGNORED;
  }

  getStatus(path: string, isDirectory: boolean, commandLine?: IgnoreNode): MatchResultValue {
    // Normalize path (remove leading/trailing slashes)
    const normalizedPath = this.normalizePath(path);
    // a path inside an ignored directory is ignored, whatever its own rules say (git never
    // descends into an excluded directory, so nothing in it can be re-included)
    const parts = normalizedPath.split("/");
    for (let k = 1; k < parts.length; k++) {
      const dir = parts.slice(0, k).join("/");
      if (this.statusOf(dir, true, commandLine) === MatchResult.IGNORED) {
        return MatchResult.IGNORED;
      }
    }
    return this.statusOf(normalizedPath, isDirectory, commandLine);
  }

  matchingPattern(path: string, isDirectory: boolean): IgnoreMatch | undefined {
    const normalizedPath = this.normalizePath(path);
    const parts = normalizedPath.split("/");
    // prep_exclude: an excluded leading directory decides for everything below it
    for (let k = 1; k < parts.length; k++) {
      const found = this.matchOf(parts.slice(0, k).join("/"), true);
      if (found && !found.negated) return found;
    }
    return normalizedPath === "" ? undefined : this.matchOf(normalizedPath, isDirectory);
  }

  /** The last matching pattern of `normalizedPath` by the rules alone. */
  private matchOf(normalizedPath: string, isDirectory: boolean): IgnoreMatch | undefined {
    const matchIn = (node: IgnoreNode, relative: string, source: IgnoreSource) => {
      const found = node.matchingRule?.(relative, isDirectory, this.ignoreCase);
      if (!found) return undefined;
      return {
        source,
        line: found.line,
        pattern: found.rule.pattern,
        negated: found.rule.isNegated,
      };
    };
    for (const dirNode of this.directoryNodes) {
      // a directory's own .gitignore is read only for what lies below it
      if (dirNode.path !== "" && this.sameDirectory(normalizedPath, dirNode.path)) continue;
      if (!this.isUnderDirectory(normalizedPath, dirNode.path)) continue;
      const relative = this.getRelativePath(normalizedPath, dirNode.path);
      const found = matchIn(dirNode.node, relative, {
        kind: "directory",
        directory: dirNode.path,
      });
      if (found) return found;
    }
    const rank = (source: string) =>
      source === "info/exclude" ? 0 : source === "core.excludesFile" ? 1 : 2;
    for (const name of [...this.excludeNodes.keys()].sort((a, b) => rank(a) - rank(b))) {
      const node = this.excludeNodes.get(name) as IgnoreNode;
      const found = matchIn(node, normalizedPath, { kind: "exclude", name });
      if (found) return found;
    }
    return matchIn(this.globalNode, normalizedPath, { kind: "global" });
  }

  private sameDirectory(path: string, dirPath: string): boolean {
    return this.ignoreCase ? foldAsciiCase(path) === foldAsciiCase(dirPath) : path === dirPath;
  }

  /** The status of `normalizedPath` by the rules alone, its directories not considered. */
  private statusOf(
    normalizedPath: string,
    isDirectory: boolean,
    commandLine?: IgnoreNode,
  ): MatchResultValue {
    // the command line's rules first (last_matching_pattern_from_lists: EXC_CMDL)
    if (commandLine) {
      const result = commandLine.checkIgnored(normalizedPath, isDirectory, this.ignoreCase);
      if (result !== undefined) return result ? MatchResult.IGNORED : MatchResult.NOT_IGNORED;
    }
    // Check directory-specific nodes first (most specific to least)
    for (const dirNode of this.directoryNodes) {
      // Only check if this path is under this directory
      if (this.isUnderDirectory(normalizedPath, dirNode.path)) {
        const relativePath = this.getRelativePath(normalizedPath, dirNode.path);
        const result = dirNode.node.checkIgnored(relativePath, isDirectory, this.ignoreCase);

        if (result !== undefined) {
          return result ? MatchResult.IGNORED : MatchResult.NOT_IGNORED;
        }
      }
    }

    // Then the exclude files: info/exclude before core.excludesFile, whatever the order
    // they were set in, then any other source in the order first set
    const rank = (source: string) =>
      source === "info/exclude" ? 0 : source === "core.excludesFile" ? 1 : 2;
    const sources = [...this.excludeNodes.keys()].sort((a, b) => rank(a) - rank(b));
    for (const node of sources.map((source) => this.excludeNodes.get(source) as IgnoreNode)) {
      const result = node.checkIgnored(normalizedPath, isDirectory, this.ignoreCase);
      if (result !== undefined) return result ? MatchResult.IGNORED : MatchResult.NOT_IGNORED;
    }

    // Check global patterns
    const globalResult = this.globalNode.checkIgnored(normalizedPath, isDirectory, this.ignoreCase);
    if (globalResult !== undefined) {
      return globalResult ? MatchResult.IGNORED : MatchResult.NOT_IGNORED;
    }

    return MatchResult.CHECK_PARENT;
  }

  addIgnoreFile(dirPath: string, content: string): void {
    this.setIgnoreFile(dirPath, content);
  }

  setExcludeFile(source: string, content: string | undefined): void {
    if (content === undefined) {
      this.excludeNodes.delete(source);
      return;
    }
    const node = createIgnoreNode();
    node.parse(content);
    this.excludeNodes.set(source, node);
  }

  setIgnoreFile(dirPath: string, content: string | undefined): void {
    const normalizedDir = this.normalizePath(dirPath);
    // the directory's previous rules go: a reread file replaces them
    this.directoryNodes = this.directoryNodes.filter((n) => n.path !== normalizedDir);
    if (content === undefined) return;
    const node = createIgnoreNode();
    node.parse(content);

    // Insert sorted by path depth (deepest first)
    const depth = this.getPathDepth(normalizedDir);
    let insertIdx = 0;
    for (let i = 0; i < this.directoryNodes.length; i++) {
      const existingDepth = this.getPathDepth(this.directoryNodes[i].path);
      if (depth > existingDepth) {
        break;
      }
      insertIdx = i + 1;
    }

    this.directoryNodes.splice(insertIdx, 0, {
      path: normalizedDir,
      node,
    });
  }

  setIgnoreCase(ignoreCase: boolean): void {
    this.ignoreCase = ignoreCase;
  }

  addGlobalPatterns(patterns: string[]): void {
    this.globalNode.parse(patterns.join("\n"));
  }

  clear(): void {
    this.globalNode = createIgnoreNode();
    this.directoryNodes = [];
    this.excludeNodes = new Map();
  }

  /**
   * Normalize a path by removing leading/trailing slashes.
   */
  private normalizePath(path: string): string {
    let result = path;
    while (result.startsWith("/")) {
      result = result.substring(1);
    }
    while (result.endsWith("/")) {
      result = result.substring(0, result.length - 1);
    }
    return result;
  }

  /**
   * Check if a path is under a directory. With `core.ignoreCase` the directory part
   * compares with ASCII case folded, as git's `fspathncmp` does.
   */
  private isUnderDirectory(path: string, dirPath: string): boolean {
    if (dirPath === "" || dirPath === ".") {
      return true;
    }
    const [p, d] = this.ignoreCase
      ? [foldAsciiCase(path), foldAsciiCase(dirPath)]
      : [path, dirPath];
    return p === d || p.startsWith(`${d}/`);
  }

  /**
   * Get path relative to a directory.
   */
  private getRelativePath(path: string, dirPath: string): string {
    if (dirPath === "" || dirPath === ".") {
      return path;
    }
    if (path === dirPath) {
      return "";
    }
    return path.substring(dirPath.length + 1);
  }

  /**
   * Get the depth of a path (number of segments).
   */
  private getPathDepth(path: string): number {
    if (path === "" || path === ".") {
      return 0;
    }
    let count = 1;
    for (let i = 0; i < path.length; i++) {
      if (path.charAt(i) === "/") {
        count++;
      }
    }
    return count;
  }
}
