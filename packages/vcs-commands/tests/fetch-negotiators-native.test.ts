/**
 * Fetch negotiation as git chooses its haves: the skipping and noop negotiators
 * (`fetch.negotiationAlgorithm`), `--negotiation-tip`, `--negotiate-only` and `push.negotiate`.
 *
 * Each scenario builds its repositories with native git, then fetches with native git (its
 * upload-pack a child reading the path) and, from a copy of the client, with ours (against
 * `git daemon --inetd` over the same server). Both upload-packs trace what they read
 * (`GIT_TRACE_PACKET`), so the `have` lines each client sent are compared in order.
 */

import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDefaultTransports } from "@statewalker/vcs-transport";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { childDuplex, daemonArgs } from "./native-connect-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

/** Whether native git is 2.43 (before 2.45's fixes to push negotiation). */
function nativeIs243(): boolean {
  if (!nativeGitAvailable()) return false;
  return /git version 2\.43\./.test(gitOut(tmpdir(), tmpdir(), ["--version"]));
}

let root: string;
let counter = 0;
/** test-lib.sh's test_tick */
let tick = 1112911993;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);
const dated = () => ({
  GIT_AUTHOR_DATE: `${tick} -0700`,
  GIT_COMMITTER_DATE: `${tick} -0700`,
});

/** test-lib-functions.sh's test_commit: a file, a commit and a tag named `name`. */
function testCommit(dir: string, name: string): void {
  writeFileSync(join(dir, `${name}.t`), `${name}\n`);
  git(dir, "add", `${name}.t`);
  tick += 60;
  gitOut(root, dir, ["commit", "-q", "-m", name], dated());
  git(dir, "tag", name);
}

/** A fresh scenario directory with `git init`ed repositories. */
function scenario(...names: string[]): string {
  const dir = join(root, `s${counter++}`);
  for (const name of names) git(root, "init", "-q", "-b", "main", join(dir, name));
  tick = 1112911993;
  return dir;
}

/** The ids of the `have` lines upload-pack read, in order, from a packet trace. */
function havesIn(trace: string): string[] {
  return readFileSync(trace, "latin1")
    .split("\n")
    .map((l) => /upload-pack< have ([0-9a-f]+)$/.exec(l)?.[1])
    .filter((l): l is string => l !== undefined);
}

/** Native `git fetch` in `client` (args as given), and the haves its upload-pack read. */
function nativeFetch(client: string, args: string[], extra: Record<string, string> = {}) {
  const trace = join(root, `trace-${counter++}`);
  const r = gitRun(root, client, ["fetch", ...args], { GIT_TRACE_PACKET: trace, ...extra });
  expect(r.status, r.stderr).toBe(0);
  return havesIn(trace);
}

/** Our working copy of the repository at `dir` (below `root`). */
async function oursAt(dir: string): Promise<Git> {
  return openOurs(
    root,
    createNodeGitHostEnvironment({ env: testEnv(root) }),
    undefined,
    dir.slice(root.length + 1),
  );
}

/**
 * Our fetch from `client`'s copy, against `git daemon --inetd` over `base` (the remote
 * `git://localhost/<server>`), and the haves native upload-pack read.
 */
async function ourFetch(
  client: string,
  base: string,
  server: string,
  configure: (fetch: ReturnType<Git["fetch"]>) => ReturnType<Git["fetch"]> = (f) => f,
): Promise<string[]> {
  const trace = join(root, `trace-${counter++}`);
  const ours = await oursAt(client);
  await configure(
    ours
      .fetch()
      .setRemote(`git://localhost/${server}`)
      .setTransports(
        createDefaultTransports({
          openSocket: async () =>
            childDuplex(
              spawn("git", daemonArgs(base, false), {
                env: testEnv(root, { GIT_TRACE_PACKET: trace }),
              }),
            ),
        }),
      ),
  ).call();
  return havesIn(trace);
}

/** A copy of `client` for ours (the native fetch changes the original). */
function copyOf(client: string): string {
  const copy = `${client}-ours`;
  cpSync(client, copy, { recursive: true });
  return copy;
}

