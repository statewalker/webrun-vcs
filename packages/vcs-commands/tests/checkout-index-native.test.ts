/**
 * `git checkout-index` against native git (builtin/checkout-index.c over entry.c):
 * scenarios of t2006-checkout-index-basic.sh, t2004-checkout-cache-temp.sh and
 * t2002-checkout-cache-u.sh, plus `--prefix`, `-f`/`-n`/`-q` over files already there,
 * skip-worktree entries and a sparse index. Each case copies one fixture twice, runs native
 * git in one copy and ours in the other, and compares the exit status, stdout and stderr
 * (temporary files named by their content: `mkstemp` names them at random), every worktree
 * file, and the index without stat data (with `-u`, whether its stat data are fresh).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CheckoutIndexFailedError } from "../src/index.js";
import { gitOk, openOurs, put, snapshot } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;
let version: "2.43" | "2.56" | undefined;

function compatibility(): "2.43" | "2.56" {
  version ??= /git version 2\.43\./.test(gitOk(root, root, "--version")) ? "2.43" : "2.56";
  return version;
}

function run(cwd: string, args: string[], input?: string) {
  const r = spawnSync("git", args, {
    cwd,
    env: nativeGitEnv(root),
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function settle(dir: string): void {
  const files = execFileSync("find", [".", "-path", "./.git", "-prune", "-o", "-print"], {
    cwd: dir,
    encoding: "utf8",
  })
    .split("\n")
    .filter((p) => p && p !== ".");
  const past = new Date("2020-01-01T00:00:00Z");
  for (const p of files) utimesSync(join(dir, p), past, past);
  if (existsSync(join(dir, ".git", "index"))) run(dir, ["update-index", "-q", "--refresh"]);
}

function twins(build: (dir: string) => void): { native: string; ours: string } {
  const n = counter++;
  const fixture = join(root, `f${n}`);
  gitOk(root, root, "init", "-q", "-b", "main", fixture);
  build(fixture);
  settle(fixture);
  const out = { native: join(root, `n${n}`), ours: join(root, `o${n}`) };
  for (const dir of [out.native, out.ours]) {
    execFileSync("cp", ["-a", fixture, dir]);
    if (existsSync(join(dir, ".git", "index"))) run(dir, ["update-index", "-q", "--refresh"]);
  }
  return out;
}

/** Our `git checkout-index` with git's arguments. */
async function ours(dir: string, args: string[], input?: string) {
  const cmd = (await openOurs(dir)).checkoutIndex().setCompatibility(compatibility());
  for (const arg of args) {
    if (arg === "-a" || arg === "--all") cmd.setAll();
    else if (arg === "-f") cmd.setForce();
    else if (arg === "-q") cmd.setQuiet();
    else if (arg === "-n") cmd.setNoCreate();
    else if (arg === "-u") cmd.setUpdateIndex();
    else if (arg === "-z") cmd.setNulTerminated();
    else if (arg === "--stdin") cmd.setStdin(input ?? "");
    else if (arg === "--temp") cmd.setTemp(true);
    else if (arg === "--no-temp") cmd.setTemp(false);
    else if (arg === "--ignore-skip-worktree-bits") cmd.setIgnoreSkipWorktreeBits();
    else if (arg.startsWith("--prefix=")) cmd.setPrefix(arg.slice(9));
    else if (arg.startsWith("--stage=")) {
      const stage = arg.slice(8);
      cmd.setStage(stage === "all" ? "all" : (Number(stage) as 1 | 2 | 3));
    } else if (arg !== "--") cmd.addPath(arg);
  }
  try {
    const r = await cmd.call();
    return { status: r.exitCode, stdout: r.output, stderr: r.errors };
  } catch (e) {
    if (!(e instanceof CheckoutIndexFailedError)) throw e;
    return { status: e.exitCode, stdout: e.output, stderr: `${e.message}\n` };
  }
}

const TEMP = /\.merge_(file|link)_[A-Za-z0-9]{6}/g;

