/**
 * `cherry-pick` and `revert` against native git: the same history built twice, native git
 * in one twin and ours in the other, then refusals, merge-ort's output, status, index, every
 * worktree file and the state files (CHERRY_PICK_HEAD, REVERT_HEAD, MERGE_MSG, AUTO_MERGE,
 * sequencer/) compared; then each side continues, skips or aborts what the other started.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CherryPickStatus, RevertStatus, SequencerOperation } from "../src/index.js";
import {
  git,
  gitOk,
  INTEROP_AUTHOR_ENV,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  ortLines,
  put,
  snapshot,
} from "./merge-native-helpers.js";
import { buildHistory, type History, text } from "./merge-native-scenarios.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

function twins(history: History): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  buildHistory(root, native, history);
  buildHistory(root, ours, history);
  return { native, ours };
}

const same = (ours: string, native: string) =>
  expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));

async function oursPick(dir: string, commits: string[], options: { noCommit?: boolean } = {}) {
  const command = (await openOurs(dir)).cherryPick().setCommitter(INTEROP_IDENT);
  for (const c of commits) command.include(c);
  if (options.noCommit) command.setNoCommit(true);
  return command.call();
}

async function oursPickOp(dir: string, operation: SequencerOperation) {
  return (await openOurs(dir))
    .cherryPick()
    .setCommitter(INTEROP_IDENT)
    .setOperation(operation)
    .call();
}

async function oursRevert(dir: string, commits: string[], operation?: SequencerOperation) {
  // the revert's author resolved as native git's (GIT_AUTHOR_*), not dated by the committer
  const command = (await openOurs(dir, INTEROP_AUTHOR_ENV)).revert().setCommitter(INTEROP_IDENT);
  for (const c of commits) command.include(c);
  if (operation) command.setOperation(operation);
  return command.call();
}

/** side: `a.txt` line 5 (conflicts with main's), then `c.txt`, then `d.txt`. */
const threePicks: History = {
  base: { "a.txt": text(), "b.txt": "b\n" },
  main: { "a.txt": text({ 5: "main" }) },
  side: { "c.txt": "c\n" },
  sideMore: [{ "a.txt": text({ 5: "side" }) }, { "d.txt": "d\n" }],
};

