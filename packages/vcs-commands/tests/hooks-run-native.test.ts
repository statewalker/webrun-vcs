/**
 * `git hook run` and `git hook list` (builtin/hook.c) against native git: the hook's
 * arguments after `--`, `--to-stdin`, the exit codes or'ed together, git's errors for a
 * missing hook (`--ignore-missing` silences it), an unknown name (2.5x; 2.43 runs any name)
 * and a `--to-stdin` file it cannot open; git 2.5x's configured hooks (`hook.<name>.*`)
 * before the hooks directory's script, and `git hook list` (2.5x only) with `-z` and
 * `--show-scope`. Each case runs native git in one copy of a repository and ours (with the
 * Node hook runner) in the other.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitApiError, type HookListCommand, type HookRunCommand } from "../src/index.js";
import {
  type HookTwin,
  hookExit,
  hookLog,
  hookTwins,
  installHooks,
  nativeIn,
  nativeIs25x,
  oursIn,
} from "./hooks-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;
const it25x = nativeIs25x ? it : it.skip;
const it243 = nativeIs25x ? it.skip : it;

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/**
 * A configured hook's command: logs its name and arguments to `$HOOK_LOG`, writes a line on
 * stdout and stderr, then exits with `code`.
 */
const logCommand = (name: string, code = 0) =>
  `f() { printf '== cfg-${name}' >> "$HOOK_LOG"; printf ' [%s]' "$@" >> "$HOOK_LOG"; echo >> "$HOOK_LOG"; echo cfg-${name} out; echo cfg-${name} err >&2; return ${code}; }; f`;

/** A repository with the logging pre-commit hook and an input file. */
function base(): string {
  const dir = join(root, "r");
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, "a.txt", "a\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  installHooks(join(dir, ".git/hooks"), ["pre-commit"]);
  writeFileSync(join(dir, "input.txt"), "line one\nline two\n");
  return dir;
}

/** git's stderr lines, the lines of the hooks and git's own (hints, warnings, errors). */
const stderrLines = (text: string) =>
  text
    .split("\n")
    .filter((l) => l !== "")
    .join("\n");

async function expectRun(
  dir: string,
  args: string[],
  setup: (c: HookRunCommand) => HookRunCommand,
  label: string,
  prepare?: (twin: HookTwin) => void,
): Promise<{ log: string; stderr: string }> {
  const [theirs, mine] = hookTwins(root, dir);
  prepare?.(theirs);
  prepare?.(mine);
  const native = nativeIn(theirs, root, ["hook", "run", ...args]);
  const result = await setup((await oursIn(mine)).hookRun()).call();
  expect(hookLog(mine), `${label}: log`).toBe(hookLog(theirs));
  expect(result.exitCode, `${label}: exit (${native.stderr})`).toBe(native.status);
  expect(stderrLines(result.output), `${label}: stderr`).toBe(stderrLines(native.stderr));
  expect(native.stdout, `${label}: stdout`).toBe("");
  return { log: hookLog(mine), stderr: result.output };
}

async function expectList(
  dir: string,
  args: string[],
  setup: (c: HookListCommand) => HookListCommand,
  label: string,
): Promise<string> {
  const [theirs, mine] = hookTwins(root, dir);
  const native = nativeIn(theirs, root, ["hook", "list", ...args]);
  const result = await setup((await oursIn(mine)).hookList()).call();
  expect(result.exitCode, `${label}: exit (${native.stderr})`).toBe(native.status);
  expect(result.stdout, `${label}: stdout`).toBe(native.stdout);
  expect(stderrLines(result.output), `${label}: stderr`).toBe(stderrLines(native.stderr));
  return result.stdout;
}

