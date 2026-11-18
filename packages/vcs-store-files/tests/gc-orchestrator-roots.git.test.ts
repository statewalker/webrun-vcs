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
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CorruptObjectError, GcOrchestrator, graftFileReader } from "@statewalker/vcs-core";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";
import { createGitFilesBackend, FileGcStrategy, gc, repack } from "../src/index.js";

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

/**
 * `git fsck --full`. A git built without its own exec path (GIT_EXEC_PATH pointing at an
 * older git's helpers) fails with "'refs' is not a git command" when fsck runs `git refs
 * verify`: that build issue alone is tolerated, after checking connectivity another way.
 */
function fsck(dir: string) {
  const run = spawnSync("git", ["fsck", "--full", "--no-progress"], { cwd: dir, env: GIT_ENV });
  if (run.status === 0) return;
  const stderr = run.stderr.toString();
  if (stderr.includes("'refs' is not a git command")) {
    git(dir, ["rev-list", "--objects", "--all", "--reflog", "--indexed-objects"]);
    return;
  }
  throw new Error(`git fsck failed in ${dir}:\n${stderr}`);
}

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
  fsck(dir);
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
    fsck(wt);
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
    fsck(dir);
    expect(new Set(reachable(dir))).toEqual(new Set(before));
  });
});

/** The tree and blobs of a stash commit (its worktree state), which must survive with it. */
const stashObjects = (dir: string, id: string) =>
  git(dir, ["rev-list", "--objects", "--no-walk", id, `${id}^2`])
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(0, 40));

/** A repository mid-rebase or mid-merge whose dirty worktree was autostashed. */
function conflictedWithDirtyWorktree(): string {
  const dir = repo();
  git(dir, ["checkout", "-q", "-b", "topic", "HEAD~1"]);
  commit(dir, "topic-side");
  git(dir, ["checkout", "-q", "main"]);
  // uncommitted, in a file the conflict does not touch
  writeFileSync(join(dir, "c0.txt"), "dirty, autostashed\n");
  return dir;
}

describe("GcOrchestrator keeps the autostash of a merge or rebase in progress", () => {
  it.each([
    [
      "rebase (merge backend): rebase-merge/autostash",
      ["rebase", "--autostash", "topic"],
      ".git/rebase-merge/autostash",
    ],
    [
      "rebase --apply: rebase-apply/autostash",
      ["rebase", "--apply", "--autostash", "topic"],
      ".git/rebase-apply/autostash",
    ],
    [
      "merge --autostash: MERGE_AUTOSTASH",
      ["merge", "--autostash", "--no-edit", "topic"],
      ".git/MERGE_AUTOSTASH",
    ],
  ])("%s", async (_name, args, file) => {
    const dir = conflictedWithDirtyWorktree();
    const run = spawnSync("git", args, { cwd: dir, env: GIT_ENV });
    expect(run.status, run.stderr.toString()).not.toBe(0); // the conflict on f.txt stops it
    const stash = readFileSync(join(dir, file), "utf8").trim();
    expect(stash).toMatch(/^[0-9a-f]{40}$/);
    const objects = stashObjects(dir, stash);
    expireReflogs(dir);
    const { ours } = await check(dir, false);
    for (const id of objects) expect(ours.has(id), `autostash object ${id} kept`).toBe(true);
    // aborting applies the autostash: the dirty file comes back
    git(dir, [args[0] as string, "--abort"]);
    expect(readFileSync(join(dir, "c0.txt"), "utf8")).toBe("dirty, autostashed\n");
  });
});

