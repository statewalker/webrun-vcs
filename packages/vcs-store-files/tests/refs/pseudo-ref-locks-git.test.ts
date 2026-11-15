/**
 * HEAD at init and the pseudo refs (ORIG_HEAD, MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD)
 * are written and removed under `<name>.lock`, as git's update_ref / create_symref do:
 * a lock native git holds makes our write fail with nothing changed, and what we write
 * native git reads.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { createMemoryGitStaging } from "@statewalker/vcs-working-tree";
import { afterAll, describe, expect, it } from "vitest";
import {
  createFileRefStore,
  createGitFilesBackend,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitCherryPickStateStore,
  GitMergeStateStore,
  GitRevertStateStore,
} from "../../src/index.js";

/** A clean git environment: no user or system config, a fixed identity (CI has none). */
const env = {
  PATH: process.env.PATH ?? "",
  HOME: tmpdir(),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_NAME: "A U Thor",
  GIT_COMMITTER_EMAIL: "author@example.com",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "pseudo-ref-locks-git-"));
  roots.push(dir);
  return dir;
}

/** A repository with two commits on main. */
function newRepo() {
  const dir = tempDir();
  git(dir, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(dir, "f.txt"), "one\n");
  git(dir, ["add", "f.txt"]);
  git(dir, ["commit", "-q", "-m", "c0"]);
  const c0 = git(dir, ["rev-parse", "HEAD"]);
  writeFileSync(join(dir, "f.txt"), "two\n");
  git(dir, ["commit", "-q", "-am", "c1"]);
  return { dir, c0, c1: git(dir, ["rev-parse", "HEAD"]) };
}

const opts = { refLockTimeoutMs: 30 };

