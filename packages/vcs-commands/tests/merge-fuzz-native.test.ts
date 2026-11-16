/**
 * A seeded differential fuzz of `merge` and `cherry-pick` against native git: random
 * histories (line edits, renames, deletes, binary files, executable bits, links, file and
 * directory swaps, `.gitattributes` eol, dirty worktrees and indexes) built twice; native
 * git merges (or cherry-picks) in one twin and ours in the other, then the refusal, the
 * merge-ort lines, status, index, every worktree file and the state files are compared.
 *
 * `MERGE_FUZZ_SEEDS=<n>` runs more seeds (default 40 per operation); a failure names the
 * seed, and `MERGE_FUZZ_SEED=<seed>` replays one.
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
  type Snapshot,
  snapshot,
} from "./merge-native-helpers.js";
import { buildHistory, type FileSpec, type Files, type History } from "./merge-native-scenarios.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** mulberry32: a small seeded PRNG. */
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
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof prng>;

const WORDS = ["alpha", "beta", "gamma", "delta", "eps", "zeta", "eta", "theta"];
const TEXT_PATHS = ["a.txt", "b.txt", "d/x.txt", "d/y.txt", "e/z.txt", "f.md"];
const NEW_PATHS = ["n.txt", "d/n.txt", "g/h.txt", "a2.txt", "e/moved.txt", "d"];

function randomText(rng: Rng): string[] {
  return Array.from({ length: 4 + rng.int(8) }, (_, i) => `${rng.pick(WORDS)} ${i}`);
}

const asText = (lines: string[]) => lines.map((l) => `${l}\n`).join("");

/** A random edit of the lines: replace, insert or delete one or two of them. */
function editLines(rng: Rng, lines: string[]): string[] {
  const out = [...lines];
  for (let k = 0; k < 1 + rng.int(2); k++) {
    const at = rng.int(out.length + 1);
    const op = rng.int(3);
    if (op === 0 && at < out.length) out[at] = `${rng.pick(WORDS)} edited`;
    else if (op === 1) out.splice(at, 0, `${rng.pick(WORDS)} new`);
    else if (out.length > 2 && at < out.length) out.splice(at, 1);
  }
  return out;
}

interface Tree {
  text: Map<string, string[]>;
  other: Map<string, FileSpec>;
}

function cloneTree(t: Tree): Tree {
  return { text: new Map(t.text), other: new Map(t.other) };
}

function toFiles(t: Tree): Files {
  const files: Files = {};
  for (const [p, lines] of t.text) files[p] = asText(lines);
  for (const [p, spec] of t.other) files[p] = spec;
  return files;
}

/** What changes from `before` to `after`, as the build applies it. */
function diffFiles(before: Tree, after: Tree): Files {
  const a = toFiles(before);
  const b = toFiles(after);
  const out: Files = {};
  for (const p of Object.keys(a)) if (!(p in b)) out[p] = null;
  for (const [p, spec] of Object.entries(b)) {
    if (JSON.stringify(a[p] ?? null) !== JSON.stringify(spec)) out[p] = spec;
  }
  // a file replacing a directory: the directory's files go first
  return out;
}

function hasPrefixConflict(t: Tree, path: string): boolean {
  const all = [...t.text.keys(), ...t.other.keys()];
  return all.some((p) => p.startsWith(`${path}/`) || path.startsWith(`${p}/`));
}

/** One side's random changes. */
function mutate(rng: Rng, base: Tree): Tree {
  const t = cloneTree(base);
  for (let k = 0; k < 1 + rng.int(3); k++) {
    const op = rng.int(10);
    const texts = [...t.text.keys()];
    if (op <= 3 && texts.length > 0) {
      const p = rng.pick(texts);
      t.text.set(p, editLines(rng, t.text.get(p) as string[]));
    } else if (op === 4 && texts.length > 1) {
      t.text.delete(rng.pick(texts));
    } else if (op === 5 && texts.length > 0) {
      // rename, maybe with an edit
      const from = rng.pick(texts);
      const to = rng.pick(NEW_PATHS);
      if (t.text.has(to) || t.other.has(to) || hasPrefixConflict(t, to)) continue;
      // never the last file out of a directory: git would see a directory rename, which
      // merge-ort follows and ours does not
      const dir = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
      const all = [...t.text.keys(), ...t.other.keys()];
      if (dir && !all.some((p) => p !== from && p.startsWith(dir))) continue;
      const lines = t.text.get(from) as string[];
      t.text.delete(from);
      t.text.set(to, rng.chance(0.5) ? editLines(rng, lines) : lines);
    } else if (op === 6) {
      const to = rng.pick(NEW_PATHS);
      if (t.text.has(to) || t.other.has(to) || hasPrefixConflict(t, to)) continue;
      t.text.set(to, randomText(rng));
    } else if (op === 7) {
      t.other.set("bin.dat", new Uint8Array([0, 1, rng.int(256), rng.int(256)]));
    } else if (op === 8 && texts.length > 0) {
      const p = rng.pick(texts);
      t.text.delete(p);
      t.other.set(p, { exec: asText(base.text.get(p) ?? randomText(rng)) });
    } else {
      // a file and a directory swap places
      if (t.text.has("d/x.txt") || t.text.has("d/y.txt")) {
        for (const p of [...t.text.keys()]) if (p.startsWith("d/")) t.text.delete(p);
        for (const p of [...t.other.keys()]) if (p.startsWith("d/")) t.other.delete(p);
        t.text.set("d", randomText(rng));
      } else if (rng.chance(0.5)) {
        t.other.set("l", { link: rng.pick(["a.txt", "b.txt", "nowhere"]) });
      }
    }
  }
  return t;
}

