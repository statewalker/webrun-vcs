/**
 * Pack consolidator
 *
 * Merges multiple small pack files into larger ones to reduce
 * filesystem overhead and improve query performance.
 *
 * Based on jgit/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/file/GC.java
 */

import type { FilesApi, PackObjectType } from "@statewalker/vcs-core";
import { joinPath, PendingPack, readFile } from "@statewalker/vcs-core";
import type { PackDirectory } from "./pack-directory.js";

/** Default minimum pack size to keep separate (1MB) */
const DEFAULT_MIN_PACK_SIZE = 1 * 1024 * 1024;

/** Default maximum number of packs before consolidation */
const DEFAULT_MAX_PACKS = 50;

/**
 * Options for pack consolidation
 */
export interface ConsolidateOptions {
  /** Minimum pack size to keep separate (default: 1MB) */
  minPackSize?: number;
  /** Maximum number of packs (default: 50) */
  maxPacks?: number;
  /** Progress callback */
  onProgress?: (current: number, total: number) => void;
}

/**
 * Result of pack consolidation
 */
export interface ConsolidateResult {
  /** Number of packs removed */
  packsRemoved: number;
  /** Number of new packs created */
  packsCreated: number;
  /** Total objects processed */
  objectsProcessed: number;
  /** Bytes reclaimed (reduction in total pack size) */
  bytesReclaimed: number;
}

/**
 * Information about a pack file
 */
interface PackInfo {
  name: string;
  size: number;
}

/**
 * Pack consolidator
 *
 * Merges multiple small pack files into fewer larger ones.
 */
export class PackConsolidator {
  private readonly packDir: PackDirectory;
  private readonly files: FilesApi;
  private readonly basePath: string;

  constructor(packDir: PackDirectory, files: FilesApi, basePath: string) {
    this.packDir = packDir;
    this.files = files;
    this.basePath = basePath;
  }

  /**
   * Check if consolidation is needed
   *
   * Returns true if:
   * - Number of packs exceeds maxPacks
   * - Many small packs exist (more than 10 packs smaller than minPackSize)
   */
  async shouldConsolidate(options?: ConsolidateOptions): Promise<boolean> {
    const maxPacks = options?.maxPacks ?? DEFAULT_MAX_PACKS;
    const minPackSize = options?.minPackSize ?? DEFAULT_MIN_PACK_SIZE;

    const packInfos = await this.getPackInfos();

    // Check if too many packs
    if (packInfos.length > maxPacks) {
      return true;
    }

    // Check if many small packs
    const smallPacks = packInfos.filter((p) => p.size < minPackSize);
    if (smallPacks.length > 10) {
      return true;
    }

    return false;
  }

  /**
   * Perform pack consolidation
   *
   * Merges small packs into larger ones while preserving all objects.
   */
  async consolidate(options?: ConsolidateOptions): Promise<ConsolidateResult> {
    const minPackSize = options?.minPackSize ?? DEFAULT_MIN_PACK_SIZE;
    const onProgress = options?.onProgress;

    const packInfos = await this.getPackInfos();

    // Identify packs to consolidate (small packs)
    const smallPacks = packInfos.filter((p) => p.size < minPackSize);

    if (smallPacks.length <= 1) {
      // Nothing to consolidate
      return {
        packsRemoved: 0,
        packsCreated: 0,
        objectsProcessed: 0,
        bytesReclaimed: 0,
      };
    }

    // Calculate total objects to process
    let totalObjects = 0;
    for (const pack of smallPacks) {
      const index = await this.packDir.getIndex(pack.name);
      totalObjects += index.objectCount;
    }

    // Collect all objects from small packs
    const pendingPack = new PendingPack({
      maxObjects: totalObjects + 1, // Don't auto-flush during collection
      maxBytes: Number.MAX_SAFE_INTEGER,
    });

    let processedObjects = 0;
    const originalTotalSize = smallPacks.reduce((sum, p) => sum + p.size, 0);

    for (const pack of smallPacks) {
      const reader = await this.packDir.getPack(pack.name);
      const index = await this.packDir.getIndex(pack.name);

      for (const entry of index.entries()) {
        const obj = await reader.get(entry.id);
        if (obj) {
          // Store as full object (not delta) to avoid cross-pack references
          pendingPack.addObject(entry.id, obj.type as PackObjectType, obj.content);
        }

        processedObjects++;
        if (onProgress) {
          onProgress(processedObjects, totalObjects);
        }
      }
    }

    if (pendingPack.isEmpty()) {
      return {
        packsRemoved: 0,
        packsCreated: 0,
        objectsProcessed: 0,
        bytesReclaimed: 0,
      };
    }

    // Flush to create new pack
    const result = await pendingPack.flush();

    // Atomic replacement: write new files first, then delete old ones
    await this.atomicReplace(
      smallPacks.map((p) => p.name),
      result.packName,
      result.packData,
      result.indexData,
    );

    // Calculate bytes reclaimed
    const newPackSize = result.packData.length;
    const bytesReclaimed = Math.max(0, originalTotalSize - newPackSize);

    // Invalidate cache
    await this.packDir.invalidate();

    return {
      packsRemoved: smallPacks.length,
      packsCreated: 1,
      objectsProcessed: processedObjects,
      bytesReclaimed,
    };
  }

  /**
   * Get info for all pack files
   */
  private async getPackInfos(): Promise<PackInfo[]> {
    const packNames = await this.packDir.scan();
    const infos: PackInfo[] = [];

    for (const name of packNames) {
      const packPath = joinPath(this.basePath, `${name}.pack`);
      try {
        // Try stat first, fall back to reading file size
        let size = 0;
        try {
          const stat = await this.files.stats(packPath);
          size = stat?.size ?? 0;
        } catch {
          // Stat might not be available, try reading file
          const data = await readFile(this.files, packPath);
          size = data.length;
        }
        infos.push({
          name,
          size,
        });
      } catch {
        // Pack file may have been deleted - skip it
      }
    }

    return infos;
  }

  /**
   * Atomically replace old packs with new pack
   *
   * Since not all FilesApi implementations support rename,
   * we write directly to final paths.
   */
  private async atomicReplace(
    oldPackNames: string[],
    newPackName: string,
    packData: Uint8Array,
    indexData: Uint8Array,
  ): Promise<void> {
    const newPackPath = joinPath(this.basePath, `${newPackName}.pack`);
    const newIndexPath = joinPath(this.basePath, `${newPackName}.idx`);

    // Ensure directory exists
    const exists = await this.files.exists(this.basePath);
    if (!exists) {
      await this.files.mkdir(this.basePath);
    }

    // Write new files directly
    await this.files.write(newPackPath, [packData]);
    await this.files.write(newIndexPath, [indexData]);

    // Delete old pack files
    for (const name of oldPackNames) {
      const oldPackPath = joinPath(this.basePath, `${name}.pack`);
      const oldIndexPath = joinPath(this.basePath, `${name}.idx`);

      try {
        await this.files.remove(oldPackPath);
      } catch {
        // Ignore errors (file may not exist)
      }

      try {
        await this.files.remove(oldIndexPath);
      } catch {
        // Ignore errors (file may not exist)
      }
    }
  }
}
