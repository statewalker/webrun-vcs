import { FileMode } from "@statewalker/vcs-core";
import { describe, expect, it, vi } from "vitest";
import type { StagingEntry } from "../../src/staging/index.js";
import { compareWithWorktree } from "../../src/status/worktree-status.js";
import type { WorktreeEntry } from "../../src/worktree/index.js";
import type { Worktree } from "../../src/worktree/worktree.js";

/**
 * An index written by a git without nanosecond support (as some distributions build it) keeps
 * whole-second times. Such an entry must still match a file whose filesystem time has a
 * fraction, and its raciness is judged in whole seconds, as that git judges it.
 */
describe("compareWithWorktree with whole-second index times", () => {
  const OBJECT = "a".repeat(40);

  function worktreeWith(current: Partial<WorktreeEntry>) {
    const computeHash = vi.fn(async () => OBJECT);
    const worktree = {
      capabilities: { executable: true, symlinks: true },
      getEntry: vi.fn(async (path: string) => ({
        path,
        name: path,
        mode: FileMode.REGULAR_FILE,
        isDirectory: false,
        isIgnored: false,
        ...current,
      })),
      computeHash,
    } as unknown as Worktree;
    return { worktree, computeHash };
  }

  function entry(times: { mtime: number; ctime?: number }): StagingEntry {
    return {
      path: "a.txt",
      mode: FileMode.REGULAR_FILE,
      objectId: OBJECT,
      stage: 0,
      size: 6,
      ...times,
    } as unknown as StagingEntry;
  }

  it("matches a file whose times carry a fraction the index did not keep", async () => {
    const second = 1_700_000_000_000;
    const { worktree, computeHash } = worktreeWith({
      size: 6,
      mtime: second + 437.25,
      ctime: second + 912.5,
    });
    const result = await compareWithWorktree(worktree, entry({ mtime: second, ctime: second }), {
      indexTime: second + 60_000,
    });
    expect(result.kind).toBeUndefined();
    expect(computeHash).not.toHaveBeenCalled();
  });

  it("still re-hashes a whole-second entry written in the same second as the index", async () => {
    const second = 1_700_000_000_000;
    const { worktree, computeHash } = worktreeWith({ size: 6, mtime: second + 100 });
    await compareWithWorktree(worktree, entry({ mtime: second }), { indexTime: second + 900 });
    expect(computeHash).toHaveBeenCalledTimes(1);
  });

  it("ignores a fraction recorded a few nanoseconds off (seen with git 2.56.1 on CI)", async () => {
    // the index kept mtime .724000000 for a file whose filesystem time is .723999977
    const second = 1_794_774_513_000;
    const { worktree, computeHash } = worktreeWith({
      size: 2,
      mtime: second + 723.999977,
      ctime: second + 120_723.492678,
    });
    const result = await compareWithWorktree(
      worktree,
      { ...entry({ mtime: second + 724, ctime: second + 120_723.492678 }), size: 2 },
      { indexTime: second + 120_789 },
    );
    expect(result.kind).toBeUndefined();
    expect(computeHash).not.toHaveBeenCalled();
  });

  it("re-hashes an entry modified in the same second as the index, whatever its fraction", async () => {
    const second = 1_700_000_000_000;
    const { worktree, computeHash } = worktreeWith({ size: 6, mtime: second + 437 });
    await compareWithWorktree(worktree, entry({ mtime: second + 437 }), {
      indexTime: second + 900,
    });
    expect(computeHash).toHaveBeenCalledTimes(1);
  });
});
