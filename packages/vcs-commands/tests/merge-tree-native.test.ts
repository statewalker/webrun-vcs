/**
 * `git merge-tree` (builtin/merge-tree.c), native twins: t4301-merge-tree-write-tree.sh (the
 * `--write-tree` mode: tree, conflicted entries, messages, `-z`, `--name-only`, `--stdin`,
 * `--merge-base`, `-X`) and t4300-merge-tree.sh (the trivial three-tree merge). Each
 * repository is built by native git; then native git and ours run the same command on it and
 * stdout (bytes), stderr and the exit status are compared, with git as the oracle. Ours must
 * leave refs, the index and the worktree as they were.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, MergeTreeCommand } from "../src/index.js";
import { compatibilityOf, type Outcome, Shell } from "./describe-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let shell: Shell;
let compatibility: "2.43" | "2.56";
let counter = 0;

/** `git merge-tree <argv>` mapped onto our MergeTreeCommand (cmd_merge_tree's parsing). */
function mergeTreeArgs(git: Git, argv: string[], input?: string): MergeTreeCommand {
  const command = git.mergeTree().setCompatibility(compatibility);
  const positional: string[] = [];
  let mode: "write-tree" | "trivial" | undefined;
  let options = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!options || !arg.startsWith("-")) {
      // PARSE_OPT_STOP_AT_NON_OPTION
      options = false;
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const [opt, value] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    switch (opt) {
      case "--end-of-options":
        options = false;
        break;
      case "--write-tree":
        mode = "write-tree";
        break;
      case "--trivial-merge":
        mode = "trivial";
        break;
      case "--messages":
        command.setMessages(true);
        break;
      case "--no-messages":
        command.setMessages(false);
        break;
      case "--name-only":
        command.setNameOnly(true);
        break;
      case "-z":
        command.setNulTerminated(true);
        break;
      case "--allow-unrelated-histories":
        command.setAllowUnrelatedHistories(true);
        break;
      case "--quiet":
        command.setQuiet(true);
        break;
      case "--stdin":
        command.setStdin(input ?? "");
        break;
      case "--merge-base":
        command.setMergeBase(value ?? (argv[++i] as string));
        break;
      case "-X":
      case "--strategy-option":
        command.addStrategyOption(value ?? (argv[++i] as string));
        break;
      default:
        if (opt.startsWith("-X")) command.addStrategyOption(arg.slice(2));
        else throw new Error(`unmapped option ${arg}`);
    }
  }
  if (input !== undefined && !argv.includes("--stdin")) throw new Error("input without --stdin");
  const trivial = mode === "trivial" || (mode === undefined && positional.length === 3);
  if (trivial) {
    command.setTrivialMerge(
      positional[0] as string,
      positional[1] as string,
      positional[2] as string,
    );
  } else if (positional.length === 2) {
    command.setBranches(positional[0] as string, positional[1] as string);
  } else if (mode === "write-tree") {
    command.setMode("write-tree");
  }
  return command;
}

/** What a repository's refs, index and HEAD are (ours must not change them). */
function repositoryState(dir: string): string {
  const refs = shell.ok(dir, "for-each-ref", "--format=%(refname) %(objectname)");
  const head = shell.git(dir, ["symbolic-ref", "-q", "HEAD"]).stdout;
  let index = "";
  try {
    index = readFileSync(join(dir, ".git", "index")).toString("base64");
  } catch {
    // a bare repository
  }
  const status = shell.git(dir, ["status", "--porcelain", "--ignored"]).stdout;
  return `${refs}\n${head}\n${index}\n${status}`;
}

/** `git merge-tree <argv>` in `dir`, native and ours, compared; native's outcome. */
async function check(dir: string, argv: string[], input?: string): Promise<Outcome> {
  const native = shell.git(dir, ["merge-tree", ...argv], {
    latin1Stdout: true,
    ...(input !== undefined ? { input } : {}),
  });
  const before = repositoryState(dir);
  const git = await openOurs(dir);
  const out = await mergeTreeArgs(git, argv, input).callOutput();
  const ours: Outcome = {
    status: out.exitCode,
    stdout: Buffer.from(out.stdout).toString("latin1"),
    stderr: out.stderr,
  };
  expect({ argv, ...ours }).toEqual({ argv, ...native });
  expect(repositoryState(dir)).toBe(before);
  return native;
}

