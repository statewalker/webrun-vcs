/**
 * FileRefStore.set takes `<ref>.lock` next to native git: a lock git holds makes
 * our set wait and fail, and git refuses to update a ref while our set holds its
 * lock. Needs native git.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FilesApi } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { FileRefStore } from "../../src/refs/index.js";

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
const gitTry = (cwd: string, args: string[]) =>
  spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A repository with two commits on main; returns the directory and both ids. */
function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), "loose-ref-locks-git-"));
  roots.push(dir);
  git(dir, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(dir, "f.txt"), "x\n");
  git(dir, ["add", "f.txt"]);
  git(dir, ["commit", "-q", "-m", "c0"]);
  const c0 = git(dir, ["rev-parse", "HEAD"]);
  writeFileSync(join(dir, "f.txt"), "y\n");
  git(dir, ["commit", "-q", "-am", "c1"]);
  return { dir, c0, c1: git(dir, ["rev-parse", "HEAD"]) };
}

describe("set next to native git", () => {
  it("waits for a <ref>.lock native git holds, then fails with the ref unchanged", async () => {
    const { dir, c0, c1 } = newRepo();
    const lock = join(dir, ".git/refs/heads/main.lock");
    writeFileSync(lock, ""); // what git holds while it updates main
    const refs = new FileRefStore(createNodeFilesApi({ rootDir: dir }), ".git", {
      refLockTimeoutMs: 120,
    });
    const started = Date.now();
    await expect(refs.set("refs/heads/main", c0)).rejects.toMatchObject({ code: "ELOCKED" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(110);
    expect(git(dir, ["rev-parse", "refs/heads/main"])).toBe(c1);
    expect(existsSync(lock)).toBe(true); // git's lock, not ours to remove

    unlinkSync(lock);
    await refs.set("refs/heads/main", c0);
    expect(git(dir, ["rev-parse", "refs/heads/main"])).toBe(c0);
    expect(gitTry(dir, ["fsck", "--strict", "--no-dangling"]).status).toBe(0);
  });

  it("native git update-ref fails while our set holds <ref>.lock", async () => {
    const { dir, c0, c1 } = newRepo();
    const base = createNodeFilesApi({ rootDir: dir });
    let release: () => void = () => {};
    const released = new Promise<void>((r) => {
      release = r;
    });
    let paused: () => void = () => {};
    const reached = new Promise<void>((r) => {
      paused = r;
    });
    let armed = true;
    // pause once, right before set renames main.lock over main
    const files = new Proxy(base, {
      get(target, prop) {
        if (prop === "move") {
          return async (source: string, dest: string) => {
            if (armed && source.endsWith("main.lock")) {
              armed = false;
              paused();
              await released;
            }
            return target.move(source, dest);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as FilesApi;
    const lockPath = join(dir, ".git/refs/heads/main.lock");
    const set = new FileRefStore(files, ".git").set("refs/heads/main", c0);
    await reached;
    expect(readFileSync(lockPath, "utf8")).toBe(`${c0}\n`); // the new value, in the lock
    const upd = gitTry(dir, ["update-ref", "refs/heads/main", c1]);
    expect(upd.status).not.toBe(0);
    expect(upd.stderr).toContain("main.lock");
    expect(git(dir, ["rev-parse", "refs/heads/main"])).toBe(c1); // ours not committed yet
    release();
    await set;
    expect(existsSync(lockPath)).toBe(false);
    expect(git(dir, ["rev-parse", "refs/heads/main"])).toBe(c0);
    // the reflog line is in git's format, and git reads it
    expect(git(dir, ["reflog", "show", "--format=%H", "-1", "refs/heads/main"])).toBe(c0);
    expect(gitTry(dir, ["fsck", "--strict", "--no-dangling"]).status).toBe(0);
  });
});
