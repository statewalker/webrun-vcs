/**
 * unifiedDiff against `git diff --no-index`: random file pairs (repetitive lines, whitespace
 * variants, CR LF, missing trailing newlines, long function lines cut at 80 bytes, bytes that
 * are not UTF-8) with random options (algorithm, indent heuristic, context, inter-hunk
 * context, -w/-b/--ignore-space-at-eol/--ignore-cr-at-eol, --ignore-blank-lines, -W, a
 * builtin diff driver through core.attributesFile). The hunk part of git's output (from the
 * first "@@") must equal ours byte for byte; the diffstat counts must equal `--numstat`.
 *
 * Set `UD_SEEDS` for the number of cases (default 1500) and `UD_SHOW` for how many
 * mismatches to print. Skipped without native git.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  diffLineCounts,
  type UnifiedDiffOptions,
  unifiedDiff,
  userdiffFindFunction,
  type XdiffAlgorithm,
} from "../../../src/diff/text-diff/index.js";

const version = spawnSync("git", ["--version"], { encoding: "utf8" });
const hasGit = version.status === 0;
const [major, minor] = (/(\d+)\.(\d+)/.exec(version.stdout ?? "") ?? ["", "0", "0"])
  .slice(1)
  .map(Number);
const histogramRediff = major > 2 || (major === 2 && minor >= 54);
/** git before 2.5x also sets aside many-matched lines for a minimal diff */
const legacyMinimal = major === 2 && minor < 50;
const SEEDS = Number(process.env.UD_SEEDS ?? 1500);
const SHOW = Number(process.env.UD_SHOW ?? 3);

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  LANG: "C",
  LC_ALL: "C",
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

const TOKENS = [
  "a",
  "b",
  "}",
  "",
  " ",
  "\t",
  "  a",
  "\ta",
  "a  ",
  "a\t",
  "a\r",
  " a b",
  "a  b",
  "a\tb",
  "int main(void)",
  "  if (x) {",
  "static int f(int y)",
  "def g(self):",
  "    return 1",
  "class K:",
  "_private",
  "$var",
  "label:",
  "# comment",
  "x",
];
/** Builtin drivers whose pattern is the same in git 2.43 and 2.56 */
const DRIVERS = ["cpp", "python", "java", "golang", "ruby", "tex", "html", "perl", "css"];
const ALGORITHMS: XdiffAlgorithm[] = ["myers", "minimal", "patience", "histogram"];
const enc = new TextEncoder();

function longLine(r: () => number): string {
  const len = 70 + Math.floor(r() * 30);
  let s = r() < 0.5 ? "def " : "fn_";
  while (s.length < len) s += r() < 0.15 ? "é" : r() < 0.1 ? " " : "x";
  return s;
}

function lines(r: () => number, n: number): string[] {
  return Array.from({ length: n }, () =>
    r() < 0.05 ? longLine(r) : TOKENS[Math.floor(r() * TOKENS.length)],
  );
}

function edit(r: () => number, base: string[], edits: number): string[] {
  const out = [...base];
  for (let k = 0; k < edits; k++) {
    const at = Math.floor(r() * (out.length + 1));
    const op = Math.floor(r() * 4);
    const tok = r() < 0.05 ? longLine(r) : TOKENS[Math.floor(r() * TOKENS.length)];
    if (op === 0 && at < out.length) out[at] = tok;
    else if (op === 1) out.splice(at, 0, tok);
    else if (op === 2 && at < out.length) out.splice(at, 1);
    else if (at < out.length) out[at] = `${out[at]} `;
  }
  return out;
}

function toBytes(r: () => number, l: string[]): Uint8Array {
  const crlf = r() < 0.1;
  let text = l.map((x) => `${x}${crlf ? "\r\n" : "\n"}`).join("");
  if (r() < 0.25 && text.length > 0) text = text.slice(0, crlf ? -2 : -1);
  const bytes = enc.encode(text);
  // a stray byte that is not UTF-8, sometimes
  if (r() < 0.05 && bytes.length > 3) bytes[Math.floor(r() * bytes.length)] = 0xff;
  return bytes;
}

interface Case {
  a: Uint8Array;
  b: Uint8Array;
  options: UnifiedDiffOptions;
  driver?: string;
  args: string[];
}

