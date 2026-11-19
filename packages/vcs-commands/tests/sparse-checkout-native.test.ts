/**
 * `git sparse-checkout` and the sparse checkout of index-writing commands against native
 * git: each case builds the same repository twice with native git, runs native git in one
 * twin and ours in the other, then compares the worktree, the index with its flags
 * (`ls-files -t`), the sparse-checkout file's bytes, `config` and `config.worktree`, and
 * what both printed (stdout, stderr, exit status).
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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

/**
 * The index flags as stored (`core.sparseCheckout` off, so reading clears none on present
 * files), taken before `state` (whose `git status` may write the index), then the rest.
 */
function rawState(dir: string) {
  const rawFlags = gitOk(root, dir, "-c", "core.sparseCheckout=false", "ls-files", "-t", "--stage");
  return { rawFlags, ...state(dir) };
}

/** What a command printed on stderr, as our warnings give it. */
const warningText = (warnings: readonly string[] | undefined) =>
  warnings && warnings.length > 0 ? `${warnings.join("\n")}\n` : "";

/**
 * u/e racily clean in a cone of k and u, then changed behind a matching stat, then the
 * sparse-checkout file narrowed to k (git's `ie_match_stat` must read the file to see it).
 */
function racyOutside(dir: string) {
  gitOk(root, dir, "sparse-checkout", "set", "k", "u");
  // the stat and the index's time in one second, the edit in the same (ctime included)
  // (well inside a second: the filesystem's coarse clock lags Date.now by a few ms)
  while (Date.now() % 1000 < 50 || Date.now() % 1000 > 400) {
    // wait for the start of a second
  }
  const t = Math.floor(Date.now() / 1000);
  utimesSync(join(dir, "u/e"), t, t);
  gitOk(root, dir, "update-index", "-q", "--refresh");
  put(dir, "u/e", "E\n");
  utimesSync(join(dir, "u/e"), t, t);
  utimesSync(join(dir, ".git/index"), t, t);
  put(dir, ".git/info/sparse-checkout", "/*\n!/*/\n/k/\n");
  // the command runs in a later second: the index it writes no longer finds u/e racy
  while (Math.floor(Date.now() / 1000) <= t) {
    // wait for the next second
  }
}

