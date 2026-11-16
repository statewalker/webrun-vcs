/**
 * mergeLines against native git, on random repetitive files (lines like `}`, blank lines and
 * one-letter tokens, where diffs have many equally short answers and only git's own choice
 * matches git).
 *
 * Two modes are compared:
 * - merge-ort (`git merge`, `cherry-pick`, `stash apply`): mergeLines' defaults against
 *   `git merge-tree --write-tree`, which runs the same merge-ort code, each case a base commit
 *   and two children;
 * - `git merge-file`: mergeLines with `algorithm: "myers", level: "zealous-alnum"`.
 *
 * merge-ort diffs with histogram (git 2.43 hardcoded it, newer git defaults to it); git 2.54
 * changed histogram's clean-up, which the test follows by the native version. Each case uses
 * one of the three conflict styles. Set `LM_SEEDS` for the number of cases
 * (default 3000) and `LM_SHOW` for how many mismatches to print. Skipped without native git.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ByteLines,
  type ConflictStyle,
  mergeLines,
  type XdiffAlgorithm,
  xdiff,
} from "../../../src/diff/text-diff/index.js";

const version = spawnSync("git", ["--version"], { encoding: "utf8" });
const hasGit = version.status === 0;
const [major, minor] = (/(\d+)\.(\d+)/.exec(version.stdout ?? "") ?? ["", "0", "0"])
  .slice(1)
  .map(Number);
/** git before 2.54 does not diff a histogram group again after sliding joined it */
const histogramRediff = major > 2 || (major === 2 && minor >= 54);
const mergeFileTakesAlgorithm = major > 2 || (major === 2 && minor >= 44);
const SEEDS = Number(process.env.LM_SEEDS ?? 3000);
const SHOW = Number(process.env.LM_SHOW ?? 3);
const STYLES: ConflictStyle[] = ["merge", "diff3", "zdiff3"];

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
};

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = ["a", "b", "c", "}", "", "x"];

function edit(r: () => number, lines: string[], edits: number, tokens: string[]): string[] {
  const out = [...lines];
  for (let k = 0; k < edits; k++) {
    const at = Math.floor(r() * (out.length + 1));
    const op = Math.floor(r() * 3);
    const tok = tokens[Math.floor(r() * tokens.length)];
    if (op === 0 && at < out.length) out[at] = tok;
    else if (op === 1) out.splice(at, 0, tok);
    else if (at < out.length) out.splice(at, 1);
  }
  return out;
}

interface Case {
  base: string;
  ours: string;
  theirs: string;
  style: ConflictStyle;
}

/**
 * Case `seed`: mostly short files of six tokens with a few edits per side; every 50th a
 * long file with hundreds of edits (the discarding and the cost cutoff of xdiff's Myers),
 * from a larger alphabet with some unique lines.
 */
