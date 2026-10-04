import { GitResolutionStore } from "@statewalker/vcs-store-files";
import { createInMemoryFilesApi, type FilesApi, joinPath } from "@statewalker/vcs-utils/files";
import { createMemoryGitStaging, MergeStage, type Staging } from "@statewalker/vcs-working-tree";
import type { ResolutionStore } from "@statewalker/vcs-working-tree/transformation";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Simple in-memory Blobs implementation for testing
 */
class TestBlobs {
  private storage = new Map<string, Uint8Array>();

  async store(content: AsyncIterable<Uint8Array> | Iterable<Uint8Array>): Promise<string> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of content) {
      chunks.push(chunk);
    }
    const data = this.concat(chunks);
    // Simple hash: use first 20 bytes of content or pad with zeros
    const id = this.simpleHash(data);
    this.storage.set(id, data);
    return id;
  }

  async storeWithId(id: string, content: Uint8Array): Promise<void> {
    this.storage.set(id, content);
  }

  async load(id: string): Promise<AsyncIterable<Uint8Array> | undefined> {
    const data = this.storage.get(id);
    if (!data) return undefined;
    return (async function* () {
      yield data;
    })();
  }

  async has(id: string): Promise<boolean> {
    return this.storage.has(id);
  }

  async remove(id: string): Promise<boolean> {
    return this.storage.delete(id);
  }

  async *keys(): AsyncIterable<string> {
    for (const key of this.storage.keys()) {
      yield key;
    }
  }

  async size(_id: string): Promise<number> {
    return -1;
  }

  private simpleHash(data: Uint8Array): string {
    // Simple deterministic hash for testing
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      hash = (hash * 31 + data[i]) >>> 0;
    }
    return hash.toString(16).padStart(40, "0");
  }

  private concat(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  }
}

