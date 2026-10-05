import { describe, expect, it } from "vitest";
import { newSha1, Sha1, type Sha1Hash } from "../../../src/hash/sha1/sha-1.js";
import { bytesToHex } from "../../../src/hash/utils/index.js";

function toHex(bytes: Sha1Hash): string {
  return bytesToHex(bytes);
}

describe("newSha1", () => {
  const encoder = new TextEncoder();

  describe("direct invocation with arguments", () => {
    it("should hash a single message", () => {
      const message = encoder.encode("test");
      const hash = newSha1(message);

      expect(toHex(hash)).toBe("a94a8fe5ccb19ba61c4c0873d391e987982fbbd3");
    });

    it("should hash 'Hello, World!'", () => {
      const message = encoder.encode("Hello, World!");
      const hash = newSha1(message);

      expect(toHex(hash)).toBe("0a0a9f2a6772942557ab5355d76af442f8f65e01");
    });

    it("should hash empty data", () => {
      const message = new Uint8Array([]);
      const hash = newSha1(message);

      expect(toHex(hash)).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    });

    it("should hash multiple messages at once", () => {
      const token1 = encoder.encode("Hello");
      const token2 = encoder.encode(" ");
      const token3 = encoder.encode("World");
      const hash = newSha1(token1, token2, token3);

      // Same as hashing "Hello World"
      const singleHash = newSha1(encoder.encode("Hello World"));
      expect(toHex(hash)).toBe(toHex(singleHash));
    });

    it("should return 20-byte hash", () => {
      const message = encoder.encode("test");
      const hash = newSha1(message);

      expect(hash).toHaveLength(20);
      expect(toHex(hash)).toHaveLength(40);
    });
  });

  describe("chained invocation", () => {
    it("should return Sha1 instance when called without arguments", () => {
      const sha1 = newSha1();

      expect(sha1).toBeInstanceOf(Sha1);
      expect(typeof sha1.update).toBe("function");
      expect(typeof sha1.finalize).toBe("function");
      expect(typeof sha1.clone).toBe("function");
    });

    it("should hash using chained update calls", () => {
      const token1 = encoder.encode("Hello");
      const token2 = encoder.encode(" ");
      const token3 = encoder.encode("World");

      const hash = newSha1().update(token1).update(token2).update(token3).finalize();

      const directHash = newSha1(encoder.encode("Hello World"));
      expect(toHex(hash)).toBe(toHex(directHash));
    });

    it("should allow chaining multiple update calls", () => {
      const token1 = encoder.encode("Hello");
      const token2 = encoder.encode(" World");

      const hash = newSha1().update(token1).update(token2).finalize();

      const directHash = newSha1(encoder.encode("Hello World"));
      expect(toHex(hash)).toBe(toHex(directHash));
    });

    it("should produce same result as direct invocation", () => {
      const message = encoder.encode("test");

      const directHash = newSha1(message);
      const chainedHash = newSha1().update(message).finalize();

      expect(toHex(chainedHash)).toBe(toHex(directHash));
    });
  });

  describe("error handling", () => {
    it("should return same result when finalizing twice", () => {
      const update = newSha1();
      update.update(encoder.encode("test"));
      const hash1 = update.finalize();
      const hash2 = update.finalize();

      expect(toHex(hash1)).toBe(toHex(hash2));
      expect(toHex(hash1)).toBe("a94a8fe5ccb19ba61c4c0873d391e987982fbbd3");
    });

    it("should throw error when updating after finalize", () => {
      const update = newSha1();
      update.update(encoder.encode("test"));
      update.finalize();

      expect(() => update.update(encoder.encode("more"))).toThrow("Hash was finalized");
    });

    it("should return a finalized clone when cloning after finalize", () => {
      const update = newSha1();
      update.update(encoder.encode("test"));
      const hash1 = update.finalize();

      const cloned = update.clone();
      expect(cloned.finalized).toBe(true);
      const hash2 = cloned.finalize();

      expect(toHex(hash1)).toBe(toHex(hash2));
    });
  });

  describe("clone", () => {
    it("should return a clone function", () => {
      const update = newSha1();
      expect(typeof update.clone).toBe("function");
    });

    it("should create independent copy of hash state", () => {
      const hash = newSha1();
      hash.update(encoder.encode("Hello"));

      // Clone at this point
      const cloned = hash.clone();

      // Continue original
      hash.update(encoder.encode(" World"));
      const originalResult = toHex(hash.finalize());

      // Finalize clone (should only have "Hello")
      const clonedResult = toHex(cloned.finalize());

      expect(originalResult).toBe(toHex(newSha1(encoder.encode("Hello World"))));
      expect(clonedResult).toBe(toHex(newSha1(encoder.encode("Hello"))));
      expect(originalResult).not.toBe(clonedResult);
    });

    it("should allow getting intermediate hashes", () => {
      const hash = newSha1();

      // First part
      hash.update(encoder.encode("abc"));
      const intermediate1 = toHex(hash.clone().finalize());

      // Second part
      hash.update(encoder.encode("def"));
      const intermediate2 = toHex(hash.clone().finalize());

      // Final
      hash.update(encoder.encode("ghi"));
      const finalResult = toHex(hash.finalize());

      // Verify intermediate hashes
      expect(intermediate1).toBe(toHex(newSha1(encoder.encode("abc"))));
      expect(intermediate2).toBe(toHex(newSha1(encoder.encode("abcdef"))));
      expect(finalResult).toBe(toHex(newSha1(encoder.encode("abcdefghi"))));
    });

    it("should clone state correctly across block boundaries", () => {
      // Create data that spans multiple SHA-1 blocks (64 bytes each)
      const part1 = new Uint8Array(50).fill(0x41); // 50 bytes of 'A'
      const part2 = new Uint8Array(50).fill(0x42); // 50 bytes of 'B'
      const part3 = new Uint8Array(50).fill(0x43); // 50 bytes of 'C'

      const hash = newSha1();
      hash.update(part1);

      // Clone after first part (within first block)
      const clone1 = hash.clone();

      hash.update(part2);

      // Clone after second part (spans blocks)
      const clone2 = hash.clone();

      hash.update(part3);

      // Verify all produce correct results
      const fullData = new Uint8Array(150);
      fullData.set(part1, 0);
      fullData.set(part2, 50);
      fullData.set(part3, 100);

      const data1 = new Uint8Array(50);
      data1.set(part1, 0);

      const data2 = new Uint8Array(100);
      data2.set(part1, 0);
      data2.set(part2, 50);

      expect(toHex(clone1.finalize())).toBe(toHex(newSha1(data1)));
      expect(toHex(clone2.finalize())).toBe(toHex(newSha1(data2)));
      expect(toHex(hash.finalize())).toBe(toHex(newSha1(fullData)));
    });

    it("should allow continuing to update cloned hash", () => {
      const hash = newSha1();
      hash.update(encoder.encode("Hello"));

      const cloned = hash.clone();
      cloned.update(encoder.encode(" Universe"));

      hash.update(encoder.encode(" World"));

      expect(toHex(hash.finalize())).toBe(toHex(newSha1(encoder.encode("Hello World"))));
      expect(toHex(cloned.finalize())).toBe(toHex(newSha1(encoder.encode("Hello Universe"))));
    });

    it("should allow multiple clones from same state", () => {
      const hash = newSha1();
      hash.update(encoder.encode("base"));

      const clone1 = hash.clone();
      const clone2 = hash.clone();
      const clone3 = hash.clone();

      clone1.update(encoder.encode("_one"));
      clone2.update(encoder.encode("_two"));
      clone3.update(encoder.encode("_three"));

      expect(toHex(clone1.finalize())).toBe(toHex(newSha1(encoder.encode("base_one"))));
      expect(toHex(clone2.finalize())).toBe(toHex(newSha1(encoder.encode("base_two"))));
      expect(toHex(clone3.finalize())).toBe(toHex(newSha1(encoder.encode("base_three"))));
    });

    it("should clone empty state correctly", () => {
      const hash = newSha1();
      const cloned = hash.clone();

      hash.update(encoder.encode("data"));

      expect(toHex(cloned.finalize())).toBe(toHex(newSha1(encoder.encode(""))));
      expect(toHex(hash.finalize())).toBe(toHex(newSha1(encoder.encode("data"))));
    });

    it("should support chained clone usage", () => {
      const result = toHex(
        newSha1()
          .update(encoder.encode("Hello"))
          .clone()
          .update(encoder.encode(" World"))
          .finalize(),
      );

      expect(result).toBe(toHex(newSha1(encoder.encode("Hello World"))));
    });
  });

  describe("update with offset and len", () => {
    it("should hash a slice of data using offset", () => {
      const fullData = encoder.encode("Hello World");
      // Hash only "World" (starting at offset 6)
      const hash = newSha1().update(fullData, 6).finalize();

      const directHash = newSha1(encoder.encode("World"));
      expect(toHex(hash)).toBe(toHex(directHash));
    });

    it("should hash a slice of data using offset and len", () => {
      const fullData = encoder.encode("Hello World");
      // Hash only "ello" (starting at offset 1, length 4)
      const hash = newSha1().update(fullData, 1, 4).finalize();

      const directHash = newSha1(encoder.encode("ello"));
      expect(toHex(hash)).toBe(toHex(directHash));
    });

    it("should hash with offset=0 and explicit len", () => {
      const fullData = encoder.encode("Hello World");
      // Hash only "Hello" (starting at offset 0, length 5)
      const hash = newSha1().update(fullData, 0, 5).finalize();

      const directHash = newSha1(encoder.encode("Hello"));
      expect(toHex(hash)).toBe(toHex(directHash));
    });

    it("should hash middle portion of data", () => {
      const fullData = encoder.encode("prefix_content_suffix");
      // Hash only "content" (starting at offset 7, length 7)
      const hash = newSha1().update(fullData, 7, 7).finalize();

      const directHash = newSha1(encoder.encode("content"));
      expect(toHex(hash)).toBe(toHex(directHash));
    });

    it("should work with chained updates using different slices", () => {
      const data = encoder.encode("HelloWorld");
      // Hash "Hello" + "World" separately using offset/len
      const hash = newSha1()
        .update(data, 0, 5) // "Hello"
        .update(data, 5, 5) // "World"
        .finalize();

      const directHash = newSha1(encoder.encode("HelloWorld"));
      expect(toHex(hash)).toBe(toHex(directHash));
    });

    it("should handle offset with len=0", () => {
      const fullData = encoder.encode("Hello");
      const hash = newSha1().update(fullData, 3, 0).finalize();

      const emptyHash = newSha1(encoder.encode(""));
      expect(toHex(hash)).toBe(toHex(emptyHash));
    });

    it("should handle Uint8Array with offset and len", () => {
      const data = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
      // Hash only bytes [0x02, 0x03] (offset 2, len 2)
      const hash = newSha1().update(data, 2, 2).finalize();

      const directHash = newSha1(new Uint8Array([0x02, 0x03]));
      expect(toHex(hash)).toBe(toHex(directHash));
    });

    it("should handle number array with offset and len", () => {
      const data = [72, 101, 108, 108, 111]; // "Hello"
      // Hash only "ell" (offset 1, len 3)
      const hash = newSha1().update(data, 1, 3).finalize();

      const directHash = newSha1(encoder.encode("ell"));
      expect(toHex(hash)).toBe(toHex(directHash));
    });

    it("should work with data spanning multiple SHA-1 blocks", () => {
      // Create data larger than one block (64 bytes)
      const data = new Uint8Array(100).fill(0x42);
      // Hash bytes 20-80 (60 bytes, almost one full block)
      const hash = newSha1().update(data, 20, 60).finalize();

      const slice = new Uint8Array(60).fill(0x42);
      const directHash = newSha1(slice);
      expect(toHex(hash)).toBe(toHex(directHash));
    });

    it("should default len to remaining bytes when not specified", () => {
      const fullData = encoder.encode("Hello World");
      // Without len, should hash from offset to end
      const hash = newSha1().update(fullData, 6).finalize();

      const directHash = newSha1(encoder.encode("World"));
      expect(toHex(hash)).toBe(toHex(directHash));
    });
  });

  describe("edge cases", () => {
    it("should handle binary data", () => {
      const data = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0xff]);
      const hash = newSha1(data);

      expect(hash).toHaveLength(20);
      expect(toHex(hash)).toMatch(/^[0-9a-f]{40}$/);
    });

    it("should handle large data", () => {
      const data = new Uint8Array(10000).fill(0x42);
      const hash = newSha1(data);

      expect(hash).toHaveLength(20);
    });

    it("should handle data requiring multiple blocks", () => {
      // SHA-1 block size is 64 bytes, test with data > 64 bytes
      const data = new Uint8Array(100).map((_, i) => i % 256);
      const hash = newSha1(data);

      expect(hash).toHaveLength(20);
    });

    it("should handle number array input", () => {
      const data = [72, 101, 108, 108, 111]; // "Hello" as number array
      const hash = newSha1(data);

      const uint8Hash = newSha1(encoder.encode("Hello"));
      expect(toHex(hash)).toBe(toHex(uint8Hash));
    });

    it("should handle incremental updates of varying sizes", () => {
      const full = encoder.encode("The quick brown fox jumps over the lazy dog");
      const directHash = newSha1(full);

      // Split at various points
      const update = newSha1();
      update.update(encoder.encode("The quick "));
      update.update(encoder.encode("brown fox "));
      update.update(encoder.encode("jumps over "));
      update.update(encoder.encode("the lazy dog"));
      const incrementalHash = update.finalize();

      expect(toHex(incrementalHash)).toBe(toHex(directHash));
    });
  });

  describe("known test vectors", () => {
    // Standard SHA-1 test vectors
    it("should match test vector: 'abc'", () => {
      const hash = newSha1(encoder.encode("abc"));
      expect(toHex(hash)).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    });

    it("should match test vector: empty string", () => {
      const hash = newSha1(encoder.encode(""));
      expect(toHex(hash)).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
    });

    it("should match test vector: 'The quick brown fox jumps over the lazy dog'", () => {
      const hash = newSha1(encoder.encode("The quick brown fox jumps over the lazy dog"));
      expect(toHex(hash)).toBe("2fd4e1c67a2d28fced849ee1bb76e7391b93eb12");
    });

    it("should match test vector: 'The quick brown fox jumps over the lazy cog'", () => {
      const hash = newSha1(encoder.encode("The quick brown fox jumps over the lazy cog"));
      expect(toHex(hash)).toBe("de9f2c7fd25e1b3afad3e85a0bd17d9b100db4b3");
    });
  });
});
