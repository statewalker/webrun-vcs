/**
 * Differential fuzz of merge, merge --autostash, cherry-pick, revert, rebase --autostash and
 * stash apply (and their --abort) against native git on dirty state: random histories (the
 * generator of merge-fuzz-native.test.ts) with unstaged, staged, deleted, untracked and
 * ignored-or-not files in the way, built twice; native git runs on one twin, ours on the
 * other, and HEAD, status, index, every worktree file and the state files must match. A
 * file native git keeps that ours lost is reported apart (data loss).
 *
 * `DIRTY_FUZZ_SEEDS` sets the number of seeds per operation (default 40), `DIRTY_FUZZ_SEED`
 * runs one seed; `DEBUG` prints the history and both sides' results.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MergeOperation, RebaseOperation, SequencerOperation } from "../src/index.js";
import {
  git,
  INTEROP_AUTHOR_ENV,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  put,
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
function randomHistory(seed: number): History & { _main: Tree; _side: Tree; _base: Tree } {
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
  return Object.assign(history, { _main: main, _side: side, _base: base });
}

// ---------------------------------------------------------------------------------------
// Dirty state on top of main: worktree and index changes, untracked files in the way
// ---------------------------------------------------------------------------------------

let root: string;
let counter = 0;

/** Random local state on top of main: what is in the worktree and the index. */
function randomDirty(seed: number, h: ReturnType<typeof randomHistory>): void {
  const rng = prng(seed * 7919 + 13);
  const main = h._main;
  const side = h._side;
  const dirty: Files = {};
  const stage: string[] = [];
  const mainPaths = [...main.text.keys()];
  const sideAdded = [...side.text.keys(), ...side.other.keys()].filter(
    (p) => !main.text.has(p) && !main.other.has(p),
  );
  const taken = (p: string) =>
    p in dirty || Object.keys(dirty).some((q) => q.startsWith(`${p}/`) || p.startsWith(`${q}/`));
  const n = 1 + rng.int(3);
  for (let k = 0; k < n; k++) {
    const kind = rng.int(9);
    if (kind === 0 && mainPaths.length) {
      const p = rng.pick(mainPaths);
      if (!taken(p)) dirty[p] = `unstaged ${seed}\n`;
    } else if (kind === 1 && mainPaths.length) {
      const p = rng.pick(mainPaths);
      if (!taken(p)) {
        dirty[p] = `staged ${seed}\n`;
        stage.push(p);
      }
    } else if (kind === 2 && mainPaths.length) {
      const p = rng.pick(mainPaths);
      if (!taken(p)) dirty[p] = null; // unstaged deletion
    } else if (kind === 3 && mainPaths.length) {
      const p = rng.pick(mainPaths);
      if (!taken(p)) {
        dirty[p] = null;
        stage.push(p);
      }
    } else if (kind === 4 && sideAdded.length) {
      // untracked file exactly where side adds one
      const p = rng.pick(sideAdded);
      if (!taken(p) && !hasPrefixConflict(main, p)) dirty[p] = "untracked in the way\n";
    } else if (kind === 5 && sideAdded.length) {
      // untracked directory where side adds a file
      const p = rng.pick(sideAdded);
      if (!taken(p) && !hasPrefixConflict(main, p)) dirty[`${p}/u.txt`] = "untracked under\n";
    } else if (kind === 6) {
      // a staged new file
      const p = rng.pick(["s1.txt", "d/s2.txt", "q/s3.txt"]);
      if (!taken(p) && !hasPrefixConflict(main, p) && !main.text.has(p)) {
        dirty[p] = "staged new\n";
        stage.push(p);
      }
    } else if (kind === 7) {
      // an untracked file somewhere harmless
      const p = rng.pick(["u1.txt", "d/u2.txt", "e/u3.txt", "zz/u4.txt"]);
      if (!taken(p) && !hasPrefixConflict(main, p) && !main.text.has(p)) dirty[p] = "untracked\n";
    } else if (kind === 8) {
      // an untracked file in a directory side removes or turns into a file
      if ((main.text.has("d/x.txt") || main.text.has("d/y.txt")) && !taken("d/keep.txt")) {
        dirty["d/keep.txt"] = "untracked precious\n";
      }
    }
  }
  h.dirty = Object.keys(dirty).length ? dirty : undefined;
  h.stage = stage.length ? stage : undefined;
}

