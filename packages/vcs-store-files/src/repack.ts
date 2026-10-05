/**
 * Repack loose objects into a pack file.
 *
 * Moves all loose objects from FileRawStorage into a single pack file
 * with an index, then removes the loose files.
 */

import type { FilesApi } from "@statewalker/vcs-core";
import {
  parseHeader,
  StreamingPackWriter,
  typeStringToCode,
  writePackIndexV2,
} from "@statewalker/vcs-core";

import type { PackDirectory } from "./pack/pack-directory.js";
import type { FileRawStorage } from "./storage/raw/file-raw-storage.js";

/**
 * Options for the repack operation.
 */
export interface RepackOptions {
  /** Source: loose object storage */
  looseStorage: FileRawStorage;
  /** Destination: pack directory for pack files */
  packDirectory: PackDirectory;
  /** @deprecated Unused — kept for backward compatibility */
  files?: FilesApi;
  /** If true, report what would be done without actually doing it */
  dryRun?: boolean;
}

/**
 * Result of the repack operation.
 */
export interface RepackResult {
  /** Name of the created pack file (without path/extension) */
  packName: string;
  /** Number of objects packed */
  objectCount: number;
  /** Number of loose object files removed */
  looseObjectsRemoved: number;
}

/**
 * Repack all loose objects into a single pack file.
 *
 * 1. Collects all loose object IDs
 * 2. Creates a pack file with all objects
 * 3. Builds a V2 index for the pack
 * 4. Saves pack + index via PackDirectory
 * 5. Removes loose object files
 *
 * @returns Repack result with stats, or null if no loose objects to pack
 *
 * @example
 * ```typescript
 * const { looseStorage, packDirectory } = await createGitFilesBackend({ files, create: true });
 * // ... store some objects ...
 * const result = await repack({ looseStorage, packDirectory, files });
 * if (result) {
 *   console.log(`Packed ${result.objectCount} objects into ${result.packName}`);
 * }
 * ```
 */
export async function repack(options: RepackOptions): Promise<RepackResult | null> {
  const { looseStorage, packDirectory, dryRun = false } = options;

  // Collect all loose object IDs
  const objectIds: string[] = [];
  for await (const id of looseStorage.keys()) {
    objectIds.push(id);
  }

  if (objectIds.length === 0) {
    return null;
  }

  if (dryRun) {
    return {
      packName: "",
      objectCount: objectIds.length,
      looseObjectsRemoved: 0,
    };
  }

  // Create a pack with all loose objects
  const writer = new StreamingPackWriter(objectIds.length);
  const packChunks: Uint8Array[] = [];

  for (const id of objectIds) {
    // Load raw content from loose storage (decompressed "type size\0content")
    const rawChunks: Uint8Array[] = [];
    for await (const chunk of looseStorage.load(id)) {
      rawChunks.push(chunk);
    }
    const rawData = concatBytes(rawChunks);

    // Parse the Git header to get type and content
    const header = parseHeader(rawData);
    const typeCode = typeStringToCode(header.type);
    const content = rawData.subarray(header.contentOffset);

    // Add to pack writer
    for await (const chunk of writer.addObject(id, typeCode, content)) {
      packChunks.push(chunk);
    }
  }

  // Finalize the pack
  for await (const chunk of writer.finalize()) {
    packChunks.push(chunk);
  }

  const packData = concatBytes(packChunks);

  // Build the pack index (entries must be sorted by ID for binary search)
  const packChecksum = packData.subarray(packData.length - 20);
  const indexEntries = writer.getIndexEntries().sort((a, b) => a.id.localeCompare(b.id));
  const indexData = await writePackIndexV2(indexEntries, packChecksum);

  // Generate pack name from checksum
  const packName = `pack-${bytesToHex(packChecksum)}`;

  // Save pack + index
  await packDirectory.addPack(packName, packData, indexData);

  // Remove loose objects
  let removed = 0;
  for (const id of objectIds) {
    if (await looseStorage.remove(id)) {
      removed++;
    }
  }

  return {
    packName,
    objectCount: objectIds.length,
    looseObjectsRemoved: removed,
  };
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
