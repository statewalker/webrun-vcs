/**
 * Tests for Git ignore rule pattern matching.
 *
 * Based on JGit's FastIgnoreRuleTest.java.
 * Tests comprehensive gitignore pattern syntax including:
 * - Character classes [a], [v-z]
 * - Wildcards *, ?, **
 * - Path segments and anchoring /a, a/
 * - Negation patterns !pattern
 * - Directory-only patterns dir/
 */

import { describe, expect, it } from "vitest";
import { createIgnoreManager } from "../../src/ignore/ignore-manager.impl.js";
import { MatchResult } from "../../src/ignore/ignore-manager.js";
import { createIgnoreNode } from "../../src/ignore/ignore-node.js";
import { createIgnoreRule } from "../../src/ignore/ignore-rule.js";

/**
 * Helper: Check if pattern matches path.
 * If path ends with "/", assumes directory.
 */
function match(pattern: string, path: string, pathMatch = false): boolean {
  const isDirectory = path.endsWith("/");
  const rule = createIgnoreRule(pattern);
  let result = rule.isMatchWithMode(path, isDirectory, pathMatch);
  if (rule.isNegated) {
    result = !result;
  }
  return result;
}

/**
 * Assert that pattern matches path.
 * Also verifies that negated pattern does NOT match.
 */
function assertMatched(pattern: string, path: string, pathMatch = false): void {
  const isMatch = match(pattern, path, pathMatch);
  expect(isMatch, `Expected '${pattern}' to match '${path}'`).toBe(true);

  // Verify negation inverts result
  const negatedPattern = pattern.startsWith("!") ? pattern.substring(1) : `!${pattern}`;
  const negatedMatch = match(negatedPattern, path, pathMatch);
  expect(negatedMatch, `Expected '${negatedPattern}' to NOT match '${path}'`).toBe(false);
}

/**
 * Assert that pattern does NOT match path.
 * Also verifies that negated pattern DOES match.
 */
function assertNotMatched(pattern: string, path: string, pathMatch = false): void {
  const isMatch = match(pattern, path, pathMatch);
  expect(isMatch, `Expected '${pattern}' to NOT match '${path}'`).toBe(false);

  // Verify negation inverts result
  const negatedPattern = pattern.startsWith("!") ? pattern.substring(1) : `!${pattern}`;
  const negatedMatch = match(negatedPattern, path, pathMatch);
  expect(negatedMatch, `Expected '${negatedPattern}' to match '${path}'`).toBe(true);
}