/** {@link check} in a bare repository. */
async function checkBare(dir: string, argv: string[]): Promise<Outcome> {
  const native = shell.git(dir, ["merge-tree", ...argv], { latin1Stdout: true });
  const git = await openOurs(dir, undefined, undefined, "", false, ".");
  const out = await mergeTreeArgs(git, argv).callOutput();
  const ours: Outcome = {
    status: out.exitCode,
    stdout: Buffer.from(out.stdout).toString("latin1"),
    stderr: out.stderr,
  };
  expect({ argv, ...ours }).toEqual({ argv, ...native });
  return native;
}

/** A new repository (`main` its initial branch). */
function repository(name: string): string {
  const dir = join(root, `${name}-${counter++}`);
  shell.ok(root, "init", "-q", "-b", "main", dir);
  return dir;
}

/** Runs a setup script in `dir` with test-lib's helpers (test_write_lines, test_commit). */
function script(dir: string, body: string): void {
  const lib = `
set -e
test_write_lines () { printf "%s\\n" "$@"; }
test_tick () {
  if test -z "\${test_tick+set}"; then test_tick=1112911993; else test_tick=$((test_tick + 60)); fi
  GIT_COMMITTER_DATE="$test_tick -0700"; GIT_AUTHOR_DATE="$test_tick -0700"
  export GIT_COMMITTER_DATE GIT_AUTHOR_DATE
}
test_commit () {
  test_tick
  file=\${2:-$1.t}
  mkdir -p "$(dirname "$file")"
  printf "%s\\n" "\${3:-$1}" >"$file"
  git add -- "$file"
  git commit -q -m "$1"
  git tag "\${4:-$1}"
}
`;
  const r = spawnSync("sh", ["-c", `${lib}\n${body}`], {
    cwd: dir,
    env: { ...nativeGitEnv(root), GIT_EDITOR: "true" },
  });
  if (r.status !== 0) {
    throw new Error(`setup failed: ${r.stderr.toString()}\n${r.stdout.toString()}`);
  }
}

