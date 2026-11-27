/**
 * textconv in `git grep --textconv` and `git blame` against native git: native git runs
 * `diff.<driver>.textconv`, ours the host's runner running the same command
 * (`shellTextconvRunner`). grep converts blobs from trees and the index through the
 * driver's notes cache (`diff.<driver>.cachetextconv`, `refs/notes/textconv/<driver>`) as
 * git's `fill_textconv` does; blame converts every version of the file it reads
 * (`textconv_object`, on by default, `--no-textconv` off), cached too, and the working
 * tree's file without the cache (t8006).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatBlamePorcelain, type Git, installTextconvRunner } from "../src/index.js";
import { shellTextconvRunner } from "./host-drivers-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "";
const [major = 0, minor = 0] = (/(\d+)\.(\d+)/.exec(version) ?? ["", "0", "0"])
  .slice(1)
  .map(Number);
const atLeast = (ma: number, mi: number) => major > ma || (major === ma && minor >= mi);

let root: string;
let counter = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "textconv-grep-blame-"));
});
afterAll(async () => {
  await removeTempDir(root);
}, CLEANUP_TIMEOUT);

function env(): Record<string, string> {
  return nativeGitEnv(root);
}

function git(dir: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: dir, env: env(), encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function sh(dir: string, script: string): void {
  const r = spawnSync("sh", ["-ec", script], { cwd: dir, env: env(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`setup failed: ${r.stderr}${r.stdout}`);
}

function twins(script: string): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  for (const dir of [native, ours]) {
    mkdirSync(dir, { recursive: true });
    sh(dir, `git init -q -b main\n${script}`);
  }
  return { native, ours };
}

async function open(dir: string): Promise<Git> {
  const e = env();
  const repo = await openOurs(dir, createNodeGitHostEnvironment({ env: e }));
  installTextconvRunner(repo.workingCopy, shellTextconvRunner(dir, e));
  return repo;
}

/** Both caches (`refs/notes/`) and their reflogs, as `for-each-ref` and `reflog` list them */
function caches(dir: string): string {
  const refs = git(dir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/notes/"]);
  const logs = git(dir, ["for-each-ref", "--format=%(refname)", "refs/notes/"])
    .stdout.split("\n")
    .filter(Boolean)
    .map((ref) => git(dir, ["reflog", "show", "--format=%H %gs", ref]).stdout)
    .join("");
  return refs.stdout + logs;
}

/** t4042's helper: it leaves `helper.out` behind each time it runs */
const CACHE_HELPER = `#!/bin/sh
sed 's/^/converted: /' "$@" >helper.out
cat helper.out
`;

describeGit("git grep --textconv through the textconv cache", () => {
  function setup(): { native: string; ours: string } {
    return twins(
      [
        `cat >helper <<'EOF'\n${CACHE_HELPER}EOF`,
        "chmod +x helper",
        'echo "*.bin diff=magic" >.gitattributes',
        "echo foo content 1 >foo.bin",
        "echo bar content 1 >bar.bin",
        "git add .gitattributes foo.bin bar.bin",
        "git commit -q -m one",
        "echo foo content 2 >foo.bin",
        "git add foo.bin",
        "git config diff.magic.textconv ./helper",
        "git config diff.magic.cachetextconv true",
      ].join("\n"),
    );
  }

  async function compareGrep(
    tw: { native: string; ours: string },
    args: { cached?: boolean; revision?: string },
  ): Promise<void> {
    for (const dir of [tw.native, tw.ours]) rmSync(join(dir, "helper.out"), { force: true });
    // one thread: threaded greps convert (and so fill the cache) in no fixed order, git's too
    const argv = [
      "grep",
      "--threads=1",
      "--textconv",
      ...(args.cached ? ["--cached"] : []),
      "converted",
      ...(args.revision ? [args.revision] : []),
    ];
    const native = git(tw.native, argv);
    const repo = await open(tw.ours);
    const cmd = repo.grep().setThreads(1).setTextconv(true).addPattern("converted");
    if (args.cached) cmd.setCached(true);
    if (args.revision) cmd.addRevision(args.revision);
    const ours = await cmd.call();
    expect(Buffer.from(ours.output).toString()).toBe(native.stdout);
    expect(ours.exitCode).toBe(native.status);
    // the helper runs only for blobs the cache does not hold yet
    expect(existsSync(join(tw.ours, "helper.out"))).toBe(existsSync(join(tw.native, "helper.out")));
    expect(caches(tw.ours)).toBe(caches(tw.native));
  }

  it("fills and reads refs/notes/textconv/<driver> for a tree's blobs, as git", async () => {
    const tw = setup();
    await compareGrep(tw, { revision: "HEAD" });
    // the second run reads every blob from the cache: the helper does not run
    await compareGrep(tw, { revision: "HEAD" });
    expect(existsSync(join(tw.native, "helper.out"))).toBe(false);
  });

  it("fills and reads the cache for the index's blobs (--cached), as git", async () => {
    const tw = setup();
    await compareGrep(tw, { cached: true });
    await compareGrep(tw, { revision: "HEAD" });
    await compareGrep(tw, { cached: true });
  });

  it("never caches the worktree's files, as git", async () => {
    const tw = setup();
    await compareGrep(tw, {});
    expect(caches(tw.native)).toBe("");
  });
});

/** t8006-blame-textconv.sh's helper */
const T8006_HELPER = `#!/bin/sh
grep -q '^bin: ' "$1" || { echo "E: $1 is not \\"binary\\" file" 1>&2; exit 1; }
sed 's/^bin: /converted: /' "$1"
`;

const T8006_SETUP = [
  `cat >helper <<'EOF'\n${T8006_HELPER}EOF`,
  "chmod +x helper",
  'echo "bin: test number 0" >zero.bin',
  'echo "bin: test 1" >one.bin',
  'echo "bin: test number 2" >two.bin',
  "ln -s one.bin symlink.bin",
  "git add zero.bin one.bin two.bin symlink.bin",
  'GIT_AUTHOR_NAME=Number1 GIT_AUTHOR_DATE="2010-01-01 18:00:00 +0000" git commit -q -a -m First',
  'echo "bin: test 1 version 2" >one.bin',
  'echo "bin: test number 2 version 2" >>two.bin',
  "rm -f symlink.bin",
  "ln -s two.bin symlink.bin",
  "git add symlink.bin",
  'GIT_AUTHOR_NAME=Number2 GIT_AUTHOR_DATE="2010-01-01 20:00:00 +0000" git commit -q -a -m Second',
].join("\n");

const T8006_FILTERS = [
  'echo "*.bin diff=test" >.gitattributes',
  'echo "zero.bin eol=crlf" >>.gitattributes',
  "git config diff.test.textconv ./helper",
  "git config diff.test.cachetextconv false",
].join("\n");

describeGit("git blame textconv against native git (t8006)", () => {
  /** `git blame --porcelain [<textconv option>] [<rev>] -- <path>` in both twins */
  async function compareBlame(
    tw: { native: string; ours: string },
    path: string,
    options: { textconv?: boolean; rev?: string; copies?: number } = {},
  ): Promise<string> {
    const argv = [
      "blame",
      "--porcelain",
      ...(options.textconv === true ? ["--textconv"] : []),
      ...(options.textconv === false ? ["--no-textconv"] : []),
      ...(options.copies ? Array(options.copies).fill("-C") : []),
      ...(options.rev ? [options.rev] : []),
      "--",
      path,
    ];
    const native = git(tw.native, argv);
    expect(native.status, native.stderr).toBe(0);
    const repo = await open(tw.ours);
    const cmd = repo.blame().setFilePath(path);
    if (options.textconv !== undefined) cmd.setTextconv(options.textconv);
    if (options.copies) cmd.setDetectCopies(options.copies);
    if (options.rev) cmd.setStartCommit(git(tw.ours, ["rev-parse", options.rev]).stdout.trim());
    if (!atLeast(2, 50)) cmd.setAlgorithm("myers");
    const result = await cmd.call();
    const ours = Buffer.from(formatBlamePorcelain(result, { lineMarks: atLeast(2, 50) }));
    expect(ours.toString()).toBe(native.stdout);
    return native.stdout;
  }

  const lines = (porcelain: string) =>
    porcelain
      .split("\n")
      .filter((l) => l.startsWith("\t"))
      .map((l) => l.slice(1));

  it("converts every version of the file, as git", async () => {
    const tw = twins(T8006_SETUP);
    // t8006-blame-textconv.sh: "no filter specified"
    expect(lines(await compareBlame(tw, "one.bin"))).toEqual(["bin: test 1 version 2"]);
    for (const dir of [tw.native, tw.ours]) sh(dir, T8006_FILTERS);
    // t8006-blame-textconv.sh: "blame with --no-textconv"
    expect(lines(await compareBlame(tw, "one.bin", { textconv: false }))).toEqual([
      "bin: test 1 version 2",
    ]);
    // t8006-blame-textconv.sh: "basic blame on last commit"
    expect(lines(await compareBlame(tw, "one.bin"))).toEqual(["converted: test 1 version 2"]);
    // t8006-blame-textconv.sh: "blame --textconv going through revisions"
    expect(lines(await compareBlame(tw, "two.bin", { textconv: true }))).toEqual([
      "converted: test number 2",
      "converted: test number 2 version 2",
    ]);
    // t8006-blame-textconv.sh: "setup +cachetextconv"
    for (const dir of [tw.native, tw.ours]) sh(dir, "git config diff.test.cachetextconv true");
    // t8006-blame-textconv.sh: "blame --textconv works with textconvcache"
    await compareBlame(tw, "two.bin", { textconv: true });
    await compareBlame(tw, "one.bin", { textconv: true });
    expect(caches(tw.ours)).toBe(caches(tw.native));
    expect(caches(tw.native)).not.toBe("");
    // t8006-blame-textconv.sh: "setup -cachetextconv"
    for (const dir of [tw.native, tw.ours]) sh(dir, "git config diff.test.cachetextconv false");
    // t8006-blame-textconv.sh: "make a new commit"
    for (const dir of [tw.native, tw.ours]) {
      sh(
        dir,
        'echo "bin: test number 2 version 3" >>two.bin && GIT_AUTHOR_NAME=Number3 GIT_AUTHOR_DATE="2010-01-01 22:00:00 +0000" git commit -q -a -m Third',
      );
    }
    // t8006-blame-textconv.sh: "blame from previous revision"
    expect(lines(await compareBlame(tw, "two.bin", { rev: "HEAD^" }))).toEqual([
      "converted: test number 2",
      "converted: test number 2 version 2",
    ]);
    // t8006-blame-textconv.sh: "blame with --no-textconv (on symlink)"
    expect(lines(await compareBlame(tw, "symlink.bin", { textconv: false }))).toEqual(["two.bin"]);
    // t8006-blame-textconv.sh: "blame --textconv (on symlink)"
    expect(lines(await compareBlame(tw, "symlink.bin", { textconv: true }))).toEqual(["two.bin"]);
    // t8006-blame-textconv.sh: "make another new commit"
    for (const dir of [tw.native, tw.ours]) {
      sh(
        dir,
        [
          "printf 'bin: test number 2\\nbin: test number 2 version 2\\nbin: test number 2 version 3\\nbin: test number 3\\n' >three.bin",
          "git add three.bin",
          'GIT_AUTHOR_NAME=Number4 GIT_AUTHOR_DATE="2010-01-01 23:00:00 +0000" git commit -q -a -m Fourth',
        ].join("\n"),
      );
    }
    // t8006-blame-textconv.sh: "blame on last commit (-C -C, symlink)"
    expect(lines(await compareBlame(tw, "three.bin", { copies: 2 }))).toEqual([
      "converted: test number 2",
      "converted: test number 2 version 2",
      "converted: test number 2 version 3",
      "converted: test number 3",
    ]);
  });

  it("converts the working tree's file without the cache, as git", async () => {
    // t8006-blame-textconv.sh: "blame --textconv with local changes"
    const tw = twins(`${T8006_SETUP}\n${T8006_FILTERS}`);
    for (const dir of [tw.native, tw.ours])
      sh(dir, 'printf "bin: updated number 0\\015" >zero.bin');
    const native = git(tw.native, ["blame", "--porcelain", "--textconv", "zero.bin"]);
    expect(native.status, native.stderr).toBe(0);
    const repo = await open(tw.ours);
    const file = new Uint8Array(readFileSync(join(tw.ours, "zero.bin")));
    const result = await repo
      .blame()
      .setFilePath("zero.bin")
      .setTextconv(true)
      .setContents(file, { workingTree: true, mode: 0o100644 })
      .call();
    const ours = Buffer.from(formatBlamePorcelain(result, { lineMarks: atLeast(2, 50) }));
    // the fake commit is dated now: each side reads its own clock
    const untimed = (out: string) => out.replace(/^(author|committer)-time \d+$/gm, "$1-time T");
    expect(untimed(ours.toString())).toBe(untimed(native.stdout));
    // git converts the file as it lies (its lone CR kept by eol=crlf's clean)
    expect(lines(native.stdout)).toEqual(["converted: updated number 0\r"]);
    // the working tree's file has no object id git knows: nothing is cached
    expect(caches(tw.ours)).toBe(caches(tw.native));
  });
});
