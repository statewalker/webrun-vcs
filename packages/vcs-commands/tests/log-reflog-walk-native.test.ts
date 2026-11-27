/**
 * Reflog walks against native git: `git log -g` / `--walk-reflogs` (reflog-walk.c), its
 * `Reflog:` / `Reflog message:` lines, the `<sel>: <message>` of `--oneline`, the `%g*`
 * placeholders (pretty.c), `<ref>@{<n>}` and `<ref>@{<date>}` selectors and the `--date`
 * magic, `HEAD@{n}` against `refs/heads/x@{n}` naming, `--grep-reflog`, how `-g` combines with
 * `-n`, `--skip`, `--since`/`--until`, `--no-merges`, paths and ranges (and git's refusals),
 * `git reflog [show]`'s `%h %gd: %gs` output and `git reflog exists`.
 *
 * Each case runs one command line through native git and through ours (`RevListCommand` with
 * `setWalkReflogs`, `ReflogCommand.callText`) and compares stdout, stderr and the exit status.
 * The reflogs are written by native git under fixed `GIT_COMMITTER_DATE`s (git's test_tick).
 *
 * Scenario sources: git's t/t1411-reflog-show.sh, t/t1414-reflog-walk.sh, the reflog tests of
 * t/t4202-log.sh and the `show` parts of t/t1410-reflog.sh.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CommitFilters,
  Git,
  type LogOutputOptions,
  RevisionError,
  type RevListCommand,
} from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";

type Outcome = { status: number; out: string; err: string };

/** git's test-lib identities, the committer's date set by {@link Tick} */
function env(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...nativeGitEnv(home),
    GIT_AUTHOR_NAME: "A U Thor",
    GIT_AUTHOR_EMAIL: "author@example.com",
    GIT_COMMITTER_NAME: "C O Mitter",
    GIT_COMMITTER_EMAIL: "committer@example.com",
    ...extra,
  };
}

/** git's test_tick: 1112911993 first, 60 seconds more each time, zone -0700. */
class Tick {
  time = 1112911933;
  next(): Record<string, string> {
    this.time += 60;
    return this.now();
  }
  now(): Record<string, string> {
    const date = `${this.time} -0700`;
    return { GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date };
  }
}

function git(cwd: string, args: string[], extra: Record<string, string> = {}): string {
  return execFileSync("git", args, { cwd, env: env(extra), encoding: "latin1" }).trim();
}

/** test_commit: `<name>.t` holding `<name>`, committed and tagged at the next tick. */
function testCommit(repo: string, tick: Tick, name: string): void {
  writeFileSync(join(repo, `${name}.t`), `${name}\n`);
  git(repo, ["add", `${name}.t`]);
  git(repo, ["commit", "-q", "-m", name], tick.next());
  git(repo, ["tag", name]);
}

function nativeVersion(): [number, number] {
  const m = /(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "latin1" }));
  return [Number(m?.[1]), Number(m?.[2])];
}

/** The native git's version, as ours follows it where versions differ */
const COMPATIBILITY: "2.43" | "2.56" = (() => {
  const [major, minor] = nativeVersion();
  return major === 2 && minor < 56 ? "2.43" : "2.56";
})();

async function open(repo: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: env() });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

type Cmd = "log" | "rev-list" | "reflog" | "reflog show" | "reflog exists";

