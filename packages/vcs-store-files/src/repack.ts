/**
 * Repack loose objects into a pack file.
 *
 * Moves all loose objects from FileRawStorage into a single pack file
 * with an index, then removes the loose files.
 */

import type { FilesApi, GitObject, ObjectTypeString } from "@statewalker/vcs-core";
import { type WrittenPackEntry, writePack, writePackIndexV2 } from "@statewalker/vcs-core";

import type { PackDirectory } from "./pack/pack-directory.js";
import type { FileRawStorage } from "./storage/raw/file-raw-storage.js";

/** A loose object file name, fan-out directory included. */
const OBJECT_ID = /^[0-9a-f]{40}$/;

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
    // Only object files: native git writes objects/ab/tmp_obj_* while it works.
    if (OBJECT_ID.test(id)) objectIds.push(id);
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

  // Stream a pack of the loose objects: each is read as it is written
  const written: WrittenPackEntry[] = [];
  const source = { get: (id: string) => looseObject(looseStorage, id) };
  const packChunks: Uint8Array[] = [];
  for await (const chunk of writePack(source, objectIds, { onEntry: (e) => written.push(e) })) {
    packChunks.push(chunk);
  }
  // PackDirectory.addPack takes the pack whole
  const packData = concatBytes(packChunks);

  // Build the pack index (entries must be sorted by ID for binary search)
  const packChecksum = packData.subarray(packData.length - 20);
  const indexEntries = written
    .map(({ id, offset, crc32 }) => ({ id, offset, crc32 }))
    .sort((a, b) => a.id.localeCompare(b.id));
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

const TYPES = new Set(["commit", "tree", "blob", "tag"]);

/** A loose object read as a stream: its header parsed, its content passed on. */
async function looseObject(storage: FileRawStorage, id: string): Promise<GitObject | undefined> {
  if (!(await storage.has(id))) return undefined;
  const it = storage.load(id)[Symbol.asyncIterator]();
  let head = new Uint8Array(0);
  let nul = -1;
  while (nul < 0) {
    const r = await it.next();
    if (r.done) throw new Error(`loose object ${id} has no header`);
    const joined = new Uint8Array(head.length + r.value.length);
    joined.set(head);
    joined.set(r.value, head.length);
    head = joined;
    nul = head.indexOf(0);
  }
  const m = /^(\w+) (\d+)$/.exec(new TextDecoder().decode(head.subarray(0, nul)));
  if (!m || !TYPES.has(m[1] as string)) throw new Error(`loose object ${id} has a bad header`);
  const rest = head.subarray(nul + 1);
  return {
    type: m[1] as ObjectTypeString,
    size: Number(m[2]),
    content: (async function* () {
      try {
        if (rest.length) yield rest;
        for (let r = await it.next(); !r.done; r = await it.next()) yield r.value;
      } finally {
        await it.return?.();
      }
    })(),
  };
}
