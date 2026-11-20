/**
 * verifyTreePaths (git's verify_cache, exhaustive): entries in index order are checked in one
 * pass, each directory looked up once by the entry that opens it; any other order falls back
 * to the whole check. Both refuse the same lists with the same message.
 */
import { describe, expect, it } from "vitest";
import { verifyTreePaths } from "../../src/index.js";

const entries = (...paths: string[]) => paths.map((path) => ({ path }));

/** The message the check throws, or undefined when it passes. */
function refusal(paths: string[]): string | undefined {
  try {
    verifyTreePaths(entries(...paths));
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describe("verifyTreePaths", () => {
  it("passes paths no tree clash is in", () => {
    expect(refusal(["a-b", "a.c", "a/b", "a/c/d", "a0", "b"])).toBeUndefined();
    expect(refusal([])).toBeUndefined();
  });

  it("finds a file that is also a directory with other paths between them", () => {
    // "a" < "a-x" < "a.c" < "a/b" in byte order: git's neighbour check misses this one
    expect(refusal(["a", "a-x", "a.c", "a/b"])).toBe("You have both a and a/b");
    expect(refusal(["d/a", "d/a-x", "d/a/b"])).toBe("You have both d/a and d/a/b");
    expect(refusal(["x/y", "x/y/z/w"])).toBe("You have both x/y and x/y/z/w");
  });

  it("reports a path given twice before any clash, as the whole check does", () => {
    expect(refusal(["a", "a/b", "c", "c"])).toBe("You have c twice");
  });

  it("checks lists out of order as a whole", () => {
    expect(refusal(["b", "a/b", "a"])).toBe("You have both a and a/b");
    expect(refusal(["b", "a", "b"])).toBe("You have b twice");
    expect(refusal(["b/c", "a"])).toBeUndefined();
  });

  it("orders paths with characters beyond the BMP by their bytes", () => {
    // U+1F600 (a surrogate pair) sorts after U+FF5E in bytes, before it in UTF-16
    expect(refusal(["d/～", "d/😀", "d/😀/x"])).toBe("You have both d/😀 and d/😀/x");
    expect(refusal(["d/～", "d/😀/x"])).toBeUndefined();
  });

  it("matches the whole check on random lists, sorted or not", () => {
    let seed = 1;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const names = ["a", "b", "a-b", "a.b", "a0"];
    for (let round = 0; round < 300; round++) {
      const set = new Set<string>();
      const count = 1 + next(8);
      for (let i = 0; i < count; i++) {
        const depth = 1 + next(3);
        const parts: string[] = [];
        for (let d = 0; d < depth; d++) parts.push(names[next(names.length)] as string);
        set.add(parts.join("/"));
      }
      const list = [...set];
      if (next(4) === 0) list.push(list[0] as string);
      const sorted = next(2) === 0;
      if (sorted) list.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
      expect(refusal(list)).toBe(wholeCheck(list));
    }
  });
});

/** The check over the whole list, as it was written before (a set of every path). */
function wholeCheck(paths: string[]): string | undefined {
  const files = new Set<string>();
  for (const path of paths) {
    if (files.has(path)) return `You have ${path} twice`;
    files.add(path);
  }
  for (const path of paths) {
    for (let at = path.indexOf("/"); at >= 0; at = path.indexOf("/", at + 1)) {
      if (files.has(path.slice(0, at))) return `You have both ${path.slice(0, at)} and ${path}`;
    }
  }
  return undefined;
}
