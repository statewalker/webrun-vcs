/**
 * Test data generators for creating valid Git objects
 */

import type { Delta } from "@statewalker/vcs-utils";
import type { ObjectId, PersonIdent } from "../../src/common/id/index.js";
import type { Commit } from "../../src/history/commits/commits.js";
import type { TreeEntry } from "../../src/history/trees/tree-entry.js";

/**
 * Seeded random number generator for reproducible tests
 *
 * Uses a simple LCG (Linear Congruential Generator) for fast, reproducible random numbers.
 */
export class TestRng {
  private seed: number;

  constructor(seed = 12345) {
    this.seed = seed;
  }

  /**
   * Generate next random number in [0, 1)
   */
  next(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  /**
   * Generate random integer in [min, max]
   */
  nextInt(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /**
   * Reset to initial seed
   */
  reset(seed?: number): void {
    this.seed = seed ?? 12345;
  }
}

/**
 * Generate random bytes with optional seed for reproducibility
 */
export function randomBytes(size: number, seed?: number): Uint8Array {
  const rng = new TestRng(seed);
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = rng.nextInt(0, 255);
  }
  return bytes;
}

/**
 * Generate a random hex string of specified length
 */
export function randomHex(length: number, seed?: number): string {
  const rng = new TestRng(seed);
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[rng.nextInt(0, 15)];
  }
  return result;
}

/**
 * Generate a random ObjectId (40 hex characters for SHA-1)
 */
export function randomObjectId(seed?: number): ObjectId {
  return randomHex(40, seed);
}

/**
 * Generate a PersonIdent for testing
 */
export function createTestPerson(
  name = "Test User",
  email = "test@example.com",
  timestamp?: number,
  tzOffset = "+0000",
): PersonIdent {
  return {
    name,
    email,
    timestamp: timestamp ?? Math.floor(Date.now() / 1000),
    tzOffset,
  };
}

/**
 * Generate a test commit object
 */
export function createTestCommit(overrides: Partial<Commit> = {}): Commit {
  const now = Math.floor(Date.now() / 1000);
  return {
    tree: randomObjectId(1),
    parents: [],
    author: createTestPerson("Test Author", "author@test.com", now),
    committer: createTestPerson("Test Committer", "committer@test.com", now),
    message: "Test commit message",
    ...overrides,
  };
}

/**
 * Generate random tree entries
 */
export function randomTreeEntries(count: number, seed?: number): TreeEntry[] {
  const rng = new TestRng(seed);
  const entries: TreeEntry[] = [];

  for (let i = 0; i < count; i++) {
    const isDirectory = rng.next() > 0.7;
    entries.push({
      mode: isDirectory ? "40000" : "100644",
      name: `entry-${i.toString().padStart(4, "0")}${isDirectory ? "" : ".txt"}`,
      id: randomObjectId(seed ? seed + i : undefined),
    });
  }

  // Sort entries by name (Git's canonical order)
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Create test delta instructions
 */
export function createTestDelta(
  targetSize: number,
  copyRanges: Array<{ start: number; len: number }> = [],
  insertData: Uint8Array[] = [],
): Delta[] {
  // Compute sourceLen from copy ranges (same logic as serializeDeltaToGit fallback)
  let sourceLen = 0;
  for (const range of copyRanges) {
    sourceLen = Math.max(sourceLen, range.start + range.len);
  }
  const deltas: Delta[] = [{ type: "start", sourceLen, targetLen: targetSize }];

  for (const range of copyRanges) {
    deltas.push({ type: "copy", start: range.start, len: range.len });
  }

  for (const data of insertData) {
    deltas.push({ type: "insert", data });
  }

  deltas.push({ type: "finish", checksum: 0 });
  return deltas;
}

/**
 * Create text content as Uint8Array
 */
export function textToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Convert Uint8Array to text
 */
export function bytesToText(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Create a simple blob content with the given text
 */
export function createBlobContent(text: string): Uint8Array {
  return textToBytes(text);
}

/**
 * Generate test content of specified size with recognizable pattern
 */
export function generatePatternContent(size: number, pattern = "test"): Uint8Array {
  const patternBytes = textToBytes(pattern);
  const result = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    result[i] = patternBytes[i % patternBytes.length];
  }
  return result;
}

/**
 * Create similar content for delta testing
 *
 * Returns two byte arrays where the second is a modification of the first
 */
export function createSimilarContent(
  baseSize: number,
  changePercentage = 0.1,
  seed?: number,
): { base: Uint8Array; modified: Uint8Array } {
  const rng = new TestRng(seed);
  const base = randomBytes(baseSize, seed);
  const modified = new Uint8Array(base);

  const numChanges = Math.floor(baseSize * changePercentage);
  for (let i = 0; i < numChanges; i++) {
    const pos = rng.nextInt(0, baseSize - 1);
    modified[pos] = rng.nextInt(0, 255);
  }

  return { base, modified };
}
