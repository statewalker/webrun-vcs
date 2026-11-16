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
  BUILTIN_FUNCNAME_PATTERNS,
  BUILTIN_FUNCNAME_PATTERNS_2_43,
  diffLineCounts,
  type FuncnamePattern,
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
  // function lines of the other builtin drivers
  "func (r *T) Run() error {",
  "pub(crate) fn x<T>() -> T {",
  "sub foo($a) : lvalue {",
  "public function bar()",
  "  SUBROUTINE FOO(A)",
  "\\section{Intro}",
  "## Heading",
  "[section]",
  "<h1>Title</h1>",
  "@article{key,",
  "(define (f x)",
  "defmodule Foo do",
  "fun foo(): Int",
  "a:hover {",
  "&node {",
  "foo <- function(x)",
  "MyClass = class(TObject)",
  "@objc func g()",
  "- (void)foo:(int)x {",
  "classdef Foo",
  "%% Section",
  "  public async Task<int> Get(int a)",
  "    List<int> xs = new List<int>();",
  "namespace N {",
  "procedure Foo is",
  "INT. ROOM",
  "f() {",
  "function g {",
];
const atLeast = (ma: number, mi: number) => major > ma || (major === ma && minor >= mi);
/** The builtin drivers of this git: 2.56's, 2.43's (up to 2.44), else only the common ones */
const BUILTINS: Readonly<Record<string, FuncnamePattern>> | undefined = atLeast(2, 56)
  ? BUILTIN_FUNCNAME_PATTERNS
  : !atLeast(2, 45)
    ? BUILTIN_FUNCNAME_PATTERNS_2_43
    : undefined;
/** Every builtin driver (the common ones only for a git between 2.45 and 2.55) */
const DRIVERS = Object.keys(BUILTIN_FUNCNAME_PATTERNS).filter(
  (d) =>
    BUILTINS !== undefined ||
    JSON.stringify(BUILTIN_FUNCNAME_PATTERNS[d]) ===
      JSON.stringify(BUILTIN_FUNCNAME_PATTERNS_2_43[d]),
);
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
  if (driver) options.findFunction = userdiffFindFunction(driver, undefined, BUILTINS);
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

/** Lines that are function lines for some builtin driver, or near misses */
const FUNCTION_LINES = [
  "int main(void)",
  "static int f(int y) {",
  "  label:",
  "label: // x",
  "::foo()",
  "def g(self):",
  "async  def h():",
  "class K(Base):",
  "public static void main(String[] args) {",
  "  private List<Map<String, Integer>> get(int a) {",
  "    return x;",
  "    if (x) {",
  "new Foo();",
  "func (r *T) Run() error {",
  "type X struct {",
  "fn main() {",
  "pub(crate) fn x<T>() -> T {",
  "pub async fn y()",
  "impl<T> Foo for Bar {",
  "sub foo {",
  "sub foo($a) : lvalue {",
  "package Foo::Bar;",
  "=head1 NAME",
  "BEGIN {",
  "function foo() {",
  "public function bar()",
  "abstract class Z",
  "procedure Foo is",
  "PROCEDURE X",
  "  SUBROUTINE FOO(A)",
  "      END SUBROUTINE FOO",
  "\\section{Intro}",
  "\\subsubsection*{x}",
  "# Heading",
  "   ## h2",
  "    #### not",
  "[section]",
  "[a]b]",
  "<h1>Title</h1>",
  "<H2 class=x>T",
  "@article{key,",
  "@book {k",
  "(define (f x)",
  "  (defun g ()",
  "(library (foo))",
  "defmodule Foo do",
  "  defp bar(x) do",
  '  test "x" do',
  "fun foo(): Int",
  "interface Bar",
  "data class X(val a: Int)",
  ".class {",
  "a:hover {",
  "#id, .c {",
  "color: red;",
  "@media screen {",
  "/ {",
  "&node {",
  "node@0 {",
  "x = 1;",
  "foo <- function(x)",
  "f = function(a, b)",
  "MyClass = class(TObject)",
  "constructor Create;",
  "  func f() {",
  "@objc func g()",
  "init?(x: Int) {",
  "extension Foo {",
  "- (void)foo:(int)x {",
  "+ (id)new",
  "@implementation Foo",
  "classdef Foo",
  "function y = f(x)",
  "%% Section",
  "## Section",
  "namespace N {",
  "public class C : B",
  "  public async Task<int> Get(int a)",
  "    List<int> xs = new List<int>();",
  "INT:",
  "IF x THEN",
  "ext. house - day",
  "INT. ROOM",
  ".scene",
  "macro_rules! m {",
  "\tfunc tabbed()",
  "  def  spaced",
  "@@weird",
  "_under",
  "$dollar",
  "f() {",
  "function g {",
  "foo () (",
  `${"List<int> ".repeat(6)}x(`,
  `public ${"static ".repeat(10)}void f(int a)`,
  `${"List<int> ".repeat(24)};`,
  `  ${"List<int> ".repeat(24)}x`,
];

