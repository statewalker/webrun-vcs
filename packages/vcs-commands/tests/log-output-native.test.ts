/**
 * `git log <options>` stdout against `LogCommand.callBytes`, byte for byte: the built-in
 * formats (medium, short, full, fuller, reference, email, mboxrd, raw, oneline), user formats
 * (format: and tformat:), abbreviation, date modes, decorations, the graph (merges, octopus
 * merges, collapsing lines, several roots), diffs (`-p`, `--stat`, `--shortstat`,
 * `--numstat`, `--name-only`, `--name-status`, `-m`, `-c`, `--cc`, `--first-parent`),
 * `--no-merges`, `--reverse`, `-n`, `--skip`, path limiting, `--follow`, notes and the
 * mailmap, over random histories with merges, renames, non-ASCII text and empty commits.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Git, type LogOutputOptions, mergesMode, RevFilter } from "../src/index.js";
import { openOurs, put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const NOW = 1700000000;
let root: string;
let clock = NOW - 86400 * 400;

const env = () => ({
  ...nativeGitEnv(root),
  TZ: "UTC",
  GIT_TEST_DATE_NOW: String(NOW),
  GIT_AUTHOR_DATE: `${clock} +0000`,
  GIT_COMMITTER_DATE: `${clock} +0000`,
});

function git(dir: string, args: string[], extra: Record<string, string> = {}): Buffer {
  const r = spawnSync("git", args, { cwd: dir, env: { ...env(), ...extra } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout as Buffer;
}

/** git's version: whether it is 2.5x (visual roots indented in graphs) */
function modernGit(): boolean {
  const out = spawnSync("git", ["--version"]).stdout.toString();
  const m = /(\d+)\.(\d+)/.exec(out);
  return !!m && (Number(m[1]) > 2 || Number(m[2]) >= 50);
}

/** mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
  };
}

const MESSAGES = [
  "Fix the parser",
  "Ünïcödé subject: café 中文",
  "Tabs\tin\tsubject\n\nBody with\ttabs\n\tindented line\n",
  "Two paragraphs\n\nFirst body paragraph\nwraps here.\n\nSecond paragraph.   \n\n\n",
  "From the start of a line\n\nFrom here too\n>From quoted\n",
  "subject with = and ?= and [brackets] that is long enough to need wrapping in an email header line",
  "Signed work\n\nSigned-off-by: A U Thor <author@example.com>\n",
  "  leading spaces kept\n",
];

const PEOPLE = [
  { name: "A U Thor", email: "author@example.com" },
  { name: "Jöhn Dœ", email: "john@old.example" },
  { name: "Mr. Dot, Jr.", email: "dot@example.com" },
];

/** A random history: branches, merges (some with conflicts), an octopus, renames, notes. */
function buildRepo(dir: string, seed: number): void {
  const r = rng(seed);
  git(root, ["init", "-q", "-b", "main", dir]);
  let n = 0;
  const commit = (args: string[] = []) => {
    clock += r.chance(0.2) ? 0 : 3600 + r.int(7200);
    const who = PEOPLE[r.int(PEOPLE.length)] as { name: string; email: string };
    const message = MESSAGES[r.int(MESSAGES.length)] as string;
    git(dir, ["commit", "-q", "--allow-empty", "--cleanup=verbatim", "-m", `${message}`, ...args], {
      GIT_AUTHOR_NAME: who.name,
      GIT_AUTHOR_EMAIL: who.email,
    });
    n++;
  };
  const edit = (path: string) => {
    put(dir, path, `${path}\nline ${n}\n${"x\n".repeat(r.int(4))}tail ${r.int(100)}\n`);
    git(dir, ["add", "-A"]);
  };
  edit("README");
  edit("src/a.txt");
  commit();
  for (const branch of ["topic", "side", "third"]) {
    git(dir, ["checkout", "-q", "-b", branch, "main"]);
    for (let k = 0; k < 1 + r.int(3); k++) {
      if (r.chance(0.2)) {
        commit(); // empty
        continue;
      }
      edit(`${branch}/f${r.int(3)}.txt`);
      if (r.chance(0.3)) edit("shared.txt");
      commit();
    }
    git(dir, ["checkout", "-q", "main"]);
    edit(`main${r.int(3)}.txt`);
    commit();
  }
  // a rename on main
  git(dir, ["mv", "src/a.txt", "src/renamed.txt"]);
  commit();
  edit("src/renamed.txt");
  commit();
  // merge topic (shared.txt may conflict: resolved by hand, an evil merge)
  clock += 3600;
  const m = spawnSync("git", ["merge", "-q", "--no-ff", "-m", "Merge branch 'topic'", "topic"], {
    cwd: dir,
    env: env(),
  });
  if (m.status !== 0) {
    put(dir, "shared.txt", "resolved\nby hand\n");
    git(dir, ["add", "-A"]);
    commit(["--no-edit"]);
  }
  // an octopus of side and third (disjoint unless shared.txt clashes: then a plain merge)
  clock += 3600;
  const o = spawnSync("git", ["merge", "-q", "--no-ff", "-m", "Octopus", "side", "third"], {
    cwd: dir,
    env: env(),
  });
  if (o.status !== 0) {
    git(dir, ["reset", "-q", "--hard"]);
    git(dir, ["merge", "-q", "--no-ff", "-X", "ours", "-m", "Merge side", "side"]);
  }
  edit("README");
  commit();
  // an unrelated root, merged in
  git(dir, ["checkout", "-q", "--orphan", "other"]);
  git(dir, ["rm", "-rfq", "."]);
  edit("other.txt");
  commit();
  edit("other.txt");
  commit();
  git(dir, ["checkout", "-q", "main"]);
  clock += 3600;
  git(dir, ["merge", "-q", "--allow-unrelated-histories", "-m", "Join other", "other"]);
  // decorations
  git(dir, ["tag", "v1", "HEAD~2"]);
  git(dir, ["tag", "-a", "-m", "annotated", "v2", "HEAD"]);
  git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD~1"]);
  // notes on two commits
  git(dir, ["notes", "add", "-m", "A note\nwith two lines", "HEAD~1"]);
  git(dir, ["notes", "add", "-m", "Another", "topic"]);
  // recent commits (human dates), a message that is not UTF-8, a mode change
  clock = NOW - 86400 * 2 - 7200;
  edit("README");
  commit();
  writeFileSync(
    join(dir, "msg.txt"),
    Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x0a, 0xff, 0x0a]),
  );
  git(dir, ["commit", "-q", "--allow-empty", "--cleanup=verbatim", "-F", "msg.txt"]);
  clock = NOW - 600;
  spawnSync("chmod", ["+x", join(dir, "README")]);
  git(dir, ["add", "-A"]);
  commit();
  // a mailmap
  writeFileSync(
    join(dir, ".mailmap"),
    "John Doe <john@example.com> <john@old.example>\n# a comment\n<dot@new.example> <dot@example.com>\n",
  );
}

