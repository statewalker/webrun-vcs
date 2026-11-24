/**
 * `git blame`'s output formats and `git annotate` against native git, byte for byte: the
 * histories of t8008-blame-formats.sh, of t/annotate-tests.sh (which t8001-annotate.sh runs
 * as `git annotate` and t8012-blame-colors.sh as `git blame -c`) and t8012's color tests,
 * each blamed by native git and by ours in the default, `-c`, annotate, `--porcelain`,
 * `--line-porcelain` and `--incremental` outputs, with `--contents`, `--since`,
 * `--first-parent`, `--date` and the colors.
 *
 * Dates are fixed (`TZ`, `GIT_TEST_DATE_NOW` for relative dates and `--color-by-age`); the
 * fake commit of `--contents` and of a working-tree blame is dated by native git's clock,
 * so ours is run with each second native git's run took.
 */
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  formatAnnotate,
  formatBlame,
  formatBlameIncremental,
  formatBlamePorcelain,
} from "../src/index.js";
import {
  alwaysWidenAbbrev,
  atLeast,
  compatibility,
  git as nativeGit,
  open,
} from "./blame-native-support.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

// the local zone of both (a zone with daylight saving time, for the `-local` modes)
process.env.TZ = "Europe/Berlin";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;
/** "Now" for relative and human dates and the color ages */
const NOW = 1700000000;

let root: string | undefined;
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
const tmp = () => {
  root ??= mkdtempSync(join(tmpdir(), "blame-formats-native-"));
  return root;
};
const git = (cwd: string, args: string[], input?: string, env?: Record<string, string>) =>
  nativeGit(tmp(), cwd, args, input, env);

/** The environment of a commit at `tick` (test-lib's test_tick) */
const commitEnv = (
  tick: number,
  name = "A U Thor",
  email = "author@example.com",
  tz = "-0700",
): Record<string, string> => ({
  GIT_AUTHOR_NAME: name,
  GIT_AUTHOR_EMAIL: email,
  GIT_AUTHOR_DATE: `${1112911993 + tick * 60} ${tz}`,
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_COMMITTER_DATE: `${1112911993 + tick * 60} ${tz}`,
});

/** The options of a native argv taking values, as `--opt value` or `--opt=value` */
const VALUED = new Set(["--contents", "--date", "--since", "--abbrev", "--ignore-rev", "-L"]);

interface Parsed {
  annotate: boolean;
  flags: Set<string>;
  values: Map<string, string[]>;
  revs: string[];
  path: string;
}

/** `git blame|annotate <options> [<rev>] [--] <path> [<rev>]` taken apart */
function parseArgv(dir: string, argv: string[]): Parsed {
  const annotate = argv[0] === "annotate";
  const flags = new Set<string>();
  const values = new Map<string, string[]>();
  const positional: string[] = [];
  let dashdash = -1;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      dashdash = positional.length;
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.startsWith("-L") ? "-L" : eq > 0 ? a.slice(0, eq) : a;
    if (VALUED.has(name)) {
      const value = a.startsWith("-L")
        ? a.length > 2
          ? a.slice(2)
          : argv[++i]
        : eq > 0
          ? a.slice(eq + 1)
          : argv[++i];
      values.set(name, [...(values.get(name) ?? []), value]);
    } else if (a.startsWith("-") && a !== "-") flags.add(a);
    else positional.push(a);
  }
  let revs: string[];
  let path: string;
  if (dashdash >= 0) {
    revs = positional.slice(0, dashdash);
    path = positional[dashdash];
  } else if (positional.length === 2) {
    // "blame <path> <rev>" when the second is a revision
    const isRev =
      spawnSync("git", ["rev-parse", "--verify", "-q", positional[1]], {
        cwd: dir,
        env: nativeGitEnv(tmp()),
      }).status === 0;
    revs = isRev ? [positional[1]] : [positional[0]];
    path = isRev ? positional[0] : positional[1];
  } else {
    revs = [];
    path = positional[0];
  }
  return { annotate, flags, values, revs, path };
}

