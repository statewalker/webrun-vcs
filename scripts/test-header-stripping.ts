/**
 * Test script to compare header stripping methods
 */

import { createNodeCompression } from "../packages/vcs-utils/src/compression/compression-node/index.js";
import { collect, setCompressionUtils } from "../packages/vcs-utils/src/index.js";
import { newByteSplitter, readHeader } from "../packages/vcs-utils/src/streams/index.js";

// Initialize compression
setCompressionUtils(createNodeCompression());

async function stripHeaderWithReadHeader(data: Uint8Array): Promise<Uint8Array> {
  // Wrap in async generator like load() does
  async function* dataGenerator() {
    yield data;
  }

  const [_headerBytes, contentStream] = await readHeader(dataGenerator(), newByteSplitter(0), 32);

  return await collect(contentStream);
}

function stripHeaderDirect(data: Uint8Array): Uint8Array {
  for (let i = 0; i < Math.min(data.length, 32); i++) {
    if (data[i] === 0) {
      return data.subarray(i + 1);
    }
  }
  return data;
}

async function main() {
  console.log("Testing header stripping methods\n");

  // Test case 1: Simple blob
  const content1 = new TextEncoder().encode("Hello, World!");
  const header1 = new TextEncoder().encode(`blob ${content1.length}\0`);
  const obj1 = new Uint8Array(header1.length + content1.length);
  obj1.set(header1, 0);
  obj1.set(content1, header1.length);

  console.log("Test 1: Simple blob");
  console.log(`  Full object size: ${obj1.length}`);
  console.log(`  Header: "${new TextDecoder().decode(obj1.subarray(0, header1.length - 1))}\\0"`);
  console.log(`  Expected content size: ${content1.length}`);

  const result1a = await stripHeaderWithReadHeader(obj1);
  const result1b = stripHeaderDirect(obj1);

  console.log(`  readHeader result: ${result1a.length}`);
  console.log(`  Direct result: ${result1b.length}`);

  if (result1a.length !== result1b.length) {
    console.log(`  !!! MISMATCH !!!`);
  } else {
    console.log(`  ✓ Match`);
  }

  // Test case 2: Larger blob (simulating typical content)
  const content2 = new Uint8Array(348);
  for (let i = 0; i < content2.length; i++) {
    content2[i] = i % 256;
  }
  const header2 = new TextEncoder().encode(`blob ${content2.length}\0`);
  const obj2 = new Uint8Array(header2.length + content2.length);
  obj2.set(header2, 0);
  obj2.set(content2, header2.length);

  console.log("\nTest 2: Larger blob (348 bytes content)");
  console.log(`  Full object size: ${obj2.length}`);
  console.log(`  Header size: ${header2.length}`);
  console.log(`  Expected content size: ${content2.length}`);

  const result2a = await stripHeaderWithReadHeader(obj2);
  const result2b = stripHeaderDirect(obj2);

  console.log(`  readHeader result: ${result2a.length}`);
  console.log(`  Direct result: ${result2b.length}`);

  if (result2a.length !== result2b.length) {
    console.log(`  !!! MISMATCH !!!`);
  } else {
    console.log(`  ✓ Match`);
  }

  // Test case 3: Multi-chunk delivery (like streaming)
  console.log("\nTest 3: Multi-chunk delivery");

  async function* multiChunkGenerator(data: Uint8Array) {
    // Yield in chunks of various sizes
    let offset = 0;
    const chunkSizes = [5, 3, 10, data.length]; // Variable chunk sizes
    for (const size of chunkSizes) {
      if (offset >= data.length) break;
      const chunk = data.subarray(offset, Math.min(offset + size, data.length));
      yield chunk;
      offset += chunk.length;
    }
  }

  const [_headerBytes3, contentStream3] = await readHeader(
    multiChunkGenerator(obj2),
    newByteSplitter(0),
    32,
  );
  const result3 = await collect(contentStream3);

  console.log(`  Multi-chunk result: ${result3.length}`);
  console.log(`  Direct result: ${result2b.length}`);

  if (result3.length !== result2b.length) {
    console.log(`  !!! MISMATCH !!!`);
    console.log(`  Difference: ${result3.length - result2b.length} bytes`);
  } else {
    console.log(`  ✓ Match`);
  }

  // Test case 4: Check if issue is with split across chunk boundary
  console.log("\nTest 4: Split at null byte boundary");

  async function* splitAtNullGenerator(data: Uint8Array) {
    // Find null byte and split right after it
    let nullPos = -1;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0) {
        nullPos = i;
        break;
      }
    }
    if (nullPos === -1) {
      yield data;
      return;
    }
    // Yield header including null
    yield data.subarray(0, nullPos + 1);
    // Yield content
    yield data.subarray(nullPos + 1);
  }

  const [_headerBytes4, contentStream4] = await readHeader(
    splitAtNullGenerator(obj2),
    newByteSplitter(0),
    32,
  );
  const result4 = await collect(contentStream4);

  console.log(`  Split at null result: ${result4.length}`);
  console.log(`  Direct result: ${result2b.length}`);

  if (result4.length !== result2b.length) {
    console.log(`  !!! MISMATCH !!!`);
    console.log(`  Difference: ${result4.length - result2b.length} bytes`);
  } else {
    console.log(`  ✓ Match`);
  }
}

main().catch(console.error);
