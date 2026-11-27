/**
 * `git show` against native git (statewalker-root#312): commits (medium format with the
 * patch, merges' dense combined diff, `-c`, `-m`, `--first-parent`, `--stat`, `--summary`,
 * `--name-only`, `--format`, `-s`, `--quiet`), annotated tags (the header, then the tagged
 * object), trees (`tree <name>` and the entries), blobs (raw, `--textconv`), `<rev>:<path>`,
 * several objects at once and ranges (which walk). Each test names the git t/ script and the
 * test whose scenario it replays; the command runs on native git and on our ShowCommand,
 * comparing stdout, stderr and the exit status byte for byte.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  type DiffTextOptions,
  installTextconvRunner,
  type ShowCommand,
  type ShowOptions,
  type TextconvRunner,
} from "../src/index.js";
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
  root ??= mkdtempSync(join(tmpdir(), "show-native-"));
  return root;
};
let repoCount = 0;

/** test-lib.sh's helpers, with a clock that ticks per commit */
const PRELUDE = `
tick=1112911993
test_tick () { tick=$((tick + 60)); export GIT_COMMITTER_DATE="$tick +0000" GIT_AUTHOR_DATE="$tick +0000"; }
test_write_lines () { printf "%s\\n" "$@"; }
test_commit () { f=\${2:-$1.t}; mkdir -p "$(dirname "$f")"; echo "\${3:-$1}" >"$f"; git add "$f"; test_tick; git commit -q -m "$1"; git tag "$1"; }
test_merge () { test_tick; git merge -q -m "$1" "$2"; git tag "$1"; }
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

interface Outcome {
  status: number;
  stdout: Buffer;
  stderr: string;
}

function native(dir: string, args: string[]): Outcome {
  const res = spawnSync("git", ["show", ...args], {
    cwd: dir,
    env: { ...nativeGitEnv(tmp()), COLUMNS: "80" },
  });
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr.toString() };
}

/** `git show`'s command line as our options and arguments (the options the tests use). */
function parseArgs(args: string[]): { options: ShowOptions; rest: string[]; maxCount?: number } {
  const options: ShowOptions = {};
  const rest: string[] = [];
  let maxCount: number | undefined;
  let dashdash = false;
  for (const arg of args) {
    if (dashdash || !arg.startsWith("-") || arg === "--") {
      if (arg === "--") dashdash = true;
      rest.push(arg);
      continue;
    }
    if (arg === "--stat") options.stat = true;
    else if (arg === "--summary") options.summary = true;
    else if (arg === "--patch-with-stat") {
      options.patch = true;
      options.stat = true;
    } else if (arg === "-p" || arg === "--patch") options.patch = true;
    else if (arg === "--name-only") options.nameOnly = true;
    else if (arg === "--name-status") options.nameStatus = true;
    else if (arg === "-s" || arg === "--no-patch" || arg === "--quiet") options.noPatch = true;
    else if (arg === "-c") options.c = true;
    else if (arg === "--cc") options.cc = true;
    else if (arg === "-m") options.m = true;
    else if (arg === "--root") options.showRoot = true;
    else if (arg === "--first-parent") options.firstParent = true;
    else if (arg === "--graph") options.graph = true;
    else if (arg === "--oneline") options.oneline = true;
    else if (arg === "--textconv") options.textconv = true;
    else if (arg === "--no-textconv") options.textconv = false;
    else if (arg.startsWith("--format=") || arg.startsWith("--pretty=")) {
      options.pretty = arg.slice(arg.indexOf("=") + 1);
    } else if (/^-\d+$/.test(arg)) maxCount = Number(arg.slice(1));
    else throw new Error(`unknown option ${arg}`);
  }
  return { options, rest, ...(maxCount !== undefined ? { maxCount } : {}) };
}

async function ours(
  dir: string,
  args: string[],
  setup?: (show: ShowCommand) => void,
): Promise<Outcome> {
  const git = await openOurs(dir);
  const { options, rest, maxCount } = parseArgs(args);
  const show = git.show().setOptions({ ...options, diff: versionOptions });
  for (const arg of rest) show.addArgument(arg);
  if (maxCount !== undefined) show.setMaxCount(maxCount);
  setup?.(show);
  try {
    const r = await show.call();
    return {
      status: r.exitCode,
      stdout: Buffer.from(r.stdout),
      stderr: r.errors.map((l) => `${l}\n`).join(""),
    };
  } catch (e) {
    const err = e as { exitCode?: number; message: string };
    return { status: err.exitCode ?? -1, stdout: Buffer.alloc(0), stderr: `${err.message}\n` };
  }
}

/** Runs `git show <args>` on both and expects the same outcome */
async function twin(
  dir: string,
  args: string[],
  setup?: (show: ShowCommand) => void,
): Promise<Outcome> {
  const theirs = native(dir, args);
  const mine = await ours(dir, args, setup);
  expect(mine.stderr, `stderr of git show ${args.join(" ")}`).toBe(theirs.stderr);
  expect(mine.stdout.toString("latin1"), `stdout of git show ${args.join(" ")}`).toBe(
    theirs.stdout.toString("latin1"),
  );
  expect(mine.status, `status of git show ${args.join(" ")}`).toBe(theirs.status);
  return theirs;
}

describeGit("git show: t7007-show", () => {
  let dir: string;
  const history = () => {
    dir ??= repo(`
