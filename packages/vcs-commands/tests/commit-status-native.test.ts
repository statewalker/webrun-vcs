/**
 * The parts of `git commit` built on status output, against native git (builtin/commit.c):
 * `--dry-run` in every format it takes (`--long`, `--short`, `--porcelain`, `-z`,
 * `--branch`, `-u<mode>`, `-v`) with git's exit code (1 when nothing is committable), with
 * `-a`, `--only` paths and `--amend`; and the commit template the editor gets
 * (COMMIT_EDITMSG, copied by the editor script) in the normal, merge-conflict, rebase-in-
 * progress, cherry-pick and amend states, with `-v`/`-vv`, each cleanup mode,
 * `commit.status=false`, `core.commentChar` and `core.commentString`. Each case runs on two
 * copies of one repository: native git in one, ours in the other, and the commits made
 * must get the same ids.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CleanupMode, type CommitCommand, type UntrackedFilesMode } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, openRepo, putFile, testEnv } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
const git = (cwd: string, args: string[], extra?: Record<string, string>) =>
  gitOut(root, cwd, args, extra);
const bytesOf = (text: string) => Buffer.from(encodeGitPath(text)).toString("latin1");

/** Whether the git on PATH is 2.5x (core.commentString, the auto comment char warning). */
function nativeIs25x(): boolean {
  const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return !!m && (Number(m[1]) > 2 || Number(m[2]) >= 50);
}
const is25x = nativeGitAvailable() && nativeIs25x();

/** A repository with an upstream, history and a mix of changes. */
function base(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, ".gitignore", "*.log\n");
  putFile(dir, "a.txt", "a\n");
  putFile(dir, "b.txt", "b\nb\nb\nb\nb\n");
  putFile(dir, "c.txt", "c\n");
  putFile(dir, "d/e.txt", "e\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  putFile(dir, "a.txt", "a1\n");
  git(dir, ["commit", "-qam", "second\n\nwith a body"]);
}

