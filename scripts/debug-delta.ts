/**
 * Debug script to trace delta computation sizes
 */

import { createNodeCompression } from "../packages/vcs-utils/src/compression/compression-node/index.js";
import {
  parseGitDelta,
  serializeDeltaToGit,
} from "../packages/vcs-utils/src/diff/delta/git-delta-format.js";
import {
  createDelta,
  createDeltaRanges,
  setCompressionUtils,
} from "../packages/vcs-utils/src/index.js";

// Initialize compression
setCompressionUtils(createNodeCompression());

// Simulate what happens in defaultComputeDelta
async function main() {
  // Create sample content WITH headers (like what comes from loose storage)
  const baseContent = new TextEncoder().encode("Hello, World!");
  const targetContent = new TextEncoder().encode("Hello, Universe!");

  // Create Git headers
  const baseWithHeader = createGitObject("blob", baseContent);
  const targetWithHeader = createGitObject("blob", targetContent);

  console.log("Base content (with header):");
  console.log(`  Total length: ${baseWithHeader.length}`);
  console.log(
    `  Header: "${new TextDecoder().decode(baseWithHeader.subarray(0, 20)).replace(/\0/g, "\\0")}"`,
  );
  console.log(`  Content length: ${baseContent.length}`);

  console.log("\nTarget content (with header):");
  console.log(`  Total length: ${targetWithHeader.length}`);
  console.log(
    `  Header: "${new TextDecoder().decode(targetWithHeader.subarray(0, 20)).replace(/\0/g, "\\0")}"`,
  );
  console.log(`  Content length: ${targetContent.length}`);

  // Strip headers (like defaultComputeDelta does)
  const strippedBase = stripGitHeader(baseWithHeader);
  const strippedTarget = stripGitHeader(targetWithHeader);

  console.log("\nAfter stripping headers:");
  console.log(`  Base length: ${strippedBase.length} (expected: ${baseContent.length})`);
  console.log(`  Target length: ${strippedTarget.length} (expected: ${targetContent.length})`);

  // Create delta
  const ranges = createDeltaRanges(strippedBase, strippedTarget);
  const delta = [...createDelta(strippedBase, strippedTarget, ranges)];

  console.log("\nDelta instructions:");
  for (const d of delta) {
    console.log(`  ${JSON.stringify(d)}`);
  }

  // Serialize to Git format
  const binaryDelta = serializeDeltaToGit(delta);
  const parsed = parseGitDelta(binaryDelta);

  console.log("\nSerialized delta:");
  console.log(`  Binary length: ${binaryDelta.length}`);
  console.log(`  Base size in delta header: ${parsed.baseSize} (expected: ${strippedBase.length})`);
  console.log(
    `  Result size in delta header: ${parsed.resultSize} (expected: ${strippedTarget.length})`,
  );
  console.log(`  Instructions: ${parsed.instructions.length}`);

  // Verify match
  if (parsed.baseSize !== strippedBase.length) {
    console.log("\n!!! ERROR: Base size mismatch !!!");
    console.log(`  Delta claims base is ${parsed.baseSize} bytes`);
    console.log(`  Actual base is ${strippedBase.length} bytes`);
  } else {
    console.log("\n✓ Base sizes match");
  }
}

function createGitObject(type: string, content: Uint8Array): Uint8Array {
  const header = new TextEncoder().encode(`${type} ${content.length}\0`);
  const result = new Uint8Array(header.length + content.length);
  result.set(header, 0);
  result.set(content, header.length);
  return result;
}

function stripGitHeader(buffer: Uint8Array): Uint8Array {
  const maxHeaderLen = Math.min(32, buffer.length);
  for (let i = 0; i < maxHeaderLen; i++) {
    if (buffer[i] === 0) {
      return buffer.subarray(i + 1);
    }
  }
  return buffer;
}

main().catch(console.error);
