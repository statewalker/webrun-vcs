/**
 * The flags of `git fetch` that change what it writes and prints, against native git:
 * `-f`/`--force`, `--update-head-ok`, `--append`, `--dry-run`, `--atomic`, `--porcelain`,
 * `--[no-]write-fetch-head` and `--set-upstream`. Each case builds two clones of one
 * repository (native, ours), runs `git fetch` with the flags in one and our `FetchCommand`
 * with the matching setters in the other, then compares the refs, FETCH_HEAD, the ref lines
 * (stderr, or stdout for `--porcelain`) and whether the fetch failed. The remotes are local
 * paths (git's local transport; ours serves upload-pack in process).
 *
 * Sources: t5510-fetch.sh (`--atomic`, `--append`, `--update-head-ok`, `--dry-run`,
 * `--no-write-fetch-head`), t5574-fetch-output.sh (`--porcelain`), t5553-set-upstream.sh.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RefTransactionAbortedError } from "@statewalker/vcs-core";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type FetchCommand,
  type FetchResult,
  type Git,
  RefUpdateStatus,
  TagOption,
} from "../src/index.js";
import {
  hookExit,
  hookLines,
  hookLog,
  hookTwins,
  installHooks,
  nativeIn,
  nativeIs25x,
  oursIn,
} from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/** Our working copy over `<root>/<name>`, its FilesApi rooted at `root` (the remotes beside it). */
async function ours(name: string): Promise<Git> {
  return openOurs(root, createNodeGitHostEnvironment({ env: testEnv(root) }), undefined, name);
}

/** git 2.48+ writes `refs/remotes/<name>/HEAD` on a fetch (followRemoteHEAD); ours does too */
const followsRemoteHead = (() => {
  if (!nativeGitAvailable()) return false;
  const m = /git version (\d+)\.(\d+)/.exec(gitOut("/", "/", ["--version"]));
  return !!m && (Number(m[1]) > 2 || Number(m[2]) >= 48);
})();

/** The native git's version, as our compatibility */
const compatibility: "2.43" | "2.56" = (() => {
  if (!nativeGitAvailable()) return "2.56";
  const m = /git version (\d+)\.(\d+)/.exec(gitOut("/", "/", ["--version"]));
  return m && (Number(m[1]) > 2 || Number(m[2]) >= 50) ? "2.56" : "2.43";
})();

/** The refs (before git 2.48 without the remote HEAD, which ours writes as 2.48+ does). */
const refs = (dir: string) =>
  git(join(root, dir), "for-each-ref", "--format=%(refname) %(objectname)")
    .split("\n")
    .filter((l) => followsRemoteHead || !/^refs\/remotes\/[^/]+\/HEAD /.test(l))
    .join("\n");

/** FETCH_HEAD, or null when there is none. */
const fetchHead = (dir: string) => {
  const path = join(root, dir, ".git/FETCH_HEAD");
  return existsSync(path) ? readFileSync(path, "utf8") : null;
};

/** The display lines git prints, without progress lines. */
const displayOf = (text: string) =>
  text.split("\n").filter((l) => l !== "" && !/^(remote: |Unpacking|Receiving|Resolving)/.test(l));

/** Whether our fetch failed as git's exits non-zero: a refused ref or a reported error. */
const oursFailed = (r: FetchResult) =>
  r.trackingRefUpdates.some((u) => u.status === RefUpdateStatus.REJECTED) ||
  (r.errors?.length ?? 0) > 0;

/**
 * `src` (with a work tree) after the changes, `preseed.git` its mirror before them, as
 * t5574's setup: `fast-forward` moves on, `force-updated` is rewritten, `deleted-branch`
 * goes, `new-branch` comes.
 */
