/**
 * Colored diff, log and show output against native git (statewalker-root#323): `--color`,
 * `color.ui`/`color.diff`, `color.diff.<slot>` (t4026-color's color values), whitespace
 * error highlighting (`core.whitespace`, `--ws-error-highlight`, `diff.wsErrorHighlight`)
 * and moved-line detection (`--color-moved`, `--color-moved-ws`, `diff.colorMoved`,
 * t4015-diff-whitespace's color-moved cases), in `git diff`, `git log` and `git show`. Each
 * test names the git t/ script and test it replays; the command runs on native git with
 * `--color=always` (or the configuration's `always`) and on ours, comparing stdout byte for
 * byte, the exit status and the `fatal:`/`error:` lines of stderr.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";

import type {
  DiffCommand,
  DiffTextOptions,
  Git,
  LogCommand,
  LogOutputOptions,
  ShowCommand,
} from "../src/index.js";
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
  renameCountLastSpan: atLeast(2, 50),
  namesFromContents: atLeast(2, 50),
  quietDetectsRenames: !atLeast(2, 50),
  exitCodeFromContents: atLeast(2, 50),
  colorCompatibility: atLeast(2, 50) ? "2.56" : "2.43",
};

let root: string | undefined;
afterAll(async () => {
  if (root) await removeTempDir(root);
}, CLEANUP_TIMEOUT);
const tmp = () => {
  root ??= mkdtempSync(join(tmpdir(), "diff-color-"));
  return root;
};
let repoCount = 0;

/** test-lib.sh's helpers, a clock that ticks per commit */
const PRELUDE = `
tick=1112911993
test_tick () { tick=$((tick + 60)); export GIT_COMMITTER_DATE="$tick +0000" GIT_AUTHOR_DATE="$tick +0000"; }
commit () { test_tick; git commit -q "$@"; }
test_write_lines () { printf "%s\\n" "$@"; }
q_to_tab () { tr Q '\\011'; }
`;

