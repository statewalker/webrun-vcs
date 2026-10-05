/**
 * Tests for stream utilities
 */

import { describe, expect, it } from "vitest";
import {
  asAsyncIterable,
  collect,
  concat,
  decodeString,
  encodeString,
  isAsyncIterable,
  mapStream,
  newByteSplitter,
  newSplitter,
  readAhead,
  readHeader,
  splitStream,
  toArray,
  toLines,
} from "../../src/streams/index.js";

// Helper to create async iterable from array
async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const item of arr) {
    yield item;
  }
}

// Helper to encode string to Uint8Array
function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

// Helper to collect splitStream results - must consume each generator before getting next
async function collectSplitStream(
  stream: AsyncGenerator<AsyncGenerator<Uint8Array>>,
): Promise<Uint8Array[][]> {
  const result: Uint8Array[][] = [];
  for await (const generator of stream) {
    const chunks = await toArray(generator);
    result.push(chunks);
  }
  return result;
}

// Helper to convert split stream results to strings
async function collectSplitStreamAsStrings(
  stream: AsyncGenerator<AsyncGenerator<Uint8Array>>,
): Promise<string[]> {
  const result: string[] = [];
  for await (const generator of stream) {
    const chunks = await toArray(generator);
    const text = chunks.map((c) => new TextDecoder().decode(c)).join("");
    result.push(text);
  }
  return result;
}

