import { describe, expect, it } from "vitest";

import {
  compareGitPaths,
  decodeGitPath,
  encodeGitPath,
  hasEscapedBytes,
} from "../../src/encoding/index.js";

const bytes = (...b: number[]) => new Uint8Array(b);
const utf8 = (s: string) => new TextEncoder().encode(s);

describe("git path encoding", () => {
  it("decodes UTF-8 as TextDecoder does, a leading BOM kept", () => {
    for (const s of ["", "plain.txt", "café.txt", "日本語/ファイル", "😀/x", "﻿bom"]) {
      expect(decodeGitPath(utf8(s))).toBe(s);
      expect(encodeGitPath(s)).toEqual(utf8(s));
      expect(hasEscapedBytes(s)).toBe(/[\ud800-\udfff]/.test(s));
    }
    expect(decodeGitPath(utf8("a".repeat(100)))).toBe("a".repeat(100));
  });

  it("escapes each byte outside a valid sequence and encodes it back", () => {
    const latin1 = bytes(0x63, 0x61, 0x66, 0xe9, 0x2e, 0x74);
    expect(decodeGitPath(latin1)).toBe("caf\udce9.t");
    expect(encodeGitPath("caf\udce9.t")).toEqual(latin1);
    expect(hasEscapedBytes("caf\udce9.t")).toBe(true);
  });

  it("round-trips any bytes: truncated, overlong, surrogate and out-of-range sequences", () => {
    const cases = [
      bytes(0xff),
      bytes(0xc3),
      bytes(0xc0, 0xaf),
      bytes(0xe0, 0x80, 0xaf),
      bytes(0xed, 0xa0, 0x80),
      bytes(0xf4, 0x90, 0x80, 0x80),
      bytes(0xf0, 0x9f, 0x98),
      bytes(0xf0, 0x9f, 0x98, 0x80, 0xe9),
      bytes(0xe9, 0xf0, 0x9f, 0x98, 0x80),
      bytes(0x61, 0x80, 0xbf, 0x62),
      bytes(0xc3, 0xa9, 0xe9, 0xc3, 0xa9),
    ];
    for (const b of cases) {
      const s = decodeGitPath(b);
      expect(encodeGitPath(s)).toEqual(b);
      expect(decodeGitPath(encodeGitPath(s))).toBe(s);
    }
    // every byte value alone and after a lead byte
    for (let x = 0; x < 256; x++) {
      for (const b of [bytes(x), bytes(0xe9, x), bytes(x, 0x80, 0x80)]) {
        expect(encodeGitPath(decodeGitPath(b))).toEqual(b);
      }
    }
  });

  it("a lone surrogate that escapes no byte encodes as TextEncoder does", () => {
    expect(encodeGitPath("a\ud800b")).toEqual(utf8("a\ud800b"));
    expect(encodeGitPath("a\udc00b")).toEqual(utf8("a\udc00b"));
  });

  it("compares as the bytes compare", () => {
    const names = [
      bytes(0x61),
      utf8("café"),
      bytes(0x63, 0x61, 0x66, 0xe9),
      bytes(0x63, 0x61, 0x66, 0xe9, 0x2e),
      utf8("caf退"),
      utf8("caf"),
      utf8("caf😀"),
      bytes(0x63, 0x61, 0x66, 0xff),
      utf8("z"),
    ];
    const byBytes = (a: Uint8Array, b: Uint8Array) => {
      for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
      return a.length - b.length;
    };
    const strings = names.map(decodeGitPath);
    for (const a of names) {
      for (const b of names) {
        expect(Math.sign(compareGitPaths(decodeGitPath(a), decodeGitPath(b)))).toBe(
          Math.sign(byBytes(a, b)),
        );
      }
    }
    expect([...strings].reverse().sort(compareGitPaths)).toEqual(strings);
  });
});