/** The lines around the first difference of two outputs */
function firstDifference(a: Buffer, b: Buffer): string {
  const la = a.toString("utf8").split("\n");
  const lb = b.toString("utf8").split("\n");
  let i = 0;
  while (i < la.length && la[i] === lb[i]) i++;
  const from = Math.max(0, i - 3);
  return `line ${i + 1}\n--- native\n${la.slice(from, i + 4).join("\n")}\n--- ours\n${lb.slice(from, i + 4).join("\n")}`;
}

/** `git log` arguments as LogCommand setters and output options */
async function ours(g: Git, args: string[]): Promise<Buffer> {
  const log = g.log();
  const options: LogOutputOptions = {};
  let paths = false;
  let maxCount: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (paths) {
      log.addPath(a);
      continue;
    }
    const value = (prefix: string) => (a.startsWith(prefix) ? a.slice(prefix.length) : undefined);
    if (a === "--") paths = true;
    else if (a === "--all") log.all();
    else if (a === "--oneline") options.oneline = true;
    else if (value("--pretty=") !== undefined) options.pretty = value("--pretty=");
    else if (value("--format=") !== undefined) options.pretty = value("--format=");
    else if (a === "--abbrev-commit") options.abbrevCommit = true;
    else if (a === "--no-abbrev") options.noAbbrev = true;
    else if (value("--abbrev=") !== undefined) options.abbrev = Number(value("--abbrev="));
    else if (value("--date=") !== undefined) options.date = value("--date=");
    else if (a === "--decorate") options.decorate = true;
    else if (value("--decorate=") !== undefined) options.decorate = value("--decorate=") as "short";
    else if (value("--decorate-refs=") !== undefined)
      options.decorateRefs = [...(options.decorateRefs ?? []), value("--decorate-refs=") as string];
    else if (a === "--graph") options.graph = true;
    else if (a === "--topo-order") options.topoOrder = true;
    else if (value("--graph-lane-limit=") !== undefined)
      options.graphLaneLimit = Number(value("--graph-lane-limit="));
    else if (a === "--no-graph-indent") options.graphIndent = false;
    else if (a === "-p") options.patch = true;
    else if (a === "--stat") options.stat = true;
    else if (a === "--shortstat") options.shortstat = true;
    else if (a === "--numstat") options.numstat = true;
    else if (a === "--name-only") options.nameOnly = true;
    else if (a === "--name-status") options.nameStatus = true;
    else if (a === "-m") options.m = true;
    else if (a === "-c") options.c = true;
    else if (a === "--cc") options.cc = true;
    else if (a === "--first-parent") log.setFirstParent(true);
    else if (a === "--no-merges") log.setRevFilter(RevFilter.NO_MERGES);
    else if (a === "--reverse") options.reverse = true;
    else if (a === "-n") maxCount = Number(args[++i]);
    else if (value("--skip=") !== undefined) log.setSkip(Number(value("--skip=")));
    else if (a === "--follow") options.follow = true;
    else if (a === "--notes") options.notes = true;
    else if (a === "--no-notes") options.notes = false;
    else if (a === "--no-mailmap") options.mailmap = false;
    else if (a === "--full-diff") options.fullDiff = true;
    else if (a === "--full-history") log.setFullHistory(true);
    else if (value("--diff-merges=") !== undefined)
      options.diffMerges = mergesMode(value("--diff-merges=") as string);
    else if (a === "-s") options.noPatch = true;
    else if (a.startsWith("^")) log.not(a.slice(1));
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else log.add(a);
  }
  if (maxCount !== undefined) log.setMaxCount(maxCount);
  if (options.graph && !modernGit()) options.graphIndent = false;
  options.now = NOW;
  return Buffer.from(await log.callBytes(options));
}

