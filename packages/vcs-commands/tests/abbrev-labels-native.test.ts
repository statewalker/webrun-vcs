/**
 * Abbreviated ids in what the sequencer, rebase and merge write, against native git: with
 * `core.abbrev=4` and blobs crafted to share 4 or 5 digits with the commits named, git's
 * `find_unique_abbrev` gives lengths 4, 5 and 6 (never the fixed 7): in conflict marker
 * labels (`>>>>>>> <abbrev> (<subject>)`, `parent of ...`, merge-ort's single merge base),
 * `sequencer/todo`, `could not apply <abbrev>...`, and `SQUASH_MSG`'s `Merge:` lines.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CherryPickStatus, MergeStatus, RebaseStatus, RevertStatus } from "../src/index.js";
import { collidingBlob } from "./craft-objects.js";
import {
  git,
  gitOk,
  INTEROP_AUTHOR_ENV,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  snapshot,
} from "./merge-native-helpers.js";
import { buildGraph, buildHistory, type History, text } from "./merge-native-scenarios.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

/** The twins, `core.abbrev=4`, on `branch`. */
function twins(history: History, branch = "main"): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  for (const dir of [native, ours]) {
    buildHistory(root, dir, { ...history, config: { ...history.config, "core.abbrev": "4" } });
    git(root, dir, "checkout", "-q", branch);
  }
  return { native, ours };
}

/** Blobs in both twins sharing `digits` digits with what `rev` names. */
function collide(dirs: { native: string; ours: string }, rev: string, digits: number): string {
  const id = gitOk(root, dirs.native, "rev-parse", rev).trim();
  collidingBlob(root, [dirs.native, dirs.ours], id, digits);
  return id;
}

/** git's abbreviation of `rev` in the native twin. */
const short = (dir: string, rev: string) => gitOk(root, dir, "rev-parse", "--short", rev).trim();

const same = (ours: string, native: string) =>
  expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));

/** side: `c.txt`, then `a.txt` line 5 (conflicts with main's), then `d.txt`. */
const threePicks: History = {
  base: { "a.txt": text(), "b.txt": "b\n" },
  main: { "a.txt": text({ 5: "main" }) },
  side: { "c.txt": "c\n" },
  sideMore: [{ "a.txt": text({ 5: "side" }) }, { "d.txt": "d\n" }],
};

/** The lines of git's stderr that are no hints. */
const errors = (text: string) => text.split("\n").filter((l) => l !== "" && !l.startsWith("hint:"));

describeGit("abbreviated ids as find_unique_abbrev gives them (core.abbrev=4)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "abbrev-labels-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("cherry-pick: conflict labels, the todo and git's error", async () => {
    const dirs = twins(threePicks);
    collide(dirs, "side~1", 5);
    collide(dirs, "side", 4);
    expect(short(dirs.native, "side~1")).toHaveLength(6);
    expect(short(dirs.native, "side")).toHaveLength(5);
    const expected = git(root, dirs.native, "cherry-pick", "side~2", "side~1", "side");
    const result = await (await openOurs(dirs.ours))
      .cherryPick()
      .setCommitter(INTEROP_IDENT)
      .include("side~2")
      .include("side~1")
      .include("side")
      .call();
    expect(result.status).toBe(CherryPickStatus.CONFLICTING);
    expect(errors(result.message ?? "")).toEqual(errors(expected.stderr));
    expect(expected.stderr).toContain(`could not apply ${short(dirs.native, "side~1")}...`);
    same(dirs.ours, dirs.native);
  });

  it("revert: the `parent of <abbrev> (<subject>)` label", async () => {
    const dirs = twins(threePicks);
    collide(dirs, "side~1", 5);
    const expected = git(root, dirs.native, "revert", "side~1");
    const result = await (await openOurs(dirs.ours, INTEROP_AUTHOR_ENV))
      .revert()
      .setCommitter(INTEROP_IDENT)
      .include("side~1")
      .call();
    expect(result.status).toBe(RevertStatus.CONFLICTING);
    expect(errors(result.message ?? "")).toEqual(errors(expected.stderr));
    same(dirs.ours, dirs.native);
  });

  it("rebase: conflict labels and `could not apply <abbrev>...`", async () => {
    const dirs = twins(threePicks, "side");
    collide(dirs, "side~1", 5);
    const expected = git(root, dirs.native, "rebase", "main");
    const command = (await openOurs(dirs.ours)).rebase().setCommitter(INTEROP_IDENT);
    await command.setUpstreamBranch("main");
    const result = await command.call();
    expect(result.status).toBe(RebaseStatus.STOPPED);
    // native git's progress (`Rebasing (1/3)\r`) left out
    const apply = (text: string) =>
      text
        .split("\n")
        .filter((l) => /ould not apply/.test(l))
        .map((l) => l.slice(l.search(/(error: c|C)ould not apply/)))
        // git before 2.5x wrote the todo (and this line) without `# ` before the subject
        .map((l) => l.replace(/^(Could not apply [0-9a-f]+\.\.\.) (?!# )/, "$1 # "));
    expect(apply(result.message ?? "")).toEqual(apply(expected.stderr + expected.stdout));
    expect(apply(expected.stderr + expected.stdout)).toHaveLength(2);
    same(dirs.ours, dirs.native);
  });

  it("merge: merge-ort's single merge base label (diff3)", async () => {
    const dirs = twins({
      base: { "a.txt": text() },
      main: { "a.txt": text({ 5: "main" }) },
      side: { "a.txt": text({ 5: "side" }) },
      config: { "merge.conflictStyle": "diff3" },
    });
    const base = collide(dirs, "main~1", 5);
    expect(short(dirs.native, base)).toHaveLength(6);
    git(root, dirs.native, "merge", "side");
    const result = await (await openOurs(dirs.ours))
      .merge()
      .include("side")
      .setAuthor(INTEROP_IDENT)
      .setCommitter(INTEROP_IDENT)
      .call();
    expect(result.status).toBe(MergeStatus.CONFLICTING);
    same(dirs.ours, dirs.native);
  });

  it("merge --squash: the `Merge:` line of a merged merge commit", async () => {
    const n = counter++;
    const dirs = { native: join(root, `native-${n}`), ours: join(root, `ours-${n}`) };
    for (const dir of [dirs.native, dirs.ours]) {
      buildGraph(root, dir, {
        base: { "a.txt": "a\n" },
        config: { "core.abbrev": "4" },
        steps: [
          { branch: "side", files: { "s.txt": "s\n" } },
          { branch: "other", from: "main", files: { "o.txt": "o\n" } },
          { branch: "side", merge: "other", files: { "o.txt": "o\n" } },
          { branch: "main", files: { "m.txt": "m\n" } },
        ],
      });
    }
    collide(dirs, "side^1", 5);
    collide(dirs, "side^2", 4);
    git(root, dirs.native, "merge", "--squash", "side");
    await (await openOurs(dirs.ours))
      .merge()
      .include("side")
      .setSquash(true)
      .setAuthor(INTEROP_IDENT)
      .setCommitter(INTEROP_IDENT)
      .call();
    const squash = snapshot(root, dirs.native).state.SQUASH_MSG ?? "";
    expect(squash).toContain(
      `Merge: ${short(dirs.native, "side^1")} ${short(dirs.native, "side^2")}\n`,
    );
    same(dirs.ours, dirs.native);
  });
});