/** One `-L` argument as a 1-based inclusive range (numbers only) */
function lineRange(arg: string): [number, number] {
  const comma = arg.indexOf(",");
  const a = comma < 0 ? arg : arg.slice(0, comma);
  const b = comma < 0 ? "" : arg.slice(comma + 1);
  const start = a === "" ? 1 : Number(a);
  if (b === "") return [start, Number.MAX_SAFE_INTEGER];
  if (b.startsWith("+")) return [start, start + Number(b.slice(1)) - 1];
  if (b.startsWith("-")) return [Math.max(1, start - Number(b.slice(1)) + 1), start];
  return [start, Number(b)];
}

/** Our output for a native argv, the fake commit (if any) dated `time` */
async function ours(dir: string, argv: string[], time: number, stdin?: string) {
  const p = parseArgv(dir, argv);
  const resolve = (rev: string) => git(dir, ["rev-parse", `${rev}^{commit}`]);
  const repo = await open(dir);
  const cmd = repo.blame().setFilePath(p.path).setCompatibility(compatibility);
  if (!atLeast(2, 50)) cmd.setAlgorithm("myers");
  if (p.revs.length > 0) cmd.setStartCommit(resolve(p.revs[0]));
  const contents = p.values.get("--contents")?.[0];
  // git's canon_mode of the file's stat: --contents <file> stats it, the working tree's
  // file is lstat'ed (a link is its target's name); standard input takes the index's mode
  const canonMode = (st: { mode: number; isSymbolicLink(): boolean }) =>
    st.isSymbolicLink() ? 0o120000 : st.mode & 0o100 ? 0o100755 : 0o100644;
  if (contents === "-") {
    cmd.setContents(new Uint8Array(Buffer.from(stdin ?? "")), { name: contents, time });
  } else if (contents !== undefined) {
    const file = join(dir, contents);
    cmd.setContents(new Uint8Array(readFileSync(file)), {
      name: contents,
      time,
      mode: canonMode(statSync(file)),
    });
  } else if (p.revs.length === 0) {
    const file = join(dir, p.path);
    const st = lstatSync(file);
    const content = st.isSymbolicLink() ? Buffer.from(readlinkSync(file)) : readFileSync(file);
    cmd.setContents(new Uint8Array(content), { workingTree: true, time, mode: canonMode(st) });
  }
  const since = p.values.get("--since")?.[0];
  if (since !== undefined) {
    // rev-parse turns --since into --max-age=<seconds>
    const maxAge = git(dir, ["rev-parse", `--since=${since}`], undefined, {
      GIT_TEST_DATE_NOW: String(NOW),
    });
    cmd.setSince(Number(maxAge.replace("--max-age=", "")));
  }
  if (p.flags.has("--root")) cmd.setShowRoot(true);
  if (p.flags.has("-w")) cmd.setIgnoreWhitespace(true);
  if (p.flags.has("--first-parent")) cmd.setFirstParent(true);
  const ignore = p.values.get("--ignore-rev");
  if (ignore) cmd.setIgnoreRevs(ignore);
  const ranges = p.values.get("-L");
  if (ranges) cmd.setLineRanges(ranges.map(lineRange));
  const result = await cmd.call();
  const f = p.flags;
  if (f.has("--incremental")) return formatBlameIncremental(result);
  if (f.has("--line-porcelain")) {
    return formatBlamePorcelain(result, { linePorcelain: true, lineMarks: atLeast(2, 50) });
  }
  if (f.has("-p") || f.has("--porcelain")) {
    return formatBlamePorcelain(result, { lineMarks: atLeast(2, 50) });
  }
  const abbrev = p.values.get("--abbrev")?.[0];
  const options = {
    alwaysWidenAbbrev,
    autoAbbrev: await result.autoAbbrev?.(),
    ...(abbrev !== undefined ? { abbrev: Number(abbrev) } : {}),
    showName: f.has("-f") || undefined,
    showNumber: f.has("-n"),
    longObjectName: f.has("-l"),
    rawTimestamp: f.has("-t"),
    noAuthor: f.has("-s"),
    ...(f.has("-e") ? { showEmail: true } : {}),
    ...(f.has("-b") ? { blankBoundary: true } : {}),
    colorLines: f.has("--color-lines"),
    colorByAge: f.has("--color-by-age"),
    colorLinesWithinEntries: !atLeast(2, 54),
    dateContext: { now: NOW },
  };
  if (p.annotate) return formatAnnotate(result, options);
  const date = p.values.get("--date")?.[0];
  return formatBlame(result, {
    ...options,
    annotate: f.has("-c"),
    ...(date !== undefined ? { date } : {}),
  });
}

