/**
 * The identities of the commits and tags our commands make, against native git's: each
 * repository is built twice by native git (same ids), one twin changed by native git, the
 * other by our commands, both with the same `GIT_AUTHOR_*` / `GIT_COMMITTER_*` (ours through
 * `createNodeGitHostEnvironment`), then the objects made compared by id and `cat-file -p`.
 *
 * The author and the committer differ in name and date, so a command that takes one for the
 * other shows. Our commands are given no identity: they resolve it as git does.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  findIdent,
  Git,
  IdentityUnknownError,
  InvalidIdentError,
  MergeStatus,
  parseGitDate,
  RebaseOperation,
  RebaseStatus,
  resolveAuthorIdent,
  resolveCommitterIdent,
} from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

type Env = Record<string, string | undefined>;

let root = "";
let home = "";
let counter = 0;

/** The identities of the commands run (the base repository is built with nativeGitEnv's). */
const OP: Env = {
  GIT_AUTHOR_NAME: "Ann Author",
  GIT_AUTHOR_EMAIL: "ann@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0200",
  GIT_COMMITTER_NAME: "Cid Committer",
  GIT_COMMITTER_EMAIL: "cid@example.com",
  GIT_COMMITTER_DATE: "1700000500 -0700",
};

/** nativeGitEnv with `over` on top (an undefined value removes the variable). */
function envOf(over: Env = {}): Record<string, string> {
  const env: Env = { ...nativeGitEnv(home), ...OP, ...over };
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

const git = (cwd: string, env: Env, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: env as Record<string, string>,
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });
/** Native git building the base repositories: nativeGitEnv's identity. */
const build = (cwd: string, ...args: string[]) => git(cwd, nativeGitEnv(home), ...args);
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/**
 * The repository both twins start from: main (c1, c2), `feat` (c1, f1), `x` (c1, x1, x2),
 * `conf` (c1, a change of a.txt that conflicts with c2's).
 */
function base(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const repo = join(dir, "repo");
  build(dir, "init", "-q", "-b", "main", "repo");
  put(repo, "a.txt", "a\n");
  build(repo, "add", ".");
  build(repo, "commit", "-qm", "c1");
  for (const b of ["feat", "x", "conf"]) build(repo, "branch", b);
  put(repo, "a.txt", "a\nmore\n");
  build(repo, "commit", "-qam", "c2");
  build(repo, "checkout", "-q", "feat");
  put(repo, "f.txt", "f\n");
  build(repo, "add", ".");
  build(repo, "commit", "-qm", "f1");
  build(repo, "checkout", "-q", "x");
  put(repo, "x.txt", "x1\n");
  build(repo, "add", ".");
  build(repo, "commit", "-qm", "x1");
  put(repo, "x.txt", "x1\nx2\n");
  build(repo, "commit", "-qam", "x2");
  build(repo, "checkout", "-q", "conf");
  put(repo, "a.txt", "a\nother\n");
  build(repo, "commit", "-qam", "conflicting");
  build(repo, "checkout", "-q", "main");
  return repo;
}

/** The base repository twice: `native` and `ours` (the repositories themselves). */
function twins(): { native: string; ours: string } {
  const n = counter++;
  return { native: base(join(root, `t${n}-native`)), ours: base(join(root, `t${n}-ours`)) };
}

/** Our Git on `repo`, with git's variables of `env` as a Node host reads them. */
async function open(repo: string, env: Env): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** `rev` in both twins: the same id, the same `cat-file -p`. */
function expectSame(t: { native: string; ours: string }, ...revs: string[]): void {
  for (const rev of revs) {
    const show = (repo: string) => {
      const id = build(repo, "rev-parse", rev).trim();
      return { rev, id, object: build(repo, "cat-file", "-p", id) };
    };
    expect(show(t.ours)).toEqual(show(t.native));
  }
}

