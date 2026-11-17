/**
 * `git switch`, `checkout --detach`, `checkout -` / `@{-N}`, against native git: every
 * repository is built twice by native git with fixed dates (same ids), one twin changed by
 * native git, the other by our commands, then compared: refs and HEAD, every reflog byte
 * for byte, `.git/config`, the index (`ls-files -s`), the worktree, `status`; a refusal by
 * its exact message (git's `fatal: ...` lines, hints included where both versions agree).
 *
 * Our side gets git's variables through `createNodeGitHostEnvironment({ env })`.
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

import { CheckoutStatus, Git, TrackMode } from "../src/index.js";
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
/** Native git that may fail: its exit status and stderr. */
const attempt = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, env: nativeGitEnv(home), encoding: "latin1" });
  return { status: r.status, stderr: r.stderr };
};
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/**
 * The upstream `origin` (main: c1, c2; dev and topic at c1; a tag), and the repository both
 * twins start from: a native clone of it with a remote `up` (also having dev), a local
 * branch `feat` (f1), tags `v1` (lightweight) and `va` (annotated).
 */
function build(base: string): string {
  mkdirSync(base, { recursive: true });
  const origin = join(base, "origin");
  run(base, "init", "-q", "-b", "main", "origin");
  put(origin, "a.txt", "a\n");
  run(origin, "add", ".");
  run(origin, "commit", "-qm", "c1");
  run(origin, "branch", "dev");
  run(origin, "branch", "topic");
  put(origin, "a.txt", "a\nmore\n");
  put(origin, "d/b.txt", "b\n");
  run(origin, "add", ".");
  run(origin, "commit", "-qm", "c2");
  run(base, "clone", "-q", "origin", "repo");
  const repo = join(base, "repo");
  run(repo, "tag", "v1", "HEAD~1");
  run(repo, "tag", "-a", "-m", "annotated", "va", "HEAD~1");
  run(repo, "checkout", "-q", "-b", "feat");
  put(repo, "f.txt", "f\n");
  run(repo, "add", ".");
  run(repo, "commit", "-qm", "f1");
  run(repo, "checkout", "-q", "main");
  return repo;
}

let counter = 0;
/** The same repository built twice: `native` and `ours` (their `repo` directories). */
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

/** Every file under `dir` (relative path -> content), `skip` directories left out. */
function tree(dir: string, skip: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (skip.includes(path)) continue;
      if (entry.isDirectory()) walk(path);
      else out[path] = readFileSync(join(dir, path), "latin1");
    }
  };
  if (existsSync(dir)) walk("");
  return out;
}

