/**
 * `--quit` of rebase, am, cherry-pick and revert, and `--show-current-patch` of rebase and
 * am, against native git: the same history built twice, the operation stopped by native
 * git in both twins (or by ours in one, to check that ours leaves the same state), then
 * native git quits (or shows) in one twin and ours in the other. Compared: the exit status
 * and output, HEAD, the index, every worktree file, the state files and directories, every
 * ref, HEAD's and the stash's reflogs. Each test names the git test (t/ script and title)
 * whose behaviour it checks.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CherryPickStatus,
  type Git,
  RebaseOperation,
  RebaseStatus,
  SequencerOperation,
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
import { buildHistory, type History, text } from "./merge-native-scenarios.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;
let modern = true;

/** The history built twice, both twins on `branch` (default side). */
function twins(history: History, branch = "side"): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  for (const dir of [native, ours]) {
    buildHistory(root, dir, history);
    gitOk(root, dir, "checkout", "-q", branch);
  }
  return { native, ours };
}

/** Every file of a state directory (or `absent`). */
function stateDir(dir: string, name: string): Record<string, string> | "absent" {
  const path = join(dir, ".git", name);
  if (!existsSync(path)) return "absent";
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(path, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(p);
      else out[p] = normalizeState(`${name}/${p}`, readFileSync(join(path, p), "latin1"));
    }
  };
  walk("");
  return out;
}

/** What both twins must agree on beyond {@link snapshot}. */
function extra(dir: string) {
  const stashLog = join(dir, ".git", "logs", "refs", "stash");
  return {
    refs: gitOk(root, dir, "for-each-ref", "--format=%(objectname) %(refname)"),
    reflog: gitOk(root, dir, "reflog", "--format=%H %gs"),
    stashLog: existsSync(stashLog) ? readFileSync(stashLog, "utf8") : "absent",
    stash: git(root, dir, "stash", "show", "-p").stdout,
    "rebase-merge": stateDir(dir, "rebase-merge"),
    "rebase-apply": stateDir(dir, "rebase-apply"),
    sequencer: stateDir(dir, "sequencer"),
  };
}

function same(ours: string, native: string) {
  expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
  expect(extra(ours)).toEqual(extra(native));
}

/** Both twins with native git's own stop (`args` run in each). */
function stopBoth(pair: { native: string; ours: string }, ...args: string[]) {
  const first = git(root, pair.native, ...args);
  const second = git(root, pair.ours, ...args);
  expect(first.status).not.toBe(0);
  expect(second.status).toBe(first.status);
  return first;
}

async function rebase(dir: string, operation: RebaseOperation) {
  const ours = await openOurs(dir);
  return ours
    .rebase()
    .setCommitter(INTEROP_IDENT)
    .setCompatibility(modern ? "2.56" : "2.43")
    .setOperation(operation)
    .call();
}

/** Our stderr/stdout lines as one text (git's output with its final newline). */
const textOf = (lines: readonly string[] | undefined) =>
  lines?.length ? `${lines.join("\n")}\n` : "";

/** side: c.txt, then a.txt line 5 (conflicts with main), then d.txt. */
const conflicting: History = {
  base: { "a.txt": text(), "b.txt": "b\n" },
  main: { "a.txt": text({ 5: "main" }), "m.txt": "m\n" },
  side: { "c.txt": "c\n" },
  sideMore: [{ "a.txt": text({ 5: "side" }) }, { "d.txt": "d\n" }],
};

/** side's a.txt line 5 changed once more after the change a revert of side~2 undoes. */
const revertConflict: History = {
  base: { "a.txt": text(), "b.txt": "b\n" },
  side: { "c.txt": "c\n" },
  sideMore: [{ "a.txt": text({ 5: "side" }) }, { "a.txt": text({ 5: "later" }) }],
};

