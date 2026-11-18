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
  // reads counted through `load`: the probe then takes `size` and `load`, not the store's
  // single read (`open`, covered below)
  wrapped.open = undefined;
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

describe("probeBlob with loadText: one read for text", () => {
  const same = (a: Uint8Array | undefined, b: Uint8Array) =>
    !!a && a.length === b.length && a.every((v, i) => v === b[i]);

  it("returns a text blob's whole content from the same, single read", async () => {
    const history = createMemoryHistory();
    const data = new TextEncoder().encode("line of text\n".repeat(10_000));
    const id = await history.blobs.store([data], data.length);
    const { blobs, state } = counting(history.blobs);
    const probe = await probeBlob(blobs, id, { loadText: true });
    expect(probe.binary).toBe(false);
    expect(same(probe.content, data)).toBe(true);
    expect(state.loads).toBe(1);
    expect(state.pulled).toBe(data.length);
  });

  it("stops after the first 8000 bytes of a binary blob and returns no content", async () => {
    const history = createMemoryHistory();
    const data = new Uint8Array(100_000).fill(0x61);
    data[10] = 0;
    const id = await history.blobs.store([data], data.length);
    const { blobs, state } = counting(history.blobs);
    const probe = await probeBlob(blobs, id, { loadText: true });
    expect(probe.binary).toBe(true);
    expect(probe.content).toBeUndefined();
    expect(state.pulled).toBeLessThanOrEqual(8192);
  });

  it("returns empty content for an empty blob without loading it", async () => {
    const history = createMemoryHistory();
    const id = await history.blobs.store([new Uint8Array(0)], 0);
    const probe = await probeBlob(history.blobs, id, { loadText: true });
    expect(probe.content?.length).toBe(0);
  });
});

describe("probeBlob with loadText: a binary blob is never allocated whole", () => {
  it("allocates and reads only about 8 KB of a large binary blob", async () => {
    const history = createMemoryHistory();
    const size = 20 * 2 ** 20;
    const data = new Uint8Array(size).fill(0x61);
    data[10] = 0;
    const id = await history.blobs.store([data], data.length);
    const { blobs, state } = counting(history.blobs);

    // record the largest Uint8Array allocated by length while the probe runs
    const Original = globalThis.Uint8Array;
    let largest = 0;
    let largestByProbe = 0;
    class Tracking extends Original {
      // biome-ignore lint/suspicious/noExplicitAny: forwards every constructor form
      constructor(...args: any[]) {
        // biome-ignore lint/suspicious/noExplicitAny: forwards every constructor form
        super(...(args as [any]));
        if (typeof args[0] !== "number") return;
        largest = Math.max(largest, args[0]);
        if (new Error().stack?.includes("src/history/blobs/probe-blob.ts")) {
          largestByProbe = Math.max(largestByProbe, args[0]);
        }
      }
    }
    globalThis.Uint8Array = Tracking as Uint8ArrayConstructor;
    let probe: Awaited<ReturnType<typeof probeBlob>>;
    try {
      probe = await probeBlob(blobs, id, { loadText: true });
    } finally {
      globalThis.Uint8Array = Original;
    }
    expect(probe).toEqual({ size, binary: true, big: false });
    expect(state.pulled).toBeLessThanOrEqual(8192);
    // the probe's own buffer is the 8000-byte window; inflating the stored
    // object adds zlib's 32 KiB window, nothing near the blob's 20 MiB
    expect(largestByProbe).toBe(8000);
    expect(largest).toBeLessThanOrEqual(64 * 1024);
  });
});

describe("probeBlob over the store's single read (Blobs.open)", () => {
  /** The store's blobs, counting the calls of each read */
  function calls(blobs: Blobs) {
    const count = { open: 0, size: 0, load: 0 };
    const wrapped: Blobs = Object.create(blobs);
    wrapped.open = async (id) => {
      count.open++;
      return blobs.open?.(id);
    };
    wrapped.size = async (id) => {
      count.size++;
      return blobs.size(id);
    };
    wrapped.load = async (id) => {
      count.load++;
      return blobs.load(id);
    };
    return { blobs: wrapped, count };
  }

  it("takes size and content from one read of the object", async () => {
    const history = createMemoryHistory();
    const data = new TextEncoder().encode("line of text\n".repeat(1000));
    const id = await history.blobs.store([data], data.length);
    const { blobs, count } = calls(history.blobs);
    const probe = await probeBlob(blobs, id, { loadText: true });
    expect(probe.size).toBe(data.length);
    expect(probe.binary).toBe(false);
    expect(probe.content && Buffer.from(probe.content).equals(Buffer.from(data))).toBe(true);
    expect(count).toEqual({ open: 1, size: 0, load: 0 });
  });

  it("finds a NUL in the first 8000 bytes, and none past them", async () => {
    const history = createMemoryHistory();
    const early = new Uint8Array(20_000).fill(0x61);
    early[7999] = 0;
    const late = new Uint8Array(20_000).fill(0x61);
    late[8000] = 0;
    const earlyId = await history.blobs.store([early], early.length);
    const lateId = await history.blobs.store([late], late.length);
    const { blobs } = calls(history.blobs);
    expect(await probeBlob(blobs, earlyId, { loadText: true })).toEqual({
      size: 20_000,
      binary: true,
      big: false,
    });
    const text = await probeBlob(blobs, lateId);
    expect(text).toEqual({ size: 20_000, binary: false, big: false });
  });

  it("calls a blob over the threshold big, and a missing one an error", async () => {
    const history = createMemoryHistory();
    const data = new TextEncoder().encode("text\n".repeat(1000));
    const id = await history.blobs.store([data], data.length);
    expect(await probeBlob(history.blobs, id, { bigFileThreshold: 1000 })).toEqual({
      size: data.length,
      binary: true,
      big: true,
    });
    await expect(probeBlob(history.blobs, "0".repeat(40))).rejects.toThrow(/not found/);
  });

  it("reads nothing for a tree id: not a blob", async () => {
    const history = createMemoryHistory();
    const tree = await history.trees.store([]);
    expect(await history.blobs.open?.(tree)).toBeUndefined();
    expect(await history.blobs.size(tree)).toBe(-1);
    expect(await history.blobs.load(tree)).toBeUndefined();
  });
});
