/**
 * `git read-tree` against native git (builtin/read-tree.c over unpack-trees.c): one tree
 * read whole (cache-tree primed), `--empty`, `-m` one-way with and without `--reset`,
 * two-way switches with `-u` (a dirty file refused, a local change carried), three-way
 * merges leaving stages (`--aggressive`, `--trivial`), `--prefix`, the option errors and a
 * sparse checkout. Each case copies one fixture twice, runs native git in one copy and ours
 * in the other, and compares the worktree, the index with its flags and cache-tree, status,
 * and what was printed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCacheTree } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { gitOk, openOurs, put, snapshot } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

function run(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, env: nativeGitEnv(root), encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Every worktree file dated in the past and the index refreshed (no racily clean entry). */
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

/**
 * c1: a, b, same, gone, d/f, d/g. c2 (on main): a and d/f changed, new added, gone removed.
 * side (from c1): a changed otherwise, b changed, gone removed, s added. HEAD at c2.
 */
function history(dir: string): void {
  for (const p of ["a", "b", "same", "gone", "d/f", "d/g"]) put(dir, p, `${p}\n`);
  gitOk(root, dir, "add", ".");
  gitOk(root, dir, "commit", "-q", "-m", "c1");
  gitOk(root, dir, "tag", "c1");
  gitOk(root, dir, "checkout", "-q", "-b", "side");
  put(dir, "a", "a side\n");
  put(dir, "b", "b side\n");
  put(dir, "s", "s\n");
  gitOk(root, dir, "rm", "-q", "gone");
  gitOk(root, dir, "add", ".");
  gitOk(root, dir, "commit", "-q", "-m", "side");
  gitOk(root, dir, "checkout", "-q", "main");
  put(dir, "a", "a main\n");
  put(dir, "d/f", "f main\n");
  put(dir, "new", "new\n");
  gitOk(root, dir, "rm", "-q", "gone");
  gitOk(root, dir, "add", ".");
  gitOk(root, dir, "commit", "-q", "-m", "c2");
  gitOk(root, dir, "tag", "c2");
}

function twins(build: (dir: string) => void): { native: string; ours: string } {
  const n = counter++;
  const fixture = join(root, `f${n}`);
  gitOk(root, root, "init", "-q", "-b", "main", fixture);
  build(fixture);
  settle(fixture);
  const out = { native: join(root, `n${n}`), ours: join(root, `o${n}`) };
  for (const dir of [out.native, out.ours]) {
    execFileSync("cp", ["-a", fixture, dir]);
    // read-tree's verify_uptodate trusts the stat data alone: refreshed for the copy
    run(dir, ["update-index", "-q", "--refresh"]);
  }
  return out;
}

/** Our `git read-tree` with git's options. */
async function ours(dir: string, args: string[]) {
  const cmd = (await openOurs(dir)).readTree();
  for (const arg of args) {
    if (arg === "-m") cmd.setMerge(true);
    else if (arg === "--reset") cmd.setReset(true);
    else if (arg === "-u") cmd.setUpdate(true);
    else if (arg === "-i") cmd.setIndexOnly(true);
    else if (arg === "--empty") cmd.setEmpty(true);
    else if (arg === "--trivial") cmd.setTrivial(true);
    else if (arg === "--aggressive") cmd.setAggressive(true);
    else if (arg === "--no-sparse-checkout") cmd.setSkipSparseCheckout(true);
    else if (arg.startsWith("--prefix=")) cmd.setPrefix(arg.slice("--prefix=".length));
    else cmd.addTree(arg);
  }
  try {
    return (await cmd.call()).warnings.join("\n");
  } catch (e) {
    return (e as Error).message;
  }
}

async function cacheTree(dir: string): Promise<string> {
  const git = await openOurs(dir);
  const staging = (git as unknown as { _workingCopy: { checkout: { staging: unknown } } })
    ._workingCopy.checkout.staging as { getCacheTree?(): Parameters<typeof encodeCacheTree>[0] };
  const tree = staging.getCacheTree?.();
  return tree ? Buffer.from(encodeCacheTree(tree)).toString("hex") : "";
}

async function state(dir: string) {
  return {
    ...snapshot(root, dir),
    flags: gitOk(root, dir, "-c", "core.sparseCheckout=false", "ls-files", "-t", "--stage"),
    cacheTree: await cacheTree(dir),
  };
}

async function compareReadTree(
  build: (dir: string) => void,
  args: string[],
  setup?: (dir: string) => void,
): Promise<void> {
  const t = twins(build);
  if (setup) {
    for (const dir of [t.native, t.ours]) {
      setup(dir);
      run(dir, ["update-index", "-q", "--refresh"]);
    }
  }
  const r = run(t.native, ["read-tree", ...args]);
  const stderr = await ours(t.ours, args);
  expect(stderr).toBe(r.stderr.replace(/\n$/, ""));
  expect(await state(t.ours)).toEqual(await state(t.native));
}

/** A staged change, a local change, an untracked file. */
const dirty = (dir: string) => {
  put(dir, "b", "b staged\n");
  run(dir, ["add", "b"]);
  put(dir, "same", "same dirty\n");
  put(dir, "untracked", "u\n");
};

