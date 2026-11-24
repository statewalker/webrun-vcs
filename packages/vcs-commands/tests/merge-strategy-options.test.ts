/**
 * merge-ort's `-X` options as parse_merge_opt reads them, and diff.c's parse_rename_score.
 */

import { describe, expect, it } from "vitest";

import { parseRenameScore } from "../src/commands/merge-strategy-options.js";
import { parseStrategyOptions, UnknownStrategyOptionError } from "../src/index.js";

describe("parseStrategyOptions", () => {
  it("keeps the last of each kind and adds whitespace bits", () => {
    const options = parseStrategyOptions([
      "ignore-space-change",
      "ignore-cr-at-eol",
      "find-renames=25%",
      "no-renames",
      "patience",
      "subtree=lib",
      "theirs",
    ]);
    expect(options.whitespace).toBe((1 << 2) | (1 << 4));
    expect(options.renames).toBe(false);
    expect(options.renameScore).toBe(15000);
    expect(options.algorithm).toBe("patience");
    expect(options.subtreeShift).toBe("lib");
    expect(options.favor).toBe("theirs");
  });

  it("diff-algorithm=minimal stays minimal until another algorithm", () => {
    expect(parseStrategyOptions(["diff-algorithm=minimal"])).toMatchObject({
      algorithm: "myers",
      minimal: true,
    });
    expect(parseStrategyOptions(["diff-algorithm=Histogram"]).algorithm).toBe("histogram");
  });

  it("refuses unknown options and bad scores, unless lenient", () => {
    for (const bad of ["bogus", "find-renames=-25", "rename-threshold=0xf", "diff-algorithm=x"]) {
      expect(() => parseStrategyOptions([bad])).toThrow(UnknownStrategyOptionError);
    }
    expect(parseStrategyOptions(["bogus", "patience"], true).algorithm).toBe("patience");
  });
});

describe("parseRenameScore", () => {
  it("reads percentages, fractions and plain digits as git does", () => {
    expect(parseRenameScore("50%")).toEqual({ score: 30000, rest: "" });
    expect(parseRenameScore("50")).toEqual({ score: 30000, rest: "" });
    expect(parseRenameScore("0.5")).toEqual({ score: 30000, rest: "" });
    expect(parseRenameScore("200%").score).toBe(60000);
    expect(parseRenameScore("0xf")).toEqual({ score: 0, rest: "xf" });
  });
});
