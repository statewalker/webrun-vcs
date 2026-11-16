/**
 * GcOrchestrator with FileGcStrategy against native git: repositories native git built with
 * each kind of reachability root (detached HEAD, a staged-only blob, unmerged index stages,
 * the index's cache-tree and resolve-undo, a commit only a reflog names after `reset --hard`,
 * stashes, a linked worktree with its own HEAD, index and reflog, ORIG_HEAD, MERGE_HEAD, a
 * shallow clone). After our gc with `--prune=now` (pruneExpireMs 0), `git fsck --full` and
 * `git rev-list --objects --all --reflog --indexed-objects` still succeed, nothing that listing
 * named before is gone, and we keep at least what native `git gc --prune=now` keeps (with
 * reflogs never expiring: we do not expire reflog entries). A corrupt reachable object makes
 * our gc abort with nothing pruned.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorruptObjectError, GcOrchestrator } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend, FileGcStrategy, gc } from "../src/index.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const home = mkdtempSync(join(tmpdir(), "gc-roots-home-"));
dirs.push(home);
/** As `nativeGitEnv` in vcs-commands tests: fixed identities and dates, no background gc. */
const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: home,
  LANG: "C",
  LC_ALL: "C",
  GIT_AUTHOR_NAME: "A U Thor",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
  ...(process.env.GIT_EXEC_PATH ? { GIT_EXEC_PATH: process.env.GIT_EXEC_PATH } : {}),
};
const git = (cwd: string, args: string[], input?: string) =>
  execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    input,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 1 << 30,
  }).toString();

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A repository with `n` commits on main, each editing f.txt and adding its own file. */
function repo(n = 3): string {
  const dir = tempDir("gc-roots-");
  git(dir, ["init", "-q", "--initial-branch=main", "."]);
  for (let i = 0; i < n; i++) commit(dir, `c${i}`);
  return dir;
}

function commit(dir: string, name: string) {
  writeFileSync(join(dir, "f.txt"), `${name}\n`);
  writeFileSync(join(dir, `${name}.txt`), `only in ${name}\n`);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", name]);
}

const hashObject = (dir: string, content: string) =>
  git(dir, ["hash-object", "-w", "--stdin"], content).trim();

/** Every object id stored, loose or packed. */
const stored = (dir: string) =>
  new Set(
    git(dir, ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"])
      .split("\n")
      .filter(Boolean),
  );

/** What native git considers reachable (refs, reflogs, the index and linked worktrees). */
const reachable = (dir: string) =>
  git(dir, ["rev-list", "--objects", "--all", "--reflog", "--indexed-objects"])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(0, 40));

/** What native `git gc --prune=now` keeps, on a copy (reflogs never expire, as in ours). */
function nativeGcKeeps(dir: string): Set<string> {
  const copy = tempDir("gc-roots-native-");
  cpSync(dir, copy, { recursive: true });
  git(copy, [
    "-c",
    "gc.reflogExpire=never",
    "-c",
    "gc.reflogExpireUnreachable=never",
    "gc",
    "--quiet",
    "--prune=now",
  ]);
  return stored(copy);
}

async function ourGc(dir: string, pruneExpireMs = 0) {
  const backend = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });
  return new GcOrchestrator(backend.history, new FileGcStrategy(backend)).run({ pruneExpireMs });
}

/**
 * Runs our gc on `dir` and checks it against native git (an orphan blob written first must go
 * in both); returns what each kept. With `sameAsNative`, we keep exactly what git keeps.
 */
async function check(dir: string, sameAsNative = true) {
  const orphan = hashObject(dir, "an unreachable blob\n");
  const before = reachable(dir);
  const native = nativeGcKeeps(dir);
  const result = await ourGc(dir);
  const ours = stored(dir);
  git(dir, ["fsck", "--full", "--no-progress"]);
  const after = reachable(dir);
  expect(new Set(after)).toEqual(new Set(before));
  for (const id of before) expect(ours.has(id), `reachable ${id} kept`).toBe(true);
  for (const id of native) expect(ours.has(id), `${id} native gc keeps is kept`).toBe(true);
  expect(ours.has(orphan)).toBe(false);
  expect(native.has(orphan)).toBe(false);
  if (sameAsNative) expect(ours).toEqual(native);
  return { ours, native, result };
}

/** Removes every reflog entry, so only the root under test holds an object. */
const expireReflogs = (dir: string) =>
  git(dir, ["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"]);

