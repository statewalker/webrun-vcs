/**
 * `git update-index` against native git (builtin/update-index.c): scenarios of
 * t2107-update-index-basic.sh, t2104-update-index-skip-worktree.sh and
 * t2106-update-index-assume-unchanged.sh, plus `--add`/`--remove`/`--force-remove`,
 * `--index-info`, `--refresh`/`--really-refresh`, conflicts and split and sparse indexes.
 *
 * Every step runs twice in one directory from the same index file (its bytes and mtime put
 * back in between): once by native git, once by ours. The index bytes, stdout, stderr and
 * exit status must be equal; the next step starts from the index both wrote.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { UpdateIndexFailedError } from "../src/index.js";
import { gitOk, openOurs, put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

function run(cwd: string, args: string[], input?: string) {
  const r = spawnSync("git", args, {
    cwd,
    env: nativeGitEnv(root),
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** A fresh repository built by `build`, its files dated in the past and the index refreshed. */
function fixture(build: (dir: string) => void): string {
  const dir = join(root, `r${counter++}`);
  gitOk(root, root, "init", "-q", "-b", "main", dir);
  build(dir);
  settle(dir);
  return dir;
}

function settle(dir: string): void {
  const files = execFileSync("find", [".", "-path", "./.git", "-prune", "-o", "-print"], {
    cwd: dir,
    encoding: "utf8",
  })
    .split("\n")
    .filter((p) => p && p !== ".");
  const past = new Date("2020-01-01T00:00:00Z");
  for (const p of files) utimesSync(join(dir, p), past, past);
  run(dir, ["update-index", "-q", "--refresh"]);
}

/** Our `git update-index` with git's arguments. */
async function ours(dir: string, args: string[], input?: string) {
  const cmd = (await openOurs(dir)).updateIndex();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--add") cmd.setAdd();
    else if (arg === "--remove") cmd.setRemove();
    else if (arg === "--replace") cmd.setReplace();
    else if (arg === "--force-remove") cmd.setForceRemove();
    else if (arg === "--info-only") cmd.setInfoOnly();
    else if (arg === "--verbose") cmd.setVerbose();
    else if (arg === "-q") cmd.setQuiet();
    else if (arg === "--unmerged") cmd.setUnmerged();
    else if (arg === "--ignore-missing") cmd.setIgnoreMissing();
    else if (arg === "--ignore-submodules") cmd.setIgnoreSubmodules();
    else if (arg === "--ignore-skip-worktree-entries") cmd.setIgnoreSkipWorktreeEntries();
    else if (arg === "--refresh") cmd.refresh();
    else if (arg === "--really-refresh") cmd.reallyRefresh();
    else if (arg === "--assume-unchanged") cmd.setAssumeUnchanged(true);
    else if (arg === "--no-assume-unchanged") cmd.setAssumeUnchanged(false);
    else if (arg === "--skip-worktree") cmd.setSkipWorktree(true);
    else if (arg === "--no-skip-worktree") cmd.setSkipWorktree(false);
    else if (arg.startsWith("--chmod=")) cmd.setChmod(arg.slice(8) as "+x" | "-x");
    else if (arg === "--index-info") cmd.setIndexInfo(input ?? "");
    else if (arg === "--stdin") cmd.setStdin(input ?? "");
    else if (arg === "-z") cmd.setNulTerminated();
    else if (arg === "--index-version") cmd.setIndexVersion(Number(args[++i]));
    else if (arg === "--show-index-version") cmd.setShowIndexVersion();
    else if (arg === "--force-write-index") cmd.setForceWriteIndex();
    else if (arg === "--cacheinfo") {
      const next = args[++i] as string;
      const parts = next.includes(",") ? next.split(",") : [next, args[++i], args[++i]];
      const [mode, id, path] = parts as [string, string, string];
      cmd.addCacheInfo(Number.parseInt(mode, 8), id, path);
    } else cmd.addPath(arg);
  }
  try {
    const r = await cmd.call();
    return { status: r.exitCode, stdout: r.output, stderr: r.errors };
  } catch (e) {
    if (!(e instanceof UpdateIndexFailedError)) throw e;
    return { status: e.exitCode, stdout: e.output, stderr: `${e.message}\n` };
  }
}

