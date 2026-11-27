/**
 * `git rm -n`/`--dry-run`, `-q`/`--quiet` and `--sparse` against native git (builtin/rm.c):
 * the `rm '<path>'` lines git prints (one per index entry, stages included; none with `-q`),
 * nothing changed by a dry run, and entries outside the sparse checkout (cone and non-cone
 * patterns, sparse index on and off) refused with git's advice unless `--sparse`.
 *
 * Sources: t3600-rm.sh ("rm" command printed, suppressed with --quiet, rm --dry-run),
 * t3602-rm-sparse-checkout.sh.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { RmResult } from "../src/commands/rm-command.js";
import { RmFailedError } from "../src/errors/index.js";
import { git, gitOk, openOurs, put, snapshot } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

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

function run(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, env: nativeGitEnv(root), encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The same repository twice, built by `build` with native git. */
function twins(build: (dir: string) => void): { native: string; ours: string } {
  const n = counter++;
  const out = { native: join(root, `n${n}`), ours: join(root, `o${n}`) };
  for (const dir of [out.native, out.ours]) {
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    build(dir);
  }
  return out;
}

/** git's command-line flags as our setters. */
async function ourRm(dir: string, args: string[]) {
  const cmd = (await openOurs(dir)).rm().setCompatibility(version);
  let options = true;
  for (const a of args) {
    if (options && a === "--") options = false;
    else if (options && (a === "-n" || a === "--dry-run")) cmd.setDryRun(true);
    else if (options && (a === "-q" || a === "--quiet")) cmd.setQuiet(true);
    else if (options && a === "--sparse") cmd.setSparse(true);
    else if (options && a === "-r") cmd.setRecursive(true);
    else if (options && a === "-f") cmd.setForce(true);
    else if (options && a === "--cached") cmd.setCached(true);
    else if (options && a === "--ignore-unmatch") cmd.setIgnoreUnmatch(true);
    else cmd.addFilepattern(a);
  }
  try {
    const result = await cmd.call();
    return { status: 0, stdout: result.output, stderr: (result.advice ?? []).join("\n") };
  } catch (e) {
    if (!(e instanceof RmFailedError)) throw e;
    const result = e.result as RmResult | undefined;
    return { status: e.exitCode, stdout: result?.output ?? [], stderr: e.message };
  }
}

/** Index (with skip-worktree flags and sparse directories), worktree, status. */
function view(dir: string) {
  return {
    ...snapshot(root, dir),
    flags: gitOk(root, dir, "ls-files", "-t"),
    sparse: gitOk(root, dir, "ls-files", "--sparse", "-s"),
  };
}

/** Native `git <args>` in one twin, ours in the other: same exit, output, index and files. */
async function both(twin: { native: string; ours: string }, args: string[]) {
  const r = run(twin.native, ["rm", ...args]);
  const ours = await ourRm(twin.ours, args);
  expect(ours.stderr).toBe(r.stderr.trim());
  expect(ours.stdout.join("\n")).toBe(r.stdout.trim());
  expect(ours.status).toBe(r.status);
  expect(view(twin.ours)).toEqual(view(twin.native));
}

/** a, b, c, in/f, out/f and out/deep/g committed. */
function files(dir: string) {
  for (const path of ["a", "b", "c", "in/f", "out/f", "out/deep/g"]) put(dir, path, `${path}\n`);
  gitOk(root, dir, "add", ".");
  gitOk(root, dir, "commit", "-q", "-m", "files");
}

describeGit("git rm -n and -q against native git (t3600-rm)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rm-flags-"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  const cases: string[][] = [
    ["a"], // t3600-rm.sh: '"rm" command printed'
    ["a", "b"],
    ["-q", "a", "b"],
    ["--quiet", "-r", "in"], // t3600-rm.sh: '"rm" command suppressed with --quiet'
    ["-n", "a", "b"],
    ["--dry-run", "-r", "."],
    ["-n", "-q", "a"],
    ["-n", "--cached", "a"],
    ["-r", "out"],
    ["-n", "nothing"],
    ["-n", "--ignore-unmatch", "nothing", "c"],
  ];
  for (const args of cases) {
    it(`rm ${args.join(" ")}`, async () => {
      await both(twins(files), args);
    });
  }

  it("rm -n refuses local modifications as rm does, changing nothing", async () => {
    const twin = twins((dir) => {
      files(dir);
      put(dir, "a", "changed\n");
    });
    await both(twin, ["-n", "a", "b"]);
    await both(twin, ["-n", "-f", "a", "b"]);
  });

  it("prints one line per stage of an unmerged path", async () => {
    const twin = twins((dir) => {
      put(dir, "c", "base\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-q", "-m", "c");
      gitOk(root, dir, "checkout", "-q", "-b", "side");
      put(dir, "c", "side\n");
      gitOk(root, dir, "commit", "-q", "-am", "s");
      gitOk(root, dir, "checkout", "-q", "main");
      put(dir, "c", "main\n");
      gitOk(root, dir, "commit", "-q", "-am", "m");
      git(root, dir, "merge", "side");
    });
    await both(twin, ["-n", "c"]);
    await both(twin, ["c"]);
  });
});