function twins(history: History, after?: (dir: string) => void) {
  const n = counter++;
  if (process.env.DEBUG) {
    const { _main, _side, _base, ...rest } = history as History & Record<string, unknown>;
    console.log("HISTORY", JSON.stringify(rest));
  }
  const native = join(root, `n${n}`);
  const ours = join(root, `o${n}`);
  for (const dir of [native, ours]) {
    buildHistory(root, dir, history);
    after?.(dir);
  }
  return { native, ours };
}

interface Mismatch {
  seed: number;
  what: string;
}

function compare(seed: number, step: string, ours: Snapshot, native: Snapshot, out: Mismatch[]) {
  for (const key of ["head", "status", "index", "files", "state"] as const) {
    if (JSON.stringify(ours[key]) !== JSON.stringify(native[key])) {
      out.push({
        seed,
        what: `${step} ${key}: ours ${JSON.stringify(ours[key])} native ${JSON.stringify(native[key])}`,
      });
      return; // one per step is enough
    }
  }
}

const count = Number(process.env.DIRTY_FUZZ_SEEDS ?? 40);
const only = process.env.DIRTY_FUZZ_SEED ? [Number(process.env.DIRTY_FUZZ_SEED)] : undefined;
const seeds = (offset: number) => only ?? Array.from({ length: count }, (_, i) => offset + i);
const snap = (dir: string) => snapshot(root, dir, normalizeState);

/** Lost uncommitted data: files native keeps (untracked/dirty) that ours lacks. */
function lost(o: Snapshot, n: Snapshot): string[] {
  const out: string[] = [];
  for (const [p, c] of Object.entries(n.files)) {
    if (!(p in o.files) || o.files[p] !== c) {
      if (/untracked|unstaged|staged|precious/.test(c)) out.push(`${p}=${JSON.stringify(c)}`);
    }
  }
  return out;
}

function report(name: string, mismatches: Mismatch[], losses: Mismatch[]) {
  const bySeed = new Map<number, string[]>();
  for (const m of mismatches) bySeed.set(m.seed, [...(bySeed.get(m.seed) ?? []), m.what]);
  console.log(
    `${name}: ${bySeed.size} seeds mismatch, ${losses.length} LOSSES\n` +
      [
        ...losses.map((l) => `LOSS seed ${l.seed}: ${l.what}`),
        ...[...bySeed].slice(0, 60).map(([s, w]) => `seed ${s}: ${w.join("\n   ").slice(0, 1500)}`),
      ].join("\n"),
  );
}

