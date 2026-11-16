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
