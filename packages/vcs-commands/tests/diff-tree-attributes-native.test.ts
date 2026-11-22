/**
 * The attribute stack of a diff's drivers, against native git: a diff of two trees (`git diff
 * A B`, `git log -p`, `git show`) reads no index (builtin/diff.c's builtin_diff_tree), so an
 * in-tree `.gitattributes` gone from the worktree but still in the index is not read; the
 * diffs against the index (`--cached`) or the worktree read it from the index.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openOurs, put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(root),
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });

/**
 * `sub/e.dat` changed by HEAD; `sub/.gitattributes` (`*.dat diff`: the default funcname)
 * deleted from the worktree only, the root's worktree `.gitattributes` naming the `cfun`
 * driver, whose funcname finds the indented `func` line the default one passes over.
 */
function build(dir: string): void {
  git(root, ["init", "-q", "-b", "main", dir]);
  git(dir, ["config", "diff.cfun.xfuncname", "^ func.*$"]);
  put(dir, "sub/e.dat", " x\n func one\n 1\n 2\n 3\n 4\n 5\n end\n");
  put(dir, "sub/.gitattributes", "*.dat diff\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "one"]);
  put(dir, "sub/e.dat", " x\n func one\n 1\n 2\n 3\n 4\n five\n end\n");
  git(dir, ["add", "sub/e.dat"]);
  git(dir, ["commit", "-q", "-m", "two"]);
  unlinkSync(join(dir, "sub/.gitattributes"));
  put(dir, ".gitattributes", "*.dat diff=cfun\n");
}

const hunks = (text: string) => text.split("\n").filter((l) => l.startsWith("@@"));

describeGit("diff drivers' attributes without the index for a diff of trees", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "diff-tree-attrs-"));
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("reads the worktree's attributes alone for two trees, the index's for --cached", async () => {
    const dir = join(root, "repo");
    build(dir);
    const nativeTrees = git(dir, ["diff", "HEAD~1", "HEAD"]);
    const nativeCached = git(dir, ["diff", "--cached", "HEAD~1"]);
    const nativeLog = git(dir, ["log", "-p", "-1", "--format="]);
    // the tree diff takes the root's driver, the --cached diff the index's sub/.gitattributes
    expect(hunks(nativeTrees)).toEqual(["@@ -4,5 +4,5 @@  func one"]);
    expect(hunks(nativeCached)).toEqual(["@@ -4,5 +4,5 @@"]);

    const g = await openOurs(dir);
    expect(await g.diff().setOldTree("HEAD~1").setNewTree("HEAD").callText()).toBe(nativeTrees);
    expect(await g.diff().setCached(true).setOldTree("HEAD~1").callText()).toBe(nativeCached);
    const log = Buffer.from(
      await g.log().setMaxCount(1).callBytes({ patch: true, pretty: "format:" }),
    );
    expect(hunks(log.toString("latin1"))).toEqual(hunks(nativeLog));
  });
});
