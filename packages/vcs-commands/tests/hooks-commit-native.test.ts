/**
 * The commit hooks against native git (builtin/commit.c `prepare_to_commit`, `run_commit_hook`,
 * hook.c `find_hook`): pre-commit, prepare-commit-msg, commit-msg, post-commit and
 * post-rewrite run in git's order with git's arguments, variables and stdin; a refusing
 * pre-commit or commit-msg aborts the commit; `--no-verify` skips both; a message commit-msg
 * edits is the one recorded; a hook that is not executable gets the `advice.ignoredHook` hint;
 * `core.hooksPath` is where hooks are found. Each case runs native git in one copy of a
 * repository with logging hooks and ours (with the Node hook runner) in the other, and
 * compares the logs, the hooks' output, HEAD and the abort.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OperationState } from "../src/commands/merge-support.js";
import { type CommitCommand, HookFailedError } from "../src/index.js";
import {
  type HookTwin,
  hookEdit,
  hookExit,
  hookLines,
  hookLog,
  hookTwins,
  installHooks,
  nativeIn,
  oursIn,
} from "./hooks-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const COMMIT_HOOKS = [
  "pre-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "post-rewrite",
];

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

function base(dir: string, hooks = COMMIT_HOOKS): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, "a.txt", "a\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  installHooks(join(dir, ".git/hooks"), hooks);
  putFile(dir, "a.txt", "a2\n");
  git(dir, ["add", "a.txt"]);
}

/**
 * Native `git commit <args>` in one twin and ours (`setup`) in the other: both succeed or
 * fail, with the same hook logs, hook output and HEAD.
 */
async function expectCommit(
  dir: string,
  args: string[],
  setup: (c: CommitCommand) => void,
  label: string,
  prepare?: (twin: HookTwin) => void,
): Promise<{ error: Error | undefined; output: string }> {
  const [theirs, mine] = hookTwins(root, dir);
  prepare?.(theirs);
  prepare?.(mine);
  const native = nativeIn(theirs, root, ["commit", ...args]);
  const command = (await oursIn(mine)).commit();
  setup(command);
  let error: Error | undefined;
  try {
    await command.call();
  } catch (e) {
    error = e as Error;
  }
  expect(error === undefined, `${label}: ${String(error)} / ${native.stderr}`).toBe(
    native.status === 0,
  );
  if (!error) expect(native.status).toBe(0);
  else expect(error).toBeInstanceOf(HookFailedError);
  expect(hookLog(mine), `${label}: log`).toBe(hookLog(theirs));
  const output = error instanceof HookFailedError ? error.output : command.getHookOutput();
  expect(hookLines(output), `${label}: output`).toBe(hookLines(native.stderr));
  expect(git(mine.dir, ["rev-parse", "HEAD"]), `${label}: HEAD`).toBe(
    git(theirs.dir, ["rev-parse", "HEAD"]),
  );
  expect(git(mine.dir, ["log", "-1", "--format=%B"]), `${label}: message`).toBe(
    git(theirs.dir, ["log", "-1", "--format=%B"]),
  );
  return { error, output };
}

