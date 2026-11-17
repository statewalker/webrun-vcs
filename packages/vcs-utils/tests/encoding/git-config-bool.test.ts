import { describe, expect, it } from "vitest";

import { parseGitBool } from "../../src/encoding/index.js";

describe("parseGitBool (git_config_bool)", () => {
  it("a key with no `=` (the boolean true) is true; an empty value is false", () => {
    expect(parseGitBool(true)).toBe(true);
    expect(parseGitBool(false)).toBe(false);
    expect(parseGitBool("")).toBe(false);
  });

  it("the spellings in any case", () => {
    for (const text of ["true", "TRUE", "Yes", "on"]) expect(parseGitBool(text)).toBe(true);
    for (const text of ["false", "No", "OFF"]) expect(parseGitBool(text)).toBe(false);
  });

  it("integers as git_parse_int reads them: base 0, a unit, leading blanks", () => {
    expect(parseGitBool(0)).toBe(false);
    expect(parseGitBool(2)).toBe(true);
    expect(parseGitBool("1")).toBe(true);
    expect(parseGitBool("0")).toBe(false);
    expect(parseGitBool("-0")).toBe(false);
    expect(parseGitBool("+3")).toBe(true);
    expect(parseGitBool("0x10")).toBe(true);
    expect(parseGitBool("0x0")).toBe(false);
    expect(parseGitBool("010")).toBe(true);
    expect(parseGitBool("1k")).toBe(true);
    expect(parseGitBool("0G")).toBe(false);
    expect(parseGitBool(" 1")).toBe(true);
  });

  it("anything else is not a boolean (git refuses it)", () => {
    for (const text of [" true", "true ", "1 ", "09", "0x", "1x", "maybe", "1.5"]) {
      expect(parseGitBool(text)).toBeUndefined();
    }
    expect(parseGitBool(undefined)).toBeUndefined();
    expect(parseGitBool(null)).toBeUndefined();
    expect(parseGitBool(Number.NaN)).toBeUndefined();
  });
});
