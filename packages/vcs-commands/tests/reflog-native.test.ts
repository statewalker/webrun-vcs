/**
 * The reflog lines our porcelain writes, against native git's: every repository is built
 * twice by native git with fixed dates (same ids), one twin changed by native git, the other
 * by our commands, then every reflog (`.git/logs/**`, a linked worktree's
 * `.git/worktrees/<id>/logs/HEAD`) compared byte for byte.
 *
 * Our side gets git's committer variables through the host environment
 * (`GitHostEnvironment.committer`), the same as native git's `GIT_COMMITTER_*`.
 *
 * Version notes (the sandbox runs git 2.43, CI 2.5x): the messages compared here are the same
 * in both; `branch -m` of the checked-out branch logs HEAD twice in both (the old branch's
 * delete, then HEAD repointed).
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
import type { PersonIdent } from "@statewalker/vcs-core";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  Git,
  MergeOperation,
  MergeStatus,
  RebaseOperation,
  RebaseStatus,
  ResetMode,
  SequencerOperation,
} from "../src/index.js";
import {
  type NativeGitHttpBackend,
  nativeGitAvailable,
  nativeGitEnv,
  nativeGitHttpBackend,
} from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** The identity nativeGitEnv gives native git (author and committer). */
const IDENT: PersonIdent = {
  name: "Interop Tester",
  email: "interop@example.com",
  timestamp: 1112911993,
  tzOffset: "+0000",
};

let root = "";
let home = "";
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(home),
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });
/** Native git that may fail (a conflicting merge or rebase). */
const runMayFail = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, env: nativeGitEnv(home), encoding: "latin1" }).status;
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/**
 * The repository both twins start from: main (c1, c2), `feat` (c1, f1), `x` (c1, x1, x2),
 * `behind` (c1), `conf` (c1, a change of a.txt that conflicts with c2's).
 */
function build(base: string, empty = false): string {
  mkdirSync(base, { recursive: true });
  const repo = join(base, "repo");
  run(base, "init", "-q", "-b", "main", "repo");
  if (empty) return repo;
  put(repo, "a.txt", "a\n");
  run(repo, "add", ".");
  run(repo, "commit", "-qm", "c1");
  run(repo, "branch", "feat");
  run(repo, "branch", "x");
  run(repo, "branch", "behind");
  run(repo, "branch", "conf");
  put(repo, "a.txt", "a\nmore\n");
  run(repo, "commit", "-qam", "c2");
  run(repo, "checkout", "-q", "feat");
  put(repo, "f.txt", "f\n");
  run(repo, "add", ".");
  run(repo, "commit", "-qm", "f1");
  run(repo, "checkout", "-q", "x");
  put(repo, "x.txt", "x1\n");
  run(repo, "add", ".");
  run(repo, "commit", "-qm", "x1");
  put(repo, "x.txt", "x1\nx2\n");
  run(repo, "commit", "-qam", "x2\n\nwith a body");
  run(repo, "checkout", "-q", "conf");
  put(repo, "a.txt", "a\nother\n");
  run(repo, "commit", "-qam", "conflicting");
  run(repo, "checkout", "-q", "main");
  return repo;
}

let counter = 0;
/** The same repository built twice: `native` and `ours` (the bases holding `repo`). */
function twins(empty = false): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `t${n}-native`);
  const ours = join(root, `t${n}-ours`);
  build(native, empty);
  build(ours, empty);
  return { native, ours };
}

/** git's committer variables, as a Node host reads them from the environment. */
const environment = {
  readFile: async () => undefined,
  committer: { name: IDENT.name, email: IDENT.email, date: "1112911993 +0000" },
};

