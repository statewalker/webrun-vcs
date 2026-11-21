/**
 * git's interactive add (add-interactive.c) against native git: each case builds the same
 * repository twice, runs native `git add -i` with scripted answers on standard input, runs
 * ours (`add().setInteractive(true)`) with a selector giving the same answers, and compares
 * the transcript git printed on standard output and standard error, the index and the
 * worktree. Runs in the compatibility of the git on PATH (2.43 or 2.5x).
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PatchRequest } from "../src/commands/add-patch/index.js";
import { gitOk, openOurs, put, snapshot } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;
let compat: "2.43" | "2.56" = "2.56";

/** The same repository in two directories, built by `build` with native git. */
function twins(build: (dir: string) => void, initial = true): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `n${n}`);
  const ours = join(root, `o${n}`);
  for (const dir of [native, ours]) {
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    if (initial) {
      put(dir, ".gitignore", "*.log\n");
    }
    build(dir);
  }
  return { native, ours };
}

function native(dir: string, args: string[], answers: string[]) {
  const r = spawnSync(
    "git",
    ["-c", "color.ui=false", "-c", "interactive.singleKey=false", "add", "-i", ...args],
    {
      cwd: dir,
      env: { ...nativeGitEnv(root), GIT_PAGER: "cat" },
      input: answers.map((a) => `${a}\n`).join(""),
      encoding: "utf8",
    },
  );
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? 1 };
}

async function compare(
  dirs: { native: string; ours: string },
  answers: string[],
  paths: string[] = [],
  options: { context?: number; interHunkContext?: number } = {},
  /** Evens out what names the repository's own directory (a lock file's path) */
  normalize: (text: string, dir: string) => string = (text) => text,
): Promise<{ stdout: string; requests: PatchRequest[] }> {
  const flags = [
    ...(options.context !== undefined ? [`-U${options.context}`] : []),
    ...(options.interHunkContext !== undefined
      ? [`--inter-hunk-context=${options.interHunkContext}`]
      : []),
  ];
  const n = native(dirs.native, [...flags, ...(paths.length ? ["--", ...paths] : [])], answers);
  const git = await openOurs(dirs.ours);
  const queue = [...answers];
  const requests: PatchRequest[] = [];
  const cmd = git
    .add()
    .setInteractive(true)
    .setCompatibility(compat)
    .setPatchSelector((request) => {
      requests.push(request);
      return queue.shift();
    });
  for (const p of paths) cmd.addFilepattern(p);
  if (flags.length > 0) cmd.setPatchOptions(options);
  const result = await cmd.call();
  expect(normalize(result.interactive?.output ?? "", dirs.ours)).toBe(
    normalize(n.stdout, dirs.native),
  );
  expect(normalize(result.interactive?.errors ?? "", dirs.ours)).toBe(
    normalize(n.stderr, dirs.native),
  );
  expect(n.status).toBe(0);
  expect(snapshot(root, dirs.ours)).toEqual(snapshot(root, dirs.native));
  return { stdout: n.stdout, requests };
}

const twenty = Array.from({ length: 20 }, (_, i) => `${i + 1}\n`).join("");

/** Staged and unstaged changes, a binary file, a deletion, untracked and ignored files. */
function mixed(dir: string): void {
  put(dir, "f", twenty);
  put(dir, "g", "x\n");
  put(dir, "bin", Buffer.from([0, 1, 2]));
  put(dir, "dir/a.txt", "a\n");
  put(dir, "dir/b.txt", "b\n");
  put(dir, "gone", "bye\n");
  gitOk(root, dir, "add", ".");
  gitOk(root, dir, "commit", "-qm", "base");
  put(dir, "f", twenty.replace("2\n", "two\n").replace("18\n", "eighteen\n"));
  gitOk(root, dir, "add", "f");
  put(dir, "f", twenty.replace("2\n", "two\n").replace("18\n", "eighteen\n").replace("10\n", ""));
  put(dir, "g", "x\ny\n");
  put(dir, "bin", Buffer.from([0, 9, 2]));
  put(dir, "dir/a.txt", "A\n");
  put(dir, "dir/b.txt", "b\nb\n");
  unlinkSync(join(dir, "gone"));
  put(dir, "new.txt", "new\n");
  put(dir, "sub/deep.txt", "deep\n");
  put(dir, "noise.log", "ignored\n");
  put(dir, "staged-new", "s\n");
  gitOk(root, dir, "add", "staged-new");
}

