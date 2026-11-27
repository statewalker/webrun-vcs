/**
 * `git check-ignore` against native git: the scenarios of git's t0008-ignores.sh in each
 * verbosity t0008 runs them (`-q`, plain, `-v`, `-v -n`, with and without `--no-index`):
 * argument errors, files tracked and untracked at the top and in a subdirectory, nested
 * `.gitignore` files with negated patterns, ignored directories (from inside one too), a path
 * beyond a symbolic link, a path inside a submodule, `info/exclude` and `core.excludesFile`,
 * `--stdin` with quoted lines and `-z` (from a subdirectory too), exact prefixes, `**`, and
 * an existing directory. Each runs on native git and on ours in the same repository. Run with
 * the system git (2.43) and with 2.56.1 first on `PATH`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import {
  git,
  nativeAtLeast,
  type Outcome,
  outcomeOf,
  plumbingEnv,
  writeFiles,
} from "./plumbing-native-support.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root = "";
let repo = "";

interface Run {
  args: string[];
  stdin?: string;
  cwd?: string;
}

function nativeRun(run: Run): Outcome {
  const r = spawnSync("git", ["check-ignore", ...run.args], {
    cwd: run.cwd ? join(repo, run.cwd) : repo,
    env: plumbingEnv(root),
    encoding: "latin1",
    input: Buffer.from(run.stdin ?? "", "latin1"),
  });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

async function oursRun(run: Run): Promise<Outcome> {
  const environment = createNodeGitHostEnvironment({ env: plumbingEnv(root) });
  const g = await openOurs(repo, environment);
  const cmd = g.checkIgnore();
  if (run.cwd) cmd.setCurrentDirectory(run.cwd);
  let paths = false;
  for (const a of run.args) {
    if (paths) cmd.addPath(a);
    else if (a === "--") paths = true;
    else if (a === "-q" || a === "--quiet") cmd.setQuiet(true);
    else if (a === "-v" || a === "--verbose") cmd.setVerbose(true);
    else if (a === "-n" || a === "--non-matching") cmd.setNonMatching(true);
    else if (a === "--no-index") cmd.setNoIndex(true);
    else if (a === "-z") cmd.setNulTerminated(true);
    else if (a === "--stdin") cmd.setStdin(Buffer.from(run.stdin ?? "", "latin1"));
    else cmd.addPath(a);
  }
  return outcomeOf(await cmd.call());
}

async function twin(run: Run): Promise<Outcome> {
  const n = nativeRun(run);
  expect(await oursRun(run), JSON.stringify(run)).toEqual(n);
  return n;
}

/** t0008's test_expect_success_multi: the verbosities, with and without the index. */
async function multi(args: string[], options: { cwd?: string; stdin?: string } = {}) {
  for (const index of [[], ["--no-index"]]) {
    const runs = [[], ["-v"], ["-v", "-n"], ["--verbose", "--non-matching"]];
    const nonOption = args.filter((a) => !a.startsWith("-"));
    if (nonOption.length === 1) runs.push(["-q"]);
    for (const opts of runs) await twin({ args: [...index, ...opts, ...args], ...options });
  }
}

