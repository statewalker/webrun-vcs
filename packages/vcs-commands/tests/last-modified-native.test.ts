/**
 * `git last-modified` (builtin/last-modified.c, git 2.52+), native twins: t8020-last-modified's
 * scenarios run by native git and by ours on the same repository, git deciding (stdout bytes,
 * exit status, stderr's first line), plus Bloom-filter, hashmap-order, quoting and merge
 * scenarios of our own. Skipped where native git has no `last-modified` (2.43).
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, LastModifiedCommand } from "../src/index.js";
import { Shell } from "./describe-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

function hasLastModified(): boolean {
  if (!nativeGitAvailable()) return false;
  const r = spawnSync("git", ["last-modified", "-h"], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`.includes("usage: git last-modified");
}

const describeGit = hasLastModified() && process.platform !== "win32" ? describe : describe.skip;

interface Outcome {
  status: number;
  stdout: string;
  stderr: string;
}

let root: string;
let shell: Shell;

/** Whether native git reads `arg` as a revision (setup_revisions' guess before `--`). */
function isRevision(dir: string, arg: string): boolean {
  if (arg.startsWith("^") || arg.includes("..")) return true;
  return shell.git(dir, ["rev-parse", "--verify", "-q", arg]).status === 0;
}

/** `git last-modified <argv>` mapped onto our command. */
function lastModifiedArgs(git: Git, dir: string, argv: string[]): LastModifiedCommand {
  const command = git.lastModified();
  let dashdash = false;
  let pathsStarted = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (dashdash || pathsStarted) {
      command.addPaths(arg);
      continue;
    }
    if (arg === "--") dashdash = true;
    else if (arg === "-r" || arg === "--recursive") command.setRecursive();
    else if (arg === "-t" || arg === "--show-trees") command.setShowTrees();
    else if (arg === "-z") command.setNullTerminated();
    else if (arg.startsWith("--max-depth=")) command.setMaxDepth(Number(arg.slice(12)));
    else if (/^-\d+$/.test(arg)) command.setMaxCount(Number(arg.slice(1)));
    else if (arg.startsWith("-")) command.addRevisions(arg);
    else if (isRevision(dir, arg)) command.addRevisions(arg);
    else {
      pathsStarted = true;
      command.addPaths(arg);
    }
  }
  return command;
}

