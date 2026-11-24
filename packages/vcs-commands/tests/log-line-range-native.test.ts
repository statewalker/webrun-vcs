/**
 * `git log -L <start>,<end>:<file>` and `git log -L :<funcname>:<file>` (line-log.c,
 * line-range.c) against native git: the ranges followed back through history, each commit's
 * diff cut to them, renames followed, merges, `--graph`, `--oneline`, `-s`, `--format`, the
 * range syntax (numbers, `+N`/`-N`, `/regex/`, `^/regex/`, `:funcname`, funcname patterns of
 * diff drivers) and the errors git dies with.
 *
 * Scenario source: git's t/t4211-line-log.sh. Its imported history (`t/t4211/history.export`)
 * is `fixtures/t4211-history.export`; its other setups are rebuilt here. Every scenario runs
 * on native git and on ours over the same repository and compares the output, or the message
 * and exit status git dies with. Ours follows the native git's version (2.43 prints line-log's
 * own diff, 2.5x runs the diff pipeline): `setCompatibility` is picked from `git --version`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { GitApiError, LogOutputOptions } from "../src/index.js";
import { openOurs, put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let home: string;
let clock = 1112911993;

function env(): Record<string, string> {
  return {
    ...nativeGitEnv(home),
    TZ: "UTC",
    GIT_AUTHOR_DATE: `${clock} +0000`,
    GIT_COMMITTER_DATE: `${clock} +0000`,
  };
}

function run(dir: string, args: string[], input?: string) {
  const r = spawnSync("git", args, { cwd: dir, env: env(), input });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout as Buffer).toString("latin1"),
    stderr: (r.stderr as Buffer).toString(),
  };
}

function git(dir: string, ...args: string[]): string {
  const r = run(dir, args);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** test_tick, then a commit of everything */
function commit(dir: string, message: string, ...extra: string[]): void {
  clock += 60;
  git(dir, "add", "-A");
  git(dir, "commit", "-q", ...extra, "-m", message);
}

/** The version ours follows: 2.43's line-log, or 2.5x's */
function compatibility(): "2.43" | "2.56" {
  const m = /(\d+)\.(\d+)/.exec(git(home, "--version"));
  return m && (Number(m[1]) > 2 || Number(m[2]) >= 44) ? "2.56" : "2.43";
}

/** `git log <args>` by ours: the options of `args` through the API */
async function ours(dir: string, args: string[]): Promise<{ status: number; out: string }> {
  const g = await openOurs(dir);
  const log = g.log().setCompatibility(compatibility());
  const options: LogOutputOptions = {};
  const diff: NonNullable<LogOutputOptions["diff"]> = {};
  let paths = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (paths) log.addPath(a);
    else if (a === "--") paths = true;
    else if (a === "-L") log.addLineRange(args[++i] as string);
    else if (a.startsWith("-L")) log.addLineRange(a.slice(2));
    else if (a === "--oneline") options.oneline = true;
    else if (a === "--graph") options.graph = true;
    else if (a === "--parents") options.parents = true;
    else if (a === "-s" || a === "--no-patch") options.noPatch = true;
    else if (a === "-p") options.patch = true;
    else if (a === "--name-only") options.nameOnly = true;
    else if (a === "--name-status") options.nameStatus = true;
    else if (a === "--summary") options.summary = true;
    else if (a === "--stat") options.stat = true;
    else if (a === "--full-diff") options.fullDiff = true;
    else if (a === "--follow") options.follow = true;
    else if (a === "--date-order") options.dateOrder = true;
    else if (a.startsWith("--format=")) options.pretty = `tformat:${a.slice(9)}`;
    else if (a === "--first-parent") log.setFirstParent(true);
    else if (a === "-M") diff.findRenames = true;
    else if (a === "-w") diff.ignoreWhitespace = true;
    else if (a === "-b") diff.ignoreWhitespaceChange = true;
    else if (a === "--no-prefix") diff.noPrefix = true;
    else if (a.startsWith("--src-prefix=")) diff.srcPrefix = a.slice(13);
    else if (a.startsWith("--dst-prefix=")) diff.dstPrefix = a.slice(13);
    else if (a === "--full-index") diff.fullIndex = true;
    else if (a.startsWith("--abbrev=")) options.abbrev = Number(a.slice(9));
    else if (a === "--word-diff") diff.wordDiff = "plain";
    else if (a.startsWith("--word-diff-regex=")) diff.wordDiffRegex = a.slice(18);
    else if (a.startsWith("-S")) diff.pickaxeString = a.slice(2);
    else if (a.startsWith("-G")) diff.pickaxeGrep = a.slice(2);
    else if (a.startsWith("--diff-filter=")) diff.diffFilter = a.slice(14);
    else if (a === "--numstat") options.numstat = true;
    else if (a === "-R") diff.reverse = true;
    else if (a.startsWith("--find-object=")) {
      diff.findObjects = [git(dir, "rev-parse", a.slice(14)).trim()];
    } else if (a === "--shortstat") options.shortstat = true;
    else if (a.startsWith("-U")) diff.context = Number(a.slice(2));
    else if (a.startsWith("--before=")) log.setUntil(Number(a.slice(9)));
    else if (/^-\d+$/.test(a)) log.setMaxCount(Number(a.slice(1)));
    else {
      const id = git(dir, "rev-parse", "--verify", "-q", a).trim();
      log.add(id, a);
    }
  }
  if (Object.keys(diff).length > 0) log.setDiffOptions(diff);
  try {
    const bytes = await log.callBytes(options);
    return { status: 0, out: Buffer.from(bytes).toString("latin1") };
  } catch (e) {
    const err = e as GitApiError;
    if (typeof err.exitCode !== "number") throw e;
    return { status: err.exitCode, out: err.message };
  }
}

