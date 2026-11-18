import { describe, expect, it } from "vitest";

import { gitCharWidthAt, gitStrWidth } from "../../src/encoding/index.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("gitStrWidth (utf8_strwidth)", () => {
  it("sums git's character widths, control characters counting none", () => {
    expect(gitStrWidth(utf8("abc"))).toBe(3);
    expect(gitStrWidth(utf8("中文.txt"))).toBe(8);
    expect(gitStrWidth(utf8("é"))).toBe(1);
    expect(gitStrWidth(utf8("😀"))).toBe(2);
    expect(gitStrWidth(utf8("a\u0001b"))).toBe(2);
  });

  it("counts bytes when the text is not valid UTF-8 (git's strlen fallback)", () => {
    expect(gitStrWidth(new Uint8Array([0x61, 0xff, 0x62]))).toBe(3);
    // U+FFFE, an overlong slash, a surrogate: invalid for git's pick_one_utf8_char
    expect(gitStrWidth(new Uint8Array([0xef, 0xbf, 0xbe]))).toBe(3);
    expect(gitStrWidth(new Uint8Array([0xc0, 0xaf, 0x61]))).toBe(3);
    expect(gitStrWidth(new Uint8Array([0xed, 0xa0, 0x80]))).toBe(3);
  });
});

describe("gitCharWidthAt (diff.c utf8_ish_width)", () => {
  it("steps a character at a time, an invalid byte as one column", () => {
    const bytes = new Uint8Array([...utf8("中"), 0xff, ...utf8("́"), 0x01]);
    expect(gitCharWidthAt(bytes, 0)).toEqual([2, 3]);
    expect(gitCharWidthAt(bytes, 3)).toEqual([1, 4]);
    expect(gitCharWidthAt(bytes, 4)).toEqual([0, 6]);
    expect(gitCharWidthAt(bytes, 6)).toEqual([0, 7]);
  });
});
