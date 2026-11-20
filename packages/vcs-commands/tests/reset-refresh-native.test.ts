/**
 * The refresh after `git reset` against native git (builtin/reset.c, read-cache.c
 * `refresh_index`): a mixed reset, with paths or without, lists the files left with unstaged
 * changes under "Unstaged changes after reset:" (`M`, `D`, `A` for an intent-to-add entry),
 * `--quiet` lists none, `--no-refresh` leaves the stat data alone, and the refreshed index
 * leaves `git diff-files` agreeing with native git's. Each case runs native git in one copy
 * of a repository and ours in the other.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ResetCommand } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, openRepo, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root: string;
const git = (cwd: string, args: string[]) => gitOut(root, cwd, args);

function base(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  for (const name of ["a.txt", "b.txt", "c.txt", "d/e.txt"]) putFile(dir, name, `${name}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  putFile(dir, "a.txt", "a staged\n");
  unlinkSync(join(dir, "b.txt"));
  putFile(dir, "n.txt", "new\n");
  git(dir, ["add", "-A"]);
  putFile(dir, "a.txt", "a unstaged\n");
  putFile(dir, "d/e.txt", "e unstaged\n");
}

function twins(dir: string): [string, string] {
  const out: [string, string] = [`${dir}-native`, `${dir}-ours`];
  for (const copy of out) {
    rmSync(copy, { recursive: true, force: true });
    execFileSync("cp", ["-a", dir, copy]);
  }
  return out;
}

async function expectReset(
  dir: string,
  args: string[],
  setup: (c: ResetCommand) => void,
  label: string,
): Promise<string[]> {
  const [theirs, mine] = twins(dir);
  const native = gitRun(root, theirs, ["reset", ...args]);
  expect(native.status, `${label}: ${native.stderr}`).toBe(0);
  const command = (await openRepo(root, mine)).reset();
  setup(command);
  await command.call();
  const output = command.getOutput();
  expect(output.map((l) => `${l}\n`).join(""), `${label}: stdout`).toBe(native.stdout);
  // the stat data refreshed as git's: the same files differ for diff-files (which trusts it)
  expect(git(mine, ["diff-files", "--name-status"]), `${label}: diff-files`).toBe(
    git(theirs, ["diff-files", "--name-status"]),
  );
  expect(git(mine, ["status", "--porcelain"]), `${label}: status`).toBe(
    git(theirs, ["status", "--porcelain"]),
  );
  return output;
}

describeGit("reset: the index refresh, as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "reset-refresh-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a mixed reset lists the unstaged changes", async () => {
    const dir = join(root, "r");
    base(dir);
    const output = await expectReset(dir, [], () => {}, "mixed");
    expect(output[0]).toBe("Unstaged changes after reset:");
    await expectReset(dir, ["HEAD"], (c) => c.setRef("HEAD"), "mixed HEAD");
  });

  it("--quiet lists nothing; --no-refresh refreshes nothing", async () => {
    const dir = join(root, "r");
    base(dir);
    expect(await expectReset(dir, ["-q"], (c) => c.setQuiet(true), "-q")).toEqual([]);
    await expectReset(dir, ["--no-refresh"], (c) => c.setNoRefresh(true), "--no-refresh");
  });

  it("a reset of paths lists every unstaged change, and -N lists intent-to-add entries", async () => {
    const dir = join(root, "r");
    base(dir);
    await expectReset(dir, ["--", "a.txt"], (c) => c.addPath("a.txt"), "-- a.txt");
    await expectReset(dir, ["-N"], (c) => c.setIntentToAdd(true), "-N");
  });

  it("nothing left unstaged: no header", async () => {
    const dir = join(root, "r");
    base(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "all"]);
    expect(await expectReset(dir, ["HEAD~1"], (c) => c.setRef("HEAD~1"), "HEAD~1")).toEqual([
      "Unstaged changes after reset:",
      "M\ta.txt",
      "D\tb.txt",
      "M\td/e.txt",
    ]);
    await expectReset(dir, [], () => {}, "clean");
  });
});
