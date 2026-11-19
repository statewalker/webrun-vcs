/**
 * `git add --chmod=(+|-)x` and `git add --refresh` against native git: each case builds the
 * same repository twice, runs native `git add` in one twin and ours in the other, and
 * compares the index (entries and cache-tree), the worktree, what `git diff-files` finds
 * stat-dirty (the stat a refresh stores) and git's messages.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIndexFile } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AddResult } from "../src/commands/add-command.js";
import { AddFailedError } from "../src/errors/index.js";
import type { Git } from "../src/index.js";
import { git, gitOk, normalizeState, openOurs, put, snapshot } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

/** The same repository in two directories, built by `build` with native git. */
function twins(build: (dir: string) => void): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `n${n}`);
  const ours = join(root, `o${n}`);
  for (const dir of [native, ours]) {
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    build(dir);
  }
  return { native, ours };
}

/** The `TREE` extension of the index in `dir`, as hex (empty: none). */
async function treeExtension(dir: string): Promise<string> {
  const parsed = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
  const ext = parsed.extensionData.find((e) => e.signature === "TREE");
  return ext ? Buffer.from(ext.data).toString("hex") : "";
}

/**
 * Both alike: the entries `diff-files` finds dirty (asked first: `git status` refreshes the
 * index), index, cache-tree, worktree and status. Returns what is dirty in ours.
 */
async function same(ours: string, native: string): Promise<string> {
  const dirtyOurs = dirty(ours);
  expect(dirtyOurs).toBe(dirty(native));
  expect(await treeExtension(ours)).toBe(await treeExtension(native));
  expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
  return dirtyOurs;
}

/** The entries whose stat no longer matches (`git diff-files` refreshes nothing). */
function dirty(dir: string): string {
  return execFileSync("git", ["diff-files", "--name-status"], {
    cwd: dir,
    env: nativeGitEnv(root),
    encoding: "utf8",
  });
}

/** Our add with git's command-line arguments. */
async function ourAdd(repo: Git, args: string[]): Promise<AddResult> {
  const cmd = repo.add();
  for (const a of args) {
    if (a === "-u") cmd.setUpdate(true);
    else if (a === "-n") cmd.setDryRun(true);
    else if (a === "-v") cmd.setVerbose(true);
    else if (a === "--refresh") cmd.setRefresh(true);
    else if (a.startsWith("--chmod=")) cmd.setChmod(a.slice("--chmod=".length));
    else cmd.addFilepattern(a);
  }
  return cmd.call();
}

/** Runs native `git add <args>` and ours; both must succeed or fail alike. */
async function twinAdd(native: string, ours: string, args: string[]) {
  const r = git(root, native, "add", ...args);
  let result: AddResult | undefined;
  let error: Error | undefined;
  try {
    result = await ourAdd(await openOurs(ours), args);
  } catch (e) {
    error = e as Error;
  }
  expect(error !== undefined, `ours: ${error?.message} / native: ${r.stderr}`).toBe(r.status !== 0);
  const stale = await same(ours, native);
  return { r, result, error, stale };
}

/** A commit with a regular file `a`, an executable `run.sh`, a link and `d/b`, on main. */
function base(dir: string) {
  put(dir, "a", "a\n");
  put(dir, "run.sh", "#!/bin/sh\n");
  chmodSync(join(dir, "run.sh"), 0o755);
  put(dir, "d/b", "b\n");
  symlinkSync("a", join(dir, "link"));
  gitOk(root, dir, "add", ".");
  gitOk(root, dir, "commit", "-q", "-m", "c");
}

/** Sets the mtime of `paths` to a fixed time well in the past (never racy). */
function backdate(dir: string, paths: string[], seconds = 1_600_000_000) {
  for (const p of paths) utimesSync(join(dir, p), seconds, seconds);
}