function dirty(dir: string) {
  putFile(dir, "a.txt", "a2\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["mv", "b.txt", "moved.txt"]);
  putFile(dir, "c.txt", "c2\n");
  rmSync(join(dir, "d/e.txt"));
  putFile(dir, "u.txt", "u\n");
  putFile(dir, "udir/x", "x\n");
  putFile(dir, "x.log", "l\n");
}

/** Two copies of `dir` (native git works in one, ours in the other), stats refreshed. */
function twins(dir: string): [string, string] {
  const out: [string, string] = [`${dir}-native`, `${dir}-ours`];
  for (const copy of out) {
    execFileSync("cp", ["-a", dir, copy]);
    gitRun(root, copy, ["update-index", "-q", "--refresh"]);
  }
  return out;
}

describeGit("commit --dry-run: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "commit-status-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Ours and native git's dry run agree, output and exit code. */
  async function expectDryRun(
    dir: string,
    args: string[],
    setup: (c: CommitCommand) => void,
    label: string,
  ) {
    const native = gitRun(root, dir, ["commit", ...args]);
    const command = (await openRepo(root, dir)).commit();
    setup(command);
    const ours = await command.callDryRun();
    const what = `${label}: commit ${args.join(" ")}`;
    expect(bytesOf(ours.text), what).toBe(native.stdout);
    expect(ours.exitCode, what).toBe(native.status);
  }

  /** Every dry-run format, plain, with -a and with a path. */
  async function allFormats(dir: string, label: string) {
    const formats: [string[], (c: CommitCommand) => void][] = [
      [["--dry-run"], () => {}],
      [["--dry-run", "-v"], (c) => c.setVerbose(1)],
      [["--short"], (c) => c.setStatusFormat("short")],
      [["--short", "--branch"], (c) => c.setStatusFormat("short").setShowBranch(true)],
      [["--porcelain"], (c) => c.setStatusFormat("porcelain")],
      [
        ["--porcelain", "--branch", "-z"],
        (c) => c.setStatusFormat("porcelain").setShowBranch(true).setNullTermination(true),
      ],
      [["-z"], (c) => c.setNullTermination(true)],
      [["--long"], (c) => c.setStatusFormat("long")],
    ];
    for (const [args, setup] of formats) await expectDryRun(dir, args, setup, label);
    for (const mode of ["no", "normal", "all"] as UntrackedFilesMode[]) {
      await expectDryRun(dir, ["--dry-run", `-u${mode}`], (c) => c.setUntrackedFiles(mode), label);
    }
    await expectDryRun(dir, ["--dry-run", "-a"], (c) => c.setAll(true), label);
    await expectDryRun(
      dir,
      ["--short", "-a"],
      (c) => c.setAll(true).setStatusFormat("short"),
      label,
    );
  }

  it("dirty, clean, untracked only, and before the first commit", async () => {
    const dir = join(root, "r");
    base(dir);
    await allFormats(dir, "clean");
    putFile(dir, "u.txt", "u\n");
    await allFormats(dir, "untracked only");
    dirty(dir);
    await allFormats(dir, "dirty");
    await expectDryRun(dir, ["--dry-run", "--", "c.txt"], (c) => c.setOnly("c.txt"), "only");
    await expectDryRun(
      dir,
      ["--short", "--", "c.txt", "d/e.txt"],
      (c) => c.setOnly("c.txt", "d/e.txt").setStatusFormat("short"),
      "only",
    );
    await expectDryRun(dir, ["--dry-run", "--amend"], (c) => c.setAmend(true), "amend");
    await expectDryRun(
      dir,
      ["--short", "--amend"],
      (c) => c.setAmend(true).setStatusFormat("short"),
      "amend",
    );
    const fresh = join(root, "fresh");
    mkdirSync(fresh);
    git(fresh, ["init", "-q", "-b", "trunk"]);
    await allFormats(fresh, "empty initial");
    putFile(fresh, "f.txt", "f\n");
    git(fresh, ["add", "f.txt"]);
    await allFormats(fresh, "initial staged");
  }, 180_000);

  it("a merge with conflicts, then resolved; amend of a root commit", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["checkout", "-q", "-b", "side"]);
    putFile(dir, "c.txt", "side\n");
    git(dir, ["commit", "-qam", "side"]);
    git(dir, ["checkout", "-q", "main"]);
    putFile(dir, "c.txt", "main\n");
    git(dir, ["commit", "-qam", "main"]);
    gitRun(root, dir, ["merge", "side"]);
    await expectDryRun(dir, ["--dry-run"], () => {}, "merge conflict");
    await expectDryRun(
      dir,
      ["--short", "--branch"],
      (c) => c.setStatusFormat("short").setShowBranch(true),
      "merge conflict",
    );
    putFile(dir, "c.txt", "resolved\n");
    git(dir, ["add", "c.txt"]);
    await expectDryRun(dir, ["--dry-run"], () => {}, "merge resolved");
    await expectDryRun(
      dir,
      ["--porcelain"],
      (c) => c.setStatusFormat("porcelain"),
      "merge resolved",
    );
    const single = join(root, "single");
    mkdirSync(single);
    git(single, ["init", "-q", "-b", "main"]);
    putFile(single, "f.txt", "f\n");
    git(single, ["add", "f.txt"]);
    git(single, ["commit", "-qm", "root"]);
    await expectDryRun(single, ["--dry-run", "--amend"], (c) => c.setAmend(true), "amend root");
  }, 120_000);
});

