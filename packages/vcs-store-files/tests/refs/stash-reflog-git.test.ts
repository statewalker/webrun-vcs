/**
 * The stash next to native git: GitStashStore keeps refs/stash and its reflog as git
 * does, so `git stash list` / `git stash show` / `git stash drop` work on our stashes, we
 * list and drop native git's, and every write takes git's locks (refs/stash.lock, and
 * for a drop logs/refs/stash.lock): a lock git holds makes ours fail with nothing
 * changed, and native git fails while ours is held.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FilesApi } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import type { Staging, Worktree } from "@statewalker/vcs-working-tree";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend, GitStashStore } from "../../src/index.js";

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
const gitTry = (cwd: string, args: string[]) =>
  spawnSync("git", args, { cwd, env, encoding: "utf8" });

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A repository with two commits on main. */
function newRepo() {
  const dir = mkdtempSync(join(tmpdir(), "stash-reflog-git-"));
  roots.push(dir);
  git(dir, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(dir, "f.txt"), "one\n");
  git(dir, ["add", "f.txt"]);
  git(dir, ["commit", "-q", "-m", "c0"]);
  const tree0 = git(dir, ["rev-parse", "HEAD^{tree}"]);
  writeFileSync(join(dir, "f.txt"), "two\n");
  git(dir, ["commit", "-q", "-am", "c1"]);
  return { dir, head: git(dir, ["rev-parse", "HEAD"]), tree0 };
}

/** GitStashStore over our git-files backend; the index (and so the stash) is `tree`. */
async function stashOf(dir: string, head: string, tree: string, files?: FilesApi) {
  const { history } = await createGitFilesBackend({
    files: files ?? createNodeFilesApi({ rootDir: dir }),
    gitDir: ".git",
  });
  return new GitStashStore({
    history,
    staging: { writeTree: async () => tree, entries: async function* () {} } as unknown as Staging,
    worktree: {
      getEntry: async () => undefined,
      walk: async function* () {},
    } as unknown as Worktree,
    getHead: async () => head,
    getBranch: async () => "main",
    author: { name: "A U Thor", email: "author@example.com", tzOffset: "+0000" },
  });
}

async function listOf(stash: GitStashStore) {
  const out: { index: number; commitId: string; message: string }[] = [];
  for await (const e of stash.list()) {
    out.push({ index: e.index, commitId: e.commitId, message: e.message });
  }
  return out;
}

const nativeList = (dir: string) =>
  git(dir, ["stash", "list", "--format=%gd: %gs"]).split("\n").filter(Boolean);