/** Two files, each function line followed by a changed line further down */
function functionLineFiles(cands: readonly string[]): [string, string] {
  let a = "";
  let b = "";
  for (const [i, c] of cands.entries()) {
    a += `${c}\n`;
    b += `${c}\n`;
    for (let k = 0; k < 7; k++) {
      a += ` f${i}.${k}\n`;
      b += ` f${i}.${k}\n`;
    }
    a += " old\n";
    b += " new\n";
    for (let k = 0; k < 4; k++) {
      a += ` g${i}.${k}\n`;
      b += ` g${i}.${k}\n`;
    }
  }
  return [a, b];
}

describe.skipIf(!hasGit)("diff drivers against git diff --no-index", () => {
  it.each(DRIVERS)("builtin driver %s finds git's function lines", (driver) => {
    dir ??= mkdtempSync(join(tmpdir(), "ud-fuzz-"));
    const [a, b] = functionLineFiles(FUNCTION_LINES);
    writeFileSync(join(dir, "fa"), a);
    writeFileSync(join(dir, "fb"), b);
    writeFileSync(join(dir, "attrs"), `* diff=${driver}\n`);
    const res = spawnSync(
      "git",
      ["-c", `core.attributesFile=${join(dir, "attrs")}`, "diff", "--no-index", "fa", "fb"],
      { cwd: dir, env: gitEnv },
    );
    const theirs = body(res.stdout).toString("latin1");
    const ours = Buffer.from(
      unifiedDiff(enc.encode(a), enc.encode(b), {
        indentHeuristic: true,
        findFunction: userdiffFindFunction(driver, undefined, BUILTINS),
      }),
    ).toString("latin1");
    expect(ours).toBe(theirs);
  });

  /** `diff.<driver>.xfuncname` / `funcname` cases: [kind, pattern, function line] */
  const CUSTOM: Array<[string, string, string]> = [
    ["xfuncname", "^(a|ab)", "abc def"],
    ["xfuncname", "(foo|foobar)", "x foobar y"],
    ["xfuncname", "^(.*)(x*)$", "hello xxx"],
    ["xfuncname", "^([a-z]+|[a-z]+[0-9]+)", "abc123 rest"],
    ["xfuncname", "^(x?)(xy)?", "xy"],
    ["funcname", "^\\(a*\\)b\\1", "aabaa end"],
    ["funcname", "^\\(fn\\|def\\) .*", "def x"],
    ["funcname", "^a\\{2\\}.*", "aab"],
    ["funcname", "*x.*", "*x y"],
    ["funcname", "^\\(ab\\)*\\1$", "ababab"],
    ["xfuncname", "\\<word\\>.*", "a word here"],
    ["xfuncname", "^[[:upper:]]+.*", "ABC"],
    ["xfuncname", "^\\s*def.*", " def x"],
    ["xfuncname", "^\\s.*", "\xa0def x"],
    ["xfuncname", "^\\w+", "\xe9abc"],
    ["xfuncname", "^[^a]+", "\xe9\xe9b"],
    ["xfuncname", "^.+", "\xff\xfe ok"],
    ["xfuncname", "^(int)?(int|integer) .*", "integer x"],
    ["xfuncname", "^a{,2}b.*", "aab"],
    ["xfuncname", "^a\\.b.*", "a.b"],
    ["xfuncname", "^[]a]+.*", "]a x"],
    ["xfuncname", "^[a\\]+.*", "a\\x"],
    ["xfuncname", "^ab|^a.*", "abcd"],
    ["xfuncname", "a**b.*", "aab x"],
    ["xfuncname", "^(a*)*(b)", "aab"],
    ["xfuncname", "(a|ab)(c|bcd)(d*)", "abcd"],
    ["xfuncname", "^([[:alpha:]]+)[[:space:]]*=", "name = 1"],
    ["xfuncname", "x(|a)", "xa"],
    ["xfuncname", "^(\\(|\\[)+.*", "([( z"],
    ["xfuncname", "!^skip\n^(.*)$", "skip this"],
    ["xfuncname", "!^skip\n^(.*)$", "keep this"],
    ["xfuncname", `^((${"List<int> ".repeat(3)})+;)`, `${"List<int> ".repeat(30)};`],
  ];

  it("runs diff.<driver>.xfuncname and funcname as glibc does (POSIX, leftmost-longest)", () => {
    dir ??= mkdtempSync(join(tmpdir(), "ud-fuzz-"));
    const mismatches: string[] = [];
    for (const [kind, pattern, line] of CUSTOM) {
      const a = `${line}\n f1\n f2\n f3\n f4\n f5\n old\n`;
      const b = `${line}\n f1\n f2\n f3\n f4\n f5\n new\n`;
      writeFileSync(join(dir, "pa"), a, "latin1");
      writeFileSync(join(dir, "pb"), b, "latin1");
      writeFileSync(join(dir, "attrs"), "* diff=cust\n");
      const res = spawnSync(
        "git",
        [
          "-c",
          `core.attributesFile=${join(dir, "attrs")}`,
          "-c",
          `diff.cust.${kind}=${pattern}`,
          "diff",
          "--no-index",
          "pa",
          "pb",
        ],
        { cwd: dir, env: gitEnv },
      );
      const theirs = body(res.stdout).toString("latin1");
      const config = (k: string) => (k === `diff.cust.${kind}` ? pattern : undefined);
      const ours = Buffer.from(
        unifiedDiff(Buffer.from(a, "latin1"), Buffer.from(b, "latin1"), {
          indentHeuristic: true,
          findFunction: userdiffFindFunction("cust", config),
        }),
      ).toString("latin1");
      if (ours !== theirs)
        mismatches.push(`${kind} ${JSON.stringify(pattern)}\n${theirs}\n${ours}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("refuses the patterns glibc refuses, as git dies on them", () => {
    dir ??= mkdtempSync(join(tmpdir(), "ud-fuzz-"));
    writeFileSync(join(dir, "pa"), "x\n old\n");
    writeFileSync(join(dir, "pb"), "x\n new\n");
    writeFileSync(join(dir, "attrs"), "* diff=cust\n");
    for (const [kind, pattern, valid] of [
      ["xfuncname", "*a", false],
      ["xfuncname", "a|*b", false],
      ["xfuncname", "(", false],
      ["xfuncname", "a{1", false],
      ["xfuncname", "[[:nope:]]", false],
      ["xfuncname", "[z-a]", false],
      ["funcname", "\\(a", false],
      ["funcname", "a**", false],
      ["xfuncname", "a**", true],
      ["xfuncname", ")", true],
      ["funcname", "*a", true],
      ["xfuncname", "x{256}", true],
    ] as const) {
      const res = spawnSync(
        "git",
        [
          "-c",
          `core.attributesFile=${join(dir, "attrs")}`,
          "-c",
          `diff.cust.${kind}=${pattern}`,
          "diff",
          "--no-index",
          "pa",
          "pb",
        ],
        { cwd: dir, env: gitEnv },
      );
      expect(`${pattern} ${res.status}`).toBe(`${pattern} ${valid ? 1 : 128}`);
      const make = () =>
        userdiffFindFunction("cust", (k) => (k === `diff.cust.${kind}` ? pattern : undefined));
      if (valid) expect(make).not.toThrow();
      else expect(make).toThrow(/Invalid regexp to look for hunk header/);
    }
  });
});