describeGit("git check-ignore against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "check-ignore-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    const g = (...args: string[]) => git(root, repo, args);
    g("init", "-q", "-b", "main");
    mkdirSync(join(repo, "a/b/ignored-dir"), { recursive: true });
    mkdirSync(join(repo, "a/submodule"), { recursive: true });
    mkdirSync(join(repo, "b"), { recursive: true });
    symlinkSync("b", join(repo, "a/symlink"));
    const sub = join(repo, "a/submodule");
    git(root, sub, ["init", "-q"]);
    writeFiles(sub, { a: "a\n" });
    git(root, sub, ["add", "a"]);
    git(root, sub, ["commit", "-q", "-m", "commit in submodule"]);
    g("add", "a/submodule");
    writeFiles(repo, {
      ".gitignore": "one\nignored-*\ntop-level-dir/\n",
      "not-ignored": "",
      "ignored-and-untracked": "",
      "ignored-but-in-index": "",
      "a/not-ignored": "",
      "a/ignored-and-untracked": "",
      "a/ignored-but-in-index": "",
      "a/.gitignore": "two*\n*three\n",
      "a/b/.gitignore": [
        "four",
        "five",
        "# this comment should affect the line numbers",
        "six",
        "ignored-dir/",
        "# and so should this blank line:",
        "",
        "!on*",
        "!two",
        "",
      ].join("\n"),
      "a/b/ignored-dir/.gitignore": "seven\n",
      "global-excludes": "globalone\n!globaltwo\nglobalthree\n",
      ".git/info/exclude": "per-repo\n",
    });
    g("add", "-f", "ignored-but-in-index", "a/ignored-but-in-index");
  });
  afterAll(() => removeTempDir(root), CLEANUP_TIMEOUT);

  // t0008's test_expect_success_multi cases too: . corner-case, empty command line, --stdin
  // with empty STDIN, erroneous use of --, --stdin (-z) with superfluous arg, -z without --stdin
  it('t0008-ignores.sh: "-q with multiple args", "--quiet with multiple args"', async () => {
    await multi(["."]);
    await multi([]);
    await multi(["--stdin"], { stdin: "" });
    await twin({ args: ["-q", "one", "two"] });
    await twin({ args: ["--quiet", "one", "two"] });
    for (const v of ["-v", "--verbose"]) {
      for (const q of ["-q", "--quiet"]) await twin({ args: [q, v, "foo"] });
    }
    await multi(["--"]);
    await multi(["--stdin", "foo"]);
    await multi(["--stdin", "-z", "foo"]);
    await multi(["-z"]);
    await multi(["-z", "foo"]);
    await twin({ args: ["-n", "foo"] });
    // absolute paths: against the worktree, or git's death outside it
    await twin({ args: ["-v", join(repo, "a/one"), join(repo, "one")] });
    await twin({ args: [join(root, "elsewhere")] });
    await twin({ args: ["-v", join(repo, "one")], cwd: "a" });
  });

  // t0008-ignores.sh's test_expect_success_multi cases: non-existent file at top-level (not)
  // ignored, existing tracked / untracked file at top-level, mix of file types at top-level and
  // in subdir a/, with and without --no-index
  it("t0008-ignores.sh: files tracked and untracked, at the top and in a subdirectory", async () => {
    for (const subdir of ["", "a/"]) {
      for (const name of [
        "non-existent",
        "one",
        "not-ignored",
        "ignored-but-in-index",
        "ignored-and-untracked",
      ]) {
        await multi([`${subdir}${name}`]);
      }
      await multi(
        ["non-existent", "one", "not-ignored", "ignored-but-in-index", "ignored-and-untracked"].map(
          (n) => `${subdir}${n}`,
        ),
      );
    }
  });

  it('t0008-ignores.sh: "sub-directory local ignore", "sub-directory local ignore with --verbose", "local ignore inside a sub-directory", "local ignore inside a sub-directory with --verbose", "nested include of negated pattern", "nested include of negated pattern with -v -n"', async () => {
    await twin({ args: ["a/3-three", "a/three-not-this-one"] });
    await twin({ args: ["--verbose", "a/3-three", "a/three-not-this-one"] });
    await twin({ args: ["3-three", "three-not-this-one"], cwd: "a" });
    await twin({ args: ["--verbose", "3-three", "three-not-this-one"], cwd: "a" });
    await twin({ args: ["a/b/one"] });
    await twin({ args: ["-q", "a/b/one"] });
    await twin({ args: ["-v", "a/b/one"] });
    await twin({ args: ["-v", "-n", "a/b/one"] });
  });

  it('t0008-ignores.sh: "multiple files inside ignored sub-directory", "multiple files inside ignored sub-directory with -v", "cd to ignored sub-directory", "cd to ignored sub-directory with -v"', async () => {
    await multi(["a/b/ignored-dir"]);
    const inside = ["a/b/ignored-dir/foo", "a/b/ignored-dir/twoooo", "a/b/ignored-dir/seven"];
    await twin({ args: inside });
    await twin({ args: ["-v", ...inside] });
    const rel = ["foo", "twoooo", "../one", "seven", "../../one"];
    await twin({ args: rel, cwd: "a/b/ignored-dir" });
    await twin({ args: ["-v", ...rel], cwd: "a/b/ignored-dir" });
  });

  // t0008-ignores.sh's test_expect_success_multi cases: symlink, beyond a symlink (from
  // subdirectory), submodule (from subdirectory)
  it("t0008-ignores.sh: symbolic links and submodules", async () => {
    await multi(["a/symlink"]);
    await multi(["a/symlink/foo"]);
    await multi(["symlink/foo"], { cwd: "a" });
    await multi(["a/submodule/one"]);
    await multi(["submodule/one"], { cwd: "a" });
  });

  it('t0008-ignores.sh: "global ignore not yet enabled", "global ignore", "global ignore with -v"', async () => {
    const paths = [
      "globalone",
      "per-repo",
      "globalthree",
      "a/globalthree",
      "a/per-repo",
      "not-ignored",
      "globaltwo",
    ];
    await twin({ args: ["-v", ...paths] });
    git(root, repo, ["config", "core.excludesfile", "global-excludes"]);
    await twin({ args: paths });
    await twin({ args: ["-v", ...paths] });
  });

  it('t0008-ignores.sh: "--stdin", "--stdin -q", "--stdin -v", "--stdin from subdirectory", "--stdin from subdirectory with -v", "--stdin from subdirectory with -v -n", "--stdin -z from subdirectory with -v"', async () => {
    const top = [
      "one",
      "not-ignored",
      "a/one",
      "a/not-ignored",
      "a/b/on",
      "a/b/one",
      "a/b/one one",
      '"a/b/one two"',
      '"a/b/one\\"three"',
      "a/b/not-ignored",
      "a/b/two",
      "a/b/twooo",
      "globaltwo",
      "a/globaltwo",
      "a/b/globaltwo",
      "b/globaltwo",
    ];
    const fromA = [
      "../one",
      "../not-ignored",
      "one",
      "not-ignored",
      "b/on",
      "b/one",
      "b/one one",
      '"b/one two"',
      '"b/one\\"three"',
      "b/two",
      "b/not-ignored",
      "b/twooo",
      "../globaltwo",
      "globaltwo",
      "b/globaltwo",
      "../b/globaltwo",
      "c/not-ignored",
    ];
    // broken_c_unquote: the quotes and the first backslash dropped, NUL-terminated
    const zero = (lines: string[]) =>
      lines.map((l) => l.replace(/^"/, "").replace("\\", "").replace(/"$/, "")).join("\0");
    for (const [lines, cwd] of [
      [top, undefined],
      [fromA, "a"],
    ] as const) {
      const stdin = `${lines.join("\n")}\n`;
      for (const opts of [[], ["-q"], ["-v"], ["-v", "-n"]]) {
        await twin({ args: ["--stdin", ...opts], stdin, ...(cwd ? { cwd } : {}) });
        await twin({
          args: ["--stdin", "-z", ...opts],
          stdin: `${zero(lines)}\0`,
          ...(cwd ? { cwd } : {}),
        });
      }
    }
    await twin({ args: ["--stdin"], stdin: 'one\n"bad\\q"\none\n' });
  });

  it('t0008-ignores.sh: "existing file and directory", "existing directory and file", "exact prefix matching (with root)", "exact prefix matching (without root)", "directories and ** matches", "** not confused by matching leading prefix"', async () => {
    writeFiles(repo, { one: "" });
    mkdirSync(join(repo, "top-level-dir"));
    try {
      await twin({ args: ["one", "top-level-dir"] });
      await twin({ args: ["-v", "top-level-dir", "one"] });
    } finally {
      rmSync(join(repo, "one"));
      rmSync(join(repo, "top-level-dir"), { recursive: true });
    }
    const other = join(root, "other");
    mkdirSync(other);
    const saved = repo;
    repo = other;
    try {
      git(root, other, ["init", "-q"]);
      for (const pattern of ["/git/\n", "git/\n"]) {
        writeFiles(other, { "a/.gitignore": pattern, "a/git/foo": "", "a/git-foo/bar": "" });
        await twin({ args: ["-v", "a/git", "a/git/foo", "a/git-foo", "a/git-foo/bar"] });
      }
      writeFiles(other, { ".gitignore": "data/**\n!data/**/\n!data/**/*.txt\n" });
      await twin({
        args: [
          "-v",
          "-n",
          "file",
          "data/file",
          "data/data1/file1",
          "data/data1/file1.txt",
          "data/data2/file2",
          "data/data2/file2.txt",
        ],
      });
      // git 2.44+ keeps one literal character for wildmatch (2.43 also takes `foobar`)
      if (nativeAtLeast(2, 44)) {
        writeFiles(other, { ".gitignore": "foo**/bar\n" });
        await twin({ args: ["foobar", "foo/bar"] });
      }
      writeFiles(other, {
        ".gitignore": "\\#hash\n\\!bang\nsp\\ \ntab\t\n\xe9t\xe9\n",
        "x/\xe9.gitignore": "",
      });
      await twin({ args: ["-v", "#hash", "!bang", "sp ", "tab\t", "\xe9t\xe9"] });
    } finally {
      repo = saved;
    }
  });

  // JGit FileNameMatcherTest#testSpecialGroupCase7..9 and #testVerySimplePatternCase0 found
  // these: check-ignore reads each path as a pathspec (parse_pathspec with every magic but
  // `:/` refused), so `:]` is `]`, and an empty path dies before any output
  it("paths as pathspecs: magic and the empty path", async () => {
    for (const args of [
      ["-v", "-n", ":]", ":", ":/one", "::one"],
      ["-v", ":!one"],
      ["-v", ":^one"],
      ["-v", ":(glob)one"],
      ["-v", ":(literal)one"],
      ["-v", ":(icase,exclude)one"],
      ["-v", ":(top)one"],
      ["-v", ":(glob,literal)one"],
      ["-v", ":(nosuch)one"],
      ["-v", ":(top"],
      ["-v", "one", ""],
      ["-v", "one", "../outside"],
    ]) {
      await twin({ args });
      await twin({ args, cwd: "a" });
    }
    await twin({ args: ["-v", "-n", "--stdin"], stdin: "one\n:/one\n\nnever-reached\n" });
    await twin({ args: ["-v", "-n", "--stdin", "-z"], stdin: "one\0:!one\0one\0" });
    await twin({ args: ["-v", "-n", "--stdin"], stdin: "one\n:/one\n", cwd: "a" });
  });
});
