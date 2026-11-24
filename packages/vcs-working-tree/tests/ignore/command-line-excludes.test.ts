import type { Blobs, Trees } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";
import { commandLineExcluded, createCommandLineExcludes } from "../../src/ignore/index.js";
import { createMemoryWorktree } from "../../src/worktree/index.js";

const enc = new TextEncoder();

describe("command-line excludes (git clean -e, EXC_CMDL)", () => {
  it("takes a pattern starting with # whole, as add_pattern does (no comment)", () => {
    const node = createCommandLineExcludes(["#foo"]);
    expect(commandLineExcluded(node, "#foo", false)).toBe(true);
    expect(commandLineExcluded(node, "foo", false)).toBe(false);
    const negated = createCommandLineExcludes(["*", "!#foo"]);
    expect(commandLineExcluded(negated, "#foo", false)).toBe(false);
    expect(commandLineExcluded(negated, "bar", false)).toBe(true);
  });

  /** A memory worktree with `*.o` ignored and a.o, b.o, c.txt, d/x.o. */
  async function worktree() {
    const wt = createMemoryWorktree({
      blobs: {} as Blobs,
      trees: {} as Trees,
      ignorePatterns: ["*.o"],
    });
    for (const path of ["a.o", "b.o", "c.txt", "d/x.o"])
      await wt.writeContent(path, enc.encode(""));
    return wt;
  }
  const ignored = async (excludePatterns: string[]) => {
    const out: string[] = [];
    for await (const e of (await worktree()).walk({ includeIgnored: true, excludePatterns })) {
      if (!e.isDirectory && e.isIgnored) out.push(e.path);
    }
    return out.sort();
  };

  it("a MemoryWorktree walk asks the command line's rules before its own", async () => {
    expect(await ignored([])).toEqual(["a.o", "b.o", "d/x.o"]);
    // `!a.o` re-includes what *.o ignores (git clean -X -e '!a.o' keeps a.o)
    expect(await ignored(["!a.o"])).toEqual(["b.o", "d/x.o"]);
    expect(await ignored(["c.txt"])).toEqual(["a.o", "b.o", "c.txt", "d/x.o"]);
    // a directory the command line excludes excludes what is in it
    expect(await ignored(["d", "!x.o"])).toEqual(["a.o", "b.o", "d/x.o"]);
    expect(await ignored(["#foo"])).toEqual(["a.o", "b.o", "d/x.o"]);
  });
});
