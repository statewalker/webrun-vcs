import { createInMemoryFilesApi } from "@statewalker/vcs-core";
import { describe, expect, it } from "vitest";

import { GitStaging } from "../../src/staging/index.js";
import {
  clearSkipWorktreeFromPresentFiles,
  parseSparseCheckoutPatterns,
} from "../../src/working-copy/index.js";
import type { WorktreeEntry } from "../../src/worktree/index.js";

const ID = "0123456789abcdef0123456789abcdef01234567";

describe("parseSparseCheckoutPatterns", () => {
  it("cone patterns: the root's files, recursive and parent directories", () => {
    const sparse = parseSparseCheckoutPatterns("/*\n!/*/\n/k/\n/p/\n!/p/*/\n/p/q/\n", true);
    expect(sparse.cone).toBe(true);
    expect(sparse.includes("top")).toBe(true);
    expect(sparse.includes("k/a")).toBe(true);
    expect(sparse.includes("k/deep/a")).toBe(true);
    expect(sparse.includes("p/file")).toBe(true);
    expect(sparse.includes("p/other/x")).toBe(false);
    expect(sparse.includes("p/q/x/y")).toBe(true);
    expect(sparse.includes("s/b")).toBe(false);
  });

  it("a pattern not of the cone's shape falls back to gitignore-style matching", () => {
    const sparse = parseSparseCheckoutPatterns("/k/\n*.md\n", true);
    expect(sparse.cone).toBe(false);
    expect(sparse.includes("k/a")).toBe(true);
    expect(sparse.includes("s/readme.md")).toBe(true);
    expect(sparse.includes("top")).toBe(false);
  });

  it("non-cone: the last matching pattern decides, else the parent directories'", () => {
    const sparse = parseSparseCheckoutPatterns("/*\n!/s/\n/s/b\n", false);
    expect(sparse.includes("top")).toBe(true);
    expect(sparse.includes("s/c")).toBe(false);
    expect(sparse.includes("s/b")).toBe(true);
  });

  it("without a sparse-checkout file every path is in", () => {
    expect(parseSparseCheckoutPatterns(undefined, true).includes("any/path")).toBe(true);
  });
});

describe("clearSkipWorktreeFromPresentFiles", () => {
  it("clears the flag of present paths as part of the read, one stat per missing directory", async () => {
    const files = createInMemoryFilesApi();
    const staging = new GitStaging(files, "index");
    const paths = ["k/a", "s/b", "s/c", "s/t/d", "s/t/e", "u/v"];
    for (const path of paths) {
      await staging.setEntry({
        path,
        mode: 0o100644,
        objectId: ID,
        size: 1,
        mtime: 1,
        skipWorktree: path !== "k/a",
      });
    }
    await staging.write();
    await staging.read();
    const present = new Set(["k", "k/a", "s", "s/c"]);
    const asked: string[] = [];
    const worktree = {
      getEntry: async (path: string) => {
        asked.push(path);
        return present.has(path) ? ({ path } as unknown as WorktreeEntry) : undefined;
      },
    };
    expect(await clearSkipWorktreeFromPresentFiles(staging, worktree)).toEqual(["s/c"]);
    // git's path_found: the parents of a missing path are asked up to the first one missing
    // (s/t), and the paths under it are not asked (s/t/e)
    expect(asked).toEqual(["s/b", "s", "s/c", "s/t/d", "s/t", "u/v", "u"]);
    expect(staging.hasUnwrittenChanges()).toBe(false);
    expect((await staging.getEntry("s/c"))?.skipWorktree).toBe(false);
    // written with the next write
    await staging.write();
    const reread = new GitStaging(files, "index");
    await reread.read();
    expect((await reread.getEntry("s/c"))?.skipWorktree).toBeFalsy();
    expect((await reread.getEntry("s/b"))?.skipWorktree).toBe(true);
  });
});