test_commit main1
test_commit main2
test_commit main3
git tag -m "annotated tag" annotated
git checkout -q -b side HEAD^^
test_commit side2
test_commit side3
test_merge merge main3
`);
    return dir;
  };

  it('t7007-show.sh: "showing a tag that point at a missing object"', async () => {
    const d = repo(`
echo hello world >foo
H=$(git hash-object -w foo)
test_tick
git tag -a foo-tag -m "Tags $H" $H
rm -f .git/objects/$(expr "$H" : "\\(..\\)")/$(expr "$H" : "..\\(.*\\)")
`);
    const r = await twin(d, ["foo-tag"]);
    expect(r.status).not.toBe(0);
  });

  it('t7007-show.sh: "showing two commits"', async () => {
    await twin(history(), ["main2", "main3"]);
  });

  it('t7007-show.sh: "showing a tree"', async () => {
    await twin(history(), ["main1:"]);
  });

  it('t7007-show.sh: "showing two trees"', async () => {
    await twin(history(), ["main1^{tree}", "main2^{tree}"]);
  });

  it('t7007-show.sh: "showing a trees is not recursive"', async () => {
    const d = repo(`
test_commit main1
mkdir a
test_commit a/file
`);
    await twin(d, ["HEAD^{tree}"]);
  });

  it('t7007-show.sh: "showing a range walks (linear)"', async () => {
    await twin(history(), ["main1..main3"]);
  });

  it('t7007-show.sh: "showing a range walks (Y shape, ^ first)"', async () => {
    await twin(history(), ["^side3", "main3"]);
  });

  it('t7007-show.sh: "showing a range walks (Y shape, ^ last)"', async () => {
    await twin(history(), ["main3", "^side3"]);
  });

  it('t7007-show.sh: "showing with -N walks"', async () => {
    await twin(history(), ["-2", "main3"]);
  });

  it('t7007-show.sh: "showing annotated tag"', async () => {
    await twin(history(), ["annotated"]);
  });

  it('t7007-show.sh: "showing annotated tag plus commit"', async () => {
    await twin(history(), ["annotated", "side3"]);
  });

  it('t7007-show.sh: "showing range"', async () => {
    await twin(history(), ["^side3", "annotated"]);
  });

  it('t7007-show.sh: "-s suppresses diff"', async () => {
    await twin(history(), ["-s", "--format=%s", "merge", "main3"]);
  });

  it('t7007-show.sh: "--quiet suppresses diff"', async () => {
    await twin(history(), ["--quiet", "--format=%s", "main3"]);
  });

  it('t7007-show.sh: "show --graph is forbidden"', async () => {
    const r = await twin(history(), ["--graph", "HEAD"]);
    expect(r.status).toBe(128);
  });

  // the same history, other object mixes
  it('t7007-show.sh: "set up a bit of history", then a commit named twice is shown once', async () => {
    await twin(history(), ["main3", "main3", "main3^{commit}"]);
    await twin(history(), ["annotated", "main3"]);
  });

  it('t7007-show.sh: "set up a bit of history", then blobs, trees, tags and commits mixed', async () => {
    await twin(history(), ["main1:main1.t", "main2", "main2:main2.t", "main1^{tree}"]);
    await twin(history(), ["main1^{tree}", "annotated", "main1:", "merge"]);
    await twin(history(), ["--format=%s", "annotated", "main1^{tree}", "main2"]);
    await twin(history(), ["--oneline", "annotated", "main1^{tree}", "main2"]);
    await twin(history(), ["--pretty=fuller", "annotated"]);
    await twin(history(), ["--pretty=raw", "annotated"]);
    await twin(history(), ["--format=email", "annotated"]);
  });

  it('t7007-show.sh: "set up a bit of history", then no argument shows HEAD', async () => {
    await twin(history(), []);
  });

  it('t7007-show.sh: "set up a bit of history", then merges, --stat and --name-only', async () => {
    await twin(history(), ["merge"]);
    await twin(history(), ["--stat", "merge"]);
    await twin(history(), ["--name-only", "merge", "side3"]);
    await twin(history(), ["--name-status", "side3"]);
    await twin(history(), ["-m", "merge"]);
    await twin(history(), ["-c", "merge"]);
  });

  it('t7007-show.sh: "set up a bit of history", then paths limit which commits show', async () => {
    await twin(history(), ["main3", "--", "main1.t"]);
    await twin(history(), ["main3", "main2", "--", "main3.t"]);
    await twin(history(), ["merge", "--", "main3.t"]);
    await twin(history(), ["main1", "--", "main1.t"]);
    await twin(history(), ["main1", "--", "nothing"]);
    await twin(history(), ["main1^{tree}", "--", "nothing"]);
  });

  it('t7007-show.sh: "set up a bit of history", then tags of tags, trees and blobs', async () => {
    const d = repo(`
