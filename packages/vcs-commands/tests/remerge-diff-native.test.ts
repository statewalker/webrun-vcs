/**
 * `git log --remerge-diff` and `git show --remerge-diff` against native git
 * (statewalker-root#347): each merge shown as the diff between merge-ort's automatic result
 * (conflict markers included) and the recorded merge, with merge-ort's conflict messages as
 * `remerge CONFLICT` headers. The scenarios replay git's `t/t4069-remerge-diff.sh` (each test
 * names the one it takes its inputs from), plus `--diff-merges=remerge`, `log.diffMerges`,
 * octopus merges, a virtual merge base and a walk that must store no objects. The command
 * runs on native git and on ours, comparing stdout byte for byte.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { type DiffTextOptions, type LogOutputOptions, mergesMode } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "";
const [major, minor] = (/(\d+)\.(\d+)/.exec(version) ?? ["", "0", "0"]).slice(1).map(Number);
const atLeast = (ma: number, mi: number) => major > ma || (major === ma && minor >= mi);
/** Diff behaviour that changed between git 2.43 (sandbox) and 2.5x (CI) */
const versionOptions: DiffTextOptions = {
  histogramRediff: atLeast(2, 54),
  legacyMinimal: !atLeast(2, 50),
  renameCountLastSpan: atLeast(2, 50),
  namesFromContents: atLeast(2, 50),
  quietDetectsRenames: !atLeast(2, 50),
  exitCodeFromContents: atLeast(2, 50),
};

let root: string | undefined;
afterAll(async () => {
  if (root) await removeTempDir(root);
}, CLEANUP_TIMEOUT);
const tmp = () => {
  root ??= mkdtempSync(join(tmpdir(), "remerge-diff-native-"));
  return root;
};
let repoCount = 0;

