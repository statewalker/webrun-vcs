import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BinaryHunkType, ChangeType, Patch, PatchType } from "../../../src/diff/index.js";

const FIXTURES_DIR = join(__dirname, "../fixtures/jgit");

describe("JGit Patch Integration Tests", () => {
  describe("Binary patches", () => {
    it("should parse literal_add.patch", () => {
      const patchData = readFileSync(join(FIXTURES_DIR, "literal_add.patch"));
      const patch = new Patch();
      patch.parse(patchData);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);

      const file = patch.getFiles()[0];
      expect(file.oldPath).toBe("literal_add");
      expect(file.newPath).toBe("literal_add");
      expect(file.changeType).toBe(ChangeType.ADD);
      expect(file.patchType).toBe(PatchType.GIT_BINARY);

      // Should have forward binary hunk (new file)
      expect(file.forwardBinaryHunk).not.toBeNull();
      expect(file.forwardBinaryHunk?.type).toBe(BinaryHunkType.LITERAL_DEFLATED);
      expect(file.forwardBinaryHunk?.size).toBe(1629);

      // Should have reverse binary hunk (for reversal - literal 0)
      expect(file.reverseBinaryHunk).not.toBeNull();
      expect(file.reverseBinaryHunk?.type).toBe(BinaryHunkType.LITERAL_DEFLATED);
      expect(file.reverseBinaryHunk?.size).toBe(0);
    });

    it("should parse literal.patch", () => {
      const patchData = readFileSync(join(FIXTURES_DIR, "literal.patch"));
      const patch = new Patch();
      patch.parse(patchData);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);

      const file = patch.getFiles()[0];
      expect(file.oldPath).toBe("literal");
      expect(file.newPath).toBe("literal");
      expect(file.changeType).toBe(ChangeType.MODIFY);
      expect(file.patchType).toBe(PatchType.GIT_BINARY);

      // Should have both forward and reverse literal hunks
      expect(file.forwardBinaryHunk).not.toBeNull();
      expect(file.forwardBinaryHunk?.type).toBe(BinaryHunkType.LITERAL_DEFLATED);
      expect(file.forwardBinaryHunk?.size).toBe(5389);

      expect(file.reverseBinaryHunk).not.toBeNull();
      expect(file.reverseBinaryHunk?.type).toBe(BinaryHunkType.LITERAL_DEFLATED);
      expect(file.reverseBinaryHunk?.size).toBe(1629);
    });

    it("should parse delta.patch", () => {
      const patchData = readFileSync(join(FIXTURES_DIR, "delta.patch"));
      const patch = new Patch();
      patch.parse(patchData);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);

      const file = patch.getFiles()[0];
      expect(file.oldPath).toBe("delta");
      expect(file.newPath).toBe("delta");
      expect(file.changeType).toBe(ChangeType.MODIFY);
      expect(file.patchType).toBe(PatchType.GIT_BINARY);

      // Should have both forward and reverse delta hunks
      expect(file.forwardBinaryHunk).not.toBeNull();
      expect(file.forwardBinaryHunk?.type).toBe(BinaryHunkType.DELTA_DEFLATED);
      expect(file.forwardBinaryHunk?.size).toBe(14);

      expect(file.reverseBinaryHunk).not.toBeNull();
      expect(file.reverseBinaryHunk?.type).toBe(BinaryHunkType.DELTA_DEFLATED);
      expect(file.reverseBinaryHunk?.size).toBe(12);
    });
  });

  describe("Text patches", () => {
    it("should parse patches with multiple files", () => {
      // Create a multi-file patch
      const patchText = `diff --git a/file1.txt b/file1.txt
index abc123..def456 100644
--- a/file1.txt
+++ b/file1.txt
@@ -1,1 +1,1 @@
-old content
+new content
diff --git a/file2.txt b/file2.txt
new file mode 100644
index 0000000..abc123
--- /dev/null
+++ b/file2.txt
@@ -0,0 +1,1 @@
+added file
`;
      const buffer = new TextEncoder().encode(patchText);
      const patch = new Patch();
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(2);

      // First file - modify
      const file1 = patch.getFiles()[0];
      expect(file1.oldPath).toBe("file1.txt");
      expect(file1.newPath).toBe("file1.txt");
      expect(file1.changeType).toBe(ChangeType.MODIFY);
      expect(file1.patchType).toBe(PatchType.UNIFIED);
      expect(file1.hunks).toHaveLength(1);
      expect(file1.hunks[0].deletedLineCount).toBe(1);
      expect(file1.hunks[0].addedLineCount).toBe(1);

      // Second file - add
      const file2 = patch.getFiles()[1];
      expect(file2.oldPath).toBe("file2.txt");
      expect(file2.newPath).toBe("file2.txt");
      expect(file2.changeType).toBe(ChangeType.ADD);
      expect(file2.patchType).toBe(PatchType.UNIFIED);
      expect(file2.hunks).toHaveLength(1);
      expect(file2.hunks[0].addedLineCount).toBe(1);
    });
  });

  describe("Edge cases", () => {
    it("should handle patches with renamed files", () => {
      const patchText = `diff --git a/old.txt b/new.txt
similarity index 95%
rename from old.txt
rename to new.txt
index abc123..def456 100644
--- a/old.txt
+++ b/new.txt
@@ -1,1 +1,1 @@
-old line
+new line
`;
      const buffer = new TextEncoder().encode(patchText);
      const patch = new Patch();
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);

      const file = patch.getFiles()[0];
      expect(file.oldPath).toBe("old.txt");
      expect(file.newPath).toBe("new.txt");
      expect(file.changeType).toBe(ChangeType.RENAME);
      expect(file.score).toBe(95);
      expect(file.hunks).toHaveLength(1);
    });

    it("should handle patches with copied files", () => {
      const patchText = `diff --git a/source.txt b/dest.txt
copy from source.txt
copy to dest.txt
index abc123..def456 100644
--- a/source.txt
+++ b/dest.txt
@@ -1,1 +1,1 @@
-source line
+dest line
`;
      const buffer = new TextEncoder().encode(patchText);
      const patch = new Patch();
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);

      const file = patch.getFiles()[0];
      expect(file.oldPath).toBe("source.txt");
      expect(file.newPath).toBe("dest.txt");
      expect(file.changeType).toBe(ChangeType.COPY);
      expect(file.hunks).toHaveLength(1);
    });

    it("should handle deleted files", () => {
      const patchText = `diff --git a/deleted.txt b/deleted.txt
deleted file mode 100644
index abc123..0000000
--- a/deleted.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-deleted content
`;
      const buffer = new TextEncoder().encode(patchText);
      const patch = new Patch();
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);

      const file = patch.getFiles()[0];
      expect(file.oldPath).toBe("deleted.txt");
      expect(file.newPath).toBe("deleted.txt");
      expect(file.changeType).toBe(ChangeType.DELETE);
      expect(file.oldMode).toBe(0o100644);
      expect(file.newMode).toBe(0);
      expect(file.hunks).toHaveLength(1);
      expect(file.hunks[0].deletedLineCount).toBe(1);
    });

    it("should handle mode changes", () => {
      const patchText = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
index abc123..def456
--- a/script.sh
+++ b/script.sh
`;
      const buffer = new TextEncoder().encode(patchText);
      const patch = new Patch();
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);

      const file = patch.getFiles()[0];
      expect(file.oldMode).toBe(0o100644);
      expect(file.newMode).toBe(0o100755);
    });

    it("should handle patches with multiple hunks", () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -10,3 +10,3 @@ context
 keep
-remove1
+add1
 keep2
@@ -20,3 +20,3 @@ more context
 keep3
-remove2
+add2
 keep4
`;
      const buffer = new TextEncoder().encode(patchText);
      const patch = new Patch();
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);

      const file = patch.getFiles()[0];
      expect(file.hunks).toHaveLength(2);

      // First hunk
      expect(file.hunks[0].oldStartLine).toBe(10);
      expect(file.hunks[0].oldLineCount).toBe(3);
      expect(file.hunks[0].newStartLine).toBe(10);
      expect(file.hunks[0].newLineCount).toBe(3);
      expect(file.hunks[0].context).toBe("context");

      // Second hunk
      expect(file.hunks[1].oldStartLine).toBe(20);
      expect(file.hunks[1].oldLineCount).toBe(3);
      expect(file.hunks[1].newStartLine).toBe(20);
      expect(file.hunks[1].newLineCount).toBe(3);
      expect(file.hunks[1].context).toBe("more context");
    });
  });
});