/**
 * Native git's output and ours for `argv` in `dir`, as a mismatch report (empty when they
 * agree); `config` is set in the repository for both and unset after
 */
async function compare(
  dir: string,
  argv: string[],
  options: { config?: Record<string, string>; stdin?: string } = {},
): Promise<string> {
  const config = options.config ?? {};
  for (const [k, v] of Object.entries(config)) git(dir, ["config", k, v]);
  try {
    const t0 = Math.floor(Date.now() / 1000);
    const res = spawnSync("git", argv, {
      cwd: dir,
      input: options.stdin,
      env: { ...nativeGitEnv(tmp()), GIT_TEST_DATE_NOW: String(NOW) },
    });
    const t1 = Math.ceil(Date.now() / 1000);
    if (res.status !== 0) return `git ${argv.join(" ")}: exit ${res.status}: ${res.stderr}`;
    let mine = Buffer.alloc(0);
    for (let t = t0; t <= t1; t++) {
      mine = Buffer.from(await ours(dir, argv, t, options.stdin));
      if (mine.equals(res.stdout)) return "";
    }
    return `git ${argv.join(" ")} ${JSON.stringify(config)}\n--- git\n${res.stdout}\n--- ours\n${mine}`;
  } finally {
    for (const k of Object.keys(config)) git(dir, ["config", "--unset-all", k]);
  }
}

/** Every argv compared, the mismatches printed and expected none */
async function expectSame(
  dir: string,
  argvs: string[][],
  options: { config?: Record<string, string>; stdin?: string } = {},
): Promise<void> {
  const mismatches: string[] = [];
  for (const argv of argvs) {
    const m = await compare(dir, argv, options);
    if (m) mismatches.push(m);
  }
  for (const m of mismatches.slice(0, 3)) console.log(m);
  expect(mismatches).toEqual([]);
}

/** `check_count`'s invocations of annotate-tests.sh as each PROG runs them */
const PROGS = [["annotate"], ["blame"], ["blame", "-c"]];
const progs = (options: string[], file: string, head?: string): string[][] =>
  PROGS.map((prog) => [...prog, ...options, file, ...(head ? [head] : [])]);

/** The formats every scenario is also blamed in */
const FORMATS = [["--porcelain"], ["--line-porcelain"], ["--incremental"], ["-f", "-n"]];
const formats = (options: string[], file: string, head?: string): string[][] =>
  FORMATS.map((format) => ["blame", ...format, ...options, ...(head ? [head] : []), "--", file]);

