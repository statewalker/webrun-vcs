/**
 * `git var GIT_DEFAULT_BRANCH` under git 3.0 (`breakingChanges`, `main` without
 * `init.defaultBranch`), against the git 3.0 oracle (`$GIT3`; skipped without it): t0007's
 * "get GIT_DEFAULT_BRANCH without configuration" and "get GIT_DEFAULT_BRANCH with
 * configuration" on a git built with `WITH_BREAKING_CHANGES`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openOurs } from "./merge-native-helpers.js";
import { git3Binary, nativeGit3Env } from "./native-git3.js";
import { type Outcome, outcomeOf } from "./plumbing-native-support.js";

const git3 = git3Binary();

describe.skipIf(!git3)("git var under git 3.0", () => {
  let root = "";
  let repo = "";
  const env = () => ({ ...nativeGit3Env(root), GIT_DEFAULT_REF_FORMAT: "files" });
  const run = (args: string[]): Outcome => {
    const r = spawnSync(git3 as string, args, { cwd: repo, env: env(), encoding: "latin1" });
    return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
  };
  const twin = async (variable: string) => {
    const n = run(["var", variable]);
    const environment = createNodeGitHostEnvironment({ env: env(), breakingChanges: true });
    const g = await openOurs(repo, environment);
    expect(outcomeOf(await g.var().setVariable(variable).call())).toEqual(n);
    return n;
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "git-var-git3-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    expect(run(["init", "-q"]).status).toBe(0);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t0007-git-var.sh: "get GIT_DEFAULT_BRANCH without configuration", "get GIT_DEFAULT_BRANCH with configuration"', async () => {
    expect((await twin("GIT_DEFAULT_BRANCH")).out).toBe("main\n");
    expect(run(["config", "init.defaultbranch", "foo"]).status).toBe(0);
    expect((await twin("GIT_DEFAULT_BRANCH")).out).toBe("foo\n");
  });
});
