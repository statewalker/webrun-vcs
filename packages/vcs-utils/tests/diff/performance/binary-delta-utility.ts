import {
  decodeGitBinaryDelta,
  encodeGitBinaryDelta,
} from "../../../src/diff/patch/binary-delta.js";
import { BinaryComparator } from "../../../src/diff/text-diff/binary-comparator.js";
import { BinarySequence } from "../../../src/diff/text-diff/binary-sequence.js";
import { Edit } from "../../../src/diff/text-diff/edit.js";
import { MyersDiff } from "../../../src/diff/text-diff/myers-diff.js";

/**
 * Performance statistics for binary delta encoding/decoding
 */
export interface BinaryDeltaPerformanceStats {
  sourceSize: number;
  targetSize: number;
  mutationDegree: number;
  actualMutationDegree: number;
  // Timing
  diffTimeMs: number;
  encodeTimeMs: number;
  decodeTimeMs: number;
  totalTimeMs: number;
  // Sizes
  deltaSize: number;
  compressionRatio: number; // deltaSize / targetSize
  editCount: number;
}

/**
 * Options for binary delta performance testing
 */
export interface BinaryDeltaTestOptions {
  sourceSize: number;
  targetSize: number;
  mutationDegree: number; // 0.0 to 1.0
  blockSize?: number;
  seed?: number;
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

  if (mutationDegree === 0) {
    // No mutations: copy source
    for (let i = 0; i < targetSize; i++) {
      target[i] = source[i % source.length];
    }
  } else if (mutationDegree >= 1) {
    // Complete mutation: generate new data
    for (let i = 0; i < targetSize; i++) {
      target[i] = random.nextByte();
    }
  } else {
    // Partial mutation: mix copied and mutated blocks
    let sourcePos = 0;
    let targetPos = 0;

    while (targetPos < targetSize) {
      const shouldMutate = random.next() < mutationDegree;

      if (shouldMutate) {
        const mutationLen = Math.min(Math.max(1, random.nextInt(32)), targetSize - targetPos);
        for (let i = 0; i < mutationLen; i++) {
          target[targetPos++] = random.nextByte();
        }
      } else {
        const copyLen = Math.min(Math.max(1, random.nextInt(64)), targetSize - targetPos);

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
 * Test binary delta encode/decode performance
 */
export function testBinaryDeltaPerformance(
  options: BinaryDeltaTestOptions,
): BinaryDeltaPerformanceStats {
  const { sourceSize, targetSize, mutationDegree, blockSize = 16, seed = 42 } = options;

  const random = new SeededRandom(seed);

  // Generate test data
  const source = generateRandomBytes(sourceSize, random);
  const target = generateMutatedTarget(source, targetSize, mutationDegree, random);

  // Create binary sequences for Myers diff
  const seqA = new BinarySequence(source, blockSize);
  const seqB = new BinarySequence(target, blockSize);
  const comparator = new BinaryComparator();

  // Measure diff time
  const diffStart = performance.now();
  const blockEdits = MyersDiff.diff(comparator, seqA, seqB);
  const diffEnd = performance.now();

  // Convert block-based edits to byte-based edits
  // BinarySequence uses block indices, but encodeGitBinaryDelta expects byte indices
  const byteEdits = blockEdits.map((edit) => {
    const beginA = edit.beginA * blockSize;
    const endA = Math.min(edit.endA * blockSize, source.length);
    const beginB = edit.beginB * blockSize;
    const endB = Math.min(edit.endB * blockSize, target.length);
    return new Edit(beginA, endA, beginB, endB);
  });

  // Measure encode time
  const encodeStart = performance.now();
  const delta = encodeGitBinaryDelta(source, target, byteEdits);
  const encodeEnd = performance.now();

  // Measure decode time
  const decodeStart = performance.now();
  const reconstructed = decodeGitBinaryDelta(source, delta);
  const decodeEnd = performance.now();

  // Verify correctness
  if (reconstructed.length !== target.length) {
    throw new Error(`Size mismatch: expected ${target.length}, got ${reconstructed.length}`);
  }
  for (let i = 0; i < target.length; i++) {
    if (reconstructed[i] !== target[i]) {
      throw new Error(`Mismatch at position ${i}: expected ${target[i]}, got ${reconstructed[i]}`);
    }
  }

  const actualMutationDegree = calculateMutationDegree(source, target);
  const diffTimeMs = diffEnd - diffStart;
  const encodeTimeMs = encodeEnd - encodeStart;
  const decodeTimeMs = decodeEnd - decodeStart;

  return {
    sourceSize,
    targetSize,
    mutationDegree,
    actualMutationDegree,
    diffTimeMs,
    encodeTimeMs,
    decodeTimeMs,
    totalTimeMs: diffTimeMs + encodeTimeMs + decodeTimeMs,
    deltaSize: delta.length,
    compressionRatio: delta.length / targetSize,
    editCount: blockEdits.length,
  };
}