describeGit("git blame output formats against native git", () => {
  it('t8008-blame-formats.sh: "normal blame output", "blame --porcelain output", "blame --line-porcelain output", "--porcelain detects first non-blank line as subject"', async () => {
    const dir = join(tmp(), "t8008");
    mkdirSync(dir);
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, "file"), "a\n");
    git(dir, ["add", "file"]);
    git(dir, ["commit", "-q", "-m", "one"], undefined, commitEnv(0));
    writeFileSync(join(dir, "file"), "a\nb\nc\nd\n");
    git(dir, ["commit", "-q", "-a", "-m", "two"], undefined, commitEnv(1));
    await expectSame(dir, [
      ["blame", "--abbrev=17", "file"],
      ["blame", "--porcelain", "file"],
      ["blame", "--line-porcelain", "file"],
      ["blame", "--incremental", "file"],
      ["blame", "--incremental", "HEAD", "--", "file"],
      ["annotate", "file"],
      ["blame", "-c", "--abbrev=12", "file"],
      // the other output flags on the same history
      ["blame", "-l", "-t", "-e", "-b", "HEAD", "--", "file"],
      ["blame", "-s", "-n", "-f", "--root", "HEAD", "--", "file"],
      ["blame", "-c", "-e", "-t", "--abbrev=4", "HEAD", "--", "file"],
      ["blame", "--abbrev=0", "-b", "HEAD", "--", "file"],
    ]);
    await expectSame(dir, [["blame", "HEAD", "--", "file"]], {
      config: { "blame.showEmail": "true", "blame.blankBoundary": "true" },
    });

    const tree = git(dir, ["write-tree"]);
    const commit = git(
      dir,
      ["hash-object", "-w", "-t", "commit", "--stdin"],
      `tree ${tree}\nauthor A <a@b.c> 123456789 +0000\ncommitter C <c@d.e> 123456789 +0000\n\n\n  \noneline\n\nbody\n`,
    );
    await expectSame(dir, [
      ["blame", "--porcelain", commit, "--", "file"],
      ["blame", "--incremental", commit, "--", "file"],
    ]);
  });

  it("t8008-blame-formats.sh: --date modes on its history", async () => {
    const dir = join(tmp(), "t8008-dates");
    mkdirSync(dir);
    git(dir, ["init", "-q", "-b", "main"]);
    writeFileSync(join(dir, "file"), "a\n");
    git(dir, ["add", "file"]);
    git(dir, ["commit", "-q", "-m", "one"], undefined, commitEnv(0));
    writeFileSync(join(dir, "file"), "a\nb\n");
    git(
      dir,
      ["commit", "-q", "-a", "-m", "two"],
      undefined,
      commitEnv(1, "Ünï Çödé", "u@x", "+0530"),
    );
    writeFileSync(join(dir, "file"), "a\nb\nc\n");
    git(dir, ["commit", "-q", "-a", "-m", "three"], undefined, {
      ...commitEnv(0, "Recent"),
      GIT_AUTHOR_DATE: `${NOW - 3 * 86400} +0100`,
      GIT_COMMITTER_DATE: `${NOW - 3 * 86400} +0100`,
    });
    const modes = [
      "iso",
      "iso-strict",
      "rfc",
      "short",
      "raw",
      "unix",
      "relative",
      "human",
      "default",
      "local",
      "iso-local",
      "short-local",
      "format:%Y/%m/%d %H",
      "format-local:%c",
    ];
    await expectSame(dir, [
      ...modes.map((m) => ["blame", `--date=${m}`, "file"]),
      ...modes.map((m) => ["blame", "-c", `--date=${m}`, "file"]),
      ["annotate", "--date=relative", "file"],
    ]);
    // blame.date, and git annotate keeping only its -local
    await expectSame(
      dir,
      [
        ["blame", "file"],
        ["annotate", "file"],
        ["blame", "--date=rfc", "file"],
      ],
      {
        config: { "blame.date": "short-local" },
      },
    );
  });
});