/** Runs a shell script (with test-lib's helpers) in `dir`, making it first. */
function sh(dir: string, script: string): string {
  execFileSync("mkdir", ["-p", dir]);
  return execFileSync("bash", ["-ec", PRELUDE + script], {
    cwd: dir,
    env: nativeGitEnv(tmp()),
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

/** A new repository on `main`, set up by `script` */
function repo(script: string): string {
  const dir = join(tmp(), `repo-${++repoCount}`);
  sh(dir, `git init -q -b main .\ngit config core.autocrlf false\n${script}`);
  return dir;
}

interface Outcome {
  status: number;
  stdout: Buffer;
  /** The `fatal:` and `error:` lines of stderr */
  messages: string[];
}

const messageLines = (text: string): string[] =>
  text.split("\n").filter((l) => /^(fatal|error): /.test(l));

/** `-c` settings of a run: given to native git and to ours as command-line config */
type CommandLineConfig = Record<string, string>;

function configEnv(config: CommandLineConfig): Record<string, string> {
  const env = nativeGitEnv(tmp());
  let n = Number(env.GIT_CONFIG_COUNT ?? "0");
  for (const [k, v] of Object.entries(config)) {
    env[`GIT_CONFIG_KEY_${n}`] = k;
    env[`GIT_CONFIG_VALUE_${n}`] = v;
    n++;
  }
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

function native(dir: string, args: string[], config: CommandLineConfig = {}): Outcome {
  const res = spawnSync("git", args, { cwd: dir, env: { ...configEnv(config), COLUMNS: "80" } });
  return {
    status: res.status ?? -1,
    stdout: res.stdout,
    messages: messageLines(res.stderr.toString()),
  };
}

async function ours(dir: string, config: CommandLineConfig = {}): Promise<Git> {
  if (Object.keys(config).length === 0) return openOurs(dir);
  return openOurs(dir, createNodeGitHostEnvironment({ env: configEnv(config) }));
}

/** What ours gave, or the error it threw as git's exit status and lines */
async function outcome(
  run: () => Promise<{ bytes: Uint8Array; status?: number; stderr?: readonly string[] }>,
): Promise<Outcome> {
  try {
    const { bytes, status, stderr } = await run();
    return {
      status: status ?? 0,
      stdout: Buffer.from(bytes),
      messages: messageLines((stderr ?? []).join("\n")),
    };
  } catch (e) {
    const err = e as { exitCode?: number; message: string };
    if (err.exitCode === undefined) throw e;
    return { status: err.exitCode, stdout: Buffer.alloc(0), messages: messageLines(err.message) };
  }
}

/** The difference between two outcomes, described; undefined when they agree */
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

/** `git diff <args>` against our diff built by `build` */
async function twinDiff(
  out: string[],
  dir: string,
  args: string[],
  build: (d: DiffCommand) => DiffCommand,
  config: CommandLineConfig = {},
  format: "patch" | "stat" = "patch",
): Promise<void> {
  const theirs = native(dir, ["diff", ...args], config);
  const mine = await outcome(async () => {
    const git = await ours(dir, config);
    const d = build(git.diff().setOptions(versionOptions));
    const bytes = await d.callBytes(format);
    return { bytes, status: d.exitCode };
  });
  const m = differs(`git diff ${args.join(" ")}`, theirs, mine);
  if (m) out.push(m);
}

/** `git log <args>` against our log */
async function twinLog(
  out: string[],
  dir: string,
  args: string[],
  build: (log: LogCommand) => LogCommand,
  output: LogOutputOptions = {},
  config: CommandLineConfig = {},
): Promise<void> {
  const theirs = native(dir, ["log", ...args], config);
  const mine = await outcome(async () => {
    const git = await ours(dir, config);
    const log = build(git.log());
    return { bytes: await log.callBytes(output), stderr: log.warnings };
  });
  const m = differs(`git log ${args.join(" ")}`, theirs, mine);
  if (m) out.push(m);
}

/** `git show <args>` against our show */
async function twinShow(
  out: string[],
  dir: string,
  args: string[],
  build: (show: ShowCommand) => ShowCommand,
  config: CommandLineConfig = {},
): Promise<void> {
  const theirs = native(dir, ["show", ...args], config);
  const mine = await outcome(async () => {
    const git = await ours(dir, config);
    const r = await build(git.show()).call();
    return { bytes: r.stdout, status: r.exitCode };
  });
  const m = differs(`git show ${args.join(" ")}`, theirs, mine);
  if (m) out.push(m);
}

const COLOR: DiffTextOptions = { color: true };
/** `git diff HEAD --no-renames <args>` against ours */
const headNoRenames = (options: DiffTextOptions) => (d: DiffCommand) =>
  d.setOldTree("HEAD").setRenames(false).setOptions(options);

describeGit("t4026-color", () => {
  const valid = [
    "reset",
    "",
    "bold red",
    "brightred",
    "green brightblue",
    "red bold",
    "ul blue red",
    "blue ul red",
    "blue red ul",
    "blue bold dim ul blink reverse",
    "reset blue bold dim ul blink reverse",
    "nobold nodim noul noblink noreverse",
    "no-bold no-blink",
    "254 255 bold dim ul blink reverse",
    "#ffffff #ffffff bold nobold dim nodim italic noitalic ul noul blink noblink reverse noreverse strike nostrike",
    "0 7",
    "12 13",
    "254 bold 255",
    "#ff00ff #0f0",
    "default",
    "normal default",
    "default default no-reverse bold",
    "normal black",
    "-1 black",
  ];
  const invalid = [
    "-2",
    "256",
    "3X",
    "redX",
    "dimX",
    "#x23456",
    "#1x3456",
    "#12x456",
    "#123x56",
    "#1234x6",
    "#12345x",
    "#x23",
    "#1x3",
    "#12x",
    "#1",
    "#23",
    "#789a",
    "#bcdef",
    "#1234567",
  ];
  const setup = `
    test_write_lines a b c >f
    git add f
    commit -m one
    test_write_lines a B c d >f
  `;

  it('t4026-color.sh: "reset", "empty color is empty", "attribute before color name", "aixterm bright fg color", "aixterm bright bg color", "color name before attribute", "attr fg bg", "fg attr bg", "fg bg attr", "fg bg attr...", "reset fg bg attr...", "attr negation", "\\"no-\\" variant of negation", "long color specification", "absurdly long color specification", "0-7 are aliases for basic ANSI color names", "8-15 are aliases for aixterm color names", "256 colors", "RGB colors", "\\"default\\" foreground", "\\"normal default\\" to clear background", "\\"default\\" can be combined with attributes", "\\"normal\\" yields no color at all", "-1 is a synonym for \\"normal\\""', async () => {
    const dir = repo(setup);
    const out: string[] = [];
    for (const spec of valid) {
      // as a slot of the diff: the old lines' color
      sh(dir, `git config color.diff.old "${spec}"`);
      await twinDiff(out, dir, ["--color"], (d) => d.setOptions(COLOR));
    }
    expect(out).toEqual([]);
  });

  it('t4026-color.sh: "color too small", "color too big", "extra character after color number", "extra character after color name", "extra character after attribute", "non-hex character in RGB color", "wrong number of letters in RGB color"', async () => {
    const dir = repo(setup);
    const out: string[] = [];
    for (const spec of invalid) {
      sh(dir, `git config color.diff.new "${spec}"`);
      await twinDiff(out, dir, ["--color"], (d) => d.setOptions(COLOR));
      // from the command line
      sh(dir, "git config --unset color.diff.new");
      await twinDiff(out, dir, ["--color"], (d) => d.setOptions(COLOR), {
        "color.diff.new": spec,
      });
    }
    expect(out).toEqual([]);
  });

  it('t4026-color.sh: "unknown color slots are ignored (diff)"', async () => {
    const dir = repo(`${setup}\ngit config color.diff.nosuchslotwilleverbedefined white`);
    const out: string[] = [];
    await twinDiff(out, dir, ["--color"], (d) => d.setOptions(COLOR));
    expect(out).toEqual([]);
  });
});

describeGit("t4015-diff-whitespace", () => {
  const colors = `
    git config color.diff.plain normal
    git config color.diff.meta bold
    git config color.diff.frag cyan
    git config color.diff.func normal
    git config color.diff.old red
    git config color.diff.new green
    git config color.diff.commit yellow
    git config color.diff.whitespace blue
  `;

  it('t4015-diff-whitespace.sh: "diff that introduces a line with only tabs"', async () => {
    const dir = repo(`${colors}
      git config core.whitespace blank-at-eol
      echo "test" >x
      git add x
      commit -m initial x
      echo "{NTN}" | tr "NT" "\\n\\t" >>x
    `);
    const out: string[] = [];
    await twinDiff(out, dir, ["--color"], (d) => d.setOptions(COLOR));
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "diff that introduces and removes ws breakages"', async () => {
    const dir = repo(`${colors}
      git config core.whitespace blank-at-eol
      { echo "0. blank-at-eol "; echo "1. blank-at-eol "; } >x
      git add x
      commit -m preimage
      { echo "0. blank-at-eol "; echo "1. still-blank-at-eol "; echo "2. and a new line "; } >x
    `);
    const out: string[] = [];
    await twinDiff(out, dir, ["--color"], (d) => d.setOptions(COLOR));
    expect(out).toEqual([]);
  });

  const wsehSetup = `${colors}
    { echo "0. blank-at-eol "; echo "1. blank-at-eol "; } >x
    git add x
    commit -m preimage
    { echo "0. blank-at-eol "; echo "1. still-blank-at-eol "; echo "2. and a new line "; printf "3. and more"; } >x
    git config core.whitespace blank-at-eol,incomplete-line
  `;

  it('t4015-diff-whitespace.sh: "ws-error-highlight test setup", "test --ws-error-highlight option"', async () => {
    const dir = repo(wsehSetup);
    const out: string[] = [];
    for (const v of ["default,old", "all", "none"]) {
      await twinDiff(out, dir, ["--color", `--ws-error-highlight=${v}`], (d) =>
        d.setOptions({ color: true, wsErrorHighlight: v }),
      );
    }
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "test diff.wsErrorHighlight config"', async () => {
    const dir = repo(wsehSetup);
    const out: string[] = [];
    for (const v of ["default,old", "all", "none"]) {
      await twinDiff(out, dir, ["--color"], (d) => d.setOptions(COLOR), {
        "diff.wsErrorHighlight": v,
      });
    }
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "option overrides diff.wsErrorHighlight"', async () => {
    const dir = repo(wsehSetup);
    const out: string[] = [];
    for (const [cfg, v] of [
      ["none", "default,old"],
      ["default", "all"],
      ["all", "none"],
    ] as const) {
      await twinDiff(
        out,
        dir,
        ["--color", `--ws-error-highlight=${v}`],
        (d) => d.setOptions({ color: true, wsErrorHighlight: v }),
        { "diff.wsErrorHighlight": cfg },
      );
    }
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "detect moved code, complete file"', async () => {
    const dir = repo(`${colors}
      git config core.whitespace blank-at-eol
      printf '%s\\n' '#include<stdio.h>' 'main()' '{' 'printf("Hello World");' '}' >test.c
      git add test.c
      commit -m "add main function"
      git mv test.c main.c
      git config color.diff.oldMoved "normal red"
      git config color.diff.newMoved "normal green"
    `);
    const out: string[] = [];
    await twinDiff(
      out,
      dir,
      ["HEAD", "--color-moved=zebra", "--color", "--no-renames"],
      headNoRenames({ color: true, colorMoved: "zebra" }),
    );
    expect(out).toEqual([]);
  });

  const malicious = `${colors}
    git config core.whitespace blank-at-eol
    git config color.diff.oldMoved "normal red"
    git config color.diff.newMoved "normal green"
    git config color.diff.oldMovedAlternative "blue"
    git config color.diff.newMovedAlternative "yellow"
    q_to_tab >main.c <<-\\EOF
	#include<stdio.h>
	int stuff()
	{
	Qprintf("Hello ");
	Qprintf("World\\n");
	}

	int secure_foo(struct user *u)
	{
	Qif (!u->is_allowed_foo)
	QQreturn;
	Qfoo(u);
	}

	int main()
	{
	Qfoo();
	}
	EOF
    q_to_tab >test.c <<-\\EOF
	#include<stdio.h>
	int bar()
	{
	Qprintf("Hello World, but different\\n");
	}

	int another_function()
	{
	Qbar();
	}
	EOF
    git add main.c test.c
    commit -m "add main and test file"
    q_to_tab >main.c <<-\\EOF
	#include<stdio.h>
	int stuff()
	{
	Qprintf("Hello ");
	Qprintf("World\\n");
	}

	int main()
	{
	Qfoo();
	}
	EOF
    q_to_tab >test.c <<-\\EOF
	#include<stdio.h>
	int bar()
	{
	Qprintf("Hello World, but different\\n");
	}

	int secure_foo(struct user *u)
	{
	Qfoo(u);
	Qif (!u->is_allowed_foo)
	QQreturn;
	}

	int another_function()
	{
	Qbar();
	}
	EOF
  `;

  it('t4015-diff-whitespace.sh: "detect malicious moved code, inside file", "plain moved code, inside file"', async () => {
    const dir = repo(malicious);
    const out: string[] = [];
    for (const mode of ["zebra", "plain"]) {
      await twinDiff(
        out,
        dir,
        ["HEAD", "--no-renames", `--color-moved=${mode}`, "--color"],
        headNoRenames({ color: true, colorMoved: mode }),
      );
    }
    expect(out).toEqual([]);
  });

  const poetry = `${colors}
    git config core.whitespace blank-at-eol
    test_write_lines "long line 1" "long line 2" "long line 3" "line 4" "line 5" "line 6" "line 7" "line 8" "line 9" "line 10" "line 11" "line 12" "line 13" "long line 14" "long line 15" "long line 16" >lines.txt
    git add lines.txt
    commit -m "add poetry"
    test_write_lines "line 4" "line 5" "line 6" "line 7" "line 8" "line 9" "long line 1" "long line 2" "long line 3" "long line 14" "long line 15" "long line 16" "line 10" "line 11" "line 12" "line 13" >lines.txt
    git config color.diff.oldMoved "magenta"
    git config color.diff.newMoved "cyan"
    git config color.diff.oldMovedAlternative "blue"
    git config color.diff.newMovedAlternative "yellow"
    git config color.diff.oldMovedDimmed "normal magenta"
    git config color.diff.newMovedDimmed "normal cyan"
    git config color.diff.oldMovedAlternativeDimmed "normal blue"
    git config color.diff.newMovedAlternativeDimmed "normal yellow"
  `;

  it('t4015-diff-whitespace.sh: "detect blocks of moved code", "detect permutations inside moved code -- dimmed-zebra"', async () => {
    const dir = repo(poetry);
    const out: string[] = [];
    for (const mode of ["blocks", "dimmed-zebra", "dimmed_zebra", "default", "no"]) {
      await twinDiff(
        out,
        dir,
        ["HEAD", "--no-renames", `--color-moved=${mode}`, "--color"],
        headNoRenames({ color: true, colorMoved: mode }),
      );
    }
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "cmd option assumes configured colored-moved"', async () => {
    const dir = repo(`${poetry}\ngit config diff.colorMoved zebra`);
    const out: string[] = [];
    await twinDiff(
      out,
      dir,
      ["HEAD", "--no-renames", "--color-moved", "--color"],
      headNoRenames({ color: true, colorMoved: true }),
    );
    // the configured mode alone, and --no-color-moved over it
    await twinDiff(out, dir, ["HEAD", "--no-renames", "--color"], headNoRenames(COLOR));
    await twinDiff(
      out,
      dir,
      ["HEAD", "--no-renames", "--no-color-moved", "--color"],
      headNoRenames({ color: true, colorMoved: false }),
    );
    // without color nothing is marked
    await twinDiff(
      out,
      dir,
      ["HEAD", "--no-renames", "--color-moved"],
      headNoRenames({ colorMoved: true }),
    );
    expect(out).toEqual([]);
  });

  /** A committed old.txt replaced by new.txt (t4015's `--no-index old.txt new.txt`) */
  const oldNew = (oldText: string, newText: string) => `
    cat >f <<-\\EOF
${oldText}
	EOF
    git add f
    commit -m old
    cat >f <<-\\EOF
${newText}
	EOF
  `;
  const tabbed = (lines: string[]) => lines.map((l) => `\t${l}`).join("\n");

  it('t4015-diff-whitespace.sh: "zebra alternate color is only used when necessary"', async () => {
    const dir = repo(
      oldNew(
        tabbed([
          "line 1A should be marked as oldMoved newMovedAlternate",
          "line 1B should be marked as oldMoved newMovedAlternate",
          "unchanged",
          "line 2A should be marked as oldMoved newMovedAlternate",
          "line 2B should be marked as oldMoved newMovedAlternate",
          "line 3A should be marked as oldMovedAlternate newMoved",
          "line 3B should be marked as oldMovedAlternate newMoved",
          "unchanged",
          "line 4A should be marked as oldMoved newMovedAlternate",
          "line 4B should be marked as oldMoved newMovedAlternate",
          "line 5A should be marked as oldMovedAlternate newMoved",
          "line 5B should be marked as oldMovedAlternate newMoved",
          "line 6A should be marked as oldMoved newMoved",
          "line 6B should be marked as oldMoved newMoved",
        ]),
        tabbed([
          "  line 1A should be marked as oldMoved newMovedAlternate",
          "  line 1B should be marked as oldMoved newMovedAlternate",
          "unchanged",
          "  line 3A should be marked as oldMovedAlternate newMoved",
          "  line 3B should be marked as oldMovedAlternate newMoved",
          "  line 2A should be marked as oldMoved newMovedAlternate",
          "  line 2B should be marked as oldMoved newMovedAlternate",
          "unchanged",
          "  line 6A should be marked as oldMoved newMoved",
          "  line 6B should be marked as oldMoved newMoved",
          "    line 4A should be marked as oldMoved newMovedAlternate",
          "    line 4B should be marked as oldMoved newMovedAlternate",
          "  line 5A should be marked as oldMovedAlternate newMoved",
          "  line 5B should be marked as oldMovedAlternate newMoved",
        ]),
      ),
    );
    const out: string[] = [];
    await twinDiff(
      out,
      dir,
      ["--color", "--color-moved=zebra", "--color-moved-ws=allow-indentation-change"],
      (d) =>
        d.setOptions({
          color: true,
          colorMoved: "zebra",
          colorMovedWs: "allow-indentation-change",
        }),
    );
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "short lines of opposite sign do not get marked as moved"', async () => {
    const dir = repo(
      oldNew(
        tabbed([
          "this line should be marked as moved",
          "unchanged",
          "unchanged",
          "unchanged",
          "unchanged",
          "too short",
          "this line should be marked as oldMoved newMoved",
          "this line should be marked as oldMovedAlternate newMoved",
          "unchanged 1",
          "unchanged 2",
          "unchanged 3",
          "unchanged 4",
          "this line should be marked as oldMoved newMoved/newMovedAlternate",
        ]),
        tabbed([
          "too short",
          "unchanged",
          "unchanged",
          "this line should be marked as moved",
          "too short",
          "unchanged",
          "unchanged",
          "this line should be marked as oldMoved newMoved/newMovedAlternate",
          "unchanged 1",
          "unchanged 2",
          "this line should be marked as oldMovedAlternate newMoved",
          "this line should be marked as oldMoved newMoved/newMovedAlternate",
          "unchanged 3",
          "this line should be marked as oldMoved newMoved",
          "unchanged 4",
        ]),
      ),
    );
    const out: string[] = [];
    await twinDiff(out, dir, ["--color", "--color-moved=zebra"], (d) =>
      d.setOptions({ color: true, colorMoved: "zebra" }),
    );
    expect(out).toEqual([]);
  });

  const wsTests = `
    test_write_lines "line 1" "line 2" "line 3" "line 4" "line 5" "long line 6" "long line 7" "long line 8" "long line 9" >lines.txt
    git add lines.txt
    commit -m "add poetry"
    git config color.diff.oldMoved "magenta"
    git config color.diff.newMoved "cyan"
  `;

  it('t4015-diff-whitespace.sh: "set up whitespace tests", "move detection ignoring whitespace "', async () => {
    const dir = repo(`${wsTests}
      test_write_lines "Qlong line 6" "Qlong line 7" "Qlong line 8" "Qchanged long line 9" "line 1" "line 2" "line 3" "line 4" "line 5" | q_to_tab >lines.txt
    `);
    const out: string[] = [];
    for (const ws of [undefined, "ignore-all-space"]) {
      await twinDiff(
        out,
        dir,
        [
          "HEAD",
          "--no-renames",
          "--color-moved",
          "--color",
          ...(ws ? [`--color-moved-ws=${ws}`] : []),
        ],
        headNoRenames({ color: true, colorMoved: true, ...(ws ? { colorMovedWs: ws } : {}) }),
      );
    }
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "move detection ignoring whitespace changes"', async () => {
    const dir = repo(`${wsTests}
      test_write_lines "longQline 6" "longQline 7" "longQline 8" "long liQne 9" "line 1" "line 2" "line 3" "line 4" "line 5" | q_to_tab >lines.txt
    `);
    const out: string[] = [];
    for (const ws of [undefined, "ignore-space-change"]) {
      await twinDiff(
        out,
        dir,
        [
          "HEAD",
          "--no-renames",
          "--color-moved",
          "--color",
          ...(ws ? [`--color-moved-ws=${ws}`] : []),
        ],
        headNoRenames({ color: true, colorMoved: true, ...(ws ? { colorMovedWs: ws } : {}) }),
      );
    }
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "move detection ignoring whitespace at eol"', async () => {
    const dir = repo(`${wsTests}
      test_write_lines "long line 6Q" "long line 7Q" "long line 8Q" "longQline 9Q" "line 1" "line 2" "line 3" "line 4" "line 5" | q_to_tab >lines.txt
      git config core.whitespace -blank-at-eol
    `);
    const out: string[] = [];
    for (const ws of [undefined, "ignore-space-at-eol"]) {
      await twinDiff(
        out,
        dir,
        [
          "HEAD",
          "--no-renames",
          "--color-moved",
          "--color",
          ...(ws ? [`--color-moved-ws=${ws}`] : []),
        ],
        headNoRenames({ color: true, colorMoved: true, ...(ws ? { colorMovedWs: ws } : {}) }),
      );
    }
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "--color-moved block at end of diff output respects MIN_ALNUM_COUNT"', async () => {
    const dir = repo(`
      >bar
      test_write_lines irrelevant_line line1 >foo
      git add foo bar
      commit -m x
      test_write_lines line1 >bar
      test_write_lines irrelevant_line >foo
    `);
    const out: string[] = [];
    await twinDiff(
      out,
      dir,
      ["HEAD", "--color-moved=zebra", "--color", "--no-renames"],
      headNoRenames({ color: true, colorMoved: "zebra" }),
    );
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "--color-moved respects MIN_ALNUM_COUNT"', async () => {
    const dir = repo(`
      test_write_lines "nineteen chars 456789" irrelevant_line "twenty chars 234567890" >foo
      >bar
      git add foo bar
      commit -m x
      test_write_lines irrelevant_line >foo
      test_write_lines "twenty chars 234567890" "nineteen chars 456789" >bar
    `);
    const out: string[] = [];
    await twinDiff(
      out,
      dir,
      ["HEAD", "--color-moved=zebra", "--color", "--no-renames"],
      headNoRenames({ color: true, colorMoved: "zebra" }),
    );
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "--color-moved treats adjacent blocks as separate for MIN_ALNUM_COUNT"', async () => {
    const dir = repo(`
      test_write_lines 7charsA irrelevant_line 7charsB 7charsC >foo
      >bar
      git add foo bar
      commit -m x
      test_write_lines irrelevant_line >foo
      test_write_lines 7charsB 7charsC 7charsA >bar
    `);
    const out: string[] = [];
    await twinDiff(
      out,
      dir,
      ["HEAD", "--color-moved=zebra", "--color", "--no-renames"],
      headNoRenames({ color: true, colorMoved: "zebra" }),
    );
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "--color-moved rewinds for MIN_ALNUM_COUNT"', async () => {
    const dir = repo(`
      test_write_lines A B C one two three four five six seven D E F G H I J >file
      git add file
      test_write_lines one two A B C D E F G H I J two three four five six seven >file
    `);
    const out: string[] = [];
    await twinDiff(out, dir, ["--color-moved=zebra", "--color", "--", "file"], (d) =>
      d.setOptions({ color: true, colorMoved: "zebra" }).setPathspec(["file"]),
    );
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "only move detection ignores white spaces"', async () => {
    const dir = repo(`
      test_write_lines "a long line to exceed per-line minimum" "another long line to exceed per-line minimum" "original file" >text.txt
      git add text.txt
      commit -m "add text"
      test_write_lines "Qa long line to exceed per-line minimum" "Qanother long line to exceed per-line minimum" "new file" | q_to_tab >text.txt
    `);
    const out: string[] = [];
    await twinDiff(out, dir, ["--color", "--color-moved", "-w"], (d) =>
      d.setOptions({ color: true, colorMoved: true, ignoreWhitespace: true }),
    );
    const ws = "ignore-all-space,ignore-space-change,ignore-space-at-eol";
    await twinDiff(out, dir, ["--color", "--color-moved", `--color-moved-ws=${ws}`], (d) =>
      d.setOptions({ color: true, colorMoved: true, colorMovedWs: ws }),
    );
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "compare whitespace delta across moved blocks"', async () => {
    const dir = repo(`
      q_to_tab >text.txt <<-\\EOF
	QIndented
	QText across
	Qsome lines
	QBut! <- this stands out
	QAdjusting with
	QQdifferent starting
	Qwhite spaces
	QAnother outlier
	QQQIndented
	QQQText across
	QQQfive lines
	QQQthat has similar lines
	QQQto previous blocks, but with different indent
	QQQYetQAnotherQoutlierQ
	QLine with internal w h i t e s p a c e change
	EOF
      git add text.txt
      commit -m "add text.txt"
      q_to_tab >text.txt <<-\\EOF
	QQIndented
	QQText across
	QQsome lines
	QQQBut! <- this stands out
	Adjusting with
	Qdifferent starting
	white spaces
	AnotherQoutlier
	QQIndented
	QQText across
	QQfive lines
	QQthat has similar lines
	QQto previous blocks, but with different indent
	QQYetQAnotherQoutlier
	QLine with internal whitespace change
	EOF
    `);
    const out: string[] = [];
    await twinDiff(
      out,
      dir,
      ["--color", "--color-moved", "--color-moved-ws=allow-indentation-change"],
      (d) =>
        d.setOptions({ color: true, colorMoved: true, colorMovedWs: "allow-indentation-change" }),
    );
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "compare mixed whitespace delta across moved blocks"', async () => {
    const dir = repo(`
      tr "^|Q_" "\\f\\v\\t " >text.txt <<-EOF
	^__
	|____too short without
	^
	___being grouped across blank line

	context
	lines
	to
	anchor
	____Indented text to
	_Q____be further indented by four spaces across
	____Qseveral lines
	QQ____These two lines have had their
	____indentation reduced by four spaces
	Qdifferent indentation change
	____too short
	EOF
      git add text.txt
      commit -m "add text.txt"
      tr "^|Q_" "\\f\\v\\t " >text.txt <<-EOF
	context
	lines
	to
	anchor
	QIndented text to
	QQbe further indented by four spaces across
	Q____several lines

	QQtoo short without

	^Q_______being grouped across blank line

	Q_QThese two lines have had their
	indentation reduced by four spaces
	QQdifferent indentation change
	__Qtoo short
	EOF
    `);
    const out: string[] = [];
    await twinDiff(
      out,
      dir,
      [
        "--color",
        "--color-moved",
        "--ws-error-highlight=all",
        "--color-moved-ws=allow-indentation-change",
      ],
      (d) =>
        d.setOptions({
          color: true,
          colorMoved: true,
          wsErrorHighlight: "all",
          colorMovedWs: "allow-indentation-change",
        }),
      { "color.diff.whitespace": "normal red", "core.whitespace": "space-before-tab" },
    );
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "bogus settings in move detection erroring out", "compare whitespace delta incompatible with other space options"', async () => {
    const dir = repo(`
      test_write_lines a >f
      git add f
      commit -m one
    `);
    const out: string[] = [];
    await twinDiff(out, dir, ["--color-moved=bogus"], (d) => d.setOptions({ colorMoved: "bogus" }));
    await twinDiff(out, dir, [], (d) => d, { "diff.colormoved": "bogus" });
    await twinDiff(out, dir, ["--color-moved-ws=bogus"], (d) =>
      d.setOptions({ colorMovedWs: "bogus" }),
    );
    await twinDiff(out, dir, [], (d) => d, { "diff.colormovedws": "bogus" });
    const both = "allow-indentation-change,ignore-all-space";
    await twinDiff(out, dir, [`--color-moved-ws=${both}`], (d) =>
      d.setOptions({ colorMovedWs: both }),
    );
    await twinDiff(out, dir, ["--ws-error-highlight=bogus"], (d) =>
      d.setOptions({ wsErrorHighlight: "bogus" }),
    );
    // a bad color slot value from a file and from the command line
    sh(dir, "git config color.diff.old foo");
    await twinDiff(out, dir, ["--color"], (d) => d.setOptions(COLOR));
    sh(dir, "git config --unset color.diff.old");
    await twinDiff(out, dir, ["--color"], (d) => d.setOptions(COLOR), {
      "color.diff.old": "foo",
    });
    expect(out).toEqual([]);
  });
});

describeGit("color.ui, color.diff and --color (t4026-color, t4015-diff-whitespace)", () => {
  const setup = `
    printf 'int f()\\n{\\n  a;\\n  b;\\n}\\n' >x.c
    test_write_lines one two three >y
    git add x.c y
    commit -m one
    printf 'int f()\\n{\\n  a; \\n \\tc;\\n}\\n\\n' >x.c
    git mv y z
    echo four >>z
  `;

  it('t4015-diff-whitespace.sh: "setup diff colors" with color.ui, color.diff and diff.color', async () => {
    const dir = repo(setup);
    const out: string[] = [];
    const cases: [CommandLineConfig, string[], DiffTextOptions][] = [
      [{}, [], {}],
      [{ "color.ui": "always" }, [], {}],
      [{ "color.ui": "always" }, ["--no-color"], { color: false }],
      [{ "color.ui": "never" }, ["--color"], { color: true }],
      [{ "color.ui": "always", "color.diff": "false" }, [], {}],
      [{ "color.ui": "never", "color.diff": "always" }, [], {}],
      [{ "diff.color": "always" }, [], {}],
      [{ "color.ui": "auto" }, [], {}],
      [{ "color.ui": "true" }, [], {}],
      [{}, ["--color=auto"], { color: "auto" }],
      [{}, ["--color=never"], { color: "never" }],
      [{}, ["--color=always"], { color: "always" }],
      [{ "color.diff.func": "magenta", "color.diff.frag": "bold yellow" }, ["--color"], COLOR],
      [{ "color.diff.context": "blue", "color.diff.whitespace": "reverse" }, ["--color"], COLOR],
      [{ "core.whitespace": "indent-with-non-tab,tab-in-indent" }, ["--color"], COLOR],
      [{ "core.whitespace": "-trailing-space" }, ["--color"], COLOR],
    ];
    for (const [config, args, options] of cases) {
      await twinDiff(
        out,
        dir,
        ["HEAD", ...args],
        (d) => d.setOldTree("HEAD").setOptions(options),
        config,
      );
      await twinDiff(
        out,
        dir,
        ["HEAD", "--stat", ...args],
        (d) => d.setOldTree("HEAD").setOptions(options),
        config,
        "stat",
      );
    }
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "diff that introduces a line with only tabs" through the whitespace attribute', async () => {
    const dir = repo(`${setup}
      echo "x.c whitespace=tab-in-indent" >.gitattributes
      echo "z -whitespace" >>.gitattributes
    `);
    const out: string[] = [];
    await twinDiff(out, dir, ["HEAD", "--color"], (d) => d.setOldTree("HEAD").setOptions(COLOR));
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "diff that introduces and removes ws breakages" in log -p, log --stat and show', async () => {
    const dir = repo(`${setup}
      git add -A
      commit -m two
      git tag -a -m "a tag" v1
      git config color.decorate.tag "bold blue"
    `);
    const out: string[] = [];
    for (const [args, opts] of [
      [["--color", "-p"], { patch: true }],
      [["--color", "--stat"], { stat: true }],
      [["--color", "--oneline", "--decorate"], { oneline: true, decorate: true }],
      [
        ["--color", "--decorate", "--format=%h%d %C(auto)%s"],
        { decorate: true, pretty: "tformat:%h%d %C(auto)%s" },
      ],
    ] as [string[], LogOutputOptions][]) {
      await twinLog(out, dir, args, (log) => log.setDiffOptions(COLOR), opts);
    }
    await twinLog(out, dir, ["-p"], (log) => log, { patch: true }, { "color.ui": "always" });
    await twinShow(out, dir, ["--color"], (show) => show.setDiffOptions(COLOR));
    await twinShow(out, dir, ["--color", "v1"], (show) =>
      show.setDiffOptions(COLOR).addArgument("v1"),
    );
    await twinShow(out, dir, ["--color", "HEAD^{tree}"], (show) =>
      show.setDiffOptions(COLOR).addArgument("HEAD^{tree}"),
    );
    await twinShow(out, dir, ["--color-moved", "--color", "HEAD"], (show) =>
      show.setDiffOptions({ color: true, colorMoved: true }).addArgument("HEAD"),
    );
    expect(out).toEqual([]);
  });
});

describeGit("t4207-log-decoration-colors", () => {
  const setup = `
    git config diff.color.commit yellow
    git config color.decorate.branch green
    git config color.decorate.remoteBranch red
    git config color.decorate.tag "reverse bold yellow"
    git config color.decorate.stash magenta
    git config color.decorate.grafted black
    git config color.decorate.HEAD cyan
    echo A >A.t; git add A.t; commit -m A; git tag A
    git clone -q . other
    (cd other && echo A1 >A1.t && git add A1.t && commit -m A1 && git tag A1)
    git remote add -f other ./other >/dev/null 2>&1
    echo B >B.t; git add B.t; commit -m B; git tag B
    git tag v1.0
    echo >>A.t
    test_tick
    git stash save -q Changes to A.t
  `;
  const args = ["--first-parent", "--no-abbrev", "--decorate", "--oneline", "--color=always"];
  const opts: LogOutputOptions = { oneline: true, decorate: true, noAbbrev: true };

  it('t4207-log-decoration-colors.sh: "commit decorations colored correctly"', async () => {
    const dir = repo(setup);
    const out: string[] = [];
    await twinLog(
      out,
      dir,
      [...args, "--all"],
      (log) => log.setFirstParent(true).all().setDiffOptions({ color: "always" }),
      opts,
    );
    expect(out).toEqual([]);
  });

  it('t4207-log-decoration-colors.sh: "test coloring with replace-objects"', async () => {
    const dir = repo(`${setup}
      echo C >C.t; git add C.t; commit -m C; git tag C
      echo D >D.t; git add D.t; commit -m D; git tag D
      git replace HEAD~1 HEAD~2
    `);
    const out: string[] = [];
    await twinLog(
      out,
      dir,
      [...args, "HEAD"],
      (log) => log.setFirstParent(true).setDiffOptions({ color: "always" }),
      opts,
    );
    expect(out).toEqual([]);
  });
});

describeGit("combined diffs in color (t4015-diff-whitespace)", () => {
  it('t4015-diff-whitespace.sh: "combined diff with autocrlf conversion" in color, and log --cc / show of the merge', async () => {
    const dir = repo(`
      test_write_lines a b c d e >x
      git add x
      commit -m base
      git checkout -q -b side
      test_write_lines a B c d e side >x
      commit -a -m side
      git checkout -q main
      test_write_lines a b c D e main >x
      commit -a -m main
      git merge side >/dev/null 2>&1 || true
    `);
    const out: string[] = [];
    await twinDiff(out, dir, ["--color"], (d) => d.setOptions(COLOR));
    sh(dir, "test_write_lines a B c D e both >x && git commit -q -a -m merged");
    await twinLog(
      out,
      dir,
      ["--color", "--cc", "-1"],
      (log) => log.setMaxCount(1).setDiffOptions(COLOR),
      {
        patch: true,
        diffMerges: "dense-combined",
      },
    );
    await twinShow(out, dir, ["--color"], (show) => show.setDiffOptions(COLOR));
    expect(out).toEqual([]);
  });
});

describeGit("submodules in color (t4015-diff-whitespace)", () => {
  it('t4015-diff-whitespace.sh: "move detection with submodules"', async () => {
    const dir = repo(`
      git init -q -b main bananas
      echo ripe >bananas/recipe
      git -C bananas add recipe
      echo fruit >fruit.t; git add fruit.t; commit -m fruit
      (cd bananas && commit -m recipe)
      git -c protocol.file.allow=always submodule add -q ./bananas 2>/dev/null
      git add bananas
      commit -a -m "bananas are like a heavy library?"
      (cd bananas && echo more >>recipe && commit -a -m "second recipe")
      echo foul >bananas/recipe
      echo ripe >fruit.t
    `);
    const out: string[] = [];
    for (const format of ["diff", "log"] as const) {
      await twinDiff(out, dir, [`--submodule=${format}`, "--color-moved", "--color"], (d) =>
        d.setSubmoduleFormat(format).setOptions({ color: true, colorMoved: true }),
      );
      await twinDiff(out, dir, [`--submodule=${format}`, "--color"], (d) =>
        d.setSubmoduleFormat(format).setOptions(COLOR),
      );
    }
    expect(out).toEqual([]);
  });
});

describeGit("log --graph in color (t4202-log, t4214-log-graph-octopus)", () => {
  const graphOptions: LogOutputOptions = { graph: true, dateOrder: true, pretty: "tformat:%s" };
  const twinGraph = async (
    out: string[],
    dir: string,
    revs: string[],
    config: CommandLineConfig = {},
    extra: { args: string[]; output: LogOutputOptions } = { args: [], output: {} },
  ) => {
    const ids = revs.map((r) => sh(dir, `git rev-parse ${r}`).trim());
    await twinLog(
      out,
      dir,
      ["--graph", "--color=always", "--date-order", "--format=%s", ...extra.args, ...revs],
      (log) => {
        for (const id of ids) log.add(id);
        return log.setDiffOptions({ ...versionOptions, color: "always" });
      },
      { ...graphOptions, ...extra.output },
      config,
    );
  };

  const t4202Setup = `
    for n in one two three four five; do echo $n >$n; git add $n; commit -m $n; done
    git checkout -q -b side HEAD~4
    echo side-1 >1; git add 1; commit -m side-1; git tag side-1
    echo side-2 >2; git add 2; commit -m side-2; git tag side-2
    git checkout -q main
    test_tick
    git merge -q --no-edit side
  `;

  it('t4202-log.sh: "log --graph with merge with log.graphColors"', async () => {
    const dir = repo(t4202Setup);
    const out: string[] = [];
    await twinGraph(out, dir, ["main"], {
      "log.graphColors": " blue,invalid-color, cyan, red  , ",
    });
    // the default palette, and color through color.ui alone
    await twinGraph(out, dir, ["main"]);
    const ids = [sh(dir, "git rev-parse main").trim()];
    await twinLog(
      out,
      dir,
      ["--graph", "--date-order", "--format=%s", "main"],
      (log) => {
        for (const id of ids) log.add(id);
        return log.setDiffOptions(versionOptions);
      },
      graphOptions,
      { "color.ui": "always" },
    );
    // a graph with the patch and stat beside it
    await twinGraph(
      out,
      dir,
      ["main"],
      {},
      {
        args: ["--stat", "-p"],
        output: { stat: true, patch: true },
      },
    );
    expect(out).toEqual([]);
  });

  const t4214Setup = `
    test_commit () { echo "\${3:-$1}" >"\${2:-$1.t}"; git add "\${2:-$1.t}"; commit -m "$1"; git tag "\${4:-$1}"; }
    test_commit initial
    for i in 1 2 3 4; do
      git checkout -q main -b $i
      test_commit $i $i $i tag$i
    done
    git checkout -q 1 -b merge
    test_tick
    git merge -q -m octopus-merge 1 2 3 4
    git tag octopus-merge
    test_commit after-merge
    git checkout -q 1 -b L
    test_commit left
    git checkout -q 4 -b crossover
    test_commit after-4
    git checkout -q initial -b more-L
    test_commit after-initial
  `;

  it('t4214-log-graph-octopus.sh: "log --graph with tricky octopus merge with colors", "log --graph with normal octopus merge with colors", "log --graph with normal octopus and child merge with colors", "log --graph with tricky octopus merge and its child with colors", "log --graph with crossover in octopus merge with colors", "log --graph with crossover in octopus merge and its child with colors", "log --graph with unrelated commit and octopus tip with colors", "log --graph with unrelated commit and octopus child with colors"', async () => {
    const dir = repo(t4214Setup);
    const out: string[] = [];
    for (const revs of [
      ["left", "octopus-merge"],
      ["octopus-merge"],
      ["after-merge"],
      ["left", "after-merge"],
      ["after-4", "octopus-merge"],
      ["after-4", "after-merge"],
      ["after-initial", "octopus-merge"],
      ["after-initial", "after-merge"],
    ]) {
      await twinGraph(out, dir, revs);
    }
    expect(out).toEqual([]);
  });
});

describeGit("commit -v, status -v and binary --stat in color (t4015-diff-whitespace)", () => {
  const setup = (config: string) => `
    ${config}
    test_write_lines a b c >f
    printf '\\0bin' >bin.dat
    git add f bin.dat
    commit -m one
    test_write_lines a B c >f
    printf '\\0bin2' >bin.dat
    git add f
    echo d >>f
  `;

  it('t4015-diff-whitespace.sh: "setup diff colors" in the commit -v template (never colored)', async () => {
    for (const config of ["git config color.ui always", "git config color.diff always"]) {
      const theirs = repo(setup(config));
      const mine = repo(setup(config));
      // the editor leaves the template as it is: the commit is aborted, COMMIT_EDITMSG stays
      spawnSync("git", ["commit", "-v", "-v"], {
        cwd: theirs,
        env: { ...nativeGitEnv(tmp()), GIT_EDITOR: "true" },
      });
      let template = "";
      // the same identity as native git's (no `Committer:` line in the template)
      const git = await openOurs(mine, createNodeGitHostEnvironment({ env: configEnv({}) }));
      await git
        .commit()
        .setVerbose(2)
        .setEditor(async (_p, t) => {
          template = t;
          return t;
        })
        .call()
        .catch(() => undefined);
      const expected = execFileSync("cat", [join(theirs, ".git/COMMIT_EDITMSG")]).toString();
      expect(template).toBe(expected);
      expect(template).toContain("diff --git");
      expect(template).not.toContain("\x1b[");
    }
  });

  it('t4015-diff-whitespace.sh: "setup diff colors" in status -v (color.diff, not color.status)', async () => {
    const out: string[] = [];
    const cases: [string, boolean][] = [
      ["git config color.diff always", true],
      ["git config color.status always", false],
    ];
    for (const [config, whole] of cases) {
      const dir = repo(setup(config));
      for (const level of [1, 2]) {
        const args = ["status", ...Array(level).fill("-v")];
        const theirs = native(dir, args).stdout.toString();
        const git = await ours(dir);
        const mine = (await git.status().callText({ verbose: level })).text;
        // status's own lines take color.status, which ours does not color: the diff alone
        const cut = (t: string) => (whole ? t : t.slice(t.indexOf("diff --git")));
        if (cut(theirs) !== cut(mine)) {
          out.push(`${config} git ${args.join(" ")}\n--- git\n${theirs}\n--- ours\n${mine}`);
        }
      }
    }
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "whitespace changes with modification reported (diffstat)" with a binary file in color', async () => {
    const dir = repo(`${setup("")}
      git commit -q -a -m two
    `);
    const out: string[] = [];
    await twinDiff(
      out,
      dir,
      ["--color", "--stat", "HEAD~1", "HEAD"],
      (d) => d.setOldTree("HEAD~1").setNewTree("HEAD").setOptions(COLOR),
      {},
      "stat",
    );
    await twinLog(out, dir, ["--color", "--stat"], (log) => log.setDiffOptions(COLOR), {
      stat: true,
    });
    await twinShow(out, dir, ["--color", "--stat"], (show) =>
      show.setDiffOptions(COLOR).setOptions({ stat: true }),
    );
    expect(out).toEqual([]);
  });
});