/** What the comparison covers, with the twin's own path evened out. */
function snapshot(repo: string) {
  const even = (text: string) =>
    text.split(repo).join("<repo>").split(join(repo, "..")).join("<base>");
  const head = attempt(repo, "symbolic-ref", "-q", "HEAD");
  return {
    head: head.status === 0 ? run(repo, "symbolic-ref", "HEAD") : run(repo, "rev-parse", "HEAD"),
    refs: run(repo, "for-each-ref", "--format=%(refname) %(objectname) %(symref)"),
    reflogs: Object.fromEntries(
      Object.entries(tree(join(repo, ".git/logs"))).map(([k, v]) => [k, even(v)]),
    ),
    config: even(readFileSync(join(repo, ".git/config"), "latin1")),
    index: run(repo, "ls-files", "-s"),
    worktree: tree(repo, [".git"]),
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

/** The message our call is refused with. */
async function refusal(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

/** A native refusal's stderr, as our error's message carries it (no trailing newline). */
const nativeRefusal = (repo: string, ...args: string[]) => {
  const r = attempt(repo, ...args);
  expect(r.status).toBe(128);
  return r.stderr.trimEnd();
};

describeGit("git switch, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "switch-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("switch <branch>, switch -, -c with and without a start point, -C (also the current branch)", async () => {
    const t = twins();
    for (const args of [
      ["feat"],
      ["main"],
      ["-"],
      ["-"],
      ["-c", "nb"],
      ["-c", "nb2", "feat"],
      ["-C", "nb", "v1"],
      ["-C", "nb", "main"],
    ]) {
      run(t.native, "switch", "-q", ...args);
    }
    const git = await open(t.ours);
    await git.switch().setName("feat").call();
    await git.switch().setName("main").call();
    await git.switch().setName("-").call();
    await git.switch().setName("-").call();
    await git.switch().setCreateBranch("nb").call();
    await git.switch().setCreateBranch("nb2").setStartPoint("feat").call();
    await git.switch().setForceCreateBranch("nb").setStartPoint("v1").call();
    await git.switch().setForceCreateBranch("nb").setStartPoint("main").call();
    expectSame(t);
    const head = readFileSync(join(t.ours, ".git/logs/HEAD"), "latin1");
    expect(head).toContain("\tcheckout: moving from feat to main\n");
    expect(head).toContain("\tbranch: Reset to main\n");
  });

  it("switch --detach [<commit>], checkout --detach [<commit>], checkout - and @{-N}", async () => {
    const t = twins();
    const steps: string[][] = [
      ["switch", "--detach"],
      ["switch", "main"],
      ["switch", "--detach", "va"],
      ["checkout", "main"],
      ["checkout", "--detach"],
      ["checkout", "main"],
      ["checkout", "--detach", "feat"],
      ["checkout", "-"],
      ["checkout", "@{-1}"],
      ["checkout", "@{-2}"],
      ["checkout", "feat"],
      ["checkout", "@{-3}~1"],
    ];
    for (const step of steps) run(t.native, step[0] as string, "-q", ...step.slice(1));
    const git = await open(t.ours);
    await git.switch().setDetach(true).call();
    await git.switch().setName("main").call();
    await git.switch().setDetach(true).setName("va").call();
    await git.checkout().setName("main").call();
    await git.checkout().setDetach(true).call();
    await git.checkout().setName("main").call();
    await git.checkout().setDetach(true).setName("feat").call();
    await git.checkout().setName("-").call();
    await git.checkout().setName("@{-1}").call();
    await git.checkout().setName("@{-2}").call();
    await git.checkout().setName("feat").call();
    await git.checkout().setName("@{-3}~1").call();
    expectSame(t);
    const lines = readFileSync(join(t.ours, ".git/logs/HEAD"), "latin1")
      .trim()
      .split("\n")
      .map((l) => l.slice(l.indexOf("\t") + 1));
    expect(lines).toContain("checkout: moving from main to HEAD");
  });

  it("switch --orphan: an empty index and worktree, untracked files kept; back to a branch", async () => {
    const t = twins();
    for (const repo of [t.native, t.ours]) put(repo, "untracked.txt", "u\n");
    run(t.native, "switch", "-q", "--orphan", "pages");
    const git = await open(t.ours);
    await git.switch().setOrphan("pages").call();
    expectSame(t);
    for (const repo of [t.native, t.ours]) put(repo, "p.txt", "p\n");
    run(t.native, "add", "p.txt");
    run(t.native, "commit", "-qm", "pages");
    await (await open(t.ours)).add().addFilepattern("p.txt").call();
    await (await open(t.ours)).commit().setMessage("pages").call();
    run(t.native, "switch", "-q", "main");
    await (await open(t.ours)).switch().setName("main").call();
    expectSame(t);
  });

  it("--guess: a remote-tracking branch becomes a tracking local branch; --no-guess, ambiguity, checkout.defaultRemote", async () => {
    const t = twins();
    for (const repo of [t.native, t.ours]) {
      run(repo, "remote", "add", "up", "../origin");
      run(repo, "fetch", "-q", "up");
    }
    // topic: only origin's... and up's: ambiguous
    expect(await refusal(async () => (await open(t.ours)).switch().setName("topic").call())).toBe(
      "fatal: 'topic' matched multiple (2) remote tracking branches",
    );
    expect(nativeRefusal(t.native, "switch", "topic").split("\n").at(-1)).toBe(
      "fatal: 'topic' matched multiple (2) remote tracking branches",
    );
    for (const repo of [t.native, t.ours]) run(repo, "config", "checkout.defaultRemote", "origin");
    run(t.native, "switch", "-q", "topic");
    await (await open(t.ours)).switch().setName("topic").call();
    expectSame(t);
    // --no-guess: an invalid reference
    expect(
      await refusal(async () =>
        (await open(t.ours)).switch().setName("dev").setGuess(false).call(),
      ),
    ).toBe(nativeRefusal(t.native, "switch", "--no-guess", "dev"));
    // with one remote left the guess needs no default
    for (const repo of [t.native, t.ours]) {
      run(repo, "config", "--unset", "checkout.defaultRemote");
      run(repo, "remote", "remove", "up");
    }
    run(t.native, "switch", "-q", "dev");
    await (await open(t.ours)).switch().setName("dev").call();
    expectSame(t);
    expect(readFileSync(join(t.ours, ".git/logs/refs/heads/dev"), "latin1")).toContain(
      "\tbranch: Created from refs/remotes/origin/dev\n",
    );
    // checkout guesses too
    run(t.native, "checkout", "-q", "main");
    run(t.native, "branch", "-q", "-D", "dev");
    const git = await open(t.ours);
    await git.checkout().setName("main").call();
    await git.branchDelete().setBranchNames("dev").setForce(true).call();
    expectSame(t);
    run(t.native, "checkout", "-q", "dev");
    await (await open(t.ours)).checkout().setName("dev").call();
    expectSame(t);
  });

  it("--track and --no-track: a remote start point, a local one (remote .), --track without -c", async () => {
    const t = twins();
    for (const args of [
      ["-c", "t1", "origin/topic"],
      ["--no-track", "-c", "t2", "origin/topic"],
      ["--track", "-c", "t3", "main"],
      ["-c", "t4", "main"],
      ["--track", "origin/dev"],
    ]) {
      run(t.native, "switch", "-q", ...args);
    }
    const git = await open(t.ours);
    await git.switch().setCreateBranch("t1").setStartPoint("origin/topic").call();
    await git
      .switch()
      .setCreateBranch("t2")
      .setStartPoint("origin/topic")
      .setTrack(TrackMode.NONE)
      .call();
    await git
      .switch()
      .setCreateBranch("t3")
      .setStartPoint("main")
      .setTrack(TrackMode.DIRECT)
      .call();
    await git.switch().setCreateBranch("t4").setStartPoint("main").call();
    await git.switch().setName("origin/dev").setTrack(TrackMode.DIRECT).call();
    expectSame(t);
    expect(readFileSync(join(t.ours, ".git/config"), "latin1")).toContain(
      '[branch "t3"]\n\tremote = .\n\tmerge = refs/heads/main\n',
    );
    // HEAD as the start point is the branch it is on: --track, and branch.autoSetupMerge
    run(t.native, "switch", "-q", "--track", "-c", "t5");
    await (await open(t.ours)).switch().setCreateBranch("t5").setTrack(TrackMode.DIRECT).call();
    for (const repo of [t.native, t.ours]) run(repo, "config", "branch.autoSetupMerge", "always");
    run(t.native, "switch", "-q", "-c", "t6");
    await (await open(t.ours)).switch().setCreateBranch("t6").call();
    run(t.native, "checkout", "-q", "-b", "t7", "origin");
    await (await open(t.ours))
      .checkout()
      .setCreateBranch(true)
      .setName("t7")
      .setStartPoint("origin")
      .call();
    // --track=inherit copies the start branch's upstream
    run(t.native, "switch", "-q", "--track=inherit", "-c", "t8", "main");
    await (await open(t.ours))
      .switch()
      .setCreateBranch("t8")
      .setStartPoint("main")
      .setTrack(TrackMode.INHERIT)
      .call();
    expectSame(t);
  });

  it("refusals: not a branch (tag, commit, remote branch, HEAD), an invalid reference, an existing branch, options", async () => {
    const t = twins();
    const git = await open(t.ours);
    const cases: [string[], () => Promise<unknown>][] = [
      [["v1"], () => git.switch().setName("v1").call()],
      [["va"], () => git.switch().setName("va").call()],
      [["HEAD~1"], () => git.switch().setName("HEAD~1").call()],
      [["origin/dev"], () => git.switch().setName("origin/dev").call()],
      [["origin"], () => git.switch().setName("origin").call()],
      [["HEAD"], () => git.switch().setName("HEAD").call()],
      [["nope"], () => git.switch().setName("nope").call()],
      [["@{-5}"], () => git.switch().setName("@{-5}").call()],
      [["-c", "feat"], () => git.switch().setCreateBranch("feat").call()],
      [["--orphan", "o", "main"], () => git.switch().setOrphan("o").setName("main").call()],
      [["--detach", "-c", "x"], () => git.switch().setDetach(true).setCreateBranch("x").call()],
      [[], () => git.switch().call()],
      [["-c", "x", "nope"], () => git.switch().setCreateBranch("x").setStartPoint("nope").call()],
      [["--detach", "nope"], () => git.switch().setDetach(true).setName("nope").call()],
    ];
    for (const [args, call] of cases) {
      expect([args, await refusal(call)]).toEqual([
        args,
        nativeRefusal(t.native, "switch", ...args),
      ]);
    }
    // a detached HEAD named by HEAD, and a commit named by @{-N}
    run(t.native, "checkout", "-q", "--detach");
    await git.checkout().setDetach(true).call();
    expect(await refusal(() => git.switch().setName("HEAD").call())).toBe(
      nativeRefusal(t.native, "switch", "HEAD"),
    );
    run(t.native, "checkout", "-q", "main");
    await git.checkout().setName("main").call();
    expect(await refusal(() => git.switch().setName("@{-1}").call())).toBe(
      nativeRefusal(t.native, "switch", "@{-1}"),
    );
    expectSame(t);
  });

  it("a branch another worktree has checked out: refused, or --ignore-other-worktrees", async () => {
    const t = twins();
    for (const repo of [t.native, t.ours]) run(repo, "worktree", "add", "-q", "../wt", "feat");
    const native = nativeRefusal(t.native, "switch", "feat")
      .split(join(t.native, ".."))
      .join("<base>");
    const ours = (await refusal(async () => (await open(t.ours)).switch().setName("feat").call()))
      .split(join(t.ours, ".."))
      .join("<base>");
    expect(ours).toBe(native);
    run(t.native, "switch", "-q", "--ignore-other-worktrees", "feat");
    await (await open(t.ours)).switch().setName("feat").setIgnoreOtherWorktrees(true).call();
    expectSame(t);
  });

  it("refused in the middle of a merge; --discard-changes and local changes; a two-way switch keeps them", async () => {
    const t = twins();
    // a local change the switch to feat carries over, one it would overwrite
    for (const repo of [t.native, t.ours]) put(repo, "f.txt", "local\n");
    const native = attempt(t.native, "switch", "feat");
    const ours = await (await open(t.ours)).switch().setName("feat").call();
    expect(native.status).toBe(1);
    expect(ours.status).toBe(CheckoutStatus.CONFLICTS);
    expect(`${ours.message}\n`).toBe(native.stderr);
    expectSame(t);
    // --discard-changes keeps an untracked file in the way: refused, one line per path
    const keep = attempt(t.native, "switch", "--discard-changes", "feat");
    const kept = await (await open(t.ours)).switch().setName("feat").setDiscardChanges(true).call();
    expect(keep.status).toBe(128);
    expect(`${kept.message}\n`).toBe(keep.stderr);
    expectSame(t);
    // -f overwrites it
    run(t.native, "switch", "-q", "-f", "feat");
    await (await open(t.ours)).switch().setName("feat").setForced(true).call();
    expectSame(t);
    // --discard-changes throws a tracked file's change away
    for (const repo of [t.native, t.ours]) put(repo, "f.txt", "changed\n");
    run(t.native, "switch", "-q", "--discard-changes", "main");
    await (await open(t.ours)).switch().setName("main").setDiscardChanges(true).call();
    expectSame(t);
    // a change both branches agree on is carried over
    for (const repo of [t.native, t.ours]) put(repo, "a.txt", "a\nedited\n");
    run(t.native, "switch", "-q", "-");
    await (await open(t.ours)).switch().setName("-").call();
    expectSame(t);

    for (const repo of [t.native, t.ours]) run(repo, "checkout", "-q", "-f", "main");
    for (const repo of [t.native, t.ours]) {
      run(repo, "checkout", "-q", "-b", "side", "HEAD~1");
      put(repo, "a.txt", "side\n");
      run(repo, "commit", "-qam", "side");
      expect(attempt(repo, "merge", "-q", "main").status).toBe(1);
    }
    const git = await open(t.ours);
    expect(await refusal(() => git.switch().setName("main").call())).toBe(
      nativeRefusal(t.native, "switch", "main"),
    );
    expectSame(t);
  });

  it("- and @{-N} as a start point: expanded for the reflog and for tracking", async () => {
    const t = twins();
    for (const repo of [t.native, t.ours]) {
      run(repo, "checkout", "-q", "feat");
      run(repo, "checkout", "-q", "main");
    }
    run(t.native, "switch", "-q", "-c", "x", "-");
    await (await open(t.ours)).switch().setCreateBranch("x").setStartPoint("-").call();
    expectSame(t);
    expect(readFileSync(join(t.ours, ".git/logs/refs/heads/x"), "latin1")).toContain(
      "\tbranch: Created from feat\n",
    );
    run(t.native, "checkout", "-q", "-b", "y", "-");
    await (await open(t.ours))
      .checkout()
      .setCreateBranch(true)
      .setName("y")
      .setStartPoint("-")
      .call();
    run(t.native, "checkout", "-q", "-b", "z", "@{-2}");
    await (await open(t.ours))
      .checkout()
      .setCreateBranch(true)
      .setName("z")
      .setStartPoint("@{-2}")
      .call();
    expectSame(t);
    // the branch @{-1} names is tracked: branch.autoSetupMerge=always, and --track
    for (const repo of [t.native, t.ours]) run(repo, "config", "branch.autoSetupMerge", "always");
    run(t.native, "switch", "-q", "-c", "w", "@{-1}");
    await (await open(t.ours)).switch().setCreateBranch("w").setStartPoint("@{-1}").call();
    run(t.native, "switch", "-q", "--track", "-c", "v", "-");
    await (await open(t.ours))
      .switch()
      .setCreateBranch("v")
      .setStartPoint("-")
      .setTrack(TrackMode.DIRECT)
      .call();
    expectSame(t);
    expect(readFileSync(join(t.ours, ".git/config"), "latin1")).toContain(
      '[branch "v"]\n\tremote = .\n\tmerge = refs/heads/z\n',
    );
  });

  it("--track a start point that is no branch: refused where git dies, no branch created", async () => {
    const t = twins();
    const git = await open(t.ours);
    // the worktree and the index are switched, then git dies before the branch is made
    expect(
      await refusal(() =>
        git.switch().setCreateBranch("x").setStartPoint("v1").setTrack(TrackMode.DIRECT).call(),
      ),
    ).toBe(nativeRefusal(t.native, "switch", "-c", "x", "--track", "v1"));
    expectSame(t);
    for (const repo of [t.native, t.ours]) run(repo, "reset", "-q", "--hard");
    const reopened = await open(t.ours);
    expect(
      await refusal(() =>
        reopened
          .checkout()
          .setCreateBranch(true)
          .setName("x")
          .setStartPoint("v1")
          .setTrack(TrackMode.DIRECT)
          .call(),
      ),
    ).toBe(nativeRefusal(t.native, "checkout", "-b", "x", "--track", "v1"));
    expectSame(t);
    // a detached HEAD as the start point
    for (const repo of [t.native, t.ours]) run(repo, "checkout", "-q", "-f", "--detach", "main");
    const detached = await open(t.ours);
    expect(
      await refusal(() => detached.switch().setCreateBranch("x").setTrack(TrackMode.DIRECT).call()),
    ).toBe(nativeRefusal(t.native, "switch", "--track", "-c", "x"));
    expectSame(t);
  });

  it("- and @{-N} naming a deleted branch are not guessed into a remote-tracking branch", async () => {
    const t = twins();
    for (const repo of [t.native, t.ours]) {
      run(repo, "checkout", "-q", "dev");
      run(repo, "checkout", "-q", "main");
      run(repo, "branch", "-q", "-D", "dev");
    }
    const git = await open(t.ours);
    expect(await refusal(() => git.switch().setName("-").call())).toBe(
      nativeRefusal(t.native, "switch", "-"),
    );
    expect(await refusal(() => git.switch().setName("@{-1}").call())).toBe(
      nativeRefusal(t.native, "switch", "@{-1}"),
    );
    // checkout: git takes `-` for a path then ("error: pathspec '-' did not match ...")
    expect(attempt(t.native, "checkout", "-").status).toBe(1);
    expect(await refusal(() => git.checkout().setName("-").call())).toContain("-");
    expectSame(t);
  });

  it("--no-track without -c names the branch too; checkout HEAD leaves HEAD alone", async () => {
    const t = twins();
    run(t.native, "switch", "-q", "--no-track", "origin/topic");
    await (await open(t.ours)).switch().setName("origin/topic").setTrack(TrackMode.NONE).call();
    expectSame(t);
    const git = await open(t.ours);
    expect(
      await refusal(() =>
        git.switch().setDetach(true).setName("main").setTrack(TrackMode.NONE).call(),
      ),
    ).toBe(nativeRefusal(t.native, "switch", "--detach", "--no-track", "main"));
    expect(await refusal(() => git.switch().setCreateBranch("x").setOrphan("o").call())).toBe(
      nativeRefusal(t.native, "switch", "-c", "x", "--orphan", "o"),
    );
    // `checkout HEAD`: nothing moves, no reflog line
    run(t.native, "checkout", "-q", "HEAD");
    await (await open(t.ours)).checkout().setName("HEAD").call();
    expectSame(t);
  });
});
