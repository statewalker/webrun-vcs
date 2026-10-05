/**
 * Streaming Git delta application tests
 *
 * Tests applyGitDeltaStreaming against the block-based applyGitDelta
 * to ensure equivalence.
 */

import { describe, expect, it } from "vitest";
import type { RandomAccessStream } from "../../../src/diff/delta/types.js";
import {
  applyGitDelta,
  applyGitDeltaStreaming,
  createDeltaRanges,
  deltaRangesToGitFormat,
} from "../../../src/diff/index.js";

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

/** Create a RandomAccessStream from a Uint8Array */
function toRandomAccessStream(data: Uint8Array): RandomAccessStream {
  return (start = 0) =>
    (async function* () {
      yield data.subarray(start);
    })();
}

/** Create a RandomAccessStream that yields in small chunks */
function toChunkedRandomAccessStream(data: Uint8Array, chunkSize: number): RandomAccessStream {
  return (start = 0) =>
    (async function* () {
      for (let i = start; i < data.length; i += chunkSize) {
        yield data.subarray(i, Math.min(i + chunkSize, data.length));
      }
    })();
}

function createDelta(base: Uint8Array, target: Uint8Array): Uint8Array {
  const ranges = createDeltaRanges(base, target);
  return deltaRangesToGitFormat(base, target, ranges);
}

describe("applyGitDeltaStreaming", () => {
  it("matches block-based applyGitDelta for simple delta", async () => {
    const base = new TextEncoder().encode("Hello, World!");
    const target = new TextEncoder().encode("Hello, Universe!");
    const delta = createDelta(base, target);

    const blockResult = applyGitDelta(base, delta);
    const streamResult = await collect(
      applyGitDeltaStreaming(toRandomAccessStream(base), toRandomAccessStream(delta)),
    );

    expect(streamResult).toEqual(blockResult);
    expect(streamResult).toEqual(target);
  });

  it("handles pure-insert delta", async () => {
    // Empty base, everything is insert
    const base = new Uint8Array(0);
    const target = new TextEncoder().encode("All new content");
    const delta = createDelta(base, target);

    const blockResult = applyGitDelta(base, delta);
    const streamResult = await collect(
      applyGitDeltaStreaming(toRandomAccessStream(base), toRandomAccessStream(delta)),
    );

    expect(streamResult).toEqual(blockResult);
  });

  it("handles pure-copy delta (identical base and target)", async () => {
    const base = new TextEncoder().encode("Identical content that should be copied verbatim.");
    const target = new Uint8Array(base);
    const delta = createDelta(base, target);

    const blockResult = applyGitDelta(base, delta);
    const streamResult = await collect(
      applyGitDeltaStreaming(toRandomAccessStream(base), toRandomAccessStream(delta)),
    );

    expect(streamResult).toEqual(blockResult);
  });

  it("handles large data with many copy/insert operations", async () => {
    // Create base with repeated pattern
    const encoder = new TextEncoder();
    const baseText = "Line N: This is a repeated line of text for testing.\n".replace("N", "0");
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(baseText.replace("0", String(i)));
    }
    const base = encoder.encode(lines.join(""));

    // Modify some lines
    lines[10] = "Line 10: MODIFIED LINE\n";
    lines[50] = "Line 50: ANOTHER MODIFICATION\n";
    lines[99] = "Line 99: FINAL CHANGE\n";
    const target = encoder.encode(lines.join(""));

    const delta = createDelta(base, target);
    const blockResult = applyGitDelta(base, delta);
    const streamResult = await collect(
      applyGitDeltaStreaming(toRandomAccessStream(base), toRandomAccessStream(delta)),
    );

    expect(streamResult).toEqual(blockResult);
  });

  it("works with chunked source stream", async () => {
    const base = new TextEncoder().encode("Hello, World! This is some base content.");
    const target = new TextEncoder().encode("Hello, Universe! This is some modified content.");
    const delta = createDelta(base, target);

    const streamResult = await collect(
      applyGitDeltaStreaming(toChunkedRandomAccessStream(base, 5), toRandomAccessStream(delta)),
    );

    expect(streamResult).toEqual(target);
  });

  it("works with chunked delta stream", async () => {
    const base = new TextEncoder().encode("Base text for delta chunking test.");
    const target = new TextEncoder().encode("Modified text for delta chunking test.");
    const delta = createDelta(base, target);

    const streamResult = await collect(
      applyGitDeltaStreaming(toRandomAccessStream(base), toChunkedRandomAccessStream(delta, 3)),
    );

    expect(streamResult).toEqual(target);
  });

  it("works with both streams chunked", async () => {
    const base = new TextEncoder().encode("AAABBBCCC");
    const target = new TextEncoder().encode("AAADDDEEE");
    const delta = createDelta(base, target);

    const streamResult = await collect(
      applyGitDeltaStreaming(
        toChunkedRandomAccessStream(base, 2),
        toChunkedRandomAccessStream(delta, 2),
      ),
    );

    expect(streamResult).toEqual(target);
  });

  it("handles binary data", async () => {
    const base = new Uint8Array(256);
    for (let i = 0; i < 256; i++) base[i] = i;

    const target = new Uint8Array(256);
    for (let i = 0; i < 256; i++) target[i] = (i + 128) & 0xff;

    const delta = createDelta(base, target);
    const blockResult = applyGitDelta(base, delta);
    const streamResult = await collect(
      applyGitDeltaStreaming(toRandomAccessStream(base), toRandomAccessStream(delta)),
    );

    expect(streamResult).toEqual(blockResult);
  });
});
