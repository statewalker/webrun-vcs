/**
 * The messages of commits, merges, tags and stashes, cleaned up as native git cleans up
 * `-m`: twins built by native git with fixed dates, the same message given to native git
 * (`commit -m`, `merge -m`, `tag -m`, `stash push -m`) and to ours (`setMessage`, no
 * trailing newline added by the caller), then the objects compared by id and bytes.
 *
 * git's rules (2.43 and 2.56 alike): `commit -m` ends the message's last line, then cleans
 * up as `whitespace` (or `commit.cleanup`, `--cleanup`); `merge -m` the same without ending
 * the line first (a `verbatim` merge message has no newline); `tag -m` cleans up as
 * `strip` (comment lines go) unless `--cleanup`, and `verbatim` adds no newline; a stash
 * message is stored as given after `On <branch>: `.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CleanupMode, Git, NoMessageError, stripspace } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(home),
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });

/** A message with every case the cleanup handles. */
const MESSAGE = "  \n\nsubject  \n# a comment\n\n\n  body\t\r\n\n";

function build(base: string): string {
  mkdirSync(base, { recursive: true });
  run(base, "init", "-q", "-b", "main", "repo");
  const repo = join(base, "repo");
  writeFileSync(join(repo, "a.txt"), "a\n");
  run(repo, "add", ".");
  run(repo, "commit", "-qm", "c1");
  return repo;
}

let counter = 0;
function twins(): { native: string; ours: string } {
  const n = counter++;
  return { native: build(join(root, `t${n}-native`)), ours: build(join(root, `t${n}-ours`)) };
}

async function open(repo: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: nativeGitEnv(home) });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** `rev` in both twins: the same id and the same object bytes. */
function expectSameObject(t: { native: string; ours: string }, rev: string): void {
  const show = (repo: string) => {
    const id = run(repo, "rev-parse", rev).trim();
    const type = run(repo, "cat-file", "-t", id).trim();
    return { rev, id, object: run(repo, "cat-file", type, id) };
  };
  expect(show(t.ours)).toEqual(show(t.native));
}

describeGit("message cleanup of -m, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "message-cleanup-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("commit -m: default (whitespace), strip, verbatim, commit.cleanup, a message without a newline", async () => {
    const t = twins();
    const git = await open(t.ours);
    const cases: [string[], string, CleanupMode | undefined][] = [
      [[], "plain subject", undefined],
      [[], MESSAGE, undefined],
      [["--cleanup=strip"], MESSAGE, CleanupMode.STRIP],
      [["--cleanup=verbatim"], MESSAGE, CleanupMode.VERBATIM],
      [["--cleanup=verbatim"], "no newline", CleanupMode.VERBATIM],
      [["--cleanup=scissors"], MESSAGE, CleanupMode.SCISSORS],
    ];
    for (const [options, message, mode] of cases) {
      run(t.native, "commit", "-q", "--allow-empty", ...options, "-m", message);
      const command = git.commit().setAllowEmpty(true).setMessage(message);
      if (mode) command.setCleanupMode(mode);
      await command.call();
      expectSameObject(t, "HEAD");
    }
    for (const repo of [t.native, t.ours]) run(repo, "config", "commit.cleanup", "strip");
    run(t.native, "commit", "-q", "--allow-empty", "-m", MESSAGE);
    await (await open(t.ours)).commit().setAllowEmpty(true).setMessage(MESSAGE).call();
    expectSameObject(t, "HEAD");
    // the reflog subject is the cleaned message's first line
    expect(run(t.ours, "reflog", "-1", "--format=%gs")).toBe(
      run(t.native, "reflog", "-1", "--format=%gs"),
    );
    // a message that cleans up to nothing is refused, as git's
    // "Aborting commit due to empty commit message."
    await expect(
      (await open(t.ours)).commit().setAllowEmpty(true).setMessage(" \n# x\n").call(),
    ).rejects.toThrow(NoMessageError);
    // --amend --no-edit keeps the message, cleaned up again
    run(t.native, "commit", "-q", "--amend", "--no-edit", "--allow-empty");
    await (await open(t.ours)).commit().setAmend(true).setAllowEmpty(true).call();
    expectSameObject(t, "HEAD");
  });

  it("merge -m: a merge commit, cleaned up as a commit message", async () => {
    const t = twins();
    for (const repo of [t.native, t.ours]) {
      run(repo, "checkout", "-q", "-b", "side");
      run(repo, "commit", "-q", "--allow-empty", "-m", "s");
      run(repo, "checkout", "-q", "main");
      run(repo, "commit", "-q", "--allow-empty", "-m", "m");
    }
    run(t.native, "merge", "-q", "-m", MESSAGE, "side");
    await (await open(t.ours)).merge().include("side").setMessage(MESSAGE).call();
    expectSameObject(t, "HEAD");
    for (const repo of [t.native, t.ours]) run(repo, "reset", "-q", "--hard", "HEAD~1");
    run(t.native, "merge", "-q", "--cleanup=verbatim", "-m", "verbatim merge", "side");
    await (await open(t.ours))
      .merge()
      .include("side")
      .setMessage("verbatim merge")
      .setCleanupMode(CleanupMode.VERBATIM)
      .call();
    expectSameObject(t, "HEAD");
  });

  it("tag -m: strip by default (comments go), whitespace, verbatim; core.commentChar; an empty message", async () => {
    const t = twins();
    const git = await open(t.ours);
    const cases: [string, string[], string, CleanupMode | undefined][] = [
      ["t1", [], "release", undefined],
      ["t2", [], MESSAGE, undefined],
      ["t3", ["--cleanup=whitespace"], MESSAGE, CleanupMode.WHITESPACE],
      ["t4", ["--cleanup=verbatim"], MESSAGE, CleanupMode.VERBATIM],
      ["t5", ["--cleanup=verbatim"], "no newline", CleanupMode.VERBATIM],
      ["t6", [], "", undefined],
      ["t7", [], "# only a comment", undefined],
    ];
    for (const [name, options, message, mode] of cases) {
      run(t.native, "tag", "-a", ...options, "-m", message, name);
      const command = git.tag().setName(name).setAnnotated(true).setMessage(message);
      if (mode) command.setCleanupMode(mode);
      await command.call();
      expectSameObject(t, name);
    }
    for (const repo of [t.native, t.ours]) run(repo, "config", "core.commentChar", ";");
    run(t.native, "tag", "-a", "-m", "x\n;c\n#d", "t8");
    await (await open(t.ours)).tag().setName("t8").setMessage("x\n;c\n#d").call();
    expectSameObject(t, "t8");
  });

  it("stash push -m: the message as given, after `On <branch>: `", async () => {
    const t = twins();
    for (const repo of [t.native, t.ours]) writeFileSync(join(repo, "a.txt"), "changed\n");
    run(t.native, "stash", "push", "-q", "-m", MESSAGE);
    await (await open(t.ours)).stashCreate().setMessage(MESSAGE).call();
    expectSameObject(t, "stash");
    expectSameObject(t, "stash^2");
  });

  it("stripspace is git's strbuf_stripspace", () => {
    expect(stripspace(MESSAGE)).toBe("subject\n# a comment\n\n  body\n");
    expect(stripspace(MESSAGE, "#")).toBe("subject\n\n  body\n");
    expect(stripspace("a \n\u000b\n")).toBe("a \n\u000b\n");
    expect(stripspace("")).toBe("");
    expect(stripspace("\n \n")).toBe("");
  });
});