describeGit("git log output, native", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-output-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const CASES: string[][] = [
    [],
    ["--pretty=short"],
    ["--pretty=full"],
    ["--pretty=fuller"],
    ["--pretty=raw"],
    ["--pretty=oneline"],
    ["--oneline"],
    ["--pretty=reference"],
    ["--pretty=email"],
    ["--pretty=mboxrd"],
    ["--format=%h %an <%ae> %aN <%aE> %s%n%b"],
    ["--format=format:%H|%P|%d|%D"],
    ["--format=tformat:%h %ad %cd", "--date=iso"],
    ["--abbrev-commit"],
    ["--no-abbrev", "--oneline"],
    ["--abbrev=10", "--oneline"],
    ["--date=relative"],
    // git before 2.5x writes +00:00 for UTC, 2.5x Z
    ...(modernGit() ? [["--date=iso-strict"]] : []),
    ["--date=rfc"],
    ["--date=short"],
    ["--date=raw"],
    ["--date=unix"],
    ["--date=human"],
    ["--date=local"],
    ["--date=iso-local"],
    ["--date=short-local", "--pretty=fuller"],
    ["--date=format-local:%c %Z|%z"],
    ["--date=human", "--pretty=fuller"],
    ["--date=relative", "--format=%ar %cr %ah"],
    ["--date=format:%Y/%m/%d %H:%M %a %b %j"],
    ["--decorate"],
    ["--decorate=full", "--oneline"],
    ["--decorate", "--decorate-refs=tags", "--oneline"],
    ["--graph"],
    ["--graph", "--oneline"],
    ["--graph", "--oneline", "--all"],
    ["--graph", "--format=%h%n%s"],
    ["--graph", "--pretty=short", "--decorate"],
    ["--graph", "--first-parent", "--oneline"],
    ["--graph", "--no-merges", "--oneline"],
    ["--graph", "--oneline", "-n", "5"],
    ["--graph", "--stat"],
    ["--graph", "-p", "--oneline"],
    ["--graph", "--oneline", "--", "shared.txt"],
    ["--topo-order", "--oneline"],
    ["-p"],
    ["--stat"],
    ["--stat", "-p"],
    ["--shortstat"],
    ["--numstat", "--oneline"],
    ["--name-only"],
    ["--name-status", "--oneline"],
    ["-m", "-p", "--oneline"],
    ["-m", "--name-status"],
    ["--cc"],
    ["-c", "--oneline"],
    ["--first-parent", "-p"],
    ["--no-merges", "--stat"],
    ["--reverse", "--oneline"],
    ["-n", "3", "--skip=2", "-p"],
    ["-p", "--", "src"],
    ["--stat", "--full-diff", "--", "README"],
    // git 2.5x follows each parent's own path (2.43 one path for the whole walk)
    ...(modernGit()
      ? [
          ["--follow", "--oneline", "--", "src/renamed.txt"],
          ["--follow", "-p", "--", "src/renamed.txt"],
        ]
      : []),
    ["--notes", "--oneline"],
    ["--no-notes"],
    ["--no-mailmap"],
    ["--format=%aN %aE"],
    ["--all", "--oneline", "--decorate"],
    ["--pretty=email", "--no-mailmap"],
    ["--abbrev=4", "--oneline", "--all"],
    ["--pretty=raw", "--decorate", "--abbrev-commit"],
    ["--format=%h%d", "--decorate-refs=heads"],
    ["--graph", "--pretty=email", "-n", "4"],
    ["--graph", "--pretty=raw", "-n", "4", "--notes"],
    ["--stat", "--format=", "-n", "4"],
    ["--format=%s", "-p", "-n", "3"],
    // --diff-merges=<mode> alone diffs only the merges (revs->diff stays off)
    ["--diff-merges=separate", "--oneline"],
    ["--diff-merges=first-parent", "--format=%h %s"],
    ["--diff-merges=dense-combined"],
    ["--pretty=email", "--notes", "--diff-merges=separate"],
    ["--pretty=email", "--notes", "--stat"],
    ["-m", "--oneline", "--", "shared.txt"],
    ["--full-history", "--graph", "--oneline", "--", "shared.txt"],
    ["--graph", "--full-diff", "--stat", "--oneline", "--", "shared.txt"],
    // --abbrev=<n> reaches the index lines; --abbrev=0 is 4
    ["--abbrev=10", "-p", "-n", "3"],
    ["--abbrev=0", "--oneline"],
    ["--abbrev=12", "--cc", "-n", "6", "--oneline"],
    // %N stays literal without notes
    ["--no-notes", "--format=%h %N|"],
    ["--notes", "--format=%h [%N]"],
    ["--all", "--format=%h %d"],
  ];

  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: every option set prints git's bytes`, async () => {
      const dir = join(root, `repo-${seed}`);
      buildRepo(dir, seed);
      const g = await openOurs(dir);
      const failures: string[] = [];
      for (const args of CASES) {
        const native = git(dir, ["log", ...args]);
        let mine: Buffer;
        try {
          mine = await ours(g, args);
        } catch (e) {
          failures.push(`${args.join(" ")}: threw ${(e as Error).stack}`);
          continue;
        }
        if (!mine.equals(native))
          failures.push(`git log ${args.join(" ")}\n${firstDifference(native, mine)}`);
      }
      expect(failures.slice(0, 8).join("\n\n")).toBe("");
    }, 120000);
  }
});

