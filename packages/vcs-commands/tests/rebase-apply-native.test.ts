/**
 * `git rebase --apply` (the am-based backend: `git format-patch | git am --rebasing`) and
 * its options `--whitespace=<action>`, `-C<n>`, `--ignore-whitespace` against native git,
 * on the fixtures of git's t3417-rebase-whitespace-fix and t3436-rebase-more-options.
 *
 * Each twin builds the script's fixture twice with native git (fixed author and committer
 * dates, so the ids match), runs native `git rebase` on one and ours on the other, and
 * compares HEAD, the index, the worktree, every ref, the reflogs, the commits' bytes, the
 * `rebase-apply/` state of a stopped rebase (the split mails by name only: ours are not
 * format-patch's bytes, and `am --rebasing` reads nothing of them but the `From <id>` line)
 * and what was printed. git 3.0's `breakingChanges` changes nothing here (only rebase's
 * `core.commentChar=auto` warning), so there is no `$GIT3` twin.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function run(
  cwd: string,
  env: Record<string, string>,
  ...args: string[]
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    env: { ...nativeGitEnv(root), GIT_EDITOR: "true", ...env },
    encoding: "utf8",
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const native = (cwd: string, ...args: string[]) => run(cwd, {}, ...args);

function nativeOk(cwd: string, env: Record<string, string>, ...args: string[]): string {
  const r = run(cwd, env, ...args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A repository built as git's test scripts build theirs (test_tick, test_commit). */
class Script {
  private time = 1112911933;
  authorDate?: string;
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.git("init", "-q", "-b", "main");
  }
  tick(): void {
    this.time += 60;
  }
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
  commit(message: string, file = `${message}.t`, contents = message): void {
    this.write(file, `${contents}\n`);
    this.git("add", "--", file);
    this.tick();
    this.git("commit", "-q", "-m", message);
    this.git("tag", message);
  }
}

type Dirs = { native: string; ours: string };

function twins(build: (s: Script) => void): Dirs & { scripts: Script[] } {
  const n = counter++;
  const dirs = { native: join(root, `native-${n}`), ours: join(root, `ours-${n}`) };
  const a = new Script(dirs.native);
  const b = new Script(dirs.ours);
  build(a);
  build(b);
  return { ...dirs, scripts: [a, b] };
}

/** A step run in both twins with native git, dated alike. */
function both(dirs: { scripts: Script[] }, step: (s: Script) => void): void {
  for (const s of dirs.scripts) step(s);
}

function refsAndLogs(dir: string): { refs: string; logs: Record<string, string> } {
  const refs = native(dir, "for-each-ref", "--format=%(refname) %(objectname)").stdout;
  const logs: Record<string, string> = {};
  for (const ref of [
    "HEAD",
    ...native(dir, "for-each-ref", "--format=%(refname)", "refs/heads")
      .stdout.split("\n")
      .filter(Boolean),
  ]) {
    logs[ref] = native(dir, "reflog", "show", "--format=%H %gs", ref).stdout;
  }
  return { refs, logs };
}

function commitBytes(dir: string): string[] {
  return native(dir, "rev-list", "HEAD")
    .stdout.trim()
    .split("\n")
    .map((id) => native(dir, "cat-file", "commit", id).stdout);
}

/** `rebase-apply/` as both keep it: the split mails by name, every other file's content. */
function applyState(dir: string): Record<string, string> {
  const path = join(dir, ".git", "rebase-apply");
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const name of readdirSync(path).sort()) {
    // patch-merge-index: the temporary index of am's three-way fallback, ours in memory
    if (name === "patch-merge-index") continue;
    out[name] = /^\d{4}$/.test(name) ? "<mail>" : readFileSync(join(path, name), "latin1");
  }
  return out;
}

/**
 * The repository as both twins are compared; git 2.43's `am` falls back on merge-recursive,
 * which writes no AUTO_MERGE (2.5x's merge-ort does, as ours).
 */