describe("stream-utils", () => {
  describe("concat", () => {
    it("concatenates two arrays", () => {
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([4, 5]);
      const result = concat(a, b);
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    it("handles empty first array", () => {
      const a = new Uint8Array([]);
      const b = new Uint8Array([1, 2]);
      const result = concat(a, b);
      expect(result).toEqual(new Uint8Array([1, 2]));
    });

    it("handles empty second array", () => {
      const a = new Uint8Array([1, 2]);
      const b = new Uint8Array([]);
      const result = concat(a, b);
      expect(result).toEqual(new Uint8Array([1, 2]));
    });
  });

  describe("isAsyncIterable", () => {
    it("returns true for async generator", () => {
      async function* gen(): AsyncIterable<number> {
        yield 1;
      }
      expect(isAsyncIterable(gen())).toBe(true);
    });

    it("returns false for sync array", () => {
      expect(isAsyncIterable([1, 2, 3])).toBe(false);
    });

    it("returns false for sync generator", () => {
      function* gen(): Generator<number> {
        yield 1;
      }
      expect(isAsyncIterable(gen())).toBe(false);
    });

    it("returns false for null", () => {
      expect(isAsyncIterable(null)).toBe(false);
    });

    it("returns false for primitives", () => {
      expect(isAsyncIterable(42)).toBe(false);
      expect(isAsyncIterable("string")).toBe(false);
      expect(isAsyncIterable(undefined)).toBe(false);
    });
  });

  describe("asAsyncIterable", () => {
    it("returns async iterable unchanged", async () => {
      async function* gen(): AsyncIterable<number> {
        yield 1;
        yield 2;
      }
      const input = gen();
      const result = asAsyncIterable(input);
      expect(result).toBe(input);
    });

    it("converts array to async iterable", async () => {
      const arr = [1, 2, 3];
      const result = asAsyncIterable(arr);
      const collected = await toArray(result);
      expect(collected).toEqual([1, 2, 3]);
    });

    it("converts sync generator to async iterable", async () => {
      function* gen(): Generator<number> {
        yield 10;
        yield 20;
      }
      const result = asAsyncIterable(gen());
      const collected = await toArray(result);
      expect(collected).toEqual([10, 20]);
    });
  });

  describe("toArray", () => {
    it("collects async iterable to array", async () => {
      async function* gen(): AsyncIterable<string> {
        yield "a";
        yield "b";
        yield "c";
      }
      const result = await toArray(gen());
      expect(result).toEqual(["a", "b", "c"]);
    });

    it("returns empty array for empty iterable", async () => {
      async function* empty(): AsyncIterable<number> {}
      const result = await toArray(empty());
      expect(result).toEqual([]);
    });
  });

  describe("collect", () => {
    it("collects empty stream to empty Uint8Array", async () => {
      async function* empty(): AsyncIterable<Uint8Array> {}
      const result = await collect(empty());
      expect(result).toEqual(new Uint8Array(0));
      expect(result.length).toBe(0);
    });

    it("collects single chunk unchanged", async () => {
      const chunk = new Uint8Array([1, 2, 3, 4, 5]);
      const result = await collect(fromArray([chunk]));
      expect(result).toEqual(chunk);
    });

    it("concatenates multiple chunks in order", async () => {
      const input = fromArray([
        new Uint8Array([1, 2]),
        new Uint8Array([3, 4]),
        new Uint8Array([5]),
      ]);
      const result = await collect(input);
      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    });

    it("handles chunks with zero bytes", async () => {
      const input = fromArray([new Uint8Array([0, 0]), new Uint8Array([0])]);
      const result = await collect(input);
      expect(result).toEqual(new Uint8Array([0, 0, 0]));
    });

    it("handles empty chunks mixed with data", async () => {
      const input = fromArray([
        new Uint8Array(0),
        new Uint8Array([1, 2]),
        new Uint8Array(0),
        new Uint8Array([3]),
        new Uint8Array(0),
      ]);
      const result = await collect(input);
      expect(result).toEqual(new Uint8Array([1, 2, 3]));
    });

    it("handles large number of small chunks", async () => {
      const chunks = Array.from({ length: 1000 }, (_, i) => new Uint8Array([i & 0xff]));
      const result = await collect(fromArray(chunks));
      expect(result.length).toBe(1000);
      for (let i = 0; i < 1000; i++) {
        expect(result[i]).toBe(i & 0xff);
      }
    });

    it("handles large chunks", async () => {
      const largeChunk = new Uint8Array(10000);
      for (let i = 0; i < largeChunk.length; i++) {
        largeChunk[i] = i & 0xff;
      }
      const result = await collect(fromArray([largeChunk]));
      expect(result).toEqual(largeChunk);
    });

    it("collects text encoded as Uint8Array", async () => {
      const input = fromArray([encode("hello"), encode(" "), encode("world")]);
      const result = await collect(input);
      expect(new TextDecoder().decode(result)).toBe("hello world");
    });

    it("handles binary data with all byte values", async () => {
      const allBytes = new Uint8Array(256);
      for (let i = 0; i < 256; i++) {
        allBytes[i] = i;
      }
      const result = await collect(fromArray([allBytes]));
      expect(result).toEqual(allBytes);
    });
  });

  describe("encodeString/decodeString", () => {
    it("roundtrips ASCII text", () => {
      const text = "hello world";
      const encoded = encodeString(text);
      const decoded = decodeString(encoded);
      expect(decoded).toBe(text);
    });

    it("roundtrips UTF-8 text", () => {
      const text = "日本語 émoji 🎉";
      const encoded = encodeString(text);
      const decoded = decodeString(encoded);
      expect(decoded).toBe(text);
    });
  });

  describe("mapStream", () => {
    it("maps empty async iterable to empty result", async () => {
      async function* empty(): AsyncIterable<number> {}
      const result = await toArray(mapStream(empty(), (x) => x * 2));
      expect(result).toEqual([]);
    });

    it("maps empty sync iterable to empty result", async () => {
      const result = await toArray(mapStream([], (x: number) => x * 2));
      expect(result).toEqual([]);
    });

    it("maps single item from async iterable", async () => {
      async function* single(): AsyncIterable<number> {
        yield 5;
      }
      const result = await toArray(mapStream(single(), (x) => x * 2));
      expect(result).toEqual([10]);
    });

    it("maps single item from sync iterable", async () => {
      const result = await toArray(mapStream([5], (x) => x * 2));
      expect(result).toEqual([10]);
    });

    it("maps multiple items from async iterable", async () => {
      async function* multi(): AsyncIterable<number> {
        yield 1;
        yield 2;
        yield 3;
      }
      const result = await toArray(mapStream(multi(), (x) => x * 2));
      expect(result).toEqual([2, 4, 6]);
    });

    it("maps multiple items from sync array", async () => {
      const result = await toArray(mapStream([1, 2, 3], (x) => x * 2));
      expect(result).toEqual([2, 4, 6]);
    });

    it("maps with type transformation", async () => {
      const result = await toArray(mapStream([1, 2, 3], (x) => x.toString()));
      expect(result).toEqual(["1", "2", "3"]);
    });

    it("maps with complex transformation", async () => {
      const result = await toArray(
        mapStream(["a", "b", "c"], (x) => ({ value: x, upper: x.toUpperCase() })),
      );
      expect(result).toEqual([
        { value: "a", upper: "A" },
        { value: "b", upper: "B" },
        { value: "c", upper: "C" },
      ]);
    });

    it("maps sync generator", async () => {
      function* gen(): Generator<number> {
        yield 10;
        yield 20;
        yield 30;
      }
      const result = await toArray(mapStream(gen(), (x) => x / 10));
      expect(result).toEqual([1, 2, 3]);
    });

    it("preserves order of items", async () => {
      const input = Array.from({ length: 100 }, (_, i) => i);
      const result = await toArray(mapStream(input, (x) => x));
      expect(result).toEqual(input);
    });

    it("handles null and undefined values", async () => {
      const result = await toArray(mapStream([null, undefined, "value"], (x) => x));
      expect(result).toEqual([null, undefined, "value"]);
    });

    it("maps with identity function", async () => {
      const input = [1, 2, 3];
      const result = await toArray(mapStream(input, (x) => x));
      expect(result).toEqual(input);
    });
  });

  describe("toLines", () => {
    it("handles empty stream", async () => {
      async function* empty(): AsyncIterable<Uint8Array> {}
      const result = await toArray(toLines(empty()));
      expect(result).toEqual([]);
    });

    it("handles single line without newline", async () => {
      const result = await toArray(toLines(fromArray([encode("hello")])));
      expect(result).toEqual(["hello"]);
    });

    it("handles single line with LF", async () => {
      const result = await toArray(toLines(fromArray([encode("hello\n")])));
      expect(result).toEqual(["hello"]);
    });

    it("handles single line with CRLF", async () => {
      const result = await toArray(toLines(fromArray([encode("hello\r\n")])));
      expect(result).toEqual(["hello"]);
    });

    it("handles multiple lines in single chunk", async () => {
      const result = await toArray(toLines(fromArray([encode("line1\nline2\nline3")])));
      expect(result).toEqual(["line1", "line2", "line3"]);
    });

    it("handles multiple lines with trailing newline", async () => {
      const result = await toArray(toLines(fromArray([encode("line1\nline2\nline3\n")])));
      expect(result).toEqual(["line1", "line2", "line3"]);
    });

    it("handles multiple lines split across chunks", async () => {
      const result = await toArray(
        toLines(fromArray([encode("hel"), encode("lo\nwor"), encode("ld")])),
      );
      expect(result).toEqual(["hello", "world"]);
    });

    it("handles newline at chunk boundary", async () => {
      const result = await toArray(
        toLines(fromArray([encode("hello"), encode("\n"), encode("world")])),
      );
      expect(result).toEqual(["hello", "world"]);
    });

    it("handles CRLF split across chunks", async () => {
      const result = await toArray(toLines(fromArray([encode("hello\r"), encode("\nworld")])));
      expect(result).toEqual(["hello", "world"]);
    });

    it("handles empty lines", async () => {
      const result = await toArray(toLines(fromArray([encode("line1\n\nline3\n")])));
      expect(result).toEqual(["line1", "", "line3"]);
    });

    it("handles multiple empty lines", async () => {
      const result = await toArray(toLines(fromArray([encode("\n\n\n")])));
      expect(result).toEqual(["", "", ""]);
    });

    it("handles mixed line endings", async () => {
      const result = await toArray(toLines(fromArray([encode("line1\nline2\r\nline3\n")])));
      expect(result).toEqual(["line1", "line2", "line3"]);
    });

    it("handles byte-by-byte streaming", async () => {
      const text = "hello\nworld";
      const chunks = text.split("").map((c) => encode(c));
      const result = await toArray(toLines(fromArray(chunks)));
      expect(result).toEqual(["hello", "world"]);
    });

    it("handles UTF-8 multibyte characters", async () => {
      const result = await toArray(toLines(fromArray([encode("日本語\n中文\némoji 🎉")])));
      expect(result).toEqual(["日本語", "中文", "émoji 🎉"]);
    });

    it("handles UTF-8 characters split across chunks", async () => {
      // 日 is encoded as E6 97 A5 in UTF-8
      const fullText = encode("日\n");
      const chunk1 = fullText.subarray(0, 2); // partial UTF-8
      const chunk2 = fullText.subarray(2); // rest
      const result = await toArray(toLines(fromArray([chunk1, chunk2])));
      expect(result).toEqual(["日"]);
    });

    it("handles large number of lines", async () => {
      const lines = Array.from({ length: 1000 }, (_, i) => `line${i}`);
      const input = encode(lines.join("\n"));
      const result = await toArray(toLines(fromArray([input])));
      expect(result).toEqual(lines);
    });

    it("handles only newlines", async () => {
      const result = await toArray(toLines(fromArray([encode("\n")])));
      expect(result).toEqual([""]);
    });

    it("handles carriage return only (not CRLF)", async () => {
      const result = await toArray(toLines(fromArray([encode("hello\rworld\n")])));
      // \r alone is kept, only stripped when followed by \n
      expect(result).toEqual(["hello\rworld"]);
    });

    it("handles very long line", async () => {
      const longLine = "x".repeat(10000);
      const result = await toArray(toLines(fromArray([encode(longLine)])));
      expect(result).toEqual([longLine]);
    });

    it("handles very long line split across many chunks", async () => {
      const longLine = "x".repeat(1000);
      // Split into 100 chunks of 10 characters each
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < 100; i++) {
        chunks.push(encode(longLine.substring(i * 10, (i + 1) * 10)));
      }
      const result = await toArray(toLines(fromArray(chunks)));
      expect(result).toEqual([longLine]);
    });
  });

  describe("splitStream", () => {
    // Note: splitStream only calls the split function on NEW blocks from the input iterator,
    // not on remainders from previous splits. So each input block can trigger at most one split.

    it("yields one empty generator for empty stream", async () => {
      async function* empty(): AsyncIterable<Uint8Array> {}
      const results = await collectSplitStream(splitStream(empty(), () => -1));
      // Empty stream yields one generator that produces no chunks
      expect(results.length).toBe(1);
      expect(results[0].length).toBe(0);
    });

    it("handles single chunk with no split", async () => {
      const input = fromArray([encode("hello")]);
      const results = await collectSplitStream(splitStream(input, () => -1));
      expect(results.length).toBe(1);
      expect(results[0]).toEqual([encode("hello")]);
    });

    it("handles multiple chunks with no split", async () => {
      const input = fromArray([encode("hello"), encode("world")]);
      const results = await collectSplitStream(splitStream(input, () => -1));
      expect(results.length).toBe(1);
      expect(new TextDecoder().decode(results[0][0])).toBe("hello");
      expect(new TextDecoder().decode(results[0][1])).toBe("world");
    });

    it("splits at beginning of chunk", async () => {
      const input = fromArray([encode("hello"), encode("world")]);
      let callCount = 0;
      const results = await collectSplitStream(
        splitStream(input, () => {
          callCount++;
          return callCount === 2 ? 0 : -1; // Split at start of second chunk
        }),
      );

      expect(results.length).toBe(2);
      expect(new TextDecoder().decode(results[0][0])).toBe("hello");
      // First generator yields "hello" only (no empty chunk when split at position 0)
      expect(results[0].length).toBe(1);
      // Second generator yields the remainder "world"
      expect(new TextDecoder().decode(results[1][0])).toBe("world");
    });

    it("splits in middle of chunk", async () => {
      const input = fromArray([encode("helloworld")]);
      const results = await collectSplitStream(
        splitStream(input, (block) => {
          const text = new TextDecoder().decode(block);
          return text.includes("world") ? 5 : -1; // Split at position 5
        }),
      );

      expect(results.length).toBe(2);
      expect(new TextDecoder().decode(results[0][0])).toBe("hello");
      expect(new TextDecoder().decode(results[1][0])).toBe("world");
    });

    it("splits at end of chunk", async () => {
      const input = fromArray([encode("hello"), encode("world")]);
      const results = await collectSplitStream(
        splitStream(input, (block) => {
          const text = new TextDecoder().decode(block);
          return text === "hello" ? 5 : -1; // Split at end of "hello"
        }),
      );

      expect(results.length).toBe(2);
      expect(new TextDecoder().decode(results[0][0])).toBe("hello");
      expect(results[1][0].length).toBe(0); // Empty subarray from split point
      expect(new TextDecoder().decode(results[1][1])).toBe("world");
    });

    it("splits all delimiters in a single block (always re-split)", async () => {
      // With single input block "a|b|c", all delimiters are found (always re-split)
      const input = fromArray([encode("a|b|c")]);
      const parts = await collectSplitStreamAsStrings(
        splitStream(input, (block) => {
          const text = new TextDecoder().decode(block);
          const idx = text.indexOf("|");
          return idx >= 0 ? idx + 1 : -1;
        }),
      );

      expect(parts).toEqual(["a|", "b|", "c"]);
    });

    it("splits each input block independently", async () => {
      // With separate input blocks, each can trigger a split
      const input = fromArray([encode("a|"), encode("b|"), encode("c")]);
      const parts = await collectSplitStreamAsStrings(
        splitStream(input, (block) => {
          const idx = block.indexOf(124); // | character
          return idx >= 0 ? idx + 1 : -1;
        }),
      );

      expect(parts).toEqual(["a|", "b|", "c"]);
    });

    it("handles split with empty remainder", async () => {
      const input = fromArray([encode("||")]);
      const parts = await collectSplitStreamAsStrings(
        splitStream(input, (block) => {
          const idx = block.indexOf(124); // | character
          return idx >= 0 ? idx + 1 : -1;
        }),
      );

      // "||" splits at each |, empty remainder is skipped
      expect(parts).toEqual(["|", "|"]);
    });

    it("handles split on newline with single input block", async () => {
      const input = fromArray([encode("line1\nline2\nline3")]);
      const parts = await collectSplitStreamAsStrings(
        splitStream(input, (block) => {
          const idx = block.indexOf(10); // \n character
          return idx >= 0 ? idx + 1 : -1;
        }),
      );

      // Remainder blocks are always re-split, so all newlines are found
      expect(parts).toEqual(["line1\n", "line2\n", "line3"]);
    });

    it("handles split on newline with multiple input blocks", async () => {
      const input = fromArray([encode("line1\n"), encode("line2\n"), encode("line3")]);
      const parts = await collectSplitStreamAsStrings(
        splitStream(input, (block) => {
          const idx = block.indexOf(10); // \n character
          return idx >= 0 ? idx + 1 : -1;
        }),
      );

      expect(parts).toEqual(["line1\n", "line2\n", "line3"]);
    });

    it("handles split across multiple input chunks", async () => {
      const input = fromArray([encode("hel"), encode("lo|wor"), encode("ld")]);
      const parts = await collectSplitStreamAsStrings(
        splitStream(input, (block) => {
          const idx = block.indexOf(124); // | character
          return idx >= 0 ? idx + 1 : -1;
        }),
      );

      expect(parts).toEqual(["hello|", "world"]);
    });

    it("split function receives correct blocks", async () => {
      const receivedBlocks: string[] = [];
      const input = fromArray([encode("abc"), encode("def")]);

      await collectSplitStream(
        splitStream(input, (block) => {
          receivedBlocks.push(new TextDecoder().decode(block));
          return -1;
        }),
      );

      expect(receivedBlocks).toEqual(["abc", "def"]);
    });

    it("handles many input blocks with splits", async () => {
      // Create 100 separate input blocks, each with newline
      // Each block triggers a split, plus empty remainder at end = 101 segments
      const lines = Array.from({ length: 100 }, (_, i) => `line${i}\n`);
      const input = fromArray(lines.map(encode));

      const parts = await collectSplitStreamAsStrings(
        splitStream(input, (block) => {
          const idx = block.indexOf(10); // \n character
          return idx >= 0 ? idx + 1 : -1;
        }),
      );

      // 100 blocks with trailing newlines → 101 segments (last is empty remainder)
      expect(parts.length).toBe(101);
      expect(parts[100]).toBe(""); // Last segment is empty
    });

    it("handles binary data with zero bytes", async () => {
      const data = new Uint8Array([0, 1, 2, 255, 0, 3, 4]);
      const input = fromArray([data]);

      const results = await collectSplitStream(
        splitStream(input, (block) => {
          const idx = block.indexOf(255);
          return idx >= 0 ? idx + 1 : -1;
        }),
      );

      expect(results.length).toBe(2);
      expect(results[0][0]).toEqual(new Uint8Array([0, 1, 2, 255]));
      expect(results[1][0]).toEqual(new Uint8Array([0, 3, 4]));
    });

    it("generators can be consumed lazily", async () => {
      let chunkCount = 0;
      async function* countingInput(): AsyncIterable<Uint8Array> {
        for (const text of ["a|", "b|", "c"]) {
          chunkCount++;
          yield encode(text);
        }
      }

      const splitGen = splitStream(countingInput(), (block) => {
        const idx = block.indexOf(124);
        return idx >= 0 ? idx + 1 : -1;
      });

      // Get and consume first generator
      const { value: firstGen } = await splitGen.next();
      if (firstGen) {
        await toArray(firstGen);
      }
      expect(chunkCount).toBe(1);

      // Get and consume second generator
      const { value: secondGen } = await splitGen.next();
      if (secondGen) {
        await toArray(secondGen);
      }
      expect(chunkCount).toBe(2);

      // Get and consume third generator
      const { value: thirdGen } = await splitGen.next();
      if (thirdGen) {
        await toArray(thirdGen);
      }
      expect(chunkCount).toBe(3);
    });

    it("handles split point at position 0", async () => {
      let firstCall = true;
      const input = fromArray([encode("abc")]);

      const results = await collectSplitStream(
        splitStream(input, () => {
          if (firstCall) {
            firstCall = false;
            return 0; // Split at very beginning
          }
          return -1;
        }),
      );

      expect(results.length).toBe(2);
      expect(results[0].length).toBe(0); // Empty sub-stream (no chunks yielded when split at 0)
      expect(new TextDecoder().decode(results[1][0])).toBe("abc");
    });

    it("handles consecutive delimiters in separate blocks", async () => {
      const input = fromArray([encode("|"), encode("|"), encode("|")]);

      const parts = await collectSplitStreamAsStrings(
        splitStream(input, (block) => {
          const idx = block.indexOf(124); // | character
          return idx >= 0 ? idx + 1 : -1;
        }),
      );

      expect(parts).toEqual(["|", "|", "|", ""]);
    });

    it("handles single byte chunks", async () => {
      const input = fromArray([encode("a"), encode("|"), encode("b")]);
      const parts = await collectSplitStreamAsStrings(
        splitStream(input, (block) => {
          const idx = block.indexOf(124);
          return idx >= 0 ? idx + 1 : -1;
        }),
      );

      expect(parts).toEqual(["a|", "b"]);
    });

    it("handles delimiter at very end of single block", async () => {
      const input = fromArray([encode("abc|")]);
      const parts = await collectSplitStreamAsStrings(
        splitStream(input, (block) => {
          const idx = block.indexOf(124);
          return idx >= 0 ? idx + 1 : -1;
        }),
      );

      expect(parts).toEqual(["abc|", ""]);
    });

    it("handles delimiter at very start of single block", async () => {
      const input = fromArray([encode("|abc")]);
      const parts = await collectSplitStreamAsStrings(
        splitStream(input, (block) => {
          const idx = block.indexOf(124);
          return idx >= 0 ? idx + 1 : -1;
        }),
      );

      expect(parts).toEqual(["|", "abc"]);
    });

    it("split function can use complex logic with multiple blocks", async () => {
      // Split on double newlines (paragraph separator), with separate blocks
      const input = fromArray([encode("para1\n\n"), encode("para2\n\n"), encode("para3")]);
      const parts = await collectSplitStreamAsStrings(
        splitStream(input, (block) => {
          const text = new TextDecoder().decode(block);
          const idx = text.indexOf("\n\n");
          return idx >= 0 ? idx + 2 : -1;
        }),
      );

      expect(parts).toEqual(["para1\n\n", "para2\n\n", "para3"]);
    });

    it("remainder from split is re-split", async () => {
      const splitCalls: string[] = [];
      const input = fromArray([encode("abc|def")]);

      await collectSplitStream(
        splitStream(input, (block) => {
          splitCalls.push(new TextDecoder().decode(block));
          const idx = block.indexOf(124);
          return idx >= 0 ? idx + 1 : -1;
        }),
      );

      // Split function is called on original block AND remainder "def"
      expect(splitCalls).toEqual(["abc|def", "def"]);
    });

    it("handles empty input blocks", async () => {
      const input = fromArray([new Uint8Array(0), encode("hello"), new Uint8Array(0)]);
      const results = await collectSplitStream(splitStream(input, () => -1));
      expect(results.length).toBe(1);
      // Empty blocks are still yielded
      expect(results[0].length).toBe(3);
      expect(results[0][0].length).toBe(0);
      expect(new TextDecoder().decode(results[0][1])).toBe("hello");
      expect(results[0][2].length).toBe(0);
    });
  });

  describe("readHeader", () => {
    it("reads header from empty stream", async () => {
      async function* empty(): AsyncIterable<Uint8Array> {}
      const [header, rest] = await readHeader(empty(), () => -1);
      expect(header).toEqual(new Uint8Array(0));
      const remaining = await collect(rest);
      expect(remaining).toEqual(new Uint8Array(0));
    });

    it("reads header when no delimiter found", async () => {
      const input = fromArray([encode("no delimiter here")]);
      const [header, rest] = await readHeader(input, () => -1);
      expect(new TextDecoder().decode(header)).toBe("no delimiter here");
      const remaining = await collect(rest);
      expect(remaining).toEqual(new Uint8Array(0));
    });

    it("reads header with delimiter in single chunk", async () => {
      const input = fromArray([encode("header\0body data")]);
      const [header, rest] = await readHeader(input, (block) => {
        const idx = block.indexOf(0); // null byte
        return idx >= 0 ? idx + 1 : -1;
      });
      expect(new TextDecoder().decode(header)).toBe("header\0");
      const remaining = await collect(rest);
      expect(new TextDecoder().decode(remaining)).toBe("body data");
    });

    it("reads header with delimiter at chunk boundary", async () => {
      const input = fromArray([encode("header"), encode("\0"), encode("body")]);
      const [header, rest] = await readHeader(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });
      expect(new TextDecoder().decode(header)).toBe("header\0");
      const remaining = await collect(rest);
      expect(new TextDecoder().decode(remaining)).toBe("body");
    });

    it("reads header split across chunks", async () => {
      const input = fromArray([encode("hea"), encode("der\0bo"), encode("dy")]);
      const [header, rest] = await readHeader(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });
      expect(new TextDecoder().decode(header)).toBe("header\0");
      const remaining = await collect(rest);
      expect(new TextDecoder().decode(remaining)).toBe("body");
    });

    it("reads empty header when delimiter is at start", async () => {
      const input = fromArray([encode("\0body data")]);
      const [header, rest] = await readHeader(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });
      expect(new TextDecoder().decode(header)).toBe("\0");
      const remaining = await collect(rest);
      expect(new TextDecoder().decode(remaining)).toBe("body data");
    });

    it("reads header when delimiter is at end", async () => {
      const input = fromArray([encode("header\0")]);
      const [header, rest] = await readHeader(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });
      expect(new TextDecoder().decode(header)).toBe("header\0");
      const remaining = await collect(rest);
      expect(remaining).toEqual(new Uint8Array(0));
    });

    it("reads header with newline delimiter", async () => {
      const input = fromArray([encode("Content-Type: text/plain\n\nBody content")]);
      const [header, rest] = await readHeader(input, (block) => {
        const idx = block.indexOf(10); // \n
        return idx >= 0 ? idx + 1 : -1;
      });
      expect(new TextDecoder().decode(header)).toBe("Content-Type: text/plain\n");
      const remaining = await collect(rest);
      expect(new TextDecoder().decode(remaining)).toBe("\nBody content");
    });

    it("reads header with multi-byte delimiter pattern", async () => {
      // Find \r\n\r\n (HTTP header separator)
      const input = fromArray([encode("HTTP/1.1 200 OK\r\n\r\nResponse body")]);
      const [header, rest] = await readHeader(input, (block) => {
        const text = new TextDecoder().decode(block);
        const idx = text.indexOf("\r\n\r\n");
        return idx >= 0 ? idx + 4 : -1;
      });
      expect(new TextDecoder().decode(header)).toBe("HTTP/1.1 200 OK\r\n\r\n");
      const remaining = await collect(rest);
      expect(new TextDecoder().decode(remaining)).toBe("Response body");
    });

    it("handles binary header data", async () => {
      const headerBytes = new Uint8Array([0x01, 0x02, 0x03, 0xff]); // 0xff as delimiter
      const bodyBytes = new Uint8Array([0x04, 0x05, 0x06]);
      const combined = new Uint8Array([...headerBytes, ...bodyBytes]);
      const input = fromArray([combined]);

      const [header, rest] = await readHeader(input, (block) => {
        const idx = block.indexOf(0xff);
        return idx >= 0 ? idx + 1 : -1;
      });
      expect(header).toEqual(new Uint8Array([0x01, 0x02, 0x03, 0xff]));
      const remaining = await collect(rest);
      expect(remaining).toEqual(new Uint8Array([0x04, 0x05, 0x06]));
    });

    it("reads header from many small chunks", async () => {
      // Split "header\0body" into individual bytes
      const text = "header\0body";
      const chunks = text.split("").map((c) => encode(c));
      const input = fromArray(chunks);

      const [header, rest] = await readHeader(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });
      expect(new TextDecoder().decode(header)).toBe("header\0");
      const remaining = await collect(rest);
      expect(new TextDecoder().decode(remaining)).toBe("body");
    });

    it("reads large header", async () => {
      const largeHeader = `${"x".repeat(10000)}\0`;
      const body = "body";
      const input = fromArray([encode(largeHeader + body)]);

      const [header, rest] = await readHeader(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });
      expect(new TextDecoder().decode(header)).toBe(largeHeader);
      const remaining = await collect(rest);
      expect(new TextDecoder().decode(remaining)).toBe(body);
    });

    it("reads header with large body", async () => {
      const headerText = "header\0";
      const largeBody = "x".repeat(10000);
      const input = fromArray([encode(headerText + largeBody)]);

      const [header, rest] = await readHeader(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });
      expect(new TextDecoder().decode(header)).toBe(headerText);
      const remaining = await collect(rest);
      expect(new TextDecoder().decode(remaining)).toBe(largeBody);
    });

    it("remaining iterator can be consumed lazily", async () => {
      let chunksRead = 0;
      async function* countingInput(): AsyncIterable<Uint8Array> {
        chunksRead++;
        yield encode("header\0");
        chunksRead++;
        yield encode("chunk1");
        chunksRead++;
        yield encode("chunk2");
      }

      const [header, rest] = await readHeader(countingInput(), (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });

      expect(new TextDecoder().decode(header)).toBe("header\0");
      // Only header chunk should be read so far
      expect(chunksRead).toBe(1);

      // Now consume the rest
      const remaining = await collect(rest);
      expect(new TextDecoder().decode(remaining)).toBe("chunk1chunk2");
      expect(chunksRead).toBe(3);
    });

    it("handles git object format (type size\\0content)", async () => {
      // Git object format: "blob 13\0Hello, World!"
      const input = fromArray([encode("blob 13\0Hello, World!")]);

      const [header, rest] = await readHeader(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });
      expect(new TextDecoder().decode(header)).toBe("blob 13\0");
      const remaining = await collect(rest);
      expect(new TextDecoder().decode(remaining)).toBe("Hello, World!");
    });
  });

  describe("readAhead", () => {
    it("reads ahead from empty stream", async () => {
      async function* empty(): AsyncIterable<Uint8Array> {}
      const [header, stream] = await readAhead(empty(), () => -1);
      expect(header).toEqual(new Uint8Array(0));
      const allData = await collect(stream);
      expect(allData).toEqual(new Uint8Array(0));
    });

    it("returns header and combined stream with full data", async () => {
      const input = fromArray([encode("header\0body data")]);
      const [header, stream] = await readAhead(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });

      expect(new TextDecoder().decode(header)).toBe("header\0");
      // Combined stream should contain header + body
      const allData = await collect(stream);
      expect(new TextDecoder().decode(allData)).toBe("header\0body data");
    });

    it("stream yields header first, then rest", async () => {
      const input = fromArray([encode("header\0body")]);
      const [header, stream] = await readAhead(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });

      expect(new TextDecoder().decode(header)).toBe("header\0");

      // Collect chunks individually to verify order
      const chunks = await toArray(stream);
      expect(chunks.length).toBe(2);
      expect(new TextDecoder().decode(chunks[0])).toBe("header\0");
      expect(new TextDecoder().decode(chunks[1])).toBe("body");
    });

    it("handles no delimiter - entire input becomes header", async () => {
      const input = fromArray([encode("no delimiter here")]);
      const [header, stream] = await readAhead(input, () => -1);

      expect(new TextDecoder().decode(header)).toBe("no delimiter here");
      const allData = await collect(stream);
      expect(new TextDecoder().decode(allData)).toBe("no delimiter here");
    });

    it("handles delimiter at end - no body", async () => {
      const input = fromArray([encode("header\0")]);
      const [header, stream] = await readAhead(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });

      expect(new TextDecoder().decode(header)).toBe("header\0");
      const allData = await collect(stream);
      expect(new TextDecoder().decode(allData)).toBe("header\0");
    });

    it("handles multiple chunks", async () => {
      const input = fromArray([encode("hea"), encode("der\0bo"), encode("dy")]);
      const [header, stream] = await readAhead(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });

      expect(new TextDecoder().decode(header)).toBe("header\0");
      const allData = await collect(stream);
      expect(new TextDecoder().decode(allData)).toBe("header\0body");
    });

    it("handles binary data", async () => {
      const headerBytes = new Uint8Array([0x01, 0x02, 0xff]);
      const bodyBytes = new Uint8Array([0x03, 0x04]);
      const input = fromArray([new Uint8Array([...headerBytes, ...bodyBytes])]);

      const [header, stream] = await readAhead(input, (block) => {
        const idx = block.indexOf(0xff);
        return idx >= 0 ? idx + 1 : -1;
      });

      expect(header).toEqual(new Uint8Array([0x01, 0x02, 0xff]));
      const allData = await collect(stream);
      expect(allData).toEqual(new Uint8Array([0x01, 0x02, 0xff, 0x03, 0x04]));
    });

    it("can peek header and still process full stream", async () => {
      // Simulate peeking at a git object header
      const input = fromArray([encode("blob 13\0Hello, World!")]);

      const [header, stream] = await readAhead(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });

      // Parse header to get type and size
      const headerText = new TextDecoder().decode(header);
      const [type, sizeStr] = headerText.slice(0, -1).split(" ");
      expect(type).toBe("blob");
      expect(sizeStr).toBe("13");

      // Still have access to full stream for further processing
      const allData = await collect(stream);
      expect(new TextDecoder().decode(allData)).toBe("blob 13\0Hello, World!");
    });

    it("stream can be consumed lazily", async () => {
      let chunksRead = 0;
      async function* countingInput(): AsyncIterable<Uint8Array> {
        chunksRead++;
        yield encode("header\0");
        chunksRead++;
        yield encode("chunk1");
        chunksRead++;
        yield encode("chunk2");
      }

      const [header, stream] = await readAhead(countingInput(), (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });

      expect(new TextDecoder().decode(header)).toBe("header\0");
      expect(chunksRead).toBe(1); // Only header chunk read so far

      // Now consume the stream
      const allData = await collect(stream);
      expect(new TextDecoder().decode(allData)).toBe("header\0chunk1chunk2");
      expect(chunksRead).toBe(3);
    });

    it("handles empty header when delimiter at start", async () => {
      const input = fromArray([encode("\0body")]);
      const [header, stream] = await readAhead(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });

      expect(new TextDecoder().decode(header)).toBe("\0");
      const allData = await collect(stream);
      expect(new TextDecoder().decode(allData)).toBe("\0body");
    });

    it("handles large header and body", async () => {
      const largeHeader = `${"x".repeat(5000)}\0`;
      const largeBody = "y".repeat(5000);
      const input = fromArray([encode(largeHeader + largeBody)]);

      const [header, stream] = await readAhead(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });

      expect(new TextDecoder().decode(header)).toBe(largeHeader);
      const allData = await collect(stream);
      expect(new TextDecoder().decode(allData)).toBe(largeHeader + largeBody);
    });

    it("stream iterator can be used with for-await", async () => {
      const input = fromArray([encode("header\0body1"), encode("body2")]);
      const [header, stream] = await readAhead(input, (block) => {
        const idx = block.indexOf(0);
        return idx >= 0 ? idx + 1 : -1;
      });

      expect(new TextDecoder().decode(header)).toBe("header\0");

      const parts: string[] = [];
      for await (const chunk of stream) {
        parts.push(new TextDecoder().decode(chunk));
      }
      expect(parts.join("")).toBe("header\0body1body2");
    });
  });

  describe("newSplitter", () => {
    it("finds single-byte delimiter in single block", () => {
      const detector = newSplitter(new Uint8Array([0]));
      const result = detector(encode("header\0body"));
      expect(result).toBe(7); // Position after the null byte
    });

    it("returns -1 when delimiter not found", () => {
      const detector = newSplitter(new Uint8Array([0]));
      const result = detector(encode("no delimiter here"));
      expect(result).toBe(-1);
    });

    it("finds multi-byte delimiter in single block", () => {
      const detector = newSplitter(new Uint8Array([13, 10, 13, 10])); // \r\n\r\n
      const result = detector(encode("HTTP/1.1 200 OK\r\n\r\nBody"));
      expect(result).toBe(19); // Position after \r\n\r\n
    });

    it("finds delimiter at start of block", () => {
      const detector = newSplitter(new Uint8Array([0]));
      const result = detector(encode("\0body"));
      expect(result).toBe(1);
    });

    it("finds delimiter at end of block", () => {
      const detector = newSplitter(new Uint8Array([0]));
      const result = detector(encode("header\0"));
      expect(result).toBe(7);
    });

    it("finds delimiter spanning two blocks", () => {
      const detector = newSplitter(new Uint8Array([1, 2, 3, 4]));

      // First block ends with [1, 2]
      const result1 = detector(new Uint8Array([0, 1, 2]));
      expect(result1).toBe(-1);

      // Second block starts with [3, 4]
      const result2 = detector(new Uint8Array([3, 4, 5]));
      expect(result2).toBe(2); // Delimiter ends at position 2 in second block
    });

    it("finds delimiter spanning three blocks", () => {
      const detector = newSplitter(new Uint8Array([1, 2, 3, 4]));

      const result1 = detector(new Uint8Array([0, 1]));
      expect(result1).toBe(-1);

      const result2 = detector(new Uint8Array([2, 3]));
      expect(result2).toBe(-1);

      const result3 = detector(new Uint8Array([4, 5]));
      expect(result3).toBe(1); // Delimiter ends at position 1 in third block
    });

    it("finds delimiter spanning four blocks (one byte per block)", () => {
      const detector = newSplitter(new Uint8Array([1, 2, 3, 4]));

      expect(detector(new Uint8Array([1]))).toBe(-1);
      expect(detector(new Uint8Array([2]))).toBe(-1);
      expect(detector(new Uint8Array([3]))).toBe(-1);
      expect(detector(new Uint8Array([4]))).toBe(1);
    });

    it("handles false start then real match", () => {
      // Delimiter is [1, 1, 2]
      // Block has [1, 1, 1, 2] - first [1, 1] is false start
      const detector = newSplitter(new Uint8Array([1, 1, 2]));
      const result = detector(new Uint8Array([1, 1, 1, 2, 5]));
      expect(result).toBe(4); // Match at positions 1-3, ends at 4
    });

    it("handles false start across blocks then real match", () => {
      const detector = newSplitter(new Uint8Array([1, 1, 2]));

      // Block 1: [1, 1, 1] - partial match at end
      const result1 = detector(new Uint8Array([1, 1, 1]));
      expect(result1).toBe(-1);

      // Block 2: [2, 0] - completes the match
      const result2 = detector(new Uint8Array([2, 0]));
      expect(result2).toBe(1);
    });

    it("resets state after finding delimiter", () => {
      const detector = newSplitter(new Uint8Array([0]));

      const result1 = detector(encode("first\0"));
      expect(result1).toBe(6);

      // After reset, should work for next search
      const result2 = detector(encode("second\0"));
      expect(result2).toBe(7);
    });

    it("handles empty blocks", () => {
      const detector = newSplitter(new Uint8Array([1, 2]));

      expect(detector(new Uint8Array([]))).toBe(-1);
      expect(detector(new Uint8Array([1]))).toBe(-1);
      expect(detector(new Uint8Array([]))).toBe(-1);
      expect(detector(new Uint8Array([2]))).toBe(1);
    });

    it("handles delimiter longer than block", () => {
      const detector = newSplitter(new Uint8Array([1, 2, 3, 4, 5]));

      expect(detector(new Uint8Array([1, 2]))).toBe(-1);
      expect(detector(new Uint8Array([3, 4]))).toBe(-1);
      expect(detector(new Uint8Array([5, 6]))).toBe(1);
    });

    it("handles single-byte blocks with long delimiter", () => {
      const detector = newSplitter(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));

      // Feed one byte at a time
      for (let i = 1; i <= 7; i++) {
        expect(detector(new Uint8Array([i]))).toBe(-1);
      }
      expect(detector(new Uint8Array([8]))).toBe(1);
    });

    it("handles single-byte blocks with data before delimiter", () => {
      const detector = newSplitter(new Uint8Array([1, 2, 3]));

      // Some prefix data
      expect(detector(new Uint8Array([0]))).toBe(-1);
      expect(detector(new Uint8Array([0]))).toBe(-1);
      // Now the delimiter one byte at a time
      expect(detector(new Uint8Array([1]))).toBe(-1);
      expect(detector(new Uint8Array([2]))).toBe(-1);
      expect(detector(new Uint8Array([3]))).toBe(1);
    });

    it("handles tiny blocks with false starts", () => {
      // Delimiter [1, 2, 3] - feed [1, 1, 1, 2, 3] one byte at a time
      const detector = newSplitter(new Uint8Array([1, 2, 3]));

      expect(detector(new Uint8Array([1]))).toBe(-1); // Start of false match
      expect(detector(new Uint8Array([1]))).toBe(-1); // Restart
      expect(detector(new Uint8Array([1]))).toBe(-1); // Restart again
      expect(detector(new Uint8Array([2]))).toBe(-1); // Now partial [1, 2]
      expect(detector(new Uint8Array([3]))).toBe(1); // Complete!
    });

    it("handles mixed block sizes smaller and larger than delimiter", () => {
      const detector = newSplitter(new Uint8Array([1, 2, 3, 4]));

      // Single byte
      expect(detector(new Uint8Array([0]))).toBe(-1);
      // Two bytes with partial match start
      expect(detector(new Uint8Array([1, 2]))).toBe(-1);
      // Single byte continuing match
      expect(detector(new Uint8Array([3]))).toBe(-1);
      // Larger block completing match
      expect(detector(new Uint8Array([4, 5, 6, 7, 8]))).toBe(1);
    });

    it("handles blocks smaller than delimiter with match at various positions", () => {
      const detector = newSplitter(new Uint8Array([0xaa, 0xbb, 0xcc]));

      // Feed 2-byte blocks: [01, 02], [AA, BB], [CC, DD]
      expect(detector(new Uint8Array([0x01, 0x02]))).toBe(-1);
      expect(detector(new Uint8Array([0xaa, 0xbb]))).toBe(-1);
      expect(detector(new Uint8Array([0xcc, 0xdd]))).toBe(1);
    });

    it("handles very long delimiter with tiny blocks", () => {
      // 16-byte delimiter, 2-byte blocks
      const delimiter = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
      const detector = newSplitter(delimiter);

      for (let i = 0; i < 8; i++) {
        const block = new Uint8Array([i * 2 + 1, i * 2 + 2]);
        if (i < 7) {
          expect(detector(block)).toBe(-1);
        } else {
          expect(detector(block)).toBe(2); // Last block completes the match
        }
      }
    });

    it("handles blocks smaller than delimiter with partial match reset", () => {
      // Delimiter [1, 2, 3, 4], blocks of 2
      const detector = newSplitter(new Uint8Array([1, 2, 3, 4]));

      // Partial match [1, 2]
      expect(detector(new Uint8Array([1, 2]))).toBe(-1);
      // Next block doesn't continue - resets
      expect(detector(new Uint8Array([5, 6]))).toBe(-1);
      // New partial match [1, 2]
      expect(detector(new Uint8Array([1, 2]))).toBe(-1);
      // Continue with [3, 4]
      expect(detector(new Uint8Array([3, 4]))).toBe(2);
    });

    it("works with CRLF CRLF delimiter", () => {
      const detector = newSplitter(new Uint8Array([13, 10, 13, 10]));

      // Split \r\n\r\n across blocks
      expect(detector(encode("Header\r"))).toBe(-1);
      expect(detector(encode("\n"))).toBe(-1);
      expect(detector(encode("\r"))).toBe(-1);
      expect(detector(encode("\nBody"))).toBe(1);
    });

    it("finds first occurrence when multiple delimiters present", () => {
      const detector = newSplitter(new Uint8Array([0]));
      const result = detector(encode("a\0b\0c"));
      expect(result).toBe(2); // First null byte
    });

    it("works with binary delimiter", () => {
      const detector = newSplitter(new Uint8Array([0xff, 0xfe]));

      expect(detector(new Uint8Array([0x01, 0xff]))).toBe(-1);
      expect(detector(new Uint8Array([0xfe, 0x02]))).toBe(1);
    });

    it("handles partial match that doesn't complete", () => {
      const detector = newSplitter(new Uint8Array([1, 2, 3]));

      // Start a partial match
      expect(detector(new Uint8Array([0, 1, 2]))).toBe(-1);

      // Next block doesn't continue the match
      expect(detector(new Uint8Array([4, 5, 6]))).toBe(-1);

      // Real match in next block
      expect(detector(new Uint8Array([1, 2, 3, 7]))).toBe(3);
    });

    it("integrates with readHeader for cross-block delimiter", async () => {
      const detector = newSplitter(new Uint8Array([13, 10, 13, 10]));
      const input = fromArray([
        encode("HTTP/1.1 200 OK\r"),
        encode("\n\r"),
        encode("\nBody content"),
      ]);

      const [header, rest] = await readHeader(input, detector);
      expect(new TextDecoder().decode(header)).toBe("HTTP/1.1 200 OK\r\n\r\n");
      const body = await collect(rest);
      expect(new TextDecoder().decode(body)).toBe("Body content");
    });

    it("integrates with readHeader for git object format", async () => {
      const detector = newSplitter(new Uint8Array([0]));
      const input = fromArray([encode("blob "), encode("13"), encode("\0Hello, World!")]);

      const [header, rest] = await readHeader(input, detector);
      expect(new TextDecoder().decode(header)).toBe("blob 13\0");
      const body = await collect(rest);
      expect(new TextDecoder().decode(body)).toBe("Hello, World!");
    });
  });

  describe("newByteSplitter", () => {
    it("finds single byte delimiter in block", () => {
      const splitter = newByteSplitter(0);
      const result = splitter(encode("header\0body"));
      expect(result).toBe(7); // Position after the null byte
    });

    it("returns -1 when delimiter not found", () => {
      const splitter = newByteSplitter(0);
      const result = splitter(encode("no delimiter here"));
      expect(result).toBe(-1);
    });

    it("finds delimiter at start of block", () => {
      const splitter = newByteSplitter(0);
      const result = splitter(encode("\0body"));
      expect(result).toBe(1);
    });

    it("finds delimiter at end of block", () => {
      const splitter = newByteSplitter(0);
      const result = splitter(encode("header\0"));
      expect(result).toBe(7);
    });

    it("finds first occurrence when multiple delimiters present", () => {
      const splitter = newByteSplitter(0);
      const result = splitter(encode("a\0b\0c"));
      expect(result).toBe(2); // First null byte
    });

    it("works with newline delimiter", () => {
      const splitter = newByteSplitter(10); // \n
      const result = splitter(encode("line1\nline2"));
      expect(result).toBe(6);
    });

    it("works with pipe delimiter", () => {
      const splitter = newByteSplitter(124); // |
      const result = splitter(encode("first|second"));
      expect(result).toBe(6);
    });

    it("handles binary data with 0xff delimiter", () => {
      const splitter = newByteSplitter(0xff);
      const result = splitter(new Uint8Array([0x01, 0x02, 0xff, 0x03]));
      expect(result).toBe(3);
    });

    it("handles empty block", () => {
      const splitter = newByteSplitter(0);
      const result = splitter(new Uint8Array(0));
      expect(result).toBe(-1);
    });

    it("handles single-byte block with delimiter", () => {
      const splitter = newByteSplitter(0);
      const result = splitter(new Uint8Array([0]));
      expect(result).toBe(1);
    });

    it("handles single-byte block without delimiter", () => {
      const splitter = newByteSplitter(0);
      const result = splitter(new Uint8Array([1]));
      expect(result).toBe(-1);
    });

    it("is stateless - can be called on independent blocks", () => {
      const splitter = newByteSplitter(0);

      // Unlike newSplitter, newByteSplitter is stateless
      expect(splitter(encode("first\0"))).toBe(6);
      expect(splitter(encode("second\0"))).toBe(7);
      expect(splitter(encode("no match"))).toBe(-1);
      expect(splitter(encode("\0start"))).toBe(1);
    });

    it("behaves same as newSplitter([byte]) for single block", () => {
      const byteSplitter = newByteSplitter(0);
      const arraySplitter = newSplitter(new Uint8Array([0]));

      const testBlocks = [
        encode("header\0body"),
        encode("no delimiter"),
        encode("\0start"),
        encode("end\0"),
        new Uint8Array([0x01, 0x00, 0x02]),
        new Uint8Array(0),
      ];

      for (const block of testBlocks) {
        expect(byteSplitter(block)).toBe(arraySplitter(block));
        // Reset arraySplitter by creating new instance for each block
        // since newSplitter is stateful
      }
    });

    it("integrates with splitStream", async () => {
      const input = fromArray([encode("a|b|c")]);
      const splitter = newByteSplitter(124); // |

      // With always-re-split behavior, all delimiters are found
      const parts = await collectSplitStreamAsStrings(splitStream(input, splitter));
      expect(parts).toEqual(["a|", "b|", "c"]);
    });

    it("integrates with readHeader", async () => {
      const input = fromArray([encode("header\0body content")]);
      const splitter = newByteSplitter(0);

      const [header, rest] = await readHeader(input, splitter);
      expect(new TextDecoder().decode(header)).toBe("header\0");
      const body = await collect(rest);
      expect(new TextDecoder().decode(body)).toBe("body content");
    });

    it("integrates with readHeader for git object format", async () => {
      const input = fromArray([encode("blob 13\0Hello, World!")]);
      const splitter = newByteSplitter(0);

      const [header, rest] = await readHeader(input, splitter);
      expect(new TextDecoder().decode(header)).toBe("blob 13\0");
      const body = await collect(rest);
      expect(new TextDecoder().decode(body)).toBe("Hello, World!");
    });
  });
});
