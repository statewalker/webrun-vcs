import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareRefNames,
  isValidBranchName,
  isValidRefName,
  isValidTagName,
} from "../../../src/history/refs/index.js";

interface Case {
  name: string;
  valid: boolean;
  validOneLevel: boolean;
}
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/refname-git.json", import.meta.url), "utf8"),
) as { source: string; cases: Case[] };

describe("isValidRefName follows git check-ref-format", () => {
  it(`agrees with ${fixture.source} on ${fixture.cases.length} names`, () => {
    const wrong = fixture.cases.filter((c) => isValidRefName(c.name) !== c.valid);
    expect(wrong.map((c) => JSON.stringify(c.name))).toEqual([]);
  });

  it("agrees with --allow-onelevel on the same names", () => {
    const wrong = fixture.cases.filter(
      (c) => isValidRefName(c.name, { allowOneLevel: true }) !== c.validOneLevel,
    );
    expect(wrong.map((c) => JSON.stringify(c.name))).toEqual([]);
  });

  it("covers the rules the earlier check missed", () => {
    for (const name of [
      "refs/heads/.hidden",
      "refs/heads/x.lock/y",
      "refs/heads/x.",
      "@",
      "refs/heads/a/./b",
    ]) {
      expect(isValidRefName(name), name).toBe(false);
    }
    // Not UTF-8 encodable, so git could never be given this name.
    expect(isValidRefName("refs/heads/\ud800")).toBe(false);
    expect(isValidRefName("refs/heads/a\udc00b")).toBe(false);
    expect(isValidRefName("main")).toBe(false);
    expect(isValidRefName("main", { allowOneLevel: true })).toBe(true);
  });
});

describe("compareRefNames sorts as git does (byte order of UTF-8)", () => {
  it("puts uppercase before lowercase and non-ASCII last", () => {
    const names = [
      "refs/heads/a",
      "refs/heads/é",
      "refs/heads/B",
      "refs/heads/a/b",
      "refs/heads/a-b",
    ];
    expect([...names].sort(compareRefNames)).toEqual([
      "refs/heads/B",
      "refs/heads/a",
      "refs/heads/a-b",
      "refs/heads/a/b",
      "refs/heads/é",
    ]);
  });

  it("orders astral characters by code point, not UTF-16 unit", () => {
    // U+FF5E (one UTF-16 unit, 0xFF5E) sorts before U+1F600 (surrogates 0xD83D…): byte order agrees.
    expect(compareRefNames("refs/\u{ff5e}", "refs/\u{1f600}")).toBeLessThan(0);
    expect(compareRefNames("refs/a", "refs/a")).toBe(0);
    expect(compareRefNames("refs/a", "refs/ab")).toBeLessThan(0);
  });
});

describe("isValidBranchName and isValidTagName", () => {
  it("apply git branch's and git tag's extra rules on top of the ref-name rules", () => {
    for (const name of ["-x", "HEAD", "a/.hidden", "a@{x", ""]) {
      expect(isValidBranchName(name), name).toBe(false);
      expect(isValidTagName(name), name).toBe(false);
    }
    for (const name of ["@", "feature/x", "naïve", "refs/heads/x"]) {
      expect(isValidBranchName(name), name).toBe(true);
      expect(isValidTagName(name), name).toBe(true);
    }
  });
});

describe("compareRefNames agrees with UTF-8 byte order", () => {
  it("on random pairs drawn from ASCII, BMP above the surrogates, and astral characters", () => {
    const pool = ["a", "B", "-", "/", "é", "\ue000", "\uff5e", "\uffff", "😀", "\u{10ffff}", "𐀀"];
    let seed = 7;
    const pick = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return pool[seed % pool.length] as string;
    };
    const enc = new TextEncoder();
    const byteOrder = (a: string, b: string) => Buffer.compare(enc.encode(a), enc.encode(b));
    for (let i = 0; i < 5000; i++) {
      const a = `refs/${pick()}${pick()}${pick()}`;
      const b = `refs/${pick()}${pick()}${pick()}`;
      expect(Math.sign(compareRefNames(a, b)), `${a} ${b}`).toBe(Math.sign(byteOrder(a, b)));
    }
  });
});