/** One step: native git, the index put back, ours; then both results compared. */
async function step(dir: string, args: string[], input?: string) {
  const index = join(dir, ".git", "index");
  const exists = existsSync(index);
  const saved = exists ? readFileSync(index) : undefined;
  const time = exists ? statSync(index).mtime : undefined;
  const fsck = () => run(dir, ["fsck", "--no-dangling", "--connectivity-only", "--cache"]).status;
  const expected = run(dir, ["update-index", ...args], input);
  const nativeIndex = existsSync(index) ? readFileSync(index).toString("hex") : "";
  const nativeFsck = fsck();
  if (saved && time) {
    writeFileSync(index, saved);
    utimesSync(index, time, time);
  } else rmSync(index, { force: true });
  const actual = await ours(dir, args, input);
  expect(actual).toEqual(expected);
  const ourIndex = existsSync(index) ? readFileSync(index).toString("hex") : "";
  expect(ourIndex).toBe(nativeIndex);
  // the objects the index names are in the repository where native git's are (a sparse
  // index's collapsed directories: ours stores their trees, native git leaves the root's
  // uncomputed and its fsck reports it missing)
  if (nativeFsck === 0) expect(fsck()).toBe(0);
  return expected;
}

describeGit("git update-index against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "update-index-native-"));
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('t2107-update-index-basic.sh: "--cacheinfo does not accept blob null sha1"', async () => {
    const dir = fixture((d) => {
      put(d, "file", "content\n");
      gitOk(root, d, "add", "file");
    });
    const r = await step(dir, ["--verbose", "--cacheinfo", "100644", "0".repeat(40), "file"]);
    expect(r.status).not.toBe(0);
  });

  it('t2107-update-index-basic.sh: "--cacheinfo does not accept gitlink null sha1"', async () => {
    const dir = fixture((d) => {
      const sub = join(d, "submodule");
      gitOk(root, d, "init", "-q", "submodule");
      put(sub, "foo.t", "foo\n");
      gitOk(root, sub, "add", ".");
      gitOk(root, sub, "commit", "-q", "-m", "foo");
      gitOk(root, d, "add", "submodule");
    });
    const r = await step(dir, ["--cacheinfo", "160000", "0".repeat(40), "submodule"]);
    expect(r.status).not.toBe(0);
  });

  it('t2107-update-index-basic.sh: "--cacheinfo mode,sha1,path (new syntax)"', async () => {
    const dir = fixture((d) => put(d, "file", "content\n"));
    const id = gitOk(root, dir, "hash-object", "-w", "file").trim();
    await step(dir, ["--add", "--cacheinfo", "100644", id, "file"]);
    await step(dir, ["--add", "--verbose", "--cacheinfo", `100644,${id},elif`]);
    // without --add a new path is refused
    await step(dir, ["--cacheinfo", `100644,${id},new`]);
  });

  it('t2107-update-index-basic.sh: "--chmod=+x and chmod=-x in the same argument list"', async () => {
    const dir = fixture((d) => {
      put(d, "A", "");
      put(d, "B", "");
      gitOk(root, d, "add", "A", "B");
    });
    await step(dir, ["--verbose", "--chmod=+x", "A", "--chmod=-x", "B"]);
    // a path not in the index cannot be chmodded
    await step(dir, ["--chmod=+x", "nothere"]);
  });

  it('t2107-update-index-basic.sh: "--index-version"', async () => {
    const dir = fixture((d) => {
      put(d, "a", "a\n");
      gitOk(root, d, "add", "a");
    });
    await step(dir, ["--show-index-version"]);
    await step(dir, ["--index-version", "2"]);
    await step(dir, ["--index-version", "4", "--verbose"]);
    await step(dir, ["--index-version", "4", "--verbose"]);
    await step(dir, ["--index-version", "2", "--verbose"]);
    await step(dir, ["--index-version", "4"]);
    await step(dir, ["--index-version", "2"]);
  });

  it('t2104-update-index-skip-worktree.sh: "update-index --skip-worktree", "update-index --no-skip-worktree"', async () => {
    const dir = fixture((d) => {
      for (const p of ["1", "2", "sub/1", "sub/2"]) put(d, p, "");
      gitOk(root, d, "add", "1", "2", "sub/1", "sub/2");
      gitOk(root, d, "commit", "-q", "-m", "c");
    });
    await step(dir, ["--show-index-version"]);
    await step(dir, ["--skip-worktree", "1", "sub/1"]);
    await step(dir, ["--show-index-version"]);
    await step(dir, ["--no-skip-worktree", "1", "sub/1"]);
    await step(dir, ["--show-index-version"]);
    // a path without an entry cannot be marked
    await step(dir, ["--skip-worktree", "nothere"]);
  });

  it('t2106-update-index-assume-unchanged.sh: "do not switch branches with dirty file"', async () => {
    const dir = fixture((d) => {
      put(d, "file", "");
      gitOk(root, d, "add", "file");
      gitOk(root, d, "commit", "-q", "-m", "initial");
    });
    put(dir, "file", "dirt\n");
    await step(dir, ["--assume-unchanged", "file"]);
    // assume-unchanged: a refresh does not look, a really-refresh does and drops the flag
    await step(dir, ["--refresh"]);
    await step(dir, ["--really-refresh"]);
    await step(dir, ["--no-assume-unchanged", "file"]);
  });

  it("--add, --remove and --force-remove of files, directories and links", async () => {
    const dir = fixture((d) => {
      for (const p of ["a", "b", "d/x", "d/y", "gone"]) put(d, p, `${p}\n`);
      gitOk(root, d, "add", ".");
      gitOk(root, d, "commit", "-q", "-m", "c");
    });
    put(dir, "new", "new\n");
    put(dir, "a", "changed a\n");
    rmSync(join(dir, "gone"));
    execFileSync("ln", ["-s", "a", join(dir, "link")]);
    settle(dir);
    // a new file without --add, a missing one without --remove
    await step(dir, ["new"]);
    await step(dir, ["gone"]);
    // a directory of entries is refused
    await step(dir, ["d"]);
    // an untracked directory that is no repository
    mkdirSync(join(dir, "empty"));
    await step(dir, ["empty"]);
    await step(dir, ["--verbose", "a", "--add", "new", "link", "--remove", "gone"]);
    await step(dir, ["--verbose", "--force-remove", "b", "d/x", "nothere"]);
    // --info-only: hashed, not stored
    put(dir, "info", "info only\n");
    settle(dir);
    await step(dir, ["--add", "--info-only", "info"]);
    // a path beyond a symbolic link
    await step(dir, ["--add", "link/x"]);
    // an invalid path
    await step(dir, ["--add", ".git/config"]);
  });

  it("--replace: a file in place of a directory of entries and the reverse", async () => {
    const dir = fixture((d) => {
      put(d, "d/x", "x\n");
      put(d, "f", "f\n");
      gitOk(root, d, "add", ".");
    });
    const id = gitOk(root, dir, "hash-object", "-w", "f").trim();
    await step(dir, ["--add", "--cacheinfo", `100644,${id},d`]);
    await step(dir, ["--add", "--replace", "--cacheinfo", `100644,${id},d`]);
    await step(dir, ["--add", "--cacheinfo", `100644,${id},f/y`]);
    await step(dir, ["--add", "--replace", "--cacheinfo", `100644,${id},f/y`]);
  });

  it("--index-info in its three formats, removals, stages and quoting", async () => {
    const dir = fixture((d) => {
      put(d, "a", "a\n");
      put(d, "b", "b\n");
      gitOk(root, d, "add", ".");
      gitOk(root, d, "commit", "-q", "-m", "c");
    });
    const a = gitOk(root, dir, "rev-parse", ":a").trim();
    const b = gitOk(root, dir, "rev-parse", ":b").trim();
    await step(
      dir,
      ["--index-info"],
      [
        `100644 ${b}\tnew`,
        `100755 blob ${a}\tc`,
        `100644 ${a} 1\tconf`,
        `100644 ${b} 2\tconf`,
        `100644 ${a} 3\tconf`,
        `0 ${"0".repeat(40)}\tb`,
        `100644 ${a}\t"q\\tuoted"`,
        `100644 ${a}\t.git/x`,
        "",
      ].join("\n"),
    );
    // a stage-0 entry over the conflict: the stages kept as resolve-undo
    await step(dir, ["--index-info"], `100644 ${b}\tconf\n`);
    await step(dir, ["-z", "--index-info"], `100644 ${b}\tz1\x00100644 ${a}\tz2\x00`);
    await step(dir, ["--index-info"], "garbage\n");
  });

  it("--refresh and --really-refresh: stat refreshed, changes, deletions and conflicts reported", async () => {
    const dir = fixture((d) => {
      for (const p of ["a", "b", "c", "d"]) put(d, p, `${p}\n`);
      gitOk(root, d, "add", ".");
      gitOk(root, d, "commit", "-q", "-m", "c");
    });
    // a: touched only; b: changed; c: deleted; d: conflicted
    const past = new Date("2021-01-01T00:00:00Z");
    utimesSync(join(dir, "a"), past, past);
    put(dir, "b", "b changed\n");
    utimesSync(join(dir, "b"), past, past);
    rmSync(join(dir, "c"));
    const d = gitOk(root, dir, "rev-parse", ":d").trim();
    run(dir, ["update-index", "--index-info"], `0 ${d}\td\n100644 ${d} 1\td\n100644 ${d} 2\td\n`);
    await step(dir, ["--refresh"]);
    await step(dir, ["-q", "--refresh"]);
    await step(dir, ["--unmerged", "--ignore-missing", "--refresh"]);
    await step(dir, ["--really-refresh"]);
  });

  it("--stdin paths, after the command line", async () => {
    const dir = fixture((d) => {
      put(d, "a", "a\n");
      gitOk(root, d, "add", ".");
    });
    put(dir, "x y", "xy\n");
    put(dir, "tab\there", "t\n");
    put(dir, "a", "aa\n");
    settle(dir);
    await step(dir, ["--add", "--stdin"], 'a\nx y\n"tab\\there"\n');
    await step(dir, ["--add", "--chmod=+x", "-z", "--stdin"], "a\0x y\0");
  });

  it("--skip-worktree entries with --remove and --ignore-skip-worktree-entries", async () => {
    const dir = fixture((d) => {
      put(d, "a", "a\n");
      put(d, "b", "b\n");
      gitOk(root, d, "add", ".");
      gitOk(root, d, "commit", "-q", "-m", "c");
    });
    await step(dir, ["--skip-worktree", "a", "b"]);
    rmSync(join(dir, "a"));
    rmSync(join(dir, "b"));
    await step(dir, ["--remove", "--ignore-skip-worktree-entries", "a"]);
    await step(dir, ["--remove", "b"]);
  });

  it("a split index (core.splitIndex) stays split", async () => {
    const dir = fixture((d) => {
      for (const p of ["a", "b"]) put(d, p, `${p}\n`);
      gitOk(root, d, "-c", "core.splitIndex=true", "add", ".");
      gitOk(root, d, "commit", "-q", "-m", "c");
      gitOk(root, d, "config", "core.splitIndex", "true");
    });
    put(dir, "c", "c\n");
    settle(dir);
    await step(dir, ["--add", "c"]);
    await step(dir, ["--force-remove", "a"]);
  });

  it("a sparse index (index.sparse) is written sparse", async () => {
    const dir = fixture((d) => {
      for (const p of ["a", "in/x", "out/y", "out/z"]) put(d, p, `${p}\n`);
      gitOk(root, d, "add", ".");
      gitOk(root, d, "commit", "-q", "-m", "c");
      gitOk(root, d, "sparse-checkout", "set", "--cone", "--sparse-index", "in");
    });
    put(dir, "in/new", "new\n");
    settle(dir);
    await step(dir, ["--add", "in/new"]);
    await step(dir, ["--chmod=+x", "a"]);
  });
});
