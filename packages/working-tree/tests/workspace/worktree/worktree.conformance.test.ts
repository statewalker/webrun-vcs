import { FileMode } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Worktree, WorktreeEntry } from "../../../src/worktree/worktree.js";

// This file exports a conformance test factory, not direct tests.
// Implementations use worktreeConformanceTests() to run tests.
describe("Worktree conformance test factory", () => {
  it("exports conformance test function", () => {
    expect(typeof worktreeConformanceTests).toBe("function");
  });
});

/**
 * Conformance test suite for Worktree implementations
 *
 * Run these tests against any Worktree implementation to verify
 * it correctly implements the interface contract.
 */
export function worktreeConformanceTests(
  name: string,
  createWorktree: () => Promise<Worktree>,
  cleanup: () => Promise<void>,
) {
  describe(`${name} Worktree conformance`, () => {
    let worktree: Worktree;

    beforeEach(async () => {
      worktree = await createWorktree();
    });

    afterEach(async () => {
      await cleanup();
    });

    describe("reading", () => {
      it("walk returns empty for empty worktree", async () => {
        const entries: WorktreeEntry[] = [];
        for await (const entry of worktree.walk()) {
          entries.push(entry);
        }
        expect(entries).toHaveLength(0);
      });

      it("exists returns false for non-existent path", async () => {
        expect(await worktree.exists("nonexistent.txt")).toBe(false);
      });

      it("getEntry returns undefined for non-existent path", async () => {
        const entry = await worktree.getEntry("nonexistent.txt");
        expect(entry).toBeUndefined();
      });
    });

    describe("writing", () => {
      it("writeContent creates file", async () => {
        const content = new TextEncoder().encode("Hello, World!");
        await worktree.writeContent("test.txt", content);

        expect(await worktree.exists("test.txt")).toBe(true);

        const entry = await worktree.getEntry("test.txt");
        expect(entry).toBeDefined();
        expect(entry?.isDirectory).toBe(false);
      });

      it("readContent returns written content", async () => {
        const original = "Test content";
        await worktree.writeContent("read-test.txt", new TextEncoder().encode(original));

        const chunks: Uint8Array[] = [];
        for await (const chunk of worktree.readContent("read-test.txt")) {
          chunks.push(chunk);
        }

        const result = concat(chunks);
        expect(new TextDecoder().decode(result)).toBe(original);
      });

      it("writeContent with AsyncIterable", async () => {
        const chunks = [new TextEncoder().encode("Part 1 "), new TextEncoder().encode("Part 2")];

        await worktree.writeContent("async-test.txt", toAsync(chunks));

        const readChunks: Uint8Array[] = [];
        for await (const chunk of worktree.readContent("async-test.txt")) {
          readChunks.push(chunk);
        }

        expect(new TextDecoder().decode(concat(readChunks))).toBe("Part 1 Part 2");
      });

      it("remove deletes file", async () => {
        await worktree.writeContent("to-delete.txt", new TextEncoder().encode("Delete me"));
        expect(await worktree.exists("to-delete.txt")).toBe(true);

        const removed = await worktree.remove("to-delete.txt");
        expect(removed).toBe(true);
        expect(await worktree.exists("to-delete.txt")).toBe(false);
      });

      it("remove returns false for non-existent file", async () => {
        const removed = await worktree.remove("nonexistent.txt");
        expect(removed).toBe(false);
      });

      it("mkdir creates directory", async () => {
        await worktree.mkdir("new-dir");

        const entry = await worktree.getEntry("new-dir");
        expect(entry).toBeDefined();
        expect(entry?.isDirectory).toBe(true);
      });

      it("mkdir recursive creates nested directories", async () => {
        await worktree.mkdir("a/b/c", { recursive: true });

        expect(await worktree.exists("a")).toBe(true);
        expect(await worktree.exists("a/b")).toBe(true);
        expect(await worktree.exists("a/b/c")).toBe(true);
      });

      it("rename moves file", async () => {
        await worktree.writeContent("original.txt", new TextEncoder().encode("Content"));

        await worktree.rename("original.txt", "renamed.txt");

        expect(await worktree.exists("original.txt")).toBe(false);
        expect(await worktree.exists("renamed.txt")).toBe(true);
      });
    });

    describe("walking", () => {
      it("walk returns all files", async () => {
        await worktree.writeContent("file1.txt", new TextEncoder().encode("1"));
        await worktree.writeContent("file2.txt", new TextEncoder().encode("2"));
        await worktree.writeContent("file3.txt", new TextEncoder().encode("3"));

        const entries: WorktreeEntry[] = [];
        for await (const entry of worktree.walk()) {
          entries.push(entry);
        }

        const paths = entries.map((e) => e.path).sort();
        expect(paths).toEqual(["file1.txt", "file2.txt", "file3.txt"]);
      });

      it("walk with pathPrefix filters results", async () => {
        await worktree.mkdir("src", { recursive: true });
        await worktree.writeContent("src/main.ts", new TextEncoder().encode("code"));
        await worktree.writeContent("README.md", new TextEncoder().encode("readme"));

        const entries: WorktreeEntry[] = [];
        for await (const entry of worktree.walk({ pathPrefix: "src" })) {
          entries.push(entry);
        }

        expect(entries).toHaveLength(1);
        expect(entries[0].path).toBe("src/main.ts");
      });

      it("walk with includeDirectories returns directories", async () => {
        await worktree.mkdir("my-dir");
        await worktree.writeContent("my-dir/file.txt", new TextEncoder().encode("content"));

        const entries: WorktreeEntry[] = [];
        for await (const entry of worktree.walk({ includeDirectories: true })) {
          entries.push(entry);
        }

        const dirEntry = entries.find((e) => e.path === "my-dir");
        expect(dirEntry).toBeDefined();
        expect(dirEntry?.isDirectory).toBe(true);
      });
    });

    describe("hashing", () => {
      it("computeHash returns consistent hash", async () => {
        const content = new TextEncoder().encode("Hash me");
        await worktree.writeContent("hash-test.txt", content);

        const hash1 = await worktree.computeHash("hash-test.txt");
        const hash2 = await worktree.computeHash("hash-test.txt");

        expect(hash1).toBe(hash2);
        expect(hash1.length).toBe(40); // SHA-1 hex
      });

      it("computeHash returns different hash for different content", async () => {
        await worktree.writeContent("a.txt", new TextEncoder().encode("Content A"));
        await worktree.writeContent("b.txt", new TextEncoder().encode("Content B"));

        const hashA = await worktree.computeHash("a.txt");
        const hashB = await worktree.computeHash("b.txt");

        expect(hashA).not.toBe(hashB);
      });
    });

    describe("entry properties", () => {
      it("getEntry returns correct mode for regular file", async () => {
        await worktree.writeContent("regular.txt", new TextEncoder().encode("content"), {
          mode: FileMode.REGULAR_FILE,
        });

        const entry = await worktree.getEntry("regular.txt");
        expect(entry).toBeDefined();
        expect(entry?.mode).toBe(FileMode.REGULAR_FILE);
      });

      it("getEntry returns size", async () => {
        const content = "12345678901234567890"; // 20 bytes
        await worktree.writeContent("sized.txt", new TextEncoder().encode(content));

        const entry = await worktree.getEntry("sized.txt");
        expect(entry?.size).toBe(20);
      });
    });

    describe("metadata", () => {
      it("getRoot returns root path", () => {
        const root = worktree.getRoot();
        expect(typeof root).toBe("string");
        expect(root.length).toBeGreaterThan(0);
      });

      it("isIgnored returns false for normal files", async () => {
        await worktree.writeContent("normal.txt", new TextEncoder().encode("content"));
        expect(await worktree.isIgnored("normal.txt")).toBe(false);
      });
    });
  });
}

// Test helpers
function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function* toAsync<T>(items: T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}