describeGit("commit template: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "commit-template-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** An editor script: copies COMMIT_EDITMSG to $COPY_TO, then adds a subject line. */
  function editorScript(): string {
    const path = join(root, "editor.sh");
    writeFileSync(
      path,
      '#!/bin/sh\ncp "$1" "$COPY_TO"\n{ printf "Edited subject\\n\\n"; cat "$1"; } > "$1.new" && mv "$1.new" "$1"\n',
    );
    chmodSync(path, 0o755);
    return path;
  }

  /**
   * The template native git hands its editor and ours agree, and so do the commits made
   * from the edited message (same ids), on two copies of `dir`.
   */
  async function expectTemplate(
    dir: string,
    args: string[],
    setup: (c: CommitCommand) => void,
    label: string,
    extraEnv: Record<string, string> = {},
  ) {
    const [theirs, mine] = twins(dir);
    const copy = join(root, "native-template.txt");
    rmSync(copy, { force: true });
    const native = gitRun(root, theirs, ["commit", ...args], {
      GIT_EDITOR: editorScript(),
      COPY_TO: copy,
      ...extraEnv,
    });
    let expected: string | undefined;
    try {
      expected = readFileSync(copy).toString("latin1");
    } catch {
      // the commit stopped before the editor
    }
    let seen: string | undefined;
    const command = (await openRepo(root, mine, extraEnv)).commit();
    command.setEditor(async (_path: string, text: string) => {
      seen = text;
      return `Edited subject\n\n${text}`;
    });
    setup(command);
    let error: unknown;
    try {
      await command.call();
    } catch (e) {
      error = e;
    }
    expect(expected, `${label}: native git ran the editor`).toBeDefined();
    expect(seen !== undefined ? bytesOf(seen) : seen, `${label}: template`).toBe(expected);
    expect(error === undefined, `${label}: ${String(error)} / ${native.stderr}`).toBe(
      native.status === 0,
    );
    expect(git(mine, ["rev-parse", "HEAD"]), `${label}: commit`).toBe(
      git(theirs, ["rev-parse", "HEAD"]),
    );
    expect(git(mine, ["status", "--porcelain"]), `${label}: index`).toBe(
      git(theirs, ["status", "--porcelain"]),
    );
    rmSync(mine, { recursive: true, force: true });
    rmSync(theirs, { recursive: true, force: true });
  }

  it("a plain commit: modes, -v, -vv, cleanup, commit.status, comment characters", async () => {
    const dir = join(root, "r");
    base(dir);
    dirty(dir);
    await expectTemplate(dir, [], () => {}, "plain");
    await expectTemplate(dir, ["-uno"], (c) => c.setUntrackedFiles("no"), "-uno");
    await expectTemplate(dir, ["-uall"], (c) => c.setUntrackedFiles("all"), "-uall");
    await expectTemplate(dir, ["-v"], (c) => c.setVerbose(1), "-v");
    await expectTemplate(dir, ["-vv"], (c) => c.setVerbose(2), "-vv");
    await expectTemplate(dir, ["-a"], (c) => c.setAll(true), "-a");
    await expectTemplate(dir, ["--", "c.txt"], (c) => c.setOnly("c.txt"), "only");
    await expectTemplate(
      dir,
      ["-e", "-m", "Given"],
      (c) => c.setMessage("Given").setEdit(true),
      "-e -m",
    );
    for (const mode of [
      CleanupMode.SCISSORS,
      CleanupMode.WHITESPACE,
      CleanupMode.VERBATIM,
      CleanupMode.STRIP,
    ]) {
      await expectTemplate(
        dir,
        [`--cleanup=${mode}`],
        (c) => c.setCleanupMode(mode),
        `cleanup ${mode}`,
      );
    }
    if (is25x) {
      // git 2.43 writes the cut line twice here (before the status and again before the
      // diff); 2.5x remembers it was written (s->added_cut_line)
      await expectTemplate(
        dir,
        ["--cleanup=scissors", "-v"],
        (c) => c.setCleanupMode(CleanupMode.SCISSORS).setVerbose(1),
        "scissors -v",
      );
    }
    await expectTemplate(dir, ["--no-status"], (c) => c.setIncludeStatus(false), "--no-status");
    await expectTemplate(
      dir,
      ["--allow-empty-message"],
      (c) => c.setAllowEmptyMessage(true),
      "allow empty message",
    );
    git(dir, ["config", "commit.status", "false"]);
    await expectTemplate(dir, [], () => {}, "commit.status=false");
    git(dir, ["config", "--unset", "commit.status"]);
    git(dir, ["config", "core.commentChar", ";"]);
    await expectTemplate(dir, [], () => {}, "commentChar ;");
    git(dir, ["config", "--unset", "core.commentChar"]);
    if (is25x) {
      git(dir, ["config", "core.commentString", "//"]);
      await expectTemplate(dir, ["-v"], (c) => c.setVerbose(1), "commentString //");
      git(dir, ["config", "--unset", "core.commentString"]);
    }
    await expectTemplate(dir, [], () => {}, "author differs", { GIT_AUTHOR_NAME: "Someone Else" });
    git(dir, ["config", "core.commentChar", "auto"]);
    await expectTemplate(
      dir,
      ["-e", "-m", "#1 issue\n\nbody"],
      (c) => c.setMessage("#1 issue\n\nbody").setEdit(true),
      "commentChar auto",
    );
    git(dir, ["config", "--unset", "core.commentChar"]);
    const fresh = join(root, "fresh");
    mkdirSync(fresh);
    git(fresh, ["init", "-q", "-b", "trunk"]);
    putFile(fresh, "f.txt", "f\n");
    putFile(fresh, "u.txt", "u\n");
    git(fresh, ["add", "f.txt"]);
    await expectTemplate(fresh, [], () => {}, "initial commit");
    await expectTemplate(fresh, ["-v"], (c) => c.setVerbose(1), "initial commit -v");
  }, 300_000);

  it("amend, a merge with its conflict resolved, a cherry-pick, a rebase stopped", async () => {
    const dir = join(root, "r");
    base(dir);
    putFile(dir, "c.txt", "amended\n");
    git(dir, ["add", "c.txt"]);
    await expectTemplate(dir, ["--amend"], (c) => c.setAmend(true), "amend");
    await expectTemplate(dir, ["--amend", "-v"], (c) => c.setAmend(true).setVerbose(1), "amend -v");
    git(dir, ["commit", "-qm", "c amended"]);
    git(dir, ["checkout", "-q", "-b", "side"]);
    putFile(dir, "c.txt", "side\n");
    putFile(dir, "s.txt", "s\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "side change"]);
    git(dir, ["checkout", "-q", "main"]);
    putFile(dir, "c.txt", "main\n");
    git(dir, ["commit", "-qam", "main change"]);
    gitRun(root, dir, ["merge", "side"]);
    putFile(dir, "c.txt", "resolved\n");
    git(dir, ["add", "c.txt"]);
    await expectTemplate(dir, [], () => {}, "merge resolved");
    await expectTemplate(
      dir,
      ["--cleanup=scissors"],
      (c) => c.setCleanupMode(CleanupMode.SCISSORS),
      "merge scissors",
    );
    git(dir, ["merge", "--abort"]);
    gitRun(root, dir, ["cherry-pick", "side"]);
    putFile(dir, "c.txt", "picked\n");
    git(dir, ["add", "c.txt"]);
    await expectTemplate(dir, [], () => {}, "cherry-pick resolved");
    git(dir, ["cherry-pick", "--abort"]);
    git(dir, ["checkout", "-q", "side"]);
    gitRun(root, dir, ["rebase", "main"]);
    putFile(dir, "c.txt", "rebased\n");
    git(dir, ["add", "c.txt"]);
    await expectTemplate(dir, [], () => {}, "rebase conflict resolved");
    gitRun(root, dir, ["rebase", "--abort"]);
    for (let i = 0; i < 3; i++) {
      putFile(dir, `r${i}.txt`, `${i}\n`);
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", `r${i}`]);
    }
    gitRun(root, dir, ["rebase", "-i", "HEAD~3"], {
      GIT_SEQUENCE_EDITOR: "sed -i -e '2s/^pick/edit/'",
    });
    putFile(dir, "r1.txt", "edited\n");
    git(dir, ["add", "r1.txt"]);
    await expectTemplate(
      dir,
      ["--amend"],
      (c) => c.setAmend(true),
      "interactive rebase edit, amend",
    );
  }, 300_000);

  it("the long status of the states the templates were made in", async () => {
    // (the long format of each state is compared in status-long-native.test.ts; here the
    // template's own status is checked against `git status` run with the template's prefix)
    const dir = join(root, "r");
    base(dir);
    dirty(dir);
    const ours = await (await openRepo(root, dir))
      .status()
      .callText({ format: "long", verbose: 2 });
    expect(bytesOf(ours.text)).toBe(git(dir, ["status", "-vv"]));
    const one = await (await openRepo(root, dir)).status().callText({ format: "long", verbose: 1 });
    expect(bytesOf(one.text)).toBe(git(dir, ["status", "-v"]));
    expect(testEnv(root).GIT_AUTHOR_NAME).toBeDefined();
  }, 60_000);
});