describeGit("commit identities, native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ident-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("commit: the author and the committer from the variables; amend keeps the author", async () => {
    const t = twins();
    const env = envOf();
    put(t.native, "n.txt", "n\n");
    git(t.native, env, "add", "n.txt");
    git(t.native, env, "commit", "-qm", "new");
    const ours = await open(t.ours, env);
    put(t.ours, "n.txt", "n\n");
    await ours.add().addFilepattern("n.txt").call();
    await ours.commit().setMessage("new\n").call();
    expectSame(t, "HEAD");

    // the amend runs later: a new committer date, the author's kept
    const later = envOf({
      GIT_AUTHOR_DATE: "1700009999 +0000",
      GIT_COMMITTER_DATE: "1700001000 +0100",
    });
    git(t.native, later, "commit", "-q", "--amend", "-m", "amended");
    await (await open(t.ours, later)).commit().setAmend(true).setMessage("amended\n").call();
    expectSame(t, "HEAD");

    // --reset-author: the author resolved again (GIT_AUTHOR_DATE)
    git(t.native, later, "commit", "-q", "--amend", "--reset-author", "-m", "reset");
    await (await open(t.ours, later))
      .commit()
      .setAmend(true)
      .setResetAuthor(true)
      .setMessage("reset\n")
      .call();
    expectSame(t, "HEAD");

    // --author: the name and email given, GIT_AUTHOR_DATE's date
    git(
      t.native,
      later,
      "commit",
      "-q",
      "--allow-empty",
      "--author=Other <o@example.com>",
      "-m",
      "o",
    );
    await (await open(t.ours, later))
      .commit()
      .setAllowEmpty(true)
      .setAuthor("Other", "o@example.com")
      .setMessage("o\n")
      .call();
    expectSame(t, "HEAD");
  });

  it("merge: a merge commit's author and committer from the variables", async () => {
    const t = twins();
    const env = envOf();
    git(t.native, env, "merge", "-q", "--no-edit", "feat");
    const ours = await open(t.ours, env);
    expect((await ours.merge().include("feat").call()).status).toBe(MergeStatus.MERGED);
    expectSame(t, "HEAD");
  });

  it("cherry-pick keeps the picked commit's author; revert is authored now", async () => {
    const t = twins();
    const env = envOf();
    git(t.native, env, "cherry-pick", "feat");
    git(t.native, env, "revert", "--no-edit", "HEAD");
    const ours = await open(t.ours, env);
    await ours.cherryPick().include("feat").call();
    await ours.revert().include("HEAD").call();
    expectSame(t, "HEAD~1", "HEAD");
  });

  it("rebase over local commits: the picks keep their authors, committed now", async () => {
    const t = twins();
    const env = envOf();
    git(t.native, env, "checkout", "-q", "x");
    git(t.native, env, "rebase", "-q", "main");
    const ours = await open(t.ours, env);
    await ours.checkout().setName("x").call();
    const rebase = await ours.rebase().setUpstreamBranch("main");
    expect((await rebase.call()).status).toBe(RebaseStatus.OK);
    expectSame(t, "x~1", "x");
  });

  it("rebase --committer-date-is-author-date; a conflict concluded by --continue", async () => {
    const t = twins();
    const env = envOf();
    git(t.native, env, "checkout", "-q", "x");
    git(t.native, env, "rebase", "-q", "--committer-date-is-author-date", "main");
    const ours = await open(t.ours, env);
    await ours.checkout().setName("x").call();
    const rebase = await ours.rebase().setCommitterDateIsAuthorDate(true).setUpstreamBranch("main");
    expect((await rebase.call()).status).toBe(RebaseStatus.OK);
    expectSame(t, "x~1", "x");

    // the option kept in rebase-merge/ across a stop
    git(t.native, env, "checkout", "-q", "conf");
    const stopped = spawnSync("git", ["rebase", "-q", "--committer-date-is-author-date", "main"], {
      cwd: t.native,
      env: env as Record<string, string>,
    });
    expect(stopped.status).not.toBe(0);
    put(t.native, "a.txt", "resolved\n");
    git(t.native, env, "add", "a.txt");
    git(t.native, envOf({ GIT_EDITOR: "true" }), "rebase", "--continue");
    await ours.checkout().setName("conf").call();
    const conflicting = await ours
      .rebase()
      .setCommitterDateIsAuthorDate(true)
      .setUpstreamBranch("main");
    expect((await conflicting.call()).status).toBe(RebaseStatus.STOPPED);
    put(t.ours, "a.txt", "resolved\n");
    await ours.add().addFilepattern("a.txt").call();
    await ours.rebase().setOperation(RebaseOperation.CONTINUE).call();
    expectSame(t, "conf");
  });

  it("rebase --ignore-date: the authors dated now, not GIT_AUTHOR_DATE", async () => {
    const t = twins();
    const ours = await open(t.ours, envOf());
    await ours.checkout().setName("x").call();
    const before = Math.floor(Date.now() / 1000);
    const rebase = await ours.rebase().setIgnoreDate(true).setUpstreamBranch("main");
    expect((await rebase.call()).status).toBe(RebaseStatus.OK);
    const author = build(t.ours, "cat-file", "-p", "x")
      .split("\n")
      .find((l) => l.startsWith("author "));
    const seconds = Number(/> (\d+) [+-]\d{4}$/.exec(author ?? "")?.[1]);
    // the pick keeps its author (the base build's), dated now
    expect(author).toMatch(/^author Interop Tester <interop@example\.com> /);
    expect(seconds).toBeGreaterThanOrEqual(before);
    expect(build(t.ours, "cat-file", "-p", "x")).toMatch(
      /\ncommitter Cid Committer <cid@example\.com> 1700000500 -0700\n/,
    );
  });

  it("stash: the author and the committer of each stash commit", async () => {
    const t = twins();
    const env = envOf();
    put(t.native, "a.txt", "changed\n");
    put(t.native, "u.txt", "untracked\n");
    git(t.native, env, "stash", "-q", "-u");
    const ours = await open(t.ours, env);
    put(t.ours, "a.txt", "changed\n");
    put(t.ours, "u.txt", "untracked\n");
    await ours.stashCreate().setIncludeUntracked(true).call();
    expectSame(t, "stash^1", "stash^2", "stash^3", "stash");
  });

  it("tag -a: the tagger from the committer variables", async () => {
    const t = twins();
    const env = envOf();
    git(t.native, env, "tag", "-a", "-m", "release", "v1");
    // (git tag -m ends the message with a newline)
    await (await open(t.ours, env)).tag().setName("v1").setMessage("release\n").call();
    expectSame(t, "refs/tags/v1");
  });

  it("author.* and committer.* take precedence over user.*; crud trimmed", async () => {
    const t = twins();
    // no names in the environment: the configuration's
    const env = envOf({
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
    });
    for (const repo of [t.native, t.ours]) {
      build(repo, "config", "user.name", "User Name");
      build(repo, "config", "user.email", "user@example.com");
      build(repo, "config", "author.name", ' "Dr. Au, Jr.". ');
    }
    git(t.native, env, "commit", "-q", "--allow-empty", "-m", "one");
    await (await open(t.ours, env)).commit().setAllowEmpty(true).setMessage("one\n").call();
    expectSame(t, "HEAD");

    for (const repo of [t.native, t.ours]) {
      build(repo, "config", "committer.email", "<committer@example.com>");
    }
    git(t.native, env, "commit", "-q", "--allow-empty", "-m", "two");
    git(t.native, env, "tag", "-a", "-m", "tagged", "t2");
    const ours = await open(t.ours, env);
    await ours.commit().setAllowEmpty(true).setMessage("two\n").call();
    await ours.tag().setName("t2").setMessage("tagged\n").call();
    expectSame(t, "HEAD", "refs/tags/t2");
  });

  it("user.useConfigOnly: refused, with git's message, when the configuration names nobody", async () => {
    const t = twins();
    const env = envOf({
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
    });
    const refusal = (repo: string, ...args: string[]) =>
      spawnSync("git", args, {
        cwd: repo,
        env: env as Record<string, string>,
        encoding: "latin1",
      }).stderr.trimEnd();
    for (const repo of [t.native, t.ours]) build(repo, "config", "user.useConfigOnly", "true");

    const noEmail = refusal(t.native, "commit", "-q", "--allow-empty", "-m", "x");
    expect(noEmail).toMatch(/no email was given/);
    const ours = await open(t.ours, env);
    await expect(ours.commit().setAllowEmpty(true).setMessage("x\n").call()).rejects.toThrow(
      IdentityUnknownError,
    );
    try {
      await (await open(t.ours, env)).commit().setAllowEmpty(true).setMessage("x\n").call();
    } catch (error) {
      expect((error as Error).message).toBe(noEmail);
    }

    for (const repo of [t.native, t.ours]) build(repo, "config", "user.email", "u@example.com");
    const noName = refusal(t.native, "commit", "-q", "--allow-empty", "-m", "x");
    expect(noName).toMatch(/no name was given/);
    const err = await (await open(t.ours, env))
      .commit()
      .setAllowEmpty(true)
      .setMessage("x\n")
      .call()
      .catch((e: Error) => e);
    expect((err as Error).message).toBe(noName);

    // an author given (--author): the committer refused
    const committerRefusal = refusal(
      t.native,
      "commit",
      "-q",
      "--allow-empty",
      "--author=A <a@example.com>",
      "-m",
      "x",
    );
    const withAuthor = { ...env, GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.com" };
    const err2 = await (await open(t.ours, withAuthor))
      .commit()
      .setAllowEmpty(true)
      .setMessage("x\n")
      .call()
      .catch((e: Error) => e);
    expect(committerRefusal).toMatch(/^Committer identity unknown/);
    expect((err2 as Error).message).toBe(committerRefusal);

    // the annotated tag's tagger: the committer's refusal
    for (const repo of [t.native, t.ours]) build(repo, "config", "user.name", "U");
    for (const repo of [t.native, t.ours]) build(repo, "config", "--unset", "user.email");
    const tagRefusal = refusal(t.native, "tag", "-a", "-m", "m", "v1");
    const err3 = await (await open(t.ours, env))
      .tag()
      .setName("v1")
      .setMessage("m")
      .call()
      .catch((e: Error) => e);
    expect((err3 as Error).message).toBe(tagRefusal);
  });

  describe("dates: GIT_AUTHOR_DATE / GIT_COMMITTER_DATE as git reads them", () => {
    const savedTz = process.env.TZ;
    afterEach(() => {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    });

    const formats = [
      "1700000000 -0530",
      "@1700000000 +0100",
      "@1700000000",
      "1700000000",
      "Tue, 14 Nov 2023 23:13:20 +0100",
      "Tue Nov 14 23:13:20 2023 +0100",
      "14 Nov 2023 23:13 -0800",
      "2023-11-14 23:13:20 +0100",
      "2023-11-14T23:13:20+01:00",
      "2023-11-14T23:13:20.123+0530",
      "2023-11-14T23:13:20 +05:30",
      "2023-11-14T23:13:20Z",
      "2023-11-14T23:13:20 UTC",
      "2023-11-14T23:13:20 CET",
      "2023-11-14T23:13:20",
      "2023-07-01 10:00:00",
      "2023.11.14 23:13:20",
      "11/14/2023 23:13:20",
    ];

    it.each(["Europe/Berlin", "America/New_York"])("in the local timezone %s", async (tz) => {
      process.env.TZ = tz;
      const t = twins();
      for (const [i, date] of formats.entries()) {
        const env = envOf({
          TZ: tz,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: formats[formats.length - 1 - i],
        });
        git(t.native, env, "commit", "-q", "--allow-empty", "-m", `d${i}`);
        await (await open(t.ours, env)).commit().setAllowEmpty(true).setMessage(`d${i}\n`).call();
        expect([date, build(t.ours, "cat-file", "-p", "HEAD")]).toEqual([
          date,
          build(t.native, "cat-file", "-p", "HEAD"),
        ]);
      }
      expectSame(t, "HEAD");
    });

    it("an unreadable date is refused, as git refuses it", async () => {
      const t = twins();
      const env = envOf({ GIT_AUTHOR_DATE: "99999999" });
      const native = spawnSync("git", ["commit", "-q", "--allow-empty", "-m", "x"], {
        cwd: t.native,
        env: env as Record<string, string>,
        encoding: "latin1",
      });
      expect(native.stderr.trim()).toBe("fatal: invalid date format: 99999999");
      const err = await (await open(t.ours, env))
        .commit()
        .setAllowEmpty(true)
        .setMessage("x\n")
        .call()
        .catch((e: Error) => e);
      expect((err as Error).message).toBe("fatal: invalid date format: 99999999");
    });
  });
});