/** test-lib.sh's helpers, with a clock that ticks per commit */
const PRELUDE = `
tick=1112911993
test_tick () { tick=$((tick + 60)); export GIT_COMMITTER_DATE="$tick +0000" GIT_AUTHOR_DATE="$tick +0000"; }
test_write_lines () { printf "%s\\n" "$@"; }
test_commit () { f=\${2:-$1.t}; mkdir -p "$(dirname "$f")"; echo "\${3:-$1}" >"$f"; git add "$f"; test_tick; git commit -q -m "$1"; git tag "$1"; }
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

function native(dir: string, command: "log" | "show", args: string[]): Buffer {
  const res = spawnSync("git", [command, ...args], {
    cwd: dir,
    env: { ...nativeGitEnv(tmp()), COLUMNS: "80" },
  });
  if (res.status !== 0) throw new Error(`git ${command} ${args.join(" ")}: ${res.stderr}`);
  return res.stdout;
}

/** The command line's options as ours (the options the tests use) */
function parse(args: string[]): {
  options: LogOutputOptions;
  diff: DiffTextOptions;
  revisions: string[];
  paths: string[];
  maxCount?: number;
  all: boolean;
} {
  const options: LogOutputOptions = {};
  const diff: DiffTextOptions = { ...versionOptions };
  const revisions: string[] = [];
  const paths: string[] = [];
  let maxCount: number | undefined;
  let dashdash = false;
  let all = false;
  for (const a of args) {
    const value = (prefix: string) => (a.startsWith(prefix) ? a.slice(prefix.length) : undefined);
    if (dashdash) paths.push(a);
    else if (a === "--") dashdash = true;
    else if (a === "--all") all = true;
    else if (a === "--oneline") options.oneline = true;
    else if (a === "-p") options.patch = true;
    else if (a === "-m") options.m = true;
    else if (a === "--stat") options.stat = true;
    else if (a === "--name-status") options.nameStatus = true;
    else if (a === "--reverse") options.reverse = true;
    else if (a === "--remerge-diff") options.remergeDiff = true;
    else if (value("--diff-merges=") !== undefined)
      options.diffMerges = mergesMode(value("--diff-merges=") as string);
    else if (value("--diff-filter=") !== undefined) diff.diffFilter = value("--diff-filter=");
    else if (value("-S") !== undefined) diff.pickaxeString = value("-S");
    else if (value("--find-object=") !== undefined)
      diff.findObjects = [value("--find-object=") as string];
    else if (value("--submodule=") !== undefined)
      diff.submoduleFormat = value("--submodule=") as "log";
    else if (/^-\d+$/.test(a)) maxCount = Number(a.slice(1));
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else revisions.push(a);
  }
  return { options, diff, revisions, paths, all, ...(maxCount !== undefined ? { maxCount } : {}) };
}

async function ours(dir: string, command: "log" | "show", args: string[]): Promise<Buffer> {
  const git = await openOurs(dir);
  const { options, diff, revisions, paths, maxCount, all } = parse(args);
  if (command === "show") {
    const show = git.show().setOptions(options).setDiffOptions(diff);
    for (const r of revisions) show.addArgument(r);
    for (const p of paths) show.addPath(p);
    if (maxCount !== undefined) show.setMaxCount(maxCount);
    const r = await show.call();
    return Buffer.from(r.stdout);
  }
  const log = git.log().setDiffOptions(diff);
  // 2.43 freed the parents of the commits it showed: a later merge's bases stop there
  if (!atLeast(2, 44)) log.setCompatibility("2.43");
  // LogCommand takes ids: the names resolved as git resolves them
  for (const r of revisions) {
    const id = execFileSync("git", ["rev-parse", "--verify", r], {
      cwd: dir,
      env: nativeGitEnv(tmp()),
    })
      .toString()
      .trim();
    log.add(id, r);
  }
  for (const p of paths) log.addPath(p);
  if (all) log.all();
  if (maxCount !== undefined) log.setMaxCount(maxCount);
  return Buffer.from(await log.callBytes(options));
}

/** Runs `git <command> <args>` on both and expects the same stdout */
async function twin(dir: string, command: "log" | "show", args: string[]): Promise<string> {
  const theirs = native(dir, command, args).toString("latin1");
  const mine = (await ours(dir, command, args)).toString("latin1");
  expect(mine, `git ${command} ${args.join(" ")}`).toBe(theirs);
  return theirs;
}

/** t4069's "setup basic merges" */
const BASIC = `
test_write_lines 1 2 3 4 5 6 7 8 9 >numbers
git add numbers
test_tick; git commit -q -m base
git branch feature_a; git branch feature_b; git branch feature_c
git branch ab_resolution; git branch bc_resolution
git checkout -q feature_a
test_write_lines 1 2 three 4 5 6 7 eight 9 >numbers
test_tick; git commit -q -a -m change_a
git checkout -q feature_b
test_write_lines 1 2 tres 4 5 6 7 8 9 >numbers
test_tick; git commit -q -a -m change_b
git checkout -q feature_c
test_write_lines 1 2 3 4 5 6 7 8 9 10 >numbers
test_tick; git commit -q -a -m change_c
git checkout -q bc_resolution
git merge -q --ff-only feature_b
test_tick; git merge -q --no-edit feature_c
git checkout -q ab_resolution
git merge -q --ff-only feature_a
test_tick; git merge -q --no-edit feature_b >/dev/null 2>&1 && exit 1
test_write_lines 1 2 drei 4 5 6 7 acht 9 >numbers
git add numbers
test_tick; git commit -q --no-edit
`;

/** t4069's first "setup non-content conflicts" */
const NON_CONTENT = `
git switch -q --orphan base
test_write_lines 1 2 3 4 5 6 7 8 9 >numbers
test_write_lines a b c d e f g h i >letters
test_write_lines in the way >content
git add numbers letters content
test_tick; git commit -q -m base
git branch side1; git branch side2
git checkout -q side1
test_write_lines 1 2 three 4 5 6 7 8 9 >numbers
git mv letters letters_side1
git mv content file_or_directory
git add numbers
test_tick; git commit -q -m side1
git checkout -q side2
git rm -q numbers
git mv letters letters_side2
mkdir file_or_directory
echo hello >file_or_directory/world
git add file_or_directory/world
test_tick; git commit -q -m side2
git checkout -q -b resolution side1
test_tick; git merge -q side2 >/dev/null 2>&1 && exit 1
test_write_lines 1 2 three 4 5 6 7 8 9 >numbers
git add numbers
git add letters_side1
git rm -q letters
git rm -q letters_side2
git add file_or_directory~HEAD
git mv file_or_directory~HEAD wanted_content
test_tick; git commit -q -m resolved
`;

/** t4069's second "setup non-content conflicts" (a conflict resolved to their side) */
const THEIRS_RESOLVED = `
git switch -q --orphan newbase
test_write_lines 1 2 3 4 5 6 7 8 9 >numbers
git add numbers
test_tick; git commit -q -m base
git branch newside1; git branch newside2
git checkout -q newside1
test_write_lines 1 2 three 4 5 6 7 8 9 >numbers
git add numbers
test_tick; git commit -q -m side1
git checkout -q newside2
test_write_lines 1 2 drei 4 5 6 7 8 9 >numbers
git add numbers
test_tick; git commit -q -m side2
git checkout -q -b newresolution newside1
test_tick; git merge -q newside2 >/dev/null 2>&1 && exit 1
git checkout --theirs numbers
git add -u numbers
test_tick; git commit -q -m resolved
`;

describeGit("--remerge-diff: t4069-remerge-diff", () => {
  let dir: string | undefined;
  const history = () => {
    dir ??= repo(BASIC + NON_CONTENT + THEIRS_RESOLVED);
    return dir;
  };

  it('t4069-remerge-diff.sh: "remerge-diff on a clean merge"', async () => {
    const out = await twin(history(), "show", ["--oneline", "--remerge-diff", "bc_resolution"]);
    expect(out.split("\n").length).toBe(2);
  });

  it('t4069-remerge-diff.sh: "remerge-diff on a clean merge with a filter"', async () => {
    const out = await twin(history(), "show", [
      "--oneline",
      "--remerge-diff",
      "--diff-filter=U",
      "bc_resolution",
    ]);
    expect(out).toBe("");
  });

  it('t4069-remerge-diff.sh: "remerge-diff with both a resolved conflict and an unrelated change"', async () => {
    const out = await twin(history(), "show", ["--oneline", "--remerge-diff", "ab_resolution"]);
    expect(out).toContain("remerge CONFLICT (content): Merge conflict in numbers\n");
    expect(out).toContain("-<<<<<<< ");
  });

  it('t4069-remerge-diff.sh: "pickaxe still includes additional headers for relevant changes"', async () => {
    const out = await twin(history(), "log", [
      "--oneline",
      "--remerge-diff",
      "-Sacht",
      "ab_resolution",
    ]);
    expect(out).toContain("remerge CONFLICT (content)");
  });

  it('t4069-remerge-diff.sh: "can filter out additional headers with pickaxe"', async () => {
    const d = history();
    const head = native(d, "log", ["-1", "--format=%H"]).toString().trim();
    expect(
      await twin(d, "show", [
        "--remerge-diff",
        "--submodule=log",
        `--find-object=${head}`,
        "ab_resolution",
      ]),
    ).toBe("");
    // `git show -S... --all` walks as `git log --all` does with show's defaults
    expect(await twin(d, "log", ["--remerge-diff", "-Snot present", "--all"])).toBe("");
  });

  it('t4069-remerge-diff.sh: "remerge-diff with non-content conflicts"', async () => {
    const out = await twin(history(), "show", ["--oneline", "--remerge-diff", "resolution"]);
    expect(out).toContain("remerge CONFLICT (rename/rename)");
    expect(out).toContain("remerge CONFLICT (modify/delete)");
    expect(out).toContain("remerge CONFLICT (file/directory)");
  });

  it('t4069-remerge-diff.sh: "remerge-diff w/ diff-filter=U: all conflict headers, no diff content"', async () => {
    const out = await twin(history(), "show", [
      "--oneline",
      "--remerge-diff",
      "--diff-filter=U",
      "resolution",
    ]);
    expect(out).not.toContain("@@");
  });

  it('t4069-remerge-diff.sh: "submodule formatting ignores additional headers"', async () => {
    await twin(history(), "show", [
      "--oneline",
      "--remerge-diff",
      "--diff-filter=U",
      "--submodule=log",
      "resolution",
    ]);
  });

  it('t4069-remerge-diff.sh: "remerge-diff w/ diff-filter=R: relevant file + conflict header"', async () => {
    const out = await twin(history(), "show", [
      "--oneline",
      "--remerge-diff",
      "--diff-filter=R",
      "resolution",
    ]);
    expect(out).toContain("rename to wanted_content\nremerge CONFLICT (file/directory)");
  });

  it('t4069-remerge-diff.sh: "remerge-diff w/ pathspec: limits to relevant file including conflict header"', async () => {
    const out = await twin(history(), "show", [
      "--oneline",
      "--remerge-diff",
      "resolution",
      "--",
      "letters*",
    ]);
    expect(out).toContain("remerge CONFLICT (rename/rename)");
    expect(out).not.toContain("numbers");
  });

  it('t4069-remerge-diff.sh: "remerge-diff turns off history simplification"', async () => {
    const out = await twin(history(), "show", [
      "--oneline",
      "--remerge-diff",
      "newresolution",
      "--",
      "numbers",
    ]);
    expect(out).toContain("remerge CONFLICT (content)");
  });

  it('t4069-remerge-diff.sh: "remerge-diff with --reverse"', async () => {
    const d = history();
    await twin(d, "log", ["-1", "--remerge-diff", "--oneline", "ab_resolution^"]);
    await twin(d, "log", ["-1", "--remerge-diff", "--oneline", "ab_resolution"]);
    // the commits' dates differ here, so `-2` lists ab_resolution's second parent
    const both = await twin(d, "log", [
      "-2",
      "--remerge-diff",
      "--oneline",
      "ab_resolution",
      "--reverse",
    ]);
    expect(both).toContain("remerge CONFLICT");
  });

  it('t4069-remerge-diff.sh: "setup basic merges", "setup non-content conflicts": the whole log under --remerge-diff, --diff-merges=remerge and =r, --stat, --name-status', async () => {
    const d = history();
    await twin(d, "log", ["--remerge-diff", "--all"]);
    await twin(d, "log", ["--diff-merges=remerge", "--all"]);
    await twin(d, "log", ["--diff-merges=r", "-p", "--all"]);
    await twin(d, "log", ["--remerge-diff", "--stat", "--all"]);
    await twin(d, "log", ["--remerge-diff", "--name-status", "--all"]);
  });

  it('t4069-remerge-diff.sh: "setup basic merges", "setup non-content conflicts": log.diffMerges=remerge under -m', async () => {
    const d = repo(`${BASIC}${NON_CONTENT}\ngit config log.diffMerges remerge\n`);
    await twin(d, "log", ["-m", "-p", "--all"]);
    await twin(d, "log", ["-m", "--all"]);
  });
});

describeGit("--remerge-diff: octopus merges and virtual merge bases", () => {
  it('t4069-remerge-diff.sh: "setup basic merges", under merge.conflictStyle=diff3 and with a binary conflict', async () => {
    const d = repo(`${BASIC}
