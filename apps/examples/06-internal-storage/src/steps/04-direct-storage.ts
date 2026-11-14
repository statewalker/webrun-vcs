/**
 * Step 04: Direct Storage (Bypassing Git Index)
 *
 * This step demonstrates how to use VCS storage directly
 * without the Git workflow (index, commit, etc.)
 *
 * Use cases:
 * - Content-addressable storage for applications
 * - Version tracking without working tree
 * - Embedding version control in applications
 * - Custom data deduplication
 */

import type { GitObjects } from "@statewalker/vcs-core";
import { log, logInfo, logSection, logSuccess, shortId, state } from "../shared/index.js";

/** An object's type and size: `get` inflates only the header until the content is read. */
async function objectHeader(objects: GitObjects, id: string) {
  const obj = await objects.get(id);
  if (!obj) throw new Error(`Object not found: ${id}`);
  await obj.content[Symbol.asyncIterator]().return?.();
  return { type: obj.type, size: obj.size };
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Concatenate byte arrays.
 */
function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

export async function run(): Promise<void> {
  logSection("Step 04: Direct Storage (Bypassing Git Index)");

  const history = state.history;
  if (!history) {
    throw new Error("History not initialized. Run steps 01-03 first.");
  }

  log("Using VCS storage directly without Git workflow...\n");

  // Demonstrate content-addressable storage
  log("--- Content-Addressable Storage ---\n");

  // Store content directly
  const version1 = textEncoder.encode("Version 1 content");
  const version2 = textEncoder.encode("Version 2 content with changes");
  const version3 = textEncoder.encode("Version 1 content"); // Same as version1

  const id1 = await history.blobs.store([version1]);
  const id2 = await history.blobs.store([version2]);
  const id3 = await history.blobs.store([version3]);

  log("Stored three versions:");
  logInfo("  Version 1", shortId(id1));
  logInfo("  Version 2", shortId(id2));
  logInfo("  Version 3", shortId(id3));

  log("\nDeduplication in action:");
  log(`  Version 1 ID: ${id1}`);
  log(`  Version 3 ID: ${id3}`);
  log(`  Same content = Same ID: ${id1 === id3}`);

  // Load content back
  log("\n--- Loading Content ---\n");

  const chunks1: Uint8Array[] = [];
  const content1 = await history.blobs.load(id1);
  if (content1) {
    for await (const chunk of content1) {
      chunks1.push(chunk);
    }
  }
  const loaded1 = textDecoder.decode(concatBytes(...chunks1));

  logInfo("  Loaded Version 1", loaded1);

  // Get object metadata
  log("\n--- Object Metadata ---\n");

  const header1 = await objectHeader(history.objects, id1);
  const header2 = await objectHeader(history.objects, id2);

  log("Version 1 metadata:");
  logInfo("  Type", header1.type);
  logInfo("  Size", `${header1.size} bytes`);

  log("\nVersion 2 metadata:");
  logInfo("  Type", header2.type);
  logInfo("  Size", `${header2.size} bytes`);

  // Demonstrate storing structured data
  log("\n--- Storing Structured Data ---\n");

  // Store JSON data
  const configData = {
    version: 1,
    settings: {
      theme: "dark",
      fontSize: 14,
    },
    lastModified: Date.now(),
  };

  const configBytes = textEncoder.encode(JSON.stringify(configData, null, 2));
  const configId = await history.blobs.store([configBytes]);

  log("Stored JSON configuration:");
  logInfo("  Object ID", shortId(configId));
  logInfo("  Size", `${configBytes.length} bytes`);

  // Load and parse JSON
  const configChunks: Uint8Array[] = [];
  const configContent = await history.blobs.load(configId);
  if (configContent) {
    for await (const chunk of configContent) {
      configChunks.push(chunk);
    }
  }
  const loadedConfig = JSON.parse(textDecoder.decode(concatBytes(...configChunks)));

  log("\nLoaded configuration:");
  logInfo("  Version", loadedConfig.version);
  logInfo("  Theme", loadedConfig.settings.theme);

  // Demonstrate binary data storage
  log("\n--- Binary Data Storage ---\n");

  // Create some binary data (simulated image header)
  const binaryData = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47, // PNG signature
    0x0d,
    0x0a,
    0x1a,
    0x0a, // PNG signature continued
    0x00,
    0x00,
    0x00,
    0x0d, // IHDR chunk length
    0x49,
    0x48,
    0x44,
    0x52, // IHDR
  ]);

  const binaryId = await history.blobs.store([binaryData]);

  log("Stored binary data:");
  logInfo("  Object ID", shortId(binaryId));
  logInfo("  Size", `${binaryData.length} bytes`);
  log(`  First bytes: ${[...binaryData.slice(0, 4)].map((b) => b.toString(16)).join(" ")}`);

  // Use case examples
  log("\n--- Use Cases for Direct Storage ---\n");

  log("1. Content Management System");
  log("   - Store document versions");
  log("   - Automatic deduplication of images");
  log("   - Track content history without Git workflow");

  log("\n2. Configuration Management");
  log("   - Version application configs");
  log("   - Track changes over time");
  log("   - Rollback to previous versions");

  log("\n3. Asset Pipeline");
  log("   - Store build artifacts");
  log("   - Cache based on content hash");
  log("   - Deduplicate across branches");

  log("\n4. Data Versioning");
  log("   - Version datasets for ML");
  log("   - Track data lineage");
  log("   - Efficient storage with dedup");

  // Show how this differs from Git workflow
  log("\n--- Comparison: Direct Storage vs Git Workflow ---\n");

  log("Direct Storage:");
  log("  - Store content directly: blobs.store([content])");
  log("  - No index, no working tree, no commits required");
  log("  - Immediate deduplication");
  log("  - Perfect for embedding in applications");

  log("\nGit Workflow:");
  log("  - Create files in working tree");
  log("  - Stage files (git add)");
  log("  - Commit changes (git commit)");
  log("  - Full history and branching support");

  logSuccess("\nDirect storage demonstration complete!");
}
