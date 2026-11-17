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
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CleanupMode,
  FastForwardMode,
  Git,
  MergeStatus,
  NoMessageError,
  stripspace,
} from "../src/index.js";
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
      // (a message alone makes the tag annotated, an empty one too)
      const command = git.tag().setName(name).setMessage(message);
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

  it("tag --cleanup=default is refused, as git's tag knows no such mode", async () => {
    const t = twins();
    const r = spawnSync("git", ["tag", "-a", "--cleanup=default", "-m", "x", "tg"], {
      cwd: t.native,
      env: nativeGitEnv(home),
      encoding: "latin1",
    });
    expect(r.status).toBe(128);
    await expect(
      (await open(t.ours))
        .tag()
        .setName("tg")
        .setMessage("x")
        .setCleanupMode(CleanupMode.DEFAULT)
        .call(),
    ).rejects.toThrow(r.stderr.trimEnd());
  });

  it("commit: core.commentChar=auto picks a character no line starts with; the last of core.commentString / core.commentChar wins", async () => {
    const t = twins();
    const git = await open(t.ours);
    for (const repo of [t.native, t.ours]) {
      run(repo, "config", "core.commentChar", "auto");
      run(repo, "config", "commit.cleanup", "strip");
    }
    for (const message of ["#foo\nbar", "a\n;b\n#c", "x\n# y\n"]) {
      run(t.native, "commit", "-q", "--allow-empty", "-m", message);
      await git.commit().setAllowEmpty(true).setMessage(message).call();
      expectSameObject(t, "HEAD");
    }
    // git reads both keys as one variable: the line set last wins (2.43 knows only commentChar)
    for (const repo of [t.native, t.ours]) {
      run(repo, "config", "--unset", "core.commentChar");
      run(repo, "config", "core.commentString", ";");
      run(repo, "config", "core.commentChar", "#");
    }
    run(t.native, "commit", "-q", "--allow-empty", "-m", "a\n;b\n#c");
    await (await open(t.ours)).commit().setAllowEmpty(true).setMessage("a\n;b\n#c").call();
    expectSameObject(t, "HEAD");
  });

  it("commit of a prepared MERGE_MSG: the comment character and commit.cleanup", async () => {
    const t = twins();
    const prepared = "subject\n; semi\n# hash\n\n";
    for (const repo of [t.native, t.ours]) {
      run(repo, "checkout", "-q", "-b", "side");
      run(repo, "commit", "-q", "--allow-empty", "-m", "s");
      run(repo, "checkout", "-q", "main");
      run(repo, "commit", "-q", "--allow-empty", "-m", "m");
      run(repo, "config", "core.commentChar", ";");
      run(repo, "merge", "-q", "--no-commit", "side");
      writeFileSync(join(repo, ".git/MERGE_MSG"), prepared);
    }
    // as git's commit once an editor accepts the message (no status comments)
    run(t.native, "-c", "core.editor=true", "commit", "-q", "--no-status");
    await (await open(t.ours)).commit().call();
    expectSameObject(t, "HEAD");
    for (const repo of [t.native, t.ours]) {
      run(repo, "reset", "-q", "--hard", "HEAD~1");
      run(repo, "config", "commit.cleanup", "whitespace");
      run(repo, "merge", "-q", "--no-commit", "side");
      writeFileSync(join(repo, ".git/MERGE_MSG"), prepared);
    }
    run(t.native, "-c", "core.editor=true", "commit", "-q", "--no-status");
    await (await open(t.ours)).commit().call();
    expectSameObject(t, "HEAD");
  });

  it("merge -m with a message that cleans up to nothing: refused, the merge left for commit", async () => {
    for (const threeWay of [false, true]) {
      const t = twins();
      for (const repo of [t.native, t.ours]) {
        run(repo, "checkout", "-q", "-b", "side");
        writeFileSync(join(repo, "s.txt"), "s\n");
        run(repo, "add", ".");
        run(repo, "commit", "-q", "-m", "s");
        run(repo, "checkout", "-q", "main");
        if (threeWay) run(repo, "commit", "-q", "--allow-empty", "-m", "m");
      }
      const r = spawnSync("git", ["merge", "--no-ff", "-m", "", "side"], {
        cwd: t.native,
        env: nativeGitEnv(home),
        encoding: "latin1",
      });
      expect(r.status).toBe(1);
      const result = await (await open(t.ours))
        .merge()
        .include("side")
        .setFastForwardMode(FastForwardMode.NO_FF)
        .setMessage("")
        .call();
      expect(result.status).toBe(MergeStatus.FAILED);
      expect(result.message).toBe(r.stderr.trimEnd());
      const state = (repo: string) => ({
        head: run(repo, "rev-parse", "HEAD"),
        index: run(repo, "ls-files", "-s"),
        status: run(repo, "status", "--porcelain"),
        files: ["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "AUTO_MERGE", "ORIG_HEAD"].map((f) =>
          existsSync(join(repo, ".git", f)) ? readFileSync(join(repo, ".git", f), "latin1") : null,
        ),
      });
      expect(state(t.ours)).toEqual(state(t.native));
      // `git commit` concludes it
      run(t.native, "commit", "-q", "-m", "done");
      await (await open(t.ours)).commit().setMessage("done").call();
      expectSameObject(t, "HEAD");
    }
  });
});
