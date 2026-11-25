/**
 * Bundles as remotes (transport.c's bundle transport): `git clone`, `git fetch` and
 * `git ls-remote` of a bundle file, against native git (t6020-bundle-misc.sh's clones and
 * fetches, t5607-clone-bundle.sh). Each case runs native git in one repository and ours in a
 * twin, from the same bundle, and compares the refs, the objects, what was printed and the
 * exit status.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
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

import { fetchOutputText, Git, GitApiError } from "../src/index.js";
import { compatibility, ourClone, ourCloneFails } from "./clone-options-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let home: string;
let repo: string;

function run(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, env: testEnv(home, { TZ: "UTC" }) });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout as Buffer).toString("utf8"),
    stderr: (r.stderr as Buffer).toString("utf8"),
  };
}

function gitOk(cwd: string, args: string[]): string {
  const r = run(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function sh(dir: string, script: string): void {
  const prelude = `
set -e
export GIT_AUTHOR_NAME="A U Thor" GIT_AUTHOR_EMAIL=author@example.com
export GIT_COMMITTER_NAME="C O Mitter" GIT_COMMITTER_EMAIL=committer@example.com
test_tick () {
  if test -z "\${test_tick+set}"; then test_tick=1112911993; else test_tick=$((test_tick + 60)); fi
  export GIT_COMMITTER_DATE="$test_tick -0700" GIT_AUTHOR_DATE="$test_tick -0700"
}
c() { test_tick; echo "$1" >"$2"; git add "$2"; git commit -q -m "$1"; }
m() { test_tick; git merge -q --no-edit --no-ff -m "$2" "$1"; }
t() { test_tick; git tag -m "$1" "$1"; }
`;
  const r = spawnSync("bash", ["-c", prelude + script], { cwd: dir, env: testEnv(home) });
  if (r.status !== 0) throw new Error(`setup failed: ${r.stderr.toString()}`);
}

/** Ours over the bare repository at `dir` (below home). */
async function openBare(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: home });
  const environment = createNodeGitHostEnvironment({ env: testEnv(home) });
  const gitDir = dir.slice(home.length + 1);
  const { history } = await createGitFilesBackend({ files, gitDir, environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir, history, environment });
  return Git.fromWorktreeAdmin(await worktrees.openAdmin());
}

/** Ours over the repository with a worktree at `dir` (below home). */
function openWorktree(dir: string): Promise<Git> {
  const environment = createNodeGitHostEnvironment({ env: testEnv(home) });
  return openOurs(home, environment, undefined, dir.slice(home.length + 1));
}

function bundle(name: string, args: string[], options: string[] = []): string {
  const file = join(home, name);
  gitOk(repo, ["bundle", "create", ...options, file, ...args]);
  return file;
}

const showRef = (dir: string) => run(dir, ["show-ref"]).stdout;
const objects = (dir: string) =>
  gitOk(dir, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)"]);

/** Our fetch's printout (git's stderr) and status, or its death. */
async function ourFetch(git: Git, remote: string, refspecs: string[], quiet = false) {
  try {
    const command = git.fetch().setRemote(remote).setCompatibility(compatibility);
    if (refspecs.length > 0) command.setRefSpecs(...refspecs);
    const result = await command.call();
    return { status: 0, stderr: fetchOutputText(result, quiet) };
  } catch (error) {
    if (!(error instanceof GitApiError)) throw error;
    return { status: error.exitCode, stderr: `${error.message}\n` };
  }
}

