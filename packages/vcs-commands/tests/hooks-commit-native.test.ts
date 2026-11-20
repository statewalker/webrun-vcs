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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
