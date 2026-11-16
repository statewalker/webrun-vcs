/**
 * The builtin diff drivers on adversarial lines: repeated tokens that make nested
 * quantifiers backtrack exponentially in a backtracking matcher (the `csharp` pattern on
 * `List<int> List<int> ...;` took seconds), and lines of 8 KiB and more of blanks or
 * identifier characters (quadratic in a matcher that retries every start). The POSIX
 * matcher stays linear: each line must take well under a second, on every driver of both
 * tables.
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_FUNCNAME_PATTERNS,
  BUILTIN_FUNCNAME_PATTERNS_2_43,
  unifiedDiff,
  userdiffFindFunction,
} from "../../../src/diff/text-diff/index.js";

const enc = new TextEncoder();

const ADVERSARIAL = [
  `${"List<int> ".repeat(200)};`,
  `${"List<int> ".repeat(24)};`,
  `  ${"Dictionary<string, List<int>> ".repeat(100)}x`,
  `${"public ".repeat(1500)}(`,
  `${"static ".repeat(1200)}void f(int a`,
  `${"[a]".repeat(3000)} `,
  `${"<a<b<c,".repeat(1500)}`,
  `${"x(".repeat(4000)}`,
  `${"a ".repeat(4500)}`,
  `def ${"a".repeat(9000)}`,
  `${"f".repeat(9000)}(`,
  " ".repeat(9000),
  "\t".repeat(9000),
  "a".repeat(9000),
  "_".repeat(9000),
  "@".repeat(9000),
  `sub ${"a:".repeat(4000)}`,
  `${"(".repeat(4000)}define`,
  `function ${"a".repeat(9000)}()`,
];

describe("builtin diff drivers on adversarial lines", () => {
  for (const [label, table] of [
    ["2.56", BUILTIN_FUNCNAME_PATTERNS],
    ["2.43", BUILTIN_FUNCNAME_PATTERNS_2_43],
  ] as const) {
    it(`matches every line in linear time (${label} drivers)`, () => {
      const slow: string[] = [];
      for (const name of Object.keys(table)) {
        const find = userdiffFindFunction(name, undefined, table);
        expect(find).toBeDefined();
        for (const line of ADVERSARIAL) {
          const bytes = enc.encode(line);
          const t = performance.now();
          find?.(bytes);
          const ms = performance.now() - t;
          if (ms > 750) slow.push(`${name} ${ms.toFixed(0)}ms on ${line.slice(0, 30)}...`);
        }
      }
      expect(slow).toEqual([]);
    }, 120_000);
  }

  it("finds the function line above a change after such a line (the reported case)", () => {
    const line = `${"List<int> ".repeat(24)};\n`;
    const a = enc.encode(`${line}${"x\n".repeat(5)}old\n`);
    const b = enc.encode(`${line}${"x\n".repeat(5)}new\n`);
    const t = performance.now();
    const out = new TextDecoder().decode(
      unifiedDiff(a, b, { findFunction: userdiffFindFunction("csharp") }),
    );
    expect(performance.now() - t).toBeLessThan(1000);
    // git: no csharp function line there (a statement, ending in ";"), so the header is bare
    expect(out.split("\n")[0]).toBe("@@ -4,4 +4,4 @@");
  });
});
