import { describe, expect, it } from "vitest";
import { RawText } from "../../../src/diff/text-diff/raw-text.js";
import { RawTextComparator } from "../../../src/diff/text-diff/raw-text-comparator.js";

describe("RawText", () => {
  it("should handle empty text", () => {
    const text = new RawText("");
    expect(text.size()).toBe(0);
  });

  it("should count lines correctly", () => {
    const text = new RawText("a\nb\nc\n");
    expect(text.size()).toBe(3);
  });

  it("should handle text without trailing newline", () => {
    const text = new RawText("a\nb\nc");
    expect(text.size()).toBe(3);
    expect(text.isMissingNewlineAtEnd()).toBe(true);
  });

  it("should handle text with trailing newline", () => {
    const text = new RawText("a\nb\nc\n");
    expect(text.size()).toBe(3);
    expect(text.isMissingNewlineAtEnd()).toBe(false);
  });

  it("should get line string correctly", () => {
    const text = new RawText("hello\nworld\n");
    expect(text.getString(0)).toBe("hello");
    expect(text.getString(1)).toBe("world");
  });

  it("should get raw line bytes correctly", () => {
    const text = new RawText("a\nb\n");
    const line0 = text.getRawString(0);
    expect(line0.length).toBe(1);
    expect(line0[0]).toBe(97); // 'a'
  });

  it("should detect binary content", () => {
    const binaryData = new Uint8Array([0x00, 0x01, 0x02]);
    expect(RawText.isBinary(binaryData)).toBe(true);

    const textData = new Uint8Array([0x61, 0x62, 0x63]); // 'abc'
    expect(RawText.isBinary(textData)).toBe(false);
  });

  it("should accept Uint8Array input", () => {
    const bytes = new TextEncoder().encode("line1\nline2\n");
    const text = new RawText(bytes);
    expect(text.size()).toBe(2);
    expect(text.getString(0)).toBe("line1");
  });

  it("should handle single line without newline", () => {
    const text = new RawText("single");
    expect(text.size()).toBe(1);
    expect(text.getString(0)).toBe("single");
  });

  /**
   * JGit parity tests for line ending detection.
   * Ported from RawTextTest.java
   */
  describe("line ending detection (JGit parity)", () => {
    /**
     * JGit: testCrLfTextYes
     */
    it("should detect CRLF text", () => {
      const text = new RawText("line 1\r\nline 2\r\n");
      expect(text.size()).toBe(2);
    });

    /**
     * JGit: testCrLfTextNo
     */
    it("should detect LF-only text", () => {
      const text = new RawText("line 1\nline 2\n");
      expect(text.size()).toBe(2);
    });

    /**
     * JGit: testCrLfTextMixed
     * Mixed line endings should still work.
     */
    it("should handle mixed line endings", () => {
      const text = new RawText("line 1\nline 2\r\n");
      expect(text.size()).toBe(2);
    });

    /**
     * JGit: testLineDelimiter
     * Tests line delimiter detection.
     */
    it("should detect line delimiter from first line", () => {
      // LF only
      const textLf = new RawText("foo\n");
      expect(textLf.size()).toBe(1);
      expect(textLf.isMissingNewlineAtEnd()).toBe(false);

      // CRLF
      const textCrlf = new RawText("foo\r\n");
      expect(textCrlf.size()).toBe(1);
      expect(textCrlf.isMissingNewlineAtEnd()).toBe(false);

      // No trailing newline
      const textNoNl = new RawText("foo\nbar");
      expect(textNoNl.size()).toBe(2);
      expect(textNoNl.isMissingNewlineAtEnd()).toBe(true);

      // CRLF with no trailing newline
      const textCrlfNoNl = new RawText("foo\r\nbar");
      expect(textCrlfNoNl.size()).toBe(2);
      expect(textCrlfNoNl.isMissingNewlineAtEnd()).toBe(true);

      // Empty file
      const textEmpty = new RawText("");
      expect(textEmpty.size()).toBe(0);
      expect(textEmpty.isMissingNewlineAtEnd()).toBe(true);

      // Just newline
      const textJustNl = new RawText("\n");
      expect(textJustNl.size()).toBe(1);
      expect(textJustNl.isMissingNewlineAtEnd()).toBe(false);

      // Just CRLF
      const textJustCrlf = new RawText("\r\n");
      expect(textJustCrlf.size()).toBe(1);
      expect(textJustCrlf.isMissingNewlineAtEnd()).toBe(false);
    });

    /**
     * JGit: testLineDelimiter2
     */
    it("should detect line delimiter when file starts with newline", () => {
      const text = new RawText("\nfoo");
      expect(text.size()).toBe(2);
      expect(text.isMissingNewlineAtEnd()).toBe(true);
    });
  });

  /**
   * JGit parity tests for CR-only line endings.
   * Ported from RawTextTest.java
   *
   * TODO: CR-only line endings (classic Mac style) are not currently supported.
   * JGit treats CR-only as binary content. These tests document the expected
   * behavior when CR-only support is implemented.
   */
  describe("CR-only line endings (JGit parity)", () => {
    /**
     * Tests that CR-only content is handled.
     * Note: JGit treats CR-only as binary. We may want different behavior.
     *
     * TODO: Decide on CR-only handling strategy:
     * Option 1: Treat as binary (JGit behavior)
     * Option 2: Treat CR as line ending (full support)
     */
    it("should handle CR-only line endings", () => {
      // Classic Mac line endings: \r without \n
      const text = new RawText("line 1\rline 2\rline 3\r");

      // If we support CR-only:
      expect(text.size()).toBe(3);
      expect(text.getString(0)).toBe("line 1");
      expect(text.getString(1)).toBe("line 2");
      expect(text.getString(2)).toBe("line 3");
    });

    /**
     * JGit: testCrAtLimit
     * Tests CR handling at buffer boundaries.
     */
    it("should detect CR at buffer limit as potential binary", () => {
      // Create data with CR at a specific position
      const data = new Uint8Array(100);
      data[0] = 0x41; // 'A'
      for (let i = 1; i < 98; i++) {
        if (i % 7 === 0) {
          data[i] = 0x0a; // '\n'
        } else {
          data[i] = 0x41 + (i % 7); // 'A' + offset
        }
      }
      data[98] = 0x0d; // '\r'
      data[99] = 0x0a; // '\n'

      // CRLF at end should not be treated as binary
      expect(RawText.isBinary(data)).toBe(false);
    });

    /**
     * Tests CR without following LF is detected correctly.
     */
    it("should detect standalone CR as line ending when supported", () => {
      // When CR-only support is implemented:
      const bytes = new Uint8Array([
        0x61,
        0x0d, // "a\r"
        0x62,
        0x0d, // "b\r"
        0x63,
        0x0d, // "c\r"
      ]);
      const text = new RawText(bytes);

      // Expected behavior with CR-only support:
      expect(text.size()).toBe(3);
      expect(text.getString(0)).toBe("a");
      expect(text.getString(1)).toBe("b");
      expect(text.getString(2)).toBe("c");
    });
  });

  /**
   * JGit parity tests for NUL byte handling.
   * Ported from RawTextTest.java
   */
  describe("NUL byte handling (JGit parity)", () => {
    /**
     * JGit: testNul
     * Tests that NUL bytes in content are handled correctly.
     */
    it("should handle NUL bytes in content", () => {
      // "foo-a\nf\0o-b\n" - NUL byte in second line
      const bytes = new Uint8Array([
        0x66,
        0x6f,
        0x6f,
        0x2d,
        0x61,
        0x0a, // "foo-a\n"
        0x66,
        0x00,
        0x6f,
        0x2d,
        0x62,
        0x0a, // "f\0o-b\n"
      ]);

      const text = new RawText(bytes);
      expect(text.size()).toBe(2);
      expect(text.getString(0)).toBe("foo-a");
      // Note: getString may have issues with NUL bytes in TextDecoder
      // The raw bytes should still work
      const rawLine1 = text.getRawString(1);
      expect(rawLine1[0]).toBe(0x66); // 'f'
      expect(rawLine1[1]).toBe(0x00); // NUL
      expect(rawLine1[2]).toBe(0x6f); // 'o'
    });

    /**
     * Tests binary detection with NUL byte.
     */
    it("should detect NUL byte as binary", () => {
      const withNul = new Uint8Array([0x61, 0x00, 0x62]); // "a\0b"
      expect(RawText.isBinary(withNul)).toBe(true);

      const withoutNul = new Uint8Array([0x61, 0x62, 0x63]); // "abc"
      expect(RawText.isBinary(withoutNul)).toBe(false);
    });
  });

  /**
   * JGit parity tests for CRLF handling in content comparison.
   * Ported from RawTextTest.java
   */
  describe("CRLF content handling (JGit parity)", () => {
    /**
     * Tests that CRLF is properly stripped from line content.
     */
    it("should strip CRLF from getString output", () => {
      const text = new RawText("foo\r\nbar\r\n");
      expect(text.size()).toBe(2);
      expect(text.getString(0)).toBe("foo");
      expect(text.getString(1)).toBe("bar");
    });

    /**
     * Tests CRLF with mixed content.
     */
    it("should handle mixed CRLF and LF", () => {
      const text = new RawText("line1\r\nline2\nline3\r\n");
      expect(text.size()).toBe(3);
      expect(text.getString(0)).toBe("line1");
      expect(text.getString(1)).toBe("line2");
      expect(text.getString(2)).toBe("line3");
    });
  });

  /**
   * JGit parity tests for whitespace comparison modes.
   * Ported from RawTextIgnoreAllWhitespaceTest.java, RawTextIgnoreTrailingWhitespaceTest.java,
   * RawTextIgnoreLeadingWhitespaceTest.java, and RawTextIgnoreWhitespaceChangeTest.java.
   */
  describe("whitespace comparison modes (JGit parity)", () => {
    /**
     * JGit: RawTextIgnoreAllWhitespaceTest.testEqualsWithWhitespace
     * Tests WS_IGNORE_ALL mode - all whitespace is ignored in comparison.
     */
    describe("WS_IGNORE_ALL mode", () => {
      it("should treat whitespace-only line as equal to empty line", () => {
        // "         " == ""
        const a = new RawText("foo-a\n         \n");
        const b = new RawText("foo-a\n\n");

        // With WS_IGNORE_ALL, line 1 of a (all spaces) equals line 1 of b (empty)
        expect(RawTextComparator.WS_IGNORE_ALL.equals(a, 1, b, 1)).toBe(true);
      });

      it("should ignore internal whitespace differences", () => {
        // " a b c" == "ab  c" when ignoring all whitespace
        const a = new RawText(" a b c\n");
        const b = new RawText("ab  c\n");

        // With WS_IGNORE_ALL, these lines should be equal
        expect(RawTextComparator.WS_IGNORE_ALL.equals(a, 0, b, 0)).toBe(true);
      });

      it("should ignore trailing whitespace", () => {
        // "a      " == "a" when ignoring all whitespace
        const a = new RawText("a      \n");
        const b = new RawText("a\n");

        // With WS_IGNORE_ALL, these lines should be equal
        expect(RawTextComparator.WS_IGNORE_ALL.equals(a, 0, b, 0)).toBe(true);
      });
    });

    /**
     * JGit: RawTextIgnoreTrailingWhitespaceTest.testEqualsWithWhitespace
     * Tests WS_IGNORE_TRAILING mode - only trailing whitespace is ignored.
     */
    describe("WS_IGNORE_TRAILING mode", () => {
      it("should treat whitespace-only line as equal to empty line", () => {
        // "         " == "" (trailing whitespace ignored)
        const a = new RawText("foo-a\n         \n");
        const b = new RawText("foo-a\n\n");

        // With WS_IGNORE_TRAILING, line 1 of a equals line 1 of b
        expect(RawTextComparator.WS_IGNORE_TRAILING.equals(a, 1, b, 1)).toBe(true);
      });

      it("should NOT ignore leading whitespace", () => {
        // "    b" != "b" (leading whitespace matters)
        const a = new RawText("    b\n");
        const b = new RawText("b\n");

        // With WS_IGNORE_TRAILING, these lines should NOT be equal
        expect(RawTextComparator.WS_IGNORE_TRAILING.equals(a, 0, b, 0)).toBe(false);
      });

      it("should NOT ignore internal whitespace", () => {
        // " a b c" != "ab  c" (internal whitespace matters)
        const a = new RawText(" a b c\n");
        const b = new RawText("ab  c\n");

        // With WS_IGNORE_TRAILING, these lines should NOT be equal
        expect(RawTextComparator.WS_IGNORE_TRAILING.equals(a, 0, b, 0)).toBe(false);
      });

      it("should ignore trailing whitespace only", () => {
        // "a      " == "a"
        const a = new RawText("a      \n");
        const b = new RawText("a\n");

        // With WS_IGNORE_TRAILING, these lines should be equal
        expect(RawTextComparator.WS_IGNORE_TRAILING.equals(a, 0, b, 0)).toBe(true);
      });
    });

    /**
     * JGit: RawTextIgnoreLeadingWhitespaceTest.testEqualsWithWhitespace
     * Tests WS_IGNORE_LEADING mode - only leading whitespace is ignored.
     */
    describe("WS_IGNORE_LEADING mode", () => {
      it("should ignore leading whitespace", () => {
        // "    b" == "b" (leading whitespace ignored)
        const a = new RawText("    b\n");
        const b = new RawText("b\n");

        // With WS_IGNORE_LEADING, these lines should be equal
        expect(RawTextComparator.WS_IGNORE_LEADING.equals(a, 0, b, 0)).toBe(true);
      });

      it("should NOT ignore trailing whitespace", () => {
        // "a      " != "a" (trailing whitespace matters)
        const a = new RawText("a      \n");
        const b = new RawText("a\n");

        // With WS_IGNORE_LEADING, these lines should NOT be equal
        expect(RawTextComparator.WS_IGNORE_LEADING.equals(a, 0, b, 0)).toBe(false);
      });
    });

    /**
     * JGit: RawTextIgnoreWhitespaceChangeTest
     * Tests WS_IGNORE_CHANGE mode - whitespace changes are ignored but presence matters.
     */
    describe("WS_IGNORE_CHANGE mode", () => {
      it("should treat multiple spaces as equal to single space", () => {
        // "a    b" == "a b" (whitespace amount changed but not added/removed)
        const a = new RawText("a    b\n");
        const b = new RawText("a b\n");

        // With WS_IGNORE_CHANGE, these lines should be equal
        expect(RawTextComparator.WS_IGNORE_CHANGE.equals(a, 0, b, 0)).toBe(true);
      });

      it("should NOT treat added whitespace as equal", () => {
        // "ab" != "a b" (whitespace was added where none existed)
        const a = new RawText("ab\n");
        const b = new RawText("a b\n");

        // With WS_IGNORE_CHANGE, these lines should NOT be equal
        expect(RawTextComparator.WS_IGNORE_CHANGE.equals(a, 0, b, 0)).toBe(false);
      });
    });
  });
});
