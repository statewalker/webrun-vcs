/**
 * Signed rebases (statewalker/statewalker-root#319) against native git: git's
 * t3435-rebase-gpg-sign.sh, each test run in two formats (ssh: the commits equal native
 * git's byte for byte; openpgp: equal but for the signature, which both verifies check).
 *
 * `test_rebase_gpg_sign` resets to `two` and runs `git rebase --force-rebase --root` with the
 * fake editor's `r 1 p 2` (a reword of the first commit for `-i`); `-S`/`--no-gpg-sign` (the
 * last one given wins) and `commit.gpgsign` decide whether both rewritten commits are signed.
 * The `rebase -r` tests recreate the merge (`git rebase -fr --root`) and sign it. git's
 * `-s resolve` is not ours: those runs use our default strategy, which merges these
 * histories to the same trees.
 */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";

import { RebaseStatus } from "../src/index.js";
import {
  FORMATS,
  SigningFixture,
  signingTwinsReady,
  type TwinFormat,
} from "./signed-rewrites-native-support.js";

const describeGit = signingTwinsReady ? describe : describe.skip;

let fx: SigningFixture;

/** t3435's setup and "setup: merge commit": one, two, fork-point, side's three, merged. */
function setup(dir: string): void {
  fx.testCommit(dir, "one");
  fx.testCommit(dir, "two");
  fx.testCommit(dir, "fork-point");
  fx.gitOk(dir, "switch", "-q", "-c", "side");
  fx.testCommit(dir, "three");
  fx.gitOk(dir, "switch", "-q", "main");
  fx.gitOk(dir, "merge", "-q", "--no-ff", "side");
  fx.gitOk(dir, "tag", "merged");
}

/** The sign request of the arguments as git parses them: the last of -S / --no-gpg-sign. */
function signOf(args: string[]): boolean | undefined {
  let sign: boolean | undefined;
  for (const arg of args) {
    if (arg === "--gpg-sign") sign = true;
    if (arg === "--no-gpg-sign") sign = false;
  }
  return sign;
}

/**
 * `git rebase <args>` in both twins (native with the fake editor rewording the first pick),
 * then the commits compared.
 */
async function rebaseTwins(
  format: TwinFormat,
  prepare: string[][],
  config: Record<string, string | undefined>,
  args: string[],
  ours: { interactive?: boolean; merges?: boolean },
  signed: boolean,
  label: string,
): Promise<void> {
  const dirs = fx.twins(format, setup);
  for (const dir of [dirs.native, dirs.ours]) {
    for (const step of prepare) fx.gitOk(dir, ...step);
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined) fx.git(dir, ["config", "--unset", key]);
      else fx.gitOk(dir, "config", key, value);
    }
  }
  const native = fx.git(dirs.native, ["rebase", ...args], {
    GIT_SEQUENCE_EDITOR: join(fx.root, "reword-first.sh"),
  });
  if (native.status !== 0) throw new Error(`${label}: ${native.stderr}`);

  const command = (await fx.ours(dirs.ours)).rebase().setRoot(true).setForceRebase(true);
  const sign = signOf(args);
  if (sign !== undefined) command.setSign(sign);
  if (ours.merges) command.setRebaseMerges(true);
  if (ours.interactive) {
    command.runInteractively({ editTodo: (text) => text.replace(/^pick/, "reword") });
  }
  const result = await command.call();
  if (result.status !== RebaseStatus.OK) throw new Error(`${label}: ${result.message}`);
  await fx.expectSameCommits(format, dirs, signed, ["HEAD"], `${label} (${format})`);
}

describeGit("signed rebases against native git (t3435-rebase-gpg-sign)", () => {
  beforeAll(() => {
    fx = new SigningFixture("rebase-gpg-sign-");
    // lib-rebase.sh's fake editor with FAKE_LINES='r 1 p 2': the first pick reworded
    const editor = join(fx.root, "reword-first.sh");
    writeFileSync(editor, "#!/bin/sh\nsed -i '1s/^pick/reword/' \"$1\"\n");
    chmodSync(editor, 0o755);
  }, 60_000);
  afterAll(() => fx?.dispose());

  /** test_rebase_gpg_sign's cases: [must fail, conf, args] */
  const cases: [boolean, string, string[]][] = [
    [true, "false", []],
    [false, "true", []],
    [true, "true", ["--no-gpg-sign"]],
    [true, "true", ["--gpg-sign", "--no-gpg-sign"]],
    [false, "false", ["--no-gpg-sign", "--gpg-sign"]],
    [false, "true", ["-i"]],
    [true, "true", ["-i", "--no-gpg-sign"]],
    [true, "true", ["-i", "--gpg-sign", "--no-gpg-sign"]],
    [false, "false", ["-i", "--no-gpg-sign", "--gpg-sign"]],
  ];
  for (const [mustFail, conf, args] of cases) {
    // git's title: "rebase $* with commit.gpgsign=$conf $will sign commit"
    const title = `rebase ${args.join(" ")} with commit.gpgsign=${conf} ${mustFail ? "won't" : "will"} sign commit`;
    it(`t3435-rebase-gpg-sign.sh: "${title}"`, async () => {
      for (const format of FORMATS) {
        await rebaseTwins(
          format,
          [["reset", "-q", "two"]],
          { "commit.gpgsign": conf },
          ["--force-rebase", "--root", ...args],
          { interactive: args.includes("-i") },
          !mustFail,
          title,
        );
      }
    }, 120_000);
  }

  /** The `rebase -r` tests: [title, conf (undefined: unset), args, signed] */
  const merges: [string, string | undefined, string[], boolean][] = [
    ["rebase -r, merge strategy, --gpg-sign will sign commit", undefined, ["--gpg-sign"], true],
    ["rebase -r, merge strategy, commit.gpgsign=true will sign commit", "true", [], true],
    [
      "rebase -r, merge strategy, commit.gpgsign=false --gpg-sign will sign commit",
      "false",
      ["--gpg-sign"],
      true,
    ],
    [
      "rebase -r, merge strategy, commit.gpgsign=true --no-gpg-sign won't sign commit",
      "true",
      ["--no-gpg-sign"],
      false,
    ],
    ["rebase -r --gpg-sign will sign commit", undefined, ["--gpg-sign"], true],
    ["rebase -r with commit.gpgsign=true will sign commit", "true", [], true],
    [
      "rebase -r --gpg-sign with commit.gpgsign=false will sign commit",
      "false",
      ["--gpg-sign"],
      true,
    ],
    [
      "rebase -r --no-gpg-sign with commit.gpgsign=true won't sign commit",
      "true",
      ["--no-gpg-sign"],
      false,
    ],
  ];
  for (const [title, conf, args, signed] of merges) {
    it(`t3435-rebase-gpg-sign.sh: "${title}"`, async () => {
      const strategy = title.includes("merge strategy") ? ["-s", "resolve"] : [];
      for (const format of FORMATS) {
        await rebaseTwins(
          format,
          [["reset", "-q", "--hard", "merged"]],
          { "commit.gpgsign": conf },
          ["-fr", ...args, ...strategy, "--root"],
          { merges: true },
          signed,
          title,
        );
      }
    }, 120_000);
  }
});