/** Native git's and our `git log <args>`: equal output, or equal deaths */
async function compare(dir: string, args: string[]): Promise<void> {
  const native = run(dir, ["log", ...args]);
  const mine = await ours(dir, args);
  if (native.status === 0) {
    expect({ args, status: mine.status, out: mine.out }).toEqual({
      args,
      status: 0,
      out: native.stdout,
    });
  } else {
    // the message without git's `fatal: ` (some of our errors carry the bare message)
    const bare = (text: string) => text.trim().replace(/^fatal: /, "");
    expect({ args, status: mine.status, out: bare(mine.out) }).toEqual({
      args,
      status: native.status,
      out: bare(native.stderr),
    });
  }
}

const HISTORY = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "t4211-history.export");

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "log-line-range-native-"));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

/** `name` cited as t4211-line-log.sh's test of that title */
const t4211 = (title: string) => `t4211-line-log.sh: "${title}"`;

describeGit("git log -L over t4211's imported history, native", () => {
  let dir: string;

  beforeAll(() => {
    dir = join(home, "imported");
    git(home, "init", "-q", "-b", "main", dir);
    const r = run(dir, ["fast-import", "--quiet"], readFileSync(HISTORY, "utf8"));
    if (r.status !== 0) throw new Error(r.stderr);
    git(dir, "reset", "-q", "--hard");
  });

  // canned_test's title is its arguments as the script gives them
  const canned: [string, string[]][] = [
    ["-L 4,12:a.c simple", ["-L", "4,12:a.c", "simple"]],
    ["-L 4,+9:a.c simple", ["-L", "4,+9:a.c", "simple"]],
    ["-L '/long f/,/^}/:a.c' simple", ["-L", "/long f/,/^}/:a.c", "simple"]],
    ["-L :f:a.c simple", ["-L", ":f:a.c", "simple"]],
    ["-L '/main/,/^}/:a.c' simple", ["-L", "/main/,/^}/:a.c", "simple"]],
    ["-L :main:a.c simple", ["-L", ":main:a.c", "simple"]],
    ["-L 1,+4:a.c simple", ["-L", "1,+4:a.c", "simple"]],
    ["-L 20:a.c simple", ["-L", "20:a.c", "simple"]],
    [
      "-L '/long f/',/^}/:a.c -L /main/,/^}/:a.c simple",
      ["-L", "/long f/,/^}/:a.c", "-L", "/main/,/^}/:a.c", "simple"],
    ],
    ["-L 24,+1:a.c simple", ["-L", "24,+1:a.c", "simple"]],
    ["-M -L '/long f/,/^}/:b.c' move-support", ["-M", "-L", "/long f/,/^}/:b.c", "move-support"]],
    ["-M -L ':f:b.c' parallel-change", ["-M", "-L", ":f:b.c", "parallel-change"]],
    ["-L 4,12:a.c -L :main:a.c simple", ["-L", "4,12:a.c", "-L", ":main:a.c", "simple"]],
    ["-L 4,18:a.c -L ^:main:a.c simple", ["-L", "4,18:a.c", "-L", "^:main:a.c", "simple"]],
    ["-L :main:a.c -L 4,18:a.c simple", ["-L", ":main:a.c", "-L", "4,18:a.c", "simple"]],
    ["-L 4:a.c -L 8,12:a.c simple", ["-L", "4:a.c", "-L", "8,12:a.c", "simple"]],
    ["-L 8,12:a.c -L 4:a.c simple", ["-L", "8,12:a.c", "-L", "4:a.c", "simple"]],
  ];
  for (const [title, args] of canned) {
    it(t4211(title), async () => {
      await compare(dir, args);
    });
  }

  // git 2.43 aborts on this one (an assertion in range_set_append)
  it(t4211("-L 10,16:b.c -L 18,26:b.c main"), async () => {
    if (compatibility() === "2.43") return;
    await compare(dir, ["-L", "10,16:b.c", "-L", "18,26:b.c", "main"]);
  });

  it(t4211("basic command line parsing"), async () => {
    await compare(dir, ["-L1,1:a.c", "--", "a.c"]);
    await compare(dir, ["-L1,1:b.c", "--", "b.c"]);
    await compare(dir, ["-L1,1:b.c", "--follow"]);
    await compare(dir, ["--follow", "-L1,1:b.c", "--", "b.c"]);
  });

  const badOpts: [string, string][] = [
    ["-L b.c", "b.c"],
    ["-L 1:", "1:"],
    ["-L 1:nonexistent", "1:nonexistent"],
    ["-L 1:simple", "1:simple"],
    ["-L '/foo:b.c'", "/foo:b.c"],
    ["-L 1000:b.c", "1000:b.c"],
    ["-L :b.c", ":b.c"],
    ["-L :foo:b.c", ":foo:b.c"],
  ];
  for (const [title, spec] of badOpts) {
    it(t4211(`invalid args: ${title}`), async () => {
      await compare(dir, ["-L", spec]);
    });
  }

  it("dies on other invalid ranges, several commits and a tree as git does", async () => {
    for (const spec of [
      "0,3:b.c",
      "3,+0:b.c",
      "3,-0:b.c",
      "/x[/:b.c",
      ":x[:b.c",
      "/nomatch/:b.c",
      "3,/nomatch/:b.c",
      ":^$:b.c",
    ]) {
      await compare(dir, ["-L", spec]);
    }
    await compare(dir, ["-L1:b.c", "main", "parallel-change"]);
    await compare(dir, ["-L1:b.c", "main^{tree}"]);
  });

  const lines = () => git(dir, "show", "main:b.c").split("\n").length - 1;
  it(t4211("-L X (X == nlines)"), async () => {
    await compare(dir, ["-L", `${lines()}:b.c`]);
  });
  it(t4211("-L X (X == nlines + 1)"), async () => {
    await compare(dir, ["-L", `${lines() + 1}:b.c`]);
  });
  it(t4211("-L X (X == nlines + 2)"), async () => {
    await compare(dir, ["-L", `${lines() + 2}:b.c`]);
  });
  it(t4211("-L ,Y (Y == nlines)"), async () => {
    await compare(dir, ["-L", `,${lines()}:b.c`]);
  });
  it(t4211("-L ,Y (Y == nlines + 1)"), async () => {
    await compare(dir, ["-L", `,${lines() + 1}:b.c`]);
  });
  it(t4211("-L ,Y (Y == nlines + 2)"), async () => {
    await compare(dir, ["-L", `,${lines() + 2}:b.c`]);
  });

  it("takes -N offsets, swapped ends and searches from the previous range", async () => {
    await compare(dir, ["-L", "5,-3:b.c"]);
    await compare(dir, ["-L", "12,3:b.c"]);
    await compare(dir, ["-L", "/while/,+2:b.c", "-L", "/while/,+1:b.c"]);
    await compare(dir, ["-L", "/s++/,/^}/:b.c"]);
  });

  it(t4211("-L with --first-parent and a merge"), async () => {
    await compare(dir, ["--first-parent", "-L", "1,1:b.c", "parallel-change"]);
  });

  it("shows merges, --oneline, --graph, --date-order and -U as git does", async () => {
    await compare(dir, ["-L", ":main:b.c", "parallel-change"]);
    await compare(dir, ["--oneline", "-L", ":f:b.c", "parallel-change"]);
    await compare(dir, ["--graph", "-L", ":f:b.c", "parallel-change"]);
    await compare(dir, ["--graph", "--oneline", "-L", "/long f/,/^}/:a.c", "simple"]);
    await compare(dir, ["--date-order", "-L", ":f:b.c", "parallel-change"]);
    await compare(dir, ["-U1", "-L", "4,12:a.c", "simple"]);
  });

  it(t4211("-s shows only line-log commits"), async () => {
    await compare(dir, ["--format=commit %s", "-L1,24:b.c"]);
    await compare(dir, ["--format=commit %s", "-L1,24:b.c", "-s"]);
  });

  it(t4211("-p shows the default patch output"), async () => {
    await compare(dir, ["-L1,24:b.c", "-p"]);
  });

  // 2.43 dies on every format but -p and -s
  it(t4211("--name-only shows path"), async () => {
    await compare(dir, ["-L1,24:b.c", "--name-only", "--format="]);
  });
  it(t4211("--name-status shows status and path"), async () => {
    await compare(dir, ["-L1,24:b.c", "--name-status", "--format="]);
  });
  it(t4211("--stat is not yet supported with -L"), async () => {
    await compare(dir, ["-L1,24:b.c", "--stat"]);
  });
  it(t4211("--numstat is not yet supported with -L"), async () => {
    await compare(dir, ["-L1,24:b.c", "--numstat"]);
  });
  it(t4211("--shortstat is not yet supported with -L"), async () => {
    await compare(dir, ["-L1,24:b.c", "--shortstat"]);
  });
  it(t4211("--full-diff is not yet supported with -L"), async () => {
    await compare(dir, ["-L1,24:b.c", "--full-diff"]);
  });
});