describeGit("dirty fuzz against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "dirty-fuzz-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("merge (and --abort) on dirty state", async () => {
    const mm: Mismatch[] = [];
    const ll: Mismatch[] = [];
    for (const seed of seeds(20000)) {
      const h = randomHistory(seed);
      randomDirty(seed, h);
      const autostash = seed % 3 === 0;
      const { native, ours } = twins(h);
      const args = autostash ? ["merge", "--autostash", "side"] : ["merge", "side"];
      git(root, native, ...args);
      try {
        await (await openOurs(ours))
          .merge()
          .include("side")
          .setAutoStash(autostash)
          .setAuthor(INTEROP_IDENT)
          .setCommitter(INTEROP_IDENT)
          .call();
      } catch (e) {
        mm.push({ seed, what: `merge threw ${e}` });
      }
      let o = snap(ours);
      let n = snap(native);
      compare(seed, `merge${autostash ? " --autostash" : ""}`, o, n, mm);
      for (const l of lost(o, n)) ll.push({ seed, what: `merge: ${l}` });
      if (n.state.MERGE_HEAD) {
        // a few edits during the conflict: an untracked file, then abort
        for (const dir of [native, ours]) put(dir, "during.txt", "untracked during\n");
        const na = git(root, native, "merge", "--abort");
        let oa: { status?: string; message?: string } = {};
        try {
          oa = await (await openOurs(ours)).merge().setOperation(MergeOperation.ABORT).call();
        } catch (e) {
          oa = { message: String(e) };
        }
        o = snap(ours);
        n = snap(native);
        compare(
          seed,
          `abort(native ${na.status} ${na.stderr.trim()} ours ${oa.status} ${oa.message})`,
          o,
          n,
          mm,
        );
        for (const l of lost(o, n)) ll.push({ seed, what: `abort: ${l}` });
      }
      rmSync(native, { recursive: true, force: true });
      rmSync(ours, { recursive: true, force: true });
    }
    report("merge", mm, ll);
    expect(ll).toEqual([]);
    expect(mm).toEqual([]);
  }, 900_000);

  it("cherry-pick / revert (and --abort) on dirty state", async () => {
    const mm: Mismatch[] = [];
    const ll: Mismatch[] = [];
    for (const seed of seeds(30000)) {
      const h = randomHistory(seed);
      randomDirty(seed, h);
      const revert = seed % 2 === 0;
      const { native, ours } = twins(h);
      const nr = revert
        ? git(root, native, "revert", "--no-edit", "HEAD")
        : git(root, native, "cherry-pick", "side");
      if (process.env.DEBUG) console.log("NATIVE", nr.status, nr.stdout, nr.stderr);
      try {
        // a revert's author resolved as native git's (GIT_AUTHOR_*)
        const g = await openOurs(ours, INTEROP_AUTHOR_ENV);
        const rr = revert
          ? await g.revert().include("HEAD").setCommitter(INTEROP_IDENT).call()
          : await g.cherryPick().include("side").setCommitter(INTEROP_IDENT).call();
        if (process.env.DEBUG) console.log("OURS", JSON.stringify(rr));
      } catch (e) {
        mm.push({ seed, what: `threw ${e}` });
      }
      let o = snap(ours);
      let n = snap(native);
      const name = revert ? "revert" : "cherry-pick";
      compare(seed, name, o, n, mm);
      for (const l of lost(o, n)) ll.push({ seed, what: `${name}: ${l}` });
      if (n.state.CHERRY_PICK_HEAD || n.state.REVERT_HEAD) {
        for (const dir of [native, ours]) put(dir, "during.txt", "untracked during\n");
        const na = git(root, native, name, "--abort");
        let oa: { status?: string; message?: string } = {};
        try {
          const g = await openOurs(ours);
          oa = revert
            ? await g.revert().setOperation(SequencerOperation.ABORT).call()
            : await g.cherryPick().setOperation(SequencerOperation.ABORT).call();
        } catch (e) {
          oa = { message: String(e) };
        }
        o = snap(ours);
        n = snap(native);
        compare(
          seed,
          `${name} --abort(native ${na.status} ${na.stderr.trim()} ours ${oa.status} ${oa.message})`,
          o,
          n,
          mm,
        );
        for (const l of lost(o, n)) ll.push({ seed, what: `abort: ${l}` });
      }
      rmSync(native, { recursive: true, force: true });
      rmSync(ours, { recursive: true, force: true });
    }
    report("pick/revert", mm, ll);
    expect(ll).toEqual([]);
    expect(mm).toEqual([]);
  }, 900_000);

  it("rebase --autostash (and --abort) on dirty state", async () => {
    const mm: Mismatch[] = [];
    const ll: Mismatch[] = [];
    for (const seed of seeds(40000)) {
      const h = randomHistory(seed);
      randomDirty(seed, h);
      const { native, ours } = twins(h);
      const nr = git(root, native, "rebase", "--autostash", "side");
      if (process.env.DEBUG) console.log("NATIVE", nr.status, nr.stdout, nr.stderr);
      try {
        const rr = await (await openOurs(ours))
          .rebase()
          .setCommitter(INTEROP_IDENT)
          .setAutoStash(true)
          .setUpstreamBranch("side")
          .then((c) => c.call());
        if (process.env.DEBUG) console.log("OURS", JSON.stringify(rr));
      } catch (e) {
        mm.push({ seed, what: `rebase threw ${e}` });
      }
      let o = snap(ours);
      let n = snap(native);
      compare(seed, "rebase", o, n, mm);
      for (const l of lost(o, n)) ll.push({ seed, what: `rebase: ${l}` });
      if (Object.keys(n.state).some((k) => k.startsWith("rebase-merge/"))) {
        for (const dir of [native, ours]) put(dir, "during.txt", "untracked during\n");
        const na = git(root, native, "rebase", "--abort");
        try {
          const ra = await (await openOurs(ours))
            .rebase()
            .setOperation(RebaseOperation.ABORT)
            .call();
          if (process.env.DEBUG) console.log("OURS ABORT", JSON.stringify(ra));
        } catch (e) {
          mm.push({ seed, what: `abort threw ${e}` });
        }
        o = snap(ours);
        n = snap(native);
        compare(seed, `rebase --abort(native ${na.status} ${na.stderr.trim()})`, o, n, mm);
        for (const l of lost(o, n)) ll.push({ seed, what: `abort: ${l}` });
      }
      rmSync(native, { recursive: true, force: true });
      rmSync(ours, { recursive: true, force: true });
    }
    report("rebase", mm, ll);
    expect(ll).toEqual([]);
    expect(mm).toEqual([]);
  }, 900_000);

  it("stash apply onto another branch with local changes", async () => {
    const mm: Mismatch[] = [];
    const ll: Mismatch[] = [];
    for (const seed of seeds(50000)) {
      const h = randomHistory(seed);
      randomDirty(seed, h);
      const index = seed % 2 === 0;
      // stash main's dirty state, go to side, dirty it a bit, apply
      const { native, ours } = twins(h, (dir) => {
        const r = git(root, dir, "stash", "push", "-u");
        if (r.status !== 0) return;
        git(root, dir, "checkout", "-q", "side");
        if (seed % 3 === 0) {
          for (const p of ["a.txt", "b.txt", "f.md"]) {
            if (git(root, dir, "ls-files", "--error-unmatch", p).status === 0) {
              put(dir, p, `side local ${seed}\n`);
              break;
            }
          }
        }
      });
      if (git(root, native, "stash", "list").stdout.trim() === "") {
        rmSync(native, { recursive: true, force: true });
        rmSync(ours, { recursive: true, force: true });
        continue;
      }
      const args = index ? ["stash", "apply", "--index"] : ["stash", "apply"];
      const na = git(root, native, ...args);
      let oa: { status?: string; message?: string } = {};
      try {
        oa = (await (await openOurs(ours)).stashApply().setRestoreIndex(index).call()) as typeof oa;
      } catch (e) {
        oa = { status: "threw", message: String(e) };
      }
      const o = snap(ours);
      const n = snap(native);
      compare(
        seed,
        `stash apply${index ? " --index" : ""} (native ${na.status} ${na.stderr.trim().slice(0, 200)} | ours ${oa.status} ${String(oa.message ?? "").slice(0, 200)})`,
        o,
        n,
        mm,
      );
      for (const l of lost(o, n)) ll.push({ seed, what: `stash apply: ${l}` });
      rmSync(native, { recursive: true, force: true });
      rmSync(ours, { recursive: true, force: true });
    }
    report("stash apply", mm, ll);
    expect(ll).toEqual([]);
    expect(mm).toEqual([]);
  }, 900_000);
});
