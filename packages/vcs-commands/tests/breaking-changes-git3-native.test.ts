/**
 * The git 3.0 switch and its oracle. `GitHostEnvironment.breakingChanges` is the host's
 * statement that it wants a git built with `WITH_BREAKING_CHANGES`; the oracle (`$GIT3`, see
 * `native-git3.ts`) is such a git. The behaviours the switch changes have their own twins
 * (`*-git3-native.test.ts`); this file checks the switch reaches the host environment and
 * that the oracle is what the twins assume.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { git3Binary, nativeGit3Env } from "./native-git3.js";

describe("GitHostEnvironment.breakingChanges", () => {
  it("is off unless the host asks for it, and has no environment variable", () => {
    expect(createNodeGitHostEnvironment({ env: {} }).breakingChanges).toBeUndefined();
    expect(
      createNodeGitHostEnvironment({ env: { GIT_BREAKING_CHANGES: "1" } }).breakingChanges,
    ).toBeUndefined();
    expect(createNodeGitHostEnvironment({ env: {}, breakingChanges: true }).breakingChanges).toBe(
      true,
    );
  });
});

const git3 = git3Binary();

describe.skipIf(!git3)("the git 3.0 oracle ($GIT3)", () => {
  let root = "";
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "git3-oracle-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("creates reftable repositories on main (objects still SHA-1)", () => {
    const run = (cwd: string, args: string[]) =>
      execFileSync(git3 as string, args, {
        cwd,
        env: nativeGit3Env(root),
        encoding: "utf8",
      }).trim();
    run(root, ["init", "-q", "repo"]);
    const repo = join(root, "repo");
    expect(run(repo, ["rev-parse", "--show-ref-format"])).toBe("reftable");
    expect(run(repo, ["symbolic-ref", "HEAD"])).toBe("refs/heads/main");
    expect(run(repo, ["rev-parse", "--show-object-format"])).toBe("sha1");
  });
});
