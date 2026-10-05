import { describe, expect, it } from "vitest";
import { BinaryHunk } from "../../../src/diff/patch/binary-hunk.js";
import { BinaryHunkType } from "../../../src/diff/patch/types.js";

describe("BinaryHunk", () => {
  describe("parse", () => {
    it("should parse literal hunk header", () => {
      const hunk = `literal 1629
zcmV-j2BP_iP)<h;3K|Lk000e1NJLTq001BW001Be1^@s6b9#F800004b3#c}2nYxW
zd<bNS000IQNkl<ZScS!xeQcH08Nh$fdGGB9P;Q}RCD0F7u}~l_3X>XOp-ouEG7tw0

`;
      const buffer = new TextEncoder().encode(hunk);
      const binaryHunk = new BinaryHunk(buffer, 0);
      binaryHunk.parse(buffer.length);

      expect(binaryHunk.type).toBe(BinaryHunkType.LITERAL_DEFLATED);
      expect(binaryHunk.size).toBe(1629);
      expect(binaryHunk.dataStart).toBeGreaterThan(0);
      expect(binaryHunk.dataEnd).toBeGreaterThan(binaryHunk.dataStart);
    });

    it("should parse delta hunk header", () => {
      const hunk = `delta 14
ScmZp0Xmwa1z*+$U3j_csN(Dmz

`;
      const buffer = new TextEncoder().encode(hunk);
      const binaryHunk = new BinaryHunk(buffer, 0);
      binaryHunk.parse(buffer.length);

      expect(binaryHunk.type).toBe(BinaryHunkType.DELTA_DEFLATED);
      expect(binaryHunk.size).toBe(14);
      expect(binaryHunk.dataStart).toBeGreaterThan(0);
      expect(binaryHunk.dataEnd).toBeGreaterThan(binaryHunk.dataStart);
    });

    it("should parse literal hunk with large size", () => {
      const hunk = `literal 5389
zcmc&&X;f25x2=0gFa(g;$fO8C5fl|r2$Mhpf-;XXh+qO@qwRo*3aF3^Peq(ZoX{Y4
zI{-=?P(d+4RGeCZATuQ301AQ)VKCt)uP*jm>#bhz\`}L-^YNgIORkhFFyDIsSoS=YZ

`;
      const buffer = new TextEncoder().encode(hunk);
      const binaryHunk = new BinaryHunk(buffer, 0);
      binaryHunk.parse(buffer.length);

      expect(binaryHunk.type).toBe(BinaryHunkType.LITERAL_DEFLATED);
      expect(binaryHunk.size).toBe(5389);
    });

    it("should parse empty literal hunk", () => {
      const hunk = `literal 0
HcmV?d00001

`;
      const buffer = new TextEncoder().encode(hunk);
      const binaryHunk = new BinaryHunk(buffer, 0);
      binaryHunk.parse(buffer.length);

      expect(binaryHunk.type).toBe(BinaryHunkType.LITERAL_DEFLATED);
      expect(binaryHunk.size).toBe(0);
      expect(binaryHunk.dataStart).toBeGreaterThan(0);
      expect(binaryHunk.dataEnd).toBeGreaterThan(binaryHunk.dataStart);
    });

    it("should stop at blank line", () => {
      const hunks = `literal 14
ScmZp0Xmwa1z*+$U3j_csN(Dmz

delta 12
TcmZp5XmD5{u!xa=5hEi28?FP4
`;
      const buffer = new TextEncoder().encode(hunks);
      const hunk1 = new BinaryHunk(buffer, 0);
      const nextOffset = hunk1.parse(buffer.length);

      expect(hunk1.type).toBe(BinaryHunkType.LITERAL_DEFLATED);
      expect(hunk1.size).toBe(14);

      // Should stop at blank line before "delta"
      const nextHunkStart = hunks.indexOf("delta");
      expect(nextOffset).toBeLessThanOrEqual(nextHunkStart);

      // Parse second hunk
      const hunk2 = new BinaryHunk(buffer, nextHunkStart);
      hunk2.parse(buffer.length);

      expect(hunk2.type).toBe(BinaryHunkType.DELTA_DEFLATED);
      expect(hunk2.size).toBe(12);
    });

    it("should stop at next file header", () => {
      const data = `literal 100
zcmV-j2BP_iP)<h;3K|Lk000e1NJLTq001BW001Be1^@s6b9#F800004b3#c}2nYxW
diff --git a/file.txt b/file.txt
`;
      const buffer = new TextEncoder().encode(data);
      const binaryHunk = new BinaryHunk(buffer, 0);
      const nextOffset = binaryHunk.parse(buffer.length);

      expect(binaryHunk.type).toBe(BinaryHunkType.LITERAL_DEFLATED);
      expect(binaryHunk.size).toBe(100);

      // Should stop at "diff --git"
      const diffStart = data.indexOf("diff --git");
      expect(nextOffset).toBe(diffStart);
    });

    it("should parse hunk at non-zero offset", () => {
      const text = "GIT binary patch\nliteral 42\nABCDEF\n\n";
      const buffer = new TextEncoder().encode(text);
      const literalStart = text.indexOf("literal");
      const binaryHunk = new BinaryHunk(buffer, literalStart);
      binaryHunk.parse(buffer.length);

      expect(binaryHunk.type).toBe(BinaryHunkType.LITERAL_DEFLATED);
      expect(binaryHunk.size).toBe(42);
    });

    it("should handle hunk at end of buffer", () => {
      const hunk = `literal 10
ABCDEFGHIJ`;
      const buffer = new TextEncoder().encode(hunk);
      const binaryHunk = new BinaryHunk(buffer, 0);
      const nextOffset = binaryHunk.parse(buffer.length);

      expect(binaryHunk.type).toBe(BinaryHunkType.LITERAL_DEFLATED);
      expect(binaryHunk.size).toBe(10);
      expect(nextOffset).toBe(buffer.length);
    });

    it("should handle malformed hunk gracefully", () => {
      const hunk = "unknown 123\n";
      const buffer = new TextEncoder().encode(hunk);
      const binaryHunk = new BinaryHunk(buffer, 0);
      const nextOffset = binaryHunk.parse(buffer.length);

      // Should skip to end of line for unknown type
      expect(nextOffset).toBeGreaterThan(0);
    });
  });

  describe("getData", () => {
    it("should decode base85 data from JGit test file", () => {
      // Real base85-encoded data from JGit test file (literal_add.patch)
      const hunk = `literal 1629
zcmV-j2BP_iP)<h;3K|Lk000e1NJLTq001BW001Be1^@s6b9#F800004b3#c}2nYxW
zd<bNS000IQNkl<ZScS!xeQcH08Nh$fdGGB9P;Q}RCD0F7u}~l_3X>XOp-ouEG7tw0

`;
      const buffer = new TextEncoder().encode(hunk);
      const binaryHunk = new BinaryHunk(buffer, 0);
      binaryHunk.parse(buffer.length);

      // getData should not throw
      const data = binaryHunk.getData();
      expect(data).toBeInstanceOf(Uint8Array);
      // The decoded data should be non-empty
      expect(data.length).toBeGreaterThan(0);
    });

    it("should return empty array for empty data range", () => {
      const buffer = new Uint8Array([]);
      const binaryHunk = new BinaryHunk(buffer, 0);
      binaryHunk.dataStart = 0;
      binaryHunk.dataEnd = 0;

      const data = binaryHunk.getData();
      expect(data).toBeInstanceOf(Uint8Array);
      expect(data.length).toBe(0);
    });
  });

  describe("toString", () => {
    it("should format literal hunk", () => {
      const hunk = "literal 100\nABCD\n\n";
      const buffer = new TextEncoder().encode(hunk);
      const binaryHunk = new BinaryHunk(buffer, 0);
      binaryHunk.parse(buffer.length);

      expect(binaryHunk.toString()).toContain("LITERAL_DEFLATED");
      expect(binaryHunk.toString()).toContain("100");
    });

    it("should format delta hunk", () => {
      const hunk = "delta 50\nXYZ\n\n";
      const buffer = new TextEncoder().encode(hunk);
      const binaryHunk = new BinaryHunk(buffer, 0);
      binaryHunk.parse(buffer.length);

      expect(binaryHunk.toString()).toContain("DELTA_DEFLATED");
      expect(binaryHunk.toString()).toContain("50");
    });
  });
});