describeGit("sparse checkout without losing files, against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sparse-keep-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("expectFilesOutsideOfPatterns: checkout keeps a changed skip-worktree file", async () => {
    const { native, ours } = twins((dir) => {
      sparseHistory(dir);
      gitOk(root, dir, "config", "sparse.expectFilesOutsideOfPatterns", "true");
    });
    for (const dir of [native, ours]) put(dir, "u/e", "dirty\n");
    const r = run(native, ["checkout", "-q", "other"]);
    const result = await (await openOurs(ours)).checkout().setName("other").call();
    expect(warningText(result.warnings)).toBe(r.stderr);
    expect(rawState(ours)).toEqual(rawState(native));
    expect(readFileSync(join(ours, "u/e"), "utf8")).toBe("dirty\n");
  });

  it("expectFilesOutsideOfPatterns: reset --hard HEAD keeps a changed skip-worktree file", async () => {
    const { native, ours } = twins((dir) => {
      sparseHistory(dir);
      gitOk(root, dir, "config", "sparse.expectFilesOutsideOfPatterns", "true");
    });
    for (const dir of [native, ours]) put(dir, "u/e", "dirty\n");
    const r = run(native, ["reset", "-q", "--hard", "HEAD"]);
    const cmd = (await openOurs(ours)).reset().setMode(ResetMode.HARD).setRef("HEAD");
    await cmd.call();
    expect(warningText(cmd.getWarnings())).toBe(r.stderr);
    expect(rawState(ours)).toEqual(rawState(native));
    expect(readFileSync(join(ours, "u/e"), "utf8")).toBe("dirty\n");
  });

  for (const op of ["checkout -f", "reset --hard", "checkout", "merge"] as const) {
    it(`${op}: an untracked file where a new entry outside the patterns lands is kept`, async () => {
      const { native, ours } = twins(sparseHistory);
      for (const dir of [native, ours]) put(dir, "n/x", "mine\n");
      const repo = await openOurs(ours, INTEROP_AUTHOR_ENV);
      let r: ReturnType<typeof run>;
      let warnings: readonly string[] | undefined;
      if (op === "checkout -f" || op === "checkout") {
        r = run(native, ["checkout", "-q", ...(op === "checkout -f" ? ["-f"] : []), "other"]);
        const result = await repo
          .checkout()
          .setName("other")
          .setForced(op === "checkout -f")
          .call();
        expect(result.message).toBeUndefined();
        warnings = result.warnings;
      } else if (op === "reset --hard") {
        r = run(native, ["reset", "-q", "--hard", "other"]);
        const cmd = repo.reset().setMode(ResetMode.HARD).setRef("other");
        await cmd.call();
        warnings = cmd.getWarnings();
      } else {
        r = run(native, ["merge", "-q", "other"]);
        const result = await repo.merge().include("other").call();
        warnings = result.warnings;
      }
      expect(r.status).toBe(0);
      expect(warningText(warnings)).toBe(r.stderr);
      expect(rawState(ours)).toEqual(rawState(native));
      expect(readFileSync(join(ours, "n/x"), "utf8")).toBe("mine\n");
    });
  }

  for (const op of ["checkout", "reset --hard"] as const) {
    it(`${op}: an ignored file where a new entry outside the patterns lands is kept`, async () => {
      const { native, ours } = twins((dir) => {
        sparseHistory(dir);
        put(dir, ".git/info/exclude", "x\n");
      });
      for (const dir of [native, ours]) put(dir, "n/x", "mine\n");
      const repo = await openOurs(ours);
      if (op === "checkout") {
        run(native, ["checkout", "-q", "other"]);
        await repo.checkout().setName("other").call();
      } else {
        run(native, ["reset", "-q", "--hard", "other"]);
        await repo.reset().setMode(ResetMode.HARD).setRef("other").call();
      }
      expect(rawState(ours)).toEqual(rawState(native));
      expect(readFileSync(join(ours, "n/x"), "utf8")).toBe("mine\n");
    });
  }

  for (const op of ["merge", "cherry-pick", "reset --merge", "reset --keep"] as const) {
    it(`${op}: a racily clean changed file leaving the patterns is kept`, async () => {
      const { native, ours } = twins(sparseHistory);
      for (const dir of [native, ours]) racyOutside(dir);
      const repo = await openOurs(ours, INTEROP_AUTHOR_ENV);
      let r: ReturnType<typeof run>;
      let warnings: readonly string[] | undefined;
      if (op === "merge") {
        r = run(native, ["merge", "-q", "other"]);
        warnings = (await repo.merge().include("other").call()).warnings;
      } else if (op === "cherry-pick") {
        r = run(native, ["cherry-pick", "other"]);
        const other = gitOk(root, ours, "rev-parse", "other").trim();
        warnings = (await repo.cherryPick().setCommitter(INTEROP_IDENT).include(other).call())
          .warnings;
      } else {
        const mode = op === "reset --merge" ? ResetMode.MERGE : ResetMode.KEEP;
        r = run(native, ["reset", op.slice(6), "other"]);
        const cmd = repo.reset().setMode(mode).setRef("other");
        await cmd.call();
        warnings = cmd.getWarnings();
      }
      expect(r.stderr).toContain("u/e");
      expect(warningText(warnings)).toBe(r.stderr);
      expect(rawState(ours)).toEqual(rawState(native));
      expect(readFileSync(join(ours, "u/e"), "utf8")).toBe("E\n");
    });
  }

  it("set in cone mode removes directories left with ignored files only, warns about untracked", async () => {
    const { native, ours } = twins((dir) => {
      base(dir);
      put(dir, ".git/info/exclude", "*.log\n");
      gitOk(root, dir, "sparse-checkout", "set", "k", "s", "u");
    });
    for (const dir of [native, ours]) {
      put(dir, "s/t/untracked", "mine\n");
      put(dir, "u/sub/build.log", "log\n");
      put(dir, "u/trace.log", "log\n");
    }
    const { r } = await twinSparse(native, ours, ["set", "k"]);
    expect(r.stderr).toContain("contains untracked files");
    expect(rawState(ours)).toEqual(rawState(native));
    // non-cone patterns clean nothing
    for (const dir of [native, ours]) put(dir, "s/t/x.log", "log\n");
    await twinSparse(native, ours, ["set", "--no-cone", "/k/"]);
    expect(rawState(ours)).toEqual(rawState(native));
  });

  it("set keeps files reached through a symlinked directory, with git's warning", async () => {
    const { native, ours } = twins(base);
    for (const dir of [native, ours]) {
      const outside = `${dir}-outside`;
      mkdirSync(join(outside, "t"), { recursive: true });
      put(outside, "c", "c\n");
      put(outside, "t/d", "d\n");
      rmSync(join(dir, "s"), { recursive: true, force: true });
      symlinkSync(`../${basename(dir)}-outside`, join(dir, "s"));
    }
    const r = run(native, ["sparse-checkout", "set", "k"]);
    const result = await (await openOurs(ours))
      .sparseCheckout()
      .setArguments(["set", "k"])
      .setCompatibility(version)
      .call();
    expect(result.stderr).toBe(r.stderr);
    expect(r.stderr).toContain("not up to date");
    const twin = (dir: string) =>
      JSON.parse(JSON.stringify(rawState(dir)).split(basename(dir)).join("<twin>"));
    expect(twin(ours)).toEqual(twin(native));
    for (const dir of [native, ours]) {
      expect(readFileSync(`${dir}-outside/c`, "utf8")).toBe("c\n");
      expect(readFileSync(`${dir}-outside/t/d`, "utf8")).toBe("d\n");
      expect(statSync(`${dir}-outside/t`).isDirectory()).toBe(true);
    }
  });
});

