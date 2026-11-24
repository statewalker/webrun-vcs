/**
 * The diff options that choose what is shown, against native git (statewalker-root#313):
 * `--diff-filter`, `--relative`, `-R`, `--rotate-to` / `--skip-to`, `-I<regex>`, `--quiet` /
 * `--exit-code` and `--merge-base` / `A...B`, on worktree, index and tree diffs. Each test
 * names the git t/ script whose scenario it replays; the command runs on native git and on
 * our DiffCommand (or LogCommand), comparing stdout byte for byte, the exit status, and the
 * `fatal:` / `error:` / `warning:` lines of stderr.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitWorkingCopyConfig,
} from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterAll, describe, expect, it } from "vitest";

import {
  type DiffCommand,
  type DiffOutputFormat,
  type DiffTextOptions,
  Git,
  type LogOutputOptions,
} from "../src/index.js";
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
};

let root: string | undefined;
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
const tmp = () => {
  root ??= mkdtempSync(join(tmpdir(), "diff-selection-"));
  return root;
};
let repoCount = 0;
const newRepo = () => join(tmp(), `repo-${++repoCount}`);

/** test-lib.sh's helpers, a clock that ticks per commit (merge bases are found by date) */
const PRELUDE = `
tick=1112911993
test_tick () { tick=$((tick + 60)); export GIT_COMMITTER_DATE="$tick +0000" GIT_AUTHOR_DATE="$tick +0000"; }
test_write_lines () { printf "%s\\n" "$@"; }
test_seq () { seq "$@"; }
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

/** The object id a revision names */
const rev = (dir: string, name: string): string => sh(dir, `git rev-parse ${name}`).trim();

/** A new repository on `main`, set up by `script` */
function repo(script: string): string {
  const dir = newRepo();
  sh(dir, `git init -q -b main . && git config diff.renames true\n${script}`);
  return dir;
}

interface Outcome {
  status: number;
  stdout: Buffer;
  /** The `fatal:`, `error:` and `warning:` lines of stderr */
  messages: string[];
}

/**
 * The `fatal:`, `error:` and `warning:` lines; convert.c's CRLF warnings left out (our diff
 * does not report them)
 */
const messageLines = (text: string): string[] =>
  text
    .split("\n")
    .filter(
      (l) => /^(fatal|error|warning): /.test(l) && !l.startsWith("warning: in the working copy"),
    );

function native(dir: string, args: string[]): Outcome {
  const res = spawnSync("git", args, { cwd: dir, env: { ...nativeGitEnv(tmp()), COLUMNS: "80" } });
  return {
    status: res.status ?? -1,
    stdout: res.stdout,
    messages: messageLines(res.stderr.toString()),
  };
}

/** Our working copy over a repository native git made in `dir`. */
async function open(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const { history } = await createGitFilesBackend({ files });
  const io = {
    read: async (path: string) => {
      try {
        return new Uint8Array(readFileSync(join(dir, path)));
      } catch {
        return undefined;
      }
    },
    write: async (path: string, content: Uint8Array) => writeFileSync(join(dir, path), content),
  };
  const config = new GitWorkingCopyConfig(io, ".git/config");
  await config.load();
  const staging = new FileStagingStore(files, ".git/index");
  await staging.read();
  const checkout = new GitCheckout({
    staging,
    refs: history.refs,
    files: {
      read: io.read,
      write: (p: string, c: Uint8Array) => files.write(p, [c]),
      stats: async () => undefined,
      remove: async () => {},
    } as unknown as GitCheckoutFilesApi,
    gitDir: ".git",
  });
  const worktree = createFileWorktree({
    files,
    rootPath: "",
    gitDir: ".git",
    blobs: history.blobs,
    trees: history.trees,
  });
  const workingCopy = new MemoryWorkingCopy({ history, checkout, worktree, config });
  return Git.fromWorkingCopy(workingCopy);
}

async function oursDiff(
  dir: string,
  build: (d: DiffCommand) => DiffCommand,
  format: DiffOutputFormat,
): Promise<Outcome> {
  const git = await open(dir);
  const d = build(git.diff().setOptions(versionOptions));
  try {
    const bytes = await d.callBytes(format);
    return { status: d.exitCode, stdout: Buffer.from(bytes), messages: [...d.warnings] };
  } catch (e) {
    const err = e as { exitCode?: number; message: string };
    return {
      status: err.exitCode ?? -1,
      stdout: Buffer.alloc(0),
      messages: messageLines(err.message),
    };
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

const FORMAT_ARGS: Record<DiffOutputFormat, string[]> = {
  patch: [],
  stat: ["--stat"],
  numstat: ["--numstat"],
  shortstat: ["--shortstat"],
  summary: ["--summary"],
  "name-only": ["--name-only"],
  "name-status": ["--name-status"],
  check: ["--check"],
  dirstat: ["--dirstat"],
};

/**
 * Runs `git <args>` (with `cwd` relative to the repository) and our diff, adding a mismatch to
 * `out`.
 */
async function twin(
  out: string[],
  dir: string,
  args: string[],
  build: (d: DiffCommand) => DiffCommand,
  format: DiffOutputFormat = "patch",
  cwd = ".",
): Promise<void> {
  // the format's options go before `--` and the paths after it
  const dash = args.indexOf("--");
  const nativeArgs =
    dash < 0
      ? ["-C", cwd, ...args, ...FORMAT_ARGS[format]]
      : ["-C", cwd, ...args.slice(0, dash), ...FORMAT_ARGS[format], ...args.slice(dash)];
  const theirs = native(dir, nativeArgs);
  const mine = await oursDiff(dir, build, format);
  const m = differs(`git ${nativeArgs.join(" ")}`, theirs, mine);
  if (m) out.push(m);
}

/** Every format, as {@link twin} */
async function twinFormats(
  out: string[],
  dir: string,
  args: string[],
  build: (d: DiffCommand) => DiffCommand,
  formats: DiffOutputFormat[] = ["patch", "stat", "numstat", "name-only", "name-status", "summary"],
  cwd = ".",
): Promise<void> {
  for (const f of formats) await twin(out, dir, args, build, f, cwd);
}

/** The four comparisons of `git diff`: worktree, index, two trees, a tree and the worktree */
type Mode = [string[], (d: DiffCommand) => DiffCommand];
const modes = (a: string, b: string): Mode[] => [
  [[], (d) => d],
  [["--cached"], (d) => d.setCached(true)],
  [[a, b], (d) => d.setOldTree(a).setNewTree(b)],
  [[a], (d) => d.setOldTree(a)],
];

describeGit("diff --relative", () => {
  const setup = `
    commit --allow-empty -m empty
    echo content >file1
    mkdir subdir
    echo other content >subdir/file2
    git add .
    commit -m one
  `;

  it('t4045-diff-relative.sh: "-p $*", "--numstat $*", "--stat $*" with --relative=subdir/, =subdir, from subdir, =sub', async () => {
    const dir = repo(setup);
    const out: string[] = [];
    const cases: Array<[string, string[], string]> = [
      [".", ["--relative=subdir/"], "subdir/"],
      [".", ["--relative=subdir"], "subdir"],
      ["subdir", ["--relative"], "subdir/"],
      [".", ["--relative=sub"], "sub"],
    ];
    for (const format of ["patch", "numstat", "stat"] as DiffOutputFormat[]) {
      for (const [cwd, flags, relative] of cases) {
        await twin(
          out,
          dir,
          ["diff", ...flags, "HEAD^"],
          (d) => d.setOldTree("HEAD^").setOptions({ relative }),
          format,
          cwd,
        );
      }
    }
    expect(out).toEqual([]);
  });

  it("t4045-diff-relative.sh: check_diff_relative_option and check_diff_no_relative_option (config diff.relative with --relative and --no-relative)", async () => {
    const dir = repo(setup);
    const out: string[] = [];
    const cases: Array<[string, string, string[], string | boolean]> = [
      // check_diff_no_relative_option
      [".", "false", [], false],
      [".", "true", ["--no-relative"], false],
      [".", "false", ["--no-relative"], false],
      ["subdir", "false", [], false],
      ["subdir", "true", ["--no-relative"], false],
      ["subdir", "false", ["--no-relative"], false],
      // check_diff_relative_option
      [".", "false", ["--relative=subdir/"], "subdir/"],
      [".", "false", ["--relative=subdir"], "subdir"],
      [".", "true", ["--relative=subdir/"], "subdir/"],
      [".", "true", ["--relative=subdir"], "subdir"],
      ["subdir", "false", ["--relative"], "subdir/"],
      ["subdir", "true", ["--relative"], "subdir/"],
      ["subdir", "true", [], "subdir/"],
      ["subdir", "false", ["--no-relative", "--relative"], "subdir/"],
      ["subdir", "true", ["--no-relative", "--relative"], "subdir/"],
      [".", "false", ["--no-relative", "--relative=subdir"], "subdir"],
      [".", "true", ["--no-relative", "--relative=subdir"], "subdir"],
      // at the top, --relative and diff.relative show every path
      [".", "true", [], true],
      [".", "false", ["--relative"], true],
    ];
    for (const [cwd, value, flags, relative] of cases) {
      sh(dir, `git config diff.relative ${value}`);
      await twin(
        out,
        dir,
        ["diff", "-p", ...flags, "HEAD^"],
        (d) => d.setOldTree("HEAD^").setOptions({ relative }),
        "patch",
        cwd,
      );
    }
    expect(out).toEqual([]);
  });

  it('t4045-diff-relative.sh: "--stat $*" in every mode and format, renames into and out of the prefix', async () => {
    const dir = repo(`
      ${setup}
      echo moved content here >subdir/moved
      echo stays >subdir2
      echo out >outside
      git add .
      commit -m two
      git mv subdir/moved moved-out
      git mv outside subdir/inside
      echo more >>subdir/file2
      git add subdir/file2
      commit -m three
      echo staged >subdir/new
      git add subdir/new
      echo wt >>subdir/file2
      chmod +x subdir2
    `);
    const out: string[] = [];
    for (const [args, make] of modes("HEAD^", "HEAD")) {
      for (const relative of ["subdir", "subdir/", "sub", "nothing"]) {
        await twinFormats(out, dir, ["diff", `--relative=${relative}`, ...args], (d) =>
          make(d).setOptions({ relative }),
        );
      }
    }
    expect(out).toEqual([]);
  });

  it('t4045-diff-relative.sh: "diff --relative without change in subdir", "diff --relative --name-only with change in subdir", "diff --relative --cached with change in subdir", "diff --relative with change in subdir"', async () => {
    const dir = repo(`
      test_commit zero file0
      test_commit base subdir/file0
      git switch -q -c br1
      test_commit one file0
      test_commit sub1 subdir/file0
      git switch -q -c br2 base
      test_commit two file0
      git switch -q -c br3
      test_commit sub3 subdir/file0
    `);
    const out: string[] = [];
    const rel = (d: DiffCommand) => d.setOptions({ relative: "subdir/" });
    // diff --relative without change in subdir
    sh(dir, "git switch -q br2 && ! git merge -q one >/dev/null 2>&1");
    for (const format of ["patch", "name-only"] as DiffOutputFormat[]) {
      await twin(out, dir, ["diff", "--relative"], rel, format, "subdir");
    }
    sh(dir, "git merge --abort");
    // diff --relative --name-only with change in subdir (and the other formats)
    sh(dir, "git switch -q br3 && ! git merge -q sub1 >/dev/null 2>&1");
    await twinFormats(out, dir, ["diff", "--relative"], rel, undefined, "subdir");
    // diff --relative --cached with change in subdir (git 2.43 dies of a segmentation fault)
    if (atLeast(2, 50))
      await twinFormats(
        out,
        dir,
        ["diff", "--relative", "--cached"],
        (d) => rel(d).setCached(true),
        undefined,
        "subdir",
      );
    sh(dir, "git merge --abort");
    // diff --relative with change in subdir (a test_expect_failure upstream: the combined diff
    // keeps its full path)
    sh(dir, "git switch -q br3 && ! git merge -q br1 >/dev/null 2>&1");
    await twin(out, dir, ["diff", "--relative"], rel, "patch", "subdir");
    sh(dir, "git merge --abort");
    expect(out).toEqual([]);
  });
});

describeGit("--rotate-to and --skip-to", () => {
  const setup = `
    >sample1.t
    >sample2.t
    >sample3.t
    >sample4.t
    git add sample1.t sample2.t sample3.t sample4.t
    commit -m added sample1.t sample2.t sample3.t sample4.t
    echo modified >>sample1.t
    echo modified >>sample2.t
    echo modified >>sample4.t
    commit -m updated sample1.t sample2.t sample3.t sample4.t
  `;

  it('t4056-diff-order.sh: "diff --rotate-to", "diff --skip-to", "diff --rotate/skip-to error condition"', async () => {
    const dir = repo(setup);
    const out: string[] = [];
    for (const format of ["name-only", "patch", "stat"] as DiffOutputFormat[]) {
      for (const path of ["sample2.t", "sample1.t", "sample4.t", "sample3.t", "sample0.t"]) {
        await twin(
          out,
          dir,
          ["diff", `--rotate-to=${path}`, "HEAD^"],
          (d) => d.setOldTree("HEAD^").setOptions({ rotateTo: path }),
          format,
        );
        await twin(
          out,
          dir,
          ["diff", `--skip-to=${path}`, "HEAD^"],
          (d) => d.setOldTree("HEAD^").setOptions({ skipTo: path }),
          format,
        );
      }
    }
    expect(out).toEqual([]);
  });

  it('t4056-diff-order.sh: "diff --rotate-to" in every mode, after -O, with -R', async () => {
    const dir = repo(`
      ${setup}
      printf "sample4.t\\nsample1.t\\n" >order
      echo again >>sample1.t
      echo again >>sample3.t
      git add sample1.t sample3.t
      echo wt >>sample2.t
      echo wt >>sample4.t
    `);
    const out: string[] = [];
    for (const [args, make] of modes("HEAD^", "HEAD")) {
      for (const path of ["sample2.t", "sample3.t", "sample4.t"]) {
        await twin(
          out,
          dir,
          ["diff", "-Oorder", `--rotate-to=${path}`, ...args],
          (d) => make(d).setOptions({ orderFile: "order", rotateTo: path }),
          "name-only",
        );
        await twin(
          out,
          dir,
          ["diff", "-R", `--skip-to=${path}`, ...args],
          (d) => make(d).setOptions({ reverse: true, skipTo: path }),
          "patch",
        );
      }
    }
    expect(out).toEqual([]);
  });

  it('t4056-diff-order.sh: "log --rotate-to", "log --skip-to"', async () => {
    const dir = repo(`commit --allow-empty -m initial\n${setup}`);
    const out: string[] = [];
    for (const [flag, key] of [
      ["--rotate-to", "rotateTo"],
      ["--skip-to", "skipTo"],
    ] as const) {
      for (const path of ["sample3.t", "sample2.t", "sample9.t", "a"]) {
        const args = ["log", `${flag}=${path}`, "--format=commit %s", "--name-only", "HEAD~2.."];
        const theirs = native(dir, args);
        const git = await open(dir);
        const options: LogOutputOptions = { pretty: "format:commit %s", nameOnly: true };
        // tformat: as --format= is
        options.pretty = "tformat:commit %s";
        const bytes = await git
          .log()
          .not(rev(dir, "HEAD~2"))
          .add(rev(dir, "HEAD"))
          .setDiffOptions({ [key]: path })
          .callBytes(options);
        const m = differs(args.join(" "), theirs, {
          status: 0,
          stdout: Buffer.from(bytes),
          messages: [],
        });
        if (m) out.push(m);
      }
    }
    expect(out).toEqual([]);
  });
});

describeGit("-I<regex>", () => {
  const setup = `
    test_seq 50 >file0
    git add file0
    commit -m "Set up -I<regex> test file" file0
    test_seq 50 | sed -e "s/13/ten and three/" -e "/7\\$/d" >file0
    echo >>file0
  `;
  const I = ["-Iten.*e", "-I^[124-9]"];
  const options: DiffTextOptions = {
    ignoreBlankLines: true,
    ignoreMatchingLines: ["ten.*e", "^[124-9]"],
  };

  it('t4013-diff-various.sh: "diff -I<regex>", "diff -I<regex> --stat" in every mode, with --exit-code and --quiet', async () => {
    const dir = repo(`
      ${setup}
      git add file0
      commit -m two
      test_seq 60 | sed -e "s/2/two/" >file0
      git add file0
      test_seq 60 | sed -e "s/2/two/" -e "s/^3.*/&   /" >file0
    `);
    const out: string[] = [];
    for (const [args, make] of modes("HEAD^", "HEAD")) {
      await twinFormats(out, dir, ["diff", "--ignore-blank-lines", ...I, ...args], (d) =>
        make(d).setOptions(options),
      );
      await twinFormats(out, dir, ["diff", "-I^[0-9]*$", ...args], (d) =>
        make(d).setOptions({ ignoreMatchingLines: ["^[0-9]*$"] }),
      );
      await twinFormats(out, dir, ["diff", "-w", "-I3", ...args], (d) =>
        make(d).setOptions({ ignoreWhitespace: true, ignoreMatchingLines: ["3"] }),
      );
      await twin(out, dir, ["diff", "-w", "-I3", "-U1", ...args], (d) =>
        make(d).setOptions({ ignoreWhitespace: true, ignoreMatchingLines: ["3"], context: 1 }),
      );
      for (const extra of [["--exit-code"], ["--quiet"]]) {
        await twin(out, dir, ["diff", "-I.*", ...extra, ...args], (d) =>
          make(d)
            .setOptions({ ignoreMatchingLines: [".*"] })
            .setExitCode(extra[0] === "--exit-code")
            .setQuiet(extra[0] === "--quiet"),
        );
      }
    }
    expect(out).toEqual([]);
  });

  it('t4013-diff-various.sh: "diff -I<regex>", "diff -I<regex> --stat", "diff -I<regex>: detect malformed regex", "diff -I<regex>: ignore matching file"', async () => {
    const dir = repo(setup);
    const out: string[] = [];
    // diff -I<regex>, diff -I<regex> --stat
    await twinFormats(out, dir, ["diff", "--ignore-blank-lines", ...I], (d) =>
      d.setOptions(options),
    );
    // diff -I<regex>: detect malformed regex
    await twin(out, dir, ["diff", "--ignore-matching-lines=^[124-9"], (d) =>
      d.setOptions({ ignoreMatchingLines: ["^[124-9"] }),
    );
    // diff -I<regex>: ignore matching file
    sh(
      dir,
      `test_seq 50 >file1 && git add file1 &&
       test_seq 50 | sed -e "s/13/ten and three/" -e "s/^[124-9].*/& /" >file1`,
    );
    await twinFormats(out, dir, ["diff", "--ignore-blank-lines", ...I], (d) =>
      d.setOptions(options),
    );
    sh(dir, "git rm -q -f file1");
    expect(out).toEqual([]);
  });

  it('t4013-diff-various.sh: "diff -I<regex>: ignore all content changes"', async () => {
    const dir = repo(`
      ${setup}
      : >file1
      git add file1
      : >file2
      git add file2
      : >file3
      git add file3
      # (unlike t4013, file3's stage 0 goes first: ours drops a stage-0 entry beside stages)
      git rm -q --cached file3
      rm -f file1 file2
      mkdir file2
      echo "A" >file3
      A_hash=$(git hash-object -w file3)
      echo "B" >file3
      B_hash=$(git hash-object -w file3)
      printf "100644 $A_hash 1\\tfile3\\n100644 $B_hash 2\\tfile3\\n" | git update-index --index-info
    `);
    const out: string[] = [];
    const all: DiffTextOptions = { ignoreBlankLines: true, ignoreMatchingLines: [".*"] };
    await twinFormats(
      out,
      dir,
      ["diff", "--ignore-blank-lines", "-I.*"],
      (d) => d.setOptions(all),
      ["name-only", "name-status", "patch", "stat"],
    );
    await twin(out, dir, ["diff", "--quiet", "-I.*"], (d) =>
      d.setOptions({ ignoreMatchingLines: [".*"] }).setQuiet(true),
    );
    expect(out).toEqual([]);
  });

  it('t4013-diff-various.sh: "git log -IA -IB -I1 -I2 -p main # magic is (not used)"', async () => {
    const dir = repo(`
      test_write_lines 1 2 3 >file0
      test_write_lines A B >sub
      git add file0 sub
      commit -m Initial
      test_write_lines 4 5 6 >>file0
      test_write_lines C D >>sub
      commit -am Second
      test_write_lines A B C >file1
      git add file1
      test_write_lines 1 2 >sub
      commit -am Third
    `);
    const args = ["log", "-IA", "-IB", "-I1", "-I2", "-p", "--format=%s", "main"];
    const theirs = native(dir, args);
    const git = await open(dir);
    const bytes = await git
      .log()
      .add(rev(dir, "main"))
      .setDiffOptions({ ...versionOptions, ignoreMatchingLines: ["A", "B", "1", "2"] })
      .callBytes({ pretty: "tformat:%s", patch: true });
    expect(
      differs(args.join(" "), theirs, { status: 0, stdout: Buffer.from(bytes), messages: [] }),
    ).toBe(undefined);
  });
});

/** A repository with every status: A, C, D, M, R, T, U (and a mode change) */
const STATUSES = `
  test_write_lines a b c d e f g h >moved
  test_write_lines 1 2 3 4 5 6 7 8 >copied
  echo gone >gone
  echo kept >kept
  echo link >typechange
  echo conflict >conflict
  echo mode >mode
  git add .
  commit -m A
  git checkout -q -b side
  echo theirs >conflict
  commit -qam side
  git checkout -q main
  echo ours >conflict
  commit -qam main
  git mv moved renamed
  cp copied copy-of-copied
  echo 9 >>copied
  git rm -q gone
  echo new >added
  echo more >>kept
  rm typechange && ln -s kept typechange
  chmod +x mode
  git add -A
  commit -m B
  ! git merge -q side >/dev/null 2>&1
  echo wt >>kept
  echo wt-added >wt-added
  git add -N wt-added
  echo staged >staged
  git add staged