describe("ignore-rule (based on JGit FastIgnoreRuleTest)", () => {
  describe("testSimpleCharClass", () => {
    it("matches [a] patterns", () => {
      assertMatched("][a]", "]a");
      assertMatched("[a]", "a");
      assertMatched("][a]", "]a");
      assertMatched("[a]", "a/");
      assertMatched("[a]", "a/b");
    });

    it("matches [a] in nested paths", () => {
      assertMatched("[a]", "b/a");
      assertMatched("[a]", "b/a/");
      assertMatched("[a]", "b/a/b");
      assertMatched("[a]", "/a/");
      assertMatched("[a]", "/a/b");
      assertMatched("[a]", "c/a/b");
      assertMatched("[a]", "c/b/a");
    });

    it("matches /[a] anchored patterns", () => {
      assertMatched("/[a]", "a");
      assertMatched("/[a]", "a/");
      assertMatched("/[a]", "a/b");
      assertMatched("/[a]", "/a");
      assertMatched("/[a]", "/a/");
      assertMatched("/[a]", "/a/b");
    });

    it("matches [a]/ directory patterns", () => {
      assertMatched("[a]/", "a/");
      assertMatched("[a]/", "a/b");
      assertMatched("[a]/", "/a/");
      assertMatched("[a]/", "/a/b");
    });

    it("matches /[a]/ anchored directory patterns", () => {
      assertMatched("/[a]/", "a/");
      assertMatched("/[a]/", "a/b");
      assertMatched("/[a]/", "/a/");
      assertMatched("/[a]/", "/a/b");
    });
  });

  describe("testCharClass", () => {
    it("matches [v-z] range patterns", () => {
      assertMatched("[v-z]", "x");
      assertMatched("[v-z]", "x/");
      assertMatched("[v-z]", "x/b");
    });

    it("matches [v-z] in nested paths", () => {
      assertMatched("[v-z]", "b/x");
      assertMatched("[v-z]", "b/x/");
      assertMatched("[v-z]", "b/x/b");
      assertMatched("[v-z]", "/x/");
      assertMatched("[v-z]", "/x/b");
      assertMatched("[v-z]", "c/x/b");
      assertMatched("[v-z]", "c/b/x");
    });

    it("matches /[v-z] anchored patterns", () => {
      assertMatched("/[v-z]", "x");
      assertMatched("/[v-z]", "x/");
      assertMatched("/[v-z]", "x/b");
      assertMatched("/[v-z]", "/x");
      assertMatched("/[v-z]", "/x/");
      assertMatched("/[v-z]", "/x/b");
    });

    it("matches [v-z]/ directory patterns", () => {
      assertMatched("[v-z]/", "x/");
      assertMatched("[v-z]/", "x/b");
      assertMatched("[v-z]/", "/x/");
      assertMatched("[v-z]/", "/x/b");
    });

    it("matches /[v-z]/ anchored directory patterns", () => {
      assertMatched("/[v-z]/", "x/");
      assertMatched("/[v-z]/", "x/b");
      assertMatched("/[v-z]/", "/x/");
      assertMatched("/[v-z]/", "/x/b");
    });
  });

  describe("testTrailingSpaces", () => {
    it("ignores trailing spaces", () => {
      assertMatched("a ", "a");
      assertMatched("a/ ", "a/");
      assertMatched("a/ ", "a/b");
    });

    it("handles escaped trailing spaces", () => {
      assertMatched("a/\\ ", "a/ ");
      assertNotMatched("a/\\ ", "a/");
      assertNotMatched("a/\\ ", "a/b");
      assertNotMatched("/ ", "a");
    });
  });

  describe("testAsteriskDot", () => {
    it("matches *.a patterns", () => {
      assertMatched("*.a", ".a");
      assertMatched("*.a", "/.a");
      assertMatched("*.a", "a.a");
      assertMatched("*.a", "/b.a");
      assertMatched("*.a", "b.a");
      assertMatched("*.a", "/a/b.a");
      assertMatched("*.a", "/b/.a");
    });

    it("does not match *.a for wrong extensions", () => {
      assertNotMatched("*.a", ".ab");
      assertNotMatched("*.a", "/.ab");
      assertNotMatched("*.a", "/b.ba");
      assertNotMatched("*.a", "a.ab");
      assertNotMatched("*.a", "/b.ab");
      assertNotMatched("*.a", "b.ab");
      assertNotMatched("*.a", "/a/b.ab");
      assertNotMatched("*.a", "/b/.ab");
    });
  });

  describe("testDotAsteriskMatch", () => {
    it("matches a.* patterns", () => {
      assertMatched("a.*", "a.");
      assertMatched("a.*", "a./");
      assertMatched("a.*", "a.b");
    });

    it("matches a.* in nested paths", () => {
      assertMatched("a.*", "b/a.b");
      assertMatched("a.*", "b/a.b/");
      assertMatched("a.*", "b/a.b/b");
      assertMatched("a.*", "/a.b/");
      assertMatched("a.*", "/a.b/b");
      assertMatched("a.*", "c/a.b/b");
      assertMatched("a.*", "c/b/a.b");
    });

    it("matches /a.* anchored patterns", () => {
      assertMatched("/a.*", "a.b");
      assertMatched("/a.*", "a.b/");
      assertMatched("/a.*", "a.b/b");
      assertMatched("/a.*", "/a.b");
      assertMatched("/a.*", "/a.b/");
      assertMatched("/a.*", "/a.b/b");
    });

    it("matches /a.*/b path patterns", () => {
      assertMatched("/a.*/b", "a.b/b");
      assertMatched("/a.*/b", "/a.b/b");
      assertMatched("/a.*/b", "/a.bc/b");
      assertMatched("/a.*/b", "/a./b");
    });
  });

  describe("testAsterisk", () => {
    it("matches a* patterns", () => {
      assertMatched("a*", "a");
      assertMatched("a*", "a/");
      assertMatched("a*", "ab");
    });

    it("matches a* in nested paths", () => {
      assertMatched("a*", "b/ab");
      assertMatched("a*", "b/ab/");
      assertMatched("a*", "b/ab/b");
      assertMatched("a*", "b/abc");
      assertMatched("a*", "b/abc/");
      assertMatched("a*", "b/abc/b");
      assertMatched("a*", "/abc/");
      assertMatched("a*", "/abc/b");
      assertMatched("a*", "c/abc/b");
      assertMatched("a*", "c/b/abc");
    });

    it("matches /a* anchored patterns", () => {
      assertMatched("/a*", "abc");
      assertMatched("/a*", "abc/");
      assertMatched("/a*", "abc/b");
      assertMatched("/a*", "/abc");
      assertMatched("/a*", "/abc/");
      assertMatched("/a*", "/abc/b");
    });

    it("matches /a*/b path patterns", () => {
      assertMatched("/a*/b", "abc/b");
      assertMatched("/a*/b", "/abc/b");
      assertMatched("/a*/b", "/abcd/b");
      assertMatched("/a*/b", "/a/b");
    });
  });

  describe("testQuestionmark", () => {
    it("matches a? patterns", () => {
      assertMatched("a?", "ab");
      assertMatched("a?", "ab/");
    });

    it("matches a? in nested paths", () => {
      assertMatched("a?", "b/ab");
      assertMatched("a?", "b/ab/");
      assertMatched("a?", "b/ab/b");
      assertMatched("a?", "/ab/");
      assertMatched("a?", "/ab/b");
      assertMatched("a?", "c/ab/b");
      assertMatched("a?", "c/b/ab");
    });

    it("matches /a? anchored patterns", () => {
      assertMatched("/a?", "ab");
      assertMatched("/a?", "ab/");
      assertMatched("/a?", "ab/b");
      assertMatched("/a?", "/ab");
      assertMatched("/a?", "/ab/");
      assertMatched("/a?", "/ab/b");
    });

    it("matches /a?/b path patterns", () => {
      assertMatched("/a?/b", "ab/b");
      assertMatched("/a?/b", "/ab/b");
    });

    it("does not match when ? should match nothing or multiple chars", () => {
      assertNotMatched("a?", "a/");
      assertNotMatched("a?", "abc");
      assertNotMatched("a?", "abc/");
      assertNotMatched("a?", "b/abc");
      assertNotMatched("a?", "b/abc/");
      assertNotMatched("a?", "/abc/");
      assertNotMatched("a?", "/abc/b");
      assertNotMatched("a?", "c/abc/b");
      assertNotMatched("a?", "c/b/abc");
    });

    it("does not match /a? for wrong lengths", () => {
      assertNotMatched("/a?", "abc");
      assertNotMatched("/a?", "abc/");
      assertNotMatched("/a?", "abc/b");
      assertNotMatched("/a?", "/abc");
      assertNotMatched("/a?", "/abc/");
      assertNotMatched("/a?", "/abc/b");
    });

    it("does not match /a?/b for wrong patterns", () => {
      assertNotMatched("/a?/b", "abc/b");
      assertNotMatched("/a?/b", "/abc/b");
      assertNotMatched("/a?/b", "/a/b");
    });
  });

  describe("testSimplePatterns", () => {
    it("matches simple 'a' pattern", () => {
      assertMatched("a", "a");
      assertMatched("a", "a/");
      assertMatched("a", "a/b");
    });

    it("matches 'a' in nested paths", () => {
      assertMatched("a", "b/a");
      assertMatched("a", "b/a/");
      assertMatched("a", "b/a/b");
      assertMatched("a", "/a/");
      assertMatched("a", "/a/b");
      assertMatched("a", "c/a/b");
      assertMatched("a", "c/b/a");
    });

    it("matches /a anchored patterns", () => {
      assertMatched("/a", "a");
      assertMatched("/a", "a/");
      assertMatched("/a", "a/b");
      assertMatched("/a", "/a");
      assertMatched("/a", "/a/");
      assertMatched("/a", "/a/b");
    });

    it("matches a/ directory patterns", () => {
      assertMatched("a/", "a/");
      assertMatched("a/", "a/b");
      assertMatched("a/", "/a/");
      assertMatched("a/", "/a/b");
    });

    it("matches /a/ anchored directory patterns", () => {
      assertMatched("/a/", "a/");
      assertMatched("/a/", "a/b");
      assertMatched("/a/", "/a/");
      assertMatched("/a/", "/a/b");
    });

    it("does not match simple patterns incorrectly", () => {
      assertNotMatched("ab", "a");
      assertNotMatched("abc", "a/");
      assertNotMatched("abc", "a/b");
      assertNotMatched("a", "ab");
      assertNotMatched("a", "ba");
      assertNotMatched("a", "aa");
      assertNotMatched("a", "b/ab");
      assertNotMatched("a", "b/ba");
      assertNotMatched("a", "b/ba/");
      assertNotMatched("a", "b/ba/b");
      assertNotMatched("a", "/aa");
      assertNotMatched("a", "aa/");
      assertNotMatched("a", "/aa/");
    });

    it("does not match /a patterns for nested paths", () => {
      assertNotMatched("/a", "b/a");
      assertNotMatched("/a", "/b/a/");
    });

    it("does not match a/ for non-directories", () => {
      assertNotMatched("a/", "a");
      assertNotMatched("a/", "b/a");
    });

    it("does not match /a/ for non-directories", () => {
      assertNotMatched("/a/", "a");
      assertNotMatched("/a/", "/a");
      assertNotMatched("/a/", "b/a");
    });
  });

  describe("testSegments", () => {
    it("matches /a/b path segments", () => {
      assertMatched("/a/b", "a/b");
      assertMatched("/a/b", "/a/b");
      assertMatched("/a/b", "/a/b/");
      assertMatched("/a/b", "/a/b/c");
    });

    it("matches a/b path segments", () => {
      assertMatched("a/b", "a/b");
      assertMatched("a/b", "/a/b");
      assertMatched("a/b", "/a/b/");
      assertMatched("a/b", "/a/b/c");
    });

    it("matches a/b/ directory path segments", () => {
      assertMatched("a/b/", "a/b/");
      assertMatched("a/b/", "/a/b/");
      assertMatched("a/b/", "/a/b/c");
    });

    it("does not match wrong segments", () => {
      assertNotMatched("a/b", "/a/bb");
      assertNotMatched("a/b", "/aa/b");
      assertNotMatched("a/b", "a/bb");
      assertNotMatched("a/b", "aa/b");
      assertNotMatched("a/b", "c/aa/b");
      assertNotMatched("a/b", "c/a/bb");
    });

    it("does not match directory patterns for non-directories", () => {
      assertNotMatched("a/b/", "/a/b");
      assertNotMatched("/a/b/", "/a/b");
    });

    it("does not match anchored paths in nested dirs", () => {
      assertNotMatched("/a/b", "c/a/b");
      assertNotMatched("/a/b/", "c/a/b");
      assertNotMatched("/a/b/", "c/a/b/");
    });

    // JGit: "XXX why is it like this????"
    it("does not match a/b in deeply nested paths", () => {
      assertNotMatched("a/b", "c/a/b");
      assertNotMatched("a/b", "c/a/b/");
      assertNotMatched("a/b", "c/a/b/c");
      assertNotMatched("a/b/", "c/a/b/");
      assertNotMatched("a/b/", "c/a/b/c");
    });
  });

  describe("testWildmatch", () => {
    it("matches **/a/b patterns", () => {
      assertMatched("**/a/b", "a/b");
      assertMatched("**/a/b", "c/a/b");
      assertMatched("**/a/b", "c/d/a/b");
      assertMatched("**/**/a/b", "c/d/a/b");
    });

    it("matches /**/a/b patterns", () => {
      assertMatched("/**/a/b", "a/b");
      assertMatched("/**/a/b", "c/a/b");
      assertMatched("/**/a/b", "c/d/a/b");
      assertMatched("/**/**/a/b", "c/d/a/b");
    });

    it("matches a/b/** patterns", () => {
      assertMatched("a/b/**", "a/b/c");
      assertMatched("a/b/**", "a/b/c/d/");
      assertMatched("a/b/**/**", "a/b/c/d");
    });

    it("matches **/a/**/b patterns", () => {
      assertMatched("**/a/**/b", "c/d/a/b");
      assertMatched("**/a/**/b", "c/d/a/e/b");
      assertMatched("**/**/a/**/**/b", "c/d/a/e/b");
    });

    it("matches /**/a/**/b patterns", () => {
      assertMatched("/**/a/**/b", "c/d/a/b");
      assertMatched("/**/a/**/b", "c/d/a/e/b");
      assertMatched("/**/**/a/**/**/b", "c/d/a/e/b");
    });

    it("matches a/**/b patterns", () => {
      assertMatched("a/**/b", "a/b");
      assertMatched("a/**/b", "a/c/b");
      assertMatched("a/**/b", "a/c/d/b");
      assertMatched("a/**/**/b", "a/c/d/b");
    });

    it("matches a/**/b/**/c patterns", () => {
      assertMatched("a/**/b/**/c", "a/c/b/d/c");
      assertMatched("a/**/**/b/**/**/c", "a/c/b/d/c");
    });

    it("matches **/ directory patterns", () => {
      assertMatched("**/", "a/");
      assertMatched("**/", "a/b");
      assertMatched("**/", "a/b/c");
      assertMatched("**/**/", "a/");
      assertMatched("**/**/", "a/b");
      assertMatched("**/**/", "a/b/");
      assertMatched("**/**/", "a/b/c");
    });

    it("matches x/**/ patterns", () => {
      assertMatched("x/**/", "x/a/");
      assertMatched("x/**/", "x/a/b");
      assertMatched("x/**/", "x/a/b/");
    });

    it("matches **/x/ patterns", () => {
      assertMatched("**/x/", "a/x/");
      assertMatched("**/x/", "a/b/x/");
    });

    it("does not match a/** for empty match", () => {
      assertNotMatched("a/**", "a/");
      assertNotMatched("a/b/**", "a/b/");
      assertNotMatched("a/**", "a");
      assertNotMatched("a/b/**", "a/b");
      assertNotMatched("a/b/**/", "a/b");
      assertNotMatched("a/b/**/**", "a/b");
    });

    it("does not match **/a/b for wrong paths", () => {
      assertNotMatched("**/a/b", "a/c/b");
    });

    it("does not match negated wildmatch patterns", () => {
      assertNotMatched("!/**/*.zip", "c/a/b.zip");
      assertNotMatched("!**/*.zip", "c/a/b.zip");
    });

    it("does not match a/**/b for partial matches", () => {
      assertNotMatched("a/**/b", "a/c/bb");
    });

    it("does not match **/ for non-directories", () => {
      assertNotMatched("**/", "a");
      assertNotMatched("**/**/", "a");
      assertNotMatched("**/x/", "a/b/x");
    });
  });

  describe("testSimpleRules", () => {
    it("throws on null pattern", () => {
      expect(() => createIgnoreRule(null as unknown as string)).toThrow();
    });

    it("handles special patterns", () => {
      expect(createIgnoreRule("/").isMatch("/", false)).toBe(false);
      expect(createIgnoreRule("//").isMatch("//", false)).toBe(false);
      expect(createIgnoreRule("#").isMatch("#", false)).toBe(false);
      expect(createIgnoreRule("").isMatch("", false)).toBe(false);
      expect(createIgnoreRule(" ").isMatch(" ", false)).toBe(false);
    });
  });

  describe("testPathMatch", () => {
    it("matches with pathMatch=true", () => {
      assertMatched("a", "a", true);
      assertMatched("a/", "a/", true);
      assertNotMatched("a/", "a/b", true);

      assertMatched("**", "a", true);
      assertMatched("**", "a/", true);
      assertMatched("**", "a/b", true);
    });

    it("handles **/ with pathMatch=true", () => {
      assertNotMatched("**/", "a", true);
      assertNotMatched("**/", "a/b", true);
      assertMatched("**/", "a/", true);
      assertMatched("**/", "a/b/", true);
    });

    it("handles x/**/ with pathMatch=true", () => {
      assertNotMatched("x/**/", "x/a", true);
      assertNotMatched("x/**/", "x/a/b", true);
      assertMatched("x/**/", "x/a/", true);
      assertMatched("x/**/", "x/y/a/", true);
    });
  });

  describe("testFileNameWithLineTerminator", () => {
    it("matches patterns with carriage return", () => {
      assertMatched("a?", "a\r");
      assertMatched("a?", "dir/a\r");
      assertMatched("a?", "a\r/file");
      assertMatched("*a", "\ra");
      assertMatched("dir/*a*", "dir/\ra\r");
    });
  });
});