describeGit("sparse checkout and ignore rules, against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sparse-ignore-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A tracked root `.gitignore` of `*.tmp`, and `s/.gitignore` with `extra`. */
  const ignoring = (extra: string) => (dir: string) => {
    base(dir);
    put(dir, ".gitignore", "*.tmp\n");
    put(dir, "s/.gitignore", extra);
    gitOk(root, dir, "add", ".");
    gitOk(root, dir, "commit", "-q", "-m", "ignores");
    gitOk(root, dir, "sparse-checkout", "set", "k", "s", "u");
  };

  it("set keeps a file a removed skip-worktree .gitignore un-ignores (read from the index)", async () => {
    const { native, ours } = twins(ignoring("!keep.tmp\n"));
    for (const dir of [native, ours]) put(dir, "s/keep.tmp", "PRECIOUS\n");
    const { r } = await twinSparse(native, ours, ["set", "k"]);
    expect(r.stderr).toContain("directory 's/' contains untracked files");
    expect(rawState(ours)).toEqual(rawState(native));
    expect(readFileSync(join(ours, "s/keep.tmp"), "utf8")).toBe("PRECIOUS\n");
    // status, add and clean read the same rules from the index
    const status = (dir: string) =>
      gitOk(root, dir, "--no-optional-locks", "status", "--porcelain", "--ignored");
    expect(status(ours)).toContain("?? s/");
    const repo = await openOurs(ours);
    const ourStatus = await repo.status().call();
    expect([...ourStatus.untracked]).toContain("s/keep.tmp");
  });

  it("set removes a file only a removed skip-worktree .gitignore ignores", async () => {
    const { native, ours } = twins(ignoring("*.junk\n"));
    for (const dir of [native, ours]) put(dir, "s/t/x.junk", "junk\n");
    const { r } = await twinSparse(native, ours, ["set", "k"]);
    expect(r.stderr).toBe("");
    expect(existsSync(join(ours, "s"))).toBe(false);
    expect(rawState(ours)).toEqual(rawState(native));
  });

  /** k only, expectFilesOutsideOfPatterns, `c` and `*.log` ignored through info/exclude. */
  const expecting = (dir: string) => {
    put(dir, "k/a", "a\n");
    put(dir, "s/c", "c\n");
    put(dir, "s/d", "d\n");
    gitOk(root, dir, "add", ".");
    gitOk(root, dir, "commit", "-q", "-m", "c");
    put(dir, ".git/info/exclude", "c\n*.log\n");
    gitOk(root, dir, "sparse-checkout", "set", "k");
    gitOk(root, dir, "config", "sparse.expectFilesOutsideOfPatterns", "true");
  };

  for (const [name, path] of [
    ["an ignored file", "s/c"],
    ["a directory holding an ignored file", "s/d/x.log"],
  ] as const) {
    it(`add keeps ${name} where a skip-worktree entry comes back (update_sparsity)`, async () => {
      const { native, ours } = twins(expecting);
      for (const dir of [native, ours]) put(dir, path, "IGNORED MINE\n");
      await twinSparse(native, ours, ["add", "s"]);
      expect(rawState(ours)).toEqual(rawState(native));
      expect(readFileSync(join(ours, path), "utf8")).toBe("IGNORED MINE\n");
    });
  }

  for (const op of ["checkout", "merge"] as const) {
    for (const [name, path] of [
      ["an ignored file", "s/c"],
      ["a directory holding an untracked file", "s/c/mine"],
    ] as const) {
      it(`${op} with ${name} where an entry returns into the patterns`, async () => {
        const { native, ours } = twins((dir) => {
          base(dir);
          gitOk(root, dir, "checkout", "-q", "-b", "other");
          put(dir, "k/a", "other\n");
          gitOk(root, dir, "commit", "-qam", "o");
          gitOk(root, dir, "checkout", "-q", "main");
          put(dir, ".git/info/exclude", "c\n");
          gitOk(root, dir, "sparse-checkout", "set", "k");
          gitOk(root, dir, "config", "sparse.expectFilesOutsideOfPatterns", "true");
          put(dir, ".git/info/sparse-checkout", "/*\n!/*/\n/k/\n/s/\n");
        });
        for (const dir of [native, ours]) put(dir, path, "MINE\n");
        const repo = await openOurs(ours, INTEROP_AUTHOR_ENV);
        let r: ReturnType<typeof run>;
        let warnings: readonly string[] | undefined;
        if (op === "checkout") {
          r = run(native, ["checkout", "-q", "other"]);
          warnings = (await repo.checkout().setName("other").call()).warnings;
        } else {
          r = run(native, ["merge", "-q", "other"]);
          warnings = (await repo.merge().include("other").call()).warnings;
        }
        // an ignored file is overwritten; a directory is ERROR_NOT_UPTODATE_DIR, never printed
        expect(r.stderr).toBe("");
        expect(warningText(warnings)).toBe(r.stderr);
        expect(rawState(ours)).toEqual(rawState(native));
      });
    }
  }
});

