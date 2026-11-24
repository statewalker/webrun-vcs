/**
 * Pickaxe (diffcore-pickaxe.c) against native git (statewalker-root#322): `-S<string>` with
 * `--pickaxe-regex`, `--pickaxe-all`, `-i` and textconv, `-G<regex>`, and `--find-object`,
 * in `git log`, `git diff` and `git show`, in diffcore's order (after rename detection,
 * before `-O`, `--diff-filter`; `--relative` limits the queue before it). Each test names the
 * git t/ script and test it replays; the command runs on native git and on ours, comparing
 * stdout byte for byte, the exit status and the `fatal:`/`error:`/`warning:` lines of
 * stderr. A partial clone twin counts the fetches `log -S` makes (one batch per commit).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type DiffCommand,
  type DiffOutputFormat,
  type DiffTextOptions,
  type Git,
  installTextconvRunner,
  type LogCommand,
  type LogOutputOptions,
  type ShowCommand,
  type TextconvRunner,
} from "../src/index.js";
import { type LoopbackServer, serveOnLoopback } from "./http-loopback-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { gitAsync } from "./native-connect-support.js";
import {
  nativeGitAvailable,
  nativeGitEnv,
  nativeGitHttpBackend,
} from "./native-git-http-backend.js";
import { testEnv } from "./status-native-support.js";

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
};

let root: string | undefined;
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
const tmp = () => {
  root ??= mkdtempSync(join(tmpdir(), "diff-pickaxe-"));
  return root;
};
let repoCount = 0;

/** test-lib.sh's helpers, a clock that ticks per commit */
const PRELUDE = `
tick=1112911993
test_tick () { tick=$((tick + 60)); export GIT_COMMITTER_DATE="$tick +0000" GIT_AUTHOR_DATE="$tick +0000"; }
commit () { test_tick; git commit -q "$@"; }
test_commit () { f=\${2:-$1.t}; mkdir -p "$(dirname "$f")"; echo "\${3:-$1}" >"$f"; git add "$f"; commit -m "$1"; git tag "$1"; }
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
  sh(dir, `git init -q -b main .\n${script}`);
  return dir;
}

const rev = (dir: string, name: string): string => sh(dir, `git rev-parse ${name}`).trim();

interface Outcome {
  status: number;
  stdout: Buffer;
  /** The `fatal:`, `error:` and `warning:` lines of stderr */
  messages: string[];
}

const messageLines = (text: string): string[] =>
  text.split("\n").filter((l) => /^(fatal|error|warning): /.test(l));

function native(dir: string, args: string[]): Outcome {
  const res = spawnSync("git", args, { cwd: dir, env: { ...nativeGitEnv(tmp()), COLUMNS: "80" } });
  return {
    status: res.status ?? -1,
    stdout: res.stdout,
    messages: messageLines(res.stderr.toString()),
  };
}

/** A textconv runner as git runs one: the command through the shell on a temporary file */
const nodeTextconv: TextconvRunner = async ({ command, path, content }) => {
  const d = mkdtempSync(join(tmp(), "textconv-"));
  try {
    const file = join(d, `XXXXXX_${basename(path)}`);
    writeFileSync(file, content);
    const res = spawnSync("sh", ["-c", `${command} "$@"`, command, file], {
      env: nativeGitEnv(tmp()),
    });
    // run-command.c's start_command: a command not found is git's own error line
    if (res.status === 127)
      throw new Error(`error: cannot run ${command}: No such file or directory`);
    if (res.status !== 0) throw new Error(`error: error running textconv command '${command}'`);
    return new Uint8Array(res.stdout);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
};

async function ours(dir: string): Promise<Git> {
  const git = await openOurs(dir);
  installTextconvRunner(git.workingCopy, nodeTextconv);
  return git;
}

/** What ours gave, or the error it threw as git's exit status and lines */
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

/** The difference between two outcomes, described; undefined when they agree */
function differs(label: string, theirs: Outcome, mine: Outcome): string | undefined {
  const problems: string[] = [];
  if (theirs.status !== mine.status) problems.push(`status ${theirs.status} vs ${mine.status}`);
  if (!theirs.stdout.equals(mine.stdout)) {
    problems.push(`stdout\n--- git\n${theirs.stdout}\n--- ours\n${mine.stdout}`);
  }
  if (theirs.messages.join("\n") !== mine.messages.join("\n")) {
    problems.push(
      `stderr\n--- git\n${theirs.messages.join("\n")}\n--- ours\n${mine.messages.join("\n")}`,
    );
  }
  return problems.length > 0 ? `${label}: ${problems.join("\n")}` : undefined;
}

/** `git log <args>` against our log built by `build` and printed with `output` */
async function twinLog(
  out: string[],
  dir: string,
  args: string[],
  build: (log: LogCommand) => LogCommand,
  output: LogOutputOptions = {},
): Promise<void> {
  const theirs = native(dir, ["log", ...args]);
  const mine = await outcome(async () => {
    const git = await ours(dir);
    return { bytes: await build(git.log()).callBytes(output) };
  });
  const m = differs(`git log ${args.join(" ")}`, theirs, mine);
  if (m) out.push(m);
}

/** `git diff <args>` against our diff */
async function twinDiff(
  out: string[],
  dir: string,
  args: string[],
  build: (d: DiffCommand) => DiffCommand,
  format: DiffOutputFormat = "patch",
): Promise<void> {
  const formatArgs: Record<DiffOutputFormat, string[]> = {
    patch: [],
    stat: ["--stat"],
    numstat: ["--numstat"],
    shortstat: ["--shortstat"],
    summary: ["--summary"],
    "name-only": ["--name-only"],
    "name-status": ["--name-status"],
    check: ["--check"],
  };
  const dash = args.indexOf("--");
  const nativeArgs =
    dash < 0
      ? ["diff", ...args, ...formatArgs[format]]
      : ["diff", ...args.slice(0, dash), ...formatArgs[format], ...args.slice(dash)];
  const theirs = native(dir, nativeArgs);
  const mine = await outcome(async () => {
    const git = await ours(dir);
    const d = build(git.diff());
    d.setOptions(versionOptions);
    const bytes = await d.callBytes(format);
    return { bytes, status: d.exitCode };
  });
  const m = differs(`git ${nativeArgs.join(" ")}`, theirs, mine);
  if (m) out.push(m);
}

/** `git show <args>` against our show */
async function twinShow(
  out: string[],
  dir: string,
  args: string[],
  build: (show: ShowCommand) => ShowCommand,
): Promise<void> {
  const theirs = native(dir, ["show", ...args]);
  const mine = await outcome(async () => {
    const git = await ours(dir);
    const r = await build(git.show()).call();
    return { bytes: r.stdout, status: r.exitCode };
  });
  const m = differs(`git show ${args.join(" ")}`, theirs, mine);
  if (m) out.push(m);
}

const H: LogOutputOptions = { pretty: "tformat:%H" };

describeGit("t4209-log-pickaxe", () => {
  const setup = `
    >file
    git add file
    commit -m initial
    echo Picked >file
    git add file
    test_tick
    git commit -q --author="Another Person <another@example.com>" -m second
  `;

  it('t4209-log-pickaxe.sh: "usage"', async () => {
    const dir = repo(setup);
    const out: string[] = [];
    const cases: Array<[string[], DiffTextOptions]> = [
      [["-Gregex", "-Sstring"], { pickaxeGrep: "regex", pickaxeString: "string" }],
      [["-Gregex", "--find-object=HEAD"], { pickaxeGrep: "regex", findObjects: ["HEAD"] }],
      [["-Sstring", "--find-object=HEAD"], { pickaxeString: "string", findObjects: ["HEAD"] }],
      [["--pickaxe-all", "--find-object=HEAD"], { pickaxeAll: true, findObjects: ["HEAD"] }],
    ];
    for (const [args, options] of cases) {
      await twinLog(out, dir, args, (log) => log.setDiffOptions(options));
    }
    expect(out).toEqual([]);
  });

  it('t4209-log-pickaxe.sh: "usage: --pickaxe-regex"', async () => {
    const dir = repo(setup);
    const out: string[] = [];
    await twinLog(out, dir, ["-Gregex", "--pickaxe-regex"], (log) =>
      log.setDiffOptions({ pickaxeGrep: "regex", pickaxeRegex: true }),
    );
    expect(out).toEqual([]);
  });

  it('t4209-log-pickaxe.sh: "usage: -G and -S with empty argument"', async () => {
    const dir = repo(setup);
    const out: string[] = [];
    // git 2.43 has no such check: diffcore_pickaxe hits its BUG() (SIGABRT)
    if (native(dir, ["log", "-S", ""]).status === -1) return;
    await twinLog(out, dir, ["-S", ""], (log) => log.setDiffOptions({ pickaxeString: "" }));
    await twinLog(out, dir, ["-G", ""], (log) => log.setDiffOptions({ pickaxeGrep: "" }));
    expect(out).toEqual([]);
  });

  it('t4209-log-pickaxe.sh: "log -G (nomatch)", "log -G (match)", "log -G --regexp-ignore-case (nomatch)", "log -G -i (match)", "log -S (match)", "log -S -i (nomatch)", "log -S --pickaxe-regex (match)", "log -S --pickaxe-regex -i (nomatch)" and the other test_log cases', async () => {
    const dir = repo(setup);
    const out: string[] = [];
    const cases: Array<[string, string, boolean]> = [
      ["-G", "picked", false],
      ["-G", "Picked", false],
      ["-G", "pickle", true],
      ["-G", "picked", true],
      ["-S", "picked", false],
      ["-S", "Picked", false],
      ["-S", "picked", true],
      ["-S", "pickle", true],
      ["-S", "p.cked", false],
      ["-S", "P.cked", false],
      ["-S", "p.cked", true],
      ["-S", "p.ckle", true],
    ];
    for (const [kind, needle, icase] of cases) {
      for (const regex of kind === "-S" ? [false, true] : [false]) {
        for (const flag of icase ? ["--regexp-ignore-case", "-i"] : [""]) {
          const args = [
            ...(regex ? ["--pickaxe-regex"] : []),
            ...(flag ? [flag] : []),
            `${kind}${needle}`,
            "--format=%H",
          ];
          await twinLog(
            out,
            dir,
            args,
            (log) =>
              log
                .setRegexpIgnoreCase(icase)
                .setDiffOptions(
                  kind === "-G"
                    ? { pickaxeGrep: needle }
                    : { pickaxeString: needle, pickaxeRegex: regex },
                ),
            H,
          );
        }
      }
    }
    expect(out).toEqual([]);
  });

  it('t4209-log-pickaxe.sh: "log -G --textconv (missing textconv tool)", "log -G --no-textconv (missing textconv tool)", "log -S --textconv (missing textconv tool)", "log -S --no-textconv (missing textconv tool)"', async () => {
    const dir = repo(
      `${setup}\necho "* diff=test" >.gitattributes\ngit config diff.test.textconv missing`,
    );
    const out: string[] = [];
    for (const [kind, options] of [
      ["-Gfoo", { pickaxeGrep: "foo" }],
      ["-Sfoo", { pickaxeString: "foo" }],
    ] as const) {
      await twinLog(out, dir, [kind], (log) => log.setDiffOptions(options));
      await twinLog(out, dir, [kind, "--no-textconv"], (log) =>
        log.setDiffOptions({ ...options, textconv: false }),
      );
    }
    expect(out).toEqual([]);
  });

  const gsPlain = () =>
    repo(`
      echo a >>data.txt && git add data.txt && commit -m A && git tag A
      echo "a a" >>data.txt && git add data.txt && commit -m B && git tag B
      echo b >>data.txt && git add data.txt && commit -m C && git tag C
      echo "[b]" >>data.txt && git add data.txt && commit -m D && git tag D
      test_commit E data.txt ""
    `);

  it('t4209-log-pickaxe.sh: "log -G trims diff new/old [-+]", "log -S<pat> is not a regex, but -S<pat> --pickaxe-regex is"', async () => {
    const dir = gsPlain();
    const out: string[] = [];
    for (const pattern of ["[+-]a", "^a"]) {
      await twinLog(out, dir, [`-G${pattern}`], (log) =>
        log.setDiffOptions({ pickaxeGrep: pattern }),
      );
    }
    for (const needle of ["a", "[a]", "[b]"]) {
      for (const regex of [false, true]) {
        await twinLog(out, dir, [`-S${needle}`, ...(regex ? ["--pickaxe-regex"] : [])], (log) =>
          log.setDiffOptions({ pickaxeString: needle, pickaxeRegex: regex }),
        );
      }
    }
    expect(out).toEqual([]);
  });

  const gsBin = () =>
    repo(`
      printf "a\\na\\0a\\n" >data.bin && git add data.bin && commit -m A && git tag A
      printf "a\\na\\0a\\n" >>data.bin && git add data.bin && commit -m B && git tag B
      test_commit C data.bin ""
    `);

  it('t4209-log-pickaxe.sh: "log -G ignores binary files", "log -G looks into binary files with -a", "log -S looks into binary files", "log -S --pickaxe-regex looks into binary files"', async () => {
    const dir = gsBin();
    const out: string[] = [];
    await twinLog(out, dir, ["-Ga"], (log) => log.setDiffOptions({ pickaxeGrep: "a" }));
    await twinLog(out, dir, ["-a", "-Ga"], (log) =>
      log.setDiffOptions({ pickaxeGrep: "a", text: true }),
    );
    await twinLog(out, dir, ["-Sa"], (log) => log.setDiffOptions({ pickaxeString: "a" }));
    await twinLog(out, dir, ["--pickaxe-regex", "-Sa"], (log) =>
      log.setDiffOptions({ pickaxeString: "a", pickaxeRegex: true }),
    );
    await twinLog(out, dir, ["--pickaxe-regex", "-S[a]"], (log) =>
      log.setDiffOptions({ pickaxeString: "[a]", pickaxeRegex: true }),
    );
    expect(out).toEqual([]);
  });

  it('t4209-log-pickaxe.sh: "log -G looks into binary files with textconv filter"', async () => {
    const dir = gsBin();
    sh(dir, `echo "* diff=bin" >.gitattributes && git config diff.bin.textconv cat`);
    const out: string[] = [];
    await twinLog(out, dir, ["-Ga"], (log) => log.setDiffOptions({ pickaxeGrep: "a" }));
    expect(out).toEqual([]);
  });

  it('t4209-log-pickaxe.sh: "log -S<pat> is not a regex, but -S<pat> --pickaxe-regex is" with -n, --skip and -p (log.c counts the commits shown)', async () => {
    const dir = gsPlain();
    const out: string[] = [];
    for (const n of [1, 2]) {
      await twinLog(
        out,
        dir,
        ["-Sa", `-n${n}`, "--format=%s"],
        (log) => log.setMaxCount(n).setDiffOptions({ pickaxeString: "a" }),
        { pretty: "tformat:%s" },
      );
    }
    await twinLog(
      out,
      dir,
      ["-Sa", "--skip=1", "--format=%s"],
      (log) => log.setSkip(1).setDiffOptions({ pickaxeString: "a" }),
      { pretty: "tformat:%s" },
    );
    await twinLog(
      out,
      dir,
      ["-Sa", "-p", "--stat"],
      (log) => log.setDiffOptions({ pickaxeString: "a" }),
      { patch: true, stat: true },
    );
    await twinLog(
      out,
      dir,
      ["-G^\\[", "--reverse", "-n3", "--format=%s"],
      (log) => log.setMaxCount(3).setDiffOptions({ pickaxeGrep: "^\\[" }),
      { pretty: "tformat:%s", reverse: true },
    );
    await twinLog(out, dir, ["-G(", "--format=%s"], (log) =>
      log.setDiffOptions({ pickaxeGrep: "(" }),
    );
    expect(out).toEqual([]);
  });
});

describeGit("t4062-diff-pickaxe", () => {
  const setup = () =>
    repo(`
      test_commit initial
      printf "%04096d" 0 >4096-zeroes.txt
      git add 4096-zeroes.txt
      commit -m "A 4k file"
    `);

  it('t4062-diff-pickaxe.sh: "-G matches", "-S --pickaxe-regex"', async () => {
    const dir = setup();
    const out: string[] = [];
    await twinDiff(
      out,
      dir,
      ["-G", "^(0{64}){64}$", "HEAD^"],
      (d) => d.setOldTree("HEAD^").setOptions({ pickaxeGrep: "^(0{64}){64}$" }),
      "name-only",
    );
    await twinDiff(
      out,
      dir,
      ["-S0", "--pickaxe-regex", "HEAD^"],
      (d) => d.setOldTree("HEAD^").setOptions({ pickaxeString: "0", pickaxeRegex: true }),
      "name-only",
    );
    expect(out).toEqual([]);
  });

  it('t4062-diff-pickaxe.sh: "-G matches" in every mode and format, with --pickaxe-all, --exit-code and --quiet', async () => {
    const dir = repo(`
      test_commit initial
      printf "one\\nfrotz\\n" >a.txt
      printf "nothing\\n" >b.txt
      mkdir sub && printf "frotz frotz\\n" >sub/c.txt
      git add . && commit -m two
      printf "one\\n" >a.txt
      printf "nothing\\nfrotz\\n" >b.txt
      git add a.txt
    `);
    const out: string[] = [];
    const modes: Array<[string[], (d: DiffCommand) => DiffCommand]> = [
      [[], (d) => d],
      [["--cached"], (d) => d.setCached(true)],
      [["HEAD^", "HEAD"], (d) => d.setOldTree("HEAD^").setNewTree("HEAD")],
      [["HEAD^"], (d) => d.setOldTree("HEAD^")],
    ];
    const kinds: Array<[string[], DiffTextOptions]> = [
      [["-Sfrotz"], { pickaxeString: "frotz" }],
      [["-Gfrotz"], { pickaxeGrep: "frotz" }],
      [["-Sfrotz", "--pickaxe-all"], { pickaxeString: "frotz", pickaxeAll: true }],
      [["-Gnothing", "--pickaxe-all"], { pickaxeGrep: "nothing", pickaxeAll: true }],
      [["-Snone"], { pickaxeString: "none" }],
      [["-S", "FROTZ", "-i"], { pickaxeString: "FROTZ", pickaxeIgnoreCase: true }],
    ];
    for (const [modeArgs, make] of modes) {
      for (const [kindArgs, options] of kinds) {
        for (const format of ["patch", "name-status", "stat"] as DiffOutputFormat[]) {
          await twinDiff(
            out,
            dir,
            [...kindArgs, ...modeArgs],
            (d) => make(d).setOptions(options),
            format,
          );
        }
        await twinDiff(out, dir, ["--exit-code", ...kindArgs, ...modeArgs], (d) =>
          make(d).setOptions(options).setExitCode(true),
        );
        await twinDiff(out, dir, ["--quiet", ...kindArgs, ...modeArgs], (d) =>
          make(d).setOptions(options).setQuiet(true),
        );
      }
    }
    expect(out).toEqual([]);
  });

  it('t4062-diff-pickaxe.sh: "-S --pickaxe-regex" after rename detection, before -O, --diff-filter and --rotate-to, after --relative', async () => {
    const dir = repo(`
      mkdir dir
      printf "%s\\n" 1 2 3 4 5 6 7 8 9 10 >dir/moved.txt
      printf "frotz\\n" >dir/keep.txt
      printf "frotz\\n" >top.txt
      printf "x\\n" >gone.txt
      git add . && commit -m one
      git mv dir/moved.txt dir/renamed.txt
      printf "frotz\\n" >>dir/renamed.txt
      printf "frotz\\nfrotz\\n" >dir/keep.txt
      printf "y\\n" >top.txt
      git rm -q gone.txt
      git add . && commit -m two
      printf "top.txt\\ndir/*\\n" >order
    `);
    const out: string[] = [];
    const base = (d: DiffCommand) => d.setOldTree("HEAD^").setNewTree("HEAD");
    const cases: Array<[string[], DiffTextOptions]> = [
      [["-Sfrotz"], { pickaxeString: "frotz" }],
      [["-Sfrotz", "--no-renames"], { pickaxeString: "frotz" }],
      [["-Gfrotz", "-Oorder"], { pickaxeGrep: "frotz", orderFile: "order" }],
      [["-Sfrotz", "--diff-filter=M"], { pickaxeString: "frotz", diffFilter: "M" }],
      [
        ["-Sfrotz", "--pickaxe-all", "--diff-filter=D"],
        { pickaxeString: "frotz", pickaxeAll: true, diffFilter: "D" },
      ],
      [["-Sfrotz", "--relative=dir"], { pickaxeString: "frotz", relative: "dir" }],
      [
        ["-Sfrotz", "--pickaxe-all", "--relative=dir"],
        { pickaxeString: "frotz", pickaxeAll: true, relative: "dir" },
      ],
      [
        ["-Sy", "--pickaxe-all", "--relative=dir"],
        { pickaxeString: "y", pickaxeAll: true, relative: "dir" },
      ],
      [["-Sfrotz", "--rotate-to=top.txt"], { pickaxeString: "frotz", rotateTo: "top.txt" }],
      [["-Sfrotz", "-R"], { pickaxeString: "frotz", reverse: true }],
    ];
    for (const [args, options] of cases) {
      for (const format of ["name-status", "patch"] as DiffOutputFormat[]) {
        await twinDiff(
          out,
          dir,
          [...args, "HEAD^", "HEAD"],
          (d) => {
            const r = base(d).setOptions(options);
            return args.includes("--no-renames") ? r.setRenames(false) : r;
          },
          format,
        );
      }
    }
    expect(out).toEqual([]);
  });

  it('t4062-diff-pickaxe.sh: "-S --pickaxe-regex" in git show (a matching and a non-matching commit, a merge with --cc)', async () => {
    const dir = repo(`
      printf "base\\n" >f && git add f && commit -m base
      git switch -q -c side
      printf "base\\nside frotz\\n" >f && commit -qam side
      git switch -q main
      printf "main\\nbase\\n" >f && commit -qam main
      test_tick && git merge -q -m merge side
    `);
    const out: string[] = [];
    for (const target of ["HEAD", "HEAD^", "HEAD^2"]) {
      await twinShow(out, dir, ["-Sfrotz", target], (show) =>
        show.setDiffOptions({ ...versionOptions, pickaxeString: "frotz" }).addArgument(target),
      );
      await twinShow(out, dir, ["-Gmain", target], (show) =>
        show.setDiffOptions({ ...versionOptions, pickaxeGrep: "main" }).addArgument(target),
      );
    }
    expect(out).toEqual([]);
  });
});

describeGit("t4064-diff-oidfind", () => {
  const setup = () =>
    repo(`
      commit --allow-empty -m "empty initial commit"
      echo "Hello, world!" >greeting
      git add greeting
      commit -m "add the greeting blob"
      git tag -m "the blob" greeting $(git rev-parse HEAD:greeting)
      echo asdf >unrelated
      git add unrelated
      commit -m "unrelated history"
      test_tick && git revert --no-edit HEAD^ >/dev/null
      commit --allow-empty -m "another unrelated commit"
    `);
  const S: LogOutputOptions = { pretty: "tformat:%s" };

  it('t4064-diff-oidfind.sh: "find the greeting blob"', async () => {
    const dir = setup();
    const out: string[] = [];
    await twinLog(
      out,
      dir,
      ["--format=%s", "--find-object=greeting^{blob}"],
      (log) => log.setDiffOptions({ findObjects: ["greeting^{blob}"] }),
      S,
    );
    await twinLog(
      out,
      dir,
      ["--format=%s", "--name-status", "--find-object=greeting^{blob}"],
      (log) => log.setDiffOptions({ findObjects: ["greeting^{blob}"] }),
      { ...S, nameStatus: true },
    );
    await twinLog(
      out,
      dir,
      ["--format=%s", "--find-object=nope"],
      (log) => log.setDiffOptions({ findObjects: ["nope"] }),
      S,
    );
    expect(out).toEqual([]);
  });

  it('t4064-diff-oidfind.sh: "find a tree"', async () => {
    const dir = setup();
    sh(
      dir,
      "mkdir a && echo asdf >a/file && git add a/file && commit -m 'add a file in a subdirectory'",
    );
    const out: string[] = [];
    const tree = rev(dir, "HEAD:a");
    await twinLog(
      out,
      dir,
      ["--format=%s", "-t", "--find-object=HEAD:a"],
      (log) => log.setDiffOptions({ findObjects: ["HEAD:a"] }),
      S,
    );
    for (const [flag, output] of [
      ["--name-status", { nameStatus: true }],
      ["--stat", { stat: true }],
      ["-p", { patch: true }],
      ["--summary", { summary: true }],
    ] as const) {
      await twinLog(
        out,
        dir,
        ["--format=%s", flag, `--find-object=${tree}`],
        (log) => log.setDiffOptions({ findObjects: [tree] }),
        { ...S, ...output },
      );
    }
    for (const format of ["name-status", "patch", "summary"] as DiffOutputFormat[]) {
      await twinDiff(
        out,
        dir,
        [`--find-object=${tree}`, "HEAD^", "HEAD"],
        (d) =>
          d
            .setOldTree("HEAD^")
            .setNewTree("HEAD")
            .setOptions({ findObjects: [tree] }),
        format,
      );
    }
    await twinDiff(out, dir, ["--exit-code", `--find-object=${tree}`, "HEAD^", "HEAD"], (d) =>
      d
        .setOldTree("HEAD^")
        .setNewTree("HEAD")
        .setOptions({ findObjects: [tree] })
        .setExitCode(true),
    );
    expect(out).toEqual([]);
  });

  it('t4064-diff-oidfind.sh: "find a submodule"', async () => {
    const dir = setup();
    sh(
      dir,
      `mkdir sub && (cd sub && git init -q -b main && echo sub >sub.t && git add sub.t && test_tick && git commit -q -m sub)
       git -c protocol.file.allow=always submodule add -q ./sub sub
       commit -a -m "add sub"`,
    );
    const out: string[] = [];
    await twinLog(
      out,
      dir,
      ["--format=%s", "--find-object=HEAD:sub"],
      (log) => log.setDiffOptions({ findObjects: ["HEAD:sub"] }),
      S,
    );
    expect(out).toEqual([]);
  });

  it('t4064-diff-oidfind.sh: "detect merge which introduces blob", "detect merge which removes blob", "do not detect merge that does not touch blob"', async () => {
    const dir = setup();
    sh(
      dir,
      `test_commit base
       git checkout -q -b boring base^
       echo boring >file && git add file && commit -m boring
       git checkout -q -b interesting base^
       echo interesting >file && git add file && commit -m interesting`,
    );
    const blob = rev(dir, "interesting:file");
    const out: string[] = [];
    const scripts = [
      `git checkout -q -B merge base && git merge -q --no-commit boring; echo interesting >file && commit -am "introduce blob"`,
      `git checkout -q -B merge interesting && git merge -q --no-commit base; echo boring >file && commit -am "remove blob"`,
      `git checkout -q -B merge interesting && test_tick && git merge -q -m "untouched blob" base`,
    ];
    for (const script of scripts) {
      sh(dir, script);
      await twinLog(
        out,
        dir,
        ["-1", "--format=%s", `--find-object=${blob}`, "-c", "--name-status"],
        (log) => log.setMaxCount(1).setDiffOptions({ findObjects: [blob] }),
        { ...S, c: true, nameStatus: true },
      );
      // the merge's combined diff in git show, and -S through find_paths_generic
      await twinShow(out, dir, [`--find-object=${blob}`, "HEAD"], (show) =>
        show.setDiffOptions({ ...versionOptions, findObjects: [blob] }).addArgument("HEAD"),
      );
      await twinShow(out, dir, ["-Sinteresting", "HEAD"], (show) =>
        show
          .setDiffOptions({ ...versionOptions, pickaxeString: "interesting" })
          .addArgument("HEAD"),
      );
    }
    expect(out).toEqual([]);
  });
});

/** Whether the native git on PATH can fetch over HTTP (the 2.56.1 build has no curl) */
const nativeHasCurl = (() => {
  if (!nativeGitAvailable()) return false;
  const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
  return (
    existsSync(join(execPath, "git-remote-https")) || existsSync(join(execPath, "git-remote-http"))
  );
})();
const describeHttp = nativeHasCurl && process.platform === "linux" ? describe : describe.skip;

describeHttp("pickaxe in a partial clone", () => {
  let home: string;
  let server: LoopbackServer;
  let closeBackend: () => void;
  const counts = { fetch: 0 };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "pickaxe-partial-"));
    const work = join(home, "work");
    mkdirSync(join(home, "srv"));
    const lines = (tag: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${tag} line ${i}\n`).join("");
    const run = (cwd: string, args: string[], n?: number) =>
      execFileSync("git", args, {
        cwd,
        env: testEnv(
          home,
          n === undefined
            ? {}
            : { GIT_AUTHOR_DATE: `170000000${n} +0000`, GIT_COMMITTER_DATE: `170000000${n} +0000` },
        ),
        stdio: ["ignore", "pipe", "pipe"],
      });
    mkdirSync(work);
    run(work, ["init", "-q", "-b", "main"]);
    writeFileSync(join(work, "a.txt"), lines("a", 12));
    writeFileSync(join(work, "move.txt"), lines("move", 30));
    writeFileSync(join(work, "b.txt"), lines("b", 5));
    run(work, ["add", "."]);
    run(work, ["commit", "-qm", "c1"], 1);
    run(work, ["mv", "move.txt", "moved.txt"]);
    writeFileSync(join(work, "moved.txt"), `${lines("move", 30)}frotz\n`);
    writeFileSync(join(work, "b.txt"), `${lines("b", 5)}more\n`);
    run(work, ["add", "-A"]);
    run(work, ["commit", "-qm", "c2"], 2);
    writeFileSync(join(work, "a.txt"), `${lines("a", 12)}frotz\n`);
    run(work, ["commit", "-qam", "c3"], 3);
    writeFileSync(join(work, "b.txt"), lines("b", 3));
    run(work, ["commit", "-qam", "c4"], 4);
    run(home, ["clone", "-q", "--bare", "--no-local", work, join(home, "srv", "repo.git")]);
    run(join(home, "srv", "repo.git"), ["config", "uploadpack.allowFilter", "true"]);
    run(join(home, "srv", "repo.git"), ["config", "uploadpack.allowAnySHA1InWant", "true"]);
    const backend = nativeGitHttpBackend(join(home, "srv"), home);
    closeBackend = () => backend.close();
    server = await serveOnLoopback(async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname.endsWith("/git-upload-pack")) {
        const raw = Buffer.from(await request.clone().arrayBuffer());
        const body = request.headers.get("content-encoding") === "gzip" ? gunzipSync(raw) : raw;
        if (!body.toString("latin1").includes("command=ls-refs")) counts.fetch++;
      }
      return backend.fetch(request);
    });
  });

  afterAll(async () => {
    await server?.close();
    closeBackend?.();
    if (home) rmSync(home, { recursive: true, force: true });
  });

  let n = 0;
  /** A native partial clone and ours, each made with native git (no checkout) */
  async function clones(): Promise<{ theirs: string; mine: Git }> {
    const url = `${server.baseUrl}/repo.git`;
    const make = async (name: string) => {
      const dir = join(home, `${name}-${++n}`);
      const r = await gitAsync(home, home, [
        "clone",
        "-q",
        "--no-checkout",
        "--filter=blob:none",
        url,
        dir,
      ]);
      expect(r.status, r.stderr).toBe(0);
      return dir;
    };
    const theirs = await make("n");
    const mineDir = await make("o");
    const mine = await openOurs(
      home,
      createNodeGitHostEnvironment({ env: testEnv(home) }),
      undefined,
      mineDir.slice(home.length + 1),
    );
    return { theirs, mine };
  }

  async function fetches(run: () => Promise<unknown>): Promise<number> {
    const before = counts.fetch;
    await run();
    return counts.fetch - before;
  }

  it('t4209-log-pickaxe.sh: "log -S<pat> is not a regex, but -S<pat> --pickaxe-regex is" in a partial clone: one prefetch per commit diffed (diffcore_std), as native git', async () => {
    for (const [args, options] of [
      [["-Sfrotz"], { pickaxeString: "frotz" }],
      [["-Gfrotz", "--name-status"], { pickaxeGrep: "frotz" }],
    ] as const) {
      const { theirs, mine } = await clones();
      let nativeText = "";
      const nativeFetches = await fetches(async () => {
        const r = await gitAsync(home, theirs, ["log", "--format=%s", ...args]);
        expect(r.status, r.stderr).toBe(0);
        nativeText = r.stdout;
      });
      let ourText = "";
      const ourFetches = await fetches(async () => {
        ourText = await mine
          .log()
          .setDiffOptions(options)
          .callText({
            pretty: "tformat:%s",
            nameStatus: (args as readonly string[]).includes("--name-status"),
          });
      });
      expect(ourText).toBe(nativeText);
      expect(ourFetches).toBe(nativeFetches);
      expect(nativeFetches).toBeGreaterThan(1);
    }
  });

  it('t4064-diff-oidfind.sh: "find the greeting blob" in a partial clone: --find-object prefetches as -S does', async () => {
    const { theirs, mine } = await clones();
    const blob = execFileSync("git", ["rev-parse", "HEAD:a.txt"], {
      cwd: theirs,
      env: testEnv(home),
    })
      .toString()
      .trim();
    let nativeText = "";
    const nativeFetches = await fetches(async () => {
      const r = await gitAsync(home, theirs, ["log", "--format=%s", `--find-object=${blob}`]);
      expect(r.status, r.stderr).toBe(0);
      nativeText = r.stdout;
    });
    let ourText = "";
    const ourFetches = await fetches(async () => {
      ourText = await mine
        .log()
        .setDiffOptions({ findObjects: [blob] })
        .callText({ pretty: "tformat:%s" });
    });
    expect(ourText).toBe(nativeText);
    expect(ourFetches).toBe(nativeFetches);
  });
});

