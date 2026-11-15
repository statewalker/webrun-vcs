/**
 * Tests for SQL blob store chunked storage feature
 *
 * Verifies that large blobs are stored in compressed chunks
 * while small blobs remain inline.
 */

import { encodeObjectHeader, type History } from "@statewalker/vcs-core";
import { bytesToHex, collect, createSha1 } from "@statewalker/vcs-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import { SqlGcStrategy } from "../src/gc-strategy.js";
import { SqlNativeBlobStoreImpl } from "../src/native/sql-native-blob-store.js";

/** Chunk size used by the blob store (256KB) */
const CHUNK_SIZE = 262144;

/** Threshold for chunked storage (256KB) */
const CHUNK_THRESHOLD = 262144;

describe("SqlNativeBlobStore chunked storage", () => {
  let db: SqlJsAdapter;
  let store: SqlNativeBlobStoreImpl;

  beforeEach(async () => {
    db = await SqlJsAdapter.create();
    store = new SqlNativeBlobStoreImpl(db);
  });

  afterEach(async () => {
    await db.close();
  });

  /** Helper to create async iterable from Uint8Array */
  async function* toStream(data: Uint8Array): AsyncIterable<Uint8Array> {
    yield data;
  }

  /** Helper to collect async iterable into single Uint8Array */
  async function collectBytes(
    iterable: AsyncIterable<Uint8Array> | Promise<AsyncIterable<Uint8Array> | undefined>,
  ): Promise<Uint8Array> {
    const resolved = await iterable;
    if (!resolved) {
      throw new Error("Blob not found");
    }
    return collect(resolved);
  }

  /** Compute expected Git blob hash */
  function computeGitBlobId(content: Uint8Array): string {
    const sha1 = createSha1();
    sha1.update(encodeObjectHeader("blob", content.length));
    sha1.update(content);
    return bytesToHex(sha1.digest());
  }

  describe("storage type selection", () => {
    it("stores small blob inline", async () => {
      const content = new TextEncoder().encode("small content");
      const id = await store.store(toStream(content));

      // Verify storage type via direct query
      const rows = await db.query<{ storage_type: string | null }>(
        `SELECT storage_type FROM vcs_blob WHERE blob_id = ?`,
        [id],
      );
      expect(rows[0].storage_type).toBe("inline");
    });

    it("stores blob exactly at threshold inline", async () => {
      const content = new Uint8Array(CHUNK_THRESHOLD).fill(65);
      const id = await store.store(toStream(content));

      const rows = await db.query<{ storage_type: string | null }>(
        `SELECT storage_type FROM vcs_blob WHERE blob_id = ?`,
        [id],
      );
      expect(rows[0].storage_type).toBe("inline");
    });

    it("stores large blob in chunks", async () => {
      const content = new Uint8Array(CHUNK_THRESHOLD + 1).fill(65);
      const id = await store.store(toStream(content));

      // Verify storage type
      const rows = await db.query<{ storage_type: string | null; size: number }>(
        `SELECT storage_type, size FROM vcs_blob WHERE blob_id = ?`,
        [id],
      );
      expect(rows[0].storage_type).toBe("chunked");
      expect(rows[0].size).toBe(CHUNK_THRESHOLD + 1);

      // Verify content is NULL (stored in chunks)
      const contentRows = await db.query<{ content: Uint8Array | null }>(
        `SELECT content FROM vcs_blob WHERE blob_id = ?`,
        [id],
      );
      expect(contentRows[0].content).toBeNull();
    });
  });

  describe("chunk storage", () => {
    it("creates correct number of chunks", async () => {
      // 500KB blob should create 2 chunks (256KB + 244KB)
      const size = 500_000;
      const content = new Uint8Array(size).fill(66);
      const id = await store.store(toStream(content));

      // Get blob FK
      const blobRows = await db.query<{ id: number }>(`SELECT id FROM vcs_blob WHERE blob_id = ?`, [
        id,
      ]);
      const blobFk = blobRows[0].id;

      // Count chunks
      const chunkRows = await db.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM vcs_blob_chunk WHERE blob_fk = ?`,
        [blobFk],
      );
      expect(chunkRows[0].cnt).toBe(2);
    });

    it("stores chunks with correct metadata", async () => {
      const size = 500_000;
      const content = new Uint8Array(size).fill(67);
      const id = await store.store(toStream(content));

      // Get blob FK
      const blobRows = await db.query<{ id: number }>(`SELECT id FROM vcs_blob WHERE blob_id = ?`, [
        id,
      ]);
      const blobFk = blobRows[0].id;

      // Get chunk metadata
      const chunks = await db.query<{
        position: number;
        chunk_offset: number;
        chunk_length: number;
        compressed_length: number;
      }>(
        `SELECT position, chunk_offset, chunk_length, compressed_length FROM vcs_blob_chunk WHERE blob_fk = ? ORDER BY position`,
        [blobFk],
      );

      expect(chunks.length).toBe(2);

      // First chunk: position 0, offset 0, length 256KB
      expect(chunks[0].position).toBe(0);
      expect(chunks[0].chunk_offset).toBe(0);
      expect(chunks[0].chunk_length).toBe(CHUNK_SIZE);
      expect(chunks[0].compressed_length).toBeGreaterThan(0);
      expect(chunks[0].compressed_length).toBeLessThan(CHUNK_SIZE); // Should be compressed

      // Second chunk: position 1, offset 256KB, remaining bytes
      expect(chunks[1].position).toBe(1);
      expect(chunks[1].chunk_offset).toBe(CHUNK_SIZE);
      expect(chunks[1].chunk_length).toBe(size - CHUNK_SIZE);
    });

    it("compresses chunks effectively for compressible data", async () => {
      // Highly compressible content (all zeros)
      const size = 500_000;
      const content = new Uint8Array(size).fill(0);
      const id = await store.store(toStream(content));

      // Get total compressed size
      const blobRows = await db.query<{ id: number }>(`SELECT id FROM vcs_blob WHERE blob_id = ?`, [
        id,
      ]);
      const blobFk = blobRows[0].id;

      const totalRows = await db.query<{ total: number }>(
        `SELECT SUM(compressed_length) as total FROM vcs_blob_chunk WHERE blob_fk = ?`,
        [blobFk],
      );

      // Compressed size should be much smaller than original
      expect(totalRows[0].total).toBeLessThan(size * 0.1); // Less than 10%
    });
  });

  describe("round-trip integrity", () => {
    it("round-trips small blob content correctly", async () => {
      const content = new TextEncoder().encode("Small blob content for testing");
      const id = await store.store(toStream(content));
      const loaded = await collectBytes(store.load(id));

      expect(loaded.length).toBe(content.length);
      expect(loaded).toEqual(content);
    });

    it("round-trips large blob content correctly", { timeout: 30000 }, async () => {
      // 1MB with pattern
      const size = 1_000_000;
      const content = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        content[i] = i % 256;
      }

      const id = await store.store(toStream(content));
      const loaded = await collectBytes(store.load(id));

      expect(loaded.length).toBe(content.length);
      expect(loaded).toEqual(content);
    });

    it("round-trips binary data correctly", { timeout: 30000 }, async () => {
      // 500KB of all byte values
      const size = 500_000;
      const content = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        content[i] = i % 256;
      }

      const id = await store.store(toStream(content));
      const loaded = await collectBytes(store.load(id));

      expect(loaded).toEqual(content);
    });
  });

  describe("deduplication", () => {
    it("deduplicates small blobs", async () => {
      const content = new TextEncoder().encode("Duplicate small content");

      const id1 = await store.store(toStream(content));
      const id2 = await store.store(toStream(content));

      expect(id1).toBe(id2);

      // Only one blob record
      const countRows = await db.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM vcs_blob WHERE blob_id = ?`,
        [id1],
      );
      expect(countRows[0].cnt).toBe(1);
    });

    it("deduplicates large blobs", async () => {
      const content = new Uint8Array(500_000).fill(68);

      const id1 = await store.store(toStream(content));
      const id2 = await store.store(toStream(content));

      expect(id1).toBe(id2);

      // Only one blob record
      const countRows = await db.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM vcs_blob WHERE blob_id = ?`,
        [id1],
      );
      expect(countRows[0].cnt).toBe(1);
    });
  });

  describe("streaming load", () => {
    it("yields single chunk for inline blobs", async () => {
      const content = new TextEncoder().encode("Inline content");
      const id = await store.store(toStream(content));

      let chunkCount = 0;
      const stream = await store.load(id);
      if (!stream) throw new Error("Blob not found");
      for await (const chunk of stream) {
        chunkCount++;
        expect(chunk.length).toBe(content.length);
      }
      expect(chunkCount).toBe(1);
    });

    it("yields multiple chunks for chunked blobs", async () => {
      const content = new Uint8Array(500_000).fill(69);
      const id = await store.store(toStream(content));

      let chunkCount = 0;
      let totalBytes = 0;
      const stream = await store.load(id);
      if (!stream) throw new Error("Blob not found");
      for await (const chunk of stream) {
        chunkCount++;
        totalBytes += chunk.length;
        expect(chunk.length).toBeLessThanOrEqual(CHUNK_SIZE);
      }

      expect(chunkCount).toBe(2);
      expect(totalBytes).toBe(500_000);
    });
  });

  describe("metadata operations", () => {
    it("returns correct size for inline blobs", async () => {
      const content = new TextEncoder().encode("Size test inline");
      const id = await store.store(toStream(content));

      const size = await store.size(id);
      expect(size).toBe(content.length);
    });

    it("returns correct size for chunked blobs", async () => {
      const content = new Uint8Array(500_000).fill(70);
      const id = await store.store(toStream(content));

      const size = await store.size(id);
      expect(size).toBe(500_000);
    });

    it("has() works for chunked blobs", async () => {
      const content = new Uint8Array(500_000).fill(71);
      const id = await store.store(toStream(content));

      expect(await store.has(id)).toBe(true);
      expect(await store.has("nonexistent")).toBe(false);
    });
  });

  describe("deletion", () => {
    it("deletes inline blobs", async () => {
      const content = new TextEncoder().encode("Delete inline test");
      const id = await store.store(toStream(content));

      expect(await store.has(id)).toBe(true);
      const deleted = await store.remove(id);
      expect(deleted).toBe(true);
      expect(await store.has(id)).toBe(false);
    });

    it("deletes chunked blobs and their chunks", async () => {
      const content = new Uint8Array(500_000).fill(72);
      const id = await store.store(toStream(content));

      // Get blob FK before deletion
      const blobRows = await db.query<{ id: number }>(`SELECT id FROM vcs_blob WHERE blob_id = ?`, [
        id,
      ]);
      const blobFk = blobRows[0].id;

      // Verify chunks exist
      const beforeChunks = await db.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM vcs_blob_chunk WHERE blob_fk = ?`,
        [blobFk],
      );
      expect(beforeChunks[0].cnt).toBe(2);

      // Delete
      const deleted = await store.remove(id);
      expect(deleted).toBe(true);
      expect(await store.has(id)).toBe(false);

      // Verify chunks are deleted (CASCADE)
      const afterChunks = await db.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM vcs_blob_chunk WHERE blob_fk = ?`,
        [blobFk],
      );
      expect(afterChunks[0].cnt).toBe(0);
    });
  });

  describe("Git compatibility", () => {
    it("produces correct hash for inline blobs", async () => {
      const content = new TextEncoder().encode("Git hash test inline");
      const expectedId = computeGitBlobId(content);

      const id = await store.store(toStream(content));

      expect(id).toBe(expectedId);
      expect(id).toMatch(/^[0-9a-f]{40}$/);
    });

    it("produces correct hash for chunked blobs", async () => {
      const content = new Uint8Array(500_000).fill(73);
      const expectedId = computeGitBlobId(content);

      const id = await store.store(toStream(content));

      expect(id).toBe(expectedId);
      expect(id).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  describe("multi-chunk input handling", () => {
    it("handles content provided in multiple small chunks", { timeout: 15000 }, async () => {
      // Stream content in 10KB chunks
      const totalSize = 500_000;
      const chunkSize = 10_000;
      const content = new Uint8Array(totalSize);
      for (let i = 0; i < totalSize; i++) {
        content[i] = i % 256;
      }

      async function* multiChunkStream() {
        for (let offset = 0; offset < totalSize; offset += chunkSize) {
          yield content.subarray(offset, Math.min(offset + chunkSize, totalSize));
        }
      }

      const id = await store.store(multiChunkStream());
      const loaded = await collectBytes(store.load(id));

      expect(loaded).toEqual(content);
    });

    it("handles irregular chunk sizes in input", { timeout: 15000 }, async () => {
      const parts = [
        new Uint8Array(100_000).fill(1),
        new Uint8Array(200_000).fill(2),
        new Uint8Array(150_000).fill(3),
        new Uint8Array(50_000).fill(4),
      ];
      const totalSize = parts.reduce((sum, p) => sum + p.length, 0);

      async function* irregularStream() {
        for (const part of parts) {
          yield part;
        }
      }

      const id = await store.store(irregularStream());

      // Verify correct size
      const size = await store.size(id);
      expect(size).toBe(totalSize);

      // Verify storage type
      const rows = await db.query<{ storage_type: string | null }>(
        `SELECT storage_type FROM vcs_blob WHERE blob_id = ?`,
        [id],
      );
      expect(rows[0].storage_type).toBe("chunked");

      // Verify round-trip
      const loaded = await collectBytes(store.load(id));
      expect(loaded.length).toBe(totalSize);

      // Verify content byte by byte
      let offset = 0;
      for (const part of parts) {
        expect(loaded.subarray(offset, offset + part.length)).toEqual(part);
        offset += part.length;
      }
    });
  });

  describe("aggregate operations", () => {
    it("count() includes both inline and chunked blobs", async () => {
      // Store inline blob
      await store.store(toStream(new TextEncoder().encode("inline")));

      // Store chunked blob
      await store.store(toStream(new Uint8Array(500_000).fill(74)));

      expect(await store.count()).toBe(2);
    });

    it("totalSize() includes both inline and chunked blobs", async () => {
      const inlineContent = new TextEncoder().encode("inline content");
      const chunkedSize = 500_000;

      await store.store(toStream(inlineContent));
      await store.store(toStream(new Uint8Array(chunkedSize).fill(75)));

      expect(await store.totalSize()).toBe(inlineContent.length + chunkedSize);
    });

    it("keys() yields both inline and chunked blob IDs", async () => {
      const inlineId = await store.store(toStream(new TextEncoder().encode("inline keys")));
      const chunkedId = await store.store(toStream(new Uint8Array(500_000).fill(76)));

      const keys: string[] = [];
      for await (const key of store.keys()) {
        keys.push(key);
      }

      expect(keys).toContain(inlineId);
      expect(keys).toContain(chunkedId);
      expect(keys.length).toBe(2);
    });
  });
});

describe("SqlNativeBlobStore streaming writes", () => {
  let db: SqlJsAdapter;
  let written: () => number;

  beforeEach(async () => {
    db = await SqlJsAdapter.create();
    let n = 0;
    const execute = db.execute.bind(db);
    db.execute = (sql, params) => {
      for (const p of params ?? []) if (p instanceof Uint8Array) n += p.length;
      return execute(sql, params);
    };
    written = () => n;
  });

  afterEach(async () => {
    await db.close();
  });

  /** Barely compressible bytes, generated as they are pulled; `onChunk` sees bytes produced so far. */
  function lazy(total: number, onChunk: (produced: number) => void) {
    return (async function* () {
      let x = 99;
      for (let produced = 0; produced < total; ) {
        onChunk(produced);
        const out = new Uint8Array(Math.min(64 * 1024, total - produced));
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

  async function expectedId(total: number): Promise<string> {
    const sha1 = createSha1();
    sha1.update(encodeObjectHeader("blob", total));
    for await (const c of lazy(total, () => {})) sha1.update(c);
    return bytesToHex(sha1.digest());
  }

  for (const known of [true, false]) {
    it(`writes a large blob chunk by chunk (${known ? "known" : "unknown"} size)`, async () => {
      const store = new SqlNativeBlobStoreImpl(db);
      const total = 8 * 1024 * 1024;
      let maxLag = 0;
      const start = written();
      const content = lazy(total, (produced) => {
        maxLag = Math.max(maxLag, produced - (written() - start));
      });
      const id = await store.store(content, known ? total : undefined);
      expect(id).toBe(await expectedId(total));
      expect(maxLag).toBeLessThanOrEqual(1024 * 1024);
      expect(await store.size(id)).toBe(total);
      expect(await store.count()).toBe(1);
      const keys: string[] = [];
      for await (const k of store.keys()) keys.push(k);
      expect(keys).toEqual([id]);
      let read = 0;
      for await (const c of (await store.load(id)) ?? []) read += c.length;
      expect(read).toBe(total);
    });
  }

  it("stores nothing when a large blob is not as long as its size", async () => {
    const store = new SqlNativeBlobStoreImpl(db);
    await expect(
      store.store(
        lazy(1024 * 1024, () => {}),
        2 * 1024 * 1024,
      ),
    ).rejects.toMatchObject({
      name: "SizeMismatchError",
    });
    await expect(
      store.store(
        lazy(1024 * 1024, () => {}),
        512 * 1024,
      ),
    ).rejects.toMatchObject({
      name: "SizeMismatchError",
    });
    expect(await store.count()).toBe(0);
    const chunks = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM vcs_blob_chunk");
    expect(chunks[0]?.n).toBe(0);
  });

  it("keeps the existing copy when a large blob is stored twice", async () => {
    const store = new SqlNativeBlobStoreImpl(db);
    const total = 600 * 1024;
    const a = await store.store(
      lazy(total, () => {}),
      total,
    );
    const b = await store.store(lazy(total, () => {}));
    expect(b).toBe(a);
    expect(await store.count()).toBe(1);
    const chunks = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM vcs_blob_chunk");
    expect(chunks[0]?.n).toBe(3);
  });
});

describe("SqlNativeBlobStore early stops and leftovers", () => {
  let db: SqlJsAdapter;
  beforeEach(async () => {
    db = await SqlJsAdapter.create();
  });
  afterEach(async () => {
    await db.close();
  });

  it("releases the source when a large blob is longer than its size", async () => {
    const store = new SqlNativeBlobStoreImpl(db);
    let released = false;
    let pulled = 0;
    const source = (async function* () {
      try {
        for (let i = 0; i < 64; i++) {
          pulled++;
          yield new Uint8Array(64 * 1024).fill(i);
        }
      } finally {
        released = true;
      }
    })();
    await expect(store.store(source, 600 * 1024)).rejects.toMatchObject({
      name: "SizeMismatchError",
    });
    expect(pulled).toBeLessThan(64);
    expect(released).toBe(true);
    expect(await store.count()).toBe(0);
  });

  it("sweeps tmp rows of a crashed write once older than the expiry", async () => {
    const store = new SqlNativeBlobStoreImpl(db);
    await store.store([new Uint8Array(10)]); // create the tables, one real blob
    const insertTmp = async (name: string, createdAt: number) => {
      const r = await db.execute(
        "INSERT INTO vcs_blob (blob_id, content, size, storage_type, created_at) VALUES (?, NULL, 0, 'chunked', ?)",
        [name, createdAt],
      );
      await db.execute(
        "INSERT INTO vcs_blob_chunk (blob_fk, position, chunk_offset, chunk_length, compressed_length, content) VALUES (?, 0, 0, 1, 1, ?)",
        [r.lastInsertRowId, new Uint8Array(1)],
      );
    };
    await insertTmp("tmp:old", Date.now() - 2 * 24 * 3600_000);
    await insertTmp("tmp:fresh", Date.now());
    // a chunk row whose blob row is gone
    await db.execute(
      "INSERT INTO vcs_blob_chunk (blob_fk, position, chunk_offset, chunk_length, compressed_length, content) VALUES (999, 0, 0, 1, 1, ?)",
      [new Uint8Array(1)],
    );
    expect(await store.sweepStale({ olderThanMs: 24 * 3600_000 })).toBe(2);
    const rows = await db.query<{ blob_id: string }>(
      "SELECT blob_id FROM vcs_blob ORDER BY blob_id",
    );
    expect(rows.map((r) => r.blob_id).filter((b) => b.startsWith("tmp:"))).toEqual(["tmp:fresh"]);
    const chunks = await db.query<{ n: number }>("SELECT COUNT(*) AS n FROM vcs_blob_chunk");
    expect(chunks[0]?.n).toBe(1);
    expect(await store.count()).toBe(1);
  });

  it("is what SqlGcStrategy sweeps for SQL native blobs", async () => {
    const store = new SqlNativeBlobStoreImpl(db);
    await store.store([new Uint8Array(10)]);
    await db.execute(
      "INSERT INTO vcs_blob (blob_id, content, size, storage_type, created_at) VALUES ('tmp:x', NULL, 0, 'chunked', 0)",
    );
    const strategy = new SqlGcStrategy({ blobs: store } as unknown as History);
    expect(await strategy.sweepStale(1000)).toBe(1);
  });
});

describe("SqlNativeBlobStore publish without its placeholder", () => {
  let db: SqlJsAdapter;
  beforeEach(async () => {
    db = await SqlJsAdapter.create();
  });
  afterEach(async () => {
    await db.close();
  });

  it("fails rather than report a blob that is not stored", async () => {
    const store = new SqlNativeBlobStoreImpl(db);
    await store.store([new Uint8Array(10)]); // create the tables
    const transaction = db.transaction.bind(db);
    // another process sweeps the placeholder (no age guard) just before it is published
    db.transaction = (async (fn: Parameters<typeof db.transaction>[0]) => {
      await db.execute("DELETE FROM vcs_blob WHERE blob_id LIKE 'tmp:%'", []);
      return transaction(fn);
    }) as typeof db.transaction;
    const big = new Uint8Array(600 * 1024).fill(3);
    await expect(store.store([big], big.length)).rejects.toThrow(/disappeared/);
    db.transaction = transaction;
    expect(await store.count()).toBe(1);
  });
});
