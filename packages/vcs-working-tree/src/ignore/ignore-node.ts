/**
 * Ignore node implementation.
 *
 * Represents a bundle of ignore rules from a single source
 * (e.g., one .gitignore file).
 */

import type { IgnoreNode, IgnoreRule, MatchResultValue } from "./ignore-manager.js";
import { MatchResult } from "./ignore-manager.js";
import { createIgnoreRule, trimTrailingSpaces } from "./ignore-rule.js";

/**
 * Create an ignore node from optional initial rules.
 */
export function createIgnoreNode(initialRules?: IgnoreRule[]): IgnoreNode {
  return new GitIgnoreNode(initialRules);
}

class GitIgnoreNode implements IgnoreNode {
  private readonly _rules: IgnoreRule[] = [];
  /** The line of each rule in the parsed text (0 for rules given otherwise) */
  private readonly lines: number[] = [];

  constructor(initialRules?: IgnoreRule[]) {
    if (initialRules) {
      this._rules.push(...initialRules);
      this.lines.push(...initialRules.map(() => 0));
    }
  }

  get rules(): readonly IgnoreRule[] {
    return this._rules;
  }

  parse(content: string): void {
    // as git's add_patterns_from_buffer: a line's CR goes, then its unescaped trailing
    // spaces; empty lines and comments are skipped
    const lines = content
      .split("\n")
      .map((line) => trimTrailingSpaces(line.endsWith("\r") ? line.slice(0, -1) : line));
    let _lineNumber = 1;

    for (const line of lines) {
      // Skip empty lines and comments
      if (line.length === 0) {
        _lineNumber++;
        continue;
      }

      // Skip comment lines
      if (line.startsWith("#")) {
        _lineNumber++;
        continue;
      }

      // Skip single slash (not a valid pattern)
      if (line === "/") {
        _lineNumber++;
        continue;
      }

      try {
        const rule = createIgnoreRule(line);
        if (!rule.isEmpty) {
          this._rules.push(rule);
          this.lines.push(_lineNumber);
        }
      } catch (_error) {
        // Skip invalid patterns (JGit logs but continues)
        // console.warn(`Invalid ignore pattern at line ${lineNumber}: ${line}`);
      }

      _lineNumber++;
    }
  }

  isIgnored(entryPath: string, isDirectory: boolean): MatchResultValue {
    const result = this.checkIgnored(entryPath, isDirectory);
    if (result === undefined) {
      return MatchResult.CHECK_PARENT;
    }
    return result ? MatchResult.IGNORED : MatchResult.NOT_IGNORED;
  }

  checkIgnored(entryPath: string, isDirectory: boolean, ignoreCase = false): boolean | undefined {
    const found = this.matchingRule(entryPath, isDirectory, ignoreCase);
    // true if ignoring, false if negated (un-ignoring)
    return found === undefined ? undefined : !found.rule.isNegated;
  }

  matchingRule(
    entryPath: string,
    isDirectory: boolean,
    ignoreCase = false,
  ): { rule: IgnoreRule; line: number } | undefined {
    // later rules have higher priority
    for (let i = this._rules.length - 1; i >= 0; i--) {
      const rule = this._rules[i];
      const matched = rule.matchesPath
        ? rule.matchesPath(entryPath, isDirectory, ignoreCase)
        : rule.isMatchWithMode(entryPath, isDirectory, true);
      if (matched) return { rule, line: this.lines[i] ?? 0 };
    }
    return undefined;
  }
}