describe("resolveAuthorIdent / resolveCommitterIdent", () => {
  const config = (values: Record<string, string>) => ({ value: (key: string) => values[key] });
  const env = (over: object = {}) => ({ readFile: async () => undefined, ...over });

  it("the variables, then author.* / committer.*, then user.*, then $EMAIL", () => {
    const c = config({
      "user.name": "U",
      "user.email": "u@x",
      "author.name": "A",
      "committer.email": "c@x",
    });
    expect(resolveAuthorIdent(env(), c, { now: 1 })).toMatchObject({ name: "A", email: "u@x" });
    expect(resolveCommitterIdent(env(), c, { now: 1 })).toMatchObject({ name: "U", email: "c@x" });
    const vars = env({ author: { name: "V", date: "1700000000 +0300" } });
    expect(resolveAuthorIdent(vars, c)).toEqual({
      name: "V",
      email: "u@x",
      timestamp: 1700000000,
      tzOffset: "+0300",
    });
    expect(
      resolveCommitterIdent(env({ defaultEmail: "e@x" }), config({}), { now: 1 }),
    ).toMatchObject({ name: "webrun-vcs", email: "e@x" });
  });

  it("nobody named: the fallback, else webrun-vcs now, never Unknown", () => {
    const none = resolveCommitterIdent(env(), config({}), { now: 5 });
    expect(none).toMatchObject({ name: "webrun-vcs", email: "vcs@localhost", timestamp: 5 });
    const fallback = { name: "F", email: "f@x", timestamp: 0, tzOffset: "+0000" };
    // the fallback's name and email, never its date: dated now
    expect(resolveCommitterIdent(env(), config({}), { now: 5, fallback })).toMatchObject({
      name: "F",
      email: "f@x",
      timestamp: 5,
    });
    // a date in the variables, nobody named: the fallback's name, the variable's date
    const dated = env({ committer: { date: "1700000000 +0100" } });
    expect(resolveCommitterIdent(dated, config({}), { fallback })).toEqual({
      name: "F",
      email: "f@x",
      timestamp: 1700000000,
      tzOffset: "+0100",
    });
  });

  it("user.useConfigOnly refuses what the configuration does not give", () => {
    const strict = config({ "user.useConfigOnly": "true" });
    expect(() => resolveAuthorIdent(env(), strict)).toThrow(/no email was given/);
    expect(() =>
      resolveAuthorIdent(env(), config({ "user.useConfigOnly": "true", "user.email": "e@x" })),
    ).toThrow(/no name was given/);
    expect(() =>
      resolveAuthorIdent(env({ author: { name: "a", email: "b" } }), strict),
    ).not.toThrow();
  });

  it("parseGitDate: offsets kept, local ones for dates without", () => {
    expect(parseGitDate("1700000000 -0530")).toEqual({ timestamp: 1700000000, tzOffset: "-0530" });
    expect(parseGitDate("2023-11-14T23:13:20+01:00")).toEqual({
      timestamp: 1700000000,
      tzOffset: "+0100",
    });
    expect(parseGitDate("Tue, 14 Nov 2023 23:13:20 +0100")).toEqual({
      timestamp: 1700000000,
      tzOffset: "+0100",
    });
    expect(parseGitDate("2023-11-14T22:13:20Z")).toEqual({
      timestamp: 1700000000,
      tzOffset: "+0000",
    });
    expect(parseGitDate("99999999")).toBeUndefined();
    expect(parseGitDate("2023-11-14")).toBeUndefined();
    expect(parseGitDate("not a date")).toBeUndefined();
  });
});

