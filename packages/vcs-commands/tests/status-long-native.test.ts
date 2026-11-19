/**
 * The text forms of `git status` against native git (wt-status.c): the long format with its
 * branch line, tracking report, operation-in-progress lines (merge, rebase, interactive
 * rebase, cherry-pick, revert, bisect, am, sparse checkout), section headers, hints and
 * closing line; `status.displayCommentPrefix`, `advice.statusHints=false`, `-uno`,
 * `--ignored`, `--show-stash`; and the short, porcelain v1 and v2 formats with `--branch`
 * and `-z`. Every state is checked with each format, against the git on PATH.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { StatusCallTextOptions } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, openRepo, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
const git = (cwd: string, args: string[], extra?: Record<string, string>) =>
  gitOut(root, cwd, args, extra);
const bytesOf = (text: string) => Buffer.from(encodeGitPath(text)).toString("latin1");

/** The formats compared: native git's options and ours. */
const FORMATS: [string[], StatusCallTextOptions, string[]?][] = [
  [[], {}],
  [["--long"], { format: "long" }, ["status.displayCommentPrefix=true"]],
  [["--long"], { format: "long" }, ["advice.statusHints=false"]],
  [["--long", "-uno"], { format: "long" }],
  [["--long", "--ignored"], { format: "long" }],
  [["--long", "--show-stash"], { format: "long", showStash: true }],
  [["--short", "--branch"], { format: "short", branch: true }],
  [["--porcelain", "-b"], { format: "porcelain", branch: true }],
  [["--porcelain=v2", "--branch"], { format: "porcelain-v2", branch: true }],
  [
    ["--porcelain=v2", "--branch", "--show-stash"],
    { format: "porcelain-v2", branch: true, showStash: true },
  ],
  [["-z"], { z: true }],
  [["--short", "-z", "-b"], { format: "short", z: true, branch: true }],
  [["--porcelain=v2", "-z", "--branch"], { format: "porcelain-v2", z: true, branch: true }],
  [["--short"], { format: "short" }, ["status.aheadBehind=false", "status.branch=true"]],
  [["--long"], { format: "long" }, ["status.aheadBehind=false"]],
];

/** Ours and native git agree on every format in the repository's state. */
async function expectAllFormats(dir: string, label: string) {
  for (const [args, options, config = []] of FORMATS) {
    const untracked = args.includes("-uno") ? "no" : undefined;
    const ignored = args.includes("--ignored") ? "traditional" : undefined;
    for (const c of config) {
      const [k, v] = c.split("=") as [string, string];
      git(dir, ["config", k, v]);
    }
    try {
      const command = (await openRepo(root, dir)).status();
      if (untracked) command.setUntrackedFiles(untracked);
      if (ignored) command.setIgnored(ignored);
      const ours = await command.callText(options);
      const native = git(dir, ["status", ...args]);
      expect(bytesOf(ours.text), `${label}: status ${args.join(" ")} ${config.join(" ")}`).toBe(
        native,
      );
    } finally {
      for (const c of config) git(dir, ["config", "--unset", c.split("=")[0] as string]);
    }
  }
}

/** A repository with a remote-tracking upstream and a mix of changes. */
function base(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, ".gitignore", "*.log\n");
  putFile(dir, "a.txt", "a\n");
  putFile(dir, "b.txt", "b\nb\nb\nb\nb\n");
  putFile(dir, "c.txt", "c\n");
  putFile(dir, "d/e.txt", "e\n");
  putFile(dir, "sp ace.txt", "s\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
}

/** A mix of staged, unstaged, untracked and ignored changes. */
function dirty(dir: string) {
  putFile(dir, "a.txt", "a2\n");
  git(dir, ["add", "a.txt"]);
  git(dir, ["mv", "b.txt", "moved.txt"]);
  putFile(dir, "c.txt", "c2\n");
  rmSync(join(dir, "d/e.txt"));
  putFile(dir, "new.txt", "n\n");
  git(dir, ["add", "new.txt"]);
  putFile(dir, "sp ace.txt", "s2\n");
  putFile(dir, "u.txt", "u\n");
  putFile(dir, "udir/x", "x\n");
  putFile(dir, "x.log", "l\n");
  putFile(dir, "caf\xe9.txt", "c\n");
}