describe("pseudo refs and HEAD under git's lock files", () => {
  it("merge state: MERGE_HEAD and ORIG_HEAD are written under their locks; git reads them", async () => {
    const { dir, c0, c1 } = newRepo();
    const files = createNodeFilesApi({ rootDir: dir });
    const merge = new GitMergeStateStore(files, ".git");
    await merge.begin({
      mergeHead: c0,
      origHead: c1,
      message: "Merge c0",
      squash: false,
      noFastForward: false,
    });
    expect(git(dir, ["rev-parse", "MERGE_HEAD"])).toBe(c0);
    expect(git(dir, ["rev-parse", "ORIG_HEAD"])).toBe(c1);
    expect(existsSync(join(dir, ".git/MERGE_HEAD.lock"))).toBe(false);
    expect((await merge.read())?.mergeHead).toBe(c0);

    // native git holds MERGE_HEAD.lock: completing fails, MERGE_HEAD stays, but the other
    // state files (ORIG_HEAD, MERGE_MSG) are still removed
    writeFileSync(join(dir, ".git/MERGE_HEAD.lock"), "");
    await expect(merge.complete()).rejects.toMatchObject({ code: "ELOCKED" });
    expect(readFileSync(join(dir, ".git/MERGE_HEAD"), "utf8")).toBe(`${c0}\n`);
    expect(existsSync(join(dir, ".git/MERGE_MSG"))).toBe(false);
    expect(existsSync(join(dir, ".git/ORIG_HEAD"))).toBe(false);
    unlinkSync(join(dir, ".git/MERGE_HEAD.lock"));
    await merge.complete();
    expect(existsSync(join(dir, ".git/MERGE_HEAD"))).toBe(false);
    expect(existsSync(join(dir, ".git/ORIG_HEAD"))).toBe(false);
    expect(await merge.isInProgress()).toBe(false);
  });

  it("a held ORIG_HEAD.lock makes cherry-pick and revert begin fail, ORIG_HEAD unchanged", async () => {
    const { dir, c0, c1 } = newRepo();
    const files = createNodeFilesApi({ rootDir: dir });
    git(dir, ["update-ref", "ORIG_HEAD", c1]);
    writeFileSync(join(dir, ".git/ORIG_HEAD.lock"), "");
    // the timeout git uses for loose ref locks (core.filesRefLockTimeout, 100 ms)
    const started = Date.now();
    await expect(
      new GitCherryPickStateStore(files, ".git").begin({
        cherryPickHead: c0,
        origHead: c0,
        noCommit: false,
      }),
    ).rejects.toMatchObject({ code: "ELOCKED", message: expect.stringContaining("ORIG_HEAD") });
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    await expect(
      new GitRevertStateStore(files, ".git").begin({
        revertHead: c0,
        origHead: c0,
        noCommit: false,
      }),
    ).rejects.toMatchObject({ code: "ELOCKED" });
    expect(git(dir, ["rev-parse", "ORIG_HEAD"])).toBe(c1);
    // nothing is in progress after a failed begin
    expect(existsSync(join(dir, ".git/CHERRY_PICK_HEAD"))).toBe(false);
    expect(existsSync(join(dir, ".git/REVERT_HEAD"))).toBe(false);
    expect(await new GitCherryPickStateStore(files, ".git").isInProgress()).toBe(false);
    expect(await new GitRevertStateStore(files, ".git").isInProgress()).toBe(false);
    unlinkSync(join(dir, ".git/ORIG_HEAD.lock"));

    // a held CHERRY_PICK_HEAD.lock: begin fails and ORIG_HEAD gets its old value back
    writeFileSync(join(dir, ".git/CHERRY_PICK_HEAD.lock"), "");
    await expect(
      new GitCherryPickStateStore(files, ".git").begin({
        cherryPickHead: c0,
        origHead: c0,
        noCommit: false,
      }),
    ).rejects.toMatchObject({ code: "ELOCKED" });
    expect(git(dir, ["rev-parse", "ORIG_HEAD"])).toBe(c1);
    expect(existsSync(join(dir, ".git/CHERRY_PICK_HEAD"))).toBe(false);
    unlinkSync(join(dir, ".git/CHERRY_PICK_HEAD.lock"));

    const pick = new GitCherryPickStateStore(files, ".git");
    await pick.begin({ cherryPickHead: c0, origHead: c0, noCommit: false });
    expect(git(dir, ["rev-parse", "CHERRY_PICK_HEAD"])).toBe(c0);
    expect(git(dir, ["rev-parse", "ORIG_HEAD"])).toBe(c0);
    await pick.abort();
    expect(existsSync(join(dir, ".git/CHERRY_PICK_HEAD"))).toBe(false);
  });

  it("GitCheckout keeps MERGE_HEAD and CHERRY_PICK_HEAD in the ref store, under their locks", async () => {
    const { dir, c0, c1 } = newRepo();
    const files = createNodeFilesApi({ rootDir: dir });
    const refs = createFileRefStore(files, ".git", opts);
    const read = async (path: string) =>
      (await files.exists(path)) ? new Uint8Array(readFileSync(join(dir, path))) : undefined;
    const checkout = new GitCheckout({
      staging: createMemoryGitStaging(),
      refs,
      files: {
        read,
        stats: async (path: string) => {
          const s = await files.stats(path);
          return s ? { isDirectory: s.kind === "directory" } : undefined;
        },
        write: (path: string, content: Iterable<Uint8Array>) => files.write(path, content),
        remove: async (path: string) => {
          await files.remove(path);
        },
      } as GitCheckoutFilesApi,
      gitDir: ".git",
    });
    git(dir, ["update-ref", "ORIG_HEAD", c1]);
    await checkout.setMergeState({ mergeHead: c0, originalHead: c1 });
    expect(git(dir, ["rev-parse", "MERGE_HEAD"])).toBe(c0);
    expect(await checkout.getMergeState()).toMatchObject({ mergeHead: c0, originalHead: c1 });

    writeFileSync(join(dir, ".git/CHERRY_PICK_HEAD.lock"), "");
    await expect(
      checkout.setCherryPickState({ commits: [c0], currentIndex: 0, originalHead: c1 }),
    ).rejects.toMatchObject({ code: "ELOCKED" });
    expect(existsSync(join(dir, ".git/CHERRY_PICK_HEAD"))).toBe(false);
    unlinkSync(join(dir, ".git/CHERRY_PICK_HEAD.lock"));

    // native git's MERGE_HEAD is ours to read, too
    await checkout.setMergeState(null);
    expect(existsSync(join(dir, ".git/MERGE_HEAD"))).toBe(false);
    writeFileSync(join(dir, ".git/MERGE_HEAD"), `${c1}\n`);
    expect((await checkout.getMergeState())?.mergeHead).toBe(c1);
  });

  it("init writes HEAD under HEAD.lock: a held lock fails the create with HEAD untouched", async () => {
    const dir = tempDir();
    const files = createNodeFilesApi({ rootDir: dir });
    await files.mkdir(".git");
    writeFileSync(join(dir, ".git/HEAD.lock"), "");
    await expect(
      createGitFilesBackend({ files, gitDir: ".git", create: true, refLockTimeoutMs: 30 }),
    ).rejects.toMatchObject({ code: "ELOCKED" });
    expect(existsSync(join(dir, ".git/HEAD"))).toBe(false);
    unlinkSync(join(dir, ".git/HEAD.lock"));

    await createGitFilesBackend({ files, gitDir: ".git", create: true, defaultBranch: "trunk" });
    expect(readFileSync(join(dir, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/trunk\n");
    expect(git(dir, ["symbolic-ref", "HEAD"])).toBe("refs/heads/trunk");
  });
});
