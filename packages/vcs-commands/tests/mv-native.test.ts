/**
 * `git mv` against native git (builtin/mv.c): each check's message, directory moves, `-k`,
 * `-n`, `-v`, `-f`, a case-only rename with `core.ignoreCase`, an intent-to-add entry, a
 * symbolic link, a submodule (its gitfile, `core.worktree` and `.gitmodules`), and the sparse
 * checkout (the advice without `--sparse`, moves into and out of the cone with it). Each case
 * copies one fixture twice, runs native git in one copy and ours in the other, and compares
 * the worktree, the index with its flags and cache-tree, status, and what was printed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeCacheTree } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MvCommand } from "../src/index.js";
import { gitOk, openOurs, put, snapshot } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;
/** The git version on PATH: 2.43 or 2.5x. */
const version = (() => {
  try {
    const out = execFileSync("git", ["--version"], { encoding: "utf8" });
    return /git version 2\.(5\d|[6-9]\d)/.test(out) ? "2.56" : "2.43";
  } catch {
    return "2.56";
  }
})();
const only256 = version === "2.56" ? it : it.skip;

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
  for (const p of files) {
    try {
      utimesSync(join(dir, p), past, past);
    } catch {
      // a dangling link
    }
  }
  run(dir, ["update-index", "-q", "--refresh"]);
}

/** Two copies of the repository `build` makes. */
function twins(build: (dir: string) => void): { native: string; ours: string } {
  const n = counter++;
  const fixture = join(root, `f${n}`);
  gitOk(root, root, "init", "-q", "-b", "main", fixture);
  build(fixture);
  settle(fixture);
  const out = { native: join(root, `n${n}`), ours: join(root, `o${n}`) };
  for (const dir of [out.native, out.ours]) execFileSync("cp", ["-a", fixture, dir]);
  return out;
}

/** a, b, c, d/f, d/e/g, link -> a, committed; x untracked, empty/u untracked. */
function basic(dir: string): void {
  for (const p of ["a", "b", "c", "d/f", "d/e/g"]) put(dir, p, `${p}\n`);
  symlinkSync("a", join(dir, "link"));
  gitOk(root, dir, "add", ".");
  gitOk(root, dir, "commit", "-q", "-m", "c");
  put(dir, "x", "x\n");
  put(dir, "empty/u", "u\n");
}

/** Our `git mv` with git's options. */
async function ours(dir: string, args: string[]) {
  const cmd = (await openOurs(dir)).mv().setCompatibility(version);
  const paths: string[] = [];
  for (const arg of args) {
    if (arg === "-f") cmd.setForce(true);
    else if (arg === "-k") cmd.setSkipErrors(true);
    else if (arg === "-n") cmd.setDryRun(true);
    else if (arg === "-v") cmd.setVerbose(true);
    else if (arg === "--sparse") cmd.setSparse(true);
    else paths.push(arg);
  }
  for (const p of paths.slice(0, -1)) cmd.addSource(p);
  cmd.setDestination(paths[paths.length - 1] as string);
  return runOurs(cmd);
}

async function runOurs(cmd: MvCommand) {
  try {
    const r = await cmd.call();
    return { stdout: r.output.join("\n"), stderr: r.warnings.join("\n") };
  } catch (e) {
    const result = (e as { result?: { output: string[] } }).result;
    return { stdout: result?.output.join("\n") ?? "", stderr: (e as Error).message };
  }
}

/** The index's cache-tree bytes (TREE), as hex. */
async function cacheTree(dir: string): Promise<string> {
  const git = await openOurs(dir);
  const staging = (git as unknown as { _workingCopy: { checkout: { staging: unknown } } })
    ._workingCopy.checkout.staging as { getCacheTree?(): Parameters<typeof encodeCacheTree>[0] };
  const tree = staging.getCacheTree?.();
  return tree ? Buffer.from(encodeCacheTree(tree)).toString("hex") : "";
}

