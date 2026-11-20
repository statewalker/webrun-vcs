/**
 * The post-index-change hook against native git (read-cache.c `do_write_locked_index`):
 * run after each index write with `<updated-workdir> <updated-skipworktree>`: `1 0` after an
 * unpack-trees run that updated the worktree (a branch switch, `reset --hard`), `0 1` after
 * a mixed reset (`read_from_tree`), `0 0` otherwise (add, commit, a path checkout,
 * sparse-checkout). `commit -a` runs it while `index.lock` is held. Each case runs native
 * git in one copy of a repository with a logging hook and ours in the other.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Git, ResetMode } from "../src/index.js";
import { hookLog, hookTwins, installHooks, nativeIn, oursIn } from "./hooks-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/** A repository with two files on main and a branch `other` changing one of them. */
function base(): string {
  const dir = join(root, "r");
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, "a.txt", "a\n");
  putFile(dir, "d/f.txt", "f\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  git(dir, ["checkout", "-q", "-b", "other"]);
  putFile(dir, "a.txt", "other\n");
  git(dir, ["commit", "-qam", "other"]);
  git(dir, ["checkout", "-q", "main"]);
  // the hook also lists index.lock while it runs (commit -a holds it)
  installHooks(join(dir, ".git/hooks"), ["post-index-change"]);
  writeFileSync(
    join(dir, ".git/hooks/post-index-change"),
    `#!/bin/sh\nprintf '== %s %s lock=%s\\n' "$1" "$2" "$(ls .git/index.lock 2>/dev/null)" >> "$HOOK_LOG"\n`,
    { mode: 0o755 },
  );
  return dir;
}

/** Runs `args` natively and `run` in ours over twins of `dir` (after `prepare`). */
async function expectTwins(
  dir: string,
  args: string[],
  run: (g: Git) => Promise<unknown>,
  prepare?: (twinDir: string) => void,
): Promise<void> {
  const [theirs, mine] = hookTwins(root, dir);
  prepare?.(theirs.dir);
  prepare?.(mine.dir);
  const native = nativeIn(theirs, root, args);
  expect(native.status, native.stderr).toBe(0);
  await run(await oursIn(mine));
  expect(hookLog(mine), args.join(" ")).toBe(hookLog(theirs));
}

describeGit("post-index-change hook: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-index-change-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("add and commit: 0 0; commit -a with index.lock held", async () => {
    const dir = base();
    const change = (d: string) => putFile(d, "a.txt", "changed\n");
    await expectTwins(dir, ["add", "a.txt"], (g) => g.add().addFilepattern("a.txt").call(), change);
    await expectTwins(
      dir,
      ["commit", "-qm", "two"],
      (g) => g.commit().setMessage("two").call(),
      (d) => {
        change(d);
        git(d, ["add", "a.txt"]);
      },
    );
    await expectTwins(
      dir,
      ["commit", "-qam", "two"],
      (g) => g.commit().setAll(true).setMessage("two").call(),
      change,
    );
  });

  it("checkout of a branch and reset --hard: 1 0", async () => {
    const dir = base();
    await expectTwins(dir, ["checkout", "-q", "other"], (g) =>
      g.checkout().setName("other").call(),
    );
    await expectTwins(
      dir,
      ["reset", "-q", "--hard", "other"],
      (g) => g.reset().setRef("other").setMode(ResetMode.HARD).call(),
      (d) => putFile(d, "a.txt", "dirty\n"),
    );
  });

  it("reset (mixed): 0 1; reset -- <path> and checkout -- <path>", async () => {
    const dir = base();
    await expectTwins(dir, ["reset", "-q", "other"], (g) =>
      g.reset().setRef("other").setMode(ResetMode.MIXED).call(),
    );
    await expectTwins(dir, ["reset", "-q", "other", "--", "a.txt"], (g) =>
      g.reset().setRef("other").addPath("a.txt").call(),
    );
    await expectTwins(
      dir,
      ["checkout", "--", "a.txt"],
      (g) => g.checkout().addPath("a.txt").call(),
      (d) => putFile(d, "a.txt", "dirty\n"),
    );
  });

  it("sparse-checkout set and disable", async () => {
    const dir = base();
    await expectTwins(dir, ["sparse-checkout", "set", "d"], (g) =>
      g.sparseCheckout().setArguments(["set", "d"]).call(),
    );
    git(dir, ["sparse-checkout", "set", "d"]);
    await expectTwins(dir, ["sparse-checkout", "disable"], (g) =>
      g.sparseCheckout().setArguments(["disable"]).call(),
    );
  });
});
