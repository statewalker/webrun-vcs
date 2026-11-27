/**
 * `git commit --amend` that would make the commit empty (its tree its first parent's),
 * against native git (builtin/commit.c prepare_to_commit): refused with exit status 1,
 * run_status's text on stdout, `empty_amend_advice` on stderr, nothing moved (HEAD, the
 * index), in every way the commit can be prepared (`-m`, `--no-edit`, an editor, `-a`,
 * `-o <path>`). `--allow-empty` still amends, and so does an amend that changes only the
 * message. The text is the same in git 2.43 and 2.5x. statewalker/webrun-vcs#259.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type CommitCommand, EMPTY_AMEND_ADVICE, EmptyCommitError } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, openRepo, putFile } from "./status-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/** `base` adding a.txt, then `two` adding b.txt. */
function base(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, "a.txt", "a\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-qm", "base"]);
  putFile(dir, "b.txt", "b\n");
  git(dir, ["add", "b.txt"]);
  git(dir, ["commit", "-qm", "two\n\nwith a body"]);
}

/** Two copies of `dir`: native git works in one, ours in the other. */
function twins(dir: string): [string, string] {
  const out: [string, string] = [`${dir}-native`, `${dir}-ours`];
  for (const copy of out) {
    rmSync(copy, { recursive: true, force: true });
    execFileSync("cp", ["-a", dir, copy]);
    gitRun(root, copy, ["update-index", "-q", "--refresh"]);
  }
  return out;
}

const file = (d: string, path: string) => {
  const at = join(d, ".git", path);
  return existsSync(at) ? readFileSync(at).toString("latin1") : undefined;
};

/** What a refused commit must leave as native git left it. */
function expectSameState(mine: string, theirs: string, label: string): void {
  for (const args of [
    ["rev-parse", "HEAD"],
    ["ls-files", "-s"],
    ["status", "--porcelain"],
    ["log", "--format=%H %s"],
  ]) {
    expect(git(mine, args), `${label}: git ${args.join(" ")}`).toBe(git(theirs, args));
  }
  expect(file(mine, "COMMIT_EDITMSG"), `${label}: COMMIT_EDITMSG`).toBe(
    file(theirs, "COMMIT_EDITMSG"),
  );
  expect(existsSync(join(mine, ".git/index.lock")), `${label}: index.lock`).toBe(false);
}