describeGit("cherry-pick and revert write the worktree as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pick-worktree-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a clean cherry-pick writes the files and commits with the commit's author", async () => {
    const { native, ours } = twins({
      base: { "a.txt": text() },
      main: { "a.txt": text({ 1: "main" }) },
      side: { "a.txt": text({ 9: "side" }), "n.txt": "n\n" },
    });
    const expected = git(root, native, "cherry-pick", "side");
    const result = await oursPick(ours, ["side"]);
    expect(result.status).toBe(CherryPickStatus.OK);
    expect(result.output).toEqual(ortLines(expected.stdout));
    same(ours, native);
  });

  it("a conflicting cherry-pick leaves markers, stages and CHERRY_PICK_HEAD", async () => {
    const { native, ours } = twins(threePicks);
    const expected = git(root, native, "cherry-pick", "side~1");
    const result = await oursPick(ours, ["side~1"]);
    expect(result.status).toBe(CherryPickStatus.CONFLICTING);
    expect(result.output).toEqual(ortLines(expected.stdout));
    expect(result.message?.split("\n")[0]).toBe(expected.stderr.split("\n")[0]);
    same(ours, native);
  });

  it("--no-commit, clean and conflicting", async () => {
    for (const commit of ["side~2", "side~1"]) {
      const { native, ours } = twins(threePicks);
      git(root, native, "cherry-pick", "--no-commit", commit);
      await oursPick(ours, [commit], { noCommit: true });
      same(ours, native);
    }
  });

  it("several commits stop at the conflict with git's sequencer state", async () => {
    const { native, ours } = twins(threePicks);
    git(root, native, "cherry-pick", "side~2", "side~1", "side");
    const result = await oursPick(ours, ["side~2", "side~1", "side"]);
    expect(result.status).toBe(CherryPickStatus.CONFLICTING);
    same(ours, native);
  });

  it("refuses on staged changes, unmerged entries and local changes as git", async () => {
    const staged = twins({ ...threePicks, dirty: { "b.txt": "staged\n" }, stage: ["b.txt"] });
    const expectedStaged = git(root, staged.native, "cherry-pick", "side~2");
    const stagedResult = await oursPick(staged.ours, ["side~2"]);
    expect(stagedResult.status).toBe(CherryPickStatus.FAILED);
    expect(stagedResult.message).toBe(expectedStaged.stderr.trim());
    same(staged.ours, staged.native);

    const local = twins({ ...threePicks, main: undefined, dirty: { "a.txt": "dirty\n" } });
    const expectedLocal = git(root, local.native, "cherry-pick", "side~1");
    const localResult = await oursPick(local.ours, ["side~1"]);
    expect(localResult.message).toBe(expectedLocal.stderr.trim());
    same(local.ours, local.native);

    const unmerged = twins(threePicks);
    git(root, unmerged.native, "cherry-pick", "side~1");
    await oursPick(unmerged.ours, ["side~1"]);
    const expectedUnmerged = git(root, unmerged.native, "cherry-pick", "side");
    const unmergedResult = await oursPick(unmerged.ours, ["side"]);
    expect(unmergedResult.message).toBe(expectedUnmerged.stderr.trim());
  });

  it("native git continues our cherry-picks, and we continue native git's", async () => {
    const { native, ours } = twins(threePicks);
    git(root, native, "cherry-pick", "side~2", "side~1", "side");
    await oursPick(ours, ["side~2", "side~1", "side"]);
    for (const dir of [native, ours]) {
      put(dir, "a.txt", "resolved\n");
      git(root, dir, "add", "a.txt");
    }
    expect(git(root, ours, "cherry-pick", "--continue").status).toBe(0);
    const result = await oursPickOp(native, SequencerOperation.CONTINUE);
    expect(result.status).toBe(CherryPickStatus.OK);
    same(ours, native);
  });

  it("native git aborts our cherry-picks, and we abort native git's", async () => {
    for (const commits of [["side~1"], ["side~2", "side~1", "side"]]) {
      const { native, ours } = twins({ ...threePicks, dirty: { "u.txt": "untracked\n" } });
      git(root, native, "cherry-pick", ...commits);
      await oursPick(ours, commits);
      same(ours, native);
      expect(git(root, ours, "cherry-pick", "--abort").status).toBe(0);
      const result = await oursPickOp(native, SequencerOperation.ABORT);
      expect(result.status).toBe(CherryPickStatus.OK);
      same(ours, native);
    }
  });

  it("native git skips in our cherry-picks, and we skip in native git's", async () => {
    const { native, ours } = twins(threePicks);
    git(root, native, "cherry-pick", "side~2", "side~1", "side");
    await oursPick(ours, ["side~2", "side~1", "side"]);
    expect(git(root, ours, "cherry-pick", "--skip").status).toBe(0);
    const result = await oursPickOp(native, SequencerOperation.SKIP);
    expect(result.status).toBe(CherryPickStatus.OK);
    same(ours, native);
  });

  it("revert: clean, conflicting, and continued across implementations", async () => {
    const clean = twins(threePicks);
    git(root, clean.native, "checkout", "-q", "side");
    git(root, clean.ours, "checkout", "-q", "side");
    git(root, clean.native, "revert", "--no-edit", "side~2");
    const cleanResult = await oursRevert(clean.ours, ["side~2"]);
    expect(cleanResult.status).toBe(RevertStatus.OK);
    same(clean.ours, clean.native);

    const history: History = {
      base: { "a.txt": text() },
      side: { "a.txt": text({ 5: "side" }) },
      sideMore: [{ "a.txt": text({ 5: "again" }) }],
    };
    const { native, ours } = twins(history);
    for (const dir of [native, ours]) git(root, dir, "checkout", "-q", "side");
    const expected = git(root, native, "revert", "side~1");
    const result = await oursRevert(ours, ["side~1"]);
    expect(result.status).toBe(RevertStatus.CONFLICTING);
    expect(result.output).toEqual(ortLines(expected.stdout));
    expect(result.message?.split("\n")[0]).toBe(expected.stderr.split("\n")[0]);
    same(ours, native);
    for (const dir of [native, ours]) {
      put(dir, "a.txt", text());
      git(root, dir, "add", "a.txt");
    }
    expect(git(root, ours, "revert", "--continue").status).toBe(0);
    const continued = await oursRevert(native, [], SequencerOperation.CONTINUE);
    expect(continued.status).toBe(RevertStatus.OK);
    same(ours, native);
  });
});

