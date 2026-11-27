/**
 * Symmetric differences against native git: `--left-right`, `--left-only`/`--right-only`,
 * `--cherry-pick`, `--cherry-mark`, `--cherry`, `--count` and `--boundary` of `git rev-list`
 * and `git log` (the `<`/`>`/`=`/`+` marks in rev-list's output, `--oneline`, `--graph` and
 * `%m`), and `git cherry`. Each case runs the same command line through native git and through
 * ours and compares stdout and the exit status.
 *
 * Inputs come from git's t6007-rev-list-cherry-pick-file (whose name-rev post-processing is
 * left out: the ids are compared), t3500-cherry, t6000-rev-list-misc and
 * t4218-log-graph-indentation.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, type LogOutputOptions } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";
/** The native git's version: 2.43 has no visual-root indentation in graphs */
let version243 = false;

type Outcome = { status: number; out: string };

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { ...nativeGitEnv(home), ...extra };
}

function git(cwd: string, args: string[], extra: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd, env: env(extra), encoding: "latin1" }).trim();
}

/** git's test_tick: 60 seconds after the last one, zone -0700. */
function ticker() {
  let tick = 1112911993;
  return () => {
    tick += 60;
    return { GIT_COMMITTER_DATE: `${tick} -0700`, GIT_AUTHOR_DATE: `${tick} -0700` };
  };
}

async function open(repo: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: env() });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

function native(repo: string, args: string[]): Outcome {
  const r = spawnSync("git", args, { cwd: repo, env: env(), encoding: "latin1" });
  return { status: r.status ?? -1, out: r.stdout };
}

/** `git rev-list|log <args>` through ours. */
async function ours(repo: string, args: string[]): Promise<Outcome> {
  const [cmd, ...rest] = args;
  const command = (await open(repo)).revList();
  if (cmd === "rev-list") command.setCommittish(false);
  if (version243) command.setCompatibility("2.43");
  const log: LogOutputOptions = {};
  let paths = false;
  const flags: Record<string, () => void> = {
    "--left-right": () => command.setLeftRight(true),
    "--left-only": () => command.setLeftOnly(true),
    "--right-only": () => command.setRightOnly(true),
    "--cherry-pick": () => command.setCherryPick(true),
    "--cherry-mark": () => command.setCherryMark(true),
    "--cherry": () => command.setCherry(true),
    "--count": () => command.setCount(true),
    "--boundary": () => command.setBoundary(true),
    "--topo-order": () => command.setOrder("topo"),
    "--oneline": () => (log.oneline = true),
    "--graph": () => {
      log.graph = true;
      if (version243) log.graphIndent = false;
    },
  };
  for (const a of rest) {
    if (paths) command.addPath(a);
    else if (a === "--") paths = true;
    else if (flags[a]) flags[a]();
    else if (a.startsWith("--format=")) log.pretty = `tformat:${a.slice(9)}`;
    else if (a.startsWith("--pretty=")) log.pretty = a.slice(9);
    else command.addRevision(a);
  }
  try {
    const out = cmd === "rev-list" ? await command.callText() : await command.callLogText(log);
    return { status: 0, out };
  } catch {
    return { status: 128, out: "" };
  }
}

async function expectSame(repo: string, cases: string[][]): Promise<void> {
  for (const args of cases) {
    const n = native(repo, args);
    const o = await ours(repo, args);
    expect([args, o]).toEqual([args, n]);
  }
}

/** `git cherry <args>` through ours. */
async function oursCherry(repo: string, args: string[]): Promise<Outcome> {
  const command = (await open(repo)).cherry();
  const positional: string[] = [];
  for (const a of args) {
    if (a === "-v") command.setVerbose(true);
    else if (a === "--abbrev") command.setAbbrev(true);
    else if (a.startsWith("--abbrev=")) command.setAbbrev(Number(a.slice(9)));
    else positional.push(a);
  }
  const [upstream, head, limit] = positional;
  if (upstream !== undefined) command.setUpstream(upstream);
  if (head !== undefined) command.setHead(head);
  if (limit !== undefined) command.setLimit(limit);
  try {
    return { status: 0, out: await command.callText() };
  } catch (error) {
    return { status: (error as { exitCode?: number }).exitCode ?? -1, out: "" };
  }
}