describeGit(
  "forced one-way resets record the stat of the files they write, against native git",
  () => {
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "sparse-stat-"));
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    const diffFiles = (dir: string) =>
      gitOk(root, dir, "--no-optional-locks", "diff-files", "--name-only");

    for (const sparseOn of [false, true]) {
      for (const op of ["checkout -f", "reset --hard"] as const) {
        it(`${op}${sparseOn ? " in a sparse checkout" : ""}: diff-files lists nothing after`, async () => {
          const { native, ours } = twins((dir) => {
            sparseHistory(dir);
            if (!sparseOn) gitOk(root, dir, "sparse-checkout", "disable");
          });
          for (const dir of [native, ours]) put(dir, "k/a", "DIRTY\n");
          const repo = await openOurs(ours);
          if (op === "checkout -f") {
            run(native, ["checkout", "-q", "-f", "other"]);
            await repo.checkout().setName("other").setForced(true).call();
          } else {
            run(native, ["reset", "-q", "--hard", "other"]);
            await repo.reset().setMode(ResetMode.HARD).setRef("other").call();
          }
          expect(diffFiles(native)).toBe("");
          expect(diffFiles(ours)).toBe(diffFiles(native));
          // a narrower cone then removes the rewritten files (none is "not up to date")
          await twinSparse(native, ours, ["set", "s"]);
          expect(rawState(ours)).toEqual(rawState(native));
        });
      }
    }
  },
);