/** A conflict on c.txt between main and a side branch. */
function conflictBranches(dir: string) {
  git(dir, ["checkout", "-q", "-b", "side"]);
  putFile(dir, "c.txt", "side\n");
  putFile(dir, "side.txt", "s\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "side change"]);
  git(dir, ["checkout", "-q", "main"]);
  putFile(dir, "c.txt", "main\n");
  git(dir, ["commit", "-qam", "main change"]);
}

describeGit("status text forms: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "status-long-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a clean repository, a dirty one, and one before its first commit", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectAllFormats(dir, "clean");
    putFile(dir, "u.txt", "u\n");
    await expectAllFormats(dir, "untracked only");
    dirty(dir);
    await expectAllFormats(dir, "dirty");
    const fresh = join(root, "fresh");
    mkdirSync(fresh);
    git(fresh, ["init", "-q", "-b", "trunk"]);
    await expectAllFormats(fresh, "empty initial");
    putFile(fresh, "f.txt", "f\n");
    await expectAllFormats(fresh, "initial untracked");
    git(fresh, ["add", "f.txt"]);
    await expectAllFormats(fresh, "initial staged");
  }, 120_000);

  it("tracking: up to date, ahead, behind, diverged, gone; detached HEAD at and from", async () => {
    const upstream = join(root, "up");
    base(upstream);
    const dir = join(root, "r");
    git(root, ["clone", "-q", upstream, dir]);
    await expectAllFormats(dir, "up to date");
    putFile(dir, "a.txt", "ahead\n");
    git(dir, ["commit", "-qam", "ahead"]);
    await expectAllFormats(dir, "ahead");
    putFile(upstream, "c.txt", "up\n");
    git(upstream, ["commit", "-qam", "up1"]);
    putFile(upstream, "c.txt", "up2\n");
    git(upstream, ["commit", "-qam", "up2"]);
    git(dir, ["fetch", "-q"]);
    await expectAllFormats(dir, "diverged");
    git(dir, ["reset", "-q", "--hard", "HEAD~1"]);
    await expectAllFormats(dir, "behind");
    git(dir, ["update-ref", "-d", "refs/remotes/origin/main"]);
    await expectAllFormats(dir, "gone");
    git(dir, ["checkout", "-q", "--detach", "HEAD"]);
    await expectAllFormats(dir, "detached at");
    putFile(dir, "a.txt", "detached commit\n");
    git(dir, ["commit", "-qam", "on detached"]);
    await expectAllFormats(dir, "detached from");
    git(dir, ["tag", "v1", "HEAD~1"]);
    git(dir, ["checkout", "-q", "v1"]);
    await expectAllFormats(dir, "detached at tag");
  }, 120_000);

  it("a merge with conflicts, then resolved", async () => {
    const dir = join(root, "r");
    base(dir);
    conflictBranches(dir);
    gitRun(root, dir, ["merge", "side"]);
    putFile(dir, "u.txt", "u\n");
    await expectAllFormats(dir, "merge conflict");
    putFile(dir, "c.txt", "resolved\n");
    git(dir, ["add", "c.txt"]);
    await expectAllFormats(dir, "merge resolved");
  }, 120_000);

  it("deletion conflicts: each unmerged label and hint", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["checkout", "-q", "-b", "side"]);
    git(dir, ["rm", "-q", "a.txt"]);
    putFile(dir, "c.txt", "side\n");
    putFile(dir, "both.txt", "side\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "side"]);
    git(dir, ["checkout", "-q", "main"]);
    putFile(dir, "a.txt", "main\n");
    git(dir, ["rm", "-q", "c.txt"]);
    putFile(dir, "both.txt", "main\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "main"]);
    gitRun(root, dir, ["merge", "side"]);
    await expectAllFormats(dir, "modify/delete conflicts");
  }, 120_000);

  it("rebase: stopped on a conflict, and an interactive rebase stopped to edit", async () => {
    const dir = join(root, "r");
    base(dir);
    conflictBranches(dir);
    git(dir, ["checkout", "-q", "side"]);
    gitRun(root, dir, ["rebase", "main"]);
    await expectAllFormats(dir, "rebase conflict");
    gitRun(root, dir, ["rebase", "--abort"]);
    git(dir, ["checkout", "-q", "main"]);
    for (let i = 0; i < 4; i++) {
      putFile(dir, `r${i}.txt`, `${i}\n`);
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", `r${i}`]);
    }
    gitRun(root, dir, ["rebase", "-i", "HEAD~4"], {
      GIT_SEQUENCE_EDITOR: "sed -i -e '1s/^pick/edit/' -e '3s/^pick/edit/'",
    });
    await expectAllFormats(dir, "interactive edit (1 done)");
    git(dir, ["rebase", "--continue"], { GIT_EDITOR: "true" });
    await expectAllFormats(dir, "interactive edit (3 done)");
    putFile(dir, "r1.txt", "dirty\n");
    await expectAllFormats(dir, "interactive edit, dirty");
  }, 120_000);

  it("cherry-pick and revert stopped on conflicts; bisect; am", async () => {
    const dir = join(root, "r");
    base(dir);
    conflictBranches(dir);
    gitRun(root, dir, ["cherry-pick", "side"]);
    await expectAllFormats(dir, "cherry-pick conflict");
    putFile(dir, "c.txt", "ok\n");
    git(dir, ["add", "c.txt"]);
    await expectAllFormats(dir, "cherry-pick resolved");
    gitRun(root, dir, ["cherry-pick", "--abort"]);
    putFile(dir, "c.txt", "again\n");
    git(dir, ["commit", "-qam", "again"]);
    gitRun(root, dir, ["revert", "HEAD~1"]);
    await expectAllFormats(dir, "revert conflict");
    gitRun(root, dir, ["revert", "--abort"]);
    git(dir, ["bisect", "start"]);
    git(dir, ["bisect", "bad"]);
    git(dir, ["bisect", "good", "HEAD~2"]);
    await expectAllFormats(dir, "bisect");
    git(dir, ["bisect", "reset"]);
    const patch = git(dir, ["format-patch", "-1", "--stdout", "side"]);
    putFile(dir, "p.mbox", patch);
    gitRun(root, dir, ["am", "p.mbox"]);
    await expectAllFormats(dir, "am conflict");
  }, 120_000);

  it("a sparse checkout", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["sparse-checkout", "set", "--no-cone", "/a.txt", "/c.txt"]);
    await expectAllFormats(dir, "sparse");
  }, 60_000);
});

