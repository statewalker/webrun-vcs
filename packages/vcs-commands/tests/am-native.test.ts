/**
 * `git am` against native git: a series made by native `git format-patch` from a history
 * (renames, binaries, mode changes, non-ASCII authors and subjects) is applied to two
 * twins built by native git, one by native `git am`, the other by our AmCommand, with the
 * same pinned committer; then the exit status, stdout, stderr, `.git/rebase-apply/` (at a
 * stop), HEAD's commit id, the reflogs, ORIG_HEAD, the worktree and the index are compared,
 * through `--skip`, `--continue` and `--abort`.
 */
import { spawnSync } from "node:child_process";
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

import { type AmCommand, Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

type Env = Record<string, string | undefined>;
let root = "";
let home = "";
let counter = 0;
let modern = true;

const IDENT: Env = {
  GIT_AUTHOR_NAME: "Ann Author",
  GIT_AUTHOR_EMAIL: "ann@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0200",
  GIT_COMMITTER_NAME: "Cid Committer",
  GIT_COMMITTER_EMAIL: "cid@example.com",
  GIT_COMMITTER_DATE: "1700000500 -0700",
};

function envOf(over: Env = {}): Record<string, string> {
  const env: Env = { ...nativeGitEnv(home), ...IDENT, ...over };
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

function git(cwd: string, args: string[], env: Env = {}) {
  const r = spawnSync("git", args, {
    cwd,
    env: envOf(env),
    encoding: "utf8",
    input: "",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function gitOk(cwd: string, args: string[], env: Env = {}): string {
  const r = git(cwd, args, env);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

const put = (dir: string, path: string, content: string | Buffer, mode = 0o644) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  rmSync(join(dir, path), { force: true });
  writeFileSync(join(dir, path), content, { mode });
};

async function open(repo: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: envOf() });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

const lines = (n: number, p = "line") =>
  Array.from({ length: n }, (_, i) => `${p} ${i + 1}\n`).join("");

/** The base every repository starts from. */
function base(repo: string): void {
  mkdirSync(repo, { recursive: true });
  gitOk(repo, ["init", "-q", "-b", "main"]);
  put(repo, "a.txt", lines(20));
  put(repo, "b.txt", lines(10, "bee"));
  put(repo, "data.bin", Buffer.from(Array.from({ length: 600 }, (_, i) => (i * 7) % 256)));
  gitOk(repo, ["add", "-A"]);
  gitOk(repo, ["commit", "-qm", "base"]);
}

/** A series made by native format-patch on top of the base; the mbox file's path. */
function series(): string {
  const src = join(root, `src${counter++}`);
  base(src);
  const commit = (msg: string, name: string, email: string, date: string) => {
    gitOk(src, ["add", "-A"]);
    gitOk(src, ["commit", "-q", "-m", msg], {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: date,
    });
  };
  put(src, "a.txt", lines(20).replace("line 3\n", "line three\n"));
  commit(
    "Change line three\n\nWith a body line.\n",
    "José Núñez",
    "jose@example.com",
    "1700001000 +0100",
  );
  gitOk(src, ["mv", "b.txt", "bee.txt"]);
  put(src, "run.sh", "#!/bin/sh\necho hi\n", 0o755);
  commit(
    "[core] Rename bee and add a script",
    "O'Brien, Pat",
    "pat@example.com",
    "1700002000 -0500",
  );
  const bin = readFileSync(join(src, "data.bin"));
  bin[10] = 0;
  bin[300] = 1;
  put(src, "data.bin", bin);
  put(
    src,
    "a.txt",
    lines(20).replace("line 3\n", "line three\n").replace("line 18\n", "line eighteen\n"),
  );
  commit("Café: binary and text", "张伟", "zhang@example.com", "1700003000 +0800");
  const mbox = join(root, `series${counter++}.mbox`);
  writeFileSync(
    mbox,
    spawnSync("git", ["format-patch", "--stdout", "HEAD~3"], { cwd: src, env: envOf() }).stdout,
  );
  return mbox;
}

function snapshot(repo: string): string {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(repo, rel)).sort()) {
      if (!rel && name === ".git") continue;
      const p = rel ? `${rel}/${name}` : name;
      const full = join(repo, p);
      if (
        readdirSync(join(repo, rel), { withFileTypes: true })
          .find((d) => d.name === name)
          ?.isDirectory()
      )
        walk(p);
      else out.push(`${p} ${readFileSync(full).toString("base64")}`);
    }
  };
  walk("");
  const state = join(repo, ".git", "rebase-apply");
  if (existsSync(state)) {
    // patch-merge-index: the temporary index of --3way, which ours keeps in memory
    for (const f of readdirSync(state).sort())
      if (f !== "patch-merge-index")
        out.push(`STATE ${f}: ${readFileSync(join(state, f)).toString()}`);
  }
  return out.join("\n");
}

function refsOf(repo: string): string {
  return [
    gitOk(repo, ["rev-parse", "HEAD"]),
    git(repo, ["rev-parse", "-q", "--verify", "ORIG_HEAD"]).stdout,
    gitOk(repo, ["reflog", "--format=%H %gs"]),
    gitOk(repo, ["ls-files", "-s"]),
    gitOk(repo, ["status", "--porcelain"]),
  ].join("\n--\n");
}

async function compare(
  pair: { native: string; ours: string },
  args: string[],
  configure: (c: AmCommand) => AmCommand,
  label: string,
) {
  const native = git(pair.native, ["am", ...args]);
  const g = await open(pair.ours);
  const r = await configure(g.am().setLegacyMessages(!modern)).call();
  g.close();
  expect({ label, status: r.exitCode, stdout: r.output, stderr: r.errors }).toEqual({
    label,
    status: native.status,
    stdout: native.stdout,
    stderr: native.stderr,
  });
  expect(snapshot(pair.ours)).toBe(snapshot(pair.native));
  expect(refsOf(pair.ours)).toBe(refsOf(pair.native));
}

function twins(setup?: (repo: string) => void) {
  const n = counter++;
  const make = (side: string) => {
    const repo = join(root, `t${n}-${side}`);
    base(repo);
    setup?.(repo);
    return repo;
  };
  return { native: make("native"), ours: make("ours") };
}

describeGit("git am as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "am-native-"));
    home = join(root, "home");
    mkdirSync(home, { recursive: true });
    modern = gitAtLeast(gitOk(root, ["--version"]), 2, 46);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("applies a series as native git does", async () => {
    const mbox = series();
    const bytes = readFileSync(mbox);
    await compare(twins(), [mbox], (c) => c.addMbox(bytes), "plain");
    await compare(
      twins(),
      ["-s", "-k", mbox],
      (c) => c.addMbox(bytes).setSignoff(true).setKeep(true),
      "-s -k",
    );
    await compare(
      twins(),
      ["-q", "-m", mbox],
      (c) => c.addMbox(bytes).setQuiet(true).setMessageId(true),
      "-q -m",
    );
  }, 120_000);

  it("stops, skips, continues and aborts as native git does", async () => {
    const mbox = series();
    const bytes = readFileSync(mbox);
    const drift = (repo: string) => {
      put(repo, "a.txt", lines(20).replace("line 3\n", "LINE 3\n"));
      gitOk(repo, ["commit", "-qam", "drift"]);
    };
    // stop on the first patch, then --skip the rest through
    let pair = twins(drift);
    await compare(pair, [mbox], (c) => c.addMbox(bytes), "stop");
    await compare(pair, ["--skip"], (c) => c.setResume("skip"), "skip");
    // stop, resolve by hand, --continue
    pair = twins(drift);
    await compare(pair, [mbox], (c) => c.addMbox(bytes), "stop 2");
    for (const repo of [pair.native, pair.ours]) {
      put(repo, "a.txt", lines(20).replace("line 3\n", "line three\n"));
      gitOk(repo, ["add", "a.txt"]);
    }
    await compare(pair, ["--continue"], (c) => c.setResume("continue"), "continue");
    // stop, --abort
    pair = twins(drift);
    await compare(pair, [mbox], (c) => c.addMbox(bytes), "stop 3");
    await compare(pair, ["--abort"], (c) => c.setResume("abort"), "abort");
    // --continue with nothing staged
    pair = twins(drift);
    await compare(pair, [mbox], (c) => c.addMbox(bytes), "stop 4");
    await compare(pair, ["--continue"], (c) => c.setResume("continue"), "continue without changes");
    await compare(pair, ["--quit"], (c) => c.setResume("quit"), "quit");
    // --3way: a context change merges cleanly, a real conflict stops with stages
    const near = (repo: string) => {
      put(repo, "a.txt", lines(20).replace("line 4\n", "LINE 4\n"));
      gitOk(repo, ["commit", "-qam", "drift near"]);
    };
    await compare(
      twins(near),
      ["-3", mbox],
      (c) => c.addMbox(bytes).setThreeWay(true),
      "3way clean",
    );
    pair = twins(drift);
    await compare(
      pair,
      ["--3way", mbox],
      (c) => c.addMbox(bytes).setThreeWay(true),
      "3way conflict",
    );
    for (const repo of [pair.native, pair.ours]) {
      put(repo, "a.txt", lines(20).replace("line 3\n", "merged 3\n"));
      gitOk(repo, ["add", "a.txt"]);
    }
    await compare(pair, ["--continue"], (c) => c.setResume("continue"), "3way continue");
    // already applied: the 3-way merge finds nothing to change
    const applied = (repo: string) => {
      put(
        repo,
        "a.txt",
        lines(20).replace("line 3\n", "line three\n").replace("line 1\n", "first\n"),
      );
      gitOk(repo, ["commit", "-qam", "same change"]);
    };
    await compare(
      twins(applied),
      ["-3", mbox],
      (c) => c.addMbox(bytes).setThreeWay(true),
      "3way already applied",
    );
    // a dirty index refuses
    pair = twins((repo) => {
      put(repo, "a.txt", "staged\n");
      gitOk(repo, ["add", "a.txt"]);
    });
    await compare(pair, [mbox], (c) => c.addMbox(bytes), "dirty index");
  }, 120_000);
});
