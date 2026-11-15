import { describe, expect, it } from "vitest";
import { fixedSizeChunks } from "../../../src/storage/chunked/index.js";

async function lengths(input: Uint8Array[], size: number): Promise<number[]> {
  const out: number[] = [];
  for await (const c of fixedSizeChunks(input, size)) out.push(c.length);
  return out;
}

describe("fixedSizeChunks", () => {
  it("re-cuts input into chunks of the given size, the last one shorter", async () => {
    const input = [new Uint8Array(3), new Uint8Array(10), new Uint8Array(1)];
    expect(await lengths(input, 4)).toEqual([4, 4, 4, 2]);
    expect(await lengths([], 4)).toEqual([]);
    expect(await lengths([new Uint8Array(8)], 4)).toEqual([4, 4]);
  });

  it("keeps the bytes in order", async () => {
    const out: number[] = [];
    for await (const c of fixedSizeChunks([Uint8Array.of(1, 2, 3), Uint8Array.of(4, 5)], 2)) {
      out.push(...c);
    }
    expect(out).toEqual([1, 2, 3, 4, 5]);
  });
});