describeGit("git annotate and blame on the annotate-tests.sh history", () => {
  const dir = () => join(tmp(), "annotate");
  let tick = 0;
  const commit = (args: string[], name = "A U Thor", email = "author@example.com") =>
    git(dir(), ["commit", "-q", ...args], undefined, commitEnv(++tick, name, email));
  const write = (path: string, text: string) => writeFileSync(join(dir(), path), text);
  const read = (path: string) => readFileSync(join(dir(), path), "utf8");

  it('annotate-tests.sh: "setup A lines", "blame 1 author", "blame working copy", "blame with --contents", "blame with --contents changed"', async () => {
    mkdirSync(dir());
    git(dir(), ["init", "-q", "-b", "main"]);
    write("file", "1A quick brown fox jumps over the\nlazy dog\n");
    git(dir(), ["add", "file"]);
    commit(["-a", "-m", "Initial."], "A", "A@test.git");
    await expectSame(dir(), [...progs([], "file"), ...formats([], "file")]);

    write("file", "1A quick brown fox jumps over the\nanother lazy dog\n");
    await expectSame(dir(), [...progs([], "file"), ...formats([], "file").slice(0, 3)]);
    git(dir(), ["checkout", "--", "file"]);

    await expectSame(dir(), progs(["--contents=file"], "file"));
    write("contents", "1A quick brown fox jumps over the\nanother lazy dog\n");
    await expectSame(dir(), [
      ...progs(["--contents=contents"], "file"),
      ["blame", "--porcelain", "--contents", "contents", "file"],
      ["blame", "--incremental", "--contents", "contents", "file"],
    ]);
    await expectSame(dir(), [["blame", "--contents", "-", "file"]], {
      stdin: "1A quick brown fox jumps over the\nfrom stdin\n",
    });
  });

  it('annotate-tests.sh: "blame by tag objects", "setup B lines", "blame 2 authors", "blame with --contents and revision"', async () => {
    git(dir(), ["tag", "-m", "test tag", "testTag"], undefined, commitEnv(tick));
    git(dir(), ["tag", "-m", "test tag #2", "testTag2", "testTag"], undefined, commitEnv(tick));
    await expectSame(dir(), [...progs([], "file", "testTag"), ...progs([], "file", "testTag2")]);
    write("file", `${read("file")}2A quick brown fox jumps over the\nlazy dog\n`);
    commit(["-a", "-m", "Second."], "B", "B@test.git");
    await expectSame(dir(), [
      ...progs([], "file"),
      ...formats([], "file"),
      ...progs(["--contents=file"], "file", "testTag"),
    ]);
  });

  it('annotate-tests.sh: "setup B1 lines (branch1)", "setup B2 lines (branch2)", "merge branch1 & branch2", "blame 2 authors + 2 merged-in authors", "blame --first-parent blames merge for branch1", "blame ancestor", "blame great-ancestor", "setup evil merge", "blame evil merge"', async () => {
    git(dir(), ["checkout", "-q", "-b", "branch1", "main"]);
    write("file", `${read("file")}3A slow green fox jumps into the\nwell.\n`);
    commit(["-a", "-m", "Branch1-1"], "B1", "B1@test.git");
    await expectSame(dir(), progs([], "file"));
    git(dir(), ["checkout", "-q", "-b", "branch2", "main"]);
    write("file", read("file").replace("2A quick brown", "4A quick brown lazy dog"));
    commit(["-a", "-m", "Branch2-1"], "B2", "B2@test.git");
    await expectSame(dir(), progs([], "file"));
    git(dir(), ["merge", "-q", "branch1"], undefined, commitEnv(++tick));
    await expectSame(dir(), [
      ...progs([], "file"),
      ...progs(["--first-parent"], "file"),
      ...formats(["--first-parent"], "file"),
      ...progs([], "file", "main"),
      ...progs([], "file", "main^"),
      ...formats([], "file"),
    ]);
    write("file", `${read("file")}evil merge.\n`);
    commit(["-a", "--amend", "--no-edit"]);
    await expectSame(dir(), [...progs([], "file"), ...formats([], "file")]);
  });

  it('annotate-tests.sh: "setup incomplete line", "blame incomplete line", "setup edits", "blame edits", "setup obfuscated email", "blame obfuscated email"', async () => {
    write("file", `${read("file")}incomplete`);
    commit(["-a", "-m", "Incomplete"], "C", "C@test.git");
    await expectSame(dir(), [...progs([], "file"), ...formats([], "file")]);
    const edited = `${read("file")}\n`
      .split("\n")
      .map((l) => l.replace(/^3A/, "99"))
      .filter((l) => !l.startsWith("1A") && !l.startsWith("incomplete"))
      .join("\n");
    write("file", `${edited}incomplete`);
    commit(["-a", "-m", "edit"], "D", "D@test.git");
    await expectSame(dir(), [...progs([], "file"), ...formats([], "file")]);
    write("file", `No robots allowed\n${read("file")}`);
    commit(["-a", "-m", "norobots"], "E", "E at test dot git");
    await expectSame(dir(), [
      ...progs([], "file"),
      ...progs(["-e"], "file"),
      ...formats([], "file"),
    ]);
  });

  it('annotate-tests.sh: "blame -L 1 (all)", "blame -L , (all)", "blame -L X (X to end)", "blame -L ,Y (up to Y)", "blame -L X,Y", "blame -L Y,X (undocumented)", "blame -L X,+N", "blame -L X,-N", "blame -L multiple (disjoint)", "blame -L multiple (overlapping)"', async () => {
    const ranges = [
      ["-L1"],
      ["-L,"],
      ["-L5"],
      ["-L5,"],
      ["-L,3"],
      ["-L3,3"],
      ["-L3,6"],
      ["-L6,3"],
      ["-L3,+1"],
      ["-L3,+4"],
      ["-L3,-1"],
      ["-L6,-4"],
      ["-L,12345"],
      ["-L2,3", "-L6,7"],
      ["-L6,7", "-L2,3"],
      ["-L2,3", "-L4,5"],
      ["-L2,4", "-L3,5"],
      ["-L3,5", "-L2,8"],
    ];
    await expectSame(dir(), [
      ...ranges.flatMap((r) => progs(r, "file")),
      ...ranges.flatMap((r) => [
        ["blame", "--incremental", ...r, "file"],
        ["blame", "--porcelain", ...r, "file"],
      ]),
    ]);
  });

  it('annotate-tests.sh: "setup -L :regex", "setup incremental", "blame empty", "blame half", "blame -L 1 half", "blame full", "blame -L 1 full"', async () => {
    write("hello.c", 'int main(int argc, const char *argv[])\n{\n\tputs("hello");\n}\n');
    git(dir(), ["add", "hello.c"]);
    commit(["-m", "hello"], "F", "F@test.git");
    write("hello.c", read("hello.c").replace("}\n", '\tputs("goodbye");\n}\n'));
    commit(["-a", "-m", "goodbye"], "G", "G@test.git");
    write("hello.c", `#include <stdio.h>\n${read("hello.c")}void mail()\n{\n\tputs("mail");\n}\n`);
    commit(["-a", "-m", "mail"], "H", "H@test.git");
    await expectSame(dir(), [...progs([], "hello.c"), ...formats([], "hello.c")]);

    write("incremental", "");
    git(dir(), ["add", "incremental"]);
    commit(["-m", "step 0"], "I", "I@test.git");
    write("incremental", "partial");
    commit(["-a", "-m", "step 0.5"], "I", "I@test.git");
    write("incremental", "partial\n");
    commit(["-a", "-m", "step 1"], "I", "I@test.git");
    await expectSame(dir(), [
      ...progs([], "incremental", "HEAD^^"),
      ...formats([], "incremental", "HEAD^^"),
      ...progs([], "incremental", "HEAD^"),
      ...progs(["-L1"], "incremental", "HEAD^"),
      ...formats([], "incremental", "HEAD^"),
      ...progs([], "incremental"),
      ...progs(["-L1"], "incremental"),
      ...formats([], "incremental"),
    ]);
  });

  it("annotate-tests.sh history: --since, --first-parent and --date in every output", async () => {
    // committer times of the history: tick N is 1112911993 + 60 N
    const since = String(1112911993 + 8 * 60);
    await expectSame(dir(), [
      ...progs([`--since=${since}`], "file"),
      ...formats([`--since=${since}`], "file"),
      ...formats([`--since=${since}`, "--first-parent"], "file"),
      ["blame", `--since=${since}`, "--root", "file"],
      ["blame", "--since=2005-04-07 15:20:00 -0700", "-b", "file"],
      ["blame", "--since=20.years.ago", "file"],
      ["blame", "--date=relative", "--first-parent", "file"],
      ["blame", "--date=short", "-e", "-n", "file"],
      ["blame", "-c", "--date=human", "hello.c"],
    ]);
  });
});

