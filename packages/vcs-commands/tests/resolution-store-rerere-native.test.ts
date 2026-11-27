/**
 * The transformation API's resolution store (vcs-store-files `GitResolutionStore`) over
 * git's rerere (statewalker/webrun-vcs#359): what it records in `rr-cache/` is what two
 * `git rerere` runs record (one while the path was conflicted, one once it was resolved),
 * native `git rerere status`/`diff`/`remaining`/`gc` and merges read it as their own, and the
 * store replays what native git recorded as `git rerere` replays it.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitResolutionStore } from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import type { ResolutionStore } from "@statewalker/vcs-working-tree/transformation";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { git, gitOk, openOurs, put, snapshot } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { buildT4200, copyRrCache, rerereState } from "./rerere-native-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

interface Twins {
  native: string;
  ours: string;
}

/** Both twins built as t4200's setup, then left in `merge first`'s conflict without rerere. */
function conflicted(config: Record<string, string> = {}): Twins {
  const n = counter++;
  const t = { native: join(root, `native-${n}`), ours: join(root, `ours-${n}`) };
  for (const dir of [t.native, t.ours]) {
    buildT4200(root, dir, config);
    git(root, dir, "-c", "rerere.enabled=false", "merge", "first");
  }
  return t;
}

async function storeOf(dir: string): Promise<ResolutionStore> {
  const ours = await openOurs(dir);
  const wc = ours.workingCopy;
  return new GitResolutionStore(
    createNodeFilesApi({ rootDir: dir }),
    wc.checkout.staging,
    wc.history.blobs,
    ".git",
    "",
    wc.worktree,
    ours.rerere().engine(),
  );
}

/** The records of `rr-cache/` alone (`MERGE_RR` is "" natively, absent or "" in ours). */
function records(dir: string): Record<string, string> {
  const { MERGE_RR, ...rest } = rerereState(dir);
  expect(MERGE_RR ?? "").toBe("");
  return rest;
}

const RESOLUTION = (dir: string) => gitOk(root, dir, "show", "first:a1");

/** Native git in both twins, its exit status and output compared. */
function bothSame(t: Twins, ...args: string[]): void {
  const a = git(root, t.native, ...args);
  const b = git(root, t.ours, ...args);
  expect({ status: b.status, stdout: b.stdout, stderr: b.stderr }).toEqual({
    status: a.status,
    stdout: a.stdout,
    stderr: a.stderr,
  });
}

