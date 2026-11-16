/**
 * Octopus merges (`git merge a b c`) against native git: histories built twice
 * (`buildGraph`), native git merging in one twin and ours in the other, then the octopus
 * script's messages, status, index, every worktree file and the state files compared
 * (MERGE_HEAD with a line per head, MERGE_MODE `no-ff`). The conflict markers of a file
 * git-merge-one-file leaves are labelled with git's random temporary file names
 * (`.merge_file_XXXXXX`), evened out before comparing.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FastForwardMode, MergeOperation, MergeStatus } from "../src/index.js";
import {
  git,
  gitOk,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  put,
  type Snapshot,
  snapshot,
} from "./merge-native-helpers.js";
import { buildGraph, type Graph, text } from "./merge-native-scenarios.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

const OCTOPUS_LINE =
  /^(Trying simple merge|Simple merge did not work|Auto-merging|Added .* in both|Adding |Removing |Fast-forwarding to|Already up to date|Automated merge did not work|Should not be doing|Automatic merge failed|Merge made by|Error: Your local changes| {4})/;

/** git's temporary file names in markers, evened out. */
function evenOut(s: Snapshot): Snapshot {
  const files: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.files))
    files[k] = v.replace(/\.merge_file_\w{6}/g, ".merge_file_X");
  return { ...s, files };
}

interface Options {
  noCommit?: boolean;
  prepare?: (dir: string) => void;
  branch?: string;
}

async function compareOctopus(graph: Graph, heads: string[], options: Options = {}) {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  for (const dir of [native, ours]) {
    buildGraph(root, dir, graph);
    if (options.branch) gitOk(root, dir, "checkout", "-q", options.branch);
    options.prepare?.(dir);
  }
  const expected = git(
    root,
    native,
    "merge",
    ...(options.noCommit ? ["--no-commit"] : []),
    ...heads,
  );
  const command = (await openOurs(ours))
    .merge()
    .setAuthor(INTEROP_IDENT)
    .setCommitter(INTEROP_IDENT);
  for (const h of heads) command.include(h);
  if (options.noCommit) command.setCommit(false);
  const result = await command.call();
  expect(evenOut(snapshot(root, ours, normalizeState))).toEqual(
    evenOut(snapshot(root, native, normalizeState)),
  );
  const lines = (text: string) => text.split("\n").filter((l) => OCTOPUS_LINE.test(l));
  expect((result.output ?? []).filter((l) => OCTOPUS_LINE.test(l))).toEqual(lines(expected.stdout));
  if (result.status === MergeStatus.FAILED) {
    expect(result.message?.split("\n").pop()).toBe(expected.stderr.trim().split("\n").pop());
  }
  rmSync(native, { recursive: true, force: true });
  rmSync(ours, { recursive: true, force: true });
  return { result, expected };
}

/** main, and branches a, b, c off it with their changes; main's own change on top. */
function branches(
  changes: Record<string, Record<string, string | null>>,
  main?: Record<string, string | null>,
): Graph {
  return {
    base: { f: text(), g: text(), h: text() },
    steps: [
      ...Object.entries(changes).map(([branch, files]) => ({ branch, from: "main", files })),
      ...(main ? [{ branch: "main", files: main }] : []),
    ],
  };
}

