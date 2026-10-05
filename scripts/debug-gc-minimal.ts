/**
 * Minimal GC test that logs all sizes during delta computation
 */

import { createNodeCompression } from "../packages/vcs-utils/src/compression/compression-node/index.js";
import { createDelta, createDeltaRanges } from "../packages/vcs-utils/src/diff/index.js";
import { collect, setCompressionUtils } from "../packages/vcs-utils/src/index.js";
import { newByteSplitter, readHeader } from "../packages/vcs-utils/src/streams/index.js";

// Initialize compression
setCompressionUtils(createNodeCompression());

/**
 * Strip Git header from buffer (same as in raw-store-with-delta.ts)
 */
function stripGitHeader(buffer: Uint8Array): Uint8Array {
  const maxHeaderLen = Math.min(32, buffer.length);
  for (let i = 0; i < maxHeaderLen; i++) {
    if (buffer[i] === 0) {
      return buffer.subarray(i + 1);
    }
  }
  return buffer;
}

/**
 * Simulate storeObject - use readHeader to split
 */
async function simulateStoreObject(data: Uint8Array): Promise<{
  headerBytes: Uint8Array;
  contentBytes: Uint8Array;
}> {
  async function* dataGenerator() {
    yield data;
  }

  const [headerBytes, contentStream] = await readHeader(dataGenerator(), newByteSplitter(0), 32);

  const contentBytes = await collect(contentStream);
  return { headerBytes, contentBytes };
}

/**
 * Simulate deltify load - use stripGitHeader
 */
async function simulateDeltifyLoad(data: Uint8Array): Promise<Uint8Array> {
  // In the actual code, stripGitHeaderAndCollect does:
  // 1. Collect stream into buffer
  // 2. Strip header using direct byte search
  return stripGitHeader(data);
}

async function main() {
  console.log("Minimal GC simulation with size logging\n");

  // Create test objects
  const encoder = new TextEncoder();

  // Object A: A blob with 348 bytes of content (similar to the problematic one)
  const contentA = new Uint8Array(348);
  for (let i = 0; i < contentA.length; i++) {
    contentA[i] = 65 + (i % 26); // Fill with A-Z pattern
  }
  const headerA = encoder.encode(`blob ${contentA.length}\0`);
  const fullObjectA = new Uint8Array(headerA.length + contentA.length);
  fullObjectA.set(headerA, 0);
  fullObjectA.set(contentA, headerA.length);

  console.log(`Object A (base):`);
  console.log(`  Full object size: ${fullObjectA.length}`);
  console.log(`  Header: "${new TextDecoder().decode(headerA).replace("\0", "\\0")}"`);
  console.log(`  Content size: ${contentA.length}`);

  // Object B: A similar blob (target for deltification)
  const contentB = new Uint8Array(348);
  for (let i = 0; i < contentB.length; i++) {
    contentB[i] = 65 + ((i + 5) % 26); // Slightly different pattern
  }
  const headerB = encoder.encode(`blob ${contentB.length}\0`);
  const fullObjectB = new Uint8Array(headerB.length + contentB.length);
  fullObjectB.set(headerB, 0);
  fullObjectB.set(contentB, headerB.length);

  console.log(`\nObject B (target):`);
  console.log(`  Full object size: ${fullObjectB.length}`);
  console.log(`  Header: "${new TextDecoder().decode(headerB).replace("\0", "\\0")}"`);
  console.log(`  Content size: ${contentB.length}`);

  // Step 1: Simulate storeObject (how objects are stored to pack)
  console.log("\n--- Step 1: Simulate storeObject ---");
  const storeA = await simulateStoreObject(fullObjectA);
  const storeB = await simulateStoreObject(fullObjectB);
  console.log(
    `  Object A: header=${storeA.headerBytes.length}, content=${storeA.contentBytes.length}`,
  );
  console.log(
    `  Object B: header=${storeB.headerBytes.length}, content=${storeB.contentBytes.length}`,
  );

  // Step 2: Simulate deltify load (how objects are loaded for delta computation)
  console.log("\n--- Step 2: Simulate deltify load ---");
  const deltifyA = await simulateDeltifyLoad(fullObjectA);
  const deltifyB = await simulateDeltifyLoad(fullObjectB);
  console.log(`  Object A content: ${deltifyA.length}`);
  console.log(`  Object B content: ${deltifyB.length}`);

  // Step 3: Compare
  console.log("\n--- Step 3: Compare ---");
  if (storeA.contentBytes.length !== deltifyA.length) {
    console.log(
      `  ❌ MISMATCH: storeObject content (${storeA.contentBytes.length}) != deltify content (${deltifyA.length})`,
    );
  } else {
    console.log(`  ✓ Match: storeObject content = deltify content = ${storeA.contentBytes.length}`);
  }

  // Step 4: Compute delta
  console.log("\n--- Step 4: Compute delta ---");
  const ranges = createDeltaRanges(deltifyA, deltifyB);
  const delta = [...createDelta(deltifyA, deltifyB, ranges)];

  // Check the start instruction
  const startInstr = delta.find((d) => d.type === "start");
  if (startInstr && startInstr.type === "start") {
    console.log(
      `  Delta start instruction: sourceLen=${startInstr.sourceLen}, targetLen=${startInstr.targetLen}`,
    );
  }

  // Step 5: Verify
  console.log("\n--- Step 5: Verification ---");
  console.log(`  Stored base content size: ${storeA.contentBytes.length}`);
  console.log(
    `  Delta's sourceLen: ${startInstr && startInstr.type === "start" ? startInstr.sourceLen : "N/A"}`,
  );

  if (
    startInstr &&
    startInstr.type === "start" &&
    storeA.contentBytes.length === startInstr.sourceLen
  ) {
    console.log(`  ✓ Sizes match - delta should work correctly`);
  } else {
    console.log(`  ❌ SIZE MISMATCH - this would cause delta application to fail!`);
  }

  // Now test with content that has null bytes
  console.log("\n\n=== Testing with null bytes in content ===\n");

  // Object C: A tree object (contains null bytes)
  const treeEntry1 = encoder.encode("100644 file.txt\0");
  const sha1 = new Uint8Array(20).fill(0xab);
  const treeContent = new Uint8Array(treeEntry1.length + sha1.length);
  treeContent.set(treeEntry1, 0);
  treeContent.set(sha1, treeEntry1.length);

  const headerC = encoder.encode(`tree ${treeContent.length}\0`);
  const fullObjectC = new Uint8Array(headerC.length + treeContent.length);
  fullObjectC.set(headerC, 0);
  fullObjectC.set(treeContent, headerC.length);

  console.log(`Object C (tree with null bytes in content):`);
  console.log(`  Full object size: ${fullObjectC.length}`);
  console.log(`  Header size: ${headerC.length}`);
  console.log(`  Content size: ${treeContent.length}`);

  const storeC = await simulateStoreObject(fullObjectC);
  const deltifyC = await simulateDeltifyLoad(fullObjectC);

  console.log(`\n  storeObject content size: ${storeC.contentBytes.length}`);
  console.log(`  deltify content size: ${deltifyC.length}`);

  if (storeC.contentBytes.length !== deltifyC.length) {
    console.log(
      `  ❌ MISMATCH: storeObject (${storeC.contentBytes.length}) != deltify (${deltifyC.length})`,
    );
    console.log(`  Difference: ${storeC.contentBytes.length - deltifyC.length} bytes`);
  } else {
    console.log(`  ✓ Match: ${storeC.contentBytes.length} bytes`);
  }
}

main().catch(console.error);
