/**
 * `git rebase --committer-date-is-author-date`, `--ignore-date` (`--reset-author-date`) and
 * `--trailer` against native git, on the fixtures of git's t3436-rebase-more-options and
 * t3440-rebase-trailer (2.46+: under 2.43 `--trailer` is an unknown option).
 *
 * Each twin builds the script's fixture twice with native git (fixed author and committer
 * dates, so the ids match), runs native `git rebase` on one and ours on the other, and
 * compares HEAD, the index, the worktree, the state files (`rebase-merge/cdate_is_adate`,
 * `ignore_date`, `trailer`), every ref, the reflogs, the commits' bytes and what was printed.
 * `--ignore-date` dates the authors with the clock (not `GIT_AUTHOR_DATE`), so those twins
 * compare the histories with the dates of the run replaced.
 *
 * Only the merge backend exists here: the apply backend's scenarios (`--apply`) are left out.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GitApiError,
  type RebaseCommand,
  RebaseOperation,
  type RebaseResult,
} from "../src/index.js";
import {
  INTEROP_AUTHOR_ENV,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  snapshot,
} from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

/** Which git's messages to give: the native git's version */
const NATIVE_COMPAT: "2.43" | "2.56" = /^git version 2\.43\./.test(
  spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "",
)
  ? "2.43"
  : "2.56";
const modern = NATIVE_COMPAT !== "2.43";

