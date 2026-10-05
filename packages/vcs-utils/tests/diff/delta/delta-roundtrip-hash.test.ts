/**
 * Delta roundtrip tests with hash verification
 *
 * Validates the full delta pipeline:
 * 1. Serialization roundtrip: Delta[] ↔ Git binary format ↔ Delta[]
 * 2. Serialization roundtrip: Delta[] ↔ Fossil binary format ↔ Delta[]
 * 3. Cross-format roundtrip: Git ↔ Fossil format interchangeability
 * 4. Object ID (SHA-1) hash verification after delta application
 * 5. Streaming vs block application equivalence with hash verification
 */

import { describe, expect, it } from "vitest";
import type { RandomAccessStream } from "../../../src/diff/delta/types.js";
import {
  applyDelta,
  applyGitDelta,
  applyGitDeltaStreaming,
  createDelta,
  createDeltaRanges,
  createFossilLikeRanges,
  decodeDeltaBlocks,
  deltaRangesToGitFormat,
  deltaToGitFormat,
  deserializeDeltaFromFossil,
  deserializeDeltaFromGit,
  encodeDeltaBlocks,
  mergeChunks,
  serializeDeltaToFossil,
  serializeDeltaToGit,
} from "../../../src/diff/index.js";
import { computeObjectId } from "../../../src/pack/object-id.js";

// ─── Helpers ───────────────────────────────────────────────────

