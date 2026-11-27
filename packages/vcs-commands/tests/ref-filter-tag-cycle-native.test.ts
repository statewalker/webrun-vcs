/**
 * `--points-at` over a tag cycle made through replace refs (statewalker/webrun-vcs#263):
 * annotated tag `cycle-a` of HEAD, annotated tag `cycle-b` of `cycle-a`, then
 * `git replace -f cycle-a cycle-b`, so reading `cycle-a` gives a tag naming `cycle-a` again.
 * Native git peels such a tag forever (`tag -l --points-at`, `for-each-ref --points-at`,
 * `branch --points-at` all hang, 2.43 and 2.5x alike); ours stops after the bound every ref
 * filter peel uses and counts the tag as not matching. So the native oracle here is git
 * given patterns that keep the cycle out of its walk (ref-filter matches names before
 * `--points-at`): ours without the patterns must print exactly that, and ours with them the
 * same as git with them.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let dir: string;

const env = (): Record<string, string> => ({
  ...nativeGitEnv(root),
  TZ: "UTC",
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_AUTHOR_DATE: "1112911993 -0700",
  GIT_COMMITTER_DATE: "1112911993 -0700",
});

function git(args: string[], timeout?: number) {
  const r = spawnSync("git", args, { cwd: dir, env: env(), timeout });
  return {
    status: r.status,
    signal: r.signal,
    stdout: (r.stdout as Buffer).toString("utf8"),
    stderr: (r.stderr as Buffer).toString("utf8"),
  };
}

function ok(args: string[]): string {
  const r = git(args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

async function openOurs(): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const environment = createNodeGitHostEnvironment({ env: env() });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

describeGit("ref filter over a tag cycle made through replace refs", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ref-filter-tag-cycle-"));
    dir = root;
    ok(["init", "-q", "-b", "main", "."]);
    ok(["commit", "-q", "--allow-empty", "-m", "first"]);
    ok(["branch", "side"]);
    ok(["tag", "v1"]);
    ok(["tag", "-m", "annotated", "v2"]);
    ok(["tag", "-m", "a", "cycle-a"]);
    ok(["tag", "-m", "b", "cycle-b", "cycle-a"]);
    ok(["replace", "-f", "cycle-a", "cycle-b"]);
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it("native git loops forever on the cycle", { timeout: 30_000 }, () => {
    const r = git(["tag", "-l", "--points-at=HEAD"], 3000);
    expect(r.signal).toBe("SIGTERM");
  });

  it("tag -l --points-at ends, the cycle not matching", { timeout: 60_000 }, async () => {
    const native = ok(["tag", "-l", "--points-at=HEAD", "v*"]);
    expect(native).toBe("v1\nv2\n");
    const ours = await openOurs();
    expect((await ours.tagList().setPointsAt("HEAD").callText()).output).toBe(native);
    expect((await ours.tagList().setPointsAt("HEAD").setPatterns("v*").callText()).output).toBe(
      native,
    );
  });

  it("for-each-ref --points-at ends, the cycle not matching", { timeout: 60_000 }, async () => {
    const native = ok(["for-each-ref", "--points-at=HEAD", "refs/heads", "refs/tags/v*"]);
    const ours = await openOurs();
    expect((await ours.forEachRef().setPointsAt("HEAD").call()).output).toBe(native);
    expect(
      (await ours.forEachRef().setPointsAt("HEAD").setPatterns("refs/heads", "refs/tags/v*").call())
        .output,
    ).toBe(native);
  });

  it("for-each-ref --contains with %(*objectname) ends", { timeout: 60_000 }, async () => {
    const format = "--format=%(refname) %(*objectname)";
    const native = ok(["for-each-ref", format, "--contains=HEAD", "refs/heads", "refs/tags/v*"]);
    const ours = await openOurs();
    const all = await ours
      .forEachRef()
      .setFormat("%(refname) %(*objectname)")
      .setContains("HEAD")
      .call();
    // the cycle's tags peel to no commit, so --contains leaves them out
    expect(all.output).toBe(native);
  });

  it("branch --points-at ends", { timeout: 60_000 }, async () => {
    const native = ok(["branch", "--points-at=HEAD"]);
    const ours = await openOurs();
    expect((await ours.branchList().setPointsAt("HEAD").callText()).output).toBe(native);
  });
});
