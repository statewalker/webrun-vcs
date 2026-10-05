/**
 * Tests for FileVolatileStore
 */

import { createInMemoryFilesApi, type FilesApi } from "@statewalker/vcs-core";
import { collect } from "@statewalker/vcs-utils";
import { beforeEach, describe, expect, it } from "vitest";
import { FileVolatileStore } from "../../../src/storage/binary/volatile-store.files.js";

describe("FileVolatileStore", () => {
  let files: FilesApi;
  let store: FileVolatileStore;
  const tempDir = "/tmp/volatile";

  const encoder = new TextEncoder();

  beforeEach(() => {
    files = createInMemoryFilesApi();
    store = new FileVolatileStore(files, tempDir);
  });

  async function* chunks(...strings: string[]): AsyncIterable<Uint8Array> {
    for (const s of strings) {
      yield encoder.encode(s);
    }
  }

  describe("store", () => {
    it("stores content and reports correct size", async () => {
      const content = await store.store(chunks("Hello", " ", "World"));
      expect(content.size).toBe(11);
    });

    it("stores empty content", async () => {
      const content = await store.store(chunks());
      expect(content.size).toBe(0);
    });

    it("stores large content", async () => {
      const largeChunk = new Uint8Array(1024 * 1024).fill(42);

      async function* largeContent(): AsyncIterable<Uint8Array> {
        yield largeChunk;
      }

      const content = await store.store(largeContent());
      expect(content.size).toBe(1024 * 1024);
    });

    it("computes size correctly for multiple chunks", async () => {
      const content = await store.store(chunks("a", "bb", "ccc", "dddd"));
      expect(content.size).toBe(10); // 1 + 2 + 3 + 4
    });
  });

  describe("read", () => {
    it("reads stored content back", async () => {
      const content = await store.store(chunks("Hello", " ", "World"));

      const result = await collect(content.read());
      const text = new TextDecoder().decode(result);

      expect(text).toBe("Hello World");
    });

    it("allows multiple reads", async () => {
      const content = await store.store(chunks("Test"));

      const read1 = await collect(content.read());
      const read2 = await collect(content.read());
      const read3 = await collect(content.read());

      expect(new TextDecoder().decode(read1)).toBe("Test");
      expect(new TextDecoder().decode(read2)).toBe("Test");
      expect(new TextDecoder().decode(read3)).toBe("Test");
    });

    it("preserves binary data", async () => {
      const binaryData = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x42]);

      async function* binaryContent(): AsyncIterable<Uint8Array> {
        yield binaryData;
      }

      const content = await store.store(binaryContent());
      const result = await collect(content.read());

      expect(Array.from(result)).toEqual([0x00, 0x01, 0xff, 0xfe, 0x42]);
    });

    it("throws after dispose", async () => {
      const content = await store.store(chunks("Test"));

      await content.dispose();

      await expect(async () => {
        await collect(content.read());
      }).rejects.toThrow("VolatileContent already disposed");
    });
  });

  describe("dispose", () => {
    it("can be called multiple times", async () => {
      const content = await store.store(chunks("Test"));

      await content.dispose();
      await content.dispose(); // Should not throw
    });

    it("removes temp file on dispose", async () => {
      const content = await store.store(chunks("Test"));

      // Find temp file
      let tempFilePath: string | undefined;
      for await (const entry of files.list(tempDir)) {
        tempFilePath = `${tempDir}/${entry.name}`;
        break;
      }
      expect(tempFilePath).toBeDefined();
      if (!tempFilePath) {
        throw new Error("tempFilePath should be defined");
      }

      // Verify file exists before dispose
      const statsBefore = await files.stats(tempFilePath);
      expect(statsBefore).toBeDefined();

      await content.dispose();

      // Verify file is removed after dispose
      const statsAfter = await files.stats(tempFilePath);
      expect(statsAfter).toBeUndefined();
    });
  });

  describe("sync iterable support", () => {
    it("stores sync iterable content", async () => {
      const data = [encoder.encode("Hello"), encoder.encode(" World")];

      const content = await store.store(data);
      expect(content.size).toBe(11);

      const result = await collect(content.read());
      expect(new TextDecoder().decode(result)).toBe("Hello World");
    });

    it("stores single Uint8Array wrapped in array", async () => {
      const data = [encoder.encode("Test")];

      const content = await store.store(data);
      expect(content.size).toBe(4);
    });

    it("stores empty sync iterable", async () => {
      const content = await store.store([]);
      expect(content.size).toBe(0);
    });

    it("stores generator function (sync)", async () => {
      function* syncChunks(): Iterable<Uint8Array> {
        yield encoder.encode("AAA");
        yield encoder.encode("BBB");
      }

      const content = await store.store(syncChunks());
      expect(content.size).toBe(6);

      const result = await collect(content.read());
      expect(new TextDecoder().decode(result)).toBe("AAABBB");
    });
  });

  describe("multiple stores", () => {
    it("handles multiple independent stores", async () => {
      const content1 = await store.store(chunks("First"));
      const content2 = await store.store(chunks("Second"));
      const content3 = await store.store(chunks("Third"));

      expect(content1.size).toBe(5);
      expect(content2.size).toBe(6);
      expect(content3.size).toBe(5);

      const text1 = new TextDecoder().decode(await collect(content1.read()));
      const text2 = new TextDecoder().decode(await collect(content2.read()));
      const text3 = new TextDecoder().decode(await collect(content3.read()));

      expect(text1).toBe("First");
      expect(text2).toBe("Second");
      expect(text3).toBe("Third");
    });

    it("disposing one does not affect others", async () => {
      const content1 = await store.store(chunks("First"));
      const content2 = await store.store(chunks("Second"));

      await content1.dispose();

      // content2 should still work
      const text2 = new TextDecoder().decode(await collect(content2.read()));
      expect(text2).toBe("Second");

      // content1 should throw
      await expect(async () => {
        await collect(content1.read());
      }).rejects.toThrow();
    });
  });

  describe("temp directory", () => {
    it("creates temp directory if it does not exist", async () => {
      const newTempDir = "/new/temp/dir";
      const newStore = new FileVolatileStore(files, newTempDir);

      await newStore.store(chunks("content"));

      const stats = await files.stats(newTempDir);
      expect(stats?.kind).toBe("directory");
    });

    it("uses unique filenames for each store", async () => {
      await store.store(chunks("First"));
      await store.store(chunks("Second"));

      const entries: string[] = [];
      for await (const entry of files.list(tempDir)) {
        entries.push(entry.name);
      }

      expect(entries).toHaveLength(2);
      expect(new Set(entries).size).toBe(2); // All unique
    });
  });
});
