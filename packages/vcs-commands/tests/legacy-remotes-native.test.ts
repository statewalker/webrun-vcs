/**
 * git 2.x's legacy remotes: a remote missing from the configuration read from
 * `.git/remotes/<name>` (`URL:`, `Pull:`, `Push:` lines) or `.git/branches/<name>`
 * (`<url>[#<branch>]`), as remote.c's `read_remotes_file` / `read_branches_file`, and
 * `git remote rename <name> <name>` migrating one into the configuration (builtin/remote.c
 * `migrate_file`). Each twin runs native git (2.43 in the sandbox, 2.5x on CI) beside ours
 * and compares refs, FETCH_HEAD, the configuration and git's deprecation warning (2.5x only).
 * The git 3.0 oracle (`$GIT3`) reads neither file; ours with `breakingChanges` neither.
 *
 * Scenarios after git's t5505-remote ("migrate a remote from named file in
 * $GIT_DIR/remotes", "... $GIT_DIR/branches", "... (2)"), t5510-fetch ("fetch with
 * branches", "fetch with branches containing #") and t5516-fetch-push ("push with
 * branches", "push with branches containing #").
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, GitApiError } from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { git3Binary, nativeGit3Env } from "./native-git3.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

const DATES = {
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};

/** Our working copy over `<root>/<name>`, ours a 2.43 or 2.5x as the native git is. */
async function ours(name: string, extra: Record<string, string> = {}): Promise<Git> {
  const env = testEnv(root, { ...DATES, ...extra });
  return openOurs(
    root,
    createNodeGitHostEnvironment({
      env,
      hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
    }),
    undefined,
    name,
  );
}

/** Two repositories `n<k>` (native) and `o<k>` (ours), each made by `make(dir)`. */
function twins(make: (dir: string) => void): [string, string] {
  const names: [string, string] = [`n${counter}`, `o${counter}`];
  counter++;
  for (const name of names) make(join(root, name));
  return names;
}

/** An empty repository on main. */
const empty = (dir: string) => {
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
};

/** A file of the git directory. */
const gitFile = (repo: string, path: string, content: string) =>
  putFile(join(root, repo, ".git"), path, content);

const refs = (dir: string) =>
  git(join(root, dir), "for-each-ref", "--format=%(refname) %(objectname)");

/** FETCH_HEAD with the twin's own name taken out of the URLs. */
const fetchHead = (dir: string) => {
  const path = join(root, dir, ".git", "FETCH_HEAD");
  return existsSync(path) ? readFileSync(path, "latin1") : "";
};

/** git's stderr lines that are the legacy-remote warning (2.5x) or the default-branch hint. */
function legacyLines(stderr: string): string {
  const out: string[] = [];
  const lines = stderr.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("warning: reading remote from")) {
      out.push(...lines.slice(i, i + 9));
      i += 8;
    } else if (line.startsWith("hint:")) out.push(line);
  }
  return out.join("\n");
}

async function failure(run: () => Promise<unknown>): Promise<GitApiError | undefined> {
  try {
    await run();
    return undefined;
  } catch (e) {
    return e as GitApiError;
  }
}