/** The commit (or tag) object `rev` of `repo` as `cat-file -p` shows it. */
const catFile = (repo: string, rev: string) => build(repo, "cat-file", "-p", rev);
/** The seconds of the `role` line of a commit as `cat-file -p` shows it. */
const secondsOf = (object: string, role: string) =>
  Number(new RegExp(`^${role} .*> (\\d+) [+-]\\d{4}$`, "m").exec(object)?.[1]);

describeGit("identities as git resolves them: guesses, empty values, refusals", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ident-native-2-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** No identity in the environment, no dates: what the configuration gives. */
  const NONE: Env = {
    GIT_AUTHOR_NAME: undefined,
    GIT_AUTHOR_EMAIL: undefined,
    GIT_AUTHOR_DATE: undefined,
    GIT_COMMITTER_NAME: undefined,
    GIT_COMMITTER_EMAIL: undefined,
    GIT_COMMITTER_DATE: undefined,
  };

  it("`git var`'s identities, wherever git guesses nothing", () => {
    const dates = { GIT_AUTHOR_DATE: "1700000000 +0000", GIT_COMMITTER_DATE: "1700000500 +0100" };
    const envs: Env[] = [
      {},
      { GIT_AUTHOR_NAME: "EnvA" },
      { GIT_AUTHOR_EMAIL: "enva@x" },
      { GIT_AUTHOR_NAME: "EnvA", GIT_AUTHOR_EMAIL: "enva@x" },
      { GIT_COMMITTER_NAME: "EnvC", GIT_COMMITTER_EMAIL: "envc@x" },
      { GIT_AUTHOR_NAME: "", GIT_COMMITTER_NAME: "" },
      { GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_EMAIL: "" },
      { GIT_AUTHOR_NAME: ' ;<Odd>, "Name" ;', GIT_AUTHOR_EMAIL: "<a@b>" },
      { GIT_AUTHOR_NAME: ";;;", GIT_COMMITTER_NAME: " \t'x'\t" },
      { EMAIL: "em@x" },
      { EMAIL: "  sp@x  " },
    ];
    const configs: Record<string, string>[] = [
      {},
      { "user.name": "UN", "user.email": "ue@x" },
      { "user.name": "UN" },
      { "user.email": "ue@x" },
      { "author.name": "AN", "author.email": "ae@x" },
      { "committer.email": "ce@x", "user.name": "UN" },
      { "author.name": "", "author.email": "", "user.name": "UN" },
      { "user.name": "", "user.email": "ue@x" },
      { "user.email": "", "user.name": "UN" },
      { "committer.name": "CN", "committer.email": "ce@x" },
      { "user.useConfigOnly": "true" },
      { "user.useConfigOnly": "true", "user.email": "ue@x" },
      { "user.useConfigOnly": "true", "committer.email": "ce@x", "committer.name": "CN" },
      { "user.useConfigOnly": "true", "user.name": "", "user.email": "ue@x" },
      { "user.useConfigOnly": "true", "user.name": "UN", "user.email": "" },
    ];
    const native = (role: string, env: Env, config: Record<string, string>) => {
      const args = Object.entries(config).flatMap(([k, v]) => ["-c", `${k}=${v}`]);
      const r = spawnSync("git", [...args, "var", `GIT_${role.toUpperCase()}_IDENT`], {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", TZ: "UTC", ...env },
        encoding: "latin1",
      });
      return r.status === 0 ? r.stdout.trimEnd() : r.stderr.trimEnd();
    };
    const ours = (role: string, env: Env, config: Record<string, string>) => {
      const environment = createNodeGitHostEnvironment({ env });
      const lookup = { value: (key: string) => config[key] };
      try {
        const p = (role === "author" ? resolveAuthorIdent : resolveCommitterIdent)(
          environment,
          lookup,
        );
        return `${p.name} <${p.email}> ${p.timestamp} ${p.tzOffset}`;
      } catch (error) {
        return (error as Error).message;
      }
    };
    let compared = 0;
    const mismatches: string[] = [];
    for (const role of ["author", "committer"]) {
      for (const e of envs) {
        for (const config of configs) {
          const env: Env = { ...dates, ...e };
          const up = role.toUpperCase();
          const keys = (field: string) =>
            ["user", "author", "committer"].some((s) => config[`${s}.${field}`] !== undefined);
          // where git would guess (the passwd name, user@host), a portable host cannot: skipped
          const nameGiven = env[`GIT_${up}_NAME`] !== undefined || keys("name");
          const mailGiven = env[`GIT_${up}_EMAIL`] !== undefined || keys("email") || !!env.EMAIL;
          const strictRefusal = config["user.useConfigOnly"] === "true";
          if (!(nameGiven && mailGiven) && !strictRefusal) continue;
          const n = native(role, env, config);
          if (/auto-detect|unable to/.test(n)) continue;
          compared++;
          const o = ours(role, env, config);
          if (o !== n) mismatches.push(`${role} ${JSON.stringify(e)} ${JSON.stringify(config)}`);
          expect([role, e, config, o]).toEqual([role, e, config, n]);
        }
      }
    }
    expect(mismatches).toEqual([]);
    expect(compared).toBeGreaterThan(150);
  });

  /** Native git's stderr of `args` in `repo` with `env`, trimmed (the command must fail). */
  const refusal = (repo: string, env: Env, ...args: string[]) => {
    const r = spawnSync("git", args, {
      cwd: repo,
      env: envOf(env),
      encoding: "latin1",
    });
    expect(r.status).not.toBe(0);
    return r.stderr.trimEnd();
  };
  const ourError = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error).toBeInstanceOf(Error);
    return (error as Error).message;
  };

  it("commit and tag refuse an empty name and a name of crud only, with git's messages", async () => {
    const t = twins();
    const commitArgs = ["commit", "-q", "--allow-empty", "-m", "x"];
    const ourCommit = async (env: Env) =>
      ourError(
        (await open(t.ours, envOf(env))).commit().setAllowEmpty(true).setMessage("x\n").call(),
      );
    const ourTag = async (env: Env) =>
      ourError((await open(t.ours, envOf(env))).tag().setName("v1").setMessage("m\n").call());

    // GIT_AUTHOR_NAME="": no hint (the name was given)
    const emptyEnv = { GIT_AUTHOR_NAME: "" };
    const emptyName = refusal(t.native, emptyEnv, ...commitArgs);
    expect(emptyName).toBe("fatal: empty ident name (for <ann@example.com>) not allowed");
    expect(await ourCommit(emptyEnv)).toBe(emptyName);
    await expect(
      (await open(t.ours, envOf(emptyEnv))).commit().setAllowEmpty(true).setMessage("x\n").call(),
    ).rejects.toThrow(InvalidIdentError);

    // a name of crud only
    const crudEnv = { GIT_AUTHOR_NAME: " ;;;" };
    const crud = refusal(t.native, crudEnv, ...commitArgs);
    expect(crud).toBe("fatal: name consists only of disallowed characters:  ;;;");
    expect(await ourCommit(crudEnv)).toBe(crud);

    // the committer's, and the tagger's
    const committerEnv = { GIT_COMMITTER_NAME: "" };
    expect(await ourCommit(committerEnv)).toBe(refusal(t.native, committerEnv, ...commitArgs));
    const tagRefusal = refusal(t.native, committerEnv, "tag", "-a", "-m", "m", "v1");
    expect(tagRefusal).toMatch(/^fatal: empty ident name \(for <cid@example\.com>\)/);
    expect(await ourTag(committerEnv)).toBe(tagRefusal);
    const crudTagger = { GIT_COMMITTER_NAME: "<>" };
    expect(await ourTag(crudTagger)).toBe(
      refusal(t.native, crudTagger, "tag", "-a", "-m", "m", "v1"),
    );

    // user.name="" (the default name): git's hint first
    for (const repo of [t.native, t.ours]) {
      build(repo, "config", "user.name", "");
      build(repo, "config", "user.email", "user@example.com");
    }
    const fromConfig = refusal(t.native, NONE, ...commitArgs);
    expect(fromConfig).toMatch(
      /^Author identity unknown\n[\s\S]*\nfatal: empty ident name \(for <user@example\.com>\) not allowed$/,
    );
    expect(await ourCommit(NONE)).toBe(fromConfig);

    // user.useConfigOnly with only committer.*: the author's name is empty (for <>)
    for (const repo of [t.native, t.ours]) {
      build(repo, "config", "--unset", "user.name");
      build(repo, "config", "--unset", "user.email");
      build(repo, "config", "user.useConfigOnly", "true");
      build(repo, "config", "committer.name", "CN");
      build(repo, "config", "committer.email", "cn@example.com");
    }
    const committerOnly = refusal(t.native, NONE, ...commitArgs);
    expect(committerOnly).toMatch(/\nfatal: empty ident name \(for <>\) not allowed$/);
    expect(await ourCommit(NONE)).toBe(committerOnly);
  });

  it("an email key set anywhere, even empty, stops the email: <>", async () => {
    const t = twins();
    const commit = async (message: string) => {
      git(t.native, envOf(NONE), "commit", "-q", "--allow-empty", "-m", message);
      await (await open(t.ours, envOf({ ...NONE, EMAIL: "em@example.com" })))
        .commit()
        .setAllowEmpty(true)
        .setMessage(`${message}\n`)
        .call();
      expectSame(t, "HEAD");
    };
    // user.useConfigOnly, user.name, user.email="": "UN <>", $EMAIL not read
    for (const repo of [t.native, t.ours]) {
      build(repo, "config", "user.useConfigOnly", "true");
      build(repo, "config", "user.name", "UN");
      build(repo, "config", "user.email", "");
    }
    await commit("empty user.email");
    expect(catFile(t.ours, "HEAD")).toMatch(/\nauthor UN <> \d+ [+-]\d{4}\n/);
    // committer.email alone: the author's email empty, the committer's given
    for (const repo of [t.native, t.ours]) {
      build(repo, "config", "--unset", "user.email");
      build(repo, "config", "committer.email", "c@example.com");
    }
    await commit("committer.email only");
    expect(catFile(t.ours, "HEAD")).toMatch(/\nauthor UN <> .*\ncommitter UN <c@example\.com> /);
  });

  it("a fallback gives a name and an email, never a date: the committer is dated now", async () => {
    const t = twins();
    const nobody = envOf(NONE);
    // amend: the author kept (the base build's, 1112911993), the committer now
    const before = Math.floor(Date.now() / 1000);
    await (await open(t.ours, nobody)).commit().setAmend(true).setMessage("amended\n").call();
    let object = catFile(t.ours, "HEAD");
    expect(object).toMatch(/\nauthor Interop Tester <interop@example\.com> 1112911993 \+0000\n/);
    expect(object).toMatch(/\ncommitter Interop Tester <interop@example\.com> /);
    expect(secondsOf(object, "committer")).toBeGreaterThanOrEqual(before);

    // setAuthorIdent with an old date
    const old = { name: "Old", email: "old@x", timestamp: 1000000000, tzOffset: "+0300" };
    await (await open(t.ours, nobody))
      .commit()
      .setAllowEmpty(true)
      .setAuthorIdent(old)
      .setMessage("old\n")
      .call();
    object = catFile(t.ours, "HEAD");
    expect(object).toMatch(/\nauthor Old <old@x> 1000000000 \+0300\n/);
    expect(object).toMatch(/\ncommitter Old <old@x> /);
    expect(secondsOf(object, "committer")).toBeGreaterThanOrEqual(before);

    // GIT_AUTHOR_DATE, no committer identity: the committer is not dated by the author
    const authorOnly = envOf({
      ...NONE,
      GIT_AUTHOR_NAME: "A",
      GIT_AUTHOR_EMAIL: "a@x",
      GIT_AUTHOR_DATE: "1000000000 +0300",
    });
    await (await open(t.ours, authorOnly)).commit().setAllowEmpty(true).setMessage("a\n").call();
    object = catFile(t.ours, "HEAD");
    expect(object).toMatch(/\nauthor A <a@x> 1000000000 \+0300\n/);
    expect(object).toMatch(/\ncommitter A <a@x> /);
    expect(secondsOf(object, "committer")).toBeGreaterThanOrEqual(before);

    // a merge with an author given
    const merged = await (await open(t.ours, nobody)).merge().include("feat").setAuthor(old).call();
    expect(merged.status).toBe(MergeStatus.MERGED);
    object = catFile(t.ours, "HEAD");
    expect(object).toMatch(/\nauthor Old <old@x> 1000000000 \+0300\n/);
    expect(secondsOf(object, "committer")).toBeGreaterThanOrEqual(before);
  });

  it("explicit names lose their crud, as git's --author", async () => {
    const t = twins();
    const env = envOf();
    git(
      t.native,
      env,
      "commit",
      "-q",
      "--allow-empty",
      "--author= ;Dr. X; < x@example.com >",
      "-m",
      "x",
    );
    await (await open(t.ours, env))
      .commit()
      .setAllowEmpty(true)
      .setAuthor(" ;Dr. X;", " x@example.com ")
      .setMessage("x\n")
      .call();
    expectSame(t, "HEAD");
    // amend --author: the kept author's date, the given name and email without crud
    const later = envOf({ GIT_COMMITTER_DATE: "1700009999 +0000" });
    git(
      t.native,
      later,
      "commit",
      "-q",
      "--amend",
      "--allow-empty",
      "--author=\"Y\" <'y@example.com'>",
      "-m",
      "y",
    );
    await (await open(t.ours, later))
      .commit()
      .setAmend(true)
      .setAllowEmpty(true)
      .setAuthor('"Y"', "'y@example.com'")
      .setMessage("y\n")
      .call();
    expectSame(t, "HEAD");
  });

  describe("the clock is read again before each pick (git's reset_ident_date)", () => {
    /** Names but no dates: every commit dated by the clock. */
    const undated = (): Env => ({ GIT_AUTHOR_DATE: undefined, GIT_COMMITTER_DATE: undefined });
    let now = 0;
    afterEach(() => {
      vi.restoreAllMocks();
    });
    /** A clock that moves ten seconds each time it is read. */
    const ticking = () => {
      now = 1_800_000_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => {
        now += 10_000;
        return now;
      });
    };
    /** The commits of `revs` and the seconds of HEAD's last `count` reflog lines. */
    const timesOf = (repo: string, revs: string[], count: number) => {
      const commits = revs.map((rev) => secondsOf(catFile(repo, rev), "committer"));
      return { commits, lines: readReflogTimes(repo).slice(-count) };
    };

    it("rebase: each pick committed and logged at its own time", async () => {
      const t = twins();
      const ours = await open(t.ours, envOf(undated()));
      await ours.checkout().setName("x").call();
      ticking();
      const rebase = await ours.rebase().setUpstreamBranch("main");
      expect((await rebase.call()).status).toBe(RebaseStatus.OK);
      vi.restoreAllMocks();
      const { commits, lines } = timesOf(t.ours, ["x~1", "x"], 3);
      // the two picks, then the finish (logged at the last pick's time)
      expect(commits[1]).toBeGreaterThan(commits[0]);
      expect(lines.slice(0, 2)).toEqual(commits);
      expect(lines[2]).toBe(commits[1]);
    });

    it("cherry-pick and revert of several commits: one time per pick", async () => {
      const t = twins();
      const ours = await open(t.ours, envOf(undated()));
      ticking();
      await ours.cherryPick().include("x~1").include("x").call();
      vi.restoreAllMocks();
      let { commits, lines } = timesOf(t.ours, ["HEAD~1", "HEAD"], 2);
      expect(commits[1]).toBeGreaterThan(commits[0]);
      expect(lines).toEqual(commits);

      ticking();
      await ours.revert().include("HEAD").include("HEAD~1").call();
      vi.restoreAllMocks();
      ({ commits, lines } = timesOf(t.ours, ["HEAD~1", "HEAD"], 2));
      expect(commits[1]).toBeGreaterThan(commits[0]);
      expect(lines).toEqual(commits);
      // a revert's author is dated with its commit
      expect(secondsOf(catFile(t.ours, "HEAD"), "author")).toBe(commits[1]);
    });
  });

  it("reflog lines are not strict: an empty name is the default's", () => {
    const environment = createNodeGitHostEnvironment({ env: { GIT_COMMITTER_NAME: "" } });
    const config = { value: (key: string) => ({ "user.email": "u@x" })[key] };
    expect(findIdent("committer", environment, config, { strict: false, now: 7 })).toMatchObject({
      name: "webrun-vcs",
      email: "u@x",
      timestamp: 7,
    });
    expect(() => findIdent("committer", environment, config, { now: 7 })).toThrow(
      "fatal: empty ident name (for <u@x>) not allowed",
    );
  });
});