describeGit("git log -L over many lines, native", () => {
  it(t4211("range_set_union"), async () => {
    const dir = join(home, "many");
    git(home, "init", "-q", "-b", "main", dir);
    const seq = (n: number) => Array.from({ length: n }, (_, i) => `${i + 1}\n`).join("");
    put(dir, "c.c", seq(500));
    commit(dir, "many lines");
    put(dir, "c.c", seq(1000));
    commit(dir, "modify many lines");
    const args: string[] = [];
    for (let x = 1; x <= 200; x++) args.push("-L", `${2 * x},+1:c.c`);
    await compare(dir, args);
  });
});

describeGit("git log -L following renames through a merge, native", () => {
  let dir: string;

  // t4211's "setup for checking fancy rename following"
  beforeAll(() => {
    dir = join(home, "moves");
    git(home, "init", "-q", "-b", "moves-start", dir);
    const lines = (...l: (string | number)[]) => l.map((x) => `${x}\n`).join("");
    put(dir, "file-1", lines(12, 13, 14, 15, "b", "c", "d", "e"));
    put(dir, "file-2", lines(22, 23, 24, 25, "B", "C", "D", "E"));
    commit(dir, "Add file-1 and file-2");
    git(dir, "checkout", "-q", "-b", "moves-main");
    put(dir, "file-1", lines(11, 12, 13, 14, 15, "b", "c", "d", "e"));
    commit(dir, "Modify file-1 on main");
    put(dir, "file-2", lines(21, 22, 23, 24, 25, "B", "C", "D", "E"));
    commit(dir, "Modify file-2 on main #1");
    git(dir, "mv", "file-1", "renamed-1");
    commit(dir, "Rename file-1 to renamed-1 on main");
    put(dir, "renamed-1", lines(11, 12, 13, 14, 15, "b", "c", "d", "e", "f"));
    commit(dir, "Modify renamed-1 on main");
    put(dir, "file-2", lines(21, 22, 23, 24, 25, "B", "C", "D", "E", "F"));
    commit(dir, "Modify file-2 on main #2");
    git(dir, "checkout", "-q", "-b", "moves-side", "moves-start");
    put(dir, "file-1", lines(12, 13, 14, 15, 16, "b", "c", "d", "e"));
    commit(dir, "Modify file-1 on side #1");
    put(dir, "file-2", lines(22, 23, 24, 25, 26, "B", "C", "D", "E"));
    commit(dir, "Modify file-2 on side");
    git(dir, "mv", "file-2", "renamed-2");
    commit(dir, "Rename file-2 to renamed-2 on side");
    put(dir, "file-1", lines(12, 13, 14, 15, 16, "a", "b", "c", "d", "e"));
    commit(dir, "Modify file-1 on side #2");
    put(dir, "renamed-2", lines(22, 23, 24, 25, 26, "A", "B", "C", "D", "E"));
    commit(dir, "Modify renamed-2 on side");
    git(dir, "checkout", "-q", "moves-main");
    clock += 60;
    git(dir, "merge", "-q", "--no-edit", "moves-side");
  });

  it(t4211("fancy rename following #1"), async () => {
    await compare(dir, ["-L1:renamed-1", "--oneline", "--no-patch"]);
  });

  it(t4211("fancy rename following #2"), async () => {
    await compare(dir, ["-L1:renamed-2", "--oneline", "--no-patch"]);
  });

  it("prints the renames' diffs, with --graph and --first-parent too", async () => {
    await compare(dir, ["-L1:renamed-1"]);
    await compare(dir, ["-L1,3:renamed-2", "-L2:renamed-1"]);
    await compare(dir, ["--graph", "-L1:renamed-2", "--oneline"]);
    await compare(dir, ["--graph", "-L1:renamed-1"]);
    await compare(dir, ["--first-parent", "-L1:renamed-2", "--oneline"]);
    await compare(dir, ["--format=%h %p %s", "-L1:renamed-1", "-s"]);
    await compare(dir, ["--format=%h %p %s", "-L1:renamed-2", "-s", "--parents"]);
    await compare(dir, ["-L1:renamed-1", "--parents", "--oneline"]);
  });
});

