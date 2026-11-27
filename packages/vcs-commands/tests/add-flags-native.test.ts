/**
 * `git add --sparse` and `git add --ignore-errors` / `add.ignoreErrors` against native git
 * (builtin/add.c, read-cache.c `add_files_to_cache`): entries and files outside the sparse
 * checkout (skip-worktree entries, paths outside the patterns, cone and non-cone, sparse
 * index on and off) refused with git's advice unless `--sparse`, and an unreadable file
 * passed over with git's lines (the others added, exit status 1) or fatal.
 *
 * Sources: t3705-add-sparse-checkout.sh, t3700-add.sh.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AddResult } from "../src/commands/add-command.js";
import type { GitApiError } from "../src/errors/git-api-error.js";
import { AddFailedError } from "../src/errors/index.js";
import { gitOk, openOurs, put, snapshot } from "./merge-native-helpers.js";
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

type Wrap = NonNullable<Parameters<typeof openOurs>[2]>;

/** git's `add` flags as our setters; `-v` is implied (the output is always compared). */
async function ourAdd(dir: string, args: string[], wrap?: Wrap) {
  const cmd = (await openOurs(dir, undefined, wrap)).add().setCompatibility(version);
  let options = true;
  for (const a of args) {
    if (options && a === "--") options = false;
    else if (options && a === "--sparse") cmd.setSparse(true);
    else if (options && a === "-u") cmd.setUpdate(true);
    else if (options && a === "-A") cmd.setAll(true);
    else if (options && a === "--ignore-removal") cmd.setAll(false);
    else if (options && a === "-f") cmd.setForce(true);
    else if (options && a === "--dry-run") cmd.setDryRun(true);
    else if (options && a === "--ignore-missing") cmd.setIgnoreMissing(true);
    else if (options && a === "--ignore-errors") cmd.setIgnoreErrors(true);
    else if (options && a === "--no-ignore-errors") cmd.setIgnoreErrors(false);
    else if (options && a === "--refresh") cmd.setRefresh(true);
    else if (options && a === "--renormalize") cmd.setRenormalize(true);
    else if (options && a.startsWith("--chmod=")) cmd.setChmod(a.slice("--chmod=".length));
    else cmd.addFilepattern(a);
  }
  try {
    const result = await cmd.call();
    return { status: 0, stdout: result.output, stderr: result.warnings.join("\n") };
  } catch (e) {
    const error = e as GitApiError;
    if (error instanceof AddFailedError) {
      const failed = error as AddFailedError<AddResult>;
      const stderr = [...failed.warnings, error.message].filter((l) => l !== "").join("\n");
      return { status: error.exitCode, stdout: [...failed.output], stderr };
    }
    if (typeof error.exitCode !== "number") throw e;
    return { status: error.exitCode, stdout: [] as string[], stderr: error.message };
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

/** git's "unable to index file" line, which 2.43 prints too: lines compared as they are. */
async function both(twin: { native: string; ours: string }, args: string[]) {
  const r = run(twin.native, ["add", "-v", ...args]);
  const ours = await ourAdd(twin.ours, args);
  expect(ours.stderr).toBe(r.stderr.trim());
  expect(ours.stdout.join("\n")).toBe(r.stdout.trim());
  expect(ours.status).toBe(r.status);
  expect(view(twin.ours)).toEqual(view(twin.native));
}

/** t3705's `setup_sparse_entry`: sparse_entry committed and skip-worktree, no sparse checkout. */
function sparseEntry(dir: string, content = "") {
  put(dir, "sparse_entry", content);
  gitOk(root, dir, "add", "sparse_entry");
  gitOk(root, dir, "update-index", "--skip-worktree", "sparse_entry");
  gitOk(root, dir, "config", "core.sparseCheckout", "false");
  gitOk(root, dir, "commit", "-q", "--allow-empty", "-m", "ensure sparse_entry exists at HEAD");
}

/** t3705's `setup_gitignore`. */
const gitignore = (dir: string) => put(dir, ".gitignore", "*\n!/sparse_entry\n");

describeGit("git add --sparse against native git (t3705-add-sparse-checkout)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "add-sparse-"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  it('t3705-add-sparse-checkout.sh: "git add does not remove sparse entries"', async () => {
    const twin = twins((dir) => {
      sparseEntry(dir);
      rmSync(join(dir, "sparse_entry"));
    });
    await both(twin, ["sparse_entry"]);
    await both(twin, ["--sparse", "sparse_entry"]);
  });

  it('t3705-add-sparse-checkout.sh: "git add -A does not remove sparse entries"', async () => {
    const twin = twins((dir) => {
      sparseEntry(dir);
      rmSync(join(dir, "sparse_entry"));
      gitignore(dir);
    });
    await both(twin, ["-A"]);
    await both(twin, ["--sparse", "-A"]);
  });

  it('t3705-add-sparse-checkout.sh: "git add . does not remove sparse entries"', async () => {
    const twin = twins((dir) => {
      sparseEntry(dir);
      rmSync(join(dir, "sparse_entry"));
      gitignore(dir);
    });
    await both(twin, ["."]);
    await both(twin, ["--sparse", "."]);
  });

  const updates: [string[], string][] = [
    [[], 't3705-add-sparse-checkout.sh: "git add does not update sparse entries"'],
    [["-f"], 't3705-add-sparse-checkout.sh: "git add -f does not update sparse entries"'],
    [["-u"], 't3705-add-sparse-checkout.sh: "git add -u does not update sparse entries"'],
    [
      ["--ignore-removal"],
      't3705-add-sparse-checkout.sh: "git add --ignore-removal does not update sparse entries"',
    ],
    [
      ["--dry-run"],
      't3705-add-sparse-checkout.sh: "git add --dry-run does not update sparse entries"',
    ],
  ];
  for (const [opt, name] of updates) {
    it(name, async () => {
      const twin = twins((dir) => {
        sparseEntry(dir);
        put(dir, "sparse_entry", "modified\n");
      });
      await both(twin, [...opt, "sparse_entry"]);
      await both(twin, ["--sparse", ...opt, "sparse_entry"]);
    });
  }

  it('t3705-add-sparse-checkout.sh: "git add --refresh does not update sparse entries"', async () => {
    const twin = twins(sparseEntry);
    await both(twin, ["--refresh", "sparse_entry"]);
    await both(twin, ["--refresh", "--sparse", "sparse_entry"]);
  });

  it('t3705-add-sparse-checkout.sh: "git add --chmod does not update sparse entries"', async () => {
    const twin = twins(sparseEntry);
    await both(twin, ["--chmod=+x", "sparse_entry"]);
    await both(twin, ["--sparse", "--chmod=+x", "sparse_entry"]);
  });

  it('t3705-add-sparse-checkout.sh: "git add --renormalize does not update sparse entries"', async () => {
    const twin = twins((dir) => {
      gitOk(root, dir, "config", "core.autocrlf", "false");
      sparseEntry(dir, "LINEONE\r\nLINETWO\r\n");
      put(dir, ".gitattributes", "sparse_entry text=auto\n");
    });
    await both(twin, ["--renormalize", "sparse_entry"]);
    await both(twin, ["--sparse", "--renormalize", "sparse_entry"]);
  });

  it('t3705-add-sparse-checkout.sh: "git add --dry-run --ignore-missing warn on sparse path"', async () => {
    const twin = twins((dir) => {
      sparseEntry(dir);
      rmSync(join(dir, "sparse_entry"));
    });
    await both(twin, ["--dry-run", "--ignore-missing", "sparse_entry"]);
    await both(twin, ["--sparse", "--dry-run", "--ignore-missing", "sparse_entry"]);
  });

  it('t3705-add-sparse-checkout.sh: "do not advice about sparse entries when they do not match the pathspec"', async () => {
    await both(twins(sparseEntry), ["nonexistent"]);
  });

  it('t3705-add-sparse-checkout.sh: "do not warn when pathspec matches dense entries"', async () => {
    const twin = twins((dir) => {
      sparseEntry(dir);
      put(dir, "sparse_entry", "modified\n");
      put(dir, "dense_entry", "");
    });
    await both(twin, ["*_entry"]);
  });

  it('t3705-add-sparse-checkout.sh: "add obeys advice.updateSparsePath"', async () => {
    const twin = twins((dir) => {
      sparseEntry(dir);
      gitOk(root, dir, "config", "advice.updateSparsePath", "false");
    });
    await both(twin, ["sparse_entry"]);
  });

  /** sparse_entry outside the non-cone patterns `a`, its skip-worktree flag cleared. */
  const outsidePatterns = (dir: string) => {
    sparseEntry(dir);
    put(dir, "a.t", "a\n");
    gitOk(root, dir, "add", "a.t");
    gitOk(root, dir, "commit", "-q", "-m", "a");
    gitOk(root, dir, "sparse-checkout", "init", "--no-cone");
    gitOk(root, dir, "sparse-checkout", "set", "a.t");
    put(dir, "sparse_entry", "\n");
    gitOk(root, dir, "update-index", "--no-skip-worktree", "sparse_entry");
  };

  it('t3705-add-sparse-checkout.sh: "git add fails outside of sparse-checkout definition"', async () => {
    const twin = twins(outsidePatterns);
    await both(twin, ["sparse_entry"]);
    await both(twin, ["--chmod=+x", "sparse_entry"]);
    await both(twin, ["--renormalize", "sparse_entry"]);
    await both(twin, ["--sparse", "sparse_entry"]);
    await both(twin, ["--sparse", "--chmod=+x", "sparse_entry"]);
    await both(twin, ["--sparse", "--renormalize", "sparse_entry"]);
  });

  it('t3705-add-sparse-checkout.sh: "add allows sparse entries with --sparse"', async () => {
    const twin = twins((dir) => {
      outsidePatterns(dir);
      gitOk(root, dir, "update-index", "--skip-worktree", "sparse_entry");
      put(dir, "sparse_entry", "modified\n");
    });
    await both(twin, ["sparse_entry"]);
    await both(twin, ["--sparse", "sparse_entry"]);
  });

  it('t3705-add-sparse-checkout.sh: "can add files from non-sparse dir"', async () => {
    const twin = twins((dir) => {
      outsidePatterns(dir);
      gitOk(root, dir, "sparse-checkout", "set", "w", "!/x", "y/");
      put(dir, "w/f", "");
      put(dir, "x/y/f", "");
    });
    await both(twin, ["w/f", "x/y/f"]);
  });

  it('t3705-add-sparse-checkout.sh: "refuse to add non-skip-worktree file from sparse dir"', async () => {
    const twin = twins((dir) => {
      outsidePatterns(dir);
      gitOk(root, dir, "sparse-checkout", "set", "!/x", "y/", "!x/y/z");
      put(dir, "x/y/z/f", "");
    });
    await both(twin, ["x/y/z/f"]);
    await both(twin, ["--sparse", "x/y/z/f"]);
  });

  for (const sparseIndex of [false, true]) {
    /** a, in/f, out/f, out/deep/g committed; the cone `in`. */
    const cone = (dir: string) => {
      for (const path of ["a", "in/f", "out/f", "out/deep/g"]) put(dir, path, `${path}\n`);
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-q", "-m", "files");
      gitOk(root, dir, "config", "index.sparse", String(sparseIndex));
      gitOk(root, dir, "sparse-checkout", "set", "--cone", "in");
    };
    const label = `cone, sparse index ${sparseIndex ? "on" : "off"}`;
    const runs: string[][][] = [
      [["out/new"], ["--sparse", "out/new"]],
      [["."], ["--sparse", "."]],
      [["-A"], ["--sparse", "-A"]],
      [["out"], ["--sparse", "out"]],
      [["out/f"], ["--sparse", "out/f"]],
      [["--sparse", "in/new", "a"]],
    ];
    for (const sequence of runs) {
      it(`${label}: ${sequence.map((a) => `add ${a.join(" ")}`).join(", then ")}`, async () => {
        const twin = twins((dir) => {
          cone(dir);
          put(dir, "out/new", "new\n");
          put(dir, "out/f", "changed\n");
          put(dir, "in/new", "new\n");
        });
        for (const args of sequence) await both(twin, args);
      });
    }

    // nothing of out/ on disk: git keeps a sparse index collapsed (out/ one entry)
    const absent: string[][][] = [
      [["out/f"], ["--sparse", "out/f"]],
      [["out"], ["--sparse", "out"]],
      [["o*"], ["--sparse", "o*"]],
      [["--sparse", "-A"]],
      [["--sparse", "."]],
      [["--sparse", "--renormalize", "."]],
      [["--sparse", "--chmod=+x", "a"]],
      [
        ["--chmod=+x", "."],
        ["--sparse", "--chmod=+x", "."],
      ],
      [
        ["--refresh", "out/f"],
        ["--refresh", "out"],
      ],
      [["--sparse", "-u"]],
      [["in/new", "a"]],
    ];
    for (const sequence of absent) {
      const name = sequence.map((a) => `add ${a.join(" ")}`).join(", then ");
      it(`${label}, out/ not on disk: ${name}`, async () => {
        const twin = twins((dir) => {
          cone(dir);
          put(dir, "in/new", "new\n");
          put(dir, "a", "changed\n");
        });
        for (const args of sequence) await both(twin, args);
      });
    }
  }
});