test_commit main1
test_tick
git tag -m "tag of a tree" tree-tag main1^{tree}
git tag -m "tag of a blob" blob-tag main1:main1.t
git tag -m "first" first main1
git -c advice.nestedTag=false tag -m "tag of a tag" nested first
git tag -m "no newline" -m "two paragraphs" para main1
`);
    await twin(d, ["tree-tag"]);
    await twin(d, ["blob-tag", "main1"]);
    await twin(d, ["nested"]);
    await twin(d, ["para", "first"]);
    await twin(d, ["--format=%s", "nested", "tree-tag"]);
  });

  it('t7007-show.sh: "set up a bit of history", then revisions that name nothing', async () => {
    await twin(history(), ["nope"]);
    await twin(history(), ["main1:nope"]);
    await twin(history(), ["nope", "--"]);
    const empty = repo("");
    await twin(empty, []);
  });
});

describeGit("git show: t4013-diff-various", () => {
  let dir: string;
  const history = () => {
    dir ??= repo(`
export GIT_AUTHOR_DATE="2006-06-26 00:00:00 +0000" GIT_COMMITTER_DATE="2006-06-26 00:00:00 +0000"
mkdir dir dir2
test_write_lines 1 2 3 >file0
test_write_lines A B >dir/sub
cat file0 >file2
git add file0 file2 dir/sub
git commit -q -m Initial
git branch initial
git branch side
export GIT_AUTHOR_DATE="2006-06-26 00:01:00 +0000" GIT_COMMITTER_DATE="2006-06-26 00:01:00 +0000"
test_write_lines 4 5 6 >>file0
test_write_lines C D >>dir/sub
rm -f file2
git update-index --remove file0 file2 dir/sub
git commit -q -m "Second

