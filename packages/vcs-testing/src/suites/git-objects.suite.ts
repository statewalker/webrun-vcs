/**
 * Conformance suite for the object kernel (`GitObjects`) over a
 * `StagingBlobStore`. It drives the kernel and, to check stored bytes and plant
 * corruption, the store underneath. Stored bytes are checked with the
 * platform's DecompressionStream, independent of the kernel's inflater.
 */

import {
  CorruptObjectError,
  createGitObjects,
  type GitObjects,
  InvalidObjectIdError,
  ObjectIdMismatchError,
  type ObjectTypeString,
  SizeMismatchError,
  type StagingBlobStore,
} from "@statewalker/vcs-core";
import { createSha1 } from "@statewalker/vcs-utils/hash/hasher";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GitObjectSample, gitObjectSamples } from "../fixtures/index.js";

export interface GitObjectsTestContext {
  /** The kernel under test, over `store`. */
  objects: GitObjects;
  /** The store the kernel writes to (used to inspect and corrupt stored bytes). */
  store: StagingBlobStore;
  cleanup?: () => Promise<void>;
  /**
   * Bytes the backend has persisted so far (values, rows or file bytes written).
   * When given, the suite writes a 50 MiB blob and checks that the producer
   * never runs more than a bounded amount ahead of the backend.
   */
  persistedBytes?: () => number;
}

/** Deterministic, barely compressible bytes, generated chunk by chunk as they are pulled. */
function lazyNoise(total: number, chunk: number, onChunk?: (produced: number) => void) {
  return (async function* () {
    let x = 0x1234567;
    for (let produced = 0; produced < total; ) {
      onChunk?.(produced);
      const out = new Uint8Array(Math.min(chunk, total - produced));
      for (let i = 0; i < out.length; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        out[i] = x;
      }
      produced += out.length;
      yield out;
    }
  })();
}

const enc = new TextEncoder();

async function collect(s: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const c of s) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function through(bytes: Uint8Array, t: ReadableWritablePair<Uint8Array, BufferSource>) {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(t));
  return new Uint8Array(await out.arrayBuffer());
}
const zlib = (b: Uint8Array) => through(b, new CompressionStream("deflate"));
const unzlib = (b: Uint8Array) => through(b, new DecompressionStream("deflate"));

async function* chunked(b: Uint8Array, size: number) {
  for (let i = 0; i < b.length; i += size) yield b.subarray(i, i + size);
}
const body = (o: GitObjectSample) => o.raw.subarray(o.raw.indexOf(0) + 1);
const idOf = (raw: Uint8Array) => bytesToHex(createSha1().update(raw).digest());

/** A 100 KiB pseudo-random blob (deterministic), so streams cross many chunks. */
function largeBlob(): GitObjectSample {
  const content = new Uint8Array(100 * 1024);
  let x = 0x2545f491;
  for (let i = 0; i < content.length; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    content[i] = x >>> 24;
  }
  const raw = new Uint8Array([...enc.encode(`blob ${content.length}\0`), ...content]);
  return { name: "blob: 100 KiB pseudo-random", id: idOf(raw), type: "blob", raw };
}

async function storedIds(store: StagingBlobStore): Promise<string[]> {
  const ids: string[] = [];
  for await (const id of store.list()) ids.push(id);
  return ids.sort();
}

/** Put `bytes` into the store under `id` as they are (to plant corruption). */
function plant(store: StagingBlobStore, id: string, bytes: Uint8Array) {
  return store.putStaged(
    (async function* () {
      if (bytes.length > 0) yield bytes;
    })(),
    () => id,
  );
}

/**
 * @param name Implementation name (e.g. "Memory", "Files (Node)")
 * @param factory Creates an empty store and a kernel over it, per test
 */
