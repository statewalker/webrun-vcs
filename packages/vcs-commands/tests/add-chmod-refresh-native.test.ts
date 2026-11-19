/**
 * `git add --chmod=(+|-)x` and `git add --refresh` against native git: each case builds the
 * same repository twice, runs native `git add` in one twin and ours in the other, and
 * compares the index (entries and cache-tree), the worktree, what `git diff-files` finds
 * stat-dirty (the stat a refresh stores) and git's messages.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lutimesSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
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
/** The git version whose messages ours reproduces: the one on PATH. */
const compatibility = (() => {
  try {
    const version = execFileSync("git", ["--version"], { encoding: "utf8" });
    return /git version 2\.(5\d|[6-9]\d)/.test(version) ? "2.56" : "2.43";
  } catch {
    return "2.56";
  }
})();

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
  const cmd = repo.add().setCompatibility(compatibility);
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
  // a minute old: no entry is racily clean in either twin (they are built moments apart)
  const past = Date.now() / 1000 - 60;
  for (const p of ["a", "run.sh", "d/b"]) utimesSync(join(dir, p), past, past);
  lutimesSync(join(dir, "link"), past, past);
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

describeGit("git add of paths outside the sparse checkout against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "add-sparse-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** k/a in the sparse checkout; s/b and s/c skip-worktree. */
  const sparse = (dir: string) => {
    put(dir, "k/a", "a\n");
    put(dir, "s/b", "b\n");
    put(dir, "s/c", "c\n");
    gitOk(root, dir, "add", ".");
    gitOk(root, dir, "commit", "-q", "-m", "c");
    gitOk(root, dir, "sparse-checkout", "set", "k");
  };
  const stderrOf = (r: { stderr: string }) => r.stderr.trim();
  const advice = (...elements: string[]) =>
    [
      "The following paths and/or pathspecs matched paths that exist",
      "outside of your sparse-checkout definition, so will not be",
      "updated in the index:",
      ...elements,
      "hint: If you intend to update such entries, try one of the following:",
      "hint: * Use the --sparse option.",
      "hint: * Disable or modify the sparsity rules.",
      // git 2.43 words the last hint "git config advice...", 2.5x "git config set advice..."
      `hint: Disable this message with "git config${compatibility === "2.43" ? "" : " set"} advice.updateSparsePath false"`,
    ].join("\n");

  for (const args of [
    ["s/b"],
    ["s"],
    ["*b"],
    ["-n", "s/b"],
    ["-u", "s/b"],
    ["--chmod=+x", "s/b"],
    ["--refresh", "s/b"],
    ["--refresh", "s/b", "k/a"],
    ["s/b", "k/a"],
    ["--chmod=+x", "k/a", "s/b"],
  ]) {
    it(`add ${args.join(" ")}: the advice, the rest written, exit 1`, async () => {
      const { native, ours } = twins(sparse);
      put(native, "k/a", "a changed\n");
      put(ours, "k/a", "a changed\n");
      const { r, error } = await twinAdd(native, ours, args);
      const elements = args.filter((a) => !a.startsWith("-") && a !== "k/a");
      expect(stderrOf(r)).toBe(advice(...elements));
      expect(error).toBeInstanceOf(AddFailedError);
      expect(error?.message).toBe(stderrOf(r));
      expect((error as AddFailedError).result).toBeDefined();
    });
  }

  it("advice.updateSparsePath=false drops the hint; a missing path still dies", async () => {
    const { native, ours } = twins((dir) => {
      sparse(dir);
      gitOk(root, dir, "config", "advice.updateSparsePath", "false");
    });
    const { r, error } = await twinAdd(native, ours, ["s/b"]);
    expect(error?.message).toBe(stderrOf(r));
    expect(r.stderr).not.toContain("hint:");
    const missing = await twinAdd(native, ours, ["s/nope"]);
    expect(missing.error?.message).toBe(stderrOf(missing.r));
  });
});