/** Native git in `cwd` with extra variables. */
function run(
  cwd: string,
  env: Record<string, string>,
  ...args: string[]
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    env: { ...nativeGitEnv(root), GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", ...env },
    encoding: "utf8",
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const native = (cwd: string, ...args: string[]) => run(cwd, {}, ...args);

/** Native git that must succeed. */
function nativeOk(cwd: string, env: Record<string, string>, ...args: string[]): string {
  const r = run(cwd, env, ...args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A repository built as git's test scripts build theirs (test_tick, test_commit). */
class Script {
  private time = 1112911933;
  /** The scripts' own GIT_AUTHOR_DATE (t3436 exports one), else the tick */
  authorDate?: string;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.git("init", "-q", "-b", "main");
  }
  /** test_tick */
  tick(): void {
    this.time += 60;
  }
  /** Native git dated as the last tick; it must succeed. */
  git(...args: string[]): string {
    return this.gitEnv({}, ...args);
  }
  gitEnv(env: Record<string, string>, ...args: string[]): string {
    const date = `${this.time} -0700`;
    return nativeOk(
      this.dir,
      { GIT_AUTHOR_DATE: this.authorDate ?? date, GIT_COMMITTER_DATE: date, ...env },
      ...args,
    );
  }
  write(file: string, contents: string): void {
    writeFileSync(join(this.dir, file), contents);
  }
  /** test_commit <message> [<file> [<contents> [<tag>]]] */
  commit(message: string, file = `${message}.t`, contents = message, tag = message): void {
    this.write(file, `${contents}\n`);
    this.git("add", "--", file);
    this.tick();
    this.git("commit", "-q", "-m", message);
    this.git("tag", tag);
  }
}

/** The same script run twice: native git's twin and ours. */
function twins(build: (s: Script) => void): { native: string; ours: string } {
  const n = counter++;
  const dirs = { native: join(root, `native-${n}`), ours: join(root, `ours-${n}`) };
  build(new Script(dirs.native));
  build(new Script(dirs.ours));
  return dirs;
}

/** A shell script in the test root, for GIT_EDITOR / GIT_SEQUENCE_EDITOR. */
function script(name: string, body: string): string {
  const path = join(root, `${name}-${counter++}.sh`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return path;
}

/** An editor writing `text` over the file it is given (set_replace_editor, FAKE_COMMIT_MESSAGE). */
function replaceEditor(text: string): string {
  const source = join(root, `text-${counter++}`);
  writeFileSync(source, text);
  return script("editor", `cat '${source}' >"$1"`);
}

/** Every ref with its value, and the reflog of HEAD and every branch. */
function refsAndLogs(dir: string): { refs: string; logs: Record<string, string> } {
  const refs = native(dir, "for-each-ref", "--format=%(refname) %(objectname)").stdout;
  const logs: Record<string, string> = {};
  for (const ref of [
    "HEAD",
    ...native(dir, "for-each-ref", "--format=%(refname)", "refs/heads")
      .stdout.split("\n")
      .filter(Boolean),
  ]) {
    const text = native(dir, "reflog", "show", "--format=%H %gs", ref).stdout;
    // git 2.43 logs a recreated merge with the last pick's or reset's action (a stale
    // GIT_REFLOG_ACTION), 2.5x as `rebase (merge)`
    logs[ref] = modern
      ? text
      : text.replace(
          / rebase(?: \((?:merge|pick|reset)\)(?:: '[^']*')?)?: (Merge )/g,
          " rebase (*): $1",
        );
  }
  return { refs, logs };
}

/** The raw bytes of every commit HEAD reaches. */
function commitBytes(dir: string): string[] {
  return native(dir, "rev-list", "HEAD")
    .stdout.trim()
    .split("\n")
    .map((id) => native(dir, "cat-file", "commit", id).stdout);
}

/**
 * The history as `--ignore-date` leaves it: each commit's tree, parent count, idents and
 * message, the dates at or after `since` (the clock's) replaced.
 */
function historyNow(dir: string, since: number): string {
  const log = native(
    dir,
    "log",
    "--format=%T %p%n%an <%ae> %ad%n%cn <%ce> %cd%n%B%n--",
    "--date=raw",
    "HEAD",
  ).stdout;
  return log
    .replace(/^([0-9a-f]+) ((?:[0-9a-f]+ ?)*)$/gm, (_, tree: string, parents: string) => {
      return `${tree} ${parents.split(" ").filter(Boolean).length}`;
    })
    .replace(/> (\d+) ([+-]\d{4})$/gm, (all, seconds: string, tz: string) =>
      Number(seconds) >= since ? `> <now> ${tz}` : all,
    );
}

/**
 * Lines both print alike: 2.43 shows a todo command's subject without the `# ` ours writes
 * in every version.
 */
const evenOut = (line: string) => line.replace(/^(Could not apply [0-9a-f]+\.\.\. )# /, "$1");

/**
 * What native git printed, without the progress, the final line ours does not print and
 * the summaries of the `git commit` children a reword or a squash runs (ours prints none).
 */
function printed(r: { stdout: string; stderr: string }): string[] {
  return `${r.stdout}\n${r.stderr}`
    .split(/[\r\n]/)
    .filter(
      (l) =>
        l.trim() !== "" &&
        !/^(Rebasing \(|Successfully rebased and updated)/.test(l) &&
        !/^\[.+ [0-9a-f]{7,}\] /.test(l) &&
        !/^ (Date: |\d+ files? changed|(create|delete) mode )/.test(l),
    )
    .map(evenOut);
}

function oursPrinted(result: RebaseResult): string[] {
  return [...(result.output ?? []), ...(result.message ? result.message.split("\n") : [])]
    .filter((l) => l !== "")
    .map(evenOut);
}

/** An option of `git rebase` and the call of ours it stands for. */
type Step = (r: RebaseCommand) => RebaseCommand;

interface TwinOptions {
  /** Variables of native git's run (the editors) */
  env?: Record<string, string>;
  /** `--continue` instead of a new rebase */
  operation?: RebaseOperation;
  /** The dates of the run are the clock's (`--ignore-date`): compared with them replaced */
  since?: number;
}

/** Both twins compared after a step. */
function compare(dirs: { native: string; ours: string }, since?: number): void {
  if (since === undefined) {
    expect(snapshot(root, dirs.ours, normalizeState)).toEqual(
      snapshot(root, dirs.native, normalizeState),
    );
    expect(refsAndLogs(dirs.ours)).toEqual(refsAndLogs(dirs.native));
    expect(commitBytes(dirs.ours)).toEqual(commitBytes(dirs.native));
    return;
  }
  const stripHead = (s: ReturnType<typeof snapshot>) => ({
    ...s,
    head: s.head.replace(/ [0-9a-f]+$/, ""),
    state: Object.fromEntries(
      Object.entries(s.state).map(([k, v]) => [k, v.replace(/\b[0-9a-f]{40}\b/g, "<id>")]),
    ),
  });
  expect(stripHead(snapshot(root, dirs.ours, normalizeState))).toEqual(
    stripHead(snapshot(root, dirs.native, normalizeState)),
  );
  expect(historyNow(dirs.ours, since)).toEqual(historyNow(dirs.native, since));
}

/**
 * `git rebase <args>` in the native twin and ours configured by `configure` in the other;
 * both must agree on the outcome, the repository and the output.
 */
async function rebaseTwins(
  dirs: { native: string; ours: string },
  args: string[],
  configure: Step,
  options: TwinOptions = {},
): Promise<{ status: number; result?: RebaseResult; error?: GitApiError }> {
  const expected = run(dirs.native, options.env ?? {}, "rebase", ...args);
  const git = await openOurs(dirs.ours, INTEROP_AUTHOR_ENV);
  let result: RebaseResult | undefined;
  let error: GitApiError | undefined;
  try {
    const command = git
      .rebase()
      .setCommitter(INTEROP_IDENT)
      .setCompatibility(NATIVE_COMPAT)
      .setExecHandler((line) => ({
        exitCode: spawnSync("sh", ["-c", line], { cwd: dirs.ours }).status ?? 1,
      }));
    if (options.operation) command.setOperation(options.operation);
    result = await configure(command).call();
  } catch (e) {
    if (!(e instanceof GitApiError)) throw e;
    error = e;
  }
  if (error) {
    expect(error.message).toBe(expected.stderr.trim());
    expect(error.exitCode).toBe(expected.status);
  } else {
    const ok = ["ok", "fast-forward", "up-to-date", "edit"].includes(result?.status ?? "");
    // native git's stdout (merge-ort's lines) and stderr are read apart: compared as sets
    expect({ ok, printed: oursPrinted(result as RebaseResult).sort() }).toEqual({
      ok: expected.status === 0,
      printed: printed(expected).sort(),
    });
  }
  compare(dirs, options.since);
  return { status: expected.status, result, error };
}

/** `git rebase --continue` in both. */
function continueTwins(dirs: { native: string; ours: string }, options: TwinOptions = {}) {
  return rebaseTwins(dirs, ["--continue"], (r) => r, {
    ...options,
    operation: RebaseOperation.CONTINUE,
  });
}

/** A user's step run in both twins with native git (resolving a conflict). */
function both(dirs: { native: string; ours: string }, ...args: string[]): void {
  nativeOk(dirs.native, {}, ...args);
  nativeOk(dirs.ours, {}, ...args);
}

/** Our options for the arguments of `git rebase` the scripts use. */
function configureFor(args: string[], handler?: Parameters<RebaseCommand["runInteractively"]>[0]) {
  return (r: RebaseCommand) => {
    let upstream = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i] as string;
      if (a === "--onto") r.setOnto(args[++i] as string);
      else if (a === "--root") r.setRoot(true);
      else if (a === "-m" || a === "--merge") continue;
      else if (a === "-r" || a === "--rebase-merges") r.setRebaseMerges(true);
      else if (a === "-i") r.runInteractively(handler ?? {});
      else if (a === "--committer-date-is-author-date") r.setCommitterDateIsAuthorDate(true);
      else if (a === "--reset-author-date" || a === "--ignore-date") r.setIgnoreDate(true);
      else if (a === "--signoff") r.setSignoff(true);
      else if (a === "--trailer") r.addTrailer(args[++i] as string);
      else if (a.startsWith("--trailer=")) r.addTrailer(a.slice("--trailer=".length));
      else if (a.startsWith("-") && a !== "-") throw new Error(`option ${a}`);
      else if (!upstream && !args.includes("--root")) {
        r.setUpstream(a);
        upstream = true;
      } else r.setBranch(a);
    }
    return r;
  };
}

/** The seconds of the clock now (what `--ignore-date` dates with), a second early. */
const clockNow = () => Math.floor(Date.now() / 1000) - 1;

/** The author and committer dates of `rev`, as `%ad`/`%cd` give them raw. */
function dates(dir: string, rev = "HEAD"): { author: string; committer: string } {
  const [author, committer] = native(dir, "log", "-1", "--format=%ad%n%cd", "--date=raw", rev)
    .stdout.trim()
    .split("\n");
  return { author: author as string, committer: committer as string };
}

describeGit("rebase --committer-date-is-author-date, --ignore-date, --trailer", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rebase-dates-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("t3436-rebase-more-options", () => {
    /** The script's setup: GIT_AUTHOR_DATE fixed, the committer dated by the tick */
    const setup = (s: Script) => {
      s.authorDate = "1999-04-02T08:03:20+05:30";
      s.git("checkout", "-q", "-b", "topic");
      s.write("file", "line 1\n\tline 2\nline 3\n");
      s.git("add", "file");
      s.tick();
      s.git("commit", "-q", "-m", "add file");
      s.write("file", "line 1\nnew line 2\nline 3\n");
      s.tick();
      s.git("commit", "-q", "-am", "update file");
      s.git("tag", "side");
      s.commit("commit1", "foo", "foo1");
      s.commit("commit2", "foo", "foo2");
      s.commit("commit3", "foo", "foo3");
      s.git("checkout", "-q", "--orphan", "main");
      s.git("rm", "-q", "--cached", "foo");
      s.git("clean", "-q", "-f");
      s.write("file", "line 1\n        line 2\nline 3\n");
      s.tick();
      s.git("commit", "-q", "-am", "add file");
      s.git("tag", "main");
      s.git("checkout", "-q", "topic");
    };
    /** `GIT_AUTHOR_DATE="@1234 +0300" git commit --amend --reset-author` on topic */
    const amended = (s: Script) => {
      setup(s);
      s.tick();
      s.gitEnv({ GIT_AUTHOR_DATE: "@1234 +0300" }, "commit", "-q", "--amend", "--reset-author");
    };
    /** `git checkout side && GIT_AUTHOR_DATE="@1234 +0300" git merge --no-ff commit3` */
    const merged = (date?: string) => (s: Script) => {
      setup(s);
      s.git("checkout", "-q", "side");
      s.tick();
      s.gitEnv(date ? { GIT_AUTHOR_DATE: date } : {}, "merge", "-q", "--no-ff", "commit3");
    };

    it('t3436-rebase-more-options.sh: "--committer-date-is-author-date works with merge backend"', async () => {
      const dirs = twins(amended);
      const args = ["-m", "--committer-date-is-author-date", "HEAD^"];
      await rebaseTwins(dirs, args, configureFor(args));
      const d = dates(dirs.ours);
      expect(d.committer).toBe(d.author);
      expect(d.author).toBe("1234 +0300");
    });

    it('t3436-rebase-more-options.sh: "--committer-date-is-author-date works when rewording"', async () => {
      const dirs = twins(amended);
      const args = ["-i", "--committer-date-is-author-date", "HEAD^"];
      const env = {
        GIT_SEQUENCE_EDITOR: script("todo", "sed -i -e '1s/^pick/reword/' \"$1\""),
        GIT_EDITOR: replaceEditor("edited\n"),
      };
      await rebaseTwins(
        dirs,
        args,
        configureFor(args, {
          editTodo: (t) => t.replace(/^pick/, "reword"),
          modifyCommitMessage: () => "edited\n",
        }),
        { env },
      );
      expect(native(dirs.ours, "log", "--format=%B", "-1").stdout).toBe("edited\n\n");
      const d = dates(dirs.ours);
      expect(d.committer).toBe(d.author);
    });

    it('t3436-rebase-more-options.sh: "--committer-date-is-author-date works with rebase -r"', async () => {
      const dirs = twins(merged("@1234 +0300"));
      const args = ["-r", "--root", "--committer-date-is-author-date"];
      await rebaseTwins(dirs, args, configureFor(args));
      for (const rev of ["HEAD", "HEAD^", "HEAD^2", "HEAD~2"]) {
        const d = dates(dirs.ours, rev);
        expect(d.committer).toBe(d.author);
      }
    });

    it('t3436-rebase-more-options.sh: "--committer-date-is-author-date works when committing conflict resolution"', async () => {
      const dirs = twins((s) => {
        setup(s);
        s.git("checkout", "-q", "commit2");
        s.tick();
        s.gitEnv(
          { GIT_AUTHOR_DATE: "@1980 +0000" },
          "commit",
          "-q",
          "--amend",
          "--only",
          "--reset-author",
        );
      });
      const args = ["-m", "--committer-date-is-author-date", "--onto", "HEAD^^", "HEAD^"];
      const { status } = await rebaseTwins(dirs, args, configureFor(args));
      expect(status).not.toBe(0);
      for (const dir of [dirs.native, dirs.ours]) writeFileSync(join(dir, "foo"), "resolved\n");
      both(dirs, "add", "foo");
      await continueTwins(dirs);
      const d = dates(dirs.ours);
      expect(d.author).toBe("1980 +0000");
      expect(d.committer).toBe(d.author);
    });

    it('t3436-rebase-more-options.sh: "--reset-author-date works with merge backend"', async () => {
      const dirs = twins((s) => {
        setup(s);
        s.tick();
        s.git("commit", "-q", "--amend", "--date=1999-04-02T08:03:20+05:30");
      });
      const since = clockNow();
      const args = ["--reset-author-date", "-m", "HEAD^"];
      await rebaseTwins(dirs, args, configureFor(args), { since });
      expect(dates(dirs.ours).author).not.toMatch(/\+0530$/);
      expect(Number(dates(dirs.ours).author.split(" ")[0])).toBeGreaterThanOrEqual(since);
    });

    it('t3436-rebase-more-options.sh: "--reset-author-date works after conflict resolution"', async () => {
      const dirs = twins(setup);
      const since = clockNow();
      const args = ["--reset-author-date", "-m", "--onto", "commit2^^", "commit2^", "commit2"];
      const { status } = await rebaseTwins(dirs, args, configureFor(args), { since });
      expect(status).not.toBe(0);
      for (const dir of [dirs.native, dirs.ours]) writeFileSync(join(dir, "foo"), "resolved\n");
      both(dirs, "add", "foo");
      await continueTwins(dirs, { since });
      expect(Number(dates(dirs.ours).author.split(" ")[0])).toBeGreaterThanOrEqual(since);
    });

    it('t3436-rebase-more-options.sh: "--reset-author-date works with rebase -r"', async () => {
      const dirs = twins(merged());
      const since = clockNow();
      const args = ["-r", "--root", "--reset-author-date"];
      await rebaseTwins(dirs, args, configureFor(args), { since });
      for (const rev of ["HEAD", "HEAD^", "HEAD^2", "HEAD~2"]) {
        expect(Number(dates(dirs.ours, rev).author.split(" ")[0])).toBeGreaterThanOrEqual(since);
      }
    });

    it('t3436-rebase-more-options.sh: "--reset-author-date with --committer-date-is-author-date works"', async () => {
      const dirs = twins(setup);
      const since = clockNow();
      const args = [
        "-m",
        "--committer-date-is-author-date",
        "--reset-author-date",
        "--onto",
        "commit2^^",
        "commit2^",
        "commit3",
      ];
      const { status } = await rebaseTwins(dirs, args, configureFor(args), { since });
      expect(status).not.toBe(0);
      both(dirs, "checkout", "--theirs", "foo");
      both(dirs, "add", "foo");
      await continueTwins(dirs, { since });
      for (const rev of ["HEAD", "HEAD^"]) {
        const d = dates(dirs.ours, rev);
        expect(d.committer).toBe(d.author);
        expect(Number(d.author.split(" ")[0])).toBeGreaterThanOrEqual(since);
      }
    });

    it('t3436-rebase-more-options.sh: "reset-author-date with --committer-date-is-author-date works when rewording"', async () => {
      const dirs = twins(amended);
      const since = clockNow();
      const args = ["-i", "--committer-date-is-author-date", "--reset-author-date", "HEAD^"];
      const env = {
        GIT_SEQUENCE_EDITOR: script("todo", "sed -i -e '1s/^pick/reword/' \"$1\""),
        GIT_EDITOR: replaceEditor("edited\n"),
      };
      await rebaseTwins(
        dirs,
        args,
        configureFor(args, {
          editTodo: (t) => t.replace(/^pick/, "reword"),
          modifyCommitMessage: () => "edited\n",
        }),
        { env, since },
      );
      expect(native(dirs.ours, "log", "--format=%B", "-1").stdout).toBe("edited\n\n");
      const d = dates(dirs.ours);
      expect(d.committer).toBe(d.author);
      expect(Number(d.author.split(" ")[0])).toBeGreaterThanOrEqual(since);
    });

    // the script forks a merge strategy (`--strategy=test`, merge-recursive): the same todo
    // with the builtin merge
    it('t3436-rebase-more-options.sh: "--reset-author-date --committer-date-is-author-date works when forking merge" (builtin strategy)', async () => {
      const dirs = twins(amended);
      const head = native(dirs.native, "rev-parse", "HEAD").stdout.trim();
      const todo = `merge -C ${head} commit3\n`;
      const since = clockNow();
      const args = ["-i", "--reset-author-date", "--committer-date-is-author-date", "side", "side"];
      await rebaseTwins(dirs, args, configureFor(args, { editTodo: () => todo }), {
        env: { GIT_SEQUENCE_EDITOR: replaceEditor(todo) },
        since,
      });
      const d = dates(dirs.ours);
      expect(d.committer).toBe(d.author);
      expect(Number(d.author.split(" ")[0])).toBeGreaterThanOrEqual(since);
    });

    it('t3436-rebase-more-options.sh: "--ignore-date is an alias for --reset-author-date" (merge backend)', async () => {
      const dirs = twins((s) => {
        setup(s);
        s.tick();
        s.git("commit", "-q", "--allow-empty", "-m", "empty", "--date=1999-04-02T08:03:20+05:30");
      });
      const since = clockNow();
      const args = ["-m", "--ignore-date", "HEAD^"];
      await rebaseTwins(dirs, args, configureFor(args), { since });
      expect(Number(dates(dirs.ours).author.split(" ")[0])).toBeGreaterThanOrEqual(since);
    });

    it('t3436-rebase-more-options.sh: "--committer-date-is-author-date works with merge backend" (an exec, a squash and an edit stop)', async () => {
      // the options kept in rebase-merge/ across stops, through an exec and a squash chain
      const dirs = twins(amended);
      const short = (rev: string) => native(dirs.native, "rev-parse", "--short", rev).stdout.trim();
      const todo = `pick ${short("commit1")} commit1\nexec true\nsquash ${short("commit2")} commit2\nedit ${short("HEAD")} commit3\n`;
      const args = ["-i", "--committer-date-is-author-date", "side"];
      await rebaseTwins(dirs, args, configureFor(args, { editTodo: () => todo }), {
        env: { GIT_SEQUENCE_EDITOR: replaceEditor(todo) },
      });
      await continueTwins(dirs);
      for (const rev of ["HEAD", "HEAD^"]) {
        const d = dates(dirs.ours, rev);
        expect(d.committer).toBe(d.author);
      }
    });
  });

  describe("t3440-rebase-trailer", () => {
    const REVIEWED_BY = "Reviewed-by: Dev <dev@example.com>";
    const describeModern = modern ? describe : describe.skip;
    const setup = (s: Script) => {
      s.tick();
      s.git("commit", "-q", "--allow-empty", "-m", "Initial empty commit");
      s.commit("first", "file", "a");
      s.commit("second", "file");
      s.git("checkout", "-q", "-b", "conflict-branch", "first");
      s.commit("file-2", "file-2");
      s.commit("conflict", "file");
      s.commit("third", "file");
      s.git("checkout", "-q", "main");
    };
    const on =
      (branch: string, at: string, config: [string, string][] = []) =>
      (s: Script) => {
        setup(s);
        s.git("checkout", "-q", "-B", branch, at);
        for (const [k, v] of config) s.git("config", k, v);
      };
    const message = (dir: string, rev = "HEAD") =>
      native(dir, "log", "-1", "--format=%B", rev).stdout;

    it("--trailer under git 2.43 is an unknown option (t3440-rebase-trailer is 2.46+)", async () => {
      const dirs = twins(on("old-git", "third"));
      const git = await openOurs(dirs.ours, INTEROP_AUTHOR_ENV);
      const refused = await git
        .rebase()
        .setCompatibility("2.43")
        .addTrailer(REVIEWED_BY)
        .setUpstream("HEAD^")
        .call()
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(GitApiError);
      expect((refused as GitApiError).message).toBe("error: unknown option `trailer'");
      expect((refused as GitApiError).exitCode).toBe(129);
      if (!modern) {
        const r = native(dirs.native, "rebase", "--trailer", REVIEWED_BY, "HEAD^");
        expect(r.status).toBe(129);
        expect(r.stderr.split("\n")[0]).toBe("error: unknown option `trailer'");
      }
      compare(dirs);
    });

    describeModern("git 2.46+", () => {
      it('t3440-rebase-trailer.sh: "reject empty --trailer argument"', async () => {
        const dirs = twins(on("empty-trailer", "third"));
        const args = ["--trailer", "", "HEAD^"];
        const { status, error } = await rebaseTwins(dirs, args, configureFor(args));
        expect(status).toBe(128);
        expect(error?.message).toContain("empty --trailer");
      });

      it('t3440-rebase-trailer.sh: "reject trailer with missing key before separator"', async () => {
        const dirs = twins(on("missing-key", "third"));
        const args = ["--trailer", ": no-key", "HEAD^"];
        const { status, error } = await rebaseTwins(dirs, args, configureFor(args));
        expect(status).toBe(128);
        expect(error?.message).toContain("missing key before separator");
      });

      it('t3440-rebase-trailer.sh: "allow trailer with missing value after separator"', async () => {
        const dirs = twins(on("missing-value", "third"));
        const args = ["--trailer", "Acked-by:", "HEAD^"];
        await rebaseTwins(dirs, args, configureFor(args));
        expect(message(dirs.ours)).toBe("third\n\nAcked-by: \n\n");
      });

      it('t3440-rebase-trailer.sh: "CLI trailer duplicates allowed; replace policy keeps last"', async () => {
        const dirs = twins(
          on("replace-policy", "third", [
            ["trailer.Bug.ifexists", "replace"],
            ["trailer.Bug.ifmissing", "add"],
          ]),
        );
        const args = ["--trailer", "Bug: 123", "--trailer", "Bug: 456", "HEAD^"];
        await rebaseTwins(dirs, args, configureFor(args));
        expect(message(dirs.ours)).toBe("third\n\nBug: 456\n\n");
      });

      it('t3440-rebase-trailer.sh: "multiple Signed-off-by trailers all preserved"', async () => {
        const dirs = twins(on("multiple-signoff", "third"));
        const args = [
          "--trailer",
          "Signed-off-by: Dev A <a@example.com>",
          "--trailer",
          "Signed-off-by: Dev B <b@example.com>",
          "HEAD^",
        ];
        await rebaseTwins(dirs, args, configureFor(args));
        expect(message(dirs.ours)).toBe(
          "third\n\nSigned-off-by: Dev A <a@example.com>\nSigned-off-by: Dev B <b@example.com>\n\n",
        );
      });

      it('t3440-rebase-trailer.sh: "rebase --trailer adds trailer after conflicts"', async () => {
        const dirs = twins((s) => {
          on("trailer-conflict", "third")(s);
          s.commit("fourth", "file");
        });
        const args = ["--trailer", REVIEWED_BY, "second"];
        const { status } = await rebaseTwins(dirs, args, configureFor(args));
        expect(status).not.toBe(0);
        both(dirs, "checkout", "--theirs", "file");
        both(dirs, "add", "file");
        await continueTwins(dirs);
        expect(message(dirs.ours)).toBe(`fourth\n\n${REVIEWED_BY}\n\n`);
        expect(message(dirs.ours, "HEAD^")).toBe(`third\n\n${REVIEWED_BY}\n\n`);
      });

      it('t3440-rebase-trailer.sh: "--trailer handles fixup commands in todo list"', async () => {
        const dirs = twins((s) => {
          on("fixup-trailer", "third")(s);
          s.commit("fixup-base", "base");
          s.commit("fixup-second", "second");
        });
        const fixup = "pick fixup-base fixup-base\nfixup fixup-second fixup-second\n";
        const args = ["-i", "--trailer", REVIEWED_BY, "HEAD~2"];
        await rebaseTwins(dirs, args, configureFor(args, { editTodo: () => fixup }), {
          env: { GIT_SEQUENCE_EDITOR: replaceEditor(fixup) },
        });
        expect(message(dirs.ours)).toBe(`fixup-base\n\n${REVIEWED_BY}\n\n`);

        both(dirs, "reset", "-q", "--hard", "fixup-second");
        const replace = "pick fixup-base fixup-base\nfixup -C fixup-second fixup-second\n";
        await rebaseTwins(dirs, args, configureFor(args, { editTodo: () => replace }), {
          env: { GIT_SEQUENCE_EDITOR: replaceEditor(replace) },
        });
        expect(message(dirs.ours)).toBe(`fixup-second\n\n${REVIEWED_BY}\n\n`);
      });

      it('t3440-rebase-trailer.sh: "--trailer handles fixup commands in todo list" (squash, reword, edit and exec)', async () => {
        const dirs = twins((s) => {
          on("squash-trailer", "third")(s);
          s.commit("fixup-base", "base");
          s.commit("fixup-second", "second");
          s.commit("fixup-third", "third-file");
        });
        const todo =
          "pick fixup-base fixup-base\nsquash fixup-second fixup-second\nexec true\nreword fixup-third fixup-third\nedit third third\n";
        const args = ["-i", "--trailer", REVIEWED_BY, "second"];
        await rebaseTwins(
          dirs,
          args,
          configureFor(args, { editTodo: () => todo, modifyCommitMessage: (m) => m }),
          { env: { GIT_SEQUENCE_EDITOR: replaceEditor(todo) } },
        );
        await continueTwins(dirs);
      });

      it('t3440-rebase-trailer.sh: "rebase --root honors trailer.<name>.key"', async () => {
        const dirs = twins(on("root-trailer", "first", [["trailer.review.key", "Reviewed-by"]]));
        const args = ["--root", "--trailer=review=Dev <dev@example.com>"];
        await rebaseTwins(dirs, args, configureFor(args));
        expect(message(dirs.ours)).toBe("first\n\nReviewed-by: Dev <dev@example.com>\n\n");
        expect(message(dirs.ours, "HEAD^")).toBe(
          "Initial empty commit\n\nReviewed-by: Dev <dev@example.com>\n\n",
        );
      });

      it('t3440-rebase-trailer.sh: "rebase --trailer adds trailer after conflicts" (with --signoff and the date options)', async () => {
        const dirs = twins((s) => {
          on("trailer-conflict", "third")(s);
          s.commit("fourth", "file");
        });
        const args = [
          "--signoff",
          "--committer-date-is-author-date",
          "--trailer",
          REVIEWED_BY,
          "--trailer",
          "Bug: 7",
          "second",
        ];
        const { status } = await rebaseTwins(dirs, args, configureFor(args));
        expect(status).not.toBe(0);
        both(dirs, "checkout", "--theirs", "file");
        both(dirs, "add", "file");
        await continueTwins(dirs);
      });
    });
  });
});