describeGit("git hook run: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-run-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("runs the hook with the arguments after --, its exit code git's", async () => {
    const dir = base();
    await expectRun(dir, ["pre-commit"], (c) => c.setHookName("pre-commit"), "plain");
    await expectRun(
      dir,
      ["pre-commit", "--", "a", "b c"],
      (c) => c.setHookName("pre-commit").setArgs(["a", "b c"]),
      "args",
    );
    await expectRun(
      dir,
      ["pre-commit"],
      (c) => c.setHookName("pre-commit"),
      "failing",
      (t) => hookExit(t, "pre-commit", 3),
    );
  });

  it("--to-stdin: the file on the hook's stdin; one it cannot open is fatal", async () => {
    const dir = base();
    await expectRun(
      dir,
      ["--to-stdin=input.txt", "pre-commit"],
      (c) => c.setHookName("pre-commit").setToStdin("input.txt"),
      "to-stdin",
    );
    await expectRun(
      dir,
      ["--to-stdin=missing.txt", "pre-commit"],
      (c) => c.setHookName("pre-commit").setToStdin("missing.txt"),
      "to-stdin missing",
    );
    // with no hook to run the file is never opened
    await expectRun(
      dir,
      ["--ignore-missing", "--to-stdin=missing.txt", "pre-push"],
      (c) => c.setHookName("pre-push").setIgnoreMissing(true).setToStdin("missing.txt"),
      "to-stdin unused",
    );
  });

  it("a missing hook: git's error and exit 1, none with --ignore-missing", async () => {
    const dir = base();
    await expectRun(dir, ["pre-push"], (c) => c.setHookName("pre-push"), "missing");
    await expectRun(
      dir,
      ["--ignore-missing", "pre-push"],
      (c) => c.setHookName("pre-push").setIgnoreMissing(true),
      "ignore-missing",
    );
    // a hook that is not executable: the hint, then the error
    installHooks(join(dir, ".git/hooks"), ["post-commit"], false);
    await expectRun(dir, ["post-commit"], (c) => c.setHookName("post-commit"), "not executable");
  });

  it25x("an unknown hook name: refused unless --allow-unknown-hook-name (2.5x)", async () => {
    const dir = base();
    await expectRun(dir, ["my-hook"], (c) => c.setHookName("my-hook"), "unknown");
    await expectRun(
      dir,
      ["--ignore-missing", "my-hook"],
      (c) => c.setHookName("my-hook").setIgnoreMissing(true),
      "unknown, ignore-missing",
    );
    installHooks(join(dir, ".git/hooks"), ["my-hook"]);
    await expectRun(
      dir,
      ["--allow-unknown-hook-name", "my-hook", "--", "x"],
      (c) => c.setHookName("my-hook").setAllowUnknownHookName(true).setArgs(["x"]),
      "allowed",
    );
  });

  it243("an unknown hook name: run as any other (2.43)", async () => {
    const dir = base();
    await expectRun(dir, ["my-hook"], (c) => c.setHookName("my-hook"), "unknown");
    installHooks(join(dir, ".git/hooks"), ["my-hook"]);
    await expectRun(
      dir,
      ["my-hook", "--", "x"],
      (c) => c.setHookName("my-hook").setArgs(["x"]),
      "unknown, present",
    );
  });

  it("configured hooks run before the script (2.5x), their exit codes or'ed", async () => {
    const dir = base();
    const set = (key: string, value: string) => git(dir, ["config", key, value]);
    set("hook.fmt.event", "pre-commit");
    set("hook.fmt.command", logCommand("fmt", 1));
    set("hook.lint.event", "pre-commit");
    set("hook.lint.command", logCommand("lint", 2));
    set("hook.off.event", "pre-commit");
    set("hook.off.command", logCommand("off"));
    set("hook.off.enabled", "false");
    const configured = await expectRun(
      dir,
      ["--to-stdin=input.txt", "pre-commit", "--", "q"],
      (c) => c.setHookName("pre-commit").setArgs(["q"]).setToStdin("input.txt"),
      "configured",
    );
    expect(configured.log).toContain("stdin:\nline one\nline two");
    if (nativeIs25x)
      expect(configured.log).toMatch(/cfg-fmt \[q\][\s\S]*cfg-lint[\s\S]*== pre-commit/);
    else expect(configured.log).not.toContain("cfg-");
    // only a disabled configured hook: nothing runs, and that is no "cannot find" error
    set("hook.off.event", "post-merge");
    await expectRun(dir, ["post-merge"], (c) => c.setHookName("post-merge"), "only disabled");
    // a broken configuration is fatal
    set("hook.bad.event", "post-merge");
    await expectRun(dir, ["post-merge"], (c) => c.setHookName("post-merge"), "no command");
  });
});