describeGit("conflicts leaving the sparse checkout, against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "sparse-conflict-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** s/c changed on main and other; k and s checked out, then the patterns narrowed to k. */
  const conflicting = (wasSkip: boolean) => (dir: string) => {
    put(dir, "k/a", "a\n");
    put(dir, "s/c", "c\n1\n");
    put(dir, "s/d", "d\n");
    gitOk(root, dir, "add", ".");
    gitOk(root, dir, "commit", "-q", "-m", "base");
    gitOk(root, dir, "checkout", "-q", "-b", "other");
    put(dir, "s/c", "OTHER\n1\n");
    gitOk(root, dir, "commit", "-qam", "o");
    gitOk(root, dir, "checkout", "-q", "main");
    put(dir, "s/c", "MAIN\n1\n");
    gitOk(root, dir, "commit", "-qam", "m");
    gitOk(root, dir, "sparse-checkout", "set", "k", "s");
    if (wasSkip) gitOk(root, dir, "sparse-checkout", "set", "k");
    else put(dir, ".git/info/sparse-checkout", "/*\n!/*/\n/k/\n");
  };

  for (const wasSkip of [false, true]) {
    for (const op of ["merge", "cherry-pick"] as const) {
      it(`${op}: a conflicted entry ${wasSkip ? "outside the checkout is written" : "leaving the checkout is unlinked"}`, async () => {
        const { native, ours } = twins(conflicting(wasSkip));
        const repo = await openOurs(ours, INTEROP_AUTHOR_ENV);
        if (op === "merge") {
          expect(run(native, ["merge", "-q", "other"]).status).toBe(1);
          expect((await repo.merge().include("other").call()).conflicts).toEqual(["s/c"]);
        } else {
          expect(run(native, ["cherry-pick", "other"]).status).toBe(1);
          const other = gitOk(root, ours, "rev-parse", "other").trim();
          await repo.cherryPick().setCommitter(INTEROP_IDENT).include(other).call();
        }
        expect(existsSync(join(native, "s/c"))).toBe(wasSkip);
        expect(rawState(ours)).toEqual(rawState(native));
      });
    }
  }
});

