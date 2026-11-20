/**
 * `git push` to a repository named by a path, against native git: receive-pack runs over the
 * target's own configuration and worktrees. A branch checked out in any worktree of the
 * target (linked ones included, git's `find_shared_symref`) is refused, and the target's
 * `receive.*` and `transfer.hideRefs` settings rule the push (and fetch and ls-remote for
 * the hidden refs) as they rule git's.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, GitApiError, PushResult } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;
const git = (cwd: string, ...args: string[]) => gitOut(root, cwd, args);

/** Our working copy over `<root>/<name>`, its FilesApi rooted at `root`. */
async function ours(name: string): Promise<Git> {
  return openOurs(root, createNodeGitHostEnvironment({ env: testEnv(root) }), undefined, name);
}

/** The refs of `<root>/<dir>`. */
const refs = (dir: string) =>
  git(join(root, dir), "for-each-ref", "--format=%(refname) %(objectname)");

/**
 * Two pushers, `n<k>` (native) and `o<k>` (ours), each with the source's history and a new
 * commit on `topic` and on `main`, and a target per pusher made by `makeTarget(dir)`.
 */
function setup(makeTarget: (target: string) => void): { n: string; o: string } {
  const n = `n${counter}`;
  const o = `o${counter}`;
  counter++;
  for (const d of [n, o]) {
    const dir = join(root, d);
    git(root, "clone", "-q", "src", d);
    git(dir, "checkout", "-q", "-b", "topic", "origin/topic");
    putFile(dir, "t.txt", "pushed topic\n");
    git(dir, "add", "t.txt");
    git(dir, "commit", "-qm", "topic pushed");
    git(dir, "checkout", "-q", "main");
    putFile(dir, "m.txt", "pushed main\n");
    git(dir, "add", "m.txt");
    git(dir, "commit", "-qm", "main pushed");
    makeTarget(`${d}-dst`);
  }
  return { n, o };
}

/** Native `git push --porcelain` as `<dst> ok` / `<dst> rejected <reason>` lines. */
function nativePush(pusher: string, args: string[]) {
  const r = gitRun(root, join(root, pusher), ["push", "--porcelain", ...args]);
  const lines = r.stdout
    .split("\n")
    .filter((l) => /^[ +\-*=!]\t/.test(l))
    .map((l) => {
      const [flag, spec, summary] = l.split("\t");
      const dst = (spec ?? "").slice((spec ?? "").indexOf(":") + 1);
      const reason = /\((.*)\)$/.exec(summary ?? "")?.[1];
      return flag === "!" ? `${dst} rejected ${reason}` : `${dst} ok`;
    });
  const remote = r.stderr
    .split("\n")
    .filter((l) => l.startsWith("remote: "))
    // git pads each line to clear a progress line
    .map((l) => l.slice("remote: ".length).trimEnd());
  return { status: r.status, lines: lines.sort(), remote };
}

/** Our push result as the lines {@link nativePush} gives. */
function ourLines(result: PushResult): string[] {
  return result.remoteUpdates
    .map((u) =>
      u.status === "ok" || u.status === "up-to-date"
        ? `${u.remoteName} ok`
        : `${u.remoteName} rejected ${u.message}`,
    )
    .sort();
}