describeGit("git add --chmod against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "add-chmod-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("+x on a tracked file changes the index mode only", async () => {
    const { native, ours } = twins(base);
    await twinAdd(native, ours, ["--chmod=+x", "a"]);
    expect(gitOk(root, ours, "ls-files", "-s", "a")).toMatch(/^100755 /);
    expect(gitOk(root, ours, "status", "--short")).toBe("MM a\n");
  });

  it("-x on an executable, and +x on a new file, a directory pathspec", async () => {
    const { native, ours } = twins((dir) => {
      base(dir);
      put(dir, "d/new.sh", "new\n");
    });
    await twinAdd(native, ours, ["--chmod=-x", "run.sh"]);
    await twinAdd(native, ours, ["--chmod=+x", "d"]);
  });

  it("a symbolic link cannot be chmodded: git's error, the rest is written", async () => {
    const { native, ours } = twins((dir) => {
      base(dir);
      put(dir, "a", "a changed\n");
    });
    const { r, error } = await twinAdd(native, ours, ["--chmod=+x", "a", "link"]);
    expect(error).toBeInstanceOf(AddFailedError);
    expect(error?.message).toBe(r.stderr.trim());
    expect(error?.message).toBe("error: cannot chmod +x 'link'");
  });

  it("--dry-run changes nothing; -u without a pathspec chmods nothing", async () => {
    const { native, ours } = twins((dir) => {
      base(dir);
      put(dir, "a", "a changed\n");
    });
    await twinAdd(native, ours, ["-n", "--chmod=+x", "a"]);
    await twinAdd(native, ours, ["-u", "--chmod=+x"]);
  });

  it("a value other than +x or -x is refused before anything changes", async () => {
    const { native, ours } = twins((dir) => {
      base(dir);
      put(dir, "a", "a changed\n");
    });
    const { r, error } = await twinAdd(native, ours, ["--chmod=x", "a"]);
    expect(error?.message).toBe(r.stderr.trim());
  });
});

describeGit("git add --refresh against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "add-refresh-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("stores the fresh stat of files that still hold their content, adds nothing", async () => {
    const { native, ours } = twins((dir) => {
      base(dir);
      backdate(dir, ["a", "d/b", "run.sh"]);
      put(dir, "run.sh", "#!/bin/sh\necho changed\n");
      put(dir, "u", "untracked\n");
      backdate(dir, ["run.sh", "u"]);
    });
    expect(dirty(native)).toContain("a");
    const { r, result, stale } = await twinAdd(native, ours, ["--refresh", "."]);
    expect(result?.output).toEqual([]);
    expect(r.stdout).toBe("");
    expect(stale).toBe("M\trun.sh\n");
  });

  it("with -v: git's porcelain lines of what differs", async () => {
    const { native, ours } = twins((dir) => {
      base(dir);
      backdate(dir, ["a", "d/b"]);
      put(dir, "run.sh", "changed\n");
      gitOk(root, dir, "rm", "-q", "--cached", "d/b");
      put(dir, "n", "intent\n");
      gitOk(root, dir, "add", "-N", "n");
      rmSync(join(dir, "a"));
    });
    const { r, result } = await twinAdd(native, ours, ["--refresh", "-v", "."]);
    expect(result?.output.join("\n")).toBe(r.stdout.trim());
  });

  it("a conflicted path: 'needs merge' on stdout", async () => {
    const { native, ours } = twins((dir) => {
      base(dir);
      const id = gitOk(root, dir, "rev-parse", "HEAD:a").trim();
      gitOk(root, dir, "rm", "-q", "--cached", "a");
      execFileSync("git", ["update-index", "--index-info"], {
        cwd: dir,
        env: nativeGitEnv(root),
        input: `100644 ${id} 1\ta\n100644 ${id} 2\ta\n100644 ${id} 3\ta\n`,
      });
    });
    const { r, result } = await twinAdd(native, ours, ["--refresh", "a", "d"]);
    expect(r.stdout).toBe("a: needs merge\n");
    expect(result?.output.join("\n")).toBe(r.stdout.trim());
  });

  it("an element that matches no entry dies before the index is written", async () => {
    const { native, ours } = twins((dir) => {
      base(dir);
      backdate(dir, ["a"]);
    });
    const { r, error, stale } = await twinAdd(native, ours, ["--refresh", "a", "nope"]);
    expect(r.status).toBe(128);
    expect(error?.message).toBe(r.stderr.trim());
    expect(stale).toContain("a");
  });
});
