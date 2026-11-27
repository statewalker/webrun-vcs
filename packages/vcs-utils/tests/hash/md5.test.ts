import { describe, expect, it } from "vitest";
import { md5, md5Hex, sha256Hex, sha512_256Hex } from "../../src/hash/index.js";

describe("md5 (RFC 1321)", () => {
  // RFC 1321 A.5's test suite
  const vectors: [string, string][] = [
    ["", "d41d8cd98f00b204e9800998ecf8427e"],
    ["a", "0cc175b9c0f1b6a831c399e269772661"],
    ["abc", "900150983cd24fb0d6963f7d28e17f72"],
    ["message digest", "f96b697d7cb7938d525a2f31aaf161d0"],
    ["abcdefghijklmnopqrstuvwxyz", "c3fcd3d76192e4007dfb496cca67e13b"],
    [
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
      "d174ab98d277d9f5a5611c2c9f419d9f",
    ],
    [
      "12345678901234567890123456789012345678901234567890123456789012345678901234567890",
      "57edf4a22be3c955ac49da2e2107b67a",
    ],
  ];
  for (const [input, digest] of vectors) {
    it(`MD5("${input}") = ${digest}`, () => {
      expect(md5Hex(input)).toBe(digest);
    });
  }

  it("hashes bytes and every padding length around a block", () => {
    // lengths 55, 56, 63, 64 and 65 cross the padding boundaries; checked against values
    // computed by a reference implementation (the digest of `a` repeated)
    const expected: Record<number, string> = {
      55: "ef1772b6dff9a122358552954ad0df65",
      56: "3b0c8ac703f828b04c6c197006d17218",
      63: "b06521f39153d618550606be297466d5",
      64: "014842d480b571495a4a0363793f7367",
      65: "c743a45e0d2e6a95cb859adae0248435",
    };
    for (const [length, digest] of Object.entries(expected)) {
      expect(md5Hex("a".repeat(Number(length)))).toBe(digest);
    }
    expect(md5(new Uint8Array([0x61, 0x62, 0x63]))).toEqual(
      Uint8Array.from([
        0x90, 0x01, 0x50, 0x98, 0x3c, 0xd2, 0x4f, 0xb0, 0xd6, 0x96, 0x3f, 0x7d, 0x28, 0xe1, 0x7f,
        0x72,
      ]),
    );
  });
});

describe("sha256Hex and sha512_256Hex (FIPS 180-4 examples)", () => {
  it('hashes "abc"', () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha512_256Hex("abc")).toBe(
      "53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23",
    );
  });
});
