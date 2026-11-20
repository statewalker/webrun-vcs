/**
 * The hooks of `git am` against native git (builtin/am.c): applypatch-msg told the message
 * file (`.git/rebase-apply/final-commit`, whose edited text is committed), pre-applypatch
 * before each commit and post-applypatch after it; a refusing applypatch-msg or
 * pre-applypatch stops the am (exit 1), `--no-verify` skips both. Each case runs native git
 * in one copy of a repository with logging hooks and ours (with the Node hook runner) in the
 * other, and compares the logs, stderr, exit status and HEAD.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AmCommand } from "../src/index.js";
import {
  type HookTwin,
  hookEdit,
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

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

/** A repository with two commits made into patches (`<root>/p.mbox`), reset to the base. */
function base(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, "a.txt", "a\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  for (const name of ["b", "c"]) {
    putFile(dir, `${name}.txt`, `${name}\n`);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", `add ${name}`]);
  }
  const mbox = join(root, "p.mbox");
  writeFileSync(mbox, gitOut(root, dir, ["format-patch", "--stdout", "HEAD~2"]), "latin1");
  git(dir, ["reset", "-q", "--hard", "HEAD~2"]);
  installHooks(join(dir, ".git/hooks"), ["applypatch-msg", "pre-applypatch", "post-applypatch"]);
  return mbox;
}

async function expectAm(
  dir: string,
  mbox: string,
  args: string[],
  setup: (c: AmCommand) => AmCommand,
  label: string,
  prepare?: (twin: HookTwin) => void,
): Promise<void> {
  const [theirs, mine] = hookTwins(root, dir);
  prepare?.(theirs);
  prepare?.(mine);
  const native = nativeIn(theirs, root, ["am", ...args, mbox]);
  const g = await oursIn(mine);
  const result = await setup(
    g.am().setLegacyMessages(!nativeIs25x).addMbox(readFileSync(mbox)),
  ).call();
  expect(hookLog(mine), `${label}: log`).toBe(hookLog(theirs));
  expect(result.exitCode, `${label}: exit`).toBe(native.status);
  expect(result.errors, `${label}: stderr`).toBe(native.stderr);
  expect(git(mine.dir, ["log", "--format=%H %B"]), `${label}: log`).toBe(
    git(theirs.dir, ["log", "--format=%H %B"]),
  );
}

describeGit("am hooks: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-am-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("applypatch-msg, pre-applypatch and post-applypatch per patch", async () => {
    const dir = join(root, "r");
    const mbox = base(dir);
    await expectAm(dir, mbox, [], (c) => c, "am");
  });

  it("applypatch-msg edits the message; --no-verify skips the two checks", async () => {
    const dir = join(root, "r");
    const mbox = base(dir);
    await expectAm(
      dir,
      mbox,
      [],
      (c) => c,
      "edited",
      (t) => hookEdit(t, "applypatch-msg", "\nReviewed-by: Hook <hook@example.com>\n"),
    );
    await expectAm(
      dir,
      mbox,
      ["--no-verify"],
      (c) => c.setNoVerify(true),
      "--no-verify",
      (t) => hookExit(t, "applypatch-msg", 1),
    );
  });

  it("a refusing applypatch-msg or pre-applypatch stops the am", async () => {
    const dir = join(root, "r");
    const mbox = base(dir);
    await expectAm(
      dir,
      mbox,
      [],
      (c) => c,
      "applypatch-msg exit 1",
      (t) => hookExit(t, "applypatch-msg", 1),
    );
    await expectAm(
      dir,
      mbox,
      [],
      (c) => c,
      "pre-applypatch exit 1",
      (t) => hookExit(t, "pre-applypatch", 1),
    );
  });
});