describe("GcOrchestrator keeps what native git keeps", () => {
  it("a commit only a detached HEAD names", async () => {
    const dir = repo();
    git(dir, ["checkout", "-q", "--detach"]);
    commit(dir, "detached");
    const id = git(dir, ["rev-parse", "HEAD"]).trim();
    expireReflogs(dir);
    const { ours, native } = await check(dir);
    expect(ours.has(id)).toBe(true);
    expect(native.has(id)).toBe(true);
  });

  it("a blob only the index names (staged, never committed)", async () => {
    const dir = repo();
    writeFileSync(join(dir, "staged.txt"), "staged only\n");
    git(dir, ["add", "staged.txt"]);
    const id = git(dir, ["rev-parse", ":staged.txt"]).trim();
    const { ours } = await check(dir);
    expect(ours.has(id)).toBe(true);
  });

  it("the blobs of unmerged index stages", async () => {
    const dir = repo();
    const stages = [1, 2, 3].map((s) => hashObject(dir, `stage ${s}\n`));
    git(
      dir,
      ["update-index", "--index-info"],
      `0 ${"0".repeat(40)}\tconflict.txt\n${stages
        .map((id, i) => `100644 ${id} ${i + 1}\tconflict.txt`)
        .join("\n")}\n`,
    );
    expect(git(dir, ["ls-files", "-u"])).toContain(stages[2]);
    const { ours } = await check(dir);
    for (const id of stages) expect(ours.has(id)).toBe(true);
  });

  it("a tree only the index's cache-tree names", async () => {
    const dir = repo();
    writeFileSync(join(dir, "new.txt"), "new\n");
    git(dir, ["add", "new.txt"]);
    // write-tree records the trees of the index in its cache-tree (TREE extension)
    const tree = git(dir, ["write-tree"]).trim();
    const { ours, native } = await check(dir);
    expect(native.has(tree)).toBe(true);
    expect(ours.has(tree)).toBe(true);
  });

  it("the blobs of a resolved conflict's resolve-undo", async () => {
    const dir = repo();
    const stages = [1, 2, 3].map((s) => hashObject(dir, `undo stage ${s}\n`));
    git(
      dir,
      ["update-index", "--index-info"],
      `${stages.map((id, i) => `100644 ${id} ${i + 1}\tresolved.txt`).join("\n")}\n`,
    );
    writeFileSync(join(dir, "resolved.txt"), "resolution\n");
    // resolving with add records the stages in the REUC extension
    git(dir, ["add", "resolved.txt"]);
    expect(git(dir, ["ls-files", "-u"])).toBe("");
    const { ours, native } = await check(dir);
    for (const id of stages) {
      expect(native.has(id)).toBe(true);
      expect(ours.has(id)).toBe(true);
    }
  });

  it("a commit only the reflogs name after reset --hard", async () => {
    const dir = repo();
    const id = git(dir, ["rev-parse", "HEAD"]).trim();
    git(dir, ["reset", "-q", "--hard", "HEAD~2"]);
    // ORIG_HEAD names it too: drop it, the reflogs alone must keep it
    rmSync(join(dir, ".git/ORIG_HEAD"), { force: true });
    const { ours, native } = await check(dir);
    expect(native.has(id)).toBe(true);
    expect(ours.has(id)).toBe(true);
  });

  it("stashes, the older one only in the stash reflog", async () => {
    const dir = repo();
    writeFileSync(join(dir, "f.txt"), "first stash\n");
    git(dir, ["stash", "-q"]);
    const first = git(dir, ["rev-parse", "stash@{0}"]).trim();
    writeFileSync(join(dir, "f.txt"), "second stash\n");
    git(dir, ["stash", "-q"]);
    expect(git(dir, ["rev-parse", "stash@{1}"]).trim()).toBe(first);
    const { ours } = await check(dir);
    expect(ours.has(first)).toBe(true);
  });

  it("a linked worktree's detached HEAD, index and reflog", async () => {
    const dir = repo();
    const wt = join(tempDir("gc-roots-wt-"), "wt");
    git(dir, ["worktree", "add", "-q", "--detach", wt]);
    commit(wt, "in-worktree");
    const wtHead = git(wt, ["rev-parse", "HEAD"]).trim();
    commit(wt, "in-worktree-2");
    git(wt, ["reset", "-q", "--hard", "HEAD~1"]);
    const wtReflogOnly = git(wt, ["rev-parse", "HEAD@{1}"]).trim();
    rmSync(join(dir, ".git/worktrees/wt/ORIG_HEAD"), { force: true });
    writeFileSync(join(wt, "wt-staged.txt"), "staged in the worktree\n");
    git(wt, ["add", "wt-staged.txt"]);
    const wtStaged = git(wt, ["rev-parse", ":wt-staged.txt"]).trim();
    const { ours } = await check(dir);
    for (const id of [wtHead, wtReflogOnly, wtStaged]) expect(ours.has(id)).toBe(true);
    git(wt, ["fsck", "--full", "--no-progress"]);
  });

  it("a commit only ORIG_HEAD names (git itself does not keep it)", async () => {
    const dir = repo();
    const id = git(dir, ["rev-parse", "HEAD"]).trim();
    git(dir, ["reset", "-q", "--hard", "HEAD~1"]);
    expireReflogs(dir);
    expect(git(dir, ["rev-parse", "ORIG_HEAD"]).trim()).toBe(id);
    // git gc --prune=now deletes it (pseudo-refs are not roots there): we keep more
    const { ours, native } = await check(dir, false);
    expect(native.has(id)).toBe(false);
    expect(ours.has(id)).toBe(true);
    git(dir, ["rev-parse", "--verify", "ORIG_HEAD^{tree}"]);
  });

  it("a merged commit only MERGE_HEAD names, mid-merge", async () => {
    const dir = repo();
    git(dir, ["checkout", "-q", "-b", "topic", "HEAD~1"]);
    commit(dir, "topic-side");
    const topic = git(dir, ["rev-parse", "HEAD"]).trim();
    git(dir, ["checkout", "-q", "main"]);
    try {
      git(dir, ["merge", "--no-edit", "topic"]);
    } catch {
      // the conflict on f.txt is the point
    }
    git(dir, ["branch", "-q", "-D", "topic"]);
    expireReflogs(dir);
    expect(git(dir, ["rev-parse", "MERGE_HEAD"]).trim()).toBe(topic);
    // git gc --prune=now deletes it (pseudo-refs are not roots there): we keep more
    const { ours, native } = await check(dir, false);
    expect(native.has(topic)).toBe(false);
    expect(ours.has(topic)).toBe(true);
  });

  it("a shallow clone: the absent parents beyond the boundary do not abort", async () => {
    const src = repo(4);
    const dir = join(tempDir("gc-roots-shallow-"), "clone");
    git(src, ["clone", "-q", "--depth", "2", `file://${src}`, dir]);
    expect(git(dir, ["rev-parse", "--is-shallow-repository"]).trim()).toBe("true");
    const { result } = await check(dir);
    expect(result.reachableObjects).toBeGreaterThan(0);
  });

  it("keeps recently written unreachable objects unless pruneExpireMs is 0", async () => {
    const dir = repo();
    const orphan = hashObject(dir, "written just now\n");
    let result = await ourGc(dir, 14 * 24 * 60 * 60 * 1000);
    expect(result.keptRecentObjects).toBe(1);
    expect(stored(dir).has(orphan)).toBe(true);
    result = await ourGc(dir, 0);
    expect(stored(dir).has(orphan)).toBe(false);
  });
});

