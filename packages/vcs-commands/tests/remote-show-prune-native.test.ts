/**
 * `git remote show [-n]`, `git remote prune [--dry-run]` and `git remote set-branches
 * [--add]` against native git (builtin/remote.c `show`, `prune_remote`, `set_branches`).
 * Each twin is two repositories built alike by native git (`n<k>`, `o<k>`) beside the
 * upstream repositories (local paths: git's local transport, ours upload-pack in process);
 * native git runs the command in one, ours in the other, and the twins compare stdout,
 * stderr, the exit status, the configuration, the refs and the reflogs.
 *
 * Scenarios from t5505-remote.sh (cited per test).
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeGitHostEnvironment,
  createNodeHookRunner,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, GitApiError } from "../src/index.js";
import { nativeIs25x } from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const DATES = {
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args, DATES);

async function ours(name: string): Promise<Git> {
  const env = testEnv(root, DATES);
  return openOurs(
    root,
    createNodeGitHostEnvironment({
      env,
      hookRunner: createNodeHookRunner({ env, compatibility: nativeIs25x ? "2.56" : "2.43" }),
    }),
    undefined,
    name,
  );
}

/** t5505's setup_repository: `main` with one commit, `side` with a second. */
function setupRepository(name: string): void {
  const dir = join(root, name);
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "main");
  putFile(dir, "file", "");
  git(dir, "add", "file");
  git(dir, "commit", "-qm", "Initial");
  git(dir, "checkout", "-q", "-b", "side");
  putFile(dir, "elif", "");
  git(dir, "add", "elif");
  git(dir, "commit", "-qm", "Second");
  git(dir, "checkout", "-q", "main");
}

/** Two clones of `source` (`n<k>`, `o<k>`), `prepare` run in each. */
function twins(source: string, prepare: (dir: string) => void = () => {}, args: string[] = []) {
  const names: [string, string] = [`n${counter}`, `o${counter}`];
  counter++;
  for (const name of names) {
    git(root, "clone", "-q", ...args, source, name);
    prepare(join(root, name));
  }
  return names;
}

/** Two new repositories (`n<k>`, `o<k>`), `prepare` run in each. */
function emptyTwins(prepare: (dir: string) => void): [string, string] {
  const names: [string, string] = [`n${counter}`, `o${counter}`];
  counter++;
  for (const name of names) {
    mkdirSync(join(root, name));
    git(join(root, name), "init", "-q", "-b", "main");
    prepare(join(root, name));
  }
  return names;
}

/**
 * A fetch mirror of `source` with a work tree (`git remote add --mirror=fetch`), its HEAD
 * at a branch the mirror does not write; `--mirror` clones are bare, which ours opens
 * otherwise.
 */
const mirrorOf = (source: string) => (dir: string) => {
  git(dir, "symbolic-ref", "HEAD", "refs/heads/elsewhere");
  git(dir, "remote", "add", "--mirror=fetch", "origin", `../${source}`);
  git(dir, "config", "remote.origin.mirror", "true");
  git(dir, "fetch", "-q", "origin");
};

const config = (dir: string) => readFileSync(join(root, dir, gitDirOf(dir), "config"), "latin1");
const gitDirOf = (dir: string) => (existsSync(join(root, dir, ".git")) ? ".git" : "");
const refs = (dir: string) =>
  git(join(root, dir), "for-each-ref", "--format=%(refname) %(objectname) %(symref)");

function reflogs(dir: string): string {
  const lines: string[] = [];
  const walk = (rel: string) => {
    const at = join(root, dir, gitDirOf(dir), rel);
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else lines.push(`${path}:\n${readFileSync(join(at, entry.name), "latin1")}`);
    }
  };
  walk("logs/refs");
  return lines.join("\n");
}

function expectSameState(n: string, o: string): void {
  expect(config(o)).toBe(config(n));
  expect(refs(o)).toBe(refs(n));
  expect(reflogs(o)).toBe(reflogs(n));
}

/** `git remote show <args>` in both twins: stdout (or the death) and the state compared. */
async function expectSameShow(n: string, o: string, args: string[]) {
  const native = gitRun(root, join(root, n), ["remote", "show", ...args], DATES);
  const names = args.filter((a) => a !== "-n");
  const command = (await ours(o))
    .remoteShow()
    .setRemoteNames(...names)
    .setNoQuery(args.includes("-n"));
  let text: string | undefined;
  let error: GitApiError | undefined;
  try {
    text = await command.callText();
  } catch (e) {
    error = e as GitApiError;
  }
  if (native.status !== 0) {
    expect(error, native.stderr).toBeDefined();
    expect((error as unknown as { stdout?: string }).stdout).toBe(native.stdout);
  } else {
    expect(error).toBeUndefined();
    expect(text).toBe(native.stdout);
    expect(command.getMessages().join("\n")).toBe(native.stderr.trimEnd());
  }
  expectSameState(n, o);
  return native;
}

