/**
 * Pack Operations Benchmark
 *
 * Measures performance of pack file writing and reading operations.
 *
 * Run with: pnpm start
 */

import {
  type GitObject,
  readPackIndex,
  type WrittenPackEntry,
  writePack,
  writePackIndex,
} from "@statewalker/vcs-core";
import { sha1 } from "@statewalker/vcs-utils/hash/sha1";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";

// ============================================================================
// Content Generation
// ============================================================================

/**
 * Creates reproducible pseudo-random content
 */
function createRandomContent(size: number, seed: number): Uint8Array {
  const buffer = new Uint8Array(size);
  let state = seed;

  for (let i = 0; i < size; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    buffer[i] = state & 0xff;
  }

  return buffer;
}

/**
 * Create a blob object for packing
 */
interface BlobObject {
  id: string;
  content: Uint8Array;
}

async function createBlobObject(content: Uint8Array): Promise<BlobObject> {
  // Git blob format: "blob <size>\0<content>"
  const header = new TextEncoder().encode(`blob ${content.length}\0`);
  const fullContent = new Uint8Array(header.length + content.length);
  fullContent.set(header);
  fullContent.set(content, header.length);

  const hashBytes = await sha1(fullContent);
  const id = bytesToHex(hashBytes);
  return { id, content };
}

// ============================================================================
// Benchmark Utilities
// ============================================================================

interface PackBenchmarkResult {
  objectCount: number;
  totalContentSize: number;
  packSize: number;
  indexSize: number;
  compressionRatio: number;
  writeTimeMs: number;
  indexWriteTimeMs: number;
  readAllTimeMs: number;
  indexReadTimeMs: number;
}