describe("GcOrchestrator keeps what per-worktree refs name", () => {
  /** A commit made in `dir` and left behind: only the refs under test name it afterwards. */
  function leftBehind(dir: string, name: string): string {
    commit(dir, name);
    const id = git(dir, ["rev-parse", "HEAD"]).trim();
    git(dir, ["reset", "-q", "--hard", "HEAD~1"]);
    return id;
  }

  it("refs/bisect, refs/worktree and refs/rewritten of the main worktree", async () => {
    const dir = repo();
    const ids = ["bisected", "worktree-ref", "rewritten-ref"].map((n) => leftBehind(dir, n));
    git(dir, ["update-ref", "refs/bisect/bad", ids[0] as string]);
    git(dir, ["update-ref", "refs/worktree/keep", ids[1] as string]);
    git(dir, ["update-ref", "refs/rewritten/onto", ids[2] as string]);
    rmSync(join(dir, ".git/ORIG_HEAD"), { force: true });
    expireReflogs(dir);
    const { ours, native } = await check(dir);
    for (const id of ids) {
      expect(native.has(id)).toBe(true);
      expect(ours.has(id)).toBe(true);
    }
  });

  it("a linked worktree's refs/bisect, refs/worktree and refs/rewritten", async () => {
    const dir = repo();
    const wt = join(tempDir("gc-roots-wt-refs-"), "wt");
    git(dir, ["worktree", "add", "-q", "--detach", wt]);
    const ids = ["wt-bisected", "wt-worktree-ref", "wt-rewritten-ref"].map((n) =>
      leftBehind(wt, n),
    );
    git(wt, ["update-ref", "refs/bisect/bad", ids[0] as string]);
    git(wt, ["update-ref", "refs/worktree/keep", ids[1] as string]);
    git(wt, ["update-ref", "refs/rewritten/onto", ids[2] as string]);
    // per-worktree refs live in the worktree's own directory
    expect(readFileSync(join(dir, ".git/worktrees/wt/refs/worktree/keep"), "utf8").trim()).toBe(
      ids[1],
    );
    rmSync(join(dir, ".git/worktrees/wt/ORIG_HEAD"), { force: true });
    expireReflogs(dir);
    git(wt, ["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"]);
    // git 2.43's gc --prune=now drops them (its walk misses other worktrees' refs); we keep
    // them, and `git -C wt rev-list --all` (which lists them) still succeeds
    const { ours } = await check(dir, false);
    for (const id of ids) expect(ours.has(id), `we keep ${id}`).toBe(true);
    git(wt, ["rev-list", "--objects", "--all", "--reflog", "--indexed-objects"]);
    fsck(wt);
  });
});

describe("GcOrchestrator on a truncated reachable blob", () => {
  it("aborts with nothing pruned (blobs are read to their end in strict mode)", async () => {
    const dir = repo(6);
    const blob = git(dir, ["rev-parse", "main~3:c2.txt"]).trim();
    const path = join(dir, ".git/objects", blob.slice(0, 2), blob.slice(2));
    const bytes = readFileSync(path);
    rmSync(path, { force: true });
    writeFileSync(path, bytes.subarray(0, bytes.length - 6));
    const orphan = hashObject(dir, "an unreachable blob\n");
    const before = stored(dir);
    expect(
      spawnSync("git", ["cat-file", "blob", blob], { cwd: dir, env: GIT_ENV }).status,
    ).not.toBe(0);

    await expect(ourGc(dir)).rejects.toBeInstanceOf(CorruptObjectError);
    expect(stored(dir)).toEqual(before);
    expect(before.has(orphan)).toBe(true);
  });
});

describe("GcOrchestrator beyond the shallow boundary", () => {
  it("a stored parent beyond the boundary whose tree is missing does not abort", async () => {
    const dir = repo(4);
    const boundary = git(dir, ["rev-parse", "main~1"]).trim();
    const beyond = git(dir, ["rev-parse", "main~2"]).trim();
    const beyondTree = git(dir, ["rev-parse", "main~2^{tree}"]).trim();
    // main~1 becomes a shallow commit; main~2, still stored, lies beyond it without its tree
    writeFileSync(join(dir, ".git/shallow"), `${boundary}\n`);
    rmSync(join(dir, ".git/objects", beyondTree.slice(0, 2), beyondTree.slice(2)));
    expireReflogs(dir);
    const orphan = hashObject(dir, "an unreachable blob\n");
    const kept = reachable(dir);

    const result = await ourGc(dir);
    expect(result.reachableObjects).toBeGreaterThan(0);
    const after = stored(dir);
    for (const id of kept) expect(after.has(id), `reachable ${id} kept`).toBe(true);
    expect(after.has(beyond)).toBe(true);
    expect(after.has(orphan)).toBe(false);
  });

  it("a missing tree inside the boundary still aborts", async () => {
    const dir = repo(4);
    writeFileSync(join(dir, ".git/shallow"), `${git(dir, ["rev-parse", "main~2"]).trim()}\n`);
    const tree = git(dir, ["rev-parse", "main~1^{tree}"]).trim();
    rmSync(join(dir, ".git/objects", tree.slice(0, 2), tree.slice(2)));
    hashObject(dir, "an unreachable blob\n");
    const before = stored(dir);
    await expect(ourGc(dir)).rejects.toThrow(/missing/);
    expect(stored(dir)).toEqual(before);
  });
});

