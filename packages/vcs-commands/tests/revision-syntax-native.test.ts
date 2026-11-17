/**
 * git's revision syntax against native `git rev-parse --verify`: one repository built by
 * native git, every revision resolved by both (the id on stdout, or the exact `fatal:`
 * line; `warning:` lines compared too). Reflog entries are dated relative to now, so
 * `@{<date>}` lookups land between them for both.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { approxidateCareful } from "../src/commands/git-date.js";
import { Git, ResetMode } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;

/** git's environment, with both dates `hoursAgo` hours before now. */
const envAt = (hoursAgo?: number) => {
  const env = nativeGitEnv(home);
  if (hoursAgo === undefined) return env;
  const date = `${NOW - Math.round(hoursAgo * HOUR)} +0000`;
  return { ...env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
};
const run = (cwd: string, hoursAgo: number | undefined, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: envAt(hoursAgo),
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/**
 * `origin` (main: c1, c2 "second commit"); `repo`, its clone: main gets c3, c4 ("fix
 * typo"); `feat` (f1) from main; back on main; tags `v1` (lightweight) and `va`
 * (annotated) at c3; a branch `loc` tracking main (`remote = .`); a conflict-free index.
 */
function build(base: string): string {
  mkdirSync(base, { recursive: true });
  const origin = join(base, "origin");
  run(base, 11, "init", "-q", "-b", "main", "origin");
  put(origin, "a.txt", "a\n");
  run(origin, 10, "add", ".");
  run(origin, 10, "commit", "-qm", "c1");
  put(origin, "d/b.txt", "b\n");
  run(origin, 8, "add", ".");
  run(origin, 8, "commit", "-qm", "second commit");
  run(base, 7, "clone", "-q", "origin", "repo");
  const repo = join(base, "repo");
  put(repo, "a.txt", "a\nthree\n");
  run(repo, 5, "commit", "-qam", "c3");
  run(repo, 5, "tag", "v1");
  run(repo, 5, "tag", "-a", "-m", "annotated", "va");
  put(repo, "a.txt", "a\nthree\nfour\n");
  run(repo, 3, "commit", "-qam", "fix typo\n\nbody line");
  run(repo, 2, "checkout", "-q", "-b", "feat");
  put(repo, "f.txt", "f\n");
  run(repo, 1, "add", ".");
  run(repo, 1, "commit", "-qm", "f1");
  run(repo, 0.5, "checkout", "-q", "main");
  run(repo, 0.5, "branch", "--track", "loc", "main");
  return repo;
}

async function open(repo: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: nativeGitEnv(home) });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** `git rev-parse --verify <rev>` by native git and by ours: status, stdout, stderr. */
async function expectSameResolution(repo: string, revs: string[]): Promise<void> {
  const git = await open(repo);
  for (const rev of revs) {
    const n = spawnSync("git", ["rev-parse", "--verify", rev], {
      cwd: repo,
      env: envAt(),
      encoding: "latin1",
    });
    let ours: { status: number; out: string; err: string };
    try {
      const r = await git.revParse().setRevision(rev).call();
      ours = {
        status: 0,
        out: `${r.objectId}\n`,
        err: r.warnings.map((w) => `${w}\n`).join(""),
      };
    } catch (error) {
      ours = { status: 128, out: "", err: `${(error as Error).message}\n` };
    }
    expect([rev, ours]).toEqual([rev, { status: n.status, out: n.stdout, err: n.stderr }]);
  }
}

describeGit("revision syntax, native rev-parse --verify", () => {
  let repo = "";
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "revision-native-"));
    home = join(root, "home");
    mkdirSync(home);
    repo = build(join(root, "base"));
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("refs, ids, @, ~ and ^, peeling, <rev>:<path> and index paths", async () => {
    const head = run(repo, undefined, "rev-parse", "HEAD").trim();
    await expectSameResolution(repo, [
      "HEAD",
      "@",
      "@~1",
      "@^",
      "HEAD~2",
      "main^0",
      "main^2",
      "HEAD~9",
      head,
      `${head}~1`,
      "origin/main",
      "origin",
      "refs/heads/feat",
      "heads/feat",
      "v1",
      "va",
      "va^{}",
      "va^{tag}",
      "va^{commit}",
      "va^{tree}",
      "va^{object}",
      "va~1",
      "v1^{tag}",
      "HEAD^{tree}",
      "HEAD^{blob}",
      "HEAD^{tree}^{commit}",
      "HEAD:a.txt",
      "HEAD:d",
      "HEAD:d/b.txt",
      "HEAD:",
      "HEAD:./a.txt",
      "HEAD:nope",
      "HEAD~1:a.txt",
      "va:a.txt",
      ":a.txt",
      ":0:a.txt",
      ":./d/b.txt",
      ":2:a.txt",
      ":nope",
      "nope",
    ]);
  });

  it("commit message searches: :/<regex>, <rev>^{/<regex>}, !- and !!", async () => {
    await expectSameResolution(repo, [
      ":/c1",
      ":/^c",
      ":/typo$",
      ":/body",
      ":/^(f1|c3)",
      ":/second.commit",
      ":/!-c",
      ":/!!x",
      ":/!x",
      ":/nothing matches",
      ":/(",
      "HEAD^{/c}",
      "HEAD^{/second}",
      "HEAD~1^{/typo}",
      "feat^{/}",
      "va^{/c1}",
      "HEAD^{/zzz}",
    ]);
  });

  it("@{upstream}, @{u}, <branch>@{u}, @{push} and @{-N}", async () => {
    await expectSameResolution(repo, [
      "@{u}",
      "@{U}",
      "@{upstream}",
      "@{UpStream}",
      "main@{u}",
      "HEAD@{u}",
      "loc@{u}",
      "loc@{upstream}~1",
      "feat@{u}",
      "nosuch@{u}",
      "@{push}",
      "main@{push}",
      "@{push}^{tree}",
      "loc@{push}",
      "feat@{push}",
      "@{-1}",
      "@{-1}~1",
      "@{-2}",
      "@{-9}",
      "@{-1}@{u}",
      "@{u}@{1}",
    ]);
  });

  it("@{push} as push.default, remote.pushDefault, pushRemote and push refspecs say", async () => {
    const configs: string[][][] = [
      [["push.default", "upstream"]],
      [["push.default", "current"]],
      [["push.default", "matching"]],
      [["push.default", "nothing"]],
      [["push.default", "tracking"]],
      [["remote.pushDefault", "other"]],
      [["branch.main.pushRemote", "origin"]],
      [["remote.origin.push", "refs/heads/main:refs/heads/pushed"]],
      [["remote.origin.push", "refs/heads/nothere:refs/heads/x"]],
      [["remote.origin.mirror", "true"]],
    ];
    for (const config of configs) {
      for (const [key, value] of config) run(repo, undefined, "config", key ?? "", value ?? "");
      await expectSameResolution(repo, ["@{push}", "loc@{push}", "feat@{push}"]);
      for (const [key] of config) run(repo, undefined, "config", "--unset", key ?? "");
    }
    // `remote = .` upstream of a branch that tracks a local branch
    run(repo, undefined, "config", "push.default", "upstream");
    await expectSameResolution(repo, ["loc@{push}"]);
    run(repo, undefined, "config", "--unset", "push.default");
  });

  it("detached HEAD: @{u} and @{push} refused as git refuses them", async () => {
    run(repo, 0.4, "checkout", "-q", "--detach", "HEAD");
    try {
      await expectSameResolution(repo, ["@{u}", "@{push}", "HEAD@{u}", "main@{u}", "@{1}"]);
    } finally {
      run(repo, 0.3, "checkout", "-q", "main");
    }
  });

  it("<ref>@{<n>}, @{<n>}, HEAD@{<n>}, and the log running out", async () => {
    await expectSameResolution(repo, [
      "main@{0}",
      "main@{1}",
      "main@{2}",
      "main@{3}",
      "main@{9}",
      "@{0}",
      "@{1}",
      "@{2}",
      "HEAD@{0}",
      "HEAD@{1}",
      "HEAD@{3}",
      "HEAD@{30}",
      "feat@{1}",
      "feat@{2}",
      "feat@{1}~1",
      "feat@{1}^{tree}",
      "origin/main@{0}",
      "origin/main@{1}",
      "v1@{0}",
      "v1@{1}",
      "loc@{0}",
    ]);
  });

  it("<ref>@{<date>}: approxidate, seconds, and a log that does not go back far enough", async () => {
    await expectSameResolution(repo, [
      "main@{4.hours.ago}",
      "main@{4 hours ago}",
      "main@{6.hours.ago}",
      "main@{9.hours.ago}",
      "main@{yesterday}",
      "main@{1.year.ago}",
      "main@{now}",
      "@{2.hours.ago}",
      "HEAD@{90.minutes.ago}",
      "feat@{now}",
      `main@{${NOW - 4 * HOUR}}`,
      `main@{${NOW - 3 * HOUR}}`,
      "main@{blah}",
      "main@{last.week}",
      "main@{2 days ago}",
    ]);
  });
});