describeGit("skip-worktree entries present in the worktree against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "add-sparse-present-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** k/a in the cone; s/b, s/c and s/t/d skip-worktree (their files removed). */
  const sparse = (dir: string) => {
    put(dir, "k/a", "a\n");
    put(dir, "s/b", "b\n");
    put(dir, "s/c", "c\n");
    put(dir, "s/t/d", "d\n");
    gitOk(root, dir, "add", ".");
    gitOk(root, dir, "commit", "-q", "-m", "c");
    gitOk(root, dir, "sparse-checkout", "set", "--cone", "k");
  };
  /** Each entry's path and skip-worktree flag as the index file holds them (no git read). */
  const flags = async (dir: string) => {
    const parsed = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
    return parsed.entries.map((e) => `${e.skipWorktree ? "S" : "H"} ${e.path}`).join("\n");
  };
  /** Native `git add <args>` and ours: alike in exit, output and the index file's flags. */
  const twinAddFlags = async (native: string, ours: string, args: string[]) => {
    const r = git(root, native, "add", ...args);
    let result: AddResult | undefined;
    let error: Error | undefined;
    try {
      result = await ourAdd(await openOurs(ours), args);
    } catch (e) {
      error = e as Error;
    }
    expect(error !== undefined, `ours: ${error?.message} / native: ${r.stderr}`).toBe(
      r.status !== 0,
    );
    // (before git status refreshes and writes either index)
    const written = await flags(ours);
    expect(written).toBe(await flags(native));
    await same(ours, native);
    return { r, result, error, written };
  };

  // --refresh asks the skip-worktree flag (cleared: the file is refreshed, exit 0); the others
  // ask the sparse-checkout patterns as well (the advice, nothing staged, exit 1)
  for (const [args, status] of [
    [["--refresh", "s/b"], 0],
    [["--refresh", "-v", "s/b"], 0],
    [["s/b"], 1],
    [["-u", "s/b"], 1],
    [["s"], 1],
    [["--chmod=+x", "s/b"], 1],
  ] as Array<[string[], number]>) {
    it(`a file recreated outside the cone, same content: add ${args.join(" ")} exits ${status}`, async () => {
      const { native, ours } = twins(sparse);
      for (const dir of [native, ours]) put(dir, "s/b", "b\n");
      const { r, result, error, written } = await twinAddFlags(native, ours, args);
      expect(r.status).toBe(status);
      if (status === 0) {
        expect(result?.output.join("\n") ?? "").toBe(r.stdout.trim());
        expect(written).toContain("H s/b");
      } else {
        expect(error?.message).toBe(r.stderr.trim());
        // nothing changed: the index is not written, the flag stays on disk
        expect(written).toContain("S s/b");
      }
      expect(written).toContain("S s/c");
    });
  }

  it("an untracked file outside the cone: advised on, not added", async () => {
    const { native, ours } = twins(sparse);
    for (const dir of [native, ours]) {
      put(dir, "s/new", "new\n");
      put(dir, "k/new", "new\n");
    }
    const { r, error } = await twinAddFlags(native, ours, ["."]);
    expect(r.status).toBe(1);
    expect(error?.message).toBe(r.stderr.trim());
    expect(gitOk(root, ours, "ls-files", "k/new", "s/new")).toBe("k/new\n");
  });

  it("recreated with other content: --refresh -v prints M, the index is not written", async () => {
    const { native, ours } = twins(sparse);
    for (const dir of [native, ours]) put(dir, "s/b", "changed\n");
    const { r, result } = await twinAddFlags(native, ours, ["--refresh", "-v", "s/b"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("M\ts/b");
    expect(result?.output.join("\n")).toBe(r.stdout.trim());
  });

  it("a recreated file in a directory left out: --refresh -v reports it, the rest skipped", async () => {
    const { native, ours } = twins(sparse);
    for (const dir of [native, ours]) put(dir, "s/t/d", "new d\n");
    const { r, result } = await twinAddFlags(native, ours, ["--refresh", "-v", "s"]);
    expect(r.status).toBe(0);
    expect(result?.output.join("\n")).toBe(r.stdout.trim());
  });

  it("non-cone patterns: a file the patterns include is added once recreated", async () => {
    const { native, ours } = twins((dir) => {
      put(dir, "k/a", "a\n");
      put(dir, "s/b", "b\n");
      put(dir, "s/c", "c\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-q", "-m", "c");
      gitOk(root, dir, "sparse-checkout", "set", "--no-cone", "/k/");
      // the patterns now include s/b, its flag (set by the checkout) still on
      gitOk(root, dir, "config", "core.sparseCheckout", "true");
      put(dir, ".git/info/sparse-checkout", "/k/\n/s/b\n");
      put(dir, "s/b", "b changed\n");
    });
    const { r, written } = await twinAddFlags(native, ours, ["s/b"]);
    expect(r.status).toBe(0);
    expect(written).toContain("H s/b");
    expect(written).toContain("S s/c");
  });

  it("sparse.expectFilesOutsideOfPatterns=true keeps the flag: the advice, exit 1", async () => {
    const { native, ours } = twins((dir) => {
      sparse(dir);
      gitOk(root, dir, "config", "sparse.expectFilesOutsideOfPatterns", "true");
      put(dir, "s/b", "b\n");
    });
    const { error, written } = await twinAddFlags(native, ours, ["--refresh", "s/b"]);
    expect(error).toBeInstanceOf(AddFailedError);
    expect(written).toContain("S s/b");
  });

  it("status: the flag cleared and written with the refreshed stat, as git status writes it", async () => {
    const { native, ours } = twins(sparse);
    for (const dir of [native, ours]) put(dir, "s/b", "b\n");
    git(root, native, "status", "--porcelain");
    const status = await (await openOurs(ours)).status().call();
    expect(status.isClean()).toBe(true);
    expect(await flags(ours)).toBe(await flags(native));
    expect(await flags(ours)).toContain("H s/b");
  });
});
