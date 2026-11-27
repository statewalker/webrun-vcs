/**
 * rerere against native git (t4200-rerere.sh): the same history built twice, native git in
 * one twin and ours in the other, then the stderr lines, `MERGE_RR`, every file under
 * `rr-cache/`, the index and the worktree compared after each step; resolutions one side
 * recorded are replayed by the other.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MergeOperation, MergeStatus } from "../src/index.js";
import { git, gitOk, INTEROP_IDENT, openOurs, put, snapshot } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { buildT4200, copyRrCache, rerereState, rrMtime } from "./rerere-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

function twins(config: Record<string, string> = {}): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  buildT4200(root, native, config);
  buildT4200(root, ours, config);
  return { native, ours };
}

/** Runs native git in both twins (setup steps). */
function both(t: { native: string; ours: string }, ...args: string[]): void {
  gitOk(root, t.native, ...args);
  gitOk(root, t.ours, ...args);
}

/** Native git in both twins where it may fail (a conflicting merge without rerere). */
function bothMayFail(t: { native: string; ours: string }, ...args: string[]): void {
  git(root, t.native, ...args);
  git(root, t.ours, ...args);
}

function writeBoth(t: { native: string; ours: string }, path: string, content: string): void {
  put(t.native, path, content);
  put(t.ours, path, content);
}

/** The lines rerere prints on stderr (what our results carry). */
function rerereLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((l) =>
      /^(Recorded (preimage|resolution) for|Resolved '|Staged '|Forgot resolution|Updated preimage|error: (could not parse|no remembered|could not open))/.test(
        l,
      ),
    );
}

function same(t: { native: string; ours: string }): void {
  expect(rerereState(t.ours)).toEqual(rerereState(t.native));
  expect(snapshot(root, t.ours)).toEqual(snapshot(root, t.native));
}

/** `git rerere [args]` natively in one twin, ours in the other; both outputs compared. */
async function rerere(
  t: { native: string; ours: string },
  subcommand?: string,
  options: { autoUpdate?: boolean; paths?: string[]; nativeArgs?: string[] } = {},
) {
  const args = ["rerere", ...(options.nativeArgs ?? [])];
  if (subcommand) args.push(subcommand);
  args.push(...(options.paths ?? []));
  const expected = git(root, t.native, ...args);
  const command = (await openOurs(t.ours)).rerere();
  if (subcommand) command.setSubcommand(subcommand);
  if (options.autoUpdate !== undefined) command.setAutoUpdate(options.autoUpdate);
  for (const p of options.paths ?? []) command.addPath(p);
  const actual = await command.call();
  expect({ exit: actual.exitCode, stdout: actual.stdout, stderr: actual.stderr }).toEqual({
    exit: expected.status,
    stdout: expected.stdout,
    stderr: expected.stderr,
  });
  return actual;
}

/** `git merge <branch>` natively and ours; status, merge-ort's output, rerere's lines. */
async function merge(
  t: { native: string; ours: string },
  branch: string,
  options: { autoUpdate?: boolean } = {},
) {
  const flag =
    options.autoUpdate === undefined
      ? []
      : [options.autoUpdate ? "--rerere-autoupdate" : "--no-rerere-autoupdate"];
  const expected = git(root, t.native, "merge", ...flag, branch);
  const command = (await openOurs(t.ours))
    .merge()
    .include(branch)
    .setAuthor(INTEROP_IDENT)
    .setCommitter(INTEROP_IDENT);
  if (options.autoUpdate !== undefined) command.setRerereAutoUpdate(options.autoUpdate);
  const result = await command.call();
  expect(result.rerereOutput ?? []).toEqual(rerereLines(expected.stderr));
  expect(result.status === MergeStatus.CONFLICTING).toBe(expected.status === 1);
  return result;
}

/** `git commit -a -m <message>` natively and ours. */
async function commitAll(t: { native: string; ours: string }, message: string) {
  const expected = git(root, t.native, "commit", "-q", "-a", "-m", message);
  const result = await (await openOurs(t.ours))
    .commit()
    .setAll(true)
    .setMessage(message)
    .setAuthorIdent(INTEROP_IDENT)
    .setCommitterIdent(INTEROP_IDENT)
    .call();
  expect(result.rerereOutput ?? []).toEqual(rerereLines(expected.stderr));
  return result;
}

const FIRST_RESOLUTION = (dir: string) => gitOk(root, dir, "show", "first:a1");