function snap(dir: string) {
  const s = snapshot(root, dir, normalizeState);
  if (NATIVE_COMPAT === "2.43") delete s.state.AUTO_MERGE;
  return s;
}

function compare(dirs: Dirs): void {
  expect(snap(dirs.ours)).toEqual(snap(dirs.native));
  expect(applyState(dirs.ours)).toEqual(applyState(dirs.native));
  expect(native(dirs.ours, "rev-parse", "ORIG_HEAD").stdout).toBe(
    native(dirs.native, "rev-parse", "ORIG_HEAD").stdout,
  );
  expect(refsAndLogs(dirs.ours)).toEqual(refsAndLogs(dirs.native));
  expect(commitBytes(dirs.ours)).toEqual(commitBytes(dirs.native));
}

/** 2.43 shows a todo command's subject without the `# ` ours writes in every version. */
const evenOut = (line: string) => line.replace(/^(Could not apply [0-9a-f]+\.\.\. )# /, "$1");

/** What native git printed, without the merge backend's progress and final line. */
function printed(r: { stdout: string; stderr: string }): string[] {
  return `${r.stdout}\n${r.stderr}`
    .split(/[\r\n]/)
    .filter((l) => l.trim() !== "" && !/^(Rebasing \(|Successfully rebased and updated)/.test(l))
    .map(evenOut);
}

function oursPrinted(result: RebaseResult): string[] {
  return [...(result.output ?? []), ...(result.message ? result.message.split("\n") : [])]
    .filter((l) => l.trim() !== "")
    .map(evenOut);
}

/** Our options for the arguments of `git rebase` the scripts use. */
function configureFor(args: string[]) {
  return (r: RebaseCommand) => {
    let upstream = false;
    for (const a of args) {
      if (a === "--apply") r.setBackend("apply");
      else if (a === "-m" || a === "--merge") r.setBackend("merge");
      else if (a === "--ignore-whitespace") r.setIgnoreWhitespace(true);
      else if (a.startsWith("--whitespace=")) r.setWhitespace(a.slice("--whitespace=".length));
      else if (/^-C\d*$/.test(a)) r.setContext(a.slice(2));
      else if (a === "--committer-date-is-author-date") r.setCommitterDateIsAuthorDate(true);
      else if (a === "--reset-author-date" || a === "--ignore-date") r.setIgnoreDate(true);
      else if (a === "--signoff") r.setSignoff(true);
      else if (a === "--continue") r.setOperation(RebaseOperation.CONTINUE);
      else if (a === "--skip") r.setOperation(RebaseOperation.SKIP);
      else if (a === "--abort") r.setOperation(RebaseOperation.ABORT);
      else if (a.startsWith("-")) throw new Error(`option ${a}`);
      else if (!upstream) {
        r.setUpstream(a);
        upstream = true;
      } else r.setBranch(a);
    }
    return r;
  };
}

/**
 * `git rebase <args>` in the native twin and ours with the same arguments; both must agree
 * on the outcome, the repository and the output. Returns native git's exit status.
 */
async function rebaseTwins(
  dirs: Dirs,
  args: string[],
  options: { since?: number; env?: Record<string, string> } = {},
): Promise<number> {
  const expected = run(dirs.native, options.env ?? {}, "rebase", ...args);
  const git = await openOurs(dirs.ours, INTEROP_AUTHOR_ENV);
  let result: RebaseResult | undefined;
  let error: GitApiError | undefined;
  try {
    const command = git.rebase().setCommitter(INTEROP_IDENT).setCompatibility(NATIVE_COMPAT);
    result = await configureFor(args)(command).call();
  } catch (e) {
    if (!(e instanceof GitApiError)) throw e;
    error = e;
  }
  if (error) {
    expect(error.message).toBe(expected.stderr.trim());
    expect(error.exitCode).toBe(expected.status);
  } else {
    const ok = ["ok", "fast-forward", "up-to-date", "aborted"].includes(result?.status ?? "");
    expect({ ok, printed: oursPrinted(result as RebaseResult).sort() }).toEqual({
      ok: expected.status === 0,
      printed: printed(expected).sort(),
    });
  }
  if (options.since === undefined) compare(dirs);
  else {
    expect(historyNow(dirs.ours, options.since)).toEqual(historyNow(dirs.native, options.since));
    expect(snapshot(root, dirs.ours, normalizeState).files).toEqual(
      snapshot(root, dirs.native, normalizeState).files,
    );
  }
  return expected.status;
}

/** The history with the dates at or after `since` (the clock's) replaced. */
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

function dates(dir: string, rev = "HEAD"): { author: string; committer: string } {
  const [author, committer] = native(dir, "log", "-1", "--format=%ad%n%cd", "--date=raw", rev)
    .stdout.trim()
    .split("\n");
  return { author: author as string, committer: committer as string };
}

describeGit("git rebase --apply against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rebase-apply-native-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("t3417-rebase-whitespace-fix", () => {
    const second = "a\nb\nc\n\nd\ne\nf\n\n\n\n\n";
    const third = "a\nb\nc\n\nd\ne\nf\n    \n \nh\ni\nj\nk\nl\n";
    const first = (s: Script) => {
      s.write("file", "a\nb\nc\n\n");
      s.tick();
      s.git("commit", "-q", "--allow-empty", "-m", "Initial empty commit");
      s.git("add", "file");
      s.tick();
      s.git("commit", "-q", "-m", "first");
      s.write("file", second);
      s.git("add", "file");
      s.tick();
      s.git("commit", "-q", "-m", "second");
    };
    const withThird = (s: Script) => {
      first(s);
      s.git("rebase", "-q", "--whitespace=fix", "HEAD^^");
      s.write("file", third);
      s.git("add", "file");
      s.tick();
      s.git("commit", "-q", "-m", "third");
    };

    it('t3417-rebase-whitespace-fix.sh: "blank line at end of file; extend at end of file"', async () => {
      const dirs = twins(first);
      expect(await rebaseTwins(dirs, ["--whitespace=fix", "HEAD^^"])).toBe(0);
      expect(readFileSync(join(dirs.ours, "file"), "utf8")).toBe("a\nb\nc\n\nd\ne\nf\n");
    });

    it('t3417-rebase-whitespace-fix.sh: "two blanks line at end of file; extend at end of file"', async () => {
      const dirs = twins(withThird);
      expect(await rebaseTwins(dirs, ["--whitespace=fix", "HEAD^^"])).toBe(0);
    });

    it('t3417-rebase-whitespace-fix.sh: "same, but do not remove trailing spaces"', async () => {
      const dirs = twins((s) => {
        withThird(s);
        s.git("rebase", "-q", "--whitespace=fix", "HEAD^^");
        s.git("config", "core.whitespace", "-blank-at-eol");
        s.git("reset", "-q", "--hard", "HEAD^");
        s.write("file", third);
        s.git("add", "file");
        s.tick();
        s.git("commit", "-q", "-m", "third");
      });
      expect(await rebaseTwins(dirs, ["--whitespace=fix", "HEAD^^"])).toBe(0);
      expect(readFileSync(join(dirs.ours, "file"), "utf8")).toBe(third);
    });

    it('t3417-rebase-whitespace-fix.sh: "at beginning of file"', async () => {
      const dirs = twins((s) => {
        s.tick();
        s.git("commit", "-q", "--allow-empty", "-m", "Initial empty commit");
        s.git("config", "core.whitespace", "blank-at-eol");
        s.write("file", "a\n\t\t    \n       \n");
        s.git("add", "file");
        s.tick();
        s.git("commit", "-q", "-m", "beginning", "file");
        s.write("file", "a\n\t\t    \n       \n1\n2\n3\n4\n5\n");
        s.tick();
        s.git("commit", "-q", "-m", "more", "file");
      });
      expect(await rebaseTwins(dirs, ["--whitespace=fix", "HEAD^^"])).toBe(0);
    });
  });

  describe("t3436-rebase-more-options", () => {
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

    it('t3436-rebase-more-options.sh: "--ignore-whitespace works with apply backend"', async () => {
      const dirs = twins(setup);
      expect(await rebaseTwins(dirs, ["--apply", "main", "side"])).toBe(1);
      expect(await rebaseTwins(dirs, ["--abort"])).toBe(0);
      expect(await rebaseTwins(dirs, ["--apply", "--ignore-whitespace", "main", "side"])).toBe(0);
      expect(native(dirs.ours, "diff", "--exit-code", "side").status).toBe(0);
    });

    it('t3436-rebase-more-options.sh: "--ignore-whitespace works with merge backend"', async () => {
      const dirs = twins(setup);
      expect(await rebaseTwins(dirs, ["--merge", "main", "side"])).toBe(1);
      expect(await rebaseTwins(dirs, ["--abort"])).toBe(0);
      expect(await rebaseTwins(dirs, ["--merge", "--ignore-whitespace", "main", "side"])).toBe(0);
      expect(native(dirs.ours, "diff", "--exit-code", "side").status).toBe(0);
    });

    it('t3436-rebase-more-options.sh: "--committer-date-is-author-date works with apply backend"', async () => {
      const dirs = twins((s) => {
        setup(s);
        s.tick();
        s.gitEnv({ GIT_AUTHOR_DATE: "@1234 +0300" }, "commit", "-q", "--amend", "--reset-author");
      });
      await rebaseTwins(dirs, ["--apply", "--committer-date-is-author-date", "HEAD^"]);
      const d = dates(dirs.ours);
      expect(d.committer).toBe(d.author);
      expect(d.author).toBe("1234 +0300");
    });

    it('t3436-rebase-more-options.sh: "--reset-author-date works with apply backend"', async () => {
      const dirs = twins((s) => {
        setup(s);
        s.tick();
        s.git("commit", "-q", "--amend", "--date=1999-04-02T08:03:20+05:30");
      });
      const since = Math.floor(Date.now() / 1000);
      await rebaseTwins(dirs, ["--apply", "--reset-author-date", "HEAD^"], { since });
      expect(Number(dates(dirs.ours).author.split(" ")[0])).toBeGreaterThanOrEqual(since);
    });

    it('t3436-rebase-more-options.sh: "--ignore-date is an alias for --reset-author-date" (apply backend)', async () => {
      const dirs = twins((s) => {
        setup(s);
        s.tick();
        s.git("commit", "-q", "--amend", "--date=1999-04-02T08:03:20+05:30");
      });
      const since = Math.floor(Date.now() / 1000);
      await rebaseTwins(dirs, ["--apply", "--ignore-date", "HEAD^"], { since });
    });

    it('t3436-rebase-more-options.sh: "--ignore-whitespace works with apply backend" (a conflict resolved, then --continue)', async () => {
      const dirs = twins(setup);
      expect(await rebaseTwins(dirs, ["--apply", "main", "side"])).toBe(1);
      both(dirs, (s) => {
        s.write("file", "line 1\nnew line 2\nline 3\n");
        s.git("add", "file");
      });
      expect(await rebaseTwins(dirs, ["--continue"])).toBe(0);
    });

    it('t3436-rebase-more-options.sh: "--ignore-whitespace works with apply backend" (a conflict skipped)', async () => {
      const dirs = twins(setup);
      expect(await rebaseTwins(dirs, ["--apply", "main", "side"])).toBe(1);
      expect(await rebaseTwins(dirs, ["--skip"])).toBe(0);
    });

    it('t3436-rebase-more-options.sh: "--ignore-whitespace works with apply backend" (-C1 and an unknown whitespace action)', async () => {
      const dirs = twins(setup);
      expect(await rebaseTwins(dirs, ["--apply", "-C1", "main", "side"])).toBe(1);
      expect(await rebaseTwins(dirs, ["--abort"])).toBe(0);
      await rebaseTwins(dirs, ["--whitespace=bogus", "main"]);
      await rebaseTwins(dirs, ["--apply", "--merge", "main"]);
    });
  });
});