/** A random history for one seed. */
function randomHistory(seed: number): History {
  const rng = prng(seed);
  const base: Tree = { text: new Map(), other: new Map() };
  for (const p of TEXT_PATHS) if (rng.chance(0.6)) base.text.set(p, randomText(rng));
  if (base.text.size === 0) base.text.set("a.txt", randomText(rng));
  if (rng.chance(0.3)) base.other.set("bin.dat", new Uint8Array([0, 1, 2, 3]));
  const config: Record<string, string> = {};
  if (rng.chance(0.2)) base.other.set(".gitattributes", "*.txt text eol=crlf\n");
  if (rng.chance(0.2)) config["merge.conflictStyle"] = rng.pick(["diff3", "zdiff3"]);
  const main = mutate(rng, base);
  const side = mutate(rng, base);
  const history: History = {
    base: toFiles(base),
    main: diffFiles(base, main),
    side: diffFiles(base, side),
    config,
  };
  // a dirty worktree (or index) now and then
  const dirtyKind = rng.int(6);
  const mainTexts = [...main.text.keys()];
  if (dirtyKind === 0 && mainTexts.length > 0) {
    history.dirty = { [rng.pick(mainTexts)]: "dirty\n" };
  } else if (dirtyKind === 1) {
    // an untracked file where side adds one (never under a file main has)
    const added = Object.keys(history.side ?? {}).filter(
      (p) =>
        history.side?.[p] !== null &&
        !main.text.has(p) &&
        !main.other.has(p) &&
        !hasPrefixConflict(main, p),
    );
    if (added.length > 0) history.dirty = { [rng.pick(added)]: "untracked\n" };
  } else if (dirtyKind === 2 && mainTexts.length > 0) {
    const p = rng.pick(mainTexts);
    history.dirty = { [p]: "staged\n" };
    history.stage = [p];
  }
  return history;
}

let root: string;
let counter = 0;

function twins(history: History) {
  const n = counter++;
  if (process.env.MERGE_FUZZ_DEBUG) console.log(JSON.stringify(history));
  const native = join(root, `n${n}`);
  const ours = join(root, `o${n}`);
  buildHistory(root, native, history);
  buildHistory(root, ours, history);
  return { native, ours };
}

interface Mismatch {
  seed: number;
  what: string;
}

function compare(seed: number, ours: Snapshot, native: Snapshot, out: Mismatch[]): void {
  for (const key of ["head", "status", "index", "files", "state"] as const) {
    if (JSON.stringify(ours[key]) !== JSON.stringify(native[key])) {
      out.push({
        seed,
        what: `${key}: ours ${JSON.stringify(ours[key])} native ${JSON.stringify(native[key])}`,
      });
    }
  }
}

const count = Number(process.env.MERGE_FUZZ_SEEDS ?? 40);
const only = process.env.MERGE_FUZZ_SEED ? [Number(process.env.MERGE_FUZZ_SEED)] : undefined;
const seeds = (offset: number) => only ?? Array.from({ length: count }, (_, i) => offset + i);

describeGit("merge and cherry-pick fuzz against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-fuzz-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("merge: random histories merge as native git merges them", async () => {
    const mismatches: Mismatch[] = [];
    for (const seed of seeds(1000)) {
      const history = randomHistory(seed);
      const { native, ours } = twins(history);
      const expected = git(root, native, "merge", "side");
      const result = await (await openOurs(ours))
        .merge()
        .include("side")
        .setAuthor(INTEROP_IDENT)
        .setCommitter(INTEROP_IDENT)
        .call();
      compare(
        seed,
        snapshot(root, ours, normalizeState),
        snapshot(root, native, normalizeState),
        mismatches,
      );
      if (result.status === MergeStatus.FAILED) {
        if (result.message !== expected.stderr.trim()) {
          mismatches.push({ seed, what: `refusal: ${result.message} vs ${expected.stderr}` });
        }
      } else {
        const lines = (result.output ?? []).filter((l) => ortLines(l).length > 0);
        if (JSON.stringify(lines) !== JSON.stringify(ortLines(expected.stdout))) {
          mismatches.push({ seed, what: `output: ${lines.join("|")} vs ${expected.stdout}` });
        }
      }
      rmSync(native, { recursive: true, force: true });
      rmSync(ours, { recursive: true, force: true });
    }
    expect(mismatches).toEqual([]);
  }, 900_000);

  it("cherry-pick: random histories pick as native git picks them", async () => {
    const mismatches: Mismatch[] = [];
    for (const seed of seeds(5000)) {
      const history = randomHistory(seed);
      const { native, ours } = twins(history);
      const expected = git(root, native, "cherry-pick", "side");
      const result = await (await openOurs(ours))
        .cherryPick()
        .include("side")
        .setCommitter(INTEROP_IDENT)
        .call();
      compare(
        seed,
        snapshot(root, ours, normalizeState),
        snapshot(root, native, normalizeState),
        mismatches,
      );
      if (result.status === "failed") {
        if (result.message !== expected.stderr.trim()) {
          mismatches.push({ seed, what: `refusal: ${result.message} vs ${expected.stderr}` });
        }
      } else if (JSON.stringify(result.output) !== JSON.stringify(ortLines(expected.stdout))) {
        mismatches.push({
          seed,
          what: `output: ${result.output?.join("|")} vs ${expected.stdout}`,
        });
      }
      rmSync(native, { recursive: true, force: true });
      rmSync(ours, { recursive: true, force: true });
    }
    expect(mismatches).toEqual([]);
  }, 900_000);
});