/** Our Git on the worktree whose git directory is `gitDir` (relative to `base`). */
async function open(base: string, gitDir = "repo/.git"): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: base });
  const { history } = await createGitFilesBackend({ files, gitDir: "repo/.git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir, history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** Every reflog under `gitDir` (its `logs/`, and its worktrees' `logs/`), `base` as `<base>`. */
function reflogs(gitDir: string, base: string, url?: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    const at = join(gitDir, rel);
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (path.includes("logs/")) {
        let text = readFileSync(join(gitDir, path), "latin1").split(base).join("<base>");
        if (url) text = text.replace(url, "<url>");
        out[path] = text;
      }
    }
  };
  walk("logs");
  walk("worktrees");
  return out;
}

/** The two twins' reflogs, which must be equal. */
function expectSameReflogs(t: { native: string; ours: string }): void {
  const native = reflogs(join(t.native, "repo/.git"), t.native);
  const ours = reflogs(join(t.ours, "repo/.git"), t.ours);
  expect(Object.keys(ours).sort()).toEqual(Object.keys(native).sort());
  for (const name of Object.keys(native)) expect([name, ours[name]]).toEqual([name, native[name]]);
}

const messages = (base: string, log: string) =>
  readFileSync(join(base, "repo/.git", log), "latin1")
    .trim()
    .split("\n")
    .map((line) => line.slice(line.indexOf("\t") + 1));

