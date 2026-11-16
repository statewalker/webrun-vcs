/**
 * Directory rename detection against native git (`merge.directoryRenames`: `conflict`, git's
 * default, `true` and `false`): a side that moves a directory takes along what the other
 * side added there, with git's "CONFLICT (file location)" or "Path updated" messages, its
 * split, collision and in-the-way conflicts, and its interactions with rename/rename and
 * rename/delete. Twins built apart (`buildHistory`); merge, cherry-pick and rebase compared
 * with snapshot / normalizeState and merge-ort's output lines.
 *
 * A seeded fuzz moves random directories (`DIRREN_FUZZ_SEEDS=<n>`, default 30 per
 * operation; `DIRREN_FUZZ_SEED=<seed>` replays one).
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
import { buildHistory, type Files, type History, text } from "./merge-native-scenarios.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

type Op = "merge" | "cherry-pick" | "rebase";

/** Runs `op` in both twins; the differences found (none: the same). */
async function compare(history: History, op: Op): Promise<string[]> {
  const n = counter++;
  if (process.env.DIRREN_DEBUG) console.log(JSON.stringify(history, null, 1));
  const native = join(root, `native-${n}`);
  const ours = join(root, `ours-${n}`);
  buildHistory(root, native, history);
  buildHistory(root, ours, history);
  if (op === "rebase") {
    git(root, native, "checkout", "-q", "side");
    git(root, ours, "checkout", "-q", "side");
  }
  let expected: { status: number; stdout: string; stderr: string };
  let output: string[] = [];
  let refusal: string | undefined;
  const repo = await openOurs(ours);
  if (op === "merge") {
    expected = git(root, native, "merge", "side");
    const result = await repo
      .merge()
      .include("side")
      .setAuthor(INTEROP_IDENT)
      .setCommitter(INTEROP_IDENT)
      .call();
    output = result.output ?? [];
    if (result.status === MergeStatus.FAILED) refusal = result.message;
  } else if (op === "cherry-pick") {
    expected = git(root, native, "cherry-pick", "side");
    const result = await repo.cherryPick().include("side").setCommitter(INTEROP_IDENT).call();
    output = result.output ?? [];
    if (result.status === "failed") refusal = result.message;
  } else {
    expected = git(root, native, "rebase", "main");
    const command = repo.rebase().setCommitter(INTEROP_IDENT);
    await command.setUpstreamBranch("main");
    const result = await command.call();
    output = result.output ?? [];
  }
  const diffs: string[] = [];
  const a = snapshot(root, ours, normalizeState);
  const b = snapshot(root, native, normalizeState);
  for (const key of ["head", "status", "index", "files", "state"] as const) {
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) {
      diffs.push(`${key}: ours ${JSON.stringify(a[key])}\nnative ${JSON.stringify(b[key])}`);
    }
  }
  if (refusal !== undefined) {
    if (refusal !== expected.stderr.trim()) diffs.push(`refusal: ${refusal} vs ${expected.stderr}`);
  } else {
    const lines = output.filter((l) => dirLines(l).length > 0);
    if (JSON.stringify(lines) !== JSON.stringify(dirLines(expected.stdout))) {
      diffs.push(`output: ${JSON.stringify(lines)} vs ${JSON.stringify(expected.stdout)}`);
    }
  }
  rmSync(native, { recursive: true, force: true });
  rmSync(ours, { recursive: true, force: true });
  return diffs;
}

/** merge-ort's lines, with the directory rename messages. */
function dirLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .filter((l) => /^(Path updated|WARNING: Avoiding)/.test(l) || ortLines(l).length > 0);
}

const dirFiles = (dir: string, names: string[], tag = "") =>
  Object.fromEntries(
    names.map((n, i) => [`${dir}/${n}`, text({ 1: `${dir}/${n}${tag}`, [i + 2]: n })]),
  );
const moved = (from: string, to: string, names: string[]): Files => ({
  ...Object.fromEntries(names.map((n) => [`${from}/${n}`, null])),
  ...Object.fromEntries(
    names.map((n, i) => [`${to}/${n}`, text({ 1: `${from}/${n}`, [i + 2]: n })]),
  ),
});