git config merge.conflictStyle diff3
git checkout -q main
printf 'a\\0b\\n' >bin; git add bin; test_tick; git commit -q -m bin
git checkout -q -b bin2
printf 'a\\0c\\n' >bin; test_tick; git commit -q -a -m bin2
git checkout -q main
printf 'a\\0d\\n' >bin; test_tick; git commit -q -a -m bin1
test_tick; git merge -q --no-edit bin2 >/dev/null 2>&1 && exit 1
printf 'a\\0e\\n' >bin; git add bin; test_tick; git commit -q --no-edit
`);
    const out = await twin(d, "log", ["--remerge-diff", "--all"]);
    expect(out).toContain("|||||||");
    expect(out).toContain("remerge warning: Cannot merge binary files: bin");
  });

  // log-tree.c's warning for octopus merges, over a smaller octopus than t7602's
  it('t7602-merge-octopus-many.sh: "setup": an octopus merge is skipped with a warning', async () => {
    const d = repo(`
test_commit base
git checkout -q -b one main; test_commit one
git checkout -q -b two main; test_commit two
git checkout -q -b three main; test_commit three
git checkout -q main
test_tick; git merge -q -m octopus one two three
`);
    const out = await twin(d, "log", ["--remerge-diff", "-1"]);
    expect(out).toContain("diff: warning: Skipping remerge-diff for octopus merges.\n");
    await twin(d, "log", ["--oneline", "--remerge-diff"]);
  });

  it('t6404-recursive-merge.sh: "setup tests" (a criss-cross): the merge of the two merge bases stays silent', async () => {
    const d = repo(`
