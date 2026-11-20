/**
 * Hooks the configuration defines (git 2.5x hook.c: `hook.<name>.event` and
 * `hook.<name>.command`, run through the shell before the hooks directory's script, in the
 * order of their event lines; `hook.<name>.enabled=false` and `hook.<event>.enabled=false`
 * leave them out) against native git, for pre-commit and post-checkout. git 2.43 has no
 * configured hooks: it runs the script alone, and so do we following it.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
import {
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

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/**
 * A configured hook's command: logs its name, arguments and directory to `$HOOK_LOG`, then
 * fails with `code`. A function, so the arguments git appends (`"$@"`) reach it.
 */
const logCommand = (name: string, code = 0) =>
  `f() { printf '== cfg-${name}'; printf ' [%s]' "$@"; printf ' pwd=%s\\n' "$(pwd)"; echo cfg-${name} out; return ${code}; }; f >> "$HOOK_LOG"`;

/** A repository with the logging pre-commit and post-checkout scripts and configured hooks. */
function base(): string {
  const dir = join(root, "r");
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, "a.txt", "a\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  git(dir, ["branch", "other"]);
  installHooks(join(dir, ".git/hooks"), ["pre-commit", "post-checkout"]);
  const set = (key: string, value: string) => git(dir, ["config", key, value]);
  // two for pre-commit (lint after fmt: the order of their event lines), one disabled
  set("hook.fmt.event", "pre-commit");
  set("hook.fmt.command", logCommand("fmt"));
  set("hook.lint.command", logCommand("lint"));
  set("hook.lint.event", "pre-commit");
  set("hook.off.event", "pre-commit");
  set("hook.off.command", logCommand("off"));
  set("hook.off.enabled", "false");
  // one for post-checkout, on two events
  set("hook.notify.event", "post-checkout");
  git(dir, ["config", "--add", "hook.notify.event", "post-commit"]);
  set("hook.notify.command", logCommand("notify"));
  return dir;
}

async function expectTwins(
  dir: string,
  args: string[],
  run: (g: Git) => Promise<{ error?: unknown; output: string }>,
  label: string,
  prepare?: (twin: ReturnType<typeof hookTwins>[number]) => void,
): Promise<void> {
  const [theirs, mine] = hookTwins(root, dir);
  prepare?.(theirs);
  prepare?.(mine);
  putFile(theirs.dir, "a.txt", "changed\n");
  putFile(mine.dir, "a.txt", "changed\n");
  git(theirs.dir, ["add", "a.txt"]);
  git(mine.dir, ["add", "a.txt"]);
  const native = nativeIn(theirs, root, args);
  const ours = await run(await oursIn(mine));
  expect(hookLog(mine), `${label}: log`).toBe(hookLog(theirs));
  expect(ours.error !== undefined, `${label}: failed (${native.stderr})`).toBe(native.status !== 0);
  expect(hookLines(ours.output), `${label}: output`).toBe(hookLines(native.stderr));
  expect(git(mine.dir, ["for-each-ref"]), `${label}: refs`).toBe(git(theirs.dir, ["for-each-ref"]));
}

async function attempt(command: {
  call(): Promise<unknown>;
  getHookOutput(): string;
}): Promise<{ output: string; error?: unknown }> {
  try {
    await command.call();
    return { output: command.getHookOutput() };
  } catch (error) {
    return { output: command.getHookOutput(), error };
  }
}

describeGit("configured hooks (hook.<name>.command): as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-config-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("pre-commit: the configured ones in order, then the script; a disabled one left out", async () => {
    const dir = base();
    await expectTwins(
      dir,
      ["commit", "-qm", "two"],
      (g) => attempt(g.commit().setMessage("two")),
      "commit",
    );
  });

  it("pre-commit: one refusing (any of them) stops the commit, the rest still run", async () => {
    const dir = base();
    git(dir, ["config", "hook.fmt.command", logCommand("fmt", 3)]);
    await expectTwins(
      dir,
      ["commit", "-qm", "two"],
      (g) => attempt(g.commit().setMessage("two")),
      "refused",
    );
    await expectTwins(
      dir,
      ["commit", "-qm", "two"],
      (g) => attempt(g.commit().setMessage("two")),
      "script refuses",
      (t) => hookExit(t, "pre-commit", 1),
    );
  });

  it("the event disabled (hook.pre-commit.enabled=false): only the script runs", async () => {
    const dir = base();
    git(dir, ["config", "hook.pre-commit.enabled", "false"]);
    await expectTwins(
      dir,
      ["commit", "-qm", "two"],
      (g) => attempt(g.commit().setMessage("two")),
      "event disabled",
    );
  });

  it("post-checkout: the configured one and the script", async () => {
    const dir = base();
    const [theirs, mine] = hookTwins(root, dir);
    const native = nativeIn(theirs, root, ["checkout", "-q", "other"]);
    const command = (await oursIn(mine)).checkout().setName("other");
    await command.call();
    expect(native.status).toBe(0);
    expect(hookLog(mine)).toBe(hookLog(theirs));
    expect(hookLines(command.getHookOutput())).toBe(hookLines(native.stderr));
  });
});