describeGit("state files after a pick or merge that ends early, as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "pick-state-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a pick that commits drops the CHERRY_PICK_HEAD and MERGE_MSG of a stopped empty one", async () => {
    const { native, ours } = twins({
      base: { "a.txt": text() },
      main: { "a.txt": text({ 1: "main" }) },
      side: { "n.txt": "n\n" },
    });
    // picking HEAD itself is empty: git stops with CHERRY_PICK_HEAD and MERGE_MSG
    expect(git(root, native, "cherry-pick", "main").status).toBe(1);
    const head = git(root, ours, "rev-parse", "main").stdout.trim();
    expect((await oursPick(ours, [head])).status).toBe(CherryPickStatus.CONFLICTING);
    same(ours, native);
    // a pick that commits ends it (do_commit), AUTO_MERGE left as git leaves it
    expect(git(root, native, "cherry-pick", "side").status).toBe(0);
    expect((await oursPick(ours, ["side"])).status).toBe(CherryPickStatus.OK);
    same(ours, native);
  });

  it("an already up to date merge drops the AUTO_MERGE a clean pick left", async () => {
    const { native, ours } = twins({
      base: { "a.txt": text() },
      main: { "a.txt": text({ 1: "main" }) },
      side: { "n.txt": "n\n" },
    });
    git(root, native, "cherry-pick", "side");
    await oursPick(ours, ["side"]);
    same(ours, native);
    expect(git(root, native, "merge", "-q", "main~1").status).toBe(0);
    await (await openOurs(ours, INTEROP_AUTHOR_ENV)).merge().include("main~1").call();
    same(ours, native);
  });

  it("a merge refused over a tracked file replaced by a directory records no AUTO_MERGE", async () => {
    const { native, ours } = twins({
      base: { "a.txt": text(), "c/w": "w\n" },
      main: { "a.txt": text({ 1: "main" }) },
      side: { "c/w": "W2\n" },
    });
    for (const dir of [native, ours]) {
      rmSync(join(dir, "c/w"));
      put(dir, "c/w/m", "m\n");
    }
    const expected = git(root, native, "merge", "-q", "side");
    expect(expected.status).not.toBe(0);
    await (await openOurs(ours, INTEROP_AUTHOR_ENV)).merge().include("side").call();
    same(ours, native);
  });
});

describeGit("a refused merge's restore over a directory at a tracked file, as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "restore-dir-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A directory (holding m) where f was, after `prepare`; side changes f. */
  const setups: [string, (dir: string) => void][] = [
    [
      "f staged changed, a directory there",
      (dir) => {
        put(dir, "f", "S\n");
        gitOk(root, dir, "add", "f");
        rmSync(join(dir, "f"));
        put(dir, "f/m", "m\n");
      },
    ],
    [
      "f staged changed, a directory there, another file changed",
      (dir) => {
        put(dir, "f", "S\n");
        gitOk(root, dir, "add", "f");
        rmSync(join(dir, "f"));
        put(dir, "f/m", "m\n");
        put(dir, "k", "k2\n");
      },
    ],
    [
      "rm --cached f, a directory there",
      (dir) => {
        gitOk(root, dir, "rm", "-q", "--cached", "f");
        rmSync(join(dir, "f"));
        put(dir, "f/m", "m\n");
      },
    ],
    [
      "a nested repository with a commit at f",
      (dir) => {
        rmSync(join(dir, "f"));
        put(dir, "f/x", "x\n");
        gitOk(root, join(dir, "f"), "init", "-q");
        gitOk(root, join(dir, "f"), "add", "x");
        gitOk(root, join(dir, "f"), "commit", "-q", "-m", "n");
      },
    ],
    [
      "f staged changed, a nested repository with a commit at f",
      (dir) => {
        put(dir, "f", "S\n");
        gitOk(root, dir, "add", "f");
        rmSync(join(dir, "f"));
        put(dir, "f/x", "x\n");
        gitOk(root, join(dir, "f"), "init", "-q");
        gitOk(root, join(dir, "f"), "add", "x");
        gitOk(root, join(dir, "f"), "commit", "-q", "-m", "n");
      },
    ],
    [
      "f staged changed, a symlink to a directory at f",
      (dir) => {
        put(dir, "f", "S\n");
        gitOk(root, dir, "add", "f");
        rmSync(join(dir, "f"));
        mkdirSync(join(dir, "t"));
        put(dir, "t/m", "m\n");
        symlinkSync("t", join(dir, "f"));
      },
    ],
  ];
  for (const [name, prepare] of setups) {
    it(`${name}: the reset and stash apply of restore_state`, async () => {
      const { native, ours } = twins({
        base: { "a.txt": text(), f: "w\n", k: "k\n" },
        main: { "a.txt": text({ 1: "main" }) },
        side: { f: "W2\n" },
      });
      for (const dir of [native, ours]) prepare(dir);
      const expected = git(root, native, "merge", "-q", "side");
      expect(expected.status).toBe(2);
      await (await openOurs(ours, INTEROP_AUTHOR_ENV)).merge().include("side").call();
      same(ours, native);
      expect(gitOk(root, ours, "stash", "list")).toBe(gitOk(root, native, "stash", "list"));
    });
  }
});
