/**
 * Signed picks and reverts (statewalker/statewalker-root#319) against native git: git's
 * t3514-cherry-pick-revert-gpg.sh, each test run in two formats (ssh: the commits equal
 * native git's byte for byte; openpgp: equal but for the signature, which both verifies
 * check).
 *
 * `test_gpg_sign` resets to `tip`, sets `commit.gpgsign` and runs `git <cmd> <args> <commit>`;
 * every commit made since `tip` is signed, or none is. A range (`..side`, `two..`) is given to
 * ours as the commits native `rev-list` lists for it, in the order git applies them (oldest
 * first for a pick, newest first for a revert). `--edit` makes the commits through
 * `git commit -S<key>` / `--no-gpg-sign` (run_git_commit), the rest through try_to_commit.
 */
import { afterAll, beforeAll, describe, it } from "vitest";

import { CherryPickStatus, RevertStatus } from "../src/index.js";
import {
  FORMATS,
  SigningFixture,
  signingTwinsReady,
  type TwinFormat,
} from "./signed-rewrites-native-support.js";

const describeGit = signingTwinsReady ? describe : describe.skip;

let fx: SigningFixture;

/** t3514's setup: one; side1, side2 on side; two, three, tip on main. */
function setup(dir: string): void {
  fx.testCommit(dir, "one");
  fx.gitOk(dir, "switch", "-q", "-c", "side");
  fx.testCommit(dir, "side1");
  fx.testCommit(dir, "side2");
  fx.gitOk(dir, "switch", "-q", "-");
  fx.testCommit(dir, "two");
  fx.testCommit(dir, "three");
  fx.testCommit(dir, "tip");
}

/** The commits git applies for `commit` (a range or one commit), in its order. */
function commitsOf(dir: string, cmd: string, commit: string): string[] {
  if (!commit.includes("..")) return [fx.gitOk(dir, "rev-parse", commit).trim()];
  const listed = fx.revList(dir, commit);
  return cmd === "cherry-pick" ? listed.reverse() : listed;
}

async function gpgSignTwins(
  format: TwinFormat,
  mustFail: boolean,
  conf: string,
  cmd: "cherry-pick" | "revert",
  commit: string,
  args: string[],
  title: string,
): Promise<void> {
  const dirs = fx.twins(format, setup);
  for (const dir of [dirs.native, dirs.ours]) {
    fx.gitOk(dir, "reset", "-q", "--hard", "tip");
    fx.gitOk(dir, "config", "commit.gpgsign", conf);
  }
  const native = fx.git(dirs.native, [cmd, ...args, commit]);
  if (native.status !== 0) throw new Error(`${title}: ${native.stderr}`);

  const g = await fx.ours(dirs.ours);
  const command = cmd === "revert" ? g.revert() : g.cherryPick();
  for (const arg of args) {
    if (arg === "--gpg-sign") command.setSign(true);
    else if (arg === "--no-gpg-sign") command.setSign(false);
    else if (arg === "--edit") command.setEdit(true);
    else if (arg === "--no-edit") command.setEdit(false);
    else throw new Error(`unexpected argument ${arg}`);
  }
  for (const id of commitsOf(dirs.ours, cmd, commit)) command.include(id);
  const result = await command.call();
  if (result.status !== CherryPickStatus.OK && result.status !== RevertStatus.OK) {
    throw new Error(`${title}: ${result.message}`);
  }
  await fx.expectSameCommits(format, dirs, !mustFail, ["tip.."], `${title} (${format})`);
}

describeGit("signed picks and reverts against native git (t3514-cherry-pick-revert-gpg)", () => {
  beforeAll(() => {
    fx = new SigningFixture("cherry-pick-revert-gpg-");
  }, 60_000);
  afterAll(() => fx?.dispose());

  /** test_gpg_sign's calls: [must fail, conf, cmd, commit, args] */
  const cases: [boolean, string, "cherry-pick" | "revert", string, string[]][] = [
    [true, "false", "cherry-pick", "side", []],
    [true, "false", "cherry-pick", "..side", []],
    [false, "true", "cherry-pick", "side", []],
    [false, "true", "cherry-pick", "..side", []],
    [true, "true", "cherry-pick", "side", ["--no-gpg-sign"]],
    [true, "true", "cherry-pick", "..side", ["--no-gpg-sign"]],
    [true, "true", "cherry-pick", "side", ["--gpg-sign", "--no-gpg-sign"]],
    [true, "true", "cherry-pick", "..side", ["--gpg-sign", "--no-gpg-sign"]],
    [false, "false", "cherry-pick", "side", ["--no-gpg-sign", "--gpg-sign"]],
    [false, "false", "cherry-pick", "..side", ["--no-gpg-sign", "--gpg-sign"]],
    [false, "true", "cherry-pick", "side", ["--edit"]],
    [false, "true", "cherry-pick", "..side", ["--edit"]],
    [true, "true", "cherry-pick", "side", ["--edit", "--no-gpg-sign"]],
    [true, "true", "cherry-pick", "..side", ["--edit", "--no-gpg-sign"]],
    [true, "true", "cherry-pick", "side", ["--edit", "--gpg-sign", "--no-gpg-sign"]],
    [true, "true", "cherry-pick", "..side", ["--edit", "--gpg-sign", "--no-gpg-sign"]],
    [false, "false", "cherry-pick", "side", ["--edit", "--no-gpg-sign", "--gpg-sign"]],
    [false, "false", "cherry-pick", "..side", ["--edit", "--no-gpg-sign", "--gpg-sign"]],

    [true, "false", "revert", "HEAD", ["--edit"]],
    [true, "false", "revert", "two..", ["--edit"]],
    [false, "true", "revert", "HEAD", ["--edit"]],
    [false, "true", "revert", "two..", ["--edit"]],
    [true, "true", "revert", "HEAD", ["--edit", "--no-gpg-sign"]],
    [true, "true", "revert", "two..", ["--edit", "--no-gpg-sign"]],
    [true, "true", "revert", "HEAD", ["--edit", "--gpg-sign", "--no-gpg-sign"]],
    [true, "true", "revert", "two..", ["--edit", "--gpg-sign", "--no-gpg-sign"]],
    [false, "false", "revert", "HEAD", ["--edit", "--no-gpg-sign", "--gpg-sign"]],
    [false, "false", "revert", "two..", ["--edit", "--no-gpg-sign", "--gpg-sign"]],
    [false, "true", "revert", "HEAD", ["--no-edit"]],
    [false, "true", "revert", "two..", ["--no-edit"]],
    [true, "true", "revert", "HEAD", ["--no-edit", "--no-gpg-sign"]],
    [true, "true", "revert", "two..", ["--no-edit", "--no-gpg-sign"]],
    [true, "true", "revert", "HEAD", ["--no-edit", "--gpg-sign", "--no-gpg-sign"]],
    [true, "true", "revert", "two..", ["--no-edit", "--gpg-sign", "--no-gpg-sign"]],
    [false, "false", "revert", "HEAD", ["--no-edit", "--no-gpg-sign", "--gpg-sign"]],
  ];
  for (const [mustFail, conf, cmd, commit, args] of cases) {
    // git's title: "$cmd $* $cmit with commit.gpgsign=$conf $will sign commit"
    const title = `${cmd} ${args.join(" ")} ${commit} with commit.gpgsign=${conf} ${mustFail ? "won't" : "will"} sign commit`;
    it(`t3514-cherry-pick-revert-gpg.sh: "${title}"`, async () => {
      for (const format of FORMATS) {
        await gpgSignTwins(format, mustFail, conf, cmd, commit, args, title);
      }
    }, 120_000);
  }
});
