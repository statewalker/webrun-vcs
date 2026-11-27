/**
 * `git show-branch` (builtin/show-branch.c), native twins: t3202-show-branch's scenarios and
 * the other modes (`--more`, `--independent`, `--topics`, `--sha1-name`, globs, merges named
 * `x^2`), each run by native git and by ours on the same repository with git as the oracle
 * (stdout, stderr and exit status; usage errors by their first line).
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Outcome, Shell } from "./describe-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let shell: Shell;
let version: string;
let counter = 0;

/** The current tick, as t/test-lib's `$test_tick`. */
const testTick = () => Number(shell.dates().GIT_COMMITTER_DATE?.split(" ")[0]);

/** The native git's minor version (2.x). */
const minor = () => Number(/2\.(\d+)/.exec(version)?.[1] ?? 0);

async function twin(dir: string, argv: string[], now?: number) {
  const native = shell.git(dir, ["show-branch", ...argv], {
    env: now !== undefined ? { GIT_TEST_DATE_NOW: String(now) } : {},
  });
  const git = await openOurs(dir);
  const command = git.showBranch().setArguments(argv).setVersionString(version);
  if (now !== undefined) command.setNow(now);
  const r = await command.call();
  const ours: Outcome = { status: r.exitCode, stdout: r.stdout, stderr: r.stderr };
  return { native, ours };
}

/** Both sides alike; native's outcome. */
async function check(dir: string, argv: string[], now?: number): Promise<Outcome> {
  const { native, ours } = await twin(dir, argv, now);
  expect(ours).toEqual(native);
  return native;
}

/** A usage error or death: the same status and first stderr line, nothing on stdout. */
async function checkRefused(dir: string, argv: string[]): Promise<Outcome> {
  const { native, ours } = await twin(dir, argv);
  const first = (o: Outcome) => o.stderr.split("\n")[0];
  expect({ status: ours.status, stdout: ours.stdout, first: first(ours) }).toEqual({
    status: native.status,
    stdout: native.stdout,
    first: first(native),
  });
  return native;
}

function repository(name: string): string {
  const dir = join(root, `${name}-${counter++}`);
  shell.ok(root, "init", "-q", "-b", "main", dir);
  return dir;
}