function setupUpstream(): void {
  const src = join(root, "src");
  mkdirSync(src);
  git(src, "init", "-q", "-b", "main");
  putFile(src, "a.txt", "a\n");
  git(src, "add", "a.txt");
  git(src, "commit", "-qm", "base");
  git(src, "tag", "-a", "-m", "v1", "v1");
  git(src, "branch", "fast-forward");
  git(src, "branch", "deleted-branch");
  git(src, "checkout", "-q", "-b", "force-updated");
  putFile(src, "f.txt", "old\n");
  git(src, "add", "f.txt");
  git(src, "commit", "-qm", "force-update-old");
  git(src, "checkout", "-q", "main");
  git(root, "clone", "-q", "--mirror", src, join(root, "preseed.git"));

  git(src, "branch", "new-branch");
  git(src, "branch", "-D", "deleted-branch");
  git(src, "checkout", "-q", "fast-forward");
  putFile(src, "ff.txt", "ff\n");
  git(src, "add", "ff.txt");
  git(src, "commit", "-qm", "fast-forward-new");
  git(src, "tag", "atomic-mixed-tag");
  git(src, "checkout", "-q", "force-updated");
  git(src, "reset", "-q", "--hard", "HEAD~");
  putFile(src, "f.txt", "new\n");
  git(src, "add", "f.txt");
  git(src, "commit", "-qm", "force-update-new");
  git(src, "checkout", "-q", "main");
}

const SEED = ["refs/heads/*:refs/unforced/*", "+refs/heads/*:refs/forced/*"];

/**
 * Two clones of `preseed.git` (native `n<k>`, ours `o<k>`) with `seed` refspecs fetched,
 * their `origin` then pointed at `../src` (t5574: "Change the URL of the repository").
 */
function twins(seed: string[] = []): [string, string] {
  const names: [string, string] = [`n${counter}`, `o${counter}`];
  counter++;
  for (const name of names) {
    git(root, "clone", "-q", join(root, "preseed.git"), name);
    if (seed.length > 0) git(join(root, name), "fetch", "-q", "origin", ...seed);
    git(join(root, name), "remote", "set-url", "origin", "../src");
  }
  return names;
}

/**
 * Native `git fetch <args>` in `n`, ours (`configure` on a FetchCommand) in `o`; the refs,
 * FETCH_HEAD, the display lines and the failure compared. `porcelain`: the lines are on
 * stdout and stderr holds only the errors (`FetchResult.errors`).
 */
async function expectFetchTwins(
  [n, o]: [string, string],
  args: string[],
  configure: (fetch: FetchCommand) => FetchCommand,
  porcelain = false,
): Promise<{ native: ReturnType<typeof gitRun>; result: FetchResult }> {
  const native = gitRun(root, join(root, n), ["fetch", ...args]);
  const result = await configure((await ours(o)).fetch().setCompatibility(compatibility)).call();
  expect(refs(o), `refs after fetch ${args.join(" ")}`).toBe(refs(n));
  expect(fetchHead(o), "FETCH_HEAD").toBe(fetchHead(n));
  const errors = (result.errors ?? []).map((e) => `error: ${e}`);
  if (porcelain) {
    expect(result.display ?? []).toEqual(displayOf(native.stdout));
    // nothing else on stderr but the errors
    expect(native.stderr).toBe(errors.map((e) => `${e}\n`).join(""));
  } else {
    const lines = native.stderr.split("\n").filter((l) => l !== "");
    expect(result.display ?? []).toEqual(
      displayOf(native.stderr).filter((l) => !l.startsWith("error: ")),
    );
    expect(errors).toEqual(lines.filter((l) => l.startsWith("error: ")));
  }
  expect(oursFailed(result), `failed (${native.stderr})`).toBe(native.status !== 0);
  return { native, result };
}

