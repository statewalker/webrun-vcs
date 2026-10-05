/**
 * Pack directory manager
 *
 * Manages multiple pack files in a directory with caching.
 *
 * Based on jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/PackDirectory.java
 */

import type {
  FilesApi,
  ObjectId,
  ObjectTypeCode,
  PackIndex,
  PackObject,
} from "@statewalker/vcs-core";
import {
  basename,
  createGitObject,
  DeltaReverseIndex,
  joinPath,
  readFile,
  readPackIndex,
  typeCodeToString,
} from "@statewalker/vcs-core";
import { type PackDeltaChainInfo, PackReader } from "./pack-reader.js";

/**
 * Options for PackDirectory
 */
export interface PackDirectoryOptions {
  /** FilesApi instance for storage operations */
  files: FilesApi;
  /** Base path for pack files (e.g., ".git/objects/pack") */
  basePath: string;
  /** Maximum cached pack readers (default: 10) */
  maxCachedPacks?: number;
}

/**
 * Cached pack entry with reader and index
 */
interface CachedPack {
  reader: PackReader;
  index: PackIndex;
  lastAccess: number;
}

/**
 * Pack directory manager
 *
 * Provides efficient access to multiple pack files with:
 * - LRU caching of pack readers
 * - Object lookup across all packs
 * - Pack file management (add/remove)
 */
export class PackDirectory {
  private readonly files: FilesApi;
  private readonly basePath: string;
  private readonly maxCachedPacks: number;
  private readonly cache: Map<string, CachedPack> = new Map();
  private packNames: string[] | null = null;

  constructor(options: PackDirectoryOptions) {
    this.files = options.files;
    this.basePath = options.basePath;
    this.maxCachedPacks = options.maxCachedPacks ?? 10;
  }

  /**
   * Scan directory for pack files
   *
   * Returns pack names (without path or extension) sorted in reverse
   * alphabetical order (newer packs first by convention).
   */
  async scan(): Promise<string[]> {
    if (this.packNames !== null) {
      return this.packNames;
    }

    const names: string[] = [];
    const exists = await this.files.exists(this.basePath);
    if (!exists) {
      this.packNames = names;
      return names;
    }

    for await (const entry of this.files.list(this.basePath)) {
      if (entry.kind === "file" && entry.path.endsWith(".pack")) {
        const name = basename(entry.path);
        // Remove .pack extension
        const packName = name.slice(0, -5);
        // Verify corresponding .idx file exists
        const idxPath = joinPath(this.basePath, `${packName}.idx`);
        if (await this.files.exists(idxPath)) {
          names.push(packName);
        }
      }
    }

    // Sort in reverse order (newer packs first)
    names.sort((a, b) => b.localeCompare(a));
    this.packNames = names;
    return names;
  }

  /**
   * Get pack reader by name
   *
   * Uses cache for efficiency. Creates and opens reader if not cached.
   */
  async getPack(name: string): Promise<PackReader> {
    const cached = this.cache.get(name);
    if (cached) {
      cached.lastAccess = Date.now();
      return cached.reader;
    }

    // Load index and create reader
    const index = await this.loadIndex(name);
    const packPath = joinPath(this.basePath, `${name}.pack`);
    const reader = new PackReader(this.files, packPath, index);
    reader.resolveExternalBase = (baseId) => this.resolveBase(baseId, name);
    await reader.open();

    // Add to cache
    this.addToCache(name, reader, index);

    return reader;
  }

  /**
   * Get pack index by name
   */
  async getIndex(name: string): Promise<PackIndex> {
    const cached = this.cache.get(name);
    if (cached) {
      cached.lastAccess = Date.now();
      return cached.index;
    }

    // Load index
    const index = await this.loadIndex(name);

    // If we're just getting the index, we might as well cache the reader too
    const packPath = joinPath(this.basePath, `${name}.pack`);
    const reader = new PackReader(this.files, packPath, index);
    reader.resolveExternalBase = (baseId) => this.resolveBase(baseId, name);
    await reader.open();
    this.addToCache(name, reader, index);

    return index;
  }

  /**
   * Find which pack contains an object
   *
   * Searches packs in order (reverse alphabetical, newer first).
   */
  async findPack(id: ObjectId): Promise<string | undefined> {
    const names = await this.scan();
    for (const name of names) {
      const index = await this.getIndex(name);
      if (index.has(id)) {
        return name;
      }
    }
    return undefined;
  }

  /**
   * Check if object exists in any pack
   */
  async has(id: ObjectId): Promise<boolean> {
    return (await this.findPack(id)) !== undefined;
  }

  /**
   * Load object content from any pack (without Git header)
   *
   * Returns the raw object content as stored in the pack file.
   * Returns undefined if not found in any pack.
   */
  async load(id: ObjectId): Promise<Uint8Array | undefined> {
    const packName = await this.findPack(id);
    if (!packName) return undefined;

    const reader = await this.getPack(packName);
    const obj = await reader.get(id);
    return obj?.content;
  }