describeGit("--quit and --show-current-patch as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sequencer-quit-"));
    mkdirSync(root, { recursive: true });
    modern = gitAtLeast(gitOk(root, root, "--version"), 2, 44);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("rebase --quit", () => {
    for (const backend of ["--merge", "--apply"]) {
      it(`t3407-rebase-abort.sh: "rebase ${backend} --quit"`, async () => {
        const pair = twins(conflicting);
        stopBoth(pair, "rebase", backend, "main");
        const expected = git(root, pair.native, "rebase", "--quit");
        expect(expected.status).toBe(0);
        const result = await rebase(pair.ours, RebaseOperation.QUIT);
        expect(result.status).toBe(RebaseStatus.OK);
        expect(result.message).toBeUndefined();
        expect(textOf(result.output)).toBe(expected.stderr);
        same(pair.ours, pair.native);
      });
    }

    it('t3407-rebase-abort.sh: "rebase --merge --quit" (a rebase ours stopped)', async () => {
      const pair = twins(conflicting);
      git(root, pair.native, "rebase", "--merge", "main");
      const ours = await openOurs(pair.ours);
      const command = ours.rebase().setCommitter(INTEROP_IDENT);
      await command.setUpstreamBranch("main");
      const stopped = await command.call();
      expect(stopped.status).toBe(RebaseStatus.STOPPED);
      git(root, pair.native, "rebase", "--quit");
      await rebase(pair.ours, RebaseOperation.QUIT);
      same(pair.ours, pair.native);
    });

    it("rebase --quit of --rebase-merges deletes refs-to-delete (sequencer_remove_state)", async () => {
      const pair = twins(conflicting);
      stopBoth(pair, "rebase", "--rebase-merges", "main");
      expect(gitOk(root, pair.native, "for-each-ref", "refs/rewritten/")).not.toBe("");
      git(root, pair.native, "rebase", "--quit");
      await rebase(pair.ours, RebaseOperation.QUIT);
      same(pair.ours, pair.native);
    });

    for (const backend of ["--merge", "--apply"]) {
      it(`t3420-rebase-autostash.sh: "rebase${backend}: --quit"`, async () => {
        const pair = twins({ ...conflicting, config: { "rebase.autostash": "true" } });
        for (const dir of [pair.native, pair.ours]) put(dir, "b.txt", "dirty\n");
        stopBoth(pair, "rebase", backend, "main");
        const expected = git(root, pair.native, "rebase", "--quit");
        expect(expected.status).toBe(0);
        const result = await rebase(pair.ours, RebaseOperation.QUIT);
        expect(result.status).toBe(RebaseStatus.OK);
        expect(textOf(result.output)).toBe(expected.stderr);
        expect(expected.stderr).toContain("Autostash exists; creating a new stash entry.");
        same(pair.ours, pair.native);
      });
    }

    it('t3400-rebase.sh: "Show verbose error when HEAD could not be detached" (no rebase in progress)', async () => {
      const pair = twins(conflicting);
      for (const operation of [RebaseOperation.QUIT, RebaseOperation.SHOW_CURRENT_PATCH]) {
        const flag = operation === RebaseOperation.QUIT ? "--quit" : "--show-current-patch";
        const expected = git(root, pair.native, "rebase", flag);
        expect(expected.status).toBe(128);
        const result = await rebase(pair.ours, operation);
        expect(result.status).toBe(RebaseStatus.FAILED);
        expect(`${result.message}\n`).toBe(expected.stderr);
      }
      same(pair.ours, pair.native);
    });
  });

  describe("rebase --show-current-patch", () => {
    it('t3400-rebase.sh: "rebase--merge.sh and --show-current-patch"', async () => {
      const pair = twins(conflicting);
      stopBoth(pair, "rebase", "--merge", "main");
      const expected = git(root, pair.native, "rebase", "--show-current-patch");
      expect(expected.status).toBe(0);
      expect(expected.stdout).toBe(gitOk(root, pair.native, "show", "REBASE_HEAD", "--"));
      const result = await rebase(pair.ours, RebaseOperation.SHOW_CURRENT_PATCH);
      expect(result.status).toBe(RebaseStatus.OK);
      expect(result.currentPatch).toBe(expected.stdout);
      same(pair.ours, pair.native);
    });

    it("rebase --show-current-patch without REBASE_HEAD (stopped at a break)", async () => {
      const pair = twins(conflicting);
      for (const dir of [pair.native, pair.ours]) {
        const r = spawnSync("git", ["rebase", "-i", "main"], {
          cwd: dir,
          env: { ...nativeGitEnv(root), GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "sed -i 1ibreak" },
          encoding: "utf8",
        });
        expect(r.status).toBe(0);
      }
      expect(existsSync(join(pair.native, ".git", "rebase-merge"))).toBe(true);
      const expected = git(root, pair.native, "rebase", "--show-current-patch");
      expect(expected.status).toBe(1);
      const result = await rebase(pair.ours, RebaseOperation.SHOW_CURRENT_PATCH);
      expect(result.status).toBe(RebaseStatus.FAILED);
      expect(`${result.message}\n`).toBe(expected.stderr);
      same(pair.ours, pair.native);
    });

    it('t3400-rebase.sh: "rebase --apply and --show-current-patch"', async () => {
      const pair = twins(conflicting);
      stopBoth(pair, "rebase", "--apply", "main");
      const expected = git(root, pair.native, "rebase", "--show-current-patch");
      expect(expected.status).toBe(0);
      const result = await rebase(pair.ours, RebaseOperation.SHOW_CURRENT_PATCH);
      expect(result.status).toBe(RebaseStatus.OK);
      expect(result.currentPatch).toBe(expected.stdout);
      same(pair.ours, pair.native);
    });
  });

  describe("cherry-pick and revert --quit", () => {
    async function quit(dir: string, command: "cherry-pick" | "revert") {
      const ours: Git = await openOurs(dir);
      const c = command === "cherry-pick" ? ours.cherryPick() : ours.revert();
      return c.setOperation(SequencerOperation.QUIT).call();
    }

    for (const command of ["cherry-pick", "revert"] as const) {
      it(`t3510-cherry-pick-sequence.sh: "--quit does not complain when no cherry-pick is in progress" (${command})`, async () => {
        const pair = twins(conflicting, "main");
        const expected = git(root, pair.native, command, "--quit");
        expect(expected.status).toBe(0);
        const result = await quit(pair.ours, command);
        expect(result.status).toBe(CherryPickStatus.OK);
        expect(textOf(result.output)).toBe(expected.stderr);
        same(pair.ours, pair.native);
      });
    }

    it('t3510-cherry-pick-sequence.sh: "--quit cleans up sequencer state"', async () => {
      const pair = twins(conflicting, "main");
      stopBoth(pair, "cherry-pick", "main..side");
      expect(existsSync(join(pair.native, ".git", "sequencer"))).toBe(true);
      const expected = git(root, pair.native, "cherry-pick", "--quit");
      expect(expected.status).toBe(0);
      const result = await quit(pair.ours, "cherry-pick");
      expect(result.status).toBe(CherryPickStatus.OK);
      expect(textOf(result.output)).toBe(expected.stderr);
      expect(existsSync(join(pair.ours, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
      same(pair.ours, pair.native);
    });

    it('t3510-cherry-pick-sequence.sh: "--quit keeps HEAD and conflicted index intact"', async () => {
      // a single pick (no sequencer/): CHERRY_PICK_HEAD, MERGE_MSG and AUTO_MERGE go
      const pair = twins(conflicting, "main");
      stopBoth(pair, "cherry-pick", "side~1");
      expect(existsSync(join(pair.native, ".git", "MERGE_MSG"))).toBe(true);
      git(root, pair.native, "cherry-pick", "--quit");
      await quit(pair.ours, "cherry-pick");
      expect(git(root, pair.ours, "update-index", "--refresh").status).not.toBe(0);
      same(pair.ours, pair.native);
    });

    it('t3510-cherry-pick-sequence.sh: "--quit cleans up sequencer state" (revert)', async () => {
      const pair = twins(revertConflict);
      stopBoth(pair, "revert", "--no-edit", "side~1", "side");
      expect(existsSync(join(pair.native, ".git", "REVERT_HEAD"))).toBe(true);
      const expected = git(root, pair.native, "revert", "--quit");
      expect(expected.status).toBe(0);
      const result = await quit(pair.ours, "revert");
      expect(result.status).toBe(CherryPickStatus.OK);
      same(pair.ours, pair.native);
    });

    it('t3510-cherry-pick-sequence.sh: "--quit cleans up sequencer state" (a pick ours stopped)', async () => {
      const pair = twins(conflicting, "main");
      git(root, pair.native, "cherry-pick", "main..side");
      const ours = await openOurs(pair.ours);
      const stopped = await ours
        .cherryPick()
        .setCommitter(INTEROP_IDENT)
        .include("side~2")
        .include("side~1")
        .include("side")
        .call();
      expect(stopped.status).toBe(CherryPickStatus.CONFLICTING);
      git(root, pair.native, "cherry-pick", "--quit");
      await quit(pair.ours, "cherry-pick");
      same(pair.ours, pair.native);
    });
  });

  describe("am --quit and --show-current-patch", () => {
    /** Both twins on main stopped by native `git am` of side's commits. */
    function amStopped() {
      const pair = twins(conflicting, "main");
      const mbox = join(root, `series-${counter++}.mbox`);
      const series = gitOk(root, pair.native, "format-patch", "--stdout", "main..side");
      for (const dir of [pair.native, pair.ours]) {
        put(root, mbox.slice(root.length + 1), series);
        expect(git(root, dir, "am", mbox).status).toBe(128);
      }
      return pair;
    }

    async function am(dir: string, configure: (g: Git) => ReturnType<Git["am"]>) {
      const ours = await openOurs(dir);
      return configure(ours)
        .setLegacyMessages(!gitAtLeast(gitOk(root, root, "--version"), 2, 46))
        .call();
    }

    for (const [args, mode] of [
      [["--show-current-patch"], undefined],
      [["--show-current-patch=raw"], "raw"],
      [["--show-current-patch=diff"], "diff"],
    ] as const) {
      it(`t4150-am.sh: "am ${args[0]}"`, async () => {
        const pair = amStopped();
        const expected = git(root, pair.native, "am", ...args);
        expect(expected.status).toBe(0);
        const file = mode === "diff" ? "patch" : "0002";
        expect(expected.stdout).toBe(
          readFileSync(join(pair.native, ".git", "rebase-apply", file), "latin1"),
        );
        const result = await am(pair.ours, (g) => g.am().setShowCurrentPatch(mode));
        expect({ status: result.exitCode, stdout: result.output, stderr: result.errors }).toEqual({
          status: expected.status,
          stdout: expected.stdout,
          stderr: expected.stderr,
        });
        same(pair.ours, pair.native);
      });
    }

    it('t4150-am.sh: "am --quit keeps HEAD where it is"', async () => {
      const pair = amStopped();
      const expected = git(root, pair.native, "am", "--quit");
      expect(expected.status).toBe(0);
      const result = await am(pair.ours, (g) => g.am().setResume("quit"));
      expect(result.exitCode).toBe(0);
      expect(result.errors).toBe(expected.stderr);
      same(pair.ours, pair.native);
    });

    it("am --quit and --show-current-patch refused without a session", async () => {
      const pair = twins(conflicting, "main");
      for (const args of [["--quit"], ["--show-current-patch"], ["--show-current-patch=diff"]]) {
        const expected = git(root, pair.native, "am", ...args);
        expect(expected.status).toBe(128);
        const result = await am(pair.ours, (g) =>
          args[0] === "--quit"
            ? g.am().setResume("quit")
            : g.am().setShowCurrentPatch(args[0]?.endsWith("diff") ? "diff" : "raw"),
        );
        expect({ status: result.exitCode, stderr: result.errors }).toEqual({
          status: expected.status,
          stderr: expected.stderr,
        });
      }
      same(pair.ours, pair.native);
    });
  });
});
