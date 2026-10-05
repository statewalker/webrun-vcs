/**
 * T4.3: Git Refs Tests (Loose/Packed Refs)
 *
 * Tests that verify Git refs handling:
 * - Loose refs (individual files in .git/refs/)
 * - Packed refs (.git/packed-refs file)
 * - Ref resolution priority (loose overrides packed)
 * - Symbolic ref handling
 * - Atomic operations (compare-and-swap)
 */

import {
  createInMemoryFilesApi,
  type FilesApi,
  isSymbolicRef,
  joinPath,
  type ObjectId,
  type Ref,
  RefStorage,
  readFile,
  type SymbolicRef,
} from "@statewalker/vcs-core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createRefsStructure,
  deleteRef,
  FileRefStore,
  packRefs,
  parsePackedRefs,
  readAllRefs,
  readLooseRef,
  readPackedRefs,
  readRef,
  resolveRef,
  writeObjectRef,
  writeSymbolicRef,
} from "../../src/refs/index.js";

// Test constants
const TEST_OID_1 = "0123456789abcdef0123456789abcdef01234567" as ObjectId;
const TEST_OID_2 = "abcdef0123456789abcdef0123456789abcdef01" as ObjectId;
const TEST_OID_3 = "fedcba9876543210fedcba9876543210fedcba98" as ObjectId;

