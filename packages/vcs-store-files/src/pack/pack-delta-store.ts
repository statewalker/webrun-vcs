/**
 * Native pack-based delta store
 *
 * Stores deltas using Git's native OFS_DELTA/REF_DELTA types.
 * Relationships are read from pack headers - no separate metadata needed.
 *
 * This is the Git-specific implementation of DeltaStore interface.
 * Located in pack/ because it depends on Git pack format.
 *
 * Based on:
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/Pack.java
 * - jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/pack/PackWriter.java
 */

import type {
  DeltaChainDetails,
  DeltaInfo,
  DeltaReverseIndex,
  DeltaStore,
  DeltaStoreUpdate,
  FilesApi,
  ObjectTypeCode,
  StoredDelta,
} from "@statewalker/vcs-core";
import {
  PackObjectType,
  PendingPack,
  parseBinaryDelta,
  parseHeader,
  serializeDelta,
} from "@statewalker/vcs-core";
import type { Delta } from "@statewalker/vcs-utils";
import { collect, newByteSplitter, readHeader } from "@statewalker/vcs-utils/streams";
import { PackDirectory } from "./pack-directory.js";

/**
 * Options for PackDeltaStore
 */
export interface PackDeltaStoreOptions {
  /** FilesApi for storage operations */
  files: FilesApi;
  /** Base path for pack files (e.g., ".git/objects/pack") */
  basePath: string;
}

/**
 * Convert ObjectTypeCode to PackObjectType
 */
function toPackObjectType(typeCode: ObjectTypeCode): PackObjectType {
  switch (typeCode) {
    case 1:
      return PackObjectType.COMMIT;
    case 2:
      return PackObjectType.TREE;
    case 3:
      return PackObjectType.BLOB;
    case 4:
      return PackObjectType.TAG;
    default:
      throw new Error(`Unknown object type code: ${typeCode}`);
  }
}

/**
 * Batched update handle for pack-based delta storage
 *
 * Collects objects and deltas into a PendingPack, then writes
 * a single pack file when close() is called.
 */
export class PackDeltaStoreUpdate implements DeltaStoreUpdate {
  private readonly pending: PendingPack;
  private readonly packDir: PackDirectory;
  private readonly onClose?: () => void;
  private closed = false;

  constructor(packDir: PackDirectory, onClose?: () => void) {
    this.pending = new PendingPack({
      // No auto-flush - we want everything in one pack
      maxObjects: Number.MAX_SAFE_INTEGER,
      maxBytes: Number.MAX_SAFE_INTEGER,
    });
    this.packDir = packDir;
    this.onClose = onClose;
  }

  /**
   * Store a full object in this batch
   *
   * Parses the Git header to determine object type, then stores
   * the content (without header) in the pending pack.
   */
  async storeObject(
    key: string,
    content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  ): Promise<void> {
    if (this.closed) {
      throw new Error("Update already closed");
    }

    // Wrap to ensure async iterable for readHeader
    const asyncContent = (async function* () {
      yield* content;
    })();

    // Use readHeader to split stream into header and remaining content
    // newByteSplitter(0) finds the null byte that terminates Git header ("type size\0")
    const [headerBytes, contentStream] = await readHeader(
      asyncContent,
      newByteSplitter(0), // Split on null byte (includes delimiter in header)
      32, // Max header length (type + space + size + null)
    );

    // Parse header to extract type
    const parsed = parseHeader(headerBytes);
    const packType = toPackObjectType(parsed.typeCode);

    // Collect content (readHeader already excludes header from contentStream)
    const contentBytes = await collect(contentStream);

    this.pending.addObject(key, packType, contentBytes);
  }

  /**
   * Store a delta relationship in this batch
   */
  async storeDelta(info: DeltaInfo, delta: Delta[]): Promise<number> {
    if (this.closed) {
      throw new Error("Update already closed");
    }

    // Serialize delta to Git binary format
    const binaryDelta = serializeDelta(delta);

    // Add as delta - uses OFS_DELTA if base is in same pack
    this.pending.addDelta(info.targetKey, info.baseKey, binaryDelta);

    return binaryDelta.length;
  }

  /**
   * Commit all operations - creates a single pack file
   */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    if (this.pending.isEmpty()) {
      return;
    }

    const result = await this.pending.flush();

    // Write pack files
    await this.packDir.addPack(result.packName, result.packData, result.indexData);