describe("ResolutionStore", () => {
  let files: FilesApi;
  let staging: Staging;
  let blobs: TestBlobs;
  let store: ResolutionStore;
  const gitDir = "/.git";
  const worktreePath = "/";

  beforeEach(async () => {
    files = createInMemoryFilesApi();
    staging = createMemoryGitStaging();
    blobs = new TestBlobs();

    await files.mkdir(gitDir);
    store = new GitResolutionStore(files, staging, blobs as never, gitDir, worktreePath);
  });

  afterEach(async () => {
    // Clean up
  });

  describe("Conflict Detection", () => {
    it("returns empty array when no conflicts", async () => {
      const conflicts = await store.getConflicts();
      expect(conflicts).toHaveLength(0);
    });

    it("detects content conflicts (all three stages)", async () => {
      // Add conflict entries to staging
      await staging.setEntry({
        path: "file.txt",
        objectId: "base111111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.BASE,
      });
      await staging.setEntry({
        path: "file.txt",
        objectId: "ours222222222222222222222222222222222222",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "file.txt",
        objectId: "theirs33333333333333333333333333333333",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });

      const conflicts = await store.getConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe("content");
      expect(conflicts[0].path).toBe("file.txt");
      expect(conflicts[0].base?.objectId).toBe("base111111111111111111111111111111111111");
      expect(conflicts[0].ours?.objectId).toBe("ours222222222222222222222222222222222222");
      expect(conflicts[0].theirs?.objectId).toBe("theirs33333333333333333333333333333333");
    });

    it("detects delete-modify conflicts (base + theirs only)", async () => {
      await staging.setEntry({
        path: "deleted.txt",
        objectId: "base111111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.BASE,
      });
      await staging.setEntry({
        path: "deleted.txt",
        objectId: "theirs33333333333333333333333333333333",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });

      const conflicts = await store.getConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe("delete-modify");
      expect(conflicts[0].ours).toBeUndefined();
    });

    it("detects modify-delete conflicts (base + ours only)", async () => {
      await staging.setEntry({
        path: "modified.txt",
        objectId: "base111111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.BASE,
      });
      await staging.setEntry({
        path: "modified.txt",
        objectId: "ours222222222222222222222222222222222222",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });

      const conflicts = await store.getConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe("modify-delete");
      expect(conflicts[0].theirs).toBeUndefined();
    });

    it("detects add-add conflicts (ours + theirs only, no base)", async () => {
      await staging.setEntry({
        path: "new.txt",
        objectId: "ours222222222222222222222222222222222222",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "new.txt",
        objectId: "theirs33333333333333333333333333333333",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });

      const conflicts = await store.getConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe("add-add");
      expect(conflicts[0].base).toBeUndefined();
    });

    it("detects mode conflicts", async () => {
      const sameContent = "same1111111111111111111111111111111111";
      await staging.setEntry({
        path: "script.sh",
        objectId: "base111111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.BASE,
      });
      await staging.setEntry({
        path: "script.sh",
        objectId: sameContent,
        mode: 0o100644, // regular file
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "script.sh",
        objectId: sameContent,
        mode: 0o100755, // executable
        stage: MergeStage.THEIRS,
      });

      const conflicts = await store.getConflicts();
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].type).toBe("mode");
    });

    it("detects multiple conflicts", async () => {
      // First conflict
      await staging.setEntry({
        path: "a.txt",
        objectId: "ours1111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "a.txt",
        objectId: "theirs11111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });

      // Second conflict
      await staging.setEntry({
        path: "b.txt",
        objectId: "base2222222222222222222222222222222222",
        mode: 0o100644,
        stage: MergeStage.BASE,
      });
      await staging.setEntry({
        path: "b.txt",
        objectId: "ours2222222222222222222222222222222222",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "b.txt",
        objectId: "theirs22222222222222222222222222222222",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });

      const conflicts = await store.getConflicts();
      expect(conflicts).toHaveLength(2);
    });

    it("hasConflicts returns true when conflicts exist", async () => {
      expect(await store.hasConflicts()).toBe(false);

      await staging.setEntry({
        path: "file.txt",
        objectId: "ours111111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "file.txt",
        objectId: "theirs111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });

      expect(await store.hasConflicts()).toBe(true);
    });

    it("getConflict returns single conflict info", async () => {
      await staging.setEntry({
        path: "test.txt",
        objectId: "ours111111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "test.txt",
        objectId: "theirs111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });

      const conflict = await store.getConflict("test.txt");
      expect(conflict).toBeDefined();
      expect(conflict?.path).toBe("test.txt");
      expect(conflict?.type).toBe("add-add");

      const noConflict = await store.getConflict("nonexistent.txt");
      expect(noConflict).toBeUndefined();
    });

    it("getConflictPaths returns list of paths", async () => {
      await staging.setEntry({
        path: "a.txt",
        objectId: "ours1111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "a.txt",
        objectId: "theirs11111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });
      await staging.setEntry({
        path: "b.txt",
        objectId: "ours2222222222222222222222222222222222",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "b.txt",
        objectId: "theirs22222222222222222222222222222222",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });

      const paths = await store.getConflictPaths();
      expect(paths).toContain("a.txt");
      expect(paths).toContain("b.txt");
      expect(paths).toHaveLength(2);
    });
  });

  describe("Resolution Workflow", () => {
    beforeEach(async () => {
      // Setup a conflict
      await staging.setEntry({
        path: "conflict.txt",
        objectId: "base111111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.BASE,
      });
      await staging.setEntry({
        path: "conflict.txt",
        objectId: "ours222222222222222222222222222222222222",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "conflict.txt",
        objectId: "theirs33333333333333333333333333333333",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });

      // Store blob content
      await blobs.storeWithId(
        "ours222222222222222222222222222222222222",
        new TextEncoder().encode("our content"),
      );
      await blobs.storeWithId(
        "theirs33333333333333333333333333333333",
        new TextEncoder().encode("their content"),
      );
    });

    it("marks conflict as resolved", async () => {
      expect(await store.hasConflicts()).toBe(true);

      await store.markResolved("conflict.txt", {
        strategy: "manual",
        objectId: "resolved4444444444444444444444444444444",
        mode: 0o100644,
      });

      expect(await store.hasConflicts()).toBe(false);

      // Check stage 0 entry was created
      const entry = await staging.getEntry("conflict.txt", MergeStage.MERGED);
      expect(entry?.objectId).toBe("resolved4444444444444444444444444444444");
    });

    it("accepts ours version", async () => {
      await store.acceptOurs("conflict.txt");

      const entries = await staging.getEntries("conflict.txt");
      expect(entries).toHaveLength(1);
      expect(entries[0].objectId).toBe("ours222222222222222222222222222222222222");
      expect(entries[0].stage).toBe(MergeStage.MERGED);

      expect(await store.hasConflicts()).toBe(false);
    });

    it("accepts theirs version", async () => {
      await store.acceptTheirs("conflict.txt");

      const entries = await staging.getEntries("conflict.txt");
      expect(entries).toHaveLength(1);
      expect(entries[0].objectId).toBe("theirs33333333333333333333333333333333");
      expect(entries[0].stage).toBe(MergeStage.MERGED);

      expect(await store.hasConflicts()).toBe(false);
    });

    it("throws when accepting ours for nonexistent conflict", async () => {
      await expect(store.acceptOurs("nonexistent.txt")).rejects.toThrow();
    });

    it("throws when accepting theirs for nonexistent conflict", async () => {
      await expect(store.acceptTheirs("nonexistent.txt")).rejects.toThrow();
    });

    it("marks all resolved from working tree", async () => {
      // Write resolved content to worktree (no conflict markers)
      await files.write(joinPath(worktreePath, "conflict.txt"), [
        new TextEncoder().encode("resolved content without markers"),
      ]);

      await store.markAllResolved();

      expect(await store.hasConflicts()).toBe(false);
    });

    it("unmarkResolved throws not implemented error", async () => {
      await expect(store.unmarkResolved("conflict.txt")).rejects.toThrow(/not implemented/i);
    });
  });

  describe("Statistics", () => {
    it("returns correct conflict statistics", async () => {
      // Add an add-add conflict
      await staging.setEntry({
        path: "a.txt",
        objectId: "ours1111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "a.txt",
        objectId: "theirs11111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });

      // Add a content conflict
      await staging.setEntry({
        path: "b.txt",
        objectId: "base2222222222222222222222222222222222",
        mode: 0o100644,
        stage: MergeStage.BASE,
      });
      await staging.setEntry({
        path: "b.txt",
        objectId: "ours2222222222222222222222222222222222",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "b.txt",
        objectId: "theirs22222222222222222222222222222222",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });

      const stats = await store.getStats();

      expect(stats.totalConflicts).toBe(2);
      expect(stats.byType["add-add"]).toBe(1);
      expect(stats.byType.content).toBe(1);
    });

    it("returns zero stats when no conflicts", async () => {
      const stats = await store.getStats();

      expect(stats.totalConflicts).toBe(0);
      expect(stats.resolvedCount).toBe(0);
      expect(stats.pendingCount).toBe(0);
    });
  });

  describe("Resolution Recording (rerere)", () => {
    beforeEach(async () => {
      // Setup a conflict
      await staging.setEntry({
        path: "test.txt",
        objectId: "base111111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.BASE,
      });
      await staging.setEntry({
        path: "test.txt",
        objectId: "ours222222222222222222222222222222222222",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "test.txt",
        objectId: "theirs33333333333333333333333333333333",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });

      // Store blob content for conflict marker generation
      await blobs.storeWithId(
        "ours222222222222222222222222222222222222",
        new TextEncoder().encode("our content"),
      );
      await blobs.storeWithId(
        "theirs33333333333333333333333333333333",
        new TextEncoder().encode("their content"),
      );
    });

    it("records and retrieves resolutions", async () => {
      // Write resolved content to worktree
      await files.write(joinPath(worktreePath, "test.txt"), [
        new TextEncoder().encode("resolved content"),
      ]);

      // Record resolution
      const signature = await store.recordResolution("test.txt");
      expect(signature).toBeDefined();
      expect(signature).toHaveLength(40); // SHA-1 hex

      // Retrieve recorded resolution
      if (signature) {
        const recorded = await store.getRecordedResolution(signature);
        expect(recorded).toBeDefined();
        if (recorded?.resolvedContent) {
          expect(new TextDecoder().decode(recorded.resolvedContent)).toBe("resolved content");
        }
      }
    });

    it("lists recorded resolutions", async () => {
      // Create a recorded resolution manually
      await files.mkdir("/.git/rr-cache");
      await files.mkdir("/.git/rr-cache/abc123");
      await files.write("/.git/rr-cache/abc123/postimage", [new TextEncoder().encode("resolved")]);

      const signatures = await store.listRecordedResolutions();
      expect(signatures).toContain("abc123");
    });

    it("deletes recorded resolution", async () => {
      // Create a recorded resolution
      await files.mkdir("/.git/rr-cache");
      await files.mkdir("/.git/rr-cache/abc123");
      await files.write("/.git/rr-cache/abc123/postimage", [new TextEncoder().encode("resolved")]);

      const deleted = await store.deleteRecordedResolution("abc123");
      expect(deleted).toBe(true);

      const signatures = await store.listRecordedResolutions();
      expect(signatures).not.toContain("abc123");
    });

    it("deleteRecordedResolution returns false for nonexistent", async () => {
      const deleted = await store.deleteRecordedResolution("nonexistent");
      expect(deleted).toBe(false);
    });

    it("clears all recorded resolutions", async () => {
      await files.mkdir("/.git/rr-cache");
      await files.mkdir("/.git/rr-cache/abc123");
      await files.write("/.git/rr-cache/abc123/postimage", [new TextEncoder().encode("resolved")]);

      await store.clearRecordedResolutions();

      const signatures = await store.listRecordedResolutions();
      expect(signatures).toHaveLength(0);
    });

    it("getSuggestedResolution finds matching resolution", async () => {
      // Write resolved content to worktree
      await files.write(joinPath(worktreePath, "test.txt"), [
        new TextEncoder().encode("resolved content"),
      ]);

      // Record the resolution
      await store.recordResolution("test.txt");

      // Get suggested resolution (for same conflict)
      const suggested = await store.getSuggestedResolution("test.txt");
      expect(suggested).toBeDefined();
      expect(suggested?.resolvedContent).toBeDefined();
      if (suggested?.resolvedContent) {
        expect(new TextDecoder().decode(suggested.resolvedContent)).toBe("resolved content");
      }
    });

    it("applyRecordedResolution writes to worktree", async () => {
      // Write resolved content
      await files.write(joinPath(worktreePath, "test.txt"), [
        new TextEncoder().encode("resolved content"),
      ]);

      // Record the resolution
      await store.recordResolution("test.txt");

      // Clear worktree file
      await files.remove(joinPath(worktreePath, "test.txt"));

      // Apply recorded resolution
      const applied = await store.applyRecordedResolution("test.txt");
      expect(applied).toBe(true);

      // Check worktree was updated
      const chunks: Uint8Array[] = [];
      for await (const chunk of files.read(joinPath(worktreePath, "test.txt"))) {
        chunks.push(chunk);
      }
      const content = new TextDecoder().decode(
        chunks.reduce((acc, c) => {
          const result = new Uint8Array(acc.length + c.length);
          result.set(acc);
          result.set(c, acc.length);
          return result;
        }, new Uint8Array(0)),
      );
      expect(content).toBe("resolved content");
    });

    it("applyRecordedResolution returns false when no match", async () => {
      const applied = await store.applyRecordedResolution("test.txt");
      expect(applied).toBe(false);
    });

    it("autoResolve applies all matching resolutions", async () => {
      // Write resolved content and record
      await files.write(joinPath(worktreePath, "test.txt"), [
        new TextEncoder().encode("resolved content"),
      ]);
      await store.recordResolution("test.txt");

      // Clear worktree
      await files.remove(joinPath(worktreePath, "test.txt"));

      // Auto-resolve
      const resolved = await store.autoResolve();
      expect(resolved).toContain("test.txt");
    });
  });

  describe("Worktree Resolution Detection", () => {
    it("detects resolved files (no conflict markers)", async () => {
      await staging.setEntry({
        path: "resolved.txt",
        objectId: "ours111111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "resolved.txt",
        objectId: "theirs111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });

      // Write clean file without markers
      await files.write(joinPath(worktreePath, "resolved.txt"), [
        new TextEncoder().encode("clean merged content"),
      ]);

      const conflict = await store.getConflict("resolved.txt");
      expect(conflict?.resolvedInWorktree).toBe(true);
    });

    it("detects unresolved files (has conflict markers)", async () => {
      await staging.setEntry({
        path: "unresolved.txt",
        objectId: "ours111111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "unresolved.txt",
        objectId: "theirs111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });

      // Write file with conflict markers
      await files.write(joinPath(worktreePath, "unresolved.txt"), [
        new TextEncoder().encode(
          "<<<<<<< ours\nour content\n=======\ntheir content\n>>>>>>> theirs",
        ),
      ]);

      const conflict = await store.getConflict("unresolved.txt");
      expect(conflict?.resolvedInWorktree).toBe(false);
    });

    it("detects missing worktree files as not resolved", async () => {
      await staging.setEntry({
        path: "missing.txt",
        objectId: "ours111111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.OURS,
      });
      await staging.setEntry({
        path: "missing.txt",
        objectId: "theirs111111111111111111111111111111111",
        mode: 0o100644,
        stage: MergeStage.THEIRS,
      });

      const conflict = await store.getConflict("missing.txt");
      expect(conflict?.resolvedInWorktree).toBe(false);
    });
  });
});
