/**
 * `stash drop` and `stash apply` (and so `pop`) of a stash that is not there, against native
 * git: "No stash entries found." without a stash named, "error: stash@{n} is not a valid
 * reference" for a named one when there is no stash, "fatal: log for 'stash' only has N
 * entries" beyond the stash log. git 2.43 exits 1 for the first two, 2.5x 128 (ours follows
 * 2.5x); the last is 128 on both. `stash clear` (`setAll`) without a stash is no failure.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, GitApiError } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, openRepo, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

const is25x = (() => {
  if (!nativeGitAvailable()) return false;
  const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return !!m && (Number(m[1]) > 2 || Number(m[2]) >= 50);
})();

let root: string;
let counter = 0;

/** A repository with `stashes` stashes, copied twice. */
function twins(stashes: number): [string, string] {
  const dirs: [string, string] = [join(root, `n${counter}`), join(root, `o${counter}`)];
  counter++;
  const [first] = dirs;
  mkdirSync(first, { recursive: true });
  gitOut(root, first, ["init", "-q", "-b", "main"]);
  putFile(first, "a.txt", "a\n");
  gitOut(root, first, ["add", "a.txt"]);
  gitOut(root, first, ["commit", "-qm", "base"]);
  for (let i = 0; i < stashes; i++) {
    putFile(first, "a.txt", `a${i}\n`);
    gitOut(root, first, ["stash", "-q"]);
  }
  execFileSync("cp", ["-a", first, dirs[1]]);
  return dirs;
}

async function failure(run: () => Promise<unknown>): Promise<GitApiError> {
  try {
    await run();
  } catch (e) {
    return e as GitApiError;
  }
  throw new Error("expected a failure");
}

interface Case {
  name: string;
  stashes: number;
  native: string[];
  ours: (git: Git) => Promise<unknown>;
  /** git 2.43's exit status where it differs from 2.5x's */
  status243?: number;
}

const CASES: Case[] = [
  {
    name: "drop: no stash",
    stashes: 0,
    native: ["stash", "drop"],
    ours: (g) => g.stashDrop().call(),
    status243: 1,
  },
  {
    name: "drop stash@{5}: no stash",
    stashes: 0,
    native: ["stash", "drop", "stash@{5}"],
    ours: (g) => g.stashDrop().setStashRef(5).call(),
    status243: 1,
  },
  {
    name: "drop stash@{5}: two stashes",
    stashes: 2,
    native: ["stash", "drop", "stash@{5}"],
    ours: (g) => g.stashDrop().setStashRef(5).call(),
  },
  {
    name: "apply: no stash",
    stashes: 0,
    native: ["stash", "apply"],
    ours: (g) => g.stashApply().call(),
    status243: 1,
  },
  {
    name: "apply stash@{5}: no stash",
    stashes: 0,
    native: ["stash", "apply", "stash@{5}"],
    ours: (g) => g.stashApply().setStashRef("stash@{5}").call(),
    status243: 1,
  },
  {
    name: "apply stash@{5}: two stashes",
    stashes: 2,
    native: ["stash", "apply", "stash@{5}"],
    ours: (g) => g.stashApply().setStashRef("stash@{5}").call(),
  },
  {
    name: "apply 5: two stashes (refs/stash@{5})",
    stashes: 2,
    native: ["stash", "apply", "5"],
    ours: (g) => g.stashApply().setStashRef("5").call(),
  },
  {
    name: "apply nope: not a revision",
    stashes: 1,
    native: ["stash", "apply", "nope"],
    ours: (g) => g.stashApply().setStashRef("nope").call(),
    status243: 1,
  },
];

describeGit("stash drop / apply of a missing stash: as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "stash-missing-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  for (const c of CASES) {
    it(c.name, async () => {
      const [theirs, mine] = twins(c.stashes);
      const native = gitRun(root, theirs, c.native);
      const error = await failure(async () => c.ours(await openRepo(root, mine)));
      expect(error.message).toBe(native.stderr.trim());
      if (is25x || c.status243 === undefined) expect(error.exitCode).toBe(native.status);
      else expect(native.status).toBe(c.status243);
      expect(error.exitCode).toBe(128);
      // nothing changed: the stash list is native git's
      expect(gitOut(root, mine, ["stash", "list"])).toBe(gitOut(root, theirs, ["stash", "list"]));
    });
  }

  it("clear without a stash is no failure", async () => {
    const [theirs, mine] = twins(0);
    expect(gitRun(root, theirs, ["stash", "clear"]).status).toBe(0);
    expect(await (await openRepo(root, mine)).stashDrop().setAll(true).call()).toBeUndefined();
  });
});