/** `git remote prune <args>` in both twins. */
async function expectSamePrune(n: string, o: string, args: string[]) {
  const native = gitRun(root, join(root, n), ["remote", "prune", ...args], DATES);
  const command = (await ours(o))
    .remotePrune()
    .setRemoteNames(...args.filter((a) => a !== "--dry-run" && a !== "-n"))
    .setDryRun(args.includes("--dry-run") || args.includes("-n"));
  let error: GitApiError | undefined;
  try {
    await command.call();
  } catch (e) {
    error = e as GitApiError;
  }
  expect(error === undefined, `${native.stderr} / ${error?.message}`).toBe(native.status === 0);
  expect(command.getOutput()).toBe(native.stdout);
  expectSameState(n, o);
  return native;
}

/** `git remote set-branches <args>` in both twins. */
async function expectSameSetBranches(n: string, o: string, args: string[]) {
  const native = gitRun(root, join(root, n), ["remote", "set-branches", ...args], DATES);
  const rest = args.filter((a) => a !== "--add");
  const command = (await ours(o))
    .remoteSetBranches()
    .setAdd(args.includes("--add"))
    .setBranches(...rest.slice(1));
  if (rest[0] !== undefined) command.setRemoteName(rest[0]);
  let error: GitApiError | undefined;
  try {
    await command.call();
  } catch (e) {
    error = e as GitApiError;
  }
  if (native.status === 0) expect(error).toBeUndefined();
  else {
    expect(error?.exitCode ?? 129).toBe(native.status);
    expect(native.stderr.startsWith(error?.message ?? "")).toBe(true);
  }
  expectSameState(n, o);
  return native;
}

