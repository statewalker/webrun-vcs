/**
 * When the index keeps its resolve-undo records (`REUC`), against native git. git records
 * them when a conflict is resolved (`git add`) and keeps them through the commands that edit
 * the index in place (`commit`, `reset --mixed`, which records the stages it removes, `rm`,
 * an up-to-date `merge`); a command that writes a new index through unpack-trees (`merge`,
 * `cherry-pick`, `rebase`, `checkout` of a branch, `reset --hard`) drops them. Twins built
 * apart, a conflict made and resolved natively in both, then one command natively and ours,
 * and `git ls-files --resolve-undo` compared with the rest of the snapshot.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
import { MergeOperation, ResetMode } from "../src/index.js";
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
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

const HISTORY: History = {
  base: { f: text(), g: text(), keep: "k\n" },
  side: { f: text({ 2: "side" }), g: text({ 3: "side" }) },
  main: { f: text({ 2: "main" }), g: text({ 3: "main" }) },
};

interface Case {
  /** Native git's command */
  native: string[];
  /** Ours */
  ours: (repo: Git) => Promise<unknown>;
  /** Commit the resolution (natively, in both) before the command */
  committed?: boolean;
  /** Resolve only `f` (leave `g` conflicted) */
  partial?: boolean;
  /** A local change of `keep` before the command */
  dirty?: boolean;
}

/** Twins with the side merge resolved by `git add` (REUC recorded); the command run. */
async function compareCase(c: Case): Promise<void> {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  for (const dir of [native, ours]) {
    buildHistory(root, dir, HISTORY);
    // a branch to cherry-pick, merge and check out (no conflict with main)
    gitOk(root, dir, "checkout", "-q", "-b", "other", "main~1");
    put(dir, "o", "o\n");
    gitOk(root, dir, "add", "o");
    gitOk(root, dir, "commit", "-q", "-m", "other");
    gitOk(root, dir, "checkout", "-q", "main");
    git(root, dir, "merge", "side");
    put(dir, "f", "resolved\n");
    if (!c.partial) put(dir, "g", "resolved\n");
    gitOk(root, dir, "add", ...(c.partial ? ["f"] : ["f", "g"]));
    if (c.committed) gitOk(root, dir, "commit", "-q", "-m", "merged");
    if (c.dirty) put(dir, "keep", "dirty\n");
  }
  git(root, native, ...c.native);
  await c.ours(await openOurs(ours));
  const reuc = (dir: string) => gitOk(root, dir, "ls-files", "--resolve-undo");
  expect(reuc(ours)).toBe(reuc(native));
  // the index and the worktree (what these commands do besides is compared elsewhere)
  const a = snapshot(root, ours, normalizeState);
  const b = snapshot(root, native, normalizeState);
  expect([a.index, a.files]).toEqual([b.index, b.files]);
  rmSync(native, { recursive: true, force: true });
  rmSync(ours, { recursive: true, force: true });
}

describeGit("resolve-undo (REUC) kept or dropped as native git does", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "reuc-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("committing the merge keeps it", async () => {
    await compareCase({
      native: ["merge", "--continue"],
      ours: (repo) =>
        repo
          .merge()
          .setOperation(MergeOperation.CONTINUE)
          .setAuthor(INTEROP_IDENT)
          .setCommitter(INTEROP_IDENT)
          .call(),
    });
  });

  it("a merge drops it", async () => {
    await compareCase({
      committed: true,
      native: ["merge", "other"],
      ours: (repo) =>
        repo.merge().include("other").setAuthor(INTEROP_IDENT).setCommitter(INTEROP_IDENT).call(),
    });
  });

  it("an up-to-date merge keeps it", async () => {
    await compareCase({
      committed: true,
      native: ["merge", "side"],
      ours: (repo) =>
        repo.merge().include("side").setAuthor(INTEROP_IDENT).setCommitter(INTEROP_IDENT).call(),
    });
  });

  it("a cherry-pick drops it", async () => {
    await compareCase({
      committed: true,
      native: ["cherry-pick", "other"],
      ours: (repo) => repo.cherryPick().include("other").setCommitter(INTEROP_IDENT).call(),
    });
  });

  it("reset --mixed keeps it and records the stages it removes", async () => {
    await compareCase({
      partial: true,
      native: ["reset", "-q"],
      ours: (repo) => repo.reset().setMode(ResetMode.MIXED).call(),
    });
  });

  it("reset --soft keeps it", async () => {
    await compareCase({
      committed: true,
      native: ["reset", "-q", "--soft", "HEAD~1"],
      ours: (repo) => repo.reset().setMode(ResetMode.SOFT).setRef("HEAD~1").call(),
    });
  });

  it("reset --hard drops it", async () => {
    await compareCase({
      committed: true,
      native: ["reset", "-q", "--hard"],
      ours: (repo) => repo.reset().setMode(ResetMode.HARD).call(),
    });
  });

  it("checkout of another branch drops it", async () => {
    await compareCase({
      committed: true,
      native: ["checkout", "-q", "other"],
      ours: (repo) => repo.checkout().setName("other").call(),
    });
  });

  it("a stash drops it", async () => {
    await compareCase({
      committed: true,
      dirty: true,
      native: ["stash", "-q"],
      ours: (repo) => repo.stashCreate().call(),
    });
  });

  it("a rebase drops it", async () => {
    await compareCase({
      committed: true,
      native: ["rebase", "-q", "other"],
      ours: async (repo) => {
        const command = repo.rebase().setCommitter(INTEROP_IDENT);
        await command.setUpstreamBranch("other");
        return command.call();
      },
    });
  });
});
