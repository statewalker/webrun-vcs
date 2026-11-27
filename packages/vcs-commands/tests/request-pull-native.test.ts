/**
 * `git request-pull` against native git, its scenarios taken from git's t5150-request-pull.sh
 * (the same repositories: an upstream, a downstream to push to, a local clone with a tag, a
 * renaming branch and a branch description), plus `-p`, revisions that name nothing or
 * several refs, no common history, and several remote refs matching the one asked for (git
 * 2.43's Perl matcher keeps the last match, 2.50+'s shell one the first). Both run on the
 * same repository; stdout, stderr and the exit status are compared. Run with the system git
 * (2.43) and with a 2.5x git first on `PATH`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitEnv, type Outcome } from "./shortlog-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** 2.50 replaced request-pull's Perl ref matcher by a shell one. */
function compatibility(): "2.43" | "2.56" {
  const v = execFileSync("git", ["--version"], { encoding: "utf8" });
  const m = /(\d+)\.(\d+)/.exec(v);
  return m && (Number(m[1]) > 2 || Number(m[2]) >= 50) ? "2.56" : "2.43";
}

let root = "";
let tick = 0;
let local = "";
let downstreamUrl = "";

function git(cwd: string, args: string[], input?: string): string {
  tick += 60;
  return execFileSync("git", args, {
    cwd,
    env: gitEnv(root, tick),
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
}

/** t5150's `rm -fr downstream.git && git init --bare downstream.git`. */
function freshDownstream(): void {
  rmSync(join(root, "downstream.git"), { recursive: true, force: true });
  git(root, ["init", "-q", "--bare", "-b", "main", "downstream.git"]);
}

/** `git checkout initial && git merge --ff-only main` in local. */
function atMain(): void {
  git(local, ["checkout", "-q", "initial"]);
  git(local, ["merge", "-q", "--ff-only", "main"]);
}

function native(args: string[]): Outcome {
  const r = spawnSync("git", ["request-pull", ...args], {
    cwd: local,
    env: gitEnv(root, tick),
    encoding: "latin1",
  });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

async function ours(args: string[]): Promise<Outcome> {
  // rooted above the repositories, so file:// URLs and paths to them reach them
  const git = await openOurs(root, undefined, undefined, "local");
  const cmd = git.requestPull().setCompatibility(compatibility());
  const positional: string[] = [];
  for (const a of args) {
    if (a === "-p") cmd.setPatch(true);
    else if (a !== "--") positional.push(a);
  }
  const [start, url, end] = positional;
  cmd.setStart(start ?? "").setUrl(url ?? "");
  if (end !== undefined) cmd.setEnd(end);
  const r = await cmd.call();
  const latin1 = (s: string) => Buffer.from(encodeGitPath(s)).toString("latin1");
  return { status: r.exitCode, out: latin1(r.stdout), err: latin1(r.stderr) };
}

async function expectSame(args: string[]): Promise<Outcome> {
  const n = native(args);
  expect(await ours(args)).toEqual(n);
  return n;
}

describeGit("git request-pull, native (t5150-request-pull)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "request-pull-native-"));
    local = join(root, "local");
    const trashUrl = `file://${root}`;
    downstreamUrl = `${trashUrl}/downstream.git/`;
    // t5150-request-pull.sh: "setup"
    git(root, ["init", "-q", "--bare", "-b", "main", "upstream.git"]);
    git(root, ["init", "-q", "--bare", "-b", "main", "downstream.git"]);
    git(root, ["clone", "-q", "upstream.git", "upstream-private"]);
    git(root, ["clone", "-q", "downstream.git", "local"]);
    const priv = join(root, "upstream-private");
    git(priv, ["checkout", "-q", "-b", "main"]);
    writeFileSync(
      join(priv, "mnemonic.txt"),
      "Thirtey days hath November,\nAprile, June, and September:\n",
    );
    git(priv, ["add", "mnemonic.txt"]);
    git(priv, ["commit", "-q", "-m", '"Thirty days", a reminder of month lengths']);
    git(priv, ["tag", "-m", "version 1", "-a", "initial"]);
    git(priv, ["push", "-q", "--tags", "origin", "main"]);

    git(local, ["remote", "add", "upstream", `${trashUrl}/upstream.git`]);
    git(local, ["fetch", "-q", "upstream"]);
    git(local, ["checkout", "-q", "-b", "main"]);
    git(local, ["pull", "-q", "upstream", "main"]);
    appendFileSync(
      join(local, "mnemonic.txt"),
      [
        "Of twyecescore-eightt is but eine,",
        "And all the remnante be thrycescore-eine.",
        "O’course Leap yare comes an’pynes,",
        "Ev’rie foure yares, gote it ryghth.",
        "An’twyecescore-eight is but twyecescore-nyne.",
        "",
      ].join("\n"),
    );
    git(local, ["add", "mnemonic.txt"]);
    git(local, ["commit", "-q", "-m", "More detail"]);
    git(local, ["tag", "-m", "version 2", "-a", "full"]);
    git(local, ["checkout", "-q", "-b", "simplify", "HEAD^"]);
    git(local, ["mv", "mnemonic.txt", "mnemonic.standard"]);
    writeFileSync(
      join(local, "mnemonic.clarified"),
      "Thirty days has September,\nAll the rest I can’t remember.\n",
    );
    git(local, ["add", "-N", "mnemonic.clarified"]);
    git(local, [
      "commit",
      "-q",
      "-a",
      "-m",
      "Adapt to use modern, simpler English\n\nBut keep the old version, too, in case some people prefer it.",
    ]);
    git(local, ["checkout", "-q", "main"]);
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it('t5150-request-pull.sh: "pull request when forgot to push"', async () => {
    freshDownstream();
    atMain();
    const n = await expectSame(["initial", downstreamUrl]);
    expect(n.status).toBe(1);
    expect(n.err).toMatch(/No match for commit .*\n.*Are you sure you pushed/);
  });

  it('t5150-request-pull.sh: "pull request after push"', async () => {
    freshDownstream();
    atMain();
    git(local, ["push", "-q", "origin", "main:for-upstream"]);
    const n = await expectSame(["initial", "origin", "main:for-upstream"]);
    expect(n.status).toBe(0);
    expect(n.out).toContain("downstream.git for-upstream\n");
  });

  it('t5150-request-pull.sh: "request asks HEAD to be pulled"', async () => {
    freshDownstream();
    atMain();
    git(local, ["push", "-q", "--tags", "origin", "main", "simplify"]);
    git(local, ["push", "-q", "origin", "main:for-upstream"]);
    const n = await expectSame(["initial", downstreamUrl]);
    expect(n.out).toContain(`  ${downstreamUrl} \n`);
  });

  it('t5150-request-pull.sh: "pull request format"', async () => {
    freshDownstream();
    atMain();
    git(local, ["push", "-q", "origin", "tags/full"]);
    const n = await expectSame(["initial", downstreamUrl, "tags/full"]);
    expect(n.status).toBe(0);
    expect(n.out).toContain("version 2\n\n---");
    await expectSame(["initial", downstreamUrl, "tags/full:refs/tags/full"]);
    expect((await expectSame(["initial", downstreamUrl, "full"])).out).toMatch(/ tags\/full$/m);
  });

  it('t5150-request-pull.sh: "request-pull ignores OPTIONS_KEEPDASHDASH poison"', async () => {
    atMain();
    git(local, ["push", "-q", "origin", "main:for-upstream"]);
    await expectSame(["--", "initial", downstreamUrl, "main:for-upstream"]);
  });

  it("-p adds the patch after the diffstat and summary (renames found)", async () => {
    git(local, ["push", "-q", "-f", "origin", "simplify"]);
    const n = await expectSame(["-p", "initial", downstreamUrl, "simplify"]);
    expect(n.out).toContain("rename mnemonic.txt => mnemonic.standard (100%)");
    expect(n.out).toContain("diff --git");
  });

  it("a branch description is shown", async () => {
    git(local, ["config", "branch.simplify.description", "Simpler words\nfor everyone"]);
    git(local, ["checkout", "-q", "simplify"]);
    const n = await expectSame(["initial", downstreamUrl]);
    expect(n.out).toContain("(from the branch description for simplify local branch)");
    await expectSame(["initial", downstreamUrl, "simplify"]);
    git(local, ["checkout", "-q", "main"]);
  });

  it("several remote refs match the name asked for", async () => {
    git(local, ["push", "-q", "-f", "origin", "main:refs/heads/topic", "simplify:refs/tags/topic"]);
    await expectSame(["initial", downstreamUrl, "main:topic"]);
    await expectSame(["initial", downstreamUrl, "simplify:topic"]);
    git(local, ["push", "-q", "-f", "origin", "simplify:refs/heads/topic", "main:refs/tags/topic"]);
    await expectSame(["initial", downstreamUrl, "main:topic"]);
    await expectSame(["initial", downstreamUrl, "simplify:topic"]);
  });

  it("the remote named by its object id", async () => {
    const id = git(local, ["rev-parse", "main"]).trim();
    await expectSame(["initial", downstreamUrl, `main:${id}`]);
  });

  it("revisions that name nothing, several refs or no common history", async () => {
    expect((await expectSame(["nosuch", downstreamUrl])).status).toBe(1);
    expect((await expectSame(["initial", downstreamUrl, "nosuch"])).status).toBe(1);
    git(local, ["branch", "full"]);
    expect((await expectSame(["initial", downstreamUrl, "full"])).err).toContain("Ambiguous");
    git(local, ["branch", "-D", "full"]);
    git(local, ["checkout", "-q", "--orphan", "lonely"]);
    git(local, ["commit", "-q", "-m", "lonely"]);
    git(local, ["checkout", "-q", "main"]);
    expect((await expectSame(["initial", downstreamUrl, "lonely"])).err).toContain(
      "No commits in common",
    );
  });

  it('t5150-request-pull.sh: "request-pull quotes regex metacharacters properly"', async () => {
    freshDownstream();
    atMain();
    git(local, ["tag", "-mrelease", "v2.0"]);
    git(local, ["push", "-q", "origin", "refs/tags/v2.0:refs/tags/v2-0"]);
    const n = await expectSame(["initial", downstreamUrl, "tags/v2.0"]);
    expect(n.err).toMatch(/No match for commit .*\n.*Are you sure you pushed/);
  });

  it('t5150-request-pull.sh: "pull request with mismatched object"', async () => {
    freshDownstream();
    atMain();
    git(local, ["push", "-q", "origin", "HEAD:refs/tags/full"]);
    const n = await expectSame(["initial", downstreamUrl, "tags/full"]);
    expect(n.err).toMatch(/points to a different object\n.*Are you sure you pushed/);
  });

  it('t5150-request-pull.sh: "pull request with stale object"', async () => {
    freshDownstream();
    atMain();
    git(local, ["push", "-q", "origin", "refs/tags/full"]);
    git(local, ["tag", "-f", "-mThirty-one days", "full"]);
    const n = await expectSame(["initial", downstreamUrl, "tags/full"]);
    expect(n.err).toMatch(/points to a different object\n.*Are you sure you pushed/);
  });
});