describeGit(
  "leaving the sparse checkout where git cannot unlink or look, against native git",
  () => {
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "sparse-unlink-"));
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    /** k only, main and other differing in k/a, s/c's path taken by a directory. */
    const dirAtLeaving = (dir: string) => {
      base(dir);
      gitOk(root, dir, "checkout", "-q", "-b", "other");
      put(dir, "k/a", "other\n");
      gitOk(root, dir, "commit", "-qam", "o");
      gitOk(root, dir, "checkout", "-q", "main");
      gitOk(root, dir, "sparse-checkout", "set", "k");
    };

    for (const op of ["checkout -f", "reset --hard"] as const) {
      it(`${op}: a directory where a file leaves is kept with git's unlink warning`, async () => {
        const { native, ours } = twins(dirAtLeaving);
        for (const dir of [native, ours]) put(dir, "s/c/j.o", "IGN\n");
        const repo = await openOurs(ours);
        let r: ReturnType<typeof run>;
        let warnings: readonly string[] | undefined;
        if (op === "checkout -f") {
          r = run(native, ["checkout", "-q", "-f", "main"]);
          warnings = (await repo.checkout().setName("main").setForced(true).call()).warnings;
        } else {
          r = run(native, ["reset", "-q", "--hard", "HEAD"]);
          const cmd = repo.reset().setMode(ResetMode.HARD).setRef("HEAD");
          await cmd.call();
          warnings = cmd.getWarnings();
        }
        expect(r.stderr).toBe("warning: unable to unlink 's/c': Is a directory\n");
        expect(warningText(warnings)).toBe(r.stderr);
        expect(rawState(ours)).toEqual(rawState(native));
      });
    }

    it("a refused merge's reset warns about a directory where a file outside the patterns is", async () => {
      const { native, ours } = twins((dir) => {
        base(dir);
        gitOk(root, dir, "checkout", "-q", "-b", "other");
        put(dir, "s/c", "c-other\n");
        gitOk(root, dir, "commit", "-qam", "o");
        gitOk(root, dir, "checkout", "-q", "main");
        // a real merge (a fast-forward refuses before any strategy runs)
        put(dir, "k/a", "a-main\n");
        gitOk(root, dir, "commit", "-qam", "m");
        put(dir, ".git/info/exclude", "*.o\n");
        gitOk(root, dir, "sparse-checkout", "set", "k");
      });
      for (const dir of [native, ours]) put(dir, "s/c/j.o", "J\n");
      const r = run(native, ["merge", "-q", "other"]);
      const repo = await openOurs(ours, INTEROP_AUTHOR_ENV);
      const result = await repo.merge().include("other").call();
      expect(r.stderr).toContain("warning: unable to unlink 's/c': Is a directory\n");
      expect(`${result.message}\n`).toBe(r.stderr);
      expect(rawState(ours)).toEqual(rawState(native));
    });

    for (const op of ["checkout", "reset --merge"] as const) {
      it(`${op}: a changed file reached through a symlinked directory refuses the switch`, async () => {
        const { native, ours } = twins((dir) => {
          base(dir);
          gitOk(root, dir, "checkout", "-q", "-b", "other");
          put(dir, "s/c", "c-other\n");
          gitOk(root, dir, "commit", "-qam", "o");
          gitOk(root, dir, "checkout", "-q", "main");
          gitOk(root, dir, "sparse-checkout", "set", "k", "s");
          put(dir, ".git/info/sparse-checkout", "/*\n!/*/\n/k/\n");
        });
        for (const dir of [native, ours]) {
          const ext = `${dir}-ext`;
          mkdirSync(join(ext, "t"), { recursive: true });
          put(ext, "c", "c\n");
          put(ext, "t/d", "d\n");
          rmSync(join(dir, "s"), { recursive: true, force: true });
          symlinkSync(ext, join(dir, "s"));
        }
        const repo = await openOurs(ours);
        let r: ReturnType<typeof run>;
        if (op === "checkout") {
          r = run(native, ["checkout", "-q", "other"]);
          const result = await repo.checkout().setName("other").call();
          expect(result.message).toBe(r.stderr.trim());
        } else {
          r = run(native, ["reset", "-q", "--merge", "other"]);
          await expect(
            repo.reset().setMode(ResetMode.MERGE).setRef("other").call(),
          ).rejects.toThrow(r.stderr.split("\n")[0] as string);
        }
        expect(r.status).not.toBe(0);
        const twin = (dir: string) =>
          JSON.parse(JSON.stringify(rawState(dir)).split(basename(dir)).join("<twin>"));
        expect(twin(ours)).toEqual(twin(native));
        for (const dir of [native, ours]) expect(readFileSync(`${dir}-ext/c`, "utf8")).toBe("c\n");
      });
    }
  },
);
