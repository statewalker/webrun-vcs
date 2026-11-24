/**
 * `pull` (merge and rebase) against native `git pull`: two clones of one remote, made the
 * same way, each with a local commit that conflicts with the remote's new one; native git
 * pulls in one, ours (over `git http-backend`) in the other, then status, index, worktree
 * and state files compared.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MergeStatus, RebaseStatus } from "../src/index.js";
import { git, gitOk, normalizeState, openOurs, put, snapshot } from "./merge-native-helpers.js";
import { text } from "./merge-native-scenarios.js";
import {
  type NativeGitHttpBackend,
  nativeGitAvailable,
  nativeGitHttpBackend,
} from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const URL = "http://git.test/src.git";

describeGit("pull writes the worktree as native git", () => {
  let root: string;
  let backend: NativeGitHttpBackend;
  const originalFetch = globalThis.fetch;

  /** The remote with a base commit, two clones of it, then a conflicting commit each side. */
  function setup(): { native: string; ours: string } {
    const src = join(root, "src.git");
    const work = join(root, "work");
    gitOk(root, root, "init", "-q", "-b", "main", work);
    put(work, "a.txt", text());
    put(work, "b.txt", "b\n");
    gitOk(root, work, "add", ".");
    gitOk(root, work, "commit", "-q", "-m", "base");
    gitOk(root, root, "clone", "-q", "--bare", work, src);
    const native = join(root, "native");
    const ours = join(root, "ours");
    for (const dir of [native, ours]) {
      gitOk(root, root, "clone", "-q", src, dir);
      put(dir, "a.txt", text({ 5: "local" }));
      gitOk(root, dir, "commit", "-q", "-am", "local");
    }
    put(work, "a.txt", text({ 5: "upstream" }));
    put(work, "c.txt", "c\n");
    gitOk(root, work, "add", ".");
    gitOk(root, work, "commit", "-q", "-m", "upstream");
    gitOk(root, work, "push", "-q", src, "main");
    gitOk(root, ours, "config", "remote.origin.url", URL);
    return { native, ours };
  }

  /** State files with the remote's URL (in `Merge branch 'main' of <url>`) evened out. */
  const normalize = (name: string, content: string) =>
    normalizeState(name, content).replace(/ of \S+/, " of <url>");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pull-worktree-"));
    backend = nativeGitHttpBackend(root, root);
    globalThis.fetch = backend.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    backend?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("a pull that merges with a conflict leaves what git pull leaves", async () => {
    const { native, ours } = setup();
    git(root, native, "-c", "pull.rebase=false", "pull", "origin", "main");
    const result = await (await openOurs(ours)).pull().setRemoteBranchName("main").call();
    expect(result.mergeResult?.status).toBe(MergeStatus.CONFLICTING);
    expect(snapshot(root, ours, normalize)).toEqual(snapshot(root, native, normalize));
    expect(gitOk(root, ours, "rev-parse", "MERGE_HEAD")).toBe(
      gitOk(root, native, "rev-parse", "MERGE_HEAD"),
    );
  });

  it("a merging pull under merge.log puts the shortlog in MERGE_MSG (t7600 'merge log message')", async () => {
    const { native, ours } = setup();
    for (const dir of [native, ours]) gitOk(root, dir, "config", "merge.log", "true");
    git(root, native, "-c", "pull.rebase=false", "pull", "origin", "main");
    const result = await (await openOurs(ours)).pull().setRemoteBranchName("main").call();
    expect(result.mergeResult?.status).toBe(MergeStatus.CONFLICTING);
    // the URL in the title and in the shortlog's name
    const urls = (name: string, content: string) =>
      normalizeState(name, content).replace(/ of \S+?(?=:?\n)/g, " of <url>");
    expect(snapshot(root, ours, urls)).toEqual(snapshot(root, native, urls));
    expect(snapshot(root, ours, urls).state.MERGE_MSG).toMatch(
      /^Merge branch 'main' of <url>\n\n\* 'main' of <url>:\n {2}upstream\n/,
    );
  });

  it("a pull --rebase stops at the conflict as git pull --rebase does", async () => {
    const { native, ours } = setup();
    git(root, native, "-c", "pull.rebase=true", "pull", "origin", "main");
    const result = await (await openOurs(ours))
      .pull()
      .setRemoteBranchName("main")
      .setRebase(true)
      .call();
    expect(result.rebaseResult?.status).toBe(RebaseStatus.STOPPED);
    expect(snapshot(root, ours, normalize)).toEqual(snapshot(root, native, normalize));
  });
});