/**
 * A random DAG made with plumbing: commits with up to five parents (octopus merges), several
 * roots, tips on many branches, equal dates and clock skew, each commit changing one or two
 * files of a handful (so path-limited walks simplify and rewrite parents).
 */
function buildDag(dir: string, seed: number, size: number): void {
  const r = rng(seed);
  git(root, ["init", "-q", "-b", "main", dir]);
  const files = ["a.txt", "b.txt", "d/c.txt", "d/e/f.txt", "g.bin"];
  const commits: { id: string; tree: string }[] = [];
  const indexEnv = { GIT_INDEX_FILE: join(dir, ".git", "tmp-index") };
  for (let i = 0; i < size; i++) {
    const parents: string[] = [];
    if (commits.length > 0 && !r.chance(0.06)) {
      const want = r.chance(0.25) ? 2 + (r.chance(0.3) ? r.int(4) : 0) : 1;
      for (let k = 0; k < want; k++) {
        // recent commits more likely
        const span = Math.min(commits.length, 8);
        const pick = commits[commits.length - 1 - r.int(span)] as { id: string };
        if (!parents.includes(pick.id)) parents.push(pick.id);
      }
    }
    const base = parents.length ? commits.find((c) => c.id === parents[0])?.tree : undefined;
    if (base) git(dir, ["read-tree", base], indexEnv);
    else git(dir, ["read-tree", "--empty"], indexEnv);
    const changes = r.chance(0.1) ? 0 : 1 + r.int(2);
    for (let k = 0; k < changes; k++) {
      const path = files[r.int(files.length)] as string;
      const content = path.endsWith(".bin")
        ? `\0bin${i}\n`
        : `${path}\nversion ${i}\n${"line\n".repeat(r.int(5))}`;
      const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], {
        cwd: dir,
        env: env(),
        input: content,
      })
        .stdout.toString()
        .trim();
      git(dir, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], indexEnv);
    }
    const tree = git(dir, ["write-tree"], indexEnv).toString().trim();
    clock += r.chance(0.15) ? 0 : r.chance(0.1) ? -1800 : 600 + r.int(3600);
    const message = MESSAGES[r.int(MESSAGES.length)] as string;
    const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message];
    const id = git(dir, args).toString().trim();
    commits.push({ id, tree });
    if (r.chance(0.15) || i === size - 1) {
      git(dir, ["update-ref", i === size - 1 ? "refs/heads/main" : `refs/heads/b${i}`, id]);
    }
  }
  git(dir, ["tag", "t1", (commits[Math.floor(size / 2)] as { id: string }).id]);
  git(dir, ["reset", "-q", "--hard", "main"]);
}