describeGit("git add --ignore-errors against native git (t3700-add)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "add-ignore-errors-"));
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  /** Our FilesApi refusing to read `foo2` (root reads any file). */
  const unreadable: Wrap = (files) =>
    new Proxy(files, {
      get(target, prop, receiver) {
        if (prop === "withLstatCache") return undefined;
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        if (prop === "read") {
          return (path: string, ...rest: unknown[]) => {
            if (path.replace(/^\/+/, "") === "foo2") {
              // biome-ignore lint/correctness/useYield: a read that fails before any chunk
              return (async function* () {
                throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), {
                  code: "EACCES",
                });
              })();
            }
            return value.call(target, path, ...rest);
          };
        }
        return value.bind(target);
      },
    });

  /**
   * Native `git add -v <args>` as an unprivileged user with foo2 unreadable (root reads
   * any file), or undefined when the git on PATH cannot run as that user.
   */
  function nativeAdd(dir: string, args: string[]) {
    chmodSync(join(dir, "foo2"), 0);
    try {
      if (process.getuid?.() !== 0) return run(dir, ["add", "-v", ...args]);
      spawnSync("chown", ["-R", "65534:65534", dir]);
      chmodSync(root, 0o711);
      const r = spawnSync(
        "setpriv",
        ["--reuid=65534", "--regid=65534", "--clear-groups", "git", "add", "-v", ...args],
        { cwd: dir, env: nativeGitEnv(root), encoding: "utf8" },
      );
      spawnSync("chown", ["-R", "0:0", dir]);
      chmodSync(root, 0o700);
      if (r.error || !(r.stderr ?? "").includes('error: open("foo2")')) return undefined;
      // (a git installed in a private directory cannot read its own system attributes there)
      const stderr = (r.stderr ?? "")
        .split("\n")
        .filter((l) => !/^warning: unable to access '.*\/etc\/gitattributes'/.test(l))
        .join("\n");
      return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr };
    } finally {
      chmodSync(join(dir, "foo2"), 0o644);
    }
  }

  /** git's lines for these runs (builtin/add.c, read-cache.c), when it cannot be run. */
  const fallback = (args: string[], tracked: boolean) => {
    const ignoring = args.includes("--ignore-errors") || args.includes("config");
    const lines = ['error: open("foo2"): Permission denied', "error: unable to index file 'foo2'"];
    if (!ignoring)
      lines.push(tracked ? "fatal: updating files failed" : "fatal: adding files failed");
    return {
      status: ignoring ? 1 : 128,
      stdout: !ignoring && tracked ? "" : "add 'foo1'\n",
      stderr: `${lines.join("\n")}\n`,
    };
  };

  const cases: { name: string; args: string[]; tracked?: boolean; config?: string }[] = [
    { name: "git add --ignore-errors", args: ["--ignore-errors", "."] }, // t3700-add.sh: "git add --ignore-errors"
    { name: "git add without --ignore-errors", args: ["."] },
    { name: "git add (add.ignore-errors)", args: ["."], config: "1" }, // t3700-add.sh: "git add (add.ignore-errors)"
    { name: "git add (add.ignore-errors = false)", args: ["."], config: "0" }, // t3700-add.sh: "git add (add.ignore-errors = false)"
    { name: "--no-ignore-errors overrides config", args: ["--no-ignore-errors", "."], config: "1" }, // t3700-add.sh: "--no-ignore-errors overrides config"
    { name: "git add -u --ignore-errors", args: ["-u", "--ignore-errors"], tracked: true },
    { name: "git add -u", args: ["-u"], tracked: true },
    { name: "git add --ignore-errors foo1 foo2", args: ["--ignore-errors", "foo1", "foo2"] },
  ];
  for (const { name, args, tracked = false, config } of cases) {
    it(name, async () => {
      const twin = twins((dir) => {
        if (config) gitOk(root, dir, "config", "add.ignore-errors", config);
        if (tracked) {
          put(dir, "foo1", "a\n");
          put(dir, "foo2", "b\n");
          gitOk(root, dir, "add", ".");
          gitOk(root, dir, "commit", "-q", "-m", "c");
        }
        put(dir, "foo1", "changed 1\n");
        put(dir, "foo2", "changed 2\n");
      });
      const ran = nativeAdd(twin.native, args);
      const ignoring = config === "1" ? !args.includes("--no-ignore-errors") : undefined;
      const r = ran ?? fallback(ignoring ? ["config"] : args, tracked);
      const ours = await ourAdd(twin.ours, args, unreadable);
      expect(ours.stderr).toBe(r.stderr.trim());
      expect(ours.stdout.join("\n")).toBe(r.stdout.trim());
      expect(ours.status).toBe(r.status);
      const index = (dir: string) => gitOk(root, dir, "ls-files", "-s");
      if (ran) expect(index(twin.ours)).toBe(index(twin.native));
      // foo1's change staged where git goes on, nothing where it dies
      const changed = gitOk(root, twin.ours, "hash-object", "foo1").trim();
      expect(index(twin.ours).includes(changed)).toBe(r.status === 1);
    });
  }
});
