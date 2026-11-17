/**
 * `switch -m` / `checkout -m` (git 2.55+'s autostash), `checkout -b` on an existing branch
 * and `-B`, `merge --no-commit -m` (MERGE_MSG), several `-m` for commit / merge / tag, and
 * `switch --discard-changes` over ignored and untracked files, against native git. Each
 * repository is built twice by native git with fixed dates (same ids), one twin changed by
 * native git, the other by our commands, then compared: refs and HEAD, every reflog byte
 * for byte, the index (`ls-files -s`), the worktree, `status`, MERGE_* files; refusals by
 * their exact `fatal:` lines.
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

import { CheckoutStatus, FastForwardMode, Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** The native git version, [major, minor]. */
function nativeVersion(): [number, number] {
  const m = /(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" }));
  return [Number(m?.[1] ?? 0), Number(m?.[2] ?? 0)];
}
const [major, minor] = nativeGitAvailable() ? nativeVersion() : [0, 0];
/** `checkout -m` stashes local changes from git 2.55 on (2.43 merges them in place). */
const autostashGit = major > 2 || (major === 2 && minor >= 55);
const itAutostash = autostashGit ? it : it.skip;

let root = "";
let home = "";
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(home),
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });
const attempt = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", args, { cwd, env: nativeGitEnv(home), encoding: "latin1" });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
};
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/**
 * main: a.txt (1 2 3), b.txt, c.txt; feat: a.txt's first line F, b.txt changed, d.txt
 * added; side: c.txt changed; a tag v1 at feat; on main.
 */
function build(base: string): string {
  mkdirSync(base, { recursive: true });
  run(base, "init", "-q", "-b", "main", "repo");
  const repo = join(base, "repo");
  put(repo, "a.txt", "1\n2\n3\n");
  put(repo, "b.txt", "b\n");
  put(repo, "c.txt", "c\n");
  put(repo, ".gitignore", "*.log\n");
  run(repo, "add", ".");
  run(repo, "commit", "-qm", "base");
  run(repo, "checkout", "-q", "-b", "feat");
  put(repo, "a.txt", "F\n2\n3\n");
  put(repo, "b.txt", "b feat\n");
  put(repo, "d.txt", "d\n");
  run(repo, "add", ".");
  run(repo, "commit", "-qm", "feat");
  run(repo, "tag", "v1");
  run(repo, "checkout", "-q", "-b", "side", "main");
  put(repo, "c.txt", "c side\n");
  run(repo, "commit", "-qam", "side");
  run(repo, "checkout", "-q", "main");
  return repo;
}

let counter = 0;
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

function snapshot(repo: string) {
  const head = attempt(repo, "symbolic-ref", "-q", "HEAD");
  const state = (name: string) =>
    existsSync(join(repo, ".git", name)) ? readFileSync(join(repo, ".git", name), "latin1") : null;
  return {
    head: head.status === 0 ? run(repo, "symbolic-ref", "HEAD") : run(repo, "rev-parse", "HEAD"),
    refs: run(repo, "for-each-ref", "--format=%(refname) %(objectname) %(symref)"),
    reflogs: tree(join(repo, ".git/logs")),
    index: run(repo, "ls-files", "-s"),
    worktree: tree(repo, [".git"]),
    status: run(repo, "status", "--porcelain=v1", "--untracked-files=all"),
    mergeHead: state("MERGE_HEAD"),
    mergeMsg: state("MERGE_MSG"),
    mergeMode: state("MERGE_MODE"),
    autostash: state("CHECKOUT_AUTOSTASH_HEAD"),
  };
}

function expectSame(t: { native: string; ours: string }): void {
  const n = snapshot(t.native);
  const o = snapshot(t.ours);
  for (const key of Object.keys(n) as (keyof typeof n)[]) {
    expect([key, o[key]]).toEqual([key, n[key]]);
  }
}

async function refusal(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a refusal");
}

