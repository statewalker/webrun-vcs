/**
 * Merges with several merge bases against native `git merge`: criss-cross histories built
 * twice (`buildGraph`), native git merging in one twin and ours in the other, then output,
 * status, index, every worktree file and the state files (AUTO_MERGE names the result tree,
 * so the trees must be the same) compared. The virtual merge base git builds from the bases
 * (their own conflicts with "Temporary merge branch" markers) must be the same as ours.
 *
 * A seeded fuzz builds random criss-crosses (`VBASE_FUZZ_SEEDS=<n>`, default 30;
 * `VBASE_FUZZ_SEED=<seed>` replays one).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MergeStatus } from "../src/index.js";
import {
  git,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  ortLines,
  snapshot,
} from "./merge-native-helpers.js";
import { buildGraph, type Files, type Graph, text } from "./merge-native-scenarios.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

function twins(graph: Graph): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  buildGraph(root, native, graph);
  buildGraph(root, ours, graph);
  return { native, ours };
}

/** Merges `side` into main in both twins; the differences found (none: the same). */
async function compareMerge(graph: Graph, branch = "side"): Promise<string[]> {
  const { native, ours } = twins(graph);
  const expected = git(root, native, "merge", branch);
  const result = await (await openOurs(ours))
    .merge()
    .include(branch)
    .setAuthor(INTEROP_IDENT)
    .setCommitter(INTEROP_IDENT)
    .call();
  const diffs: string[] = [];
  const a = snapshot(root, ours, normalizeState);
  const b = snapshot(root, native, normalizeState);
  for (const key of ["head", "status", "index", "files", "state"] as const) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      diffs.push(`${key}: ours ${JSON.stringify(a[key])}\nnative ${JSON.stringify(b[key])}`);
    }
  }
  if (result.status === MergeStatus.FAILED) {
    if (result.message !== expected.stderr.trim()) {
      diffs.push(`refusal: ${result.message} vs ${expected.stderr}`);
    }
  } else {
    const lines = (result.output ?? []).filter((l) => ortLines(l).length > 0);
    if (JSON.stringify(lines) !== JSON.stringify(ortLines(expected.stdout))) {
      diffs.push(`output: ${JSON.stringify(lines)} vs ${JSON.stringify(expected.stdout)}`);
    }
  }
  rmSync(native, { recursive: true, force: true });
  rmSync(ours, { recursive: true, force: true });
  return diffs;
}

/**
 * The classic criss-cross: side and main change the same file, each merges the other
 * (keeping its own version), then both change it again.
 */
function crissCross(options: {
  base: Files;
  m1: Files;
  s1: Files;
  m2?: Files;
  s2?: Files;
  config?: Record<string, string>;
}): Graph {
  return {
    base: options.base,
    config: options.config,
    steps: [
      { branch: "side", files: options.s1, message: "s1" },
      { branch: "m1", from: "main", files: options.m1, message: "m1" },
      { branch: "main", merge: "m1", files: options.m1, message: "main takes m1" },
      { branch: "main", merge: "side", message: "main merges side" },
      { branch: "side", merge: "m1", message: "side merges m1" },
      { branch: "side", files: options.s2 ?? {}, message: "s2" },
      { branch: "main", files: options.m2 ?? {}, message: "m2" },
    ],
  };
}

