import { describe, expect, it } from "vitest";
import {
  compressBlock,
  createPakoCompression,
  setCompressionUtils,
} from "../../../src/compression/index.js";

// Use pako compression (works in all environments)
setCompressionUtils(createPakoCompression());

import {
  BinaryComparator,
  BinarySequence,
  ChangeType,
  encodeGitBase85,
  encodeGitBinaryDelta,
  MyersDiff,
  Patch,
  PatchApplier,
  PatchType,
} from "../../../src/diff/index.js";

describe("PatchApplier", () => {
  describe("Basic operations", () => {
    it("should apply simple modification", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line 1
-line 2
+line 2 modified
 line 3
`;
      const oldContent = new TextEncoder().encode("line 1\nline 2\nline 3\n");

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      expect(patch.getFiles()).toHaveLength(1);

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.content).not.toBeNull();

      const newContentStr = new TextDecoder().decode(result.content);
      expect(newContentStr).toBe("line 1\nline 2 modified\nline 3\n");
    });

    it("should apply ADD operation", async () => {
      const patchText = `diff --git a/newfile.txt b/newfile.txt
new file mode 100644
index 0000000..abc123
--- /dev/null
+++ b/newfile.txt
@@ -0,0 +1,2 @@
+new line 1
+new line 2
`;
      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      expect(patch.getFiles()).toHaveLength(1);
      expect(patch.getFiles()[0].changeType).toBe(ChangeType.ADD);

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], null);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.content).not.toBeNull();

      const newContentStr = new TextDecoder().decode(result.content);
      expect(newContentStr).toBe("new line 1\nnew line 2\n");
    });

    it("should apply DELETE operation", async () => {
      const patchText = `diff --git a/oldfile.txt b/oldfile.txt
deleted file mode 100644
index abc123..0000000
--- a/oldfile.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-old line 1
-old line 2
`;
      const oldContent = new TextEncoder().encode("old line 1\nold line 2\n");

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      expect(patch.getFiles()).toHaveLength(1);
      expect(patch.getFiles()[0].changeType).toBe(ChangeType.DELETE);

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.content).toBeNull();
    });

    it("should handle multiple hunks", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line 1
-line 2
+line 2 modified
 line 3
@@ -5,3 +5,3 @@
 line 5
-line 6
+line 6 modified
 line 7
`;
      const oldContent = new TextEncoder().encode(
        "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\n",
      );

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      expect(patch.getFiles()).toHaveLength(1);
      expect(patch.getFiles()[0].hunks).toHaveLength(2);

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.content).not.toBeNull();

      const newContentStr = new TextDecoder().decode(result.content);
      expect(newContentStr).toBe(
        "line 1\nline 2 modified\nline 3\nline 4\nline 5\nline 6 modified\nline 7\n",
      );
    });

    it("should handle additions and deletions", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,4 +1,5 @@
 line 1
-line 2
 line 3
+new line
+another new line
 line 4
`;
      const oldContent = new TextEncoder().encode("line 1\nline 2\nline 3\nline 4\n");

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.content).not.toBeNull();

      const newContentStr = new TextDecoder().decode(result.content);
      expect(newContentStr).toBe("line 1\nline 3\nnew line\nanother new line\nline 4\n");
    });
  });

  describe("Fuzzy matching", () => {
    it("should apply hunk with shifted position (backward)", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -5,3 +5,3 @@
 context line
-old line
+new line
 more context
`;
      // The actual file has 2 extra lines at the beginning
      const oldContent = new TextEncoder().encode(
        "extra 1\nextra 2\ncontext line\nold line\nmore context\n",
      );

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier({ maxFuzz: 10 });
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0); // Should warn about shift
      expect(result.content).not.toBeNull();

      const newContentStr = new TextDecoder().decode(result.content);
      expect(newContentStr).toBe("extra 1\nextra 2\ncontext line\nnew line\nmore context\n");
    });

    it("should apply hunk with shifted position (forward)", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 context line
-old line
+new line
 more context
`;
      // The actual file is missing first 2 lines, so hunk needs to shift forward
      // But wait, this wouldn't work for forward shift in this case
      // Let me create a better example
      const oldContent = new TextEncoder().encode("context line\nold line\nmore context\n");

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier({ maxFuzz: 10 });
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContentStr = new TextDecoder().decode(result.content);
      expect(newContentStr).toBe("context line\nnew line\nmore context\n");
    });

    it("should fail when fuzzy matching fails", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 context line
-old line
+new line
 more context
`;
      // File content doesn't match at all
      const oldContent = new TextEncoder().encode(
        "completely different\ncontent here\nnothing matches\n",
      );

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier({ maxFuzz: 10 });
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should respect maxFuzz limit", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -100,3 +100,3 @@
 context line
-old line
+new line
 more context
`;
      // File only has 3 lines, so hunk at line 100 should fail with low maxFuzz
      const oldContent = new TextEncoder().encode("context line\nold line\nmore context\n");

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      // With maxFuzz=5, can't shift from line 100 to line 1
      const applier = new PatchApplier({ maxFuzz: 5 });
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("Edge cases", () => {
    it("should handle empty file", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index 0000000..abc123 100644
--- a/file.txt
+++ b/file.txt
@@ -0,0 +1,1 @@
+first line
`;
      const oldContent = new Uint8Array(0);

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContentStr = new TextDecoder().decode(result.content);
      expect(newContentStr).toBe("first line\n");
    });

    it("should handle CRLF line endings", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 line 1\r
-line 2\r
+line 2 modified\r
`;
      const oldContent = new TextEncoder().encode("line 1\r\nline 2\r\n");

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContentStr = new TextDecoder().decode(result.content);
      expect(newContentStr).toBe("line 1\r\nline 2 modified\r\n");
    });

    it("should handle file without trailing newline", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
 line 1
-line 2
\\ No newline at end of file
+line 2 modified
`;
      const oldContent = new TextEncoder().encode("line 1\nline 2");

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContentStr = new TextDecoder().decode(result.content);
      // Result should have a trailing newline since the patch adds one
      expect(newContentStr).toBe("line 1\nline 2 modified\n");
    });
  });

  describe("Error handling", () => {
    it("should error on MODIFY without old content", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,1 @@
-old
+new
`;
      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], null);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("old content is null");
    });

    it("should fail binary patches with invalid base85 data", async () => {
      // Using characters not in base85 alphabet: space, comma, slash are invalid
      const patchText = `diff --git a/binary.dat b/binary.dat
index abc123..def456 100644
GIT binary patch
literal 14
S invalid,data/here[test]

`;
      const oldContent = new Uint8Array([1, 2, 3, 4]);

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      expect(patch.getFiles()[0].patchType).toBe(PatchType.GIT_BINARY);

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      // Invalid base85 characters should cause decompression/decode failure
      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("Binary patch application with compression", () => {
    it("should apply binary literal patch with NodeCompressionProvider (sync)", async () => {
      // Create simple binary content
      const newContent = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

      // Compress the content
      const compressed = await compressBlock(newContent, { raw: false });

      // Encode as base85 (returns Uint8Array with newlines)
      const base85Bytes = encodeGitBase85(compressed);
      const base85String = new TextDecoder().decode(base85Bytes);

      // Create a patch with literal binary hunk (ADD operation for sync)
      const patchText = `diff --git a/binary.dat b/binary.dat
new file mode 100644
index 0000000..def456
GIT binary patch
literal ${newContent.length}
${base85String}
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      expect(patch.getFiles()[0].patchType).toBe(PatchType.GIT_BINARY);

      // Apply with compression provider (sync)
      const applier = new PatchApplier({});
      const result = await applier.apply(patch.getFiles()[0], null);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.content).not.toBeNull();
      expect(result.content).toEqual(newContent);
    });

    it("should apply binary literal patch with NodeCompressionProvider (async)", async () => {
      // Create simple binary content
      const newContent = new Uint8Array([0x57, 0x6f, 0x72, 0x6c, 0x64]); // "World"

      // Compress the content
      const compressed = await compressBlock(newContent, { raw: false });

      // Encode as base85 (returns Uint8Array with newlines)
      const base85Bytes = encodeGitBase85(compressed);
      const base85String = new TextDecoder().decode(base85Bytes);

      // Create a patch with literal binary hunk
      const patchText = `diff --git a/binary.dat b/binary.dat
new file mode 100644
index 0000000..def456
GIT binary patch
literal ${newContent.length}
${base85String}
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      expect(patch.getFiles()[0].patchType).toBe(PatchType.GIT_BINARY);

      // Apply with compression provider (async)
      const applier = new PatchApplier({});
      const result = await applier.apply(patch.getFiles()[0], null);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.content).not.toBeNull();
      expect(result.content).toEqual(newContent);
    });

    it("should apply binary delta patch with NodeCompressionProvider", async () => {
      // Create base and target content
      const baseContent = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
      const targetContent = new Uint8Array([0x01, 0x02, 0xff, 0xfe, 0x05, 0x06, 0x07, 0x08]);

      // Create diff using Myers algorithm (static method)
      const baseSeq = new BinarySequence(baseContent, 1);
      const targetSeq = new BinarySequence(targetContent, 1);
      const comparator = new BinaryComparator();

      const editList = MyersDiff.diff(comparator, baseSeq, targetSeq);

      // Encode as Git binary delta directly from EditList (JGit-style)
      const delta = encodeGitBinaryDelta(baseContent, targetContent, editList);

      // Compress the delta
      const compressed = await compressBlock(delta, { raw: false });

      // Encode as base85 (returns Uint8Array with newlines)
      const base85Bytes = encodeGitBase85(compressed);
      const base85String = new TextDecoder().decode(base85Bytes);

      // Create a patch with delta binary hunk
      const patchText = `diff --git a/binary.dat b/binary.dat
index abc123..def456 100644
GIT binary patch
delta ${targetContent.length}
${base85String}
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      expect(patch.getFiles()[0].patchType).toBe(PatchType.GIT_BINARY);

      // Apply with compression provider
      const applier = new PatchApplier({});
      const result = await applier.apply(patch.getFiles()[0], baseContent);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.content).not.toBeNull();
      expect(result.content).toEqual(targetContent);
    });

    it("should handle large binary content with compression", async () => {
      // Create larger binary content (1KB)
      const newContent = new Uint8Array(1024);
      for (let i = 0; i < newContent.length; i++) {
        newContent[i] = i % 256;
      }

      // Compress the content
      const compressed = await compressBlock(newContent, { raw: false });

      // Encode as base85 (returns Uint8Array with newlines)
      const base85Bytes = encodeGitBase85(compressed);
      const base85String = new TextDecoder().decode(base85Bytes);

      // Create a patch with literal binary hunk
      const patchText = `diff --git a/large.bin b/large.bin
new file mode 100644
index 0000000..def456
GIT binary patch
literal ${newContent.length}
${base85String}
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      // Apply with compression provider
      const applier = new PatchApplier({});
      const result = await applier.apply(patch.getFiles()[0], null);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.content).not.toBeNull();
      expect(result.content).toEqual(newContent);
    });

    it("should validate decompressed size matches expected size", async () => {
      // Create binary content
      const actualContent = new Uint8Array([0x01, 0x02, 0x03]);
      const compressed = await compressBlock(actualContent, { raw: false });
      const base85Bytes = encodeGitBase85(compressed);
      const base85String = new TextDecoder().decode(base85Bytes);

      // Create patch with WRONG size (should trigger warning)
      const wrongSize = 100; // Actual is 3 bytes
      const patchText = `diff --git a/binary.dat b/binary.dat
new file mode 100644
GIT binary patch
literal ${wrongSize}
${base85String}
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier({});
      const result = await applier.apply(patch.getFiles()[0], null);

      expect(result.success).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("size mismatch");
      expect(result.content).toEqual(actualContent);
    });

    it("should handle malformed compressed data gracefully", async () => {
      // Create malformed base85 data (won't decompress properly)
      const malformedData = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
      const base85Bytes = encodeGitBase85(malformedData);
      const base85String = new TextDecoder().decode(base85Bytes);

      const patchText = `diff --git a/binary.dat b/binary.dat
new file mode 100644
GIT binary patch
literal 100
${base85String}
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier({});
      const result = await applier.apply(patch.getFiles()[0], null);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain("decompress");
    });
  });

  describe("Conflict markers", () => {
    it("should insert conflict markers when allowConflicts is true and hunk fails", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 context line
-old line to replace
+new replacement line
 more context
`;
      // File content doesn't match - patch expects "old line to replace" but file has different content
      const oldContent = new TextEncoder().encode(
        "context line\ndifferent content here\nmore context\n",
      );

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier({ allowConflicts: true, maxFuzz: 0 });
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain("conflicts");
      expect(result.content).not.toBeNull();

      const newContentStr = new TextDecoder().decode(result.content);
      expect(newContentStr).toContain("<<<<<<< ours");
      expect(newContentStr).toContain("=======");
      expect(newContentStr).toContain(">>>>>>> theirs");
    });

    it("should include ours and theirs content in conflict markers", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 header
-original line
+modified line
 footer
`;
      // Content doesn't match what patch expects
      const oldContent = new TextEncoder().encode("header\ncompletely different\nfooter\n");

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier({ allowConflicts: true, maxFuzz: 0 });
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContentStr = new TextDecoder().decode(result.content);

      // Should contain the ours content (what patch expected to find: context + deletion)
      expect(newContentStr).toContain("header");
      expect(newContentStr).toContain("original line");

      // Should contain the theirs content (what patch wants: context + addition)
      expect(newContentStr).toContain("modified line");

      // Should have proper conflict marker structure
      const lines = newContentStr.split("\n");
      const oursIndex = lines.findIndex((l) => l.includes("<<<<<<< ours"));
      const separatorIndex = lines.indexOf("=======");
      const theirsIndex = lines.findIndex((l) => l.includes(">>>>>>> theirs"));

      expect(oursIndex).toBeLessThan(separatorIndex);
      expect(separatorIndex).toBeLessThan(theirsIndex);
    });

    it("should fail without conflict markers when allowConflicts is false", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 context line
-old line
+new line
 more context
`;
      const oldContent = new TextEncoder().encode(
        "context line\ndifferent content\nmore context\n",
      );

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      // Default: allowConflicts is false
      const applier = new PatchApplier({ maxFuzz: 0 });
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should apply successful hunks even when one has conflicts", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 first section
-line to change
+changed line
 section end
@@ -10,3 +10,3 @@
 second section
-another line
+another changed
 section end
`;
      // First hunk will fail (content mismatch), second hunk content is at correct position
      const oldContent = new TextEncoder().encode(
        "first section\ndifferent line here\nsection end\nfiller1\nfiller2\nfiller3\nfiller4\nfiller5\nfiller6\nsecond section\nanother line\nsection end\n",
      );

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier({ allowConflicts: true, maxFuzz: 0 });
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.content).not.toBeNull();

      const newContentStr = new TextDecoder().decode(result.content);

      // Should have conflict markers for the first hunk
      expect(newContentStr).toContain("<<<<<<< ours");

      // Second hunk should have been applied (shifted due to first conflict)
      // After conflict markers are inserted, the line count changes
      expect(newContentStr).toContain("another changed");
    });

    it("should handle conflict with only additions", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,4 @@
 existing line
+new line 1
+new line 2
 another existing
`;
      // Content at expected position doesn't match
      const oldContent = new TextEncoder().encode("wrong line\ndifferent line\n");

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier({ allowConflicts: true, maxFuzz: 0 });
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContentStr = new TextDecoder().decode(result.content);
      expect(newContentStr).toContain("<<<<<<< ours");
      expect(newContentStr).toContain("new line 1");
      expect(newContentStr).toContain("new line 2");
      expect(newContentStr).toContain(">>>>>>> theirs");
    });

    it("should handle conflict with only deletions", async () => {
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,4 +1,2 @@
 keep this
-delete me
-delete me too
 keep this too
`;
      // Content doesn't match what patch expects to delete
      const oldContent = new TextEncoder().encode(
        "keep this\nwrong content\nwrong again\nkeep this too\n",
      );

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier({ allowConflicts: true, maxFuzz: 0 });
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContentStr = new TextDecoder().decode(result.content);
      expect(newContentStr).toContain("<<<<<<< ours");
      // Ours should contain what patch expected (context + deletions)
      expect(newContentStr).toContain("delete me");
      // Theirs should contain what patch wanted (just context, no deletions)
      expect(newContentStr).toContain(">>>>>>> theirs");
    });
  });
});