describeGit("legacy remotes (.git/remotes/, .git/branches/), as native git 2.x", () => {
  let first = "";
  let second = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "legacy-remotes-"));
    const up = join(root, "up");
    mkdirSync(up);
    git(up, "init", "-q", "-b", "main");
    putFile(up, "a.txt", "a\n");
    gitOut(root, up, ["add", "a.txt"]);
    gitOut(root, up, ["commit", "-qm", "one"], DATES);
    first = git(up, "rev-parse", "HEAD").trim();
    gitOut(root, up, ["tag", "-a", "-m", "v1", "v1"], DATES);
    git(up, "branch", "second");
    git(up, "branch", "master");
    putFile(up, "b.txt", "b\n");
    gitOut(root, up, ["add", "b.txt"]);
    gitOut(root, up, ["commit", "-qm", "two"], DATES);
    second = git(up, "rev-parse", "HEAD").trim();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Native `git fetch <args>` and ours, compared by refs, FETCH_HEAD and warnings. */
  async function expectSameFetch(n: string, o: string, remote: string, refspecs: string[] = []) {
    const native = gitRun(root, join(root, n), ["fetch", remote, ...refspecs]);
    expect(native.status, native.stderr).toBe(0);
    const g = await ours(o);
    const result = await g
      .fetch()
      .setRemote(remote)
      .setRefSpecs(...refspecs)
      .call();
    expect(refs(o)).toBe(refs(n));
    expect(fetchHead(o).split(o).join("<r>")).toBe(fetchHead(n).split(n).join("<r>"));
    expect(legacyLines(result.messages.join("\n"))).toBe(legacyLines(native.stderr));
    return native;
  }

  it("fetches through a remotes file (URL:, Pull: lines; tags follow)", async () => {
    const [n, o] = twins(empty);
    for (const d of [n, o]) {
      gitFile(
        d,
        "remotes/rem",
        "URL: ../up\nPull: refs/heads/main:refs/heads/origin\nPull:  refs/heads/second:refs/heads/second  \n",
      );
    }
    const native = await expectSameFetch(n, o, "rem");
    expect(native.stderr.includes("nominated for removal")).toBe(nativeIs25x);
    expect(refs(o)).toContain(`refs/heads/origin ${second}`);
  });

  it("t5510: fetch with branches (no #: init.defaultBranch, else master with the hint)", async () => {
    const [n, o] = twins(empty);
    for (const d of [n, o]) gitFile(d, "branches/branch1", "../up\n");
    await expectSameFetch(n, o, "branch1");
    expect(refs(o)).toContain(`refs/heads/branch1 ${first}`);

    const [n2, o2] = twins(empty);
    for (const d of [n2, o2]) {
      gitFile(d, "branches/branch1", "../up\n");
      git(join(root, d), "config", "init.defaultBranch", "main");
    }
    await expectSameFetch(n2, o2, "branch1");
    expect(refs(o2)).toContain(`refs/heads/branch1 ${second}`);
  });

  it("t5510: fetch with branches containing #, and tags follow a refspec without destination", async () => {
    const [n, o] = twins(empty);
    for (const d of [n, o]) gitFile(d, "branches/branch2", "  ../up#second \n");
    await expectSameFetch(n, o, "branch2");
    expect(refs(o)).toContain(`refs/heads/branch2 ${first}`);

    // remote.c: a branches remote always auto-follows tags (fetch_tags = 1)
    const [n2, o2] = twins(empty);
    for (const d of [n2, o2]) gitFile(d, "branches/branch2", "../up#second\n");
    await expectSameFetch(n2, o2, "branch2", ["main"]);
    expect(refs(o2)).toContain("refs/tags/v1");
  });

  it("adds a remotes file to a configuration without URL; a configured URL wins", async () => {
    const [n, o] = twins(empty);
    for (const d of [n, o]) {
      git(join(root, d), "config", "remote.rem.fetch", "refs/heads/second:refs/heads/from-config");
      gitFile(d, "remotes/rem", "URL: ../up\nPull: refs/heads/main:refs/heads/from-file\n");
    }
    await expectSameFetch(n, o, "rem");
    expect(refs(o)).toContain("refs/heads/from-config");
    expect(refs(o)).toContain("refs/heads/from-file");

    const [n2, o2] = twins(empty);
    for (const d of [n2, o2]) {
      git(join(root, d), "config", "remote.rem.url", "../up");
      git(join(root, d), "config", "remote.rem.fetch", "refs/heads/main:refs/heads/configured");
      gitFile(d, "remotes/rem", "URL: ../nowhere\nPull: refs/heads/main:refs/heads/from-file\n");
    }
    await expectSameFetch(n2, o2, "rem");
    expect(refs(o2)).not.toContain("from-file");
  });

  it("t5516: push with branches (HEAD to #branch, else master) and a remotes file's Push:", async () => {
    for (const [file, branch] of [
      ["../nb#second", "second"],
      ["../nb", "master"],
    ] as const) {
      const [n, o] = twins((dir) => {
        git(root, "clone", "-q", "--no-local", join(root, "up"), dir);
        git(dir, "reset", "-q", "--hard", first);
        git(root, "clone", "-q", "--bare", "--no-local", join(root, "up"), `${dir}-bare`);
      });
      for (const d of [n, o]) {
        gitFile(d, "branches/pb", `${file.replace("nb", `${d}-bare`)}\n`);
        putFile(join(root, d), "c.txt", `${d}\n`.replace(/^[no]/, "x"));
        git(join(root, d), "add", "c.txt");
        gitOut(root, join(root, d), ["commit", "-qm", "three"], DATES);
      }
      const native = gitRun(root, join(root, n), ["push", "pb"]);
      const g = await ours(o);
      const result = await failure(() => g.push().setRemote("pb").call());
      expect(result).toBeUndefined();
      expect(native.status, native.stderr).toBe(0);
      expect(refs(`${o}-bare`)).toBe(refs(`${n}-bare`));
      expect(refs(`${o}-bare`)).toContain(`refs/heads/${branch} `);
    }

    const [n, o] = twins((dir) => {
      git(root, "clone", "-q", "--no-local", join(root, "up"), dir);
      git(root, "clone", "-q", "--bare", "--no-local", join(root, "up"), `${dir}-bare`);
    });
    for (const d of [n, o]) {
      git(join(root, d), "remote", "remove", "origin");
      gitFile(
        d,
        "remotes/origin",
        `URL: ../${d}-bare\nPush: refs/heads/main:refs/heads/upstream\nPull: refs/heads/main:refs/heads/origin\n`,
      );
    }
    const native = gitRun(root, join(root, n), ["push", "origin"]);
    expect(native.status, native.stderr).toBe(0);
    const result = await (await ours(o)).push().setRemote("origin").call();
    expect(refs(`${o}-bare`)).toBe(refs(`${n}-bare`));
    expect(refs(`${o}-bare`)).toContain(`refs/heads/upstream ${second}`);
    expect(legacyLines((result.warnings ?? []).join("\n"))).toBe(legacyLines(native.stderr));
    // the push updates the tracking ref the Pull: line names
    expect(refs(o)).toBe(refs(n));
  });

  it("ls-remote, pull and @{upstream} through legacy remotes", async () => {
    const [n, o] = twins((dir) => {
      git(root, "clone", "-q", "--no-local", join(root, "up"), dir);
      git(dir, "reset", "-q", "--hard", first);
      git(dir, "remote", "remove", "origin");
    });
    for (const d of [n, o]) {
      gitFile(d, "remotes/rem", "URL: ../up\nPull: refs/heads/second:refs/heads/tracked\n");
      gitFile(d, "branches/br", "../up#main\n");
      git(join(root, d), "config", "branch.main.remote", "rem");
      git(join(root, d), "config", "branch.main.merge", "refs/heads/second");
      git(join(root, d), "update-ref", "refs/heads/tracked", first);
    }
    const g = await ours(o);
    // ls-remote <name>
    const listed = await g.lsRemote().setRemote("br").call();
    const native = git(join(root, n), "ls-remote", "br")
      .split("\n")
      .filter((line) => line && !line.endsWith("^{}") && !line.endsWith("\tHEAD"))
      .map((line) => line.split("\t").reverse().join(" "));
    expect(listed.refs.map((r) => `${r.name} ${r.objectId}`).sort()).toEqual(native.sort());
    // @{upstream}: branch.main.remote names a remotes file
    const upstream = await g.revParse().setRevision("@{upstream}").call();
    expect(upstream.objectId).toBe(git(join(root, n), "rev-parse", "@{upstream}").trim());
    // pull from a branches file: fetches main into refs/heads/br and merges it (main's
    // upstream on another remote would leave nothing to merge: get_ref_map's has_merge)
    for (const d of [n, o]) git(join(root, d), "config", "--remove-section", "branch.main");
    const nativePull = gitRun(root, join(root, n), ["pull", "--ff-only", "br"]);
    expect(nativePull.status, nativePull.stderr).toBe(0);
    await (await ours(o)).pull().setRemote("br").call();
    expect(refs(o)).toBe(refs(n));
    expect(git(join(root, o), "rev-parse", "HEAD")).toBe(git(join(root, n), "rev-parse", "HEAD"));
  });

  it("t5505: migrate a remote from named file in $GIT_DIR/remotes", async () => {
    const [n, o] = twins(empty);
    for (const d of [n, o]) {
      gitFile(
        d,
        "remotes/origin",
        `URL: ${join(root, "up")}\nPush: refs/heads/main:refs/heads/upstream\nPull: refs/heads/main:refs/heads/origin\n`,
      );
    }
    const native = gitRun(root, join(root, n), ["remote", "rename", "origin", "origin"]);
    expect(native.status, native.stderr).toBe(0);
    const result = await (await ours(o))
      .remoteRename()
      .setOldName("origin")
      .setNewName("origin")
      .call();
    expect(existsSync(join(root, o, ".git/remotes/origin"))).toBe(false);
    expect(existsSync(join(root, n, ".git/remotes/origin"))).toBe(false);
    expect(readFileSync(join(root, o, ".git/config"), "latin1")).toBe(
      readFileSync(join(root, n, ".git/config"), "latin1"),
    );
    expect(result.warnings.map((w) => `warning: ${w}`).join("\n")).toBe(legacyLines(native.stderr));
    expect(git(join(root, o), "config", "remote.origin.url").trim()).toBe(join(root, "up"));
  });

  it("t5505: migrate a remote from named file in $GIT_DIR/branches (with # and without)", async () => {
    for (const content of ["#main", ""]) {
      const [n, o] = twins(empty);
      for (const d of [n, o]) gitFile(d, "branches/origin", `${join(root, "up")}${content}\n`);
      const native = gitRun(root, join(root, n), ["remote", "rename", "origin", "origin"]);
      expect(native.status, native.stderr).toBe(0);
      await (await ours(o)).remoteRename().setOldName("origin").setNewName("origin").call();
      expect(existsSync(join(root, o, ".git/branches/origin"))).toBe(false);
      expect(existsSync(join(root, n, ".git/branches/origin"))).toBe(false);
      expect(readFileSync(join(root, o, ".git/config"), "latin1")).toBe(
        readFileSync(join(root, n, ".git/config"), "latin1"),
      );
    }
  });

  it("refuses to rename a legacy remote to another name, as git_config_rename_section", async () => {
    const [n, o] = twins(empty);
    for (const d of [n, o]) gitFile(d, "branches/br", "../up#main\n");
    const native = gitRun(root, join(root, n), ["remote", "rename", "br", "newbr"]);
    const error = await failure(async () =>
      (await ours(o)).remoteRename().setOldName("br").setNewName("newbr").call(),
    );
    expect(error?.exitCode).toBe(native.status);
    expect(`error: ${error?.message}`).toBe(
      native.stderr
        .split("\n")
        .filter((l) => l.startsWith("error:"))
        .join("\n"),
    );
    expect(existsSync(join(root, o, ".git/branches/br"))).toBe(true);
    expect(readFileSync(join(root, o, ".git/config"), "latin1")).toBe(
      readFileSync(join(root, n, ".git/config"), "latin1"),
    );
  });
});