describeGit("octopus merges against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-octopus-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("three branches with separate changes: one commit with four parents", async () => {
    const graph = branches(
      { a: { f: text({ 1: "a" }) }, b: { g: text({ 2: "b" }), n: "new\n" }, c: { h: null } },
      { f: text({ 9: "main" }) },
    );
    const { result } = await compareOctopus(graph, ["a", "b", "c"]);
    expect(result.status).toBe(MergeStatus.MERGED);
  });

  it("--no-commit stops with MERGE_HEAD listing every head", async () => {
    const graph = branches(
      { a: { f: text({ 1: "a" }) }, b: { g: text({ 2: "b" }) } },
      { h: text({ 5: "m" }) },
    );
    await compareOctopus(graph, ["a", "b"], { noCommit: true });
  });

  it("edits of one file merged file by file (git-merge-one-file)", async () => {
    const graph = branches(
      { a: { f: text({ 1: "a" }) }, b: { f: text({ 9: "b" }) } },
      { f: text({ 5: "main" }) },
    );
    await compareOctopus(graph, ["a", "b"]);
  });

  it("a conflict with the last head is left to resolve", async () => {
    const graph = branches(
      { a: { g: text({ 1: "a" }) }, b: { f: text({ 3: "b" }), n: "b\n" } },
      { f: text({ 3: "main" }), n: "main\n" },
    );
    const { result } = await compareOctopus(graph, ["a", "b"]);
    expect(result.status).toBe(MergeStatus.CONFLICTING);
  });

  it("a conflict with an earlier head: the octopus gives up", async () => {
    const graph = branches(
      { a: { f: text({ 3: "a" }) }, b: { g: text({ 2: "b" }) } },
      { f: text({ 3: "main" }) },
    );
    const { result } = await compareOctopus(graph, ["a", "b"]);
    expect(result.status).toBe(MergeStatus.FAILED);
  });

  it("the first head a fast-forward, the others merged on top", async () => {
    const graph = branches({ a: { f: text({ 1: "a" }) }, b: { g: text({ 2: "b" }) } });
    await compareOctopus(graph, ["a", "b"]);
  });

  it("a head already merged by another drops out", async () => {
    const graph: Graph = {
      base: { f: text(), g: text() },
      steps: [
        { branch: "a", files: { f: text({ 1: "a" }) } },
        { branch: "b", from: "a", files: { g: text({ 2: "b" }) } },
        { branch: "c", from: "main", files: { f: text({ 9: "c" }) } },
        { branch: "main", files: { g: text({ 9: "m" }) } },
      ],
    };
    await compareOctopus(graph, ["a", "b", "c"]);
  });

  it("additions: the same file alike, and differently", async () => {
    const graph = branches(
      { a: { same: "s\n", x: "a\n" }, b: { same: "s\n" }, c: { x: "c\n" } },
      { h: text({ 4: "m" }) },
    );
    await compareOctopus(graph, ["a", "b", "c"]);
  });

  it("staged changes: refused before anything is written", async () => {
    const graph = branches(
      { a: { f: text({ 1: "a" }) }, b: { g: text({ 2: "b" }) } },
      { h: "m\n" },
    );
    await compareOctopus(graph, ["a", "b"], {
      prepare: (dir) => {
        put(dir, "h", "staged\n");
        gitOk(root, dir, "add", "h");
      },
    });
  });

  it("on another branch: the message says into which", async () => {
    const graph: Graph = {
      ...branches({ a: { f: text({ 1: "a" }) }, b: { g: text({ 2: "b" }) } }),
      steps: [
        { branch: "a", from: "main", files: { f: text({ 1: "a" }) } },
        { branch: "b", from: "main", files: { g: text({ 2: "b" }) } },
        { branch: "topic", from: "main", files: { h: text({ 3: "t" }) } },
      ],
    };
    await compareOctopus(graph, ["a", "b"], { branch: "topic" });
  });

  it("a resolved octopus is committed with every head as a parent", async () => {
    const graph = branches(
      { a: { g: text({ 1: "a" }) }, b: { f: text({ 3: "b" }) } },
      { f: text({ 3: "main" }) },
    );
    const n = counter++;
    const native = join(root, `native-${n}`);
    const ours = join(root, `ours-${n}`);
    for (const dir of [native, ours]) {
      buildGraph(root, dir, graph);
      git(root, dir, "merge", "a", "b");
      put(dir, "f", "resolved\n");
      gitOk(root, dir, "add", "f");
    }
    git(root, native, "merge", "--continue");
    const result = await (await openOurs(ours))
      .merge()
      .setOperation(MergeOperation.CONTINUE)
      .setAuthor(INTEROP_IDENT)
      .setCommitter(INTEROP_IDENT)
      .call();
    expect(result.status).toBe(MergeStatus.MERGED);
    expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
  });

  it("--ff-only is refused", async () => {
    const graph = branches(
      { a: { f: text({ 1: "a" }) }, b: { g: text({ 2: "b" }) } },
      { h: "m\n" },
    );
    const dir = join(root, "ffonly");
    buildGraph(root, dir, graph);
    const command = (await openOurs(dir))
      .merge()
      .include("a")
      .include("b")
      .setFastForwardMode(FastForwardMode.FF_ONLY);
    await expect(command.call()).rejects.toThrow("Not possible to fast-forward");
    expect(git(root, dir, "merge", "--ff-only", "a", "b").stderr).toContain(
      "Not possible to fast-forward",
    );
  });
});
