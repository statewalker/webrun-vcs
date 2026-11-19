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