function randomBytes(length: number, seed = 42): Uint8Array {
  const result = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    result[i] = state & 0xff;
  }
  return result;
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function collectAsync(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

function toRandomAccessStream(data: Uint8Array): RandomAccessStream {
  return (start = 0) =>
    (async function* () {
      yield data.subarray(start);
    })();
}

// ─── Test Data ─────────────────────────────────────────────────

interface TestCase {
  name: string;
  base: Uint8Array;
  target: Uint8Array;
}

const testCases: TestCase[] = [
  {
    name: "simple text modification",
    base: encode("Hello, World! This is a test file."),
    target: encode("Hello, Universe! This is a modified file."),
  },
  {
    name: "identical content",
    base: encode("Identical content that should result in copy-only delta"),
    target: encode("Identical content that should result in copy-only delta"),
  },
  {
    name: "empty base with new content",
    base: new Uint8Array(0),
    target: encode("Completely new content from scratch"),
  },
  {
    name: "content to empty",
    base: encode("This content will be deleted"),
    target: new Uint8Array(0),
  },
  {
    name: "binary data with partial overlap",
    base: (() => {
      const b = new Uint8Array(500);
      b.set(randomBytes(500, 100));
      return b;
    })(),
    target: (() => {
      const t = new Uint8Array(600);
      t.set(randomBytes(200, 100), 0); // Same start as base
      t.set(randomBytes(200, 777), 200); // New data
      t.set(randomBytes(200, 100).subarray(0, 200), 400); // Repeated
      return t;
    })(),
  },
  {
    name: "large text with insertions",
    base: encode(Array.from({ length: 50 }, (_, i) => `Line ${i}: original content\n`).join("")),
    target: encode(
      Array.from({ length: 50 }, (_, i) =>
        i === 10 || i === 25 || i === 40
          ? `Line ${i}: MODIFIED content\n`
          : `Line ${i}: original content\n`,
      ).join(""),
    ),
  },
  {
    name: "1KB random data",
    base: randomBytes(1024, 42),
    target: randomBytes(1024, 99),
  },
];

// ─── Tests ─────────────────────────────────────────────────────

describe("Delta serialization roundtrip", () => {
  describe("Git format: Delta[] → serializeDeltaToGit → deserializeDeltaFromGit → apply", () => {
    for (const tc of testCases) {
      it(tc.name, () => {
        const ranges = [...createDeltaRanges(tc.base, tc.target)];
        const deltas = [...createDelta(tc.base, tc.target, ranges)];

        // Serialize to Git binary format
        const gitBinary = serializeDeltaToGit(deltas);

        // Deserialize back to Delta[]
        const restored = deserializeDeltaFromGit(gitBinary);

        // Apply the deserialized deltas using the Git binary application path
        const reconstructed = applyGitDelta(tc.base, gitBinary);
        expect(reconstructed).toEqual(tc.target);

        // Verify the deserialized deltas have correct structure
        expect(restored[0].type).toBe("start");
        if (restored[0].type === "start") {
          expect(restored[0].targetLen).toBe(tc.target.length);
        }
        expect(restored[restored.length - 1].type).toBe("finish");
      });
    }
  });

  describe("Fossil format: Delta[] → serializeDeltaToFossil → deserializeDeltaFromFossil → apply", () => {
    for (const tc of testCases) {
      it(tc.name, () => {
        const ranges = [...createDeltaRanges(tc.base, tc.target)];
        const deltas = [...createDelta(tc.base, tc.target, ranges)];

        // Serialize to Fossil format
        const fossilBinary = serializeDeltaToFossil(deltas);

        // Deserialize back to Delta[]
        const restored = deserializeDeltaFromFossil(fossilBinary);

        // Apply the restored deltas
        const reconstructed = mergeChunks(applyDelta(tc.base, restored));
        expect(reconstructed).toEqual(tc.target);
      });
    }
  });

  describe("Fossil encode/decode blocks roundtrip", () => {
    for (const tc of testCases) {
      it(tc.name, () => {
        const ranges = [...createDeltaRanges(tc.base, tc.target)];
        const deltas = [...createDelta(tc.base, tc.target, ranges)];

        // Encode to blocks
        const encoded = mergeChunks(encodeDeltaBlocks(deltas));

        // Decode from blocks
        const decoded = [...decodeDeltaBlocks(encoded)];

        // Apply decoded deltas
        const reconstructed = mergeChunks(applyDelta(tc.base, decoded));
        expect(reconstructed).toEqual(tc.target);
      });
    }
  });
});

describe("Cross-format roundtrip", () => {
  describe("Git → Fossil → Git: content preserved through format conversion", () => {
    // Note: Git format has no Fossil checksum, so we cannot apply via Fossil's
    // applyDelta (which validates checksum). Instead we convert Git → Delta[] →
    // Fossil → Delta[] → Git and apply with applyGitDelta.
    for (const tc of testCases) {
      it(tc.name, () => {
        // Create Git binary delta
        const ranges = createDeltaRanges(tc.base, tc.target);
        const gitBinary = deltaRangesToGitFormat(tc.base, tc.target, ranges);

        // Convert Git → Delta[]
        const deltas = deserializeDeltaFromGit(gitBinary);

        // Serialize as Fossil
        const fossilBinary = serializeDeltaToFossil(deltas);

        // Deserialize Fossil → Delta[]
        const restored = deserializeDeltaFromFossil(fossilBinary);

        // Convert back to Git format (using known base size)
        const gitBinary2 = deltaToGitFormat(tc.base.length, restored);

        // Apply using Git path
        const reconstructed = applyGitDelta(tc.base, gitBinary2);
        expect(reconstructed).toEqual(tc.target);
      });
    }
  });

  describe("Fossil → Git: create as Delta[], serialize as Fossil, restore, serialize as Git, apply", () => {
    // Note: Fossil format doesn't encode sourceLen. The Git serializer falls
    // back to computing baseSize from copy instruction extents, which may be
    // smaller than the actual base. We use deltaToGitFormat with explicit
    // baseSize to avoid the fallback.
    for (const tc of testCases) {
      it(tc.name, () => {
        // Create Delta[]
        const ranges = [...createDeltaRanges(tc.base, tc.target)];
        const deltas = [...createDelta(tc.base, tc.target, ranges)];

        // Serialize as Fossil
        const fossilBinary = serializeDeltaToFossil(deltas);

        // Deserialize from Fossil
        const restored = deserializeDeltaFromFossil(fossilBinary);

        // Serialize as Git (with explicit baseSize since Fossil doesn't preserve it)
        const gitBinary = deltaToGitFormat(tc.base.length, restored);

        // Apply using Git path
        const reconstructed = applyGitDelta(tc.base, gitBinary);
        expect(reconstructed).toEqual(tc.target);
      });
    }
  });
});

describe("Object ID (SHA-1) hash verification after delta application", () => {
  describe("delta-reconstructed content has same hash as original content", () => {
    const hashTestCases: TestCase[] = [
      {
        name: "blob: simple text",
        base: encode("Hello, World!"),
        target: encode("Hello, Universe!"),
      },
      {
        name: "blob: source code",
        base: encode('function hello() {\n  return "world";\n}\n'),
        target: encode(
          'function hello() {\n  return "universe";\n}\n\nfunction goodbye() {\n  return "world";\n}\n',
        ),
      },
      {
        name: "blob: 10KB with scattered changes",
        base: randomBytes(10000, 1),
        target: (() => {
          const t = new Uint8Array(randomBytes(10000, 1));
          // Scattered modifications
          for (let i = 0; i < 10000; i += 1000) {
            t[i] = 0xff;
            t[i + 1] = 0x00;
          }
          return t;
        })(),
      },
      {
        name: "blob: empty to non-empty",
        base: new Uint8Array(0),
        target: encode("new file content\n"),
      },
    ];

    for (const tc of hashTestCases) {
      it(tc.name, async () => {
        // Compute expected hash of target
        const expectedHash = await computeObjectId("blob", tc.target);

        // Create delta and apply
        const ranges = createDeltaRanges(tc.base, tc.target);
        const gitDelta = deltaRangesToGitFormat(tc.base, tc.target, ranges);
        const reconstructed = applyGitDelta(tc.base, gitDelta);

        // Compute hash of reconstructed content
        const actualHash = await computeObjectId("blob", reconstructed);

        expect(actualHash).toBe(expectedHash);
        expect(reconstructed).toEqual(tc.target);
      });
    }
  });

  describe("both delta algorithms produce same hash", () => {
    it("createDeltaRanges vs createFossilLikeRanges yield same content and hash", async () => {
      const base = randomBytes(5000, 42);
      const target = new Uint8Array(base);
      // Modify a section
      for (let i = 2000; i < 3000; i++) target[i] = 0xaa;

      const expectedHash = await computeObjectId("blob", target);

      // Algorithm 1: createDeltaRanges
      const ranges1 = createDeltaRanges(base, target);
      const delta1 = deltaRangesToGitFormat(base, target, ranges1);
      const result1 = applyGitDelta(base, delta1);
      const hash1 = await computeObjectId("blob", result1);

      // Algorithm 2: createFossilLikeRanges
      const ranges2 = createFossilLikeRanges(base, target);
      const delta2 = deltaRangesToGitFormat(base, target, ranges2);
      const result2 = applyGitDelta(base, delta2);
      const hash2 = await computeObjectId("blob", result2);

      expect(hash1).toBe(expectedHash);
      expect(hash2).toBe(expectedHash);
      expect(result1).toEqual(result2);
    });
  });

  describe("hash survives format conversion", () => {
    it("Git → Fossil → Git roundtrip produces correct hash", async () => {
      const base = encode("base content for hash test\nline 2\nline 3\n");
      const target = encode("modified content for hash test\nline 2\nnew line 3\nline 4\n");

      const expectedHash = await computeObjectId("blob", target);

      // Create via Git format
      const ranges = [...createDeltaRanges(base, target)];
      const gitDelta = deltaRangesToGitFormat(base, target, ranges);

      // Convert Git → Delta[] → Fossil → Delta[] → Git → apply
      const deltas = deserializeDeltaFromGit(gitDelta);
      const fossilBinary = serializeDeltaToFossil(deltas);
      const restored = deserializeDeltaFromFossil(fossilBinary);
      const gitDelta2 = deltaToGitFormat(base.length, restored);
      const reconstructed = applyGitDelta(base, gitDelta2);

      const actualHash = await computeObjectId("blob", reconstructed);
      expect(actualHash).toBe(expectedHash);
    });
  });
});

describe("Streaming vs block application with hash verification", () => {
  const streamTestCases: TestCase[] = [
    {
      name: "text modification",
      base: encode("The quick brown fox jumps over the lazy dog."),
      target: encode("The fast brown cat leaps over the lazy dog."),
    },
    {
      name: "large binary with overlap",
      base: randomBytes(50000, 1),
      target: (() => {
        const t = new Uint8Array(55000);
        const b = randomBytes(50000, 1);
        t.set(b.subarray(0, 20000), 0);
        t.set(randomBytes(15000, 333), 20000);
        t.set(b.subarray(35000, 50000), 35000);
        t.set(randomBytes(5000, 444), 50000);
        return t;
      })(),
    },
    {
      name: "pure insert (no overlap)",
      base: new Uint8Array(0),
      target: randomBytes(1000, 555),
    },
  ];

  for (const tc of streamTestCases) {
    it(`${tc.name}: streaming and block produce same result and hash`, async () => {
      const ranges = createDeltaRanges(tc.base, tc.target);
      const gitDelta = deltaRangesToGitFormat(tc.base, tc.target, ranges);

      // Block application
      const blockResult = applyGitDelta(tc.base, gitDelta);

      // Streaming application
      const streamResult = await collectAsync(
        applyGitDeltaStreaming(toRandomAccessStream(tc.base), toRandomAccessStream(gitDelta)),
      );

      // Both should match target
      expect(blockResult).toEqual(tc.target);
      expect(streamResult).toEqual(tc.target);

      // Both should produce the same hash
      const blockHash = await computeObjectId("blob", blockResult);
      const streamHash = await computeObjectId("blob", streamResult);
      const expectedHash = await computeObjectId("blob", tc.target);

      expect(blockHash).toBe(expectedHash);
      expect(streamHash).toBe(expectedHash);
    });
  }
});

describe("Delta chain roundtrip (multiple sequential deltas)", () => {
  it("applying deltas in sequence preserves content and hash at each step", async () => {
    const versions = [
      encode("Version 1: initial content\n"),
      encode("Version 2: modified content\nNew line added\n"),
      encode("Version 2: modified content\nNew line added\nAnother line\n"),
      encode("Version 3: completely rewritten\n"),
    ];

    let current = versions[0];

    for (let i = 1; i < versions.length; i++) {
      const target = versions[i];
      const expectedHash = await computeObjectId("blob", target);

      // Create delta from current to next version
      const ranges = createDeltaRanges(current, target);
      const gitDelta = deltaRangesToGitFormat(current, target, ranges);

      // Apply delta
      const reconstructed = applyGitDelta(current, gitDelta);
      const actualHash = await computeObjectId("blob", reconstructed);

      expect(reconstructed).toEqual(target);
      expect(actualHash).toBe(expectedHash);

      current = reconstructed;
    }

    // Final version should match
    expect(current).toEqual(versions[versions.length - 1]);
  });

  it("chained deltas through Fossil format preserve hash", async () => {
    const versions = [
      encode("v1: hello world\n"),
      encode("v2: hello universe\n"),
      encode("v3: goodbye universe\nfinal version\n"),
    ];

    let current = versions[0];

    for (let i = 1; i < versions.length; i++) {
      const target = versions[i];
      const expectedHash = await computeObjectId("blob", target);

      // Create delta, serialize to Fossil, restore, apply
      const ranges = [...createDeltaRanges(current, target)];
      const deltas = [...createDelta(current, target, ranges)];
      const fossilBinary = serializeDeltaToFossil(deltas);
      const restored = deserializeDeltaFromFossil(fossilBinary);
      const reconstructed = mergeChunks(applyDelta(current, restored));

      const actualHash = await computeObjectId("blob", reconstructed);

      expect(reconstructed).toEqual(target);
      expect(actualHash).toBe(expectedHash);

      current = reconstructed;
    }
  });
});

describe("Git object types hash verification", () => {
  it("commit object delta preserves hash", async () => {
    const baseCommit = encode(
      "tree 4b825dc642cb6eb9a060e54bf899d8e4c1247e30\n" +
        "author Test User <test@example.com> 1234567890 +0000\n" +
        "committer Test User <test@example.com> 1234567890 +0000\n" +
        "\nInitial commit\n",
    );
    const targetCommit = encode(
      "tree 4b825dc642cb6eb9a060e54bf899d8e4c1247e30\n" +
        "parent abc1234567890abcdef1234567890abcdef123456\n" +
        "author Test User <test@example.com> 1234567891 +0000\n" +
        "committer Test User <test@example.com> 1234567891 +0000\n" +
        "\nSecond commit\n",
    );

    const expectedHash = await computeObjectId("commit", targetCommit);

    const ranges = createDeltaRanges(baseCommit, targetCommit);
    const delta = deltaRangesToGitFormat(baseCommit, targetCommit, ranges);
    const reconstructed = applyGitDelta(baseCommit, delta);

    const actualHash = await computeObjectId("commit", reconstructed);
    expect(actualHash).toBe(expectedHash);
    expect(reconstructed).toEqual(targetCommit);
  });

  it("tree object delta preserves hash", async () => {
    // Simplified tree entries (real git trees use binary SHA, but for delta testing text is fine)
    const baseTree = encode(`100644 file1.txt\0${"A".repeat(20)}`);
    const targetTree = encode(
      `100644 file1.txt\0${"A".repeat(20)}100644 file2.txt\0${"B".repeat(20)}`,
    );

    const expectedHash = await computeObjectId("tree", targetTree);

    const ranges = createDeltaRanges(baseTree, targetTree);
    const delta = deltaRangesToGitFormat(baseTree, targetTree, ranges);
    const reconstructed = applyGitDelta(baseTree, delta);

    const actualHash = await computeObjectId("tree", reconstructed);
    expect(actualHash).toBe(expectedHash);
  });
});
