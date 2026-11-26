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
import { gc, openRepositoryFromEnvironment } from "@statewalker/vcs-store-files";
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
  function repository(objectFormat = "sha1"): string {
    const repo = newDir("repo");
    git(repo, ["init", "-q", "-b", "main", `--object-format=${objectFormat}`]);
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

  type Vars = Record<string, string>;

  /** Native `git status --porcelain` and ours, both run in `cwd` with these variables. */
  async function statusTwins(cwd: string, vars: Vars) {
    const env = { ...nativeGitEnv(root), ...vars };
    const r = spawnSync("git", ["status", "--porcelain"], { cwd, env, encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const opened = await openRepositoryFromEnvironment({
      files: createNodeFilesApi({ rootDir: root }),
      cwd: `/${relative(root, cwd)}`,
      environment: createNodeGitHostEnvironment({ env }),
    });
    const ours = await Git.fromWorkingCopy(opened.admin as WorkingCopy)
      .status()
      .callText({ format: "porcelain" });
    return { native: r.stdout, ours: ours.text, opened };
  }

  it.each(["sha1", "sha256"])(
    "GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE name a separate repository, worktree and index (%s)",
    async (objectFormat) => {
      const repo = repository(objectFormat);
      git(repo, ["add", "b.txt"]);
      // the index of the staged change, kept outside the git directory; the repository's
      // own index is reset
      renameSync(join(repo, ".git", "index"), join(repo, "other-index"));
      git(repo, ["read-tree", "HEAD"]);
      const work = newDir("work");
      for (const name of ["a.txt", "b.txt", "u.txt"]) {
        writeFileSync(join(work, name), readFileSync(join(repo, name)));
      }
      const sub = join(work, "sub");
      mkdirSync(sub);
      const { native, ours, opened } = await statusTwins(sub, {
        GIT_DIR: join(repo, ".git"),
        GIT_WORK_TREE: "..",
        GIT_INDEX_FILE: join(repo, "other-index"),
      });
      expect(opened.setup.workTree).toBe(`/${relative(root, work)}`);
      expect(native).toContain("M  b.txt");
      expect(ours).toBe(native);
    },
  );

  it("GIT_COMMON_DIR without a commondir file: the objects follow it, the refs do not (files_ref_store_create)", async () => {
    const repo = repository();
    const wt = join(root, `wt${counter++}`);
    git(repo, ["worktree", "add", "-q", "-b", "side", wt]);
    writeFileSync(join(wt, "a.txt"), "changed in the worktree\n");
    git(wt, ["add", "a.txt"]);
    writeFileSync(join(wt, "w.txt"), "untracked\n");
    const admin = join(repo, ".git", "worktrees", relative(root, wt));
    rmSync(join(admin, "commondir"));
    const { native, ours, opened } = await statusTwins(wt, {
      GIT_DIR: admin,
      GIT_COMMON_DIR: join(repo, ".git"),
      GIT_WORK_TREE: wt,
    });
    expect(opened.setup.commonDir).toBe(`/${relative(root, join(repo, ".git"))}`);
    expect(ours).toBe(native);
  });

  it("gc refuses stores opened at another GIT_OBJECT_DIRECTORY", async () => {
    const repo = repository();
    const objects = newDir("objects");
    spawnSync("cp", ["-a", join(repo, ".git", "objects", "."), objects]);
    const env = { ...nativeGitEnv(root), GIT_OBJECT_DIRECTORY: objects };
    const opened = await openRepositoryFromEnvironment({
      files: createNodeFilesApi({ rootDir: root }),
      cwd: `/${relative(root, repo)}`,
      environment: createNodeGitHostEnvironment({ env }),
    });
    const { history, files, gitDir } = opened.backend;
    await expect(gc({ history, files, gitDir })).rejects.toThrow(/GIT_OBJECT_DIRECTORY/);
  });
});
