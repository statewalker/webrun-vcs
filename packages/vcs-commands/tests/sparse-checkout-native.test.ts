/**
 * `git sparse-checkout` and the sparse checkout of index-writing commands against native
 * git: each case builds the same repository twice with native git, runs native git in one
 * twin and ours in the other, then compares the worktree, the index with its flags
 * (`ls-files -t`), the sparse-checkout file's bytes, `config` and `config.worktree`, and
 * what both printed (stdout, stderr, exit status).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git } from "../src/index.js";
import { ResetMode } from "../src/index.js";
import {
  gitOk,
  INTEROP_AUTHOR_ENV,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  put,
  snapshot,
} from "./merge-native-helpers.js";
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

let root: string;
let counter = 0;

/** Native git in `cwd`, with `input` on stdin. */
function run(cwd: string, args: string[], input?: string) {
  const r = spawnSync("git", args, {
    cwd,
    env: { ...nativeGitEnv(root), GIT_EDITOR: "true" },
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Sets the mtime of every tracked file well in the past (never racily clean). */
function backdate(dir: string) {
  const files = gitOk(root, dir, "ls-files", "-z").split("\0").filter(Boolean);
  for (const path of files) {
    if (existsSync(join(dir, path))) utimesSync(join(dir, path), 1_600_000_000, 1_600_000_000);
  }
}

/** The same repository in two directories, built by `build` with native git. */
function twins(build: (dir: string) => void): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `n${n}`);
  const ours = join(root, `o${n}`);
  for (const dir of [native, ours]) {
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    build(dir);
    backdate(dir);
    // a refreshed index: the stat of every file recorded (unmerged entries fail it)
    run(dir, ["update-index", "-q", "--refresh"]);
  }
  return { native, ours };
}

/** k/a, k/sub/b, s/c, s/t/d, u/e and top on main. */
function base(dir: string) {
  put(dir, "k/a", "a\n");
  put(dir, "k/sub/b", "b\n");
  put(dir, "s/c", "c\n");
  put(dir, "s/t/d", "d\n");
  put(dir, "u/e", "e\n");
  put(dir, "top", "top\n");
  gitOk(root, dir, "add", ".");
  gitOk(root, dir, "commit", "-q", "-m", "base");
}

const readOr = (path: string) => (existsSync(path) ? readFileSync(path, "latin1") : "<none>");

/** Everything compared: worktree, status, index with flags, the sparse files, config. */
function state(dir: string) {
  return {
    ...snapshot(root, dir, normalizeState),
    flags: gitOk(root, dir, "ls-files", "-t", "--stage"),
    sparseFile: readOr(join(dir, ".git/info/sparse-checkout")),
    config: readOr(join(dir, ".git/config")),
    worktreeConfig: readOr(join(dir, ".git/config.worktree")),
  };
}

/** Runs `git sparse-checkout <args>` natively and ours; both alike, output included. */
async function twinSparse(native: string, ours: string, args: string[], input?: string) {
  const r = run(native, ["sparse-checkout", ...args], input);
  const cmd = (await openOurs(ours)).sparseCheckout().setArguments(args).setCompatibility(version);
  if (input !== undefined) cmd.setStdin(input, false);
  const result = await cmd.call();
  expect({ exit: result.exitCode, stdout: result.stdout, stderr: result.stderr }).toEqual({
    exit: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
  });
  expect(state(ours)).toEqual(state(native));
  return { r, result };
}

describeGit("git sparse-checkout against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sparse-checkout-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("set (cone): pattern file, config.worktree, skip-worktree entries and removed files", async () => {
    const { native, ours } = twins(base);
    await twinSparse(native, ours, ["set", "k/sub", "s"]);
    await twinSparse(native, ours, ["list"]);
    await twinSparse(native, ours, ["add", "u"]);
    await twinSparse(native, ours, ["set", "k"]);
    await twinSparse(native, ours, ["list"]);
  });

  it("set nested directories, escapes and duplicates write git's cone file", async () => {
    const { native, ours } = twins((dir) => {
      base(dir);
      put(dir, "w*x/y/z", "z\n");
      put(dir, "a b/c", "c\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-q", "-m", "more");
    });
    await twinSparse(native, ours, [
      "set",
      "--skip-checks",
      "s/t",
      "s",
      "w*x/y",
      "k/sub/",
      "./a b//",
      "k/sub",
    ]);
    await twinSparse(native, ours, ["list"]);
  });

  it("init, init --no-cone, reapply and disable", async () => {
    const { native, ours } = twins(base);
    await twinSparse(native, ours, ["init"]);
    await twinSparse(native, ours, ["disable"]);
    await twinSparse(native, ours, ["init", "--no-cone"]);
    await twinSparse(native, ours, ["reapply"]);
    await twinSparse(native, ours, ["disable"]);
    await twinSparse(native, ours, ["list"]);
  });

  it("non-cone set/add write the patterns verbatim; list prints them", async () => {
    const { native, ours } = twins(base);
    await twinSparse(native, ours, ["set", "--no-cone", "/k/", "!/k/sub/", "*.md", "top"]);
    await twinSparse(native, ours, ["list"]);
    await twinSparse(native, ours, ["add", "/s/t/"]);
    await twinSparse(native, ours, ["list"]);
    await twinSparse(native, ours, ["set", "--stdin"], "/u/\n  spaced  \n\n/k/a\n");
    await twinSparse(native, ours, ["set"]);
  });

  it("set --stdin in cone mode unquotes and trims", async () => {
    const { native, ours } = twins(base);
    await twinSparse(native, ours, ["set", "--stdin"], '  k/sub  \n"s/t"\n\n');
    await twinSparse(native, ours, ["add", "--stdin"], "u\n");
  });

  it("refuses a file, a leading slash, `!` and glob characters in cone mode", async () => {
    const { native, ours } = twins(base);
    await twinSparse(native, ours, ["set", "k"]);
    for (const args of [
      ["set", "top"],
      ["set", "/k"],
      ["set", "!k"],
      ["set", "k*"],
      ["add", "k/a"],
    ]) {
      await twinSparse(native, ours, args);
    }
    await twinSparse(native, ours, ["add", "--skip-checks", "top"]);
  });

  it("warns about a single file in non-cone mode", async () => {
    const { native, ours } = twins(base);
    await twinSparse(native, ours, ["set", "--no-cone", "top", "/k/"]);
  });

  it("list, add and reapply outside a sparse checkout die", async () => {
    const { native, ours } = twins(base);
    await twinSparse(native, ours, ["list"]);
    await twinSparse(native, ours, ["add", "k"]);
    await twinSparse(native, ours, ["reapply"]);
    await twinSparse(native, ours, ["nope"]);
    await twinSparse(native, ours, ["set", "--nope"]);
  });

  it("a dirty file outside the new patterns stays, without the flag, with git's warning", async () => {
    const { native, ours } = twins(base);
    await twinSparse(native, ours, ["set", "k", "s"]);
    for (const dir of [native, ours]) put(dir, "s/c", "dirty\n");
    const { r } = await twinSparse(native, ours, ["set", "k"]);
    expect(r.stderr).toContain("The following paths are not up to date");
    // the change committed elsewhere: reapply takes the file out
    for (const dir of [native, ours]) put(dir, "s/c", "c\n");
    await twinSparse(native, ours, ["reapply"]);
  });

  it("an unmerged entry is left with git's warning", async () => {
    const { native, ours } = twins((dir) => {
      base(dir);
      gitOk(root, dir, "checkout", "-q", "-b", "side");
      put(dir, "s/c", "side\n");
      gitOk(root, dir, "commit", "-q", "-am", "side");
      gitOk(root, dir, "checkout", "-q", "main");
      put(dir, "s/c", "main\n");
      gitOk(root, dir, "commit", "-q", "-am", "main");
      run(dir, ["merge", "-q", "side"]);
    });
    await twinSparse(native, ours, ["set", "k"]);
  });

  it("check-rules: cone and non-cone rules, a rules file, -z", async () => {
    const { native, ours } = twins(base);
    await twinSparse(native, ours, ["set", "k"]);
    const paths = 'k/a\ns/c\ntop\n"k/sub/b"\nu/e\n';
    await twinSparse(native, ours, ["check-rules"], paths);
    await twinSparse(native, ours, ["check-rules", "-z"], "k/a\0s/c\0top\0");
    for (const dir of [native, ours]) put(dir, "rules", "s\nu/\n");
    await twinSparse(native, ours, ["check-rules", "--rules-file", "rules"], paths);
    for (const dir of [native, ours]) put(dir, "rules", "/s/\n!/s/t/\n");
    await twinSparse(
      native,
      ours,
      ["check-rules", "--no-cone", "--rules-file=rules"],
      `${paths}s/t/d\n`,
    );
  });

  it("init and set in a repository without commits write the file and config only", async () => {
    const { native, ours } = twins(() => {});
    await twinSparse(native, ours, ["init"]);
    await twinSparse(native, ours, ["set", "k"]);
    await twinSparse(native, ours, ["list"]);
  });

  it("--no-sparse-index records index.sparse=false; --sparse-index is refused", async () => {
    const { native, ours } = twins(base);
    await twinSparse(native, ours, ["set", "--no-sparse-index", "k"]);
    const result = await (await openOurs(ours))
      .sparseCheckout()
      .setArguments(["set", "--sparse-index", "k"])
      .call();
    expect(result.exitCode).toBe(128);
    expect(result.stderr).toBe("fatal: the sparse index is not supported\n");
  });

  it("the typed setters run as their command line", async () => {
    const { native, ours } = twins(base);
    run(native, ["sparse-checkout", "set", "--no-cone", "/k/", "/u/"]);
    const repo = await openOurs(ours);
    await repo
      .sparseCheckout()
      .setSubcommand("set")
      .setCone(false)
      .addPattern("/k/")
      .addPattern("/u/")
      .call();
    expect(state(ours)).toEqual(state(native));
    const listed = await (await openOurs(ours)).sparseCheckout().setSubcommand("list").call();
    expect(listed.stdout).toBe("/k/\n/u/\n");
    const checked = await (await openOurs(ours))
      .sparseCheckout()
      .setSubcommand("check-rules")
      .setStdin("k/a\ns/c\n")
      .call();
    expect(checked.stdout).toBe("k/a\n");
  });

  it("warns about patterns cone mode cannot read and falls back", async () => {
    const { native, ours } = twins(base);
    await twinSparse(native, ours, ["set", "k"]);
    for (const content of [
      "/*\n!/*/\n/k/\n*.md\n",
      "/*\n!/*/\n!/k/*/\n",
      "/*\n!/*/\n/k/\n!/k/\n",
      "/*\n!/*/\n/s/\n!/s/*/\n/s/\n",
    ]) {
      for (const dir of [native, ours]) put(dir, ".git/info/sparse-checkout", content);
      const { result } = await twinSparse(native, ours, ["list"]);
      expect(result.warnings).toContain("disabling cone pattern matching");
      await twinSparse(native, ours, ["reapply"]);
    }
  });
});