const nativeRefusal = (repo: string, ...args: string[]) => {
  const r = attempt(repo, ...args);
  expect(r.status).toBe(128);
  return r.stderr.trimEnd();
};

/** The same local change written to both twins. */
const both = (t: { native: string; ours: string }, fn: (repo: string) => void) => {
  fn(t.native);
  fn(t.ours);
};

describeGit("switch -m, checkout -m/-b/-B, merge -m, several -m, --discard-changes", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "switch-merge-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  itAutostash("switch -m: a clean path, a conflicting one and a new staged file", async () => {
    const t = twins();
    both(t, (repo) => {
      put(repo, "a.txt", "1\n2\nL\n");
      put(repo, "b.txt", "b local\n");
      put(repo, "n.txt", "new\n");
      run(repo, "add", "n.txt");
    });
    // git exits 0: the switch is made, the conflicts left with the stash
    expect(attempt(t.native, "switch", "-m", "feat").status).toBe(0);
    const result = await (await open(t.ours)).switch().setName("feat").setMerge(true).call();
    expect(result.status).toBe(CheckoutStatus.CONFLICTS);
    expectSame(t);
  });

  itAutostash("switch -m: a clean carry-over (staged changes come back unstaged)", async () => {
    const t = twins();
    both(t, (repo) => {
      put(repo, "a.txt", "1\n2\nL\n");
      run(repo, "add", "a.txt");
      put(repo, "c.txt", "c local\n");
      put(repo, "n.txt", "new\n");
      run(repo, "add", "n.txt");
      put(repo, "x.log", "ignored\n");
      put(repo, "u.txt", "untracked\n");
    });
    const n = attempt(t.native, "switch", "-m", "feat");
    expect(n.status).toBe(0);
    expect(n.stderr).toContain("Applied autostash.");
    const result = await (await open(t.ours)).switch().setName("feat").setMerge(true).call();
    expect(result.status).toBe(CheckoutStatus.OK);
    expect(result.message).toBe("Applied autostash.");
    expectSame(t);
  });

  itAutostash(
    "switch -m: a conflict leaves markers labelled <branch> / local and a stash entry",
    async () => {
      const t = twins();
      both(t, (repo) => put(repo, "a.txt", "L\n2\n3\n"));
      const n = attempt(t.native, "switch", "-m", "feat");
      expect(n.status).toBe(0);
      const result = await (await open(t.ours)).switch().setName("feat").setMerge(true).call();
      expect(result.status).toBe(CheckoutStatus.CONFLICTS);
      expect(result.ref).not.toBeNull();
      expect(result.conflicts).toEqual(["a.txt"]);
      expect(n.stderr).toContain(result.message ?? "<none>");
      expect(readFileSync(join(t.ours, "a.txt"), "latin1")).toBe(
        "<<<<<<< feat\nF\n=======\nL\n>>>>>>> local\n2\n3\n",
      );
      expectSame(t);
    },
  );

  itAutostash("checkout -m: detached target, diff3 base label from the branch left", async () => {
    const t = twins();
    both(t, (repo) => {
      run(repo, "config", "merge.conflictStyle", "diff3");
      put(repo, "a.txt", "L\n2\n3\n");
    });
    expect(attempt(t.native, "checkout", "-m", "v1").status).toBe(0);
    const result = await (await open(t.ours)).checkout().setName("v1").setMerge(true).call();
    expect(result.status).toBe(CheckoutStatus.CONFLICTS);
    expect(readFileSync(join(t.ours, "a.txt"), "latin1")).toContain("||||||| main\n");
    expectSame(t);
    // from the detached HEAD, back with a change: the base is the abbreviated commit
    both(t, (repo) => {
      run(repo, "checkout", "-q", "-f", "v1");
      put(repo, "a.txt", "F\n2\nM\n");
      put(repo, "c.txt", "c detached\n");
    });
    expect(attempt(t.native, "checkout", "-m", "side").status).toBe(0);
    await (await open(t.ours)).checkout().setName("side").setMerge(true).call();
    expectSame(t);
  });

  it("switch -m with -f or --discard-changes is refused as git refuses it", async () => {
    const t = twins();
    const git = await open(t.ours);
    expect(
      await refusal(() => git.switch().setName("feat").setMerge(true).setForced(true).call()),
    ).toBe(nativeRefusal(t.native, "switch", "-m", "-f", "feat"));
    expect(
      await refusal(() =>
        git.switch().setName("feat").setMerge(true).setDiscardChanges(true).call(),
      ),
    ).toBe(nativeRefusal(t.native, "switch", "-m", "--discard-changes", "feat"));
  });

  it("checkout -m without local changes is a plain switch; with an untracked file in the way it is refused", async () => {
    const t = twins();
    run(t.native, "checkout", "-q", "-m", "feat");
    await (await open(t.ours)).checkout().setName("feat").setMerge(true).call();
    expectSame(t);
    both(t, (repo) => put(repo, "c.txt", "only local\n"));
    run(t.native, "checkout", "-q", "-m", "main");
    await (await open(t.ours)).checkout().setName("main").setMerge(true).call();
    expectSame(t);
    // an untracked d.txt where feat writes one: refused, HEAD stays, the local change kept
    // (git 2.55+ stashes it, fails the switch again and applies the stash back)
    both(t, (repo) => put(repo, "d.txt", "untracked d\n"));
    const n = attempt(t.native, "checkout", "-m", "feat");
    expect(n.status).not.toBe(0);
    const result = await (await open(t.ours)).checkout().setName("feat").setMerge(true).call();
    expect(result.status).toBe(CheckoutStatus.CONFLICTS);
    expect(result.ref).toBeNull();
    const ours = result.message ?? "";
    expect(ours.endsWith("\nApplied autostash.")).toBe(true);
    // (git 2.43 merged in place and died on the untracked file with its own line)
    if (autostashGit) expect(n.stderr.trimEnd()).toBe(ours);
    expectSame(t);
  });

  it("checkout -b refuses an existing branch; setForceCreateBranch is -B", async () => {
    const t = twins();
    const git = await open(t.ours);
    expect(await refusal(() => git.checkout().setCreateBranch(true).setName("feat").call())).toBe(
      nativeRefusal(t.native, "checkout", "-b", "feat"),
    );
    expectSame(t);
    run(t.native, "checkout", "-q", "-B", "feat", "side");
    run(t.native, "checkout", "-q", "-B", "fresh");
    await git.checkout().setForceCreateBranch(true).setName("feat").setStartPoint("side").call();
    await (await open(t.ours)).checkout().setForceCreateBranch(true).setName("fresh").call();
    expectSame(t);
  });

  it("merge --no-commit -m: MERGE_MSG as git writes it, clean, conflicted and with several -m", async () => {
    const t = twins();
    run(t.native, "merge", "-q", "--no-commit", "--no-ff", "-m", "Merge it", "side");
    await (await open(t.ours))
      .merge()
      .include("side")
      .setCommit(false)
      .setFastForwardMode(FastForwardMode.NO_FF)
      .setMessage("Merge it")
      .call();
    expectSame(t);
    for (const repo of [t.native, t.ours]) run(repo, "merge", "--abort");
    // a message ending in a newline, then two -m paragraphs
    run(t.native, "merge", "-q", "--no-commit", "--no-ff", "-m", "Ends\n", "side");
    await (await open(t.ours))
      .merge()
      .include("side")
      .setCommit(false)
      .setFastForwardMode(FastForwardMode.NO_FF)
      .setMessage("Ends\n")
      .call();
    expectSame(t);
    for (const repo of [t.native, t.ours]) run(repo, "merge", "--abort");
    run(t.native, "merge", "-q", "--no-commit", "--no-ff", "-m", "One", "-m", "Two", "side");
    await (await open(t.ours))
      .merge()
      .include("side")
      .setCommit(false)
      .setFastForwardMode(FastForwardMode.NO_FF)
      .addMessage("One")
      .addMessage("Two")
      .call();
    expectSame(t);
    for (const repo of [t.native, t.ours]) run(repo, "merge", "--abort");
    // conflicted: the conflicts hint after the message
    both(t, (repo) => {
      put(repo, "a.txt", "M\n2\n3\n");
      run(repo, "commit", "-qam", "main a");
    });
    attempt(t.native, "merge", "--no-commit", "-m", "Conflicted", "feat");
    await (await open(t.ours))
      .merge()
      .include("feat")
      .setCommit(false)
      .setMessage("Conflicted")
      .call();
    expectSame(t);
  });

  it("several -m: commit, merge and tag join paragraphs with a blank line", async () => {
    const t = twins();
    both(t, (repo) => put(repo, "a.txt", "1\n2\n3\n4\n"));
    run(t.native, "commit", "-qam", "Subject", "-m", "Body\n", "-m", "Tail");
    const git = await open(t.ours);
    await git.add().addFilepattern("a.txt").call();
    await git.commit().addMessage("Subject").addMessage("Body\n").addMessage("Tail").call();
    expectSame(t);
    run(t.native, "merge", "-q", "--no-ff", "-m", "Merge side", "-m", "Second paragraph", "side");
    await (await open(t.ours))
      .merge()
      .include("side")
      .setFastForwardMode(FastForwardMode.NO_FF)
      .addMessage("Merge side")
      .addMessage("Second paragraph")
      .call();
    expectSame(t);
    run(t.native, "tag", "-m", "Release", "-m", "Notes", "-m", "", "rel");
    await (await open(t.ours))
      .tag()
      .setName("rel")
      .addMessage("Release")
      .addMessage("Notes")
      .addMessage("")
      .call();
    expectSame(t);
    expect(run(t.ours, "cat-file", "tag", "rel")).toBe(run(t.native, "cat-file", "tag", "rel"));
  });

  it("switch --discard-changes overwrites ignored files in the way, refuses untracked ones", async () => {
    const t = twins();
    both(t, (repo) => {
      put(repo, "b.txt", "local b\n");
      put(repo, "d.txt.log", "x\n");
      put(repo, "d.txt", "untracked d\n");
    });
    const msg = await refusal(async () => {
      const r = await (await open(t.ours)).switch().setName("feat").setDiscardChanges(true).call();
      if (r.status !== CheckoutStatus.OK) throw new Error(r.message);
    });
    const n = attempt(t.native, "switch", "--discard-changes", "feat");
    expect(n.status).not.toBe(0);
    expect(n.stderr).toContain(msg);
    expectSame(t);
    // ignored in the way: overwritten (git's preserve_ignored is off unless --no-overwrite-ignore)
    both(t, (repo) => {
      rmSync(join(repo, "d.txt"));
      put(repo, ".git/info/exclude", "d.txt\n");
      put(repo, "d.txt", "ignored d\n");
    });
    run(t.native, "switch", "-q", "--discard-changes", "feat");
    const r = await (await open(t.ours)).switch().setName("feat").setDiscardChanges(true).call();
    expect(r.status).toBe(CheckoutStatus.OK);
    expectSame(t);
  });

  itAutostash(
    "checkout -m: a failure after the autostash keeps the changes (directory in place of a file)",
    async () => {
      const t = twins();
      both(t, (repo) => {
        rmSync(join(repo, "b.txt"));
        put(repo, "b.txt/x", "in a directory\n");
        put(repo, "a.txt", "L\n2\n3\n");
      });
      const n = attempt(t.native, "checkout", "-m", "feat");
      expect(n.status).toBe(0);
      const result = await (await open(t.ours)).checkout().setName("feat").setMerge(true).call();
      expect(result.status).toBe(CheckoutStatus.CONFLICTS);
      expect(result.conflicts).toEqual(["a.txt"]);
      expect(n.stderr).toContain(result.message ?? "<none>");
      expectSame(t);
      expect(run(t.ours, "stash", "list")).toBe(run(t.native, "stash", "list"));
    },
  );

  itAutostash("checkout -m from a detached HEAD: the base label is core.abbrev long", async () => {
    const t = twins();
    both(t, (repo) => {
      run(repo, "config", "merge.conflictStyle", "diff3");
      run(repo, "config", "core.abbrev", "12");
      run(repo, "checkout", "-q", "--detach", "main");
      put(repo, "a.txt", "L\n2\n3\n");
    });
    expect(attempt(t.native, "checkout", "-m", "feat").status).toBe(0);
    await (await open(t.ours)).checkout().setName("feat").setMerge(true).call();
    const main = run(t.ours, "rev-parse", "main").trim();
    expect(readFileSync(join(t.ours, "a.txt"), "latin1")).toContain(
      `||||||| ${main.slice(0, 12)}\n`,
    );
    expectSame(t);
  });

  it("checkout -m with -f is refused as git refuses it", async () => {
    const t = twins();
    const git = await open(t.ours);
    expect(
      await refusal(() => git.checkout().setName("feat").setMerge(true).setForced(true).call()),
    ).toBe(nativeRefusal(t.native, "checkout", "-m", "-f", "feat"));
    expectSame(t);
  });

  it("checkout -b <existing> <bad start>: the start point is refused first", async () => {
    const t = twins();
    const git = await open(t.ours);
    for (const branch of ["feat", "fresh"]) {
      expect(
        await refusal(() =>
          git.checkout().setCreateBranch(true).setName(branch).setStartPoint("nope").call(),
        ),
      ).toBe(nativeRefusal(t.native, "checkout", "-b", branch, "nope"));
    }
    // a tree as start point: the existing branch first, then the non-commit
    expect(
      await refusal(() =>
        git.checkout().setCreateBranch(true).setName("feat").setStartPoint("HEAD^{tree}").call(),
      ),
    ).toBe(nativeRefusal(t.native, "checkout", "-b", "feat", "HEAD^{tree}"));
    expect(
      await refusal(() =>
        git.checkout().setCreateBranch(true).setName("fresh").setStartPoint("HEAD^{tree}").call(),
      ),
    ).toBe(nativeRefusal(t.native, "checkout", "-b", "fresh", "HEAD^{tree}"));
    expectSame(t);
  });

  it('several -m: an empty first -m adds no blank line (-m "" -m b)', async () => {
    const t = twins();
    both(t, (repo) => put(repo, "a.txt", "1\n2\n3\n5\n"));
    run(t.native, "commit", "-qam", "", "-m", "Second");
    const git = await open(t.ours);
    await git.add().addFilepattern("a.txt").call();
    await git.commit().addMessage("").addMessage("Second").call();
    expectSame(t);
    run(t.native, "merge", "-q", "--no-ff", "-m", "", "-m", "Merged", "side");
    await (await open(t.ours))
      .merge()
      .include("side")
      .setFastForwardMode(FastForwardMode.NO_FF)
      .addMessage("")
      .addMessage("Merged")
      .call();
    expectSame(t);
    run(t.native, "tag", "-m", "", "-m", "Tagged", "rel");
    await (await open(t.ours)).tag().setName("rel").addMessage("").addMessage("Tagged").call();
    expectSame(t);
    expect(run(t.ours, "cat-file", "tag", "rel")).toBe(run(t.native, "cat-file", "tag", "rel"));
    expect(run(t.ours, "log", "--format=%B", "-2")).toBe(run(t.native, "log", "--format=%B", "-2"));
  });
});