describe("GcOrchestrator with verifyBlobs off", () => {
  it("does not read blob bodies: a truncated reachable blob is kept, the orphan pruned", async () => {
    const dir = repo(6);
    const blob = git(dir, ["rev-parse", "main~3:c2.txt"]).trim();
    const path = join(dir, ".git/objects", blob.slice(0, 2), blob.slice(2));
    const bytes = readFileSync(path);
    rmSync(path, { force: true });
    writeFileSync(path, bytes.subarray(0, bytes.length - 6));
    expireReflogs(dir);
    const orphan = hashObject(dir, "an unreachable blob\n");

    const backend = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });
    const result = await new GcOrchestrator(backend.history, new FileGcStrategy(backend)).run({
      pruneExpireMs: 0,
      verifyBlobs: false,
    });
    expect(result.reachableObjects).toBeGreaterThan(0);
    const after = stored(dir);
    // the reachable (if corrupt) blob is never pruned; only the unreachable orphan goes
    expect(after.has(blob)).toBe(true);
    expect(after.has(orphan)).toBe(false);
  });
});

/**
 * A repository whose old history only a graft reaches: an orphan commit (with its own blob)
 * that no ref, reflog or index names, made the parent of main's root by `info/grafts`.
 */
function graftedHistory(): { dir: string; old: string; oldBlob: string; trueParent?: string } {
  const dir = repo(3);
  const oldBlob = hashObject(dir, "only in the grafted history\n");
  const tree = git(dir, ["mktree"], `100644 blob ${oldBlob}\told.txt\n`).trim();
  const old = git(dir, ["commit-tree", "-m", "old history", tree]).trim();
  const root = git(dir, ["rev-list", "--max-parents=0", "main"]).trim();
  writeFileSync(join(dir, ".git/info/grafts"), `${root} ${old}\n`);
  return { dir, old, oldBlob };
}

