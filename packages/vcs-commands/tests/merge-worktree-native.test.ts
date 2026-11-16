/**
 * `merge` against native `git merge`: the same history built twice, native git merging in
 * one twin and ours in the other, then refusal messages, merge-ort's output, status, index,
 * every worktree file and the state files compared. Then each side continues or aborts
 * the other's merge in progress.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FastForwardMode, MergeOperation, MergeStatus } from "../src/index.js";
import {
  git,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  ortLines,
  put,
  snapshot,
} from "./merge-native-helpers.js";
import { buildHistory, type History, text } from "./merge-native-scenarios.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

/** The history built twice: one twin for native git, one for ours. */
function twins(history: History): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  buildHistory(root, native, history);
  buildHistory(root, ours, history);
  return { native, ours };
}

interface MergeOptions {
  noCommit?: boolean;
  squash?: boolean;
  ff?: FastForwardMode;
}

function nativeArgs(options: MergeOptions): string[] {
  const args = ["merge"];
  if (options.noCommit) args.push("--no-commit");
  if (options.squash) args.push("--squash");
  if (options.ff === FastForwardMode.NO_FF) args.push("--no-ff");
  if (options.ff === FastForwardMode.FF_ONLY) args.push("--ff-only");
  return [...args, "side"];
}

async function oursMerge(dir: string, options: MergeOptions = {}) {
  const ours = await openOurs(dir);
  const command = ours.merge().include("side").setAuthor(INTEROP_IDENT).setCommitter(INTEROP_IDENT);
  if (options.noCommit) command.setCommit(false);
  if (options.squash) command.setSquash(true);
  if (options.ff) command.setFastForwardMode(options.ff);
  return command.call();
}

/** Merges side into main in both twins and compares everything. */
async function compareMerge(history: History, options: MergeOptions = {}) {
  const { native, ours } = twins(history);
  const expected = git(root, native, ...nativeArgs(options));
  const result = await oursMerge(ours, options);
  expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
  if (result.status === MergeStatus.FAILED) {
    expect(expected.status).not.toBe(0);
    expect(result.message).toBe(expected.stderr.trim());
  } else {
    expect(result.output?.filter((l) => ortLines(l).length > 0)).toEqual(ortLines(expected.stdout));
  }
  return { native, ours, expected, result };
}

