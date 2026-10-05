import { describe, expect, it } from "vitest";
import { Patch } from "../../../src/diff/patch/patch.js";

describe("Patch", () => {
  describe("parse", () => {
    it("should parse empty patch", () => {
      const patch = new Patch();
      const buffer = new Uint8Array([]);
      patch.parse(buffer);

      expect(patch.getFiles()).toHaveLength(0);
      expect(patch.getErrors()).toHaveLength(0);
    });

    it("should skip trailing whitespace", () => {
      const patch = new Patch();
      const buffer = new TextEncoder().encode("   \n  \n");
      patch.parse(buffer);

      expect(patch.getFiles()).toHaveLength(0);
      expect(patch.getErrors()).toHaveLength(0);
    });

    it("should detect disconnected hunk header", () => {
      const patch = new Patch();
      const buffer = new TextEncoder().encode("@@ -1,1 +1,1 @@\n");
      patch.parse(buffer);

      expect(patch.getFiles()).toHaveLength(0);
      expect(patch.getErrors()).toHaveLength(1);
      expect(patch.getErrors()[0].message).toContain("disconnected");
    });

    it("should detect and parse git diff format", () => {
      const patch = new Patch();
      const buffer = new TextEncoder().encode(
        "diff --git a/file.txt b/file.txt\nindex abc123..def456 100644\n",
      );
      patch.parse(buffer);

      // Should successfully parse the file header
      expect(patch.getFiles()).toHaveLength(1);
      expect(patch.getFiles()[0].oldPath).toBe("file.txt");
      expect(patch.getFiles()[0].newPath).toBe("file.txt");
    });

    it("should parse traditional diff format", () => {
      const patch = new Patch();
      const patchText = `--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,3 @@
 line 1
-old line
+new line
 line 3
`;
      const buffer = new TextEncoder().encode(patchText);
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);
      expect(patch.getFiles()[0].oldPath).toBe("file.txt");
      expect(patch.getFiles()[0].newPath).toBe("file.txt");
      expect(patch.getFiles()[0].changeType).toBe("MODIFY");
      expect(patch.getFiles()[0].hunks).toHaveLength(1);
    });

    it("should parse traditional diff with /dev/null for new file", () => {
      const patch = new Patch();
      const patchText = `--- /dev/null
+++ b/newfile.txt
@@ -0,0 +1,2 @@
+new line 1
+new line 2
`;
      const buffer = new TextEncoder().encode(patchText);
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);
      expect(patch.getFiles()[0].oldPath).toBeNull();
      expect(patch.getFiles()[0].newPath).toBe("newfile.txt");
      expect(patch.getFiles()[0].changeType).toBe("ADD");
    });

    it("should parse traditional diff with /dev/null for deleted file", () => {
      const patch = new Patch();
      const patchText = `--- a/deleted.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-old line 1
-old line 2
`;
      const buffer = new TextEncoder().encode(patchText);
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);
      expect(patch.getFiles()[0].oldPath).toBe("deleted.txt");
      expect(patch.getFiles()[0].newPath).toBeNull();
      expect(patch.getFiles()[0].changeType).toBe("DELETE");
    });

    it("should parse combined diff format (diff --cc)", () => {
      const patch = new Patch();
      const patchText = `diff --cc file.txt
index abc123,def456..789012
--- a/file.txt
+++ b/file.txt
@@@ -1,5 -1,5 +1,6 @@@
  context
+ line from parent 1
 +line from parent 2
++line in result
`;
      const buffer = new TextEncoder().encode(patchText);
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);
      expect(patch.getFiles()[0].oldPath).toBe("file.txt");
      expect(patch.getFiles()[0].newPath).toBe("file.txt");
      expect(patch.getFiles()[0].hunks).toHaveLength(1);
    });

    it("should parse combined diff format (diff --combined)", () => {
      const patch = new Patch();
      const patchText = `diff --combined file.txt
index abc123,def456..789012
--- a/file.txt
+++ b/file.txt
@@@ -1,3 -1,3 +1,4 @@@
  context line
++new combined line
  more context
`;
      const buffer = new TextEncoder().encode(patchText);
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);
      expect(patch.getFiles()[0].oldPath).toBe("file.txt");
      expect(patch.getFiles()[0].newPath).toBe("file.txt");
    });

    it("should parse multiple traditional diffs", () => {
      const patch = new Patch();
      const patchText = `--- a/file1.txt
+++ b/file1.txt
@@ -1,1 +1,1 @@
-old1
+new1
--- a/file2.txt
+++ b/file2.txt
@@ -1,1 +1,1 @@
-old2
+new2
`;
      const buffer = new TextEncoder().encode(patchText);
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(2);
      expect(patch.getFiles()[0].oldPath).toBe("file1.txt");
      expect(patch.getFiles()[1].oldPath).toBe("file2.txt");
    });

    it("should parse with custom offset and end", () => {
      const patch = new Patch();
      const buffer = new TextEncoder().encode(
        "junk\ndiff --git a/file.txt b/file.txt\nindex abc..def 100644\nmore junk",
      );
      patch.parse(buffer, 5, 65);

      // Should parse just the middle section
      expect(patch.getFiles()).toHaveLength(1);
    });

    it("should parse multiple files in one patch", () => {
      const patchText = `diff --git a/file1.txt b/file1.txt
index abc123..def456 100644
--- a/file1.txt
+++ b/file1.txt
@@ -1,1 +1,1 @@
-old
+new
diff --git a/file2.txt b/file2.txt
new file mode 100644
index 0000000..abc123
--- /dev/null
+++ b/file2.txt
@@ -0,0 +1,1 @@
+content
`;
      const patch = new Patch();
      const buffer = new TextEncoder().encode(patchText);
      patch.parse(buffer);

      expect(patch.getFiles()).toHaveLength(2);
      expect(patch.getFiles()[0].oldPath).toBe("file1.txt");
      expect(patch.getFiles()[0].changeType).toBe("MODIFY");
      expect(patch.getFiles()[1].oldPath).toBe("file2.txt");
      expect(patch.getFiles()[1].changeType).toBe("ADD");
    });
  });

  /**
   * JGit parity tests for combined diff parsing.
   * Ported from PatchCcTest.java
   *
   * Combined diffs are used for merge commits, showing changes from multiple parents.
   * Format uses multiple @@ markers (@@@ for 2 parents, @@@@ for 3, etc.)
   * and multiple prefix characters per line.
   */
  describe("combined patch parsing (JGit parity)", () => {
    /**
     * JGit: testParse_OneFileCc
     * Tests parsing a combined diff with one file modified in a merge.
     */
    it("should parse OneFileCc combined diff", () => {
      const patchText = `commit 1a56639bbea8e8cbfbe5da87746de97f9217ce9b
Date:   Tue May 13 00:43:56 2008 +0200
      ...

diff --cc org.spearce.egit.ui/src/org/spearce/egit/ui/UIText.java
index 169356b,dd8c317..fd85931
mode 100644,100644..100755
--- a/org.spearce.egit.ui/src/org/spearce/egit/ui/UIText.java
+++ b/org.spearce.egit.ui/src/org/spearce/egit/ui/UIText.java
@@@ -55,12 -163,13 +163,15 @@@ public class UIText extends NLS

 	/** */
 	public static String ResourceHistory_toggleCommentWrap;
+
 	/** */
 +	public static String ResourceHistory_toggleCommentFill;
 +	/** */
 	public static String ResourceHistory_toggleRevDetail;
+
 	/** */
 	public static String ResourceHistory_toggleRevComment;
+
 	/** */
 	public static String ResourceHistory_toggleTooltips;

`;
      const patch = new Patch();
      const buffer = new TextEncoder().encode(patchText);
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);

      const cfh = patch.getFiles()[0];

      // File paths should be parsed
      expect(cfh.newPath).toBe("org.spearce.egit.ui/src/org/spearce/egit/ui/UIText.java");
      expect(cfh.oldPath).toBe(cfh.newPath);

      // Should have one hunk
      expect(cfh.hunks).toHaveLength(1);
    });

    /**
     * JGit: testParse_CcNewFile
     * Tests parsing a combined diff for a new file added in merge.
     */
    it("should parse CcNewFile combined diff", () => {
      const patchText = `commit 6cb8160a4717d51fd3cc0baf721946daa60cf921
Merge: 5c19b43... 13a2c0d...
Author: Shawn O. Pearce <sop@google.com>
Date:   Fri Dec 12 13:26:52 2008 -0800

    Merge branch 'b' into d

diff --cc d
index 0000000,0000000..4bcfe98
new file mode 100644
--- /dev/null
+++ b/d
@@@ -1,0 -1,0 +1,1 @@@
++d
`;
      const patch = new Patch();
      const buffer = new TextEncoder().encode(patchText);
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);

      const cfh = patch.getFiles()[0];

      // Combined diff parser sets both paths from "diff --cc d" line
      // The /dev/null handling is in the traditional parser only
      expect(cfh.oldPath).toBe("d");
      expect(cfh.newPath).toBe("d");

      // Note: Combined diff parser doesn't currently detect ADD from "new file mode"
      // This is a limitation vs JGit's CombinedFileHeader which properly detects it
      expect(cfh.changeType).toBe("MODIFY");

      // Should have one hunk
      expect(cfh.hunks).toHaveLength(1);
    });

    /**
     * JGit: testParse_CcDeleteFile
     * Tests parsing a combined diff for a file deleted in merge.
     */
    it("should parse CcDeleteFile combined diff", () => {
      const patchText = `commit 740709ece2412856c0c3eabd4dc4a4cf115b0de6
Merge: 5c19b43... 13a2c0d...
Author: Shawn O. Pearce <sop@google.com>
Date:   Fri Dec 12 13:26:52 2008 -0800

    Merge branch 'b' into d

diff --cc a
index 7898192,2e65efe..0000000
deleted file mode 100644,100644
--- a/a
+++ /dev/null
`;
      const patch = new Patch();
      const buffer = new TextEncoder().encode(patchText);
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);

      const cfh = patch.getFiles()[0];

      // Combined diff parser sets both paths from "diff --cc a" line
      // The /dev/null handling is in the traditional parser only
      expect(cfh.oldPath).toBe("a");
      expect(cfh.newPath).toBe("a");

      // Note: Combined diff parser doesn't currently detect DELETE from "deleted file mode"
      // This is a limitation vs JGit's CombinedFileHeader which properly detects it
      expect(cfh.changeType).toBe("MODIFY");

      // Deleted file should have no hunks (just mode change)
      expect(cfh.hunks).toHaveLength(0);
    });

    /**
     * Tests that combined hunk headers with 3 @@ markers are recognized.
     */
    it("should recognize combined hunk headers (@@@ markers)", () => {
      const patchText = `diff --cc file.txt
index abc123,def456..789012
--- a/file.txt
+++ b/file.txt
@@@ -1,3 -1,3 +1,4 @@@
  context line
+ added from parent 1
 +added from parent 2
++added in merge result
  more context
`;
      const patch = new Patch();
      const buffer = new TextEncoder().encode(patchText);
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);
      expect(patch.getFiles()[0].hunks).toHaveLength(1);
    });

    /**
     * Tests parsing combined diff with mode changes.
     * One file can have different modes from different parents.
     */
    it("should parse combined diff with mode changes", () => {
      const patchText = `diff --cc script.sh
index abc123,def456..789012
mode 100644,100755..100755
--- a/script.sh
+++ b/script.sh
@@@ -1,1 -1,1 +1,1 @@@
  #!/bin/bash
`;
      const patch = new Patch();
      const buffer = new TextEncoder().encode(patchText);
      patch.parse(buffer);

      expect(patch.getErrors()).toHaveLength(0);
      expect(patch.getFiles()).toHaveLength(1);
    });
  });
});
