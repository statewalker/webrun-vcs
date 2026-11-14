/**
 * Reflogs written by FileRefStore.set (through createGitFilesBackend) agree with native
 * git's core.logAllRefUpdates defaults: git creates the same reflogs for the same updates
 * in a non-bare and in a bare repository. Needs native git.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend } from "../../src/index.js";

/** A fixed identity, so git works on machines without user.name / user.email (CI). */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_NAME: "A U Thor",
  GIT_COMMITTER_EMAIL: "author@example.com",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
const reflogExists = (cwd: string, ref: string) =>
  spawnSync("git", ["reflog", "exists", ref], { cwd, env: GIT_ENV }).status === 0;

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A non-bare repository with one commit on main, and a bare clone of it. */
function newRepos() {
  const root = mkdtempSync(join(tmpdir(), "reflog-config-git-"));
  roots.push(root);
  const dir = join(root, "work");
  git(root, ["init", "-q", "-b", "main", "work"]);
  writeFileSync(join(dir, "f.txt"), "x\n");
  git(dir, ["add", "f.txt"]);
  git(dir, ["commit", "-q", "-m", "c0"]);
  git(root, ["clone", "-q", "--bare", "work", "bare.git"]);
  return { dir, bare: join(root, "bare.git"), c0: git(dir, ["rev-parse", "HEAD"]) };
}

describe("reflogs next to native git", () => {
  it("a non-bare repository: branches get a reflog, tags do not, as with git update-ref", async () => {
    const { dir, c0 } = newRepos();
    const { history } = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: dir }),
    });
    await history.refs.set("refs/heads/ours", c0);
    await history.refs.set("refs/tags/ours", c0);
    git(dir, ["update-ref", "refs/heads/theirs", c0]);
    git(dir, ["update-ref", "refs/tags/theirs", c0]);
    expect(reflogExists(dir, "refs/heads/ours")).toBe(reflogExists(dir, "refs/heads/theirs"));
    expect(reflogExists(dir, "refs/heads/ours")).toBe(true);
    expect(reflogExists(dir, "refs/tags/ours")).toBe(reflogExists(dir, "refs/tags/theirs"));
    expect(reflogExists(dir, "refs/tags/ours")).toBe(false);
    expect(git(dir, ["reflog", "show", "--format=%H", "refs/heads/ours"])).toBe(c0);
  });

  it("a bare repository: no reflog is created, as with git update-ref", async () => {
    const { bare, c0 } = newRepos();
    const { history } = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: bare }),
      gitDir: ".",
    });
    await history.refs.set("refs/heads/ours", c0);
    git(bare, ["update-ref", "refs/heads/theirs", c0]);
    expect(reflogExists(bare, "refs/heads/theirs")).toBe(false);
    expect(reflogExists(bare, "refs/heads/ours")).toBe(false);
  });
});
