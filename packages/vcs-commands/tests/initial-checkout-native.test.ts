/**
 * An unborn index (git's `is_index_unborn`: no `.git/index`, as `clone --no-checkout` or
 * `worktree add --no-checkout` leave it) against native git. checkout and switch then run
 * unpack-trees as an initial checkout (`topts.initial_checkout`): every entry of the target
 * is written, untracked files in the way still refuse the switch; a switch that names no
 * target (`switch -c`, `switch --detach`, the bare `checkout -b <new>`) leaves the index
 * unborn. The two-tree `read-tree -m` does the same; other commands read the missing index
 * as an empty one (status shows HEAD's files staged as deleted).
 *
 * Each case starts from two native `clone --no-checkout` twins of one upstream; native git
 * changes one, our commands the other; refs, HEAD, the index (`ls-files -s`, `-t`, whether
 * the file exists), the worktree and `status` are compared.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CheckoutStatus, Git, ResetMode } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(home),
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });
/** Native git that may fail: its exit status, stdout and stderr. */
const attempt = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, env: nativeGitEnv(home), encoding: "latin1" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/**
 * The upstream (main: a.txt, d/b.txt; other: a.txt changed, o.txt added) and its
 * `clone --no-checkout` (no index, no worktree files).
 */
function build(base: string): string {
  mkdirSync(base, { recursive: true });
  const origin = join(base, "origin");
  run(base, "init", "-q", "-b", "main", "origin");
  put(origin, "a.txt", "a\n");
  put(origin, "d/b.txt", "b\n");
  run(origin, "add", ".");
  run(origin, "commit", "-qm", "one");
  run(origin, "checkout", "-q", "-b", "other");
  put(origin, "a.txt", "a2\n");
  put(origin, "o.txt", "o\n");
  run(origin, "add", ".");
  run(origin, "commit", "-qm", "two");
  run(origin, "checkout", "-q", "main");
  run(base, "clone", "-q", "--no-checkout", "origin", "repo");
  return join(base, "repo");
}

let counter = 0;
/** The same clone built twice: `native` and `ours`. */
function twins(): { native: string; ours: string } {
  const n = counter++;
  return { native: build(join(root, `t${n}-native`)), ours: build(join(root, `t${n}-ours`)) };
}

async function open(repo: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: nativeGitEnv(home) });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** Every file under `dir` (relative path -> content), `.git` left out. */
function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (path === ".git") continue;
      if (entry.isDirectory()) walk(path);
      else out[path] = readFileSync(join(dir, path), "latin1");
    }
  };
  if (existsSync(dir)) walk("");
  return out;
}

function snapshot(repo: string) {
  const head = attempt(repo, "symbolic-ref", "-q", "HEAD");
  return {
    head: head.status === 0 ? head.stdout : run(repo, "rev-parse", "HEAD"),
    refs: run(repo, "for-each-ref", "--format=%(refname) %(objectname) %(upstream)"),
    indexFile: existsSync(join(repo, ".git/index")),
    index: run(repo, "ls-files", "-s"),
    flags: run(repo, "ls-files", "-t"),
    worktree: tree(repo),
    status: run(repo, "status", "--porcelain=v1", "--untracked-files=all"),
  };
}

function expectSame(t: { native: string; ours: string }): void {
  const n = snapshot(t.native);
  const o = snapshot(t.ours);
  for (const key of Object.keys(n) as (keyof typeof n)[]) {
    expect([key, o[key]]).toEqual([key, n[key]]);
  }
}