/** The remote's lines of our push (what git prints after "remote: "). */
function ourRemote(result: PushResult): string[] {
  // progress (native git prints none to a pipe)
  const lines = result.messages
    .join("")
    .split("\n")
    .filter((l) => !l.startsWith("Checking connectivity"));
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Pushes `specs` to `<pusher>-dst` from both pushers and compares the outcome. */
async function pushBoth(
  n: string,
  o: string,
  specs: string[],
  options: { force?: boolean; compareRemote?: boolean } = {},
) {
  const native = nativePush(n, [...(options.force ? ["-f"] : []), `../${n}-dst`, ...specs]);
  let push = (await ours(o))
    .push()
    .setRemote(`../${o}-dst`)
    .setRefSpecs(...specs);
  if (options.force) push = push.setForce(true);
  const result = await push.call();
  expect(ourLines(result)).toEqual(native.lines);
  if (options.compareRemote !== false) expect(ourRemote(result)).toEqual(native.remote);
  expect(refs(`${o}-dst`)).toBe(refs(`${n}-dst`));
  return { native, result };
}

describeGit("push to a local repository: the target's worktrees and receive.* config", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "push-local-"));
    const src = join(root, "src");
    mkdirSync(src);
    git(src, "init", "-q", "-b", "main");
    putFile(src, "a.txt", "a\n");
    git(src, "add", "a.txt");
    git(src, "commit", "-qm", "one");
    git(src, "branch", "topic");
    git(src, "branch", "other");
    // a history of two commits, for shallow clones
    const deep = join(root, "deep");
    mkdirSync(deep);
    git(deep, "init", "-q", "-b", "main");
    for (const i of [1, 2]) {
      putFile(deep, "d.txt", `${i}\n`);
      git(deep, "add", "d.txt");
      git(deep, "commit", "-qm", `deep ${i}`);
    }
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A clone of the source with `topic` checked out in a linked worktree `<target>-linked`. */
  const withLinkedWorktree = (target: string) => {
    git(root, "clone", "-q", "src", target);
    git(join(root, target), "branch", "topic", "origin/topic");
    git(join(root, target), "worktree", "add", "-q", `../${target}-linked`, "topic");
  };

  it("refuses to update a branch checked out in a linked worktree of the target", async () => {
    const { n, o } = setup(withLinkedWorktree);
    const { native } = await pushBoth(n, o, ["topic:topic"]);
    expect(native.status).toBe(1);
    expect(native.remote[0]).toBe("error: refusing to update checked out branch: refs/heads/topic");
    expect(git(join(root, `${o}-dst-linked`), "status", "--porcelain")).toBe("");
  });

  it("refuses to delete a branch checked out in a linked worktree of the target", async () => {
    const { n, o } = setup(withLinkedWorktree);
    const { native } = await pushBoth(n, o, [":topic"]);
    expect(native.status).toBe(1);
    expect(native.lines).toEqual(["refs/heads/topic rejected branch is currently checked out"]);
  });

  it("refuses a branch a linked worktree is rebasing (detached HEAD)", async () => {
    const { n, o } = setup((target) => {
      withLinkedWorktree(target);
      const linked = join(root, `${target}-linked`);
      putFile(linked, "x.txt", "x\n");
      git(linked, "add", "x.txt");
      git(linked, "commit", "-qm", "x");
      // a rebase stopped at its first pick: HEAD detached, the branch in rebase-merge/head-name
      expect(gitRun(root, linked, ["rebase", "-q", "-x", "false", "HEAD~1"]).status).toBe(1);
    });
    await pushBoth(n, o, ["+topic:topic"]);
  });

  it("accepts a forced update by default (receive.denyNonFastForwards unset)", async () => {
    const { n, o } = setup((target) => git(root, "clone", "-q", "--bare", "src", target));
    // the pushers' own `other` is behind nothing: force main over the target's other after
    // moving the target's other ahead
    for (const d of [n, o]) {
      const dst = join(root, `${d}-dst`);
      const tree = git(dst, "rev-parse", "other^{tree}").trim();
      const id = git(dst, "commit-tree", "-p", "other", "-m", "ahead", tree).trim();
      git(dst, "update-ref", "refs/heads/other", id);
    }
    await pushBoth(n, o, ["+main:other"]);
  });

  it("receive.denyNonFastForwards refuses a forced update", async () => {
    const { n, o } = setup((target) => {
      git(root, "clone", "-q", "--bare", "src", target);
      const dst = join(root, target);
      git(dst, "config", "receive.denyNonFastForwards", "true");
      const tree = git(dst, "rev-parse", "other^{tree}").trim();
      const id = git(dst, "commit-tree", "-p", "other", "-m", "ahead", tree).trim();
      git(dst, "update-ref", "refs/heads/other", id);
    });
    const { native } = await pushBoth(n, o, ["+main:other"]);
    expect(native.lines).toEqual(["refs/heads/other rejected non-fast-forward"]);
  });

  it("receive.denyDeletes refuses deleting a branch", async () => {
    const { n, o } = setup((target) => {
      git(root, "clone", "-q", "--bare", "src", target);
      git(join(root, target), "config", "receive.denyDeletes", "true");
    });
    const { native } = await pushBoth(n, o, [":other"]);
    expect(native.lines).toEqual(["refs/heads/other rejected deletion prohibited"]);
  });

  for (const value of ["ignore", "warn", "false", "refuse", "true"]) {
    it(`receive.denyCurrentBranch=${value}`, async () => {
      const { n, o } = setup((target) => {
        git(root, "clone", "-q", "src", target);
        git(join(root, target), "config", "receive.denyCurrentBranch", value);
      });
      await pushBoth(n, o, ["main:main"]);
      // the worktree is left as it was
      expect(git(join(root, `${o}-dst`), "ls-files", "-s")).toBe(
        git(join(root, `${n}-dst`), "ls-files", "-s"),
      );
    });
  }

  it("receive.denyCurrentBranch=updateInstead checks the pushed commit out in a clean worktree", async () => {
    const { n, o } = setup((target) => {
      git(root, "clone", "-q", "src", target);
      git(join(root, target), "config", "receive.denyCurrentBranch", "updateInstead");
    });
    const { native } = await pushBoth(n, o, ["main:main"]);
    expect(native.status).toBe(0);
    for (const args of [
      ["ls-files", "-s"],
      ["status", "--porcelain"],
    ]) {
      expect(git(join(root, `${o}-dst`), ...args)).toBe(git(join(root, `${n}-dst`), ...args));
    }
    expect(readFileSync(join(root, `${o}-dst`, "m.txt"), "utf8")).toBe("pushed main\n");
  });

  it("receive.denyCurrentBranch=updateInstead updates a linked worktree's branch", async () => {
    const { n, o } = setup((target) => {
      withLinkedWorktree(target);
      git(join(root, target), "config", "receive.denyCurrentBranch", "updateInstead");
    });
    await pushBoth(n, o, ["topic:topic"]);
    expect(readFileSync(join(root, `${o}-dst-linked`, "t.txt"), "utf8")).toBe("pushed topic\n");
    expect(git(join(root, `${o}-dst-linked`), "status", "--porcelain")).toBe("");
  });

  for (const [what, dirty] of [
    ["unstaged", (dst: string) => putFile(dst, "a.txt", "changed\n")],
    [
      "staged",
      (dst: string) => {
        putFile(dst, "s.txt", "staged\n");
        execFileSync("git", ["add", "s.txt"], { cwd: dst, env: testEnv(root) });
      },
    ],
  ] as const) {
    it(`receive.denyCurrentBranch=updateInstead refuses a worktree with ${what} changes`, async () => {
      const { n, o } = setup((target) => {
        git(root, "clone", "-q", "src", target);
        git(join(root, target), "config", "receive.denyCurrentBranch", "updateInstead");
        dirty(join(root, target));
      });
      const { native } = await pushBoth(n, o, ["main:main"], { compareRemote: false });
      expect(native.lines).toEqual([
        `refs/heads/main rejected Working directory has ${what} changes`,
      ]);
      expect(git(join(root, `${o}-dst`), "status", "--porcelain")).toBe(
        git(join(root, `${n}-dst`), "status", "--porcelain"),
      );
    });
  }

  for (const value of [undefined, "ignore", "warn", "refuse"]) {
    it(`receive.denyDeleteCurrent=${value ?? "(unset)"} on a bare repository`, async () => {
      const { n, o } = setup((target) => {
        git(root, "clone", "-q", "--bare", "src", target);
        if (value) git(join(root, target), "config", "receive.denyDeleteCurrent", value);
      });
      await pushBoth(n, o, [":main"]);
    });
  }

  it("transfer.hideRefs and receive.hideRefs refuse a push to a hidden ref", async () => {
    const { n, o } = setup((target) => {
      git(root, "clone", "-q", "--bare", "src", target);
      git(join(root, target), "config", "transfer.hideRefs", "refs/heads/other");
      git(join(root, target), "config", "receive.hideRefs", "refs/heads/topic/");
    });
    await pushBoth(n, o, ["main:other", "main:topic", "main:main"]);
  });

  it("uploadpack.hideRefs and transfer.hideRefs hide refs from ls-remote and fetch", async () => {
    const { n, o } = setup((target) => {
      git(root, "clone", "-q", "--bare", "src", target);
      git(join(root, target), "config", "uploadpack.hideRefs", "refs/heads/other");
      git(join(root, target), "config", "--add", "transfer.hideRefs", "refs/heads/topic");
      git(join(root, target), "config", "--add", "transfer.hideRefs", "!refs/heads/topic");
      git(join(root, target), "config", "receive.hideRefs", "refs/heads/main");
    });
    const native = git(join(root, n), "ls-remote", `../${n}-dst`)
      .split("\n")
      .filter((l) => l && !l.endsWith("\tHEAD"))
      .map((l) => l.split("\t").reverse().join(" "));
    const result = await (await ours(o)).lsRemote().setRemote(`../${o}-dst`).call();
    expect(result.refs.map((r) => `${r.name} ${r.objectId}`)).toEqual(native);
    expect(native.some((l) => l.startsWith("refs/heads/other "))).toBe(false);
    expect(native.some((l) => l.startsWith("refs/heads/topic "))).toBe(true);

    // a fetch of the hidden branch finds no such ref
    const fetched = gitRun(root, join(root, n), ["fetch", `../${n}-dst`, "other"]);
    expect(fetched.status).toBe(128);
    let error: GitApiError | undefined;
    try {
      await (await ours(o)).fetch().setRemote(`../${o}-dst`).setRefSpecs("other").call();
    } catch (e) {
      error = e as GitApiError;
    }
    expect(error?.message).toBe(fetched.stderr.trim());
    expect(error?.exitCode).toBe(fetched.status);
  });

  for (const value of [undefined, "true"]) {
    it(`a push from a shallow clone, receive.shallowUpdate=${value ?? "(unset)"}`, async () => {
      const n = `n${counter}`;
      const o = `o${counter}`;
      counter++;
      for (const d of [n, o]) {
        const dir = join(root, d);
        git(root, "clone", "-q", "--depth", "1", `file://${join(root, "deep")}`, d);
        putFile(dir, "s.txt", "shallow\n");
        git(dir, "add", "s.txt");
        git(dir, "commit", "-qm", "on a shallow clone");
        git(root, "init", "-q", "--bare", `${d}-dst`);
        if (value) git(join(root, `${d}-dst`), "config", "receive.shallowUpdate", value);
      }
      await pushBoth(n, o, ["main:main"]);
      const shallow = (d: string) => {
        try {
          return readFileSync(join(root, `${d}-dst`, "shallow"), "utf8");
        } catch {
          return undefined;
        }
      };
      expect(shallow(o)).toBe(shallow(n));
      if (value) expect(git(join(root, `${o}-dst`), "fsck", "--no-progress")).toBe("");
    });
  }

  it("a linked worktree (a gitfile into the repository's commondir) as the remote", async () => {
    const { n, o } = setup((target) => {
      withLinkedWorktree(target);
      // the linked worktree's branch moves on: its HEAD is told apart from main's
      const linked = join(root, `${target}-linked`);
      putFile(linked, "l.txt", "linked\n");
      git(linked, "add", "l.txt");
      git(linked, "commit", "-qm", "linked");
    });
    // ls-remote: the refs, and HEAD as the linked worktree's own (topic)
    for (const [mine, theirs] of [
      [n, `../${n}-dst-linked`],
      [o, `../${o}-dst-linked`],
    ] as const) {
      expect(gitRun(root, join(root, mine), ["ls-remote", theirs]).status).toBe(0);
    }
    const native = git(join(root, n), "ls-remote", "--symref", `../${n}-dst-linked`, "HEAD");
    const result = await (await ours(o)).lsRemote().setRemote(`../${o}-dst-linked`).call();
    expect(native).toContain("ref: refs/heads/topic\tHEAD");
    expect(result.defaultBranch).toBe("topic");
    const nativeRefs = git(join(root, n), "ls-remote", `../${n}-dst-linked`)
      .split("\n")
      .filter((l) => l && !l.endsWith("\tHEAD"))
      .map((l) => l.split("\t").reverse().join(" "));
    expect(result.refs.map((r) => `${r.name} ${r.objectId}`)).toEqual(nativeRefs);

    // fetch from it
    const fetched = gitRun(root, join(root, n), ["fetch", `../${n}-dst-linked`, "topic"]);
    expect(fetched.status).toBe(0);
    await (await ours(o)).fetch().setRemote(`../${o}-dst-linked`).setRefSpecs("topic").call();
    expect(readFileSync(join(root, o, ".git/FETCH_HEAD"), "utf8").split("\t")[0]).toBe(
      readFileSync(join(root, n, ".git/FETCH_HEAD"), "utf8").split("\t")[0],
    );

    // push to it: its own branch and the main worktree's are both checked out
    const specs = ["+topic:topic", "main:main", "main:other"];
    const native2 = nativePush(n, [`../${n}-dst-linked`, ...specs]);
    const ourPush = await (await ours(o))
      .push()
      .setRemote(`../${o}-dst-linked`)
      .setRefSpecs(...specs)
      .call();
    expect(ourLines(ourPush)).toEqual(native2.lines);
    expect(refs(`${o}-dst`)).toBe(refs(`${n}-dst`));
  });
});