describeGit("commit hooks: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-commit-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("-m: pre-commit, prepare-commit-msg, commit-msg and post-commit in order", async () => {
    const dir = join(root, "r");
    base(dir);
    const { output } = await expectCommit(dir, ["-m", "two"], (c) => c.setMessage("two"), "-m");
    expect(output).toContain("hook post-commit err");
  });

  it("--no-verify skips pre-commit and commit-msg", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectCommit(
      dir,
      ["--no-verify", "-m", "two"],
      (c) => c.setMessage("two").setNoVerify(true),
      "--no-verify",
    );
  });

  it("a failing pre-commit aborts the commit; with --no-verify it does not run", async () => {
    const dir = join(root, "r");
    base(dir);
    const { error } = await expectCommit(
      dir,
      ["-m", "two"],
      (c) => c.setMessage("two"),
      "pre-commit exit 1",
      (t) => hookExit(t, "pre-commit", 1),
    );
    expect((error as HookFailedError).hook).toBe("pre-commit");
    await expectCommit(
      dir,
      ["-n", "-m", "two"],
      (c) => c.setMessage("two").setNoVerify(true),
      "pre-commit exit 1, --no-verify",
      (t) => hookExit(t, "pre-commit", 1),
    );
  });

  it("a failing commit-msg aborts the commit after prepare-commit-msg", async () => {
    const dir = join(root, "r");
    base(dir);
    const { error } = await expectCommit(
      dir,
      ["-m", "two"],
      (c) => c.setMessage("two"),
      "commit-msg exit 3",
      (t) => hookExit(t, "commit-msg", 3),
    );
    expect((error as HookFailedError).hookExitCode).toBe(3);
  });

  it("commit-msg and prepare-commit-msg edit the message: the edited text is committed", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectCommit(
      dir,
      ["-m", "two"],
      (c) => c.setMessage("two"),
      "edited message",
      (t) => {
        hookEdit(t, "prepare-commit-msg", "\nprepared line\n");
        hookEdit(t, "commit-msg", "\nSigned-off-by: Hook <hook@example.com>\n");
      },
    );
  });

  it("--amend: prepare-commit-msg is told `commit HEAD`, post-rewrite gets `amend` and the ids", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectCommit(dir, ["--amend", "--no-edit"], (c) => c.setAmend(true), "--amend");
    await expectCommit(
      dir,
      ["--amend", "-m", "amended"],
      (c) => c.setAmend(true).setMessage("amended"),
      "--amend -m",
    );
    await expectCommit(
      dir,
      ["--amend", "--no-post-rewrite", "-m", "amended"],
      (c) => c.setAmend(true).setMessage("amended").setNoPostRewrite(true),
      "--amend --no-post-rewrite",
    );
  });

  // t7505-prepare-commit-msg-hook "with -C", t7513 "commit --trailer" with hooks
  it("-C, -s and --trailer: prepare-commit-msg is told `commit <rev>` and sees the trailers", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectCommit(
      dir,
      ["-C", "HEAD", "-s", "--trailer", "Cc: C <c@example.com>"],
      (c) => c.setReuseMessage("HEAD").setSignoff(true).addTrailer("Cc: C <c@example.com>"),
      "-C HEAD -s --trailer",
      (t) => hookEdit(t, "prepare-commit-msg", "\nprepared line\n"),
    );
    await expectCommit(
      dir,
      ["--amend", "--reset-author", "-C", "HEAD", "--no-post-rewrite"],
      (c) => c.setAmend(true).setResetAuthor(true).setReuseMessage("HEAD").setNoPostRewrite(true),
      "--amend --reset-author -C HEAD --no-post-rewrite",
    );
  });

  it("-a: the hooks see the index lock", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["commit", "-qm", "staged", "--no-verify"]);
    putFile(dir, "a.txt", "a3\n");
    await expectCommit(dir, ["-a", "-m", "all"], (c) => c.setAll(true).setMessage("all"), "-a");
  });

  it("a hook that is not executable is skipped with the advice.ignoredHook hint", async () => {
    const dir = join(root, "r");
    base(dir, ["post-commit"]);
    installHooks(join(dir, ".git/hooks"), ["pre-commit", "commit-msg"], false);
    await expectCommit(dir, ["-m", "two"], (c) => c.setMessage("two"), "not executable");
    git(dir, ["config", "advice.ignoredHook", "false"]);
    const { output } = await expectCommit(
      dir,
      ["-m", "two"],
      (c) => c.setMessage("two"),
      "not executable, no advice",
    );
    expect(output).not.toContain("hint:");
  });

  it("core.hooksPath: relative to the worktree top, and absolute", async () => {
    const dir = join(root, "r");
    base(dir, []);
    installHooks(join(dir, "my-hooks"), COMMIT_HOOKS);
    git(dir, ["config", "core.hooksPath", "my-hooks"]);
    await expectCommit(dir, ["-m", "two"], (c) => c.setMessage("two"), "relative hooksPath");
    const absolute = join(root, "abs-hooks");
    installHooks(absolute, ["pre-commit", "post-commit"]);
    git(dir, ["config", "core.hooksPath", absolute]);
    await expectCommit(dir, ["-m", "two"], (c) => c.setMessage("two"), "absolute hooksPath");
  });
});

/**
 * A pre-commit that stages a file it generates, and hooks after it that list the index they
 * are given and the index files of the git directory (git's partial-commit index named
 * `next-index-N.lock`, its process id evened out).
 */
const STAGING_PRE_COMMIT = `#!/bin/sh
echo "== pre-commit GIT_INDEX_FILE=$GIT_INDEX_FILE" >> "$HOOK_LOG"
ls .git | grep index >> "$HOOK_LOG"
echo gen > gen.txt
git add gen.txt
`;
const LISTING_HOOK = `#!/bin/sh
echo "== $(basename "$0") GIT_INDEX_FILE=$GIT_INDEX_FILE" >> "$HOOK_LOG"
git ls-files -s >> "$HOOK_LOG"
ls .git | grep index >> "$HOOK_LOG"
`;

function installStagingHooks(dir: string): void {
  const hooks = join(dir, ".git/hooks");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, "pre-commit"), STAGING_PRE_COMMIT, { mode: 0o755 });
  for (const name of ["commit-msg", "post-commit"]) {
    writeFileSync(join(hooks, name), LISTING_HOOK, { mode: 0o755 });
  }
}

