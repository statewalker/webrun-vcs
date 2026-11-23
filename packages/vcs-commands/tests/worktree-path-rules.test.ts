/**
 * `worktreePathRules`: `core.protectHFS` defaults to on where the system is unknown (no
 * environment, a browser), as well as on macOS; only a known other system or an explicit
 * `core.protectHFS=false` turns it off, and a worktree that refuses more itself
 * (`capabilities.protects`) raises the rules again.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidWorktreePath } from "@statewalker/vcs-core";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import type { WorkingCopy, Worktree } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { worktreePathRules } from "../src/commands/worktree-path-rules.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() ? describe : describe.skip;
const HFS_DOTGIT = "‌.git/hooks/post-checkout";

let root = "";
let counter = 0;

async function workingCopyOf(
  config: Record<string, string>,
  systemName?: string,
): Promise<WorkingCopy> {
  const dir = join(root, `r${counter++}`);
  const env = nativeGitEnv(root);
  execFileSync("git", ["init", "-q", dir], { env });
  for (const [key, value] of Object.entries(config)) {
    execFileSync("git", ["config", key, value], { cwd: dir, env });
  }
  const environment =
    systemName === undefined ? undefined : { ...createNodeGitHostEnvironment({ env }), systemName };
  const git = await openOurs(dir, environment);
  return (git as unknown as { _workingCopy: WorkingCopy })._workingCopy;
}

describeGit("worktreePathRules", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "path-rules-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("refuses HFS+ spellings of .git where the system is unknown", async () => {
    const rules = worktreePathRules(await workingCopyOf({}));
    expect(rules.protectHFS).toBe(true);
    expect(isValidWorktreePath(HFS_DOTGIT, undefined, rules)).toBe(false);
    expect(worktreePathRules(undefined).protectHFS).toBe(true);
  });

  it("refuses them on macOS, accepts them on a known other system (git's default)", async () => {
    expect(worktreePathRules(await workingCopyOf({}, "Darwin")).protectHFS).toBe(true);
    const linux = worktreePathRules(await workingCopyOf({}, "Linux"));
    expect(isValidWorktreePath(HFS_DOTGIT, undefined, linux)).toBe(true);
  });

  it("follows core.protectHFS and core.protectNTFS when set", async () => {
    const off = worktreePathRules(
      await workingCopyOf({ "core.protectHFS": "false", "core.protectNTFS": "false" }),
    );
    expect(off).toMatchObject({ protectHFS: false, protectNTFS: false });
    const on = worktreePathRules(await workingCopyOf({ "core.protectHFS": "true" }, "Linux"));
    expect(on.protectHFS).toBe(true);
  });

  it("raises the rules to what the worktree itself refuses", async () => {
    const workingCopy = await workingCopyOf(
      { "core.protectHFS": "false", "core.protectNTFS": "false" },
      "Linux",
    );
    const guarded = {
      capabilities: { protects: { ntfs: true, hfs: true } },
    } as unknown as Worktree;
    expect(worktreePathRules(workingCopy, guarded)).toMatchObject({
      protectHFS: true,
      protectNTFS: true,
    });
    // the FileWorktree of a working copy reports both protections
    expect(worktreePathRules(workingCopy, workingCopy.worktree)).toMatchObject({
      protectHFS: true,
      protectNTFS: true,
    });
  });
});
