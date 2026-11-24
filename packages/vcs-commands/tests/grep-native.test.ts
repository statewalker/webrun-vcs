/**
 * `git grep` against native git: each scenario runs `git grep <args>` natively and the same
 * arguments mapped onto our GrepCommand (`grepArgs` below, git's parse-options rules), in the
 * same repository and directory, and compares stdout bytes, stderr and the exit status.
 *
 * Scenario sources: git's t/t7810-grep.sh (its fixture: file, hello.c, hello_world, ab, d0,
 * v, w, x, y, z, t/, space, hello.ps1, invalid-utf8), t/t7815-grep-binary.sh and
 * t/t7816-grep-binary-pattern.sh (the NUL patterns of a git without PCRE). `-P` patterns with
 * regex characters are compared only with a native git built without PCRE (2.56.1 here; the
 * sandbox's 2.43 has PCRE).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createFileWorktree } from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GitApiError,
  type GrepCommand,
  type GrepOptions,
  type GrepToken,
  grepNoIndex,
  grepPattern,
  grepPatternFile,
  installTextconvRunner,
  type TextconvRunner,
} from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { openRepo } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const t7810 = "t7810-grep.sh";
const t7815 = "t7815-grep-binary.sh";
const t7816 = "t7816-grep-binary-pattern.sh";
/** Combinations of the t7810 fixture no git test runs as such */
const own = "webrun-vcs (t7810-grep.sh fixture)";

let root: string;
let dir: string;