`;

const FILTERS = [
  "A",
  "D",
  "M",
  "R",
  "C",
  "T",
  "U",
  "X",
  "B",
  "*",
  "AD",
  "ad",
  "m",
  "r",
  "u",
  "AM*",
  "Q*",
  "Ma",
  "x",
  "MR*",
  "acdmrtux",
];

describeGit("--diff-filter", () => {
  it('t4202-log.sh: "multiple --diff-filter bits", "all-negative filter" as git diff: each letter, exclusions and * in every mode', async () => {
    const dir = repo(`${STATUSES}
git config diff.renames copies`);
    const out: string[] = [];
    for (const [args, make] of modes("HEAD~1", "HEAD")) {
      for (const filter of FILTERS) {
        await twinFormats(
          out,
          dir,
          ["diff", `--diff-filter=${filter}`, ...args],
          (d) => make(d).setOptions({ diffFilter: filter }),
          ["name-status", "patch", "stat"],
        );
      }
    }
    expect(out).toEqual([]);
  });

  it('t4040-whitespace-status.sh: "diff-tree --diff-filter --quiet", "diff-files --diff-filter --quiet" with -R and --exit-code', async () => {
    const dir = repo(STATUSES);
    const out: string[] = [];
    for (const [args, make] of modes("HEAD~1", "HEAD")) {
      for (const filter of ["A", "D", "R", "*", "ad", "Q"]) {
        await twin(
          out,
          dir,
          ["diff", "-R", `--diff-filter=${filter}`, ...args],
          (d) => make(d).setOptions({ reverse: true, diffFilter: filter }),
          "name-status",
        );
        await twin(out, dir, ["diff", "--exit-code", `--diff-filter=${filter}`, ...args], (d) =>
          make(d).setOptions({ diffFilter: filter }).setExitCode(true),
        );
        await twin(out, dir, ["diff", "--quiet", `--diff-filter=${filter}`, ...args], (d) =>
          make(d).setOptions({ diffFilter: filter }).setQuiet(true),
        );
      }
    }
    expect(out).toEqual([]);
  });

  it('t4202-log.sh: "diff-filter=A", "diff-filter=M", "diff-filter=D", "all-negative filter", "diff-filter=R", "multiple --diff-filter bits"', async () => {
    const dir = repo(`
      test_commit one a.t
      test_commit two b.t
      echo changed >a.t && commit -qam three
      git rm -q b.t && commit -qm four
      git mv a.t c.t && commit -qm five
    `);
    const out: string[] = [];
    for (const filter of ["A", "D", "M", "R", "ad", "d", "Ra", "aR"]) {
      for (const formats of [[], ["--name-status"]]) {
        // git 2.43 shows nothing for a filter of exclusions alone without an output format
        if (/^[a-z]+$/.test(filter) && formats.length === 0 && !atLeast(2, 50)) continue;
        const args = ["log", `--diff-filter=${filter}`, "--format=%s", ...formats];
        const theirs = native(dir, args);
        const git = await open(dir);
        const bytes = await git
          .log()
          .add(rev(dir, "HEAD"))
          .setDiffOptions({ diffFilter: filter })
          .callBytes({ pretty: "tformat:%s", ...(formats.length ? { nameStatus: true } : {}) });
        const m = differs(args.join(" "), theirs, {
          status: 0,
          stdout: Buffer.from(bytes),
          messages: [],
        });
        if (m) out.push(m);
      }
    }
    expect(out).toEqual([]);
  });
});

describeGit("-R", () => {
  it('t4013-diff-various.sh: "git diff-tree -R --stat --compact-summary initial mode # magic is (not used)" (without --compact-summary), every mode and format', async () => {
    const dir = repo(STATUSES.replace("! git merge -q side >/dev/null 2>&1", ""));
    const out: string[] = [];
    for (const [args, make] of modes("HEAD~1", "HEAD")) {
      await twinFormats(out, dir, ["diff", "-R", ...args], (d) =>
        make(d).setOptions({ reverse: true }),
      );
      await twin(out, dir, ["diff", "-R", "--relative=re", ...args], (d) =>
        make(d).setOptions({ reverse: true, relative: "re" }),
      );
    }
    sh(dir, "git config diff.mnemonicPrefix true");
    for (const [args, make] of modes("HEAD~1", "HEAD")) {
      await twin(out, dir, ["diff", "-R", ...args], (d) => make(d).setOptions({ reverse: true }));
    }
    expect(out).toEqual([]);
  });
});

describeGit("--exit-code and --quiet", () => {
  it('t4017-diff-retval.sh: "git diff --quiet -w  HEAD^^ HEAD^", "git diff --quiet HEAD^^ HEAD^", "git diff --quiet -w  HEAD^ HEAD", "git diff-tree HEAD^ HEAD", "git diff-index --cached HEAD^", "git diff --exit-code returns 1 for changed binary file", "git diff --quiet returns 1 for renamed file"', async () => {
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
    const flags: Array<[string, (d: DiffCommand) => DiffCommand]> = [
      ["--quiet", (d) => d.setQuiet(true)],
      ["--exit-code", (d) => d.setExitCode(true)],
    ];
    const run = async (args: string[], build: (d: DiffCommand) => DiffCommand) => {
      for (const [flag, set] of flags) {
        await twin(out, dir, ["diff", flag, ...args], (d) => set(build(d)));
      }
    };
    await run(["-w", "HEAD^^", "HEAD^"], (d) =>
      d.setOldTree("HEAD^^").setNewTree("HEAD^").setOptions({ ignoreWhitespace: true }),
    );
    await run(["HEAD^^", "HEAD^"], (d) => d.setOldTree("HEAD^^").setNewTree("HEAD^"));
    await run(["-w", "HEAD^", "HEAD"], (d) =>
      d.setOldTree("HEAD^").setNewTree("HEAD").setOptions({ ignoreWhitespace: true }),
    );
    await run(["HEAD^", "HEAD"], (d) => d.setOldTree("HEAD^").setNewTree("HEAD"));
    await run(["HEAD^", "HEAD", "--", "a"], (d) =>
      d.setOldTree("HEAD^").setNewTree("HEAD").setPathspec(["a"]),
    );
    await run(["HEAD^", "HEAD", "--", "b"], (d) =>
      d.setOldTree("HEAD^").setNewTree("HEAD").setPathspec(["b"]),
    );
    await run(["HEAD", "HEAD"], (d) => d.setOldTree("HEAD").setNewTree("HEAD"));
    await run([], (d) => d);
    await run(["--cached", "HEAD"], (d) => d.setCached(true).setOldTree("HEAD"));
    await run(["--cached", "HEAD^"], (d) => d.setCached(true).setOldTree("HEAD^"));
    sh(dir, "echo text >>b && echo 3 >c && git add .");
    await run(["--cached", "HEAD^"], (d) => d.setCached(true).setOldTree("HEAD^"));
    sh(dir, `commit -m "text in b" && echo 3 >>c`);
    await run([], (d) => d);
    await run(["HEAD"], (d) => d.setOldTree("HEAD"));
    sh(dir, "git update-index c");
    await run(["--cached", "HEAD"], (d) => d.setCached(true).setOldTree("HEAD"));
    await run(["--cached", "--relative=b", "HEAD"], (d) =>
      d.setCached(true).setOldTree("HEAD").setOptions({ relative: "b" }),
    );
    // git diff $option returns 1 for changed binary file
    sh(dir, "git reset -q --hard && echo a binary >.gitattributes && echo 2 >>a");
    await run([], (d) => d);
    sh(dir, "rm -f .gitattributes");
    // ... for a renamed file
    sh(dir, "git reset -q --hard && git mv a renamed");
    await run(["--cached"], (d) => d.setCached(true));
    await run(["--cached", "--diff-filter=R"], (d) =>
      d.setCached(true).setOptions({ diffFilter: "R" }),
    );
    await run(["--cached", "--diff-filter=M"], (d) =>
      d.setCached(true).setOptions({ diffFilter: "M" }),
    );
    // the patch printed with --exit-code, nothing with --quiet
    await twin(
      out,
      dir,
      ["diff", "--exit-code", "--cached"],
      (d) => d.setCached(true).setExitCode(true),
      "stat",
    );
    await twin(
      out,
      dir,
      ["diff", "--quiet", "--cached"],
      (d) => d.setCached(true).setQuiet(true),
      "stat",
    );
    expect(out).toEqual([]);
  });

  it('t4017-diff-retval.sh: "git diff --exit-code --submodule=diff returns 1 for dirty subrepo", "git diff --quiet --submodule=log returns 1 for dirty subrepo"', async () => {
    const dir = repo(`
      echo a >a && git add a && commit -m a
      mkdir subrepo && (cd subrepo && git init -q -b main . && echo f >f && git add f && commit -m sub)
      git add subrepo
      commit -m subrepo
      (cd subrepo && echo g >g && git add g && commit -m another)
    `);
    const out: string[] = [];
    for (const [flag, set] of [
      ["--exit-code", (d: DiffCommand) => d.setExitCode(true)],
      ["--quiet", (d: DiffCommand) => d.setQuiet(true)],
    ] as const) {
      for (const format of ["diff", "log", "short"] as const) {
        await twin(out, dir, ["diff", flag, `--submodule=${format}`], (d) =>
          set(d).setSubmoduleFormat(format),
        );
      }
    }
    expect(out).toEqual([]);
  });

  it('t4017-diff-retval.sh: "git diff-files" with a conflict alone: the combined diff sets no status, --quiet\'s unmerged entry does', async () => {
    const dir = repo(`
      echo base >c && git add c && commit -m base
      git checkout -q -b side && echo theirs >c && commit -qam side
      git checkout -q main && echo ours >c && commit -qam main
      ! git merge -q side >/dev/null 2>&1
    `);
    const out: string[] = [];
    await twin(out, dir, ["diff", "--exit-code"], (d) => d.setExitCode(true));
    await twin(out, dir, ["diff", "--quiet"], (d) => d.setQuiet(true));
    await twin(out, dir, ["diff", "--exit-code"], (d) => d.setExitCode(true), "name-status");
    expect(out).toEqual([]);
  });
});

describeGit("--quiet", () => {
  it('t4035-diff-quiet.sh: "git diff-tree HEAD^ HEAD", "git diff-index --cached HEAD^", "git diff-files", "git diff --quiet ignores stat-change only entries", "git diff --quiet on a path that need conversion"', async () => {
    const dir = repo(`
      echo 1 >a
      git add .
      commit -m first
      echo 2 >b
      git add .
      commit -a -m second
    `);
    const out: string[] = [];
    const quiet = async (args: string[], build: (d: DiffCommand) => DiffCommand) =>
      twin(out, dir, ["diff", "--quiet", ...args], (d) => build(d).setQuiet(true));
    await quiet(["HEAD^", "HEAD"], (d) => d.setOldTree("HEAD^").setNewTree("HEAD"));
    await quiet(["HEAD^", "HEAD", "--", "a"], (d) =>
      d.setOldTree("HEAD^").setNewTree("HEAD").setPathspec(["a"]),
    );
    await quiet(["HEAD^", "HEAD", "--", "b"], (d) =>
      d.setOldTree("HEAD^").setNewTree("HEAD").setPathspec(["b"]),
    );
    await quiet(["HEAD", "HEAD"], (d) => d.setOldTree("HEAD").setNewTree("HEAD"));
    await quiet(["-w", "HEAD^", "HEAD"], (d) =>
      d.setOldTree("HEAD^").setNewTree("HEAD").setOptions({ ignoreWhitespace: true }),
    );
    await quiet([], (d) => d);
    await quiet(["--cached", "HEAD"], (d) => d.setCached(true).setOldTree("HEAD"));
    await quiet(["--cached", "HEAD^"], (d) => d.setCached(true).setOldTree("HEAD^"));
    sh(dir, "echo text >>b && echo 3 >c && git add .");
    await quiet(["--cached", "HEAD^"], (d) => d.setCached(true).setOldTree("HEAD^"));
    sh(dir, `commit -m "text in b" && echo 3 >>c`);
    await quiet([], (d) => d);
    sh(dir, "git update-index c");
    await quiet(["--cached", "HEAD"], (d) => d.setCached(true).setOldTree("HEAD"));
    // git diff --quiet ignores stat-change only entries
    sh(dir, "touch -d '2030-01-01' a");
    await quiet([], (d) => d);
    sh(dir, "echo modified >>b");
    await quiet([], (d) => d);
    // --ignore-space-at-eol / --ignore-all-space against the worktree
    sh(dir, `git reset -q --hard && echo "1 " >a`);
    await quiet(["--ignore-space-at-eol"], (d) => d.setOptions({ ignoreWhitespaceAtEol: true }));
    await quiet(["--ignore-all-space"], (d) => d.setOptions({ ignoreWhitespace: true }));
    sh(dir, `echo "1   1" >a`);
    await quiet(["--ignore-space-at-eol"], (d) => d.setOptions({ ignoreWhitespaceAtEol: true }));
    await quiet(["--ignore-all-space"], (d) => d.setOptions({ ignoreWhitespace: true }));
    // git diff --quiet on a path that need conversion
    sh(
      dir,
      `git reset -q --hard && echo "crlf.txt text=auto" >.gitattributes &&
       printf "Hello\\r\\nWorld\\r\\n" >crlf.txt && git add .gitattributes crlf.txt &&
       printf "Hello\\r\\nWorld\\n" >crlf.txt`,
    );
    await quiet(["crlf.txt"], (d) => d.setPathspec(["crlf.txt"]));
    expect(out).toEqual([]);
  });
});

describeGit("A...B and --merge-base", () => {
  //     B---E   <-- main
  //    / \ /
  //   A   X
  //    \ / \
  //     C---D--G   <-- br1
  //      \    /
  //       ---F   <-- br2
  //
  //  H  <-- br3
  const setup = `
    commit --allow-empty -m A
    echo b >b
    git add b
    commit -m B
    git checkout -q -b br1 HEAD^
    echo c >c
    git add c
    commit -m C
    git tag -m commit-C commit-C
    test_tick
    git merge -q -m D main
    git tag commit-D
    git checkout -q main
    test_tick
    git merge -q -m E commit-C
    git checkout -q -b br2 commit-C
    echo f >f
    git add f
    commit -m F
    git checkout -q br1
    test_tick
    git merge -q -m G br2
    git checkout -q --orphan br3
    commit -m H
    git checkout -q main
  `;

  it('t4068-diff-symmetric-merge-base.sh: "diff with one merge base", "diff with two merge bases", "diff with no merge bases"', async () => {
    const dir = repo(setup);
    const out: string[] = [];
    for (const range of [
      "commit-D...br1",
      "br1...main",
      "br2...br3",
      "br1...",
      "...br2",
      "main...main",
      "commit-C^{tree}...main",
      "nothing...main",
    ]) {
      await twin(out, dir, ["diff", range], (d) => d.setOldTree(range));
      await twin(out, dir, ["diff", range], (d) => d.setOldTree(range), "name-status");
    }
    for (const range of ["commit-D..br1", "br1..", "..br2"]) {
      await twin(out, dir, ["diff", range], (d) => d.setOldTree(range));
    }
    expect(out).toEqual([]);
  });

  it('t4068-diff-symmetric-merge-base.sh: "diff --merge-base with one commit", "diff --merge-base with annotated tag", "diff --merge-base --cached with one commit and staged and unstaged changes", "diff --merge-base with non-commit", "diff --merge-base with range"', async () => {
    const dir = repo(setup);
    const out: string[] = [];
    const mb =
      (rev: string, cached = false) =>
      (d: DiffCommand) =>
        d.setMergeBase(true).setOldTree(rev).setCached(cached);
    const check = async () => {
      for (const rev of ["br2", "commit-C", "main^{tree}", "br3", "br1", "br2..br3"]) {
        await twin(out, dir, ["diff", "--merge-base", rev], mb(rev));
        // git diff --cached A..B is a usage error before --merge-base is looked at
        if (!rev.includes("..")) {
          await twin(out, dir, ["diff", "--cached", "--merge-base", rev], mb(rev, true));
        }
      }
    };
    await check();
    sh(dir, "echo unstaged >>c");
    await check();
    sh(dir, "echo staged >>c && git add c && echo unstaged >>c");
    await check();
    await twin(out, dir, ["diff", "--merge-base"], (d) => d.setMergeBase(true));
    expect(out).toEqual([]);
  });

  it('t4068-diff-symmetric-merge-base.sh: "diff --merge-base with two commits", "diff --merge-base commit and non-commit", "diff --merge-base with multiple merge bases and two commits"', async () => {
    const dir = repo(setup);
    const out: string[] = [];
    for (const [a, b] of [
      ["br2", "main"],
      ["br2", "main^{tree}"],
      ["br2", "br3"],
      ["main", "br1"],
      ["commit-C", "commit-D"],
    ]) {
      await twin(out, dir, ["diff", "--merge-base", a, b], (d) =>
        d.setMergeBase(true).setOldTree(a).setNewTree(b),
      );
    }
    expect(out).toEqual([]);
  });
});

describe("DiffCommand selection options", () => {
  it("--quiet stops early: no renames detected, nothing printed", async () => {
    const dir = repo(`
      test_write_lines a b c d e f >one
      git add one && commit -m one
      git mv one two && echo g >>two && git add two
    `);
    const git = await open(dir);
    const quiet = git.diff().setCached(true).setQuiet(true);
    expect(await quiet.callText()).toBe("");
    expect(quiet.exitCode).toBe(1);
    expect(quiet.hasChanges).toBe(true);
    const exit = (await open(dir)).diff().setCached(true).setExitCode(true);
    expect(await exit.callText("name-status")).toBe("R085\tone\ttwo\n");
    expect(exit.exitCode).toBe(1);
    const none = (await open(dir)).diff().setQuiet(true);
    await none.callBytes();
    expect(none.exitCode).toBe(0);
  });

  it("call() applies --diff-filter and --relative", async () => {
    const dir = repo(`
      mkdir d && echo a >d/a && echo b >b && git add . && commit -m one
      echo c >d/c && echo bb >>b && git rm -q d/a && git add .
    `);
    const git = await open(dir);
    const entries = await git.diff().setCached(true).setOptions({ diffFilter: "A" }).call();
    expect(entries.map((e) => e.newPath)).toEqual(["d/c"]);
    const relative = await (await open(dir))
      .diff()
      .setCached(true)
      .setOptions({ relative: "d" })
      .call();
    expect(relative.map((e) => e.oldPath ?? e.newPath)).toEqual(["d/a", "d/c"]);
  });
});

describeGit("--exit-code with content options and every format", () => {
  it('t4017-diff-retval.sh: "git diff --quiet -w  HEAD^ HEAD", "git diff --exit-code returns 1 for changed binary file" with -w, -I and each format', async () => {
    const dir = repo(`
      echo y >a
      echo w >b
      echo m >m
      git add .
      commit -m one
      echo z >a
      echo "w " >b
      chmod +x m
      echo new >n
      git add .
      commit -m two
      echo q >a
      echo "w  " >b
      git add a b
      echo r >a
      echo "w   " >b
    `);
    const out: string[] = [];
    const flagSets: Array<[string[], DiffTextOptions]> = [
      [[], {}],
      [["-w"], { ignoreWhitespace: true }],
      [["-I[a-z]"], { ignoreMatchingLines: ["[a-z]"] }],
    ];
    for (const [args, make] of modes("HEAD^", "HEAD")) {
      for (const paths of [[], ["b"], ["a"]]) {
        for (const [flags, options] of flagSets) {
          for (const format of [
            "patch",
            "stat",
            "numstat",
            "shortstat",
            "summary",
            "name-only",
            "name-status",
          ] as DiffOutputFormat[]) {
            await twin(
              out,
              dir,
              ["diff", "--exit-code", ...flags, ...args, "--", ...paths],
              (d) => {
                const x = make(d).setOptions(options).setExitCode(true);
                return paths.length > 0 ? x.setPathspec(paths) : x;
              },
              format,
            );
          }
          await twin(out, dir, ["diff", "--quiet", ...flags, ...args, "--", ...paths], (d) => {
            const x = make(d).setOptions(options).setQuiet(true);
            return paths.length > 0 ? x.setPathspec(paths) : x;
          });
        }
      }
    }
    expect(out).toEqual([]);
  });
});

describeGit("-I matches the whole line, its newline included", () => {
  it('t4013-diff-various.sh: "diff -I<regex>" with patterns that match the LF', async () => {
    const dir = repo(`
      printf "x\\nkeep\\n" >f
      git add f
      commit -m one
      printf "y\\nkeep\\n" >f
      git add f
      commit -m two
      printf "y\\nkeep\\nlast" >f
    `);
    const out: string[] = [];
    const patterns = ["[[:space:]]", "y$", "^$", "x.", "x[^a]", "\\s", "y[[:space:]]$", "^k"];
    for (const [args, make] of modes("HEAD^", "HEAD")) {
      for (const pattern of patterns) {
        await twin(out, dir, ["diff", "--exit-code", `-I${pattern}`, ...args], (d) =>
          make(d)
            .setOptions({ ignoreMatchingLines: [pattern] })
            .setExitCode(true),
        );
      }
    }
    expect(out).toEqual([]);
  });
});
