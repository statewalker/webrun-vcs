/**
 * CompressedRawStorage.size reports the uncompressed size, reading only the
 * start of a git loose object (its header) instead of inflating all of it.
 */
import { describe, expect, it } from "vitest";
import { CompressedRawStorage, MemoryRawStorage } from "../../../src/storage/raw/index.js";

const enc = new TextEncoder();

function noise(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let x = 1;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    out[i] = x >>> 24;
  }
  return out;
}

/** The inner store, counting compressed bytes handed out by `load`. */
function countingInner() {
  const inner = new MemoryRawStorage();
  let read = 0;
  const load = inner.load.bind(inner);
  inner.load = (key, options) =>
    (async function* () {
      for await (const c of load(key, options)) {
        read += c.length;
        yield c;
      }
    })();
  return { inner, read: () => read, reset: () => (read = 0) };
}

describe("CompressedRawStorage.size", () => {
  it("returns the uncompressed size of a git loose object from its header", async () => {
    const { inner, read, reset } = countingInner();
    const store = new CompressedRawStorage(inner, { gitObjects: true });
    const body = noise(512 * 1024);
    const header = enc.encode(`blob ${body.length}\0`);
    await store.store(
      "obj",
      (async function* () {
        yield header;
        yield body;
      })(),
    );
    reset();
    expect(await store.size("obj")).toBe(header.length + body.length);
    // only the first stored chunk was read, not the half-megabyte object
    expect(read()).toBeLessThanOrEqual(64 * 1024);
  });

  it("counts the inflated bytes of other content, and -1 when absent", async () => {
    const store = new CompressedRawStorage(new MemoryRawStorage());
    await store.store(
      "plain",
      (async function* () {
        yield enc.encode("hello, ");
        yield enc.encode("world");
      })(),
    );
    expect(await store.size("plain")).toBe(12);
    expect(await store.size("missing")).toBe(-1);
  });
});

describe("CompressedRawStorage.size and git headers", () => {
  async function storeObject(store: CompressedRawStorage, key: string, body: Uint8Array) {
    await store.store(
      key,
      (async function* () {
        yield enc.encode(`blob ${body.length}\0`);
        yield body;
      })(),
    );
  }

  /** Cut the stored zlib stream of `key` to half its length. */
  async function truncate(inner: MemoryRawStorage, key: string) {
    const parts: Uint8Array[] = [];
    for await (const c of inner.load(key)) parts.push(c);
    const all = new Uint8Array(parts.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of parts) {
      all.set(c, o);
      o += c.length;
    }
    await inner.store(
      key,
      (async function* () {
        yield all.subarray(0, all.length >> 1);
      })(),
    );
  }

  it("does not trust a header unless the store holds git objects", async () => {
    const store = new CompressedRawStorage(new MemoryRawStorage());
    // content that starts like a git header but declares the wrong size
    await store.store(
      "lying",
      (async function* () {
        yield enc.encode("blob 1000\0");
        yield enc.encode("short");
      })(),
    );
    expect(await store.size("lying")).toBe(15);
  });

  it("returns -1 for a truncated object by default", async () => {
    const inner = new MemoryRawStorage();
    const store = new CompressedRawStorage(inner);
    await storeObject(store, "obj", noise(64 * 1024));
    await truncate(inner, "obj");
    expect(await store.size("obj")).toBe(-1);
  });

  it("reads the size from the header with gitObjects: true", async () => {
    const inner = new MemoryRawStorage();
    const store = new CompressedRawStorage(inner, { gitObjects: true });
    const body = noise(64 * 1024);
    await storeObject(store, "obj", body);
    expect(await store.size("obj")).toBe(`blob ${body.length}\0`.length + body.length);
  });
});