describeGit("git blame colors against native git", () => {
  const dir = () => join(tmp(), "annotate");

  it('t8012-blame-colors.sh: "colored blame colors contiguous lines"', async () => {
    await expectSame(
      dir(),
      [
        ["blame", "--color-lines", "--abbrev=12", "hello.c"],
        ["blame", "--abbrev=12", "hello.c"],
        ["blame", "-c", "--abbrev=12", "hello.c"],
      ],
      { config: { "color.blame.repeatedLines": "yellow" } },
    );
    await expectSame(dir(), [["blame", "--abbrev=12", "hello.c"]], {
      config: { "color.blame.repeatedLines": "yellow", "blame.coloring": "repeatedLines" },
    });
    await expectSame(dir(), [
      ["blame", "--color-lines", "hello.c"],
      ["blame", "--color-lines", "--porcelain", "hello.c"],
      ["blame", "--color-lines", "--color-by-age", "-n", "hello.c"],
    ]);
  });

  it('t8012-blame-colors.sh: "color lines becoming contiguous due to --ignore-rev"', async () => {
    const d = dir();
    writeFileSync(
      join(d, "hello.c"),
      readFileSync(join(d, "hello.c"), "utf8").replace(/\t/g, "    "),
    );
    git(d, ["add", "hello.c"]);
    git(d, ["commit", "-q", "-m", "tabs to spaces"], undefined, commitEnv(100));
    await expectSame(d, [["blame", "--color-lines", "--ignore-rev=HEAD", "hello.c"]], {
      config: { "color.blame.repeatedLines": "yellow" },
    });
  });

  it('t8012-blame-colors.sh: "color by age consistently colors old code", "blame color by age: new code is different"', async () => {
    const d = dir();
    await expectSame(d, [["blame", "--color-by-age", "hello.c"]]);
    await expectSame(
      d,
      [
        ["blame", "hello.c"],
        ["blame", "--color-lines", "hello.c"],
      ],
      {
        config: { "blame.coloring": "highlightRecent" },
      },
    );
    writeFileSync(join(d, "hello.c"), `${readFileSync(join(d, "hello.c"), "utf8")}void qfunc();\n`);
    git(d, ["add", "hello.c"]);
    git(d, ["commit", "-q", "-m", "new commit"], undefined, {
      ...commitEnv(0),
      GIT_AUTHOR_DATE: `${NOW - 3600} +0000`,
      GIT_COMMITTER_DATE: `${NOW - 3600} +0000`,
    });
    await expectSame(d, [["blame", "--color-by-age", "hello.c"]], {
      config: { "color.blame.highlightRecent": "yellow,1 month ago, cyan" },
    });
    await expectSame(d, [
      ["blame", "--color-by-age", "hello.c"],
      ["blame", "--color-by-age", "--color-lines", "-s", "hello.c"],
    ]);
    // a working-tree change: "Not Committed Yet" is now
    writeFileSync(join(d, "hello.c"), `${readFileSync(join(d, "hello.c"), "utf8")}/* wip */\n`);
    await expectSame(d, [
      ["blame", "--color-by-age", "hello.c"],
      ["blame", "--color-lines", "hello.c"],
    ]);
    git(d, ["checkout", "--", "hello.c"]);
  });
});

