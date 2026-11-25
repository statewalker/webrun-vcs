/**
 * t4013-diff-various.sh's `git diff-tree` (and `git log --raw`) commands against native git, on
 * t4013's history: each command run by native git and by ours on one repository, stdout
 * compared byte for byte.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
import { runNative, runOurs } from "./diff-plumbing-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let dir = "";
const env = () => ({
  ...nativeGitEnv(root),
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
});

/** t4013's setup (test-tool chmtime and the `dir2`/`dir3` copies left out) */
const SETUP = `
set -e
d() { GIT_AUTHOR_DATE="2006-06-26 00:0$1:00 +0000"; GIT_COMMITTER_DATE="$GIT_AUTHOR_DATE"; export GIT_AUTHOR_DATE GIT_COMMITTER_DATE; }
lines() { printf "%s\\n" "$@"; }
d 0
mkdir dir
lines 1 2 3 >file0
lines A B >dir/sub
cat file0 >file2
git add file0 file2 dir/sub
git commit -q -m Initial
git branch initial
git branch side
d 1
lines 4 5 6 >>file0
lines C D >>dir/sub
rm -f file2
git update-index --remove file0 file2 dir/sub
git commit -q -m "Second

This is the second commit."
d 2
lines A B C >file1
git add file1
lines E F >>dir/sub
git update-index dir/sub
git commit -q -m Third
d 3
git checkout -q side
lines A B C >>file0
lines 1 2 >>dir/sub
cat dir/sub >file3
git add file3
git update-index file0 dir/sub
git commit -q -m Side
d 4
git checkout -q main
git pull -q -s ours --no-rebase . side
d 5
lines A B C >>file0
lines 1 2 >>dir/sub
git update-index file0 dir/sub
git config log.showroot false
git commit -q --amend --no-edit
d 6
git checkout -q -b rearrange initial
lines B A >dir/sub
git add dir/sub
git commit -q -m "Rearranged lines in dir/sub"
git checkout -q main
git checkout -q -b mode initial
git update-index --chmod=+x file0
git commit -q -m "update mode"
git checkout -q -f main
git checkout -q -b note initial
git update-index --chmod=+x file2
git commit -q -m "update mode (file2)"
git notes add -m "note"
git checkout -q -f main
commit=$(echo reverse | git commit-tree -p main^2 -p main^1 main^{tree})
git update-ref REVERSE $commit
git config diff.renames false
`;

/** t4013's diff-tree commands (its `log -m --raw` too) */
const COMMANDS = [
  "diff-tree initial",
  "diff-tree -r initial",
  "diff-tree -r --abbrev initial",
  "diff-tree -r --abbrev=4 initial",
  "diff-tree --root initial",
  "diff-tree --root --abbrev initial",
  "diff-tree --root -r initial",
  "diff-tree --root -r --abbrev initial",
  "diff-tree --root -r --abbrev=4 initial",
  "diff-tree -p initial",
  "diff-tree --root -p initial",
  "diff-tree --root -p --abbrev=10 initial",
  "diff-tree --root -p --full-index initial",
  "diff-tree --root -p --full-index --abbrev=10 initial",
  "diff-tree --patch-with-stat initial",
  "diff-tree --root --patch-with-stat initial",
  "diff-tree --patch-with-raw initial",
  "diff-tree --root --patch-with-raw initial",
  "diff-tree --pretty initial",
  "diff-tree --pretty --root initial",
  "diff-tree --pretty -p initial",
  "diff-tree --pretty --stat initial",
  "diff-tree --pretty --summary initial",
  "diff-tree --pretty --stat --summary initial",
  "diff-tree --pretty --root -p initial",
  "diff-tree --pretty --root --stat initial",
  "diff-tree --pretty --root --summary initial",
  "diff-tree --pretty --root --summary -r initial",
  "diff-tree --pretty --root --stat --summary initial",
  "diff-tree --pretty --patch-with-stat initial",
  "diff-tree --pretty --root --patch-with-stat initial",
  "diff-tree --pretty --patch-with-raw initial",
  "diff-tree --pretty --root --patch-with-raw initial",
  "diff-tree --pretty=oneline initial",
  "diff-tree --pretty=oneline --root initial",
  "diff-tree --pretty=oneline -p initial",
  "diff-tree --pretty=oneline --root -p initial",
  "diff-tree --pretty=oneline --patch-with-stat initial",
  "diff-tree --pretty=oneline --root --patch-with-stat initial",
  "diff-tree --pretty=oneline --patch-with-raw initial",
  "diff-tree --pretty=oneline --root --patch-with-raw initial",
  "diff-tree --pretty side",
  "diff-tree --pretty -p side",
  "diff-tree --pretty --patch-with-stat side",
  "diff-tree initial mode",
  "diff-tree --stat initial mode",
  "diff-tree --summary initial mode",
  "diff-tree main",
  "diff-tree -m main",
  "diff-tree -p main",
  "diff-tree -p -m main",
  "diff-tree -c main",
  "diff-tree -c --abbrev main",
  "diff-tree --cc main",
  "diff-tree -c --stat main",
  "diff-tree --cc --stat main",
  "diff-tree -c --stat --summary main",
  "diff-tree --cc --stat --summary main",
  "diff-tree -c --stat --summary side",
  "diff-tree --cc --stat --summary side",
  "diff-tree --cc --shortstat main",
  "diff-tree --cc --summary REVERSE",
  "diff-tree --cc --patch-with-stat main",
  "diff-tree --cc --patch-with-stat --summary main",
  "diff-tree --cc --patch-with-stat --summary side",
];