This is the second commit."
export GIT_AUTHOR_DATE="2006-06-26 00:02:00 +0000" GIT_COMMITTER_DATE="2006-06-26 00:02:00 +0000"
test_write_lines A B C >file1
git add file1
test_write_lines E F >>dir/sub
git update-index dir/sub
git commit -q -m Third
export GIT_AUTHOR_DATE="2006-06-26 00:03:00 +0000" GIT_COMMITTER_DATE="2006-06-26 00:03:00 +0000"
git checkout -q side
test_write_lines A B C >>file0
test_write_lines 1 2 >>dir/sub
cat dir/sub >file3
git add file3
git update-index file0 dir/sub
git commit -q -m Side
export GIT_AUTHOR_DATE="2006-06-26 00:04:00 +0000" GIT_COMMITTER_DATE="2006-06-26 00:04:00 +0000"
git checkout -q main
git pull -q -s ours --no-rebase . side
export GIT_AUTHOR_DATE="2006-06-26 00:05:00 +0000" GIT_COMMITTER_DATE="2006-06-26 00:05:00 +0000"
test_write_lines A B C >>file0
test_write_lines 1 2 >>dir/sub
git update-index file0 dir/sub
git config log.showroot false
git commit -q --amend --no-edit
export GIT_AUTHOR_DATE="2006-06-26 00:06:00 +0000" GIT_COMMITTER_DATE="2006-06-26 00:06:00 +0000"
git checkout -q -b note initial
git update-index --chmod=+x file2
git commit -q -m "update mode (file2)"
git notes add -m "note"
git checkout -q -f main
git config diff.renames false
`);
    return dir;
  };

  for (const args of [
    ["initial"],
    ["--root", "initial"],
    ["side"],
    ["main"],
    ["-c", "main"],
    ["-m", "main"],
    ["--first-parent", "main"],
    ["--stat", "side"],
    ["--stat", "--summary", "side"],
    ["--patch-with-stat", "side"],
    ["--patch-with-stat", "--summary", "side"],
    ["note"],
  ]) {
    it(`t4013-diff-various.sh: "git show ${args.join(" ")} # magic is (not used)"`, async () => {
      await twin(history(), args);
    });
  }

  it('t4013-diff-various.sh: "show A B ... -- <pathspec>"', async () => {
    await twin(history(), ["--name-only", "--format=<%s>", "side", "main^", "main^^", "--", "dir"]);
  });
});

describeGit("git show: t4030-diff-textconv", () => {
  let dir: string;
  const history = () => {
    dir ??= repo(`
