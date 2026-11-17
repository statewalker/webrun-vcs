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

  it("an integer must fit git's int, with its unit (git_parse_int: ERANGE)", () => {
    for (const text of [
      "2147483648",
      "-2147483649",
      "4294967296",
      "0x80000000",
      "020000000000",
      "2g",
      "2048m",
      "2097152k",
      "9223372036854775807",
      "99999999999999999999999",
    ]) {
      expect([text, parseGitBool(text)]).toEqual([text, undefined]);
    }
    expect(parseGitBool(1.5)).toBeUndefined();
    expect(parseGitBool(2147483648)).toBeUndefined();
    expect(parseGitBool(-2147483649)).toBeUndefined();
    // INT_MIN fits an int: git 2.5x accepts it (2.43 refused it, an off-by-one since fixed)
    expect(parseGitBool(-2147483648)).toBe(true);
    expect(parseGitBool("-2147483648")).toBe(true);
    expect(parseGitBool(Number.POSITIVE_INFINITY)).toBeUndefined();
    for (const text of ["2147483647", "-2147483647", "1g", "0x7fffffff", "017777777777"]) {
      expect([text, parseGitBool(text)]).toEqual([text, true]);
    }
    expect(parseGitBool(2147483647)).toBe(true);
    expect(parseGitBool(-2147483647)).toBe(true);
    expect(parseGitBool("0g")).toBe(false);
  });
});
