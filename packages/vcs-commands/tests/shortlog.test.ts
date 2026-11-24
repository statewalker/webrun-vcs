import { describe, expect, it } from "vitest";

import { commitSubject, GitApiError, parseShortlogWrap, Shortlog } from "../src/index.js";

describe("Shortlog", () => {
  it("groups subjects by name in byte order, oldest first, [PATCH] prefixes dropped", () => {
    const log = new Shortlog();
    log.insert("b", "[PATCH 2/2] second\n");
    log.insert("a", "  only");
    log.insert("b", "first\nline two");
    expect(log.text()).toBe("a (1):\n      only\n\nb (2):\n      first line two\n      second\n\n");
  });

  it("sorts by count with -n, keeping name order between equal counts, and counts with -s", () => {
    const log = new Shortlog({ summary: true, numbered: true });
    for (const name of ["c", "b", "b", "a"]) log.insert(name, "");
    expect(log.text()).toBe("     2\tb\n     1\ta\n     1\tc\n");
  });

  it("takes %s as the first paragraph after blank lines", () => {
    expect(commitSubject("\n  \nOne\ntwo  \n\nbody")).toBe("One two");
  });
});

describe("parseShortlogWrap", () => {
  it("reads -w's numbers with git's defaults", () => {
    expect(parseShortlogWrap()).toEqual({ width: 76, indent1: 6, indent2: 9 });
    expect(parseShortlogWrap("60,2")).toEqual({ width: 60, indent1: 2, indent2: 9 });
    expect(parseShortlogWrap(",,3")).toEqual({ width: 76, indent1: 6, indent2: 3 });
  });

  it("refuses widths not above the indents and stray characters (exit 129)", () => {
    for (const bad of ["10,20", "x", "5,1,7", "-1"]) {
      const error = (() => {
        try {
          parseShortlogWrap(bad);
        } catch (e) {
          return e;
        }
      })();
      expect(error).toBeInstanceOf(GitApiError);
      expect((error as GitApiError).exitCode).toBe(129);
    }
  });
});