describeGit("merge writes the worktree as native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-worktree-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("a clean merge of edits to different lines writes the merged file and commits", async () => {
    const { result } = await compareMerge({
      base: { "a.txt": text(), "b.txt": "b\n" },
      main: { "a.txt": text({ 2: "main" }) },
      side: { "a.txt": text({ 8: "side" }), "new.txt": "new\n" },
    });
    expect(result.status).toBe(MergeStatus.MERGED);
  });

  it("a fast-forward writes the target's files and keeps unrelated local edits", async () => {
    const { result } = await compareMerge({
      base: { "a.txt": text(), "keep.txt": "k\n" },
      side: { "a.txt": text({ 1: "side" }), "d/new.txt": "n\n", "gone.txt": null },
      dirty: { "keep.txt": "dirty\n" },
    });
    expect(result.status).toBe(MergeStatus.FAST_FORWARD);
    expect(result.output?.[1]).toBe("Fast-forward");
  });

  it("a content conflict leaves markers, stages 1-3 and git's state files", async () => {
    const { result } = await compareMerge({
      base: { "a.txt": text(), "b.txt": "b\n" },
      main: { "a.txt": text({ 5: "main" }), "b.txt": "b main\n" },
      side: { "a.txt": text({ 5: "side" }) },
    });
    expect(result.status).toBe(MergeStatus.CONFLICTING);
    expect(result.conflicts).toEqual(["a.txt"]);
  });

  it("diff3 and zdiff3 conflict styles", async () => {
    for (const style of ["diff3", "zdiff3"]) {
      await compareMerge({
        config: { "merge.conflictStyle": style },
        base: { "a.txt": text() },
        main: { "a.txt": text({ 4: "same", 5: "main", 6: "same2" }) },
        side: { "a.txt": text({ 4: "same", 5: "side", 6: "same2" }) },
      });
    }
  });

  it("conflicts refined as git's zealous merge: shared lines leave the conflict", async () => {
    await compareMerge({
      base: { "a.txt": text() },
      main: { "a.txt": text({ 2: "x", 3: "common", 4: "m4", 9: "m9" }) },
      side: { "a.txt": text({ 2: "y", 3: "common", 4: "s4", 9: "s9" }) },
    });
  });

  it("modify/delete, binary, add/add and rename conflicts", async () => {
    await compareMerge({
      base: {
        "md.txt": "md\n",
        "dm.txt": "dm\n",
        "bin.dat": new Uint8Array([1, 0, 2]),
        "ren.txt": text(),
        "rd.txt": text({ 1: "rd" }),
        "rr.txt": text({ 1: "rr" }),
      },
      main: {
        "md.txt": "md main\n",
        "dm.txt": null,
        "bin.dat": new Uint8Array([1, 0, 3]),
        "ren.txt": null,
        "ren2.txt": text({ 2: "main" }),
        "aa.txt": "main\n",
        "rd.txt": null,
        "rd2.txt": text({ 1: "rd" }),
        "rr.txt": null,
        "rr-main.txt": text({ 1: "rr" }),
      },
      side: {
        "md.txt": null,
        "dm.txt": "dm side\n",
        "bin.dat": new Uint8Array([1, 0, 4]),
        "ren.txt": text({ 9: "side" }),
        "aa.txt": "side\n",
        "rd.txt": null,
        "rr.txt": null,
        "rr-side.txt": text({ 1: "rr" }),
      },
    });
  });

  it("a renamed file both sides edited conflicts with git's path labels", async () => {
    await compareMerge({
      config: { "merge.conflictStyle": "diff3" },
      base: { "ren.txt": text() },
      main: { "ren.txt": null, "moved.txt": text({ 10: "main" }) },
      side: { "ren.txt": text({ 10: "side" }) },
    });
  });

  it("file/directory and distinct types conflicts place files as git", async () => {
    await compareMerge({
      base: { keep: "k\n", "f.txt": "f\n" },
      main: { d: "file\n", "f.txt": "f main\n" },
      side: { "d/x": "x\n", "f.txt": { link: "target" } },
    });
    await compareMerge({
      base: { keep: "k\n" },
      main: { "d/x": "x\n" },
      side: { d: "file\n" },
    });
  });

  it("modes: an executable bit merges with a content change", async () => {
    await compareMerge({
      base: { "s.sh": text() },
      main: { "s.sh": { exec: text() } },
      side: { "s.sh": text({ 3: "side" }) },
    });
  });

  it("refuses a merge over a local change, listing the file as git", async () => {
    const { result } = await compareMerge({
      base: { "a.txt": text() },
      main: { "a.txt": text({ 1: "main" }) },
      side: { "a.txt": text({ 9: "side" }) },
      dirty: { "a.txt": "dirty\n" },
    });
    expect(result.status).toBe(MergeStatus.FAILED);
  });

  it("refuses a merge over staged changes (merge-ort's index check)", async () => {
    const { result } = await compareMerge({
      base: { "a.txt": text(), "b.txt": "b\n" },
      main: { "a.txt": text({ 1: "main" }) },
      side: { "a.txt": text({ 9: "side" }) },
      dirty: { "b.txt": "staged\n", "c.txt": "new\n" },
      stage: ["b.txt", "c.txt"],
    });
    expect(result.message).toContain("  b.txt c.txt\nMerge with strategy ort failed.");
  });

  it("refuses a merge or fast-forward over untracked files in the way", async () => {
    await compareMerge({
      base: { "a.txt": text() },
      main: { "a.txt": text({ 1: "main" }) },
      side: { "new.txt": "side\n" },
      dirty: { "new.txt": "untracked\n" },
    });
    await compareMerge({
      base: { "a.txt": text() },
      side: { "new.txt": "side\n", "a.txt": text({ 2: "s" }) },
      dirty: { "new.txt": "untracked\n", "a.txt": "dirty\n" },
    });
  });

  it("--no-commit, --squash, --no-ff and --ff-only", async () => {
    const history: History = {
      base: { "a.txt": text() },
      main: { "a.txt": text({ 1: "main" }) },
      side: { "a.txt": text({ 9: "side" }) },
    };
    expect((await compareMerge(history, { noCommit: true })).result.status).toBe(
      MergeStatus.MERGED_NOT_COMMITTED,
    );
    expect((await compareMerge(history, { squash: true })).result.status).toBe(
      MergeStatus.MERGED_SQUASHED,
    );
    await compareMerge(
      {
        base: { "a.txt": text() },
        main: { "a.txt": text({ 1: "main" }) },
        side: { "a.txt": text({ 1: "side" }) },
      },
      { squash: true },
    );
    const ff: History = { base: { "a.txt": text() }, side: { "a.txt": text({ 9: "side" }) } };
    // main's own commit is empty: side is a fast-forward of it only when main has none
    await compareMerge({ ...ff, main: undefined }, { squash: true });
    await compareMerge({ ...ff, main: undefined }, { ff: FastForwardMode.NO_FF });
    await compareMerge({ ...ff, main: undefined }, { noCommit: true, ff: FastForwardMode.NO_FF });
  });

  it("files are written through the attributes (eol=crlf) of the merged index", async () => {
    await compareMerge({
      base: { ".gitattributes": "*.txt text eol=crlf\n", "a.txt": text() },
      main: { "a.txt": text({ 1: "main" }) },
      side: { "a.txt": text({ 9: "side" }), "b.txt": "b\n" },
    });
    await compareMerge({
      base: { ".gitattributes": "*.txt text eol=crlf\n", "a.txt": text() },
      main: { "a.txt": text({ 5: "main" }) },
      side: { "a.txt": text({ 5: "side" }) },
    });
  });

  it("merge.autoStash stashes local changes around the merge", async () => {
    const { result } = await compareMerge({
      config: { "merge.autoStash": "true" },
      base: { "a.txt": text(), "b.txt": "b\n" },
      main: { "a.txt": text({ 1: "main" }) },
      side: { "a.txt": text({ 9: "side" }) },
      dirty: { "a.txt": text({ 1: "main", 5: "dirty" }) },
    });
    expect(result.status).toBe(MergeStatus.MERGED);
    expect(result.output?.at(-1)).toBe("Applied autostash.");
    // a merge that stops keeps the stash (MERGE_AUTOSTASH) until it is aborted
    const { native, ours } = twins({
      config: { "merge.autoStash": "true" },
      base: { "a.txt": text(), "b.txt": "b\n" },
      main: { "a.txt": text({ 5: "main" }) },
      side: { "a.txt": text({ 5: "side" }) },
      dirty: { "b.txt": "dirty\n" },
    });
    git(root, native, "merge", "side");
    await oursMerge(ours);
    expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
    expect(git(root, ours, "merge", "--abort").status).toBe(0);
    await (await openOurs(native)).merge().setOperation(MergeOperation.ABORT).call();
    expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
  });

  it("refuses while a merge is in progress or the index has unmerged entries", async () => {
    const history: History = {
      base: { "a.txt": text() },
      main: { "a.txt": text({ 5: "main" }) },
      side: { "a.txt": text({ 5: "side" }) },
    };
    const { native, ours } = twins(history);
    git(root, native, "merge", "side");
    await oursMerge(ours);
    const expected = git(root, native, "merge", "side");
    const result = await oursMerge(ours);
    expect(result.status).toBe(MergeStatus.FAILED);
    expect(result.message).toBe(expected.stderr.trim());
    git(root, native, "add", "a.txt");
    git(root, ours, "add", "a.txt");
    const again = git(root, native, "merge", "side");
    const ourAgain = await oursMerge(ours);
    expect(ourAgain.message).toBe(again.stderr.trim());
  });

  describe("interop: continue and abort across implementations", () => {
    const conflicting: History = {
      base: { "a.txt": text(), "b.txt": "b\n" },
      main: { "a.txt": text({ 5: "main" }) },
      side: { "a.txt": text({ 5: "side" }), "b.txt": "b side\n", "c.txt": "c\n" },
      dirty: { "untouched.txt": "untracked\n" },
    };

    it("native git aborts our merge, and we abort native git's", async () => {
      const { native, ours } = twins(conflicting);
      // ours merges, native aborts it
      await oursMerge(ours);
      git(root, native, "merge", "side");
      expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
      const nativeAbort = git(root, ours, "merge", "--abort");
      expect(nativeAbort.status).toBe(0);
      // native merges in its twin, ours aborts it
      const result = await (await openOurs(native))
        .merge()
        .setOperation(MergeOperation.ABORT)
        .call();
      expect(result.status).toBe(MergeStatus.ABORTED);
      expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
    });

    it("native git continues our merge, and we continue native git's", async () => {
      const { native, ours } = twins(conflicting);
      await oursMerge(ours);
      git(root, native, "merge", "side");
      for (const dir of [native, ours]) {
        put(dir, "a.txt", "resolved\n");
        git(root, dir, "add", "a.txt");
      }
      // native continues ours; ours continues native's: the same merge commit
      expect(git(root, ours, "merge", "--continue").status).toBe(0);
      const result = await (await openOurs(native))
        .merge()
        .setOperation(MergeOperation.CONTINUE)
        .setAuthor(INTEROP_IDENT)
        .setCommitter(INTEROP_IDENT)
        .call();
      expect(result.status).toBe(MergeStatus.MERGED);
      expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
    });

    it("continue with unmerged files is refused as git refuses it", async () => {
      const { native, ours } = twins(conflicting);
      await oursMerge(ours);
      git(root, native, "merge", "side");
      const expected = git(root, native, "merge", "--continue");
      const result = await (await openOurs(ours))
        .merge()
        .setOperation(MergeOperation.CONTINUE)
        .call();
      expect(result.status).toBe(MergeStatus.FAILED);
      expect(result.message).toBe(expected.stderr.trim());
      const noMerge = git(root, native, "merge", "--abort");
      expect(noMerge.status).toBe(0);
      const expectedNone = git(root, native, "merge", "--abort");
      const none = await (await openOurs(native)).merge().setOperation(MergeOperation.ABORT).call();
      expect(none.message).toBe(expectedNone.stderr.trim());
    });
  });
});
