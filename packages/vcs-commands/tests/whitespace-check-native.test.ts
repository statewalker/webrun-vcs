/**
 * Whitespace errors in diffs against native git (statewalker-root#325): `git diff --check`
 * (also `log --check` and `show --check`) with its `<file>:<line>: <error>.` lines, the
 * offending lines and its exit status; the `whitespace` attribute over `core.whitespace`;
 * and the colored diff's whitespace highlighting (`--ws-error-highlight`), which shares the
 * rules with `--check` and `git apply`. Each test names the git t/ script and the tests it
 * replays; the command runs on native git and on ours, comparing stdout byte for byte, the
 * exit status and the `fatal:`/`error:` lines of stderr.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, describe, expect, it } from "vitest";

import type {
  DiffCommand,
  DiffOutputFormat,
  DiffTextOptions,
  Git,
  LogCommand,
  LogOutputOptions,
  ShowCommand,
} from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

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
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
const tmp = () => {
  root ??= mkdtempSync(join(tmpdir(), "diff-check-"));
  return root;
};
let repoCount = 0;

/** test-lib.sh's helpers, a clock that ticks per commit */
const PRELUDE = `
tick=1112911993
test_tick () { tick=$((tick + 60)); export GIT_COMMITTER_DATE="$tick +0000" GIT_AUTHOR_DATE="$tick +0000"; }
commit () { test_tick; git commit -q "$@"; }
test_write_lines () { printf "%s\\n" "$@"; }
`;

/** Runs a shell script (with test-lib's helpers) in `dir`. */
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
  const res = spawnSync("git", args, { cwd: dir, env: configEnv(config) });
  return {
    status: res.status ?? -1,
    stdout: res.stdout,
    messages: messageLines(res.stderr.toString()),
  };
}