describeGit("rerere as native git (t4200-rerere.sh)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "rerere-native-"));
  });
  afterAll(async () => {
    await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  it('t4200-rerere.sh: "nothing recorded without rerere"', async () => {
    const t = twins({ "rerere.enabled": "false" });
    await merge(t, "first");
    expect(rerereState(t.ours)).toEqual({});
    same(t);
  });

  it('t4200-rerere.sh: "activate rerere, old style (conflicting merge)"', async () => {
    // rerere.enabled unset: an existing rr-cache/ turns it on
    const t = twins();
    for (const dir of [t.native, t.ours]) mkdirSync(join(dir, ".git", "rr-cache"));
    const result = await merge(t, "first");
    expect(result.rerereOutput).toEqual(["Recorded preimage for 'a1'"]);
    same(t);
  });

  it('t4200-rerere.sh: "rerere.enabled works, too"', async () => {
    const t = twins({ "rerere.enabled": "true" });
    const result = await merge(t, "first");
    expect(result.rerereOutput).toEqual(["Recorded preimage for 'a1'"]);
    same(t);
  });

  it('t4200-rerere.sh: "explicit rerere" over a merge made without rerere', async () => {
    const t = twins();
    bothMayFail(t, "-c", "rerere.enabled=false", "merge", "first");
    both(t, "config", "rerere.enabled", "true");
    await rerere(t);
    same(t);
    // a second run with the file still conflicted records the preimage again
    await rerere(t);
    same(t);
  });

  it('t4200-rerere.sh: "rr-cache looks sane", "rerere diff", "rerere status"', async () => {
    const t = twins({ "rerere.enabled": "true" });
    await merge(t, "first");
    same(t);
    for (const dir of [t.native, t.ours]) put(dir, "a1", FIRST_RESOLUTION(dir));
    await rerere(t, "diff");
    await rerere(t, "status");
    await rerere(t, "remaining");
  });

  it('t4200-rerere.sh: "first postimage wins", "rerere updates postimage timestamp"', async () => {
    const t = twins({ "rerere.enabled": "true" });
    await merge(t, "first");
    for (const dir of [t.native, t.ours]) {
      put(dir, "a1", FIRST_RESOLUTION(dir).replace("To die: t", "To die! T"));
    }
    await commitAll(t, "prefer first over second");
    same(t);
    const id = rerereState(t.ours).MERGE_RR;
    expect(id).toBe("");
    both(t, "checkout", "-q", "-b", "third", "main");
    for (const dir of [t.native, t.ours]) {
      put(dir, "a1", gitOk(root, dir, "show", "second^:a1").replace("To die: t", "To die! T"));
    }
    both(t, "commit", "-q", "-a", "-m", "third");
    // the postimage dated an hour back: a replay freshens it
    const ids = Object.keys(rerereState(t.ours)).filter((k) => k.endsWith("/postimage"));
    expect(ids).toHaveLength(1);
    const post = (ids[0] as string).slice("rr-cache/".length);
    const old = Date.now() / 1000 - 3600;
    for (const dir of [t.native, t.ours]) utimesSync(join(dir, ".git", "rr-cache", post), old, old);
    const result = await merge(t, "first");
    expect(result.rerereOutput).toEqual(["Resolved 'a1' using previous resolution."]);
    same(t);
    expect(rrMtime(t.ours, post)).toBeGreaterThan(old + 60);
  });

  it('t4200-rerere.sh: "rerere clear", "leftover directory", "missing preimage"', async () => {
    const t = twins({ "rerere.enabled": "true" });
    await merge(t, "first");
    await rerere(t, "clear");
    same(t);
    both(t, "reset", "-q", "--hard");
    // leftover directory: the preimage is written into it
    await merge(t, "first");
    same(t);
    // a postimage without its preimage
    for (const dir of [t.native, t.ours]) {
      put(dir, "a1", FIRST_RESOLUTION(dir));
    }
    await rerere(t);
    same(t);
    const pre = Object.keys(rerereState(t.ours)).find((k) => k.endsWith("/preimage")) as string;
    for (const dir of [t.native, t.ours]) rmSync(join(dir, ".git", pre));
    both(t, "reset", "-q", "--hard");
    await merge(t, "first");
    same(t);
  });

  it("resolutions recorded by ours are replayed by native git, and the reverse", async () => {
    const t = twins({ "rerere.enabled": "true" });
    await merge(t, "first");
    for (const dir of [t.native, t.ours]) put(dir, "a1", FIRST_RESOLUTION(dir));
    await commitAll(t, "resolved");
    same(t);
    both(t, "reset", "-q", "--hard", "HEAD^");
    // each side replays what the other recorded
    const ourCache = join(root, `cache-${counter}`);
    mkdirSync(join(ourCache, ".git"), { recursive: true });
    copyRrCache(t.ours, ourCache);
    rmSync(join(t.ours, ".git", "rr-cache"), { recursive: true, force: true });
    copyRrCache(t.native, t.ours);
    rmSync(join(t.native, ".git", "rr-cache"), { recursive: true, force: true });
    copyRrCache(ourCache, t.native);
    const result = await merge(t, "first");
    expect(result.rerereOutput).toEqual(["Resolved 'a1' using previous resolution."]);
    same(t);
  });

  it('t4200-rerere.sh: "resolution was recorded properly", "rerere.autoupdate", "merge --rerere-autoupdate", "merge --no-rerere-autoupdate"', async () => {
    const t = twins({ "rerere.enabled": "true" });
    both(t, "checkout", "-q", "-b", "fifth", "main");
    writeBoth(t, "file3", "Hallo\n");
    both(t, "add", "file3");
    both(t, "commit", "-q", "-m", "version1");
    both(t, "checkout", "-q", "-b", "third", "main");
    writeBoth(t, "file3", "Bello\n");
    both(t, "add", "file3");
    both(t, "commit", "-q", "-m", "version2");
    both(t, "tag", "version2");
    await merge(t, "fifth");
    same(t);
    writeBoth(t, "file3", "Cello\n");
    both(t, "add", "file3");
    await commitAll(t, "resolution");
    same(t);
    // replayed, not staged
    both(t, "reset", "-q", "--hard", "HEAD^");
    await merge(t, "fifth");
    same(t);
    // rerere.autoupdate stages it
    both(t, "config", "rerere.autoupdate", "true");
    both(t, "reset", "-q", "--hard");
    await merge(t, "fifth");
    same(t);
    // --rerere-autoupdate without the setting
    both(t, "config", "--unset", "rerere.autoupdate");
    both(t, "reset", "-q", "--hard");
    await merge(t, "fifth", { autoUpdate: true });
    same(t);
    // --no-rerere-autoupdate over the setting
    both(t, "config", "rerere.autoupdate", "true");
    both(t, "reset", "-q", "--hard");
    await merge(t, "fifth", { autoUpdate: false });
    same(t);
  });

  it('t4200-rerere.sh: "explicit rerere with autoupdate", "explicit rerere --rerere-autoupdate overrides"', async () => {
    const t = twins({ "rerere.enabled": "true" });
    both(t, "checkout", "-q", "-b", "fifth", "main");
    writeBoth(t, "file3", "Hallo\n");
    both(t, "add", "file3");
    both(t, "commit", "-q", "-m", "version1");
    both(t, "checkout", "-q", "-b", "third", "main");
    writeBoth(t, "file3", "Bello\n");
    both(t, "add", "file3");
    both(t, "commit", "-q", "-m", "version2");
    bothMayFail(t, "-c", "rerere.enabled=false", "merge", "fifth");
    await rerere(t);
    writeBoth(t, "file3", "Cello\n");
    await rerere(t);
    same(t);
    for (const autoUpdate of [undefined, true, false]) {
      for (const setting of ["true", "false"]) {
        both(t, "config", "rerere.autoupdate", setting);
        both(t, "reset", "-q", "--hard");
        bothMayFail(t, "-c", "rerere.enabled=false", "merge", "fifth");
        await rerere(t, undefined, {
          ...(autoUpdate === undefined ? {} : { autoUpdate }),
          nativeArgs:
            autoUpdate === undefined
              ? []
              : [autoUpdate ? "--rerere-autoupdate" : "--no-rerere-autoupdate"],
        });
        same(t);
      }
    }
  });

  it('t4200-rerere.sh: "multiple identical conflicts"', async () => {
    const t = twins({ "rerere.enabled": "true" });
    const seq = (a: number, b: number) =>
      Array.from({ length: b - a + 1 }, (_, i) => `${a + i}\n`).join("");
    const early = seq(1, 6);
    const short = seq(11, 15);
    const long = seq(111, 120);
    const concat = (last: string, ...mid: string[]) =>
      early + mid.map((m) => `${m}\n`).join("") + last;
    writeBoth(t, "file1", concat(short));
    writeBoth(t, "file2", concat(long));
    both(t, "add", "file1", "file2");
    both(t, "commit", "-q", "-m", "base");
    both(t, "checkout", "-q", "-b", "six.1");
    writeBoth(t, "file1", concat(short, "6.1"));
    writeBoth(t, "file2", concat(long, "6.1"));
    both(t, "commit", "-q", "-a", "-m", "6.1");
    both(t, "checkout", "-q", "-b", "six.2", "HEAD^");
    writeBoth(t, "file1", concat(short, "6.2"));
    writeBoth(t, "file2", concat(long, "6.2"));
    both(t, "commit", "-q", "-a", "-m", "6.2");
    const resolve = () => {
      writeBoth(t, "file1", concat(short, "6.1", "6.2"));
      writeBoth(t, "file2", concat(long, "6.1", "6.2"));
    };
    await merge(t, "six.1");
    resolve();
    same(t);
    await rerere(t, "status");
    await rerere(t, "remaining");
    await rerere(t, "clear");
    same(t);
    both(t, "reset", "-q", "--hard");
    await merge(t, "six.1");
    resolve();
    await rerere(t);
    await rerere(t, "remaining");
    same(t);
    both(t, "reset", "-q", "--hard");
    await merge(t, "six.1");
    await rerere(t);
    await rerere(t, "remaining");
    same(t);
    await rerere(t, "forget", { paths: ["file2"] });
    await rerere(t, "status");
    same(t);
    await rerere(t);
    same(t);
  });

  it('t4200-rerere.sh: "rerere with unexpected conflict markers does not crash"', async () => {
    const t = twins({ "rerere.enabled": "true" });
    both(t, "checkout", "-q", "-b", "branch-1", "main");
    writeBoth(t, "test", "bar\n");
    both(t, "add", "test");
    both(t, "commit", "-q", "-m", "two");
    both(t, "checkout", "-q", "-b", "branch-2", "main");
    writeBoth(t, "test", "foo\n");
    both(t, "add", "test");
    both(t, "commit", "-q", "-a", "-m", "one");
    await merge(t, "branch-1");
    writeBoth(t, "test", "<<<<<<< a\n");
    await rerere(t);
    same(t);
    await rerere(t, "clear");
    same(t);
  });

  it('t4200-rerere.sh: "rerere with inner conflict markers"', async () => {
    const t = twins({ "rerere.enabled": "true" });
    both(t, "checkout", "-q", "-b", "A", "main");
    writeBoth(t, "test", "bar\n");
    both(t, "add", "test");
    both(t, "commit", "-q", "-m", "two");
    writeBoth(t, "test", "baz\n");
    both(t, "add", "test");
    both(t, "commit", "-q", "-m", "three");
    both(t, "checkout", "-q", "-b", "B", "main");
    writeBoth(t, "test", "foo\n");
    both(t, "add", "test");
    both(t, "commit", "-q", "-a", "-m", "one");
    await merge(t, "A~");
    both(t, "add", "test");
    await commitAll(t, "will solve conflicts later");
    await merge(t, "A");
    same(t);
    writeBoth(t, "test", "resolved\n");
    both(t, "add", "test");
    await commitAll(t, "solved conflict");
    same(t);
    both(t, "reset", "-q", "--hard", "HEAD~~");
    await merge(t, "A~");
    both(t, "add", "test");
    await commitAll(t, "will solve conflicts later");
    await merge(t, "A");
    same(t);
  });

  it('t4200-rerere.sh: "test simple stage 1 handling"', async () => {
    const t = twins({ "rerere.enabled": "true" });
    both(t, "checkout", "-q", "-b", "A", "main");
    both(t, "mv", "a1", "A");
    both(t, "commit", "-q", "-m", "rename to A");
    both(t, "checkout", "-q", "-b", "B", "main");
    both(t, "mv", "a1", "B");
    both(t, "commit", "-q", "-m", "rename to B");
    both(t, "checkout", "-q", "A^0");
    await merge(t, "B^0");
    same(t);
    await rerere(t, "remaining");
  });

  it("an unknown subcommand is git's usage (exit 129)", async () => {
    const t = twins({ "rerere.enabled": "true" });
    const expected = git(root, t.native, "rerere", "bogus");
    const actual = await (await openOurs(t.ours)).rerere().setSubcommand("bogus").call();
    expect(actual.exitCode).toBe(expected.status);
    expect(actual.stderr.split("\n")[0]).toBe(expected.stderr.split("\n")[0]);
  });

  it("merge --abort forgets MERGE_RR: a later commit records nothing, the merge conflicts again", async () => {
    const t = twins({ "rerere.enabled": "true" });
    await merge(t, "first");
    git(root, t.native, "merge", "--abort");
    const aborted = await (await openOurs(t.ours))
      .merge()
      .setOperation(MergeOperation.ABORT)
      .call();
    expect(aborted.status).toBe(MergeStatus.ABORTED);
    same(t);
    writeBoth(t, "other", "other\n");
    both(t, "add", "other");
    await commitAll(t, "unrelated");
    same(t);
    const again = await merge(t, "first");
    expect(again.rerereOutput).toEqual(["Recorded preimage for 'a1'"]);
    same(t);
  });

  it("merge --continue records the resolution", async () => {
    const t = twins({ "rerere.enabled": "true" });
    await merge(t, "first");
    for (const dir of [t.native, t.ours]) put(dir, "a1", FIRST_RESOLUTION(dir));
    both(t, "add", "a1");
    const expected = git(root, t.native, "merge", "--continue");
    const result = await (await openOurs(t.ours))
      .merge()
      .setOperation(MergeOperation.CONTINUE)
      .setAuthor(INTEROP_IDENT)
      .setCommitter(INTEROP_IDENT)
      .call();
    expect(result.rerereOutput).toEqual(rerereLines(expected.stderr));
    expect(result.rerereOutput).toEqual(["Recorded resolution for 'a1'."]);
    same(t);
  });
});
