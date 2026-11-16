/**
 * `rebase` against native `git rebase` (merge backend): the same history built twice,
 * native git rebasing one twin and ours the other, then status, index, every worktree file
 * and `.git/rebase-merge/` compared; then each side continues, skips or aborts the rebase
 * the other stopped.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RebaseOperation, RebaseStatus } from "../src/index.js";
import {
  git,
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

/** The history built twice, both twins on `side`. */
function twins(history: History): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  for (const dir of [native, ours]) {
    buildHistory(root, dir, history);
    git(root, dir, "checkout", "-q", "side");
  }
  return { native, ours };
}

const same = (ours: string, native: string) =>
  expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));

async function oursRebase(dir: string, operation?: RebaseOperation) {
  const ours = await openOurs(dir);
  const command = ours.rebase().setCommitter(INTEROP_IDENT);
  if (operation) command.setOperation(operation);
  else await command.setUpstreamBranch("main");
  return command.call();
}

/** side: c.txt, then a.txt line 5 (conflicts with main), then d.txt. */
const conflicting: History = {
  base: { "a.txt": text(), "b.txt": "b\n" },
  main: { "a.txt": text({ 5: "main" }), "m.txt": "m\n" },
  side: { "c.txt": "c\n" },
  sideMore: [{ "a.txt": text({ 5: "side" }) }, { "d.txt": "d\n" }],
};

describeGit("rebase writes the worktree as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rebase-worktree-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a clean rebase replays the commits (the same commits as native git)", async () => {
    const { native, ours } = twins({
      base: { "a.txt": text() },
      main: { "a.txt": text({ 1: "main" }) },
      side: { "a.txt": text({ 9: "side" }), "n.txt": "n\n" },
      sideMore: [{ "o.txt": "o\n" }],
    });
    git(root, native, "rebase", "main");
    const result = await oursRebase(ours);
    expect(result.status).toBe(RebaseStatus.OK);
    same(ours, native);
  });

  it("stops at a conflict with git's rebase-merge state", async () => {
    const { native, ours } = twins(conflicting);
    const expected = git(root, native, "rebase", "main");
    const result = await oursRebase(ours);
    expect(result.status).toBe(RebaseStatus.STOPPED);
    expect(result.output).toEqual(ortLines(expected.stdout));
    expect(result.message?.split("\n")[0]).toBe(
      expected.stderr.split(/[\r\n]/).find((l) => l.startsWith("error:")),
    );
    same(ours, native);
  });

  it("refuses on unstaged or staged changes as git", async () => {
    const unstaged = twins({ ...conflicting, dirty: undefined });
    for (const dir of [unstaged.native, unstaged.ours]) put(dir, "b.txt", "dirty\n");
    const expected = git(root, unstaged.native, "rebase", "main");
    const result = await oursRebase(unstaged.ours);
    expect(result.status).toBe(RebaseStatus.UNCOMMITTED_CHANGES);
    expect(result.message).toBe(expected.stderr.trim());
    for (const dir of [unstaged.native, unstaged.ours]) git(root, dir, "add", "b.txt");
    const expectedStaged = git(root, unstaged.native, "rebase", "main");
    const stagedResult = await oursRebase(unstaged.ours);
    expect(stagedResult.message).toBe(expectedStaged.stderr.trim());
    same(unstaged.ours, unstaged.native);
  });

  it("native git continues our rebase, and we continue native git's", async () => {
    const { native, ours } = twins(conflicting);
    git(root, native, "rebase", "main");
    await oursRebase(ours);
    for (const dir of [native, ours]) {
      put(dir, "a.txt", "resolved\n");
      git(root, dir, "add", "a.txt");
    }
    expect(git(root, ours, "rebase", "--continue").status).toBe(0);
    const result = await oursRebase(native, RebaseOperation.CONTINUE);
    expect(result.status).toBe(RebaseStatus.OK);
    same(ours, native);
  });

  it("native git aborts our rebase, and we abort native git's", async () => {
    const { native, ours } = twins(conflicting);
    git(root, native, "rebase", "main");
    await oursRebase(ours);
    expect(git(root, ours, "rebase", "--abort").status).toBe(0);
    const result = await oursRebase(native, RebaseOperation.ABORT);
    expect(result.status).toBe(RebaseStatus.ABORTED);
    same(ours, native);
  });

  it("native git skips in our rebase, and we skip in native git's", async () => {
    const { native, ours } = twins(conflicting);
    git(root, native, "rebase", "main");
    await oursRebase(ours);
    expect(git(root, ours, "rebase", "--skip").status).toBe(0);
    const result = await oursRebase(native, RebaseOperation.SKIP);
    expect(result.status).toBe(RebaseStatus.OK);
    same(ours, native);
  });

  it("rebase.autoStash stashes local changes and applies them after, or after --abort", async () => {
    const clean = twins({
      config: { "rebase.autoStash": "true" },
      base: { "a.txt": text(), "b.txt": "b\n" },
      main: { "a.txt": text({ 1: "main" }) },
      side: { "c.txt": "c\n" },
    });
    for (const dir of [clean.native, clean.ours]) put(dir, "b.txt", "dirty\n");
    const expected = git(root, clean.native, "rebase", "main");
    const result = await oursRebase(clean.ours);
    expect(result.status).toBe(RebaseStatus.OK);
    // what git prints about the autostash (stdout and stderr), the stash's id evened out
    const autostashLines = (lines: string[]) =>
      lines
        .filter((l) => /autostash/.test(l))
        .map((l) => l.replace(/autostash: \w+/, "autostash: <id>"));
    expect(autostashLines(result.output ?? [])).toEqual(
      autostashLines(`${expected.stdout}\n${expected.stderr}`.split(/[\r\n]/)),
    );
    same(clean.ours, clean.native);

    const stopped = twins({ ...conflicting, config: { "rebase.autoStash": "true" } });
    for (const dir of [stopped.native, stopped.ours]) put(dir, "b.txt", "dirty\n");
    git(root, stopped.native, "rebase", "main");
    expect((await oursRebase(stopped.ours)).status).toBe(RebaseStatus.STOPPED);
    same(stopped.ours, stopped.native);
    expect(git(root, stopped.ours, "rebase", "--abort").status).toBe(0);
    const aborted = await oursRebase(stopped.native, RebaseOperation.ABORT);
    expect(aborted.output).toEqual(["Applied autostash."]);
    same(stopped.ours, stopped.native);
  });

  it("a branch behind upstream fast-forwards; one containing it is up to date", async () => {
    const behind = twins({ base: { "a.txt": text() }, side: {}, main: { "m.txt": "m\n" } });
    for (const dir of [behind.native, behind.ours])
      git(root, dir, "reset", "-q", "--hard", "HEAD~1");
    git(root, behind.native, "rebase", "main");
    expect((await oursRebase(behind.ours)).status).toBe(RebaseStatus.FAST_FORWARD);
    same(behind.ours, behind.native);

    const ahead = twins({ base: { "a.txt": text() }, side: { "s.txt": "s\n" } });
    git(root, ahead.native, "rebase", "main");
    expect((await oursRebase(ahead.ours)).status).toBe(RebaseStatus.UP_TO_DATE);
    same(ahead.ours, ahead.native);
  });
});