describeGit("reflog lines, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "reflog-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("commit: initial, plain, amend; the subject is the first line", async () => {
    const t = twins(true);
    const steps: [string, string][] = [
      ["first line\nsecond line\n\nbody\n", "a\n"],
      ["second\n", "a\nb\n"],
    ];
    const git = await open(t.ours);
    for (const [message, content] of steps) {
      put(join(t.native, "repo"), "a.txt", content);
      run(join(t.native, "repo"), "add", "a.txt");
      run(join(t.native, "repo"), "commit", "-q", "-m", message);
      put(join(t.ours, "repo"), "a.txt", content);
      await git.add().addFilepattern("a.txt").call();
      await git.commit().setMessage(message).setAuthorIdent(IDENT).setCommitterIdent(IDENT).call();
    }
    run(join(t.native, "repo"), "commit", "-q", "--amend", "-m", "amended");
    await git
      .commit()
      .setAmend(true)
      .setMessage("amended\n")
      .setAuthorIdent(IDENT)
      .setCommitterIdent(IDENT)
      .call();
    expectSameReflogs(t);
    expect(messages(t.ours, "logs/HEAD")).toEqual([
      "commit (initial): first line",
      "commit: second",
      "commit (amend): amended",
    ]);
  });

  it("checkout and switch: branches, a detached HEAD, -b with and without a start point", async () => {
    const t = twins();
    const nat = join(t.native, "repo");
    const c1 = run(nat, "rev-parse", "main~1").trim();
    run(nat, "checkout", "-q", "feat");
    run(nat, "switch", "-q", "main");
    run(nat, "checkout", "-q", c1);
    run(nat, "checkout", "-q", "main");
    run(nat, "checkout", "-q", "main");
    run(nat, "checkout", "-q", "-b", "nb");
    run(nat, "switch", "-q", "-c", "nb2", "feat");
    run(nat, "checkout", "-q", "-B", "nb", "behind");

    const git = await open(t.ours);
    await git.checkout().setName("feat").call();
    await git.checkout().setName("main").call();
    await git.checkout().setName(c1).call();
    await git.checkout().setName("main").call();
    await git.checkout().setName("main").call();
    await git.checkout().setCreateBranch(true).setName("nb").call();
    await git.checkout().setCreateBranch(true).setName("nb2").setStartPoint("feat").call();
    await git.checkout().setCreateBranch(true).setName("nb").setStartPoint("behind").call();
    expectSameReflogs(t);
    expect(messages(t.ours, "logs/HEAD").slice(-8)).toEqual([
      "checkout: moving from main to feat",
      "checkout: moving from feat to main",
      `checkout: moving from main to ${c1}`,
      `checkout: moving from ${c1} to main`,
      "checkout: moving from main to main",
      "checkout: moving from main to nb",
      "checkout: moving from nb to nb2",
      "checkout: moving from nb2 to nb",
    ]);
    expect(messages(t.ours, "logs/refs/heads/nb")).toEqual([
      "branch: Created from HEAD",
      "branch: Reset to behind",
    ]);
  });

  it("reset: --hard HEAD~1, --soft <branch>, a reset that leaves HEAD where it is", async () => {
    const t = twins();
    const nat = join(t.native, "repo");
    run(nat, "reset", "-q", "--hard", "HEAD~1");
    run(nat, "reset", "-q", "--soft", "feat");
    run(nat, "reset", "-q");
    const git = await open(t.ours);
    await git.reset().setRef("HEAD~1").setMode(ResetMode.HARD).call();
    await git.reset().setRef("feat").setMode(ResetMode.SOFT).call();
    await git.reset().call();
    expectSameReflogs(t);
    expect(messages(t.ours, "logs/HEAD").slice(-3)).toEqual([
      "reset: moving to HEAD~1",
      "reset: moving to feat",
      "reset: moving to HEAD",
    ]);
  });

  it("merge: a merge commit, a fast-forward, a conflict concluded by --continue", async () => {
    const t = twins();
    const nat = join(t.native, "repo");
    run(nat, "merge", "-q", "--no-edit", "feat");
    run(nat, "checkout", "-q", "feat");
    run(nat, "merge", "-q", "main");
    run(nat, "checkout", "-q", "main");
    expect(runMayFail(nat, "merge", "-q", "conf")).not.toBe(0);
    put(nat, "a.txt", "resolved\n");
    run(nat, "add", "a.txt");
    // (-m: `--no-edit` keeps MERGE_MSG's conflict comments, which our --continue drops)
    run(nat, "commit", "-q", "-m", "Merge branch 'conf'");

    const git = await open(t.ours);
    const merge = () => git.merge().setAuthor(IDENT).setCommitter(IDENT);
    expect((await merge().include("feat").call()).status).toBe(MergeStatus.MERGED);
    await git.checkout().setName("feat").call();
    expect((await merge().include("main").call()).status).toBe(MergeStatus.FAST_FORWARD);
    await git.checkout().setName("main").call();
    expect((await merge().include("conf").call()).status).toBe(MergeStatus.CONFLICTING);
    put(join(t.ours, "repo"), "a.txt", "resolved\n");
    await git.add().addFilepattern("a.txt").call();
    await merge().setOperation(MergeOperation.CONTINUE).setMessage("Merge branch 'conf'").call();
    expectSameReflogs(t);
    expect(messages(t.ours, "logs/refs/heads/main").slice(-2)).toEqual([
      "merge feat: Merge made by the 'ort' strategy.",
      "commit (merge): Merge branch 'conf'",
    ]);
    expect(messages(t.ours, "logs/refs/heads/feat").at(-1)).toBe("merge main: Fast-forward");
  });

  it("rebase: picks, a fast-forward, an abort", async () => {
    const t = twins();
    const nat = join(t.native, "repo");
    for (const [branch, ok] of [
      ["x", true],
      ["behind", true],
      ["conf", false],
    ] as const) {
      run(nat, "checkout", "-q", branch);
      expect(runMayFail(nat, "rebase", "main") === 0).toBe(ok);
    }
    run(nat, "rebase", "--abort");

    const git = await open(t.ours);
    for (const [branch, status] of [
      ["x", RebaseStatus.OK],
      ["behind", RebaseStatus.FAST_FORWARD],
      ["conf", RebaseStatus.STOPPED],
    ] as const) {
      await git.checkout().setName(branch).call();
      const rebase = await git.rebase().setCommitter(IDENT).setUpstreamBranch("main");
      expect((await rebase.call()).status).toBe(status);
    }
    await git.rebase().setOperation(RebaseOperation.ABORT).call();
    expectSameReflogs(t);
    const main = run(nat, "rev-parse", "main").trim();
    expect(messages(t.ours, "logs/refs/heads/x").at(-1)).toBe(
      `rebase (finish): refs/heads/x onto ${main}`,
    );
    expect(messages(t.ours, "logs/HEAD").slice(-11)).toEqual([
      "checkout: moving from main to x",
      "rebase (start): checkout main",
      "rebase (pick): x1",
      "rebase (pick): x2",
      "rebase (finish): returning to refs/heads/x",
      "checkout: moving from x to behind",
      "rebase (start): checkout main",
      "rebase (finish): returning to refs/heads/behind",
      "checkout: moving from behind to conf",
      "rebase (start): checkout main",
      "rebase (abort): returning to refs/heads/conf",
    ]);
  });

  it("cherry-pick and revert", async () => {
    const t = twins();
    const nat = join(t.native, "repo");
    run(nat, "cherry-pick", "feat");
    run(nat, "revert", "--no-edit", "HEAD");
    const git = await open(t.ours);
    await git.cherryPick().include("feat").setCommitter(IDENT).call();
    await git.revert().include("HEAD").setCommitter(IDENT).call();
    expectSameReflogs(t);
    expect(messages(t.ours, "logs/refs/heads/main").slice(-2)).toEqual([
      "cherry-pick: f1",
      'revert: Revert "f1"',
    ]);
  });

  it("a conflict concluded: cherry-pick --continue, rebase --continue", async () => {
    const t = twins();
    const nat = join(t.native, "repo");
    expect(runMayFail(nat, "cherry-pick", "conf")).not.toBe(0);
    put(nat, "a.txt", "resolved\n");
    run(nat, "add", "a.txt");
    run(nat, "-c", "core.editor=true", "cherry-pick", "--continue");
    run(nat, "checkout", "-q", "conf");
    expect(runMayFail(nat, "rebase", "main")).not.toBe(0);
    put(nat, "a.txt", "resolved again\n");
    run(nat, "add", "a.txt");
    run(nat, "-c", "core.editor=true", "rebase", "--continue");

    const git = await open(t.ours);
    const ours = join(t.ours, "repo");
    await git.cherryPick().include("conf").setCommitter(IDENT).call();
    put(ours, "a.txt", "resolved\n");
    await git.add().addFilepattern("a.txt").call();
    await git.cherryPick().setOperation(SequencerOperation.CONTINUE).setCommitter(IDENT).call();
    await git.checkout().setName("conf").call();
    const rebase = await git.rebase().setCommitter(IDENT).setUpstreamBranch("main");
    expect((await rebase.call()).status).toBe(RebaseStatus.STOPPED);
    put(ours, "a.txt", "resolved again\n");
    await git.add().addFilepattern("a.txt").call();
    await git.rebase().setOperation(RebaseOperation.CONTINUE).setCommitter(IDENT).call();
    expectSameReflogs(t);
    expect(messages(t.ours, "logs/HEAD").slice(-5)).toEqual([
      "commit (cherry-pick): conflicting",
      "checkout: moving from main to conf",
      "rebase (start): checkout main",
      "rebase (continue): conflicting",
      "rebase (finish): returning to refs/heads/conf",
    ]);
  });

  it("branch: create, -f, rename (also the checked-out one); tag writes no reflog", async () => {
    const t = twins();
    const nat = join(t.native, "repo");
    run(nat, "branch", "b1");
    run(nat, "branch", "b2", "feat");
    run(nat, "branch", "-f", "b2", "main");
    run(nat, "branch", "-m", "b1", "b1r");
    run(nat, "branch", "-m", "trunk");
    run(nat, "tag", "t1");
    run(nat, "tag", "-a", "-m", "annotated", "t2");
    const git = await open(t.ours);
    await git.branchCreate().setName("b1").call();
    await git.branchCreate().setName("b2").setStartPoint("feat").call();
    await git.branchCreate().setName("b2").setStartPoint("main").setForce(true).call();
    await git.branchRename().setOldName("b1").setNewName("b1r").call();
    await git.branchRename().setNewName("trunk").call();
    await git.tag().setName("t1").call();
    await git.tag().setName("t2").setMessage("annotated").setTaggerIdent(IDENT).call();
    expectSameReflogs(t);
    expect(messages(t.ours, "logs/refs/heads/b2")).toEqual([
      "branch: Created from feat",
      "branch: Reset to main",
    ]);
    expect(messages(t.ours, "logs/HEAD").slice(-2)).toEqual([
      "Branch: renamed refs/heads/main to refs/heads/trunk",
      "Branch: renamed refs/heads/main to refs/heads/trunk",
    ]);
    expect(existsSync(join(t.ours, "repo/.git/logs/refs/tags"))).toBe(false);
  });

  it("stash: refs/stash and the reset HEAD's reflog records", async () => {
    const t = twins();
    const nat = join(t.native, "repo");
    put(nat, "a.txt", "changed\n");
    run(nat, "stash", "-q");
    put(nat, "a.txt", "changed again\n");
    run(nat, "stash", "push", "-q", "-m", "my message");
    const git = await open(t.ours);
    put(join(t.ours, "repo"), "a.txt", "changed\n");
    await git.stashCreate().setAuthor(IDENT).call();
    put(join(t.ours, "repo"), "a.txt", "changed again\n");
    await git.stashCreate().setAuthor(IDENT).setMessage("my message").call();
    expectSameReflogs(t);
    expect(
      messages(t.ours, "logs/refs/stash").map((m) => m.replace(/ [0-9a-f]{7} /, " <id> ")),
    ).toEqual(["WIP on main: <id> c2", "On main: my message"]);
    expect(messages(t.ours, "logs/HEAD").slice(-2)).toEqual([
      "reset: moving to HEAD",
      "reset: moving to HEAD",
    ]);
  });

  it("a linked worktree: commit, checkout, reset logged in its own HEAD reflog", async () => {
    const t = twins();
    for (const base of [t.native, t.ours])
      run(join(base, "repo"), "worktree", "add", "-q", "../wt", "-b", "wb");
    const wt = join(t.native, "wt");
    put(wt, "w.txt", "w\n");
    run(wt, "add", "w.txt");
    run(wt, "commit", "-q", "-m", "in wt");
    run(wt, "checkout", "-q", "feat");
    run(wt, "reset", "-q", "--hard", "HEAD~1");
    run(wt, "checkout", "-q", "wb");
    run(wt, "merge", "-q", "--no-edit", "x");

    const git = await open(t.ours, "repo/.git/worktrees/wt");
    put(join(t.ours, "wt"), "w.txt", "w\n");
    await git.add().addFilepattern("w.txt").call();
    await git.commit().setMessage("in wt\n").setAuthorIdent(IDENT).setCommitterIdent(IDENT).call();
    await git.checkout().setName("feat").call();
    await git.reset().setRef("HEAD~1").setMode(ResetMode.HARD).call();
    await git.checkout().setName("wb").call();
    await git.merge().include("x").setAuthor(IDENT).setCommitter(IDENT).call();
    expectSameReflogs(t);
    // (`worktree add` logs its HEAD without a message, then its `reset --hard`)
    expect(messages(t.ours, "worktrees/wt/logs/HEAD").slice(2)).toEqual([
      "commit: in wt",
      "checkout: moving from wb to feat",
      "reset: moving to HEAD~1",
      "checkout: moving from feat to wb",
      "merge x: Merge made by the 'ort' strategy.",
    ]);
  });
});