/** The result with each temporary file named by its content, and the repository. */
function state(dir: string, result: { status: number; stdout: string; stderr: string }) {
  const named = (text: string) =>
    text.replace(TEMP, (name) =>
      existsSync(join(dir, name))
        ? `<${readFileSync(join(dir, name)).toString("latin1")}>`
        : "<gone>",
    );
  const snap = snapshot(root, dir);
  const files: Record<string, string> = {};
  const temps: string[] = [];
  for (const [name, content] of Object.entries(snap.files)) {
    // a nested repository's own files are not checkout-index's
    if (/^[^/]+\/\.git\//.test(name)) continue;
    if (/^\.merge_(file|link)_[A-Za-z0-9]{6}$/.test(name)) temps.push(content);
    else files[name] = content;
  }
  return {
    result: { ...result, stdout: named(result.stdout) },
    files,
    temps: temps.sort(),
    index: gitOk(root, dir, "ls-files", "-s", "-t"),
    // whether the index's stat data match the files (t2002)
    diffFiles: run(dir, ["diff-files", "--name-only"]).stdout,
    status: snap.status.replace(TEMP, "<temp>"),
  };
}

async function compare(
  t: { native: string; ours: string },
  args: string[],
  input?: string,
): Promise<ReturnType<typeof run>> {
  const expected = run(t.native, ["checkout-index", ...args], input);
  const actual = await ours(t.ours, args, input);
  const a = state(t.ours, actual);
  const e = state(t.native, expected);
  if (process.env.DEBUG_TWINS && JSON.stringify(a) !== JSON.stringify(e)) {
    for (const k of Object.keys(e) as (keyof typeof e)[]) {
      if (JSON.stringify(a[k]) !== JSON.stringify(e[k])) {
        console.error(k, "\nNATIVE", JSON.stringify(e[k]), "\nOURS  ", JSON.stringify(a[k]));
      }
    }
  }
  expect(a).toEqual(e);
  return expected;
}

/** Removes the worktree files of both twins whose names match (`rm -f path* .merge_*`). */
function clean(t: { native: string; ours: string }, pattern: RegExp): void {
  for (const dir of [t.native, t.ours]) {
    for (const name of execFileSync("ls", ["-A", dir], { encoding: "utf8" }).split("\n")) {
      if (name && pattern.test(name)) rmSync(join(dir, name), { recursive: true, force: true });
    }
  }
}

/** t2004's three trees: t1, t2, t3, and the index a three-way read-tree leaves. */
function threeTrees(dir: string): { t1: string; t2: string; t3: string } {
  const writeTree = (files: Record<string, string>) => {
    rmSync(join(dir, ".git", "index"), { force: true });
    for (const [p, c] of Object.entries(files)) put(dir, p, c);
    gitOk(root, dir, "update-index", "--add", ...Object.keys(files));
    const tree = gitOk(root, dir, "write-tree").trim();
    for (const p of Object.keys(files)) rmSync(join(dir, p));
    return tree;
  };
  const t1 = writeTree({
    path0: "tree1path0\n",
    path1: "tree1path1\n",
    path3: "tree1path3\n",
    path4: "tree1path4\n",
    "asubdir/path5": "tree1asubdir/path5\n",
  });
  const t2 = writeTree({
    path0: "tree2path0\n",
    path1: "tree2path1\n",
    path2: "tree2path2\n",
    path4: "tree2path4\n",
  });
  const t3 = writeTree({
    path0: "tree2path0\n",
    path1: "tree3path1\n",
    path2: "tree3path2\n",
    path3: "tree3path3\n",
  });
  rmSync(join(dir, ".git", "index"), { force: true });
  return { t1, t2, t3 };
}

describeGit("git checkout-index against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "checkout-index-native-"));
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t2006-checkout-index-basic.sh: "checkout-index reports errors (cmdline)", "checkout-index reports errors (stdin)"', async () => {
    const t = twins((d) => {
      put(d, "a", "a\n");
      gitOk(root, d, "add", "a");
    });
    await compare(t, ["--", "does-not-exist"]);
    await compare(t, ["--stdin"], "does-not-exist\n");
  });

  it('t2006-checkout-index-basic.sh: "checkout-index --temp correctly reports error on missing blobs"', async () => {
    const missing = "4d1e4e4d6e5e6cb8bd40e4fd17ae8dc8b3fd5e86";
    const t = twins((d) => {
      gitOk(root, d, "update-index", "--add", "--cacheinfo", `100644,${missing},file`);
      gitOk(root, d, "update-index", "--add", "--cacheinfo", `120000,${missing},symlink`);
    });
    const r = await compare(t, ["--temp", "symlink", "file"]);
    expect(r.status).not.toBe(0);
  });

  it('t2006-checkout-index-basic.sh: "checkout-index --temp correctly reports error for submodules"', async () => {
    const t = twins((d) => {
      const sub = join(d, "sub");
      gitOk(root, d, "init", "-q", "sub");
      put(sub, "file.t", "file\n");
      gitOk(root, sub, "add", ".");
      gitOk(root, sub, "commit", "-q", "-m", "file");
      gitOk(root, d, "add", "sub");
      gitOk(root, d, "commit", "-q", "-m", "sub");
    });
    await compare(t, ["--temp", "sub"]);
  });

  it('t2004-checkout-cache-temp.sh: "checkout one stage 0 to temporary file", "checkout all stage 0 to temporary files"', async () => {
    let trees = { t1: "", t2: "", t3: "" };
    const t = twins((d) => {
      trees = threeTrees(d);
    });
    for (const dir of [t.native, t.ours]) gitOk(root, dir, "read-tree", trees.t1);
    await compare(t, ["--temp", "--", "path1"]);
    clean(t, /^(path|\.merge_)/);
    await compare(t, ["-a", "--temp"]);
  });

  it("t2004-checkout-cache-temp.sh: the stages of a three-way merge", async () => {
    let trees = { t1: "", t2: "", t3: "" };
    const t = twins((d) => {
      trees = threeTrees(d);
      gitOk(root, d, "read-tree", "-m", trees.t1, trees.t2, trees.t3);
    });
    const reset = () => clean(t, /^(path|\.merge_)/);
    // t2004-checkout-cache-temp.sh: "checkout one stage 2 to temporary file"
    await compare(t, ["--stage=2", "--temp", "--", "path1"]);
    reset();
    // t2004-checkout-cache-temp.sh: "checkout all stage 2 to temporary files"
    await compare(t, ["--all", "--stage=2", "--temp"]);
    reset();
    // t2004-checkout-cache-temp.sh: "checkout all stages of unknown path"
    await compare(t, ["--stage=all", "--temp", "--", "does-not-exist"]);
    reset();
    // t2004-checkout-cache-temp.sh: "checkout all stages/one file to nothing"
    await compare(t, ["--stage=all", "--temp", "--", "path0"]);
    reset();
    // t2004-checkout-cache-temp.sh: "checkout all stages/one file to temporary files"
    await compare(t, ["--stage=all", "--temp", "--", "path1"]);
    reset();
    // t2004-checkout-cache-temp.sh: "--stage=all implies --temp"
    await compare(t, ["--stage=all", "--", "path1"]);
    reset();
    // t2004-checkout-cache-temp.sh: "--stage=all --no-temp is rejected"
    await compare(t, ["--stage=all", "--no-temp", "--", "path1"]);
    reset();
    // t2004-checkout-cache-temp.sh: "checkout some stages/one file to temporary files"
    await compare(t, ["--stage=all", "--temp", "--", "path2"]);
    reset();
    // t2004-checkout-cache-temp.sh: "checkout all stages/all files to temporary files"
    await compare(t, ["-a", "--stage=all", "--temp"]);
    reset();
    // a stage written in place, and a path with no such stage
    await compare(t, ["--stage=3", "--", "path1", "path4"]);
    reset();
    // an unmerged path at stage 0
    await compare(t, ["--", "path1"]);
  });

  it('t2004-checkout-cache-temp.sh: "checkout --temp symlink"', async () => {
    const t = twins((d) => {
      execFileSync("ln", ["-s", "path7", join(d, "path6")]);
      gitOk(root, d, "update-index", "--add", "path6");
      rmSync(join(d, "path6"));
    });
    await compare(t, ["--temp", "-a"]);
    // a link checked out in place
    await compare(t, ["-a"]);
  });

  it('t2002-checkout-cache-u.sh: "without -u, git checkout-index smudges stat information.", "with -u, git checkout-index picks up stat information from new files."', async () => {
    const t = twins((d) => {
      put(d, "path0", "frotz\n");
      gitOk(root, d, "update-index", "--add", "path0");
    });
    for (const dir of [t.native, t.ours]) rmSync(join(dir, "path0"));
    await compare(t, ["-f", "-a"]);
    for (const dir of [t.native, t.ours]) rmSync(join(dir, "path0"));
    await compare(t, ["-u", "-f", "-a"]);
  });

  it("files already there: skipped when unchanged, refused or overwritten when changed", async () => {
    const t = twins((d) => {
      for (const p of ["a", "b", "c", "d/e"]) put(d, p, `${p}\n`);
      gitOk(root, d, "add", ".");
      gitOk(root, d, "commit", "-q", "-m", "c");
    });
    for (const dir of [t.native, t.ours]) {
      put(dir, "b", "local b\n");
      rmSync(join(dir, "c"));
      rmSync(join(dir, "d"), { recursive: true });
      put(dir, "d", "a file where a directory goes\n");
    }
    await compare(t, ["a", "b", "c"]);
    await compare(t, ["-n", "-a"]);
    await compare(t, ["-q", "-a"]);
    await compare(t, ["-f", "-u", "b", "d/e"]);
  });

  it("--prefix: every entry written under a prefix, the index untouched", async () => {
    const t = twins((d) => {
      for (const p of ["a", "dir/b"]) put(d, p, `${p}\n`);
      execFileSync("ln", ["-s", "a", join(d, "link")]);
      put(d, "x.sh", "#!/bin/sh\n");
      execFileSync("chmod", ["+x", join(d, "x.sh")]);
      gitOk(root, d, "add", ".");
      gitOk(root, d, "commit", "-q", "-m", "c");
    });
    await compare(t, ["--prefix=export/", "-a"]);
    await compare(t, ["--prefix=export/", "-a"]);
    await compare(t, ["--prefix=export/", "-f", "-u", "a"]);
    await compare(t, ["--prefix=pre-", "dir/b"]);
  });

  it("skip-worktree entries, with and without --ignore-skip-worktree-bits", async () => {
    const t = twins((d) => {
      for (const p of ["a", "b"]) put(d, p, `${p}\n`);
      gitOk(root, d, "add", ".");
      gitOk(root, d, "commit", "-q", "-m", "c");
      gitOk(root, d, "update-index", "--skip-worktree", "b");
      rmSync(join(d, "b"));
    });
    await compare(t, ["b"]);
    await compare(t, ["-a"]);
    await compare(t, ["--ignore-skip-worktree-bits", "-a"]);
  });

  it("a sparse index: entries outside the cone and the sparse directory", async () => {
    const t = twins((d) => {
      for (const p of ["a", "in/x", "out/y"]) put(d, p, `${p}\n`);
      gitOk(root, d, "add", ".");
      gitOk(root, d, "commit", "-q", "-m", "c");
      gitOk(root, d, "sparse-checkout", "set", "--cone", "--sparse-index", "in");
    });
    await compare(t, ["out/y"]);
    await compare(t, ["-f", "-a"]);
    await compare(t, ["--ignore-skip-worktree-bits", "--prefix=all/", "-a"]);
  });
});
