import { describe, expect, it } from "vitest";
import { HunkHeader } from "../../../src/diff/patch/hunk-header.js";

describe("HunkHeader", () => {
  describe("parse", () => {
    it("should parse simple hunk header", () => {
      const hunk = `@@ -10,7 +10,8 @@
 context line
-deleted line
+added line
 another context
`;
      const buffer = new TextEncoder().encode(hunk);
      const header = new HunkHeader(buffer, 0);
      header.parse(buffer.length);

      expect(header.oldStartLine).toBe(10);
      expect(header.oldLineCount).toBe(7);
      expect(header.newStartLine).toBe(10);
      expect(header.newLineCount).toBe(8);
      expect(header.contextLineCount).toBe(2);
      expect(header.deletedLineCount).toBe(1);
      expect(header.addedLineCount).toBe(1);
    });

    it("should parse hunk with context text", () => {
      const hunk = `@@ -100,5 +100,6 @@ function foo() {
 context
-old
+new
`;
      const buffer = new TextEncoder().encode(hunk);
      const header = new HunkHeader(buffer, 0);
      header.parse(buffer.length);

      expect(header.oldStartLine).toBe(100);
      expect(header.oldLineCount).toBe(5);
      expect(header.newStartLine).toBe(100);
      expect(header.newLineCount).toBe(6);
      expect(header.context).toBe("function foo() {");
    });

    it("should parse minimal hunk (single line)", () => {
      const hunk = `@@ -1 +1 @@
-old
+new
`;
      const buffer = new TextEncoder().encode(hunk);
      const header = new HunkHeader(buffer, 0);
      header.parse(buffer.length);

      expect(header.oldStartLine).toBe(1);
      expect(header.oldLineCount).toBe(1);
      expect(header.newStartLine).toBe(1);
      expect(header.newLineCount).toBe(1);
      expect(header.deletedLineCount).toBe(1);
      expect(header.addedLineCount).toBe(1);
    });

    it("should parse hunk with only additions", () => {
      const hunk = `@@ -10,0 +10,3 @@
+line 1
+line 2
+line 3
`;
      const buffer = new TextEncoder().encode(hunk);
      const header = new HunkHeader(buffer, 0);
      header.parse(buffer.length);

      expect(header.oldLineCount).toBe(0);
      expect(header.newLineCount).toBe(3);
      expect(header.deletedLineCount).toBe(0);
      expect(header.addedLineCount).toBe(3);
      expect(header.contextLineCount).toBe(0);
    });

    it("should parse hunk with only deletions", () => {
      const hunk = `@@ -10,3 +10,0 @@
-line 1
-line 2
-line 3
`;
      const buffer = new TextEncoder().encode(hunk);
      const header = new HunkHeader(buffer, 0);
      header.parse(buffer.length);

      expect(header.oldLineCount).toBe(3);
      expect(header.newLineCount).toBe(0);
      expect(header.deletedLineCount).toBe(3);
      expect(header.addedLineCount).toBe(0);
    });

    it("should handle no newline marker", () => {
      const hunk = `@@ -1,1 +1,1 @@
-old line
\\ No newline at end of file
+new line
`;
      const buffer = new TextEncoder().encode(hunk);
      const header = new HunkHeader(buffer, 0);
      header.parse(buffer.length);

      expect(header.deletedLineCount).toBe(1);
      expect(header.addedLineCount).toBe(1);
      // "\ No newline" doesn't count as any type
    });

    it("should stop at next hunk header", () => {
      const hunks = `@@ -10,2 +10,2 @@
 context
-old
+new
@@ -20,2 +20,2 @@
 more stuff
`;
      const buffer = new TextEncoder().encode(hunks);
      const header1 = new HunkHeader(buffer, 0);
      const nextOffset = header1.parse(buffer.length);

      expect(header1.contextLineCount).toBe(1);
      expect(header1.deletedLineCount).toBe(1);
      expect(header1.addedLineCount).toBe(1);

      // Next hunk should start at the "@@ -20" line
      const secondHunkStart = hunks.indexOf("@@ -20");
      expect(nextOffset).toBe(secondHunkStart);
    });

    it("should handle large line numbers", () => {
      const hunk = `@@ -1234,567 +5678,90 @@
 context
`;
      const buffer = new TextEncoder().encode(hunk);
      const header = new HunkHeader(buffer, 0);
      header.parse(buffer.length);

      expect(header.oldStartLine).toBe(1234);
      expect(header.oldLineCount).toBe(567);
      expect(header.newStartLine).toBe(5678);
      expect(header.newLineCount).toBe(90);
    });

    it("should parse hunk at non-zero offset", () => {
      const text = "some prefix\n@@ -1,1 +1,1 @@\n-old\n+new\n";
      const buffer = new TextEncoder().encode(text);
      const hunkStart = text.indexOf("@@");
      const header = new HunkHeader(buffer, hunkStart);
      header.parse(buffer.length);

      expect(header.oldStartLine).toBe(1);
      expect(header.oldLineCount).toBe(1);
      expect(header.deletedLineCount).toBe(1);
      expect(header.addedLineCount).toBe(1);
    });
  });

  describe("getLineType", () => {
    it("should identify context line", () => {
      const hunk = " context\n";
      const buffer = new TextEncoder().encode(hunk);
      const header = new HunkHeader(buffer, 0);

      expect(header.getLineType(0)).toBe(" ");
    });

    it("should identify deleted line", () => {
      const hunk = "-deleted\n";
      const buffer = new TextEncoder().encode(hunk);
      const header = new HunkHeader(buffer, 0);

      expect(header.getLineType(0)).toBe("-");
    });

    it("should identify added line", () => {
      const hunk = "+added\n";
      const buffer = new TextEncoder().encode(hunk);
      const header = new HunkHeader(buffer, 0);

      expect(header.getLineType(0)).toBe("+");
    });

    it("should identify no newline marker", () => {
      const hunk = "\\ No newline\n";
      const buffer = new TextEncoder().encode(hunk);
      const header = new HunkHeader(buffer, 0);

      expect(header.getLineType(0)).toBe("\\");
    });
  });

  describe("toString", () => {
    it("should format hunk header without context", () => {
      const hunk = "@@ -10,5 +15,7 @@\n";
      const buffer = new TextEncoder().encode(hunk);
      const header = new HunkHeader(buffer, 0);
      header.parse(buffer.length);

      expect(header.toString()).toBe("@@ -10,5 +15,7 @@");
    });

    it("should format hunk header with context", () => {
      const hunk = "@@ -10,5 +15,7 @@ my function\n";
      const buffer = new TextEncoder().encode(hunk);
      const header = new HunkHeader(buffer, 0);
      header.parse(buffer.length);

      expect(header.toString()).toBe("@@ -10,5 +15,7 @@ my function");
    });
  });
});