function ours(dir: string, config: CommandLineConfig = {}): Promise<Git> {
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

/**
 * `git diff <args>` against our diff: `--check` (and `--color`, `--exit-code`, `--quiet`,
 * `--cached`, `-R`, a revision and paths) read from the arguments
 */
async function twinDiff(
  out: string[],
  dir: string,
  args: string[],
  config: CommandLineConfig = {},
): Promise<void> {
  const theirs = native(dir, ["diff", ...args], config);
  const mine = await outcome(async () => {
    const git = await ours(dir, config);
    let d: DiffCommand = git.diff().setOptions(versionOptions);
    let format: DiffOutputFormat = "patch";
    const options: DiffTextOptions = {};
    let paths = false;
    let trees = 0;
    for (const a of args) {
      if (paths) d = d.setPathspec([a]);
      else if (a === "--") paths = true;
      else if (a === "--check") format = "check";
      else if (a === "--color") options.color = true;
      else if (a === "--exit-code") d = d.setExitCode(true);
      else if (a === "--quiet") d = d.setQuiet(true);
      else if (a === "--cached") d = d.setCached(true);
      else if (a === "-R") options.reverse = true;
      else if (a === "-w") options.ignoreWhitespace = true;
      else if (a.startsWith("--ws-error-highlight=")) options.wsErrorHighlight = a.slice(21);
      else if (a.startsWith("-")) throw new Error(`unmapped ${a}`);
      else if (/^HEAD/.test(a)) d = trees++ > 0 ? d.setNewTree(a) : d.setOldTree(a);
      else d = d.setPathspec([a]);
    }
    d = d.setOptions(options);
    const bytes = await d.callBytes(format);
    return { bytes, status: d.exitCode };
  });
  const m = differs(`git diff ${args.join(" ")}`, theirs, mine);
  if (m) out.push(m);
}

/** A revision's id, as native git resolves it */
const rev = (dir: string, name: string) => sh(dir, `git rev-parse ${name}`).trim();

/** `git log <args>` against our log */
async function twinLog(
  out: string[],
  dir: string,
  args: string[],
  build: (log: LogCommand) => LogCommand,
  output: LogOutputOptions,
  config: CommandLineConfig = {},
): Promise<void> {
  const theirs = native(dir, ["log", ...args], config);
  const mine = await outcome(async () => {
    const git = await ours(dir, config);
    const log = build(git.log().setDiffOptions(versionOptions));
    const bytes = await log.callBytes(output);
    return { bytes, status: log.exitCode, stderr: log.warnings };
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
    const r = await build(git.show().setDiffOptions(versionOptions)).call();
    return { bytes: r.stdout, status: r.exitCode, stderr: r.errors };
  });
  const m = differs(`git show ${args.join(" ")}`, theirs, mine);
  if (m) out.push(m);
}

describeGit("t4019-diff-wserror", () => {
  const setup = `
    git config diff.color.whitespace "blue reverse"
    >F
    git add F
    echo "         Eight SP indent" >>F
    echo " 	HT and SP indent" >>F
    echo "With trailing SP " >>F
    echo "Carriage ReturnQ" | tr Q "\\015" >>F
    echo "No problem" >>F
    echo >>F
  `;

  it('t4019-diff-wserror.sh: "default", "default (attribute)", "default, tabwidth=10 (attribute)", "no check (attribute)", "no check, tabwidth=10 (attribute), must be irrelevant", "without -trail", "without -trail (attribute)", "without -space", "without -space (attribute)", "with indent-non-tab only", "with indent-non-tab only (attribute)", "with indent-non-tab only, tabwidth=10", "with indent-non-tab only, tabwidth=10 (attribute)", "with cr-at-eol", "with cr-at-eol (attribute)", "trailing empty lines (1)", "trailing empty lines (2)"', async () => {
    const dir = repo(setup);
    const out: string[] = [];
    for (const [core, attributes] of [
      [undefined, undefined],
      [undefined, "F whitespace"],
      ["tabwidth=10", "F whitespace"],
      [undefined, "F -whitespace"],
      ["tabwidth=10", "F -whitespace"],
      ["-trail", undefined],
      [undefined, "F whitespace=-trail"],
      ["-space", undefined],
      [undefined, "F whitespace=-space"],
      ["indent,-trailing,-space", undefined],
      [undefined, "F whitespace=indent,-trailing,-space"],
      ["indent,tabwidth=10,-trailing,-space", undefined],
      [undefined, "F whitespace=indent,-trailing,-space,tabwidth=10"],
      ["cr-at-eol", undefined],
      [undefined, "F whitespace=trailing,cr-at-eol"],
      // the attribute wins over core.whitespace
      ["indent,-trailing,-space", "F whitespace=-indent,trailing"],
      ["-trailing,-space", "F whitespace"],
      ["incomplete-line,tab-in-indent", "F whitespace=tabwidth=4"],
    ] as [string | undefined, string | undefined][]) {
      sh(
        dir,
        `${core === undefined ? "git config --unset core.whitespace || :" : `git config core.whitespace "${core}"`}
        ${attributes === undefined ? "rm -f .gitattributes" : `echo "${attributes}" >.gitattributes`}`,
      );
      await twinDiff(out, dir, ["--color"]);
      await twinDiff(out, dir, ["--check"]);
      await twinDiff(out, dir, ["--check", "--color"]);
      await twinDiff(out, dir, ["--check", "--exit-code"]);
    }
    expect(out).toEqual([]);
  });

  it('t4019-diff-wserror.sh: "checkdiff shows correct line number for trailing blank lines", "do not color trailing cr in context", "color new trailing blank lines"', async () => {
    const dir = repo(`${setup}
      printf "a\\nb\\n" >G
      git add G
      printf "x\\nx\\nx\\na\\nb\\nc\\n\\n" >G
    `);
    const out: string[] = [];
    await twinDiff(out, dir, ["--check", "--", "G"]);
    sh(dir, `echo AAAQ | tr Q "\\015" >G\ngit add G\necho BBBQ | tr Q "\\015" >>G`);
    await twinDiff(out, dir, ["--color", "G"]);
    await twinDiff(out, dir, ["--check", "G"]);
    sh(
      dir,
      `test_write_lines a b "" "" >x\ngit add x\ntest_write_lines a "" "" "" c "" "" "" "" >x`,
    );
    await twinDiff(out, dir, ["--color", "x"]);
    await twinDiff(out, dir, ["--check", "x"]);
    await twinDiff(out, dir, ["--check", "--color", "x"]);
    expect(out).toEqual([]);
  });
});

describeGit("t4015-diff-whitespace", () => {
  it('t4015-diff-whitespace.sh: "incomplete line in both pre- and post-image context", "incomplete lines on both pre- and post-image", "fix incomplete line in pre-image", "new incomplete line in post-image"', async () => {
    const out: string[] = [];
    for (const [before, after] of [
      ['(echo foo && echo baz | tr -d "\\012")', '(echo bar && echo baz | tr -d "\\012")'],
      ['echo foo | tr -d "\\012"', 'echo bar | tr -d "\\012"'],
      ['echo foo | tr -d "\\012"', "echo bar"],
      ["echo foo", 'echo bar | tr -d "\\012"'],
    ]) {
      const dir = repo(`${before} >x\ngit add x\n${after} >x`);
      for (const config of [{ "core.whitespace": "incomplete" }, {}] as CommandLineConfig[]) {
        await twinDiff(out, dir, ["--check", "x"], config);
        await twinDiff(out, dir, ["-R", "--check", "x"], config);
        await twinDiff(out, dir, ["--color", "x"], config);
        await twinDiff(out, dir, ["--color", "-R", "x"], config);
        await twinDiff(out, dir, ["--check", "--color", "-R", "x"], config);
      }
    }
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "incomplete-line error is disabled for symlinks"', async () => {
    const dir = repo("printf %s one >mylink\ngit add mylink\nrm mylink\nln -s two mylink");
    const out: string[] = [];
    const config = { "diff.color": "always", "core.whitespace": "incomplete" };
    await twinDiff(out, dir, ["--color", "mylink"], config);
    await twinDiff(out, dir, ["--color", "-R", "mylink"], config);
    await twinDiff(out, dir, ["--check", "mylink"], { "core.whitespace": "incomplete" });
    await twinDiff(out, dir, ["--check", "-R", "mylink"], { "core.whitespace": "incomplete" });
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "check mixed spaces and tabs in indent", "check mixed tabs and spaces in indent", "check with no whitespace errors", "check with trailing whitespace", "check with space before tab in indent", "--check and --exit-code are not exclusive", "--check and --quiet are not exclusive", "check staged with no whitespace errors", "check staged with trailing whitespace", "check staged with space before tab in indent", "check with no whitespace errors (diff-index)", "check with trailing whitespace (diff-index)", "check with space before tab in indent (diff-index)", "check staged with no whitespace errors (diff-index)", "check staged with trailing whitespace (diff-index)", "check staged with space before tab in indent (diff-index)", "check trailing whitespace (trailing-space: off)", "check trailing whitespace (trailing-space: on)", "check space before tab in indent (space-before-tab: off)", "check space before tab in indent (space-before-tab: on)", "check spaces as indentation (indent-with-non-tab: off)", "check spaces as indentation (indent-with-non-tab: on)", "ditto, but tabwidth=9", "check tabs and spaces as indentation (indent-with-non-tab: on)", "ditto, but tabwidth=10", "ditto, but tabwidth=20", "check tabs as indentation (tab-in-indent: off)", "check tabs as indentation (tab-in-indent: on)", "check tabs and spaces as indentation (tab-in-indent: on)", "ditto, but tabwidth=1 (must be irrelevant)", "check tab-in-indent and indent-with-non-tab conflict", "check tab-in-indent excluded from wildcard whitespace attribute", "line numbers in --check output are correct", "checkdiff detects new trailing blank lines (1)", "checkdiff detects new trailing blank lines (2)", "checkdiff allows new blank lines"', async () => {
    const dir = repo('echo "foo();" >x\ngit add x\ncommit -m initial');
    const out: string[] = [];
    const check = async (setup: string, args: string[] = ["--check"]) => {
      sh(dir, setup);
      await twinDiff(out, dir, args);
      if (args.length === 1) await twinDiff(out, dir, ["--check", "--color"]);
    };
    await check('echo " \t foo();" >x');
    await check('echo "\t \tfoo();" >x');
    await check('echo "foo();" >x');
    await check('echo "foo(); " >x');
    await check('echo " \tfoo();" >x');
    await check("git checkout x", ["--check", "--exit-code"]);
    await check(":", ["--check", "--quiet"]);
    await check('echo "foo(); " >x', ["--check", "--quiet"]);
    await check('echo "foo(); " >x', ["--check", "--exit-code"]);
    await check('echo "foo(); " >x', ["--check", "-w", "--exit-code"]);
    await check('echo " foo();" >x', ["--check", "-w", "--exit-code"]);
    await check(":", ["--check", "-w"]);
    await check('echo " foo(); " >x', ["--check", "-w", "--exit-code"]);
    // staged
    for (const line of ["foo();", "foo(); ", " \tfoo();"]) {
      await check(`echo "${line}" >x\ngit add x`, ["--cached", "--check"]);
      await check(":", ["--check", "HEAD"]);
      await check(":", ["--cached", "--check", "HEAD"]);
    }
    for (const [rule, line] of [
      ["-trailing-space", "foo ();   "],
      ["trailing-space", "foo ();   "],
      ["-space-before-tab", " \tfoo ();"],
      ["space-before-tab", " \tfoo ();   "],
      ["-indent-with-non-tab", "        foo ();"],
      ["indent-with-non-tab", "        foo ();"],
      ["indent-with-non-tab,tabwidth=9", "        foo ();"],
      ["indent-with-non-tab", "\t                foo ();"],
      ["indent-with-non-tab,tabwidth=10", "\t                foo ();"],
      ["indent-with-non-tab,tabwidth=20", "\t                foo ();"],
      ["-tab-in-indent", "\tfoo ();"],
      ["tab-in-indent", "\tfoo ();"],
      ["tab-in-indent", "\t                foo ();"],
      ["tab-in-indent,tabwidth=1", "\t                foo ();"],
      ["tab-in-indent,indent-with-non-tab", "foo ();"],
    ]) {
      await check(`git config core.whitespace "${rule}"\necho "${line}" >x`);
    }
    // the conflict dies in every diff (git_default_core_config)
    await check(":", ["--color"]);
    await check(":", []);
    await check("git config --unset core.whitespace\necho 'x whitespace' >.gitattributes");
    await check('echo "\t  foo ();" >x\nrm -f .gitattributes');
    await check('echo "" >x\necho "foo(); " >>x');
    await check('echo "foo();" >x\necho "" >>x');
    await check('test_write_lines a b "" "" >x\ngit add x\ntest_write_lines a "" "" "" "" >x');
    await check('git checkout x\nmv x y\n{ echo "/* This is new */"; echo ""; cat y; } >x\nrm y');
    // a conflicting whitespace attribute dies for its path only
    await check(
      `echo "x whitespace=tab-in-indent,indent-with-non-tab" >.gitattributes\necho "y  " >y\ngit add -N y`,
    );
    await check(":", ["--check", "--", "y"]);
    expect(out).toEqual([]);
  });

  it('t4015-diff-whitespace.sh: "check with no whitespace errors (diff-tree)", "check with trailing whitespace (diff-tree)", "check with space before tab in indent (diff-tree)", "check with ignored trailing whitespace attr (diff-tree)"', async () => {
    const dir = repo(`
      echo "foo();" >x
      git add x
      commit -m initial
      echo "foo();" >x
      echo "bar();" >>x
      commit -m "new commit" x
      echo "foo(); " >x
      commit -m "another commit" x
      echo " 	foo();" >x
      commit -m "yet another" x
      echo "* -whitespace" >.gitattributes
      git add .gitattributes
      echo "foo(); " >x
      git add x
      commit -m "add trailing space"
    `);
    const out: string[] = [];
    await twinLog(out, dir, ["--check"], (l) => l, { check: true });
    await twinLog(out, dir, ["--check", "--color"], (l) => l.setDiffOptions({ color: true }), {
      check: true,
    });
    await twinLog(out, dir, ["--check", "--oneline"], (l) => l, { check: true, oneline: true });
    await twinLog(out, dir, ["--check", "--stat"], (l) => l, { check: true, stat: true });
    await twinLog(out, dir, ["--check", "-p"], (l) => l, { check: true, patch: true });
    await twinLog(
      out,
      dir,
      ["--check", "HEAD~4..HEAD~2"],
      (l) => l.not(rev(dir, "HEAD~4")).add(rev(dir, "HEAD~2")),
      {
        check: true,
      },
    );
    for (const rev of ["HEAD", "HEAD~1", "HEAD~2", "HEAD~3"]) {
      await twinShow(out, dir, ["--check", rev], (s) =>
        s.setOptions({ check: true }).addArgument(rev),
      );
    }
    await twinShow(out, dir, ["--check", "HEAD~2", "HEAD~1"], (s) =>
      s.setOptions({ check: true }).addArgument("HEAD~2").addArgument("HEAD~1"),
    );
    await twinShow(out, dir, ["--check", "HEAD~3", "HEAD"], (s) =>
      s.setOptions({ check: true }).addArgument("HEAD~3").addArgument("HEAD"),
    );
    expect(out).toEqual([]);
  });
});

describeGit("t4017-diff-retval", () => {
  it('t4017-diff-retval.sh: "--check --exit-code returns 0 for no difference", "--check --exit-code returns 1 for a clean difference", "--check --exit-code returns 3 for a dirty difference", "--check with --no-pager returns 2 for dirty difference", "check should test not just the last line", "check detects leftover conflict markers", "check honors conflict marker length"', async () => {
    const dir = repo(`
      echo "1 " >a
      git add .
      commit -m zeroth
      echo 1 >a
      git add .
      commit -m first
      echo 2 >b
      git add .
      commit -a -m second
    `);
    const out: string[] = [];
    await twinDiff(out, dir, ["--check", "--exit-code"]);
    sh(dir, 'echo "good" >a');
    await twinDiff(out, dir, ["--check", "--exit-code"]);
    sh(dir, 'echo "bad   " >>a');
    await twinDiff(out, dir, ["--check", "--exit-code"]);
    await twinDiff(out, dir, ["--check"]);
    sh(dir, 'echo "" >>a');
    await twinDiff(out, dir, ["--check"]);
    sh(
      dir,
      `
      git reset -q --hard
      git checkout -q HEAD^
      echo binary >>b
      git add b
      commit -m side
      git merge main >/dev/null 2>&1 || :
      git add b
    `,
    );
    await twinDiff(out, dir, ["--cached", "--check"]);
    await twinDiff(out, dir, ["--cached", "--check", "--color"]);
    sh(
      dir,
      `
      git reset -q --hard
      echo ">>>>>>> boo" >>b
      echo "======" >>a
    `,
    );
    await twinDiff(out, dir, ["--check", "a"]);
    await twinDiff(out, dir, ["--check", "b"]);
    sh(
      dir,
      `
      git reset -q --hard
      echo ">>>>>>>> boo" >>b
      echo "========" >>a
    `,
    );
    await twinDiff(out, dir, ["--check"]);
    sh(dir, 'echo "b conflict-marker-size=8" >.gitattributes');
    await twinDiff(out, dir, ["--check", "b"]);
    await twinDiff(out, dir, ["--check", "a"]);
    for (const size of ["7", "0", "x", "-1"]) {
      sh(dir, `echo "a conflict-marker-size=${size}" >.gitattributes`);
      await twinDiff(out, dir, ["--check"]);
    }
    sh(dir, 'echo "a conflict-marker-size" >.gitattributes');
    await twinDiff(out, dir, ["--check"]);
    expect(out).toEqual([]);
  });
});

describeGit("core.whitespace dies before a command writes (git_default_core_config)", () => {
  /** Every file under `dir` (the git directory included) with its bytes' hash */
  const tree = (dir: string): string => sh(dir, "find . -type f | LC_ALL=C sort | xargs sha1sum");
  const base = () =>
    repo(`
      echo one >a
      echo two >b
      git add a b
      commit -m one
      git checkout -q -b side
      echo side >c
      git add c
      commit -m side
      git checkout -q main
      echo three >>a
      git add a
      echo four >>b
    `);
  type Run = (git: Git) => Promise<unknown>;
  const cases: [string[], Run][] = [
    [["stash", "push", "--staged"], (g) => g.stashCreate().setStaged(true).call()],
    [["stash", "push"], (g) => g.stashCreate().call()],
    [["merge", "--no-edit", "side"], (g) => g.merge().include("side").call()],
    [["status", "-v"], (g) => g.status().callText({ verbose: 1 })],
    [["commit", "-v", "-m", "msg"], (g) => g.commit().setMessage("msg").setVerbose(1).call()],
  ];

  for (const [label, rules] of [
    ["a rule git cannot enforce", "[core]\n\twhitespace = tab-in-indent,indent-with-non-tab\n"],
    ["a variable without a value", "[core]\n\twhitespace\n"],
  ] as const) {
    it(`refuses ${label} in stash push --staged, stash push, merge, status -v and commit -v`, async () => {
      for (const [args, run] of cases) {
        const theirs = base();
        const mine = base();
        for (const dir of [theirs, mine])
          sh(dir, `printf '${rules.replace(/\n/g, "\\n").replace(/\t/g, "\\t")}' >>.git/config`);
        const before = tree(theirs);
        const beforeMine = tree(mine);
        const native = spawnSync("git", args, { cwd: theirs, env: configEnv({}) });
        const nativeOut: Outcome = {
          status: native.status ?? -1,
          stdout: native.stdout,
          messages: messageLines(native.stderr.toString()),
        };
        const ourOut = await outcome(async () => {
          const git = await ours(mine);
          await run(git);
          return { bytes: new Uint8Array(0), status: 0 };
        });
        const label = `git ${args.join(" ")}`;
        expect(nativeOut.status, label).toBe(128);
        expect(ourOut.status, label).toBe(128);
        expect(ourOut.messages, label).toEqual(nativeOut.messages);
        expect(nativeOut.messages.at(-1), label).toMatch(/^fatal: /);
        // nothing written, by either
        expect(tree(theirs), label).toBe(before);
        expect(tree(mine), label).toBe(beforeMine);
        // the stash list stays empty (git stash list itself dies on this configuration)
        for (const dir of [theirs, mine]) {
          expect(sh(dir, "ls .git/refs/stash .git/logs/refs/stash 2>&1 || :"), label).toMatch(
            /No such file.*\n.*No such file/,
          );
        }
      }
    });
  }

  it("lets git config, git remote and git ls-remote run, as they read no core settings", async () => {
    const dir = base();
    sh(dir, "git config core.whitespace tab-in-indent,indent-with-non-tab");
    const git = await ours(dir);
    expect(native(dir, ["config", "core.whitespace"]).status).toBe(0);
    await git.config().get("core.whitespace").call();
    expect(native(dir, ["remote"]).status).toBe(0);
    await git.remoteList().call();
    expect(native(dir, ["ls-remote", "."]).status).toBe(0);
    await git.lsRemote().setRemote(dir).call();
  });
});

describeGit("2.43's whitespace rules", () => {
  it("reads the rules after incomplete-line, which git 2.43 does not know, in --check and --color", async () => {
    const dir = repo(`
      echo x >f
      git add f
      commit -m one
      echo "        foo ();" >>f
    `);
    const out: string[] = [];
    for (const rule of [
      "-incomplete-line,indent-with-non-tab",
      "incomplete-line,indent-with-non-tab",
      "-incomplete,indent-with-non-tab",
      "indent-with-non-tab,-incomplete-line,-trailing",
    ]) {
      const config = { "core.whitespace": rule };
      await twinDiff(out, dir, ["--check"], config);
      await twinDiff(out, dir, ["--color"], config);
      if (!atLeast(2, 50)) {
        // git 2.43 still reads the rules after the one it does not know
        const r = native(dir, ["diff", "--check"], config);
        expect(r.status).toBe(2);
        expect(r.stdout.toString()).toContain("f:2: indent with spaces.\n");
      }
    }
    expect(out).toEqual([]);
  });
});
