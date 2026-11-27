/**
 * Word diff against native git (statewalker-root#324): `--word-diff[=plain|color|porcelain|none]`,
 * `--color-words[=<regex>]`, `--word-diff-regex`, `diff.wordRegex`, `diff.<driver>.wordRegex`
 * and the builtin drivers' word regexes (userdiff.c), in `git diff`, `git log -p` and
 * `git show`. Each test replays t4034-diff-words.sh, whose `pre` and `post` files become two
 * versions of one tracked file (`git diff` of the worktree instead of `--no-index`); the
 * per-language fixtures of t/t4034/ are in `fixtures/t4034-diff-words.json`. The command
 * runs on native git and on ours, comparing stdout byte for byte, the exit status and the
 * `fatal:`/`error:` lines of stderr.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";

import type { DiffTextOptions, Git, LogOutputOptions } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "";
const [major, minor] = (/(\d+)\.(\d+)/.exec(version) ?? ["", "0", "0"]).slice(1).map(Number);
const atLeast = (ma: number, mi: number) => major > ma || (major === ma && minor >= mi);
/** Behaviour that changed between git 2.43 (sandbox) and 2.5x (CI) */
const versionOptions: DiffTextOptions = {
  histogramRediff: atLeast(2, 54),
  legacyMinimal: !atLeast(2, 50),
  colorCompatibility: atLeast(2, 50) ? "2.56" : "2.43",
  driverCompatibility: atLeast(2, 50) ? "2.56" : "2.43",
};

const FIXTURES = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "t4034-diff-words.json"),
    "utf8",
  ),
) as Record<string, { pre: string; post: string }>;

let root: string | undefined;
afterAll(async () => {
  if (root) await removeTempDir(root);
}, CLEANUP_TIMEOUT);
const tmp = () => {
  root ??= mkdtempSync(join(tmpdir(), "diff-words-"));
  return root;
};
let repoCount = 0;

const PRELUDE = `
tick=1112911993
test_tick () { tick=$((tick + 60)); export GIT_COMMITTER_DATE="$tick +0000" GIT_AUTHOR_DATE="$tick +0000"; }
commit () { test_tick; git commit -q "$@"; }
`;