    // Invalidate pack directory cache
    await this.packDir.invalidate();

    // Notify parent store
    this.onClose?.();
  }
}

/**
 * Native pack-based delta store
 *
 * Stores deltas using Git's native delta types (OFS_DELTA, REF_DELTA).
 * Delta relationships are embedded in pack file headers.
 *
 * Key differences from JSON metadata approach:
 * - Uses OFS_DELTA when base is in same pack (more efficient)
 * - Uses REF_DELTA when base is in different pack
 * - No separate JSON metadata index
 * - Relationships read from pack headers
 *
 * @example
 * ```typescript
 * const store = new PackDeltaStore({ files, basePath: ".git/objects/pack" });
 * await store.initialize();
 *
 * // Store objects using transaction pattern
 * const update = store.startUpdate();
 * await update.storeObject(blobId, [contentWithHeader]);
 * await update.storeDelta({ baseKey: baseId, targetKey: targetId }, delta);
 * await update.close(); // Creates single pack file
 *
 * // Query uses pack headers, not separate index
 * const isDelta = await store.isDelta(targetId);
 * ```
 */
export class PackDeltaStore implements DeltaStore {
  private readonly packDir: PackDirectory;
  private reverseIndex: DeltaReverseIndex | null = null;
  private initialized = false;

  constructor(options: PackDeltaStoreOptions) {
    this.packDir = new PackDirectory({
      files: options.files,
      basePath: options.basePath,
    });
  }

  /**
   * Initialize the store
   *
   * Scans existing pack files. No metadata file to load.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Scan for existing packs
    await this.packDir.scan();
    this.initialized = true;
  }

  /**
   * Start a batched update transaction
   *
   * Returns an update handle that collects all write operations.
   * When close() is called, all objects are written to a single pack file.
   *
   * @returns Update handle for batched writes
   */
  startUpdate(): DeltaStoreUpdate {
    return new PackDeltaStoreUpdate(this.packDir, () => {
      // Invalidate reverse index when new pack is created
      this.reverseIndex = null;
    });
  }

  /**
   * Load delta for an object
   *
   * Reads delta bytes from pack and parses to Delta[] instructions.
   *
   * @param targetKey Target object key
   * @returns Stored delta with instructions, or undefined if not a delta
   */
  async loadDelta(targetKey: string): Promise<StoredDelta | undefined> {
    await this.ensureInitialized();

    // Check if it's a delta from pack header
    if (!(await this.packDir.isDelta(targetKey))) {
      return undefined;
    }

    // Get base from pack header
    const baseKey = await this.packDir.getDeltaBase(targetKey);
    if (!baseKey) return undefined;

    // Load raw delta bytes from pack
    const packName = await this.packDir.findPack(targetKey);
    if (!packName) return undefined;

    const reader = await this.packDir.getPack(packName);
    const rawDelta = await reader.loadRawDelta(targetKey);
    if (!rawDelta) return undefined;

    // Parse binary delta to Delta[]
    const delta = parseBinaryDelta(rawDelta);

    // Calculate ratio (would need original size for accurate ratio)
    const chainInfo = await this.packDir.getDeltaChainInfo(targetKey);
    const ratio = chainInfo ? rawDelta.length / (rawDelta.length + chainInfo.savings) : 0;

    return {
      baseKey,
      targetKey,
      delta,
      ratio,
    };
  }

  /**
   * Check if object is stored as delta
   *
   * Reads pack header - no separate index lookup.
   *
   * @param targetKey Target object key
   * @returns True if stored as delta
   */
  async isDelta(targetKey: string): Promise<boolean> {
    await this.ensureInitialized();

    // Check reverse index if available (O(1))
    if (this.reverseIndex) {
      return this.reverseIndex.isDelta(targetKey);
    }

    // Fall back to pack header read
    return this.packDir.isDelta(targetKey);
  }

  /**
   * Remove delta relationship
   *
   * Pack files are immutable - actual removal happens during GC/repack.
   * This marks the relationship as removed in the reverse index.
   *
   * @param targetKey Target object key
   * @param _keepAsBase Ignored - pack-based deletion handled by GC
   * @returns True if was a delta
   */
  async removeDelta(targetKey: string, _keepAsBase?: boolean): Promise<boolean> {
    await this.ensureInitialized();

    const wasDelta = await this.isDelta(targetKey);

    // Update reverse index if cached
    if (this.reverseIndex && wasDelta) {
      this.reverseIndex.remove(targetKey);
    }

    return wasDelta;
  }