describeGit("git fetch flags: as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fetch-flags-"));
    setupUpstream();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  // the unforced namespace of t5574's porcelain test, printed in full: a refused
  // non-fast-forward, the rest written; -f forces it
  it('-f/--force, t5574-fetch-output.sh: "fetch porcelain output"', async () => {
    const plain = twins(SEED);
    await expectFetchTwins(plain, ["origin", SEED[0]], (f) =>
      f.setRemote("origin").setRefSpecs(SEED[0]),
    );
    for (const force of ["-f", "--force"]) {
      const forced = twins(SEED);
      await expectFetchTwins(forced, [force, "origin", SEED[0]], (f) =>
        f.setRemote("origin").setRefSpecs(SEED[0]).setForceUpdate(true),
      );
    }
  });

  // dry run first, as the t/ test runs it
  for (const atomic of [false, true]) {
    it(`t5574-fetch-output.sh: "fetch porcelain output ${atomic ? "(atomic)" : ""}"`, async () => {
      const pair = twins(SEED);
      const opt = atomic ? ["--atomic"] : [];
      for (const dryRun of [true, false]) {
        await expectFetchTwins(
          pair,
          [...opt, "--porcelain", ...(dryRun ? ["--dry-run"] : []), "--prune", "origin", ...SEED],
          (f) =>
            f
              .setRemote("origin")
              .setRefSpecs(...SEED)
              .setAtomic(atomic)
              .setPorcelain(true)
              .setDryRun(dryRun)
              .setRemoveDeletedRefs(true),
          true,
        );
      }
    });
  }

  it('t5574-fetch-output.sh: "fetch porcelain output with HEAD"', async () => {
    const pair = twins();
    for (const spec of ["HEAD", "HEAD:foo"]) {
      for (const dryRun of [true, false]) {
        await expectFetchTwins(
          pair,
          ["--porcelain", ...(dryRun ? ["--dry-run"] : []), "origin", spec],
          (f) => f.setRemote("origin").setRefSpecs(spec).setPorcelain(true).setDryRun(dryRun),
          true,
        );
      }
    }
  });

  // a dry run prints what a fetch prints, writes nothing
  it('t5574-fetch-output.sh: "fetch output with HEAD"', async () => {
    const pair = twins(SEED);
    await expectFetchTwins(pair, ["--dry-run", "--prune", "origin"], (f) =>
      f.setRemote("origin").setDryRun(true).setRemoveDeletedRefs(true),
    );
    await expectFetchTwins(pair, ["--dry-run", "origin", "HEAD:foo"], (f) =>
      f.setRemote("origin").setRefSpecs("HEAD:foo").setDryRun(true),
    );
  });

  it('t5510-fetch.sh: "fetch --atomic --append appends to FETCH_HEAD"', async () => {
    const pair = twins();
    await expectFetchTwins(pair, ["origin", "fast-forward"], (f) =>
      f.setRemote("origin").setRefSpecs("fast-forward"),
    );
    await expectFetchTwins(pair, ["--append", "origin", "new-branch"], (f) =>
      f.setRemote("origin").setRefSpecs("new-branch").setAppend(true),
    );
    await expectFetchTwins(pair, ["--atomic", "--append", "origin"], (f) =>
      f.setRemote("origin").setAtomic(true).setAppend(true),
    );
  });

  // an existing FETCH_HEAD is left as it was too
  it('t5510-fetch.sh: "--no-write-fetch-head does not touch FETCH_HEAD, and does not print what would be written"', async () => {
    const pair = twins();
    await expectFetchTwins(pair, ["origin", "main"], (f) =>
      f.setRemote("origin").setRefSpecs("main"),
    );
    await expectFetchTwins(pair, ["--no-write-fetch-head", "origin"], (f) =>
      f.setRemote("origin").setWriteFetchHead(false),
    );
    const fresh = twins();
    await expectFetchTwins(fresh, ["--no-write-fetch-head", "origin", "main"], (f) =>
      f.setRemote("origin").setRefSpecs("main").setWriteFetchHead(false),
    );
    expect(fetchHead(fresh[1])).toBeNull();
  });

  // with --prune: the deletions wait in the one transaction too
  it('t5510-fetch.sh: "fetch --atomic aborts with non-fast-forward update"', async () => {
    const pair = twins(SEED);
    await expectFetchTwins(pair, ["--atomic", "--prune", "origin", SEED[0]], (f) =>
      f.setRemote("origin").setRefSpecs(SEED[0]).setAtomic(true).setRemoveDeletedRefs(true),
    );
    expect(fetchHead(pair[1])).toBe("");
    await expectFetchTwins(pair, ["--atomic", "--prune", "origin"], (f) =>
      f.setRemote("origin").setAtomic(true).setRemoveDeletedRefs(true),
    );
  });

  // after t5510-fetch.sh: "refuse to fetch into the current branch"
  it('t5510-fetch.sh: "fetch into the current branch with --update-head-ok"', async () => {
    const [n, o] = twins();
    const native = gitRun(root, join(root, n), ["fetch", "origin", "fast-forward:main"]);
    expect(native.status).toBe(128);
    await expect(
      (await ours(o)).fetch().setRemote("origin").setRefSpecs("fast-forward:main").call(),
    ).rejects.toThrow(
      native.stderr
        .trim()
        .replace(join(root, n), join(root, o))
        .replace(/^fatal: /, ""),
    );
    expect(refs(o)).toBe(refs(n));
    expect(fetchHead(o)).toBe(fetchHead(n));
    await expectFetchTwins([n, o], ["--update-head-ok", "origin", "fast-forward:main"], (f) =>
      f.setRemote("origin").setRefSpecs("fast-forward:main").setUpdateHeadOk(true),
    );
  });

  it('t5510-fetch.sh: "fetch --dry-run does not touch FETCH_HEAD, but still prints what would be written"', async () => {
    const pair = twins();
    await expectFetchTwins(pair, ["--dry-run", "../src"], (f) =>
      f.setRemote("../src").setDryRun(true),
    );
    expect(fetchHead(pair[1])).toBeNull();
  });

  it('t5510-fetch.sh: "--write-fetch-head gets defeated by --dry-run"', async () => {
    const pair = twins();
    await expectFetchTwins(pair, ["--dry-run", "--write-fetch-head", "../src"], (f) =>
      f.setRemote("../src").setDryRun(true).setWriteFetchHead(true),
    );
    expect(fetchHead(pair[1])).toBeNull();
  });

  it('t5510-fetch.sh: "fetch --atomic works with mixed branches and tags"', async () => {
    const pair = twins();
    await expectFetchTwins(pair, ["--tags", "--atomic", "origin"], (f) =>
      f.setRemote("origin").setTagOpt(TagOption.FETCH_TAGS).setAtomic(true),
    );
  });
});