function sh(dir: string, script: string): void {
  execFileSync("mkdir", ["-p", dir]);
  execFileSync("bash", ["-ec", PRELUDE + script], {
    cwd: dir,
    env: nativeGitEnv(tmp()),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** t4034's setup: the diff colors it configures */
const T4034_SETUP = `
git config diff.color.old red
git config diff.color.new green
git config diff.color.func magenta
`;

/** A repository whose file `f` holds `pre` in the index and `post` in the worktree */
function prePost(pre: string, post: string, script = ""): string {
  const dir = join(tmp(), `repo-${++repoCount}`);
  execFileSync("mkdir", ["-p", dir]);
  writeFileSync(join(dir, "f"), pre);
  sh(
    dir,
    `git init -q -b main .\ngit config core.autocrlf false\n${T4034_SETUP}\ngit add f\n${script}`,
  );
  writeFileSync(join(dir, "f"), post);
  return dir;
}

interface Outcome {
  status: number;
  stdout: Buffer;
  messages: string[];
}

const messageLines = (text: string): string[] =>
  text.split("\n").filter((l) => /^(fatal|error): /.test(l));

function native(dir: string, args: string[]): Outcome {
  const res = spawnSync("git", args, { cwd: dir, env: nativeGitEnv(tmp()) });
  return {
    status: res.status ?? -1,
    stdout: res.stdout,
    messages: messageLines(res.stderr.toString()),
  };
}

async function ours(dir: string): Promise<Git> {
  return openOurs(dir, createNodeGitHostEnvironment({ env: nativeGitEnv(tmp()) }));
}

async function outcome(
  run: () => Promise<{ bytes: Uint8Array; status?: number }>,
): Promise<Outcome> {
  try {
    const { bytes, status } = await run();
    return { status: status ?? 0, stdout: Buffer.from(bytes), messages: [] };
  } catch (e) {
    const err = e as { exitCode?: number; message: string };
    if (err.exitCode === undefined) throw e;
    return { status: err.exitCode, stdout: Buffer.alloc(0), messages: messageLines(err.message) };
  }
}

function differs(label: string, theirs: Outcome, mine: Outcome): string | undefined {
  const problems: string[] = [];
  if (theirs.status !== mine.status) problems.push(`status ${theirs.status} vs ${mine.status}`);
  if (!theirs.stdout.equals(mine.stdout)) {
    const show = (b: Buffer) => JSON.stringify(b.toString()).replace(/\\n/g, "\\n\n");
    problems.push(`stdout\n--- git\n${show(theirs.stdout)}\n--- ours\n${show(mine.stdout)}`);
  }
  if (theirs.messages.join("\n") !== mine.messages.join("\n")) {
    problems.push(
      `stderr\n--- git\n${theirs.messages.join("\n")}\n--- ours\n${mine.messages.join("\n")}`,
    );
  }
  return problems.length > 0 ? `${label}: ${problems.join("\n")}` : undefined;
}

/** `git diff <args>` against our diff with `options` (and the setup of `build`) */
async function twinDiff(
  out: string[],
  dir: string,
  args: string[],
  options: DiffTextOptions,
  oldTree?: string,
): Promise<void> {
  const theirs = native(dir, ["diff", ...args]);
  const mine = await outcome(async () => {
    const git = await ours(dir);
    let d = git.diff().setOptions({ ...versionOptions, ...options });
    if (oldTree) d = d.setOldTree(oldTree);
    const bytes = await d.callBytes("patch");
    return { bytes, status: d.exitCode };
  });
  const m = differs(`git diff ${args.join(" ")}`, theirs, mine);
  if (m) out.push(m);
}

async function twinLog(
  out: string[],
  dir: string,
  args: string[],
  options: DiffTextOptions,
  output: LogOutputOptions,
): Promise<void> {
  const theirs = native(dir, ["log", ...args]);
  const mine = await outcome(async () => {
    const git = await ours(dir);
    const log = git.log().setDiffOptions({ ...versionOptions, ...options });
    return { bytes: await log.callBytes(output) };
  });
  const m = differs(`git log ${args.join(" ")}`, theirs, mine);
  if (m) out.push(m);
}

async function twinShow(
  out: string[],
  dir: string,
  args: string[],
  options: DiffTextOptions,
): Promise<void> {
  const theirs = native(dir, ["show", ...args]);
  const mine = await outcome(async () => {
    const git = await ours(dir);
    const r = await git
      .show()
      .setDiffOptions({ ...versionOptions, ...options })
      .call();
    return { bytes: r.stdout, status: r.exitCode };
  });
  const m = differs(`git show ${args.join(" ")}`, theirs, mine);
  if (m) out.push(m);
}

const PRE_SIMPLE = "h(4)\n\na = b + c\n";
const POST_SIMPLE = "h(4),hh[44]\n\na = b + c\n\naa = a\n\naeff = aeff * ( aaa )\n";

/** The word diff options of `--color-words[=<regex>]` */
const colorWords = (regex?: string): DiffTextOptions => ({
  wordDiff: "color",
  ...(regex !== undefined ? { wordDiffRegex: regex } : {}),
});

describeGit("t4034-diff-words", () => {
  it('t4034-diff-words.sh: "word diff with runs of whitespace"', async () => {
    const dir = prePost(PRE_SIMPLE, POST_SIMPLE);
    const out: string[] = [];
    await twinDiff(out, dir, ["--color-words"], colorWords());
    await twinDiff(out, dir, ["--word-diff=color"], { wordDiff: "color" });
    await twinDiff(out, dir, ["--color", "--word-diff=color"], { color: true, wordDiff: "color" });
    expect(out).toEqual([]);
  });

  it('t4034-diff-words.sh: "--word-diff=porcelain"', async () => {
    const dir = prePost(PRE_SIMPLE, POST_SIMPLE);
    const out: string[] = [];
    await twinDiff(out, dir, ["--word-diff=porcelain"], { wordDiff: "porcelain" });
    await twinDiff(out, dir, ["--word-diff=porcelain", "--color"], {
      wordDiff: "porcelain",
      color: true,
    });
    expect(out).toEqual([]);
  });

  it('t4034-diff-words.sh: "--word-diff=plain"', async () => {
    const dir = prePost(PRE_SIMPLE, POST_SIMPLE);
    const out: string[] = [];
    await twinDiff(out, dir, ["--word-diff=plain"], { wordDiff: "plain" });
    await twinDiff(out, dir, ["--word-diff"], { wordDiff: "plain" });
    await twinDiff(out, dir, ["--word-diff=plain", "--no-color"], {
      wordDiff: "plain",
      color: false,
    });
    expect(out).toEqual([]);
  });

  it('t4034-diff-words.sh: "--word-diff=plain --color"', async () => {
    const dir = prePost(PRE_SIMPLE, POST_SIMPLE);
    const out: string[] = [];
    await twinDiff(out, dir, ["--word-diff=plain", "--color"], { wordDiff: "plain", color: true });
    expect(out).toEqual([]);
  });

  it('t4034-diff-words.sh: "word diff without context"', async () => {
    const dir = prePost(PRE_SIMPLE, POST_SIMPLE);
    const out: string[] = [];
    await twinDiff(out, dir, ["--color-words", "--unified=0"], { ...colorWords(), context: 0 });
    expect(out).toEqual([]);
  });

  it('t4034-diff-words.sh: "word diff with a regular expression", "word diff with zero length matches"', async () => {
    const dir = prePost(PRE_SIMPLE, POST_SIMPLE);
    const out: string[] = [];
    await twinDiff(out, dir, ["--color-words=[a-z]+"], colorWords("[a-z]+"));
    await twinDiff(out, dir, ["--color-words=[a-z\n]*"], colorWords("[a-z\n]*"));
    expect(out).toEqual([]);
  });

  it('t4034-diff-words.sh: "set up a diff driver", "option overrides .gitattributes", "use regex supplied by driver", "set up diff.wordRegex option", "command-line overrides config", "command-line overrides config: --word-diff-regex", ".gitattributes override config", "setup: remove diff driver regex", "use configured regex"', async () => {
    const dir = prePost(
      PRE_SIMPLE,
      POST_SIMPLE,
      `git config diff.testdriver.wordRegex "[^[:space:]]"\necho "f diff=testdriver" >.gitattributes`,
    );
    const out: string[] = [];
    await twinDiff(out, dir, ["--color-words=[a-z]+"], colorWords("[a-z]+"));
    await twinDiff(out, dir, ["--color-words"], colorWords());
    sh(dir, `git config diff.wordRegex "[[:alnum:]]+"`);
    await twinDiff(out, dir, ["--color-words=[a-z]+"], colorWords("[a-z]+"));
    await twinDiff(out, dir, ["--color", "--word-diff-regex=[a-z]+"], {
      color: true,
      wordDiffRegex: "[a-z]+",
    });
    await twinDiff(out, dir, ["--color-words"], colorWords());
    sh(dir, "git config --unset diff.testdriver.wordRegex");
    await twinDiff(out, dir, ["--color-words"], colorWords());
    expect(out).toEqual([]);
  });

  it('t4034-diff-words.sh: "test parsing words for newline"', async () => {
    const dir = prePost("aaa (aaa)\n", "aaa (aaa) aaa\n");
    const out: string[] = [];
    await twinDiff(out, dir, ["--color-words=a+"], colorWords("a+"));
    expect(out).toEqual([]);
  });

  it('t4034-diff-words.sh: "test when words are only removed at the end", "--word-diff=none"', async () => {
    const dir = prePost("(:\n", "(\n");
    const out: string[] = [];
    await twinDiff(out, dir, ["--color-words=."], colorWords("."));
    await twinDiff(out, dir, ["--word-diff=plain", "--word-diff=none"], { wordDiff: "none" });
    expect(out).toEqual([]);
  });

  for (const lang of Object.keys(FIXTURES)) {
    it(`t4034-diff-words.sh: "diff driver '${lang}'"`, async () => {
      const { pre, post } = FIXTURES[lang] as { pre: string; post: string };
      const dir = prePost(pre, post, `echo "* diff=${lang}" >.gitattributes`);
      const out: string[] = [];
      await twinDiff(out, dir, ["--color-words"], colorWords());
      await twinDiff(out, dir, ["--word-diff=porcelain"], { wordDiff: "porcelain" });
      expect(out).toEqual([]);
    });
  }

  it('t4034-diff-words.sh: "word-diff with diff.sbe"', async () => {
    const dir = prePost("a\n\nb\n", "a\n\nc\n", "git config diff.suppress-blank-empty true");
    const out: string[] = [];
    await twinDiff(out, dir, ["--word-diff=plain"], { wordDiff: "plain" });
    expect(out).toEqual([]);
  });

  it('t4034-diff-words.sh: "word-diff with no newline at EOF"', async () => {
    const dir = prePost("a a a a a", "a a ab a a");
    const out: string[] = [];
    await twinDiff(out, dir, ["--word-diff=plain"], { wordDiff: "plain" });
    await twinDiff(out, dir, ["--word-diff=porcelain"], { wordDiff: "porcelain" });
    await twinDiff(out, dir, ["--color-words"], colorWords());
    expect(out).toEqual([]);
  });

  it('t4034-diff-words.sh: "setup history with two files", "wordRegex for the first file does not apply to the second"', async () => {
    const dir = join(tmp(), `repo-${++repoCount}`);
    sh(
      dir,
      `git init -q -b main .
      ${T4034_SETUP}
      echo "a b; c" >a.tex
      echo "a b; c" >z.txt
      git add a.tex z.txt
      commit -minitial
      echo "a bx; c" >a.tex
      echo "a bx; c" >z.txt
      commit -mmodified -a
      echo "*.tex diff=tex" >.gitattributes
      git config diff.tex.wordRegex "[a-z]+|."`,
    );
    const out: string[] = [];
    await twinDiff(out, dir, ["--word-diff", "HEAD~"], { wordDiff: "plain" }, "HEAD~");
    await twinDiff(out, dir, ["--color-words", "HEAD~"], colorWords(), "HEAD~");
    await twinLog(out, dir, ["-p", "--word-diff"], { wordDiff: "plain" }, { patch: true });
    await twinLog(out, dir, ["-p", "--color-words"], colorWords(), { patch: true });
    await twinLog(out, dir, ["--graph", "-p", "--color-words"], colorWords(), {
      patch: true,
      graph: true,
    });
    // not porcelain: git writes the graph's prefix only where a word hunk starts or a
    // piece's text has a newline, so most porcelain lines go without it; ours prefixes each
    await twinShow(out, dir, ["--word-diff=porcelain"], { wordDiff: "porcelain" });
    await twinShow(out, dir, ["--color-words=."], colorWords("."));
    expect(out).toEqual([]);
  });

  it('t4034-diff-words.sh: "word diff with runs of whitespace" with configured colors and --color-moved', async () => {
    const dir = prePost(
      PRE_SIMPLE,
      POST_SIMPLE,
      `git config color.diff.context "bold blue"\ngit config color.diff.frag "yellow reverse"`,
    );
    const out: string[] = [];
    await twinDiff(out, dir, ["--color-words"], colorWords());
    await twinDiff(out, dir, ["--word-diff=porcelain", "--color"], {
      wordDiff: "porcelain",
      color: true,
    });
    await twinDiff(out, dir, ["--color-words", "--color-moved"], {
      ...colorWords(),
      colorMoved: true,
    });
    expect(out).toEqual([]);
  });

  it('t4034-diff-words.sh: "word-diff with no newline at EOF" with NUL bytes under --text and a diff attribute', async () => {
    const dir = join(tmp(), `repo-${++repoCount}`);
    sh(
      dir,
      `git init -q -b main .
      ${T4034_SETUP}
      printf '\\000\\001\\002\\003a b\\n' >bin
      printf 'x\\000y keep\\nsame\\n' >gone
      printf 'p\\000q r\\n' >txt
      git add bin gone txt
      commit -minitial
      printf '\\000\\001\\002\\004a c\\n' >bin
      printf 'same\\n' >gone
      printf 'p\\000q s\\nt\\000u\\n' >txt
      commit -mmodified -a`,
    );
    const out: string[] = [];
    for (const [args, options] of [
      [["--word-diff"], { wordDiff: "plain" }],
      [["--color-words"], colorWords()],
      [["--word-diff=porcelain"], { wordDiff: "porcelain" }],
      [["--word-diff=porcelain", "--color"], { wordDiff: "porcelain", color: true }],
    ] as [string[], DiffTextOptions][]) {
      await twinDiff(
        out,
        dir,
        [...args, "--text", "HEAD~", "HEAD"],
        { ...options, text: true },
        "HEAD~",
      );
    }
    // a diff attribute makes the files text without --text
    sh(dir, `echo "* diff" >.gitattributes`);
    await twinDiff(out, dir, ["--word-diff", "HEAD~"], { wordDiff: "plain" }, "HEAD~");
    await twinDiff(out, dir, ["--color-words", "HEAD~"], colorWords(), "HEAD~");
    await twinDiff(
      out,
      dir,
      ["--word-diff=porcelain", "HEAD~"],
      { wordDiff: "porcelain" },
      "HEAD~",
    );
    await twinShow(out, dir, ["--word-diff"], { wordDiff: "plain" });
    expect(out).toEqual([]);
  });

  it('t4034-diff-words.sh: "--word-diff=none" with an unknown mode and an invalid regex', async () => {
    const dir = prePost(PRE_SIMPLE, POST_SIMPLE);
    const out: string[] = [];
    await twinDiff(out, dir, ["--word-diff=bogus"], {
      wordDiff: "bogus" as DiffTextOptions["wordDiff"],
    });
    await twinDiff(out, dir, ["--color-words=[a-"], colorWords("[a-"));
    expect(out).toEqual([]);
  });
});