describeGit("git merge-tree --write-tree, native twins (t4301)", () => {
  let dir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-tree-native-"));
    shell = new Shell(root);
    compatibility = compatibilityOf(shell);
    dir = repository("t4301");
    // t4301-merge-tree-write-tree.sh: "setup"
    script(
      dir,
      `
test_write_lines 1 2 3 4 5 >numbers
echo hello >greeting
echo foo >whatever
git add numbers greeting whatever
test_tick
git commit -q -m initial

git branch side1
git branch side2
git branch side3
git branch side4

git checkout -q side1
test_write_lines 1 2 3 4 5 6 >numbers
echo hi >greeting
echo bar >whatever
git add numbers greeting whatever
test_tick
git commit -q -m modify-stuff

git checkout -q side2
test_write_lines 0 1 2 3 4 5 >numbers
echo yo >greeting
git rm -q whatever
mkdir whatever
>whatever/empty
git add numbers greeting whatever/empty
test_tick
git commit -q -m other-modifications

git checkout -q side3
git mv numbers sequence
test_tick
git commit -q -m rename-numbers

git checkout -q side4
test_write_lines 0 1 2 3 4 5 >numbers
echo yo >greeting
git add numbers greeting
test_tick
git commit -q -m other-content-modifications

git switch -q --orphan unrelated
>something-else
git add something-else
test_tick
git commit -q -m first-commit
`,
    );
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('t4301: "Clean merge"', async () => {
    const out = await check(dir, ["--write-tree", "side1", "side3"]);
    expect(out.status).toBe(0);
  });

  it('t4301: "Failed merge without rename detection"', async () => {
    shell.ok(dir, "config", "diff.renames", "false");
    try {
      const out = await check(dir, ["--write-tree", "side1", "side3"]);
      // git 2.43's merge-ort detected renames whatever the configuration said
      if (compatibility !== "2.43") {
        expect(out.status).toBe(1);
        expect(out.stdout).toContain("CONFLICT (modify/delete): numbers deleted");
      }
      await check(dir, ["--write-tree", "-X", "find-renames", "side1", "side3"]);
    } finally {
      shell.ok(dir, "config", "--unset", "diff.renames");
    }
    await check(dir, ["--write-tree", "-X", "no-renames", "side1", "side3"]);
    shell.ok(dir, "config", "merge.renames", "false");
    try {
      await check(dir, ["--write-tree", "side1", "side3"]);
    } finally {
      shell.ok(dir, "config", "--unset", "merge.renames");
    }
  });

  it('t4301: "Content merge and a few conflicts"', async () => {
    const out = await check(dir, ["--write-tree", "side1", "side2"]);
    expect(out.status).toBe(1);
  });

  it('t4301: `Auto resolve conflicts by "ours" strategy option`', async () => {
    await check(dir, ["-X", "ours", "side1", "side4"]);
    await check(dir, ["-Xours", "side1", "side4"]);
  });

  it("an unknown strategy option dies (exit 128)", async () => {
    const out = await check(dir, ["-X", "bogus", "side1", "side4"]);
    expect(out.status).toBe(128);
  });

  it('t4301: "test conflict notices and such"', async () => {
    await check(dir, ["--write-tree", "--name-only", "side1", "side2"]);
  });

  it('t4301: "Just the conflicted files without the messages"', async () => {
    await check(dir, ["--write-tree", "--no-messages", "--name-only", "side1", "side2"]);
  });

  it('t4301: "Check conflicted oids and modes without messages"', async () => {
    await check(dir, ["--write-tree", "--no-messages", "side1", "side2"]);
  });

  it("--messages on a clean merge prints the blank line and the messages", async () => {
    await check(dir, ["--write-tree", "--messages", "side1", "side4"]);
    await check(dir, ["--write-tree", "--messages", "side1", "side3"]);
  });

  it('t4301: `NUL terminated conflicted file "lines"`', async () => {
    const tweak = repository("tweak");
    script(tweak, `git fetch -q ${JSON.stringify(dir)} side1:side1 side2:side2`);
    script(
      tweak,
      `
git checkout -q -b tweak1 side1
test_write_lines zero 1 2 3 4 5 6 >numbers
git add numbers
git mv numbers "Αυτά μου φαίνονται κινέζικα"
git commit -q -m "Renamed numbers"
`,
    );
    await check(tweak, ["--write-tree", "-z", "tweak1", "side2"]);
    // without -z the non-ASCII name is quoted (core.quotePath), and not with it off
    await check(tweak, ["--write-tree", "tweak1", "side2"]);
    shell.ok(tweak, "config", "core.quotePath", "false");
    await check(tweak, ["--write-tree", "--name-only", "tweak1", "side2"]);
  });

  it("conflicted paths are printed relative to the current directory", async () => {
    const repo = repository("prefix");
    script(
      repo,
      `mkdir -p sub/deeper
echo base >sub/deeper/f
echo base >top
git add .
git commit -q -m base
git branch other
echo ours >sub/deeper/f
echo ours >top
git commit -q -am ours
git checkout -q other
echo theirs >sub/deeper/f
echo theirs >top
git commit -q -am theirs`,
    );
    for (const argv of [
      ["--write-tree", "main", "other"],
      ["--write-tree", "--name-only", "main", "other"],
      ["--write-tree", "-z", "main", "other"],
    ]) {
      const cwd = join(repo, "sub");
      const native = shell.git(cwd, ["merge-tree", ...argv], { latin1Stdout: true });
      const git = await openOurs(repo);
      const out = await mergeTreeArgs(git, argv).setPrefix("sub/").callOutput();
      expect({
        argv,
        status: out.exitCode,
        stdout: Buffer.from(out.stdout).toString("latin1"),
        stderr: out.stderr,
      }).toEqual({ argv, ...native });
      expect(native.stdout).toContain("../top");
    }
  });

  it('t4301: "error out by default for unrelated histories"', async () => {
    const out = await check(dir, ["--write-tree", "side1", "unrelated"]);
    expect(out.status).toBe(128);
  });

  it('t4301: "can override merge of unrelated histories"', async () => {
    await check(dir, ["--write-tree", "--allow-unrelated-histories", "side1", "unrelated"]);
  });

  it("a name that is no commit is not something we can merge (exit 1)", async () => {
    await check(dir, ["--write-tree", "side1", "no-such-branch"]);
    await check(dir, ["--write-tree", "side1^{tree}", "side2"]);
  });

  it('t4301: "--stdin with both a successful and a conflicted merge"', async () => {
    await check(dir, ["--stdin"], "side1 side3\nside1 side2");
  });

  it('t4301: "--merge-base is incompatible with --stdin"', async () => {
    const out = await check(dir, ["--merge-base=side1", "--stdin"], "");
    expect(out.status).toBe(128);
  });

  it('t4301: "check the input format when --stdin is passed"', async () => {
    const repo = repository("stdin-format");
    script(repo, "test_commit c1\ntest_commit c2\ntest_commit c3");
    await check(repo, ["--stdin"], "c1 c3\nc2 -- c1 c3\nc2 c3");
    await check(repo, ["--write-tree", "-z", "c1", "c3"]);
    await check(repo, ["--write-tree", "-z", "--merge-base=c2", "c1", "c3"]);
    const malformed = await check(repo, ["--stdin"], "c1 c3\nc1\n");
    expect(malformed.status).toBe(128);
    // the split of each line: 2.5x trims each space-separated field, 2.43 splits after each
    // space and trims the fields' ends (a trailing space makes no field)
    await check(repo, ["--stdin"], "c1 c2 c3\n");
    await check(repo, ["--stdin"], "c1 c3 \n");
    await check(repo, ["--stdin"], "c2 -- c1 c3 \n");
    await check(repo, ["--stdin"], "c1  c3\n");
    await check(repo, ["--stdin"], "\n");
    await check(repo, ["--stdin"], "c1\tc3 c2\n");
  });

  it('t4301: "specify merge-base as parent of branch2"', async () => {
    const repo = repository("base-b2-p");
    script(repo, "test_commit c1 file1\ntest_commit c2 file2\ntest_commit c3 file3");
    await check(repo, ["--write-tree", "--merge-base=c2", "c1", "c3"]);
  });

  it('t4301: "--merge-base with tree OIDs"', async () => {
    await check(dir, ["--merge-base=side1^", "side1", "side3"]);
    // git 2.43 takes the branches and the base as commits only
    await check(dir, ["--merge-base=side1^^{tree}", "side1^{tree}", "side3^{tree}"]);
    await check(dir, ["--merge-base=side1^^{tree}", "side1", "side3"]);
    await check(dir, ["--merge-base=nope", "side1", "side3"]);
    await check(dir, ["--merge-base=side1^", "side1", "nope"]);
  });

  it("the --trivial-merge mode refuses the other options", async () => {
    // t4301: "usage: --trivial-merge is incompatible with $opt"
    for (const opt of ["--messages", "--name-only", "-z", "--allow-unrelated-histories"]) {
      const out = await check(dir, ["--trivial-merge", opt, "side1", "side2", "side3"]);
      expect(out.status).toBe(128);
    }
    await check(dir, ["--trivial-merge", "--stdin", "side1", "side2", "side3"], "");
    await check(dir, ["--trivial-merge", "-X", "ours", "side1", "side2", "side3"]);
  });

  // t4301's pack names (`side3-tree-is-missing-<id>.pack`): git reads any `*.idx` in
  // objects/pack, and so does ours (statewalker/webrun-vcs#363)
  it('t4301: "error out on missing tree objects"', async () => {
    const bare = join(root, `missing-tree-${counter++}.git`);
    shell.ok(root, "init", "-q", "--bare", bare);
    script(
      dir,
      `{ git rev-list side3; git rev-parse side3^:; } |
git pack-objects -q ${JSON.stringify(bare)}/objects/pack/side3-tree-is-missing`,
    );
    const side3 = shell.ok(dir, "rev-parse", "side3").trim();
    const out = await checkBare(bare, [`${side3}^`, side3]);
    // git 2.43 reported the tree and merged it as an empty one
    expect(out.status).toBe(compatibility === "2.43" ? 0 : 128);
  });

  it('t4301: "error out on missing blob objects"', async () => {
    const bare = join(root, `missing-blob-${counter++}.git`);
    shell.ok(root, "init", "-q", "--bare", bare);
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      ids.push(shell.git(dir, ["hash-object", "-w", "--stdin"], { input: `${n}\n` }).stdout.trim());
    }
    const trees = ids.map(
      (id) =>
        shell.git(dir, ["mktree"], { input: `100644 blob ${id}\tblob\n` }).stdout.trim() as string,
    );
    shell.git(dir, ["pack-objects", "-q", `${bare}/objects/pack/side1-whatever-is-missing`], {
      input: [ids[0], ids[2], ...trees].join("\n"),
    });
    const out = await checkBare(bare, [`--merge-base=${trees[0]}`, trees[1], trees[2]]);
    expect(out.status).not.toBe(0);
  });

  it('t4301: "--quiet on clean merge", "--quiet on conflicted merge"', async () => {
    if (compatibility === "2.43") {
      // --quiet is 2.5x's: 2.43 refuses the option (usage errors compare their first line)
      const argv = ["--write-tree", "--quiet", "side1", "side3"];
      const native = shell.git(dir, ["merge-tree", ...argv]);
      const out = await mergeTreeArgs(await openOurs(dir), argv).callOutput();
      expect([out.exitCode, out.stderr.split("\n")[0]]).toEqual([
        native.status,
        native.stderr.split("\n")[0],
      ]);
      return;
    }
    const objects = () => shell.ok(dir, "count-objects");
    shell.ok(dir, "gc", "-q");
    const before = objects();
    expect((await check(dir, ["--write-tree", "--quiet", "side1", "side3"])).status).toBe(0);
    expect((await check(dir, ["--write-tree", "--quiet", "side1", "side2"])).status).toBe(1);
    expect(objects()).toBe(before);
    const both = await check(dir, ["--quiet", "--messages", "side1", "side2"]);
    expect(both.status).toBe(128);
    await check(dir, ["--quiet", "-z", "side1", "side2"]);
  });
});