/** `branch.*` of a repository, as `git config --get-regexp` lists them. */
const branchConfig = (dir: string) =>
  gitRun(root, join(root, dir), ["config", "--get-regexp", "^branch\\."]).stdout;

/** The warning lines of a native stderr (a warning's own continuation lines too). */
const warningsOf = (stderr: string) =>
  stderr.split("\n").filter((l) => l.startsWith("warning: ") || l.startsWith("you need "));

describeGit("git fetch --set-upstream: as native git (t5553-set-upstream.sh)", () => {
  /** `work` with `main` and `other` pushed to the bare `parent`, its remote `upstream`. */
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fetch-set-upstream-"));
    const work = join(root, "work");
    mkdirSync(work);
    git(work, "init", "-q", "-b", "main");
    // t5553 runs with GIT_TEST_DEFAULT_INITIAL_BRANCH_NAME=main
    git(root, "init", "-q", "--bare", "-b", "main", join(root, "parent"));
    git(work, "remote", "add", "upstream", "../parent");
    putFile(work, "one.t", "one\n");
    git(work, "add", "one.t");
    git(work, "commit", "-qm", "one");
    git(work, "push", "-q", "upstream", "main");
    git(work, "checkout", "-q", "-b", "other");
    putFile(work, "two.t", "two\n");
    git(work, "add", "two.t");
    git(work, "commit", "-qm", "two");
    git(work, "push", "-q", "upstream", "other");
    git(work, "checkout", "-q", "main");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Copies of `work` (native, ours), `prepare` run in each. */
  function pair(prepare: (dir: string) => void = () => {}): [string, string] {
    const names: [string, string] = [`n${counter}`, `o${counter}`];
    counter++;
    for (const name of names) {
      execFileSync("cp", ["-a", join(root, "work"), join(root, name)]);
      prepare(join(root, name));
    }
    return names;
  }

  /** `git fetch --set-upstream <args>` against ours: the config, refs and warnings. */
  async function expectSetUpstream(
    [n, o]: [string, string],
    args: string[],
    configure: (fetch: FetchCommand) => FetchCommand,
  ): Promise<void> {
    const native = gitRun(root, join(root, n), ["fetch", "--set-upstream", ...args]);
    let messages: string[] = [];
    let failed = false;
    try {
      const result = await configure(
        (await ours(o)).fetch().setCompatibility(compatibility).setSetUpstream(true),
      ).call();
      messages = result.messages;
    } catch {
      failed = true;
    }
    expect(failed, native.stderr).toBe(native.status !== 0);
    expect(branchConfig(o)).toBe(branchConfig(n));
    expect(refs(o)).toBe(refs(n));
    expect(messages.filter((m) => m.startsWith("warning: ") || m.startsWith("you need "))).toEqual(
      warningsOf(native.stderr),
    );
  }

  it('t5553-set-upstream.sh: "fetch --set-upstream does not set upstream w/o branch"', async () => {
    await expectSetUpstream(pair(), ["upstream"], (f) => f.setRemote("upstream"));
  });

  it('t5553-set-upstream.sh: "fetch --set-upstream upstream main sets branch main but not other"', async () => {
    await expectSetUpstream(pair(), ["upstream", "main"], (f) =>
      f.setRemote("upstream").setRefSpecs("main"),
    );
  });

  it('t5553-set-upstream.sh: "fetch --set-upstream upstream other sets branch other"', async () => {
    const twins = pair((d) => {
      git(d, "config", "branch.main.remote", "upstream");
      git(d, "config", "branch.main.merge", "refs/heads/main");
      git(d, "config", "branch.main.autoSetupRebase", "always");
    });
    await expectSetUpstream(twins, ["upstream", "other"], (f) =>
      f.setRemote("upstream").setRefSpecs("other"),
    );
  });

  it('t5553-set-upstream.sh: "fetch --set-upstream main:other does not set the branch other2"', async () => {
    await expectSetUpstream(pair(), ["upstream", "main:other2"], (f) =>
      f.setRemote("upstream").setRefSpecs("main:other2"),
    );
  });

  it('t5553-set-upstream.sh: "fetch --set-upstream ./does-not-exist fails with invalid url"', async () => {
    const twins = pair((d) => {
      git(d, "config", "branch.main.remote", "upstream");
      git(d, "config", "branch.main.merge", "refs/heads/other");
    });
    await expectSetUpstream(twins, ["./does-not-exist"], (f) => f.setRemote("./does-not-exist"));
  });

  it('t5553-set-upstream.sh: "fetch --set-upstream with valid URL sets upstream to URL"', async () => {
    const url = `file://${join(root, "parent")}`;
    // branch.autoSetupRebase applies, as install_branch_config writes it
    const twins = pair((d) => git(d, "config", "branch.autoSetupRebase", "remote"));
    await expectSetUpstream(twins, [url], (f) => f.setRemote(url));
  });

  it('t5553-set-upstream.sh: "fetch --set-upstream with a detached HEAD"', async () => {
    const twins = pair((d) => git(d, "checkout", "-q", "HEAD^0"));
    await expectSetUpstream(twins, ["upstream", "main"], (f) =>
      f.setRemote("upstream").setRefSpecs("main"),
    );
  });

  // the warnings of fetch.c's other refusals, and a dry run (which sets it too)
  it("several refs, a tag, a dry run", async () => {
    git(join(root, "work"), "tag", "three");
    git(join(root, "work"), "push", "-q", "upstream", "three");
    await expectSetUpstream(pair(), ["upstream", "main", "other"], (f) =>
      f.setRemote("upstream").setRefSpecs("main", "other"),
    );
    await expectSetUpstream(pair(), ["upstream", "refs/tags/three"], (f) =>
      f.setRemote("upstream").setRefSpecs("refs/tags/three"),
    );
    await expectSetUpstream(pair(), ["--dry-run", "upstream", "other"], (f) =>
      f.setRemote("upstream").setRefSpecs("other").setDryRun(true),
    );
  });
});