describeGit("git log --graph over random DAGs, native", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-graph-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const CASES: string[][] = [
    ["--graph", "--oneline", "--all"],
    ["--graph", "--oneline"],
    ["--graph", "--format=%h %p", "--all", "--decorate"],
    ["--graph", "--pretty=short", "--all"],
    ["--graph", "--oneline", "--all", "--", "a.txt"],
    ["--graph", "--oneline", "--all", "--", "d"],
    ["--graph", "--oneline", "--all", "--no-merges"],
    ["--graph", "--oneline", "--all", "--first-parent"],
    ["--graph", "--oneline", "--all", "-n", "7", "--skip=3"],
    ["--graph", "--stat", "--all", "-n", "12"],
    ["--graph", "--name-status", "--all", "-n", "12"],
    ["--graph", "--cc", "--all", "-n", "12", "--oneline"],
    ["--topo-order", "--format=%h %s", "--all"],
    ["--oneline", "--all", "--", "a.txt"],
    ["--format=%h %p", "--all", "--", "d/e"],
    ["-m", "--stat", "--all", "-n", "10"],
    ["--cc", "--all", "-n", "10"],
    ["-c", "--all", "-n", "10"],
    ["--cc", "--name-status", "--all", "-n", "10"],
    ["-c", "--name-only", "-p", "--all", "-n", "10"],
    ["--cc", "--stat", "-p", "--all", "-n", "10", "--graph"],
    ["-p", "--all", "-n", "10", "--", "g.bin", "b.txt"],
    // the full history of path-limited walks (-m and --diff-merges=separate turn it on)
    ["--full-history", "--graph", "--oneline", "--all", "--", "a.txt"],
    ["--full-history", "--format=%h %p", "--all", "--", "d"],
    ["-m", "--graph", "--format=%h %p", "--all", "--", "d/e"],
    ["--diff-merges=separate", "--stat", "--oneline", "--all", "--", "b.txt"],
    ["--graph", "--full-diff", "--stat", "--oneline", "--all", "--", "a.txt"],
    // --all in git's order: refs by name, then HEAD (commits of one date in that order)
    ["--format=%h %s", "--all"],
    // git 2.5x: lanes cut at a limit, and the visual roots' indentation turned off
    ...(modernGit()
      ? [
          ["--graph", "--oneline", "--all", "--graph-lane-limit=2"],
          ["--graph", "--oneline", "--all", "--graph-lane-limit=1"],
          ["--graph", "--pretty=short", "--all", "--graph-lane-limit=3", "--stat"],
          ["--graph", "--oneline", "--all", "--no-graph-indent"],
        ]
      : []),
  ];

  for (const seed of [11, 12, 13, 14, 15, 16, 17, 18]) {
    it(`seed ${seed}: graphs and diffs print git's bytes`, async () => {
      const dir = join(root, `dag-${seed}`);
      buildDag(dir, seed, seed % 2 ? 45 : 70);
      const g = await openOurs(dir);
      const failures: string[] = [];
      for (const args of CASES) {
        const native = git(dir, ["log", ...args]);
        let mine: Buffer;
        try {
          mine = await ours(g, args);
        } catch (e) {
          failures.push(`${args.join(" ")}: threw ${(e as Error).stack}`);
          continue;
        }
        if (!mine.equals(native))
          failures.push(`git log ${args.join(" ")}\n${firstDifference(native, mine)}`);
      }
      expect(failures.slice(0, 6).join("\n\n")).toBe("");
    }, 120000);
  }
});

describeGit("git log output under its configuration, native", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-config-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const CONFIGS: { config: [string, string][]; cases: string[][] }[] = [
    { config: [["format.pretty", "oneline"]], cases: [[], ["--graph"]] },
    { config: [["log.abbrevCommit", "true"]], cases: [[], ["--pretty=raw"]] },
    {
      config: [["log.date", "relative"]],
      cases: [
        ["-n", "3"],
        ["--date=iso", "-n", "2"],
      ],
    },
    { config: [["log.decorate", "full"]], cases: [["--oneline"], ["--pretty=raw", "-n", "2"]] },
    {
      config: [
        ["log.decorate", "short"],
        ["log.excludeDecoration", "refs/tags/"],
      ],
      cases: [["--oneline", "--all"]],
    },
    {
      config: [["pretty.mine", "format:%h <%an> %s"]],
      cases: [["--pretty=mine"], ["--pretty=min"], ["--format=mine", "--graph"]],
    },
    {
      config: [["log.mailmap", "false"]],
      cases: [
        ["-n", "6"],
        ["--format=%an %aN", "-n", "6"],
      ],
    },
    { config: [["log.showRoot", "false"]], cases: [["--stat", "--oneline"]] },
    { config: [["diff.renames", "false"]], cases: [["--stat", "-n", "8"]] },
    { config: [["log.graphIndent", "false"]], cases: [["--graph", "--oneline", "--all"]] },
    {
      config: [["core.abbrev", "12"]],
      cases: [
        ["--oneline", "-n", "3"],
        ["-p", "-n", "2"],
      ],
    },
    { config: [["log.diffMerges", "first-parent"]], cases: [["-m", "--stat", "--oneline"]] },
  ];

  it("follows format.pretty, log.*, pretty.<name>, diff.renames, core.abbrev", async () => {
    const dir = join(root, "repo");
    buildRepo(dir, 7);
    const failures: string[] = [];
    for (const { config, cases } of CONFIGS) {
      for (const [k, v] of config) git(dir, ["config", "--add", k, v]);
      const g = await openOurs(dir);
      for (const args of cases) {
        const native = git(dir, ["log", ...args]);
        const mine = await ours(g, args).catch((e) => Buffer.from(`threw ${(e as Error).stack}`));
        if (!mine.equals(native)) {
          failures.push(
            `${JSON.stringify(config)} git log ${args.join(" ")}\n${firstDifference(native, mine)}`,
          );
        }
      }
      for (const [k] of config) git(dir, ["config", "--unset-all", k]);
    }
    expect(failures.slice(0, 6).join("\n\n")).toBe("");
  }, 120000);
});