export function createGitObjectsTests(
  name: string,
  factory: () => Promise<GitObjectsTestContext>,
): void {
  describe(`GitObjects [${name}]`, () => {
    let ctx: GitObjectsTestContext;
    let objects: GitObjects;
    let store: StagingBlobStore;
    const corpus = [...gitObjectSamples(), largeBlob()];
    const blob = corpus[corpus.length - 1] as GitObjectSample;
    const commit = corpus.find((o) => o.type === "commit") as GitObjectSample;

    beforeEach(async () => {
      ctx = await factory();
      objects = ctx.objects;
      store = ctx.store;
    });

    afterEach(async () => {
      await ctx.cleanup?.();
    });

    it("put(type, size, content) returns git's id for every sample object", async () => {
      for (const o of corpus) {
        const id = await objects.put(o.type, body(o).length, chunked(body(o), 7));
        expect(id, o.name).toBe(o.id);
      }
    });

    it("accepts a plain array of chunks as content", async () => {
      const bytes = enc.encode("hello\n");
      expect(await objects.put("blob", bytes.length, [bytes])).toBe(
        "ce013625030ba8dba906f756967f9e9ca394464a",
      );
      expect(await objects.put("blob", 0, [])).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    });

    it("accepts 1-byte and empty chunks anywhere, header included", async () => {
      const raw = commit.raw;
      async function* bytewise() {
        for (const b of raw) {
          yield new Uint8Array(0);
          yield Uint8Array.of(b);
        }
        yield new Uint8Array(0);
      }
      await objects.putRaw(commit.id, bytewise());
      expect(await collect(objects.getRaw(commit.id))).toEqual(raw);
    });

    it("putRaw then getRaw is byte-identical; get returns type, size and content", async () => {
      for (const o of corpus) {
        await objects.putRaw(o.id, chunked(o.raw, 5));
        expect(await collect(objects.getRaw(o.id)), o.name).toEqual(o.raw);
        const g = await objects.get(o.id, { verify: true });
        expect(g?.type, o.name).toBe(o.type);
        expect(g?.size, o.name).toBe(body(o).length);
        expect(await collect(g?.content ?? []), o.name).toEqual(body(o));
      }
    });

    it("stores zlib loose objects under their ids, and lists exactly those ids", async () => {
      for (const o of corpus) await objects.put(o.type, body(o).length, [body(o)]);
      for (const o of corpus) {
        expect(await unzlib(await collect(store.get(o.id))), o.name).toEqual(o.raw);
      }
      const listed: string[] = [];
      for await (const id of objects.list()) listed.push(id);
      expect(listed.sort()).toEqual(corpus.map((o) => o.id).sort());
    });

    it("an absent object: has false, get undefined, getRaw empty, remove false", async () => {
      expect(await objects.has(blob.id)).toBe(false);
      expect(await objects.get(blob.id)).toBeUndefined();
      expect(await objects.get(blob.id, { verify: true })).toBeUndefined();
      expect((await collect(objects.getRaw(blob.id))).length).toBe(0);
      expect(await objects.remove(blob.id)).toBe(false);
    });

    it("remove deletes a stored object", async () => {
      await objects.putRaw(blob.id, [blob.raw]);
      expect(await objects.remove(blob.id)).toBe(true);
      expect(await objects.has(blob.id)).toBe(false);
      expect(await storedIds(store)).toEqual([]);
    });

    it("a non-id is absent for has, get and getRaw; putRaw and remove refuse it", async () => {
      for (const bad of ["../config", blob.id.toUpperCase(), blob.id.slice(1), `${blob.id}0`]) {
        expect(await objects.has(bad), bad).toBe(false);
        expect(await objects.get(bad), bad).toBeUndefined();
        expect((await collect(objects.getRaw(bad))).length, bad).toBe(0);
        await expect(objects.putRaw(bad, [blob.raw]), bad).rejects.toBeInstanceOf(
          InvalidObjectIdError,
        );
        await expect(objects.remove(bad), bad).rejects.toBeInstanceOf(InvalidObjectIdError);
      }
      expect(await storedIds(store)).toEqual([]);
    });

    it("putRaw with a wrong id rejects with ObjectIdMismatchError and stores nothing", async () => {
      await expect(objects.putRaw(commit.id, [blob.raw])).rejects.toBeInstanceOf(
        ObjectIdMismatchError,
      );
      expect(await storedIds(store)).toEqual([]);
    });

    it("putRaw of a malformed object rejects with CorruptObjectError and stores nothing", async () => {
      // Each id is the real SHA-1 of the malformed bytes: only header checks can reject them.
      const bad = [
        "blub 3\0abc",
        "blob 3abc",
        "blob 4\0abc",
        "blob 2\0abc",
        "blob 03\0abc",
        "blob -1\0abc",
        "blob\0",
        "",
      ];
      for (const text of bad) {
        const raw = enc.encode(text);
        await expect(objects.putRaw(idOf(raw), [raw]), JSON.stringify(text)).rejects.toBeInstanceOf(
          CorruptObjectError,
        );
      }
      await expect(objects.putRaw(idOf(new Uint8Array(0)), [])).rejects.toBeInstanceOf(
        CorruptObjectError,
      );
      expect(await storedIds(store)).toEqual([]);
    });

    it("put with a size lie (short or long) rejects with SizeMismatchError and stores nothing", async () => {
      const b = body(blob);
      await expect(objects.put("blob", b.length + 1, [b])).rejects.toBeInstanceOf(
        SizeMismatchError,
      );
      await expect(objects.put("blob", b.length - 1, [b])).rejects.toBeInstanceOf(
        SizeMismatchError,
      );
      expect(await storedIds(store)).toEqual([]);
    });

    it("put refuses an unknown type or a bad size", async () => {
      await expect(objects.put("blub" as ObjectTypeString, 0, [])).rejects.toBeInstanceOf(
        TypeError,
      );
      await expect(objects.put("blob", -1, [])).rejects.toBeInstanceOf(RangeError);
      await expect(objects.put("blob", 1.5, [])).rejects.toBeInstanceOf(RangeError);
    });

    it("storing an object again, and 10 concurrent puts, leave one object", async () => {
      const b = body(blob);
      await objects.put("blob", b.length, [b]);
      await objects.putRaw(blob.id, [blob.raw]);
      const ids = await Promise.all(
        Array.from({ length: 10 }, () => objects.put("blob", b.length, chunked(b, 4096))),
      );
      expect(new Set(ids)).toEqual(new Set([blob.id]));
      expect(await storedIds(store)).toEqual([blob.id]);
    });

    const corruptions: [string, (z: Uint8Array) => Promise<Uint8Array> | Uint8Array][] = [
      ["a truncated zlib stream", (z) => z.subarray(0, z.length - 9)],
      ["bytes after the zlib stream", (z) => Uint8Array.of(...z, 1, 2, 3)],
      ["a header size that disagrees with the body", () => zlib(enc.encode("blob 5\0abc"))],
      ["bytes that are not zlib", () => enc.encode("plain text, not deflated")],
      ["an unknown type in the header", () => zlib(enc.encode("blub 3\0abc"))],
      ["zero bytes (an empty file)", () => new Uint8Array(0)],
      ["a zlib stream of nothing", () => zlib(new Uint8Array(0))],
    ];
    for (const [what, corrupt] of corruptions) {
      it(`reading an object with ${what} raises CorruptObjectError`, async () => {
        await plant(store, blob.id, await corrupt(await zlib(blob.raw)));
        expect(await objects.has(blob.id)).toBe(true);
        const viaGet = (async () => {
          const g = await objects.get(blob.id);
          if (!g) throw new Error("get returned undefined for a stored object");
          await collect(g.content);
        })();
        await expect(viaGet).rejects.toBeInstanceOf(CorruptObjectError);
        await expect(collect(objects.getRaw(blob.id))).rejects.toBeInstanceOf(CorruptObjectError);
      });
    }

    it("get with verify detects an object whose bytes hash to another id", async () => {
      await plant(store, blob.id, await zlib(commit.raw)); // a valid object, wrong name
      const g = await objects.get(blob.id, { verify: true });
      await expect(collect(g?.content ?? [])).rejects.toBeInstanceOf(ObjectIdMismatchError);
    });

    it("get().content is single-use: a second iteration throws", async () => {
      await objects.putRaw(blob.id, [blob.raw]);
      const g = await objects.get(blob.id);
      await collect(g?.content ?? []);
      await expect(collect(g?.content ?? [])).rejects.toThrow();
    });

    it("reading only the header and releasing the content is enough", async () => {
      await objects.putRaw(blob.id, [blob.raw]);
      for (let i = 0; i < 20; i++) {
        const g = await objects.get(blob.id);
        expect(g?.size).toBe(body(blob).length);
        await g?.content[Symbol.asyncIterator]().return?.();
      }
      expect(await collect(objects.getRaw(blob.id))).toEqual(blob.raw);
    });

    it("a failing store closes the source of put (no dangling pump)", async () => {
      let closed = false;
      const source: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              return { done: false, value: crypto.getRandomValues(new Uint8Array(64 * 1024)) };
            },
            async return() {
              closed = true;
              return { done: true, value: undefined };
            },
          };
        },
      };
      const failing: StagingBlobStore = {
        ...store,
        async putStaged(bytes) {
          for await (const _ of bytes) throw new Error("disk full");
          throw new Error("unreachable");
        },
      };
      await expect(createGitObjects(failing).put("blob", 1 << 30, source)).rejects.toThrow(
        "disk full",
      );
      expect(closed).toBe(true);
    });

    it("putUnsized spools large content and leaves only the object behind", async () => {
      const size = 3 * 1024 * 1024 + 17; // above the default 1 MiB spool threshold
      const hasher = createSha1().update(enc.encode(`blob ${size}\0`));
      for await (const c of lazyNoise(size, 65536)) hasher.update(c);
      const expected = bytesToHex(hasher.digest());
      expect(await objects.putUnsized("blob", lazyNoise(size, 65536))).toBe(expected);
      expect(await storedIds(store)).toEqual([expected]);
      expect((await objects.get(expected))?.size).toBe(size);
    });

    it("writes a 50 MiB blob of known size without the producer running ahead of the store", async () => {
      const persisted = ctx.persistedBytes;
      if (!persisted) return;
      const size = 50 * 1024 * 1024;
      const start = persisted();
      let maxLag = 0;
      const id = await objects.put(
        "blob",
        size,
        lazyNoise(size, 256 * 1024, (produced) => {
          maxLag = Math.max(maxLag, produced - (persisted() - start));
        }),
      );
      // a few MiB of deflate window and storage chunk, never the whole blob
      expect(maxLag).toBeLessThan(8 * 1024 * 1024);
      // read it back streaming, re-hashing on the way
      const obj = await objects.get(id, { verify: true });
      expect(obj?.size).toBe(size);
      let read = 0;
      let largest = 0;
      for await (const c of obj?.content ?? []) {
        read += c.length;
        largest = Math.max(largest, c.length);
      }
      expect(read).toBe(size);
      expect(largest).toBeLessThanOrEqual(4 * 1024 * 1024);
    }, 120_000);
  });
}