describeGit("git rm --sparse against native git (t3602-rm-sparse-checkout)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rm-sparse-"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  for (const sparseIndex of [false, true]) {
    const cone = (dir: string) => {
      files(dir);
      gitOk(root, dir, "config", "index.sparse", String(sparseIndex));
      gitOk(root, dir, "sparse-checkout", "set", "--cone", "in");
    };
    const label = `cone, sparse index ${sparseIndex ? "on" : "off"}`;
    // each case with the runs that follow it in the same repository
    const runs: string[][][] = [
      [["out/f"], ["--sparse", "out/f"]],
      [
        ["-n", "out/f"],
        ["-n", "--sparse", "out/f"],
      ],
      [["-f", "out/f"]],
      [
        ["-r", "out"],
        ["--sparse", "-r", "out"],
      ], // t3602-rm-sparse-checkout.sh: "recursive rm does not remove sparse entries"
      [["-n", "--sparse", "-r", "out"]], // t3602-rm-sparse-checkout.sh: "recursive rm --sparse removes sparse entries"
      [["out/f", "a"]],
      [["-r", "."]],
      [["--sparse", "-r", "."]],
      [["--ignore-unmatch", "out/f"]], // t3602-rm-sparse-checkout.sh: "do not warn about sparse entries with --ignore-unmatch"
      [["nonexistent"]], // t3602-rm-sparse-checkout.sh: "do not advice about sparse entries when they do not match the pathspec"
      [["out/*"], ["--sparse", "out/*"]],
      [["--sparse", "out"]],
      [["--sparse", "out/"]],
      [["--sparse", "out/f*"]],
      [["--sparse", "-r", "o*"]],
      [["--sparse", "-q", "-r", "out", "a"]],
    ];
    for (const sequence of runs) {
      it(`${label}: ${sequence.map((a) => `rm ${a.join(" ")}`).join(", then ")}`, async () => {
        const twin = twins(cone);
        for (const args of sequence) await both(twin, args);
      });
    }

    it(`${label}: an untracked file in a sparse directory`, async () => {
      const twin = twins((dir) => {
        cone(dir);
        put(dir, "out/new", "new\n");
      });
      await both(twin, ["-n", "--sparse", "-r", "out"]);
      await both(twin, ["--sparse", "-r", "out"]);
    });

    it(`${label}: a file outside the cone that is no skip-worktree entry`, async () => {
      const twin = twins((dir) => {
        cone(dir);
        gitOk(root, dir, "sparse-checkout", "set", "--cone", "in", "out");
        gitOk(root, dir, "sparse-checkout", "set", "--cone", "in");
        put(dir, "out/f", "out/f\n");
        gitOk(root, dir, "update-index", "--no-skip-worktree", "out/f");
      });
      await both(twin, ["out/f"]);
      await both(twin, ["--sparse", "out/f"]);
    });
  }

  const noCone = (patterns: string[]) => (dir: string) => {
    files(dir);
    gitOk(root, dir, "sparse-checkout", "set", "--no-cone", ...patterns);
  };
  const refusals: [string[], string][] = [
    [[], 't3602-rm-sparse-checkout.sh: "rm does not remove sparse entries"'],
    [["-f"], 't3602-rm-sparse-checkout.sh: "rm -f does not remove sparse entries"'],
    [["--dry-run"], 't3602-rm-sparse-checkout.sh: "rm --dry-run does not remove sparse entries"'],
  ];
  for (const [opt, name] of refusals) {
    it(name, async () => {
      await both(twins(noCone(["a"])), [...opt, "b"]);
    });
  }

  it('t3602-rm-sparse-checkout.sh: "rm obeys advice.updateSparsePath"', async () => {
    const twin = twins((dir) => {
      noCone(["a"])(dir);
      gitOk(root, dir, "config", "advice.updateSparsePath", "false");
    });
    await both(twin, ["b"]);
  });

  it('t3602-rm-sparse-checkout.sh: "do not warn about sparse entries when pathspec matches dense entries"', async () => {
    await both(twins(noCone(["a"])), ["[ba]"]);
  });

  it('t3602-rm-sparse-checkout.sh: "refuse to rm a non-skip-worktree path outside sparse cone"', async () => {
    const twin = twins((dir) => {
      noCone(["a"])(dir);
      put(dir, "b", "b\n");
      gitOk(root, dir, "update-index", "--no-skip-worktree", "b");
    });
    await both(twin, ["b"]);
    await both(twin, ["--sparse", "b"]);
  });

  it('t3602-rm-sparse-checkout.sh: "can remove files from non-sparse dir", "refuse to remove non-skip-worktree file from sparse dir"', async () => {
    const twin = twins((dir) => {
      for (const path of ["w/f.t", "x/y/f.t", "x/y/z/f.t"]) put(dir, path, `${path}\n`);
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-q", "-m", "c");
      gitOk(root, dir, "sparse-checkout", "set", "--no-cone", "w", "!/x", "y/", "!x/y/z");
      put(dir, "x/y/z/f.t", "x/y/z/f.t\n");
      gitOk(root, dir, "update-index", "--no-skip-worktree", "x/y/z/f.t");
    });
    await both(twin, ["x/y/z/f.t"]);
    await both(twin, ["w/f.t", "x/y/f.t"]);
  });
});
