/**
 * `git stash create [<message>]` against native git: ours is `stashCreate().setRef(null)`
 * (`git.stashCreate()` alone is `git stash push`). git's create_stash builds the stash
 * commit and prints its id, and touches nothing else: the worktree, the index's entries,
 * `refs/stash` and its reflog, HEAD and ORIG_HEAD stay as they were. With nothing to stash
 * it prints nothing (exit 0). Both repositories are built with the same identities and
 * dates, so the stash ids are equal.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, openRepo, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
let counter = 0;

/** A repository with a commit (and an older stash), copied twice; `dirty` makes changes. */
function twins(dirty: boolean): [string, string] {
  const dirs: [string, string] = [join(root, `n${counter}`), join(root, `o${counter}`)];
  counter++;
  const [first] = dirs;
  mkdirSync(first, { recursive: true });
  gitOut(root, first, ["init", "-q", "-b", "main"]);
  putFile(first, "a.txt", "a\n");
  putFile(first, "b.txt", "b\n");
  putFile(first, "dir/c.txt", "c\n");
  gitOut(root, first, ["add", "."]);
  gitOut(root, first, ["commit", "-qm", "base"]);
  // an existing stash entry, so refs/stash and its reflog have something to keep
  putFile(first, "b.txt", "stashed\n");
  gitOut(root, first, ["stash", "-q"]);
  if (dirty) {
    // staged, staged then changed again, unstaged, a new staged file, an untracked file
    putFile(first, "a.txt", "a staged\n");
    putFile(first, "dir/c.txt", "c staged\n");
    putFile(first, "new.txt", "new\n");
    gitOut(root, first, ["add", "a.txt", "dir/c.txt", "new.txt"]);
    putFile(first, "dir/c.txt", "c staged then changed\n");
    putFile(first, "b.txt", "b unstaged\n");
    putFile(first, "untracked.txt", "untracked\n");
  }
  gitOut(root, first, ["update-index", "-q", "--refresh"]);
  execFileSync("cp", ["-a", first, dirs[1]]);
  gitOut(root, dirs[1], ["update-index", "-q", "--refresh"]);
  return dirs;
}

const FILES = ["a.txt", "b.txt", "dir/c.txt", "new.txt", "untracked.txt"];

/** What `stash create` must leave alone, read with native git. */
function state(dir: string) {
  const refOrNone = (name: string) => {
    const r = gitRun(root, dir, ["rev-parse", "-q", "--verify", name]);
    return r.status === 0 ? r.stdout.trim() : undefined;
  };
  return {
    files: FILES.map((f) =>
      existsSync(join(dir, f)) ? readFileSync(join(dir, f), "latin1") : undefined,
    ),
    index: gitOut(root, dir, ["ls-files", "-s"]),
    status: gitOut(root, dir, ["status", "--porcelain=v1", "-uall"]),
    head: gitOut(root, dir, ["symbolic-ref", "HEAD"]),
    headId: refOrNone("HEAD"),
    origHead: refOrNone("ORIG_HEAD"),
    stash: refOrNone("refs/stash"),
    stashLog: gitOut(root, dir, ["reflog", "show", "--format=%H %gs", "refs/stash"]),
    headLog: gitOut(root, dir, ["reflog", "show", "--format=%H %gs", "HEAD"]),
  };
}

/** The stash commit's tree, parents, and each parent's tree and message. */
function structure(dir: string, id: string) {
  const show = (rev: string) => gitOut(root, dir, ["cat-file", "commit", rev]);
  const parents = gitOut(root, dir, ["rev-list", "--parents", "-n1", id])
    .trim()
    .split(" ")
    .slice(1);
  return { commit: show(id), parents: parents.map(show) };
}

describeGit("stash create: as native git, nothing but the commit", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "stash-create-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  for (const message of [undefined, "a message"]) {
    it(`stash create${message ? ` "${message}"` : ""}: same commit, nothing else changed`, async () => {
      const [theirs, mine] = twins(true);
      const before = state(mine);
      expect(state(theirs)).toEqual(before);
      const indexBytes = readFileSync(join(mine, ".git/index"));

      const native = gitRun(root, theirs, ["stash", "create", ...(message ? [message] : [])]);
      expect(native.stderr).toBe("");
      expect(native.status).toBe(0);
      const nativeId = native.stdout.trim();
      expect(nativeId).toMatch(/^[0-9a-f]{40}$/);

      const git = await openRepo(root, mine);
      const command = git.stashCreate().setRef(null);
      if (message) command.setMessage(message);
      const ours = await command.call();

      expect(ours).toBe(nativeId);
      expect(structure(mine, nativeId)).toEqual(structure(theirs, nativeId));
      expect(state(theirs)).toEqual(before);
      expect(state(mine)).toEqual(before);
      // ours does not even rewrite the index (git refreshes and writes it, entries unchanged)
      expect(readFileSync(join(mine, ".git/index")).equals(indexBytes)).toBe(true);
    });
  }

  it("stash create with nothing to stash: no commit, nothing printed", async () => {
    const [theirs, mine] = twins(false);
    const before = state(mine);
    const native = gitRun(root, theirs, ["stash", "create"]);
    expect(native).toEqual({ status: 0, stdout: "", stderr: "" });
    const git = await openRepo(root, mine);
    expect(await git.stashCreate().setRef(null).call()).toBeUndefined();
    expect(state(theirs)).toEqual(before);
    expect(state(mine)).toEqual(before);
  });

  it("git.stashCreate() without setRef(null) is `git stash push`", async () => {
    const [theirs, mine] = twins(true);
    gitOut(root, theirs, ["stash", "push", "-q"]);
    const git = await openRepo(root, mine);
    expect(await git.stashCreate().call()).toBe(
      gitOut(root, theirs, ["rev-parse", "refs/stash"]).trim(),
    );
    expect(state(mine)).toEqual(state(theirs));
  });
});
