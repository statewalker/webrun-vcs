/**
 * `git reflog expire`, `delete`, `exists`, and 2.5x's `write` and `drop` against native git
 * (builtin/reflog.c, reflog.c, files_reflog_expire, reftable_be_reflog_expire).
 *
 * Each case builds one repository twice with native git under git's test_tick dates (the same
 * object ids), runs one command line through native git in one twin and through
 * `ReflogCommand` in the other, then compares stdout, stderr, the exit status, the refs and
 * the reflogs: on the files backend every file under `logs/` (and the worktrees' `logs/`)
 * byte for byte, on reftable (`GIT_DEFAULT_REF_FORMAT=reftable`, git 2.45+) every reflog's
 * entries as `git reflog list` and our reader see them.
 *
 * Under git 2.43 `write` and `drop` are no subcommands (git reads them as a revision and
 * dies); ours refuses them the same way with `setCompatibility("2.43")`. git 2.56's default
 * expiry swap (`REFLOG_EXPIRE_OPTIONS_INIT`) is evened out by `gc.reflogExpire=90.days.ago`
 * and `gc.reflogExpireUnreachable=30.days.ago` in every twin's config.
 *
 * Scenario sources: git's t/t1410-reflog.sh, t/t1418-reflog-exists.sh,
 * t/t1421-reflog-write.sh.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, type ReflogCommand, type ReflogUpdateResult } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";

type Outcome = { status: number; out: string; err: string };
type Format = "files" | "reftable";

const ZERO = "0000000000000000000000000000000000000000";

function nativeVersion(): [number, number] {
  const m = /(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "latin1" }));
  return [Number(m?.[1]), Number(m?.[2])];
}
const [MAJOR, MINOR] = nativeGitAvailable() ? nativeVersion() : [0, 0];
/** The native git's version, as ours follows it where versions differ */
const COMPATIBILITY: "2.43" | "2.56" = MAJOR === 2 && MINOR < 56 ? "2.43" : "2.56";
/** `reflog write` and `reflog drop` came with 2.5x */
const HAS_WRITE_DROP = MAJOR > 2 || MINOR >= 51;
/** reftable repositories came with 2.45 */
const HAS_REFTABLE = MAJOR > 2 || MINOR >= 45;

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

/** git's test-lib identities, the dates given (a Tick's) */
function env(format: Format, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...nativeGitEnv(home),
    GIT_AUTHOR_NAME: "A U Thor",
    GIT_AUTHOR_EMAIL: "author@example.com",
    GIT_COMMITTER_NAME: "C O Mitter",
    GIT_COMMITTER_EMAIL: "committer@example.com",
    GIT_DEFAULT_REF_FORMAT: format,
    ...extra,
  };
}

/** One twin being built: native git commands at the twin's own clock. */
class Builder {
  readonly tick = new Tick();
  /** The root of our FilesApi (default the repository; above it to reach an alternate) */
  filesRoot?: string;
  constructor(
    readonly repo: string,
    readonly format: Format,
  ) {}
  git(args: string[], cwd = this.repo, extra: Record<string, string> = {}): string {
    return execFileSync("git", args, {
      cwd,
      env: env(this.format, { ...this.tick.now(), ...extra }),
      encoding: "latin1",
    }).trim();
  }
  put(path: string, content: string): void {
    mkdirSync(join(this.repo, path, ".."), { recursive: true });
    writeFileSync(join(this.repo, path), content);
  }
  /** test_commit: `<name>.t` holding `<name>`, committed and tagged at the next tick */
  testCommit(name: string, cwd = this.repo, tag = true): void {
    writeFileSync(join(cwd, `${name}.t`), `${name}\n`);
    this.git(["add", `${name}.t`], cwd);
    this.tick.next();
    this.git(["commit", "-q", "-m", name], cwd);
    if (tag) this.git(["tag", name], cwd);
  }
  /** t1410's corrupt: the loose object moved out of the object directory */
  corrupt(id: string): void {
    const from = join(this.repo, ".git/objects", id.slice(0, 2), id.slice(2));
    renameSync(from, join(this.repo, ".git", id));
  }
}

