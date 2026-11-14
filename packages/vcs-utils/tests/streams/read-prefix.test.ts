import { describe, expect, it } from "vitest";
import { readPrefix } from "../../src/streams/index.js";

function bytes(n: number, start = 0): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (start + i) & 0xff);
}

describe("readPrefix", () => {
  it("returns the first bytes and stops pulling the source", async () => {
    let pulled = 0;
    let closed = false;
    async function* source(): AsyncGenerator<Uint8Array> {
      try {
        for (let i = 0; i < 100; i++) {
          pulled++;
          yield bytes(30, i * 30);
        }
      } finally {
        closed = true;
      }
    }
    const prefix = await readPrefix(source(), 100);
    expect(prefix).toEqual(bytes(100));
    expect(pulled).toBe(4);
    expect(closed).toBe(true);
  });

  it("returns fewer bytes when the source is shorter", async () => {
    expect(await readPrefix([bytes(5), bytes(3, 5)], 100)).toEqual(bytes(8));
    expect(await readPrefix([], 10)).toEqual(new Uint8Array(0));
  });

  it("reads nothing for a zero length", async () => {
    let pulled = 0;
    async function* source(): AsyncGenerator<Uint8Array> {
      pulled++;
      yield bytes(10);
    }
    expect(await readPrefix(source(), 0)).toEqual(new Uint8Array(0));
    expect(pulled).toBe(0);
  });
});