describe("IgnoreNode", () => {
  it("parses gitignore content", async () => {
    const node = createIgnoreNode();

    node.parse(`
# Comment line
*.log
!important.log
build/
/dist

# Empty lines are ignored

node_modules/
`);

    expect(node.rules.length).toBe(5);
    expect(node.rules[0].pattern).toBe("*.log");
    expect(node.rules[1].pattern).toBe("!important.log");
    expect(node.rules[1].isNegated).toBe(true);
    expect(node.rules[2].pattern).toBe("build/");
    expect(node.rules[2].dirOnly).toBe(true);
    expect(node.rules[3].pattern).toBe("/dist");
  });

  it("checks ignored status", async () => {
    const node = createIgnoreNode();

    node.parse(`
*.log
!important.log
build/
`);

    // Regular file matches *.log
    expect(node.isIgnored("test.log", false)).toBe(MatchResult.IGNORED);

    // important.log is negated
    expect(node.isIgnored("important.log", false)).toBe(MatchResult.NOT_IGNORED);

    // build directory
    expect(node.isIgnored("build", true)).toBe(MatchResult.IGNORED);

    // build as file should not match build/
    expect(node.isIgnored("build", false)).toBe(MatchResult.CHECK_PARENT);

    // No match
    expect(node.isIgnored("src/main.ts", false)).toBe(MatchResult.CHECK_PARENT);
  });
});