const SCENARIOS: Record<string, History> = {
  "a file added in a renamed directory": {
    base: dirFiles("d", ["a", "b", "c"]),
    side: moved("d", "e", ["a", "b", "c"]),
    main: { "d/new": text({ 1: "new" }) },
  },
  "a file renamed into a renamed directory": {
    base: { ...dirFiles("d", ["a", "b"]), x: text({ 1: "x" }) },
    side: moved("d", "e", ["a", "b"]),
    main: { x: null, "d/x": text({ 1: "x" }) },
  },
  "a nested directory renamed": {
    base: { ...dirFiles("p/q", ["a", "b"]), "p/top": "t\n" },
    side: { ...moved("p/q", "r/q", ["a", "b"]) },
    main: { "p/q/n": text({ 1: "n" }), "p/q/a": text({ 1: "p/q/a", 2: "a", 9: "main" }) },
  },
  "a directory renamed to the top": {
    base: dirFiles("d", ["a", "b"]),
    side: {
      "d/a": null,
      "d/b": null,
      a: text({ 1: "d/a", 2: "a" }),
      b: text({ 1: "d/b", 3: "b" }),
    },
    main: { "d/n": "n\n" },
  },
  "a directory split two ways": {
    base: dirFiles("d", ["a", "b"]),
    side: { ...moved("d", "e", ["a"]), ...moved("d", "f", ["b"]) },
    main: { "d/n": text({ 1: "n" }) },
  },
  "two paths mapped to one by directory renames": {
    base: { ...dirFiles("d", ["a", "b"]), ...dirFiles("g", ["c", "e"]) },
    side: { ...moved("d", "x", ["a", "b"]), ...moved("g", "x", ["c", "e"]) },
    main: { "d/n": text({ 1: "dn" }), "g/n": text({ 1: "gn" }) },
  },
  "an existing file in the way of the moved path": {
    base: dirFiles("d", ["a", "b"]),
    side: { ...moved("d", "e", ["a", "b"]), "e/n": text({ 1: "theirs" }) },
    main: { "d/n": text({ 1: "ours" }) },
  },
  "both sides rename the directory differently": {
    base: dirFiles("d", ["a", "b"]),
    side: moved("d", "e", ["a", "b"]),
    main: { ...moved("d", "f", ["a", "b"]), "f/n": "n\n" },
  },
  "the target directory renamed on the other side": {
    base: { ...dirFiles("d", ["a", "b"]), ...dirFiles("e", ["c", "g"]) },
    side: moved("d", "e", ["a", "b"]),
    main: { ...moved("e", "z", ["c", "g"]), "d/n": "n\n" },
  },
  "a rename/delete inside a renamed directory": {
    base: { ...dirFiles("d", ["a", "b", "c"]), x: text({ 1: "x" }) },
    side: { ...moved("d", "e", ["a", "b", "c"]), x: null },
    main: { x: null, "d/x": text({ 1: "x" }) },
  },
  "a rename/rename across a renamed directory": {
    base: { ...dirFiles("d", ["a", "b", "c"]), x: text({ 1: "x" }) },
    side: { ...moved("d", "e", ["a", "b", "c"]), x: null, y: text({ 1: "x" }) },
    main: { x: null, "d/x": text({ 1: "x" }) },
  },
  "an add/add after the move": {
    base: dirFiles("d", ["a", "b"]),
    side: { ...moved("d", "e", ["a", "b"]), "e/n": text({ 1: "side" }) },
    main: { "d/n": text({ 1: "main" }), "d/a": text({ 1: "d/a", 2: "a", 8: "main" }) },
  },
  "a file/directory clash at the moved path": {
    base: dirFiles("d", ["a", "b"]),
    side: { ...moved("d", "e", ["a", "b"]), "e/n/inner": "i\n" },
    main: { "d/n": "file\n" },
  },
};

describeGit("directory renames against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-dirren-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  for (const [name, history] of Object.entries(SCENARIOS)) {
    for (const mode of [undefined, "true", "false"]) {
      it(`${name} (merge.directoryRenames=${mode ?? "default"})`, async () => {
        const h: History = { ...history, config: mode ? { "merge.directoryRenames": mode } : {} };
        for (const op of ["merge", "cherry-pick"] as const) {
          expect(await compare(h, op), op).toEqual([]);
        }
      });
    }
  }

  it("a rebase across a renamed directory", async () => {
    const history: History = {
      base: dirFiles("d", ["a", "b", "c"]),
      main: moved("d", "e", ["a", "b", "c"]),
      side: { "d/new": text({ 1: "new" }) },
      sideMore: [{ "d/new2": "n2\n" }],
    };
    expect(await compare(history, "rebase")).toEqual([]);
    expect(
      await compare({ ...history, config: { "merge.directoryRenames": "true" } }, "rebase"),
    ).toEqual([]);
  });

  const fuzzCount = Number(process.env.DIRREN_FUZZ_SEEDS ?? 30);
  const only = process.env.DIRREN_FUZZ_SEED ? [Number(process.env.DIRREN_FUZZ_SEED)] : undefined;
  for (const op of ["merge", "cherry-pick"] as const) {
    it(`${op}: random directory moves as native git does them`, async () => {
      const failures: string[] = [];
      const offset = op === "merge" ? 9000 : 9500;
      for (const seed of only ?? Array.from({ length: fuzzCount }, (_, i) => offset + i)) {
        const diffs = await compare(randomDirHistory(seed), op);
        if (diffs.length > 0) failures.push(`seed ${seed}: ${diffs.join("\n")}`);
      }
      expect(failures).toEqual([]);
    }, 600_000);
  }
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

