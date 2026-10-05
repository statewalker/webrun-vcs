/**
 * GitPackStore implementation
 *
 * Pack-based object storage implementing the RawStorage interface.
 * Uses PackDirectory for reading and PendingPack for buffered writes.
 *
 * Based on: jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/ObjectDirectory.java
 */

import type {
  FilesApi,
  FlushResult,
  GitPackStore,
  GitPackStoreConfig,
  PackObjectType,
  PackStoreStats,
} from "@statewalker/vcs-core";
import { PendingPack, parseHeader } from "@statewalker/vcs-core";
import { PackDirectory } from "./pack-directory.js";

/** Default maximum pending objects before auto-flush */
const DEFAULT_MAX_PENDING_OBJECTS = 100;

/** Default maximum pending bytes before auto-flush (10MB) */
const DEFAULT_MAX_PENDING_BYTES = 10 * 1024 * 1024;

/**
 * Concatenate multiple Uint8Arrays efficiently
 */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
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
 * Convert object type string to pack object type code
 */
function typeStringToPackType(type: string): PackObjectType {
  switch (type) {
    case "commit":
      return 1; // COMMIT
    case "tree":
      return 2; // TREE
    case "blob":
      return 3; // BLOB
    case "tag":
      return 4; // TAG
    default:
      throw new Error(`Unknown object type: ${type}`);
  }
}

/**
 * GitPackStore implementation
 *
 * Provides pack-based storage with:
 * - Reading from multiple pack files via PackDirectory
 * - Buffered writes via PendingPack
 * - Auto-flush at configurable thresholds
 * - Optional loose storage fallback
 */
export class GitPackStoreImpl implements GitPackStore {
  private readonly files: FilesApi;
  private readonly packPath: string;
  private readonly packDirectory: PackDirectory;
  private readonly pendingPack: PendingPack;
  private readonly config: Required<Omit<GitPackStoreConfig, "looseStorage">> & {
    looseStorage?: GitPackStoreConfig["looseStorage"];
  };

  private initialized = false;
  private closed = false;

  /**
   * Create a new GitPackStore
   *
   * @param files FilesApi for storage operations
   * @param packPath Path to pack directory (e.g., ".git/objects/pack")
   * @param config Optional configuration
   */
  constructor(files: FilesApi, packPath: string, config: GitPackStoreConfig = {}) {
    this.files = files;
    this.packPath = packPath;

    this.config = {
      maxPendingObjects: config.maxPendingObjects ?? DEFAULT_MAX_PENDING_OBJECTS,
      maxPendingBytes: config.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES,
      packImmediately: config.packImmediately ?? true,
      looseStorage: config.looseStorage,
    };

    this.packDirectory = new PackDirectory({
      files,
      basePath: packPath,
    });

    this.pendingPack = new PendingPack({
      maxObjects: this.config.maxPendingObjects,
      maxBytes: this.config.maxPendingBytes,
    });
  }

  // === Lifecycle Methods ===

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Ensure pack directory exists
    const exists = await this.files.exists(this.packPath);
    if (!exists) {
      await this.files.mkdir(this.packPath);
    }

    // Scan for existing pack files
    await this.packDirectory.scan();