describe("GitStashStore next to native git", () => {
  it("native git lists, shows and drops our stashes", async () => {
    const { dir, head, tree0 } = newRepo();
    const stash = await stashOf(dir, head, tree0);
    await stash.push("one");
    await stash.push({ message: "two" });
    await stash.push();
    const abbrev = head.slice(0, 7);
    expect(nativeList(dir)).toEqual([
      `stash@{0}: WIP on main: ${abbrev} c1`,
      "stash@{1}: On main: two",
      "stash@{2}: On main: one",
    ]);
    // the stash holds the index tree: f.txt as in c0, against HEAD (c1)
    expect(git(dir, ["stash", "show", "--name-status", "stash@{1}"])).toBe("M\tf.txt");
    expect(git(dir, ["stash", "show", "-p", "stash@{2}"])).toContain("-two\n+one");
    expect(git(dir, ["rev-parse", "stash@{1}^1"])).toBe(head);
    expect(git(dir, ["log", "-1", "--format=%s", "stash@{1}^2"])).toBe(
      `index on main: ${abbrev} c1`,
    );
    expect(gitTry(dir, ["fsck", "--strict", "--no-dangling"]).status).toBe(0);

    // our drop of stash@{1}: git sees the rest, chained (--rewrite)
    await stash.drop(1);
    expect(nativeList(dir)).toEqual([
      `stash@{0}: WIP on main: ${abbrev} c1`,
      "stash@{1}: On main: one",
    ]);
    const lines = readFileSync(join(dir, ".git/logs/refs/stash"), "utf8").trim().split("\n");
    expect(lines[0]?.slice(0, 40)).toBe("0".repeat(40));
    expect(lines[1]?.slice(0, 40)).toBe(lines[0]?.slice(41, 81));

    // native git drops ours, and we read what it left
    git(dir, ["stash", "drop", "-q", "stash@{0}"]);
    expect((await listOf(stash)).map((e) => e.message)).toEqual(["On main: one"]);
    // our last drop removes refs/stash and its log, as git stash drop does
    await stash.drop(0);
    expect(gitTry(dir, ["rev-parse", "--verify", "-q", "refs/stash"]).status).not.toBe(0);
    expect(existsSync(join(dir, ".git/logs/refs/stash"))).toBe(false);
    expect(nativeList(dir)).toEqual([]);
  });

  it("we list, apply-read and drop native git's stashes", async () => {
    const { dir, head, tree0 } = newRepo();
    for (const [content, args] of [
      ["n1\n", ["-m", "n1"]],
      ["n2\n", ["-m", "n2"]],
      ["n3\n", []],
    ] as const) {
      writeFileSync(join(dir, "f.txt"), content);
      git(dir, ["stash", "push", "-q", ...args]);
    }
    const ids = [0, 1, 2].map((n) => git(dir, ["rev-parse", `stash@{${n}}`]));
    const stash = await stashOf(dir, head, tree0);
    expect(await listOf(stash)).toEqual([
      { index: 0, commitId: ids[0], message: `WIP on main: ${head.slice(0, 7)} c1` },
      { index: 1, commitId: ids[1], message: "On main: n2" },
      { index: 2, commitId: ids[2], message: "On main: n1" },
    ]);
    await stash.drop(1);
    expect(nativeList(dir)).toEqual([
      `stash@{0}: WIP on main: ${head.slice(0, 7)} c1`,
      "stash@{1}: On main: n1",
    ]);
    expect(git(dir, ["rev-parse", "stash@{1}"])).toBe(ids[2]);
    // native git still applies what we kept
    git(dir, ["stash", "apply", "-q", "stash@{1}"]);
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("n1\n");
    git(dir, ["checkout", "-q", "--", "f.txt"]);
    // dropping stash@{0} moves refs/stash to the next entry (--updateref)
    await stash.drop(0);
    expect(git(dir, ["rev-parse", "refs/stash"])).toBe(ids[2]);
    expect(gitTry(dir, ["fsck", "--strict", "--no-dangling"]).status).toBe(0);
  });

  it("a refs/stash.lock native git holds makes our push and drop fail with nothing changed", async () => {
    const { dir, head, tree0 } = newRepo();
    const stash = await stashOf(dir, head, tree0);
    await stash.push("kept");
    const before = readFileSync(join(dir, ".git/logs/refs/stash"), "utf8");
    const lock = join(dir, ".git/refs/stash.lock");
    writeFileSync(lock, ""); // what git holds while it updates refs/stash

    await expect(stash.push("lost")).rejects.toMatchObject({
      code: "ELOCKED",
      message: expect.stringContaining("refs/stash.lock"),
    });
    await expect(stash.drop(0)).rejects.toMatchObject({ code: "ELOCKED" });
    await expect(stash.clear()).rejects.toMatchObject({ code: "ELOCKED" });
    expect(readFileSync(join(dir, ".git/logs/refs/stash"), "utf8")).toBe(before);
    expect(nativeList(dir)).toEqual(["stash@{0}: On main: kept"]);
    expect(existsSync(lock)).toBe(true); // git's lock, not ours to remove
    unlinkSync(lock);

    // the reflog's own lock (git reflog expire/delete holds it) stops a drop too
    const logLock = join(dir, ".git/logs/refs/stash.lock");
    writeFileSync(logLock, "");
    await expect(stash.drop(0)).rejects.toMatchObject({ code: "ELOCKED" });
    expect(nativeList(dir)).toEqual(["stash@{0}: On main: kept"]);
    expect(existsSync(join(dir, ".git/refs/stash.lock"))).toBe(false); // ours released
    unlinkSync(logLock);

    await stash.push("after");
    expect(nativeList(dir)).toEqual(["stash@{0}: On main: after", "stash@{1}: On main: kept"]);
  });

  it("native git cannot update refs/stash or drop a stash while our drop holds the locks", async () => {
    const { dir, head, tree0 } = newRepo();
    const base = createNodeFilesApi({ rootDir: dir });
    let release: () => void = () => {};
    const released = new Promise<void>((r) => {
      release = r;
    });
    let paused: () => void = () => {};
    const reached = new Promise<void>((r) => {
      paused = r;
    });
    let armed = false;
    // pause once, right before our drop renames logs/refs/stash.lock over the log
    const files = new Proxy(base, {
      get(target, prop) {
        if (prop === "move") {
          return async (source: string, dest: string) => {
            if (armed && source.endsWith("logs/refs/stash.lock")) {
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
    const stash = await stashOf(dir, head, tree0, files);
    await stash.push("one");
    await stash.push("two");
    armed = true;
    const drop = stash.drop(0);
    await reached;
    expect(existsSync(join(dir, ".git/refs/stash.lock"))).toBe(true);
    const upd = gitTry(dir, ["update-ref", "refs/stash", head]);
    expect(upd.status).not.toBe(0);
    expect(upd.stderr).toContain("refs/stash.lock");
    const nativeDrop = gitTry(dir, ["stash", "drop", "-q"]);
    expect(nativeDrop.status).not.toBe(0);
    release();
    await drop;
    expect(nativeList(dir)).toEqual(["stash@{0}: On main: one"]);
    expect(existsSync(join(dir, ".git/refs/stash.lock"))).toBe(false);
    expect(existsSync(join(dir, ".git/logs/refs/stash.lock"))).toBe(false);
  });
});