function nativeRun(dir: string, sub: string, argv: string[], env = {}): Outcome {
  const r = spawnSync("git", ["last-modified", ...argv], {
    cwd: join(dir, sub),
    env: { ...nativeGitEnv(shell.home), ...env },
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout.toString("latin1"),
    stderr: r.stderr.toString(),
  };
}

async function oursRun(
  dir: string,
  sub: string,
  argv: string[],
  configure?: (c: LastModifiedCommand) => void,
): Promise<{ outcome: Outcome; command: LastModifiedCommand }> {
  const git = await openOurs(dir);
  const command = lastModifiedArgs(git, join(dir, sub), argv);
  if (sub) command.setPrefix(sub);
  configure?.(command);
  const r = await command.callOutput();
  return {
    outcome: {
      status: r.exitCode,
      stdout: Buffer.from(r.stdout).toString("latin1"),
      stderr: r.stderr,
    },
    command,
  };
}

/** Both sides compared; `sub` is the directory git runs in. */
async function check(
  dir: string,
  argv: string[],
  options: { sub?: string; configure?: (c: LastModifiedCommand) => void } = {},
): Promise<{ native: Outcome; command: LastModifiedCommand }> {
  const sub = options.sub ?? "";
  const native = nativeRun(dir, sub, argv);
  const { outcome: ours, command } = await oursRun(dir, sub, argv, options.configure);
  expect(ours.status).toBe(native.status);
  expect(ours.stderr.split("\n")[0]).toBe(native.stderr.split("\n")[0]);
  expect(ours.stdout).toBe(native.stdout);
  return { native, command };
}

/** test_merge <message> <commit>: a merge, tagged */
function merge(dir: string, message: string, commit: string): void {
  shell.tick();
  shell.ok(dir, "merge", "-m", message, commit);
  shell.ok(dir, "tag", message);
}

describeGit("git last-modified, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "last-modified-native-"));
    shell = new Shell(root);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("t8020-last-modified", () => {
    let dir: string;
    beforeAll(() => {
      dir = join(root, "t8020");
      shell.ok(root, "init", "-q", "-b", "main", dir);
      shell.commit(dir, "1", "file");
      shell.commit(dir, "2", "a/file");
      shell.ok(dir, "tag", "-mA", "t2", "2");
      shell.commit(dir, "3", "a/b/file");
    });

    it('t8020-last-modified.sh: "last-modified non-recursive"', async () => {
      const { native } = await check(dir, []);
      expect(native.stdout.split("\n").length).toBe(3);
    });
    it('t8020-last-modified.sh: "last-modified recursive"', async () => {
      await check(dir, ["-r"]);
    });
    it('t8020-last-modified.sh: "last-modified on annotated tag"', async () => {
      await check(dir, ["t2"]);
    });
    it('t8020-last-modified.sh: "last-modified recursive with show-trees"', async () => {
      await check(dir, ["-r", "-t"]);
    });
    it('t8020-last-modified.sh: "last-modified non-recursive with show-trees"', async () => {
      await check(dir, ["-t"]);
    });
    it('t8020-last-modified.sh: "last-modified subdir"', async () => {
      await check(dir, ["a"]);
    });
    it('t8020-last-modified.sh: "last-modified in sparse checkout"', async () => {
      shell.ok(dir, "sparse-checkout", "set", "b");
      try {
        await check(dir, ["--", "a"]);
      } finally {
        shell.ok(dir, "sparse-checkout", "disable");
      }
    });
    it('t8020-last-modified.sh: "last-modified subdir recursive"', async () => {
      await check(dir, ["-r", "a"]);
    });
    it('t8020-last-modified.sh: "last-modified path in subdir non-recursive"', async () => {
      await check(dir, ["a/file"]);
    });
    it('t8020-last-modified.sh: "last-modified subdir with wildcard non-recursive"', async () => {
      // the shell expands a/* before git sees it
      await check(dir, ["a/b", "a/file"]);
    });
    it('t8020-last-modified.sh: "last-modified with negative max-depth"', async () => {
      await check(dir, ["--max-depth=-1"]);
    });
    it('t8020-last-modified.sh: "last-modified with max-depth of 1"', async () => {
      await check(dir, ["--max-depth=1"]);
    });
    it('t8020-last-modified.sh: "last-modified from non-HEAD commit"', async () => {
      await check(dir, ["HEAD^"]);
    });
    it('t8020-last-modified.sh: "last-modified from subdir defaults to root"', async () => {
      await check(dir, [], { sub: "a" });
    });
    it('t8020-last-modified.sh: "last-modified from subdir uses relative pathspecs"', async () => {
      await check(dir, ["-r", "b"], { sub: "a" });
    });
    it('t8020-last-modified.sh: "limit last-modified traversal by count"', async () => {
      const { native } = await check(dir, ["-1"]);
      expect(native.stdout).toContain("^");
    });
    it('t8020-last-modified.sh: "limit last-modified traversal by commit"', async () => {
      const { native } = await check(dir, ["HEAD~2..HEAD"]);
      expect(native.stdout).toContain("^");
    });
    it('t8020-last-modified.sh: "cannot run last-modified on two commits"', async () => {
      await check(dir, ["HEAD", "HEAD~1"]);
    });
    it('t8020-last-modified.sh: "last-modified complains about unknown arguments"', async () => {
      await check(dir, ["--foo"]);
    });
    it('t8020-last-modified.sh: "last-modified expects commit-ish"', async () => {
      await check(dir, ["HEAD^{tree}"]);
    });
    it("max-depth refuses wildcard pathspecs (diff_setup_done)", async () => {
      await check(dir, ["--", "a*"]);
      await check(dir, ["-r", "--", "a*"]);
    });

    it('t8020-last-modified.sh: "only last-modified files in the current tree"', async () => {
      shell.ok(dir, "rm", "-q", "-rf", "a");
      shell.tick();
      shell.ok(dir, "commit", "-q", "-m", "remove a");
      await check(dir, []);
    });

    it('t8020-last-modified.sh: "subdirectory modified via merge"', async () => {
      const repo = join(root, "t8020-merge");
      shell.ok(root, "init", "-q", "-b", "main", repo);
      shell.commit(repo, "base");
      shell.ok(repo, "switch", "-q", "--create", "left");
      shell.commit(repo, "left", "subdir/left");
      shell.ok(repo, "switch", "-q", "--create", "right", "base");
      shell.commit(repo, "right", "subdir/right");
      shell.ok(repo, "switch", "-q", "-");
      merge(repo, "merge", "right");
      await check(repo, []);
      await check(repo, ["-r", "-t"]);
    });

    it('t8020-last-modified.sh: "cross merge boundaries in blaming"', async () => {
      shell.ok(dir, "checkout", "-q", "HEAD^0");
      shell.ok(dir, "rm", "-q", "-rf", ".");
      shell.commit(dir, "m1");
      shell.ok(dir, "checkout", "-q", "HEAD^");
      shell.ok(dir, "rm", "-q", "-rf", ".");
      shell.commit(dir, "m2");
      shell.tick();
      shell.ok(dir, "merge", "-q", "m1");
      await check(dir, []);
    });

    it('t8020-last-modified.sh: "last-modified merge for resolved conflicts"', async () => {
      shell.ok(dir, "checkout", "-q", "HEAD^0");
      shell.ok(dir, "rm", "-q", "-rf", ".");
      shell.commit(dir, "c1", "conflict");
      shell.ok(dir, "checkout", "-q", "HEAD^");
      shell.ok(dir, "rm", "-q", "-rf", ".");
      shell.commit(dir, "c2", "conflict");
      expect(shell.git(dir, ["merge", "c1"]).status).not.toBe(0);
      shell.commit(dir, "resolved", "conflict");
      await check(dir, ["conflict"]);
    });

    it('t8020-last-modified.sh: "last-modified merge ignores content from branch"', async () => {
      shell.ok(dir, "checkout", "-q", "HEAD^0");
      shell.ok(dir, "rm", "-q", "-rf", ".");
      shell.commit(dir, "a1", "file", "A");
      shell.commit(dir, "a2", "file", "B");
      shell.commit(dir, "a3", "file", "C");
      shell.commit(dir, "a4", "file", "D");
      shell.ok(dir, "checkout", "-q", "a2");
      shell.tick();
      shell.ok(dir, "merge", "-q", "--no-commit", "--no-ff", "a4");
      shell.ok(dir, "checkout", "a2", "--", "file");
      shell.ok(dir, "merge", "--continue");
      await check(dir, []);
    });

    it('t8020-last-modified.sh: "last-modified merge undoes changes"', async () => {
      shell.ok(dir, "checkout", "-q", "HEAD^0");
      shell.ok(dir, "rm", "-q", "-rf", ".");
      shell.commit(dir, "b1", "file", "A");
      shell.commit(dir, "b2", "file", "B");
      shell.commit(dir, "b3", "file", "C");
      shell.commit(dir, "b4", "file", "D");
      shell.ok(dir, "checkout", "-q", "b2");
      shell.commit(dir, "b5", "file2", "2");
      shell.ok(dir, "checkout", "-q", "b4");
      shell.tick();
      shell.ok(dir, "merge", "-q", "--no-commit", "--no-ff", "b5");
      shell.ok(dir, "checkout", "b2", "--", "file");
      shell.ok(dir, "merge", "--continue");
      await check(dir, []);
      await check(dir, ["-2"]);
    });
  });

  describe("history with many paths, merges and a commit-graph", () => {
    let dir: string;
    beforeAll(() => {
      dir = join(root, "wide");
      shell.ok(root, "init", "-q", "-b", "main", dir);
      // more than 51 paths: git's hashmap grows past its first 64 buckets
      for (let i = 0; i < 70; i++) writeFileSync(join(dir, `f${i}`), `${i}\n`);
      shell.ok(dir, "add", ".");
      shell.tick();
      shell.ok(dir, "commit", "-q", "-m", "root");
      for (let round = 0; round < 6; round++) {
        shell.ok(dir, "switch", "-q", "-c", `side${round}`);
        for (let i = round; i < 70; i += 7) {
          shell.commit(dir, `s${round}-${i}`, `d${i % 5}/g${i}`, `side ${round}`);
        }
        shell.ok(dir, "switch", "-q", "main");
        for (let i = round + 3; i < 70; i += 11) {
          shell.commit(dir, `m${round}-${i}`, `f${i}`, `main ${round}`);
        }
        shell.tick();
        shell.ok(dir, "merge", "-q", "--no-ff", "-m", `merge ${round}`, `side${round}`);
      }
      // a name that needs quoting, a mode change and a file replaced by a directory
      shell.commit(dir, "quoted", "sp ace\ttabé", "q");
      shell.ok(dir, "update-index", "--chmod=+x", "f1");
      shell.tick();
      shell.ok(dir, "commit", "-q", "-m", "chmod");
      shell.ok(dir, "rm", "-q", "f2");
      shell.commit(dir, "dir", "f2/inner", "x");
    });

    it("without a commit-graph", async () => {
      await check(dir, []);
      await check(dir, ["-r"]);
      await check(dir, ["-r", "-t"]);
      await check(dir, ["-r", "-z"]);
      await check(dir, ["-5", "-r"]);
      await check(dir, ["side2~1..main", "-r"]);
      await check(dir, ["-r", "--", "d1", "f3"]);
      await check(dir, ["-r", "--", "d*"]);
      await check(dir, ["--max-depth=0", "--", "d1", "d1/g6"]);
    });

    it("with changed-path Bloom filters, which spare tree reads", async () => {
      const copy = join(root, "wide-graph");
      shell.ok(root, "clone", "-q", "--no-local", dir, copy);
      shell.ok(copy, "commit-graph", "write", "--reachable", "--changed-paths");
      const { command } = await check(copy, ["-r", "--", "f3"]);
      const stats = command.getStatistics();
      expect(stats.bloomDefinitelyNot).toBeGreaterThan(0);
      await check(copy, ["-r"]);
      await check(copy, ["-r", "-t"]);
      await check(copy, ["side2~1..main"]);
      await check(copy, ["origin/side2~1..main"]);
      await check(copy, ["-3", "--", "d2"]);
      // the filters off: the same lines, every tree read
      const { command: off } = await check(copy, ["-r", "--", "f3"], {
        configure: (c) => c.setUseBloomFilters(false),
      });
      expect(off.getStatistics().bloomDefinitelyNot).toBe(0);
      expect(off.getStatistics().treeDiffs).toBeGreaterThan(stats.treeDiffs);
    });

    it("callEntries gives the lines as entries", async () => {
      const git = await openOurs(dir);
      const entries = await git
        .lastModified()
        .addRevisions("-3")
        .callEntries()
        .catch((e) => e);
      expect(entries).toBeInstanceOf(Error);
      const ok = await (await openOurs(dir)).lastModified().setMaxCount(3).callEntries();
      const native = nativeRun(dir, "", ["-3"]).stdout.split("\n").filter(Boolean);
      expect(ok.map((e) => `${e.boundary ? "^" : ""}${e.commit}`)).toEqual(
        native.map((l) => l.slice(0, l.indexOf("\t"))),
      );
    });
  });
});