describeGit("git read-tree against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "read-tree-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const optionErrors: string[][] = [
    ["-m", "--reset", "c1"],
    ["-m", "--prefix=x/", "c1"],
    ["--prefix=/x", "c1"],
    ["-m"],
    ["-u", "c1"],
    ["-i", "c1"],
    ["-u", "-i", "-m", "c1"],
    ["--empty", "c1"],
    ["nothing"],
  ];
  for (const args of optionErrors) {
    it(`refuses read-tree ${args.join(" ")}`, async () => {
      await compareReadTree(history, args);
    });
  }

  it("reads a single tree (cache-tree primed)", async () => {
    await compareReadTree(history, ["c1"], dirty);
  });

  it("reads two trees without -m", async () => {
    await compareReadTree(history, ["c1", "side"]);
  });

  it("--empty empties the index", async () => {
    await compareReadTree(history, ["--empty"]);
  });

  it("warns when emptying the index with no arguments", async () => {
    await compareReadTree(history, []);
  });

  it("-m one tree keeps the matching entries", async () => {
    await compareReadTree(history, ["-m", "c2"], dirty);
  });

  it("-m one tree refuses a dirty file it changes", async () => {
    await compareReadTree(history, ["-m", "c1"], (dir) => put(dir, "a", "dirty\n"));
  });

  it("-m -u one tree switches the worktree", async () => {
    await compareReadTree(history, ["-m", "-u", "c1"]);
  });

  it("--reset -u overwrites dirty files and untracked ones in the way", async () => {
    await compareReadTree(history, ["--reset", "-u", "side"], (dir) => {
      dirty(dir);
      put(dir, "a", "a dirty\n");
      put(dir, "s", "untracked in the way\n");
    });
  });

  it("--reset without -u leaves the worktree", async () => {
    await compareReadTree(history, ["--reset", "c1"], dirty);
  });

  it("-m -u two-way refuses a dirty file it changes", async () => {
    await compareReadTree(history, ["-m", "-u", "c2", "c1"], (dir) => put(dir, "a", "dirty\n"));
  });

  it("-m two-way without -u still checks the files", async () => {
    await compareReadTree(history, ["-m", "c2", "c1"], (dir) => put(dir, "a", "dirty\n"));
  });

  it("-m -i two-way does not look at the worktree", async () => {
    await compareReadTree(history, ["-m", "-i", "c2", "c1"], (dir) => put(dir, "a", "dirty\n"));
  });

  it("-m -u two-way carries a clean switch and a local change", async () => {
    await compareReadTree(history, ["-m", "-u", "c2", "c1"], dirty);
  });

  it("-m -u two-way refuses a staged change it would lose", async () => {
    await compareReadTree(history, ["-m", "-u", "c2", "c1"], (dir) => {
      put(dir, "a", "staged\n");
      run(dir, ["add", "a"]);
    });
  });

  it("-m -u two-way refuses an untracked file in the way", async () => {
    await compareReadTree(history, ["-m", "-u", "c2", "side"], (dir) => put(dir, "s", "u\n"));
  });

  it("a three-way merge leaves stages", async () => {
    await compareReadTree(history, ["-m", "c1", "c2", "side"]);
  });

  it("a three-way merge with -u", async () => {
    await compareReadTree(history, ["-m", "-u", "c1", "c2", "side"], dirty);
  });

  it("a three-way merge with --aggressive", async () => {
    await compareReadTree(history, ["-m", "--aggressive", "-u", "c1", "c2", "side"]);
  });

  it("a three-way merge with --trivial fails where a file needs merging", async () => {
    await compareReadTree(history, ["-m", "--trivial", "c1", "c2", "side"]);
  });

  it("a three-way merge refuses an index that is not the head's", async () => {
    await compareReadTree(history, ["-m", "c1", "c2", "side"], (dir) => {
      put(dir, "q", "q\n");
      run(dir, ["add", "q"]);
    });
  });

  it("refuses a merge over unmerged entries", async () => {
    await compareReadTree(history, ["-m", "c1", "c2", "side"], (dir) => {
      run(dir, ["read-tree", "-m", "c1", "c2", "side"]);
    });
  });

  it("--prefix reads a tree under a directory", async () => {
    await compareReadTree(history, ["--prefix=sub/", "c1"]);
  });

  it("--prefix without its slash, with -u", async () => {
    await compareReadTree(history, ["--prefix=sub", "-u", "side"]);
  });

  it("--prefix refuses an overlap", async () => {
    await compareReadTree(history, ["--prefix=d/", "c1"]);
  });

  describe("a sparse checkout (cone)", () => {
    const sparse = (dir: string) => {
      history(dir);
      gitOk(root, dir, "sparse-checkout", "set", "--cone", "d");
    };

    it("-m -u two-way keeps what stays outside", async () => {
      await compareReadTree(sparse, ["-m", "-u", "c2", "c1"]);
    });

    it("--reset -u", async () => {
      await compareReadTree(sparse, ["--reset", "-u", "side"]);
    });

    it("-m -u one tree with --no-sparse-checkout", async () => {
      await compareReadTree(sparse, ["-m", "-u", "--no-sparse-checkout", "c1"]);
    });

    it("a three-way merge with -u", async () => {
      await compareReadTree(sparse, ["-m", "-u", "c1", "c2", "side"]);
    });
  });
});
