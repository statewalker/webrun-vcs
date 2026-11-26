/**
 * A tool built on the library, run inside a git hook, opens the repository with the
 * variables git set for the hook (`openRepositoryFromEnvironment`, statewalker/webrun-vcs#375):
 * a `commit -a` pre-commit hook gets `GIT_INDEX_FILE=.git/index.lock`, a `commit --only` one
 * `next-index-*.lock`, a pre-receive hook `GIT_OBJECT_DIRECTORY` at the quarantine. The hook
 * runs native `git status --porcelain` (or `git cat-file -t`), records its environment and
 * waits while ours runs with that environment in the same state; both must agree.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { openRepositoryFromEnvironment } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let counter = 0;

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, env: nativeGitEnv(root), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A hook recording its environment and native git's answer, then waiting for `go`. */
function installHook(gitDir: string, name: string, out: string, native: string): void {
  mkdirSync(join(gitDir, "hooks"), { recursive: true });
  const hook = join(gitDir, "hooks", name);
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      `cat > "${out}/stdin"`,
      `env -0 > "${out}/env"`,
      `pwd -P > "${out}/cwd"`,
      `${native} > "${out}/native" 2>&1`,
      `touch "${out}/ready"`,
      `while [ ! -f "${out}/go" ]; do sleep 0.05; done`,
      "",
    ].join("\n"),
  );
  chmodSync(hook, 0o755);
}

/** Starts git (it blocks in the hook) and waits until the hook is ready. */
async function startBlocked(
  cwd: string,
  args: string[],
  out: string,
): Promise<{ child: ChildProcess; done: Promise<number> }> {
  const child = spawn("git", args, { cwd, env: nativeGitEnv(root), stdio: "ignore" });
  const done = new Promise<number>((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
  for (let i = 0; i < 400 && !existsSync(join(out, "ready")); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (!existsSync(join(out, "ready"))) throw new Error(`git ${args.join(" ")}: hook never ran`);
  return { child, done };
}

/** Opens ours as the hook's process would: its environment and current directory. */
async function openAsHook(out: string) {
  const env = Object.fromEntries(
    readFileSync(join(out, "env"), "utf8")
      .split("\0")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  const cwd = readFileSync(join(out, "cwd"), "utf8").trim();
  const files = createNodeFilesApi({ rootDir: root });
  const environment = createNodeGitHostEnvironment({ env });
  return {
    env,
    opened: await openRepositoryFromEnvironment({
      files,
      cwd: `/${relative(root, cwd)}`,
      environment,
    }),
  };
}

function newDir(name: string): string {
  const dir = join(root, `${name}${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describeGit("opening the repository with a hook's variables (#375)", () => {
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "open-env-")));
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A repository with a committed a.txt and b.txt, both changed, and an untracked u.txt. */
  function repository(): string {
    const repo = newDir("repo");
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "base"]);
    writeFileSync(join(repo, "a.txt"), "a changed\n");
    writeFileSync(join(repo, "b.txt"), "b changed\n");
    writeFileSync(join(repo, "u.txt"), "untracked\n");
    return repo;
  }

  async function statusInPreCommit(args: string[]): Promise<void> {
    const repo = repository();
    git(repo, ["add", "b.txt"]);
    const out = newDir("out");
    installHook(join(repo, ".git"), "pre-commit", out, "git status --porcelain");
    const { done } = await startBlocked(repo, ["commit", "-q", ...args], out);
    try {
      const { env, opened } = await openAsHook(out);
      expect(env.GIT_INDEX_FILE).toBeDefined();
      expect(opened.setup.indexFile).not.toBe(join(opened.setup.gitDir, "index"));
      const ours = await Git.fromWorkingCopy(opened.admin as WorkingCopy)
        .status()
        .callText({ format: "porcelain" });
      expect(ours.text).toBe(readFileSync(join(out, "native"), "utf8"));
    } finally {
      writeFileSync(join(out, "go"), "");
      expect(await done).toBe(0);
    }
  }

  it("commit -a: the pre-commit hook's GIT_INDEX_FILE is index.lock", async () => {
    await statusInPreCommit(["-a", "-m", "all"]);
  });

  it("commit --only: the pre-commit hook's GIT_INDEX_FILE is next-index-*.lock", async () => {
    await statusInPreCommit(["-m", "only a", "--", "a.txt"]);
  });

  it("pre-receive: the pushed objects are read from GIT_OBJECT_DIRECTORY's quarantine", async () => {
    const bare = newDir("bare");
    git(bare, ["init", "-q", "--bare", "-b", "main"]);
    const repo = repository();
    git(repo, ["commit", "-qam", "pushed"]);
    const pushed = git(repo, ["rev-parse", "HEAD"]).trim();
    const out = newDir("out");
    installHook(bare, "pre-receive", out, `git cat-file -t ${pushed}`);
    const { done } = await startBlocked(repo, ["push", "-q", bare, "main"], out);
    try {
      const { env, opened } = await openAsHook(out);
      expect(env.GIT_QUARANTINE_PATH).toBeDefined();
      expect(readFileSync(join(out, "native"), "utf8")).toBe("commit\n");
      const commit = await opened.backend.history.commits.load(pushed);
      expect(commit?.message).toBe("pushed\n");
    } finally {
      writeFileSync(join(out, "go"), "");
      expect(await done).toBe(0);
    }
  });

  it("GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE name a separate repository, worktree and index", async () => {
    const repo = repository();
    git(repo, ["add", "b.txt"]);
    // the index of the staged change, kept apart; the repository's own index is reset
    renameSync(join(repo, ".git", "index"), join(repo, "other-index"));
    git(repo, ["read-tree", "HEAD"]);
    const work = newDir("work");
    for (const name of ["a.txt", "b.txt", "u.txt"]) {
      writeFileSync(join(work, name), readFileSync(join(repo, name)));
    }
    const sub = join(work, "sub");
    mkdirSync(sub);
    const vars = {
      GIT_DIR: join(repo, ".git"),
      GIT_WORK_TREE: "..",
      GIT_INDEX_FILE: join(repo, "other-index"),
    };
    const r = spawnSync("git", ["status", "--porcelain"], {
      cwd: sub,
      env: { ...nativeGitEnv(root), ...vars },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const files = createNodeFilesApi({ rootDir: root });
    const environment = createNodeGitHostEnvironment({ env: { ...nativeGitEnv(root), ...vars } });
    const opened = await openRepositoryFromEnvironment({
      files,
      cwd: `/${relative(root, sub)}`,
      environment,
    });
    expect(opened.setup.workTree).toBe(`/${relative(root, work)}`);
    const ours = await Git.fromWorkingCopy(opened.admin as WorkingCopy)
      .status()
      .callText({ format: "porcelain" });
    expect(ours.text).toBe(r.stdout);
  });
});
