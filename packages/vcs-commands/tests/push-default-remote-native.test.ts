/**
 * `git push` with no remote named, against native git: the remote comes from git's
 * `pushremote_for_branch` (remote.c): `branch.<current>.pushRemote`, `remote.pushDefault`,
 * `branch.<current>.remote`, the one configured remote, then `origin`; a detached HEAD skips
 * the branch's settings. With none of them configured git dies "No configured push
 * destination." Each case builds two identical repositories, pushes from one with native git
 * and from the other with ours, and compares which remote received `main`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, noMaintenance } from "./native-git-http-backend.js";
import { gitOut, gitRun, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

async function ours(name: string): Promise<Git> {
  return openOurs(root, createNodeGitHostEnvironment({ env: testEnv(root) }), undefined, name);
}

const REMOTES = ["origin", "other", "third"] as const;

/**
 * A repository `<name>` with one commit on `main`, `push.default=current`, and bare
 * repositories `<name>-<remote>.git` for each remote `configure` adds.
 */
function build(name: string, configure: (dir: string, add: (remote: string) => void) => void) {
  const dir = join(root, name);
  git(root, "init", "-q", "-b", "main", name);
  git(dir, "commit", "-q", "--allow-empty", "-m", "first");
  git(dir, "config", "push.default", "current");
  configure(dir, (remote) => {
    const bare = `${name}-${remote}.git`;
    git(root, "init", "-q", "--bare", bare);
    noMaintenance(join(root, bare));
    git(dir, "remote", "add", remote, `../${bare}`);
  });
}

/** The remotes of `<name>` whose bare repository holds `refs/heads/main`. */
function received(name: string): string[] {
  return REMOTES.filter(
    (remote) =>
      gitRun(root, root, [
        "--git-dir",
        join(root, `${name}-${remote}.git`),
        "rev-parse",
        "-q",
        "--verify",
        "refs/heads/main",
      ]).status === 0,
  );
}

/** Pushes with no remote from a native and from our twin of `configure`; compares results. */
async function pushBoth(configure: (dir: string, add: (remote: string) => void) => void) {
  const n = `n${counter}`;
  const o = `o${counter}`;
  counter++;
  build(n, configure);
  build(o, configure);
  const native = gitRun(root, join(root, n), ["push", "-q"]);
  let error: unknown;
  try {
    await (await ours(o)).push().call();
  } catch (e) {
    error = e;
  }
  return { native, error, nativeReceived: received(n), ourReceived: received(o) };
}