    this.initialized = true;
  }

  async close(): Promise<void> {
    if (this.closed) return;

    // Flush any pending objects
    if (this.hasPending()) {
      await this.flush();
    }

    // Invalidate pack directory cache
    await this.packDirectory.invalidate();

    this.closed = true;
  }

  // === RawStorage Implementation ===

  async store(key: string, content: AsyncIterable<Uint8Array>): Promise<void> {
    this.ensureInitialized();
    this.ensureNotClosed();

    // Collect all content chunks
    const chunks: Uint8Array[] = [];
    for await (const chunk of content) {
      chunks.push(chunk);
    }
    const fullContent = concatChunks(chunks);

    // Content should include Git header (e.g., "blob 123\0...")
    // Parse header to determine object type
    const header = parseHeader(fullContent);
    const packType = typeStringToPackType(header.type);

    // Get content without header for pack storage
    const objectContent = fullContent.subarray(header.contentOffset);

    if (this.config.packImmediately) {
      // Add to pending pack buffer
      this.pendingPack.addObject(key, packType, objectContent);

      // Auto-flush if thresholds exceeded
      if (this.pendingPack.shouldFlush()) {
        await this.flush();
      }
    } else if (this.config.looseStorage) {
      // Write to loose storage (convert array to async iterable)
      await this.config.looseStorage.store(
        key,
        (async function* () {
          yield fullContent;
        })(),
      );
    } else {
      throw new Error("GitPackStore: packImmediately=false requires looseStorage");
    }
  }

  async *load(key: string, options?: { start?: number; end?: number }): AsyncIterable<Uint8Array> {
    this.ensureInitialized();
    this.ensureNotClosed();

    // Check pending objects first (they have priority)
    if (this.pendingPack.hasPending(key)) {
      // Pending objects are stored without header, but RawStorage expects header
      // This is a limitation - pending objects won't be readable until flushed
      // For now, flush and then read from pack
      await this.flush();
    }

    // Try pack files
    const rawContent = await this.packDirectory.loadRaw(key);
    if (rawContent) {
      yield this.sliceContent(rawContent, options);
      return;
    }

    // Try loose storage fallback
    if (this.config.looseStorage) {
      try {
        const chunks: Uint8Array[] = [];
        for await (const chunk of this.config.looseStorage.load(key, options)) {
          chunks.push(chunk);
        }
        if (chunks.length > 0) {
          yield* chunks;
          return;
        }
      } catch {
        // Not found in loose storage either
      }
    }

    throw new Error(`Object not found: ${key}`);
  }

  async has(key: string): Promise<boolean> {
    this.ensureInitialized();
    this.ensureNotClosed();

    // Check pending objects
    if (this.pendingPack.hasPending(key)) {
      return true;
    }

    // Check pack files
    if (await this.packDirectory.has(key)) {
      return true;
    }

    // Check loose storage fallback
    if (this.config.looseStorage) {
      return this.config.looseStorage.has(key);
    }

    return false;
  }

  async remove(key: string): Promise<boolean> {
    this.ensureInitialized();
    this.ensureNotClosed();

    // Pack files are immutable - can't remove from them
    // Only loose storage supports removal
    if (this.config.looseStorage) {
      return this.config.looseStorage.remove(key);
    }

    // Cannot remove from pack files
    return false;
  }

  async *keys(): AsyncIterable<string> {
    this.ensureInitialized();
    this.ensureNotClosed();

    const seen = new Set<string>();

    // Yield pending object keys
    for (const id of this.pendingPack.getPendingIds()) {
      if (!seen.has(id)) {
        seen.add(id);
        yield id;
      }
    }

    // Yield pack object keys
    for await (const id of this.packDirectory.listObjects()) {
      if (!seen.has(id)) {
        seen.add(id);
        yield id;
      }
    }

    // Yield loose storage keys
    if (this.config.looseStorage) {
      for await (const id of this.config.looseStorage.keys()) {
        if (!seen.has(id)) {
          seen.add(id);
          yield id;
        }
      }
    }
  }

  async size(key: string): Promise<number> {
    this.ensureInitialized();
    this.ensureNotClosed();

    // Check pack files
    const rawContent = await this.packDirectory.loadRaw(key);
    if (rawContent) {
      return rawContent.length;
    }

    // Check loose storage fallback
    if (this.config.looseStorage) {
      return this.config.looseStorage.size(key);
    }

    return -1;
  }

  // === GitPackStore Specific Methods ===

  async flush(): Promise<FlushResult> {
    this.ensureInitialized();
    this.ensureNotClosed();

    if (this.pendingPack.isEmpty()) {
      return {
        packName: "",
        objectIds: [],
        objectCount: 0,
      };
    }

    // Get pending object IDs before flush
    const objectIds = [...this.pendingPack.getPendingIds()];

    // Flush to pack file
    const result = await this.pendingPack.flush();

    // Add pack to directory
    await this.packDirectory.addPack(result.packName, result.packData, result.indexData);

    return {
      packName: result.packName,
      objectIds,
      objectCount: objectIds.length,
    };
  }

  hasPending(): boolean {
    return !this.pendingPack.isEmpty();
  }

  async getStats(): Promise<PackStoreStats> {
    this.ensureInitialized();
    this.ensureNotClosed();

    const directoryStats = await this.packDirectory.getStats();

    return {
      packCount: directoryStats.packCount,
      totalPackedObjects: directoryStats.totalObjects,
      pendingObjects: this.pendingPack.objectCount,
      pendingBytes: this.pendingPack.size,
      packs: directoryStats.packs,
    };
  }

  async refresh(): Promise<void> {
    this.ensureInitialized();
    this.ensureNotClosed();

    await this.packDirectory.invalidate();
    await this.packDirectory.scan();
  }

  // === Private Methods ===

  private sliceContent(
    content: Uint8Array,
    options?: { start?: number; end?: number },
  ): Uint8Array {
    if (!options || (options.start === undefined && options.end === undefined)) {
      return content;
    }
    const start = options.start ?? 0;
    const end = options.end ?? content.length;
    return content.subarray(start, end);
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error("GitPackStore not initialized. Call initialize() first.");
    }
  }

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new Error("GitPackStore is closed");
    }
  }
}

/**
 * Create a GitPackStore instance
 *
 * @param files FilesApi for storage operations
 * @param packPath Path to pack directory (e.g., ".git/objects/pack")
 * @param config Optional configuration
 * @returns Uninitialized GitPackStore (call initialize() before use)
 */
export function createGitPackStore(
  files: FilesApi,
  packPath: string,
  config?: GitPackStoreConfig,
): GitPackStore {
  return new GitPackStoreImpl(files, packPath, config);
}