describeGit("git show-branch, native twins", () => {
  let t3202: string;
  let sorted: string[];

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "show-branch-native-"));
    shell = new Shell(root);
    version = shell.ok(root, "--version");
    // t3202-show-branch.sh: "setup"
    t3202 = repository("t3202");
    shell.commit(t3202, "initial");
    for (let i = 1; i <= 10; i++) {
      shell.ok(t3202, "checkout", "-q", "-b", `branch${i}`, "initial");
      shell.commit(t3202, "--no-tag", `branch${i}`);
    }
    sorted = shell
      .ok(
        t3202,
        "for-each-ref",
        "--sort=version:refname",
        "--format=%(refname:strip=2)",
        "refs/heads/branch*",
      )
      .trim()
      .split("\n");
  });
  afterAll(async () => {
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  it('t3202-show-branch.sh: "show-branch with more than 8 branches"', async () => {
    const out = await check(t3202, sorted);
    expect(out.stdout).toContain("+++++++++* [branch10^] initial");
  });

  it('t3202-show-branch.sh: "show-branch with showbranch.default"', async () => {
    const dir = join(root, `default-${counter++}`);
    shell.ok(root, "clone", "-q", t3202, dir);
    for (const b of sorted) shell.ok(dir, "update-ref", `refs/heads/${b}`, `origin/${b}`);
    shell.ok(dir, "checkout", "-q", "branch10");
    for (const b of sorted) shell.ok(dir, "config", "--add", "showbranch.default", b);
    await check(dir, []);
  });

  it('t3202-show-branch.sh: "show-branch --color output"', async () => {
    const out = await check(t3202, ["--color=always", ...sorted]);
    expect(out.stdout).toContain("\x1b[1;34m*\x1b[m [branch10] branch10");
  });

  it('t3202-show-branch.sh: "show branch --remotes"', async () => {
    const out = await check(t3202, ["-r"]);
    expect(out.stderr).toBe("No revs to be shown.\n");
  });

  it('t3202-show-branch.sh: "show-branch --sparse"', async () => {
    const dir = join(root, `sparse-${counter++}`);
    shell.ok(root, "clone", "-q", t3202, dir);
    for (const b of sorted) shell.ok(dir, "update-ref", `refs/heads/${b}`, `origin/${b}`);
    shell.ok(dir, "checkout", "-q", "-b", "branchA", "branch10");
    shell.tick();
    shell.ok(dir, "merge", "-q", "-s", "ours", "-m", "merge 1 and 10 to make A", "branch1");
    shell.tick();
    shell.ok(dir, "commit", "-q", "--allow-empty", "-m", "another");
    expect((await check(dir, ["--sparse"])).stdout).toContain("merge 1 and 10 to make A");
    expect((await check(dir, [])).stdout).not.toContain("merge 1 and 10 to make A");
    expect((await check(dir, ["--no-sparse"])).stdout).not.toContain("merge 1 and 10 to make A");
    // the merge named as a second parent's chain, topics and more
    expect((await check(dir, ["--sparse", "branchA", "branch2"])).stdout).toContain("[branchA^^2]");
    await check(dir, ["branchA", "branch1", "branch2"]);
    await check(dir, ["--topics", "branchA", "branch1", "branch2"]);
    await check(dir, ["--more=3", "branchA", "branch3"]);
    await check(dir, ["--sha1-name", "branchA", "branch3"]);
    await check(dir, ["--no-name", "branchA", "branch3"]);
    await check(dir, ["--date-order", "--sparse", "branchA", "branch1", "branch5"]);
    await check(dir, ["--independent", "branchA", "branch1", "branch2", "branch10"]);
    await check(dir, ["--current", "branch1", "branch2"]);
  });

  it('t3202-show-branch.sh: "show branch --list"', async () => {
    await check(t3202, ["--list", ...sorted]);
  });

  it('t3202-show-branch.sh: "show branch --list has no --color output"', async () => {
    await check(t3202, ["--color=always", "--list", ...sorted]);
  });

  it('t3202-show-branch.sh: "show branch --merge-base with one argument"', async () => {
    for (const b of sorted) await check(t3202, ["--merge-base", b]);
  });

  it('t3202-show-branch.sh: "show branch --merge-base with two arguments"', async () => {
    for (const b of sorted) await check(t3202, ["--merge-base", "initial", b]);
  });

  it('t3202-show-branch.sh: "show branch --merge-base with N arguments"', async () => {
    const out = await check(t3202, ["--merge-base", ...sorted]);
    expect(out.stdout).toBe(shell.ok(t3202, "rev-parse", "initial"));
  });

  it('t3202-show-branch.sh: "show-branch $combo (should fail)"', async () => {
    for (const combo of [
      ["--all", "--reflog"],
      ["--merge-base", "--reflog"],
      ["--list", "--merge-base"],
      ["--reflog", "--current"],
    ]) {
      const out = await checkRefused(t3202, combo);
      expect(out.status).not.toBe(0);
    }
  });

  it('t3202-show-branch.sh: "show-branch --no-$opt (should fail)"', async () => {
    for (const opt of ["topo-order", "date-order", "reflog"]) {
      const out = await checkRefused(t3202, [`--no-${opt}`]);
      expect(out.stderr).toContain(`unknown option \`no-${opt}'`);
    }
  });

  it('t3202-show-branch.sh: "--reflog shows reflog entries"', async () => {
    const dir = repository("reflog");
    // "setup reflogs"
    shell.commit(dir, "base");
    shell.ok(dir, "checkout", "-q", "-b", "branch");
    shell.commit(dir, "one");
    shell.tick();
    shell.ok(dir, "reset", "-q", "--hard", "HEAD^");
    shell.commit(dir, "two");
    shell.commit(dir, "three");
    const out = await check(dir, ["--reflog", "branch"], testTick());
    expect(out.stdout).toContain("[branch@{1}] (");
    await check(dir, ["-g", "branch"], testTick());
    await check(dir, ["-g=2,1", "branch"], testTick());
    await check(dir, ["--reflog=3", "--list"], testTick());
    await check(dir, ["--reflog=9", "branch"], testTick());
    await checkRefused(dir, ["--reflog=2x", "branch"]);
    await checkRefused(dir, ["--reflog", "branch", "main"]);
    await checkRefused(dir, ["--reflog", "nope"]);
    if (minor() >= 45) {
      // 2.43 reads an empty reflog's @{0} without a record ("--reflog handles missing reflog")
      shell.ok(dir, "reflog", "expire", "--expire=now", "branch");
      const empty = await check(dir, ["--reflog", "branch"], testTick());
      expect(empty.stdout).toBe("");
    }
  });

  it("-g HEAD after a checkout, and an ambiguous name", async () => {
    const dir = repository("head-reflog");
    for (let i = 0; i < 8; i++) shell.commit(dir, "--no-tag", `c${i}`);
    shell.ok(dir, "branch", "side", "HEAD~5");
    shell.ok(dir, "checkout", "-q", "side");
    for (let i = 0; i < 3; i++) shell.commit(dir, "--no-tag", `s${i}`);
    shell.ok(dir, "checkout", "-q", "main");
    shell.tick();
    shell.ok(dir, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    shell.commit(dir, "--no-tag", "after");
    // the headers read main's reflog, the commits HEAD's own (HEAD@{n})
    await check(dir, ["-g", "HEAD"], testTick());
    shell.ok(dir, "tag", "main", "side");
    const ambiguous = await check(dir, ["main", "main"]);
    expect(ambiguous.stderr).toContain("is ambiguous");
  });

  it("globs, --all with remotes, and more refs than git handles", async () => {
    const dir = join(root, `globs-${counter++}`);
    shell.ok(root, "clone", "-q", t3202, dir);
    for (const b of sorted) shell.ok(dir, "update-ref", `refs/heads/${b}`, `origin/${b}`);
    shell.ok(dir, "tag", "v1.2", "branch3");
    shell.ok(dir, "tag", "v1.10", "branch4");
    shell.ok(dir, "tag", "-a", "-m", "annotated", "v1.9", "branch5");
    shell.ok(dir, "tag", "tree", "HEAD^{tree}");
    // a branch and a tag of one name: the branch is listed as heads/<name>
    shell.ok(dir, "tag", "branch7", "branch8");
    await check(dir, ["branch1*"]);
    await check(dir, ["tags/v1*"]);
    expect((await check(dir, ["--list", "-a"])).stdout).toContain("[heads/branch7]");
    await check(dir, ["-r", "--list"]);
    await check(dir, ["--more=2", "branch1", "origin/branch2"]);
    await check(dir, ["--list", "nomatch*", "branch2"]);
    await checkRefused(dir, ["nosuchbranch"]);
    for (let i = 11; i <= 30; i++) shell.ok(dir, "branch", `branch${i}`, "branch1");
    const many = await check(dir, ["--list", "branch*"]);
    expect(many.stderr).toContain("cannot handle more than");
  });
});