describeGit("add -i as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "add-interactive-native-"));
    compat = gitAtLeast(gitOk(root, root, "--version"), 2, 50) ? "2.56" : "2.43";
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("lists the status, the menu, help and errors, and quits", async () => {
    const { requests } = await compare(twins(mixed), [
      "s",
      "status",
      "h",
      "?",
      "bogus",
      "9",
      "0",
      "1-2",
      "",
      "a b",
      "quit",
    ]);
    expect(requests[0]).toMatchObject({ type: "choose", prompt: "What now> ", singleton: true });
    await compare(twins(mixed), ["7"]);
    await compare(twins(mixed), ["q"]);
  });

  it("stops at the end of input in the main menu", async () => {
    await compare(twins(mixed), []);
    await compare(twins(mixed), ["1"]);
  });

  it("updates with numbers, ranges, prefixes, * and deselection", async () => {
    await compare(twins(mixed), ["u", "1", "3-4", "-3", "6-", "", "s", "q"]);
    await compare(twins(mixed), ["2", "*", "s", "q"]);
    await compare(twins(mixed), ["update", "di", "f", "g,bin", "-g", "?", "", "q"]);
    await compare(twins(mixed), ["u", "5x", "9", "1-0", "3- 1", "", "q"]);
    await compare(twins(mixed), ["u", "* 2", "q"]);
    await compare(twins(mixed), ["u", "-*", "1 2", "-1-2", "", "q"]);
  });

  it("stops at the end of input in a selection, staging what was chosen", async () => {
    await compare(twins(mixed), ["u", "1", "2"]);
    await compare(twins(mixed), ["u"]);
  });

  it("reverts staged changes, new files becoming untracked", async () => {
    const reverted = await compare(twins(mixed), ["r", "*", "s", "q"]);
    expect(reverted.stdout).toContain("note: staged-new is untracked now.\n");
    await compare(twins(mixed), ["revert", "st", "", "s", "q"]);
    await compare(twins(mixed), ["r", "", "q"]);
  });

  it("reverts on an unborn branch", async () => {
    const unborn = (dir: string) => {
      put(dir, "a", "a\n");
      put(dir, "b", "b\n");
      put(dir, "c", Buffer.from([0, 1]));
      gitOk(root, dir, "add", ".");
      put(dir, "a", "a\nmore\n");
    };
    await compare(twins(unborn), ["s", "r", "1,3", "", "s", "d", "1", "q"]);
    await compare(twins(unborn), ["u", "*", "p", "q"]);
  });

  it("adds untracked files", async () => {
    await compare(twins(mixed), ["a", "n", "su", "", "s", "q"]);
    await compare(twins(mixed), ["4", "*", "4", "q"]);
    const clean = (dir: string) => {
      put(dir, "x", "x\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "base");
    };
    await compare(twins(clean), ["a", "u", "r", "p", "d", "q"]);
  });

  it("selects hunks in patch mode", async () => {
    const patched = await compare(twins(mixed), ["p", "f", "g", "", "y", "n", "y", "s", "q"]);
    expect(patched.stdout).toContain("Stage this hunk");
    await compare(twins(mixed), ["5", "1", "", "?", "y"]);
    await compare(twins(mixed), ["p", ""]);
    await compare(twins(mixed), ["p"]);
  });

  it("passes binary files and conflicts over in patch mode", async () => {
    const onlyBinary = (dir: string) => {
      put(dir, "b", Buffer.from([0, 1]));
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "base");
      put(dir, "b", Buffer.from([0, 2]));
    };
    await compare(twins(onlyBinary), ["p", "s", "q"]);
    const conflict = (dir: string) => {
      put(dir, "c", "base\n");
      put(dir, "d", "d\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "base");
      gitOk(root, dir, "checkout", "-qb", "side");
      put(dir, "c", "side\n");
      gitOk(root, dir, "commit", "-qam", "side");
      gitOk(root, dir, "checkout", "-q", "main");
      put(dir, "c", "main\n");
      gitOk(root, dir, "commit", "-qam", "main");
      spawnSync("git", ["merge", "-q", "side"], { cwd: dir, env: nativeGitEnv(root) });
      put(dir, "d", "d\ne\n");
    };
    await compare(twins(conflict), ["s", "p", "*", "y", "q"]);
    await compare(twins(conflict), ["d", "*", "u", "1", "", "s", "q"]);
  });

  it("shows the staged diff", async () => {
    await compare(twins(mixed), ["d", "1", "s", "6", "*", "d", "-", "q"]);
    await compare(twins(mixed), ["diff", "f,staged-new", "q"]);
    await compare(twins(mixed), ["d"]);
  });

  it("takes a pathspec", async () => {
    await compare(twins(mixed), ["s", "u", "*", "a", "q"], ["dir", "new.txt"]);
  });

  it("lists mode changes and an intent-to-add file", async () => {
    const modes = (dir: string) => {
      put(dir, "m", "m\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "base");
      chmodSync(join(dir, "m"), 0o755);
      put(dir, "ita", "one\ntwo\n");
      gitOk(root, dir, "add", "-N", "ita");
    };
    await compare(twins(modes), ["s", "u", "*", "s", "q"]);
  });

  it("reverts a conflicted path and lists odd names", async () => {
    const conflict = (dir: string) => {
      put(dir, "c", "base\n");
      put(dir, "only-side", "x\n");
      gitOk(root, dir, "add", "c");
      gitOk(root, dir, "commit", "-qm", "base");
      gitOk(root, dir, "checkout", "-qb", "side");
      put(dir, "c", "side\n");
      put(dir, "n", "side\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "side");
      gitOk(root, dir, "checkout", "-q", "main");
      put(dir, "c", "main\n");
      put(dir, "n", "main\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "main");
      spawnSync("git", ["merge", "-q", "side"], { cwd: dir, env: nativeGitEnv(root) });
    };
    await compare(twins(conflict), ["r", "*", "s", "q"]);
    const names = (dir: string) => {
      put(dir, "1st", "a\n");
      put(dir, "with space", "a\n");
      put(dir, "caf\u00e9", "a\n");
      put(dir, "café2", "a\n");
      put(dir, "*star", "a\n");
      put(dir, "-dash", "a\n");
      put(dir, "same-a", "a\n");
      put(dir, "same-b", "a\n");
      put(dir, "samething", "a\n");
    };
    await compare(twins(names), ["a", "with", "same-", "same-b", "s", "1", "", "q"]);
    await compare(twins(names), ["a", "*", "d", "w", "q"]);
  });

  it("shows the diff with the diff configuration", async () => {
    const configured = (dir: string) => {
      mixed(dir);
      gitOk(root, dir, "config", "diff.context", "1");
      gitOk(root, dir, "config", "diff.mnemonicPrefix", "true");
    };
    const shown = await compare(twins(configured), ["d", "*", "p", "1", "", "?", "n", "y", "q"]);
    expect(shown.stdout).toContain("--- c/f\n+++ i/f\n");
  });

  it("takes -U and --inter-hunk-context (2.5x)", async () => {
    if (compat === "2.43") return;
    await compare(twins(mixed), ["d", "*", "p", "1", "", "n", "y", "q"], [], {
      context: 1,
      interHunkContext: 4,
    });
  });
  it("reports unmerged entries left after a revert, without 'reverted'", async () => {
    const conflict = (dir: string) => {
      put(dir, "c", "base\n");
      gitOk(root, dir, "add", "c");
      gitOk(root, dir, "commit", "-qm", "base");
      gitOk(root, dir, "checkout", "-qb", "side");
      put(dir, "c", "side\n");
      put(dir, "n", "side\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "side");
      gitOk(root, dir, "checkout", "-q", "main");
      put(dir, "c", "main\n");
      put(dir, "n", "main\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "main");
      spawnSync("git", ["merge", "-q", "side"], { cwd: dir, env: nativeGitEnv(root) });
      put(dir, "x", "x\n");
      gitOk(root, dir, "add", "x");
    };
    const { stdout } = await compare(twins(conflict), ["r", "c", "", "r", "x"]);
    expect(stdout).toContain("n: needs merge\n");
    expect(stdout).not.toContain("reverted");
  });

  it("stages each path as add_file_to_index, stopping at one it cannot add", async () => {
    const toDirectory = (dir: string) => {
      put(dir, "s", "s\n");
      put(dir, "t", "t\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "base");
      unlinkSync(join(dir, "s"));
      put(dir, "s/x", "x\n");
      put(dir, "t", "t2\n");
    };
    const failed = await compare(twins(toDirectory), ["u", "*", "", "s", "q"]);
    expect(failed.stdout).not.toContain("updated");
    const toRepository = (dir: string) => {
      put(dir, "s", "s\n");
      put(dir, "t", "t\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "base");
      unlinkSync(join(dir, "s"));
      gitOk(root, dir, "init", "-q", "s");
      put(dir, "t", "t2\n");
    };
    await compare(twins(toRepository), ["u", "*", "", "q"]);
    const deleted = (dir: string) => {
      put(dir, "s", "s\n");
      put(dir, "t", "t\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "base");
      unlinkSync(join(dir, "t"));
      put(dir, "s", "s2\n");
      put(dir, "u", "u\n");
    };
    await compare(twins(deleted), ["u", "*", "", "a", "*", "", "s", "q"]);
  });

  it("adds untracked files outside the sparse-checkout patterns", async () => {
    const sparse = (dir: string) => {
      put(dir, "a", "a\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "base");
      gitOk(root, dir, "sparse-checkout", "set", "--no-cone", "/a");
      put(dir, "d/new", "n\n");
      put(dir, "new2", "n\n");
    };
    const { stdout } = await compare(twins(sparse, false), ["a", "*", "s", "q"]);
    expect(stdout).toContain("added 2 paths\n");
  });

  it("reports the index lock another process holds", async () => {
    const locked = (dir: string) => {
      put(dir, "a", "a\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-qm", "base");
      put(dir, "a", "b\n");
      gitOk(root, dir, "add", "a");
      put(dir, "a", "c\n");
      put(dir, "u", "u\n");
      put(dir, ".git/index.lock", "");
    };
    const dirs = twins(locked, false);
    const normalize = (text: string, dir: string) => text.split(dir).join("<dir>");
    const answers = ["u", "1", "", "r", "1", "", "a", "1", "", "q"];
    await compare(dirs, answers, [], {}, normalize);
    for (const dir of [dirs.native, dirs.ours]) unlinkSync(join(dir, ".git/index.lock"));
  });

  it("numbers names in strcmp order (UTF-8 bytes)", async () => {
    const names = (dir: string) => {
      put(dir, "\uff5e", "x\n");
      put(dir, "\u{1f600}", "y\n");
      put(dir, "b", "z\n");
    };
    await compare(twins(names, false), ["a", "3", "", "s", "q"]);
  });
});