describeGit("git fetch --atomic: the reference-transaction hook, as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fetch-atomic-hooks-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /**
   * A repository fetching from `up.git` inside it (so each twin has its own copy), with
   * `extra` branches and tags added upstream after a first fetch, and the logging hook.
   */
  function repository(name: string, extra: { branches?: string[]; tags?: string[] }): string {
    const dir = join(root, name);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    putFile(dir, "a.txt", "a\n");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-qm", "base");
    git(dir, "clone", "-q", "--bare", ".", "up.git");
    git(dir, "remote", "add", "origin", "up.git");
    git(dir, "fetch", "-q", "origin");
    for (const b of extra.branches ?? []) git(join(dir, "up.git"), "branch", b, "main");
    for (const t of extra.tags ?? []) git(join(dir, "up.git"), "tag", t, "main");
    installHooks(join(dir, ".git/hooks"), ["reference-transaction"]);
    return dir;
  }

  async function expectHookTwins(dir: string, args: string[], refuse = false): Promise<void> {
    const [theirs, mine] = hookTwins(root, dir);
    if (refuse) {
      hookExit(theirs, "reference-transaction", 1);
      hookExit(mine, "reference-transaction", 1);
    }
    const native = nativeIn(theirs, root, ["fetch", ...args]);
    const fetch = (await oursIn(mine)).fetch().setRemote("origin");
    if (args.includes("--atomic")) fetch.setAtomic(true);
    if (args.includes("--tags")) fetch.setTagOpt(TagOption.FETCH_TAGS);
    if (args.includes("--prune")) fetch.setRemoveDeletedRefs(true);
    if (args.includes("--dry-run")) fetch.setDryRun(true);
    let result: FetchResult | undefined;
    let error: Error | undefined;
    try {
      result = await fetch.call();
    } catch (e) {
      error = e as Error;
    }
    expect(hookLog(mine)).toBe(hookLog(theirs));
    expect(hookLines(fetch.getHookOutput())).toBe(hookLines(native.stderr));
    const refsOf = (d: string) =>
      git(d, "for-each-ref", "--format=%(refname) %(objectname)")
        .split("\n")
        .filter((l) => followsRemoteHead || !/^refs\/remotes\/[^/]+\/HEAD /.test(l))
        .join("\n");
    expect(refsOf(mine.dir)).toBe(refsOf(theirs.dir));
    const head = (d: string) => {
      const path = join(d, ".git/FETCH_HEAD");
      return existsSync(path) ? readFileSync(path, "utf8") : null;
    };
    expect(head(mine.dir)).toBe(head(theirs.dir));
    if (error) {
      // the refusing hook: git dies
      expect(error).toBeInstanceOf(RefTransactionAbortedError);
      expect(native.status).toBe(128);
      expect(native.stderr).toContain(`fatal: ${error.message}`);
      return;
    }
    if (!result) throw new Error("no result");
    expect(oursFailed(result), native.stderr).toBe(native.status !== 0);
    const errors = (result.errors ?? []).map((e) => `error: ${e}`);
    expect(errors).toEqual(native.stderr.split("\n").filter((l) => l.startsWith("error: ")));
  }

  it('t5510-fetch.sh: "fetch --atomic executes a single reference transaction only"', async () => {
    const dir = repository("single", { branches: ["atomic-hooks-1", "atomic-hooks-2"] });
    await expectHookTwins(dir, ["--atomic", "origin"]);
  });

  it('t5510-fetch.sh: "fetch --atomic aborts all reference updates if hook aborts"', async () => {
    const dir = repository("abort", {
      branches: ["atomic-hooks-abort-1", "atomic-hooks-abort-2", "atomic-hooks-abort-3"],
      tags: ["atomic-hooks-abort"],
    });
    await expectHookTwins(dir, ["--tags", "--atomic", "origin"], true);
  });

  // without --atomic: one transaction allowing failures in 2.5x, one per ref in 2.43
  it("a fetch without --atomic", async () => {
    const dir = repository("plain", { branches: ["plain-1", "plain-2"], tags: ["plain-tag"] });
    await expectHookTwins(dir, ["--tags", "origin"]);
  });

  // statewalker/webrun-vcs#340: a fetch with nothing to update still commits its transaction,
  // empty (2.5x: always, the dry run too; 2.43: only --atomic's)
  for (const args of [
    ["origin"],
    ["--atomic", "origin"],
    ["--prune", "origin"],
    ["--atomic", "--prune", "origin"],
    ["--dry-run", "origin"],
  ]) {
    it(`a fetch updating no ref: fetch ${args.join(" ")}`, async () => {
      const dir = repository(`noop-${args.join("").replace(/-/g, "")}`, {});
      await expectHookTwins(dir, args);
    });
  }
});

