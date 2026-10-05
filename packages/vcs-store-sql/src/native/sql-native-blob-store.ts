/**
 * Native SQL BlobStore with Git-compatible IDs
 *
 * Stores blobs in SQL tables while computing SHA-1 hashes
 * identical to native Git. Supports chunked storage for large blobs.
 */

import { encodeObjectHeader, type ObjectId } from "@statewalker/vcs-core";
import { bytesToHex, compressBlock, decompressBlock, Sha1 } from "@statewalker/vcs-utils";
import type { DatabaseClient } from "../database-client.js";
import type { SqlNativeBlobStore } from "./types.js";

/**
 * Table name for blob storage
 */
const BLOB_TABLE = "vcs_blob";

/**
 * Table name for chunk storage
 */
const CHUNK_TABLE = "vcs_blob_chunk";

/**
 * Chunk size in bytes (256KB)
 * Optimal for SQLite page alignment and streaming
 */
const CHUNK_SIZE = 262144;

/**
 * Threshold for chunked vs inline storage (256KB)
 * Blobs larger than this use chunked storage
 */
const CHUNK_THRESHOLD = 262144;

/**
 * Native SQL BlobStore implementation
 *
 * Uses a simple table with:
 * - blob_id: Git-compatible SHA-1 hash
 * - content: Raw blob content (for inline storage)
 * - size: Content size in bytes
 * - storage_type: 'inline' or 'chunked'
 * - created_at: Storage timestamp
 *
 * Large blobs (>256KB) are stored in chunks with per-chunk compression.
 * Computes Git-compatible SHA-1 object IDs for interoperability.
 */
export class SqlNativeBlobStoreImpl implements SqlNativeBlobStore {
  private initialized = false;

  constructor(private db: DatabaseClient) {}

  /**
   * Ensure blob and chunk tables exist with current schema
   *
   * Handles upgrades from older schema versions by adding new columns
   * and creating new tables as needed.
   */
  private async ensureTable(): Promise<void> {
    if (this.initialized) return;

    // Create blob table if it doesn't exist
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${BLOB_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        blob_id TEXT UNIQUE NOT NULL,
        content BLOB,
        size INTEGER NOT NULL,
        storage_type TEXT DEFAULT 'inline',
        created_at INTEGER NOT NULL
      )
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS ${BLOB_TABLE}_size_idx ON ${BLOB_TABLE}(size)
    `);

    // Check if storage_type column exists (for upgrade from older schema)
    const columns = await this.db.query<{ name: string }>(`PRAGMA table_info(${BLOB_TABLE})`);
    const hasStorageType = columns.some((col) => col.name === "storage_type");
    if (!hasStorageType) {
      // Add storage_type column for existing tables
      await this.db.execute(
        `ALTER TABLE ${BLOB_TABLE} ADD COLUMN storage_type TEXT DEFAULT 'inline'`,
      );
    }

    // Create chunk table for large blob storage
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${CHUNK_TABLE} (
        blob_fk INTEGER NOT NULL REFERENCES ${BLOB_TABLE}(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        chunk_offset INTEGER NOT NULL,
        chunk_length INTEGER NOT NULL,
        compressed_length INTEGER NOT NULL,
        content BLOB NOT NULL,
        PRIMARY KEY (blob_fk, position)
      )
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS ${CHUNK_TABLE}_blob_fk_idx ON ${CHUNK_TABLE}(blob_fk)
    `);