describeGit("pickaxe and --diff-filter with -n (log.c counts the commits shown)", () => {
  it('t4209-log-pickaxe.sh: "log -S<pat> is not a regex, but -S<pat> --pickaxe-regex is" with --graph -n (hidden commits drawn as ...)', async () => {
    const dir = repo(`
      for c in one two three four five six; do echo "$c" >"$c.t"; git add "$c.t"; commit -m "$c"; done
      git switch -q -c side HEAD~2
      echo a >s1.t && git add s1.t && commit -m s1
      echo b >s2.t && git add s2.t && commit -m s2
      git switch -q main
      test_tick && git merge -q -m merge side
      echo a >seven.t && git add seven.t && commit -m seven
    `);
    const out: string[] = [];
    for (const n of [1, 2, 3]) {
      await twinLog(
        out,
        dir,
        ["--graph", "-Sa", `-n${n}`, "--format=%s"],
        (log) => log.setMaxCount(n).setDiffOptions({ pickaxeString: "a" }),
        { pretty: "tformat:%s", graph: true },
      );
      await twinLog(
        out,
        dir,
        ["--graph", "--diff-filter=A", `-n${n}`, "--format=%s"],
        (log) => log.setMaxCount(n).setDiffOptions({ diffFilter: "A" }),
        { pretty: "tformat:%s", graph: true },
      );
      await twinLog(
        out,
        dir,
        ["-Sa", `-n${n}`, "--format=%s"],
        (log) => log.setMaxCount(n).setDiffOptions({ pickaxeString: "a" }),
        { pretty: "tformat:%s" },
      );
    }
    expect(out).toEqual([]);
  });

  it("log -n1 --diff-filter=M and -S stop walking once a commit is shown (2000 commits)", async () => {
    const dir = join(tmp(), `repo-${++repoCount}`);
    mkdirSync(dir);
    sh(dir, "git init -q -b main .");
    // a long history by fast-import: each commit adds a file, the last one modifies one
    let stream = "";
    const total = 2000;
    for (let i = 1; i <= total; i++) {
      const path = i === total ? "f1.t" : `f${i}.t`;
      stream += `commit refs/heads/main\nmark :${i}\ncommitter T <t@example.com> ${1112911993 + i} +0000\ndata 2\nc\n`;
      if (i > 1) stream += `from :${i - 1}\n`;
      stream += `M 100644 inline ${path}\ndata ${String(i).length + 1}\n${i}\n\n`;
    }
    execFileSync("git", ["fast-import", "--quiet"], {
      cwd: dir,
      input: stream,
      env: nativeGitEnv(tmp()),
    });
    const out: string[] = [];
    await twinLog(
      out,
      dir,
      ["-n1", "--diff-filter=M", "--format=%s %H"],
      (log) => log.setMaxCount(1).setDiffOptions({ diffFilter: "M" }),
      { pretty: "tformat:%s %H" },
    );
    expect(out).toEqual([]);
    const time = async (build: (log: LogCommand) => LogCommand, output: LogOutputOptions) => {
      const git = await ours(dir);
      const log = build(git.log());
      const start = performance.now();
      await log.callBytes(output);
      return { ms: performance.now() - start, walked: log.getStatistics().commitsWalked };
    };
    const first = await time((log) => log.setMaxCount(1).setDiffOptions({ diffFilter: "M" }), {
      pretty: "tformat:%H",
    });
    const firstS = await time(
      (log) => log.setMaxCount(1).setDiffOptions({ pickaxeString: String(total) }),
      { pretty: "tformat:%H" },
    );
    const all = await time((log) => log.setDiffOptions({ diffFilter: "M" }), {
      pretty: "tformat:%H",
    });
    // the walk reads a few commits ahead of the one shown, never the whole history
    expect(first.walked).toBeLessThan(50);
    expect(firstS.walked).toBeLessThan(50);
    expect(all.walked).toBeGreaterThanOrEqual(total);
    expect(first.ms * 5).toBeLessThan(all.ms);
  }, 120_000);
});
