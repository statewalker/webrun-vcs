import { describe, expect, it } from "vitest";
import {
  type Blobs,
  createMemoryHistory,
  DEFAULT_BIG_FILE_THRESHOLD,
  probeBlob,
} from "../../../src/history/index.js";

/** Blobs whose `load` streams in 1 KiB pieces and counts the bytes pulled. */
function counting(blobs: Blobs) {
  const state = { pulled: 0, loads: 0 };
  const wrapped: Blobs = Object.create(blobs);
  wrapped.load = async (id) => {
    const content = await blobs.load(id);
    if (!content) return undefined;
    state.loads++;
    return (async function* () {
      for await (const chunk of content) {
        for (let i = 0; i < chunk.length; i += 1024) {
          const piece = chunk.subarray(i, i + 1024);
          state.pulled += piece.length;
          yield piece;
        }
      }
    })();
  };
  return { blobs: wrapped, state };
}

describe("probeBlob", () => {
  it("defaults to git's core.bigFileThreshold (50 MiB)", () => {
    expect(DEFAULT_BIG_FILE_THRESHOLD).toBe(50 * 1024 * 1024);
  });

  it("calls text text, reading only the first 8000 bytes", async () => {
    const history = createMemoryHistory();
    const data = new Uint8Array(100_000).fill(0x61);
    data[50_000] = 0; // past git's 8000-byte window: still text
    const id = await history.blobs.store([data], data.length);
    const { blobs, state } = counting(history.blobs);
    expect(await probeBlob(blobs, id)).toEqual({ size: 100_000, binary: false, big: false });
    expect(state.pulled).toBeLessThanOrEqual(8192);
  });

  it("calls content with a NUL in the first 8000 bytes binary", async () => {
    const history = createMemoryHistory();
    const data = new Uint8Array(100_000).fill(0x61);
    data[7999] = 0;
    const id = await history.blobs.store([data], data.length);
    const { blobs, state } = counting(history.blobs);
    expect(await probeBlob(blobs, id)).toEqual({ size: 100_000, binary: true, big: false });
    expect(state.pulled).toBeLessThanOrEqual(8192);
  });

  it("calls a blob over the threshold big and binary without reading it", async () => {
    const history = createMemoryHistory();
    const data = new TextEncoder().encode("text\n".repeat(1000));
    const id = await history.blobs.store([data], data.length);
    const { blobs, state } = counting(history.blobs);
    expect(await probeBlob(blobs, id, { bigFileThreshold: 1000 })).toEqual({
      size: data.length,
      binary: true,
      big: true,
    });
    expect(state.loads).toBe(0);
  });

  it("rejects a missing blob", async () => {
    const history = createMemoryHistory();
    await expect(probeBlob(history.blobs, "0".repeat(40))).rejects.toThrow(/not found/);
  });
});