    this.initialized = true;
  }

  /**
   * Collect content from stream and compute Git-compatible hash
   *
   * Git hash format requires knowing size upfront: "blob <size>\0<content>"
   * So we collect chunks first, then compute hash over all content.
   */
  private async streamHashAndCollect(
    content: AsyncIterable<Uint8Array>,
  ): Promise<{ hash: ObjectId; chunks: Uint8Array[]; totalSize: number }> {
    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    // First pass: collect chunks and count total size
    for await (const chunk of content) {
      chunks.push(chunk);
      totalSize += chunk.length;
    }

    // Compute Git hash: "blob <size>\0<content>"
    const sha1 = new Sha1();
    sha1.update(encodeObjectHeader("blob", totalSize));
    for (const chunk of chunks) {
      sha1.update(chunk);
    }

    return {
      hash: bytesToHex(sha1.finalize()),
      chunks,
      totalSize,
    };
  }

  /**
   * Combine collected chunks into single Uint8Array
   */
  private combineChunks(chunks: Uint8Array[]): Uint8Array {
    if (chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0];

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }

  /**
   * Store blob inline (single row, no compression)
   */
  private async storeInline(blobId: ObjectId, data: Uint8Array, size: number): Promise<void> {
    const now = Date.now();
    await this.db.execute(
      `INSERT INTO ${BLOB_TABLE} (blob_id, content, size, storage_type, created_at) VALUES (?, ?, ?, 'inline', ?)`,
      [blobId, data, size, now],
    );
  }

  /**
   * Store blob in compressed chunks
   */
  private async storeChunked(
    blobId: ObjectId,
    inputChunks: Uint8Array[],
    totalSize: number,
  ): Promise<void> {
    const now = Date.now();

    await this.db.transaction(async (tx) => {
      // Insert blob metadata (content is NULL for chunked storage)
      const result = await tx.execute(
        `INSERT INTO ${BLOB_TABLE} (blob_id, content, size, storage_type, created_at) VALUES (?, NULL, ?, 'chunked', ?)`,
        [blobId, totalSize, now],
      );
      const blobFk = result.lastInsertRowId;

      // Process input chunks into fixed-size storage chunks
      let position = 0;
      let byteOffset = 0;
      let buffer = new Uint8Array(0);

      for (const inputChunk of inputChunks) {
        // Accumulate into buffer
        const combined = new Uint8Array(buffer.length + inputChunk.length);
        combined.set(buffer, 0);
        combined.set(inputChunk, buffer.length);
        buffer = combined;

        // Emit complete chunks
        while (buffer.length >= CHUNK_SIZE) {
          const toStore = buffer.subarray(0, CHUNK_SIZE);
          const compressed = await compressBlock(toStore);

          await tx.execute(
            `INSERT INTO ${CHUNK_TABLE} (blob_fk, position, chunk_offset, chunk_length, compressed_length, content) VALUES (?, ?, ?, ?, ?, ?)`,
            [blobFk, position, byteOffset, CHUNK_SIZE, compressed.length, compressed],
          );

          position++;
          byteOffset += CHUNK_SIZE;
          buffer = buffer.subarray(CHUNK_SIZE);
        }
      }

      // Store final partial chunk if any
      if (buffer.length > 0) {
        const compressed = await compressBlock(buffer);
        await tx.execute(
          `INSERT INTO ${CHUNK_TABLE} (blob_fk, position, chunk_offset, chunk_length, compressed_length, content) VALUES (?, ?, ?, ?, ?, ?)`,
          [blobFk, position, byteOffset, buffer.length, compressed.length, compressed],
        );
      }
    });
  }

  /**
   * Store blob with unknown size
   *
   * Streams content, computes Git-compatible hash, and stores either
   * inline (for small blobs) or in compressed chunks (for large blobs).
   */
  async store(content: AsyncIterable<Uint8Array>): Promise<ObjectId> {
    await this.ensureTable();

    // Stream, collect, and compute hash
    const { hash: blobId, chunks, totalSize } = await this.streamHashAndCollect(content);

    // Check if blob already exists (deduplication)
    const existing = await this.db.query<{ id: number }>(
      `SELECT id FROM ${BLOB_TABLE} WHERE blob_id = ?`,
      [blobId],
    );

    if (existing.length > 0) {
      return blobId;
    }

    // Choose storage strategy based on size
    if (totalSize <= CHUNK_THRESHOLD) {
      // Store inline (combine chunks for small blobs)
      const data = this.combineChunks(chunks);
      await this.storeInline(blobId, data, totalSize);
    } else {
      // Store chunked with compression
      await this.storeChunked(blobId, chunks, totalSize);
    }

    return blobId;
  }

  /**
   * Load blob content
   *
   * For inline blobs, yields content in single chunk.
   * For chunked blobs, streams decompressed chunks.
   * Returns undefined if blob doesn't exist.
   */
  async load(id: ObjectId): Promise<AsyncIterable<Uint8Array> | undefined> {
    await this.ensureTable();

    // Get blob metadata
    const rows = await this.db.query<{
      id: number;
      content: Uint8Array | null;
      storage_type: string | null;
    }>(`SELECT id, content, storage_type FROM ${BLOB_TABLE} WHERE blob_id = ?`, [id]);

    if (rows.length === 0) {
      return undefined;
    }

    const { id: blobFk, content, storage_type } = rows[0];
    const db = this.db;

    return (async function* () {
      // Handle inline storage (default for existing blobs without storage_type)
      if (storage_type !== "chunked") {
        if (content) {
          yield content;
        }
        return;
      }

      // Stream chunks for chunked storage
      const chunks = await db.query<{ content: Uint8Array }>(
        `SELECT content FROM ${CHUNK_TABLE} WHERE blob_fk = ? ORDER BY position`,
        [blobFk],
      );

      for (const chunk of chunks) {
        const decompressed = await decompressBlock(chunk.content);
        yield decompressed;
      }
    })();
  }

  /**
   * Check if blob exists
   */
  async has(id: ObjectId): Promise<boolean> {
    await this.ensureTable();

    const result = await this.db.query<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM ${BLOB_TABLE} WHERE blob_id = ?`,
      [id],
    );

    return result[0].cnt > 0;
  }

  // --- Extended query methods ---

  /**
   * Get blob count
   */
  async count(): Promise<number> {
    await this.ensureTable();

    const result = await this.db.query<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM ${BLOB_TABLE}`,
    );
    return result[0].cnt;
  }

  /**
   * Get total size of all blobs
   */
  async totalSize(): Promise<number> {
    await this.ensureTable();

    const result = await this.db.query<{ total: number | null }>(
      `SELECT SUM(size) as total FROM ${BLOB_TABLE}`,
    );
    return result[0].total || 0;
  }

  /**
   * List all blob object IDs
   */
  async *keys(): AsyncIterable<ObjectId> {
    await this.ensureTable();

    const rows = await this.db.query<{ blob_id: ObjectId }>(`SELECT blob_id FROM ${BLOB_TABLE}`);
    for (const row of rows) {
      yield row.blob_id;
    }
  }

  /**
   * Get blob size in bytes.
   * Returns -1 if blob not found.
   */
  async size(id: ObjectId): Promise<number> {
    await this.ensureTable();

    const rows = await this.db.query<{ size: number }>(
      `SELECT size FROM ${BLOB_TABLE} WHERE blob_id = ?`,
      [id],
    );

    if (rows.length === 0) {
      return -1;
    }

    return rows[0].size;
  }

  /**
   * Remove a blob from storage.
   *
   * Explicitly deletes chunks for chunked blobs since SQLite
   * foreign keys are disabled by default.
   */
  async remove(id: ObjectId): Promise<boolean> {
    await this.ensureTable();

    // Get blob info to check if it's chunked
    const rows = await this.db.query<{ id: number; storage_type: string | null }>(
      `SELECT id, storage_type FROM ${BLOB_TABLE} WHERE blob_id = ?`,
      [id],
    );

    if (rows.length === 0) {
      return false;
    }

    const { id: blobFk, storage_type } = rows[0];

    // Delete chunks first if chunked storage
    if (storage_type === "chunked") {
      await this.db.execute(`DELETE FROM ${CHUNK_TABLE} WHERE blob_fk = ?`, [blobFk]);
    }

    // Delete blob record
    const result = await this.db.execute(`DELETE FROM ${BLOB_TABLE} WHERE blob_id = ?`, [id]);

    return result.changes > 0;
  }
}
