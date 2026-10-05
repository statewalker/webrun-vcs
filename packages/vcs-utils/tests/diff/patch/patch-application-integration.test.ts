import { describe, expect, it } from "vitest";
import { ChangeType, Patch, PatchApplier } from "../../../src/diff/index.js";

/**
 * Integration tests for patch parsing + application
 * Based on JGit's patch application test scenarios
 */
describe("Patch Application Integration", () => {
  describe("Simple text patches", () => {
    it("should apply patch to simple file", async () => {
      const oldContent = new TextEncoder().encode("line 1\nline 2\nline 3\nline 4\nline 5\n");

      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -2,3 +2,3 @@ line 1
 line 2
-line 3
+line 3 modified
 line 4
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.content).not.toBeNull();

      const newContent = new TextDecoder().decode(result.content);
      expect(newContent).toBe("line 1\nline 2\nline 3 modified\nline 4\nline 5\n");
    });

    it("should apply patch with multiple modifications", async () => {
      const oldContent = new TextEncoder().encode("a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n");

      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 a
 b
+new line after b
 c
@@ -7,4 +8,3 @@ f
 g
 h
-i
 j
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContent = new TextDecoder().decode(result.content);
      expect(newContent).toBe("a\nb\nnew line after b\nc\nd\ne\nf\ng\nh\nj\n");
    });

    it("should handle patch with context lines", async () => {
      const oldContent = new TextEncoder().encode(
        "context 1\ncontext 2\nold content\ncontext 3\ncontext 4\n",
      );

      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,5 +1,5 @@
 context 1
 context 2
-old content
+new content
 context 3
 context 4
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContent = new TextDecoder().decode(result.content);
      expect(newContent).toBe("context 1\ncontext 2\nnew content\ncontext 3\ncontext 4\n");
    });
  });

  describe("Fuzzy matching scenarios", () => {
    it("should apply patch when file has extra lines at beginning", async () => {
      // Patch expects line 10, but file has extra 5 lines at start
      const oldContent = new TextEncoder().encode(
        "extra 1\nextra 2\nextra 3\nextra 4\nextra 5\n" +
          "context before\ntarget line\ncontext after\n",
      );

      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -10,3 +10,3 @@
 context before
-target line
+modified target line
 context after
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier({ maxFuzz: 50 });
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0); // Should warn about shift
      expect(result.content).not.toBeNull();

      const newContent = new TextDecoder().decode(result.content);
      expect(newContent).toContain("modified target line");
    });

    it("should apply sequential hunks correctly", async () => {
      const oldContent = new TextEncoder().encode(
        "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n",
      );

      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line 1
-line 2
+line 2 mod
 line 3
@@ -5,3 +5,3 @@ line 4
 line 5
-line 6
+line 6 mod
 line 7
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContent = new TextDecoder().decode(result.content);
      expect(newContent).toBe(
        "line 1\nline 2 mod\nline 3\nline 4\nline 5\nline 6 mod\nline 7\nline 8\n",
      );
    });

    it("should fail when context doesn't match and fuzz limit exceeded", async () => {
      const oldContent = new TextEncoder().encode("completely\ndifferent\ncontent\n");

      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -100,3 +100,3 @@
 expected context
-old line
+new line
 more context
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier({ maxFuzz: 10 });
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe("File operations", () => {
    it("should create new file from patch", async () => {
      const patchText = `diff --git a/newfile.txt b/newfile.txt
new file mode 100644
index 0000000..abc123
--- /dev/null
+++ b/newfile.txt
@@ -0,0 +1,3 @@
+First line
+Second line
+Third line
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      expect(patch.getFiles()[0].changeType).toBe(ChangeType.ADD);

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], null);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContent = new TextDecoder().decode(result.content);
      expect(newContent).toBe("First line\nSecond line\nThird line\n");
    });

    it("should delete file", async () => {
      const oldContent = new TextEncoder().encode("content to delete\n");

      const patchText = `diff --git a/oldfile.txt b/oldfile.txt
deleted file mode 100644
index abc123..0000000
--- a/oldfile.txt
+++ /dev/null
@@ -1 +0,0 @@
-content to delete
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      expect(patch.getFiles()[0].changeType).toBe(ChangeType.DELETE);

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).toBeNull();
    });

    it("should handle renamed file with modifications", async () => {
      const oldContent = new TextEncoder().encode("old content\n");

      const patchText = `diff --git a/old.txt b/new.txt
similarity index 85%
rename from old.txt
rename to new.txt
index abc123..def456 100644
--- a/old.txt
+++ b/new.txt
@@ -1 +1 @@
-old content
+new content
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      expect(patch.getFiles()[0].changeType).toBe(ChangeType.RENAME);

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContent = new TextDecoder().decode(result.content);
      expect(newContent).toBe("new content\n");
    });
  });

  describe("Complex scenarios", () => {
    it("should apply patch to file with no trailing newline", async () => {
      const oldContent = new TextEncoder().encode("line 1\nline 2");

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

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContent = new TextDecoder().decode(result.content);
      expect(newContent).toBe("line 1\nline 2 modified\n");
    });

    it("should handle large file with many hunks", async () => {
      // Create a file with 100 lines
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
      const oldContent = new TextEncoder().encode(`${lines.join("\n")}\n`);

      // Create a patch that modifies lines 10, 30, 50, 70, 90
      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -8,3 +8,3 @@ line 8
 line 9
-line 10
+line 10 modified
 line 11
@@ -28,3 +28,3 @@ line 28
 line 29
-line 30
+line 30 modified
 line 31
@@ -48,3 +48,3 @@ line 48
 line 49
-line 50
+line 50 modified
 line 51
@@ -68,3 +68,3 @@ line 68
 line 69
-line 70
+line 70 modified
 line 71
@@ -88,3 +88,3 @@ line 88
 line 89
-line 90
+line 90 modified
 line 91
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      expect(patch.getFiles()[0].hunks).toHaveLength(5);

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContent = new TextDecoder().decode(result.content);
      expect(newContent).toContain("line 10 modified");
      expect(newContent).toContain("line 30 modified");
      expect(newContent).toContain("line 50 modified");
      expect(newContent).toContain("line 70 modified");
      expect(newContent).toContain("line 90 modified");

      // Verify unmodified lines are intact
      expect(newContent).toContain("line 1\n");
      expect(newContent).toContain("line 100\n");
    });

    it("should apply patch with only additions at end of file", async () => {
      const oldContent = new TextEncoder().encode("existing line 1\nexisting line 2\n");

      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -2,0 +3,3 @@ existing line 2
+new line 1
+new line 2
+new line 3
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContent = new TextDecoder().decode(result.content);
      expect(newContent).toBe(
        "existing line 1\nexisting line 2\nnew line 1\nnew line 2\nnew line 3\n",
      );
    });

    it("should apply patch with only deletions", async () => {
      const oldContent = new TextEncoder().encode("line 1\nline 2\nline 3\nline 4\nline 5\n");

      const patchText = `diff --git a/file.txt b/file.txt
index abc123..def456 100644
--- a/file.txt
+++ b/file.txt
@@ -1,5 +1,2 @@
 line 1
-line 2
-line 3
-line 4
 line 5
`;

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContent = new TextDecoder().decode(result.content);
      expect(newContent).toBe("line 1\nline 5\n");
    });
  });

  describe("Multi-file patches", () => {
    it("should apply multi-file patch", async () => {
      const patchText = `diff --git a/file1.txt b/file1.txt
index abc123..def456 100644
--- a/file1.txt
+++ b/file1.txt
@@ -1,1 +1,1 @@
-file 1 old
+file 1 new
diff --git a/file2.txt b/file2.txt
index abc123..def456 100644
--- a/file2.txt
+++ b/file2.txt
@@ -1,1 +1,1 @@
-file 2 old
+file 2 new
`;

      const file1Content = new TextEncoder().encode("file 1 old\n");
      const file2Content = new TextEncoder().encode("file 2 old\n");

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      expect(patch.getFiles()).toHaveLength(2);

      const applier = new PatchApplier();

      const result1 = await applier.apply(patch.getFiles()[0], file1Content);
      expect(result1.success).toBe(true);
      expect(result1.content).not.toBeNull();
      const newContent1 = new TextDecoder().decode(result1.content);
      expect(newContent1).toBe("file 1 new\n");

      const result2 = await applier.apply(patch.getFiles()[1], file2Content);
      expect(result2.success).toBe(true);
      expect(result2.content).not.toBeNull();
      const newContent2 = new TextDecoder().decode(result2.content);
      expect(newContent2).toBe("file 2 new\n");
    });
  });

  describe("Whitespace handling", () => {
    it("should match lines ignoring trailing whitespace", async () => {
      const oldContent = new TextEncoder().encode("line 1  \nline 2\nline 3\t\n");

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

      const patch = new Patch();
      patch.parse(new TextEncoder().encode(patchText));

      const applier = new PatchApplier();
      const result = await applier.apply(patch.getFiles()[0], oldContent);

      expect(result.success).toBe(true);
      expect(result.content).not.toBeNull();

      const newContent = new TextDecoder().decode(result.content);
      // Should preserve the trailing whitespace from original lines
      expect(newContent).toContain("line 1");
      expect(newContent).toContain("line 2 modified");
      expect(newContent).toContain("line 3");
    });
  });
});
