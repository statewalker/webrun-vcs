/**
 * Step 02: Understanding Pack Files
 *
 * This step demonstrates Git pack file structure and how objects
 * are efficiently stored together.
 *
 * Key concepts:
 * - Pack files bundle multiple objects together
 * - Pack files use delta compression between similar objects
 * - Pack index (.idx) enables fast object lookup
 * - Pack format: PACK header + version + object count + entries + checksum
 */

import {
  type GitObject,
  ObjectType,
  type WrittenPackEntry,
  writePack,
  writePackIndexV2,
} from "@statewalker/vcs-core";
import { bytesToHex, decompressBlock } from "@statewalker/vcs-utils";
import { joinPath, readFile } from "@statewalker/vcs-utils/files";
import {
  countLooseObjects,
  createFilesApi,
  getPackFileStats,
  listPackFiles,
  log,
  logInfo,
  logSection,
  logSuccess,
  looseObjectPath,
  PACK_DIR,
  shortId,
  state,
} from "../shared/index.js";

/**
 * Read a loose object from the filesystem.
 */
async function readLooseObject(
  objectId: string,
): Promise<{ type: number; content: Uint8Array } | null> {
  try {
    const compressed = await readFile(createFilesApi(), looseObjectPath(objectId));
    const decompressed = await decompressBlock(compressed);

    // Find null byte
    let nullIndex = -1;
    for (let i = 0; i < decompressed.length; i++) {
      if (decompressed[i] === 0) {
        nullIndex = i;
        break;
      }
    }

    if (nullIndex === -1) return null;

    const header = new TextDecoder().decode(decompressed.subarray(0, nullIndex));
    const [typeName] = header.split(" ");

    let type: number;
    switch (typeName) {
      case "commit":
        type = ObjectType.COMMIT;
        break;
      case "tree":
        type = ObjectType.TREE;
        break;
      case "blob":
        type = ObjectType.BLOB;
        break;
      case "tag":
        type = ObjectType.TAG;
        break;
      default:
        return null;
    }

    const content = decompressed.subarray(nullIndex + 1);
    return { type, content };
  } catch {
    return null;
  }
}

/**
 * Collect all loose object IDs.
 */
async function collectLooseObjectIds(): Promise<string[]> {
  return (await countLooseObjects()).objects;
}

export async function run(): Promise<void> {
  logSection("Step 02: Understanding Pack Files");

  const history = state.history;
  if (!history) {
    throw new Error("History not initialized. Run step 01 first.");
  }

  // Check current state
  const { count: looseBefore } = await countLooseObjects();
  const packsBefore = await listPackFiles();

  log("Current state:");
  logInfo("  Loose objects", looseBefore);
  logInfo("  Pack files", packsBefore.length);

  if (looseBefore === 0) {
    log("\nNo loose objects to pack. Run step 01 first.");
    return;
  }

  // Collect loose objects
  const looseObjectIds = await collectLooseObjectIds();

  log("\n--- Creating Pack File ---\n");

  // Create the pack with writePack: it streams the header, each entry and the SHA-1 trailer,
  // reading each object only when it writes it
  const TYPE_NAMES = ["", "commit", "tree", "blob", "tag"] as const;
  const source = {
    async get(objectId: string): Promise<GitObject | undefined> {
      const obj = await readLooseObject(objectId);
      if (!obj) return undefined;
      const typeName = TYPE_NAMES[obj.type] || "unknown";
      log(`  Added ${typeName}: ${shortId(objectId)} (${obj.content.length} bytes)`);
      return {
        type: TYPE_NAMES[obj.type] as GitObject["type"],
        size: obj.content.length,
        content: (async function* () {
          yield obj.content;
        })(),
      };
    },
  };
  const written: WrittenPackEntry[] = [];
  const chunks: Uint8Array[] = [];
  for await (const chunk of writePack(source, looseObjectIds, {
    onEntry: (e) => written.push(e),
  })) {
    chunks.push(chunk);
  }
  const packData = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    packData.set(c, at);
    at += c.length;
  }
  const packChecksum = packData.subarray(packData.length - 20);

  log(`\nPack created with ${written.length} objects`);
  logInfo("  Pack data size", `${packData.length} bytes`);

  // Write pack file
  const packName = `pack-${bytesToHex(packChecksum)}`;

  const files = createFilesApi();
  await files.mkdir(PACK_DIR);

  const packPath = joinPath(PACK_DIR, `${packName}.pack`);
  await files.write(packPath, [packData]);
  log(`\n  Written: ${packName}.pack`);

  // Write pack index
  const indexEntries = written
    .map(({ id, offset, crc32 }) => ({ id, offset, crc32 }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const indexData = await writePackIndexV2(indexEntries, packChecksum);
  const indexPath = joinPath(PACK_DIR, `${packName}.idx`);
  await files.write(indexPath, [indexData]);
  log(`  Written: ${packName}.idx`);

  // Explain pack structure
  log("\n--- Pack File Structure ---\n");
  log("Pack files consist of:");
  log("  1. Header: 'PACK' signature (4 bytes)");
  log("  2. Version: Pack format version (4 bytes)");
  log("  3. Object count: Number of objects (4 bytes)");
  log("  4. Object entries: Compressed object data");
  log("  5. Checksum: SHA-1 of pack content (20 bytes)");

  log("\nPack entry format:");
  log("  - Type (3 bits) + Size (variable length encoding)");
  log("  - Zlib-compressed object content");
  log("  - Delta objects reference base object offset");

  // Show pack header
  log("\n--- Pack Header Analysis ---\n");
  // packData is the pack written above
  const signature = new TextDecoder().decode(packData.subarray(0, 4));
  const version = (packData[4] << 24) | (packData[5] << 16) | (packData[6] << 8) | packData[7];
  const objectCount =
    (packData[8] << 24) | (packData[9] << 16) | (packData[10] << 8) | packData[11];

  logInfo("  Signature", signature);
  logInfo("  Version", version);
  logInfo("  Object count", objectCount);
  logInfo("  Total size", `${packData.length} bytes`);

  // Explain pack index
  log("\n--- Pack Index Structure ---\n");
  log("Pack index (.idx) enables fast object lookup:");
  log("  1. Fanout table: 256 entries for hash prefix lookup");
  log("  2. SHA-1 list: Sorted list of all object hashes");
  log("  3. CRC32 list: Integrity checksums for each object");
  log("  4. Offset list: File offsets for each object");
  log("  5. Pack checksum: SHA-1 of the pack file");

  // Final state
  const packsAfter = await listPackFiles();
  const packStats = await getPackFileStats();

  log("\n--- Final State ---\n");
  logInfo("  Pack files", packsAfter.length);
  for (const pack of packStats) {
    log(`    ${pack.name} (${pack.sizeFormatted})`);
  }

  logSuccess("\nPack file demonstration complete!");
  log("\nNote: Loose objects still exist. Step 03 will show garbage collection.");
}