function makeCase(seed: number): Case {
  const r = prng(seed);
  let base: string[];
  let ours: string[];
  let theirs: string[];
  if (seed % 50 === 0) {
    const tokens = [...TOKENS, ...Array.from({ length: 20 }, (_, i) => `t${i}`)];
    const pick = () =>
      r() < 0.1 ? `u${Math.floor(r() * 1e9)}` : tokens[Math.floor(r() * tokens.length)];
    base = Array.from({ length: 300 + Math.floor(r() * 1500) }, pick);
    ours = edit(r, base, 50 + Math.floor(r() * 600), tokens);
    theirs = edit(r, base, 50 + Math.floor(r() * 600), tokens);
  } else {
    base = Array.from({ length: 3 + Math.floor(r() * 10) }, () => TOKENS[Math.floor(r() * 6)]);
    ours = edit(r, base, 1 + Math.floor(r() * 4), TOKENS);
    theirs = edit(r, base, 1 + Math.floor(r() * 4), TOKENS);
  }
  const text = (l: string[]) => l.map((x) => `${x}\n`).join("");
  return { base: text(base), ours: text(ours), theirs: text(theirs), style: STYLES[seed % 3] };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** The base marker's label differs (git writes the base commit): compare the markers alone */
const normalizeBase = (s: string) => s.replace(/^\|{7} .*$/gm, "|||||||");

function report(name: string, bad: string[]): void {
  console.log(`${name}: ${bad.length}/${SEEDS} mismatches`);
  if (bad.length) console.log(bad.slice(0, SHOW).join("\n=====\n"));
}

function describeCase(seed: number, c: Case, native: string, mine: string): string {
  const lines = (s: string) => JSON.stringify(s.split("\n").slice(0, -1));
  return `seed ${seed} ${c.style}\nbase=${lines(c.base)}\nours=${lines(c.ours)}\ntheirs=${lines(c.theirs)}\n--native--\n${native}--mergeLines--\n${mine}`;
}

describe.skipIf(!hasGit)("mergeLines against native git", () => {
  const dir = hasGit ? mkdtempSync(join(tmpdir(), "line-merge-fuzz-")) : "";
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const git = (args: string[], input?: string | Buffer) =>
    execFileSync("git", args, { cwd: dir, env: gitEnv, input, maxBuffer: 1 << 30 });

  it(`as git merge-file (myers, zealous-alnum), ${SEEDS} cases`, () => {
    const bad: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const c = makeCase(seed);
      writeFileSync(join(dir, "o"), c.ours);
      writeFileSync(join(dir, "b"), c.base);
      writeFileSync(join(dir, "t"), c.theirs);
      const args = ["merge-file", "-p", "-L", "O", "-L", "B", "-L", "T"];
      if (c.style !== "merge") args.push(`--${c.style}`);
      const native = spawnSync("git", [...args, "o", "b", "t"], { cwd: dir, env: gitEnv }).stdout;
      const merged = mergeLines(enc.encode(c.base), enc.encode(c.ours), enc.encode(c.theirs), {
        oursLabel: "O",
        theirsLabel: "T",
        baseLabel: "B",
        style: c.style,
        algorithm: "myers",
        level: "zealous-alnum",
      });
      const mine = dec.decode(merged.content);
      const expected = dec.decode(native);
      if (mine !== expected) bad.push(describeCase(seed, c, expected, mine));
    }
    report("merge-file", bad);
    expect(bad.length).toBe(0);
  }, 600_000);

  it(`as merge-ort (git merge-tree), ${SEEDS} cases`, () => {
    git(["init", "-q", "repo"]);
    const repo = (args: string[], input?: string | Buffer) =>
      execFileSync("git", args, { cwd: join(dir, "repo"), env: gitEnv, input, maxBuffer: 1 << 30 });
    const cases = Array.from({ length: SEEDS }, (_, i) => makeCase(i + 1));
    // all cases in one fast-import: a base commit and two children each
    const data = (s: string) => `data ${Buffer.byteLength(s)}\n${s}\n`;
    const chunks: string[] = [];
    cases.forEach((c, i) => {
      const commit = (ref: string, mark: number, from: number, content: string) =>
        `commit refs/heads/${ref}\nmark :${mark}\ncommitter t <t@example.com> 1700000000 +0000\n${data("m")}${from ? `from :${from}\n` : ""}M 644 inline f\n${data(content)}\n`;
      chunks.push(commit(`b${i}`, 3 * i + 1, 0, c.base));
      chunks.push(commit(`o${i}`, 3 * i + 2, 3 * i + 1, c.ours));
      chunks.push(commit(`t${i}`, 3 * i + 3, 3 * i + 1, c.theirs));
    });
    repo(["fast-import", "--quiet"], chunks.join(""));

    // one merge-tree run per conflict style; each answer is a tree holding the merged `f`
    const trees: string[] = new Array(SEEDS);
    for (const [s, style] of STYLES.entries()) {
      const pairs = cases.map((_, i) => i).filter((i) => i % 3 === (s + 2) % 3);
      const input = pairs.map((i) => `o${i} t${i}\n`).join("");
      const res = spawnSync(
        "git",
        [
          "-c",
          `merge.conflictStyle=${style}`,
          "merge-tree",
          "--write-tree",
          "--stdin",
          "-z",
          "--no-messages",
        ],
        { cwd: join(dir, "repo"), env: gitEnv, input, maxBuffer: 1 << 30 },
      );
      const fields = res.stdout.toString("utf8").split("\0");
      let k = 0;
      for (const i of pairs) {
        k++; // merge status
        trees[i] = fields[k++];
        while (fields[k] !== "") k++; // conflicted entries
        k++;
      }
    }
    const batch = repo(["cat-file", "--batch"], trees.map((t) => `${t}:f\n`).join(""));
    const results: string[] = [];
    let pos = 0;
    for (let i = 0; i < SEEDS; i++) {
      const eol = batch.indexOf(0x0a, pos);
      const size = Number(batch.subarray(pos, eol).toString("utf8").split(" ")[2]);
      results.push(batch.subarray(eol + 1, eol + 1 + size).toString("utf8"));
      pos = eol + 1 + size + 1;
    }

    const bad: string[] = [];
    cases.forEach((c, i) => {
      const merged = mergeLines(enc.encode(c.base), enc.encode(c.ours), enc.encode(c.theirs), {
        oursLabel: `o${i}`,
        theirsLabel: `t${i}`,
        baseLabel: "base",
        style: c.style,
        histogramRediff,
      });
      const mine = normalizeBase(dec.decode(merged.content));
      const expected = normalizeBase(results[i]);
      if (mine !== expected) bad.push(describeCase(i + 1, c, expected, mine));
    });
    report("merge-ort", bad);
    expect(bad.length).toBe(0);
  }, 600_000);

  it("big inputs as git merge-file, with either algorithm", () => {
    const j = (l: string[]) => l.join("");
    const n = 20000;
    const unique = Array.from({ length: n }, (_, i) => `line ${i}\n`);
    const middle = (i: number) => i >= n / 4 && i < (3 * n) / 4;
    const scattered = [
      j(unique),
      j(unique.map((l, i) => (i % 1000 === 0 ? `ours ${i}\n` : l))),
      j(unique.map((l, i) => (i % 1000 === 500 ? `theirs ${i}\n` : l))),
    ];
    const blocks = [
      j(unique),
      j(unique.map((l, i) => (middle(i) ? `o ${i % 7}\n` : l))),
      j(unique.map((l, i) => (middle(i) ? `t ${i % 5}\n` : l))),
    ];
    const rep = Array.from({ length: n }, (_, i) =>
      i % 3 === 0 ? "}\n" : i % 3 === 1 ? "\n" : `x${i % 50}\n`,
    );
    const inserted = [...rep];
    inserted.splice(n / 2, 0, "inserted\n");
    const repetitive = [j(rep), j([...rep].reverse()), j(inserted)];
    for (const [b, o, t] of [scattered, blocks, repetitive]) {
      writeFileSync(join(dir, "b"), b);
      writeFileSync(join(dir, "o"), o);
      writeFileSync(join(dir, "t"), t);
      // merge-file takes --diff-algorithm from git 2.44 on
      const algorithms = mergeFileTakesAlgorithm ? ["myers", "histogram"] : ["myers"];
      for (const algorithm of algorithms as XdiffAlgorithm[]) {
        const args = ["merge-file", "-p", "-L", "O", "-L", "B", "-L", "T"];
        if (algorithm !== "myers") args.push(`--diff-algorithm=${algorithm}`);
        args.push("o", "b", "t");
        const native = spawnSync("git", args, { cwd: dir, env: gitEnv, maxBuffer: 1 << 30 });
        const merged = mergeLines(enc.encode(b), enc.encode(o), enc.encode(t), {
          oursLabel: "O",
          theirsLabel: "T",
          algorithm,
          level: "zealous-alnum",
          histogramRediff,
        });
        expect(dec.decode(merged.content) === native.stdout.toString("utf8")).toBe(true);
      }
    }
  }, 120_000);

  it("xdiff as git diff, with each algorithm", () => {
    const algorithms: XdiffAlgorithm[] = ["myers", "minimal", "patience", "histogram"];
    const cases = Math.max(1, Math.floor(SEEDS / 6));
    const bad: string[] = [];
    for (let seed = 1; seed <= cases; seed++) {
      const c = makeCase(seed * 3 + 1);
      writeFileSync(join(dir, "b"), c.base);
      writeFileSync(join(dir, "o"), c.ours);
      const indentHeuristic = seed % 2 === 0;
      for (const algorithm of algorithms) {
        const args = ["diff", "--no-index", "--no-color", "-U0", `--diff-algorithm=${algorithm}`];
        args.push(indentHeuristic ? "--indent-heuristic" : "--no-indent-heuristic", "b", "o");
        const native = spawnSync("git", args, { cwd: dir, env: gitEnv, maxBuffer: 1 << 30 });
        const headers = native.stdout
          .toString("utf8")
          .matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm);
        const hunks = [...headers].map((h) => {
          const chg1 = h[2] === undefined ? 1 : Number(h[2]);
          const chg2 = h[4] === undefined ? 1 : Number(h[4]);
          const i1 = chg1 === 0 ? Number(h[1]) : Number(h[1]) - 1;
          const i2 = chg2 === 0 ? Number(h[3]) : Number(h[3]) - 1;
          return `${i1},${chg1} ${i2},${chg2}`;
        });
        const mine = xdiff(new ByteLines(enc.encode(c.base)), new ByteLines(enc.encode(c.ours)), {
          algorithm,
          indentHeuristic,
          histogramRediff,
        }).map((x) => `${x.i1},${x.chg1} ${x.i2},${x.chg2}`);
        if (mine.join("|") !== hunks.join("|")) {
          bad.push(
            `seed ${seed} ${algorithm}\nnative ${hunks.join("|")}\nxdiff  ${mine.join("|")}`,
          );
        }
      }
    }
    console.log(`xdiff: ${bad.length}/${cases * algorithms.length} mismatches`);
    if (bad.length) console.log(bad.slice(0, SHOW).join("\n"));
    expect(bad.length).toBe(0);
  }, 600_000);
});