describeGit("git remote show / prune / set-branches, as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "remote-show-"));
    setupRepository("one");
    git(root, "clone", "-q", "one", "two");
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it('t5505-remote.sh: "show", "show with negative refspecs", "show stale with negative refspecs", "show -n"', async () => {
    setupRepository("one-show");
    const up = join(root, "one-show");
    const [n, o] = twins("one-show", (dir) => {
      git(dir, "config", "--add", "remote.origin.fetch", "refs/heads/main:refs/heads/upstream");
      git(dir, "fetch", "-q");
      git(dir, "checkout", "-q", "-b", "ahead", "origin/main");
      putFile(dir, "file", "1\n");
      git(dir, "commit", "-qam", "update");
      git(dir, "checkout", "-q", "main");
      git(dir, "branch", "-q", "--track", "octopus", "origin/main");
      git(dir, "branch", "-q", "--track", "rebase", "origin/main");
      git(dir, "branch", "-q", "-d", "-r", "origin/main");
      git(dir, "config", "--add", "remote.two.url", "../two");
      git(dir, "config", "--add", "remote.two.pushurl", "../three");
      git(dir, "config", "branch.rebase.rebase", "true");
      git(dir, "config", "branch.octopus.merge", "topic-a topic-b topic-c");
      git(dir, "config", "--add", "remote.origin.push", ":");
      git(dir, "config", "--add", "remote.origin.push", "refs/heads/main:refs/heads/upstream");
      git(dir, "config", "--add", "remote.origin.push", "+refs/tags/lastbackup");
      git(dir, "config", "--add", "remote.two.push", "+refs/heads/ahead:refs/heads/main");
      git(dir, "config", "--add", "remote.two.push", "refs/heads/main:refs/heads/another");
    });
    putFile(up, "file", "1\n");
    git(up, "commit", "-qam", "update");
    await expectSameShow(n, o, ["origin", "two"]);
    await expectSameShow(n, o, ["-n", "origin", "two"]);
    for (const d of [n, o]) git(join(root, d), "branch", "-q", "-D", "rebase", "octopus");
    for (const negative of ["^refs/heads/main", "^refs/heads/side"]) {
      for (const d of [n, o]) {
        git(join(root, d), "config", "--add", "remote.origin.fetch", negative);
      }
      await expectSameShow(n, o, ["origin"]);
      for (const d of [n, o]) {
        git(join(root, d), "config", "--unset-all", "remote.origin.fetch", `\\${negative}`);
      }
    }
    // -n asks nothing: the remote may be gone
    renameSync(up, `${up}.unreachable`);
    try {
      await expectSameShow(n, o, ["-n", "origin"]);
      const gone = await expectSameShow(n, o, ["origin"]);
      expect(gone.status).toBe(128);
    } finally {
      renameSync(`${up}.unreachable`, up);
    }
    // a remote that is no remote is shown as a URL
    await expectSameShow(n, o, ["-n", "nosuch"]);
  });

  it('t5505-remote.sh: "show" (rebase kinds, several merges, push mirror, no push URL, ambiguous HEAD)', async () => {
    setupRepository("one-kinds");
    const up = join(root, "one-kinds");
    const [n, o] = twins("one-kinds", (dir) => {
      git(dir, "branch", "-q", "--track", "i", "origin/side");
      git(dir, "config", "branch.i.rebase", "interactive");
      git(dir, "branch", "-q", "--track", "m", "origin/side");
      git(dir, "config", "branch.m.rebase", "merges");
      git(dir, "branch", "-q", "--track", "two-merges", "origin/side");
      git(dir, "config", "--add", "branch.two-merges.merge", "refs/heads/main");
      git(dir, "branch", "-q", "--track", "bad", "origin/side");
      git(dir, "config", "--add", "branch.bad.merge", "refs/heads/main");
      git(dir, "config", "branch.bad.rebase", "true");
      git(dir, "remote", "add", "--mirror=push", "mirrored", "../one-kinds");
      git(dir, "config", "remote.nourl.fetch", "+refs/heads/*:refs/remotes/nourl/*");
    });
    // HEAD detached at a commit two branches hold: git cannot tell which is HEAD
    git(up, "branch", "twin");
    git(up, "checkout", "-q", "--detach");
    await expectSameShow(n, o, ["origin", "mirrored"]);
    await expectSameShow(n, o, ["-n", "mirrored", "nourl"]);
    git(up, "checkout", "-q", "main");
  });

  it('t5505-remote.sh: "prune", "prune --dry-run", "remote prune to cause a dangling symref"', async () => {
    setupRepository("one-prune");
    const up = join(root, "one-prune");
    git(up, "branch", "side2", "side");
    const [n, o] = twins("one-prune");
    git(up, "branch", "-D", "side2");
    git(up, "branch", "side3", "side");
    // nothing stale in another remote: no output for it
    for (const d of [n, o]) git(join(root, d), "remote", "add", "two", "../two");
    await expectSamePrune(n, o, ["--dry-run", "origin", "two"]);
    await expectSamePrune(n, o, ["origin", "two"]);
    await expectSamePrune(n, o, ["origin"]);
    // the branch origin/HEAD names goes: the symref dangles
    git(up, "checkout", "-q", "side3");
    git(up, "branch", "-D", "main");
    await expectSamePrune(n, o, ["--dry-run", "origin"]);
    await expectSamePrune(n, o, ["origin"]);
    git(up, "checkout", "-q", "-b", "main", "side3~1");
  });

  // t5505-remote.sh: '"remote show" does not show symbolic refs' (origin/HEAD below)
  it('t5505-remote.sh: "add --mirror && prune", "add alt && prune", "show empty remote"', async () => {
    setupRepository("one-mirror");
    const up = join(root, "one-mirror");
    git(up, "branch", "side2", "side");
    const [n, o] = emptyTwins(mirrorOf("one-mirror"));
    git(up, "branch", "-m", "side2", "side4");
    await expectSameShow(n, o, ["origin"]);
    await expectSamePrune(n, o, ["origin"]);

    // a remote whose refspec maps one remote's branches under another's name
    const [n2, o2] = twins("one", (dir) => {
      git(dir, "remote", "add", "-f", "alt", "../one-mirror");
      git(dir, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/alt/*");
    });
    await expectSameShow(n2, o2, ["origin", "alt"]);
    await expectSamePrune(n2, o2, ["--dry-run", "origin"]);

    mkdirSync(join(root, "empty"));
    git(join(root, "empty"), "init", "-q");
    const [n3, o3] = twins("empty");
    await expectSameShow(n3, o3, ["origin"]);
    await expectSameShow(n3, o3, ["-n", "origin"]);
  });

  it('t5505-remote.sh: "remote set-branches", "remote set-branches with --mirror", "remote set-branches requires a remote"', async () => {
    const [n, o] = twins("one", (dir) => git(dir, "remote", "rename", "origin", "scratch"));
    await expectSameSetBranches(n, o, ["scratch", "--add", "other"]);
    await expectSameSetBranches(n, o, ["scratch", "maint", "main", "next"]);
    await expectSameSetBranches(n, o, ["--add", "scratch", "seen", "t/topic"]);
    for (const d of [n, o]) {
      git(join(root, d), "config", "--unset-all", "remote.scratch.fetch");
      git(
        join(root, d),
        "config",
        "remote.scratch.fetch",
        "refs/heads/main:refs/remotes/scratch/main",
      );
      git(
        join(root, d),
        "config",
        "--add",
        "remote.scratch.fetch",
        "+refs/heads/next:refs/remotes/scratch/next",
      );
    }
    await expectSameSetBranches(n, o, ["--add", "scratch", "seen"]);
    await expectSameSetBranches(n, o, ["nosuch", "x"]);
    // no fetch refspec to replace: git's config write fails, nothing changes
    for (const d of [n, o]) git(join(root, d), "config", "remote.nofetch.url", "../one");
    expect((await expectSameSetBranches(n, o, ["nofetch", "x"])).status).toBe(1);
    await expectSameSetBranches(n, o, ["--add", "nofetch", "x"]);

    const [n2, o2] = emptyTwins((dir) => {
      mirrorOf("one")(dir);
      git(dir, "remote", "rename", "origin", "scratch");
    });
    await expectSameSetBranches(n2, o2, ["scratch", "heads/main"]);
    // a push mirror writes mirror refspecs too (remote.<name>.mirror)
    for (const d of [n, o]) git(join(root, d), "remote", "add", "--mirror=push", "pm", "../one");
    await expectSameSetBranches(n, o, ["--add", "pm", "heads/main"]);
  });
});