const URL = "http://git.test/src.git";

describeGit("reflog lines of clone, fetch and pull, native twins", () => {
  let backend: NativeGitHttpBackend;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reflog-net-"));
    home = join(root, "home");
    mkdirSync(home);
    backend = nativeGitHttpBackend(root, home);
    globalThis.fetch = backend.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    backend?.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** The upstream `work`, published as the bare `src.git`. */
  function upstream(): { work: string; src: string } {
    const work = join(root, "work");
    const src = join(root, "src.git");
    run(root, "init", "-q", "-b", "main", work);
    put(work, "a.txt", "a\n");
    run(work, "add", ".");
    run(work, "commit", "-qm", "base");
    run(work, "branch", "dev");
    run(root, "clone", "-q", "--bare", work, src);
    return { work, src };
  }
  const publish = (work: string, src: string, ...refs: string[]) =>
    run(work, "push", "-q", "--force", src, ...refs);
  const commitIn = (work: string, message: string) =>
    run(work, "commit", "-q", "--allow-empty", "-m", message);

  /** Both reflog sets with the clone's URL (a path for native git, ours over HTTP) evened out. */
  function expectSame(native: string, ours: string, src: string): void {
    const url = new RegExp(
      `(${src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${URL.replace(/\./g, "\\.")})`,
      "g",
    );
    const n = reflogs(join(native, ".git"), native, url);
    const o = reflogs(join(ours, ".git"), ours, url);
    expect(Object.keys(o).sort()).toEqual(Object.keys(n).sort());
    for (const name of Object.keys(n)) expect([name, o[name]]).toEqual([name, n[name]]);
  }

  async function openPlain(dir: string): Promise<Git> {
    const files = createNodeFilesApi({ rootDir: dir });
    const { history } = await createGitFilesBackend({ files });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
    return Git.fromWorkingCopy(await worktrees.openCurrent());
  }

  it("clone: HEAD, the branch and refs/remotes/origin/HEAD; then fetch with new, fast-forward and forced refs", async () => {
    const { work, src } = upstream();
    const native = join(root, "native");
    const ours = join(root, "ours");
    run(root, "clone", "-q", src, native);
    run(root, "init", "-q", "-b", "main", ours);
    await (await openPlain(ours)).clone().setURI(URL).call();
    expectSame(native, ours, src);
    expect(readFileSync(join(ours, ".git/logs/HEAD"), "latin1")).toContain(
      `\tclone: from ${URL}\n`,
    );

    commitIn(work, "upstream 1");
    run(work, "checkout", "-q", "-b", "nb");
    commitIn(work, "new branch");
    run(work, "checkout", "-q", "main");
    publish(work, src, "main", "nb");
    run(native, "fetch", "origin");
    await (await openPlain(ours)).fetch().setRemote("origin").call();
    expectSame(native, ours, src);

    run(work, "checkout", "-q", "nb");
    run(work, "reset", "-q", "--hard", "HEAD~1");
    commitIn(work, "rewritten");
    run(work, "checkout", "-q", "main");
    publish(work, src, "nb");
    run(native, "fetch", "origin");
    await (await openPlain(ours)).fetch().setRemote("origin").call();
    expectSame(native, ours, src);
    const nb = readFileSync(join(ours, ".git/logs/refs/remotes/origin/nb"), "latin1");
    expect(nb.split("\n").map((l) => l.slice(l.indexOf("\t") + 1))).toEqual([
      "fetch origin: storing head",
      "fetch origin: forced-update",
      "",
    ]);
  });

  it("pull: a fast-forward, and pull --rebase that fast-forwards", async () => {
    const { work, src } = upstream();
    const native = join(root, "native");
    const ours = join(root, "ours");
    run(root, "clone", "-q", src, native);
    run(root, "clone", "-q", src, ours);
    run(ours, "config", "remote.origin.url", URL);

    commitIn(work, "upstream 1");
    publish(work, src, "main");
    run(native, "-c", "pull.rebase=false", "pull");
    await (await openPlain(ours)).pull().call();
    commitIn(work, "upstream 2");
    publish(work, src, "main");
    run(native, "pull", "--rebase");
    await (await openPlain(ours)).pull().setRebase(true).call();
    expectSame(native, ours, src);
    const head = readFileSync(join(ours, ".git/logs/HEAD"), "latin1").trim().split("\n");
    expect(head.slice(-2).map((l) => l.slice(l.indexOf("\t") + 1))).toEqual([
      "pull: Fast-forward",
      "pull --rebase: Fast-forward",
    ]);
  });
});