describe("IgnoreManager", () => {
  it("manages multiple ignore sources", async () => {
    const manager = createIgnoreManager();

    // Add root .gitignore
    manager.addIgnoreFile("", "*.log\nnode_modules/");

    // Add src/.gitignore
    manager.addIgnoreFile("src", "*.test.ts");

    expect(manager.isIgnored("debug.log", false)).toBe(true);
    expect(manager.isIgnored("node_modules", true)).toBe(true);
    expect(manager.isIgnored("src/utils.test.ts", false)).toBe(true);
    expect(manager.isIgnored("src/utils.ts", false)).toBe(false);
    expect(manager.isIgnored("test/utils.test.ts", false)).toBe(false);
  });

  it("respects priority of deeper gitignore files", () => {
    const manager = createIgnoreManager();

    // Root ignores all .log files
    manager.addIgnoreFile("", "*.log");

    // logs/ directory un-ignores .log files
    manager.addIgnoreFile("logs", "!*.log");

    expect(manager.isIgnored("debug.log", false)).toBe(true);
    expect(manager.isIgnored("logs/app.log", false)).toBe(false);
  });

  it("supports global patterns", async () => {
    const manager = createIgnoreManager({
      globalPatterns: ["*.DS_Store", "Thumbs.db"],
    });

    expect(manager.isIgnored(".DS_Store", false)).toBe(true);
    expect(manager.isIgnored("images/Thumbs.db", false)).toBe(true);
  });

  it("clears all rules", async () => {
    const manager = createIgnoreManager();

    manager.addIgnoreFile("", "*.log");
    expect(manager.isIgnored("test.log", false)).toBe(true);

    manager.clear();
    expect(manager.isIgnored("test.log", false)).toBe(false);
  });
});
