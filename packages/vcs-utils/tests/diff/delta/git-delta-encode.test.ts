/**
 * The git delta encoder (diff-delta.c's format): what it writes, applyGitDelta
 * reads back exactly, and it gives up once the delta would exceed maxSize.
 */
import { describe, expect, it } from "vitest";
import {
  applyGitDelta,
  createGitDeltaIndex,
  encodeGitDelta,
  gitDeltaIndexBytes,
} from "../../../src/diff/delta/index.js";

function random(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = seed | 1;
  for (let i = 0; i < n; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out[i] = x & 0xff;
  }
  return out;
}

describe("encodeGitDelta", () => {
  it("round-trips edited content through applyGitDelta, much smaller than the target", () => {
    const base = random(200_000, 7);
    const target = new Uint8Array(base.length + 300);
    target.set(base.subarray(0, 50_000));
    target.set(random(300, 9), 50_000); // an insertion
    target.set(base.subarray(50_000), 50_300);
    target[150_000] ^= 0xff; // and an edit
    const delta = encodeGitDelta(createGitDeltaIndex(base), target);
    expect(delta).toBeDefined();
    expect(applyGitDelta(base, delta as Uint8Array)).toEqual(target);
    expect((delta as Uint8Array).length).toBeLessThan(2000);
  });

  it("handles copies longer than 0x10000, tiny inputs and unrelated content", () => {
    const base = random(300_000, 3);
    const same = encodeGitDelta(createGitDeltaIndex(base), base) as Uint8Array;
    expect(applyGitDelta(base, same)).toEqual(base);
    for (const [b, t] of [
      [new Uint8Array(0), new Uint8Array(0)],
      [new Uint8Array(0), random(10, 1)],
      [random(5, 2), random(3, 4)],
      [random(1000, 5), random(1000, 6)],
    ] as const) {
      const d = encodeGitDelta(createGitDeltaIndex(b), t) as Uint8Array;
      expect(applyGitDelta(b, d)).toEqual(t);
    }
  });

  it("returns undefined once the delta would exceed maxSize", () => {
    const base = random(10_000, 11);
    const target = random(10_000, 12);
    expect(encodeGitDelta(createGitDeltaIndex(base), target, 100)).toBeUndefined();
    expect(gitDeltaIndexBytes(createGitDeltaIndex(base))).toBeGreaterThan(0);
  });
});