  /**
   * Get delta chain info for an object
   *
   * Walks delta chain from pack headers.
   *
   * @param targetKey Target object key
   * @returns Chain details or undefined if not a delta
   */
  async getDeltaChainInfo(targetKey: string): Promise<DeltaChainDetails | undefined> {
    await this.ensureInitialized();

    const packInfo = await this.packDir.getDeltaChainInfo(targetKey);
    if (!packInfo) return undefined;

    // Build chain by walking from target to base
    const chain: string[] = [targetKey];
    let currentKey = targetKey;

    while (true) {
      const base = await this.packDir.getDeltaBase(currentKey);
      if (!base) break;
      chain.push(base);
      currentKey = base;
    }

    return {
      baseKey: packInfo.baseId,
      targetKey,
      depth: packInfo.depth,
      originalSize: 0, // Would need to load resolved object
      compressedSize: 0, // Would need pack entry size
      chain,
    };
  }

  /**
   * List all delta relationships
   *
   * Scans pack headers to find all deltas.
   * Uses reverse index if available for efficiency.
   *
   * @returns Async iterable of delta info
   */
  async *listDeltas(): AsyncIterable<DeltaInfo> {
    await this.ensureInitialized();

    // Use reverse index if available
    if (this.reverseIndex) {
      for (const { target, base } of this.reverseIndex.entries()) {
        yield { baseKey: base, targetKey: target };
      }
      return;
    }

    // Fall back to pack header scan
    for await (const { target, base } of this.packDir.listDeltaRelationships()) {
      yield { baseKey: base, targetKey: target };
    }
  }

  /**
   * Find all objects depending on a base
   *
   * Uses reverse index for O(1) lookup if available,
   * otherwise falls back to O(n) pack scan.
   *
   * @param baseKey Base object key
   * @returns Array of dependent target keys
   */
  async findDependents(baseKey: string): Promise<string[]> {
    await this.ensureInitialized();

    // Use reverse index if available
    if (this.reverseIndex) {
      return this.reverseIndex.getTargets(baseKey);
    }

    // Fall back to pack scan
    return this.packDir.findDependents(baseKey);
  }

  /**
   * Check if object is used as a delta base
   *
   * @param key Object key
   * @returns True if has dependents
   */
  async isBase(key: string): Promise<boolean> {
    const dependents = await this.findDependents(key);
    return dependents.length > 0;
  }

  /**
   * Build or rebuild the reverse index
   *
   * Call this for efficient repeated findDependents() queries.
   * Must be called after pack changes.
   */
  async buildReverseIndex(): Promise<void> {
    await this.ensureInitialized();
    this.reverseIndex = await this.packDir.buildReverseIndex();
  }

  /**
   * Invalidate cached reverse index
   *
   * Call after packs are added/removed externally.
   */
  invalidateReverseIndex(): void {
    this.reverseIndex = null;
  }

  /**
   * Close the store
   */
  async close(): Promise<void> {
    await this.packDir.invalidate();
    this.reverseIndex = null;
  }

  /**
   * Get pack directory for advanced operations
   */
  getPackDirectory(): PackDirectory {
    return this.packDir;
  }

  /**
   * Get reverse index (may be null if not built)
   */
  getReverseIndex(): DeltaReverseIndex | null {
    return this.reverseIndex;
  }

  /**
   * Load resolved object content from pack files WITH Git header
   *
   * Loads fully resolved content (with delta resolution if needed)
   * for any object stored in packs, whether it's a delta or full object.
   * Returns content WITH Git header (e.g., "blob 123\0content") for
   * compatibility with RawStore which expects headers.
   *
   * @param key Object key
   * @returns Resolved content with header, or undefined if not in packs
   */
  async loadObject(key: string): Promise<Uint8Array | undefined> {
    await this.ensureInitialized();

    // Use loadRaw() which returns content WITH Git header
    return this.packDir.loadRaw(key);
  }

  /**
   * Check if object exists in any pack file
   *
   * Checks for any object in packs, regardless of whether
   * it's a delta or full object.
   *
   * @param key Object key
   * @returns True if object exists in packs
   */
  async hasObject(key: string): Promise<boolean> {
    await this.ensureInitialized();

    return this.packDir.has(key);
  }

  /**
   * Ensure store is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }
}