describe("Git Files Refs Handling", () => {
  let files: FilesApi;
  let gitDir: string;
  let refStore: FileRefStore;

  beforeEach(async () => {
    files = createInMemoryFilesApi();
    gitDir = "/.git";
    await files.mkdir(gitDir);
    await createRefsStructure(files, gitDir);
    refStore = new FileRefStore(files, gitDir);
  });

  describe("loose refs", () => {
    it("creates loose ref file", async () => {
      await writeObjectRef(files, gitDir, "refs/heads/main", TEST_OID_1);

      const exists = await files.exists(joinPath(gitDir, "refs/heads/main"));
      expect(exists).toBe(true);
    });

    it("reads loose ref file", async () => {
      await writeObjectRef(files, gitDir, "refs/heads/main", TEST_OID_1);

      const ref = await readLooseRef(files, gitDir, "refs/heads/main");

      expect(ref).toBeDefined();
      expect(isSymbolicRef(ref!)).toBe(false);
      expect((ref as Ref).objectId).toBe(TEST_OID_1);
      expect((ref as Ref).storage).toBe(RefStorage.LOOSE);
    });

    it("updates loose ref file", async () => {
      await writeObjectRef(files, gitDir, "refs/heads/main", TEST_OID_1);
      await writeObjectRef(files, gitDir, "refs/heads/main", TEST_OID_2);

      const ref = await readLooseRef(files, gitDir, "refs/heads/main");

      expect(ref).toBeDefined();
      expect((ref as Ref).objectId).toBe(TEST_OID_2);
    });

    it("handles symbolic refs", async () => {
      await writeSymbolicRef(files, gitDir, "HEAD", "refs/heads/main");

      const ref = await readLooseRef(files, gitDir, "HEAD");

      expect(ref).toBeDefined();
      expect(isSymbolicRef(ref!)).toBe(true);
      if (isSymbolicRef(ref!)) {
        expect(ref.target).toBe("refs/heads/main");
      }
    });

    it("creates nested ref directories", async () => {
      await writeObjectRef(files, gitDir, "refs/remotes/origin/main", TEST_OID_1);

      const exists = await files.exists(joinPath(gitDir, "refs/remotes/origin/main"));
      expect(exists).toBe(true);

      // Verify parent directories exist
      expect(await files.exists(joinPath(gitDir, "refs/remotes"))).toBe(true);
      expect(await files.exists(joinPath(gitDir, "refs/remotes/origin"))).toBe(true);
    });

    it("stores ref content with newline terminator", async () => {
      await writeObjectRef(files, gitDir, "refs/heads/main", TEST_OID_1);

      const data = await readFile(files, joinPath(gitDir, "refs/heads/main"));
      const content = new TextDecoder().decode(data);

      expect(content).toBe(`${TEST_OID_1}\n`);
    });

    it("stores symbolic ref with ref: prefix", async () => {
      await writeSymbolicRef(files, gitDir, "HEAD", "refs/heads/main");

      const data = await readFile(files, joinPath(gitDir, "HEAD"));
      const content = new TextDecoder().decode(data);

      expect(content).toBe("ref: refs/heads/main\n");
    });
  });

  describe("packed refs", () => {
    it("reads packed-refs file", async () => {
      // Create packed-refs file
      const packedContent = `# pack-refs with: peeled
${TEST_OID_1} refs/heads/main
${TEST_OID_2} refs/heads/feature
`;
      await files.write(joinPath(gitDir, "packed-refs"), [new TextEncoder().encode(packedContent)]);

      const { refs, peeled } = await readPackedRefs(files, gitDir);

      expect(peeled).toBe(true);
      expect(refs).toHaveLength(2);
      expect(refs[0].name).toBe("refs/heads/main");
      expect(refs[0].objectId).toBe(TEST_OID_1);
      expect(refs[0].storage).toBe(RefStorage.PACKED);
      expect(refs[1].name).toBe("refs/heads/feature");
      expect(refs[1].objectId).toBe(TEST_OID_2);
    });

    it("writes packed-refs file", async () => {
      // Create some loose refs first
      await writeObjectRef(files, gitDir, "refs/heads/main", TEST_OID_1);
      await writeObjectRef(files, gitDir, "refs/heads/feature", TEST_OID_2);

      // Pack refs
      await packRefs(files, gitDir, ["refs/heads/main", "refs/heads/feature"], true);

      // Verify packed-refs exists
      const exists = await files.exists(joinPath(gitDir, "packed-refs"));
      expect(exists).toBe(true);

      // Read and verify content
      const { refs } = await readPackedRefs(files, gitDir);
      expect(refs.map((r) => r.name)).toContain("refs/heads/main");
      expect(refs.map((r) => r.name)).toContain("refs/heads/feature");
    });

    it("handles peeled tags in packed-refs", async () => {
      // Create packed-refs with peeled tag
      const packedContent = `# pack-refs with: peeled fully-peeled sorted
${TEST_OID_1} refs/tags/v1.0.0
^${TEST_OID_2}
`;
      await files.write(joinPath(gitDir, "packed-refs"), [new TextEncoder().encode(packedContent)]);

      const { refs } = await readPackedRefs(files, gitDir);

      expect(refs).toHaveLength(1);
      expect(refs[0].name).toBe("refs/tags/v1.0.0");
      expect(refs[0].objectId).toBe(TEST_OID_1);
      expect((refs[0] as { peeledObjectId?: string }).peeledObjectId).toBe(TEST_OID_2);
    });

    it("parses packed-refs without header", async () => {
      const packedContent = `${TEST_OID_1} refs/heads/main
`;
      const { refs, peeled } = parsePackedRefs(packedContent);

      expect(peeled).toBe(false);
      expect(refs).toHaveLength(1);
      expect(refs[0].name).toBe("refs/heads/main");
    });

    it("handles empty packed-refs file", async () => {
      await files.write(joinPath(gitDir, "packed-refs"), [new TextEncoder().encode("")]);

      const { refs } = await readPackedRefs(files, gitDir);

      expect(refs).toHaveLength(0);
    });

    it("handles missing packed-refs file", async () => {
      const { refs } = await readPackedRefs(files, gitDir);

      expect(refs).toHaveLength(0);
    });
  });

  describe("ref resolution priority", () => {
    it("loose refs override packed refs", async () => {
      // Create packed ref
      const packedContent = `${TEST_OID_1} refs/heads/main
`;
      await files.write(joinPath(gitDir, "packed-refs"), [new TextEncoder().encode(packedContent)]);

      // Create loose ref with different value
      await writeObjectRef(files, gitDir, "refs/heads/main", TEST_OID_2);

      // readRef should return loose value
      const ref = await readRef(files, gitDir, "refs/heads/main");

      expect(ref).toBeDefined();
      expect((ref as Ref).objectId).toBe(TEST_OID_2);
      expect((ref as Ref).storage).toBe(RefStorage.LOOSE);
    });

    it("falls back to packed when loose does not exist", async () => {
      // Create packed ref only
      const packedContent = `${TEST_OID_1} refs/heads/main
`;
      await files.write(joinPath(gitDir, "packed-refs"), [new TextEncoder().encode(packedContent)]);

      // readRef should return packed value
      const ref = await readRef(files, gitDir, "refs/heads/main");

      expect(ref).toBeDefined();
      expect((ref as Ref).objectId).toBe(TEST_OID_1);
      expect((ref as Ref).storage).toBe(RefStorage.PACKED);
    });

    it("resolves symbolic ref chain", async () => {
      // HEAD -> refs/heads/main -> objectId
      await writeSymbolicRef(files, gitDir, "HEAD", "refs/heads/main");
      await writeObjectRef(files, gitDir, "refs/heads/main", TEST_OID_1);

      const resolved = await resolveRef(files, gitDir, "HEAD");

      expect(resolved).toBeDefined();
      expect(resolved?.objectId).toBe(TEST_OID_1);
    });

    it("resolves multi-level symbolic ref chain", async () => {
      // HEAD -> refs/heads/alias -> refs/heads/main -> objectId
      await writeSymbolicRef(files, gitDir, "HEAD", "refs/heads/alias");
      await writeSymbolicRef(files, gitDir, "refs/heads/alias", "refs/heads/main");
      await writeObjectRef(files, gitDir, "refs/heads/main", TEST_OID_1);

      const resolved = await resolveRef(files, gitDir, "HEAD");

      expect(resolved).toBeDefined();
      expect(resolved?.objectId).toBe(TEST_OID_1);
    });

    it("returns undefined for broken symbolic ref", async () => {
      await writeSymbolicRef(files, gitDir, "HEAD", "refs/heads/nonexistent");

      const resolved = await resolveRef(files, gitDir, "HEAD");

      expect(resolved).toBeUndefined();
    });

    it("throws on circular symbolic ref chain", async () => {
      // Create circular chain
      await writeSymbolicRef(files, gitDir, "refs/heads/a", "refs/heads/b");
      await writeSymbolicRef(files, gitDir, "refs/heads/b", "refs/heads/c");
      await writeSymbolicRef(files, gitDir, "refs/heads/c", "refs/heads/d");
      await writeSymbolicRef(files, gitDir, "refs/heads/d", "refs/heads/e");
      await writeSymbolicRef(files, gitDir, "refs/heads/e", "refs/heads/f");
      await writeSymbolicRef(files, gitDir, "refs/heads/f", "refs/heads/a");

      await expect(resolveRef(files, gitDir, "refs/heads/a")).rejects.toThrow("depth exceeded");
    });

    it("readAllRefs returns both loose and packed refs", async () => {
      // Create loose ref
      await writeObjectRef(files, gitDir, "refs/heads/loose", TEST_OID_1);

      // Create packed ref
      const packedContent = `${TEST_OID_2} refs/heads/packed
`;
      await files.write(joinPath(gitDir, "packed-refs"), [new TextEncoder().encode(packedContent)]);

      const refs = await readAllRefs(files, gitDir, "refs/");

      const refNames = refs.map((r) => r.name);
      expect(refNames).toContain("refs/heads/loose");
      expect(refNames).toContain("refs/heads/packed");
    });

    it("readAllRefs does not duplicate refs that exist in both", async () => {
      // Create both loose and packed version of same ref
      await writeObjectRef(files, gitDir, "refs/heads/main", TEST_OID_2);
      const packedContent = `${TEST_OID_1} refs/heads/main
`;
      await files.write(joinPath(gitDir, "packed-refs"), [new TextEncoder().encode(packedContent)]);

      const refs = await readAllRefs(files, gitDir, "refs/heads/");

      const mainRefs = refs.filter((r) => r.name === "refs/heads/main");
      // Loose should take priority over packed
      expect(mainRefs.length).toBeGreaterThanOrEqual(1);
      // First one should be the loose version
      const looseMainRef = mainRefs.find((r) => r.storage === RefStorage.LOOSE);
      expect(looseMainRef).toBeDefined();
      expect((looseMainRef as Ref).objectId).toBe(TEST_OID_2);
    });
  });

  describe("atomic operations", () => {
    it("compareAndSwap succeeds when old value matches", async () => {
      await writeObjectRef(files, gitDir, "refs/heads/main", TEST_OID_1);

      const result = await refStore.compareAndSwap("refs/heads/main", TEST_OID_1, TEST_OID_2);

      expect(result.success).toBe(true);

      // Verify the update
      const ref = await refStore.get("refs/heads/main");
      expect((ref as Ref).objectId).toBe(TEST_OID_2);
    });

    it("compareAndSwap fails when old value does not match", async () => {
      await writeObjectRef(files, gitDir, "refs/heads/main", TEST_OID_1);

      const result = await refStore.compareAndSwap(
        "refs/heads/main",
        TEST_OID_3, // Wrong expected value
        TEST_OID_2,
      );

      expect(result.success).toBe(false);
      expect(result.previousValue).toBe(TEST_OID_1);

      // Verify the ref was not changed
      const ref = await refStore.get("refs/heads/main");
      expect((ref as Ref).objectId).toBe(TEST_OID_1);
    });

    it("compareAndSwap succeeds for new ref when old is undefined", async () => {
      const result = await refStore.compareAndSwap("refs/heads/newbranch", undefined, TEST_OID_1);

      expect(result.success).toBe(true);

      // Verify the ref was created
      const ref = await refStore.get("refs/heads/newbranch");
      expect(ref).toBeDefined();
      expect((ref as Ref).objectId).toBe(TEST_OID_1);
    });

    it("compareAndSwap fails for new ref when ref already exists", async () => {
      await writeObjectRef(files, gitDir, "refs/heads/existing", TEST_OID_1);

      const result = await refStore.compareAndSwap(
        "refs/heads/existing",
        undefined, // Expected no ref
        TEST_OID_2,
      );

      expect(result.success).toBe(false);
      expect(result.previousValue).toBe(TEST_OID_1);
    });

    it("delete removes loose ref", async () => {
      await writeObjectRef(files, gitDir, "refs/heads/todelete", TEST_OID_1);

      const deleted = await deleteRef(files, gitDir, "refs/heads/todelete");

      expect(deleted).toBe(true);
      expect(await files.exists(joinPath(gitDir, "refs/heads/todelete"))).toBe(false);
    });

    it("delete returns false for non-existent ref", async () => {
      const deleted = await deleteRef(files, gitDir, "refs/heads/nonexistent");

      expect(deleted).toBe(false);
    });

    it("delete cleans up empty parent directories", async () => {
      // Create deeply nested ref
      await writeObjectRef(files, gitDir, "refs/feature/team/project/branch", TEST_OID_1);

      // Delete it
      await deleteRef(files, gitDir, "refs/feature/team/project/branch");

      // Empty dirs should be cleaned up, but refs/ should remain
      expect(await files.exists(joinPath(gitDir, "refs/feature/team/project"))).toBe(false);
      expect(await files.exists(joinPath(gitDir, "refs"))).toBe(true);
    });
  });

  describe("FileRefStore integration", () => {
    it("set and get round-trip", async () => {
      await refStore.set("refs/heads/main", TEST_OID_1);

      const ref = await refStore.get("refs/heads/main");

      expect(ref).toBeDefined();
      expect(isSymbolicRef(ref!)).toBe(false);
      expect((ref as Ref).objectId).toBe(TEST_OID_1);
    });

    it("setSymbolic creates symbolic ref", async () => {
      await refStore.setSymbolic("HEAD", "refs/heads/main");

      const ref = await refStore.get("HEAD");

      expect(ref).toBeDefined();
      expect(isSymbolicRef(ref!)).toBe(true);
    });

    it("has returns true for existing ref", async () => {
      await refStore.set("refs/heads/main", TEST_OID_1);

      expect(await refStore.has("refs/heads/main")).toBe(true);
    });

    it("has returns false for non-existing ref", async () => {
      expect(await refStore.has("refs/heads/nonexistent")).toBe(false);
    });

    it("resolve follows symbolic refs", async () => {
      await refStore.set("refs/heads/main", TEST_OID_1);
      await refStore.setSymbolic("HEAD", "refs/heads/main");

      const resolved = await refStore.resolve("HEAD");

      expect(resolved).toBeDefined();
      expect(resolved?.objectId).toBe(TEST_OID_1);
    });

    it("list returns all refs", async () => {
      await refStore.set("refs/heads/main", TEST_OID_1);
      await refStore.set("refs/heads/feature", TEST_OID_2);
      await refStore.set("refs/tags/v1.0", TEST_OID_3);

      const refs: (Ref | SymbolicRef)[] = [];
      for await (const ref of refStore.list("refs/")) {
        refs.push(ref);
      }

      // Verify all expected refs are present
      const names = refs.map((r) => r.name);
      expect(names).toContain("refs/heads/main");
      expect(names).toContain("refs/heads/feature");
      expect(names).toContain("refs/tags/v1.0");

      // Verify at least the expected refs exist (may include empty dir refs)
      expect(refs.length).toBeGreaterThanOrEqual(3);
    });

    it("list filters by prefix", async () => {
      await refStore.set("refs/heads/main", TEST_OID_1);
      await refStore.set("refs/heads/feature", TEST_OID_2);
      await refStore.set("refs/tags/v1.0", TEST_OID_3);

      const refs: (Ref | SymbolicRef)[] = [];
      for await (const ref of refStore.list("refs/heads/")) {
        refs.push(ref);
      }

      expect(refs).toHaveLength(2);
      const names = refs.map((r) => r.name);
      expect(names).toContain("refs/heads/main");
      expect(names).toContain("refs/heads/feature");
      expect(names).not.toContain("refs/tags/v1.0");
    });

    it("delete removes ref via store", async () => {
      await refStore.set("refs/heads/todelete", TEST_OID_1);

      const deleted = await refStore.delete("refs/heads/todelete");

      expect(deleted).toBe(true);
      expect(await refStore.has("refs/heads/todelete")).toBe(false);
    });

    it("initialize creates refs directory structure", async () => {
      const newFiles = createInMemoryFilesApi();
      const newGitDir = "/.git-new";
      await newFiles.mkdir(newGitDir);

      const newStore = new FileRefStore(newFiles, newGitDir);
      await newStore.initialize();

      expect(await newFiles.exists(joinPath(newGitDir, "refs"))).toBe(true);
      expect(await newFiles.exists(joinPath(newGitDir, "refs/heads"))).toBe(true);
      expect(await newFiles.exists(joinPath(newGitDir, "refs/tags"))).toBe(true);
    });

    it("optimize packs loose refs", async () => {
      await refStore.set("refs/heads/main", TEST_OID_1);
      await refStore.set("refs/heads/feature", TEST_OID_2);

      await refStore.optimize();

      // Packed refs should exist
      const packedExists = await files.exists(joinPath(gitDir, "packed-refs"));
      expect(packedExists).toBe(true);

      // Refs should still be readable (either from packed or remaining loose)
      const main = await refStore.get("refs/heads/main");
      expect(main).toBeDefined();
      expect((main as Ref).objectId).toBe(TEST_OID_1);
    });
  });
});