const DIRS = ["d", "e", "p/q", "p/r", "s"];
const NAMES = ["a", "b", "c", "f"];

/** A random history where sides move directories and add or rename files into them. */
function randomDirHistory(seed: number): History {
  const rng = prng(seed);
  const base = new Map<string, string>();
  for (const dir of DIRS) {
    if (!rng.chance(0.6)) continue;
    for (const name of NAMES) {
      if (rng.chance(0.7)) base.set(`${dir}/${name}`, text({ 1: `${dir}/${name}`, 5: name }));
    }
  }
  if (base.size === 0) base.set("d/a", text({ 1: "d/a" }));
  if (rng.chance(0.5)) base.set("top", text({ 1: "top" }));
  const mutate = (tag: string): Map<string, string> => {
    const t = new Map(base);
    for (let k = 0; k < 1 + rng.int(3); k++) {
      const op = rng.int(8);
      const paths = [...t.keys()];
      if (op <= 2) {
        // move (most of) a directory
        const dirs = [...new Set(paths.map((p) => p.slice(0, p.lastIndexOf("/"))))].filter(
          (d) => d,
        );
        if (dirs.length === 0) continue;
        const from = rng.pick(dirs);
        const to = rng.pick([...DIRS, "n", "p/n", ""].filter((d) => d !== from));
        for (const p of paths.filter(
          (x) => x.startsWith(`${from}/`) && !x.slice(from.length + 1).includes("/"),
        )) {
          if (rng.chance(0.15)) continue;
          const content = t.get(p) as string;
          t.delete(p);
          const target = to ? `${to}/${p.slice(from.length + 1)}` : p.slice(from.length + 1);
          if ([...t.keys()].some((q) => q.startsWith(`${target}/`) || target.startsWith(`${q}/`))) {
            t.set(p, content);
            continue;
          }
          t.set(target, rng.chance(0.3) ? `${content}${tag}\n` : content);
        }
      } else if (op <= 4) {
        // add a file in a (base) directory
        const dir = rng.pick(DIRS);
        const path = `${dir}/${rng.pick(["n", "m", ...NAMES])}${tag}`;
        if (![...t.keys()].some((q) => q.startsWith(`${path}/`) || path.startsWith(`${q}/`))) {
          // unique content: equal similarity scores tie, which git's unstable qsort orders
          t.set(path, text({ 1: `${tag} added ${path}` }));
        }
      } else if (op === 5 && paths.length > 0) {
        // edit a file
        const p = rng.pick(paths);
        t.set(p, text({ 1: (t.get(p) as string).split("\n")[0], 7: `${tag} edit` }));
      } else if (op === 6 && paths.length > 1) {
        t.delete(rng.pick(paths));
      } else if (paths.length > 0) {
        // rename a file into another directory
        const p = rng.pick(paths);
        const target = `${rng.pick(DIRS)}/${p.slice(p.lastIndexOf("/") + 1)}${tag}`;
        if (
          ![...t.keys()].some(
            (q) => q === target || q.startsWith(`${target}/`) || target.startsWith(`${q}/`),
          )
        ) {
          const content = t.get(p) as string;
          t.delete(p);
          t.set(target, content);
        }
      }
    }
    return t;
  };
  const diff = (to: Map<string, string>): Files => {
    const files: Files = {};
    for (const p of base.keys()) if (!to.has(p)) files[p] = null;
    for (const [p, c] of to) if (base.get(p) !== c) files[p] = c;
    return files;
  };
  const main = mutate("M");
  const side = mutate("S");
  const config: Record<string, string> = {};
  const mode = rng.pick([undefined, undefined, "true", "false"]);
  if (mode) config["merge.directoryRenames"] = mode;
  return { base: Object.fromEntries(base), main: diff(main), side: diff(side), config };
}