/** t4301's other scenarios, each in a repository of its own (O, A, B branches). */
describeGit("git merge-tree -z conflict details, native twins (t4301)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-tree-native-"));
    shell = new Shell(root);
    compatibility = compatibilityOf(shell);
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A repository from `original` (on main), with branches O, A and B, A and B scripted. */
  function scenario(name: string, original: string, a: string, b: string): string {
    const dir = repository(name);
    script(
      dir,
      `
${original}
git commit -q -m original
git branch O
git branch A
git branch B
git checkout -q A
${a}
git commit -q -m A
git checkout -q B
${b}
git commit -q -m B
`,
    );
    return dir;
  }

  async function twins(dir: string): Promise<void> {
    await check(dir, ["-z", "A^0", "B^0"]);
    await check(dir, ["A^0", "B^0"]);
  }

  it('t4301: "directory rename + content conflict"', async () => {
    const dir = scenario(
      "dir-rename-and-content",
      `test_write_lines 1 2 3 4 5 >foo
mkdir olddir
for i in a b c; do echo $i >olddir/$i; done
git add foo olddir`,
      `test_write_lines 1 2 3 4 5 6 >foo
git add foo
git mv olddir newdir`,
      `test_write_lines 1 2 3 4 5 six >foo
git add foo
git mv foo olddir/bar`,
    );
    await twins(dir);
  });

  it('t4301: "rename/delete handling"', async () => {
    const dir = scenario(
      "rename-delete",
      "test_write_lines 1 2 3 4 5 >foo\ngit add foo",
      "test_write_lines 1 2 3 4 5 6 >foo\ngit add foo\ngit mv foo bar",
      "git rm -q foo",
    );
    await twins(dir);
  });

  it('t4301: "rename/add handling"', async () => {
    const dir = scenario(
      "rename-add",
      "test_write_lines original 1 2 3 4 5 >foo\ngit add foo",
      'test_write_lines 1 2 3 4 5 >foo\necho "different file" >bar\ngit add foo bar',
      "test_write_lines original 1 2 3 4 5 6 >foo\ngit add foo\ngit mv foo bar",
    );
    await twins(dir);
  });

  it('t4301: "rename/add, where add is a mode conflict"', async () => {
    const dir = scenario(
      "rename-add-symlink",
      "test_write_lines original 1 2 3 4 5 >foo\ngit add foo",
      "test_write_lines 1 2 3 4 5 >foo\nln -s foo bar\ngit add foo bar",
      "test_write_lines original 1 2 3 4 5 6 >foo\ngit add foo\ngit mv foo bar",
    );
    await twins(dir);
  });

  it('t4301: "rename/rename + content conflict"', async () => {
    const dir = scenario(
      "rr-plus-content",
      "test_write_lines 1 2 3 4 5 >foo\ngit add foo",
      "test_write_lines 1 2 3 4 5 six >foo\ngit add foo\ngit mv foo bar",
      "test_write_lines 1 2 3 4 5 6 >foo\ngit add foo\ngit mv foo baz",
    );
    await twins(dir);
  });

  it('t4301: "rename/add/delete conflict"', async () => {
    const dir = scenario(
      "rad",
      'echo "original file" >foo\ngit add foo',
      'git rm -q foo\necho "different file" >bar\ngit add bar',
      "git mv foo bar",
    );
    await twins(dir);
  });

  it('t4301: "rename/rename(2to1)/delete/delete conflict"', async () => {
    const dir = scenario(
      "rrdd",
      "echo foo >foo\necho bar >bar\ngit add foo bar",
      "git mv foo baz\ngit rm -q bar",
      "git mv bar baz\ngit rm -q foo",
    );
    await twins(dir);
  });

  it('t4301: "mod6: chains of rename/rename(1to2) and add/add via colliding renames"', async () => {
    const dir = scenario(
      "mod6",
      `test_seq () { i=$1; while test $i -le $2; do echo $i; i=$((i + 1)); done; }
test_seq 11 19 >one
test_seq 31 39 >three
test_seq 51 59 >five
git add .
test_tick`,
      `test_seq () { i=$1; while test $i -le $2; do echo $i; i=$((i + 1)); done; }
test_seq 10 19 >one
echo 40 >>three
git add one three
git mv one two
git mv three four
git mv five six
test_tick`,
      `echo 20 >>one
echo forty >>three
echo 60 >>five
git add one three five
git mv one six
git mv three two
git mv five four
test_tick`,
    );
    await twins(dir);
  });

  it('t4301: "directory rename + rename/delete + modify/delete + directory/file conflict"', async () => {
    const dir = scenario(
      "4-stacked-conflict",
      `test_write_lines 1 2 3 4 5 >foo
mkdir olddir
for i in a b c; do echo $i >olddir/$i; done
git add foo olddir`,
      `git rm -q foo
git mv olddir newdir
mkdir newdir/bar
>newdir/bar/file
git add newdir/bar/file`,
      `test_write_lines 1 2 3 4 5 6 >foo
git add foo
git mv foo olddir/bar`,
    );
    await twins(dir);
  });
});