// git 2.5x only: 2.43's set_head writes no symbolic ref in a transaction (and fetch has none)
describe.skipIf(!nativeGitAvailable() || process.platform !== "linux" || !nativeIs25x)(
  "git fetch: a hook refusing the create-only transaction of the remote HEAD, as native git",
  () => {
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "fetch-head-hook-"));
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it("the hook hears preparing, then aborted, and the fetch dies (refs.c)", async () => {
      const dir = join(root, "r");
      mkdirSync(dir);
      git(dir, "init", "-q", "-b", "main");
      putFile(dir, "a.txt", "a\n");
      git(dir, "add", "a.txt");
      git(dir, "commit", "-qm", "base");
      git(dir, "clone", "-q", "--bare", ".", "up.git");
      git(dir, "remote", "add", "origin", "up.git");
      // refs/remotes/origin/HEAD exists after this first fetch (followRemoteHEAD)
      git(dir, "fetch", "-q", "origin");
      git(join(dir, "up.git"), "branch", "new-branch", "main");
      // a hook refusing only the symbolic ref's transaction
      const hook = join(dir, ".git/hooks/reference-transaction");
      writeFileSync(
        hook,
        '#!/bin/sh\ninput=$(cat)\nprintf "== %s\\n%s\\n" "$1" "$input" >> "$HOOK_LOG"\ncase "$input" in *ref:*) exit 1;; esac\nexit 0\n',
      );
      chmodSync(hook, 0o755);
      const [theirs, mine] = hookTwins(root, dir);
      const native = nativeIn(theirs, root, ["fetch", "origin"]);
      let error: Error | undefined;
      try {
        await (await oursIn(mine)).fetch().setRemote("origin").call();
      } catch (e) {
        error = e as Error;
      }
      expect(native.status).toBe(128);
      expect(error).toBeInstanceOf(RefTransactionAbortedError);
      expect(native.stderr).toContain(`fatal: ${error?.message}`);
      expect(hookLog(theirs)).toMatch(
        /== preparing\n0+ ref:refs\/remotes\/origin\/main refs\/remotes\/origin\/HEAD\n== aborted\n/,
      );
      expect(hookLog(mine)).toBe(hookLog(theirs));
      const refsOf = (d: string) => git(d, "for-each-ref", "--format=%(refname) %(objectname)");
      expect(refsOf(mine.dir)).toBe(refsOf(theirs.dir));
      const head = (d: string) => readFileSync(join(d, ".git/FETCH_HEAD"), "utf8");
      expect(head(mine.dir)).toBe(head(theirs.dir));
    });
  },
);