describeGit("the resolution store records and replays as git's rerere (t4200-rerere.sh)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "resolution-store-rerere-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('t4200-rerere.sh: "nothing recorded without rerere"', async () => {
    const t = conflicted();
    put(t.native, "a1", RESOLUTION(t.native));
    gitOk(root, t.native, "rerere");
    put(t.ours, "a1", RESOLUTION(t.ours));
    const store = await storeOf(t.ours);
    expect(await store.recordResolution("a1")).toBeUndefined();
    expect(rerereState(t.ours)).toEqual(rerereState(t.native));
    expect(rerereState(t.ours)).toEqual({});
  });

  it('t4200-rerere.sh: "explicit rerere": the records two `git rerere` runs write', async () => {
    const t = conflicted({ "rerere.enabled": "true" });
    gitOk(root, t.native, "rerere");
    put(t.native, "a1", RESOLUTION(t.native));
    gitOk(root, t.native, "rerere");
    put(t.ours, "a1", RESOLUTION(t.ours));
    const store = await storeOf(t.ours);
    const id = await store.recordResolution("a1");
    expect(records(t.ours)).toEqual(records(t.native));
    expect(Object.keys(records(t.ours))).toEqual([
      "rr-cache/",
      `rr-cache/${id}/`,
      `rr-cache/${id}/postimage`,
      `rr-cache/${id}/preimage`,
    ]);
    // the old format's labelled markers are gone
    expect(records(t.ours)[`rr-cache/${id}/preimage`]).not.toContain("<<<<<<< ours");
  });

  it('t4200-rerere.sh: "rr-cache looks sane": the variant `MERGE_RR` gave the path is used', async () => {
    const t = conflicted({ "rerere.enabled": "true" });
    for (const dir of [t.native, t.ours]) {
      gitOk(root, dir, "rerere");
      put(dir, "a1", RESOLUTION(dir));
    }
    gitOk(root, t.native, "rerere");
    expect(await (await storeOf(t.ours)).recordResolution("a1")).toMatch(/^[0-9a-f]{40}$/);
    expect(rerereState(t.ours)).toEqual(rerereState(t.native));
    expect(rerereState(t.ours).MERGE_RR).toBe("");
  });

  it('t4200-rerere.sh: "multiple identical conflicts": a second variant of one conflict id', async () => {
    // f1 and f2 conflict with the same sides in other context: one id, two variants
    const n = counter++;
    const t = { native: join(root, `native-${n}`), ours: join(root, `ours-${n}`) };
    for (const dir of [t.native, t.ours]) {
      mkdirSync(dir, { recursive: true });
      const run = (...args: string[]) => gitOk(root, dir, ...args);
      run("init", "-q", "-b", "main");
      run("config", "rerere.enabled", "true");
      put(dir, "f1", "a\nX\nb\n");
      put(dir, "f2", "c\nX\nd\n");
      run("add", ".");
      run("commit", "-q", "-m", "base");
      run("checkout", "-q", "-b", "side");
      put(dir, "f1", "a\nT\nb\n");
      put(dir, "f2", "c\nT\nd\n");
      run("commit", "-q", "-a", "-m", "theirs");
      run("checkout", "-q", "main");
      put(dir, "f1", "a\nO\nb\n");
      put(dir, "f2", "c\nO\nd\n");
      run("commit", "-q", "-a", "-m", "ours");
      git(root, dir, "-c", "rerere.enabled=false", "merge", "side");
    }
    gitOk(root, t.native, "rerere");
    for (const dir of [t.native, t.ours]) {
      put(dir, "f1", "a\nR1\nb\n");
      put(dir, "f2", "c\nR2\nd\n");
    }
    gitOk(root, t.native, "rerere");
    const store = await storeOf(t.ours);
    const id = await store.recordResolution("f1");
    expect(await store.recordResolution("f2")).toBe(id);
    expect(records(t.ours)).toEqual(records(t.native));
    expect(records(t.ours)[`rr-cache/${id}/postimage.1`]).toBe("c\nR2\nd\n");
  });

  it('t4200-rerere.sh: "rerere.enabled works, too": a conflict git would replay records nothing', async () => {
    // f and g conflict with the same sides, their context differing far from the hunk
    const n = counter++;
    const t = { native: join(root, `native-${n}`), ours: join(root, `ours-${n}`) };
    const lines = (first: string, mid: string) => `${first}\n2\n3\n4\n5\n${mid}\n6\n7\n8\n9\n`;
    for (const dir of [t.native, t.ours]) {
      mkdirSync(dir, { recursive: true });
      const run = (...args: string[]) => gitOk(root, dir, ...args);
      run("init", "-q", "-b", "main");
      run("config", "rerere.enabled", "true");
      put(dir, "f", lines("1", "X"));
      put(dir, "g", lines("one", "X"));
      run("add", ".");
      run("commit", "-q", "-m", "base");
      for (const [branch, file, side] of [
        ["tf", "f", "T"],
        ["of", "f", "O"],
        ["tg", "g", "T"],
        ["og", "g", "O"],
      ] as const) {
        run("checkout", "-q", "-b", branch, "main");
        put(dir, file, lines(file === "f" ? "1" : "one", side));
        run("commit", "-q", "-a", "-m", branch);
      }
      run("checkout", "-q", "of");
      git(root, dir, "-c", "rerere.enabled=false", "merge", "tf");
    }
    gitOk(root, t.native, "rerere");
    for (const dir of [t.native, t.ours]) put(dir, "f", lines("1", "R"));
    gitOk(root, t.native, "rerere");
    const store = await storeOf(t.ours);
    const id = await store.recordResolution("f");
    for (const dir of [t.native, t.ours]) {
      gitOk(root, dir, "reset", "-q", "--hard");
      gitOk(root, dir, "checkout", "-q", "og");
      git(root, dir, "-c", "rerere.enabled=false", "merge", "tg");
    }
    expect(git(root, t.native, "rerere").stderr).toContain(
      "Resolved 'g' using previous resolution.",
    );
    put(t.ours, "g", lines("one", "R"));
    expect(await (await storeOf(t.ours)).recordResolution("g")).toBe(id);
    // native's replay leaves its thisimage behind; the records are the same
    const withoutThisimage = (dir: string) =>
      Object.fromEntries(Object.entries(records(dir)).filter(([k]) => !k.includes("thisimage")));
    expect(withoutThisimage(t.ours)).toEqual(withoutThisimage(t.native));
    expect(Object.keys(withoutThisimage(t.ours))).toHaveLength(4);
  });

  it('t4200-rerere.sh: "rerere status", "rerere diff", "rerere gc" over what the store recorded', async () => {
    const t = conflicted({ "rerere.enabled": "true" });
    gitOk(root, t.native, "rerere");
    put(t.native, "a1", RESOLUTION(t.native));
    gitOk(root, t.native, "rerere");
    put(t.ours, "a1", RESOLUTION(t.ours));
    await (await storeOf(t.ours)).recordResolution("a1");
    for (const sub of ["status", "diff", "remaining"]) bothSame(t, "rerere", sub);
    // a recent resolution is kept
    bothSame(t, "rerere", "gc");
    expect(records(t.ours)).toEqual(records(t.native));
    expect(Object.keys(records(t.ours))).toHaveLength(4);
    // a merge replays it, as it replays native git's record
    bothSame(t, "reset", "-q", "--hard");
    bothSame(t, "merge", "first");
    expect(snapshot(root, t.ours)).toEqual(snapshot(root, t.native));
    for (const sub of ["status", "diff", "remaining"]) bothSame(t, "rerere", sub);
    bothSame(t, "commit", "-q", "-a", "-m", "resolved");
    // a resolution unused for 100 days (gc.rerereResolved: 60) goes as a resolved one
    const old = Date.now() / 1000 - 100 * 86400;
    for (const dir of [t.native, t.ours]) {
      for (const key of Object.keys(records(dir))) {
        if (!key.endsWith("/")) utimesSync(join(dir, ".git", key), old, old);
      }
    }
    bothSame(t, "rerere", "gc");
    expect(records(t.ours)).toEqual(records(t.native));
    expect(records(t.ours)).toEqual({ "rr-cache/": "dir" });
  });

  it('t4200-rerere.sh: "rerere.enabled works, too": the store replays what native git recorded', async () => {
    const t = conflicted({ "rerere.enabled": "true" });
    gitOk(root, t.native, "rerere");
    put(t.native, "a1", RESOLUTION(t.native));
    gitOk(root, t.native, "rerere");
    copyRrCache(t.native, t.ours);
    // the same conflict again, rerere off for the merge: nothing replayed yet
    for (const dir of [t.native, t.ours]) {
      gitOk(root, dir, "reset", "-q", "--hard");
      git(root, dir, "-c", "rerere.enabled=false", "merge", "first");
    }
    const replayed = git(root, t.native, "rerere");
    expect(replayed.stderr).toContain("Resolved 'a1' using previous resolution.");
    const store = await storeOf(t.ours);
    const suggested = await store.getSuggestedResolution("a1");
    expect(suggested?.resolvedContent && new TextDecoder().decode(suggested.resolvedContent)).toBe(
      RESOLUTION(t.native),
    );
    expect(await store.autoResolve()).toEqual(["a1"]);
    expect(snapshot(root, t.ours)).toEqual(snapshot(root, t.native));
    expect(records(t.ours)).toEqual(records(t.native));
  });
});
