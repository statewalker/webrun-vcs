/**
 * unifiedDiff on fixed cases, each expected body taken from `git diff --no-index`.
 */
import { describe, expect, it } from "vitest";
import {
  ByteLines,
  diffLineCounts,
  type UnifiedDiffOptions,
  unifiedDiff,
  userdiffFindFunction,
  xdiff,
  xdiffHunks,
} from "../../../src/diff/text-diff/index.js";
import { compilePosixRegex } from "../../../src/regex/index.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const body = (a: string, b: string, options: UnifiedDiffOptions = {}) =>
  dec.decode(unifiedDiff(enc.encode(a), enc.encode(b), { indentHeuristic: true, ...options }));

describe("unifiedDiff (git diff --no-index bodies)", () => {
  it("shows the nearest line starting with a letter in the hunk header", () => {
    expect(body("int f()\n a\n b\n c\n d\n e\n f\n", "int f()\n a\n b\n c\n d\n E\n f\n")).toBe(
      "@@ -3,5 +3,5 @@ int f()\n  b\n  c\n  d\n- e\n+ E\n  f\n",
    );
  });

  it("ignores whitespace with -w and whitespace amounts with -b", () => {
    expect(body("a b\nc\n", "a  b\nc\n", { ignoreWhitespace: true })).toBe("");
    expect(body("a b\nc\nd e\n", "a  b\nc\nde\n", { ignoreWhitespaceChange: true })).toBe(
      "@@ -1,3 +1,3 @@\n a  b\n c\n-d e\n+de\n",
    );
  });

  it("leaves out blank-line changes with --ignore-blank-lines", () => {
    expect(
      body("a\nb\nc\nd\ne\nf\ng\n", "a\n\nb\nc\nd\ne\nf\nG\n", {
        ignoreBlankLines: true,
        context: 1,
      }),
    ).toBe("@@ -6,2 +7,2 @@ e\n f\n-g\n+G\n");
  });

  it("marks lines without a newline", () => {
    expect(body("a\nb", "a\nc")).toBe(
      "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n",
    );
  });

  it("cuts the function line at 80 bytes, and the header before a broken UTF-8 character", () => {
    const long = `def ${"x".repeat(75)}\u00e9tail():`;
    expect(body(`${long}\n1\n2\n3\n4\n`, `${long}\n1\n2\n3\nX\n`)).toBe(
      `@@ -2,4 +2,4 @@ def ${"x".repeat(75)}\n 1\n 2\n 3\n-4\n+X\n`,
    );
  });

  it("joins hunks within the inter-hunk context", () => {
    expect(
      body("1\n2\n3\n4\n5\n6\n7\n8\n9\n", "1\nB\n3\n4\n5\n6\n7\nH\n9\n", {
        context: 1,
        interHunkContext: 3,
      }),
    ).toBe("@@ -1,9 +1,9 @@\n 1\n-2\n+B\n 3\n 4\n 5\n 6\n 7\n-8\n+H\n 9\n");
  });

  it("finds function lines with a builtin driver's pattern", () => {
    const a =
      "class A:\n    def m(self):\n        x = 1\n        y = 2\n        z = 3\n        w = 4\n";
    expect(
      body(a, a.replace("w = 4", "w = 5"), { findFunction: userdiffFindFunction("python") }),
    ).toBe(
      "@@ -3,4 +3,4 @@ def m(self):\n         x = 1\n         y = 2\n         z = 3\n-        w = 4\n+        w = 5\n",
    );
  });

  it("counts lines as the diffstat does", () => {
    expect(diffLineCounts(enc.encode("a\nb\nc\n"), enc.encode("a\nB\nc\nd\n"))).toEqual({
      added: 2,
      deleted: 1,
    });
  });

  it("matches xdiff's changes for the hunk callback (common tail trimmed)", () => {
    const a = enc.encode("a\nb\nc\n");
    const b = enc.encode("a\nx\nc\n");
    expect(xdiffHunks(a, b)).toEqual(xdiff(new ByteLines(a), new ByteLines(b)));
  });

  it("matches POSIX bracket expressions", () => {
    const m = compilePosixRegex("[][[:alnum:]]+", { extended: true }).exec(enc.encode("x[a]"));
    expect(m && [m.start, m.end]).toEqual([0, 4]);
    expect(
      compilePosixRegex("^[[:alpha:]_][^]]*$", { extended: true }).test(enc.encode("a]")),
    ).toBe(false);
  });
});