describeGit("status -v / -vv with unmerged paths: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "status-vv-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** `status -v`, `status -vv` and `commit --dry-run -vv` agree with native git. */
  async function expectVerbose(dir: string, label: string) {
    for (const level of [1, 2]) {
      const flag = level === 1 ? "-v" : "-vv";
      const ours = await (await openRepo(root, dir)).status().callText({ verbose: level });
      expect(bytesOf(ours.text), `${label}: status ${flag}`).toBe(git(dir, ["status", flag]));
      const dry = await (await openRepo(root, dir)).commit().setVerbose(level).callDryRun();
      const native = gitRun(root, dir, ["commit", "--dry-run", flag]);
      expect(bytesOf(dry.text), `${label}: commit --dry-run ${flag}`).toBe(native.stdout);
      expect(dry.exitCode, `${label}: commit --dry-run ${flag} exit`).toBe(native.status);
    }
  }

  it("a merge conflict and an am -3 conflict, with and without other worktree changes", async () => {
    const dir = join(root, "r");
    base(dir);
    conflictBranches(dir);
    gitRun(root, dir, ["merge", "side"]);
    await expectVerbose(dir, "merge conflict");
    putFile(dir, "a.txt", "a changed\n");
    await expectVerbose(dir, "merge conflict, a.txt changed");
    git(dir, ["checkout", "--", "a.txt"]);
    git(dir, ["merge", "--abort"]);
    const patch = git(dir, ["format-patch", "-1", "--stdout", "side"]);
    putFile(dir, "../p.mbox", patch);
    gitRun(root, dir, ["am", "-3", "../p.mbox"]);
    await expectVerbose(dir, "am -3 conflict");
    putFile(dir, "a.txt", "a changed\n");
    await expectVerbose(dir, "am -3 conflict, a.txt changed");
  }, 120_000);
});

describeGit("status -v / -vv with submodules: the submodule ignore configuration", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "status-v-sub-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A repository with two submodules: `s1` moved and staged, `s2` moved, unstaged, dirty. */
  function withSubmodules(dir: string) {
    const up = join(root, "up");
    mkdirSync(up, { recursive: true });
    git(up, ["init", "-q", "-b", "main"]);
    putFile(up, "f.txt", "f\n");
    git(up, ["add", "f.txt"]);
    git(up, ["commit", "-qm", "f"]);
    base(dir);
    for (const name of ["s1", "s2"]) {
      git(dir, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", up, name]);
    }
    git(dir, ["commit", "-qm", "submodules"]);
    for (const name of ["s1", "s2"]) {
      putFile(join(dir, name), "f.txt", `${name} moved\n`);
      git(join(dir, name), ["commit", "-qam", "moved"]);
    }
    git(dir, ["add", "s1"]);
    putFile(join(dir, "s2"), "f.txt", "dirty\n");
    putFile(dir, "c.txt", "c changed\n");
  }

  async function expectVerbose(dir: string, label: string) {
    for (const level of [1, 2]) {
      const flag = level === 1 ? "-v" : "-vv";
      const ours = await (await openRepo(root, dir)).status().callText({ verbose: level });
      expect(bytesOf(ours.text), `${label}: status ${flag}`).toBe(git(dir, ["status", flag]));
    }
  }

  it("diff.ignoreSubmodules and submodule.<name>.ignore apply to the verbose diffs", async () => {
    const dir = join(root, "r");
    withSubmodules(dir);
    await expectVerbose(dir, "no ignore");
    for (const value of ["all", "dirty", "untracked", "none"]) {
      git(dir, ["config", "diff.ignoreSubmodules", value]);
      await expectVerbose(dir, `diff.ignoreSubmodules=${value}`);
      git(dir, ["config", "--unset", "diff.ignoreSubmodules"]);
      for (const name of ["s1", "s2"]) {
        git(dir, ["config", `submodule.${name}.ignore`, value]);
        await expectVerbose(dir, `submodule.${name}.ignore=${value}`);
        git(dir, ["config", "--unset", `submodule.${name}.ignore`]);
      }
    }
    // declared in .gitmodules only
    git(dir, ["config", "-f", ".gitmodules", "submodule.s1.ignore", "all"]);
    git(dir, ["config", "-f", ".gitmodules", "submodule.s2.ignore", "all"]);
    await expectVerbose(dir, ".gitmodules ignore=all");
  }, 120_000);
});