describeGit("git hook list: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-list-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it25x("the configured hooks, disabled ones marked, then the script (2.5x)", async () => {
    const dir = base();
    const set = (key: string, value: string) => git(dir, ["config", key, value]);
    set("hook.fmt.event", "pre-commit");
    set("hook.fmt.command", logCommand("fmt"));
    set("hook.off.event", "pre-commit");
    set("hook.off.command", logCommand("off"));
    set("hook.off.enabled", "false");
    set("hook.push.event", "pre-push");
    set("hook.push.command", logCommand("push"));
    await expectList(dir, ["pre-commit"], (c) => c.setHookName("pre-commit"), "list");
    const scoped = await expectList(
      dir,
      ["--show-scope", "pre-commit"],
      (c) => c.setHookName("pre-commit").setShowScope(true),
      "show-scope",
    );
    expect(scoped).toBe("local\tfmt\nlocal\tdisabled\toff\nhook from hookdir\n");
    await expectList(
      dir,
      ["-z", "pre-push"],
      (c) => c.setHookName("pre-push").setNullTerminated(true),
      "-z",
    );
    await expectList(dir, ["post-merge"], (c) => c.setHookName("post-merge"), "none");
    await expectList(dir, ["my-hook"], (c) => c.setHookName("my-hook"), "unknown");
    set("hook.pre-commit.enabled", "false");
    await expectList(dir, ["pre-commit"], (c) => c.setHookName("pre-commit"), "event disabled");
  });

  it243("2.43 has no git hook list", async () => {
    const dir = base();
    const [theirs, mine] = hookTwins(root, dir);
    const native = nativeIn(theirs, root, ["hook", "list", "pre-commit"]);
    expect(native.status).toBe(129);
    const error = await (await oursIn(mine))
      .hookList("pre-commit")
      .call()
      .catch((e) => e);
    expect(error).toBeInstanceOf(GitApiError);
    expect((error as GitApiError).exitCode).toBe(129);
    expect(native.stderr).toContain((error as GitApiError).message);
  });
});

describeGit("git hook run --to-stdin: a path above the repository", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-run-up-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads the host file a `..` path names, never the worktree's file of that name", async () => {
    const dir = base();
    writeFileSync(join(dir, "outside.txt"), "worktree copy\n");
    writeFileSync(join(root, "outside.txt"), "from above\n");
    const run = await expectRun(
      dir,
      ["--to-stdin=../outside.txt", "pre-commit"],
      (c) => c.setHookName("pre-commit").setToStdin("../outside.txt"),
      "above",
    );
    expect(run.log).toContain("from above");
    expect(run.log).not.toContain("worktree copy");
    writeFileSync(join(dir, "gone.txt"), "worktree copy\n");
    await expectRun(
      dir,
      ["--to-stdin=../../gone.txt", "pre-commit"],
      (c) => c.setHookName("pre-commit").setToStdin("../../gone.txt"),
      "above missing",
    );
  });
});

describeGit("git hook run: hook settings from included config files", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-run-inc-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("include.path=../inc (the worktree top) and ../../inc (above it) are read", async () => {
    const dir = base();
    // beside the worktree's files: a configured hook (2.5x)
    writeFileSync(
      join(dir, "inc"),
      `[hook "inc"]\n\tevent = pre-commit\n\tcommand = "${logCommand("inc").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\n`,
    );
    git(dir, ["config", "--add", "include.path", "../inc"]);
    const inc = await expectRun(dir, ["pre-commit"], (c) => c.setHookName("pre-commit"), "inc");
    if (nativeIs25x) expect(inc.log).toContain("cfg-inc");
    // above the worktree: a hooks directory without the hook (both versions)
    writeFileSync(join(root, "inc-up"), `[core]\n\thooksPath = ${join(root, "no-hooks")}\n`);
    git(dir, ["config", "--add", "include.path", "../../inc-up"]);
    const up = await expectRun(dir, ["pre-commit"], (c) => c.setHookName("pre-commit"), "inc-up");
    expect(up.log).not.toContain("== pre-commit");
  });
});
