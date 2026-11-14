/**
 * packRefs on a real .git directory next to native git: git reads what it writes
 * (show-ref, fsck), our packRefs waits for a packed-refs.lock git holds, and git
 * sees the packed-refs.lock our packRefs holds. Needs native git.
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
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, { cwd, input, env: GIT_ENV, encoding: "utf8" }).trim();
const gitTry = (cwd: string, args: string[]) =>
  spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A repository with loose branches, a lightweight and an annotated tag, and one packed ref. */
function newRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "packed-refs-lock-git-"));
  roots.push(dir);
  git(dir, ["init", "-q", "-b", "main", "."]);
  writeFileSync(join(dir, "f.txt"), "x\n");
  git(dir, ["add", "f.txt"]);
  git(dir, ["commit", "-q", "-m", "c0"]);
  writeFileSync(join(dir, "f.txt"), "y\n");
  git(dir, ["commit", "-q", "-am", "c1"]);
  git(dir, ["branch", "old", "HEAD~1"]);
  git(dir, ["update-ref", "refs/heads/packed", "HEAD~1"]);
  git(dir, ["pack-refs", "--all"]);
  // loose refs from here on (main stays packed only)
  git(dir, ["branch", "topic/a"]);
  git(dir, ["tag", "light"]);
  git(dir, ["tag", "-a", "-m", "annotated", "v1", "HEAD~1"]);
  return dir;
}

function storeFor(dir: string, files: FilesApi = createNodeFilesApi({ rootDir: dir })) {
  return new FileRefStore(files, ".git", { packedLockTimeoutMs: 1000 });
}

describe("packRefs next to native git", () => {
  it("after our packRefs, git show-ref (with peeled tags) and git fsck agree", async () => {
    const dir = newRepo();
    const before = git(dir, ["show-ref", "-d"]);
    await storeFor(dir).packRefs([], { all: true });

    expect(git(dir, ["show-ref", "-d"])).toBe(before);
    expect(existsSync(join(dir, ".git/refs/heads/topic/a"))).toBe(false);
    expect(existsSync(join(dir, ".git/refs/tags/v1"))).toBe(false);
    expect(existsSync(join(dir, ".git/packed-refs.lock"))).toBe(false);
    const fsck = gitTry(dir, ["fsck", "--strict", "--no-dangling"]);
    expect(fsck.status, fsck.stderr).toBe(0);
    expect(fsck.stderr).toBe("");
    // git can rewrite what we wrote
    git(dir, ["update-ref", "-d", "refs/heads/old"]);
    git(dir, ["pack-refs", "--all"]);
    expect(git(dir, ["show-ref", "-d"])).toBe(
      before
        .split("\n")
        .filter((l) => !l.endsWith(" refs/heads/old"))
        .join("\n"),
    );
  });

  it("waits for a packed-refs.lock native git holds, then fails cleanly after the timeout", async () => {
    const dir = newRepo();
    const packedBefore = readFileSync(join(dir, ".git/packed-refs"), "utf8");
    const lock = join(dir, ".git/packed-refs.lock");
    writeFileSync(lock, "");
    const refs = new FileRefStore(createNodeFilesApi({ rootDir: dir }), ".git", {
      packedLockTimeoutMs: 150,
    });
    const started = Date.now();
    await expect(refs.packRefs([], { all: true })).rejects.toThrow(/packed-refs\.lock/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(readFileSync(join(dir, ".git/packed-refs"), "utf8")).toBe(packedBefore);
    expect(existsSync(join(dir, ".git/refs/heads/topic/a"))).toBe(true);
    expect(existsSync(lock)).toBe(true); // git's lock, not ours to remove

    // released within the timeout: ours proceeds
    setTimeout(() => unlinkSync(lock), 50);
    await storeFor(dir).packRefs([], { all: true });
    expect(existsSync(join(dir, ".git/refs/heads/topic/a"))).toBe(false);
    expect(gitTry(dir, ["fsck", "--strict", "--no-dangling"]).status).toBe(0);
  });

  it("native git sees the packed-refs.lock our packRefs holds", async () => {
    const dir = newRepo();
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
    // pause once, after packRefs has read packed-refs (that is, under its lock)
    const files = new Proxy(base, {
      get(target, prop) {
        if (prop === "read") {
          return async function* (path: string) {
            const chunks: Uint8Array[] = [];
            for await (const c of target.read(path)) chunks.push(c);
            if (armed && path.endsWith("packed-refs")) {
              armed = false;
              paused();
              await released;
            }
            yield* chunks;
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as FilesApi;
    const pack = storeFor(dir, files).packRefs([], { all: true });
    await reached;
    expect(existsSync(join(dir, ".git/packed-refs.lock"))).toBe(true);
    const del = gitTry(dir, [
      "-c",
      "core.packedRefsTimeout=0",
      "update-ref",
      "-d",
      "refs/heads/packed",
    ]);
    expect(del.status).not.toBe(0);
    expect(del.stderr).toContain("packed-refs.lock");
    release();
    await pack;
    expect(existsSync(join(dir, ".git/packed-refs.lock"))).toBe(false);
    git(dir, ["update-ref", "-d", "refs/heads/packed"]);
    expect(gitTry(dir, ["rev-parse", "--verify", "-q", "refs/heads/packed"]).status).not.toBe(0);
    expect(gitTry(dir, ["fsck", "--strict", "--no-dangling"]).status).toBe(0);
  });
});

describe("a delete keeps packed-refs.lock until its loose file is gone", () => {
  it("native git sees our packed-refs.lock between the packed-refs rename and the loose removal", async () => {
    const dir = newRepo();
    git(dir, ["update-ref", "refs/heads/packed", "HEAD"]); // loose over its packed copy
    const head = git(dir, ["rev-parse", "HEAD"]);
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
    // pause once, right after packed-refs is renamed into place
    const files = new Proxy(base, {
      get(target, prop) {
        if (prop === "move") {
          return async (source: string, dest: string) => {
            const r = await target.move(source, dest);
            if (armed && dest.endsWith("packed-refs")) {
              armed = false;
              paused();
              await released;
            }
            return r;
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as FilesApi;
    const del = storeFor(dir, files).batch([{ name: "refs/heads/packed", old: head, new: null }]);
    await reached;
    expect(existsSync(join(dir, ".git/packed-refs.lock"))).toBe(true);
    expect(readFileSync(join(dir, ".git/packed-refs"), "utf8")).not.toContain("refs/heads/packed");
    // the loose file still shadows nothing stale: git reads the ref's loose value
    expect(git(dir, ["rev-parse", "refs/heads/packed"])).toBe(head);
    const pack = gitTry(dir, ["-c", "core.packedRefsTimeout=0", "pack-refs", "--all"]);
    expect(pack.status).not.toBe(0);
    expect(pack.stderr).toContain("packed-refs.lock");
    release();
    expect(await del).toEqual({ ok: true, rejected: [] });
    expect(existsSync(join(dir, ".git/packed-refs.lock"))).toBe(false);
    expect(existsSync(join(dir, ".git/packed-refs.new"))).toBe(false);
    expect(gitTry(dir, ["rev-parse", "--verify", "-q", "refs/heads/packed"]).status).not.toBe(0);
    expect(gitTry(dir, ["fsck", "--strict", "--no-dangling"]).status).toBe(0);
  });
});
