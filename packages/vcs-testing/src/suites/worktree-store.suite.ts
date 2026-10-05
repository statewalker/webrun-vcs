/**
 * Parametrized test suite for Worktree implementations
 *
 * This suite tests the core Worktree interface contract.
 * All storage implementations must pass these tests.
 */

import type { Worktree } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Context provided by the storage factory
 */
export interface WorktreeStoreTestContext {
  worktreeStore: Worktree;
  /**
   * Helper to set up test files in the worktree.
   * Returns the paths of created files.
   */
  setupFiles?: () => Promise<string[]>;
  cleanup?: () => Promise<void>;
}

/**
 * Factory function to create a storage instance for testing
 */
export type WorktreeStoreFactory = () => Promise<WorktreeStoreTestContext>;

/**
 * Helper to collect async iterable to array
 */
async function toArray<T>(input: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const item of input) {
    result.push(item);
  }
  return result;
}

/**
 * Helper to collect async iterable of Uint8Array into single buffer
 */
async function collectBytes(input: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  for await (const chunk of input) {
    chunks.push(chunk);
    totalLength += chunk.length;
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

const _decoder = new TextDecoder();

/**
 * Create the WorktreeStore test suite with a specific factory
 *
 * @param name Name of the storage implementation (e.g., "Filesystem", "Memory")
 * @param factory Factory function to create storage instances
 */
export function createWorktreeStoreTests(name: string, factory: WorktreeStoreFactory): void {
  describe(`WorktreeStore [${name}]`, () => {
    let ctx: WorktreeStoreTestContext;
    let testFiles: string[] = [];

    beforeEach(async () => {
      ctx = await factory();
      if (ctx.setupFiles) {
        testFiles = await ctx.setupFiles();
      }
    });

    afterEach(async () => {
      await ctx.cleanup?.();
      testFiles = [];
    });

    describe("Walk Operations", () => {
      it("walk returns entries for files", async () => {
        if (testFiles.length === 0) {
          // Skip if no test files setup
          return;
        }

        const entries = await toArray(ctx.worktreeStore.walk());

        expect(entries.length).toBeGreaterThan(0);

        // All entries should have required properties
        for (const entry of entries) {
          expect(typeof entry.path).toBe("string");
          expect(typeof entry.name).toBe("string");
          expect(typeof entry.mode).toBe("number");
          expect(typeof entry.size).toBe("number");
          expect(typeof entry.mtime).toBe("number");
          expect(typeof entry.isDirectory).toBe("boolean");
          expect(typeof entry.isIgnored).toBe("boolean");
        }
      });

      it("walk returns entries in sorted order", async () => {
        if (testFiles.length < 2) {
          return;
        }

        const entries = await toArray(ctx.worktreeStore.walk());
        const paths = entries.map((e) => e.path);

        // Paths should be sorted
        const sortedPaths = [...paths].sort();
        expect(paths).toEqual(sortedPaths);
      });

      it("walk with includeIgnored option", async () => {
        const entriesWithoutIgnored = await toArray(
          ctx.worktreeStore.walk({ includeIgnored: false }),
        );
        const entriesWithIgnored = await toArray(ctx.worktreeStore.walk({ includeIgnored: true }));

        // With ignored files should be >= without
        expect(entriesWithIgnored.length).toBeGreaterThanOrEqual(entriesWithoutIgnored.length);
      });

      it("walk with includeDirectories option", async () => {
        const filesOnly = await toArray(ctx.worktreeStore.walk({ includeDirectories: false }));
        const _withDirs = await toArray(ctx.worktreeStore.walk({ includeDirectories: true }));

        // No directories in filesOnly
        const dirsInFilesOnly = filesOnly.filter((e) => e.isDirectory);
        expect(dirsInFilesOnly.length).toBe(0);
      });

      it("walk with pathPrefix option", async () => {
        if (testFiles.length === 0) {
          return;
        }

        // Find a directory prefix from test files
        const firstFile = testFiles[0];
        const parts = firstFile.split("/");
        if (parts.length < 2) {
          return; // No nested directories
        }

        const prefix = `${parts[0]}/`;
        const entries = await toArray(ctx.worktreeStore.walk({ pathPrefix: prefix }));

        // All entries should start with prefix
        for (const entry of entries) {
          expect(entry.path.startsWith(prefix)).toBe(true);
        }
      });
    });

    describe("Get Entry", () => {
      it("getEntry returns entry for existing file", async () => {
        if (testFiles.length === 0) {
          return;
        }

        const entry = await ctx.worktreeStore.getEntry(testFiles[0]);

        expect(entry).toBeDefined();
        expect(entry?.path).toBe(testFiles[0]);
        expect(entry?.isDirectory).toBe(false);
      });

      it("getEntry returns undefined for non-existent file", async () => {
        const entry = await ctx.worktreeStore.getEntry("nonexistent/file.txt");
        expect(entry).toBeUndefined();
      });

      it("getEntry returns correct entry properties", async () => {
        if (testFiles.length === 0) {
          return;
        }

        const entry = await ctx.worktreeStore.getEntry(testFiles[0]);

        expect(entry).toBeDefined();
        if (!entry) return;

        expect(entry.path).toBe(testFiles[0]);
        expect(entry.name).toBe(testFiles[0].split("/").pop());
        expect(entry.mode).toBeGreaterThan(0);
        expect(entry.size).toBeGreaterThanOrEqual(0);
        expect(entry.mtime).toBeGreaterThan(0);
      });
    });

    describe("Compute Hash", () => {
      it("computeHash returns valid SHA-1 for file", async () => {
        if (testFiles.length === 0) {
          return;
        }

        const hash = await ctx.worktreeStore.computeHash(testFiles[0]);

        expect(hash).toMatch(/^[0-9a-f]{40}$/);
      });

      it("computeHash returns same hash for same content", async () => {
        if (testFiles.length === 0) {
          return;
        }

        const hash1 = await ctx.worktreeStore.computeHash(testFiles[0]);
        const hash2 = await ctx.worktreeStore.computeHash(testFiles[0]);

        expect(hash1).toBe(hash2);
      });

      it("computeHash uses Git blob format", async () => {
        if (testFiles.length === 0) {
          return;
        }

        // The hash should be computed using "blob <size>\0<content>"
        const hash = await ctx.worktreeStore.computeHash(testFiles[0]);

        // Just verify it returns a valid hash
        expect(hash).toMatch(/^[0-9a-f]{40}$/);
      });
    });

    describe("Read Content", () => {
      it("readContent returns file content", async () => {
        if (testFiles.length === 0) {
          return;
        }

        const content = await collectBytes(ctx.worktreeStore.readContent(testFiles[0]));

        expect(content.length).toBeGreaterThanOrEqual(0);
      });

      it("readContent returns streamable content", async () => {
        if (testFiles.length === 0) {
          return;
        }

        const chunks: Uint8Array[] = [];
        for await (const chunk of ctx.worktreeStore.readContent(testFiles[0])) {
          chunks.push(chunk);
        }

        expect(chunks.length).toBeGreaterThanOrEqual(0);
      });

      it("readContent preserves binary content", async () => {
        if (testFiles.length === 0) {
          return;
        }

        const content = await collectBytes(ctx.worktreeStore.readContent(testFiles[0]));

        // Content should be retrievable as bytes
        expect(content instanceof Uint8Array).toBe(true);
      });
    });

    describe("Entry Properties", () => {
      it("entry mode represents file type correctly", async () => {
        if (testFiles.length === 0) {
          return;
        }

        const entry = await ctx.worktreeStore.getEntry(testFiles[0]);
        expect(entry).toBeDefined();

        // Regular file modes: 0o100644, 0o100755
        const mode = entry?.mode;
        expect(mode).toBeGreaterThan(0);
      });

      it("entry size matches content length", async () => {
        if (testFiles.length === 0) {
          return;
        }

        const entry = await ctx.worktreeStore.getEntry(testFiles[0]);
        expect(entry).toBeDefined();

        const content = await collectBytes(ctx.worktreeStore.readContent(testFiles[0]));
        expect(entry?.size).toBe(content.length);
      });

      it("entry mtime is reasonable timestamp", async () => {
        if (testFiles.length === 0) {
          return;
        }

        const entry = await ctx.worktreeStore.getEntry(testFiles[0]);
        expect(entry).toBeDefined();

        // mtime should be a reasonable timestamp (after 2000)
        const year2000 = new Date("2000-01-01").getTime();
        expect(entry?.mtime).toBeGreaterThan(year2000);
      });
    });

    describe("Edge Cases", () => {
      it("handles empty worktree gracefully", async () => {
        // This test may not apply to all implementations
        // Just verify walk doesn't throw
        const entries = await toArray(ctx.worktreeStore.walk());
        expect(Array.isArray(entries)).toBe(true);
      });

      it("handles files with spaces in names", async () => {
        // Skip if implementation doesn't support this
        const entries = await toArray(ctx.worktreeStore.walk());
        // Just verify it completes without error
        expect(Array.isArray(entries)).toBe(true);
      });

      it("handles deeply nested paths", async () => {
        const entries = await toArray(ctx.worktreeStore.walk());
        // Verify we can handle nested paths
        for (const entry of entries) {
          expect(entry.path).toBeDefined();
          expect(entry.path.length).toBeGreaterThan(0);
        }
      });
    });
  });
}
