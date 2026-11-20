/**
 * The post-index-change hook against native git (read-cache.c `do_write_locked_index`):
 * run after each index write with `<updated-workdir> <updated-skipworktree>`: `1 0` after an
 * unpack-trees run that updated the worktree (a branch switch, `reset --hard`), `0 1` after
 * a mixed reset (`read_from_tree`), `0 0` otherwise (add, commit, a path checkout,
 * sparse-checkout). `commit -a` runs it while `index.lock` is held. Each case runs native
 * git in one copy of a repository with a logging hook and ours in the other.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Git, ResetMode } from "../src/index.js";
import {
  hookLog,
  hookTwins,
  installHooks,
  nativeIn,
  nativeIs25x,
  oursIn,
} from "./hooks-native-support.js";
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

  it("add -p: the refresh and each apply run it, their output on stderr", async () => {
    // add-patch.c refreshes the index before the selection and after each file's
    // `git apply --cached` (itself a write); the hook's stdout goes to stderr too
    const dir = base();
    writeFileSync(
      join(dir, ".git/hooks/post-index-change"),
      `#!/bin/sh\nprintf '== %s %s\\n' "$1" "$2" >> "$HOOK_LOG"\necho "hook $1 $2 out"\necho "hook $1 $2 err" >&2\n`,
      { mode: 0o755 },
    );
    const twenty = Array.from({ length: 20 }, (_, i) => `${i + 1}\n`).join("");
    putFile(dir, "a.txt", twenty);
    git(dir, ["add", "a.txt"]);
    git(dir, ["commit", "-qm", "twenty"]);
    const [theirs, mine] = hookTwins(root, dir);
    for (const d of [theirs.dir, mine.dir]) {
      putFile(d, "a.txt", twenty.replace("2\n", "two\n").replace("18\n", "eighteen\n"));
      putFile(d, "d/f.txt", "f\ng\n");
    }
    const answers = ["y", "n", "y"];
    const native = spawnSync(
      "git",
      ["-c", "color.ui=false", "-c", "interactive.singleKey=false", "add", "-p"],
      {
        cwd: theirs.dir,
        env: theirs.env,
        input: answers.map((a) => `${a}\n`).join(""),
        encoding: "utf8",
      },
    );
    expect(native.status, native.stderr).toBe(0);
    const queue = [...answers];
    const add = (await oursIn(mine))
      .add()
      .setPatch(true)
      .setPatchSelector(() => queue.shift())
      .setCompatibility(nativeIs25x ? "2.56" : "2.43");
    const result = await add.call();
    expect(result.patch?.output).toBe(native.stdout);
    expect(`${result.patch?.errors ?? ""}${add.getHookOutput()}`).toBe(native.stderr);
    expect(hookLog(mine)).toBe(hookLog(theirs));
    expect(git(mine.dir, ["ls-files", "-s"])).toBe(git(theirs.dir, ["ls-files", "-s"]));
  });
});