  /**
   * Load object content from any pack WITH Git header
   *
   * Returns content prefixed with Git object header (e.g., "blob 123\0content").
   * This format is compatible with RawStore which expects headers.
   *
   * Returns undefined if not found in any pack.
   */
  async loadRaw(id: ObjectId): Promise<Uint8Array | undefined> {
    const packName = await this.findPack(id);
    if (!packName) return undefined;

    const reader = await this.getPack(packName);
    const obj = await reader.get(id);
    if (!obj) return undefined;

    // Pack types 1-4 map to Git object types
    const typeStr = typeCodeToString(obj.type as ObjectTypeCode);
    return createGitObject(typeStr, obj.content);
  }

  /**
   * Add a new pack file pair
   *
   * Writes both .pack and .idx files atomically (as much as possible).
   */
  async addPack(name: string, packData: Uint8Array, indexData: Uint8Array): Promise<void> {
    const packPath = joinPath(this.basePath, `${name}.pack`);
    const idxPath = joinPath(this.basePath, `${name}.idx`);

    // Ensure directory exists
    const exists = await this.files.exists(this.basePath);
    if (!exists) {
      await this.files.mkdir(this.basePath);
    }

    // Write pack file first, then index
    await this.files.write(packPath, [packData]);
    await this.files.write(idxPath, [indexData]);

    // Invalidate pack name cache
    this.packNames = null;
  }

  /**
   * Remove a pack file pair
   *
   * Removes both .pack and .idx files, clears from cache.
   */
  async removePack(name: string): Promise<void> {
    const packPath = joinPath(this.basePath, `${name}.pack`);
    const idxPath = joinPath(this.basePath, `${name}.idx`);

    // Close and remove from cache
    const cached = this.cache.get(name);
    if (cached) {
      await cached.reader.close();
      this.cache.delete(name);
    }

    // Remove files
    await this.files.remove(packPath);
    await this.files.remove(idxPath);

    // Invalidate pack name cache
    this.packNames = null;
  }

  /**
   * Invalidate cache
   *
   * Call after external modifications (e.g., GC).
   */
  async invalidate(): Promise<void> {
    // Close all cached readers
    for (const cached of this.cache.values()) {
      await cached.reader.close();
    }
    this.cache.clear();
    this.packNames = null;
  }

  /**
   * List all object IDs across all packs
   */
  async *listObjects(): AsyncIterable<ObjectId> {
    const names = await this.scan();
    const seen = new Set<ObjectId>();

    for (const name of names) {
      const index = await this.getIndex(name);
      for (const id of index.listObjects()) {
        if (!seen.has(id)) {
          seen.add(id);
          yield id;
        }
      }
    }
  }

  /**
   * Check if object is stored as delta in any pack
   *
   * Reads the pack header to determine object type.
   * OFS_DELTA (type 6) and REF_DELTA (type 7) are deltas.
   *
   * Based on: jgit Pack.java#loadObjectSize (checks object type from header)
   *
   * @param id Object ID to check
   * @returns True if stored as delta
   */
  async isDelta(id: ObjectId): Promise<boolean> {
    const packName = await this.findPack(id);
    if (!packName) return false;
    const reader = await this.getPack(packName);
    return reader.isDelta(id);
  }

  /**
   * Get immediate delta base (not full chain resolution)
   *
   * For OFS_DELTA: calculates base offset and finds object ID
   * For REF_DELTA: returns the embedded base object ID
   *
   * Based on: jgit Pack.java#resolveDeltas
   *
   * @param id Object ID to query
   * @returns Base object ID or undefined if not a delta
   */
  async getDeltaBase(id: ObjectId): Promise<ObjectId | undefined> {
    const packName = await this.findPack(id);
    if (!packName) return undefined;

    const reader = await this.getPack(packName);
    const offset = reader.index.findOffset(id);
    if (offset === -1) return undefined;

    const header = await reader.readObjectHeader(offset);

    if (header.type === 7) {
      // REF_DELTA - base ID embedded in header
      return header.baseId;
    }
    if (header.type === 6) {
      // OFS_DELTA - calculate base offset, find corresponding ID
      if (header.baseOffset === undefined) {
        throw new Error("OFS_DELTA missing base offset");
      }
      const baseOffset = offset - header.baseOffset;
      return reader.findObjectIdByOffset(baseOffset);
    }

    return undefined; // Not a delta
  }

  /**
   * Get delta chain info (depth, ultimate base)
   *
   * Walks the delta chain from target to ultimate base object.
   *
   * Based on: jgit Pack.java#load (delta chain resolution)
   *
   * @param id Object ID to query
   * @returns Chain info or undefined if not a delta
   */
  async getDeltaChainInfo(id: ObjectId): Promise<PackDeltaChainInfo | undefined> {
    const packName = await this.findPack(id);
    if (!packName) return undefined;
    const reader = await this.getPack(packName);
    return reader.getDeltaChainInfo(id);
  }