/** Everything compared: the snapshot, the raw flags, the cache-tree. */
async function state(dir: string) {
  return {
    ...snapshot(root, dir),
    flags: gitOk(root, dir, "-c", "core.sparseCheckout=false", "ls-files", "-t", "--stage"),
    cacheTree: await cacheTree(dir),
  };
}

async function compareMv(
  build: (dir: string) => void,
  args: string[],
  setup?: (dir: string) => void,
): Promise<{ native: string; ours: string }> {
  const t = twins(build);
  if (setup) for (const dir of [t.native, t.ours]) setup(dir);
  const r = run(t.native, ["mv", ...args]);
  const o = await ours(t.ours, args);
  expect(o.stderr).toBe(r.stderr.replace(/\n$/, ""));
  expect(o.stdout).toBe(r.stdout.replace(/\n$/, ""));
  expect(await state(t.ours)).toEqual(await state(t.native));
  return t;
}

describeGit("git mv against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "mv-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const errors: [string, string[]][] = [
    ["bad source", ["nothing", "z"]],
    ["not under version control", ["x", "z"]],
    ["destination exists", ["a", "b"]],
    ["can not move directory into itself", ["d", "d/e/new"]],
    ["can not move directory into itself (a file onto itself)", ["d/f", "d"]],
    ["multiple sources for the same target", ["a", "d/e/../e/g", "d/e/g", "d"]],
    ["destination is not a directory", ["a", "b", "nothing"]],
    ["destination already exists (a directory onto a file)", ["d", "c"]],
    ["Cannot overwrite (-f, a file onto a directory)", ["-f", "a", "d/e"]],
    ["source directory is empty", ["empty", "z"]],
    ["destination directory does not exist (trailing slash)", ["a", "nothing/"]],
    ["destination directory does not exist (leading directory)", ["a", "nothing/z"]],
    ["destination is not a directory (leading file)", ["a", "b/z"]],
    ["destination is beyond a symbolic link", ["b", "link/z"]],
  ];
  for (const [name, args] of errors) {
    it(`refuses: ${name}`, async () => {
      await compareMv(basic, args);
    });
  }

  it("refuses a conflicted path", async () => {
    await compareMv(basic, ["conf", "z"], (dir) => {
      const blob = gitOk(root, dir, "rev-parse", "HEAD:a").trim();
      const info = [1, 2, 3].map((s) => `100644 ${blob} ${s}\tconf`).join("\n");
      execFileSync("git", ["update-index", "--index-info"], {
        cwd: dir,
        env: nativeGitEnv(root),
        input: `${info}\n`,
      });
      writeFileSync(join(dir, "conf"), "conflict\n");
    });
  });

  only256("refuses moving a path and its parent directory together (2.5x)", async () => {
    await compareMv(basic, ["d/e/g", "d/e", "empty"]);
  });

  it("renames a file", async () => {
    await compareMv(basic, ["a", "z"]);
  });

  it("moves several files into a directory, verbosely", async () => {
    await compareMv(basic, ["-v", "a", "b", "d/e"]);
  });

  it("moves into the root with '.'", async () => {
    await compareMv(basic, ["d/f", "."]);
  });

  it("moves a directory with every entry beneath", async () => {
    await compareMv(basic, ["d", "moved"]);
  });

  it("moves a directory into another one", async () => {
    await compareMv(basic, ["d/e", "empty"]);
  });

  it("moves a directory to a name with a trailing slash", async () => {
    await compareMv(basic, ["d/e", "e2/"]);
  });

  it("-k passes over the sources that cannot move", async () => {
    await compareMv(basic, ["-k", "a", "nothing", "x", "b", "d/e"]);
  });

  it("-n tells what it would do and changes nothing", async () => {
    await compareMv(basic, ["-n", "a", "c", "d"]);
  });

  it("-f overwrites an existing file", async () => {
    await compareMv(basic, ["-f", "-v", "a", "b"]);
  });

  it("-f overwrites an untracked file", async () => {
    await compareMv(basic, ["-f", "a", "x"]);
  });

  it("moves a symbolic link as the link", async () => {
    await compareMv(basic, ["link", "d/e/link"]);
  });

  it("moves an intent-to-add entry", async () => {
    await compareMv(basic, ["n", "d/n"], (dir) => {
      put(dir, "n", "new\n");
      run(dir, ["add", "-N", "n"]);
    });
  });

  it("moves a file with staged and unstaged changes (stat kept where it differs)", async () => {
    await compareMv(basic, ["a", "b", "d"], (dir) => {
      put(dir, "a", "staged\n");
      run(dir, ["add", "a"]);
      put(dir, "a", "changed again\n");
    });
  });

  it("renames by case only with core.ignoreCase", async () => {
    await compareMv(basic, ["a", "A"], (dir) => run(dir, ["config", "core.ignoreCase", "true"]));
  });

  describe("a submodule", () => {
    const withSubmodule = (dir: string) => {
      const sub = join(root, `sub${counter}`);
      gitOk(root, root, "init", "-q", "-b", "main", sub);
      put(sub, "s", "s\n");
      gitOk(root, sub, "add", ".");
      gitOk(root, sub, "commit", "-q", "-m", "s");
      put(dir, "top", "top\n");
      put(dir, "d/f", "f\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "sub");
      gitOk(root, dir, "commit", "-q", "-m", "c");
    };
    const links = (dir: string, at: string) => ({
      gitfile: readFileSync(join(dir, at, ".git"), "utf8"),
      worktree: gitOk(root, dir, "config", "-f", ".git/modules/sub/config", "core.worktree"),
    });

    it("moves with its gitfile, core.worktree and .gitmodules", async () => {
      const t = await compareMv(withSubmodule, ["sub", "d/sub2"]);
      expect(links(t.ours, "d/sub2")).toEqual(links(t.native, "d/sub2"));
    });

    it("moves into a directory", async () => {
      const t = await compareMv(withSubmodule, ["sub", "d"]);
      expect(links(t.ours, "d/sub")).toEqual(links(t.native, "d/sub"));
    });

    it("refuses while .gitmodules holds unstaged changes", async () => {
      await compareMv(withSubmodule, ["sub", "sub2"], (dir) => {
        writeFileSync(join(dir, ".gitmodules"), `${readFileSync(join(dir, ".gitmodules"))}#\n`);
      });
    });
  });

  describe("a sparse checkout (cone)", () => {
    const sparse = (dir: string) => {
      for (const p of ["top", "in/x", "in/y", "out/z", "out/w"]) put(dir, p, `${p}\n`);
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-q", "-m", "c");
      gitOk(root, dir, "sparse-checkout", "set", "--cone", "in");
    };

    it("refuses an entry outside it with the advice", async () => {
      await compareMv(sparse, ["out/z", "in/z"]);
    });

    it("refuses a destination outside it with the advice", async () => {
      await compareMv(sparse, ["in/x", "out/x"]);
    });

    it("-k moves the rest after the advice", async () => {
      await compareMv(sparse, ["-k", "out/z", "top", "in"]);
    });

    it("refuses an existing destination in the index (--sparse)", async () => {
      await compareMv(sparse, ["--sparse", "in/x", "out/z"]);
    });

    it("--sparse moves an entry into the cone (checked out)", async () => {
      await compareMv(sparse, ["--sparse", "out/z", "in/z"]);
    });

    it("--sparse moves a clean entry out of the cone (skip-worktree)", async () => {
      await compareMv(sparse, ["--sparse", "in/x", "out"]);
    });

    it("--sparse moves a dirty entry out of the cone with the advice", async () => {
      await compareMv(sparse, ["--sparse", "in/x", "out"], (dir) => put(dir, "in/x", "dirty\n"));
    });

    it("--sparse moves a skip-worktree directory into a directory", async () => {
      await compareMv(sparse, ["--sparse", "out", "in"]);
    });
  });
});
