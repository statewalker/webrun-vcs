import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  applyDelta,
  createDelta,
  decodeDeltaBlocks,
  encodeDeltaBlocks,
  mergeChunks,
} from "../src/index.js";

// Dynamically import the reference Fossil delta implementation
const fossilDeltaPath = resolve(__dirname, "../../../tmp/fossil-delta-js/fossil-delta.js");
const fossilDelta = (await import(fossilDeltaPath)) as {
  createDelta: (source: Uint8Array, target: Uint8Array) => Uint8Array;
  applyDelta: (source: Uint8Array, delta: Uint8Array) => Uint8Array;
};

describe("Performance Comparison: Our Implementation vs Fossil Reference", () => {
  const MB = 1024 * 1024;

  // Helper to format time
  function formatTime(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(2)}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  // Helper to format bytes
  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < MB) return `${(bytes / 1024).toFixed(2)}KB`;
    return `${(bytes / MB).toFixed(2)}MB`;
  }

  test("Performance: 1MB identical blocks", { timeout: 60000 }, () => {
    const SIZE = 1 * MB;

    // Create identical 1MB blocks
    const source = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) {
      source[i] = i % 256;
    }
    const target = new Uint8Array(source);

    console.log("\n=== 1MB Identical Blocks ===");
    console.log(`Source size: ${formatBytes(SIZE)}`);
    console.log(`Target size: ${formatBytes(SIZE)}`);

    // Our implementation
    const ourStart = performance.now();
    const ourDeltas = Array.from(createDelta(source, target));
    const ourDeltaBlob = mergeChunks(encodeDeltaBlocks(ourDeltas[Symbol.iterator]()));
    const ourCreateTime = performance.now() - ourStart;

    const ourApplyStart = performance.now();
    const ourDecodedDeltas = decodeDeltaBlocks(ourDeltaBlob);
    const ourResult = mergeChunks(applyDelta(source, ourDecodedDeltas));
    const ourApplyTime = performance.now() - ourApplyStart;

    // Fossil reference
    const fossilStart = performance.now();
    const fossilDeltaBlob = fossilDelta.createDelta(source, target);
    const fossilCreateTime = performance.now() - fossilStart;

    const fossilApplyStart = performance.now();
    const fossilResult = fossilDelta.applyDelta(source, fossilDeltaBlob);
    const fossilApplyTime = performance.now() - fossilApplyStart;

    console.log("\nCreate Delta:");
    console.log(`  Our impl:      ${formatTime(ourCreateTime)}`);
    console.log(`  Fossil ref:    ${formatTime(fossilCreateTime)}`);
    console.log(`  Ratio:         ${(ourCreateTime / fossilCreateTime).toFixed(2)}x`);

    console.log("\nApply Delta:");
    console.log(`  Our impl:      ${formatTime(ourApplyTime)}`);
    console.log(`  Fossil ref:    ${formatTime(fossilApplyTime)}`);
    console.log(`  Ratio:         ${(ourApplyTime / fossilApplyTime).toFixed(2)}x`);

    console.log("\nDelta Size:");
    console.log(`  Our impl:      ${formatBytes(ourDeltaBlob.length)}`);
    console.log(`  Fossil ref:    ${formatBytes(fossilDeltaBlob.length)}`);
    console.log(`  Ratio:         ${(ourDeltaBlob.length / fossilDeltaBlob.length).toFixed(2)}x`);

    // Verify correctness
    expect(ourResult).toEqual(target);
    expect(new Uint8Array(fossilResult)).toEqual(target);
  });

  test("Performance: 3MB with 1% changes", { timeout: 120000 }, () => {
    const SIZE = 3 * MB;

    // Create 3MB source
    const source = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) {
      source[i] = i % 256;
    }

    // Create target with 1% changes (~30KB modified)
    const target = new Uint8Array(source);
    const numChanges = Math.floor(SIZE * 0.01);
    for (let i = 0; i < numChanges; i++) {
      const pos = Math.floor((i * SIZE) / numChanges);
      target[pos] = (target[pos] + 1) % 256;
    }

    console.log("\n=== 3MB with 1% Changes ===");
    console.log(`Source size: ${formatBytes(SIZE)}`);
    console.log(`Target size: ${formatBytes(SIZE)}`);
    console.log(`Changed:     ${formatBytes(numChanges)} (1%)`);

    // Our implementation
    const ourStart = performance.now();
    const ourDeltas = Array.from(createDelta(source, target));
    const ourDeltaBlob = mergeChunks(encodeDeltaBlocks(ourDeltas[Symbol.iterator]()));
    const ourCreateTime = performance.now() - ourStart;

    const ourApplyStart = performance.now();
    const ourDecodedDeltas = decodeDeltaBlocks(ourDeltaBlob);
    const ourResult = mergeChunks(applyDelta(source, ourDecodedDeltas));
    const ourApplyTime = performance.now() - ourApplyStart;

    // Fossil reference
    const fossilStart = performance.now();
    const fossilDeltaBlob = fossilDelta.createDelta(source, target);
    const fossilCreateTime = performance.now() - fossilStart;

    const fossilApplyStart = performance.now();
    const fossilResult = fossilDelta.applyDelta(source, fossilDeltaBlob);
    const fossilApplyTime = performance.now() - fossilApplyStart;

    console.log("\nCreate Delta:");
    console.log(`  Our impl:      ${formatTime(ourCreateTime)}`);
    console.log(`  Fossil ref:    ${formatTime(fossilCreateTime)}`);
    console.log(`  Ratio:         ${(ourCreateTime / fossilCreateTime).toFixed(2)}x`);

    console.log("\nApply Delta:");
    console.log(`  Our impl:      ${formatTime(ourApplyTime)}`);
    console.log(`  Fossil ref:    ${formatTime(fossilApplyTime)}`);
    console.log(`  Ratio:         ${(ourApplyTime / fossilApplyTime).toFixed(2)}x`);

    console.log("\nDelta Size:");
    console.log(`  Our impl:      ${formatBytes(ourDeltaBlob.length)}`);
    console.log(`  Fossil ref:    ${formatBytes(fossilDeltaBlob.length)}`);
    console.log(`  Ratio:         ${(ourDeltaBlob.length / fossilDeltaBlob.length).toFixed(2)}x`);

    console.log("\nTotal Time:");
    console.log(`  Our impl:      ${formatTime(ourCreateTime + ourApplyTime)}`);
    console.log(`  Fossil ref:    ${formatTime(fossilCreateTime + fossilApplyTime)}`);

    // Verify correctness
    expect(ourResult).toEqual(target);
    expect(new Uint8Array(fossilResult)).toEqual(target);
  });

  test("Performance: 5MB completely different", { timeout: 120000 }, () => {
    const SIZE = 5 * MB;

    // Create source with one pattern
    const source = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) {
      source[i] = i % 256;
    }

    // Create target with completely different pattern
    const target = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i++) {
      target[i] = (255 - (i % 256)) % 256;
    }

    console.log("\n=== 5MB Completely Different ===");
    console.log(`Source size: ${formatBytes(SIZE)}`);
    console.log(`Target size: ${formatBytes(SIZE)}`);

    // Our implementation
    const ourStart = performance.now();
    const ourDeltas = Array.from(createDelta(source, target));
    const ourDeltaBlob = mergeChunks(encodeDeltaBlocks(ourDeltas[Symbol.iterator]()));
    const ourCreateTime = performance.now() - ourStart;

    const ourApplyStart = performance.now();
    const ourDecodedDeltas = decodeDeltaBlocks(ourDeltaBlob);
    const ourResult = mergeChunks(applyDelta(source, ourDecodedDeltas));
    const ourApplyTime = performance.now() - ourApplyStart;

    // Fossil reference
    const fossilStart = performance.now();
    const fossilDeltaBlob = fossilDelta.createDelta(source, target);
    const fossilCreateTime = performance.now() - fossilStart;

    const fossilApplyStart = performance.now();
    const fossilResult = fossilDelta.applyDelta(source, fossilDeltaBlob);
    const fossilApplyTime = performance.now() - fossilApplyStart;

    console.log("\nCreate Delta:");
    console.log(`  Our impl:      ${formatTime(ourCreateTime)}`);
    console.log(`  Fossil ref:    ${formatTime(fossilCreateTime)}`);
    console.log(`  Ratio:         ${(ourCreateTime / fossilCreateTime).toFixed(2)}x`);

    console.log("\nApply Delta:");
    console.log(`  Our impl:      ${formatTime(ourApplyTime)}`);
    console.log(`  Fossil ref:    ${formatTime(fossilApplyTime)}`);
    console.log(`  Ratio:         ${(ourApplyTime / fossilApplyTime).toFixed(2)}x`);

    console.log("\nDelta Size:");
    console.log(`  Our impl:      ${formatBytes(ourDeltaBlob.length)}`);
    console.log(`  Fossil ref:    ${formatBytes(fossilDeltaBlob.length)}`);

    // Verify correctness
    expect(ourResult).toEqual(target);
    expect(new Uint8Array(fossilResult)).toEqual(target);
  });
});