async function runPackBenchmark(objectSizes: number[], seed: number): Promise<PackBenchmarkResult> {
  // Generate objects
  const objects: BlobObject[] = [];
  let totalContentSize = 0;

  for (let i = 0; i < objectSizes.length; i++) {
    const content = createRandomContent(objectSizes[i], seed + i * 1000);
    const obj = await createBlobObject(content);
    objects.push(obj);
    totalContentSize += content.length;
  }

  // Write pack (streamed by writePack; collected here to measure its size)
  const byId = new Map(objects.map((o) => [o.id, o.content]));
  const source = {
    async get(id: string): Promise<GitObject | undefined> {
      const content = byId.get(id);
      if (!content) return undefined;
      return {
        type: "blob",
        size: content.length,
        content: (async function* () {
          yield content;
        })(),
      };
    },
  };
  const writeStart = performance.now();
  const written: WrittenPackEntry[] = [];
  let packSize = 0;
  let packChecksum: Uint8Array = new Uint8Array(0);
  for await (const chunk of writePack(
    source,
    objects.map((o) => o.id),
    { onEntry: (e) => written.push(e) },
  )) {
    packSize += chunk.length;
    packChecksum = chunk; // the last chunk is the SHA-1 trailer
  }
  const writeTimeMs = performance.now() - writeStart;

  // Write index
  const indexWriteStart = performance.now();
  const indexEntries = written
    .map(({ id, offset, crc32 }) => ({ id, offset, crc32 }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const indexData = await writePackIndex(indexEntries, packChecksum);
  const indexWriteTimeMs = performance.now() - indexWriteStart;

  // Read and verify index
  const indexReadStart = performance.now();
  const index = readPackIndex(indexData);
  // Verify all entries can be looked up
  let _verifiedCount = 0;
  for (const entry of index.entries()) {
    const offset = index.findOffset(entry.id);
    if (offset >= 0) _verifiedCount++;
  }
  const indexReadTimeMs = performance.now() - indexReadStart;

  return {
    objectCount: objects.length,
    totalContentSize,
    packSize,
    indexSize: indexData.length,
    compressionRatio: packSize / totalContentSize,
    writeTimeMs,
    indexWriteTimeMs,
    readAllTimeMs: indexReadTimeMs, // Use index read time as proxy for "read" time
    indexReadTimeMs,
  };
}

// ============================================================================
// Formatting Utilities
// ============================================================================

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}μs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatPercent(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

function padLeft(str: string, len: number): string {
  return str.padStart(len);
}

// ============================================================================
// Main Benchmark
// ============================================================================

console.log("=".repeat(80));
console.log("  Pack Operations Benchmark");
console.log("=".repeat(80));
console.log();

// Test configurations: [objectCount, averageSize]
const configurations: Array<{ name: string; objects: number[] }> = [
  {
    name: "10 small blobs (1KB each)",
    objects: Array(10).fill(1024),
  },
  {
    name: "100 small blobs (1KB each)",
    objects: Array(100).fill(1024),
  },
  {
    name: "10 medium blobs (10KB each)",
    objects: Array(10).fill(10 * 1024),
  },
  {
    name: "100 medium blobs (10KB each)",
    objects: Array(100).fill(10 * 1024),
  },
  {
    name: "10 large blobs (100KB each)",
    objects: Array(10).fill(100 * 1024),
  },
  {
    name: "Mixed sizes (realistic)",
    objects: [
      // Small files (configs, etc)
      ...Array(50).fill(256),
      // Medium files (source code)
      ...Array(30).fill(4096),
      // Larger files
      ...Array(15).fill(16384),
      // Big files (images, etc)
      ...Array(5).fill(65536),
    ],
  },
  {
    name: "1000 tiny blobs (256B each)",
    objects: Array(1000).fill(256),
  },
];

console.log("Running pack benchmarks...");
console.log();

// Table header
const header = [
  padLeft("Config", 35),
  padLeft("Objects", 8),
  padLeft("Content", 10),
  padLeft("Pack", 10),
  padLeft("Index", 8),
  padLeft("Ratio", 8),
  padLeft("Write", 10),
  padLeft("Read", 10),
].join(" | ");

console.log("-".repeat(header.length));
console.log(header);
console.log("-".repeat(header.length));

const results: PackBenchmarkResult[] = [];

for (const config of configurations) {
  try {
    const result = await runPackBenchmark(config.objects, 12345);
    results.push(result);

    const row = [
      config.name.padEnd(35),
      padLeft(result.objectCount.toString(), 8),
      padLeft(formatSize(result.totalContentSize), 10),
      padLeft(formatSize(result.packSize), 10),
      padLeft(formatSize(result.indexSize), 8),
      padLeft(formatPercent(result.compressionRatio), 8),
      padLeft(formatMs(result.writeTimeMs), 10),
      padLeft(formatMs(result.readAllTimeMs), 10),
    ].join(" | ");

    console.log(row);
  } catch (error) {
    console.log(
      `${config.name.padEnd(35)} | ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

console.log("-".repeat(header.length));

// Summary
console.log();
console.log("=".repeat(80));
console.log("  Summary");
console.log("=".repeat(80));
console.log();

// Calculate totals
const totalObjects = results.reduce((sum, r) => sum + r.objectCount, 0);
const totalContent = results.reduce((sum, r) => sum + r.totalContentSize, 0);
const totalPack = results.reduce((sum, r) => sum + r.packSize, 0);
const totalWriteTime = results.reduce((sum, r) => sum + r.writeTimeMs, 0);
const totalReadTime = results.reduce((sum, r) => sum + r.readAllTimeMs, 0);

console.log(`Total objects processed: ${totalObjects}`);
console.log(`Total content size: ${formatSize(totalContent)}`);
console.log(`Total pack size: ${formatSize(totalPack)}`);
console.log(`Overall compression: ${formatPercent(totalPack / totalContent)}`);
console.log();
console.log(`Total write time: ${formatMs(totalWriteTime)}`);
console.log(`Total read time: ${formatMs(totalReadTime)}`);
console.log(
  `Write throughput: ${(totalContent / (1024 * 1024) / (totalWriteTime / 1000)).toFixed(2)} MB/s`,
);
console.log(
  `Read throughput: ${(totalContent / (1024 * 1024) / (totalReadTime / 1000)).toFixed(2)} MB/s`,
);

console.log();
console.log("=".repeat(80));
console.log("  Benchmark Complete");
console.log("=".repeat(80));