describeGit("git log -L :funcname over a linear history, native", () => {
  let dir: string;
  let firstTick = 0;

  // t4211's "setup for checking line-log and parent oids" and "setup -L with whitespace change"
  beforeAll(() => {
    dir = join(home, "funcs");
    git(home, "init", "-q", "-b", "parent-oids", dir);
    put(dir, "file.c", "int func1()\n{\n    return F1;\n}\n\nint func2()\n{\n    return F2;\n}\n");
    commit(dir, "Add func1() and func2() in file.c");
    firstTick = clock;
    put(dir, "other-file", "1\n");
    commit(dir, "Add other-file");
    put(
      dir,
      "file.c",
      "int func1()\n{\n    return F1 + 1;\n}\n\nint func2()\n{\n    return F2;\n}\n",
    );
    commit(dir, "Modify func1() in file.c");
    put(dir, "other-file", "2\n");
    commit(dir, "Modify other-file");
    put(
      dir,
      "file.c",
      "int func1()\n{\n    return F1 + 1;\n}\n\nint func2()\n{\n    return F2 + 2;\n}\n",
    );
    commit(dir, "Modify func2() in file.c");
    git(dir, "checkout", "-q", "-b", "ws-change");
    put(
      dir,
      "file.c",
      "int func1()\n{\n    return F1 + 1;\n}\n\nint func2()\n{\n\treturn F2 + 2;\n}\n",
    );
    commit(dir, "Whitespace change in func2()");
    git(dir, "checkout", "-q", "parent-oids");
  });

  it(t4211("parent oids without parent rewriting"), async () => {
    await compare(dir, ["--format=%h %p %s", "--no-patch", "-L:func2:file.c"]);
  });

  it(t4211("parent oids with parent rewriting"), async () => {
    await compare(dir, ["--format=%h %p %s", "--no-patch", "-L:func2:file.c", "--parents"]);
    await compare(dir, ["--oneline", "-L:func2:file.c", "--parents"]);
  });

  it(t4211("line-log with --before"), async () => {
    await compare(dir, ["--format=%h", "--no-patch", "-L:func2:file.c", `--before=${firstTick}`]);
  });

  for (const re of ["$", "^", ".*"]) {
    it(t4211(`zero-width regex ${re} matches any function name`), async () => {
      await compare(dir, ["--format=%s", "--no-patch", `-L:${re}:file.c`]);
    });
  }

  it(t4211("-L diff output includes index and new file mode"), async () => {
    await compare(dir, ["-L:func2:file.c", "--format="]);
    await compare(dir, ["-L:func2:file.c"]);
  });

  it(t4211("show line-log with graph"), async () => {
    await compare(dir, ["--graph", "--oneline", "-L:func2:file.c"]);
  });

  it(t4211("-L --oneline has no extra blank line before diff"), async () => {
    await compare(dir, ["--oneline", "-L:func2:file.c", "-1"]);
  });

  it(t4211("-L with --ignore-all-space suppresses whitespace-only diff"), async () => {
    await compare(dir, ["-L:func2:file.c", "--format=", "ws-change"]);
    await compare(dir, ["-L:func2:file.c", "--format=", "-w", "ws-change"]);
  });

  it(t4211("-L with -b suppresses whitespace-only diff"), async () => {
    await compare(dir, ["-L:func2:file.c", "--format=", "-b", "ws-change"]);
  });

  it(t4211("-L with --no-prefix"), async () => {
    await compare(dir, ["-L:func2:file.c", "--no-prefix", "--format="]);
  });

  it(t4211("-L with --src-prefix and --dst-prefix"), async () => {
    await compare(dir, ["-L:func2:file.c", "--src-prefix=old/", "--dst-prefix=new/", "--format="]);
  });

  it(t4211("-L with --full-index"), async () => {
    await compare(dir, ["-L:func2:file.c", "--full-index", "--format="]);
  });

  it(t4211("-L with --abbrev"), async () => {
    await compare(dir, ["-L:func2:file.c", "--abbrev=4", "--format=", "-1"]);
  });

  it(t4211("--summary shows new file on root commit"), async () => {
    await compare(dir, ["-L:func2:file.c", "--summary", "--format="]);
  });

  it(t4211("-L with -S filters to string-count changes"), async () => {
    await compare(dir, ["-L:func2:file.c", "-SF2 + 2", "--format="]);
  });

  it(t4211("-L with -G filters to diff-text matches"), async () => {
    await compare(dir, ["-L:func2:file.c", "-GF2 [+] 2", "--format="]);
  });

  it(t4211("-L with --diff-filter=M excludes root commit"), async () => {
    await compare(dir, ["-L:func2:file.c", "--diff-filter=M", "--format=%s", "--no-patch"]);
  });

  it(t4211("-L with --diff-filter=A shows only root commit"), async () => {
    await compare(dir, ["-L:func2:file.c", "--diff-filter=A", "--format=%s", "--no-patch"]);
  });

  it(t4211("-L with -S suppresses non-matching commits"), async () => {
    await compare(dir, ["-L:func2:file.c", "-SF2 + 2", "--format=%s", "--no-patch"]);
  });

  it(t4211("-L with --word-diff"), async () => {
    await compare(dir, ["-L:func2:file.c", "--word-diff", "--format="]);
  });

  it(t4211("-L with --word-diff-regex"), async () => {
    await compare(dir, [
      "-L:func2:file.c",
      "--word-diff",
      "--word-diff-regex=[a-zA-Z0-9_]+",
      "--format=",
    ]);
  });

  it(t4211("-L with -R reverses diff"), async () => {
    // 2.43 queues the pairs reversed and follows the ranges through them as they are
    if (compatibility() === "2.43") return;
    await compare(dir, ["-L:func2:file.c", "-R", "--format=", "-1"]);
  });

  it("takes a range beside a function of the same file", async () => {
    await compare(dir, ["-L", "/F1/,+1:file.c", "-L", ":func2:file.c"]);
  });

  it("finds functions by the diff driver's pattern", async () => {
    const d = join(home, "drivers");
    git(home, "init", "-q", "-b", "main", d);
    put(
      d,
      "lib.py",
      "import os\n\nclass Thing:\n    def one(self):\n        return 1\n\n    def two(self):\n        return 2\n\ndef three():\n    return 3\n",
    );
    put(d, "notes.txt", "== Intro ==\ntext\nmore\n== Usage ==\nrun it\nthen stop\n");
    commit(d, "add");
    put(
      d,
      "lib.py",
      "import os\n\nclass Thing:\n    def one(self):\n        return 11\n\n    def two(self):\n        return 22\n\ndef three():\n    return 33\n",
    );
    put(d, "notes.txt", "== Intro ==\ntext\nmore!\n== Usage ==\nrun it\nthen stop!\n");
    commit(d, "change");
    // no driver: lines starting with a letter, `_` or `$` start functions
    await compare(d, ["-L:two:lib.py"]);
    await compare(d, ["-L:Usage:notes.txt"]);
    put(d, ".gitattributes", "*.py diff=python\n*.txt diff=wiki\n");
    git(d, "config", "diff.wiki.xfuncname", "^== .* ==$");
    await compare(d, ["-L:two:lib.py"]);
    await compare(d, ["-L:Thing:lib.py"]);
    await compare(d, ["-L:Usage:notes.txt"]);
    await compare(d, ["-L:Intro:notes.txt"]);
  });
});