describe("GcOrchestrator on a corrupt reachable object", () => {
  it("aborts with nothing pruned, as native git refuses to walk", async () => {
    const dir = repo(6);
    const orphan = hashObject(dir, "an unreachable blob\n");
    const id = git(dir, ["rev-parse", "main~3"]).trim();
    const path = join(dir, ".git/objects", id.slice(0, 2), id.slice(2));
    rmSync(path, { force: true });
    writeFileSync(path, "this is not a zlib stream");
    const before = stored(dir);
    expect(() => reachable(dir)).toThrow();

    await expect(ourGc(dir)).rejects.toBeInstanceOf(CorruptObjectError);
    const backend = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });
    const orchestrator = new GcOrchestrator(backend.history, new FileGcStrategy(backend));
    await expect(orchestrator.run({ dryRun: true, pruneExpireMs: 0 })).rejects.toBeInstanceOf(
      CorruptObjectError,
    );
    expect(stored(dir)).toEqual(before);
    expect(before.has(orphan)).toBe(true);
  });

  it("aborts on a missing reachable object", async () => {
    const dir = repo(6);
    const id = git(dir, ["rev-parse", "main~3"]).trim();
    rmSync(join(dir, ".git/objects", id.slice(0, 2), id.slice(2)));
    hashObject(dir, "an unreachable blob\n");
    const before = stored(dir);
    await expect(ourGc(dir)).rejects.toThrow(/missing/);
    expect(stored(dir)).toEqual(before);
  });
});

describe("gc() on a shallow clone", () => {
  it("stops at the shallow boundary instead of failing on the absent parents", async () => {
    const src = repo(4);
    const dir = join(tempDir("gc-roots-shallow-gc-"), "clone");
    git(src, ["clone", "-q", "--depth", "2", `file://${src}`, dir]);
    const before = reachable(dir);
    const backend = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });
    await gc({ history: backend.history, files: backend.files, pruneExpireMs: 0 });
    git(dir, ["fsck", "--full", "--no-progress"]);
    expect(new Set(reachable(dir))).toEqual(new Set(before));
  });
});
