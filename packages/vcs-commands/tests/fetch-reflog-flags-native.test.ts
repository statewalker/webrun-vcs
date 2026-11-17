/**
 * The reflog action of `git fetch` and `git pull` carries their command line
 * (`GIT_REFLOG_ACTION` is built from argv: `fetch --prune --force origin: fast-forward`,
 * `pull --ff-only --no-tags origin main: Fast-forward`). Our options are given in a fixed
 * order, so native git is run with its arguments in that order, then every reflog compared
 * byte for byte.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FastForwardMode, Git, TagOption } from "../src/index.js";
import {
  type NativeGitHttpBackend,
  nativeGitAvailable,
  nativeGitEnv,
  nativeGitHttpBackend,
} from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const URL = "http://git.test/src.git";
let root = "";
let home = "";
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(home),
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });

async function open(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const environment = createNodeGitHostEnvironment({ env: nativeGitEnv(home) });
  const { history } = await createGitFilesBackend({ files });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

function reflogs(dir: string, url: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    const at = join(dir, ".git/logs", rel);
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else out[path] = readFileSync(join(at, entry.name), "latin1").replace(url, "<url>");
    }
  };
  walk("");
  return out;
}

describeGit("reflog actions of fetch and pull with options, native twins", () => {
  let backend: NativeGitHttpBackend;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fetch-flags-native-"));
    home = join(root, "home");
    mkdirSync(home);
    backend = nativeGitHttpBackend(root, home);
    globalThis.fetch = backend.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    backend?.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** The upstream `work` published as `src.git`; `native` and `ours` cloned from it. */
  function setup() {
    const work = join(root, "work");
    const src = join(root, "src.git");
    run(root, "init", "-q", "-b", "main", work);
    run(work, "commit", "-q", "--allow-empty", "-m", "base");
    run(work, "branch", "dev");
    run(work, "branch", "gone");
    run(root, "clone", "-q", "--bare", work, src);
    const native = join(root, "native");
    const ours = join(root, "ours");
    run(root, "clone", "-q", src, native);
    run(root, "clone", "-q", src, ours);
    run(ours, "config", "remote.origin.url", URL);
    const url = new RegExp(
      `(${src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|${URL.replace(/\./g, "\\.")})`,
      "g",
    );
    const expectSame = () => {
      const n = reflogs(native, url);
      const o = reflogs(ours, url);
      expect(Object.keys(o).sort()).toEqual(Object.keys(n).sort());
      for (const name of Object.keys(n)) expect([name, o[name]]).toEqual([name, n[name]]);
    };
    return { work, src, native, ours, expectSame };
  }

  it("fetch --atomic --force --prune --tags --depth=<n>, and --no-tags", async () => {
    const { work, src, native, ours, expectSame } = setup();
    run(work, "commit", "-q", "--allow-empty", "-m", "upstream 1");
    run(work, "branch", "-f", "dev");
    run(work, "branch", "-D", "gone");
    run(work, "tag", "t1");
    run(work, "push", "-q", "--force", "--prune", src, "refs/heads/*:refs/heads/*", "refs/tags/*");
    run(native, "fetch", "--atomic", "--force", "--prune", "--tags", "--depth=5", "origin");
    await (await open(ours))
      .fetch()
      .setRemote("origin")
      .setAtomic(true)
      .setForceUpdate(true)
      .setRemoveDeletedRefs(true)
      .setTagOpt(TagOption.FETCH_TAGS)
      .setDepth(5)
      .call();
    expectSame();
    const dev = readFileSync(join(ours, ".git/logs/refs/remotes/origin/dev"), "latin1");
    expect(dev).toContain(
      "\tfetch --atomic --force --prune --tags --depth=5 origin: fast-forward\n",
    );

    run(work, "commit", "-q", "--allow-empty", "-m", "upstream 2");
    run(work, "push", "-q", src, "main");
    run(native, "fetch", "--no-prune", "--no-tags", "origin");
    await (await open(ours))
      .fetch()
      .setRemote("origin")
      .setRemoveDeletedRefs(false)
      .setTagOpt(TagOption.NO_TAGS)
      .call();
    expectSame();
  });

  it("pull --ff-only --no-tags <remote> <branch>", async () => {
    const { work, src, native, ours, expectSame } = setup();
    run(work, "commit", "-q", "--allow-empty", "-m", "upstream 1");
    run(work, "push", "-q", src, "main");
    run(native, "pull", "--ff-only", "--no-tags", "origin", "main");
    await (await open(ours))
      .pull()
      .setRemote("origin")
      .setRemoteBranchName("main")
      .setFastForwardMode(FastForwardMode.FF_ONLY)
      .setTagOpt(TagOption.NO_TAGS)
      .call();
    expectSame();
    expect(readFileSync(join(ours, ".git/logs/HEAD"), "latin1")).toContain(
      "\tpull --ff-only --no-tags origin main: Fast-forward\n",
    );
  });
});
