/**
 * `git commit -p` against native git: the hunks are selected into a temporary index (the
 * index lock), as `interactive_add` does for builtin/commit.c's prepare_index, then committed.
 * Both twins get the same answers on stdin and the same scripted editor; the transcript
 * (patch mode's stdout before commit's own lines), stderr, HEAD, the index and the worktree
 * are compared. Inputs from git's t/t7514-commit-patch.sh.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PatchResult } from "../src/commands/add-patch/index.js";
import { EmptyCommitError, UnmergedPathsError } from "../src/index.js";
import {
  type Editor,
  gitOk,
  KEEP,
  native,
  openOurs,
  put,
  sed,
  selector,
  view,
} from "./interactive-extras-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let counter = 0;
let compat: "2.43" | "2.56" = "2.56";

function twins(build: (dir: string) => void): { native: string; ours: string } {
  const n = counter++;
  const dirs = { native: join(root, `n${n}`), ours: join(root, `o${n}`) };
  for (const dir of [dirs.native, dirs.ours]) {
    gitOk(root, root, ["init", "-q", "-b", "main", dir]);
    build(dir);
  }
  return dirs;
}

/** t7514's setup: `file` committed with one line, then a line appended. */
function t7514(dir: string): void {
  put(dir, "file", "line1\n");
  gitOk(root, dir, ["add", "file"]);
  gitOk(root, dir, ["commit", "-qm", "commit1"]);
  put(dir, "file", "line1\nmore\n");
}

const twenty = Array.from({ length: 20 }, (_, i) => `${i + 1}\n`).join("");

/** `f` of 20 lines changed in two places, `g` changed, `n` new and intent-to-add. */
function hunks(dir: string): void {
  put(dir, "f", twenty);
  put(dir, "g", "x\n");
  gitOk(root, dir, ["add", "."]);
  gitOk(root, dir, ["commit", "-qm", "base"]);
  put(dir, "f", twenty.replace("2\n", "two\n").replace("18\n", "eighteen\n"));
  put(dir, "g", "x\ny\n");
  put(dir, "n", "new\n");
  gitOk(root, dir, ["add", "-N", "n"]);
}

interface Case {
  args: string[];
  answers: string[];
  editors?: Editor[];
  /** Our command, as the arguments say */
  paths?: string[];
  message: string;
}

/** Runs both; compares the transcript, stderr, the outcome and the repositories. */
async function compare(dirs: { native: string; ours: string }, c: Case) {
  const n = native(root, dirs.native, ["commit", "-p", ...c.args], c.answers, c.editors);
  const git = await openOurs(root, dirs.ours);
  const buffers: string[] = [];
  const cmd = git
    .commit()
    .setMessage(c.message)
    .setPatch(true)
    .setPatchSelector(selector(c.answers, c.editors, buffers))
    .setCompatibility(compat);
  if (c.paths?.length) cmd.setOnly(...c.paths);
  let error: unknown;
  try {
    await cmd.call();
  } catch (e) {
    error = e;
  }
  const patch = cmd.getPatchResult() as PatchResult;
  // patch mode's transcript, then commit's own lines (its summary, or the status)
  expect(n.stdout.slice(0, patch.output.length)).toBe(patch.output);
  const rest = n.stdout.slice(patch.output.length);
  if (n.status === 0) {
    expect(error).toBeUndefined();
    expect(rest).toMatch(/^\[main [0-9a-f]+\] /);
  } else {
    expect(error).toBeInstanceOf(EmptyCommitError);
    expect(rest).toMatch(/^On branch main\n/);
  }
  expect(patch.errors).toBe(n.stderr);
  expect(buffers).toEqual(n.buffers);
  expect(view(root, dirs.ours)).toEqual(view(root, dirs.native));
}

