/**
 * mergeLines: a three-way line merge that keeps every byte (CRLF, no final newline, any
 * encoding) and writes git's conflict markers with labels.
 */

import { describe, expect, it } from "vitest";
import { ByteLines, mergeLines } from "../../../src/diff/text-diff/index.js";

const e = (s: string) => new TextEncoder().encode(s);
const latin1 = (s: string) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
const text = (u: Uint8Array) => String.fromCharCode(...u);
const merge = (base: string, ours: string, theirs: string) =>
  mergeLines(latin1(base), latin1(ours), latin1(theirs), { oursLabel: "A", theirsLabel: "B" });

describe("ByteLines", () => {
  it("splits after LF and keeps terminators", () => {
    const lines = new ByteLines(e("a\r\nb\nc"));
    expect(lines.size()).toBe(3);
    expect(text(lines.line(0))).toBe("a\r\n");
    expect(text(lines.line(2))).toBe("c");
    expect(new ByteLines(new Uint8Array(0)).size()).toBe(0);
    expect(new ByteLines(e("x\n")).size()).toBe(1);
  });
});

describe("mergeLines", () => {
  it("merges changes on separate lines", () => {
    const r = merge("1\n2\n3\n4\n5\n", "1a\n2\n3\n4\n5\n", "1\n2\n3\n4\n5b\n");
    expect(r.conflicts).toBe(0);
    expect(text(r.content)).toBe("1a\n2\n3\n4\n5b\n");
  });

  it("keeps CRLF line endings", () => {
    const r = merge("a\r\nb\r\nc\r\nd\r\n", "A\r\nb\r\nc\r\nd\r\n", "a\r\nb\r\nc\r\nD\r\n");
    expect(r.conflicts).toBe(0);
    expect(text(r.content)).toBe("A\r\nb\r\nc\r\nD\r\n");
  });

  it("keeps a missing final newline, and adds none", () => {
    expect(text(merge("a\nb\nc\nd", "A\nb\nc\nd", "a\nb\nc\nD").content)).toBe("A\nb\nc\nD");
    expect(text(merge("a\nb\nc", "a\nb\nc", "a\nb\nC").content)).toBe("a\nb\nC");
    // adding the final newline is a change of the last line
    expect(text(merge("a\nb\nc\nd", "A\nb\nc\nd", "a\nb\nc\nd\n").content)).toBe("A\nb\nc\nd\n");
  });

  it("does not decode: Latin-1 bytes pass through", () => {
    const r = merge("caf\xe9\nb\nc\nd\n", "caf\xe9\nB\nc\nd\n", "caf\xe9\nb\nc\nD\n");
    expect(r.conflicts).toBe(0);
    expect([...r.content]).toEqual([...latin1("caf\xe9\nB\nc\nD\n")]);
  });

  it("writes git's markers with labels", () => {
    const r = merge("x\ny\n", "x1\ny\n", "x2\ny\n");
    expect(r.conflicts).toBe(1);
    expect(text(r.content)).toBe("<<<<<<< A\nx1\n=======\nx2\n>>>>>>> B\ny\n");
  });

  it("markers follow the file's line ending, and end an unterminated last line", () => {
    const crlf = merge("x\r\n", "y\r\n", "z\r\n");
    expect(text(crlf.content)).toBe("<<<<<<< A\r\ny\r\n=======\r\nz\r\n>>>>>>> B\r\n");
    const noEol = merge("x", "y", "z");
    expect(text(noEol.content)).toBe("<<<<<<< A\ny\n=======\nz\n>>>>>>> B\n");
  });

  it("same change on both sides is clean; adjacent changes conflict (as git)", () => {
    expect(merge("", "a\n", "a\n")).toMatchObject({ conflicts: 0 });
    expect(text(merge("", "a\n", "a\n").content)).toBe("a\n");
    expect(merge("1\n2\n3\n", "1x\n2\n3\n", "1\n2x\n3\n").conflicts).toBe(1);
  });

  it("one side deleting lines, the other editing elsewhere", () => {
    const r = merge("a\nb\nc\nd\ne\n", "a\nc\nd\ne\n", "a\nb\nc\nd\nE\n");
    expect(text(r.content)).toBe("a\nc\nd\nE\n");
  });
});
