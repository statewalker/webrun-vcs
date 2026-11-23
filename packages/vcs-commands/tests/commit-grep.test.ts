/**
 * grep.c's commit matching on raw commit objects (no native git needed); the native twins
 * are in `log-grep-native.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  applyMailmapToHeader,
  compileCommitGrep,
  compilePcreSubset,
  GrepPatternError,
  Mailmap,
  PcreUnsupportedError,
} from "../src/index.js";

const enc = new TextEncoder();
const commit = (author: string, message: string) =>
  enc.encode(
    `tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nauthor ${author} 1112912053 -0700\n` +
      `committer C O Mitter <c@example.com> 1112912053 -0700\n\n${message}`,
  );

describe("compileCommitGrep", () => {
  const thor = commit("A U Thor <author@example.com>", "third\n\nbody\n");

  it("matches header patterns after the field name and before the date", () => {
    expect(compileCommitGrep({ authors: ["^A U"] }).matches(thor)).toBe(true);
    expect(compileCommitGrep({ authors: ["com>$"] }).matches(thor)).toBe(true);
    expect(compileCommitGrep({ authors: ["-0700"] }).matches(thor)).toBe(false);
    expect(compileCommitGrep({ authors: ["Mitter"] }).matches(thor)).toBe(false);
    expect(compileCommitGrep({ committers: ["Mitter"] }).matches(thor)).toBe(true);
  });

  it("matches message patterns from the empty line on, never in the header", () => {
    expect(compileCommitGrep({ messages: ["^tree"] }).matches(thor)).toBe(false);
    expect(compileCommitGrep({ messages: ["^$"] }).matches(thor)).toBe(true);
    expect(compileCommitGrep({ messages: ["body"] }).matches(thor)).toBe(true);
  });

  it("follows --all-match and --invert-grep", () => {
    expect(compileCommitGrep({ messages: ["third", "nope"] }).matches(thor)).toBe(true);
    expect(compileCommitGrep({ messages: ["third", "nope"], allMatch: true }).matches(thor)).toBe(
      false,
    );
    expect(compileCommitGrep({ messages: ["third"], invertGrep: true }).matches(thor)).toBe(false);
    // --invert-grep inverts --grep only: the author must still match
    expect(
      compileCommitGrep({ messages: ["nope"], authors: ["Thor"], invertGrep: true }).matches(thor),
    ).toBe(true);
    expect(
      compileCommitGrep({ messages: ["nope"], authors: ["Zed"], invertGrep: true }).matches(thor),
    ).toBe(false);
  });

  it("dies on patterns git refuses, with git's line", () => {
    expect(() => compileCommitGrep({ messages: ["\\("] })).toThrow(GrepPatternError);
    expect(() => compileCommitGrep({ authors: ["\\("] })).toThrow(
      "fatal: header, '\\(': Unmatched ( or \\(",
    );
  });

  it("matches the mailmapped identity", () => {
    const old = commit("Old Name <old@example.com>", "x\n");
    const mailmap = new Mailmap().read("New Name <new@example.com> <old@example.com>\n");
    expect(compileCommitGrep({ authors: ["New Name <new@"], mailmap }).matches(old)).toBe(true);
    expect(compileCommitGrep({ authors: ["Old"], mailmap }).matches(old)).toBe(false);
    expect(new TextDecoder().decode(applyMailmapToHeader(old, mailmap))).toContain(
      "author New Name <new@example.com> 1112912053 -0700\n",
    );
  });
});

describe("compilePcreSubset", () => {
  const line = (s: string) => enc.encode(s);

  it("runs PCRE2 syntax with byte semantics", () => {
    expect(compilePcreSubset("fi(?=x)").test(line("fix"))).toBe(true);
    expect(compilePcreSubset("[\\d]").test(line("d"))).toBe(false);
    expect(compilePcreSubset("a.b").test(line("a\rb"))).toBe(true);
    expect(compilePcreSubset("\\s").test(enc.encode("\u00a0"))).toBe(false);
    expect(compilePcreSubset("(?i)abc").test(line("ABC"))).toBe(true);
    expect(compilePcreSubset("\\Qa.b\\E").test(line("axb"))).toBe(false);
  });

  it("refuses what it cannot run as PCRE2 does", () => {
    for (const p of ["a++", "(?>a)", "\\p{L}", "a(?R)", "\\K", "(*UTF)a", "x(?i)y"]) {
      expect(() => compilePcreSubset(p)).toThrow(PcreUnsupportedError);
    }
  });
});
