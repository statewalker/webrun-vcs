/**
 * rerere in the merge family against native git (t3504-cherry-pick-rerere.sh, and t4200's
 * rebase cases): a resolution recorded by a merge, then cherry-pick, revert, rebase, am and
 * stash apply meeting the same conflicts, native git in one twin and ours in the other; the
 * stderr lines, `MERGE_RR`, `rr-cache/`, the index, the worktree and the state files compared.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CherryPickStatus,
  Git,
  MergeStatus,
  RebaseOperation,
  RebaseStatus,
  SequencerOperation,
  StashApplyStatus,
} from "../src/index.js";
import {
  git,
  gitOk,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  put,
  snapshot,
} from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { nativeVersion } from "./plumbing-native-support.js";
import { rerereState } from "./rerere-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

type Twins = { native: string; ours: string };

/** t3504's `test_commit`: `<file>` holding `<message>`, committed and tagged `<message>`. */
function testCommit(dir: string, message: string, file = `${message}.t`): void {
  put(dir, file, `${message}\n`);
  gitOk(root, dir, "add", file);
  gitOk(root, dir, "commit", "-q", "-m", message);
  gitOk(root, dir, "tag", message);
}

/** t3504's `setup`: main (foo, foo-main, bar-main), dev from foo (foo-dev, bar-dev). */
function buildT3504(dir: string): void {
  mkdirSync(dir, { recursive: true });
  gitOk(root, dir, "init", "-q", "-b", "main");
  testCommit(dir, "foo");
  testCommit(dir, "foo-main", "foo");
  testCommit(dir, "bar-main", "bar");
  gitOk(root, dir, "checkout", "-q", "-b", "dev", "foo");
  testCommit(dir, "foo-dev", "foo");
  testCommit(dir, "bar-dev", "bar");
  gitOk(root, dir, "config", "rerere.enabled", "true");
}

function twins(): Twins {
  const n = counter++;
  const t = { native: join(root, `native-${n}`), ours: join(root, `ours-${n}`) };
  buildT3504(t.native);
  buildT3504(t.ours);
  return t;
}

function both(t: Twins, ...args: string[]): void {
  gitOk(root, t.native, ...args);
  gitOk(root, t.ours, ...args);
}

function same(t: Twins): void {
  expect(rerereState(t.ours)).toEqual(rerereState(t.native));
  expect(snapshot(root, t.ours, normalizeState)).toEqual(snapshot(root, t.native, normalizeState));
}

function rerereLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((l) =>
      /^(Recorded (preimage|resolution) for|Resolved '|Staged '|error: could not parse)/.test(l),
    );
}

/**
 * t3504's `conflicting merge` and `fixup` in both twins (natively: the merge family's
 * twins below start from the recorded resolutions): foo and bar resolved, committed, reset.
 */
function recordResolutions(t: Twins): void {
  for (const dir of [t.native, t.ours]) {
    git(root, dir, "merge", "main");
    put(dir, "foo", "foo-resolved\n");
    put(dir, "bar", "bar-resolved\n");
    gitOk(root, dir, "commit", "-q", "-am", "resolved");
    gitOk(root, dir, "reset", "-q", "--hard", "HEAD^");
  }
}

async function oursPick(
  t: Twins,
  commits: string[],
  options: { autoUpdate?: boolean; operation?: SequencerOperation } = {},
) {
  const command = (await openOurs(t.ours)).cherryPick().setCommitter(INTEROP_IDENT);
  for (const c of commits) command.include(c);
  if (options.autoUpdate !== undefined) command.setRerereAutoUpdate(options.autoUpdate);
  if (options.operation) command.setOperation(options.operation);
  return command.call();
}