describeGit("commit -p as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "commit-patch-native-"));
    compat = gitAtLeast(gitOk(root, root, ["--version"]), 2, 50) ? "2.56" : "2.43";
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it('t7514-commit-patch.sh: “edit hunk "commit -p -m message"”', async () => {
    await compare(twins(t7514), {
      args: ["-m", "commit2", "file"],
      answers: ["e"],
      editors: [KEEP],
      paths: ["file"],
      message: "commit2",
    });
  });

  it('t7514-commit-patch.sh: “edit hunk "commit --dry-run -p -m message"”', async () => {
    // the script runs `commit -p -m commit3 file` after the previous test's commit
    const after = (dir: string) => {
      t7514(dir);
      gitOk(root, dir, ["commit", "-qam", "commit2"]);
      put(dir, "file", "line1\nmore\nmore\n");
    };
    await compare(twins(after), {
      args: ["-m", "commit3", "file"],
      answers: ["e"],
      editors: [KEEP],
      paths: ["file"],
      message: "commit3",
    });
  });

  it("commits the selected hunks, an edited one and an intent-to-add file", async () => {
    await compare(twins(hunks), {
      args: ["-m", "some"],
      answers: ["y", "n", "n", "y"],
      message: "some",
    });
    const edit = sed("s/^+eighteen/+EIGHTEEN/", (t) => t.replace(/^\+eighteen$/m, "+EIGHTEEN"));
    await compare(twins(hunks), {
      args: ["-m", "split"],
      answers: ["s", "n", "e", "q"],
      editors: [edit],
      message: "split",
    });
    await compare(twins(hunks), {
      args: ["-m", "only g", "--", "g"],
      answers: ["?", "y"],
      paths: ["g"],
      message: "only g",
    });
  });

  it("commits nothing when nothing is selected, or nothing changed", async () => {
    await compare(twins(hunks), {
      args: ["-m", "none"],
      answers: ["n", "d", "q"],
      message: "none",
    });
    await compare(twins(hunks), { args: ["-m", "eof"], answers: [], message: "eof" });
    await compare(twins(t7514), {
      args: ["-m", "nothing", "--", "nope"],
      answers: [],
      paths: ["nope"],
      message: "nothing",
    });
  });

  it("commits a selected empty intent-to-add file, clearing its flag", async () => {
    const withEmpty = (dir: string) => {
      hunks(dir);
      put(dir, "e", "");
      gitOk(root, dir, ["add", "-N", "e"]);
    };
    await compare(twins(withEmpty), {
      args: ["-m", "all"],
      answers: ["y", "y", "y", "y", "y", "y"],
      message: "all",
    });
    await compare(twins(withEmpty), {
      args: ["-m", "only e", "--", "e"],
      answers: ["y"],
      paths: ["e"],
      message: "only e",
    });
    await compare(twins(withEmpty), {
      args: ["-m", "not e", "--", "e", "g"],
      answers: ["n", "y"],
      paths: ["e", "g"],
      message: "not e",
    });
  });

  it("refuses --fixup=reword: with -p as git does", async () => {
    const dirs = twins(hunks);
    const n = native(root, dirs.native, ["commit", "-p", "--fixup=reword:HEAD"], ["y"]);
    expect(n.status).toBe(128);
    const git = await openOurs(root, dirs.ours);
    await expect(
      git
        .commit()
        .setFixup("reword:HEAD")
        .setPatch(true)
        .setPatchSelector(selector(["y"]))
        .call(),
    ).rejects.toThrow(n.stderr.trim());
    expect(view(root, dirs.ours)).toEqual(view(root, dirs.native));
  });

  it("refuses -a, -i and unmerged entries as git does", async () => {
    const dirs = twins(hunks);
    const git = await openOurs(root, dirs.ours);
    const n = native(root, dirs.native, ["commit", "-p", "-a", "-m", "x"], []);
    expect(n.status).toBe(128);
    await expect(
      git
        .commit()
        .setMessage("x")
        .setAll(true)
        .setPatch(true)
        .setPatchSelector(selector([]))
        .call(),
    ).rejects.toThrow(n.stderr.trim());
    const conflicted = twins((dir) => {
      put(dir, "c", "base\n");
      gitOk(root, dir, ["add", "c"]);
      gitOk(root, dir, ["commit", "-qm", "base"]);
      gitOk(root, dir, ["checkout", "-qb", "side"]);
      put(dir, "c", "side\n");
      gitOk(root, dir, ["commit", "-qam", "side"]);
      gitOk(root, dir, ["checkout", "-q", "main"]);
      put(dir, "c", "main\n");
      gitOk(root, dir, ["commit", "-qam", "main"]);
      native(root, dir, ["merge", "side"], []);
    });
    const u = native(root, conflicted.native, ["commit", "-p", "-m", "x"], []);
    expect(u.status).toBe(128);
    const ours = await openOurs(root, conflicted.ours);
    const error = await ours
      .commit()
      .setMessage("x")
      .setPatch(true)
      .setPatchSelector(selector([]))
      .call()
      .catch((e) => e);
    expect(error).toBeInstanceOf(UnmergedPathsError);
    expect(`${error.message}\n`).toBe(u.stderr);
    expect(view(root, conflicted.ours)).toEqual(view(root, conflicted.native));
  });
});