/** A commit object written as given (dates, zones and encodings `git commit` would not write). */
function writeCommit(dir: string, body: Buffer | string): string {
  const r = spawnSync("git", ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"], {
    cwd: dir,
    env: env(),
    input: body,
  });
  if (r.status !== 0) throw new Error(`hash-object: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

const revParse = (dir: string, rev: string) => git(dir, ["rev-parse", rev]).toString().trim();

/** Each case's `git log` stdout against ours: the failures, described */
async function compareCases(
  dir: string,
  g: Git,
  cases: string[][],
  extra: Record<string, string> = {},
): Promise<string[]> {
  const failures: string[] = [];
  for (const args of cases) {
    const native = git(dir, ["log", ...args], extra);
    let mine: Buffer;
    try {
      mine = await ours(g, args);
    } catch (e) {
      failures.push(`${args.join(" ")}: threw ${(e as Error).stack}`);
      continue;
    }
    if (!mine.equals(native))
      failures.push(`git log ${args.join(" ")}\n${firstDifference(native, mine)}`);
  }
  return failures;
}

describeGit("git log review fixes, native", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-fixes-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** root; side changes f; main changes g; merge; side appends to g; `merge -X ours side` */
  function buildMerges(dir: string): void {
    git(root, ["init", "-q", "-b", "main", dir]);
    const commit = (message: string) => {
      clock += 3600;
      git(dir, ["commit", "-q", "-am", message]);
    };
    put(dir, "f", "a\n");
    put(dir, "g", "a\n");
    git(dir, ["add", "."]);
    commit("root");
    git(dir, ["checkout", "-q", "-b", "side"]);
    put(dir, "f", "side\n");
    commit("side-f");
    git(dir, ["checkout", "-q", "main"]);
    put(dir, "g", "main\n");
    commit("main-g");
    clock += 3600;
    git(dir, ["merge", "-q", "-m", "merge1", "side"]);
    git(dir, ["checkout", "-q", "side"]);
    put(dir, "g", "a\nmore\n");
    commit("side-g");
    git(dir, ["checkout", "-q", "main"]);
    clock += 3600;
    git(dir, ["merge", "-q", "-X", "ours", "-m", "merge2", "side"]);
  }

  it("-m and --diff-merges=separate walk the full history of a path", async () => {
    const dir = join(root, "full-history");
    buildMerges(dir);
    const g = await openOurs(dir);
    const rootId = revParse(dir, "main~3");
    const tip = revParse(dir, "main");
    const failures = await compareCases(dir, g, [
      ["-m", "--oneline", "--", "f"],
      ["--oneline", "--", "f"],
      ["--graph", "-m", "--oneline", "--", "g"],
      ["--graph", "--oneline", "--", "g"],
      ["--full-history", "--oneline", "--", "f"],
      ["--full-history", "--graph", "--oneline", "--", "f"],
      ["--diff-merges=separate", "--oneline", "--", "f"],
      ["--diff-merges=first-parent", "--stat", "--oneline", "--", "g"],
      ["-m", "-p", "--oneline", "--", "f"],
      ["-m", "--cc", "--oneline", "--", "g"],
      ["--full-history", "--graph", "--oneline", `^${rootId}`, tip, "--", "g"],
      ["--graph", "--full-diff", "-p", "--oneline", "--", "f"],
    ]);
    expect(failures.slice(0, 6).join("\n\n")).toBe("");
  }, 120000);

  it("--follow finds copies of unchanged files, with -c/--cc, -n and --reverse", async () => {
    const dir = join(root, "follow");
    git(root, ["init", "-q", "-b", "main", dir]);
    const commit = (message: string) => {
      clock += 3600;
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-q", "-m", message]);
    };
    const lines = (from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => `${from + i}\n`).join("");
    put(dir, "a.txt", lines(1, 20));
    put(dir, "b.txt", lines(100, 120));
    commit("root");
    put(dir, "c.txt", `${lines(1, 20)}extra\n`);
    commit("copy a to c");
    put(dir, "d.txt", lines(100, 120));
    commit("exact copy of b");
    put(dir, "c.txt", `${lines(1, 20)}extra\nmore\n`);
    commit("edit c");
    git(dir, ["mv", "b.txt", "e.txt"]);
    put(dir, "e.txt", `${lines(100, 120)}tail\n`);
    commit("rename b to e");
    git(dir, ["checkout", "-q", "-b", "side"]);
    put(dir, "c.txt", `head\n${lines(1, 20)}extra\nmore\n`);
    commit("side edits c");
    git(dir, ["checkout", "-q", "main"]);
    git(dir, ["mv", "c.txt", "f.txt"]);
    commit("rename c to f");
    clock += 3600;
    git(dir, ["merge", "-q", "-m", "merge side", "side"]);
    put(dir, "d.txt", `${lines(100, 120)}d\n`);
    commit("edit d");
    const g = await openOurs(dir);
    const failures = await compareCases(dir, g, [
      ["--follow", "--stat", "--oneline", "--", "e.txt"],
      ["--follow", "-p", "--", "d.txt"],
      ["--follow", "--name-status", "--format=%s", "--", "d.txt"],
      ["-n", "0", "--follow", "--oneline", "--", "d.txt"],
      ["-n", "2", "--follow", "--oneline", "--", "d.txt"],
      ["--reverse", "-n", "4", "--follow", "--oneline", "--", "d.txt"],
      ["--reverse", "--follow", "--oneline", "--", "e.txt"],
      // git 2.5x follows each parent's own path across the merge
      ...(modernGit()
        ? [
            ["--follow", "--stat", "--oneline", "--", "f.txt"],
            ["--follow", "--name-status", "--format=%s", "--", "f.txt"],
            ["--follow", "--cc", "--oneline", "--", "f.txt"],
            ["--follow", "-c", "--stat", "--oneline", "--", "f.txt"],
            ["--follow", "-c", "--oneline", "--", "f.txt"],
            ["--follow", "-c", "--name-status", "--oneline", "--", "f.txt"],
          ]
        : []),
    ]);
    expect(failures.slice(0, 6).join("\n\n")).toBe("");
  }, 120000);

  it("re-encodes messages and idents from their encoding header", async () => {
    const dir = join(root, "encoding");
    git(root, ["init", "-q", "-b", "main", dir]);
    put(dir, "file", "content\n");
    git(dir, ["add", "file"]);
    const tree = git(dir, ["write-tree"]).toString().trim();
    const latin1 = (s: string) => Buffer.from(s, "latin1");
    const commit = (parent: string | undefined, encoding: string, who: Buffer, message: Buffer) =>
      writeCommit(
        dir,
        Buffer.concat([
          Buffer.from(`tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author `),
          who,
          Buffer.from(" <who@example.com> 1600000000 +0200\ncommitter "),
          who,
          Buffer.from(` <who@example.com> 1600000000 +0200\nencoding ${encoding}\n\n`),
          message,
        ]),
      );
    let id = commit(
      undefined,
      "ISO-8859-1",
      latin1("José Müller"),
      latin1("Café au lait\n\nBody à la carte\n"),
    );
    id = commit(id, "UTF-8", Buffer.from("Plain Ünï"), Buffer.from("Plain UTF-8 ünï\n"));
    id = commit(id, "x-unknown-charset", latin1("Unknöwn"), latin1("Unknown \xe9 charset\n"));
    id = commit(
      id,
      "Shift_JIS",
      Buffer.from([0x93, 0xfa, 0x96, 0x7b]),
      Buffer.concat([Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]), Buffer.from(" subject\n")]),
    );
    id = commit(
      id,
      "iso-8859-1",
      latin1("Zoë"),
      latin1("Ça a l'air très long, ce sujet accentué qui doit être replié dans l'en-tête\n"),
    );
    git(dir, ["update-ref", "refs/heads/main", id]);
    const g = await openOurs(dir);
    const failures = await compareCases(dir, g, [
      [],
      ["--pretty=raw"],
      ["--pretty=email"],
      ["--format=%an|%aN|%cn|%s|%e|%b"],
      ["--oneline"],
      ["--pretty=fuller"],
      ["--format=%B"],
    ]);
    expect(failures.slice(0, 6).join("\n\n")).toBe("");
  }, 120000);

  it("reads replaced commits as git does, and decorates their originals", async () => {
    const dir = join(root, "replace");
    git(root, ["init", "-q", "-b", "main", dir]);
    for (const n of [1, 2, 3]) {
      clock += 3600;
      put(dir, "file", `version ${n}\n`);
      git(dir, ["add", "file"]);
      git(dir, ["commit", "-q", "-m", `commit ${n}`]);
    }
    const replacement = git(dir, [
      "commit-tree",
      "HEAD~1^{tree}",
      "-p",
      "HEAD~2",
      "-m",
      "replacement of commit 2",
    ])
      .toString()
      .trim();
    git(dir, ["replace", "HEAD~1", replacement]);
    const g = await openOurs(dir);
    const failures = await compareCases(dir, g, [
      ["--pretty=raw"],
      ["--oneline", "--decorate"],
      ["--format=%s %d"],
      ["--stat", "--oneline"],
      [],
    ]);
    expect(failures.slice(0, 6).join("\n\n")).toBe("");
  }, 120000);

  it("shows dates past JavaScript's range and odd zones as git does", async () => {
    const dir = join(root, "dates");
    git(root, ["init", "-q", "-b", "main", dir]);
    put(dir, "file", "content\n");
    git(dir, ["add", "file"]);
    const tree = git(dir, ["write-tree"]).toString().trim();
    let parent: string | undefined;
    for (const date of [
      "1700000000 -0130",
      "1700000000 +0060",
      "1700000000 -0001",
      "9999999999999 +0000",
      "1690000000 +0545",
    ]) {
      parent = writeCommit(
        dir,
        `tree ${tree}\n${parent ? `parent ${parent}\n` : ""}author A <a@x> ${date}\ncommitter C <c@x> ${date}\n\nDated ${date}\n`,
      );
    }
    git(dir, ["update-ref", "refs/heads/main", parent as string]);
    const g = await openOurs(dir);
    const failures = await compareCases(dir, g, [
      [],
      ["--date=iso"],
      ["--date=rfc"],
      ["--date=raw"],
      ["--date=short"],
      ["--date=relative"],
      ["--pretty=fuller", "--date=human"],
      ["--date=format:%c %z|%s|%G-W%V-%u|%j"],
      ["--format=%ad|%cd"],
      // git before 2.5x writes +00:00 for UTC, 2.5x Z
      ...(modernGit() ? [["--date=iso-strict"]] : []),
    ]);
    expect(failures.slice(0, 6).join("\n\n")).toBe("");
  }, 120000);

  it("formats dates with glibc's strftime flags and the local zone's name", async () => {
    const dir = join(root, "strftime");
    git(root, ["init", "-q", "-b", "main", dir]);
    for (const date of [1690000000, 1700000000]) {
      put(dir, "file", `${date}\n`);
      git(dir, ["add", "file"]);
      git(dir, ["commit", "-q", "-m", `at ${date}`], {
        GIT_AUTHOR_DATE: `${date} +0200`,
        GIT_COMMITTER_DATE: `${date} +0200`,
      });
    }
    const g = await openOurs(dir);
    const failures: string[] = [];
    const saved = process.env.TZ;
    try {
      for (const tz of ["Asia/Kathmandu", "Europe/Berlin", "UTC"]) {
        process.env.TZ = tz;
        const found = await compareCases(
          dir,
          g,
          [
            ["--date=format-local:%Z|%z|%c|%#Z|%10Z"],
            ["--date=format:%-d %_m %03d %10Y %^a %#Z %Ey %Oe|%Z|%5z|%-5H|%^10b|%010A|%Ea|%P"],
            ["--date=local"],
            ["--date=iso-local", "--pretty=fuller"],
          ],
          { TZ: tz },
        );
        failures.push(...found.map((f) => `TZ=${tz} ${f}`));
      }
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
    expect(failures.slice(0, 6).join("\n\n")).toBe("");
  }, 120000);

  it("refuses what git refuses, with git's messages", async () => {
    const dir = join(root, "errors");
    buildMerges(dir);
    const g = await openOurs(dir);
    const cases: string[][] = [
      ["--follow", "--oneline", "--", "f", "g"],
      ["--follow", "--oneline", "--", ":(glob)f*"],
      ["--follow", "--oneline"],
      // git 2.43 names the options the other way round
      ...(modernGit() ? [["--graph", "--reverse", "--oneline"]] : []),
    ];
    const failures: string[] = [];
    for (const args of cases) {
      const r = spawnSync("git", ["log", ...args], { cwd: dir, env: env() });
      const native = r.stderr.toString();
      const mine = await ours(g, args).then(
        () => "no error",
        (e) => `fatal: ${(e as Error).message}\n`,
      );
      if (r.status === 0 || mine !== native) {
        failures.push(`git log ${args.join(" ")}: native ${native} ours ${mine}`);
      }
    }
    expect(failures.join("\n")).toBe("");
  }, 120000);

  it("walks tags it is given from the commits they tag, --all and given commits together", async () => {
    const dir = join(root, "api");
    buildMerges(dir);
    git(dir, ["tag", "-a", "-m", "annotated", "vt", "side~1"]);
    git(dir, ["tag", "-a", "-m", "nested", "vn", "vt"]);
    git(dir, ["config", "mailmap.file", "extra-map"]);
    put(dir, "extra-map", "Mapped Name <mapped@example.com> <interop@example.com>\n");
    const g = await openOurs(dir);
    const failures = await compareCases(dir, g, [
      [revParse(dir, "vt"), "--oneline"],
      [revParse(dir, "vn"), "--format=%h %s"],
      ["--all", `^${revParse(dir, "vt")}`, "--format=%h %s"],
      [`^${revParse(dir, "main~1")}`, "--all", "--format=%h %s"],
      ["--format=%aN <%aE>", "-n", "2"],
    ]);
    expect(failures.slice(0, 6).join("\n\n")).toBe("");
  }, 120000);
});
