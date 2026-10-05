import { FileMode } from "@statewalker/vcs-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IndexEntry, Staging } from "../../../src/staging/staging.js";

// This file exports a conformance test factory, not direct tests.
// Implementations use stagingConformanceTests() to run tests.
describe("Staging conformance test factory", () => {
  it("exports conformance test function", () => {
    expect(typeof stagingConformanceTests).toBe("function");
  });
});

/**
 * Conformance test suite for Staging implementations
 *
 * Run these tests against any Staging implementation to verify
 * it correctly implements the interface contract.
 */
export function stagingConformanceTests(
  name: string,
  createStaging: () => Promise<Staging>,
  cleanup: () => Promise<void>,
) {
  describe(`${name} Staging conformance`, () => {
    let staging: Staging;

    beforeEach(async () => {
      staging = await createStaging();
      await staging.read();
    });

    afterEach(async () => {
      await cleanup();
    });

    describe("entry operations", () => {
      it("starts empty", async () => {
        expect(await staging.getEntryCount()).toBe(0);
      });

      it("can add and retrieve entries", async () => {
        const entry: IndexEntry = {
          path: "test.txt",
          objectId: "a".repeat(40),
          mode: FileMode.REGULAR_FILE,
          stage: 0,
          size: 100,
          mtime: Date.now(),
          mtimeNs: 0,
          ctime: Date.now(),
          ctimeNs: 0,
          dev: 0,
          ino: 0,
          uid: 0,
          gid: 0,
          flags: 0,
        };

        await staging.setEntry(entry);
        expect(await staging.getEntryCount()).toBe(1);

        const retrieved = await staging.getEntry("test.txt");
        expect(retrieved).toBeDefined();
        expect(retrieved?.path).toBe("test.txt");
        expect(retrieved?.objectId).toBe("a".repeat(40));
      });

      it("hasEntry returns correct values", async () => {
        expect(await staging.hasEntry("nonexistent.txt")).toBe(false);

        await staging.setEntry({
          path: "exists.txt",
          objectId: "b".repeat(40),
          mode: FileMode.REGULAR_FILE,
          stage: 0,
          size: 50,
          mtime: Date.now(),
          mtimeNs: 0,
          ctime: Date.now(),
          ctimeNs: 0,
          dev: 0,
          ino: 0,
          uid: 0,
          gid: 0,
          flags: 0,
        });

        expect(await staging.hasEntry("exists.txt")).toBe(true);
      });

      it("removeEntry removes entries", async () => {
        await staging.setEntry({
          path: "remove-me.txt",
          objectId: "c".repeat(40),
          mode: FileMode.REGULAR_FILE,
          stage: 0,
          size: 25,
          mtime: Date.now(),
          mtimeNs: 0,
          ctime: Date.now(),
          ctimeNs: 0,
          dev: 0,
          ino: 0,
          uid: 0,
          gid: 0,
          flags: 0,
        });

        expect(await staging.hasEntry("remove-me.txt")).toBe(true);

        const removed = await staging.removeEntry("remove-me.txt");
        expect(removed).toBe(true);
        expect(await staging.hasEntry("remove-me.txt")).toBe(false);
      });

      it("removeEntry returns false for non-existent entries", async () => {
        const removed = await staging.removeEntry("nonexistent.txt");
        expect(removed).toBe(false);
      });

      it("entries iterates in sorted order", async () => {
        await staging.setEntry({
          path: "z-file.txt",
          objectId: "d".repeat(40),
          mode: FileMode.REGULAR_FILE,
          stage: 0,
          size: 10,
          mtime: Date.now(),
          mtimeNs: 0,
          ctime: Date.now(),
          ctimeNs: 0,
          dev: 0,
          ino: 0,
          uid: 0,
          gid: 0,
          flags: 0,
        });

        await staging.setEntry({
          path: "a-file.txt",
          objectId: "e".repeat(40),
          mode: FileMode.REGULAR_FILE,
          stage: 0,
          size: 10,
          mtime: Date.now(),
          mtimeNs: 0,
          ctime: Date.now(),
          ctimeNs: 0,
          dev: 0,
          ino: 0,
          uid: 0,
          gid: 0,
          flags: 0,
        });

        const paths: string[] = [];
        for await (const entry of staging.entries()) {
          paths.push(entry.path);
        }

        expect(paths).toEqual(["a-file.txt", "z-file.txt"]);
      });
    });

    describe("conflict handling", () => {
      it("hasConflicts returns false when no conflicts", async () => {
        expect(await staging.hasConflicts()).toBe(false);
      });

      it("detects conflicts with multiple stages", async () => {
        // Add conflict entries (stages 1, 2, 3)
        const basePath = "conflicted.txt";

        await staging.setEntry({
          path: basePath,
          objectId: "1".repeat(40),
          mode: FileMode.REGULAR_FILE,
          stage: 1, // base
          size: 10,
          mtime: Date.now(),
          mtimeNs: 0,
          ctime: Date.now(),
          ctimeNs: 0,
          dev: 0,
          ino: 0,
          uid: 0,
          gid: 0,
          flags: 0,
        });

        await staging.setEntry({
          path: basePath,
          objectId: "2".repeat(40),
          mode: FileMode.REGULAR_FILE,
          stage: 2, // ours
          size: 10,
          mtime: Date.now(),
          mtimeNs: 0,
          ctime: Date.now(),
          ctimeNs: 0,
          dev: 0,
          ino: 0,
          uid: 0,
          gid: 0,
          flags: 0,
        });

        await staging.setEntry({
          path: basePath,
          objectId: "3".repeat(40),
          mode: FileMode.REGULAR_FILE,
          stage: 3, // theirs
          size: 10,
          mtime: Date.now(),
          mtimeNs: 0,
          ctime: Date.now(),
          ctimeNs: 0,
          dev: 0,
          ino: 0,
          uid: 0,
          gid: 0,
          flags: 0,
        });

        expect(await staging.hasConflicts()).toBe(true);

        const conflictedPaths = await staging.getConflictedPaths();
        expect(conflictedPaths).toContain(basePath);
      });

      it("resolveConflict clears conflict stages", async () => {
        const conflictPath = "to-resolve.txt";

        // Create conflict
        for (const stage of [1, 2, 3] as const) {
          await staging.setEntry({
            path: conflictPath,
            objectId: `${stage}`.repeat(40),
            mode: FileMode.REGULAR_FILE,
            stage,
            size: 10,
            mtime: Date.now(),
            mtimeNs: 0,
            ctime: Date.now(),
            ctimeNs: 0,
            dev: 0,
            ino: 0,
            uid: 0,
            gid: 0,
            flags: 0,
          });
        }

        expect(await staging.hasConflicts()).toBe(true);

        // Resolve by selecting "ours"
        await staging.resolveConflict(conflictPath, "ours");

        expect(await staging.hasConflicts()).toBe(false);

        // Should have stage 0 entry
        const resolved = await staging.getEntry(conflictPath, 0);
        expect(resolved).toBeDefined();
        expect(resolved?.stage).toBe(0);
      });
    });

    describe("clear", () => {
      it("removes all entries", async () => {
        await staging.setEntry({
          path: "file1.txt",
          objectId: "a".repeat(40),
          mode: FileMode.REGULAR_FILE,
          stage: 0,
          size: 10,
          mtime: Date.now(),
          mtimeNs: 0,
          ctime: Date.now(),
          ctimeNs: 0,
          dev: 0,
          ino: 0,
          uid: 0,
          gid: 0,
          flags: 0,
        });

        await staging.setEntry({
          path: "file2.txt",
          objectId: "b".repeat(40),
          mode: FileMode.REGULAR_FILE,
          stage: 0,
          size: 10,
          mtime: Date.now(),
          mtimeNs: 0,
          ctime: Date.now(),
          ctimeNs: 0,
          dev: 0,
          ino: 0,
          uid: 0,
          gid: 0,
          flags: 0,
        });

        expect(await staging.getEntryCount()).toBe(2);

        await staging.clear();

        expect(await staging.getEntryCount()).toBe(0);
      });
    });

    describe("persistence", () => {
      it("getUpdateTime returns timestamp", () => {
        const time = staging.getUpdateTime();
        expect(typeof time).toBe("number");
        expect(time).toBeGreaterThanOrEqual(0);
      });
    });
  });
}