test_write_lines 1 2 3 4 5 6 7 8 9 >f
git add f; test_tick; git commit -q -m base
git branch b
test_write_lines 1 2 A 4 5 6 7 8 9 >f; test_tick; git commit -q -a -m A
git checkout -q b
test_write_lines 1 2 3 4 5 6 7 B 9 >f; test_tick; git commit -q -a -m B
git checkout -q -b c main
test_tick; git merge -q --no-edit b
git checkout -q b
test_tick; git merge -q --no-edit main
test_write_lines 1 2 A 4 5 6 7 B 9 x >f; test_tick; git commit -q -a -m B2
git checkout -q c
test_write_lines 1 2 A 4 5 6 7 B 9 y >f; test_tick; git commit -q -a -m C2
test_tick; git merge -q --no-edit b >/dev/null 2>&1 && exit 1
test_write_lines 1 2 A 4 5 6 7 B 9 x y >f
git add f; test_tick; git commit -q --no-edit
`);
    const out = await twin(d, "log", ["--remerge-diff", "-1"]);
    expect(out).toContain("remerge CONFLICT (content)");
    await twin(d, "log", ["--remerge-diff", "--oneline"]);
  });
});

/** The loose objects and the objects in packs (`git count-objects -v`'s count and in-pack) */
function countObjects(dir: string): { loose: string[]; inPack: number } {
  const objects = join(dir, ".git", "objects");
  const loose: string[] = [];
  for (const fan of readdirSync(objects)) {
    if (!/^[0-9a-f]{2}$/.test(fan)) continue;
    for (const name of readdirSync(join(objects, fan))) loose.push(fan + name);
  }
  const counted = spawnSync("git", ["count-objects", "-v"], {
    cwd: dir,
    env: nativeGitEnv(tmp()),
    encoding: "utf8",
  }).stdout;
  const inPack = Number(/in-pack: (\d+)/.exec(counted)?.[1] ?? "0");
  return { loose: loose.sort(), inPack };
}

describeGit("--remerge-diff stores no objects", () => {
  it('t4069-remerge-diff.sh: "setup basic merges", "setup non-content conflicts": no loose or packed object is added by a remerge-diff walk', async () => {
    const d = repo(BASIC + NON_CONTENT + THEIRS_RESOLVED);
    // half the objects packed, the rest loose
    sh(d, "git repack -q -a -d\ntest_commit after-pack\n");
    const before = countObjects(d);
    const packsBefore = readdirSync(join(d, ".git", "objects", "pack")).sort();
    expect(before.inPack).toBeGreaterThan(0);
    expect(before.loose.length).toBeGreaterThan(0);
    const out = await ours(d, "log", ["--remerge-diff", "--all"]);
    expect(out.toString()).toContain("remerge CONFLICT");
    expect((await ours(d, "show", ["--remerge-diff", "resolution"])).toString()).toContain(
      "remerge CONFLICT",
    );
    const after = countObjects(d);
    expect(after.loose).toEqual(before.loose);
    expect(after.inPack).toBe(before.inPack);
    expect(readdirSync(join(d, ".git", "objects", "pack")).sort()).toEqual(packsBefore);
  });
});
