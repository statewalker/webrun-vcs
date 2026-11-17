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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  Git,
  IdentityUnknownError,
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
    expect(resolveCommitterIdent(env(), config({}), { now: 5, fallback })).toEqual(fallback);
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