describeGit("commit --amend that would make the commit empty: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "commit-empty-amend-"));
  });
  afterEach(() => removeTempDir(root), CLEANUP_TIMEOUT);

  const identity = async (_path: string, text: string) => text;

  it("refused with empty_amend_advice, exit 1, the status on stdout, nothing written", async () => {
    // t7501-commit-basic-functionality.sh: "same tree (single parent)" (amending)
    const dir = join(root, "r");
    base(dir);
    const cases: [string, (d: string) => void, string[], (c: CommitCommand) => CommitCommand][] = [
      [
        "-m, the added file unstaged",
        (d) => git(d, ["rm", "-q", "--cached", "b.txt"]),
        ["--amend", "-m", "x"],
        (c) => c.setAmend(true).setMessage("x"),
      ],
      [
        "--no-edit",
        (d) => git(d, ["rm", "-q", "--cached", "b.txt"]),
        ["--amend", "--no-edit"],
        (c) => c.setAmend(true).setEdit(false),
      ],
      [
        "an editor, the status in the template",
        (d) => git(d, ["rm", "-q", "--cached", "b.txt"]),
        ["--amend"],
        (c) => c.setAmend(true).setEditor(identity),
      ],
      [
        "an editor, commit.status=false",
        (d) => {
          git(d, ["rm", "-q", "--cached", "b.txt"]);
          git(d, ["config", "commit.status", "false"]);
        },
        ["--amend"],
        (c) => c.setAmend(true).setEditor(identity),
      ],
      [
        "-a staging the file's deletion",
        (d) => rmSync(join(d, "b.txt")),
        ["--amend", "-a", "-m", "x"],
        (c) => c.setAmend(true).setAll(true).setMessage("x"),
      ],
      [
        "-o <path> of the deleted file",
        (d) => rmSync(join(d, "b.txt")),
        ["--amend", "-m", "x", "-o", "b.txt"],
        (c) => c.setAmend(true).setMessage("x").setOnly("b.txt"),
      ],
      [
        "an unrelated untracked file and a modified tracked one",
        (d) => {
          git(d, ["rm", "-q", "--cached", "b.txt"]);
          putFile(d, "c.txt", "c\n");
          putFile(d, "a.txt", "a2\n");
        },
        ["--amend", "-m", "x"],
        (c) => c.setAmend(true).setMessage("x"),
      ],
    ];
    for (const [label, setup, args, ours] of cases) {
      const [theirs, mine] = twins(dir);
      setup(theirs);
      setup(mine);
      const native = gitRun(root, theirs, ["commit", ...args], { GIT_EDITOR: "true" });
      expect(native.status, `${label}: ${native.stderr}`).toBe(1);
      expect(native.stderr, label).toBe(EMPTY_AMEND_ADVICE);
      const error = await ours((await openRepo(root, mine)).commit())
        .call()
        .then(
          () => undefined,
          (e: Error) => e,
        );
      expect(error, label).toBeInstanceOf(EmptyCommitError);
      const refused = error as EmptyCommitError;
      expect(refused.exitCode, label).toBe(1);
      expect(refused.stderr, label).toBe(native.stderr);
      expect(`${refused.message}\n`, label).toBe(native.stderr);
      expect(refused.stdout, `${label}: stdout`).toBe(native.stdout);
      expectSameState(mine, theirs, label);
    }
  }, 120_000);

  it("--allow-empty still amends; an amend changing only the message works", async () => {
    // t7501-commit-basic-functionality.sh: "same tree (single parent) --allow-empty"
    const dir = join(root, "r");
    base(dir);
    const cases: [string, (d: string) => void, string[], (c: CommitCommand) => CommitCommand][] = [
      [
        "--allow-empty",
        (d) => git(d, ["rm", "-q", "--cached", "b.txt"]),
        ["--amend", "--allow-empty", "-m", "x"],
        (c) => c.setAmend(true).setAllowEmpty(true).setMessage("x"),
      ],
      [
        "only the message",
        () => {},
        ["--amend", "-m", "reworded"],
        (c) => c.setAmend(true).setMessage("reworded"),
      ],
      [
        "--no-edit, nothing changed",
        () => {},
        ["--amend", "--no-edit"],
        (c) => c.setAmend(true).setEdit(false),
      ],
    ];
    for (const [label, setup, args, ours] of cases) {
      const [theirs, mine] = twins(dir);
      setup(theirs);
      setup(mine);
      const native = gitRun(root, theirs, ["commit", "-q", ...args]);
      expect(native.status, `${label}: ${native.stderr}`).toBe(0);
      await ours((await openRepo(root, mine)).commit()).call();
      expectSameState(mine, theirs, label);
    }
  }, 60_000);

  it("an empty amend of a merge commit is allowed", async () => {
    // t7501-commit-basic-functionality.sh: "same tree (merge and amend merge)"
    const dir = join(root, "r");
    base(dir);
    git(dir, ["checkout", "-q", "-b", "side", "HEAD^"]);
    putFile(dir, "zero", "zero\n");
    git(dir, ["add", "zero"]);
    git(dir, ["commit", "-qm", "add zero"]);
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["merge", "-q", "-s", "ours", "side", "-m", "empty ok"]);
    const [theirs, mine] = twins(dir);
    const native = gitRun(root, theirs, ["commit", "-q", "--amend", "-m", "empty really ok"]);
    expect(native.status, native.stderr).toBe(0);
    await (await openRepo(root, mine)).commit().setAmend(true).setMessage("empty really ok").call();
    expectSameState(mine, theirs, "merge");
  }, 60_000);
});