/**
 * Native `git commit <args>` and ours over twins with the staging hooks: the same log, the
 * same commit (tree and id), the same index entries and status afterwards, no false index
 * left behind.
 */
async function expectStagingCommit(
  dir: string,
  args: string[],
  setup: (c: CommitCommand) => void,
  label: string,
): Promise<void> {
  const [theirs, mine] = hookTwins(root, dir);
  const native = nativeIn(theirs, root, ["commit", ...args]);
  expect(native.status, `${label}: ${native.stderr}`).toBe(0);
  const command = (await oursIn(mine)).commit();
  setup(command);
  await command.call();
  const log = (t: HookTwin) => hookLog(t).replace(/next-index-\d+/g, "next-index-N");
  expect(log(mine), `${label}: log`).toBe(log(theirs));
  for (const args of [
    ["rev-parse", "HEAD", "HEAD^{tree}"],
    ["ls-files", "-s"],
    ["status", "--porcelain"],
  ]) {
    expect(git(mine.dir, args), `${label}: ${args.join(" ")}`).toBe(git(theirs.dir, args));
  }
  const leftovers = (t: HookTwin) =>
    readdirSync(join(t.dir, ".git")).filter((n) => /index/.test(n));
  expect(leftovers(mine), `${label}: index files`).toEqual(leftovers(theirs));
}

describeGit("commit hooks: what pre-commit stages (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-commit-stage-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function stagingBase(dir: string): void {
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    putFile(dir, "a.txt", "a\n");
    putFile(dir, "b.txt", "b\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "base"]);
    installStagingHooks(dir);
    putFile(dir, "a.txt", "a2\n");
    putFile(dir, "b.txt", "b2\n");
  }

  it("commit -a: the file pre-commit adds to the index lock is committed", async () => {
    const dir = join(root, "r");
    stagingBase(dir);
    await expectStagingCommit(dir, ["-a", "-m", "x"], (c) => c.setAll(true).setMessage("x"), "-a");
  });

  it("commit --only: the hooks see the false index (HEAD and the paths), re-read after pre-commit", async () => {
    const dir = join(root, "r");
    stagingBase(dir);
    await expectStagingCommit(
      dir,
      ["-m", "x", "--only", "a.txt"],
      (c) => c.setMessage("x").setOnly("a.txt"),
      "--only",
    );
  });

  it("a plain commit: what pre-commit adds to the index is committed", async () => {
    const dir = join(root, "r");
    stagingBase(dir);
    git(dir, ["add", "a.txt"]);
    await expectStagingCommit(dir, ["-m", "x"], (c) => c.setMessage("x"), "plain");
  });
});

describeGit("commit hooks: symbolic links (as native git)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-commit-link-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a hook linked to a file that is not executable is ignored with the hint; one linked to an executable file runs", async () => {
    const dir = join(root, "r");
    base(dir, ["post-commit"]);
    // targets inside the repository (relative link), outside it (absolute) and a chain
    installHooks(join(dir, "targets"), ["plain"], false);
    installHooks(join(dir, "targets"), ["runs"], true);
    installHooks(join(root, "outside"), ["plain"], false);
    const hooks = join(dir, ".git/hooks");
    symlinkSync("../../targets/plain", join(hooks, "pre-commit"));
    symlinkSync(join(root, "outside/plain"), join(hooks, "commit-msg"));
    symlinkSync("pre-commit", join(hooks, "prepare-commit-msg"));
    await expectCommit(dir, ["-m", "two"], (c) => c.setMessage("two"), "links, not executable");
    for (const name of ["pre-commit", "commit-msg", "prepare-commit-msg"]) {
      rmSync(join(hooks, name));
    }
    symlinkSync("../../targets/runs", join(hooks, "pre-commit"));
    symlinkSync("pre-commit", join(hooks, "commit-msg"));
    await expectCommit(dir, ["-m", "two"], (c) => c.setMessage("two"), "links, executable");
  });
});

describeGit("commit hooks: nothing read for them without a runner", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-commit-norunner-"));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it("commit -m reads MERGE_MSG and SQUASH_MSG once each (not again for hook arguments)", async () => {
    const dir = join(root, "r");
    base(dir);
    const [, mine] = hookTwins(root, dir);
    const read = vi.spyOn(OperationState.prototype, "read");
    const g = await openOurs(mine.dir, createNodeGitHostEnvironment({ env: mine.env }));
    await g.commit().setMessage("two").call();
    const names = read.mock.calls.map(([name]) => name);
    expect(names.filter((n) => n === "MERGE_MSG")).toHaveLength(1);
    expect(names.filter((n) => n === "SQUASH_MSG")).toHaveLength(1);
    expect(hookLog(mine)).toBe("");
  });
});