describeGit("git merge-tree trivial merge, native twins (t4300)", () => {
  let dir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-tree-trivial-"));
    shell = new Shell(root);
    compatibility = compatibilityOf(shell);
    dir = repository("t4300");
    // t4300-merge-tree.sh: "setup"
    script(dir, 'test_commit "initial" "initial-file" "initial"');
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Runs a t4300 step's setup (from `git reset --hard initial`), then the twins. */
  async function step(setup: string, ...argv: string[]): Promise<Outcome> {
    script(dir, `git reset -q --hard initial\ngit clean -qfdx\n${setup}`);
    return check(dir, argv);
  }

  it('t4300: "file add A, !B"', async () => {
    const out = await step(
      'test_commit "add-a-not-b" "ONE" "AAA"',
      "initial",
      "initial",
      "add-a-not-b",
    );
    expect(out.stdout).toContain("added in remote");
  });

  it('t4300: "file add !A, B"', async () => {
    const out = await step(
      'test_commit "add-not-a-b" "ONE" "AAA"',
      "initial",
      "add-not-a-b",
      "initial",
    );
    expect(out.stdout).toBe("");
  });

  it('t4300: "file add A, B (same)"', async () => {
    await step(
      `test_commit "add-a-b-same-A" "ONE" "AAA"
git reset -q --hard initial
test_commit "add-a-b-same-B" "ONE" "AAA"`,
      "initial",
      "add-a-b-same-A",
      "add-a-b-same-B",
    );
  });

  it('t4300: "file add A, B (different)"', async () => {
    const out = await step(
      `test_commit "add-a-b-diff-A" "ONE" "AAA"
git reset -q --hard initial
test_commit "add-a-b-diff-B" "ONE" "BBB"`,
      "initial",
      "add-a-b-diff-A",
      "add-a-b-diff-B",
    );
    expect(out.stdout).toContain("added in both");
  });

  it('t4300: "file change A, !B"', async () => {
    await step(
      'test_commit "change-a-not-b" "initial-file" "BBB"',
      "initial",
      "change-a-not-b",
      "initial",
    );
  });

  it('t4300: "file change !A, B"', async () => {
    const out = await step(
      'test_commit "change-not-a-b" "initial-file" "BBB"',
      "initial",
      "initial",
      "change-not-a-b",
    );
    expect(out.stdout).toContain("merged");
  });

  it('t4300: "file change A, B (same)"', async () => {
    await step(
      `test_commit "change-a-b-same-A" "initial-file" "AAA"
git reset -q --hard initial
test_commit "change-a-b-same-B" "initial-file" "AAA"`,
      "initial",
      "change-a-b-same-A",
      "change-a-b-same-B",
    );
  });

  it('t4300: "file change A, B (different)"', async () => {
    const out = await step(
      `test_commit "change-a-b-diff-A" "initial-file" "AAA"
git reset -q --hard initial
test_commit "change-a-b-diff-B" "initial-file" "BBB"`,
      "initial",
      "change-a-b-diff-A",
      "change-a-b-diff-B",
    );
    expect(out.stdout).toContain("changed in both");
  });

  it('t4300: "file change A, B (mixed)"', async () => {
    const out = await step(
      `test_commit "change-a-b-mix-base" "ONE" "
AAA
AAA
AAA
AAA
AAA
AAA
AAA
AAA
AAA
AAA
AAA
AAA
AAA
AAA
AAA"
test_commit "change-a-b-mix-A" "ONE" "$(sed -e "1{s/AAA/BBB/;}" -e "10{s/AAA/BBB/;}" <ONE)"
git reset -q --hard change-a-b-mix-base
test_commit "change-a-b-mix-B" "ONE" "$(sed -e "1{s/AAA/BBB/;}" -e "10{s/AAA/CCC/;}" <ONE)"`,
      "change-a-b-mix-base",
      "change-a-b-mix-A",
      "change-a-b-mix-B",
    );
    expect(out.stdout).toContain("@@ -7,7 +7,11 @@");
  });

  it('t4300: "file remove A, !B", "file remove !A, B", "file remove A, B (same)"', async () => {
    script(
      dir,
      `git reset -q --hard initial
test_commit "rm-a-not-b-base" "ONE" "AAA"
git rm -q ONE
git commit -q -m "rm-a-not-b"
git tag "rm-a-not-b"`,
    );
    await check(dir, ["rm-a-not-b-base", "rm-a-not-b", "rm-a-not-b-base"]);
    const out = await check(dir, ["rm-a-not-b-base", "rm-a-not-b-base", "rm-a-not-b"]);
    expect(out.stdout).toContain("removed in remote");
    await check(dir, ["rm-a-not-b-base", "rm-a-not-b", "rm-a-not-b"]);
  });

  it('t4300: "file change A, remove B"', async () => {
    await step(
      `test_commit "change-a-rm-b-base" "ONE" "AAA"
test_commit "change-a-rm-b-A" "ONE" "BBB"
git reset -q --hard change-a-rm-b-base
git rm -q ONE
git commit -q -m "change-a-rm-b-B"
git tag "change-a-rm-b-B"`,
      "change-a-rm-b-base",
      "change-a-rm-b-A",
      "change-a-rm-b-B",
    );
  });

  it('t4300: "file remove A, change B"', async () => {
    const out = await step(
      `test_commit "rm-a-change-b-base" "ONE" "AAA"
git rm -q ONE
git commit -q -m "rm-a-change-b-A"
git tag "rm-a-change-b-A"
git reset -q --hard rm-a-change-b-base
test_commit "rm-a-change-b-B" "ONE" "BBB"`,
      "rm-a-change-b-base",
      "rm-a-change-b-A",
      "rm-a-change-b-B",
    );
    expect(out.stdout).toContain("removed in local");
  });

  it('t4300: "tree add A, B (same)", "tree add A, B (different)"', async () => {
    await step(
      'test_commit "add sub/file" "sub/file" "file" add-tree-A',
      "initial",
      "add-tree-A",
      "add-tree-A",
    );
    await step(
      `test_commit "add sub/file" "sub/file" "AAA" add-tree-a-b-A
git reset -q --hard initial
test_commit "add sub/file" "sub/file" "BBB" add-tree-a-b-B`,
      "initial",
      "add-tree-a-b-A",
      "add-tree-a-b-B",
    );
  });

  it('t4300: "tree unchanged A, removed B"', async () => {
    await step(
      `test_commit "add sub/file" "sub/file" "AAA" tree-remove-b-initial
git rm -q sub/file
test_tick
git commit -q -m "remove sub/file"
git tag tree-remove-b-B`,
      "tree-remove-b-initial",
      "tree-remove-b-initial",
      "tree-remove-b-B",
    );
  });

  it('t4300: "turn file to tree"', async () => {
    await step(
      `rm initial-file
mkdir initial-file
test_commit "turn-file-to-tree" "initial-file/ONE" "CCC"`,
      "initial",
      "initial",
      "turn-file-to-tree",
    );
  });

  it('t4300: "turn tree to file"', async () => {
    await step(
      `mkdir dir
test_commit "add-tree" "dir/path" "AAA"
test_commit "add-another-tree" "dir/another" "BBB"
rm -fr dir
test_commit "make-file" "dir" "CCC"`,
      "add-tree",
      "add-another-tree",
      "make-file",
    );
  });

  it("--trivial-merge given, with trees, and an unknown revision", async () => {
    await check(dir, ["--trivial-merge", "initial", "initial", "make-file"]);
    await check(dir, ["initial^{tree}", "add-tree^{tree}", "make-file^{tree}"]);
    const out = await check(dir, ["initial", "nope", "make-file"]);
    expect(out.status).toBe(128);
  });

  it('t4300: "merge-tree respects core.useReplaceRefs=false"', async () => {
    script(
      dir,
      `git reset -q --hard initial
test_commit merge-to
test_commit valid base
git reset -q --hard HEAD^
test_commit malicious base
git replace valid^0 malicious^0`,
    );
    try {
      await check(dir, ["--write-tree", "merge-to", "valid"]);
      shell.ok(dir, "config", "core.useReplaceRefs", "false");
      await check(dir, ["--write-tree", "merge-to", "valid"]);
    } finally {
      script(dir, "git config --unset core.useReplaceRefs || true\ngit replace -d valid^0");
    }
  });
});
