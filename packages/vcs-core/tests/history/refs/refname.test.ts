import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compareRefNames, isValidRefName } from "../../../src/history/refs/index.js";

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