describeGit("rerere in the merge family as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rerere-family-"));
  });
  afterAll(async () => {
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  it('t3504-cherry-pick-rerere.sh: "conflicting merge", "fixup"', async () => {
    const t = twins();
    const expected = git(root, t.native, "merge", "main");
    const result = await (await openOurs(t.ours))
      .merge()
      .include("main")
      .setAuthor(INTEROP_IDENT)
      .setCommitter(INTEROP_IDENT)
      .call();
    expect(result.status).toBe(MergeStatus.CONFLICTING);
    expect(result.rerereOutput).toEqual(rerereLines(expected.stderr));
    same(t);
    for (const dir of [t.native, t.ours]) {
      put(dir, "foo", "foo-resolved\n");
      put(dir, "bar", "bar-resolved\n");
    }
    const committed = git(root, t.native, "commit", "-q", "-am", "resolved");
    const made = await (await openOurs(t.ours))
      .commit()
      .setAll(true)
      .setMessage("resolved")
      .setAuthorIdent(INTEROP_IDENT)
      .setCommitterIdent(INTEROP_IDENT)
      .call();
    expect(made.rerereOutput).toEqual(rerereLines(committed.stderr));
    same(t);
  });

  for (const [title, flag, config] of [
    ["cherry-pick conflict with --rerere-autoupdate", true, undefined],
    ["cherry-pick conflict respects rerere.autoUpdate", undefined, "true"],
    ["cherry-pick conflict with --no-rerere-autoupdate", false, "true"],
  ] as const) {
    it(`t3504-cherry-pick-rerere.sh: "${title}"`, async () => {
      const t = twins();
      recordResolutions(t);
      if (config) both(t, "config", "rerere.autoUpdate", config);
      const args =
        flag === undefined ? [] : [flag ? "--rerere-autoupdate" : "--no-rerere-autoupdate"];
      const expected = git(root, t.native, "cherry-pick", ...args, "foo..bar-main");
      const result = await oursPick(t, ["foo-main", "bar-main"], {
        ...(flag === undefined ? {} : { autoUpdate: flag }),
      });
      expect(result.status).toBe(CherryPickStatus.CONFLICTING);
      expect(result.rerereOutput).toEqual(rerereLines(expected.stderr));
      same(t);
      if (flag === false) both(t, "add", "foo");
      // --continue commits foo (git commit's rerere) and stops at bar
      const next = git(root, t.native, "cherry-pick", "--continue");
      const continued = await oursPick(t, [], { operation: SequencerOperation.CONTINUE });
      expect(continued.rerereOutput ?? []).toEqual(rerereLines(next.stderr));
      same(t);
      if (flag === false) both(t, "add", "bar");
      const last = git(root, t.native, "cherry-pick", "--continue");
      const done = await oursPick(t, [], { operation: SequencerOperation.CONTINUE });
      expect(done.status).toBe(CherryPickStatus.OK);
      expect(done.rerereOutput ?? []).toEqual(rerereLines(last.stderr));
      same(t);
    });
  }

  it('t3504-cherry-pick-rerere.sh: "cherry-pick --continue rejects --rerere-autoupdate"', async () => {
    const t = twins();
    recordResolutions(t);
    git(root, t.native, "cherry-pick", "--rerere-autoupdate", "foo..bar-main");
    await oursPick(t, ["foo-main", "bar-main"], { autoUpdate: true });
    same(t);
    for (const flag of [true, false]) {
      const name = flag ? "--rerere-autoupdate" : "--no-rerere-autoupdate";
      const expected = git(root, t.native, "cherry-pick", "--continue", name);
      await expect(
        oursPick(t, [], { operation: SequencerOperation.CONTINUE, autoUpdate: flag }),
      ).rejects.toThrow(expected.stderr.trim());
    }
  });

  it('t3504-cherry-pick-rerere.sh: "cherry-pick conflict without rerere"', async () => {
    const t = twins();
    recordResolutions(t);
    both(t, "config", "rerere.enabled", "false");
    git(root, t.native, "cherry-pick", "foo-main");
    const result = await oursPick(t, ["foo-main"]);
    expect(result.rerereOutput).toBeUndefined();
    same(t);
  });

  it("revert replays a recorded resolution", async () => {
    const t = twins();
    // the resolution of reverting foo-again under a foo changed again
    both(t, "checkout", "-q", "-b", "rev", "dev");
    for (const dir of [t.native, t.ours]) {
      testCommit(dir, "foo-again", "foo");
      testCommit(dir, "foo-third", "foo");
    }
    for (const dir of [t.native, t.ours]) {
      git(root, dir, "revert", "--no-edit", "foo-again");
      put(dir, "foo", "foo-reverted\n");
      gitOk(root, dir, "add", "foo");
      gitOk(root, dir, "-c", "core.editor=true", "revert", "--continue");
      gitOk(root, dir, "reset", "-q", "--hard", "HEAD^");
    }
    same(t);
    const expected = git(root, t.native, "revert", "--no-edit", "foo-again");
    expect(rerereLines(expected.stderr)).toEqual(["Resolved 'foo' using previous resolution."]);
    const result = await (await openOurs(t.ours))
      .revert()
      .include("foo-again")
      .setCommitter(INTEROP_IDENT)
      .call();
    expect(result.rerereOutput).toEqual(rerereLines(expected.stderr));
    same(t);
  });

  it("rebase replays recorded resolutions at each stopped pick", async () => {
    const t = twins();
    recordResolutions(t);
    const expected = git(root, t.native, "rebase", "main");
    const result = await (await openOurs(t.ours))
      .rebase()
      .setCommitter(INTEROP_IDENT)
      .setUpstream("main")
      .call();
    expect(result.status).toBe(RebaseStatus.STOPPED);
    expect(result.rerereOutput).toEqual(rerereLines(expected.stderr));
    expect(result.rerereOutput).toEqual(["Resolved 'foo' using previous resolution."]);
    same(t);
    both(t, "add", "foo");
    const next = git(root, t.native, "-c", "core.editor=true", "rebase", "--continue");
    const continued = await (await openOurs(t.ours))
      .rebase()
      .setCommitter(INTEROP_IDENT)
      .setOperation(RebaseOperation.CONTINUE)
      .call();
    expect(continued.rerereOutput ?? []).toEqual(rerereLines(next.stderr));
    same(t);
  });

  it("rebase --rerere-autoupdate stages the replayed resolution and keeps the option", async () => {
    const t = twins();
    recordResolutions(t);
    const expected = git(root, t.native, "rebase", "--rerere-autoupdate", "main");
    const result = await (await openOurs(t.ours))
      .rebase()
      .setCommitter(INTEROP_IDENT)
      .setUpstream("main")
      .setRerereAutoUpdate(true)
      .call();
    expect(result.rerereOutput).toEqual(rerereLines(expected.stderr));
    expect(result.rerereOutput).toEqual(["Staged 'foo' using previous resolution."]);
    same(t);
    const next = git(root, t.native, "-c", "core.editor=true", "rebase", "--continue");
    const continued = await (await openOurs(t.ours))
      .rebase()
      .setCommitter(INTEROP_IDENT)
      .setOperation(RebaseOperation.CONTINUE)
      .call();
    expect(continued.rerereOutput ?? []).toEqual(rerereLines(next.stderr));
    same(t);
  });

  it('t4200-rerere.sh: "rerere does not crash with missing preimage" (rebase --abort clears)', async () => {
    const t = twins();
    for (const dir of [t.native, t.ours]) git(root, dir, "rebase", "main");
    same(t);
    const preimages = Object.keys(rerereState(t.ours)).filter((k) => k.endsWith("/preimage"));
    for (const dir of [t.native, t.ours]) {
      for (const p of preimages) rmSync(join(dir, ".git", p));
    }
    await (await openOurs(t.ours)).rebase().setOperation(RebaseOperation.ABORT).call();
    const { major, minor } = nativeVersion();
    if (major > 2 || minor >= 45) {
      git(root, t.native, "rebase", "--abort");
      same(t);
    } else {
      // git before 2.45 crashes there (read_rr did not fit the variant): ours ends as 2.45 does
      expect(rerereState(t.ours)).toEqual({ "rr-cache/": "dir" });
    }
  });

  it("rebase --skip clears what was not resolved", async () => {
    const t = twins();
    for (const dir of [t.native, t.ours]) git(root, dir, "rebase", "main");
    same(t);
    git(root, t.native, "rebase", "--skip");
    await (await openOurs(t.ours))
      .rebase()
      .setCommitter(INTEROP_IDENT)
      .setOperation(RebaseOperation.SKIP)
      .call();
    same(t);
  });

  it("am -3 replays a recorded resolution; --continue records, --abort clears", async () => {
    const t = twins();
    // dev2 and main2 change foo-main differently; the conflict resolved once by a merge
    for (const dir of [t.native, t.ours]) {
      gitOk(root, dir, "checkout", "-q", "-b", "dev2", "main");
      testCommit(dir, "foo-x", "foo");
      gitOk(root, dir, "checkout", "-q", "-b", "main2", "main");
      testCommit(dir, "foo-y", "foo");
      git(root, dir, "merge", "dev2");
      put(dir, "foo", "foo-xy\n");
      gitOk(root, dir, "commit", "-q", "-am", "resolved");
      gitOk(root, dir, "reset", "-q", "--hard", "HEAD^");
    }
    same(t);
    const mbox = gitOk(root, t.native, "format-patch", "--stdout", "main..dev2");
    const mboxPath = join(root, `mbox-${counter}`);
    writeFileSync(mboxPath, mbox);
    const openAm = async (dir: string) => {
      const files = createNodeFilesApi({ rootDir: dir });
      const environment = createNodeGitHostEnvironment({ env: nativeGitEnv(root) });
      const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
      const worktrees = await openGitLinkedWorktrees({
        files,
        gitDir: ".git",
        history,
        environment,
      });
      return Git.fromWorkingCopy(await worktrees.openCurrent());
    };
    const expected = git(root, t.native, "am", "-3", mboxPath);
    const g = await openAm(t.ours);
    const result = await g.am().addMbox(mbox).setThreeWay(true).call();
    g.close();
    expect(rerereLines(result.errors)).toEqual(rerereLines(expected.stderr));
    expect(rerereLines(result.errors)).toEqual(["Resolved 'foo' using previous resolution."]);
    expect(rerereState(t.ours)).toEqual(rerereState(t.native));
    both(t, "add", "foo");
    const next = git(root, t.native, "am", "--continue");
    const g2 = await openAm(t.ours);
    const continued = await g2.am().setResume("continue").call();
    g2.close();
    expect(rerereLines(continued.errors)).toEqual(rerereLines(next.stderr));
    expect(rerereState(t.ours)).toEqual(rerereState(t.native));
    // a fresh conflict, aborted: its preimage goes
    both(t, "reset", "-q", "--hard", "main2");
    for (const dir of [t.native, t.ours])
      rmSync(join(dir, ".git", "rr-cache"), { recursive: true });
    both(t, "config", "rerere.enabled", "true");
    git(root, t.native, "am", "-3", mboxPath);
    const g3 = await openAm(t.ours);
    await g3.am().addMbox(mbox).setThreeWay(true).call();
    g3.close();
    expect(rerereState(t.ours)).toEqual(rerereState(t.native));
    git(root, t.native, "am", "--abort");
    const g4 = await openAm(t.ours);
    await g4.am().setResume("abort").call();
    g4.close();
    expect(rerereState(t.ours)).toEqual(rerereState(t.native));
  });

  it("stash apply replays a recorded resolution", async () => {
    const t = twins();
    recordResolutions(t);
    for (const dir of [t.native, t.ours]) {
      gitOk(root, dir, "checkout", "-q", "foo");
      put(dir, "foo", "foo-dev\n");
      gitOk(root, dir, "add", "foo");
      gitOk(root, dir, "stash", "-q");
      gitOk(root, dir, "checkout", "-q", "main");
    }
    const expected = git(root, t.native, "stash", "apply");
    const result = await (await openOurs(t.ours)).stashApply().call();
    expect(result.status).toBe(StashApplyStatus.CONFLICTS);
    expect(result.rerereOutput).toEqual(rerereLines(expected.stderr));
    expect(result.rerereOutput).toEqual(["Resolved 'foo' using previous resolution."]);
    same(t);
  });

  it("commit records the resolution before it applies MERGE_AUTOSTASH (webrun-vcs#361)", async () => {
    // git's cmd_commit: repo_rerere, post-commit, then apply_autostash_ref(MERGE_AUTOSTASH);
    // the autostash changes a line of the conflicted file the merge does not touch, so a
    // rerere run after it would record the stashed line in the postimage
    const lines = (second: string, ninth: string) =>
      ["1", second, "3", "4", "5", "6", "7", "8", ninth, "10", ""].join("\n");
    const n = counter++;
    const t = { native: join(root, `native-${n}`), ours: join(root, `ours-${n}`) };
    for (const dir of [t.native, t.ours]) {
      mkdirSync(dir, { recursive: true });
      gitOk(root, dir, "init", "-q", "-b", "main");
      gitOk(root, dir, "config", "rerere.enabled", "true");
      put(dir, "foo", lines("2", "9"));
      gitOk(root, dir, "add", "foo");
      gitOk(root, dir, "commit", "-q", "-m", "base");
      gitOk(root, dir, "checkout", "-q", "-b", "dev");
      put(dir, "foo", lines("2-dev", "9"));
      gitOk(root, dir, "commit", "-q", "-am", "dev");
      gitOk(root, dir, "checkout", "-q", "main");
      put(dir, "foo", lines("2-main", "9"));
      gitOk(root, dir, "commit", "-q", "-am", "main");
      put(dir, "foo", lines("2-main", "9-stashed"));
      git(root, dir, "merge", "--autostash", "dev");
      put(dir, "foo", lines("2-resolved", "9"));
      gitOk(root, dir, "add", "foo");
    }
    same(t);
    const committed = git(root, t.native, "commit", "-q", "-m", "resolved");
    const made = await (await openOurs(t.ours))
      .commit()
      .setMessage("resolved")
      .setAuthorIdent(INTEROP_IDENT)
      .setCommitterIdent(INTEROP_IDENT)
      .call();
    expect(made.rerereOutput).toEqual(rerereLines(committed.stderr));
    const postimages = Object.entries(rerereState(t.native)).filter(([k]) =>
      k.endsWith("/postimage"),
    );
    expect(postimages.map(([, v]) => v)).toEqual([lines("2-resolved", "9")]);
    same(t);
  });
});