const git3 = git3Binary();

describe.skipIf(!git3 || !nativeGitAvailable())("legacy remotes under git 3.0 ($GIT3)", () => {
  let base = "";
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "legacy-remotes-git3-"));
    const up = join(base, "up");
    mkdirSync(up);
    gitOut(base, up, ["init", "-q", "-b", "main"]);
    writeFileSync(join(up, "a.txt"), "a\n");
    gitOut(base, up, ["add", "a.txt"]);
    gitOut(base, up, ["commit", "-qm", "one"], DATES);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  const git3Run = (cwd: string, args: string[]) => {
    const env = { ...nativeGit3Env(base), GIT_DEFAULT_REF_FORMAT: "files", ...DATES };
    return gitRunWith(git3 as string, cwd, args, env);
  };

  it("reads neither file: the name is a path, and rename finds no remote", async () => {
    for (const name of ["n", "o"]) {
      const dir = join(base, name);
      mkdirSync(dir);
      gitOut(base, dir, ["init", "-q", "-b", "main"]);
      putFile(join(dir, ".git"), "remotes/rem", "URL: ../up\nPull: refs/heads/main:refs/heads/x\n");
      putFile(join(dir, ".git"), "branches/br", "../up#main\n");
    }
    const env = testEnv(base, DATES);
    const g = await openOurs(
      base,
      createNodeGitHostEnvironment({ env, breakingChanges: true }),
      undefined,
      "o",
    );
    for (const remote of ["rem", "br"]) {
      const native = git3Run(join(base, "n"), ["fetch", remote]);
      expect(native.status).toBe(128);
      expect(native.stderr).toContain(`fatal: '${remote}' does not appear to be a git repository`);
      const error = await failure(() => g.fetch().setRemote(remote).call());
      expect(error?.exitCode).toBe(128);
      expect(error?.message).toContain(`'${remote}' does not appear to be a git repository`);
    }
    const native = git3Run(join(base, "n"), ["remote", "rename", "rem", "rem"]);
    const error = await failure(() => g.remoteRename().setOldName("rem").setNewName("rem").call());
    expect(error?.exitCode).toBe(native.status);
    expect(`error: ${error?.message}\n`).toBe(native.stderr);
    expect(existsSync(join(base, "o", ".git/remotes/rem"))).toBe(true);
  });
});