describeGit("merge with several merge bases against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-vbase-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("conflicting bases: the virtual base holds Temporary merge branch markers (diff3)", async () => {
    const graph = crissCross({
      base: { f: text() },
      s1: { f: text({ 2: "S" }) },
      m1: { f: text({ 2: "M" }) },
      s2: { f: text({ 2: "T", 10: "side" }) },
      m2: { f: text({ 1: "main", 2: "U" }) },
      config: { "merge.conflictStyle": "diff3" },
    });
    expect(await compareMerge(graph)).toEqual([]);
  });

  it("conflicting bases, zdiff3 and merge styles", async () => {
    for (const style of ["zdiff3", "merge"]) {
      const graph = crissCross({
        base: { f: text(), g: text() },
        s1: { f: text({ 3: "S" }), g: text({ 9: "s" }) },
        m1: { f: text({ 3: "M" }), g: text({ 1: "m" }) },
        s2: { f: text({ 3: "T" }) },
        m2: { f: text({ 3: "U" }) },
        config: { "merge.conflictStyle": style },
      });
      expect(await compareMerge(graph)).toEqual([]);
    }
  });

  it("bases that merge cleanly: the merge is clean", async () => {
    const graph = crissCross({
      base: { f: text(), g: text() },
      s1: { f: text({ 2: "S" }) },
      m1: { g: text({ 2: "M" }) },
      s2: { f: text({ 2: "S", 9: "s2" }) },
      m2: { g: text({ 2: "M", 9: "m2" }) },
    });
    expect(await compareMerge(graph)).toEqual([]);
  });

  it("a modify/delete between the bases: the virtual base keeps the base's version", async () => {
    const graph = crissCross({
      base: { f: text(), keep: "k\n" },
      s1: { f: null },
      m1: { f: text({ 5: "M" }) },
      s2: { keep: "side\n" },
      m2: { f: text({ 5: "M", 6: "again" }) },
    });
    expect(await compareMerge(graph)).toEqual([]);
  });

  it("binary files and links changed in both bases", async () => {
    const graph = crissCross({
      base: { b: new Uint8Array([0, 1, 2]), l: { link: "a" }, t: text() },
      s1: { b: new Uint8Array([0, 1, 3]), l: { link: "b" } },
      m1: { b: new Uint8Array([0, 1, 4]), l: { link: "c" } },
      s2: { t: text({ 1: "s" }) },
      m2: { t: text({ 10: "m" }) },
    });
    expect(await compareMerge(graph)).toEqual([]);
  });

  it("a rename in one base, an edit in the other", async () => {
    const graph = crissCross({
      base: { "a.txt": text(), other: "o\n" },
      s1: { "a.txt": null, "b.txt": text() },
      m1: { "a.txt": text({ 4: "M" }) },
      s2: { other: "side\n" },
      m2: { other: "main\n" },
    });
    expect(await compareMerge(graph)).toEqual([]);
  });

  it("an add/add between the bases", async () => {
    const graph = crissCross({
      base: { keep: "k\n" },
      s1: { n: text({ 1: "S" }) },
      m1: { n: text({ 1: "M" }) },
      s2: { n: text({ 1: "S", 8: "x" }) },
      m2: { n: text({ 1: "M", 3: "y" }) },
    });
    expect(await compareMerge(graph)).toEqual([]);
  });

  it("three merge bases: merged pairwise, their own bases merged first", async () => {
    const graph: Graph = {
      base: { f: text(), g: text() },
      config: { "merge.conflictStyle": "diff3" },
      steps: [
        { branch: "a", files: { f: text({ 1: "A" }) } },
        { branch: "b", from: "main", files: { f: text({ 1: "B" }) } },
        { branch: "c", from: "main", files: { f: text({ 1: "C" }), g: text({ 5: "c" }) } },
        { branch: "side", from: "main", merge: "a" },
        { branch: "side", merge: "b" },
        { branch: "side", merge: "c", files: { f: text({ 1: "S" }) } },
        { branch: "main", merge: "a" },
        { branch: "main", merge: "b" },
        { branch: "main", merge: "c", files: { f: text({ 1: "Mn" }) } },
      ],
    };
    expect(await compareMerge(graph)).toEqual([]);
  });

  it("a criss-cross of criss-crosses (the bases have several bases themselves)", async () => {
    const graph: Graph = {
      base: { f: text() },
      config: { "merge.conflictStyle": "diff3" },
      steps: [
        { branch: "x", files: { f: text({ 2: "x" }) } },
        { branch: "y", from: "main", files: { f: text({ 2: "y" }) } },
        { branch: "p", from: "x", merge: "y", files: { f: text({ 2: "p" }) } },
        { branch: "q", from: "y", merge: "x", files: { f: text({ 2: "q" }) } },
        { branch: "side", from: "p", merge: "q", files: { f: text({ 2: "s", 9: "s" }) } },
        { branch: "main", merge: "q" },
        { branch: "main", merge: "p", files: { f: text({ 2: "m", 1: "m" }) } },
      ],
    };
    expect(await compareMerge(graph)).toEqual([]);
  });

  const fuzzCount = Number(process.env.VBASE_FUZZ_SEEDS ?? 30);
  const only = process.env.VBASE_FUZZ_SEED ? [Number(process.env.VBASE_FUZZ_SEED)] : undefined;

  it("random criss-cross histories merge as native git merges them", async () => {
    const failures: string[] = [];
    for (const seed of only ?? Array.from({ length: fuzzCount }, (_, i) => 7000 + i)) {
      const diffs = await compareMerge(randomCrissCross(seed));
      if (diffs.length > 0) failures.push(`seed ${seed}: ${diffs.join("\n")}`);
    }
    expect(failures).toEqual([]);
  }, 600_000);
});

/** mulberry32. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  };
}

const PATHS = ["a", "b", "d/c", "d/e", "f"];

/** A random criss-cross (sometimes with a third base, renames, deletions, binary files). */
function randomCrissCross(seed: number): Graph {
  const rng = prng(seed);
  const state = new Map<string, Record<number, string>>();
  const base: Files = {};
  for (const p of PATHS) {
    if (rng.chance(0.7)) {
      state.set(p, {});
      base[p] = text();
    }
  }
  if (state.size === 0) {
    state.set("a", {});
    base.a = text();
  }
  const edit = (tag: string): Files => {
    const files: Files = {};
    for (let k = 0; k < 1 + rng.int(3); k++) {
      const p = rng.pick(PATHS);
      const op = rng.int(10);
      if (op < 6) {
        const line = 1 + rng.int(10);
        const lines: Record<number, string> = { [line]: `${tag}${rng.int(3)}` };
        if (rng.chance(0.3)) lines[10] = tag;
        files[p] = text(lines);
      } else if (op === 6) files[p] = null;
      else if (op === 7) files[p] = new Uint8Array([0, rng.int(4)]);
      else if (op === 8) {
        // a rename (the source goes), to a name the other branches may pick as well
        files[p] = null;
        files[rng.chance(0.5) ? `${p}.moved` : `${p}.${tag}`] = text({ 1: tag });
      } else files[p] = { exec: text({ 3: tag }) };
    }
    return files;
  };
  const style = rng.pick([undefined, "diff3", "zdiff3"]);
  const steps = [
    { branch: "side", files: edit("s") },
    { branch: "m1", from: "main", files: edit("m") },
    { branch: "main", merge: "m1", files: edit("x") },
    { branch: "main", merge: "side", files: rng.chance(0.5) ? edit("y") : {} },
    { branch: "side", merge: "m1", files: rng.chance(0.5) ? edit("z") : {} },
  ];
  if (rng.chance(0.3)) {
    steps.push({ branch: "c", from: "main~2", files: edit("c") } as (typeof steps)[number]);
    steps.push({ branch: "main", merge: "c" } as (typeof steps)[number]);
    steps.push({ branch: "side", merge: "c", files: edit("w") });
  }
  steps.push({ branch: "side", files: edit("t") });
  steps.push({ branch: "main", files: edit("u") });
  return {
    base,
    steps,
    ...(style ? { config: { "merge.conflictStyle": style } } : {}),
  };
}
