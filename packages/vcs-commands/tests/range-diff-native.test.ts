/**
 * `git range-diff` against native git, with the inputs of git's t3206-range-diff: its
 * history (`t/t3206/history.export`, in `fixtures/t3206-history.export`) imported by native
 * git, then each command line run through native git and through ours (`RangeDiffCommand`),
 * comparing stdout and the exit status: the three argument forms, reordered, removed, added
 * and changed commits, renamed files, mode changes, notes, `--no-patch`/`--stat`, `--abbrev`,
 * `--creation-factor`, `--left-only`/`--right-only`, pathspecs, submodules and dual colors.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, type RangeDiffCommand } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";
let repo = "";

type Outcome = { status: number; out: string };
type Env = Record<string, string>;

function env(extra: Env = {}): Env {
  return { ...nativeGitEnv(home), ...extra };
}

function git(cwd: string, args: string[], extra: Env = {}, input?: string): string {
  return execFileSync("git", args, {
    cwd,
    env: env(extra),
    encoding: "latin1",
    ...(input !== undefined ? { input } : {}),
  }).trim();
}

/** git's test_tick: 60 seconds after the last one, zone -0700. */
let tick = 1112911993;
function ticked(): Env {
  tick += 60;
  return { GIT_COMMITTER_DATE: `${tick} -0700`, GIT_AUTHOR_DATE: `${tick} -0700` };
}

/** git's test_commit: a file `<name>.t` holding `<name>`, committed and tagged. */
function testCommit(cwd: string, name: string): void {
  writeFileSync(join(cwd, `${name}.t`), `${name}\n`);
  git(cwd, ["add", `${name}.t`]);
  git(cwd, ["commit", "-q", "-m", name], ticked());
  git(cwd, ["tag", name]);
}

