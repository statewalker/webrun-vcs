/**
 * Trace script to debug repack content sizes
 *
 * Run from the apps/example-git-lifecycle/test-lifecycle-repo directory
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  createNodeCompression,
  decompressBlock,
} from "../packages/vcs-utils/src/compression/compression-node/index.js";
import { collect, setCompressionUtils } from "../packages/vcs-utils/src/index.js";
import { newByteSplitter, readHeader } from "../packages/vcs-utils/src/streams/index.js";

// Initialize compression
setCompressionUtils(createNodeCompression());

const OBJECTS_DIR = path.join(
  process.cwd(),
  "apps/example-git-lifecycle/test-lifecycle-repo/.git/objects",
);

async function readLooseObject(id: string): Promise<Uint8Array> {
  const prefix = id.substring(0, 2);
  const suffix = id.substring(2);
  const objectPath = path.join(OBJECTS_DIR, prefix, suffix);

  const compressed = await fs.readFile(objectPath);
  const decompressed = await decompressBlock(new Uint8Array(compressed));
  return decompressed;
}

function parseHeader(data: Uint8Array): { type: string; size: number; contentOffset: number } {
  for (let i = 0; i < Math.min(data.length, 32); i++) {
    if (data[i] === 0) {
      const headerStr = new TextDecoder().decode(data.subarray(0, i));
      const spaceIdx = headerStr.indexOf(" ");
      const type = headerStr.substring(0, spaceIdx);
      const size = parseInt(headerStr.substring(spaceIdx + 1), 10);
      return { type, size, contentOffset: i + 1 };
    }
  }
  throw new Error("No null byte found in header");
}

async function stripHeaderWithReadHeader(
  data: Uint8Array,
): Promise<{ header: Uint8Array; content: Uint8Array }> {
  // Wrap in async generator like load() does
  async function* dataGenerator() {
    yield data;
  }

  const [headerBytes, contentStream] = await readHeader(dataGenerator(), newByteSplitter(0), 32);

  const content = await collect(contentStream);

  return { header: headerBytes, content };
}

function stripHeaderDirect(data: Uint8Array): { type: string; size: number; content: Uint8Array } {
  for (let i = 0; i < Math.min(data.length, 32); i++) {
    if (data[i] === 0) {
      const headerStr = new TextDecoder().decode(data.subarray(0, i));
      const spaceIdx = headerStr.indexOf(" ");
      const type = headerStr.substring(0, spaceIdx);
      const size = parseInt(headerStr.substring(spaceIdx + 1), 10);
      return { type, size, content: data.subarray(i + 1) };
    }
  }
  throw new Error("No null byte found");
}

async function main() {
  // List some loose objects
  const prefixes = await fs.readdir(OBJECTS_DIR);
  const objectIds: string[] = [];

  for (const prefix of prefixes) {
    if (prefix === "pack" || prefix === "info" || prefix.length !== 2) continue;
    const prefixPath = path.join(OBJECTS_DIR, prefix);
    try {
      const suffixes = await fs.readdir(prefixPath);
      for (const suffix of suffixes) {
        if (suffix.length === 38) {
          objectIds.push(prefix + suffix);
        }
      }
    } catch {}
  }

  console.log(`Found ${objectIds.length} loose objects\n`);

  // Analyze a few objects
  for (const id of objectIds.slice(0, 10)) {
    console.log(`Object: ${id}`);

    const data = await readLooseObject(id);
    console.log(`  Total decompressed size: ${data.length}`);

    const parsed = parseHeader(data);
    console.log(
      `  Parsed header: type=${parsed.type}, size=${parsed.size}, contentOffset=${parsed.contentOffset}`,
    );
    console.log(`  Actual content size: ${data.length - parsed.contentOffset}`);

    if (parsed.size !== data.length - parsed.contentOffset) {
      console.log(`  !!! SIZE MISMATCH in header !!!`);
    }

    // Strip using readHeader (like storeObject does)
    const readHeaderResult = await stripHeaderWithReadHeader(data);
    console.log(
      `  readHeader result: header=${readHeaderResult.header.length} bytes, content=${readHeaderResult.content.length} bytes`,
    );

    // Strip using direct method (like defaultComputeDelta does)
    const directResult = stripHeaderDirect(data);
    console.log(`  Direct strip result: content=${directResult.content.length} bytes`);

    if (readHeaderResult.content.length !== directResult.content.length) {
      console.log(`  !!! CONTENT SIZE MISMATCH !!!`);
      console.log(`    readHeader: ${readHeaderResult.content.length}`);
      console.log(`    Direct: ${directResult.content.length}`);
    }

    console.log();
  }
}

main().catch(console.error);
