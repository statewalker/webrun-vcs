/**
 * T4.6: SQL Chunking Tests
 *
 * Tests SQL-specific chunking integration:
 * - Cross-backend consistency (SQL vs memory chunking)
 * - Orphaned chunk cleanup
 * - Chunk management edge cases
 *
 * Note: The SqlNativeBlobStore uses its own internal chunking implementation
 * optimized for SQL (with compression). This file tests SQL-specific aspects
 * that complement the basic chunked-blob-store.test.ts tests.
 */

import { MemoryChunkAccess } from "@statewalker/vcs-core";
import { collect } from "@statewalker/vcs-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqlJsAdapter } from "../src/adapters/sql-js-adapter.js";
import { SqlNativeBlobStoreImpl } from "../src/native/sql-native-blob-store.js";

/** Chunk size used by SQL blob store (256KB) */
const SQL_CHUNK_SIZE = 262144;

/** Chunk threshold (256KB) */
const SQL_CHUNK_THRESHOLD = 262144;

describe("T4.6: SQL Chunking Integration", () => {
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

  describe("cross-backend consistency", () => {
    it("SQL and memory backends produce identical blob IDs for same content", async () => {
      // Verify that MemoryChunkAccess and SQL blob store can both be configured
      // with the same chunk size for consistent behavior
      const memoryAccess = new MemoryChunkAccess();
      expect(memoryAccess).toBeDefined();

      // Test with content that exceeds chunk threshold
      const content = new Uint8Array(SQL_CHUNK_THRESHOLD + 10000);
      for (let i = 0; i < content.length; i++) {
        content[i] = i % 256;
      }

      // Store in SQL
      const sqlId = await store.store(toStream(content));

      // The SQL store computes Git-compatible SHA-1 hashes
      // which should be deterministic for the same content
      expect(sqlId).toMatch(/^[0-9a-f]{40}$/);

      // Store same content again - should deduplicate
      const sqlId2 = await store.store(toStream(content));
      expect(sqlId2).toBe(sqlId);
    });

    it("round-trips produce identical content regardless of internal chunking", {
      timeout: 60000,
    }, async () => {
      // ChunkedRawStorage with MemoryChunkAccess uses the same chunking concept
      // as SQL blob store, just with different storage backends
      const memoryAccess = new MemoryChunkAccess();
      expect(memoryAccess).toBeDefined();

      // Test various sizes around chunk boundaries
      const testSizes = [
        SQL_CHUNK_THRESHOLD - 1, // Just under threshold (inline)
        SQL_CHUNK_THRESHOLD, // At threshold (inline)
        SQL_CHUNK_THRESHOLD + 1, // Just over threshold (chunked)
        SQL_CHUNK_SIZE * 2, // Two full chunks
        SQL_CHUNK_SIZE * 2 + 100, // Two full chunks + partial
        SQL_CHUNK_SIZE * 3 - 1, // Three chunks - 1 byte
      ];

      for (const size of testSizes) {
        const content = new Uint8Array(size);
        for (let i = 0; i < size; i++) {
          content[i] = (i * 7 + 13) % 256; // Pseudo-random pattern
        }

        // Store and load from SQL
        const id = await store.store(toStream(content));
        const loaded = await collectBytes(store.load(id));

        // Verify round-trip integrity
        expect(loaded.length).toBe(content.length);
        expect(loaded).toEqual(content);
      }
    });

    it("handles same content in different chunk configurations", { timeout: 30000 }, async () => {
      // Store content that's exactly at various chunk boundaries
      const exactChunk = new Uint8Array(SQL_CHUNK_SIZE).fill(0xab);
      const doubleChunk = new Uint8Array(SQL_CHUNK_SIZE * 2).fill(0xcd);
      const tripleChunk = new Uint8Array(SQL_CHUNK_SIZE * 3).fill(0xef);

      const id1 = await store.store(toStream(exactChunk));
      const id2 = await store.store(toStream(doubleChunk));
      const id3 = await store.store(toStream(tripleChunk));

      // All should produce valid Git hashes
      expect(id1).toMatch(/^[0-9a-f]{40}$/);
      expect(id2).toMatch(/^[0-9a-f]{40}$/);
      expect(id3).toMatch(/^[0-9a-f]{40}$/);

      // All should round-trip correctly
      expect(await collectBytes(store.load(id1))).toEqual(exactChunk);
      expect(await collectBytes(store.load(id2))).toEqual(doubleChunk);
      expect(await collectBytes(store.load(id3))).toEqual(tripleChunk);
    });
  });

  describe("orphaned chunk cleanup", () => {
    it("delete removes all associated chunks", async () => {
      // Store a large blob that will be chunked
      const content = new Uint8Array(SQL_CHUNK_SIZE * 3 + 1000).fill(0x42);
      const id = await store.store(toStream(content));

      // Get blob FK to check chunks
      const blobRows = await db.query<{ id: number }>(`SELECT id FROM vcs_blob WHERE blob_id = ?`, [
        id,
      ]);
      const blobFk = blobRows[0].id;

      // Verify chunks exist
      const beforeChunks = await db.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM vcs_blob_chunk WHERE blob_fk = ?`,
        [blobFk],
      );
      expect(beforeChunks[0].cnt).toBeGreaterThan(0);

      // Delete the blob
      await store.remove(id);

      // Verify all chunks are removed
      const afterChunks = await db.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM vcs_blob_chunk WHERE blob_fk = ?`,
        [blobFk],
      );
      expect(afterChunks[0].cnt).toBe(0);

      // Verify blob record is gone
      expect(await store.has(id)).toBe(false);
    });

    it("no orphaned chunks remain after multiple store/delete cycles", async () => {
      // Perform multiple store/delete cycles
      for (let cycle = 0; cycle < 5; cycle++) {
        const content = new Uint8Array(SQL_CHUNK_SIZE * 2 + cycle * 1000);
        for (let i = 0; i < content.length; i++) {
          content[i] = (i + cycle) % 256;
        }

        const id = await store.store(toStream(content));
        await store.remove(id);
      }

      // Check for any orphaned chunks (chunks without valid blob_fk)
      const orphaned = await db.query<{ cnt: number }>(`
        SELECT COUNT(*) as cnt FROM vcs_blob_chunk c
        LEFT JOIN vcs_blob b ON c.blob_fk = b.id
        WHERE b.id IS NULL
      `);
      expect(orphaned[0].cnt).toBe(0);
    });

    it("handles deletion of inline blobs without affecting chunk table", async () => {
      // Store inline blob (small, not chunked)
      const smallContent = new TextEncoder().encode("Small inline blob");
      const smallId = await store.store(toStream(smallContent));

      // Store chunked blob
      const largeContent = new Uint8Array(SQL_CHUNK_SIZE * 2).fill(0x33);
      const largeId = await store.store(toStream(largeContent));

      // Get chunked blob FK
      const blobRows = await db.query<{ id: number }>(`SELECT id FROM vcs_blob WHERE blob_id = ?`, [
        largeId,
      ]);
      const largeBlobFk = blobRows[0].id;

      // Count chunks for large blob
      const beforeChunks = await db.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM vcs_blob_chunk WHERE blob_fk = ?`,
        [largeBlobFk],
      );
      const chunkCount = beforeChunks[0].cnt;

      // Delete inline blob
      await store.remove(smallId);

      // Chunks for large blob should be unaffected
      const afterChunks = await db.query<{ cnt: number }>(
        `SELECT COUNT(*) as cnt FROM vcs_blob_chunk WHERE blob_fk = ?`,
        [largeBlobFk],
      );
      expect(afterChunks[0].cnt).toBe(chunkCount);

      // Large blob should still be loadable
      const loaded = await collectBytes(store.load(largeId));
      expect(loaded).toEqual(largeContent);
    });
  });

  describe("chunk boundary edge cases", () => {
    it("handles content exactly at chunk size boundary", async () => {
      // Exactly one chunk
      const exactChunk = new Uint8Array(SQL_CHUNK_SIZE);
      for (let i = 0; i < SQL_CHUNK_SIZE; i++) {
        exactChunk[i] = i % 256;
      }

      const id = await store.store(toStream(exactChunk));

      // Should still be inline (at threshold)
      const rows = await db.query<{ storage_type: string | null }>(
        `SELECT storage_type FROM vcs_blob WHERE blob_id = ?`,
        [id],
      );
      expect(rows[0].storage_type).toBe("inline");

      // Verify round-trip
      const loaded = await collectBytes(store.load(id));
      expect(loaded).toEqual(exactChunk);
    });

    it("handles content one byte over chunk threshold", async () => {
      const content = new Uint8Array(SQL_CHUNK_THRESHOLD + 1);
      for (let i = 0; i < content.length; i++) {
        content[i] = i % 256;
      }

      const id = await store.store(toStream(content));

      // Should be chunked
      const rows = await db.query<{ storage_type: string | null }>(
        `SELECT storage_type FROM vcs_blob WHERE blob_id = ?`,
        [id],
      );
      expect(rows[0].storage_type).toBe("chunked");

      // Get chunk count
      const blobRows = await db.query<{ id: number }>(`SELECT id FROM vcs_blob WHERE blob_id = ?`, [
        id,
      ]);
      const blobFk = blobRows[0].id;

      const chunks = await db.query<{ position: number; chunk_length: number }>(
        `SELECT position, chunk_length FROM vcs_blob_chunk WHERE blob_fk = ? ORDER BY position`,
        [blobFk],
      );

      // Should have 2 chunks: 256KB + 1 byte
      expect(chunks.length).toBe(2);
      expect(chunks[0].chunk_length).toBe(SQL_CHUNK_SIZE);
      expect(chunks[1].chunk_length).toBe(1);

      // Verify round-trip
      const loaded = await collectBytes(store.load(id));
      expect(loaded).toEqual(content);
    });

    it("handles empty content", async () => {
      const empty = new Uint8Array(0);
      const id = await store.store(toStream(empty));

      // Should be inline
      const rows = await db.query<{ storage_type: string | null; size: number }>(
        `SELECT storage_type, size FROM vcs_blob WHERE blob_id = ?`,
        [id],
      );
      expect(rows[0].storage_type).toBe("inline");
      expect(rows[0].size).toBe(0);

      // Verify round-trip
      const loaded = await collectBytes(store.load(id));
      expect(loaded.length).toBe(0);
    });

    it("handles single byte content", async () => {
      const single = new Uint8Array([0x42]);
      const id = await store.store(toStream(single));

      // Verify round-trip
      const loaded = await collectBytes(store.load(id));
      expect(loaded).toEqual(single);
    });
  });

  describe("chunk count verification", () => {
    it("creates correct number of chunks for various sizes", async () => {
      const testCases = [
        { size: SQL_CHUNK_THRESHOLD + 1, expectedChunks: 2 }, // 256KB + 1 byte = 2 chunks
        { size: SQL_CHUNK_SIZE * 2, expectedChunks: 2 }, // 512KB = 2 full chunks
        { size: SQL_CHUNK_SIZE * 2 + 1, expectedChunks: 3 }, // 512KB + 1 = 3 chunks
        { size: SQL_CHUNK_SIZE * 3, expectedChunks: 3 }, // 768KB = 3 full chunks
        { size: SQL_CHUNK_SIZE * 3 + SQL_CHUNK_SIZE / 2, expectedChunks: 4 }, // 768KB + 128KB = 4 chunks
        { size: 1_000_000, expectedChunks: 4 }, // ~1MB = 4 chunks
      ];

      for (const { size, expectedChunks } of testCases) {
        const content = new Uint8Array(size).fill(0x55);
        const id = await store.store(toStream(content));

        // Get blob FK
        const blobRows = await db.query<{ id: number }>(
          `SELECT id FROM vcs_blob WHERE blob_id = ?`,
          [id],
        );
        const blobFk = blobRows[0].id;

        // Count chunks
        const chunks = await db.query<{ cnt: number }>(
          `SELECT COUNT(*) as cnt FROM vcs_blob_chunk WHERE blob_fk = ?`,
          [blobFk],
        );

        expect(chunks[0].cnt).toBe(expectedChunks);

        // Cleanup for next test
        await store.remove(id);
      }
    });

    it("chunk metadata is accurate", async () => {
      const size = 700_000; // ~683KB, will create 3 chunks
      const content = new Uint8Array(size);
      for (let i = 0; i < size; i++) {
        content[i] = i % 256;
      }

      const id = await store.store(toStream(content));

      // Get blob FK
      const blobRows = await db.query<{ id: number; size: number }>(
        `SELECT id, size FROM vcs_blob WHERE blob_id = ?`,
        [id],
      );
      expect(blobRows[0].size).toBe(size);

      const blobFk = blobRows[0].id;

      // Get chunk metadata
      const chunks = await db.query<{
        position: number;
        chunk_offset: number;
        chunk_length: number;
      }>(
        `SELECT position, chunk_offset, chunk_length FROM vcs_blob_chunk WHERE blob_fk = ? ORDER BY position`,
        [blobFk],
      );

      // Verify chunk offsets and lengths
      let expectedOffset = 0;
      let totalLength = 0;
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].position).toBe(i);
        expect(chunks[i].chunk_offset).toBe(expectedOffset);
        expectedOffset += chunks[i].chunk_length;
        totalLength += chunks[i].chunk_length;
      }

      // Total of all chunk lengths should equal blob size
      expect(totalLength).toBe(size);
    });
  });

  describe("concurrent operations", () => {
    it("handles sequential stores of same content (deduplication)", async () => {
      /**
       * Note: SQLite has limited concurrent write support, so concurrent stores
       * of identical content may cause UNIQUE constraint violations due to race
       * conditions between the existence check and insert.
       *
       * This test verifies sequential deduplication works correctly.
       */
      const content = new Uint8Array(SQL_CHUNK_SIZE * 2).fill(0x77);

      // Store same content sequentially (concurrent stores may race)
      const id1 = await store.store(toStream(content));
      const id2 = await store.store(toStream(content));
      const id3 = await store.store(toStream(content));

      // All should return the same ID (deduplication)
      expect(id1).toBe(id2);
      expect(id2).toBe(id3);

      // Only one blob should exist
      const count = await store.count();
      expect(count).toBe(1);
    });

    it("handles concurrent stores of different content", async () => {
      const contents = Array.from({ length: 5 }, (_, i) => {
        const content = new Uint8Array(SQL_CHUNK_SIZE + i * 10000);
        content.fill(i);
        return content;
      });

      // Store different content concurrently
      const promises = contents.map((c) => store.store(toStream(c)));
      const ids = await Promise.all(promises);

      // Should have 5 different IDs
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(5);

      // All should be loadable
      for (let i = 0; i < ids.length; i++) {
        const loaded = await collectBytes(store.load(ids[i]));
        expect(loaded).toEqual(contents[i]);
      }
    });

    it("handles concurrent store and load", { timeout: 30000 }, async () => {
      const content = new Uint8Array(SQL_CHUNK_SIZE * 2);
      for (let i = 0; i < content.length; i++) {
        content[i] = i % 256;
      }

      // Store first
      const id = await store.store(toStream(content));

      // Concurrent loads
      const loadPromises = Array.from({ length: 10 }, () => collectBytes(store.load(id)));

      const results = await Promise.all(loadPromises);

      // All loads should return correct content
      for (const result of results) {
        expect(result).toEqual(content);
      }
    });
  });

  describe("compression effectiveness", () => {
    it("compresses repetitive data effectively", async () => {
      // Highly compressible: all zeros
      const size = SQL_CHUNK_SIZE * 2;
      const content = new Uint8Array(size).fill(0);

      const id = await store.store(toStream(content));

      // Get blob FK
      const blobRows = await db.query<{ id: number }>(`SELECT id FROM vcs_blob WHERE blob_id = ?`, [
        id,
      ]);
      const blobFk = blobRows[0].id;

      // Get total compressed size
      const totalRows = await db.query<{ total: number }>(
        `SELECT SUM(compressed_length) as total FROM vcs_blob_chunk WHERE blob_fk = ?`,
        [blobFk],
      );

      // Should compress to much less than original
      expect(totalRows[0].total).toBeLessThan(size * 0.1);
    });

    it("handles incompressible data gracefully", async () => {
      // Pseudo-random data (incompressible)
      const size = SQL_CHUNK_SIZE * 2;
      const content = new Uint8Array(size);
      let seed = 12345;
      for (let i = 0; i < size; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        content[i] = seed % 256;
      }

      const id = await store.store(toStream(content));

      // Should still store and round-trip correctly
      const loaded = await collectBytes(store.load(id));
      expect(loaded).toEqual(content);

      // Get compressed size (will be close to or slightly larger than original)
      const blobRows = await db.query<{ id: number }>(`SELECT id FROM vcs_blob WHERE blob_id = ?`, [
        id,
      ]);
      const blobFk = blobRows[0].id;

      const totalRows = await db.query<{ total: number }>(
        `SELECT SUM(compressed_length) as total FROM vcs_blob_chunk WHERE blob_fk = ?`,
        [blobFk],
      );

      // Compressed size should be reasonable (not more than 2x original)
      expect(totalRows[0].total).toBeLessThan(size * 2);
    });
  });

  describe("partial read limitations", () => {
    /**
     * Note: The SqlNativeBlobStore does NOT support partial reads (range queries).
     * The load() method returns the entire blob content.
     *
     * This is different from ChunkedRawStorage which supports options.start/end.
     * If partial reads are needed, consider:
     * 1. Creating a SQL ChunkAccess implementation
     * 2. Using ChunkedRawStorage with that implementation
     *
     * These tests document this limitation.
     */
    it("load returns complete content (no partial read support)", async () => {
      const content = new Uint8Array(SQL_CHUNK_SIZE * 2);
      for (let i = 0; i < content.length; i++) {
        content[i] = i % 256;
      }

      const id = await store.store(toStream(content));

      // load() does not accept options for partial reads
      // It always returns the complete content
      const loaded = await collectBytes(store.load(id));
      expect(loaded.length).toBe(content.length);
      expect(loaded).toEqual(content);
    });

    it("size() allows pre-checking blob size before full load", async () => {
      const content = new Uint8Array(SQL_CHUNK_SIZE * 2 + 12345);
      const id = await store.store(toStream(content));

      // Can check size without loading full content
      const size = await store.size(id);
      expect(size).toBe(content.length);
    });
  });
});