  /**
   * Find all objects that depend on a base (O(n) scan)
   *
   * Scans all pack headers to find objects with matching base.
   * For efficient repeated queries, use DeltaReverseIndex.
   *
   * Note: Git/JGit don't maintain persistent reverse indexes for
   * delta relationships - they rebuild during repack operations.
   *
   * @param baseId Base object ID
   * @returns Array of dependent object IDs
   */
  async findDependents(baseId: ObjectId): Promise<ObjectId[]> {
    const dependents: ObjectId[] = [];

    for await (const id of this.listObjects()) {
      const base = await this.getDeltaBase(id);
      if (base === baseId) {
        dependents.push(id);
      }
    }

    return dependents;
  }

  /**
   * List all delta relationships by scanning pack headers
   *
   * Iterates through all objects and yields those stored as deltas.
   *
   * @returns Async iterable of target->base relationships
   */
  async *listDeltaRelationships(): AsyncIterable<{ target: ObjectId; base: ObjectId }> {
    for await (const id of this.listObjects()) {
      const base = await this.getDeltaBase(id);
      if (base) {
        yield { target: id, base };
      }
    }
  }

  /**
   * Build reverse index for efficient dependent lookups
   *
   * Scans all packs once to build an in-memory index of
   * base->targets relationships.
   *
   * @returns DeltaReverseIndex with O(1) lookups
   */
  async buildReverseIndex(): Promise<DeltaReverseIndex> {
    return DeltaReverseIndex.build(this);
  }

  /**
   * Get statistics about packs in the directory
   */
  async getStats(): Promise<PackDirectoryStats> {
    const names = await this.scan();
    let totalObjects = 0;
    const packSizes: Array<{ name: string; objects: number }> = [];

    for (const name of names) {
      const index = await this.getIndex(name);
      totalObjects += index.objectCount;
      packSizes.push({ name, objects: index.objectCount });
    }

    return {
      packCount: names.length,
      totalObjects,
      packs: packSizes,
    };
  }

  /**
   * Get uncompressed size of an object in any pack
   *
   * @param id Object ID
   * @returns Object size in bytes, or -1 if not found
   */
  async size(id: ObjectId): Promise<number> {
    const packName = await this.findPack(id);
    if (!packName) return -1;

    const reader = await this.getPack(packName);
    const obj = await reader.get(id);
    return obj?.size ?? -1;
  }

  /**
   * Close all pack readers and release resources
   *
   * Alias for invalidate() - closes cached readers and clears cache.
   * Call this when done using the PackDirectory.
   */
  async close(): Promise<void> {
    await this.invalidate();
  }

  /**
   * Resolve a base object from any pack except the excluded one.
   *
   * Used as the resolveExternalBase callback for PackReader
   * to enable cross-pack REF_DELTA resolution.
   */
  private async resolveBase(
    baseId: ObjectId,
    excludePack: string,
  ): Promise<PackObject | undefined> {
    const names = await this.scan();
    for (const name of names) {
      if (name === excludePack) continue;
      const index = await this.getIndex(name);
      if (index.has(baseId)) {
        const reader = await this.getPack(name);
        return reader.get(baseId);
      }
    }
    return undefined;
  }

  /**
   * Load index data from disk
   */
  private async loadIndex(name: string): Promise<PackIndex> {
    const idxPath = joinPath(this.basePath, `${name}.idx`);
    const data = await readFile(this.files, idxPath);
    return readPackIndex(data);
  }

  /**
   * Add entry to cache, evicting oldest if at capacity
   */
  private addToCache(name: string, reader: PackReader, index: PackIndex): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxCachedPacks) {
      let oldestName: string | null = null;
      let oldestTime = Infinity;

      for (const [cachedName, cached] of this.cache) {
        if (cached.lastAccess < oldestTime) {
          oldestTime = cached.lastAccess;
          oldestName = cachedName;
        }
      }

      if (oldestName) {
        const oldest = this.cache.get(oldestName);
        if (oldest) {
          // Close reader asynchronously (fire and forget)
          oldest.reader.close().catch(() => {
            // Ignore close errors
          });
        }
        this.cache.delete(oldestName);
      }
    }

    this.cache.set(name, {
      reader,
      index,
      lastAccess: Date.now(),
    });
  }
}

/**
 * Statistics about packs in the directory
 */
export interface PackDirectoryStats {
  /** Number of pack files */
  packCount: number;
  /** Total number of objects across all packs */
  totalObjects: number;
  /** Per-pack statistics */
  packs: Array<{ name: string; objects: number }>;
}