function native(repo: string, cmd: Cmd, args: string[]): Outcome {
  const r = spawnSync("git", [...cmd.split(" "), ...args], {
    cwd: repo,
    env: env(),
    encoding: "latin1",
  });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/** What our commands print where git dies */
function died(error: unknown): Outcome {
  const message = (error as Error).message;
  const err = error instanceof RevisionError ? `${message}\n` : `fatal: ${message}\n`;
  return { status: 128, out: "", err };
}

/** The command line read into a RevListCommand and the log's output options. */
function readArgs(command: RevListCommand, args: string[], log: LogOutputOptions): void {
  let paths = false;
  const valued: [RegExp, (value: string) => void][] = [
    [/^--(?:pretty|format)=(.*)$/s, (v) => (log.pretty = v)],
    [/^--date=(.*)$/s, (v) => (log.date = v)],
    [/^-n(\d+)$/, (v) => command.setMaxCount(Number(v))],
    [/^-(\d+)$/, (v) => command.setMaxCount(Number(v))],
    [/^--skip=(\d+)$/, (v) => command.setSkip(Number(v))],
    [/^--since=(\d+)$/, (v) => command.setSince(Number(v))],
    [/^--until=(\d+)$/, (v) => command.setUntil(Number(v))],
    [/^--grep=(.*)$/s, (v) => command.addGrep(v)],
    [/^--grep-reflog=(.*)$/s, (v) => command.addGrepReflog(v)],
  ];
  const flags: Record<string, () => void> = {
    "-g": () => command.setWalkReflogs(true),
    "--walk-reflogs": () => command.setWalkReflogs(true),
    "--oneline": () => (log.oneline = true),
    "--abbrev-commit": () => (log.abbrevCommit = true),
    "--no-abbrev-commit": () => (log.abbrevCommit = false),
    "-p": () => (log.patch = true),
    "--graph": () => (log.graph = true),
    "--no-graph": () => (log.graph = false),
    "--reverse": () => command.setReverse(true),
    "--topo-order": () => command.setOrder("topo"),
    "--no-merges": () => command.addCommitFilter(CommitFilters.noMerges()),
    "--all-match": () => command.setAllMatch(true),
    "--invert-grep": () => command.setInvertGrep(true),
  };
  for (const a of args) {
    // revisions and paths as git log reads them (`--` between, else checked against files)
    if (paths || a === "--") {
      paths = true;
      command.addArgument(a);
      continue;
    }
    const flag = flags[a];
    if (flag) {
      flag();
      continue;
    }
    const option = valued.find(([re]) => re.test(a));
    if (option) option[1]((option[0].exec(a) as RegExpExecArray)[1] as string);
    // ref options (`--all`) are revisions; the rest as given on the command line
    else if (/^--(?:all|branches|tags|remotes|glob)/.test(a)) command.addRevision(a);
    else command.addArgument(a);
  }
}

/** The same command line through ours. */
async function ours(repo: string, cmd: Cmd, args: string[]): Promise<Outcome> {
  const g = await open(repo);
  try {
    if (cmd === "reflog" || cmd === "reflog show") {
      // git reflog [show] [<log-options>] [<ref>]: a reflog walk with its own defaults
      const command = g.reflog();
      const log: LogOutputOptions = {};
      const rest: string[] = [];
      for (const [i, a] of args.entries()) {
        if (i === 0 && a === "show") continue;
        const n = /^-(\d+)$/.exec(a);
        if (n) command.setMaxCount(Number(n[1]));
        else if (/^--(?:pretty|format)=/.test(a)) log.pretty = a.slice(a.indexOf("=") + 1);
        else if (a === "--abbrev-commit") log.abbrevCommit = true;
        else if (a === "--no-abbrev-commit") log.abbrevCommit = false;
        else rest.push(a);
      }
      for (const ref of rest) command.setRef(ref);
      const out = await command.callText(log);
      return {
        status: 0,
        out,
        err: command
          .getWarnings()
          .map((w) => `${w}\n`)
          .join(""),
      };
    }
    if (cmd === "reflog exists") {
      const exists = await g
        .reflog()
        .setRef(args[0] as string)
        .callExists();
      return { status: exists ? 0 : 1, out: "", err: "" };
    }
    const command = g.revList();
    if (cmd === "rev-list") command.setCompatibility(COMPATIBILITY).setCommittish(false);
    else command.setCompatibility(COMPATIBILITY);
    const log: LogOutputOptions = {};
    readArgs(command, args, log);
    const out = cmd === "rev-list" ? await command.callText() : await command.callLogText(log);
    const err = command
      .getWarnings()
      .map((w) => `${w}\n`)
      .join("");
    return { status: command.getExitStatus(), out, err };
  } catch (error) {
    return died(error);
  }
}

/** Each command line by native git and by ours. */
async function expectSame(repo: string, cmd: Cmd, cases: string[][]): Promise<Outcome[]> {
  const results: Outcome[] = [];
  for (const args of cases) {
    const n = native(repo, cmd, args);
    const o = await ours(repo, cmd, args);
    expect([cmd, args, o]).toEqual([cmd, args, n]);
    results.push(n);
  }
  return results;
}

describeGit("reflog walks (git log -g, git reflog show) against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-reflog-walk-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(async () => {
    if (root) await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  describe("t1411-reflog-show", () => {
    let repo = "";
    const tick = new Tick();
    beforeAll(() => {
      repo = join(root, "t1411");
      git(root, ["init", "-q", "-b", "main", repo]);
      writeFileSync(join(repo, "file"), "content\n");
      git(repo, ["add", "file"]);
      git(repo, ["commit", "-q", "-m", "one"], tick.next());
    });

    it('t1411-reflog-show.sh: "log -g shows reflog headers", "oneline reflog format", "reflog default format", "override reflog default format"', async () => {
      const [full] = await expectSame(repo, "log", [
        ["-g", "-1"],
        ["-g", "-1", "--oneline"],
      ]);
      expect(full?.out).toContain(
        "Reflog: HEAD@{0} (C O Mitter <committer@example.com>)\nReflog message: commit (initial): one\n",
      );
      await expectSame(repo, "reflog", [["-1"], ["--format=short", "-1"]]);
    });

    it('t1411-reflog-show.sh: "using @{now} syntax shows reflog date (multiline)", "using @{now} syntax shows reflog date (oneline)", "using @{now} syntax shows reflog date (format=%gd)"', async () => {
      const [, , gd] = await expectSame(repo, "log", [
        ["-g", "-1", "HEAD@{now}"],
        ["-g", "-1", "--oneline", "HEAD@{now}"],
        ["-g", "-1", "--format=%gd", "HEAD@{now}"],
      ]);
      expect(gd?.out).toBe("HEAD@{Thu Apr 7 15:13:13 2005 -0700}\n");
    });

    it('t1411-reflog-show.sh: "using --date= shows reflog date (multiline)", "using --date= shows reflog date (oneline)", "using --date= shows reflog date (format=%gd)"', async () => {
      const [, , gd] = await expectSame(repo, "log", [
        ["-g", "-1", "--date=default"],
        ["-g", "-1", "--oneline", "--date=default"],
        ["-g", "-1", "--format=%gd", "--date=raw"],
      ]);
      expect(gd?.out).toBe("HEAD@{1112911993 -0700}\n");
    });

    it('t1411-reflog-show.sh: `log.date does not invoke "--date" magic (multiline)`, `log.date does not invoke "--date" magic (oneline)`, `log.date does not invoke "--date" magic (format=%gd)`', async () => {
      git(repo, ["config", "log.date", "raw"]);
      try {
        await expectSame(repo, "log", [
          ["-g", "-1"],
          ["-g", "-1", "--oneline"],
          ["-g", "-1", "--format=%gd"],
          // an @{now} selector shows the date in log.date's mode
          ["-g", "-1", "--format=%gd", "HEAD@{now}"],
        ]);
      } finally {
        git(repo, ["config", "--unset", "log.date"]);
      }
    });

    it('t1411-reflog-show.sh: "--date magic does not override explicit @{0} syntax"', async () => {
      const [r] = await expectSame(repo, "log", [
        ["-g", "-1", "--format=%gd", "--date=raw", "HEAD@{0}"],
      ]);
      expect(r?.out).toBe("HEAD@{0}\n");
    });

    it('t1411-reflog-show.sh: "empty reflog file"', async () => {
      git(repo, ["branch", "empty"]);
      git(repo, ["reflog", "expire", "--expire=all", "refs/heads/empty"]);
      const [r] = await expectSame(repo, "log", [["-g", "empty"]]);
      expect(r?.out).toBe("");
    });

    it('t1411-reflog-show.sh: "git log -g -p shows diffs vs. parents"', async () => {
      testCommit(repo, tick, "two");
      git(repo, ["branch", "flipflop"]);
      git(repo, ["update-ref", "refs/heads/flipflop", "-m", "flip1", "HEAD^"], tick.next());
      git(repo, ["update-ref", "refs/heads/flipflop", "-m", "flop1", "HEAD"], tick.next());
      git(repo, ["update-ref", "refs/heads/flipflop", "-m", "flip2", "HEAD^"], tick.next());
      await expectSame(repo, "log", [
        ["-g", "-p", "flipflop"],
        ["-g", "--oneline", "-p", "flipflop"],
      ]);
    });
  });

  describe("t1414-reflog-walk", () => {
    let repo = "";
    const tick = new Tick();
    beforeAll(() => {
      repo = join(root, "t1414");
      git(root, ["init", "-q", "-b", "main", repo]);
      testCommit(repo, tick, "one");
      testCommit(repo, tick, "two");
      git(repo, ["checkout", "-q", "-b", "side", "HEAD^"], tick.now());
      testCommit(repo, tick, "three");
      spawnSync("git", ["merge", "-q", "--no-commit", "main"], { cwd: repo, env: env(tick.now()) });
      writeFileSync(join(repo, "one.t"), "one\nevil-merge-content\n");
      git(repo, ["commit", "-q", "--no-edit", "-a"], tick.next());
    });
    const walk = (...args: string[]) => ["-g", "--format=%gd %gs", ...args];

    it('t1414-reflog-walk.sh: "reflog walk shows expected logs"', async () => {
      const [r] = await expectSame(repo, "log", [walk()]);
      expect(r?.out).toBe(
        [
          "HEAD@{0} commit (merge): Merge branch 'main' into side",
          "HEAD@{1} commit: three",
          "HEAD@{2} checkout: moving from main to side",
          "HEAD@{3} commit: two",
          "HEAD@{4} commit (initial): one",
          "",
        ].join("\n"),
      );
    });

    it('t1414-reflog-walk.sh: "reflog can limit with --no-merges", "reflog can limit with pathspecs", "pathspec limiting handles merges"', async () => {
      await expectSame(repo, "log", [
        walk("--no-merges"),
        walk("--", "two.t"),
        walk("--", "one.t"),
        walk("--", "three.t"),
      ]);
    });

    it('t1414-reflog-walk.sh: "walking multiple reflogs shows all", "date-limiting does not interfere with other logs"', async () => {
      await expectSame(repo, "log", [
        walk("--date=unix", "HEAD", "main", "side"),
        walk("HEAD", "main", "side"),
        walk("side", "HEAD"),
        walk("HEAD@{1979-01-01}", "HEAD"),
        walk("HEAD@{2}", "main"),
      ]);
    });

    it("reflog walks beyond t1414-reflog-walk.sh: rev-list -g lists each entry's commit", async () => {
      await expectSame(repo, "rev-list", [
        ["-g", "HEAD"],
        ["-g", "-2", "side"],
      ]);
    });

    it('t1414-reflog-walk.sh: "min/max age uses entry date to limit"', async () => {
      git(repo, ["update-ref", "-m", "before", "refs/heads/minmax", "one"], tick.now());
      const min = tick.next();
      git(repo, ["update-ref", "-m", "min", "refs/heads/minmax", "two"], min);
      const max = tick.next();
      git(repo, ["update-ref", "-m", "max", "refs/heads/minmax", "one"], max);
      git(repo, ["update-ref", "-m", "after", "refs/heads/minmax", "two"], tick.next());
      const since = `--since=${(min.GIT_COMMITTER_DATE as string).split(" ")[0]}`;
      const until = `--until=${(max.GIT_COMMITTER_DATE as string).split(" ")[0]}`;
      const [r] = await expectSame(repo, "log", [["-g", since, until, "--format=%gs", "minmax"]]);
      expect(r?.out).toBe("max\nmin\n");
    });

    it('t1414-reflog-walk.sh: "walk prefers reflog to ref tip"', async () => {
      const dir = join(root, "t1414-tip");
      git(root, ["init", "-q", "-b", "main", dir]);
      const t = new Tick();
      testCommit(dir, t, "A");
      testCommit(dir, t, "B");
      git(dir, ["reflog", "delete", "HEAD@{0}"]);
      const [r] = await expectSame(dir, "log", [["-g", "--format=%H", "-1"]]);
      expect(r?.out).toBe(`${git(dir, ["rev-parse", "A"])}\n`);
    });
  });

  describe("t4202-log", () => {
    let repo = "";
    const tick = new Tick();
    beforeAll(() => {
      repo = join(root, "t4202");
      git(root, ["init", "-q", "-b", "main", repo]);
      testCommit(repo, tick, "first");
      testCommit(repo, tick, "second");
      git(repo, ["checkout", "-q", "-b", "side", "first"], tick.next());
      testCommit(repo, tick, "third");
      git(repo, ["checkout", "-q", "main"], tick.next());
      git(repo, ["merge", "-q", "--no-edit", "side"], tick.next());
    });

    it('t4202-log.sh: "reflog is expected format"', async () => {
      const [a] = await expectSame(repo, "log", [["-g", "--abbrev-commit", "--pretty=oneline"]]);
      const [b] = await expectSame(repo, "reflog", [[]]);
      expect(b?.out).toBe(a?.out);
    });

    it('t4202-log.sh: "log.abbrevCommit configuration" (its reflog part)', async () => {
      await expectSame(repo, "reflog", [["--abbrev-commit"], ["--no-abbrev-commit"]]);
      git(repo, ["config", "log.abbrevCommit", "true"]);
      try {
        await expectSame(repo, "reflog", [[], ["--no-abbrev-commit"]]);
        await expectSame(repo, "log", [["-g", "-2"]]);
      } finally {
        git(repo, ["config", "--unset", "log.abbrevCommit"]);
      }
    });

    it('t4202-log.sh: "--walk-reflogs and --graph conflict", "--walk-reflogs --graph --no-graph works"', async () => {
      const [r] = await expectSame(repo, "log", [
        ["--walk-reflogs", "--graph"],
        ["--walk-reflogs", "--graph", "--no-graph"],
      ]);
      expect(r?.status).toBe(128);
    });

    it("reflog walks beyond t4202-log.sh: -g with -n, --skip, --oneline, the medium format of a merge and the %g placeholders", async () => {
      await expectSame(repo, "log", [
        ["-g", "-3"],
        ["-g", "--skip=2", "-2", "--oneline"],
        ["-g", "--format=%gd|%gD|%gs|%gn|%ge|%gN|%gE|%gx|%h", "side"],
        ["-g", "--format=%gd|%gD", "refs/heads/side"],
        ["-g", "--format=%gd|%gD", "@{0}"],
        ["-g", "--format=%gd|%gD", "@{-1}"],
        ["-g", "--format=%gd|%gD", "HEAD@{1}"],
        ["-g", "--format=%gd|%gD", "side@{now}"],
        ["-g", "--oneline", "--date=raw", "HEAD@{2}"],
        ["-g", "--oneline", "--date=iso", "main"],
        ["-g", "--format=%gd %s", "--date=short", "side@{1}"],
      ]);
    });

    it("reflog walks beyond t4202-log.sh: -g over --all, mixed selectors, @{-1}@{n} and a path with a revision", async () => {
      await expectSame(repo, "log", [
        ["-g", "--format=%gd %gs", "--all"],
        ["-g", "--format=%gd|%gD", "--date=iso", "HEAD@{1}", "main@{now}"],
        ["-g", "--oneline", "@{-1}@{1}"],
        ["-g", "--format=%gd %gs", "side", "--", "third.t"],
        ["-g", "--format=%gd %gs", "--grep-reflog=merge", "--grep-reflog=checkout"],
        ["-g", "--format=%gd %gs", "--invert-grep", "--grep=second"],
        ["-g", "-1", "--date=short", "--format=%gd %gn %ge %gs"],
        ["-g", "--graph", "--reverse"],
      ]);
      await expectSame(repo, "rev-list", [
        ["-g", "--all"],
        ["-g", "main", "^side"],
      ]);
    });

    it("reflog walks beyond t4202-log.sh: --grep-reflog (alone, with --grep, --all-match) and without -g", async () => {
      await expectSame(repo, "log", [
        ["-g", "--oneline", "--grep-reflog=checkout"],
        ["-g", "--oneline", "--grep-reflog=^commit"],
        ["-g", "--oneline", "--grep-reflog=checkout", "--grep=third"],
        ["-g", "--oneline", "--grep-reflog=checkout", "--grep=third", "--all-match"],
        ["--oneline", "--grep-reflog=checkout"],
      ]);
    });

    it("reflog walks beyond t4202-log.sh: -g refuses ranges, exclusions, --reverse and a sorted walk", async () => {
      const results = await expectSame(repo, "log", [
        ["-g", "^side"],
        ["-g", "side..main"],
        ["-g", "HEAD", "--not", "side"],
        ["-g", "--reverse"],
        ["-g", "--topo-order"],
        ["-g", "nosuch"],
      ]);
      for (const r of results) expect(r.status).toBe(128);
    });

    it("reflog walks beyond t4202-log.sh: -g of a ref without a reflog, a tag and a ref given by its full name", async () => {
      git(repo, ["update-ref", "--no-create-reflog", "refs/heads/nolog", "HEAD"]);
      git(repo, ["-c", "core.logAllRefUpdates=false", "branch", "nolog2"]);
      await expectSame(repo, "log", [
        ["-g", "--oneline", "nolog2"],
        ["-g", "--oneline", "third"],
        ["-g", "--oneline", "refs/heads/main", "HEAD"],
      ]);
    });

    it("reflog walks beyond t4202-log.sh: -g of refs/stash and its short name", async () => {
      writeFileSync(join(repo, "first.t"), "changed\n");
      git(repo, ["stash", "-q"], tick.next());
      writeFileSync(join(repo, "first.t"), "changed again\n");
      git(repo, ["stash", "-q"], tick.next());
      await expectSame(repo, "log", [
        ["-g", "--format=%gd %gs", "refs/stash"],
        ["-g", "--format=%gd %gs", "stash"],
        ["-g", "--oneline", "stash@{1}"],
      ]);
      await expectSame(repo, "reflog", [["stash"], ["show", "refs/stash"]]);
    });
  });

  describe("t1410-reflog", () => {
    it('t1410-reflog.sh: "stale dirs do not cause d/f conflicts (reflogs on)", "stale dirs do not cause d/f conflicts (reflogs off)"', async () => {
      const repo = join(root, "t1410-stale");
      git(root, ["init", "-q", "-b", "main", repo]);
      const tick = new Tick();
      testCommit(repo, tick, "A");
      git(repo, ["branch", "one/two", "main"], tick.next());
      const [a] = await expectSame(repo, "log", [["-g", "--format=%gd %gs", "one/two"]]);
      expect(a?.out).toBe("one/two@{0} branch: Created from main\n");
      git(repo, ["branch", "-d", "one/two"]);
      git(repo, ["branch", "one", "main"], tick.next());
      const [b] = await expectSame(repo, "log", [["-g", "--format=%gd %gs", "one"]]);
      expect(b?.out).toBe("one@{0} branch: Created from main\n");
      git(repo, ["branch", "-d", "one"]);
      git(repo, ["branch", "one/two", "main"], tick.next());
      git(repo, ["branch", "-d", "one/two"]);
      git(repo, ["-c", "core.logallrefupdates=false", "branch", "one", "main"]);
      const [c] = await expectSame(repo, "log", [["-g", "--format=%gd %gs", "one"]]);
      expect(c?.out).toBe("");
    });

    it('t1410-reflog.sh: "no segfaults for reflog containing non-commit sha1s"', async () => {
      const repo = join(root, "t1410-tree");
      git(root, ["init", "-q", "-b", "main", repo]);
      const tick = new Tick();
      testCommit(repo, tick, "A");
      testCommit(repo, tick, "B");
      const ref = "refs/tests/tree-in-reflog";
      git(repo, ["update-ref", "--create-reflog", "-m", "Creating ref", ref, "HEAD"], tick.next());
      git(repo, ["update-ref", "-m", "Forcing tree", ref, "HEAD^{tree}"], tick.next());
      git(repo, ["update-ref", "-m", "Restoring to commit", ref, "HEAD"], tick.next());
      const [r] = await expectSame(repo, "reflog", [[ref]]);
      expect(r?.out.split("\n").length - 1).toBe(2);
      await expectSame(repo, "log", [["-g", "--format=%gd %gs", ref]]);
    });

    it('t1410-reflog.sh: "continue walking past root commits"', async () => {
      const repo = join(root, "t1410-orphanage");
      git(root, ["init", "-q", "-b", "main", repo]);
      const tick = new Tick();
      testCommit(repo, tick, "initial");
      git(repo, ["checkout", "-q", "--orphan", "orphan1"], tick.now());
      testCommit(repo, tick, "orphan1-1");
      testCommit(repo, tick, "orphan1-2");
      git(repo, ["checkout", "-q", "--orphan", "orphan2"], tick.now());
      testCommit(repo, tick, "orphan2-1");
      const [r] = await expectSame(repo, "log", [["-g", "--format=%gd %gs"]]);
      expect(r?.out).toBe(
        [
          "HEAD@{0} commit (initial): orphan2-1",
          "HEAD@{1} commit: orphan1-2",
          "HEAD@{2} commit (initial): orphan1-1",
          "HEAD@{3} commit (initial): initial",
          "",
        ].join("\n"),
      );
    });

    it('t1418-reflog-exists.sh: "reflog exists works"', async () => {
      const repo = join(root, "t1410-exists");
      git(root, ["init", "-q", "-b", "main", repo]);
      const tick = new Tick();
      testCommit(repo, tick, "A");
      git(repo, ["branch", "branch"], tick.next());
      await expectSame(repo, "reflog exists", [
        ["refs/heads/main"],
        ["refs/heads/branch"],
        ["refs/heads/non-existent"],
        ["HEAD"],
        ["main"],
      ]);
      git(repo, ["reflog", "delete", "--rewrite", "refs/heads/main@{0}"]);
      await expectSame(repo, "reflog exists", [["refs/heads/main"]]);
    });

    it("reflog walks beyond t1410-reflog.sh: the walk of a reftable repository (git 2.45+)", async (ctx) => {
      const [major, minor] = nativeVersion();
      if (major < 2 || (major === 2 && minor < 45)) ctx.skip();
      const repo = join(root, "t1410-reftable");
      git(root, ["init", "-q", "-b", "main", "--ref-format=reftable", repo]);
      const tick = new Tick();
      testCommit(repo, tick, "A");
      testCommit(repo, tick, "B");
      git(repo, ["checkout", "-q", "-b", "side", "A"], tick.next());
      testCommit(repo, tick, "C");
      await expectSame(repo, "log", [
        ["-g", "--format=%gd %gs"],
        ["-g", "--oneline", "main", "side"],
      ]);
      await expectSame(repo, "reflog", [[], ["main"]]);
    });
  });
});