describeGit("revision syntax in commands, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "revision-commands-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const lastHeadLine = (repo: string) => {
    const log = run(repo, undefined, "reflog", "-1", "--format=%gs").trim();
    const head = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], {
      cwd: repo,
      encoding: "latin1",
    });
    return { log, head: head.stdout || run(repo, undefined, "rev-parse", "HEAD") };
  };
  const failure = (repo: string, ...args: string[]) =>
    spawnSync("git", args, { cwd: repo, env: envAt(), encoding: "latin1" }).stderr.trimEnd();
  const message = async (call: () => Promise<unknown>) => {
    try {
      await call();
    } catch (error) {
      return (error as Error).message;
    }
    return "";
  };

  it("switch / checkout / reset take @{u}, <branch>@{u} and @{push}", async () => {
    const native = build(join(root, "n"));
    const ours = build(join(root, "o"));
    let git = await open(ours);
    // a remote-tracking branch is not a branch to switch to
    expect(await message(() => git.switch().setName("@{u}").call())).toBe(
      failure(native, "switch", "@{u}"),
    );
    // no upstream: git's fatal line
    expect(await message(() => git.switch().setName("feat@{u}").call())).toBe(
      failure(native, "switch", "feat@{u}"),
    );
    // loc tracks main (remote = .): loc@{u} is the branch main
    run(native, 0.2, "checkout", "-q", "feat");
    await (await open(ours)).checkout().setName("feat").call();
    run(native, undefined, "checkout", "-q", "loc@{u}");
    git = await open(ours);
    await git.checkout().setName("loc@{u}").call();
    expect(lastHeadLine(ours)).toEqual(lastHeadLine(native));
    // a detached checkout names the revision as given
    run(native, undefined, "checkout", "-q", "@{u}");
    await (await open(ours)).checkout().setName("@{u}").call();
    expect(lastHeadLine(ours)).toEqual(lastHeadLine(native));
    run(native, undefined, "checkout", "-q", "main");
    await (await open(ours)).checkout().setName("main").call();
    run(native, undefined, "reset", "-q", "--hard", "@{push}~1");
    await (await open(ours)).reset().setRef("@{push}~1").setMode(ResetMode.HARD).call();
    expect(run(ours, undefined, "rev-parse", "HEAD")).toBe(
      run(native, undefined, "rev-parse", "HEAD"),
    );
    expect(lastHeadLine(ours)).toEqual(lastHeadLine(native));
  });
});

describe("approxidateCareful", () => {
  it("reads git's approximate dates relative to now", () => {
    const now = 1_700_000_000;
    expect(approxidateCareful("1600000000 +0000", now)).toEqual({
      timestamp: 1600000000,
      error: false,
    });
    expect(approxidateCareful("2.hours.ago", now)).toEqual({
      timestamp: now - 7200,
      error: false,
    });
    expect(approxidateCareful("3 days ago", now).timestamp).toBe(now - 3 * 86400);
    expect(approxidateCareful("last week", now).timestamp).toBe(now - 7 * 86400);
    expect(approxidateCareful("blah", now).error).toBe(true);
    expect(approxidateCareful("now", now).timestamp).toBe(now);
  });
});
