/**
 * Tests for test helper functions
 */

import { describe, expect, it } from "vitest";
import {
  assertBytesEqual,
  assertThrowsAsync,
  collectAll,
  collectBytes,
  concatBytes,
} from "./assertion-helpers.js";
import {
  bytesToText,
  createBlobContent,
  createSimilarContent,
  createTestCommit,
  createTestDelta,
  createTestPerson,
  generatePatternContent,
  randomBytes,
  randomHex,
  randomObjectId,
  randomTreeEntries,
  TestRng,
  textToBytes,
} from "./test-data-generators.js";

describe("TestRng", () => {
  it("should produce reproducible results with same seed", () => {
    const rng1 = new TestRng(42);
    const rng2 = new TestRng(42);

    const results1 = Array.from({ length: 10 }, () => rng1.next());
    const results2 = Array.from({ length: 10 }, () => rng2.next());

    expect(results1).toEqual(results2);
  });

  it("should produce different results with different seeds", () => {
    const rng1 = new TestRng(42);
    const rng2 = new TestRng(123);

    expect(rng1.next()).not.toBe(rng2.next());
  });

  it("should generate integers in range", () => {
    const rng = new TestRng(42);

    for (let i = 0; i < 100; i++) {
      const value = rng.nextInt(10, 20);
      expect(value).toBeGreaterThanOrEqual(10);
      expect(value).toBeLessThanOrEqual(20);
    }
  });
});

describe("randomBytes", () => {
  it("should generate bytes of specified size", () => {
    const bytes = randomBytes(100);
    expect(bytes.length).toBe(100);
  });

  it("should be reproducible with seed", () => {
    const bytes1 = randomBytes(50, 42);
    const bytes2 = randomBytes(50, 42);
    expect(bytes1).toEqual(bytes2);
  });
});

describe("randomHex", () => {
  it("should generate hex string of specified length", () => {
    const hex = randomHex(40);
    expect(hex.length).toBe(40);
    expect(hex).toMatch(/^[0-9a-f]+$/);
  });
});

describe("randomObjectId", () => {
  it("should generate 40-character hex string", () => {
    const id = randomObjectId();
    expect(id.length).toBe(40);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });
});

describe("createTestPerson", () => {
  it("should create default person", () => {
    const person = createTestPerson();
    expect(person.name).toBe("Test User");
    expect(person.email).toBe("test@example.com");
    expect(person.tzOffset).toBe("+0000");
    expect(person.timestamp).toBeGreaterThan(0);
  });

  it("should accept custom values", () => {
    const person = createTestPerson("John", "john@test.com", 12345, "+0100");
    expect(person.name).toBe("John");
    expect(person.email).toBe("john@test.com");
    expect(person.timestamp).toBe(12345);
    expect(person.tzOffset).toBe("+0100");
  });
});

describe("createTestCommit", () => {
  it("should create commit with defaults", () => {
    const commit = createTestCommit();
    expect(commit.tree).toBeDefined();
    expect(commit.parents).toEqual([]);
    expect(commit.author).toBeDefined();
    expect(commit.committer).toBeDefined();
    expect(commit.message).toBe("Test commit message");
  });

  it("should accept overrides", () => {
    const commit = createTestCommit({
      message: "Custom message",
      parents: ["parent1", "parent2"],
    });
    expect(commit.message).toBe("Custom message");
    expect(commit.parents).toEqual(["parent1", "parent2"]);
  });
});

describe("randomTreeEntries", () => {
  it("should generate specified number of entries", () => {
    const entries = randomTreeEntries(10);
    expect(entries.length).toBe(10);
  });

  it("should be sorted by name", () => {
    const entries = randomTreeEntries(20);
    const names = entries.map((e) => e.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });

  it("should have valid entry properties", () => {
    const entries = randomTreeEntries(5);
    for (const entry of entries) {
      expect(entry.mode).toBeDefined();
      expect(entry.name).toBeDefined();
      expect(entry.id.length).toBe(40);
    }
  });
});

describe("createTestDelta", () => {
  it("should create delta with start and finish", () => {
    const delta = createTestDelta(100);
    expect(delta[0]).toEqual({ type: "start", sourceLen: 0, targetLen: 100 });
    expect(delta[delta.length - 1]).toEqual({ type: "finish", checksum: 0 });
  });

  it("should include copy ranges", () => {
    const delta = createTestDelta(100, [{ start: 0, len: 50 }]);
    expect(delta).toContainEqual({ type: "copy", start: 0, len: 50 });
  });

  it("should include insert data", () => {
    const data = new Uint8Array([1, 2, 3]);
    const delta = createTestDelta(100, [], [data]);
    expect(delta).toContainEqual({ type: "insert", data });
  });
});

describe("textToBytes and bytesToText", () => {
  it("should round-trip text", () => {
    const original = "Hello, World! 你好世界";
    const bytes = textToBytes(original);
    const result = bytesToText(bytes);
    expect(result).toBe(original);
  });
});

describe("createBlobContent", () => {
  it("should create UTF-8 encoded content", () => {
    const content = createBlobContent("test content");
    expect(bytesToText(content)).toBe("test content");
  });
});

describe("generatePatternContent", () => {
  it("should generate content of specified size", () => {
    const content = generatePatternContent(100);
    expect(content.length).toBe(100);
  });

  it("should repeat pattern", () => {
    const content = generatePatternContent(12, "abc");
    expect(bytesToText(content)).toBe("abcabcabcabc");
  });
});

describe("createSimilarContent", () => {
  it("should create two arrays of same size", () => {
    const { base, modified } = createSimilarContent(100);
    expect(base.length).toBe(100);
    expect(modified.length).toBe(100);
  });

  it("should have some differences", () => {
    const { base, modified } = createSimilarContent(1000, 0.1);
    let differences = 0;
    for (let i = 0; i < base.length; i++) {
      if (base[i] !== modified[i]) differences++;
    }
    expect(differences).toBeGreaterThan(0);
    expect(differences).toBeLessThan(200); // ~10% with some variance
  });
});

describe("collectBytes", () => {
  it("should collect async iterable into single array", async () => {
    async function* generate() {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4]);
      yield new Uint8Array([5]);
    }

    const result = await collectBytes(generate());
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });
});

describe("concatBytes", () => {
  it("should concatenate arrays", () => {
    const result = concatBytes([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]);
    expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });
});

describe("assertBytesEqual", () => {
  it("should pass for equal arrays", () => {
    assertBytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]));
  });

  it("should throw for different arrays", () => {
    expect(() => assertBytesEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toThrow();
  });
});

describe("collectAll", () => {
  it("should collect all items from async iterable", async () => {
    async function* generate() {
      yield 1;
      yield 2;
      yield 3;
    }

    const result = await collectAll(generate());
    expect(result).toEqual([1, 2, 3]);
  });
});

describe("assertThrowsAsync", () => {
  it("should pass when function throws", async () => {
    await assertThrowsAsync(async () => {
      throw new Error("test error");
    });
  });

  it("should pass when message matches pattern", async () => {
    await assertThrowsAsync(async () => {
      throw new Error("test error message");
    }, "error");
  });

  it("should pass when message matches regex", async () => {
    await assertThrowsAsync(async () => {
      throw new Error("test error 123");
    }, /error \d+/);
  });
});