// git 2.43 dies on these (an assertion in process_diff_filepair: its pickaxe drops the pairs
// rename following needs), so they run on 2.5x only
describeGit("git log -L with the pickaxe, native", () => {
  let dir: string;

  // t4211's "setup for -L with -G/-S/--find-object and a merge with rename"
  beforeAll(() => {
    dir = join(home, "pickaxe");
    git(home, "init", "-q", "-b", "pickaxe-rename", dir);
    put(dir, "file", "content\n");
    commit(dir, "add file");
    git(dir, "checkout", "-q", "-b", "pickaxe-rename-side");
    git(dir, "mv", "file", "renamed-file");
    commit(dir, "rename file");
    git(dir, "checkout", "-q", "pickaxe-rename");
    commit(dir, "diverge", "--allow-empty");
    clock += 60;
    git(dir, "merge", "-q", "--no-edit", "pickaxe-rename-side");
    git(dir, "mv", "renamed-file", "file");
    commit(dir, "rename back");
  });

  it(t4211("-L -G does not crash with merge and rename"), async () => {
    if (compatibility() === "2.43") return;
    await compare(dir, ["--format=%s", "--no-patch", "-L", "1,1:file", "-G."]);
  });

  it(t4211("-L -S does not crash with merge and rename"), async () => {
    if (compatibility() === "2.43") return;
    await compare(dir, ["--format=%s", "--no-patch", "-L", "1,1:file", "-Scontent"]);
  });

  it(t4211("-L --find-object does not crash with merge and rename"), async () => {
    if (compatibility() === "2.43") return;
    await compare(dir, ["--format=%s", "--no-patch", "-L", "1,1:file", "--find-object=HEAD:file"]);
  });

  it(t4211("-L --find-object should filter commits by object"), async () => {
    if (compatibility() === "2.43") return;
    await compare(dir, [
      "--format=%s",
      "--no-patch",
      "-L",
      "1,1:file",
      `--find-object=${"0".repeat(40)}`,
    ]);
  });

  it(t4211("-L -G should filter commits by pattern"), async () => {
    if (compatibility() === "2.43") return;
    await compare(dir, ["--format=%s", "--no-patch", "-L", "1,1:file", "-Gnomatch"]);
  });

  it(t4211("-L -S should filter commits by pattern"), async () => {
    if (compatibility() === "2.43") return;
    await compare(dir, ["--format=%s", "--no-patch", "-L", "1,1:file", "-Snomatch"]);
  });
});

