import { createDeltaRanges, type DeltaRange } from "../../../src/diff/index.js";

/**
 * Performance statistics for delta generation and application
 */
export interface PerformanceStats {
  sourceSize: number;
  targetSize: number;
  rangeGenerationTimeMs: number;
  rangeApplicationTimeMs: number;
  actualMutationDegree: number;
  mutationDegree: number;
  rangeCount: number;
  rangesSize: number;
}

/**
 * Options for generating mutated target data
 */
export interface MutationOptions {
  sourceSize: number;
  targetSize: number;
  mutationDegree: number; // 0.0 to 1.0
  blockSize?: number;
  minMatch?: number;
  seed?: number; // For reproducible random generation
}

/**
 * Simple seeded random number generator (LCG)
 */
class SeededRandom {
  private seed: number;

  constructor(seed: number) {
    this.seed = seed;
  }

  next(): number {
    this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
    return this.seed / 0x7fffffff;
  }

  nextInt(max: number): number {
    return Math.floor(this.next() * max);
  }

  nextByte(): number {
    return this.nextInt(256);
  }
}

/**
 * Generate random bytes
 */
function generateRandomBytes(size: number, random: SeededRandom): Uint8Array {
  const buffer = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    buffer[i] = random.nextByte();
  }
  return buffer;
}

/**
 * Calculate the actual mutation degree between source and target
 */
function calculateMutationDegree(source: Uint8Array, target: Uint8Array): number {
  const minLen = Math.min(source.length, target.length);
  if (minLen === 0) {
    return source.length === target.length ? 0 : 1;
  }

  let differences = 0;
  for (let i = 0; i < minLen; i++) {
    if (source[i] !== target[i]) {
      differences++;
    }
  }

  // Add size difference as mutations
  const sizeDiff = Math.abs(source.length - target.length);
  differences += sizeDiff;

  const maxLen = Math.max(source.length, target.length);
  return differences / maxLen;
}

/**
 * Generate target data with controlled mutations from source
 */
function generateMutatedTarget(
  source: Uint8Array,
  targetSize: number,
  mutationDegree: number,
  random: SeededRandom,
): Uint8Array {
  if (targetSize === 0) {
    return new Uint8Array(0);
  }

  const target = new Uint8Array(targetSize);

  // Strategy: copy blocks from source and apply mutations
  if (mutationDegree === 0) {
    // No mutations: copy source, repeat or truncate as needed
    for (let i = 0; i < targetSize; i++) {
      target[i] = source[i % source.length];
    }
  } else if (mutationDegree >= 1) {
    // Complete mutation: generate completely new data
    for (let i = 0; i < targetSize; i++) {
      target[i] = random.nextByte();
    }
  } else {
    // Partial mutation: mix of copied and mutated blocks
    let sourcePos = 0;
    let targetPos = 0;

    while (targetPos < targetSize) {
      const shouldMutate = random.next() < mutationDegree;

      if (shouldMutate) {
        // Insert mutated block (random bytes)
        const mutationLen = Math.min(Math.max(1, random.nextInt(32)), targetSize - targetPos);
        for (let i = 0; i < mutationLen; i++) {
          target[targetPos++] = random.nextByte();
        }
      } else {
        // Copy block from source (possibly from different position)
        const copyLen = Math.min(Math.max(1, random.nextInt(64)), targetSize - targetPos);

        // Sometimes copy from random position (block movement)
        if (random.next() < 0.3 && source.length > 0) {
          sourcePos = random.nextInt(source.length);
        }

        for (let i = 0; i < copyLen; i++) {
          target[targetPos++] = source[sourcePos % source.length];
          sourcePos++;
        }
      }
    }
  }

  return target;
}

/**
 * Apply ranges to reconstruct target from source
 */
function applyRanges(source: Uint8Array, target: Uint8Array, ranges: DeltaRange[]): Uint8Array {
  const result: number[] = [];
  for (const range of ranges) {
    if (range.from === "source") {
      for (let i = 0; i < range.len; i++) {
        result.push(source[range.start + i]);
      }
    } else {
      for (let i = 0; i < range.len; i++) {
        result.push(target[range.start + i]);
      }
    }
  }
  return new Uint8Array(result);
}

/**
 * Test utility for createDeltaRanges
 *
 * Generates random source and mutated target, creates delta ranges,
 * applies them to verify correctness, and returns performance statistics.
 */
export function testCreateDeltaRanges(options: MutationOptions): PerformanceStats {
  const {
    sourceSize,
    targetSize,
    mutationDegree,
    blockSize = 16,
    minMatch = 16,
    seed = 42,
  } = options;

  const random = new SeededRandom(seed);

  // Generate random source
  const source = generateRandomBytes(sourceSize, random);

  // Generate mutated target
  const target = generateMutatedTarget(source, targetSize, mutationDegree, random);

  // Measure range generation time
  const genStart = performance.now();
  const ranges = Array.from(createDeltaRanges(source, target, blockSize, minMatch));
  const genEnd = performance.now();

  // Measure range application time
  const applyStart = performance.now();
  const reconstructed = applyRanges(source, target, ranges);
  const applyEnd = performance.now();

  // Verify correctness
  let verificationError: string | null = null;
  if (reconstructed.length !== target.length) {
    verificationError = `Size mismatch: expected ${target.length}, got ${reconstructed.length}`;
  } else {
    for (let i = 0; i < target.length; i++) {
      if (reconstructed[i] !== target[i]) {
        verificationError = `Mismatch at position ${i}: expected ${target[i]}, got ${reconstructed[i]}`;
        break;
      }
    }
  }

  if (verificationError) {
    throw new Error(verificationError);
  }

  // Calculate actual mutation degree
  const actualMutationDegree = calculateMutationDegree(source, target);

  // Calculate compression ratio
  const rangesSize = ranges.reduce((sum, r) => {
    // Approximate: each range has overhead (type, start, len)
    // source ranges: 1 byte type + 4 bytes start + 4 bytes len = 9 bytes
    // target ranges: 1 byte type + 4 bytes start + 4 bytes len + data = 9 + len bytes
    return sum + 9 + (r.from === "source" ? 0 : r.len);
  }, 0);

  return {
    sourceSize,
    targetSize,
    rangeGenerationTimeMs: genEnd - genStart,
    rangeApplicationTimeMs: applyEnd - applyStart,
    actualMutationDegree,
    mutationDegree,
    rangeCount: ranges.length,
    rangesSize,
  };
}