async function open(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const environment = createNodeGitHostEnvironment({ env: env() });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

function native(dir: string, args: string[]): Outcome {
  const r = spawnSync("git", ["range-diff", ...args], { cwd: dir, env: env(), encoding: "latin1" });
  return { status: r.status ?? -1, out: r.stdout };
}

/** `git range-diff <args>` through ours. */
async function ours(dir: string, args: string[]): Promise<Outcome> {
  const g = await open(dir);
  const command: RangeDiffCommand = g.rangeDiff();
  let paths = false;
  for (const a of args) {
    if (paths || a === "--") {
      paths = true;
      command.addArgument(a);
    } else if (a === "--no-color") command.setColor(false);
    else if (a === "--color") command.setColor(true);
    else if (a === "--dual-color") command.setDualColor(true);
    else if (a === "--no-dual-color") command.setDualColor(false);
    else if (a === "--no-patch" || a === "-s") command.setNoPatch(true);
    else if (a === "--stat") command.setStat(true);
    else if (a === "-p") command.setPatch(true);
    else if (a === "--left-only") command.setLeftOnly(true);
    else if (a === "--right-only") command.setRightOnly(true);
    else if (a === "--notes") command.addNotes(true);
    else if (a === "--no-notes") command.addNotes(false);
    else if (a.startsWith("--notes=")) command.addNotes(a.slice(8));
    else if (a.startsWith("--abbrev=")) command.setAbbrev(Number(a.slice(9)));
    else if (a.startsWith("--max-memory=")) command.setMaxMemory(a.slice(13));
    else if (a.startsWith("--creation-factor=")) command.setCreationFactor(Number(a.slice(18)));
    else if (a.startsWith("--submodule=")) {
      // the outer diff's: no submodules in it
    } else command.addArgument(a);
  }
  try {
    return { status: 0, out: Buffer.from(await command.callBytes()).toString("latin1") };
  } catch (error) {
    return { status: (error as { exitCode?: number }).exitCode ?? -1, out: "" };
  } finally {
    g.close();
  }
}

async function expectSame(dir: string, cases: string[][]): Promise<void> {
  for (const args of cases) {
    const n = native(dir, args);
    const o = await ours(dir, args);
    expect([args, o]).toEqual([args, n]);
  }
}

describeGit("git range-diff as native git (t3206-range-diff)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "range-diff-native-"));
    home = join(root, "home");
    mkdirSync(home, { recursive: true });
    repo = join(root, "repo");
    git(root, ["init", "-q", "-b", "main", repo]);
    const history = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "fixtures", "t3206-history.export"),
      "latin1",
    );
    git(repo, ["fast-import", "--quiet"], {}, history);
  });
  afterAll(async () => {
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  it('t3206-range-diff.sh "simple A..B A..C (unmodified)", "simple B...C (unmodified)", "simple A B C (unmodified)", "simple A..B A..C (unmodified) with --abbrev", "A^! and A^-<n> (unmodified)", "trivial reordering", "removed a commit", "added a commit", "new base, A B C", "new base, B...C"', async () => {
    await expectSame(repo, [
      ["--no-color", "main..topic", "main..unmodified"],
      ["--no-color", "topic...unmodified"],
      ["--no-color", "main", "topic", "unmodified"],
      ["--no-color", "--abbrev=10", "main..topic", "main..unmodified"],
      ["--no-color", "topic^!", "unmodified^-1"],
      ["--no-color", "main", "topic", "reordered"],
      ["--no-color", "main", "topic", "removed"],
      ["--no-color", "main", "topic", "added"],
      ["--no-color", "main", "topic", "rebased"],
      ["--no-color", "topic...rebased"],
      ["main..topic", "main..unmodified"],
    ]);
  });

  it('t3206-range-diff.sh "changed commit", "changed commit with --no-patch diff option", "changed commit with --stat diff option", "changed commit with sm config", "renamed file", "file with mode only change", "file added and later removed", "changed message"', async () => {
    await expectSame(repo, [
      ["--no-color", "topic...changed"],
      ["--no-color", "--no-patch", "topic...changed"],
      ["--no-color", "--stat", "topic...changed"],
      ["--no-color", "--submodule=log", "topic...changed"],
      ["--no-color", "--submodule=log", "topic...renamed-file"],
      ["--no-color", "--submodule=log", "topic...mode-only-change"],
      ["--no-color", "--submodule=log", "topic...added-removed"],
      ["--no-color", "topic...changed-message"],
      ["--no-color", "--creation-factor=10", "topic...changed"],
      ["--no-color", "--creation-factor=0", "topic...changed-message"],
      ["--no-color", "--creation-factor=999", "main", "topic", "removed"],
      ["--no-color", "main..topic", "main..renamed-file"],
      ["--no-color", "rebased...added-removed"],
    ]);
  });

  it('t3206-range-diff.sh "dual-coloring"', async () => {
    await expectSame(repo, [
      ["changed...changed-message", "--color", "--dual-color"],
      ["--color", "topic...changed"],
      ["--color", "--no-dual-color", "topic...changed"],
      ["--color", "--no-dual-color", "topic...changed-message"],
      ["--color", "--stat", "topic...changed"],
      ["--color", "main", "topic", "removed"],
    ]);
  });

  it('t3206-range-diff.sh "A^{/..} is not mistaken for a range"', async () => {
    await expectSame(repo, [
      ["topic^..", "topic^{/..}", "--"],
      ["topic"],
      ["--left-only", "--right-only", "topic...changed"],
      ["main", "nosuch", "topic"],
      // the flags are the objects': main..main has no positive side
      ["main..main", "main..topic"],
      ["nope..t1", "main..t2"],
    ]);
  });

  it("--max-memory (git 2.52)", async () => {
    const version = git(root, ["--version"]).replace(/^git version /, "");
    const [major, minor] = version.split(".").map(Number) as [number, number];
    if (major < 2 || (major === 2 && minor < 52)) return;
    await expectSame(repo, [
      ["--max-memory=100", "topic...changed"],
      ["--max-memory=256", "topic...changed"],
      ["--max-memory=257", "--no-color", "topic...changed"],
      ["--max-memory=0x10k", "--no-color", "topic...changed"],
      ["--max-memory=1M", "--no-color", "topic...changed"],
      ["--max-memory=3000", "main", "topic", "removed"],
      ["--max-memory=2g", "--no-color", "topic...changed"],
      ["--max-memory=12x", "topic...changed"],
      ["--max-memory=-1", "topic...changed"],
    ]);
    // the death's message, as git words it
    for (const size of ["100", "255", "0x7"]) {
      const n = spawnSync("git", ["range-diff", `--max-memory=${size}`, "topic...changed"], {
        cwd: repo,
        env: env(),
        encoding: "latin1",
      });
      const g = await open(repo);
      const error = await g
        .rangeDiff()
        .setMaxMemory(size)
        .addArgument("topic...changed")
        .call()
        .then(
          () => undefined,
          (e: Error) => e.message,
        );
      g.close();
      expect([size, `${error}\n`]).toEqual([size, n.stderr]);
    }
  });

  it('t3206-range-diff.sh "range-diff compares notes by default", "range-diff with --no-notes", "range-diff with multiple --notes", "range-diff with --notes=custom does not show default notes"', async () => {
    const dir = join(root, "notes");
    git(root, ["clone", "-q", repo, dir]);
    for (const b of ["topic", "unmodified"]) git(dir, ["branch", "-q", b, `origin/${b}`]);
    git(dir, ["notes", "add", "-m", "topic note", "topic"]);
    git(dir, ["notes", "add", "-m", "unmodified note", "unmodified"]);
    git(dir, ["notes", "--ref=note1", "add", "-m", "topic note1", "topic"]);
    git(dir, ["notes", "--ref=note1", "add", "-m", "unmodified note1", "unmodified"]);
    git(dir, ["notes", "--ref=note2", "add", "-m", "topic note2", "topic"]);
    git(dir, ["notes", "--ref=note2", "add", "-m", "unmodified note2", "unmodified"]);
    await expectSame(dir, [
      ["--no-color", "origin/main..topic", "origin/main..unmodified"],
      ["--no-color", "--no-notes", "origin/main..topic", "origin/main..unmodified"],
      [
        "--no-color",
        "--notes=note1",
        "--notes=note2",
        "origin/main..topic",
        "origin/main..unmodified",
      ],
      ["--notes=note1", "origin/main..topic", "origin/main..unmodified"],
      ["--notes", "--notes=note2", "origin/main..topic", "origin/main..unmodified"],
    ]);
  });

  it('t3206-range-diff.sh "--left-only/--right-only", "ranges with pathspecs", "no commits on one side"', async () => {
    const dir = join(root, "left-right");
    git(root, ["clone", "-q", repo, dir]);
    for (const b of ["topic", "mode-only-change"]) git(dir, ["branch", "-q", b, `origin/${b}`]);
    git(dir, ["switch", "-q", "--orphan", "left-right"]);
    testCommit(dir, "first");
    testCommit(dir, "unmatched");
    testCommit(dir, "common");
    git(dir, ["switch", "-q", "-C", "left-right", "first"]);
    git(dir, ["cherry-pick", "common"], ticked());
    await expectSame(dir, [
      ["-s", "--left-only", "...common"],
      ["-s", "--right-only", "...common"],
      ["--left-only", "common..."],
      ["--right-only", "common...", "--no-color"],
      ["topic...mode-only-change", "--", "other-file"],
      ["topic...mode-only-change", "--", "file"],
      ["first", "HEAD", "HEAD"],
      ["first", "common", "HEAD"],
    ]);
  });

  it("whitespace errors in plain colors, --stat with -p", async () => {
    const dir = join(root, "ws");
    git(root, ["init", "-q", "-b", "main", dir]);
    writeFileSync(join(dir, "f"), "a\nb\nc\n");
    git(dir, ["add", "f"]);
    git(dir, ["commit", "-q", "-m", "base"], ticked());
    const branch = (name: string, content: string) => {
      git(dir, ["checkout", "-q", "-b", name, "main"]);
      writeFileSync(join(dir, "f"), content);
      git(dir, ["commit", "-q", "-am", "change f"], ticked());
      writeFileSync(join(dir, "g"), `${name}\n`);
      git(dir, ["add", "g"]);
      git(dir, ["commit", "-q", "-m", "add g"], ticked());
    };
    branch("one", "a\nB\nc\n");
    branch("two", "a\nB \t\nc\n\n\n");
    await expectSame(dir, [
      ["--color", "--no-dual-color", "main", "one", "two"],
      ["--color", "main", "one", "two"],
      ["--no-color", "--stat", "-p", "main", "one", "two"],
      ["--no-color", "--creation-factor=0", "main", "one", "two"],
    ]);
  });

  it('t3206-range-diff.sh "submodule changes are shown irrespective of diff.submodule"', async () => {
    const dir = join(root, "sub");
    git(root, ["clone", "-q", repo, dir]);
    git(dir, ["branch", "-q", "topic", "origin/topic"]);
    const subRepo = join(root, "sub-repo");
    git(root, ["init", "-q", subRepo]);
    testCommit(subRepo, "sub-first");
    testCommit(subRepo, "sub-second");
    testCommit(subRepo, "sub-third");
    const id = (rev: string) => git(subRepo, ["rev-parse", rev]);
    const gitlink = (rev: string, msg: string) => {
      git(dir, ["update-index", "--add", "--cacheinfo", `160000,${id(rev)},sub`]);
      git(dir, ["commit", "-q", "-m", msg], ticked());
    };
    git(dir, ["checkout", "-q", "-b", "main-sub", "topic"]);
    gitlink("sub-first", "add sub");
    git(dir, ["checkout", "-q", "-b", "topic-sub"]);
    gitlink("sub-second", "change sub");
    git(dir, ["checkout", "-q", "-b", "modified-sub", "main-sub"]);
    gitlink("sub-third", "change sub");
    git(dir, ["config", "diff.submodule", "log"]);
    await expectSame(dir, [
      ["topic", "topic-sub", "modified-sub"],
      ["--creation-factor=100", "topic", "topic-sub", "modified-sub"],
    ]);
    git(dir, ["config", "diff.submodule", "diff"]);
    await expectSame(dir, [["--creation-factor=100", "topic", "topic-sub", "modified-sub"]]);
  });
});