describeGit("fetch negotiators and negotiation tips (native twins)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "negotiators-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it(`t5552-skipping-fetch-negotiator.sh: "commits with no parents are sent regardless of skip distance"`, async () => {
    const dir = scenario("server", "client");
    testCommit(join(dir, "server"), "to_fetch");
    const client = join(dir, "client");
    for (let i = 1; i <= 7; i++) testCommit(client, `c${i}`);
    git(client, "config", "fetch.negotiationAlgorithm", "skipping");
    const copy = copyOf(client);
    const theirs = nativeFetch(client, [join(dir, "server")]);
    const mine = await ourFetch(copy, dir, "server");
    const ids = (...names: string[]) => names.map((n) => git(client, "rev-parse", n).trim());
    expect(theirs).toEqual(ids("c7", "c5", "c2", "c1"));
    expect(mine).toEqual(theirs);
  });

  it(`t5552-skipping-fetch-negotiator.sh: "when two skips collide, favor the larger one"`, async () => {
    const dir = scenario("server", "client");
    testCommit(join(dir, "server"), "to_fetch");
    const client = join(dir, "client");
    for (let i = 1; i <= 11; i++) testCommit(client, `c${i}`);
    git(client, "checkout", "-q", "c5");
    testCommit(client, "c5side");
    git(client, "config", "fetch.negotiationAlgorithm", "skipping");
    const copy = copyOf(client);
    const theirs = nativeFetch(client, [join(dir, "server")]);
    const mine = await ourFetch(copy, dir, "server");
    const sent = (name: string) => theirs.includes(git(client, "rev-parse", name).trim());
    for (const name of ["c5side", "c11", "c9", "c6", "c1"]) expect(sent(name), name).toBe(true);
    for (const name of ["c10", "c8", "c7", "c5", "c4", "c3", "c2"]) {
      expect(sent(name), name).toBe(false);
    }
    expect(mine).toEqual(theirs);
  });

  it(`t5552-skipping-fetch-negotiator.sh: "use ref advertisement to filter out commits"`, async () => {
    const dir = scenario("server");
    const server = join(dir, "server");
    for (const name of ["c1", "c2", "c3"]) testCommit(server, name);
    git(server, "tag", "-d", "c1", "c2", "c3");
    const client = join(dir, "client");
    git(dir, "clone", "-q", server, client);
    testCommit(client, "c4");
    testCommit(client, "c5");
    git(client, "checkout", "-q", "c4^^");
    testCommit(client, "c2side");
    git(server, "checkout", "-q", "--orphan", "anotherbranch");
    testCommit(server, "to_fetch");
    git(client, "config", "fetch.negotiationAlgorithm", "skipping");
    // the ref advertisement is filtered under protocol v2
    git(client, "config", "protocol.version", "0");
    const copy = copyOf(client);
    const theirs = nativeFetch(client, ["origin", "to_fetch"]);
    const mine = await ourFetch(copy, dir, "server", (f) => f.setRefSpecs("to_fetch"));
    const sent = (name: string) => theirs.includes(git(client, "rev-parse", name).trim());
    for (const name of ["c5", "c4^", "c2side"]) expect(sent(name), name).toBe(true);
    for (const name of ["c4", "c4^^", "c4^^^"]) expect(sent(name), name).toBe(false);
    expect(mine).toEqual(theirs);
  });

  it(`t5552-skipping-fetch-negotiator.sh: "handle clock skew"`, async () => {
    const dir = scenario("server", "client");
    testCommit(join(dir, "server"), "to_fetch");
    const client = join(dir, "client");
    tick = 2000000000;
    testCommit(client, "c1");
    testCommit(client, "c2");
    tick = 1000000000;
    git(client, "checkout", "-q", "c1");
    for (const name of ["old1", "old2", "old3", "old4"]) testCommit(client, name);
    git(client, "config", "fetch.negotiationAlgorithm", "skipping");
    const copy = copyOf(client);
    const theirs = nativeFetch(client, [join(dir, "server")]);
    const mine = await ourFetch(copy, dir, "server");
    const ids = (...names: string[]) => names.map((n) => git(client, "rev-parse", n).trim());
    expect(theirs).toEqual(ids("c2", "c1", "old4", "old2", "old1"));
    expect(mine).toEqual(theirs);
  });

  it(`t5552-skipping-fetch-negotiator.sh: 'do not send "have" with ancestors of commits that server ACKed'`, async () => {
    const dir = scenario("server", "client");
    const server = join(dir, "server");
    testCommit(server, "to_fetch");
    const client = join(dir, "client");
    for (let i = 1; i <= 8; i++) {
      git(client, "checkout", "-q", "--orphan", `b${i}`);
      testCommit(client, `b${i}.c0`);
    }
    for (let j = 1; j <= 19; j++) {
      for (let i = 1; i <= 8; i++) {
        git(client, "checkout", "-q", `b${i}`);
        testCommit(client, `b${i}.c${j}`);
      }
    }
    git(server, "fetch", "-q", "--no-tags", client, "b1:refs/heads/b1");
    git(server, "checkout", "-q", "b1");
    testCommit(server, "commit-on-b1");
    git(client, "config", "fetch.negotiationAlgorithm", "skipping");
    git(client, "config", "protocol.version", "0");
    const copy = copyOf(client);
    const theirs = nativeFetch(client, [server, "to_fetch"]);
    const mine = await ourFetch(copy, dir, "server", (f) => f.setRefSpecs("to_fetch"));
    const sent = (name: string) => theirs.includes(git(client, "rev-parse", name).trim());
    for (const name of ["b1.c19", "b1.c17", "b1.c14", "b1.c9", "b2.c1", "b2.c0"]) {
      expect(sent(name), name).toBe(true);
    }
    for (let j = 0; j <= 8; j++) expect(sent(`b1.c${j}`), `b1.c${j}`).toBe(false);
    expect(mine).toEqual(theirs);
  });

  it(`t5554-noop-fetch-negotiator.sh: 'noop negotiator does not emit any "have"'`, async () => {
    const dir = scenario("server", "client");
    testCommit(join(dir, "server"), "to_fetch");
    const client = join(dir, "client");
    testCommit(client, "we_have");
    git(client, "config", "fetch.negotiationAlgorithm", "noop");
    const copy = copyOf(client);
    const theirs = nativeFetch(client, [join(dir, "server")]);
    const mine = await ourFetch(copy, dir, "server");
    expect(theirs).toEqual([]);
    expect(mine).toEqual([]);
  });

  it(`t5552-skipping-fetch-negotiator.sh: "fetch.negotiationalgorithm config"`, async () => {
    const dir = scenario("repo");
    const repo = join(dir, "repo");
    writeFileSync(join(repo, ".git", "config"), "[fetch]\n\tnegotiationAlgorithm\n");
    const theirs = gitRun(root, repo, ["fetch"]);
    expect(theirs.status).toBe(128);
    // rooted at the repository, so the config file is named as git names it from there
    const ours = await openOurs(repo, createNodeGitHostEnvironment({ env: testEnv(root) }));
    const error = await ours
      .fetch()
      .call()
      .then(
        () => undefined,
        (e: unknown) => e as Error,
      );
    expect(error?.message).toBe(theirs.stderr.trimEnd());
  });

  // ── --negotiation-tip (t5510) ───────────────────────────────────────────────────────────

  /** t5510's setup_negotiation_tip over a path (protocol v0, or v2 in both repositories). */
  function negotiationTipSetup(v2: boolean): { dir: string; server: string; client: string } {
    const dir = scenario("server");
    const server = join(dir, "server");
    testCommit(server, "alpha_1");
    testCommit(server, "alpha_2");
    git(server, "checkout", "-q", "--orphan", "beta");
    testCommit(server, "beta_1");
    testCommit(server, "beta_2");
    const client = join(dir, "client");
    git(dir, "clone", "-q", server, client);
    git(client, "config", "protocol.version", v2 ? "2" : "0");
    if (v2) git(server, "config", "protocol.version", "2");
    testCommit(server, "beta_s");
    git(server, "checkout", "-q", "main");
    testCommit(server, "alpha_s");
    git(server, "tag", "-d", "alpha_1", "alpha_2", "beta_1", "beta_2");
    return { dir, server, client };
  }

  const TIP_CASES: Array<[string, boolean, (client: string) => string[]]> = [
    [
      `t5510-fetch.sh: '--negotiation-tip limits "have" lines sent'`,
      false,
      () => ["alpha_1", "beta_1"],
    ],
    [`t5510-fetch.sh: "--negotiation-tip understands globs"`, false, () => ["*_1"]],
    [
      `t5510-fetch.sh: "--negotiation-tip understands abbreviated SHA-1"`,
      false,
      (client) => ["alpha_1", "beta_1"].map((t) => git(client, "rev-parse", "--short", t).trim()),
    ],
    [
      `t5510-fetch.sh: '--negotiation-tip limits "have" lines sent with HTTP protocol v2'`,
      true,
      () => ["alpha_1", "beta_1"],
    ],
  ];
  for (const [title, v2, tipsOf] of TIP_CASES) {
    it(title, async () => {
      const { dir, client } = negotiationTipSetup(v2);
      const tips = tipsOf(client);
      const copy = copyOf(client);
      const theirs = nativeFetch(client, [
        ...tips.map((t) => `--negotiation-tip=${t}`),
        "origin",
        "alpha_s",
        "beta_s",
      ]);
      const mine = await ourFetch(copy, dir, "server", (f) =>
        f.setNegotiationTips(...tips).setRefSpecs("alpha_s", "beta_s"),
      );
      const sent = (name: string) => theirs.includes(git(client, "rev-parse", name).trim());
      expect(sent("alpha_1") && sent("beta_1")).toBe(true);
      expect(sent("alpha_2") || sent("beta_2")).toBe(false);
      expect(mine).toEqual(theirs);
    });
  }

  it(`t5510-fetch.sh: "--negotiation-tip rejects missing OIDs"`, async () => {
    const { client } = negotiationTipSetup(false);
    const zero = "0".repeat(40);
    const args = [`--negotiation-tip=alpha_1`, `--negotiation-tip=${zero}`, "origin", "alpha_s"];
    const theirs = gitRun(root, client, ["fetch", ...args]);
    expect(theirs.status).toBe(128);
    const ours = await oursAt(client);
    const error = await ours
      .fetch()
      .setRemote("origin")
      .setNegotiationTips("alpha_1", zero)
      .setRefSpecs("alpha_s")
      .call()
      .then(
        () => undefined,
        (e: unknown) => e as Error,
      );
    expect(theirs.stderr).toContain(`fatal: the object ${zero} does not exist`);
    expect(error?.message).toBe(`fatal: the object ${zero} does not exist`);
  });

  // ── --negotiate-only (t5702) ────────────────────────────────────────────────────────────

  /** t5702's setup_negotiate_only over a path. */
  function negotiateOnlySetup(): { server: string; client: string } {
    const dir = scenario("server");
    const server = join(dir, "server");
    testCommit(server, "one");
    testCommit(server, "two");
    const client = join(dir, "client");
    git(dir, "clone", "-q", `file://${server}`, client);
    testCommit(client, "three");
    return { server, client };
  }

  it(`t5702-protocol-v2.sh: "file:// --negotiate-only"`, async () => {
    const { server, client } = negotiateOnlySetup();
    const head = git(client, "rev-parse", "HEAD").trim();
    const theirs = gitRun(root, client, [
      "-c",
      "protocol.version=2",
      "fetch",
      "--no-tags",
      "--negotiate-only",
      `--negotiation-tip=${head}`,
      "origin",
    ]);
    expect(theirs.status, theirs.stderr).toBe(0);
    expect(theirs.stdout).toContain(git(server, "rev-parse", "two").trim());
    const ours = await oursAt(client);
    const result = await ours
      .fetch()
      .setRemote("origin")
      .setNegotiationTips(head)
      .setNegotiateOnly(true)
      .call();
    expect(result.exitCode ?? 0).toBe(0);
    expect([...(result.negotiatedCommits ?? [])].sort()).toEqual(
      theirs.stdout.split("\n").filter(Boolean).sort(),
    );
  });

  it(`t5702-protocol-v2.sh: "file:// --negotiate-only" (two tips: a round ends only when every tip reaches an acknowledged commit)`, async () => {
    // server: B, then A (main) and D (side) on it. client: 20 commits on side, dated before
    // A, and one on main, newest: the first round's haves get A acknowledged (B is common to
    // the negotiator), and D is acknowledged only in a later round
    const dir = scenario("server");
    const server = join(dir, "server");
    testCommit(server, "B");
    git(server, "checkout", "-q", "-b", "side");
    testCommit(server, "D");
    git(server, "checkout", "-q", "main");
    tick = 1500000000;
    testCommit(server, "A");
    const client = join(dir, "client");
    git(dir, "clone", "-q", "--no-tags", `file://${server}`, client);
    git(client, "checkout", "-q", "-b", "side", "origin/side");
    tick = 1200000000;
    for (let i = 1; i <= 20; i++) testCommit(client, `s${i}`);
    git(client, "checkout", "-q", "main");
    tick = 1600000000;
    testCommit(client, "m1");
    const tips = ["main", "side"].map((b) => git(client, "rev-parse", b).trim());
    const trace = join(root, `trace-${counter++}`);
    const theirs = gitRun(
      root,
      client,
      [
        "-c",
        "protocol.version=2",
        "fetch",
        "--negotiate-only",
        ...tips.map((t) => `--negotiation-tip=${t}`),
        "origin",
      ],
      { GIT_TRACE_PACKET: trace },
    );
    expect(theirs.status, theirs.stderr).toBe(0);
    const acked = theirs.stdout.split("\n").filter(Boolean).sort();
    expect(acked).toEqual(["A", "D"].map((n) => git(server, "rev-parse", n).trim()).sort());
    const ours = await oursAt(client);
    const result = await ours
      .fetch()
      .setRemote("origin")
      .setNegotiationTips(...tips)
      .setNegotiateOnly(true)
      .call();
    expect([...(result.negotiatedCommits ?? [])].sort()).toEqual(acked);
  });

  it(`t5702-protocol-v2.sh: "file:// --negotiate-only with protocol v0"`, async () => {
    const { client } = negotiateOnlySetup();
    const head = git(client, "rev-parse", "HEAD").trim();
    git(client, "config", "protocol.version", "0");
    const theirs = gitRun(root, client, [
      "fetch",
      "--no-tags",
      "--negotiate-only",
      `--negotiation-tip=${head}`,
      "origin",
    ]);
    expect(theirs.status).toBe(255);
    const ours = await oursAt(client);
    const result = await ours
      .fetch()
      .setRemote("origin")
      .setNegotiationTips(head)
      .setNegotiateOnly(true)
      .call();
    expect(result.exitCode).toBe(255);
    // the client's lines (native upload-pack, its child over the path, then dies with "the
    // remote end hung up unexpectedly" as the client leaves without a request)
    expect(result.messages).toEqual(
      theirs.stderr.split("\n").filter((l) => l.startsWith("warning: ")),
    );
    expect(result.messages).toEqual(["warning: --negotiate-only requires protocol v2"]);
  });

  // git 2.56 renamed --negotiation-tip --negotiation-restrict (the first title's at 2.56.1)
  it(`t5702-protocol-v2.sh: "usage: --negotiate-only without --negotiation-restrict", "usage: --negotiate-only with --recurse-submodules"`, async () => {
    const { client } = negotiateOnlySetup();
    const usage = async (
      args: string[],
      configure: (f: ReturnType<Git["fetch"]>) => ReturnType<Git["fetch"]>,
    ) => {
      const theirs = gitRun(root, client, ["-c", "protocol.version=2", "fetch", ...args]);
      expect(theirs.status).toBe(128);
      const ours = await oursAt(client);
      const error = await configure(
        ours
          .fetch()
          .setRemote("origin")
          .setNegotiateOnly(true)
          .setCompatibility(nativeIs243() ? "2.43" : "2.56"),
      )
        .call()
        .then(
          () => undefined,
          (e: unknown) => e as Error,
        );
      expect(error?.message).toBe(theirs.stderr.trimEnd());
    };
    await usage(["--negotiate-only", "origin"], (f) => f);
    await usage(["--negotiate-only", "--recurse-submodules", "origin"], (f) =>
      f.setRecurseSubmodules(true),
    );
  });

  // ── push.negotiate (t5516) ──────────────────────────────────────────────────────────────

  /**
   * t5516's setup: a repository with two commits of empty files, and an empty `testrepo`
   * given the first commit (hidden from receive-pack's advertisement) and a commit of its
   * own; the repository and a copy of testrepo for ours.
   */
  function pushSetup(): { repo: string; testrepo: string; mine: string; first: string } {
    const dir = scenario("repo", "testrepo");
    const repo = join(dir, "repo");
    writeFileSync(join(repo, "path1"), "");
    git(repo, "add", "path1");
    tick += 60;
    gitOut(root, repo, ["commit", "-q", "-m", "repo"], dated());
    const first = git(repo, "rev-parse", "HEAD").trim();
    writeFileSync(join(repo, "path2"), "");
    git(repo, "add", "path2");
    tick += 60;
    gitOut(root, repo, ["commit", "-q", "-m", "second"], dated());
    const testrepo = join(dir, "testrepo");
    git(repo, "push", "-q", testrepo, `${first}:refs/remotes/origin/first_commit`);
    testCommit(testrepo, "unrelated_commit");
    git(testrepo, "config", "receive.hideRefs", "refs/remotes/origin/first_commit");
    const mine = join(dir, "testrepo-ours");
    cpSync(testrepo, mine, { recursive: true });
    return { repo, testrepo, mine, first };
  }

  /** The objects native push wrote (trace2's `write_pack_file/wrote`), and its stderr. */
  function nativePush(repo: string, args: string[], extra: Record<string, string> = {}) {
    const event = join(root, `event-${counter++}`);
    const r = gitRun(root, repo, args, { GIT_TRACE2_EVENT: event, ...extra });
    expect(r.status, r.stderr).toBe(0);
    const wrote = /"category":"pack-objects","key":"write_pack_file\/wrote","value":"(\d+)"/.exec(
      readFileSync(event, "latin1"),
    )?.[1];
    return { wrote: wrote === undefined ? 0 : Number(wrote), stderr: r.stderr };
  }

  const PUSH_CASES: Array<[string, string[], number]> = [
    [`t5516-fetch-push.sh: "push without negotiation"`, ["-c", "protocol.version=2"], 5],
    [
      `t5516-fetch-push.sh: "push with negotiation"`,
      ["-c", "protocol.version=2", "-c", "push.negotiate=1"],
      2,
    ],
  ];
  for (const [title, config, objects] of PUSH_CASES) {
    it(title, async () => {
      const { repo, testrepo, mine } = pushSetup();
      const refspec = "refs/heads/main:refs/remotes/origin/main";
      const theirs = nativePush(repo, [...config, "push", testrepo, refspec]);
      expect(theirs.wrote).toBe(objects);
      // ours from a copy of the repository, its config as git's -c gave it
      const ourRepo = `${repo}-ours`;
      cpSync(repo, ourRepo, { recursive: true });
      for (let i = 0; i < config.length; i += 2) {
        const [key, value] = (config[i + 1] as string).split("=") as [string, string];
        git(ourRepo, "config", key, value);
      }
      const ours = await oursAt(ourRepo);
      const result = await ours.push().setRemote(mine).setRefSpecs(refspec).call();
      expect(result.objectCount).toBe(theirs.wrote);
      expect(git(mine, "rev-parse", "refs/remotes/origin/main")).toBe(
        git(testrepo, "rev-parse", "refs/remotes/origin/main"),
      );
    });
  }

  it(`t5516-fetch-push.sh: "push with negotiation proceeds anyway even if negotiation fails"`, async () => {
    const { repo, testrepo, mine } = pushSetup();
    git(repo, "config", "protocol.version", "0");
    git(repo, "config", "push.negotiate", "1");
    const ourRepo = `${repo}-ours`;
    cpSync(repo, ourRepo, { recursive: true });
    const refspec = "refs/heads/main:refs/remotes/origin/main";
    const theirs = nativePush(repo, ["push", testrepo, refspec]);
    expect(theirs.wrote).toBe(5);
    expect(theirs.stderr).toContain("push negotiation failed");
    const ours = await oursAt(ourRepo);
    const result = await ours.push().setRemote(mine).setRefSpecs(refspec).call();
    expect(result.objectCount).toBe(5);
    const warnings = theirs.stderr.split("\n").filter((l) => l.startsWith("warning: "));
    expect(result.warnings ?? []).toEqual(warnings);
  });

  // git 2.43 runs the negotiation even when nothing is pushed but deletions (its child dies
  // "--negotiate-only needs one or more --negotiation-tip=*"); 2.45 skips it, as ours does
  it.skipIf(nativeIs243())(`t5516-fetch-push.sh: "push deletion with negotiation"`, async () => {
    const { repo, first } = pushSetup();
    git(repo, "config", "push.negotiate", "1");
    for (const target of ["theirs", "ours"]) {
      const dest = join(root, `del-${target}-${counter++}`);
      git(root, "init", "-q", "-b", "main", dest);
      git(repo, "push", "-q", dest, `${first}:refs/heads/master`);
      if (target === "theirs") {
        const a = gitRun(root, repo, ["push", dest, ":master", `${first}:refs/heads/next`]);
        expect(a.status, a.stderr).toBe(0);
        expect(a.stderr).not.toContain("negotiate-only needs one or ");
        const b = gitRun(root, repo, ["push", dest, ":next"]);
        expect(b.stderr).not.toContain("negotiate-only needs one or ");
      } else {
        const ours = await oursAt(repo);
        const a = await ours
          .push()
          .setRemote(dest)
          .setRefSpecs(":master", `${first}:refs/heads/next`)
          .call();
        expect(a.warnings ?? []).toEqual([]);
        const b = await (await oursAt(repo)).push().setRemote(dest).setRefSpecs(":next").call();
        expect(b.warnings ?? []).toEqual([]);
      }
      expect(git(dest, "for-each-ref").trim()).toBe("");
    }
  });
});
