/**
 * What git forgets and refuses around an operation in progress, against native git: the
 * resolve-undo records `merge --abort` drops, the state a branch switch removes (git's
 * remove_branch_state), and `reset --merge`, `--keep`, `--soft` and `--hard` with their
 * refusals. The same history built twice (`buildGraph`), each twin set up by native git,
 * then native git runs the step in one and ours in the other; snapshot / normalizeState,
 * the resolve-undo records, the stash list and git's refusal compared.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Git, MergeOperation, ResetMode } from "../src/index.js";
import { git, gitOk, normalizeState, openOurs, put, snapshot } from "./merge-native-helpers.js";
import { buildGraph, type Graph, text } from "./merge-native-scenarios.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

/**
 * Builds `graph` twice, `prepare` (native git) in both, then `native` in one twin and
 * `ours` in the other; returns native git's result and what ours threw, once both twins
 * were found the same.
 */
async function compare(
  graph: Graph,
  prepare: (dir: string) => void,
  native: string[],
  ours: (g: Git) => Promise<unknown>,
): Promise<{ status: number; stderr: string; thrown?: string }> {
  const n = counter++;
  const nd = join(root, `native-${n}`);
  const od = join(root, `ours-${n}`);
  for (const dir of [nd, od]) {
    buildGraph(root, dir, graph);
    prepare(dir);
  }
  const expected = git(root, nd, ...native);
  let thrown: string | undefined;
  try {
    await ours(await openOurs(od));
  } catch (error) {
    thrown = (error as Error).message;
  }
  expect(snapshot(root, od, normalizeState)).toEqual(snapshot(root, nd, normalizeState));
  for (const args of [
    ["ls-files", "--resolve-undo"],
    ["stash", "list", "--format=%gs"],
  ]) {
    expect(gitOk(root, od, ...args), args.join(" ")).toBe(gitOk(root, nd, ...args));
  }
  rmSync(nd, { recursive: true, force: true });
  rmSync(od, { recursive: true, force: true });
  return { ...expected, thrown };
}

/** main changes f and adds n on top of base; side and other branch off base. */
const graph: Graph = {
  base: { f: text(), g: text(), h: text() },
  steps: [
    { branch: "side", files: { f: text({ 3: "side" }), g: text({ 3: "side" }) } },
    { branch: "pick", from: "main", files: { k: "picked\n" } },
    { branch: "next", from: "main", files: { u: "u\n", f: text({ 9: "next" }) } },
    { branch: "main", files: { f: text({ 3: "main" }), g: text({ 3: "main" }), n: "n\n" } },
  ],
};

const reset = (ref: string, mode: ResetMode) => (g: Git) =>
  g.reset().setRef(ref).setMode(mode).call();

describeGit("branch state against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "branch-state-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("merge --abort drops the resolve-undo records of resolved conflicts", async () => {
    await compare(
      graph,
      (dir) => {
        git(root, dir, "merge", "side");
        put(dir, "f", "resolved\n");
        gitOk(root, dir, "add", "f");
      },
      ["merge", "--abort"],
      (g) => g.merge().setOperation(MergeOperation.ABORT).call(),
    );
  });

  it("a branch switch forgets a merge or cherry-pick stopped before its commit", async () => {
    const switchTo = (g: Git) => g.checkout().setName("pick").call();
    // a merge --no-commit (clean), a squash, a cherry-pick --no-commit
    for (const step of [
      ["merge", "-q", "--no-commit", "--no-ff", "next"],
      ["merge", "-q", "--squash", "next"],
      ["cherry-pick", "--no-commit", "next"],
    ]) {
      await compare(
        graph,
        (dir) => gitOk(root, dir, ...step),
        ["checkout", "-q", "pick"],
        switchTo,
      );
    }
    // a merge's autostash is kept on refs/stash
    await compare(
      graph,
      (dir) => {
        put(dir, "h", "dirty\n");
        gitOk(root, dir, "merge", "-q", "--autostash", "--no-commit", "--no-ff", "next");
      },
      ["checkout", "-q", "pick"],
      switchTo,
    );
  });

  it("reset --merge: a dirty file elsewhere kept, a dirty file it resets refused", async () => {
    await compare(
      graph,
      (dir) => {
        put(dir, "h", "dirty\n");
        put(dir, "g", "staged\n");
        gitOk(root, dir, "add", "g");
      },
      ["reset", "--merge", "HEAD~1"],
      reset("HEAD~1", ResetMode.MERGE),
    );
    const refused = await compare(
      graph,
      (dir) => put(dir, "f", "dirty\n"),
      ["reset", "--merge", "HEAD~1"],
      reset("HEAD~1", ResetMode.MERGE),
    );
    expect(refused.thrown).toBe(refused.stderr.trim());
  });

  it("reset --merge in the middle of a merge resets its conflicts and forgets it", async () => {
    await compare(
      graph,
      (dir) => {
        put(dir, "h", "dirty\n");
        git(root, dir, "merge", "side");
      },
      ["reset", "--merge", "HEAD"],
      reset("HEAD", ResetMode.MERGE),
    );
  });

  it("reset --keep: files HEAD and the target differ on switched, local changes kept", async () => {
    await compare(
      graph,
      (dir) => {
        put(dir, "h", "dirty\n");
        put(dir, "k", "untracked\n");
      },
      ["reset", "--keep", "HEAD~1"],
      reset("HEAD~1", ResetMode.KEEP),
    );
    // a staged change of a file kept: unstaged after the reset
    await compare(
      graph,
      (dir) => {
        put(dir, "h", "staged\n");
        gitOk(root, dir, "add", "h");
      },
      ["reset", "--keep", "next"],
      reset("next", ResetMode.KEEP),
    );
  });

  it("reset --keep refuses local changes it would lose, and an untracked file in the way", async () => {
    const cases: [(dir: string) => void, string][] = [
      [(dir) => put(dir, "f", "dirty\n"), "HEAD~1"],
      [
        (dir) => {
          put(dir, "f", "staged\n");
          gitOk(root, dir, "add", "f");
        },
        "HEAD~1",
      ],
      [(dir) => put(dir, "u", "untracked\n"), "next"],
    ];
    for (const [prepare, target] of cases) {
      const refused = await compare(
        graph,
        prepare,
        ["reset", "--keep", target],
        reset(target, ResetMode.KEEP),
      );
      expect(refused.status).not.toBe(0);
      expect(refused.thrown).toBe(refused.stderr.trim());
    }
  });

  it("a keep or soft reset in the middle of a merge is refused, a hard one forgets it", async () => {
    const conflicted = (dir: string) => git(root, dir, "merge", "side");
    for (const mode of [ResetMode.KEEP, ResetMode.SOFT]) {
      const refused = await compare(
        graph,
        conflicted,
        ["reset", `--${mode}`, "HEAD"],
        reset("HEAD", mode),
      );
      expect(refused.thrown).toBe(refused.stderr.trim());
    }
    const clean = (dir: string) =>
      gitOk(root, dir, "merge", "-q", "--no-commit", "--no-ff", "next");
    await compare(graph, clean, ["reset", "--soft", "HEAD"], reset("HEAD", ResetMode.SOFT));
    await compare(
      graph,
      conflicted,
      ["reset", "--hard", "HEAD~1"],
      reset("HEAD~1", ResetMode.HARD),
    );
    await compare(graph, clean, ["reset", "-q", "HEAD"], reset("HEAD", ResetMode.MIXED));
  });
});