/** Runs native git and returns what it printed. */
function nativeOk(dir: string, ...args: string[]) {
  return run(dir, args);
}

/** k/ in the cone, then main moves on with files outside it. */
function sparseHistory(dir: string) {
  base(dir);
  gitOk(root, dir, "checkout", "-q", "-b", "other");
  put(dir, "n/x", "x\n");
  put(dir, "k/new", "new\n");
  put(dir, "s/c", "c2\n");
  gitOk(root, dir, "add", ".");
  gitOk(root, dir, "commit", "-q", "-m", "other");
  gitOk(root, dir, "checkout", "-q", "main");
  gitOk(root, dir, "sparse-checkout", "set", "k");
}

describeGit("index-writing commands in a sparse checkout against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sparse-commands-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Our checkout's warnings as git prints them (before "Switched to ..."). */
  const sparseLines = (stderr: string) =>
    stderr
      .split("\n")
      .filter(
        (l) => !/^(Switched|Your branch|HEAD is now|M\t|Already|Updating|Fast-forward)/.test(l),
      )
      .join("\n");

  it("checkout to a commit adding files outside the cone leaves them out", async () => {
    const { native, ours } = twins(sparseHistory);
    const r = nativeOk(native, "checkout", "-q", "other");
    const result = await (await openOurs(ours)).checkout().setName("other").call();
    expect(r.status).toBe(0);
    expect(result.warnings ?? []).toEqual([]);
    expect(state(ours)).toEqual(state(native));
    nativeOk(native, "checkout", "-q", "main");
    await (await openOurs(ours)).checkout().setName("main").call();
    expect(state(ours)).toEqual(state(native));
  });

  it("checkout keeps a dirty file outside the patterns with git's warning", async () => {
    const { native, ours } = twins((dir) => {
      sparseHistory(dir);
      put(dir, ".git/info/sparse-checkout", "/*\n!/*/\n/k/\n/u/\n");
      gitOk(root, dir, "sparse-checkout", "reapply");
      put(dir, ".git/info/sparse-checkout", "/*\n!/*/\n/k/\n");
    });
    for (const dir of [native, ours]) put(dir, "u/e", "dirty\n");
    const r = nativeOk(native, "checkout", "-q", "other");
    const result = await (await openOurs(ours)).checkout().setName("other").call();
    expect(sparseLines(r.stderr)).toContain("not up to date");
    expect(`${(result.warnings ?? []).join("\n")}\n`).toBe(sparseLines(r.stderr));
    expect(state(ours)).toEqual(state(native));
  });

  it("checkout writes the entries that come back into the patterns", async () => {
    const { native, ours } = twins(sparseHistory);
    for (const dir of [native, ours])
      put(dir, ".git/info/sparse-checkout", "/*\n!/*/\n/k/\n/n/\n/s/\n");
    nativeOk(native, "checkout", "-q", "other");
    await (await openOurs(ours)).checkout().setName("other").call();
    expect(state(ours)).toEqual(state(native));
  });

  it("checkout and reset --hard print the patterns' warnings", async () => {
    const { native, ours } = twins(sparseHistory);
    for (const dir of [native, ours])
      put(dir, ".git/info/sparse-checkout", "/*\n!/*/\n/k/\n*.md\n");
    const r = nativeOk(native, "checkout", "-q", "other");
    const result = await (await openOurs(ours)).checkout().setName("other").call();
    // git reads the patterns again for each index it builds while switching (the result's,
    // a written file's refresh), repeating the warnings; ours prints them once
    const once =
      "warning: unrecognized pattern: '*.md'\nwarning: disabling cone pattern matching\n";
    expect(r.stderr.split(once).join("")).toBe("");
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(`${(result.warnings ?? []).join("\n")}\n`).toBe(once);
    expect(state(ours)).toEqual(state(native));
    const reset = nativeOk(native, "reset", "-q", "--hard", "main");
    const cmd = (await openOurs(ours)).reset().setMode(ResetMode.HARD).setRef("main");
    await cmd.call();
    expect(`${cmd.getWarnings().join("\n")}\n`).toBe(reset.stderr);
    expect(state(ours)).toEqual(state(native));
  });

  it("reset --hard applies the patterns", async () => {
    const { native, ours } = twins(sparseHistory);
    nativeOk(native, "reset", "-q", "--hard", "other");
    await (await openOurs(ours)).reset().setMode(ResetMode.HARD).setRef("other").call();
    expect(state(ours)).toEqual(state(native));
    for (const dir of [native, ours]) put(dir, ".git/info/sparse-checkout", "/*\n!/*/\n/n/\n");
    nativeOk(native, "reset", "-q", "--hard", "main");
    await (await openOurs(ours)).reset().setMode(ResetMode.HARD).setRef("main").call();
    expect(state(ours)).toEqual(state(native));
  });

  it("reset --merge and --keep print git's per-path errors for a dirty file", async () => {
    const { native, ours } = twins((dir) => {
      sparseHistory(dir);
      put(dir, ".git/info/sparse-checkout", "/*\n!/*/\n/k/\n/u/\n");
      gitOk(root, dir, "sparse-checkout", "reapply");
      put(dir, ".git/info/sparse-checkout", "/*\n!/*/\n/k/\n");
    });
    for (const dir of [native, ours]) put(dir, "u/e", "dirty\n");
    for (const mode of [ResetMode.MERGE, ResetMode.KEEP]) {
      const target = mode === ResetMode.MERGE ? "other" : "main";
      const r = nativeOk(
        native,
        "reset",
        `--${mode === ResetMode.MERGE ? "merge" : "keep"}`,
        target,
      );
      const cmd = (await openOurs(ours)).reset().setMode(mode).setRef(target);
      await cmd.call();
      expect(`${cmd.getWarnings().join("\n")}\n`).toBe(r.stderr);
      expect(state(ours)).toEqual(state(native));
    }
  });

  it("a merge with a conflict outside the cone writes the conflicted file", async () => {
    const { native, ours } = twins((dir) => {
      base(dir);
      gitOk(root, dir, "checkout", "-q", "-b", "side");
      put(dir, "s/c", "side\n");
      put(dir, "u/new", "new\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-q", "-m", "side");
      gitOk(root, dir, "checkout", "-q", "main");
      put(dir, "s/c", "main\n");
      put(dir, "k/a", "a2\n");
      gitOk(root, dir, "commit", "-q", "-am", "main");
      gitOk(root, dir, "sparse-checkout", "set", "k");
    });
    const r = nativeOk(native, "merge", "side");
    expect(r.status).toBe(1);
    const result = await (await openOurs(ours)).merge().include("side").call();
    expect(result.conflicts).toEqual(["s/c"]);
    expect(state(ours)).toEqual(state(native));
  });

  it("cherry-pick of a commit touching files outside the cone", async () => {
    const { native, ours } = twins(sparseHistory);
    nativeOk(native, "cherry-pick", "other");
    const repo: Git = await openOurs(ours, INTEROP_AUTHOR_ENV);
    const other = gitOk(root, ours, "rev-parse", "other").trim();
    await repo.cherryPick().setCommitter(INTEROP_IDENT).include(other).call();
    expect(state(ours)).toEqual(state(native));
  });

  it("diff and status read present files as in the checkout without writing the index", async () => {
    const { native, ours } = twins(sparseHistory);
    for (const dir of [native, ours]) put(dir, "s/c", "back\n");
    const before = readFileSync(join(ours, ".git/index"));
    const result = await (await openOurs(ours)).diff().call();
    expect(result.map((e) => e.newPath ?? e.oldPath)).toEqual(["s/c"]);
    expect(Buffer.compare(readFileSync(join(ours, ".git/index")), before)).toBe(0);
  });

  it("rm refuses paths outside the patterns with git's advice; --sparse removes them", async () => {
    const { native, ours } = twins(sparseHistory);
    const r = nativeOk(native, "rm", "-q", "s/c");
    let error: Error | undefined;
    try {
      await (await openOurs(ours)).rm().addFilepattern("s/c").setCompatibility(version).call();
    } catch (e) {
      error = e as Error;
    }
    expect(r.status).toBe(1);
    expect(error?.message).toBe(r.stderr.trim());
    expect(state(ours)).toEqual(state(native));
    nativeOk(native, "rm", "-q", "--sparse", "--cached", "s/c");
    await (await openOurs(ours)).rm().addFilepattern("s/c").setSparse(true).setCached(true).call();
    expect(state(ours)).toEqual(state(native));
  });
});