describe("parseSparseCheckoutPatterns as git's dir.c reads the patterns", () => {
  it("a directory asked with a trailing slash: cone as `sub/-`, non-cone with an empty basename", () => {
    const cone = parseSparseCheckoutPatterns("/*\n!/*/\n/k/\n/p/\n!/p/*/\n", true);
    expect(cone.cone).toBe(true);
    // a root file, but a directory outside the cone
    expect(cone.includes("sub")).toBe(true);
    expect(cone.includes("sub/")).toBe(false);
    expect(cone.includes("k/")).toBe(true);
    expect(cone.includes("k/sub/")).toBe(true);
    expect(cone.includes("p/")).toBe(true);
    expect(cone.includes("p/sub/")).toBe(false);
    const nonCone = parseSparseCheckoutPatterns("/sub/\n", false);
    expect(nonCone.includes("sub")).toBe(false);
    expect(nonCone.includes("sub/")).toBe(true);
  });

  it("core.ignoreCase folds ASCII case in the cone's sets and in non-cone matching", () => {
    const cone = parseSparseCheckoutPatterns("/*\n!/*/\n/K/\n!/K/*/\n", true, true);
    expect(cone.cone).toBe(true);
    expect(cone.includes("k/n")).toBe(true);
    expect(cone.includes("k/z/n")).toBe(false);
    expect(parseSparseCheckoutPatterns("/*\n!/*/\n/K/\n", true).includes("k/n")).toBe(false);
    expect(parseSparseCheckoutPatterns("K/\n", false, true).includes("k/n")).toBe(true);
    expect(parseSparseCheckoutPatterns("K/\n", false).includes("k/n")).toBe(false);
  });

  it("the recursive set is a multiset: a repeated directory survives one parent pattern", () => {
    const sparse = parseSparseCheckoutPatterns("/*\n!/*/\n/b/\n/b/\n!/b/*/\n", true);
    expect(sparse.cone).toBe(true);
    expect(sparse.includes("b/a/x")).toBe(true);
    const once = parseSparseCheckoutPatterns("/*\n!/*/\n/b/\n!/b/*/\n", true);
    expect(once.includes("b/a/x")).toBe(false);
    expect(once.includes("b/y")).toBe(true);
  });

  it("a line of spaces or a bare CR is an empty pattern: no cone, an empty basename matched", () => {
    for (const blank of ["   ", "\r"]) {
      const sparse = parseSparseCheckoutPatterns(`/k/\n${blank}\n`, true);
      expect(sparse.cone).toBe(false);
      // non-cone: a root file is no longer included, `sub/` is (the empty pattern)
      expect(sparse.includes("top")).toBe(false);
      expect(sparse.includes("k/a")).toBe(true);
      expect(sparse.includes("sub/")).toBe(true);
    }
    // an empty line is skipped, a last line without a newline read
    const skipped = parseSparseCheckoutPatterns("/k/\n\n/m/", true);
    expect(skipped.cone).toBe(true);
    expect(skipped.includes("top")).toBe(true);
    expect(skipped.includes("m/a")).toBe(true);
    // a comment is told before the CR goes; ` #x` is a pattern (of no cone shape)
    expect(parseSparseCheckoutPatterns("/k/\n#x\r\n", true).cone).toBe(true);
    expect(parseSparseCheckoutPatterns("/k/\n #x\n", true).cone).toBe(false);
  });
});

describe("clearSkipWorktreeFromPresentFiles of conflict stages", () => {
  it("clears the flag of every stage of a present path, as git clears any ce_skip_worktree", async () => {
    const files = createInMemoryFilesApi();
    const staging = new GitStaging(files, "index");
    for (const stage of [1, 2, 3] as const) {
      await staging.setEntry({
        path: "s/c",
        mode: 0o100644,
        objectId: ID,
        stage,
        size: 1,
        mtime: 1,
        skipWorktree: true,
      });
    }
    await staging.write();
    await staging.read();
    const worktree = {
      getEntry: async (path: string) =>
        path === "s" || path === "s/c" ? ({ path } as unknown as WorktreeEntry) : undefined,
    };
    expect(await clearSkipWorktreeFromPresentFiles(staging, worktree)).toEqual(["s/c"]);
    await staging.write();
    const reread = new GitStaging(files, "index");
    await reread.read();
    const flags: Array<boolean | undefined> = [];
    for await (const entry of reread.entries()) flags.push(entry.skipWorktree);
    expect(flags).toEqual([false, false, false]);
  });
});