function gitRunWith(
  binary: string,
  cwd: string,
  args: string[],
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(binary, args, { cwd, env });
  return {
    status: r.status,
    stdout: r.stdout.toString("latin1"),
    stderr: r.stderr.toString("latin1"),
  };
}

describeGit("pull from a branches remote, as native git 2.x (pull.c)", () => {
  let base = "";
  let n = 0;
  const run = (cwd: string, ...args: string[]) => gitOut(base, cwd, args, DATES);
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "legacy-remotes-pull-"));
    const up = join(base, "up");
    mkdirSync(up);
    run(up, "init", "-q", "-b", "main");
    putFile(up, "a.txt", "a\n");
    run(up, "add", "a.txt");
    run(up, "commit", "-qm", "one");
    run(up, "branch", "old");
    putFile(up, "b.txt", "b\n");
    run(up, "add", "b.txt");
    run(up, "commit", "-qm", "two");
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  /** Twins on main at `old` ("one"), each with `.git/branches/<name>` holding `content`. */
  function pullTwins(name: string, content: string): [string, string] {
    const pair: [string, string] = [`n${n}`, `o${n}`];
    n++;
    for (const d of pair) {
      const dir = join(base, d);
      mkdirSync(dir);
      run(dir, "init", "-q", "-b", "main");
      run(dir, "fetch", "-q", "--update-head-ok", "../up", "old:refs/heads/main");
      run(dir, "reset", "-q", "--hard", "main");
      putFile(join(dir, ".git"), `branches/${name}`, content);
    }
    return pair;
  }

  async function oursAt(name: string): Promise<Git> {
    const env = testEnv(base, DATES);
    return openOurs(
      base,
      createNodeGitHostEnvironment({
        env,
        hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
      }),
      undefined,
      name,
    );
  }

  const state = (d: string) => ({
    refs: run(join(base, d), "for-each-ref", "--format=%(refname) %(objectname)"),
    head: run(join(base, d), "rev-parse", "HEAD"),
    status: run(join(base, d), "status", "--porcelain", "-uall"),
  });

  /** git's warning() lines of stderr (the first prefixed, the rest as printed). */
  const fastForwardWarning = (stderr: string) => {
    const lines = stderr.split("\n");
    const at = lines.findIndex((l) => l.startsWith("warning: fetch updated the current branch"));
    return at < 0 ? [] : [lines.slice(at, at + 3).join("\n")];
  };

  it("fetch moving the checked-out branch fast-forwards the worktree (pull.c, orig_head != curr_head)", async () => {
    const [nd, od] = pullTwins("main", "../up#main\n");
    const native = gitRun(base, join(base, nd), ["pull", "main"], DATES);
    expect(native.status, native.stderr).toBe(0);
    const result = await (await oursAt(od)).pull().setRemote("main").call();
    expect(result.successful).toBe(true);
    expect(state(od)).toEqual(state(nd));
    expect(state(od).status).toBe("");
    expect(result.warnings ?? []).toEqual(fastForwardWarning(native.stderr));
  });

  it("a fast-forward of the worktree that local changes block dies as git", async () => {
    const [nd, od] = pullTwins("main", "../up#main\n");
    for (const d of [nd, od]) putFile(join(base, d), "b.txt", "mine\n");
    const native = gitRun(base, join(base, nd), ["pull", "main"], DATES);
    const error = await failure(async () => (await oursAt(od)).pull().setRemote("main").call());
    expect(error?.exitCode).toBe(native.status);
    const lines = native.stderr.split("\n");
    const from = lines.findIndex((l) => l.startsWith("warning: fetch updated the current"));
    expect(`${error?.message}\n`).toBe(`${lines.slice(from).join("\n")}`);
    expect(state(od)).toEqual(state(nd));
  });

  it("merges the branch the branches file names, not the current branch's name", async () => {
    const [nd, od] = pullTwins("vendor", "../up#old\n");
    // main ahead of `old`: the pull of `old` is already up to date
    for (const d of [nd, od]) run(join(base, d), "fetch", "-q", "../up", "main:refs/heads/x");
    for (const d of [nd, od]) run(join(base, d), "reset", "-q", "--hard", "x");
    const native = gitRun(base, join(base, nd), ["pull", "vendor"], DATES);
    expect(native.status, native.stderr).toBe(0);
    const result = await (await oursAt(od)).pull().setRemote("vendor").call();
    expect(result.successful).toBe(true);
    expect(state(od)).toEqual(state(nd));
    expect(state(od).refs).toContain("refs/heads/vendor ");
  });
});