function makeCase(seed: number): Case {
  const r = prng(seed);
  const big = seed % 40 === 0;
  const base = lines(r, big ? 200 + Math.floor(r() * 600) : Math.floor(r() * 14));
  const other = edit(r, base, big ? 20 + Math.floor(r() * 150) : 1 + Math.floor(r() * 5));
  const algorithm = ALGORITHMS[Math.floor(r() * 4)];
  const indentHeuristic = r() < 0.6;
  const context = r() < 0.2 ? 0 : Math.floor(r() * 5);
  const interHunkContext = r() < 0.7 ? 0 : Math.floor(r() * 4);
  const ws = Math.floor(r() * 8);
  const options: UnifiedDiffOptions = {
    algorithm,
    indentHeuristic,
    histogramRediff,
    legacyMinimal,
    context,
    interHunkContext,
    ignoreWhitespace: ws === 1,
    ignoreWhitespaceChange: ws === 2,
    ignoreWhitespaceAtEol: ws === 3,
    ignoreCrAtEol: ws === 4,
    ignoreBlankLines: r() < 0.2,
    functionContext: r() < 0.08,
  };
  const args = [
    `--diff-algorithm=${algorithm}`,
    indentHeuristic ? "--indent-heuristic" : "--no-indent-heuristic",
    `-U${context}`,
    `--inter-hunk-context=${interHunkContext}`,
  ];
  if (options.ignoreWhitespace) args.push("-w");
  if (options.ignoreWhitespaceChange) args.push("-b");
  if (options.ignoreWhitespaceAtEol) args.push("--ignore-space-at-eol");
  if (options.ignoreCrAtEol) args.push("--ignore-cr-at-eol");
  if (options.ignoreBlankLines) args.push("--ignore-blank-lines");
  if (options.functionContext) args.push("-W");
  const driver = r() < 0.3 ? DRIVERS[Math.floor(r() * DRIVERS.length)] : undefined;
  if (driver) options.findFunction = userdiffFindFunction(driver);
  return { a: toBytes(r, base), b: toBytes(r, other), options, driver, args };
}

let dir: string | undefined;
afterAll(() => {
  if (process.env.UD_ONLY) return;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function native(c: Case): Buffer {
  dir ??= mkdtempSync(join(tmpdir(), "ud-fuzz-"));
  writeFileSync(join(dir, "a"), c.a);
  writeFileSync(join(dir, "b"), c.b);
  const pre: string[] = [];
  if (c.driver) {
    writeFileSync(join(dir, "attrs"), `* diff=${c.driver}\n`);
    pre.push("-c", `core.attributesFile=${join(dir, "attrs")}`);
  }
  const res = spawnSync("git", [...pre, "diff", "--no-index", "--no-color", ...c.args, "a", "b"], {
    cwd: dir,
    env: gitEnv,
  });
  if (res.status !== 0 && res.status !== 1) throw new Error(String(res.stderr));
  return res.stdout;
}

function body(out: Buffer): Buffer {
  if (out.length === 0) return out;
  const at = out.indexOf("\n@@ ");
  return at < 0 ? Buffer.alloc(0) : out.subarray(at + 1);
}

function numstat(c: Case): [number, number] | undefined {
  const res = spawnSync(
    "git",
    ["diff", "--no-index", "--numstat", ...c.args.filter((a) => a !== "-W"), "a", "b"],
    { cwd: dir, env: gitEnv, encoding: "utf8" },
  );
  const m = /^(\d+)\t(\d+)\t/.exec(res.stdout);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

describe.skipIf(!hasGit)("unifiedDiff against git diff --no-index", () => {
  it(`matches git's hunks on ${SEEDS} random file pairs`, () => {
    const mismatches: string[] = [];
    let compared = 0;
    let withHunks = 0;
    const only = Number(process.env.UD_ONLY ?? 0);
    for (let seed = only || 1; seed <= (only || SEEDS); seed++) {
      const c = makeCase(seed);
      const expected = body(native(c));
      const actual = Buffer.from(unifiedDiff(c.a, c.b, c.options));
      compared++;
      if (expected.length > 0) withHunks++;
      if (!expected.equals(actual)) {
        mismatches.push(
          `seed ${seed} ${c.args.join(" ")} ${c.driver ?? ""}\n--- git\n${expected}\n--- ours\n${actual}`,
        );
        continue;
      }
      if (seed % 5 === 0) {
        const counts = diffLineCounts(c.a, c.b, c.options);
        const ns = numstat(c);
        const ours: [number, number] | undefined =
          counts.added + counts.deleted > 0 ? [counts.added, counts.deleted] : undefined;
        if (JSON.stringify(ns) !== JSON.stringify(ours)) {
          mismatches.push(
            `seed ${seed} numstat ${JSON.stringify(ns)} ours ${JSON.stringify(ours)}`,
          );
        }
      }
    }
    for (const m of mismatches.slice(0, SHOW)) console.log(m);
    expect(compared).toBe(only ? 1 : SEEDS);
    if (!only) expect(withHunks).toBeGreaterThan(SEEDS / 2);
    expect(mismatches.length).toBe(0);
  }, 600_000);
});