/** The test environment with `-c` settings as GIT_CONFIG_* (both twins read them). */
function envWith(config: [string, string][] = []): Record<string, string> {
  const env = nativeGitEnv(root);
  let n = Number(env.GIT_CONFIG_COUNT ?? "0");
  for (const [key, value] of config) {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

function git(args: string[], cwd = dir, input?: string | Buffer): string {
  return execFileSync("git", args, { cwd, env: envWith(), input }).toString("latin1");
}

interface Outcome {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Native `git grep`. */
function native(args: string[], cwd: string, config: [string, string][] = [], stdin?: string) {
  const r = spawnSync("git", ["grep", ...args], {
    cwd,
    env: envWith(config),
    ...(stdin !== undefined ? { input: stdin } : {}),
  });
  return {
    status: r.status,
    stdout: r.stdout.toString("latin1"),
    stderr: r.stderr.toString("latin1"),
  };
}

/** What our parse of `git grep`'s argv sets */
interface Parsed {
  options: Partial<GrepOptions>;
  tokens: GrepToken[];
  calls: ((c: GrepCommand) => void)[];
}

/** git grep's parse-options over argv (stopping at the first non-option, keeping `--`). */
function grepArgs(argv: string[], cwdDir: string, stdin?: string): Parsed {
  const tokens: GrepToken[] = [];
  const o: Partial<GrepOptions> = {};
  const rest: string[] = [];
  let i = 0;
  const readFile = (name: string) =>
    name === "-" ? Buffer.from(stdin ?? "", "latin1") : readFileSync(join(cwdDir, name));
  const takesArg = new Set(["e", "f", "A", "B", "C", "m", "O"]);
  const shortOpt = (c: string, value?: string) => {
    switch (c) {
      case "v":
        o.invert = true;
        break;
      case "i":
        o.ignoreCase = true;
        break;
      case "w":
        o.wordRegexp = true;
        break;
      case "a":
        o.binary = "text";
        break;
      case "I":
        o.binary = "nomatch";
        break;
      case "r":
        o.maxDepth = -1;
        break;
      case "E":
        o.patternType = "extended";
        break;
      case "G":
        o.patternType = "basic";
        break;
      case "F":
        o.patternType = "fixed";
        break;
      case "P":
        o.patternType = "perl";
        break;
      case "n":
        o.lineNumber = true;
        break;
      case "h":
        o.pathname = false;
        break;
      case "H":
        o.pathname = true;
        break;
      case "l":
        o.nameOnly = true;
        break;
      case "L":
        o.unmatchNameOnly = true;
        break;
      case "z":
        o.nullFollowingName = true;
        break;
      case "o":
        o.onlyMatching = true;
        break;
      case "c":
        o.count = true;
        break;
      case "p":
        o.funcname = true;
        break;
      case "W":
        o.funcbody = true;
        break;
      case "q":
        o.statusOnly = true;
        break;
      case "e":
        tokens.push(grepPattern(value as string));
        break;
      case "f":
        tokens.push(...grepPatternFile(readFile(value as string), value as string));
        break;
      case "A":
        o.postContext = Number(value);
        break;
      case "B":
        o.preContext = Number(value);
        break;
      case "C":
        o.preContext = o.postContext = Number(value);
        break;
      case "m":
        o.maxCount = Number(value);
        break;
      default:
        throw new Error(`test: unknown option -${c}`);
    }
  };
  for (; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") break;
    if (arg === "(") {
      tokens.push({ kind: "open" });
      continue;
    }
    if (arg === ")") {
      tokens.push({ kind: "close" });
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq < 0 ? undefined : arg.slice(eq + 1);
      const value = () => inline ?? (argv[++i] as string);
      switch (name) {
        case "cached":
          o.cached = true;
          break;
        case "no-index":
          o.noIndex = true;
          break;
        case "untracked":
          o.untracked = true;
          break;
        case "exclude-standard":
          o.excludeStandard = true;
          break;
        case "no-exclude-standard":
          o.excludeStandard = false;
          break;
        case "recurse-submodules":
          o.recurseSubmodules = true;
          break;
        case "invert-match":
          o.invert = true;
          break;
        case "textconv":
          o.textconv = true;
          break;
        case "no-textconv":
          o.textconv = false;
          break;
        case "recursive":
          o.maxDepth = -1;
          break;
        case "no-recursive":
          o.maxDepth = 0;
          break;
        case "max-depth":
          o.maxDepth = Number(value());
          break;
        case "extended-regexp":
          o.patternType = "extended";
          break;
        case "basic-regexp":
          o.patternType = "basic";
          break;
        case "fixed-strings":
          o.patternType = "fixed";
          break;
        case "perl-regexp":
          o.patternType = "perl";
          break;
        case "line-number":
          o.lineNumber = true;
          break;
        case "no-line-number":
          o.lineNumber = false;
          break;
        case "column":
          o.column = true;
          break;
        case "full-name":
          o.fullName = true;
          break;
        case "files-with-matches":
        case "name-only":
          o.nameOnly = true;
          break;
        case "files-without-match":
          o.unmatchNameOnly = true;
          break;
        case "null":
          o.nullFollowingName = true;
          break;
        case "only-matching":
          o.onlyMatching = true;
          break;
        case "count":
          o.count = true;
          break;
        case "color":
          o.color = inline === undefined || inline === "always";
          break;
        case "no-color":
          o.color = false;
          break;
        case "break":
          o.fileBreak = true;
          break;
        case "heading":
          o.heading = true;
          break;
        case "context":
          o.preContext = o.postContext = Number(value());
          break;
        case "threads":
          o.threads = Number(value());
          break;
        case "show-function":
          o.funcname = true;
          break;
        case "function-context":
          o.funcbody = true;
          break;
        case "and":
          tokens.push({ kind: "and" });
          break;
        case "or":
          break;
        case "not":
          tokens.push({ kind: "not" });
          break;
        case "quiet":
          o.statusOnly = true;
          break;
        case "all-match":
          o.allMatch = true;
          break;
        case "max-count":
          o.maxCount = Number(value());
          break;
        default:
          throw new Error(`test: unknown option ${arg}`);
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      if (/^-\d+$/.test(arg)) {
        o.preContext = o.postContext = Number(arg.slice(1));
        continue;
      }
      for (let k = 1; k < arg.length; k++) {
        const c = arg[k] as string;
        if (takesArg.has(c)) {
          const v = k + 1 < arg.length ? arg.slice(k + 1) : (argv[++i] as string);
          shortOpt(c, v);
          break;
        }
        shortOpt(c);
      }
      continue;
    }
    break;
  }
  rest.push(...argv.slice(i));
  // the first unrecognized non-option is the pattern
  if (tokens.length === 0 && rest[0] === "--") rest.shift();
  if (tokens.length === 0 && rest.length > 0) {
    tokens.push(grepPattern(rest.shift() as string, "command line"));
  }
  o.args = rest;
  return { options: o, tokens, calls: [] };
}

async function ours(
  args: string[],
  cwd: string,
  config: [string, string][] = [],
  stdin?: string,
  textconv?: TextconvRunner,
): Promise<Outcome> {
  try {
    const parsed = grepArgs(args, cwd, stdin);
    const g = await openRepo(root, dir, Object.fromEntries(Object.entries(envWith(config))));
    if (textconv) installTextconvRunner(g.workingCopy, textconv);
    const cmd = g.grep();
    Object.assign(cmd.options, parsed.options);
    cmd.options.tokens.push(...parsed.tokens);
    const prefix = cwd === dir ? "" : cwd.slice(dir.length + 1);
    cmd.setPrefix(prefix);
    cmd.setCompatibility(compatibility());
    const r = await cmd.call();
    return { status: r.exitCode, stdout: Buffer.from(r.output).toString("latin1"), stderr: "" };
  } catch (e) {
    if (e instanceof GitApiError) {
      return { status: e.exitCode, stdout: "", stderr: `${e.message}\n` };
    }
    throw e;
  }
}

interface Scenario {
  /** `<script>: "<title>"` of the git test it takes its inputs from */
  source: string;
  args: string[];
  /** Directory below the top */
  cwd?: string;
  config?: [string, string][];
  stdin?: string;
  /** Only against a native git without PCRE */
  perl?: boolean;
  /** Compare stderr's first line only (native adds usage text, or wording we do not track) */
  firstErrorLine?: boolean;
  textconv?: boolean;
}

let pcre = false;

/** git 2.43 or a 2.5x, from the native git on PATH */
function compatibility(): "2.43" | "2.56" {
  const v = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "";
  const m = /(\d+)\.(\d+)/.exec(v);
  return m && Number(m[1]) === 2 && Number(m[2]) < 50 ? "2.43" : "2.56";
}

const nodeTextconv: TextconvRunner = async ({ command, path, content }) => {
  const tmp = mkdtempSync(join(root, "textconv-"));
  try {
    const file = join(tmp, `XXXXXX_${basename(path)}`);
    writeFileSync(file, content);
    const res = spawnSync("sh", ["-c", `${command} "$@"`, command, file], { env: envWith() });
    if (res.status !== 0) throw new Error(`error running textconv command '${command}'`);
    return new Uint8Array(res.stdout);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

async function check(s: Scenario): Promise<void> {
  if (s.perl && pcre) return;
  const cwd = s.cwd ? join(dir, s.cwd) : dir;
  const n = native(s.args, cwd, s.config, s.stdin);
  const r = await ours(s.args, cwd, s.config, s.stdin, s.textconv ? nodeTextconv : undefined);
  const firstLine = (t: string) => t.split("\n")[0];
  const label = `${s.source} git grep ${JSON.stringify(s.args)}`;
  expect({ status: r.status, stdout: r.stdout }, label).toEqual({
    status: n.status,
    stdout: n.stdout,
  });
  if (s.firstErrorLine) expect(firstLine(r.stderr), label).toBe(firstLine(n.stderr));
  else expect(r.stderr, label).toBe(n.stderr);
}

const HELLO_C = `#include <assert.h>
#include <stdio.h>

int main(int argc, const char **argv)
{
\tprintf("Hello world.\\n");
\treturn 0;
\t/* char ?? */
}

`;

function put(path: string, content: string | Buffer): void {
  const full = join(dir, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, typeof content === "string" ? Buffer.from(content, "latin1") : content);
}

describeGit("git grep against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "grep-native-"));
    dir = join(root, "repo");
    mkdirSync(dir);
    git(["init", "-q", "-b", "main"]);
    put("hello.c", HELLO_C);
    put(
      "file",
      "foo mmap bar\nfoo_mmap bar\nfoo_mmap bar mmap\nfoo mmap bar_mmap\nfoo_mmap bar mmap baz\n",
    );
    put("hello_world", "Hello world\nHeLLo world\nHello_world\nHeLLo_world\n");
    put("ab", "a+b*c\na+bc\nabc\n");
    put("d0", "d\n0\n");
    put("v", "vvv\n");
    put("w", "ww w\n");
    put("x", "x x xx x\n");
    put("y", "y yy\n");
    put("z", "zzz\n");
    put("t/t", "test\n");
    put("t/v", "vvv\n");
    put("t/a/v", "vvv\n");
    put(
      "space",
      "line without leading space1\n\tline with leading space1\n\tline with leading space2\n\tline with leading space3\nline without leading space2\n",
    );
    put(
      "hello.ps1",
      '# No-op.\nfunction dummy() {}\n\n# Say hello.\nfunction hello() {\n  echo "Hello world."\n  echo "Hello again."\n} # hello\n\n# Still a no-op.\nfunction dummy() {}\n',
    );
    put("invalid-utf8", "\x80\nASCII\n");
    put('"unusual" pathname', "unusual\n");
    put('t/nested "unusual" pathname', "unusual\n");
    put("double-dash", "--\n->\nother\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "initial"]);
    const r = spawnSync("git", ["grep", "-P", "x+", "HEAD"], { cwd: dir, env: envWith() });
    pcre = !/not compiled with USE_LIBPCRE/.test(r.stderr.toString());
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  for (const [H, L] of [
    [["HEAD"], "HEAD"],
    [[], "in working tree"],
  ] as const) {
    const t = (title: string) => `${t7810}: "${title.replace("$L", L)}"`;
    const scenarios: Scenario[] = [
      {
        source: t("grep -w $L"),
        args: ["-n", "-w", "-e", "mmap", ...H],
        config: [["grep.linenumber", "false"]],
      },
      { source: t("grep -w $L (with --column)"), args: ["--column", "-w", "-e", "mmap", ...H] },
      {
        source: t("grep -w $L (with --column, extended OR)"),
        args: ["--column", "-w", "-e", "mmap$", "--or", "-e", "baz", ...H],
      },
      {
        source: t("grep -w $L (with --column, --invert-match)"),
        args: ["--column", "--invert-match", "-w", "-e", "baz", ...H, "--", "file"],
      },
      {
        source: t("grep $L (with --column, --invert-match, extended OR)"),
        args: [
          "--column",
          "--invert-match",
          "-e",
          "ll",
          "--or",
          "--not",
          "-e",
          "_",
          ...H,
          "--",
          "hello_world",
        ],
      },
      {
        source: t("grep $L (with --column, --invert-match, extended AND)"),
        args: [
          "--column",
          "--invert-match",
          "--not",
          "-e",
          "_",
          "--and",
          "--not",
          "-e",
          "ll",
          ...H,
          "--",
          "hello_world",
        ],
      },
      {
        source: t("grep $L (with --column, double-negation)"),
        args: [
          "--column",
          "--not",
          "(",
          "--not",
          "-e",
          "foo",
          "--or",
          "--not",
          "-e",
          "baz",
          ")",
          ...H,
          "--",
          "file",
        ],
      },
      {
        source: t("grep -w $L (with --column, -C)"),
        args: ["--column", "-w", "-C1", "-e", "mmap", ...H],
      },
      {
        source: t("grep -w $L (with --line-number, --column)"),
        args: ["-n", "--column", "-w", "-e", "mmap", ...H],
      },
      {
        source: t("grep -w $L (with non-extended patterns, --column)"),
        args: ["--column", "-w", "-e", "bar", "-e", "mmap", ...H],
      },
      {
        source: t("grep -w $L"),
        args: ["-w", "-e", "mmap", ...H],
        config: [["grep.linenumber", "true"]],
      },
      {
        source: t("grep -w $L"),
        args: ["--no-line-number", "-w", "-e", "mmap", ...H],
        config: [["grep.linenumber", "true"]],
      },
      { source: t("grep -w $L (w)"), args: ["-n", "-w", "-e", "^w", ...H] },
      { source: t("grep -w $L (x)"), args: ["-n", "-w", "-e", "x xx* x", ...H] },
      { source: t("grep -w $L (y-1)"), args: ["-n", "-w", "-e", "^y", ...H] },
      { source: t("grep -w $L (y-2)"), args: ["-n", "-w", "-e", "^y y", ...H] },
      { source: t("grep -w $L (z)"), args: ["-n", "-w", "-e", "^z", ...H] },
      {
        source: t("grep $L (with --column, --only-matching)"),
        args: ["--column", "-n", "-o", "-e", "mmap", ...H],
      },
      { source: t("grep $L (t-1)"), args: ["-n", "-e", "test", ...H] },
      { source: t("grep $L (t-2)"), args: ["-n", "-e", "test", ...H], cwd: "t" },
      { source: t("grep $L (t-3)"), args: ["--full-name", "-n", "-e", "test", ...H], cwd: "t" },
      { source: t("grep -c $L (no /dev/null)"), args: ["-c", "test", ...H] },
      { source: t("grep --max-depth -1 $L"), args: ["--max-depth", "-1", "-n", "-e", "vvv", ...H] },
      { source: t("grep --max-depth -1 $L"), args: ["--recursive", "-n", "-e", "vvv", ...H] },
      { source: t("grep --max-depth 0 $L"), args: ["--max-depth", "0", "-n", "-e", "vvv", ...H] },
      { source: t("grep --max-depth 0 $L"), args: ["--no-recursive", "-n", "-e", "vvv", ...H] },
      {
        source: t("grep --max-depth 0 -- '*' $L"),
        args: ["--max-depth", "0", "-n", "-e", "vvv", ...H, "--", "*"],
      },
      { source: t("grep --max-depth 1 $L"), args: ["--max-depth", "1", "-n", "-e", "vvv", ...H] },
      {
        source: t("grep --max-depth 0 -- t $L"),
        args: ["--max-depth", "0", "-n", "-e", "vvv", ...H, "--", "t"],
      },
      {
        source: t("grep --max-depth 0 -- . t $L"),
        args: ["--max-depth", "0", "-n", "-e", "vvv", ...H, "--", ".", "t"],
      },
      {
        source: t("grep --max-depth 0 -- t . $L"),
        args: ["--no-recursive", "-n", "-e", "vvv", ...H, "--", "t", "."],
      },
      {
        source: t("grep $L with grep.patterntype=perl errors without PCRE"),
        args: ["foo.*bar", ...H],
        config: [["grep.patterntype", "perl"]],
        perl: true,
      },
      { source: t("grep --count $L"), args: ["--count", "-e", "b", ...H, "--", "ab"] },
      { source: t("grep --count -h $L"), args: ["--count", "-h", "-e", "b", ...H, "--", "ab"] },
      {
        source: t("grep $L searches past invalid lines on UTF-8 locale"),
        args: ["A.", "invalid-utf8"],
      },
      { source: t("grep $L should quote unusual pathnames"), args: ["unusual", ...H] },
      {
        source: t("grep $L in subdir should quote unusual relative pathnames"),
        args: ["unusual", ...H],
        cwd: "t",
      },
      { source: t("grep -z $L with unusual pathnames"), args: ["-z", "unusual", ...H] },
      {
        source: t("grep -z $L in subdir with unusual relative pathnames"),
        args: ["-z", "unusual", ...H],
        cwd: "t",
      },
    ];
    // test_pattern_type
    const types: [string, [string, string][]][] = [
      ["BRE", [["grep.extendedRegexp", "false"]]],
      ["ERE", [["grep.extendedRegexp", "true"]]],
      ["BRE", [["grep.patternType", "basic"]]],
      ["ERE", [["grep.patternType", "extended"]]],
      ["FIX", [["grep.patternType", "fixed"]]],
      [
        "ERE",
        [
          ["grep.patternType", "default"],
          ["grep.extendedRegexp", "true"],
        ],
      ],
      [
        "ERE",
        [
          ["grep.extendedRegexp", "true"],
          ["grep.patternType", "default"],
        ],
      ],
      [
        "ERE",
        [
          ["grep.patternType", "extended"],
          ["grep.extendedRegexp", "false"],
        ],
      ],
      [
        "BRE",
        [
          ["grep.patternType", "basic"],
          ["grep.extendedRegexp", "true"],
        ],
      ],
      [
        "BRE",
        [
          ["grep.extendedRegexp", "true"],
          ["grep.extendedRegexp", "false"],
        ],
      ],
      [
        "ERE",
        [
          ["grep.patternType", "fixed"],
          ["grep.extendedRegexp", "true"],
          ["grep.patternType", "default"],
        ],
      ],
      [
        "BRE",
        [
          ["grep.patternType", "extended"],
          ["grep.patternType", "default"],
        ],
      ],
      [
        "FIX",
        [
          ["grep.patternType", "extended"],
          ["grep.patternType", "default"],
          ["grep.patternType", "fixed"],
        ],
      ],
    ];
    for (const [type, config] of types) {
      const cs = config.map(([k, v]) => `-c ${k}=${v}`).join(" ");
      scenarios.push({
        source: `${t7810}: "grep ${L} with '${cs}' interpreted as ${type}"`,
        args: ["a+b*c", ...H, ...(H.length ? ["--"] : []), "ab"],
        config,
      });
    }
    for (const s of scenarios) it(s.source, () => check(s));
  }

  const plain: Scenario[] = [
    { source: `${t7810}: "grep should not segfault with a bad input"`, args: ["("] },
    {
      source: `${t7810}: "invalid expression: grep --and -e A"`,
      args: ["--and", "-e", "A", "--", "nonexisting"],
    },
    { source: `${t7810}: "grep -l -C"`, args: ["-l", "-C1", "foo"] },
    { source: `${t7810}: "grep -c -C"`, args: ["-c", "-C1", "foo"] },
    { source: `${t7810}: "grep -L -C"`, args: ["-L", "-C1", "nonexistent_string"] },
    {
      source: `${t7810}: "grep --files-without-match --quiet"`,
      args: ["--files-without-match", "--quiet", "nonexistent_string"],
    },
    {
      source: `${t7810}: "grep --max-count 0 (must exit with non-zero)"`,
      args: ["--max-count", "0", "foo"],
    },
    { source: `${t7810}: "grep --max-count 3"`, args: ["--max-count", "3", "foo"] },
    { source: `${t7810}: "grep --max-count -1 (no limit)"`, args: ["--max-count", "-1", "foo"] },
    {
      source: `${t7810}: "grep --max-count 1 --context 2"`,
      args: ["--max-count", "1", "--context", "1", "foo_mmap"],
    },
    {
      source: `${t7810}: "grep --max-count 1 --show-function"`,
      args: ["--max-count", "1", "--show-function", "Hello", "hello.ps1"],
    },
    {
      source: `${t7810}: "grep --max-count 2 --show-function"`,
      args: ["--max-count", "2", "--show-function", "Hello", "hello.ps1"],
    },
    {
      source: `${t7810}: "grep --max-count 1 --count"`,
      args: ["--max-count", "1", "--count", "Hello", "hello.ps1"],
    },
    {
      source: `${t7810}: "grep --max-count 1 (multiple files)"`,
      args: ["--max-count", "1", "-e", "o", "--", "hello.*"],
    },
    {
      source: `${t7810}: "grep --max-count 1 --context 1 (multiple files)"`,
      args: ["--max-count", "1", "--context", "1", "-e", "o", "--", "hello.*"],
    },
    {
      source: `${t7810}: "grep -e A --and -e B"`,
      args: ["-e", "foo mmap", "--and", "-e", "bar_mmap"],
    },
    {
      source: `${t7810}: "grep ( -e A --or -e B ) --and -e B"`,
      args: ["(", "-e", "foo_", "--or", "-e", "baz", ")", "--and", "-e", " mmap"],
    },
    {
      source: `${t7810}: "grep -e A --and --not -e B"`,
      args: ["-e", "foo mmap", "--and", "--not", "-e", "bar_mmap"],
    },
    { source: `${t7810}: "grep should ignore GREP_OPTIONS"`, args: [" mmap bar$"] },
    { source: `${t7810}: "grep, multiple patterns"`, args: ["mmap\nvvv"] },
    {
      source: `${t7810}: "grep -f, ignore empty lines, read patterns from stdin"`,
      args: ["-f", "-"],
      stdin: "\nmmap\n\nvvv\n\n",
    },
    { source: `${t7810}: "grep -q, silently report matches"`, args: ["-q", "mmap"] },
    { source: `${t7810}: "grep -q, silently report matches"`, args: ["-q", "qfwfq"] },
    { source: `${t7810}: "grep -C1 hunk mark between files"`, args: ["-C1", "^[yz]"] },
    {
      source: `${t7810}: "grep -C1 hunk mark between files"`,
      args: ["--threads=1", "-C1", "^[yz]"],
    },
    { source: `${t7810}: "grep -p"`, args: ["-p", "return"] },
    { source: `${t7810}: "grep -p -B5"`, args: ["-p", "-B5", "return"] },
    { source: `${t7810}: "grep -W"`, args: ["-W", "return"] },
    { source: `${t7810}: "grep -W shows no trailing empty lines"`, args: ["-W", "stdio"] },
    {
      source: `${t7810}: "grep --threads=$threads & -c grep.threads=$threads"`,
      args: ["--threads=2", "."],
    },
    {
      source: `${t7810}: "grep from a subdirectory to search wider area (1)"`,
      args: ["x x x", ".."],
      cwd: "t",
    },
    {
      source: `${t7810}: "grep from a subdirectory to search wider area (2)"`,
      args: ["xxyyzz", ".."],
      cwd: "t",
    },
    { source: `${t7810}: "grep -Fi"`, args: ["-Fi", "CHAR *"] },
    { source: `${t7810}: "grep -- pattern"`, args: ["--", "->"] },
    { source: `${t7810}: "grep -- pattern -- pathspec"`, args: ["--", "->", "--", "double-dash"] },
    { source: `${t7810}: "grep -e pattern -- path"`, args: ["-e", "->", "--", "double-dash"] },
    { source: `${t7810}: "grep -e -- -- path"`, args: ["-e", "--", "--", "double-dash"] },
    { source: `${t7810}: "report bogus arg without dashdash"`, args: ["o", "does-not-exist"] },
    { source: `${t7810}: "report bogus rev with dashdash"`, args: ["o", "hello.c", "--"] },
    {
      source: `${t7810}: "grep --no-index complains of revs"`,
      args: ["--no-index", "o", "main", "--"],
    },
    {
      source: `${t7810}: "grep --no-index does not \\"diagnose\\" revs"`,
      args: ["--no-index", "o", ":1:hello.c"],
    },
    {
      source: `${t7810}: "grep --perl-regexp pattern errors without PCRE"`,
      args: ["--perl-regexp", "foo.*bar"],
      perl: true,
    },
    {
      source: `${t7810}: "grep -P pattern errors without PCRE"`,
      args: ["-P", "foo.*bar"],
      perl: true,
    },
    {
      source: `${t7810}: "grep pattern with grep.extendedRegexp=true"`,
      args: ["\\p{Ps}.*?\\p{Pe}", "hello.c"],
      config: [["grep.extendedregexp", "true"]],
    },
    { source: `${t7810}: "grep -G invalidpattern properly dies "`, args: ["-G", "a["] },
    {
      source: `${t7810}: "grep invalidpattern properly dies with grep.patternType=basic"`,
      args: ["a["],
      config: [["grep.patterntype", "basic"]],
    },
    { source: `${t7810}: "grep -E invalidpattern properly dies "`, args: ["-E", "a["] },
    {
      source: `${t7810}: "grep invalidpattern properly dies with grep.patternType=extended"`,
      args: ["a["],
      config: [["grep.patterntype", "extended"]],
    },
    { source: `${t7810}: "grep -G -E -F pattern"`, args: ["-G", "-E", "-F", "a+b*c", "ab"] },
    {
      source: `${t7810}: "grep pattern with grep.patternType=basic, =extended, =fixed"`,
      args: ["a+b*c", "ab"],
      config: [
        ["grep.patterntype", "basic"],
        ["grep.patterntype", "extended"],
        ["grep.patterntype", "fixed"],
      ],
    },
    { source: `${t7810}: "grep -E -F -G pattern"`, args: ["-E", "-F", "-G", "a+b*c", "ab"] },
    {
      source: `${t7810}: "grep pattern with grep.patternType=extended, =fixed, =basic"`,
      args: ["a+b*c", "ab"],
      config: [
        ["grep.patterntype", "extended"],
        ["grep.patterntype", "fixed"],
        ["grep.patterntype", "basic"],
      ],
    },
    { source: `${t7810}: "grep -F -G -E pattern"`, args: ["-F", "-G", "-E", "a+b*c", "ab"] },
    {
      source: `${t7810}: "grep pattern with grep.patternType=fixed, =basic, =extended"`,
      args: ["a+b*c", "ab"],
      config: [
        ["grep.patterntype", "fixed"],
        ["grep.patterntype", "basic"],
        ["grep.patterntype", "extended"],
      ],
    },
    {
      source: `${t7810}: "grep -G -F -P -E pattern"`,
      args: ["-G", "-F", "-P", "-E", "[\\d]", "d0"],
    },
    {
      source: `${t7810}: "grep pattern with grep.patternType=fixed, =basic, =perl, =extended"`,
      args: ["[\\d]", "d0"],
      config: [
        ["grep.patterntype", "fixed"],
        ["grep.patterntype", "basic"],
        ["grep.patterntype", "perl"],
        ["grep.patterntype", "extended"],
      ],
    },
    {
      source: `${t7810}: "grep -F pattern with grep.patternType=basic"`,
      args: ["-F", "*c", "ab"],
      config: [["grep.patterntype", "basic"]],
    },
    {
      source: `${t7810}: "grep -G pattern with grep.patternType=fixed"`,
      args: ["-G", "a+b", "ab"],
      config: [["grep.patterntype", "fixed"]],
    },
    {
      source: `${t7810}: "grep -E pattern with grep.patternType=fixed"`,
      args: ["-E", "a+", "ab"],
      config: [["grep.patterntype", "fixed"]],
    },
    {
      source: `${t7810}: "grep --color, separator"`,
      args: ["--color=always", "-A1", "-e", "char", "-e", "lo_w", "hello.c", "hello_world"],
      config: [
        ["color.grep.context", "normal"],
        ["color.grep.filename", "normal"],
        ["color.grep.function", "normal"],
        ["color.grep.linenumber", "normal"],
        ["color.grep.match", "normal"],
        ["color.grep.selected", "normal"],
        ["color.grep.separator", "red"],
      ],
    },
    {
      source: `${t7810}: "grep --break"`,
      args: ["--break", "-e", "char", "-e", "lo_w", "hello.c", "hello_world"],
    },
    {
      source: `${t7810}: "grep --break with context"`,
      args: ["--break", "-A1", "-e", "char", "-e", "lo_w", "hello.c", "hello_world"],
    },
    {
      source: `${t7810}: "grep --heading"`,
      args: ["--heading", "-e", "char", "-e", "lo_w", "hello.c", "hello_world"],
    },
    {
      source: `${t7810}: "mimic ack-grep --group"`,
      args: [
        "--break",
        "--heading",
        "-n",
        "--color",
        "-e",
        "char",
        "-e",
        "lo_w",
        "hello.c",
        "hello_world",
      ],
      config: [
        ["color.grep.context", "normal"],
        ["color.grep.filename", "bold green"],
        ["color.grep.function", "normal"],
        ["color.grep.linenumber", "normal"],
        ["color.grep.match", "black yellow"],
        ["color.grep.selected", "normal"],
        ["color.grep.separator", "normal"],
      ],
    },
    { source: `${t7810}: "grep -E \\"^ \\""`, args: ["-E", "^ ", "space"] },
    {
      source: `${t7810}: "grep --color -e A -e B with context"`,
      args: ["--color=always", "-C2", "-e", "with ", "-e", "space2", "space"],
      config: [
        ["color.grep.context", "normal"],
        ["color.grep.filename", "normal"],
        ["color.grep.function", "normal"],
        ["color.grep.linenumber", "normal"],
        ["color.grep.matchContext", "normal"],
        ["color.grep.matchSelected", "red"],
        ["color.grep.selected", "normal"],
        ["color.grep.separator", "normal"],
      ],
    },
    {
      source: `${t7810}: "grep --color -e A --and -e B with context"`,
      args: ["--color=always", "-C2", "-e", "with ", "--and", "-e", "space2", "space"],
      config: [
        ["color.grep.matchSelected", "red"],
        ["color.grep.matchContext", "normal"],
      ],
    },
    {
      source: `${t7810}: "grep --color -e A --and --not -e B with context"`,
      args: ["--color=always", "-C2", "-e", "with ", "--and", "--not", "-e", "space2", "space"],
      config: [["color.grep.matchSelected", "red"]],
    },
    {
      source: `${t7810}: "grep --color -e A --and -e B -p with context"`,
      args: [
        "--color=always",
        "-p",
        "-C3",
        "-e",
        "int",
        "--and",
        "-e",
        "Hello",
        "--no-index",
        "hello.c",
      ],
      config: [
        ["color.grep.matchSelected", "red"],
        ["color.grep.function", "normal"],
      ],
    },
    // more combinations of the same fixture
    { source: own, args: ["--all-match", "-e", "foo", "-e", "baz"] },
    { source: own, args: ["--all-match", "-e", "foo", "-e", "nothere"] },
    { source: `${t7810}: "grep -W"`, args: ["-W", "-n", "Hello", "hello.ps1"] },
    { source: `${t7810}: "grep -p"`, args: ["-p", "-A2", "-n", "echo", "hello.ps1"] },
    { source: own, args: ["-B2", "-A1", "-v", "-n", "mmap", "file", "hello_world"] },
    { source: own, args: ["-o", "-i", "-n", "--column", "hello", "--", "hello_world", "hello.c"] },
    { source: own, args: ["-c", "-v", "-e", "a", "--", "ab", "file"] },
    { source: own, args: ["-l", "-z", "--untracked", "o"] },
    { source: own, args: ["-E", "-e", "(foo|baz)$", "-o", "file"] },
    { source: own, args: ["(", "-e", "foo", "--and", "-e", "baz"] },
    { source: own, args: ["-e", "foo", ")"] },
    { source: own, args: ["--not"] },
    { source: own, args: ["--untracked", "--cached", "o"] },
    { source: own, args: ["--cached", "o", "HEAD"] },
    { source: own, args: ["--exclude-standard", "o"] },
    { source: own, args: ["-n", "vvv", "HEAD:t", "HEAD:t/v", "HEAD^{tree}"] },
    { source: own, args: ["vvv", "HEAD:./v"], cwd: "t" },
  ];
  for (const s of plain) it(s.source, () => check(s));

  it(`${t7810}: "grep -f, one pattern"`, async () => {
    put("pattern", "mmap\n");
    await check({ source: t7810, args: ["-f", "pattern"] });
    put("patterns", "\nmmap\n\nvvv\n\n");
    await check({ source: `${t7810}: "grep -f, ignore empty lines"`, args: ["-f", "patterns"] });
    rmSync(join(dir, "pattern"));
    rmSync(join(dir, "patterns"));
  });

  it(`${t7810}: "grep -f, use cwd relative file"`, async () => {
    put("sub/dir/file", "hit\n");
    git(["add", "sub/dir/file"]);
    put("sub/dir/pattern", "hit\n");
    put("pattern", "miss\n");
    await check({ source: t7810, args: ["-f", "pattern", "file"], cwd: "sub/dir" });
    git(["rm", "-qf", "sub/dir/file"]);
    rmSync(join(dir, "sub"), { recursive: true, force: true });
    rmSync(join(dir, "pattern"));
  });

  it(`${own}: --recurse-submodules is refused`, async () => {
    const r = await ours(["--recurse-submodules", "vvv"], dir);
    expect(r.status).toBe(128);
    expect(r.stderr).toMatch(/--recurse-submodules is not supported/);
    // --no-index ignores it, as git does
    const n = await ours(["--recurse-submodules", "--no-index", "-l", "vvv", "v"], dir);
    expect(n).toEqual({ status: 0, stdout: "v\n", stderr: "" });
  });

  it(`${t7810}: "grep with CE_VALID file"`, async () => {
    git(["update-index", "--assume-unchanged", "t/t"]);
    rmSync(join(dir, "t/t"));
    await check({ source: t7810, args: ["test"] });
    git(["update-index", "--no-assume-unchanged", "t/t"]);
    git(["checkout", "t/t"]);
  });

  it(`${t7810}: "grep -p with userdiff"`, async () => {
    const config: [string, string][] = [["diff.custom.funcname", "^#"]];
    put(".gitattributes", "hello.c diff=custom\n");
    await check({ source: t7810, args: ["-p", "return"], config });
    put(".gitattributes", "hello.ps1 diff=custom\n");
    await check({
      source: `${t7810}: "grep -W with userdiff"`,
      args: ["-W", "echo"],
      config: [["diff.custom.xfuncname", "^function .*$"]],
    });
    rmSync(join(dir, ".gitattributes"));
  });

  it(`${t7810}: "grep can find things only in the work tree"`, async () => {
    put("work-tree-only", "");
    git(["add", "work-tree-only"]);
    put("work-tree-only", "find in work tree\n");
    for (const extra of [[], ["--cached"], ["HEAD"]]) {
      await check({ source: t7810, args: ["--quiet", "find in work tree", ...extra] });
    }
    git(["rm", "-qf", "work-tree-only"]);
  });

  it(`${t7810}: "grep can find things only in the work tree (i-t-a)"`, async () => {
    put("intend-to-add", "intend to add this\n");
    git(["add", "-N", "intend-to-add"]);
    for (const extra of [[], ["--cached"], ["HEAD"]]) {
      await check({ source: t7810, args: ["--quiet", "intend to add this", ...extra] });
    }
    await check({
      source: `${t7810}: "grep does not report i-t-a with -L --cached"`,
      args: ["-L", "--cached", "nonexistent_string"],
    });
    git(["update-index", "--assume-unchanged", "intend-to-add"]);
    await check({
      source: `${t7810}: "grep does not search work tree with assume unchanged"`,
      args: ["--quiet", "intend to add this"],
    });
    await check({
      source: `${t7810}: "grep does not report i-t-a and assume unchanged with -L"`,
      args: ["-L", "nonexistent_string"],
    });
    git(["rm", "-qf", "intend-to-add"]);
  });

  it(`${t7810}: "grep can find things only in the index"`, async () => {
    put("cache-this", "only in the index\n");
    git(["add", "cache-this"]);
    rmSync(join(dir, "cache-this"));
    for (const extra of [[], ["--cached"], ["HEAD"]]) {
      await check({ source: t7810, args: ["--quiet", "only in the index", ...extra] });
    }
    git(["rm", "-q", "--cached", "cache-this"]);
  });

  it(`${t7810}: "dashdash disambiguates rev as rev"`, async () => {
    put("main", "content\n");
    await check({ source: t7810, args: ["-l", "o", "main", "--", "hello.c"] });
    await check({
      source: `${t7810}: "grep --no-index prefers paths to revs"`,
      args: ["--no-index", "o", "main"],
    });
    // without `--`, main is both a revision and a file
    await check({ source: t7810, args: ["-l", "o", "main"] });
    git(["add", "main"]);
    await check({
      source: `${t7810}: "dashdash disambiguates pathspec as pathspec"`,
      args: ["o", "--", "main"],
    });
    git(["rm", "-qf", "main"]);
  });

  it(`${t7810}: "allow non-existent path with dashdash"`, async () => {
    const ls = git(["ls-tree", "HEAD"]).replace("hello.c", "not-in-working-tree");
    const tree = git(["mktree"], dir, ls).trim();
    await check({ source: t7810, args: ["o", tree, "--", "not-in-working-tree"] });
  });

  it(`${t7810}: "inside git repository but with --no-index"`, async () => {
    const is = join(root, "is");
    mkdirSync(join(is, "sub"), { recursive: true });
    writeFileSync(join(is, "file1"), "hello\n");
    writeFileSync(join(is, "sub/file2"), "world\n");
    writeFileSync(join(is, ".gitignore"), ".*o*\n");
    git(["init", "-q"], is);
    const saved = dir;
    dir = is;
    try {
      for (const cwd of [undefined, "sub"]) {
        await check({ source: t7810, args: ["o"], cwd });
        await check({ source: t7810, args: ["--untracked", "o"], cwd });
        await check({ source: t7810, args: ["--no-index", "o"], cwd });
        await check({ source: t7810, args: ["--no-index", "--exclude-standard", "o"], cwd });
      }
    } finally {
      dir = saved;
    }
  });

  it(`${t7810}: "grep --no-index descends into repos, but not .git"`, async () => {
    const top = join(root, "non-desc");
    mkdirSync(join(top, "repo"), { recursive: true });
    writeFileSync(join(top, "file"), "magic\n");
    git(["init", "-q"], join(top, "repo"));
    writeFileSync(join(top, "repo/file"), "magic\n");
    writeFileSync(join(top, "repo/.git/file"), "magic\n");
    const n = spawnSync("git", ["grep", "-l", "--no-index", "magic"], {
      cwd: top,
      env: { ...envWith(), GIT_CEILING_DIRECTORIES: root },
    });
    const r = await noIndex(top, ["-l", "magic"]);
    expect(r.stdout).toBe(n.stdout.toString("latin1"));
    expect(r.status).toBe(n.status);
  });

  it(`${t7810}: "outside of git repository"`, async () => {
    const top = join(root, "non", "git");
    mkdirSync(join(top, "sub"), { recursive: true });
    writeFileSync(join(top, "file1"), "hello\n");
    writeFileSync(join(top, "sub/file2"), "world\n");
    const run = async (args: string[], cwd = "") => {
      const n = spawnSync("git", ["grep", "--no-index", ...args], {
        cwd: join(top, cwd),
        env: { ...envWith(), GIT_CEILING_DIRECTORIES: join(root, "non") },
      });
      const r = await noIndex(top, args, cwd);
      expect({ out: r.stdout, err: r.stderr, status: r.status }, args.join(" ")).toEqual({
        out: n.stdout.toString("latin1"),
        err: n.stderr.toString("latin1"),
        status: n.status,
      });
    };
    await run(["o"]);
    await run(["o"], "sub");
    writeFileSync(join(top, ".gitignore"), ".*o*\n");
    await run(["--exclude-standard", "o"]);
    await run(["--no-exclude-standard", "o"]);
    await run(["o", "--", "file1"]);
    await run(["search", ".."]);
  });

  describe("binary files", () => {
    beforeAll(() => {
      put("a", Buffer.from("binary\0file\0m[*]c\0*æ\0ð\n", "latin1"));
      git(["add", "a"]);
      git(["commit", "-q", "-m", "binary"]);
    });

    const bin: Scenario[] = [
      { source: `${t7815}: "git grep ina a"`, args: ["ina", "a"] },
      { source: `${t7815}: "git grep -ah ina a"`, args: ["-ah", "ina", "a"] },
      { source: `${t7815}: "git grep -I ina a"`, args: ["-I", "ina", "a"] },
      { source: `${t7815}: "git grep -c ina a"`, args: ["-c", "ina", "a"] },
      { source: `${t7815}: "git grep -l ina a"`, args: ["-l", "ina", "a"] },
      { source: `${t7815}: "git grep -L bar a"`, args: ["-L", "bar", "a"] },
      { source: `${t7815}: "git grep -q ina a"`, args: ["-q", "ina", "a"] },
      { source: `${t7815}: "git grep -F ile a"`, args: ["-F", "ile", "a"] },
      { source: `${t7815}: "git grep -Fi iLE a"`, args: ["-Fi", "iLE", "a"] },
      { source: `${t7815}: "git grep ile a"`, args: ["ile", "a"] },
      { source: `${t7815}: "git grep .fi a"`, args: [".fi", "a"] },
      { source: `${t7815}: "git grep ina a"`, args: ["-C1", "ina", "--", "a", "file"] },
    ];
    for (const s of bin) it(s.source, () => check(s));

    it(`${t7815}: "grep respects binary diff attribute"`, async () => {
      put("t2", "text\n");
      git(["add", "t2"]);
      await check({ source: t7815, args: ["text", "t2"] });
      put(".gitattributes", "t2 -diff\n");
      await check({ source: t7815, args: ["text", "t2"] });
      await check({
        source: `${t7815}: "grep --cached respects binary diff attribute"`,
        args: ["--cached", "text", "t2"],
      });
      git(["add", ".gitattributes"]);
      rmSync(join(dir, ".gitattributes"));
      await check({
        source: `${t7815}: "grep --cached respects binary diff attribute (2)"`,
        args: ["--cached", "text", "t2"],
      });
      git(["checkout", ".gitattributes"]);
      git(["commit", "-q", "-m", "new"]);
      await check({
        source: `${t7815}: "grep revision respects binary diff attribute"`,
        args: ["text", "HEAD", "--", "t2"],
      });
      git(["reset", "-q", "HEAD^"]);
      put("b", Buffer.from("bin\0ary\n", "latin1"));
      git(["add", "b"]);
      await check({
        source: `${t7815}: "grep respects not-binary diff attribute"`,
        args: ["bin", "b"],
      });
      put(".gitattributes", "b diff\n");
      await check({
        source: `${t7815}: "grep respects not-binary diff attribute"`,
        args: ["bin", "b"],
      });
      rmSync(join(dir, ".gitattributes"));
      git(["rm", "-qf", "b"]);
      rmSync(join(dir, "t2"));
    });

    it(`${t7815}: "setup textconv filters"`, async () => {
      const script = join(root, "nul_to_q_textconv");
      writeFileSync(script, '#!/bin/sh\ntr "\\000" "Q" <"$1"\n', { mode: 0o755 });
      put(".gitattributes", "a diff=foo\n");
      const config: [string, string][] = [["diff.foo.textconv", `"${script}"`]];
      await check({
        source: `${t7815}: "grep does not honor textconv"`,
        args: ["Qfile"],
        config,
        textconv: true,
      });
      await check({
        source: `${t7815}: "grep --textconv honors textconv"`,
        args: ["--textconv", "Qfile"],
        config,
        textconv: true,
      });
      await check({
        source: `${t7815}: "grep --no-textconv does not honor textconv"`,
        args: ["--no-textconv", "Qfile"],
        config,
        textconv: true,
      });
      await check({
        source: `${t7815}: "grep --textconv blob honors textconv"`,
        args: ["--textconv", "Qfile", "HEAD:a"],
        config,
        textconv: true,
      });
      rmSync(join(dir, ".gitattributes"));
    });

    // t7816: every NUL pattern dies in a git without PCRE (the "P" column)
    const nul: [string, string][] = [
      ["-F", "yQf"],
      ["-Fi", "YQf"],
      ["", "yQf"],
      ["", "yQx"],
      ["", "æQð"],
      ["-F", "eQm[*]c"],
      ["-i", "[æ]Qð"],
      ["", "eQm.*cQ"],
      ["-i", "NOMATCHQð"],
      ["", "QNOMATCH"],
    ];
    for (const [flags, pattern] of nul) {
      const human = pattern.replace(/Q/g, "<NUL>");
      it(`${t7816}: "error, PCRE v2 only: LC_ALL='C' git grep -f f ${flags} '${human}' a"`, async () => {
        put("f", Buffer.from(pattern.replace(/Q/g, "\0"), "latin1"));
        await check({ source: t7816, args: ["-f", "f", ...(flags ? [flags] : []), "a"] });
        rmSync(join(dir, "f"));
      });
    }
  });
});

/** grepNoIndex over `top` (a FileWorktree there), from `cwd` below it */
async function noIndex(top: string, args: string[], cwd = ""): Promise<Outcome> {
  try {
    const files = createNodeFilesApi({ rootDir: top });
    const worktree = createFileWorktree({
      files,
      rootPath: "",
      blobs: {} as never,
      trees: {} as never,
    });
    const parsed = grepArgs(args, join(top, cwd));
    const r = await grepNoIndex(worktree, {
      ...parsed.options,
      compatibility: compatibility(),
      tokens: parsed.tokens,
      prefix: cwd ? `${cwd}/` : "",
    });
    return { status: r.exitCode, stdout: Buffer.from(r.output).toString("latin1"), stderr: "" };
  } catch (e) {
    if (e instanceof GitApiError) {
      return { status: e.exitCode, stdout: "", stderr: `${e.message}\n` };
    }
    throw e;
  }
}