async function expectSameCherry(repo: string, cases: string[][]): Promise<void> {
  for (const args of cases) {
    const n = native(repo, ["cherry", ...args]);
    const o = await oursCherry(repo, args);
    expect([args, o]).toEqual([args, n]);
  }
}

describeGit("symmetric differences against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "symmetric-difference-native-"));
    home = join(root, "home");
    mkdirSync(home);
    version243 = /git version 2\.43\./.test(
      execFileSync("git", ["--version"], { encoding: "utf8" }),
    );
  });
  afterAll(async () => {
    if (root) await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  describe("t6007-rev-list-cherry-pick-file", () => {
    let repo = "";
    beforeAll(() => {
      // A---B---D---F
      //  \
      //   C---E
      repo = join(root, "t6007");
      git(root, ["init", "-q", "-b", "main", repo]);
      const tick = ticker();
      const write = (name: string, text: string) => writeFileSync(join(repo, name), `${text}\n`);
      write("foo", "Hallo");
      git(repo, ["add", "foo"]);
      git(repo, ["commit", "-qm", "A"], tick());
      git(repo, ["tag", "A"]);
      git(repo, ["checkout", "-qb", "branch"]);
      write("foo", "Bello");
      write("bar", "Cello");
      git(repo, ["add", "foo", "bar"]);
      git(repo, ["commit", "-qm", "C"], tick());
      git(repo, ["tag", "C"]);
      write("bar", "Dello");
      git(repo, ["add", "bar"]);
      git(repo, ["commit", "-qm", "E"], tick());
      git(repo, ["tag", "E"]);
      git(repo, ["checkout", "-q", "main"]);
      git(repo, ["checkout", "branch", "foo"]);
      git(repo, ["commit", "-qm", "B"], tick());
      git(repo, ["tag", "B"]);
      write("bar", "Cello");
      git(repo, ["add", "bar"]);
      git(repo, ["commit", "-qm", "D"], tick());
      git(repo, ["tag", "D"]);
      write("bar", "Nello");
      git(repo, ["add", "bar"]);
      git(repo, ["commit", "-qm", "F"], tick());
      git(repo, ["tag", "F"]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "--left-right"', async () => {
      await expectSame(repo, [["rev-list", "--left-right", "B...C"]]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "--count"', async () => {
      await expectSame(repo, [["rev-list", "--count", "B...C"]]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "--cherry-pick foo comes up empty"', async () => {
      await expectSame(repo, [["rev-list", "--left-right", "--cherry-pick", "B...C", "--", "foo"]]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "--cherry-pick bar does not come up empty"', async () => {
      await expectSame(repo, [["rev-list", "--left-right", "--cherry-pick", "B...C", "--", "bar"]]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "bar does not come up empty"', async () => {
      await expectSame(repo, [["rev-list", "--left-right", "B...C", "--", "bar"]]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "--cherry-pick bar does not come up empty (II)"', async () => {
      await expectSame(repo, [["rev-list", "--left-right", "--cherry-pick", "F...E", "--", "bar"]]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "name-rev --refs excludes non-matched patterns"', async () => {
      await expectSame(repo, [
        ["rev-list", "--left-right", "--right-only", "--cherry-pick", "F...E", "--", "bar"],
      ]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "--cherry-mark"', async () => {
      await expectSame(repo, [["rev-list", "--cherry-mark", "F...E", "--", "bar"]]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "--cherry-mark --left-right"', async () => {
      await expectSame(repo, [["rev-list", "--cherry-mark", "--left-right", "F...E", "--", "bar"]]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "--cherry-pick --right-only"', async () => {
      await expectSame(repo, [["rev-list", "--cherry-pick", "--right-only", "F...E", "--", "bar"]]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "--cherry-pick --left-only"', async () => {
      await expectSame(repo, [["rev-list", "--cherry-pick", "--left-only", "E...F", "--", "bar"]]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "--cherry"', async () => {
      await expectSame(repo, [["rev-list", "--cherry", "F...E", "--", "bar"]]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "--cherry --count"', async () => {
      await expectSame(repo, [["rev-list", "--cherry", "--count", "F...E", "--", "bar"]]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "--cherry-mark --count"', async () => {
      await expectSame(repo, [["rev-list", "--cherry-mark", "--count", "F...E", "--", "bar"]]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "--cherry-mark --left-right --count"', async () => {
      await expectSame(repo, [
        ["rev-list", "--cherry-mark", "--left-right", "--count", "F...E", "--", "bar"],
      ]);
    });

    it('t6007-rev-list-cherry-pick-file.sh: "--count --left-right"', async () => {
      await expectSame(repo, [["rev-list", "--count", "--left-right", "C...D"]]);
    });

    it("the same ranges through git log: --oneline, --graph, %m, --boundary, whole trees", async () => {
      const ranges = [["F...E"], ["F...E", "--", "bar"], ["B...C", "--", "foo"]];
      const options = [
        ["--left-right", "--oneline"],
        ["--cherry-mark", "--oneline"],
        ["--cherry-mark", "--left-right", "--oneline"],
        ["--cherry-pick", "--left-right", "--oneline"],
        ["--cherry", "--oneline"],
        ["--left-only", "--oneline"],
        ["--right-only", "--format=%m %s"],
        ["--cherry-mark", "--format=%m %s"],
        ["--left-right", "--graph", "--oneline"],
        ["--cherry-mark", "--graph", "--oneline"],
        ["--cherry-mark", "--left-right", "--graph", "--format=%s"],
        ["--left-right", "--boundary", "--oneline"],
        ["--cherry-mark", "--boundary", "--format=%m %s"],
        ["--left-right", "--pretty=medium"],
      ];
      const cases: string[][] = [];
      for (const r of ranges) {
        const [range, ...paths] = r;
        for (const o of options) cases.push(["log", ...o, range as string, ...paths]);
      }
      await expectSame(repo, cases);
      await expectSame(repo, [
        ["rev-list", "--left-right", "--boundary", "F...E"],
        ["rev-list", "--cherry-mark", "--boundary", "F...E", "--", "bar"],
        ["rev-list", "--cherry-pick", "--boundary", "--left-right", "F...E", "--", "bar"],
        ["rev-list", "--cherry-mark", "--left-right", "--topo-order", "F...E"],
        ["rev-list", "--left-right", "E...F", "^C"],
        ["rev-list", "--left-right", "F...E", "--not", "D"],
        ["rev-list", "--right-only", "F", "E"],
        ["rev-list", "--left-only", "F", "E"],
      ]);
    });

    describe("independent and duplicated branches", () => {
      beforeAll(() => {
        const tick = ticker();
        for (let k = 0; k < 6; k++) tick();
        git(repo, ["symbolic-ref", "HEAD", "refs/heads/independent"]);
        rmSync(join(repo, ".git", "index"));
        writeFileSync(join(repo, "foo"), "Hallo\n");
        git(repo, ["add", "foo"]);
        git(repo, ["commit", "-qm", "independent"], tick());
        writeFileSync(join(repo, "foo"), "Bello\n");
        git(repo, ["commit", "-qm", "independent, too", "foo"], tick());
      });

      it('t6007-rev-list-cherry-pick-file.sh: "--cherry-pick with independent, but identical branches"', async () => {
        await expectSame(repo, [
          ["rev-list", "--left-right", "--cherry-pick", "HEAD...main", "--", "foo"],
          ["rev-list", "--left-right", "--cherry-mark", "HEAD...main", "--", "foo"],
        ]);
      });

      it('t6007-rev-list-cherry-pick-file.sh: "--cherry-pick with duplicates on each side"', async () => {
        const tick = ticker();
        for (let k = 0; k < 10; k++) tick();
        git(repo, ["checkout", "-qb", "dup-orig"]);
        writeFileSync(join(repo, "dup-base.t"), "dup-base\n");
        git(repo, ["add", "dup-base.t"]);
        git(repo, ["commit", "-qm", "dup-base"], tick());
        git(repo, ["tag", "dup-base"]);
        git(repo, ["revert", "--no-edit", "dup-base"], tick());
        git(repo, ["cherry-pick", "dup-base"], tick());
        git(repo, ["checkout", "-qb", "dup-side", "HEAD~3"]);
        git(repo, ["cherry-pick", "-3", "dup-orig"], tick());
        await expectSame(repo, [
          ["rev-list", "--cherry-pick", "dup-orig...dup-side"],
          ["rev-list", "--cherry-mark", "--left-right", "dup-orig...dup-side"],
          ["rev-list", "--cherry-mark", "--count", "dup-orig...dup-side"],
        ]);
      });

      it('t6007-rev-list-cherry-pick-file.sh: "--cherry-pick avoids looking at full diffs"', async () => {
        const tick = ticker();
        for (let k = 0; k < 20; k++) tick();
        git(repo, ["checkout", "-qb", "shy-diff"]);
        writeFileSync(join(repo, "dont-look-at-me.t"), "dont-look-at-me\n");
        git(repo, ["add", "dont-look-at-me.t"]);
        git(repo, ["commit", "-qm", "dont-look-at-me"], tick());
        writeFileSync(join(repo, "dont-look-at-me.t"), "Hello\n");
        git(repo, ["commit", "-qm", "tip", "dont-look-at-me.t"], tick());
        git(repo, ["checkout", "-qb", "mainline", "HEAD^"]);
        writeFileSync(join(repo, "to-cherry-pick.t"), "to-cherry-pick\n");
        git(repo, ["add", "to-cherry-pick.t"]);
        git(repo, ["commit", "-qm", "to-cherry-pick"], tick());
        // the object store corrupted: the blob is never read
        const blob = git(repo, ["rev-parse", "shy-diff^:dont-look-at-me.t"]);
        unlinkSync(join(repo, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
        await expectSame(repo, [["rev-list", "--cherry-pick", "...shy-diff"]]);
        expect(native(repo, ["rev-list", "--cherry-pick", "...shy-diff"]).status).toBe(0);
      });
    });
  });

  describe("t6000-rev-list-misc", () => {
    let repo = "";
    beforeAll(() => {
      repo = join(root, "t6000");
      git(root, ["init", "-q", "-b", "main", repo]);
      const tick = ticker();
      for (const name of ["one", "two"]) {
        writeFileSync(join(repo, name), `${name}\n`);
        git(repo, ["add", name]);
        git(repo, ["commit", "-qm", name], tick());
      }
      git(repo, ["checkout", "-qb", "side", "HEAD~1"]);
      git(repo, ["commit", "-q", "--allow-empty", "-m", "that"], tick());
      git(repo, ["commit", "-q", "--allow-empty", "-m", "another"], tick());
      git(repo, ["tag", "-a", "-m", "annotated", "v1.0"], tick());
      git(repo, ["checkout", "-q", "main"]);
    });

    it('t6000-rev-list-misc.sh: "symleft flag bit is propagated down from tag"', async () => {
      await expectSame(repo, [
        ["log", "--format=%m %s", "--left-right", "v1.0...main"],
        ["rev-list", "--left-right", "v1.0...main"],
        ["rev-list", "--left-only", "--count", "v1.0...main"],
      ]);
    });

    it('t6000-rev-list-misc.sh: "rev-list one-sided unrelated symmetric diff"', async () => {
      const tick = ticker();
      for (let k = 0; k < 10; k++) tick();
      git(repo, ["commit", "-q", "--allow-empty", "-m", "xyz"], tick());
      git(repo, ["branch", "cmp"]);
      git(repo, ["rebase", "-q", "--force-rebase", "--root"], tick());
      await expectSame(repo, [
        ["rev-list", "--left-only", "HEAD...cmp"],
        ["rev-list", "--right-only", "HEAD...cmp"],
        // empty commits on both sides have the same (null) patch-id
        ["rev-list", "--cherry-mark", "--left-right", "HEAD...cmp"],
      ]);
    });
  });

  describe("t4218-log-graph-indentation", () => {
    let repo = "";
    beforeAll(() => {
      repo = join(root, "t4218");
      git(root, ["init", "-q", "-b", "main", repo]);
      const tick = ticker();
      const orphan = (branch: string, commits: string[]) => {
        git(repo, ["checkout", "-q", "--orphan", branch]);
        spawnSync("git", ["rm", "-rqf", "."], { cwd: repo, env: env() });
        for (const c of commits) {
          writeFileSync(join(repo, `${c}.t`), `${c}\n`);
          git(repo, ["add", `${c}.t`]);
          git(repo, ["commit", "-qm", c], tick());
        }
      };
      orphan("_1", ["1_A"]);
      orphan("_2", ["2_A", "2_B"]);
      orphan("_3", ["3_A"]);
    });

    it('t4218-log-graph-indentation.sh: "visual root indentation with --left-right", "visual root indentation with --left-right having unrelated commits on the same side"', async () => {
      await expectSame(repo, [
        ["log", "--graph", "--format=%s", "--left-right", "_2..._3"],
        ["log", "--graph", "--format=%s", "--left-right", "_2..._3", "_1"],
      ]);
    });
  });

  describe("t3500-cherry", () => {
    let repo = "";
    beforeAll(() => {
      repo = join(root, "t3500");
      git(root, ["init", "-q", "-b", "main", repo]);
      const tick = ticker();
      const commit = (file: string, text: string, message: string, append = false) => {
        writeFileSync(join(repo, file), text, append ? { flag: "a" } : {});
        git(repo, ["update-index", "--add", file]);
        git(repo, ["commit", "-qm", message], {
          ...tick(),
          GIT_AUTHOR_EMAIL: "bogus_email_address",
        });
      };
      commit("A", "First\n", "Add A.");
      git(repo, ["checkout", "-qb", "my-topic-branch"]);
      commit("B", "Second\n", "Add B.");
      commit("C", "AnotherSecond\n", "Add C.");
      git(repo, ["checkout", "-qf", "main"]);
      rmSync(join(repo, "B"), { force: true });
      rmSync(join(repo, "C"), { force: true });
      commit("A", "Third\n", "Modify A.", true);
    });

    it('t3500-cherry.sh: "prepare repository with topic branch, and check cherry finds the 2 patches from there"', async () => {
      await expectSameCherry(repo, [
        ["main", "my-topic-branch"],
        ["-v", "main", "my-topic-branch"],
        ["--abbrev", "main", "my-topic-branch"],
        ["--abbrev=10", "-v", "main", "my-topic-branch"],
        ["my-topic-branch", "main"],
        ["main", "main"],
        ["main", "nope"],
      ]);
    });

    it('t3500-cherry.sh: "check that cherry with limit returns only the top patch"', async () => {
      await expectSameCherry(repo, [["main", "my-topic-branch", "my-topic-branch^1"]]);
    });

    it('t3500-cherry.sh: "cherry-pick one of the 2 patches, and check cherry recognized one and only one as new"', async () => {
      git(repo, ["cherry-pick", "my-topic-branch^0"], ticker()());
      await expectSameCherry(repo, [
        ["main", "my-topic-branch"],
        ["-v", "main", "my-topic-branch"],
      ]);
      await expectSame(repo, [
        ["rev-list", "--cherry", "main...my-topic-branch"],
        ["log", "--cherry-mark", "--left-right", "--oneline", "main...my-topic-branch"],
      ]);
    });

    it('t3500-cherry.sh: "cherry ignores whitespace"', async () => {
      const tick = ticker();
      for (let k = 0; k < 10; k++) tick();
      const commit = (file: string, text: string, message: string) => {
        writeFileSync(join(repo, file), text);
        git(repo, ["add", file]);
        git(repo, ["commit", "-qm", message], tick());
      };
      git(repo, ["switch", "-q", "--orphan=upstream-with-space"]);
      commit("file", "initial\n", "initial");
      git(repo, ["switch", "-q", "--create=feature-without-space"]);
      commit("file", "space", "file without space");
      commit("file", "change\n", "change");
      git(repo, ["switch", "-q", "upstream-with-space"]);
      commit("file", "s p a c e", "file with space");
      await expectSameCherry(repo, [
        ["upstream-with-space", "feature-without-space"],
        ["-v", "upstream-with-space", "feature-without-space"],
      ]);
      // HEAD as the default head, and the current branch's upstream as the default upstream
      git(repo, ["switch", "-q", "feature-without-space"]);
      git(repo, ["branch", "-q", "--set-upstream-to=upstream-with-space"]);
      await expectSameCherry(repo, [[], ["upstream-with-space"]]);
    });
  });
});