describeGit("push without a remote (native git)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "push-default-remote-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("pushes to branch.<name>.pushRemote first", async () => {
    const r = await pushBoth((dir, add) => {
      for (const remote of REMOTES) add(remote);
      git(dir, "config", "branch.main.remote", "origin");
      git(dir, "config", "remote.pushDefault", "other");
      git(dir, "config", "branch.main.pushRemote", "third");
    });
    expect(r.native.status).toBe(0);
    expect(r.error).toBeUndefined();
    expect(r.nativeReceived).toEqual(["third"]);
    expect(r.ourReceived).toEqual(r.nativeReceived);
  });

  it("pushes to remote.pushDefault before branch.<name>.remote", async () => {
    const r = await pushBoth((dir, add) => {
      add("origin");
      add("other");
      git(dir, "config", "branch.main.remote", "origin");
      git(dir, "config", "remote.pushDefault", "other");
    });
    expect(r.native.status).toBe(0);
    expect(r.error).toBeUndefined();
    expect(r.nativeReceived).toEqual(["other"]);
    expect(r.ourReceived).toEqual(r.nativeReceived);
  });

  it("pushes to branch.<name>.remote before origin", async () => {
    const r = await pushBoth((dir, add) => {
      add("origin");
      add("other");
      git(dir, "config", "branch.main.remote", "other");
    });
    expect(r.native.status).toBe(0);
    expect(r.error).toBeUndefined();
    expect(r.nativeReceived).toEqual(["other"]);
    expect(r.ourReceived).toEqual(r.nativeReceived);
  });

  it("pushes to the one configured remote, whatever its name", async () => {
    const r = await pushBoth((_dir, add) => add("other"));
    expect(r.native.status).toBe(0);
    expect(r.error).toBeUndefined();
    expect(r.nativeReceived).toEqual(["other"]);
    expect(r.ourReceived).toEqual(r.nativeReceived);
  });

  it("pushes to origin among several remotes", async () => {
    const r = await pushBoth((_dir, add) => {
      add("other");
      add("origin");
    });
    expect(r.native.status).toBe(0);
    expect(r.error).toBeUndefined();
    expect(r.nativeReceived).toEqual(["origin"]);
    expect(r.ourReceived).toEqual(r.nativeReceived);
  });

  it("on a detached HEAD, skips the branch's settings", async () => {
    const r = await pushBoth((dir, add) => {
      add("origin");
      add("other");
      git(dir, "config", "branch.main.pushRemote", "origin");
      git(dir, "config", "remote.pushDefault", "other");
      for (const remote of ["origin", "other"]) {
        git(dir, "config", `remote.${remote}.push`, "HEAD:refs/heads/main");
      }
      git(dir, "checkout", "-q", "--detach");
    });
    expect(r.native.status).toBe(0);
    expect(r.error).toBeUndefined();
    expect(r.nativeReceived).toEqual(["other"]);
    expect(r.ourReceived).toEqual(r.nativeReceived);
  });

  it("refuses when no remote is configured and origin is missing", async () => {
    const r = await pushBoth((_dir, add) => {
      add("other");
      add("third");
    });
    expect(r.native.status).toBe(128);
    expect(r.native.stderr).toContain("fatal: No configured push destination.");
    expect((r.error as Error | undefined)?.message).toContain("No configured push destination.");
    expect(r.nativeReceived).toEqual([]);
    expect(r.ourReceived).toEqual([]);
  });

  it("takes a URL or path in branch.<name>.pushRemote, as git takes any explicit name", async () => {
    const r = await pushBoth((dir, add) => {
      add("origin");
      add("other");
      // the configured value is a path, no remote of that name: remote_get adds a URL alias
      git(dir, "config", "branch.main.pushRemote", `../${dir.slice(root.length + 1)}-other.git`);
    });
    expect(r.native.status).toBe(0);
    expect(r.error).toBeUndefined();
    expect(r.nativeReceived).toEqual(["other"]);
    expect(r.ourReceived).toEqual(r.nativeReceived);
  });

  it("takes a path in remote.pushDefault and branch.<name>.remote", async () => {
    for (const key of ["remote.pushDefault", "branch.main.remote"]) {
      const r = await pushBoth((dir, add) => {
        add("origin");
        add("third");
        git(dir, "config", key, `../${dir.slice(root.length + 1)}-third.git`);
      });
      expect(r.native.status).toBe(0);
      expect(r.error).toBeUndefined();
      expect(r.nativeReceived).toEqual(["third"]);
      expect(r.ourReceived).toEqual(r.nativeReceived);
    }
  });

  it("pushes to the repository itself for branch.<name>.remote = . (git branch --track)", async () => {
    const n = `n${counter}`;
    const o = `o${counter}`;
    counter++;
    for (const name of [n, o]) {
      build(name, (dir, add) => {
        add("origin");
        git(dir, "config", "branch.main.remote", ".");
        // push.default=current pushes main onto main of `.`: up to date
      });
    }
    const native = gitRun(root, join(root, n), ["push", "--porcelain"]);
    expect(native.status).toBe(0);
    const result = await (await ours(o)).push().call();
    expect(result.remoteUpdates.map((u) => `${u.remoteName} ${u.status}`)).toEqual([
      "refs/heads/main up-to-date",
    ]);
    expect(received(n)).toEqual([]);
    expect(received(o)).toEqual([]);
  });

  it("an explicit remote still wins over every setting", async () => {
    const n = `n${counter}`;
    counter++;
    build(n, (dir, add) => {
      add("origin");
      add("other");
      git(dir, "config", "remote.pushDefault", "other");
    });
    await (await ours(n)).push().setRemote("origin").call();
    expect(received(n)).toEqual(["origin"]);
  });
});
