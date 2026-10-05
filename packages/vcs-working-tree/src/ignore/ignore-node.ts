/**
 * Ignore node implementation.
 *
 * Represents a bundle of ignore rules from a single source
 * (e.g., one .gitignore file).
 */

import type { IgnoreNode, IgnoreRule, MatchResultValue } from "./ignore-manager.js";
import { MatchResult } from "./ignore-manager.js";
import { createIgnoreRule } from "./ignore-rule.js";

/**
 * Create an ignore node from optional initial rules.
 */
export function createIgnoreNode(initialRules?: IgnoreRule[]): IgnoreNode {
  return new GitIgnoreNode(initialRules);
}

class GitIgnoreNode implements IgnoreNode {
  private readonly _rules: IgnoreRule[] = [];

  constructor(initialRules?: IgnoreRule[]) {
    if (initialRules) {
      this._rules.push(...initialRules);
    }
  }

  get rules(): readonly IgnoreRule[] {
    return this._rules;
  }

  parse(content: string): void {
    const lines = content.split(/\r?\n/);
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

  checkIgnored(entryPath: string, isDirectory: boolean): boolean | undefined {
    // Parse rules in reverse order (later rules have higher priority)
    for (let i = this._rules.length - 1; i >= 0; i--) {
      const rule = this._rules[i];
      if (rule.isMatchWithMode(entryPath, isDirectory, true)) {
        // Return true if ignoring, false if negated (un-ignoring)
        return !rule.isNegated;
      }
    }
    return undefined;
  }
}
