/**
 * `git branch -c` / `-C` (copy) and the configuration `branch -m` and `branch -d` carry,
 * against native git: twins built by native git with fixed dates, one changed by native
 * git, the other by our commands, then refs, every reflog (byte for byte), `.git/config`
 * (byte for byte) and refusals (exact messages) compared.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";
/** Native git with `date` (seconds) as its committer date, when given. */
const run = (cwd: string, args: string[], date?: number) =>
  execFileSync("git", args, {
    cwd,
    env: {
      ...nativeGitEnv(home),
      ...(date ? { GIT_COMMITTER_DATE: `${date} +0000` } : {}),
    },
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/**
 * main (c1, c2) with an upstream configured, `feat` at c1 with a description and a
 * comment in its section, `other` with configuration but no branch.
 */
function build(base: string): string {
  mkdirSync(base, { recursive: true });
  run(base, ["init", "-q", "-b", "main", "repo"]);
  const repo = join(base, "repo");
  put(repo, "a.txt", "a\n");
  run(repo, ["add", "."]);
  run(repo, ["commit", "-qm", "c1"]);
  run(repo, ["branch", "feat"]);
  put(repo, "a.txt", "a\nb\n");
  run(repo, ["commit", "-qam", "c2"]);
  run(repo, ["config", "branch.main.remote", "origin"]);
  run(repo, ["config", "branch.main.merge", "refs/heads/main"]);
  run(repo, ["config", "branch.feat.description", "feat desc"]);
  run(repo, ["config", "branch.other.x", "y"]);
  run(repo, ["config", "core.foo", "bar"]);
  return repo;
}

let counter = 0;
function twins(): { native: string; ours: string } {
  const n = counter++;
  return { native: build(join(root, `t${n}-native`)), ours: build(join(root, `t${n}-ours`)) };
}

/** Our Git, its committer date `date` (seconds) when given. */
async function open(repo: string, date?: number): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const env = { ...nativeGitEnv(home), ...(date ? { GIT_COMMITTER_DATE: `${date} +0000` } : {}) };
  const environment = createNodeGitHostEnvironment({ env });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

function logs(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(repo, ".git/logs", rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else out[path] = readFileSync(join(repo, ".git/logs", path), "latin1");
    }
  };
  walk("");
  return out;
}

function expectSame(t: { native: string; ours: string }): void {
  const snap = (repo: string) => ({
    head: run(repo, ["symbolic-ref", "HEAD"]),
    refs: run(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    logs: logs(repo),
    config: readFileSync(join(repo, ".git/config"), "latin1"),
  });
  const n = snap(t.native);
  const o = snap(t.ours);
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
  const r = spawnSync("git", args, { cwd: repo, env: nativeGitEnv(home), encoding: "latin1" });
  expect(r.status).toBe(128);
  return r.stderr.trimEnd();
};

describeGit("git branch -c / -C, and the configuration of -m and -d, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "branch-copy-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("copies the current branch (HEAD stays), another one, -C over an existing one, a branch onto itself", async () => {
    const t = twins();
    run(t.native, ["branch", "-c", "cur"]);
    run(t.native, ["branch", "-c", "feat", "feat2"]);
    run(t.native, ["branch", "-C", "feat", "cur"], 1112912100);
    run(t.native, ["branch", "-C", "main", "main"]);
    await (await open(t.ours)).branchCopy().setNewName("cur").call();
    await (await open(t.ours)).branchCopy().setOldName("feat").setNewName("feat2").call();
    await (await open(t.ours, 1112912100))
      .branchCopy()
      .setOldName("feat")
      .setNewName("cur")
      .setForce(true)
      .call();
    await (await open(t.ours))
      .branchCopy()
      .setOldName("main")
      .setNewName("main")
      .setForce(true)
      .call();
    expectSame(t);
    const cur = readFileSync(join(t.ours, ".git/logs/refs/heads/cur"), "latin1");
    expect(cur).toContain("\tBranch: copied refs/heads/feat to refs/heads/cur\n");
    expect(readFileSync(join(t.ours, ".git/config"), "latin1")).toContain(
      '[branch "feat"]\n\tdescription = feat desc\n[branch "cur"]\n\tdescription = feat desc\n',
    );
  });

  it("refusals: an existing branch, a missing one, the checked-out branch, a detached HEAD", async () => {
    const t = twins();
    const git = await open(t.ours);
    const cases: [string[], () => Promise<unknown>][] = [
      [["-c", "feat", "main"], () => git.branchCopy().setOldName("feat").setNewName("main").call()],
      [["-c", "nope", "x"], () => git.branchCopy().setOldName("nope").setNewName("x").call()],
      [
        ["-C", "feat", "main"],
        () => git.branchCopy().setOldName("feat").setNewName("main").setForce(true).call(),
      ],
    ];
    for (const [args, call] of cases) {
      const native = nativeRefusal(t.native, "branch", ...args)
        .split(t.native)
        .join("<repo>");
      const ours = (await refusal(call)).split(t.ours).join("<repo>");
      expect([args, ours]).toEqual([args, native]);
    }
    run(t.native, ["checkout", "-q", "--detach"]);
    await git.checkout().setDetach(true).call();
    expect(await refusal(() => git.branchCopy().setNewName("x").call())).toBe(
      nativeRefusal(t.native, "branch", "-c", "x"),
    );
  });

  it("branch -m moves the branch's section (also the current branch's); branch -d drops it", async () => {
    const t = twins();
    run(t.native, ["branch", "-m", "feat", "feat3"]);
    run(t.native, ["branch", "-m", "trunk"]);
    run(t.native, ["branch", "-D", "feat3"]);
    const git = await open(t.ours);
    await git.branchRename().setOldName("feat").setNewName("feat3").call();
    await git.branchRename().setNewName("trunk").call();
    await git.branchDelete().setBranchNames("feat3").setForce(true).call();
    expectSame(t);
    const config = readFileSync(join(t.ours, ".git/config"), "latin1");
    expect(config).toContain('[branch "trunk"]\n\tremote = origin\n');
    expect(config).not.toContain("feat");
  });
});