/** Beyond t4013: `-z`, the combined raw form with `--cc`, `-t`, `--stdin` with parents */
const MORE = [
  "diff-tree -z main^",
  "diff-tree -z -r --name-status main^",
  "diff-tree -z -r --name-only main^",
  "diff-tree --cc --raw main",
  "diff-tree -c --raw -z main",
  "diff-tree -c --name-status main",
  "diff-tree --cc --raw --abbrev=5 main",
  "diff-tree -t main^",
  "diff-tree -r --no-commit-id main^",
  "diff-tree -r main^ -- dir",
  "diff-tree main^ -- dir/sub",
  "diff-tree -t main^ -- dir/sub",
];

describeGit("t4013-diff-various.sh: diff-tree against native git", () => {
  let ours: Git;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "diff-tree-various-"));
    dir = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", dir], { env: env() });
    execFileSync("sh", ["-c", SETUP], { cwd: dir, env: env(), stdio: "ignore" });
    ours = await openOurs(dir);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const check = async (cmd: string, input?: string) => {
    const args = cmd.split(" ");
    const native = runNative(dir, env(), args, input);
    const mine = await runOurs(ours, args, input);
    expect({ status: mine.status, stdout: mine.stdout }).toEqual({
      status: native.status,
      stdout: native.stdout,
    });
  };

  for (const cmd of COMMANDS) {
    it(`t4013-diff-various.sh: "git ${cmd} # magic is (not used)"`, () => check(cmd));
  }

  it('t4013-diff-various.sh: "git log -m --raw main # magic is (not used)"', async () => {
    const native = runNative(dir, env(), ["log", "-m", "--raw", "main"]);
    const main = execFileSync("git", ["rev-parse", "main"], {
      cwd: dir,
      env: env(),
      encoding: "utf8",
    });
    const mine = await ours.log().add(main.trim()).callText({ m: true, raw: true });
    expect(mine).toBe(native.stdout);
  });

  for (const cmd of MORE) {
    it(`git ${cmd}`, () => check(cmd));
  }

  it("diff-tree --stdin: commits with grafted parents, trees, other lines echoed", async () => {
    const id = (rev: string) =>
      execFileSync("git", ["rev-parse", rev], { cwd: dir, env: env(), encoding: "utf8" }).trim();
    const input = [
      `${id("main")}`,
      `${id("main")} ${id("initial")}`,
      `${id("main^{tree}")} ${id("initial^{tree}")}`,
      "not an object",
      `${id("side")} ${id("main~2")} ${id("initial")}`,
      "",
    ].join("\n");
    await check("diff-tree --stdin -r", input);
    await check("diff-tree --stdin -m --name-status", input);
    await check("diff-tree --stdin --cc --raw", input);
  });
});