describeGit("git log -L at a missing newline and range ends, native", () => {
  let dir: string;

  // t4211's "setup for no-newline-at-eof tests"
  beforeAll(() => {
    dir = join(home, "noeol");
    git(home, "init", "-q", "-b", "main", dir);
    put(dir, "noeol.c", "int top()\n{\n    return 1;\n}\n\nint bot()\n{\n    return 2;\n}");
    commit(dir, "add noeol.c (no trailing newline)");
    put(dir, "noeol.c", "int top()\n{\n    return 1;\n}\n\nint bot()\n{\n    return 22;\n}");
    commit(dir, "modify bot()");
    put(dir, "noeol.c", "int top()\n{\n    return 1;\n}\n\nint bot()\n{\n    return 33;\n}\n");
    commit(dir, "modify bot() and add trailing newline");
  });

  it(t4211("-L no-newline-at-eof appears in tracked range"), async () => {
    await compare(dir, ["-L:bot:noeol.c", "--format=", "-1", "HEAD~1"]);
  });

  it(t4211("-L no-newline-at-eof suppressed outside range"), async () => {
    await compare(dir, ["-L:top:noeol.c", "--format="]);
  });

  it(t4211("-L no-newline-at-eof marker with deleted line"), async () => {
    await compare(dir, ["-L:bot:noeol.c", "--format=", "-1"]);
    await compare(dir, ["-L:bot:noeol.c", "--format="]);
  });

  it(t4211("-L suppresses deletions outside tracked range"), async () => {
    const d = join(home, "boundary");
    git(home, "init", "-q", "-b", "main", d);
    const tracked = "void tracked()\n{\n    int x = 1;\n    int y = 2;\n}\n";
    put(
      d,
      "boundary.c",
      `void above()\n{\n    return;\n}\n\n${tracked}\nvoid below()\n{\n    return;\n}\n`,
    );
    commit(d, "add boundary.c");
    put(
      d,
      "boundary.c",
      `void above()\n{\n    return;\n}\n\n${tracked}\nvoid below_renamed()\n{\n    return 0;\n}\n`,
    );
    commit(d, "modify below() only");
    await compare(d, ["-L:tracked:boundary.c", "--format="]);
    await compare(d, ["-L:tracked:boundary.c"]);
    await compare(d, ["-L", "6,12:boundary.c"]);
  });
});