describe("gc keeps the objects grafts reach, as native git", () => {
  it("GcOrchestrator: a commit only a graft names, and its tree and blob", async () => {
    const { dir, old, oldBlob } = graftedHistory();
    const { ours, native } = await check(dir);
    for (const id of [old, oldBlob]) {
      expect(native.has(id), `native keeps ${id}`).toBe(true);
      expect(ours.has(id), `ours keeps ${id}`).toBe(true);
    }
  });

  it("gc(): a commit only a graft names, and the true parent a graft hides", async () => {
    const { dir, old, oldBlob } = graftedHistory();
    // c2's graft drops c1 from its parents: repack --keep-true-parents keeps c1 all the same
    const c1 = git(dir, ["rev-parse", "main~1"]).trim();
    const c0 = git(dir, ["rev-parse", "main~2"]).trim();
    const c2 = git(dir, ["rev-parse", "main"]).trim();
    writeFileSync(
      join(dir, ".git/info/grafts"),
      `${readFileSync(join(dir, ".git/info/grafts"), "utf8")}${c2} ${c0}\n`,
    );
    expireReflogs(dir);
    const native = nativeGcKeeps(dir);
    const backend = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });
    await gc({ history: backend.history, files: backend.files, pruneExpireMs: 0 });
    fsck(dir);
    const ours = stored(dir);
    for (const id of [old, oldBlob, c1]) {
      expect(native.has(id), `native keeps ${id}`).toBe(true);
      expect(ours.has(id), `ours keeps ${id}`).toBe(true);
    }
    for (const id of native) expect(ours.has(id), `${id} native gc keeps is kept`).toBe(true);
    // exactly what native gc keeps
    expect(ours).toEqual(native);
  });

  it("GIT_GRAFT_FILE: gc(), GcOrchestrator and repack keep what its grafts reach", async () => {
    const { dir, old, oldBlob } = graftedHistory();
    // the grafts live outside the repository; info/grafts names nothing
    const graftFile = join(tempDir("gc-graft-file-"), "grafts");
    writeFileSync(graftFile, readFileSync(join(dir, ".git/info/grafts")));
    rmSync(join(dir, ".git/info/grafts"));
    expireReflogs(dir);
    const env = { ...GIT_ENV, GIT_GRAFT_FILE: graftFile };
    const environment = createNodeGitHostEnvironment({ env });
    // native gc run with the variable keeps the grafted history; without it, prunes it
    const copy = tempDir("gc-graft-file-native-");
    cpSync(dir, copy, { recursive: true });
    execFileSync("git", ["gc", "--quiet", "--prune=now"], { cwd: copy, env });
    const native = stored(copy);
    expect(native.has(old) && native.has(oldBlob)).toBe(true);
    expect(nativeGcKeeps(dir).has(old)).toBe(false);

    // gc() given the environment
    const a = tempDir("gc-graft-file-a-");
    cpSync(dir, a, { recursive: true });
    const backendA = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: a }) });
    await gc({ history: backendA.history, files: backendA.files, pruneExpireMs: 0, environment });
    expect(stored(a)).toEqual(native);

    // GcOrchestrator on a backend opened with the environment (refs.readGrafts reads the file)
    const b = tempDir("gc-graft-file-b-");
    cpSync(dir, b, { recursive: true });
    const backendB = await createGitFilesBackend({
      files: createNodeFilesApi({ rootDir: b }),
      environment,
    });
    await new GcOrchestrator(backendB.history, new FileGcStrategy(backendB)).run({
      pruneExpireMs: 0,
    });
    for (const id of [old, oldBlob]) expect(stored(b).has(id), `kept ${id}`).toBe(true);
    expect(stored(b)).toEqual(new Set([...native].filter((id) => stored(dir).has(id))));

    // GcOrchestrator given the reader explicitly, on a backend without the environment
    const c = tempDir("gc-graft-file-c-");
    cpSync(dir, c, { recursive: true });
    const backendC = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: c }) });
    await new GcOrchestrator(backendC.history, new FileGcStrategy(backendC)).run({
      pruneExpireMs: 0,
      readGraftFile: graftFileReader(environment),
    });
    expect(stored(c)).toEqual(stored(b));

    // repack -a -d given the reader packs the grafted history
    const d = tempDir("gc-graft-file-d-");
    cpSync(dir, d, { recursive: true });
    const backendD = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: d }) });
    const packed = await repack({ ...backendD, readGraftFile: graftFileReader(environment) });
    expect(packed?.objectCount).toBe(native.size);
    fsck(a);
    fsck(b);
  });

  it("a shallow commit's graft is overridden: what only it reaches is pruned, as native", async () => {
    // main's root becomes shallow; its graft (to an orphan history) no longer counts
    const { dir, old, oldBlob } = graftedHistory();
    // (main~2: the graft makes `old` the root rev-list would name)
    const root = git(dir, ["rev-parse", "main~2"]).trim();
    expect(git(dir, ["rev-parse", "main~3"]).trim()).toBe(old);
    writeFileSync(join(dir, ".git/shallow"), `${root}\n`);
    expireReflogs(dir);
    const native = nativeGcKeeps(dir);
    expect(native.has(old) || native.has(oldBlob)).toBe(false);
    const backend = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });
    await gc({ history: backend.history, files: backend.files, pruneExpireMs: 0 });
    expect(stored(dir)).toEqual(native);
  });

  it("a graft naming a missing parent aborts gc with nothing pruned, as native gc dies", async () => {
    const dir = repo(3);
    const tip = git(dir, ["rev-parse", "main"]).trim();
    writeFileSync(join(dir, ".git/info/grafts"), `${tip} ${"1".repeat(40)}\n`);
    hashObject(dir, "an unreachable blob\n");
    const before = stored(dir);
    const native = spawnSync("git", ["gc", "--quiet", "--prune=now"], { cwd: dir, env: GIT_ENV });
    expect(native.status).not.toBe(0);
    expect(native.stderr.toString()).toContain(`Could not read ${"1".repeat(40)}`);
    expect(stored(dir)).toEqual(before);
    await expect(ourGc(dir)).rejects.toThrow(/missing/);
    const backend = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });
    await expect(
      gc({ history: backend.history, files: backend.files, pruneExpireMs: 0 }),
    ).rejects.toThrow();
    expect(stored(dir)).toEqual(before);
  });
});
