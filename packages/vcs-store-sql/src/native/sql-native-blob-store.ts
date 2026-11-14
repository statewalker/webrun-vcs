/**
 * Native SQL BlobStore with Git-compatible IDs
 *
 * Stores blobs in SQL tables while computing SHA-1 hashes
 * identical to native Git. Supports chunked storage for large blobs.
 */

import {
  encodeObjectHeader,
  fixedSizeChunks,
  type ObjectId,
  SizeMismatchError,
} from "@statewalker/vcs-core";
import { bytesToHex, compressBlock, createSha1, decompressBlock } from "@statewalker/vcs-utils";
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

/** `blob_id` of a blob row being written, before its id is known. */
const TMP_PREFIX = "tmp:";

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function hashBlob(chunks: Uint8Array[], size: number): ObjectId {
  const sha1 = createSha1();
  sha1.update(encodeObjectHeader("blob", size));
  for (const c of chunks) sha1.update(c);
  return bytesToHex(sha1.digest());
}

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
 * Large blobs (>256KB) are stored in chunks with per-chunk compression,
 * written and read one chunk at a time.
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
   * Write `content` as compressed chunk rows of a new placeholder blob row
   * (`blob_id` = `tmp:<uuid>`, ignored by `keys` and `count`), one chunk at a
   * time. `hasher`, when given, sees every byte. Returns the placeholder's row
   * id and the bytes written. On failure the placeholder is removed.
   */
  private async writePlaceholder(
    content: AsyncIterable<Uint8Array>,
    onBytes?: (chunk: Uint8Array) => void,
  ): Promise<{ blobFk: number; tmpId: string; totalSize: number }> {
    const tmpId = `${TMP_PREFIX}${crypto.randomUUID()}`;
    const inserted = await this.db.execute(
      `INSERT INTO ${BLOB_TABLE} (blob_id, content, size, storage_type, created_at) VALUES (?, NULL, 0, 'chunked', ?)`,
      [tmpId, Date.now()],
    );
    const blobFk = inserted.lastInsertRowId;
    let position = 0;
    let totalSize = 0;
    try {
      for await (const chunk of fixedSizeChunks(content, CHUNK_SIZE)) {
        onBytes?.(chunk);
        const compressed = await compressBlock(chunk);
        await this.db.execute(
          `INSERT INTO ${CHUNK_TABLE} (blob_fk, position, chunk_offset, chunk_length, compressed_length, content) VALUES (?, ?, ?, ?, ?, ?)`,
          [blobFk, position++, totalSize, chunk.length, compressed.length, compressed],
        );
        totalSize += chunk.length;
      }
    } catch (e) {
      await this.dropRow(blobFk);
      throw e;
    }
    return { blobFk, tmpId, totalSize };
  }

  private async dropRow(blobFk: number): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(`DELETE FROM ${CHUNK_TABLE} WHERE blob_fk = ?`, [blobFk]);
      await tx.execute(`DELETE FROM ${BLOB_TABLE} WHERE id = ?`, [blobFk]);
    });
  }

  /** Name a written placeholder `blobId`, or drop it when that blob is already stored. */
  private async publish(blobFk: number, blobId: ObjectId, totalSize: number): Promise<void> {
    const kept = await this.db.transaction(async (tx) => {
      const existing = await tx.query<{ id: number }>(
        `SELECT id FROM ${BLOB_TABLE} WHERE blob_id = ?`,
        [blobId],
      );
      if (existing.length > 0) return false;
      await tx.execute(`UPDATE ${BLOB_TABLE} SET blob_id = ?, size = ? WHERE id = ?`, [
        blobId,
        totalSize,
        blobFk,
      ]);
      return true;
    });
    if (!kept) await this.dropRow(blobFk);
  }

  /**
   * Store a blob without ever holding it whole.
   *
   * With `size`, a large blob is hashed while its compressed chunks are
   * written, in one pass. Without it, content up to the inline threshold is
   * kept in memory; longer content is written as chunks first (the database is
   * the spool), then read back to hash it, since a git id needs the size first.
   * A blob that is not `size` bytes long is refused with `SizeMismatchError`
   * and nothing is kept.
   */
  async store(content: AsyncIterable<Uint8Array>, size?: number): Promise<ObjectId> {
    await this.ensureTable();
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) {
      throw new RangeError(`bad blob size ${size}`);
    }

    // Read up to the inline threshold; what ends there is stored from memory.
    // Callers pass sync iterables too, whatever the declared type says.
    const source = content as AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
    const it =
      Symbol.asyncIterator in Object(source)
        ? (source as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
        : (source as Iterable<Uint8Array>)[Symbol.iterator]();
    const head: Uint8Array[] = [];
    let headSize = 0;
    let ended = false;
    while (headSize <= CHUNK_THRESHOLD) {
      const r = await it.next();
      if (r.done) {
        ended = true;
        break;
      }
      head.push(r.value);
      headSize += r.value.length;
      if (size !== undefined && headSize > size) {
        await it.return?.();
        throw new SizeMismatchError(size, headSize);
      }
    }
    if (ended) {
      if (size !== undefined && size !== headSize) throw new SizeMismatchError(size, headSize);
      const data = concatChunks(head);
      const blobId = hashBlob([data], headSize);
      if (!(await this.has(blobId))) await this.storeInline(blobId, data, headSize);
      return blobId;
    }
    const rest = (async function* () {
      yield* head.splice(0);
      for (let r = await it.next(); !r.done; r = await it.next()) yield r.value;
    })();

    if (size !== undefined) {
      const sha1 = createSha1();
      sha1.update(encodeObjectHeader("blob", size));
      let seen = 0;
      const { blobFk, totalSize } = await this.writePlaceholder(rest, (chunk) => {
        seen += chunk.length;
        if (seen > size) throw new SizeMismatchError(size, seen);
        sha1.update(chunk);
      });
      if (totalSize !== size) {
        await this.dropRow(blobFk);
        throw new SizeMismatchError(size, totalSize);
      }
      const blobId = bytesToHex(sha1.digest());
      await this.publish(blobFk, blobId, totalSize);
      return blobId;
    }

    const { blobFk, totalSize } = await this.writePlaceholder(rest);
    let blobId: ObjectId;
    try {
      const sha1 = createSha1();
      sha1.update(encodeObjectHeader("blob", totalSize));
      for await (const chunk of this.chunksOf(blobFk)) sha1.update(chunk);
      blobId = bytesToHex(sha1.digest());
    } catch (e) {
      await this.dropRow(blobFk);
      throw e;
    }
    await this.publish(blobFk, blobId, totalSize);
    return blobId;
  }

  /** The decompressed chunks of a chunked blob row, read one row at a time. */
  private async *chunksOf(blobFk: number): AsyncGenerator<Uint8Array> {
    for (let position = 0; ; position++) {
      const rows = await this.db.query<{ content: Uint8Array }>(
        `SELECT content FROM ${CHUNK_TABLE} WHERE blob_fk = ? AND position = ?`,
        [blobFk, position],
      );
      const row = rows[0];
      if (!row) return;
      yield await decompressBlock(row.content);
    }
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
    const chunksOf = (fk: number) => this.chunksOf(fk);

    return (async function* () {
      // Handle inline storage (default for existing blobs without storage_type)
      if (storage_type !== "chunked") {
        if (content) {
          yield content;
        }
        return;
      }

      // Stream chunks for chunked storage, one row at a time
      yield* chunksOf(blobFk);
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
      `SELECT COUNT(*) as cnt FROM ${BLOB_TABLE} WHERE blob_id NOT LIKE '${TMP_PREFIX}%'`,
    );
    return result[0].cnt;
  }

  /**
   * Get total size of all blobs
   */
  async totalSize(): Promise<number> {
    await this.ensureTable();

    const result = await this.db.query<{ total: number | null }>(
      `SELECT SUM(size) as total FROM ${BLOB_TABLE} WHERE blob_id NOT LIKE '${TMP_PREFIX}%'`,
    );
    return result[0].total || 0;
  }

  /**
   * List all blob object IDs
   */
  async *keys(): AsyncIterable<ObjectId> {
    await this.ensureTable();

    const rows = await this.db.query<{ blob_id: ObjectId }>(
      `SELECT blob_id FROM ${BLOB_TABLE} WHERE blob_id NOT LIKE '${TMP_PREFIX}%'`,
    );
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