describeGit("bundles as remotes (t6020-bundle-misc, t5607-clone-bundle)", () => {
  let b1: string;
  let b2: string;
  let b3: string;
  let b4: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "bundle-transport-"));
    repo = join(home, "repo");
    mkdirSync(repo);
    sh(
      repo,
      `git init -q -b main
c "Commit A" main.txt; c "Commit B" main.txt
git checkout -q -b topic/1; c "Commit C" topic-1.txt; c "Commit D" topic-1.txt
git update-ref refs/pull/1/head HEAD
git checkout -q main; c "Commit E" main.txt; t v1
git checkout -q -b topic/2; c "Commit F" topic-2.txt; c "Commit G" topic-2.txt
git update-ref refs/pull/2/head HEAD; c "Commit H" topic-2.txt
git checkout -q main; m topic/1 "Merge commit I"; m refs/pull/2/head "Merge commit J"
c "Commit K" main.txt
git checkout -q -b release; c "Commit L" release.txt; c "Commit M" release.txt; t v2
c "Commit N" release.txt; t v3
git checkout -q main; m tags/v2 "Merge commit O"; c "Commit P" main.txt`,
    );
    b1 = bundle("1.bdl", ["topic/1", "topic/2"]);
    b2 = bundle("2.bdl", ["^topic/1", "^topic/2", "release"]);
    b3 = bundle("3.bdl", ["^release", "^topic/1", "^topic/2", "main", "HEAD"], ["--version=3"]);
    b4 = bundle("4.bdl", ["^main", "^release", "^topic/1", "^topic/2", "--all"]);
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('t6020-bundle-misc.sh: "clone from bundle"', async () => {
    const native = join(home, "mirror-native.git");
    gitOk(home, ["clone", "-q", "--mirror", b1, native]);
    const mine = join(home, "mirror-ours.git");
    await ourClone(home, mine, (c) => c.setURI(b1).setMirror(true), { bare: true });
    expect(showRef(mine)).toBe(showRef(native));
    expect(run(mine, ["config", "remote.origin.url"]).stdout).toBe(`${b1}\n`);
    for (const file of [b2, b3, b4]) {
      const expected = run(native, ["fetch", file, "+refs/*:refs/*"]);
      const result = await ourFetch(await openBare(mine), file, ["+refs/*:refs/*"]);
      expect(result).toEqual({ status: expected.status, stderr: expected.stderr });
      expect(showRef(mine)).toBe(showRef(native));
      expect(objects(mine)).toBe(objects(native));
    }
    expect(run(mine, ["fsck", "--strict", "--no-dangling"]).status).toBe(0);
  });

  it('t6020-bundle-misc.sh: "clone from full bundle upto annotated tag"', async () => {
    const v2 = bundle("v2.bdl", ["v2"]);
    const native = join(home, "tag-native.git");
    gitOk(home, ["clone", "-q", "--mirror", v2, native]);
    const mine = join(home, "tag-ours.git");
    await ourClone(home, mine, (c) => c.setURI(v2).setMirror(true), { bare: true });
    expect(showRef(mine)).toBe(showRef(native));
  });

  it('t6020-bundle-misc.sh: "cloning from filtered bundle has useful error"', async () => {
    const partial = bundle("partial.bdl", ["--all", "--filter=blob:none"]);
    const expected = run(home, ["clone", "--bare", partial, join(home, "partial-native")]);
    expect(expected.stderr).toContain("cannot clone from filtered bundle");
    const failed = await ourCloneFails(
      home,
      join(home, "partial-ours"),
      (c) => c.setURI(partial).setBare(true),
      { bare: true },
    );
    expect(failed).toEqual({ message: "fatal: cannot clone from filtered bundle", exitCode: 128 });
  });

  it("a clone of a bundle with HEAD checks its branch out; one without HEAD warns (t5607)", async () => {
    const all = bundle("all.bdl", ["--all"]);
    for (const [name, file] of [
      ["all", all],
      ["heads", b1],
    ] as const) {
      const native = join(home, `clone-${name}-native`);
      const expected = run(home, ["clone", file, native]);
      const mine = join(home, `clone-${name}-ours`);
      const result = await ourClone(home, mine, (c) => c.setURI(file));
      expect(run(mine, ["for-each-ref"]).stdout).toBe(run(native, ["for-each-ref"]).stdout);
      // (ourClone's twin starts from `git init -b main`: an unborn HEAD keeps that name)
      expect(run(mine, ["rev-parse", "-q", "--verify", "HEAD"]).stdout).toBe(
        run(native, ["rev-parse", "-q", "--verify", "HEAD"]).stdout,
      );
      if (name === "all") {
        expect(run(mine, ["symbolic-ref", "HEAD"]).stdout).toBe(
          run(native, ["symbolic-ref", "HEAD"]).stdout,
        );
      }
      expect(run(mine, ["status", "--porcelain"]).stdout).toBe(
        run(native, ["status", "--porcelain"]).stdout,
      );
      const warned = expected.stderr.includes("remote HEAD refers to nonexistent ref");
      expect(
        (result.messages ?? []).some((m) => m.includes("remote HEAD refers to nonexistent ref")),
      ).toBe(warned);
    }
  });

  it("a fetch lacking the prerequisites fails as git's (exit 1), a clone dies (128)", async () => {
    const native = join(home, "lacking-native");
    const mine = join(home, "lacking-ours");
    gitOk(home, ["init", "-q", native]);
    gitOk(home, ["init", "-q", mine]);
    const expected = run(native, ["fetch", b2, "refs/*:refs/*"]);
    const result = await ourFetch(await openWorktree(mine), b2, ["refs/*:refs/*"]);
    expect(result).toEqual({ status: expected.status, stderr: expected.stderr });
    expect(expected.stderr).toContain("Repository lacks these prerequisite commits:");
    const clone = run(home, ["clone", b2, join(home, "lacking-clone-native")]);
    const failed = await ourCloneFails(home, join(home, "lacking-clone-ours"), (c) => c.setURI(b2));
    expect(failed.exitCode).toBe(clone.status);
    // (git's init advice, which our twin's harness runs apart, left out)
    const errors = (text: string) =>
      text
        .split("\n")
        .filter((l) => /^(error|fatal): /.test(l))
        .join("\n");
    expect(errors(failed.message)).toBe(errors(clone.stderr));
    expect(errors(failed.message)).toContain("fatal: remote transport reported error");
  });

  it("ls-remote lists a bundle's refs in git's order (t5607, t6020)", async () => {
    for (const file of [b1, b2, b3, b4]) {
      const expected = run(repo, ["ls-remote", file])
        .stdout.split("\n")
        .filter((l) => l && !l.endsWith("\tHEAD"));
      const result = await (await openWorktree(repo)).lsRemote().setRemote(file).call();
      expect(result.refs.map((r) => `${r.objectId}\t${r.name}`)).toEqual(expected);
    }
  });

  it('t5607-clone-bundle.sh: "fetch SHA-1 from bundle"', async () => {
    const tip = bundle("tip.bundle", ["-1", "main"]);
    const id = gitOk(repo, ["rev-parse", "main"]).trim();
    const native = join(home, "sha-native");
    const mine = join(home, "sha-ours");
    gitOk(repo, ["update-ref", "refs/test/base", "main~1"]);
    for (const dir of [native, mine]) {
      gitOk(home, ["init", "-q", dir]);
      gitOk(dir, ["fetch", "-q", "--no-tags", repo, "refs/test/base:refs/heads/base"]);
    }
    gitOk(repo, ["update-ref", "-d", "refs/test/base"]);
    const expected = run(native, ["fetch", "--no-tags", tip, id]);
    const result = await ourFetch(await openWorktree(mine), tip, [id]);
    expect(result.status).toBe(expected.status);
    expect(run(mine, ["cat-file", "-t", id]).stdout).toBe("commit\n");
    expect(run(mine, ["rev-parse", "FETCH_HEAD"]).stdout).toBe(
      run(native, ["rev-parse", "FETCH_HEAD"]).stdout,
    );
  });

  it('t5607-clone-bundle.sh: "empty bundle file is rejected"', async () => {
    const empty = join(home, "empty-bundle");
    writeFileSync(empty, "");
    const native = join(home, "empty-native");
    const mine = join(home, "empty-ours");
    gitOk(home, ["init", "-q", native]);
    gitOk(home, ["init", "-q", mine]);
    const expected = run(native, ["fetch", empty]);
    expect(expected.status).not.toBe(0);
    const result = await ourFetch(await openWorktree(mine), empty, []);
    expect(result.status).toBe(expected.status);
  });

  it("push to a bundle fails as git's", async () => {
    const copy = join(home, "push-target.bdl");
    copyFileSync(b1, copy);
    const expected = run(repo, ["push", copy, "main"]);
    let failure: GitApiError | undefined;
    try {
      await (await openWorktree(repo)).push().setRemote(copy).setRefSpecs("main").call();
    } catch (error) {
      if (!(error instanceof GitApiError)) throw error;
      failure = error;
    }
    expect(failure?.exitCode).toBe(expected.status);
    expect(`${failure?.message}\n`).toBe(expected.stderr);
    expect(existsSync(copy)).toBe(true);
  });

  it("a clone of a bundle whose HEAD no branch matches detaches HEAD there (update_head)", async () => {
    const ht = bundle("head-topic.bdl", ["HEAD", "topic/1"]);
    const native = join(home, "head-topic-native");
    gitOk(home, ["clone", "-q", ht, native]);
    const mine = join(home, "head-topic-ours");
    const result = await ourClone(home, mine, (c) => c.setURI(ht));
    expect(run(mine, ["rev-parse", "HEAD"]).stdout).toBe(run(native, ["rev-parse", "HEAD"]).stdout);
    expect(run(mine, ["symbolic-ref", "-q", "HEAD"]).status).toBe(
      run(native, ["symbolic-ref", "-q", "HEAD"]).status,
    );
    expect(run(mine, ["for-each-ref"]).stdout).toBe(run(native, ["for-each-ref"]).stdout);
    expect(run(mine, ["status", "--porcelain"]).stdout).toBe("");
    expect(existsSync(join(mine, "main.txt"))).toBe(existsSync(join(native, "main.txt")));
    expect((result.messages ?? []).join("")).not.toContain("nonexistent ref");
  });

  it("a symbolic link to a bundle is a bundle remote (git's is_file follows it)", async () => {
    const link = join(home, "link.bundle");
    symlinkSync(b1, link);
    const expected = run(repo, ["ls-remote", link])
      .stdout.split("\n")
      .filter((l) => l && !l.endsWith("\tHEAD"));
    const listed = await (await openWorktree(repo)).lsRemote().setRemote(link).call();
    expect(listed.refs.map((r) => `${r.objectId}\t${r.name}`)).toEqual(expected);
    // `git clone link` finds `link.bundle` (get_repo_path's suffix)
    const native = join(home, "link-native.git");
    gitOk(home, ["clone", "-q", "--mirror", join(home, "link"), native]);
    const mine = join(home, "link-ours.git");
    await ourClone(home, mine, (c) => c.setURI(join(home, "link")).setMirror(true), { bare: true });
    expect(showRef(mine)).toBe(showRef(native));
  });
});