printf '#!/bin/sh\\ntr "\\\\000\\\\001" "01" <"$1"\\n' >hexdump
chmod +x hexdump
printf '\\0\\n' >file
git add file
test_tick
git commit -q -m one
printf '\\01\\n' >>file
git add file
test_tick
git commit -q -m two
echo file diff=foo >.gitattributes
git config diff.foo.textconv "\\"$(pwd)\\""/hexdump
`);
    return dir;
  };
  const nodeTextconv: TextconvRunner = async ({ command, path, content }) => {
    const d = mkdtempSync(join(tmp(), "textconv-"));
    try {
      const file = join(d, `XXXXXX_${basename(path)}`);
      writeFileSync(file, content);
      const res = spawnSync("sh", ["-c", `${command} "$@"`, command, file], {
        env: nativeGitEnv(tmp()),
      });
      if (res.status !== 0) throw new Error(`error running textconv command '${command}'`);
      return new Uint8Array(res.stdout);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  };
  const withRunner = (show: ShowCommand) => {
    installTextconvRunner((show as unknown as { workingCopy: never }).workingCopy, nodeTextconv);
  };

  it('t4030-diff-textconv.sh: "show commit produces text"', async () => {
    await twin(history(), ["HEAD"], withRunner);
  });

  it('t4030-diff-textconv.sh: "show blob produces binary"', async () => {
    await twin(history(), ["HEAD:file"], withRunner);
  });

  it('t4030-diff-textconv.sh: "show --textconv blob produces text"', async () => {
    const r = await twin(history(), ["--textconv", "HEAD:file"], withRunner);
    expect(r.stdout.toString()).toBe("0\n1\n");
  });

  it('t4030-diff-textconv.sh: "show --no-textconv blob produces binary"', async () => {
    await twin(history(), ["--no-textconv", "HEAD:file"], withRunner);
  });

  it('t4030-diff-textconv.sh: "setup textconv filters", then --textconv of a blob named by id or index path', async () => {
    const id = sh(history(), "git rev-parse HEAD:file").trim();
    await twin(history(), ["--textconv", id], withRunner);
    await twin(history(), ["--textconv", ":file", "HEAD~1:file"], withRunner);
  });
});

describeGit("git show: unreadable objects", () => {
  /** stderr with zlib's reason left out of the inflate line (pako and the system zlib word it alike, but not always) */
  const normalise = (stderr: string) =>
    stderr.replace(
      /^error: inflate: data stream error \(.*\)$/m,
      "error: inflate: data stream error",
    );

  /** A repository whose packed blob `file` (seq 1 2000) has 16 bytes overwritten in its data */
  const corrupt = (extra = "") =>
    repo(`
seq 1 2000 >file
git add file
test_tick
git commit -q -m one
${extra}
git gc -q
pack=$(ls .git/objects/pack/*.pack)
blob=$(git rev-parse HEAD:file)
ofs=$(git show-index <\${pack%.pack}.idx | awk -v b=$blob '$2 == b { print $1 }')
chmod 0644 $pack
printf '%016d' 0 | dd of=$pack bs=1 conv=notrunc seek=$((ofs + 10)) 2>/dev/null
`);

  it('t5303-pack-corruption-resilience.sh: "create corruption in data of first object", then git show of the blob', async () => {
    const dir = corrupt();
    const theirs = native(dir, ["HEAD:file"]);
    const mine = await ours(dir, ["HEAD:file"]);
    expect(theirs.status).toBe(128);
    expect(mine.status).toBe(theirs.status);
    expect(normalise(mine.stderr)).toBe(normalise(theirs.stderr));
    expect(mine.stdout.toString("latin1")).toBe(theirs.stdout.toString("latin1"));
  });

  it('t5303-pack-corruption-resilience.sh: "create corruption in data of first object", then git show of a tag of the blob', async () => {
    const dir = corrupt("git tag -m 'tag of a blob' blob-tag HEAD:file");
    // a commit's diff of the blob dies otherwise (2.56.1 even crashes): -s leaves it out
    for (const args of [["blob-tag"], ["-s", "HEAD", "HEAD:file"]]) {
      const theirs = native(dir, args);
      const mine = await ours(dir, args);
      expect(theirs.status).toBe(128);
      expect(mine.status, args.join(" ")).toBe(theirs.status);
      expect(normalise(mine.stderr), args.join(" ")).toBe(normalise(theirs.stderr));
      expect(mine.stdout.toString("latin1"), args.join(" ")).toBe(theirs.stdout.toString("latin1"));
    }
  });

  it('t7007-show.sh: "set up a bit of history", then --format=email of a tag with a non-ASCII tagger', async () => {
    const dir = repo(`
test_commit main1
test_tick
GIT_COMMITTER_NAME="Jöhn Dœ" git tag -m "annotated" annotated
GIT_COMMITTER_NAME="Mr. Dot, Jr." git tag -m "quoted" quoted
`);
    await twin(dir, ["--format=email", "annotated"]);
    await twin(dir, ["--pretty=fuller", "annotated"]);
    await twin(dir, ["--format=email", "quoted", "annotated"]);
  });
});