describeGit("pull on an unborn branch, as native git", () => {
  let root: string;
  let backend: NativeGitHttpBackend;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pull-unborn-"));
    backend = nativeGitHttpBackend(root, root);
    globalThis.fetch = backend.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    backend?.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** The remote with one commit, and two unborn repositories that track its main. */
  function setup(): { native: string; ours: string } {
    const work = join(root, "work");
    gitOk(root, root, "init", "-q", "-b", "main", work);
    put(work, "a.txt", "a\n");
    put(work, "f.txt", "f\n");
    gitOk(root, work, "add", ".");
    gitOk(root, work, "commit", "-q", "-m", "base");
    gitOk(root, root, "clone", "-q", "--bare", work, join(root, "src.git"));
    const native = join(root, "native");
    const ours = join(root, "ours");
    for (const dir of [native, ours]) {
      gitOk(root, root, "init", "-q", "-b", "main", dir);
      gitOk(root, dir, "remote", "add", "origin", join(root, "src.git"));
      gitOk(root, dir, "config", "branch.main.remote", "origin");
      gitOk(root, dir, "config", "branch.main.merge", "refs/heads/main");
    }
    gitOk(root, ours, "config", "remote.origin.url", URL);
    return { native, ours };
  }

  const both = (dirs: { native: string; ours: string }, fn: (dir: string) => void) => {
    fn(dirs.native);
    fn(dirs.ours);
  };

  it("pull --rebase refuses staged changes before fetching, as git", async () => {
    const dirs = setup();
    both(dirs, (dir) => {
      put(dir, "s.txt", "staged\n");
      gitOk(root, dir, "add", "s.txt");
    });
    const theirs = git(root, dirs.native, "pull", "--rebase");
    expect(theirs.status).toBe(128);
    const result = await (await openOurs(dirs.ours)).pull().setRebase(true).call();
    expect(result.successful).toBe(false);
    expect(result.fetchResult).toBeUndefined();
    expect(result.rebaseResult?.status).toBe(RebaseStatus.FAILED);
    expect(`${result.rebaseResult?.message}\n`).toBe(theirs.stderr);
    expect(snapshot(root, dirs.ours)).toEqual(snapshot(root, dirs.native));
    // nothing fetched on either side
    expect(git(root, dirs.ours, "rev-parse", "-q", "--verify", "origin/main").status).toBe(1);
    expect(git(root, dirs.native, "rev-parse", "-q", "--verify", "origin/main").status).toBe(1);
  });

  it("an index file without entries refuses too, and --autostash does not help", async () => {
    const dirs = setup();
    both(dirs, (dir) => {
      put(dir, "s.txt", "x\n");
      gitOk(root, dir, "add", "s.txt");
      gitOk(root, dir, "rm", "-q", "--cached", "s.txt");
    });
    const theirs = git(root, dirs.native, "pull", "--rebase", "--autostash");
    expect(theirs.status).toBe(128);
    const result = await (await openOurs(dirs.ours))
      .pull()
      .setRebase(true)
      .setAutoStash(true)
      .call();
    expect(result.rebaseResult?.status).toBe(RebaseStatus.FAILED);
    expect(`${result.rebaseResult?.message}\n`).toBe(theirs.stderr);
  });

  it("pull --rebase with only untracked files pulls into the void, as git", async () => {
    const dirs = setup();
    both(dirs, (dir) => put(dir, "u.txt", "u\n"));
    gitOk(root, dirs.native, "pull", "-q", "--rebase");
    const result = await (await openOurs(dirs.ours)).pull().setRebase(true).call();
    expect(result.successful).toBe(true);
    expect(snapshot(root, dirs.ours)).toEqual(snapshot(root, dirs.native));
  });

  it("a merging pull keeps the staged changes it does not overwrite, as git", async () => {
    const dirs = setup();
    both(dirs, (dir) => {
      put(dir, "s.txt", "staged\n");
      gitOk(root, dir, "add", "s.txt");
    });
    gitOk(root, dirs.native, "pull", "-q", "--no-rebase");
    const result = await (await openOurs(dirs.ours)).pull().setRebase(false).call();
    expect(result.successful).toBe(true);
    expect(snapshot(root, dirs.ours)).toEqual(snapshot(root, dirs.native));
    // refs_update_ref(..., "initial pull"): HEAD's log and its branch's
    for (const ref of ["HEAD", "main"]) {
      const log = (dir: string) => gitOk(root, dir, "reflog", "show", "--format=%gs", ref);
      expect(log(dirs.ours)).toBe(log(dirs.native));
    }
  });

  it("a merging pull refuses a staged file it would overwrite, as git", async () => {
    const dirs = setup();
    both(dirs, (dir) => {
      put(dir, "a.txt", "other\n");
      gitOk(root, dir, "add", "a.txt");
    });
    const theirs = git(root, dirs.native, "pull", "-q", "--no-rebase");
    expect(theirs.status).toBe(1);
    const result = await (await openOurs(dirs.ours)).pull().setRebase(false).call();
    expect(result.successful).toBe(false);
    expect(snapshot(root, dirs.ours)).toEqual(snapshot(root, dirs.native));
  });
});