let counter = 0;
interface Twins {
  native: Builder;
  ours: Builder;
}
/** The same repository built twice by `setup` */
function twins(format: Format, setup: (b: Builder) => void): Twins {
  const n = counter++;
  const make = (side: string) => {
    const repo = join(root, `t${n}-${side}`);
    const b = new Builder(repo, format);
    execFileSync("git", ["init", "-q", "-b", "main", repo], { env: env(format) });
    b.git(["config", "gc.reflogExpire", "90.days.ago"]);
    b.git(["config", "gc.reflogExpireUnreachable", "30.days.ago"]);
    setup(b);
    return b;
  };
  return { native: make("native"), ours: make("ours") };
}

async function open(b: Builder): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: b.filesRoot ?? b.repo });
  const gitDir = b.filesRoot ? join(relative(b.filesRoot, b.repo), ".git") : ".git";
  const environment = createNodeGitHostEnvironment({ env: env(b.format, b.tick.now()) });
  const { history } = await createGitFilesBackend({ files, gitDir, environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir, history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

function native(b: Builder, args: string[]): Outcome {
  const r = spawnSync("git", ["reflog", ...args], {
    cwd: b.repo,
    env: env(b.format, b.tick.now()),
    encoding: "latin1",
  });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/** Our outcome: the result's stdout, stderr and status, or git's death */
async function ours(
  b: Builder,
  run: (reflog: ReflogCommand) => Promise<ReflogUpdateResult | boolean>,
): Promise<Outcome> {
  const git = await open(b);
  try {
    const r = await run(git.reflog().setCompatibility(COMPATIBILITY));
    if (typeof r === "boolean") return { status: r ? 0 : 1, out: "", err: "" };
    return {
      status: r.status,
      out: r.output,
      err: r.errors.map((l) => `${l}\n`).join(""),
    };
  } catch (error) {
    const e = error as Error & { exitCode?: number };
    return { status: e.exitCode ?? 128, out: "", err: `${e.message}\n` };
  } finally {
    await git.close?.();
  }
}

/** Every file under `.git/logs` and `.git/worktrees/<id>/logs`, and the directories left */
function logFiles(repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    const at = join(repo, ".git", rel);
    if (!existsSync(at)) return;
    if (statSync(at).isDirectory()) {
      out[`${rel}/`] = "";
      for (const name of readdirSync(at).sort()) walk(`${rel}/${name}`);
    } else out[rel] = readFileSync(at, "latin1");
  };
  walk("logs");
  const wt = join(repo, ".git/worktrees");
  if (existsSync(wt)) for (const id of readdirSync(wt).sort()) walk(`worktrees/${id}/logs`);
  return out;
}

/** The refs and HEADs, as native git reads them */
function refsOf(b: Builder): string {
  const r = (args: string[]) =>
    spawnSync("git", args, { cwd: b.repo, env: env(b.format), encoding: "latin1" }).stdout;
  return [
    r(["for-each-ref", "--format=%(refname) %(objectname) %(symref)"]),
    r(["symbolic-ref", "-q", "HEAD"]),
    r(["rev-parse", "-q", "--verify", "HEAD"]),
    r(["worktree", "list", "--porcelain"]).replace(/^worktree .*$/gm, ""),
  ].join("--\n");
}

/**
 * Every reflog with its entries, as `git reflog list` (2.44+) and our reader see them. The
 * zone is left out: git 2.56.x stores a reftable log record's zone as its `hhmm` digits
 * (`-0700` as -700), git master and ours as minutes (-420), so the line `reflog write` adds
 * reads back differently in 2.56.x
 */
async function reflogsOf(b: Builder): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const names = spawnSync("git", ["reflog", "list"], {
    cwd: b.repo,
    env: env(b.format),
    encoding: "latin1",
  }).stdout;
  const git = await open(b);
  try {
    const refs = git.workingCopy.history.refs;
    for (const name of [...names.split("\n").filter(Boolean), "HEAD"]) {
      const reader = await refs.getReflog?.(name);
      const entries = reader ? await reader.getReverseEntries() : undefined;
      out[name] = entries
        ? entries
            .map(
              (e) =>
                `${e.oldId} ${e.newId} ${e.who.name} <${e.who.email}> ${e.who.timestamp}\t${e.comment}`,
            )
            .join("\n")
        : "(none)";
    }
  } finally {
    await git.close?.();
  }
  return out;
}

/** Runs `args` natively in one twin and `run` in the other; compares everything */
async function compare(
  t: Twins,
  args: string[],
  run: (reflog: ReflogCommand) => Promise<ReflogUpdateResult | boolean>,
): Promise<Outcome> {
  const expected = native(t.native, args);
  const actual = await ours(t.ours, run);
  if (COMPATIBILITY === "2.43" && args.includes("--all")) {
    // 2.43 lists reflogs in readdir order, ours (and 2.5x) sorted: compare the lines sorted
    for (const o of [expected, actual]) {
      o.out = o.out.split("\n").sort().join("\n");
      o.err = o.err.split("\n").sort().join("\n");
    }
  }
  expect(actual).toEqual(expected);
  expect(refsOf(t.ours)).toBe(refsOf(t.native));
  if (t.native.format === "files") expect(logFiles(t.ours.repo)).toEqual(logFiles(t.native.repo));
  else expect(await reflogsOf(t.ours)).toEqual(await reflogsOf(t.native));
  return expected;
}

/**
 * t1410's setup and rewind: rabbit, dragon, sheep, monkey on main, then `reset --hard HEAD~2`;
 * an annotated tag logged with `core.logAllRefUpdates=always`. Returns the blob F (sheep's).
 */
function t1410Setup(b: Builder): void {
  b.put("A/B/E", "tiger\n");
  b.put("A/D", "ox\n");
  b.put("C", "rat\n");
  b.git(["add", "."]);
  b.tick.next();
  b.git(["commit", "-q", "-m", "rabbit"]);
  b.git(["update-index", "--chmod=+x", "C"]);
  b.tick.next();
  b.git(["commit", "-q", "-m", "dragon"]);
  rmSync(join(b.repo, "C"));
  rmSync(join(b.repo, "A/B/E"));
  b.put("F", "snake\n");
  b.put("A/G", "horse\n");
  b.git(["add", "F", "A/G"]);
  b.tick.next();
  b.git(["commit", "-q", "-a", "-m", "sheep"]);
  rmSync(join(b.repo, "A/G"));
  b.tick.next();
  b.git(["commit", "-q", "-a", "-m", "monkey"]);
  b.tick.next();
  b.git(["reset", "-q", "--hard", "HEAD~2"]);
  b.git(["-c", "core.logAllRefUpdates=always", "tag", "-a", "-m", "tag name", "v0.tag", "main"]);
}

/** t1410's "delete" history: rat, ox, tiger committed on top of the setup */
function t1410Delete(b: Builder): void {
  t1410Setup(b);
  for (const [content, message] of [
    ["1", "rat"],
    ["2", "ox"],
    ["3", "tiger"],
  ] as const) {
    b.put("C", `${content}\n`);
    b.tick.next();
    b.git(["commit", "-q", "-m", message, "C"]);
  }
}

/** Two worktrees: `foo` committed in the main one, `foobar` in `link-wt` (t1410) */
function t1410Worktrees(b: Builder): void {
  b.tick.next();
  b.testCommit("foo");
  b.git(["worktree", "add", "-q", "link-wt"]);
  b.tick.next();
  b.testCommit("foobar", join(b.repo, "link-wt"));
  b.tick.next();
}

const FORMATS: Format[] = HAS_REFTABLE ? ["files", "reftable"] : ["files"];

describeGit("reflog expire, delete, exists, write and drop against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "reflog-expire-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe.each(FORMATS)("%s", (format) => {
    it('t1410-reflog.sh: "reflog expire should not barf on an annotated tag"', async () => {
      const t = twins(format, t1410Setup);
      await compare(t, ["expire", "--dry-run", "refs/tags/v0.tag"], (r) =>
        r.setDryRun(true).callExpire("refs/tags/v0.tag"),
      );
    });

    it('t1410-reflog.sh: "corrupt and check", "reflog expire --dry-run should not touch reflog"', async () => {
      const t = twins(format, (b) => {
        t1410Setup(b);
        b.corrupt(b.git(["rev-parse", "HEAD@{1}:F"]));
      });
      const at = String(t.native.tick.time - 10000);
      await compare(
        t,
        [
          "expire",
          "--dry-run",
          `--expire=${at}`,
          `--expire-unreachable=${at}`,
          "--stale-fix",
          "--all",
        ],
        (r) =>
          r
            .setDryRun(true)
            .setExpire(at)
            .setExpireUnreachable(at)
            .setStaleFix(true)
            .setAll(true)
            .callExpire(),
      );
    });

    it('t1410-reflog.sh: "reflog expire" (--verbose --stale-fix --all with a missing blob)', async () => {
      const t = twins(format, (b) => {
        t1410Setup(b);
        b.corrupt(b.git(["rev-parse", "HEAD@{1}:F"]));
      });
      const at = String(t.native.tick.time - 10000);
      const r = await compare(
        t,
        [
          "expire",
          "--verbose",
          `--expire=${at}`,
          `--expire-unreachable=${at}`,
          "--stale-fix",
          "--all",
        ],
        (r) =>
          r
            .setVerbose(true)
            .setExpire(at)
            .setExpireUnreachable(at)
            .setStaleFix(true)
            .setAll(true)
            .callExpire(),
      );
      expect(r.out).toContain("prune commit: sheep");
    });

    it('t1410-reflog.sh: "--stale-fix handles missing objects generously"', async () => {
      const t = twins(format, (b) => {
        t1410Setup(b);
        // a branch written without a reflog, its tip's parent then lost
        const tree = b.git(["write-tree"]);
        const start = b.git(["commit-tree", "-m", "start stale fix", tree]);
        const tip = b.git(["commit-tree", "-p", start, "-m", "stale fix branch tip", tree]);
        b.git(["-c", "core.logAllRefUpdates=false", "update-ref", "refs/heads/stale-fix", tip]);
        // a logged ref at the tip: the tip's history is missing, but the refs reach it
        b.git(["update-ref", "-m", "points at the tip", "refs/heads/other", tip]);
        b.corrupt(start);
      });
      await compare(t, ["expire", "--stale-fix", "--verbose", "--all"], (r) =>
        r.setStaleFix(true).setVerbose(true).setAll(true).callExpire(),
      );
    });

    it('t1410-reflog.sh: "delete" (main@{1}, HEAD@{1}, main@{<date>})', async () => {
      const t = twins(format, t1410Delete);
      await compare(t, ["delete", "main@{1}"], (r) => r.callDelete("main@{1}"));
      await compare(t, ["delete", "HEAD@{1}"], (r) => r.callDelete("HEAD@{1}"));
      const date = "main@{07.04.2005.15:15:00.-0700}";
      await compare(t, ["delete", date], (r) => r.callDelete(date));
    });

    it('t1410-reflog.sh: "delete" with --rewrite, --updateref, --dry-run and --verbose', async () => {
      const t = twins(format, t1410Delete);
      await compare(t, ["delete", "--dry-run", "--verbose", "main@{2}"], (r) =>
        r.setDryRun(true).setVerbose(true).callDelete("main@{2}"),
      );
      await compare(t, ["delete", "--rewrite", "--verbose", "main@{2}", "HEAD@{3}"], (r) =>
        r.setRewrite(true).setVerbose(true).callDelete("main@{2}", "HEAD@{3}"),
      );
      await compare(t, ["delete", "--rewrite", "--updateref", "main@{0}"], (r) =>
        r.setRewrite(true).setUpdateRef(true).callDelete("main@{0}"),
      );
      // HEAD is symbolic: --updateref leaves it alone
      await compare(t, ["delete", "--updateref", "HEAD@{0}"], (r) =>
        r.setUpdateRef(true).callDelete("HEAD@{0}"),
      );
    });

    it('t1410-reflog.sh: "delete" refusals (no reflog, not a reflog, past the end)', async () => {
      const t = twins(format, t1410Delete);
      await compare(t, ["delete", "nope@{1}", "main"], (r) => r.callDelete("nope@{1}", "main"));
      await compare(t, ["delete", "main@{99}"], (r) => r.callDelete("main@{99}"));
      await compare(t, ["delete"], (r) => r.callDelete());
    });

    it('t1410-reflog.sh: "rewind2", "--expire=never", "gc.reflogexpire=never", "gc.reflogexpire=false"', async () => {
      const t = twins(format, (b) => {
        t1410Delete(b);
        b.tick.next();
        b.git(["reset", "-q", "--hard", "HEAD~2"]);
      });
      await compare(
        t,
        ["expire", "--verbose", "--expire=never", "--expire-unreachable=never", "--all"],
        (r) =>
          r
            .setVerbose(true)
            .setExpire("never")
            .setExpireUnreachable("never")
            .setAll(true)
            .callExpire(),
      );
      for (const value of ["never", "false"]) {
        for (const b of [t.native, t.ours]) {
          b.git(["config", "gc.reflogexpire", value]);
          b.git(["config", "gc.reflogexpireunreachable", value]);
        }
        await compare(t, ["expire", "--verbose", "--all"], (r) =>
          r.setVerbose(true).setAll(true).callExpire(),
        );
      }
    });

    it('t1410-reflog.sh: "git reflog expire unknown reference"', async () => {
      const t = twins(format, t1410Setup);
      await compare(t, ["expire", "main@{123}", "does-not-exist"], (r) =>
        r.callExpire("main@{123}", "does-not-exist"),
      );
    });

    it('t1410-reflog.sh: "rewind2" then expire --expire-unreachable=now --rewrite --updateref', async () => {
      const t = twins(format, t1410Delete);
      await compare(
        t,
        [
          "expire",
          "--expire-unreachable=now",
          "--rewrite",
          "--updateref",
          "--verbose",
          "main",
          "HEAD",
        ],
        (r) =>
          r
            .setExpireUnreachable("now")
            .setRewrite(true)
            .setUpdateRef(true)
            .setVerbose(true)
            .callExpire("main", "HEAD"),
      );
    });

    it('t1410-reflog.sh: "expire with multiple worktrees"', async () => {
      const t = twins(format, t1410Worktrees);
      const at = String(t.native.tick.time);
      await compare(t, ["expire", "--verbose", "--all", `--expire=${at}`], (r) =>
        r.setVerbose(true).setAll(true).setExpire(at).callExpire(),
      );
    });

    it('t1410-reflog.sh: "expire one of multiple worktrees"', async () => {
      const t = twins(format, t1410Worktrees);
      const at = String(t.native.tick.time);
      await compare(
        t,
        ["expire", "--verbose", "--all", `--expire=${at}`, "--single-worktree"],
        (r) => r.setVerbose(true).setAll(true).setExpire(at).setSingleWorktree(true).callExpire(),
      );
    });

    it('t1410-reflog.sh: "empty reflog"', async () => {
      const t = twins(format, (b) => {
        b.testCommit("A");
        b.git(["update-ref", "--create-reflog", "refs/heads/foo", "HEAD"]);
        // test-tool's create-reflog: an empty reflog
        b.git(["reflog", "delete", "refs/heads/foo@{0}"]);
      });
      await compare(t, ["expire", "--all"], (r) => r.setAll(true).callExpire());
    });

    it('t1410-reflog.sh: "expire with pattern config"', async () => {
      const t = twins(format, (b) => {
        b.testCommit("A");
        for (const branch of ["root1/branch1", "root1/branch2", "root2/branch1", "root2/branch2"]) {
          b.git(["branch", branch]);
        }
        b.git(["config", "gc.reflogexpire", "never"]);
        b.git(["config", "gc.refs/heads/root2/*.reflogExpire", "now"]);
      });
      const refs = ["root1/branch1", "root1/branch2", "root2/branch1", "root2/branch2"];
      await compare(t, ["expire", ...refs], (r) => r.callExpire(...refs));
    });

    it('t1418-reflog-exists.sh: "reflog exists works", invalid ref formats', async () => {
      const t = twins(format, (b) => b.testCommit("A"));
      for (const ref of ["refs/heads/main", "refs/heads/nonexistent", "HEAD", "refs/heads/a b"]) {
        await compare(t, ["exists", ref], (r) => r.setRef(ref).callExists());
      }
    });

    it('t1421-reflog-write.sh: "simple writes", "reflog message gets normalized", "can write to root ref"', async () => {
      const t = twins(format, (b) => b.testCommit("initial"));
      const id = t.native.git(["rev-parse", "HEAD"]);
      await compare(t, ["write", "refs/heads/something", ZERO, id, "first"], (r) =>
        r.callWrite("refs/heads/something", ZERO, id, "first"),
      );
      await compare(t, ["write", "refs/heads/something", id, id, "second"], (r) =>
        r.callWrite("refs/heads/something", id, id, "second"),
      );
      const message = "message\nwith\nnewlines";
      await compare(t, ["write", "HEAD", id, id, message], (r) =>
        r.callWrite("HEAD", id, id, message),
      );
      await compare(t, ["write", "ROOT_REF_HEAD", ZERO, id, "first"], (r) =>
        r.callWrite("ROOT_REF_HEAD", ZERO, id, "first"),
      );
    });

    it('t1421-reflog-write.sh: "invalid refname", "unqualified refname is rejected", "nonexistent object IDs", "abbreviated object IDs"', async () => {
      const t = twins(format, (b) => b.testCommit("initial"));
      const id = t.native.git(["rev-parse", "HEAD"]);
      const missing = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
      const cases: [string, string, string][] = [
        ["refs/heads/ invalid", ZERO, ZERO],
        ["unqualified", ZERO, ZERO],
        ["refs/heads/something", missing, ZERO],
        ["refs/heads/something", ZERO, missing],
        ["refs/heads/something", id.slice(0, 8), ZERO],
        ["refs/heads/something", ZERO, id.slice(0, 8)],
      ];
      for (const [ref, oldId, newId] of cases) {
        await compare(t, ["write", ref, oldId, newId, "first"], (r) =>
          r.callWrite(ref, oldId, newId, "first"),
        );
      }
    });

    it('t1410-reflog.sh: "reflog drop non-existent ref", "reflog drop", "reflog drop multiple references some non-existent"', async () => {
      const t = twins(format, (b) => {
        b.testCommit("A");
        b.git(["branch", "branch"]);
        b.git(["branch", "other"]);
      });
      await compare(t, ["drop", "refs/heads/non-existent"], (r) =>
        r.callDrop("refs/heads/non-existent"),
      );
      await compare(t, ["drop", "refs/heads/main"], (r) => r.callDrop("refs/heads/main"));
      await compare(t, ["drop", "branch", "refs/heads/non-existent", "refs/heads/other"], (r) =>
        r.callDrop("branch", "refs/heads/non-existent", "refs/heads/other"),
      );
    });

    it('t1410-reflog.sh: "reflog drop --all", "reflog drop --all with reference"', async () => {
      const t = twins(format, (b) => {
        b.testCommit("A");
        b.git(["branch", "branch"]);
      });
      await compare(t, ["drop", "--all", "refs/heads/main"], (r) =>
        r.setAll(true).callDrop("refs/heads/main"),
      );
      await compare(t, ["drop", "--all"], (r) => r.setAll(true).callDrop());
    });

    it('t1410-reflog.sh: "reflog drop --all multiple worktrees", "reflog drop --all --single-worktree"', async () => {
      for (const single of [false, true]) {
        const t = twins(format, t1410Worktrees);
        await compare(t, ["drop", "--all", ...(single ? ["--single-worktree"] : [])], (r) =>
          r.setAll(true).setSingleWorktree(single).callDrop(),
        );
      }
    });
  });

  it.skipIf(HAS_WRITE_DROP)("git 2.43: write and drop are revisions to `git reflog`", async () => {
    const t = twins("files", (b) => b.testCommit("A"));
    await compare(t, ["drop", "--all"], (r) => r.setAll(true).callDrop());
    await compare(t, ["write", "refs/heads/x", ZERO, ZERO, "m"], (r) =>
      r.callWrite("refs/heads/x", ZERO, ZERO, "m"),
    );
  });
  describe.each(FORMATS)("%s: selectors as strtoul reads them", (format) => {
    it('t1410-reflog.sh: "delete" with main@{-1}, main@{ 1}, main@{+1} and --updateref', async () => {
      const t = twins(format, t1410Delete);
      for (const selector of ["main@{-1}", "main@{ 1}", "main@{+1}", "main@{}"]) {
        await compare(t, ["delete", "--updateref", "--rewrite", selector], (r) =>
          r.setUpdateRef(true).setRewrite(true).callDelete(selector),
        );
      }
    });
  });

  describe("alternates and partial clones", () => {
    /** Twins cloned with `--shared` from one source (the same clone messages in both) */
    function sharedTwins(): Twins {
      const n = counter++;
      const src = new Builder(join(root, `t${n}-src`), "files");
      execFileSync("git", ["init", "-q", "-b", "main", src.repo], { env: env("files") });
      t1410Setup(src);
      const make = (side: string) => {
        const b = new Builder(join(root, `t${n}-${side}`, "repo"), "files");
        b.tick.time = src.tick.time;
        execFileSync("git", ["clone", "-q", "--shared", src.repo, b.repo], {
          env: env("files", b.tick.now()),
        });
        b.git(["config", "gc.reflogExpire", "90.days.ago"]);
        b.git(["config", "gc.reflogExpireUnreachable", "30.days.ago"]);
        b.tick.next();
        b.git(["reset", "-q", "--hard", "HEAD~1"]);
        b.git(["branch", "side", "origin/main"]);
        b.tick.next();
        b.git(["branch", "-f", "side", "HEAD"]);
        return b;
      };
      return { native: make("native"), ours: make("ours") };
    }

    it('t1410-reflog.sh: "reflog expire" (--stale-fix --all) refuses an alternate it cannot read', async () => {
      const t = sharedTwins();
      const before = logFiles(t.ours.repo);
      const git = await open(t.ours);
      try {
        await expect(
          git.reflog().setStaleFix(true).setAll(true).setExpire("never").callExpire(),
        ).rejects.toThrow(/cannot expire reflogs: an alternate object directory/);
        await expect(
          (await open(t.ours)).reflog().setRewrite(true).callDelete("main@{1}"),
        ).rejects.toThrow(/cannot expire reflogs/);
      } finally {
        await git.close?.();
      }
      expect(logFiles(t.ours.repo)).toEqual(before);
    });

    it('t1410-reflog.sh: "reflog expire" (--stale-fix --all) through a readable alternate', async () => {
      const t = sharedTwins();
      t.ours.filesRoot = root;
      await compare(
        t,
        [
          "expire",
          "--verbose",
          "--stale-fix",
          "--all",
          "--expire=never",
          "--expire-unreachable=now",
        ],
        (r) =>
          r
            .setVerbose(true)
            .setStaleFix(true)
            .setAll(true)
            .setExpire("never")
            .setExpireUnreachable("now")
            .callExpire(),
      );
    });

    it('t1410-reflog.sh: "--stale-fix handles missing objects generously" in a blob:none partial clone', async () => {
      const n = counter++;
      const srv = new Builder(join(root, `t${n}-srv`), "files");
      execFileSync("git", ["init", "-q", "-b", "main", srv.repo], { env: env("files") });
      srv.testCommit("A");
      srv.git(["checkout", "-q", "-b", "side"]);
      srv.testCommit("B", srv.repo, false);
      srv.testCommit("C", srv.repo, false);
      srv.git(["checkout", "-q", "main"]);
      srv.git(["config", "uploadpack.allowFilter", "true"]);
      srv.git(["config", "uploadpack.allowAnySHA1InWant", "true"]);
      const make = (side: string) => {
        const b = new Builder(join(root, `t${n}-${side}`, "repo"), "files");
        b.tick.time = srv.tick.time;
        execFileSync(
          "git",
          ["clone", "-q", "--no-local", "--filter=blob:none", `file://${srv.repo}`, b.repo],
          { env: env("files", b.tick.now()) },
        );
        b.git(["config", "gc.reflogExpire", "never"]);
        b.git(["config", "gc.reflogExpireUnreachable", "never"]);
        b.git(["branch", "foo"]);
        // foo at a commit whose blobs were never fetched, then back
        b.git(["update-ref", "-m", "to side", "refs/heads/foo", "origin/side"]);
        b.git(["update-ref", "-m", "back", "refs/heads/foo", "main"]);
        b.git(["update-ref", "-d", "refs/remotes/origin/side"]);
        return b;
      };
      const t = { native: make("native"), ours: make("ours") };
      // our FilesApi reaches the promisor remote (file://) too
      t.ours.filesRoot = root;
      const missing = (b: Builder) =>
        b.git(["rev-list", "--objects", "--missing=print", "refs/heads/foo@{1}"]);
      expect(missing(t.native)).toMatch(/^\?/m);
      const r = await compare(t, ["expire", "--verbose", "--stale-fix", "--all"], (r) =>
        r.setVerbose(true).setStaleFix(true).setAll(true).callExpire(),
      );
      expect(r.out).toContain("keep to side");
    });
    it.each(FORMATS)(
      '%s: t1410-reflog.sh: "--stale-fix handles missing objects generously" when the promisor remote is gone',
      async (format) => {
        const n = counter++;
        const srv = new Builder(join(root, `t${n}-srv`), format);
        execFileSync("git", ["init", "-q", "-b", "main", srv.repo], { env: env(format) });
        srv.testCommit("A");
        srv.git(["checkout", "-q", "-b", "side"]);
        srv.testCommit("B", srv.repo, false);
        srv.git(["checkout", "-q", "main"]);
        srv.git(["config", "uploadpack.allowFilter", "true"]);
        const make = (side: string) => {
          const b = new Builder(join(root, `t${n}-${side}`, "repo"), format);
          b.tick.time = srv.tick.time;
          execFileSync(
            "git",
            ["clone", "-q", "--no-local", "--filter=blob:none", `file://${srv.repo}`, b.repo],
            { env: env(format, b.tick.now()) },
          );
          b.git(["config", "gc.reflogExpire", "never"]);
          b.git(["config", "gc.reflogExpireUnreachable", "never"]);
          b.git(["branch", "foo"]);
          b.git(["update-ref", "-m", "to side", "refs/heads/foo", "origin/side"]);
          b.git(["update-ref", "-m", "back", "refs/heads/foo", "main"]);
          b.git(["update-ref", "-d", "refs/remotes/origin/side"]);
          return b;
        };
        const t = { native: make("native"), ours: make("ours") };
        t.ours.filesRoot = root;
        // the promisor remote is gone: the lazy fetch fails and git dies, writing nothing
        rmSync(srv.repo, { recursive: true, force: true });
        const before = format === "files" ? logFiles(t.ours.repo) : await reflogsOf(t.ours);
        // no --verbose: what 2.43 prints before dying follows its readdir order
        const r = await compare(t, ["expire", "--stale-fix", "--all"], (r) =>
          r.setStaleFix(true).setAll(true).callExpire(),
        );
        expect(r.status).toBe(128);
        expect(format === "files" ? logFiles(t.ours.repo) : await reflogsOf(t.ours)).toEqual(
          before,
        );
      },
    );
  });
});