describeGit("an unborn index (clone --no-checkout), native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "initial-checkout-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("checkout <current branch> and switch <current branch> check the whole tree out", async () => {
    for (const command of ["checkout", "switch"] as const) {
      const t = twins();
      run(t.native, command, "-q", "main");
      const git = await open(t.ours);
      const result =
        command === "checkout"
          ? await git.checkout().setName("main").call()
          : await git.switch().setName("main").call();
      expect(result.status).toBe(CheckoutStatus.OK);
      expectSame(t);
      expect(tree(t.ours)).toEqual({ "a.txt": "a\n", "d/b.txt": "b\n" });
    }
  });

  it("checkout / switch to another branch (guessed from origin), checkout HEAD, checkout -B", async () => {
    const t = twins();
    run(t.native, "checkout", "-q", "other");
    await (await open(t.ours)).checkout().setName("other").call();
    expectSame(t);

    const s = twins();
    run(s.native, "switch", "-q", "other");
    await (await open(s.ours)).switch().setName("other").call();
    expectSame(s);

    const h = twins();
    run(h.native, "checkout", "-q", "HEAD");
    await (await open(h.ours)).checkout().setName("HEAD").call();
    expectSame(h);

    const b = twins();
    run(b.native, "checkout", "-q", "-B", "main");
    await (await open(b.ours))
      .checkout()
      .setCreateBranch(true)
      .setForceCreateBranch(true)
      .setName("main")
      .call();
    expectSame(b);
  });

  it("checkout -b: the bare `checkout -b <new>` and `switch -c` leave the index unborn, with options or a start point it is checked out", async () => {
    // exactly `git checkout -b new`: only_merge_on_switching_branches
    const bare = twins();
    run(bare.native, "checkout", "-b", "new");
    await (await open(bare.ours))
      .checkout()
      .setCreateBranch(true)
      .setName("new")
      .setOnlyMergeOnSwitchingBranches(true)
      .call();
    expectSame(bare);
    expect(existsSync(join(bare.ours, ".git/index"))).toBe(false);

    const sw = twins();
    run(sw.native, "switch", "-q", "-c", "new");
    await (await open(sw.ours)).switch().setCreateBranch("new").call();
    expectSame(sw);

    // `checkout -q -b new` (more arguments): merged
    const quiet = twins();
    run(quiet.native, "checkout", "-q", "-b", "new");
    await (await open(quiet.ours)).checkout().setCreateBranch(true).setName("new").call();
    expectSame(quiet);
    expect(tree(quiet.ours)).toEqual({ "a.txt": "a\n", "d/b.txt": "b\n" });

    const start = twins();
    run(start.native, "checkout", "-b", "new", "origin/other");
    await (await open(start.ours))
      .checkout()
      .setCreateBranch(true)
      .setName("new")
      .setStartPoint("origin/other")
      .setOnlyMergeOnSwitchingBranches(true)
      .call();
    expectSame(start);

    const swStart = twins();
    run(swStart.native, "switch", "-q", "-c", "new", "origin/other");
    await (await open(swStart.ours)).switch().setCreateBranch("new").setName("origin/other").call();
    expectSame(swStart);
  });

  it("checkout --detach checks out, switch --detach without a commit does not", async () => {
    const c = twins();
    run(c.native, "checkout", "-q", "--detach");
    await (await open(c.ours)).checkout().setDetach(true).call();
    expectSame(c);

    const co = twins();
    run(co.native, "checkout", "-q", "--detach", "origin/other");
    await (await open(co.ours)).checkout().setDetach(true).setName("origin/other").call();
    expectSame(co);

    const s = twins();
    run(s.native, "switch", "-q", "--detach");
    await (await open(s.ours)).switch().setDetach(true).call();
    expectSame(s);

    const so = twins();
    run(so.native, "switch", "-q", "--detach", "origin/other");
    await (await open(so.ours)).switch().setDetach(true).setName("origin/other").call();
    expectSame(so);
  });

  it("checkout --orphan checks HEAD's files out into the new branch's index; switch --orphan starts empty", async () => {
    const c = twins();
    run(c.native, "checkout", "-q", "--orphan", "x");
    await (await open(c.ours)).checkout().setOrphan(true).setName("x").call();
    expectSame(c);

    const s = twins();
    run(s.native, "switch", "-q", "--orphan", "x");
    await (await open(s.ours)).switch().setOrphan("x").call();
    expectSame(s);
  });

  it("untracked files where the checkout writes refuse it, with git's message; the index stays unborn", async () => {
    const t = twins();
    for (const repo of [t.native, t.ours]) {
      put(repo, "a.txt", "untracked\n");
      put(repo, "o.txt", "u\n");
    }
    const native = attempt(t.native, "checkout", "other");
    expect(native.status).toBe(1);
    const result = await (await open(t.ours)).checkout().setName("other").call();
    expect(result.status).toBe(CheckoutStatus.CONFLICTS);
    expect(result.message).toBe(native.stderr.trimEnd());
    expectSame(t);

    // the current branch too
    const m = twins();
    for (const repo of [m.native, m.ours]) put(repo, "d/b.txt", "untracked\n");
    const nm = attempt(m.native, "switch", "main");
    expect(nm.status).toBe(1);
    const rm = await (await open(m.ours)).switch().setName("main").call();
    expect(rm.message).toBe(nm.stderr.trimEnd());
    expectSame(m);

    // an untracked file with the target's content is still in the way; ignored files are
    // overwritten
    const i = twins();
    for (const repo of [i.native, i.ours]) {
      put(repo, ".git/info/exclude", "o.txt\n");
      put(repo, "o.txt", "ignored\n");
    }
    run(i.native, "checkout", "-q", "other");
    await (await open(i.ours)).checkout().setName("other").call();
    expectSame(i);
  });

  it("with sparse-checkout patterns: entries outside are skip-worktree and not written, an untracked file there stays tracked", async () => {
    for (const prepare of [
      (_repo: string) => {},
      (repo: string) => put(repo, "d/b.txt", "untracked\n"),
    ]) {
      const t = twins();
      for (const repo of [t.native, t.ours]) {
        run(repo, "sparse-checkout", "set", "--no-cone", "/a.txt");
        prepare(repo);
      }
      expect(existsSync(join(t.native, ".git/index"))).toBe(false);
      run(t.native, "checkout", "-q", "main");
      await (await open(t.ours)).checkout().setName("main").call();
      expectSame(t);
    }

    const o = twins();
    for (const repo of [o.native, o.ours]) {
      run(repo, "sparse-checkout", "set", "--no-cone", "/a.txt");
    }
    run(o.native, "checkout", "-q", "origin/other");
    await (await open(o.ours)).checkout().setName("origin/other").call();
    expectSame(o);
  });

  it("sparse-checkout set on an unborn index writes no index; the checkout then follows its patterns", async () => {
    const t = twins();
    run(t.native, "sparse-checkout", "set", "d");
    const result = await (await open(t.ours)).sparseCheckout().setArguments(["set", "d"]).call();
    expect(result.exitCode).toBe(0);
    expectSame(t);
    run(t.native, "checkout", "-q", "main");
    await (await open(t.ours)).checkout().setName("main").call();
    expectSame(t);
  });

  it("read-tree -m H M (with and without -u) takes every entry of M as new", async () => {
    for (const update of [true, false]) {
      const t = twins();
      const args = ["read-tree", "-m", ...(update ? ["-u"] : []), "HEAD", "origin/other"];
      run(t.native, ...args);
      const cmd = (await open(t.ours))
        .readTree()
        .setMerge(true)
        .addTree("HEAD")
        .addTree("origin/other");
      if (update) cmd.setUpdate(true);
      await cmd.call();
      expectSame(t);
    }
    // one tree: an ordinary read (the worktree's files missing)
    const one = twins();
    run(one.native, "read-tree", "HEAD");
    await (await open(one.ours)).readTree().addTree("HEAD").call();
    expectSame(one);
  });

  it("status, diff --cached and commit read the missing index as empty: HEAD's files staged as deleted", async () => {
    const t = twins();
    const nativeStatus = run(t.native, "status");
    const long = await (await open(t.ours)).status().callText({ format: "long" });
    expect(long.text).toBe(nativeStatus);
    const v2 = await (await open(t.ours)).status().callText({ format: "porcelain-v2" });
    expect(v2.text).toBe(run(t.native, "status", "--porcelain=v2"));
    expect(await (await open(t.ours)).diff().setCached(true).callText("stat")).toBe(
      run(t.native, "diff", "--cached", "--stat"),
    );
    run(t.native, "commit", "-qm", "x");
    await (await open(t.ours)).commit().setMessage("x").call();
    expectSame(t);
  });

  it("reset --hard and reset (mixed) fill the index from HEAD; add . stages nothing", async () => {
    const h = twins();
    run(h.native, "reset", "-q", "--hard");
    await (await open(h.ours)).reset().setMode(ResetMode.HARD).call();
    expectSame(h);

    const m = twins();
    run(m.native, "reset", "-q");
    await (await open(m.ours)).reset().setMode(ResetMode.MIXED).call();
    expectSame(m);

    const a = twins();
    run(a.native, "add", ".");
    await (await open(a.ours)).add().addFilepattern(".").call();
    expectSame(a);
  });

  it("restore . matches nothing in the empty index; stash saves the deletions and checks HEAD out", async () => {
    const r = twins();
    const native = attempt(r.native, "restore", ".");
    expect(native.status).toBe(1);
    let message = "";
    try {
      const result = await (await open(r.ours)).restore().addPath(".").call();
      message = (result as { message?: string }).message ?? "";
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(native.stderr.trimEnd());
    expectSame(r);

    const s = twins();
    run(s.native, "stash", "-q");
    await (await open(s.ours)).stashCreate().call();
    expectSame(s);
    expect(run(s.ours, "stash", "show", "--stat")).toBe(run(s.native, "stash", "show", "--stat"));
    expect(run(s.ours, "rev-parse", "stash^{tree}", "stash^2^{tree}")).toBe(
      run(s.native, "rev-parse", "stash^{tree}", "stash^2^{tree}"),
    );
  });

  it("rebase refuses: the staged deletions pass its clean check (has_uncommitted_changes), its checkout does not", async () => {
    const t = twins();
    const native = attempt(t.native, "rebase", "origin/other");
    let message = "";
    try {
      const result = await (await open(t.ours)).rebase().setUpstream("origin/other").call();
      message = `${result.message ?? ""}\n`;
    } catch (error) {
      message = (error as Error).message;
    }
    expect({ status: native.status, message }).toEqual({ status: 1, message: native.stderr });
    expectSame(t);

    // the same fast-forward refused by an untracked file (an index of its own): checkout_onto's line
    const u = twins();
    for (const repo of [u.native, u.ours]) {
      run(repo, "checkout", "-q", "main");
      put(repo, "o.txt", "u\n");
    }
    const nu = attempt(u.native, "rebase", "origin/other");
    const ru = await (await open(u.ours)).rebase().setUpstream("origin/other").call();
    expect({ status: nu.status, message: `${ru.message ?? ""}\n` }).toEqual({
      status: 1,
      message: nu.stderr,
    });
    expectSame(u);
  });

  it("worktree add --no-checkout, then checkout --detach in it", async () => {
    const t = twins();
    for (const repo of [t.native, t.ours]) {
      run(repo, "worktree", "add", "-q", "--no-checkout", "../wt", "origin/other");
    }
    const wn = join(t.native, "../wt");
    const wo = join(t.ours, "../wt");
    for (const wt of [wn, wo])
      expect(run(wt, "status", "--short")).toBe("D  a.txt\nD  d/b.txt\nD  o.txt\n");
    run(wn, "checkout", "-q", "--detach");
    await (await openLinked(t.ours)).checkout().setDetach(true).call();
    expectSame({ native: wn, ours: wo });
  });
});

/** Our side of the linked worktree `wt` next to `repo`. */
async function openLinked(repo: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: join(repo, "..") });
  const environment = createNodeGitHostEnvironment({ env: nativeGitEnv(home) });
  const { history } = await createGitFilesBackend({ files, gitDir: "repo/.git" });
  const linked = await openGitLinkedWorktrees({
    files,
    gitDir: "repo/.git/worktrees/wt",
    history,
    environment,
  });
  return Git.fromWorkingCopy(await linked.openCurrent());
}
