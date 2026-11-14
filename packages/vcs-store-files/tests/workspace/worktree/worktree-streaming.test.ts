/**
 * FileWorktree and FileTreeIterator hash worktree files and check blobs out as
 * streams: a 50 MiB file is never collected into one buffer.
 */
import {
  type Blobs,
  createInMemoryFilesApi,
  FileMode,
  type FilesApi,
  type Trees,
} from "@statewalker/vcs-core";
import { createFileTreeIterator, createFileWorktree } from "@statewalker/vcs-store-files";
import { createSha1, type Hasher } from "@statewalker/vcs-utils/hash/hasher";
import { describe, expect, it } from "vitest";

const MiB = 1024 * 1024;
const BIG = 50 * MiB;
const CHUNK = 256 * 1024;
const enc = new TextEncoder();

/** The byte at `offset` of the big test file. */
const byteAt = (offset: number) => (offset * 31 + 7) & 0xff;

function makeChunk(offset: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = byteAt(offset + i);
  return out;
}

/** The blob id of the big file, hashed independently of the code under test. */
function bigFileId(): string {
  const h = createSha1().update(enc.encode(`blob ${BIG}\0`));
  for (let off = 0; off < BIG; off += CHUNK) h.update(makeChunk(off, Math.min(CHUNK, BIG - off)));
  return Array.from(h.digest(), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Tracks how far reading ran ahead of hashing: each time the reader is resumed
 * for the next chunk, the bytes it produced so far minus the bytes the hasher
 * received. A collected read runs the whole file ahead.
 */
interface Tracker {
  produced: number;
  hashed: number;
  maxReadAhead: number;
}

function trackingHasher(tracker: Tracker): () => Hasher {
  return () => {
    const inner = createSha1();
    const self: Hasher = {
      update(data) {
        tracker.hashed += data.length;
        inner.update(data);
        return self;
      },
      digest: () => inner.digest(),
      clone: () => inner.clone(),
    };
    return self;
  };
}

/** An in-memory FilesApi that serves `/repo/big.bin` lazily, chunk by chunk. */
function lazyBigFileApi(tracker: Tracker, header: number): FilesApi {
  const base = createInMemoryFilesApi();
  const path = "/repo/big.bin";
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "stats") {
        return async (p: string) =>
          p === path ? { kind: "file", size: BIG, lastModified: 1 } : target.stats(p);
      }
      if (prop === "read") {
        return (p: string) => {
          if (p !== path) return target.read(p);
          return (async function* () {
            for (let off = 0; off < BIG; off += CHUNK) {
              const len = Math.min(CHUNK, BIG - off);
              // the header is hashed before any content
              const ahead = tracker.produced - (tracker.hashed - header);
              tracker.maxReadAhead = Math.max(tracker.maxReadAhead, ahead);
              tracker.produced += len;
              yield makeChunk(off, len);
            }
          })();
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as FilesApi;
}

describe("worktree hashing streams", () => {
  const expectedId = bigFileId();
  const header = enc.encode(`blob ${BIG}\0`).length;

  it("FileWorktree.computeHash hashes a 50 MiB file without collecting it", async () => {
    const tracker: Tracker = { produced: 0, hashed: 0, maxReadAhead: 0 };
    const worktree = createFileWorktree({
      files: lazyBigFileApi(tracker, header),
      rootPath: "/repo",
      blobs: {} as Blobs,
      trees: {} as Trees,
      newHasher: trackingHasher(tracker),
    });
    expect(await worktree.computeHash("big.bin")).toBe(expectedId);
    expect(tracker.produced).toBe(BIG);
    expect(tracker.maxReadAhead).toBeLessThanOrEqual(MiB);
  });

  it("FileTreeIterator.computeHash hashes a 50 MiB file without collecting it", async () => {
    const tracker: Tracker = { produced: 0, hashed: 0, maxReadAhead: 0 };
    const iterator = createFileTreeIterator({
      files: lazyBigFileApi(tracker, header),
      rootPath: "/repo",
      newHasher: trackingHasher(tracker),
    });
    expect(await iterator.computeHash("big.bin")).toBe(expectedId);
    expect(tracker.maxReadAhead).toBeLessThanOrEqual(MiB);
  });

  it("FileWorktree.computeHash retries once when the size changed since stat", async () => {
    const base = createInMemoryFilesApi();
    await base.write("/repo/a.txt", [enc.encode("hello\n")]);
    let stats = 0;
    const files = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "stats") {
          return async (p: string) => {
            const s = await target.stats(p);
            // the first stat is stale: the file grew after it
            return s && p === "/repo/a.txt" && ++stats === 1 ? { ...s, size: 3 } : s;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FilesApi;
    const worktree = createFileWorktree({
      files,
      rootPath: "/repo",
      blobs: {} as Blobs,
      trees: {} as Trees,
    });
    expect(await worktree.computeHash("a.txt")).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
    expect(stats).toBe(2);
  });
});

describe("checkout writes stream", () => {
  it("FileWorktree.checkoutTree feeds a 50 MiB blob to FilesApi.write incrementally", async () => {
    const blobId = "b".repeat(40);
    let produced = 0;
    let consumed = 0;
    let maxOutstanding = 0;
    let largestChunk = 0;
    let written = 0;

    const blobs = {
      load: async (id: string) =>
        id === blobId
          ? (async function* () {
              for (let off = 0; off < BIG; off += CHUNK) {
                produced++;
                yield new Uint8Array(Math.min(CHUNK, BIG - off));
              }
            })()
          : undefined,
    } as unknown as Blobs;
    const trees = {
      load: async () =>
        (async function* () {
          yield { name: "big.bin", mode: FileMode.REGULAR_FILE, id: blobId };
        })(),
    } as unknown as Trees;

    const base = createInMemoryFilesApi();
    const files = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "write") {
          return async (
            _p: string,
            content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
          ): Promise<void> => {
            for await (const chunk of content) {
              consumed++;
              maxOutstanding = Math.max(maxOutstanding, produced - consumed);
              largestChunk = Math.max(largestChunk, chunk.length);
              written += chunk.length;
            }
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as FilesApi;

    const worktree = createFileWorktree({ files, rootPath: "/repo", blobs, trees });
    const result = await worktree.checkoutTree("t".repeat(40), { force: true });

    expect(result.failed).toEqual([]);
    expect(result.updated).toEqual(["big.bin"]);
    expect(written).toBe(BIG);
    expect(largestChunk).toBeLessThanOrEqual(CHUNK);
    // each chunk reaches write before the next one is loaded
    expect(maxOutstanding).toBe(0);
  });
});

describe("worktree hashing: a path that changed type", () => {
  it("says a directory is a directory, not a missing file", async () => {
    const files = createInMemoryFilesApi();
    await files.mkdir("/repo/now-a-dir");
    await files.write("/repo/now-a-dir/inner.txt", [enc.encode("x")]);
    const worktree = createFileWorktree({
      files,
      rootPath: "/repo",
      blobs: {} as Blobs,
      trees: {} as Trees,
    });
    await expect(worktree.computeHash("now-a-dir")).rejects.toThrow(/Is a directory/);
  });
});
