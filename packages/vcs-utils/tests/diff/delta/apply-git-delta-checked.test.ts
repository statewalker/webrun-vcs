/**
 * applyGitDelta checks every instruction before it allocates, as git's
 * patch-delta.c and JGit's BinaryDelta do: a bad delta throws DeltaError
 * instead of producing wrong bytes or a huge buffer.
 */
import { describe, expect, it } from "vitest";
import { applyGitDelta, DeltaError } from "../../../src/diff/delta/index.js";

/** git's delta varint (7 bits per byte, little-endian). */
function varint(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return out;
}
const delta = (...bytes: number[]) => Uint8Array.from(bytes);
const base = new TextEncoder().encode("hello world");

describe("applyGitDelta (checked)", () => {
  it("applies copies and inserts", () => {
    // copy [0,5) "hello", insert "!", copy [5,11) " world"
    const d = delta(...varint(11), ...varint(12), 0x90, 5, 1, 33, 0x91, 5, 6);
    expect(new TextDecoder().decode(applyGitDelta(base, d))).toBe("hello! world");
  });

  it("refuses a copy past the end of the base (no zeros come out)", () => {
    const d = delta(...varint(11), ...varint(20), 0x90, 20); // copy [0,20) of 11 bytes
    expect(() => applyGitDelta(base, d)).toThrow(DeltaError);
  });

  it("refuses a huge declared result before allocating", () => {
    const d = delta(...varint(11), ...varint(2 ** 40), 0x90, 5);
    expect(() => applyGitDelta(base, d)).toThrow(DeltaError);
    expect(() => applyGitDelta(base, delta(...varint(11), ...varint(100), 0x90, 5), 50)).toThrow(
      /exceeds/,
    );
  });

  it("refuses truncated operands, instruction 0, and size mismatches", () => {
    expect(() => applyGitDelta(base, delta(...varint(11), ...varint(5), 0x91, 1))).toThrow(
      DeltaError,
    ); // copy size byte missing
    expect(() => applyGitDelta(base, delta(...varint(11), ...varint(3), 3, 65))).toThrow(
      DeltaError,
    ); // insert of 3 with 1 byte
    expect(() => applyGitDelta(base, delta(...varint(11), ...varint(1), 0))).toThrow(DeltaError);
    expect(() => applyGitDelta(base, delta(...varint(10), ...varint(5), 0x90, 5))).toThrow(/base/); // base size mismatch
    expect(() => applyGitDelta(base, delta(...varint(11), ...varint(6), 0x90, 5))).toThrow(
      DeltaError,
    ); // result shorter than declared
    expect(() => applyGitDelta(base, delta(...varint(11)))).toThrow(DeltaError); // header truncated
  });

  it("reads a copy size of 0 as 0x10000", () => {
    const big = new Uint8Array(0x10000).fill(7);
    const d = delta(...varint(0x10000), ...varint(0x10000), 0x80);
    expect(applyGitDelta(big, d)).toEqual(big);
  });
});