/** The seconds of each line of HEAD's reflog, oldest first. */
function readReflogTimes(repo: string): number[] {
  return readFileSync(join(repo, ".git", "logs", "HEAD"), "latin1")
    .trim()
    .split("\n")
    .map((line) => Number(/> (\d+) [+-]\d{4}\t/.exec(line)?.[1]));
}

describe("resolveAuthorIdent / resolveCommitterIdent: git's guesses and refusals", () => {
  const config = (values: Record<string, string>) => ({ value: (key: string) => values[key] });
  const env = (over: object = {}) => ({ readFile: async () => undefined, ...over });

  it("$EMAIL alone names no one: the fallback's name, $EMAIL's email", () => {
    const fallback = { name: "F", email: "f@x" };
    expect(
      resolveCommitterIdent(env({ defaultEmail: "e@x" }), config({}), { now: 1, fallback }),
    ).toMatchObject({ name: "F", email: "e@x" });
    expect(
      resolveCommitterIdent(env(), config({ "user.name": "U" }), { now: 1, fallback }),
    ).toMatchObject({ name: "U", email: "f@x" });
  });

  it("any *.email key, even empty or the other role's, stops $EMAIL: <>", () => {
    const e = env({ defaultEmail: "e@x" });
    const keys: Record<string, string>[] = [
      { "user.email": "" },
      { "author.email": "" },
      { "committer.email": "c@x" },
    ];
    for (const values of keys) {
      expect(
        resolveAuthorIdent(e, config({ "user.name": "U", ...values }), { now: 1 }),
      ).toMatchObject({ name: "U", email: "" });
    }
    // an empty author.email is skipped for user.email
    expect(
      resolveAuthorIdent(e, config({ "user.name": "U", "author.email": "", "user.email": "u@x" })),
    ).toMatchObject({ email: "u@x" });
    // GIT_AUTHOR_EMAIL="" is an email
    expect(
      resolveAuthorIdent(
        env({ author: { email: "" } }),
        config({ "user.name": "U", "user.email": "u@x" }),
      ),
    ).toMatchObject({ email: "" });
  });

  it("strict refusals in git's order: no email, no name, empty name, crud", () => {
    const strict = config({ "user.useConfigOnly": "true" });
    expect(() => resolveAuthorIdent(env({ author: { name: "" } }), strict)).toThrow(
      /no email was given/,
    );
    expect(() =>
      resolveAuthorIdent(env({ author: { name: "", email: "<a@x>" } }), config({})),
    ).toThrow(/^fatal: empty ident name \(for <<a@x>>\) not allowed$/);
    expect(() =>
      resolveAuthorIdent(env({ author: { name: " <>", email: "a@x" } }), config({})),
    ).toThrow(/^fatal: name consists only of disallowed characters: {2}<>$/);
    expect(() =>
      resolveCommitterIdent(env(), config({ "user.name": "", "user.email": "u@x" })),
    ).toThrow(/^Committer identity unknown\n[\s\S]*fatal: empty ident name \(for <u@x>\)/);
    // an unreadable date only after the name
    expect(() =>
      resolveAuthorIdent(env({ author: { name: "", email: "a@x", date: "bad" } }), config({})),
    ).toThrow(/empty ident name/);
  });
});
