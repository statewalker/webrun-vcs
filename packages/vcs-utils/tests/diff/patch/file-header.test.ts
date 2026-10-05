import { describe, expect, it } from "vitest";
import { FileHeader } from "../../../src/diff/patch/file-header.js";

describe("FileHeader", () => {
  describe("parseGitFileHeader", () => {
    it("should parse simple modify patch", () => {
      const patch = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,1 @@
-old line
+new line
`;
      const buffer = new TextEncoder().encode(patch);
      const header = new FileHeader(buffer, 0);
      header.parseGitFileHeader(buffer.length);

      expect(header.oldPath).toBe("file.txt");
      expect(header.newPath).toBe("file.txt");
      expect(header.changeType).toBe("MODIFY");
      expect(header.patchType).toBe("UNIFIED");
      expect(header.oldId).toBe("abc123");
      expect(header.newId).toBe("def456");
      expect(header.oldMode).toBe(0o100644);
      expect(header.newMode).toBe(0o100644);
    });

    it("should parse file addition", () => {
      const patch = `diff --git a/newfile.txt b/newfile.txt
new file mode 100644
index 0000000..abc123
--- /dev/null
+++ b/newfile.txt
@@ -0,0 +1,1 @@
+new content
`;
      const buffer = new TextEncoder().encode(patch);
      const header = new FileHeader(buffer, 0);
      header.parseGitFileHeader(buffer.length);

      expect(header.oldPath).toBe("newfile.txt");
      expect(header.newPath).toBe("newfile.txt");
      expect(header.changeType).toBe("ADD");
      expect(header.oldMode).toBe(0);
      expect(header.newMode).toBe(0o100644);
    });

    it("should parse file deletion", () => {
      const patch = `diff --git a/oldfile.txt b/oldfile.txt
deleted file mode 100644
index abc123..0000000
--- a/oldfile.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-deleted content
`;
      const buffer = new TextEncoder().encode(patch);
      const header = new FileHeader(buffer, 0);
      header.parseGitFileHeader(buffer.length);

      expect(header.oldPath).toBe("oldfile.txt");
      expect(header.newPath).toBe("oldfile.txt");
      expect(header.changeType).toBe("DELETE");
      expect(header.oldMode).toBe(0o100644);
      expect(header.newMode).toBe(0);
    });

    it("should parse file rename", () => {
      const patch = `diff --git a/old.txt b/new.txt
similarity index 95%
rename from old.txt
rename to new.txt
index abc123..def456 100644
--- a/old.txt
+++ b/new.txt
`;
      const buffer = new TextEncoder().encode(patch);
      const header = new FileHeader(buffer, 0);
      header.parseGitFileHeader(buffer.length);

      expect(header.oldPath).toBe("old.txt");
      expect(header.newPath).toBe("new.txt");
      expect(header.changeType).toBe("RENAME");
      expect(header.score).toBe(95);
    });

    it("should parse file copy", () => {
      const patch = `diff --git a/source.txt b/dest.txt
copy from source.txt
copy to dest.txt
index abc123..def456 100644
--- a/source.txt
+++ b/dest.txt
`;
      const buffer = new TextEncoder().encode(patch);
      const header = new FileHeader(buffer, 0);
      header.parseGitFileHeader(buffer.length);

      expect(header.oldPath).toBe("source.txt");
      expect(header.newPath).toBe("dest.txt");
      expect(header.changeType).toBe("COPY");
    });

    it("should parse mode change", () => {
      const patch = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
index abc123..def456
--- a/script.sh
+++ b/script.sh
`;
      const buffer = new TextEncoder().encode(patch);
      const header = new FileHeader(buffer, 0);
      header.parseGitFileHeader(buffer.length);

      expect(header.oldMode).toBe(0o100644);
      expect(header.newMode).toBe(0o100755);
    });

    it("should parse paths with subdirectories", () => {
      const patch = `diff --git a/src/main/file.ts b/src/main/file.ts
index abc123..def456 100644
--- a/src/main/file.ts
+++ b/src/main/file.ts
`;
      const buffer = new TextEncoder().encode(patch);
      const header = new FileHeader(buffer, 0);
      header.parseGitFileHeader(buffer.length);

      expect(header.oldPath).toBe("src/main/file.ts");
      expect(header.newPath).toBe("src/main/file.ts");
    });

    it("should handle multiple hunks", () => {
      const patch = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,1 @@
-line 1
+line 1 modified
@@ -10,1 +10,1 @@
-line 10
+line 10 modified
`;
      const buffer = new TextEncoder().encode(patch);
      const header = new FileHeader(buffer, 0);
      const endOffset = header.parseGitFileHeader(buffer.length);

      expect(header.oldPath).toBe("file.txt");
      expect(header.newPath).toBe("file.txt");
      expect(endOffset).toBeLessThanOrEqual(buffer.length);

      // Verify hunks are parsed
      expect(header.hunks).toHaveLength(2);

      // First hunk
      expect(header.hunks[0].oldStartLine).toBe(1);
      expect(header.hunks[0].oldLineCount).toBe(1);
      expect(header.hunks[0].newStartLine).toBe(1);
      expect(header.hunks[0].newLineCount).toBe(1);
      expect(header.hunks[0].deletedLineCount).toBe(1);
      expect(header.hunks[0].addedLineCount).toBe(1);

      // Second hunk
      expect(header.hunks[1].oldStartLine).toBe(10);
      expect(header.hunks[1].oldLineCount).toBe(1);
      expect(header.hunks[1].newStartLine).toBe(10);
      expect(header.hunks[1].newLineCount).toBe(1);
      expect(header.hunks[1].deletedLineCount).toBe(1);
      expect(header.hunks[1].addedLineCount).toBe(1);
    });

    it("should toString() return readable format", () => {
      const patch = `diff --git a/old.txt b/new.txt
rename from old.txt
rename to new.txt
`;
      const buffer = new TextEncoder().encode(patch);
      const header = new FileHeader(buffer, 0);
      header.parseGitFileHeader(buffer.length);

      expect(header.toString()).toContain("RENAME");
      expect(header.toString()).toContain("old.txt");
      expect(header.toString()).toContain("new.txt");
    });

    it("should parse binary patch with literal hunk", () => {
      const patch = `diff --git a/binary.dat b/binary.dat
index abc123..def456 100644
GIT binary patch
literal 14
ScmZp0Xmwa1z*+$U3j_csN(Dmz

`;
      const buffer = new TextEncoder().encode(patch);
      const header = new FileHeader(buffer, 0);
      header.parseGitFileHeader(buffer.length);

      expect(header.oldPath).toBe("binary.dat");
      expect(header.newPath).toBe("binary.dat");
      expect(header.patchType).toBe("GIT_BINARY");
      expect(header.forwardBinaryHunk).not.toBeNull();
      expect(header.forwardBinaryHunk?.type).toBe("LITERAL_DEFLATED");
      expect(header.forwardBinaryHunk?.size).toBe(14);
    });

    it("should parse binary patch with delta hunks", () => {
      const patch = `diff --git a/delta b/delta
index abc123..def456 100644
GIT binary patch
delta 14
ScmZp0Xmwa1z*+$U3j_csN(Dmz

delta 12
TcmZp5XmD5{u!xa=5hEi28?FP4

`;
      const buffer = new TextEncoder().encode(patch);
      const header = new FileHeader(buffer, 0);
      header.parseGitFileHeader(buffer.length);

      expect(header.patchType).toBe("GIT_BINARY");
      expect(header.forwardBinaryHunk).not.toBeNull();
      expect(header.forwardBinaryHunk?.type).toBe("DELTA_DEFLATED");
      expect(header.forwardBinaryHunk?.size).toBe(14);
      expect(header.reverseBinaryHunk).not.toBeNull();
      expect(header.reverseBinaryHunk?.type).toBe("DELTA_DEFLATED");
      expect(header.reverseBinaryHunk?.size).toBe(12);
    });
  });
});