describeGit("git blame of the working tree and --contents: the index and MERGE_HEAD", () => {
  it('annotate-tests.sh: "blame working copy", "blame with --contents" with staged paths, links and a merge in progress', async () => {
    const d = join(tmp(), "fake-commit");
    mkdirSync(d);
    git(d, ["init", "-q", "-b", "main"]);
    let tick = 0;
    const commit = (args: string[]) =>
      git(d, ["commit", "-q", ...args], undefined, commitEnv(++tick));
    writeFileSync(join(d, "file"), "one\ntwo\nthree\n");
    symlinkSync("file", join(d, "link"));
    git(d, ["add", "file", "link"]);
    commit(["-m", "initial"]);

    // a link: --contents - takes the index's mode (120000), so the link's commit keeps it
    await expectSame(
      d,
      [
        ["blame", "--contents", "-", "HEAD", "--", "link"],
        ["blame", "--porcelain", "--contents", "-", "--", "link"],
      ],
      { stdin: "file" },
    );
    await expectSame(d, [["blame", "--contents", "-", "--", "link"]], { stdin: "other" });
    await expectSame(d, [
      ["blame", "link"],
      // a regular file given for a link: the type changed, every line is the fake commit's
      ["blame", "--contents", "file", "--", "link"],
    ]);

    // a path only the index has: blamed whole on the fake commit
    writeFileSync(join(d, "staged"), "x\ny\n");
    git(d, ["add", "staged"]);
    await expectSame(d, [
      ["blame", "staged"],
      ["blame", "--incremental", "staged"],
      ["blame", "--contents", "staged", "--", "staged"],
    ]);
    await expectSame(d, [["blame", "--contents", "-", "--", "staged"]], { stdin: "x\n" });

    // a staged rename: the index's deletion is the rename's source
    git(d, ["mv", "file", "renamed"]);
    writeFileSync(join(d, "renamed"), "one\ntwo\nthree\nfour\n");
    await expectSame(d, [
      ["blame", "renamed"],
      ["blame", "--porcelain", "renamed"],
    ]);
    git(d, ["reset", "-q", "--hard"]);
    rmSync(join(d, "staged"), { force: true });

    // a merge in progress: MERGE_HEAD's commits are the fake commit's other parents
    git(d, ["checkout", "-q", "-b", "side"]);
    writeFileSync(join(d, "file"), "zero\none\ntwo\nthree\n");
    commit(["-a", "-m", "side"]);
    git(d, ["checkout", "-q", "main"]);
    writeFileSync(join(d, "file"), "one\ntwo\nthree\nfour\n");
    commit(["-a", "-m", "main"]);
    git(d, ["merge", "-q", "--no-commit", "--no-ff", "side"], undefined, commitEnv(++tick));
    await expectSame(d, [
      ["blame", "file"],
      ["blame", "--porcelain", "file"],
      ["blame", "--first-parent", "file"],
    ]);
    await expectSame(d, [["blame", "--contents", "-", "--", "file"]], {
      stdin: "zero\none\ntwo\nthree\nfour\nfive\n",
    });

    // MERGE_HEAD read as append_merge_parents reads it: an annotated tag peeled to its
    // commit, a last line without its newline ignored, an empty line refused
    const mergeHead = join(d, ".git/MERGE_HEAD");
    const saved = readFileSync(mergeHead, "utf8");
    const side = saved.trim();
    git(d, ["tag", "-a", "-m", "side tag", "side-tag", side], undefined, commitEnv(++tick));
    writeFileSync(mergeHead, `${git(d, ["rev-parse", "side-tag"])}\n`);
    await expectSame(d, [
      ["blame", "file"],
      ["blame", "--porcelain", "file"],
    ]);
    writeFileSync(mergeHead, side);
    await expectSame(d, [["blame", "file"]]);
    writeFileSync(mergeHead, `${side}\n\n`);
    const res = spawnSync("git", ["blame", "file"], { cwd: d, env: nativeGitEnv(tmp()) });
    expect(res.status).toBe(128);
    expect(res.stderr.toString()).toBe("fatal: unknown line in '.git/MERGE_HEAD': \n\n");
    await expect(ours(d, ["blame", "file"], NOW)).rejects.toThrow(
      "unknown line in '.git/MERGE_HEAD': \n",
    );
    writeFileSync(mergeHead, saved);
    git(d, ["merge", "--abort"]);
  });
});