describeGit("git log -L across a rename that changes the range, native", () => {
  let dir: string;

  beforeAll(() => {
    dir = join(home, "rename-change");
    git(home, "init", "-q", "-b", "main", dir);
    const body = (n: number, changed = -1) =>
      Array.from({ length: n }, (_, i) => `line ${i + 1}${i === changed ? " changed" : ""}\n`).join(
        "",
      );
    put(dir, "a.c", body(40));
    commit(dir, "add a.c");
    rmSync(join(dir, "a.c"));
    put(dir, "b.c", body(40, 5));
    commit(dir, "rename a.c to b.c and change line 6");
    put(dir, "b.c", body(40, 9));
    commit(dir, "change line 10 of b.c");
  });

  // a renamed pair prints as a modification between two paths (diff_filepair_dup)
  it("prints the rename's pair as git does, with -p, --name-status, --summary and --graph", async () => {
    await compare(dir, ["-L", "1,21:b.c"]);
    await compare(dir, ["-L", "1,21:b.c", "-p"]);
    await compare(dir, ["-L", "1,21:b.c", "--name-status", "--format="]);
    await compare(dir, ["-L", "1,21:b.c", "--name-only", "--format="]);
    await compare(dir, ["-L", "1,21:b.c", "--summary", "--format="]);
    await compare(dir, ["--graph", "-L", "1,21:b.c"]);
    await compare(dir, ["--graph", "--oneline", "-L", "1,21:b.c"]);
  });
});

describeGit("git log -L on a submodule (gitlink) path, native", () => {
  it("diffs the gitlink as its `Subproject commit` line", async () => {
    const dir = join(home, "gitlink");
    git(home, "init", "-q", "-b", "main", dir);
    put(dir, "f", "one\n");
    commit(dir, "first");
    const first = git(dir, "rev-parse", "HEAD").trim();
    put(dir, "f", "two\n");
    commit(dir, "second");
    const second = git(dir, "rev-parse", "HEAD").trim();
    git(dir, "update-index", "--add", "--cacheinfo", `160000,${first},sub`);
    clock += 60;
    git(dir, "commit", "-q", "-m", "add sub");
    git(dir, "update-index", "--cacheinfo", `160000,${second},sub`);
    clock += 60;
    git(dir, "commit", "-q", "-m", "move sub");
    await compare(dir, ["-L1:sub"]);
    await compare(dir, ["-L1:sub", "--oneline", "--no-patch"]);
  });
});
