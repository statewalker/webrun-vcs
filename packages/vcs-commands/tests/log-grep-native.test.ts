/**
 * `git log` / `git rev-list` commit filters against native git: `--grep`, `--author`,
 * `--committer` with `--all-match`, `--invert-grep`, `-i`, `-E`/`-F`/`-P`/`--basic-regexp`,
 * `grep.patternType`/`grep.extendedRegexp` and the mailmap (revision.c's `commit_match`,
 * grep.c), and the composable `CommitFilters` (JGit's RevFilter family).
 *
 * Scenario sources: git's t/t4202-log.sh (the `--grep`, `--invert-grep`, pattern type and
 * `--author`/`--committer` tests), t/t7810-grep.sh (its `log grep` tests), JGit's
 * RevWalkFilterTest (all/none/and/or/not, NO_MERGES, CommitTimeRevFilter) and
 * RawSubStringPatternTest (case-insensitive substrings). Each scenario runs native git and ours
 * on one repository and compares the commit ids listed, or the error git dies with.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type CommitFilter,
  CommitFilters,
  Git,
  GrepPatternError,
  type LogCommand,
  RevFilter,
  type RevListCommand,
} from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** One commit of a fixture: its message, identities and parents (marks) */
interface FixtureCommit {
  message: string;
  author?: string;
  committer?: string;
  parents?: number[];
  branch?: string;
}

const AUTHOR = "A U Thor <author@example.com>";
const COMMITTER = "C O Mitter <committer@example.com>";

/** A fast-import stream: commit `i` has mark `i + 1`, dates one minute apart */
function fastImport(commits: FixtureCommit[], base = 1112912053): string {
  const out: string[] = [];
  commits.forEach((c, i) => {
    const mark = i + 1;
    const time = base + i * 60;
    out.push(`commit refs/heads/${c.branch ?? "main"}\nmark :${mark}\n`);
    out.push(`author ${c.author ?? AUTHOR} ${time} -0700\n`);
    out.push(`committer ${c.committer ?? COMMITTER} ${time} -0700\n`);
    out.push(`data ${Buffer.byteLength(c.message)}\n${c.message}\n`);
    const parents = c.parents ?? (i > 0 ? [mark - 1] : []);
    if (parents.length > 0) out.push(`from :${parents[0]}\n`);
    else out.push("from 0000000000000000000000000000000000000000\n");
    for (const p of parents.slice(1)) out.push(`merge :${p}\n`);
    out.push(`M 100644 inline file\ndata ${String(mark).length + 1}\n${mark}\n`);
    if (mark === 1) {
      const mailmap = "New Name <new@example.com> Old Name <old@example.com>\n";
      out.push(`M 100644 inline .mailmap\ndata ${mailmap.length}\n${mailmap}`);
    }
    out.push("\n");
  });
  return out.join("");
}

/** t4202's six commits, t7810's authors, t4202's pattern-type subjects and more */
const MAIN: FixtureCommit[] = [
  { message: "initial\n" },
  { message: "second\n", author: "With * Asterisk <xyzzy@frotz.com>" },
  { message: "third\n" },
  { message: "fourth\n", author: "Night Fall <nitfol@frobozz.com>" },
  { message: "fifth\n", author: "Old Name <old@example.com>" },
  {
    message:
      "sixth\n\nbody line with a fix\nand Bug 12\n\nSigned-off-by: Some One <so@example.com>\n",
  },
  { message: "1\n" },
  { message: "(1|2)\n", committer: "Other Committer <oc@example.org>" },
  { message: "1d\n" },
  { message: "2e\n" },
  { message: "crlf line\r\n\r\nbody\r\n" },
  { message: "side: Fix the bug\n", parents: [10], branch: "side" },
  { message: "Merge branch 'side'\n", parents: [11, 12] },
  { message: "" },
  { message: "Grüße aus Köln\n", author: "Ævar Arnfjörð <avar@example.com>" },
  { message: "subject only, no newline" },
  { message: "tab\there and fi\n" },
];

describeGit("log/rev-list commit filters against native git", () => {
  let root: string;
  let dir: string;
  let ids: string[];

  const gitEnv = (config: Record<string, string> = {}): Record<string, string> => {
    const env = nativeGitEnv(root);
    let n = Number(env.GIT_CONFIG_COUNT ?? "0");
    for (const [key, value] of Object.entries(config)) {
      env[`GIT_CONFIG_KEY_${n}`] = key;
      env[`GIT_CONFIG_VALUE_${n}`] = value;
      n++;
    }
    env.GIT_CONFIG_COUNT = String(n);
    return env;
  };
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: dir, env: gitEnv(), encoding: "utf8", input });

  /** Whether native git was built with PCRE (git dies on -P otherwise, as t4202 expects) */
  let pcre = false;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-grep-"));
    dir = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", dir], { env: gitEnv() });
    const marks = join(root, "marks");
    git(["fast-import", "--quiet", `--export-marks=${marks}`], fastImport(MAIN));
    const byMark = new Map<number, string>();
    for (const line of readFileSync(marks, "utf8").split("\n")) {
      const m = /^:(\d+) ([0-9a-f]{40})$/.exec(line);
      if (m) byMark.set(Number(m[1]), m[2] as string);
    }
    ids = MAIN.map((_, i) => byMark.get(i + 1) as string);
    git(["update-ref", "refs/heads/main", ids[ids.length - 1] as string]);
    git(["reset", "-q", "--hard"]);
    const r = spawnSync("git", ["log", "-P", "--grep=x+", "-1"], {
      cwd: dir,
      env: gitEnv(),
      encoding: "utf8",
    });
    pcre = !/not compiled with USE_LIBPCRE/.test(r.stderr ?? "");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function open(config: Record<string, string> = {}): Promise<Git> {
    const files = createNodeFilesApi({ rootDir: dir });
    const environment = createNodeGitHostEnvironment({ env: gitEnv(config) });
    const { history } = await createGitFilesBackend({ files, environment });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
    return Git.fromWorkingCopy(await worktrees.openCurrent());
  }

  /** What native git lists, or the first line it dies with */
  function native(cmd: "log" | "rev-list", args: string[], config: Record<string, string>) {
    const full = cmd === "log" ? ["log", "--format=%H", ...args] : ["rev-list", ...args, "HEAD"];
    const r = spawnSync("git", full, { cwd: dir, env: gitEnv(config), encoding: "utf8" });
    if (r.status !== 0) return { error: (r.stderr ?? "").split("\n")[0] as string };
    return { ids: r.stdout.split("\n").filter(Boolean) };
  }

  /** git's options on our walk, one argument at a time */
  function apply<T extends LogCommand | RevListCommand>(c: T, args: string[]): T {
    for (const arg of args) {
      const [opt, value = ""] = arg.startsWith("--") ? splitOnce(arg, "=") : [arg, ""];
      if (opt === "--grep") c.addGrep(value);
      else if (opt === "--author") c.addAuthor(value);
      else if (opt === "--committer") c.addCommitter(value);
      else if (opt === "--all-match") c.setAllMatch(true);
      else if (opt === "--invert-grep") c.setInvertGrep(true);
      else if (opt === "-i" || opt === "--regexp-ignore-case") c.setRegexpIgnoreCase(true);
      else if (opt === "-E" || opt === "--extended-regexp") c.setPatternType("extended");
      else if (opt === "-F" || opt === "--fixed-strings") c.setPatternType("fixed");
      else if (opt === "-P" || opt === "--perl-regexp") c.setPatternType("perl");
      else if (opt === "--basic-regexp") c.setPatternType("basic");
      else if (opt === "--no-mailmap") c.setUseMailmap(false);
      else if (opt === "--use-mailmap") c.setUseMailmap(true);
      else if (opt === "--max-count" || opt === "-1") c.setMaxCount(opt === "-1" ? 1 : +value);
      else if (opt === "--no-merges") c.addCommitFilter(CommitFilters.noMerges());
      else if (opt === "--merges") c.addCommitFilter(CommitFilters.onlyMerges());
      else if (opt === "--since-as-filter")
        c.addCommitFilter(CommitFilters.commitTime({ since: +value }));
      else if (opt === "--until") c.addCommitFilter(CommitFilters.commitTime({ until: +value }));
      else if (opt === "--skip") (c as LogCommand).setSkip(+value);
      else throw new Error(`test: unknown option ${arg}`);
    }
    return c;
  }

  async function ours(cmd: "log" | "rev-list", args: string[], config: Record<string, string>) {
    const g = await open(config);
    try {
      const walk =
        cmd === "log"
          ? apply(g.log(), args)
          : apply(g.revList().setLogConfig(false).setCommittish(false), args);
      const out: string[] = [];
      for await (const c of await walk.call()) out.push(c.id);
      return { ids: out };
    } catch (e) {
      if (e instanceof GrepPatternError) return { error: e.lines[0] as string };
      return { error: (e as Error).message.split("\n")[0] as string };
    }
  }

  interface Scenario {
    /** The git t/ script or JGit class the inputs come from */
    source: string;
    args: string[];
    config?: Record<string, string>;
    perl?: boolean;
    /** Also as `git rev-list` (no `log` configuration, no mailmap) */
    revList?: boolean;
  }

  const t4202 = "t4202-log.sh";
  const t7810 = "t7810-grep.sh";
  const own = "webrun-vcs";
  const SCENARIOS: Scenario[] = [
    // t4202-log.sh
    { source: t4202, args: ["-1", "--grep=sec"], revList: true },
    { source: t4202, args: ["--invert-grep"] },
    { source: t4202, args: ["--all-match"] },
    {
      source: t4202,
      args: ["--invert-grep", "--grep=th", "--grep=Sec"],
      config: { "grep.patternType": "fixed" },
    },
    {
      source: t4202,
      args: ["--invert-grep", "--grep=t[h]", "--grep=S[e]c"],
      config: { "grep.patternType": "basic" },
    },
    {
      source: t4202,
      args: ["--invert-grep", "--grep=t[h]", "--grep=S[e]c"],
      config: { "grep.patternType": "extended" },
    },
    {
      source: t4202,
      args: ["--invert-grep", "--grep=t[h]", "--grep=S[e]c"],
      config: { "grep.patternType": "perl" },
      perl: true,
    },
    {
      source: t4202,
      args: ["--invert-grep", "-i", "--grep=th", "--grep=Sec"],
      config: { "grep.patternType": "fixed" },
    },
    {
      source: t4202,
      args: ["--invert-grep", "-i", "--grep=t[h]", "--grep=S[e]c"],
      config: { "grep.patternType": "basic" },
    },
    {
      source: t4202,
      args: ["--invert-grep", "-i", "--grep=t[h]", "--grep=S[e]c"],
      config: { "grep.patternType": "perl" },
      perl: true,
    },
    { source: t4202, args: ["-1", "-i", "--grep=sec"] },
    { source: t4202, args: ["-1", "--grep=s[e]c", "-i"], config: { "grep.patternType": "basic" } },
    {
      source: t4202,
      args: ["-1", "--grep=s[e]c", "-i"],
      config: { "grep.patternType": "extended" },
    },
    {
      source: t4202,
      args: ["-1", "--grep=s[e]c", "-i"],
      config: { "grep.patternType": "perl" },
      perl: true,
    },
    { source: t4202, args: ["-1", "-F", "-E", "--grep=(s).c.nd"] },
    { source: t4202, args: ["-1", "-F", "-E", "--perl-regexp", "--grep=[\\d]"], perl: true },
    { source: t4202, args: ["-1", "-F", "-E", "--grep=[\\d]"] },
    { source: t4202, args: ["-1", "--grep=s.c.nd"], config: { "grep.patterntype": "fixed" } },
    {
      source: t4202,
      args: ["-1", "--basic-regexp", "--grep=s.c.nd"],
      config: { "grep.patterntype": "fixed" },
    },
    { source: t4202, args: ["--grep=(1|2)"], config: { "grep.patternType": "fixed" } },
    { source: t4202, args: ["--grep=(.|.)"], config: { "grep.patternType": "basic" } },
    { source: t4202, args: ["--grep=\\|2"], config: { "grep.patternType": "extended" } },
    {
      source: t4202,
      args: ["--grep=[\\d]\\|"],
      config: { "grep.patternType": "perl" },
      perl: true,
    },
    { source: t4202, args: ["-F", "--grep=(1|2)"] },
    { source: t4202, args: ["-E", "--grep=\\|2"] },
    { source: t4202, args: ["-P", "--grep=[\\d]\\|"], perl: true },
    { source: t4202, args: ["--fixed-strings", "--grep=(1|2)"] },
    { source: t4202, args: ["--basic-regexp", "--grep=(.|.)"] },
    { source: t4202, args: ["--extended-regexp", "--grep=\\|2"] },
    { source: t4202, args: ["--author=A U"], revList: true },
    { source: t4202, args: ["--committer=example"], revList: true },
    // t7810-grep.sh, "log grep"
    { source: t7810, args: ["--author=author"], revList: true },
    { source: t7810, args: ["--author= * ", "-F"] },
    { source: t7810, args: ["--author=^A U"] },
    { source: t7810, args: ["--author=frotz\\.com>$"] },
    { source: t7810, args: ["--author=Thor", "-F"] },
    { source: t7810, args: ["--author=-0700"] },
    { source: t7810, args: ["--grep=i", "--grep=r"], revList: true },
    { source: t7810, args: ["--all-match", "--grep=i", "--grep=r"], revList: true },
    { source: t7810, args: ["--author=Thor", "--author=Aster"] },
    { source: t7810, args: ["--all-match", "--author=Thor", "--author=Aster"] },
    { source: t7810, args: ["--author=A U Thor", "--grep=r"] },
    { source: t7810, args: ["--author=A U Thor", "--grep=s", "--grep=l"] },
    { source: t7810, args: ["--all-match", "--author=Thor", "--author=Night", "--grep=i"] },
    { source: t7810, args: ["--author=Thor", "--author=Night", "--grep=i"] },
    { source: t7810, args: ["--all-match", "--author=A U Thor", "--grep=i", "--grep=r"] },
    { source: t7810, args: ["--author=1112912053 -0700"] },
    { source: t7810, args: ["--committer=1112912053 -0700"] },
    // more of grep.c's behaviour
    { source: own, args: ["--committer=Other"], revList: true },
    { source: own, args: ["--committer=EXAMPLE", "-i"] },
    { source: own, args: ["--author=Thor", "--committer=Other"] },
    { source: own, args: ["--all-match", "--author=Thor", "--committer=Mitter", "--grep=t"] },
    { source: own, args: ["--invert-grep", "--author=Thor", "--grep=th"] },
    { source: own, args: ["--invert-grep", "--all-match", "--grep=i", "--grep=r"] },
    { source: own, args: ["--invert-grep", "--all-match", "--author=Thor", "--grep=i"] },
    { source: own, args: ["--grep="] },
    { source: own, args: ["--grep=^$"] },
    { source: own, args: ["--grep=^"] },
    { source: own, args: ["--grep=fix"] },
    { source: own, args: ["--grep=FIX", "-i"] },
    { source: own, args: ["--grep=^Signed-off-by:"] },
    { source: own, args: ["--grep=^tree "] },
    { source: own, args: ["--grep=^author"] },
    { source: own, args: ["--grep=body$"] },
    { source: own, args: ["--grep=body.$", "-E"] },
    { source: own, args: ["--grep=third\nfourth"] },
    { source: own, args: ["--all-match", "--grep=third\nfourth"] },
    { source: own, args: ["--grep=no newline$"] },
    { source: own, args: ["--grep=\\bfi\\b"] },
    { source: own, args: ["--grep=\tthere", "-F"] },
    { source: own, args: ["--grep=Bug [0-9]\\+"] },
    { source: own, args: ["--grep=Bug [0-9]+", "-E"] },
    { source: own, args: ["--grep=(fix|Fix)", "-E"] },
    { source: own, args: ["--grep=\\(fix\\|Fix\\)"] },
    { source: own, args: ["--grep=Grüße"] },
    { source: own, args: ["--grep=grüsse", "-i"] },
    { source: own, args: ["--author=Ævar"] },
    { source: own, args: ["--merges", "--grep=Merge"] },
    { source: own, args: ["--no-merges", "--grep=[Ff]ix"] },
    { source: own, args: ["--max-count=2", "--skip=1", "--grep=i"] },
    { source: own, args: ["--since-as-filter=1112912353", "--author=Thor"] },
    { source: own, args: ["--author=New Name"], revList: true },
    { source: own, args: ["--author=Old Name"], revList: true },
    { source: own, args: ["--no-mailmap", "--author=New Name"] },
    { source: own, args: ["--no-mailmap", "--author=Old Name"] },
    { source: own, args: ["--author=New Name"], config: { "log.mailmap": "false" } },
    { source: own, args: ["--author=new@example.com>$"] },
    { source: own, args: ["--grep=(1|2)"], config: { "grep.extendedRegexp": "true" } },
    {
      source: own,
      args: ["--grep=(1|2)"],
      config: { "grep.extendedRegexp": "true", "grep.patternType": "default" },
    },
    {
      source: own,
      args: ["--grep=(1|2)"],
      config: { "grep.extendedRegexp": "true", "grep.patternType": "basic" },
    },
    { source: own, args: ["--grep=(1|2)"], config: { "grep.patternType": "fixed" }, revList: true },
    { source: own, args: [], config: { "grep.patternType": "nope" } },
    { source: own, args: ["--grep=\\("] },
    { source: own, args: ["--author=\\("] },
    { source: own, args: ["-E", "--grep=a{1"] },
    { source: own, args: ["-E", "--grep=("] },
    // -P
    { source: own, args: ["-P", "--grep=fi(?=f)"], perl: true },
    { source: own, args: ["-P", "--grep=\\bthi\\w+"], perl: true },
    { source: own, args: ["-P", "--grep=(?i)SEC"], perl: true },
    { source: own, args: ["-P", "-i", "--grep=^s.c(?!x)"], perl: true },
    { source: own, args: ["-P", "--grep=line.$"], perl: true },
    { source: own, args: ["-P", "--grep=\\d{2}"], perl: true },
    { source: own, args: ["-P", "--grep=(?<n>i)\\k<n>"], perl: true },
    { source: own, args: ["-P", "--grep=\\Q(1|2)\\E"], perl: true },
    { source: own, args: ["-P", "--grep=[[:digit:]]e"], perl: true },
    { source: own, args: ["-P", "--grep=f.x|F.x"], perl: true },
    { source: own, args: ["-P", "--grep=\\x47r"], perl: true },
    { source: own, args: ["-P", "--grep=tab\\s"], perl: true },
    { source: own, args: ["-P", "--grep=Gr..e"], perl: true },
    { source: own, args: ["-P", "--author=^\\w+ \\w Thor"], perl: true },
  ];

  for (const s of SCENARIOS) {
    const label = `${s.source}: git ${Object.entries(s.config ?? {})
      .map(([k, v]) => `-c ${k}=${v} `)
      .join("")}log ${s.args.map((a) => JSON.stringify(a)).join(" ")}`;
    it(label, async () => {
      if (s.perl && !pcre) return;
      const config = s.config ?? {};
      const expected = native("log", s.args, config);
      expect(await ours("log", s.args, config)).toEqual(expected);
      if (s.revList) {
        const args = s.args.filter((a) => a !== "-1");
        expect(await ours("rev-list", args, config)).toEqual(native("rev-list", args, config));
      }
    });
  }

  it("refuses -P syntax it cannot run as PCRE2 does (possessive quantifiers, atomic groups)", async () => {
    for (const pattern of ["a++", "(?>a)", "\\p{L}", "a(?R)"]) {
      const result = await ours("log", ["-P", `--grep=${pattern}`], {});
      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toMatch(/unsupported in -P patterns/);
    }
  });

  it("RevWalkFilterTest: all, none, and, or, not and a custom filter, as git lists them", async () => {
    const all = native("log", [], {}).ids as string[];
    expect(all.length).toBe(MAIN.length);
    // a filter of our own (JGit's MyAll)
    const myAll: CommitFilter = { include: () => true };
    const none: string[] = [];
    const cases: [CommitFilter, string[]][] = [
      [CommitFilters.all(), all],
      [CommitFilters.not(CommitFilters.all()), none],
      [CommitFilters.none(), none],
      [CommitFilters.not(CommitFilters.none()), all],
      [CommitFilters.and(CommitFilters.all(), CommitFilters.none()), none],
      [CommitFilters.and(CommitFilters.none(), CommitFilters.all()), none],
      [CommitFilters.or(CommitFilters.all(), CommitFilters.none()), all],
      [CommitFilters.or(CommitFilters.none(), CommitFilters.all()), all],
      [CommitFilters.and(myAll, CommitFilters.none()), none],
      [CommitFilters.and(CommitFilters.none(), myAll), none],
      [CommitFilters.or(myAll, CommitFilters.none()), all],
      [CommitFilters.or(CommitFilters.none(), myAll), all],
      [CommitFilters.noMerges(), native("log", ["--no-merges"], {}).ids as string[]],
      [
        CommitFilters.and(CommitFilters.author("Thor"), CommitFilters.message("i")),
        native("log", ["--author=Thor", "--grep=i"], {}).ids as string[],
      ],
      [
        CommitFilters.or(CommitFilters.message("third"), CommitFilters.message("fourth")),
        native("log", ["--grep=third", "--grep=fourth"], {}).ids as string[],
      ],
      [
        CommitFilters.not(CommitFilters.message("th")),
        native("log", ["--invert-grep", "--grep=th"], {}).ids as string[],
      ],
      [
        CommitFilters.and(
          CommitFilters.not(CommitFilters.author("Thor")),
          CommitFilters.committer("Mitter"),
        ),
        native("log", ["--committer=Mitter"], {}).ids?.filter(
          (id) => !(native("log", ["--author=Thor"], {}).ids as string[]).includes(id),
        ) as string[],
      ],
    ];
    for (const [filter, expected] of cases) {
      const g = await open();
      const got: string[] = [];
      for await (const c of await g.log().addCommitFilter(filter).call()) got.push(c.id);
      expect(got).toEqual(expected);
    }
  });

  it("RevWalkFilterTest: CommitTimeRevFilter after/before/between as --since-as-filter/--until", async () => {
    // a, b, c1, c2 (both on b), d = merge(c1, c2), e: 100 seconds apart
    const tdir = join(root, "time");
    execFileSync("git", ["init", "-q", "-b", "main", tdir], { env: gitEnv() });
    const commits: FixtureCommit[] = [
      { message: "a\n" },
      { message: "b\n" },
      { message: "c1\n", parents: [2] },
      { message: "c2\n", parents: [2], branch: "c2" },
      { message: "d\n", parents: [3, 4] },
      { message: "e\n" },
    ];
    const stream = fastImport(commits, 1500000000).replace(/ (\d+) -0700/g, (_, t) => {
      const i = (Number(t) - 1500000000) / 60;
      return ` ${1500000000 + i * 100} -0700`;
    });
    execFileSync("git", ["fast-import", "--quiet"], { cwd: tdir, env: gitEnv(), input: stream });
    const since = 1500000000 + 2 * 100;
    const until = 1500000000 + 4 * 100;
    const saved = dir;
    dir = tdir;
    try {
      for (const [args, filter] of [
        [[`--since-as-filter=${since}`], CommitFilters.commitTime({ since })],
        [[`--until=${until}`], CommitFilters.commitTime({ until })],
        [
          [`--since-as-filter=${since}`, `--until=${until}`],
          CommitFilters.commitTime({ since, until }),
        ],
        [["--no-merges"], CommitFilters.noMerges()],
      ] as [string[], CommitFilter][]) {
        const expected = native("log", args, {}).ids as string[];
        const g = await open();
        const got: string[] = [];
        for await (const c of await g.log().addCommitFilter(filter).call()) got.push(c.id);
        expect(got).toEqual(expected);
      }
    } finally {
      dir = saved;
    }
  });

  it("RawSubStringPatternTest: case-insensitive substrings as git log -i -F --grep", async () => {
    const sdir = join(root, "substring");
    execFileSync("git", ["init", "-q", "-b", "main", sdir], { env: gitEnv() });
    const inputs = ["a", "abcd", "b", "abaaba", "ddda", "A", "aB", "Ab"];
    execFileSync("git", ["fast-import", "--quiet"], {
      cwd: sdir,
      env: gitEnv(),
      input: fastImport(inputs.map((m) => ({ message: `${m}\n` }))),
    });
    const saved = dir;
    dir = sdir;
    try {
      for (const pattern of ["a", "ab", "abcd", "bc", "abab", "Ab", "aB", "x"]) {
        const expected = native("log", ["-i", "-F", `--grep=${pattern}`], {}).ids as string[];
        const g = await open();
        const filter = CommitFilters.message(pattern, { patternType: "fixed", ignoreCase: true });
        const got: string[] = [];
        for await (const c of await g.log().addCommitFilter(filter).call()) got.push(c.id);
        expect(got).toEqual(expected);
      }
    } finally {
      dir = saved;
    }
  });

  it("filters git log's output (callText) too, --graph and --no-mailmap included", async () => {
    for (const [args, options] of [
      [["--grep=i"], {}],
      [["--graph", "--grep=i", "--author=Thor"], { graph: true }],
      [["--graph", "--author=Thor"], { graph: true }],
      [["--graph", "--grep=i"], { graph: true }],
      [["--graph", "--grep=Merge"], { graph: true }],
      [["--topo-order", "--invert-grep", "--grep=i"], { topoOrder: true }],
      [["--no-mailmap", "--author=Old Name"], { mailmap: false }],
      [["--author=New Name"], {}],
    ] as [string[], Record<string, boolean>][]) {
      const expected = execFileSync("git", ["log", "--format=%s", ...args], {
        cwd: dir,
        env: gitEnv(),
        encoding: "utf8",
      });
      const g = await open();
      const log = apply(
        g.log(),
        args.filter((a) => !["--graph", "--topo-order"].includes(a)),
      );
      // git 2.5x indents a visual root (a commit whose parents are all hidden), 2.43 does not
      const indent = options.graph ? { graphIndent: modernGit() } : {};
      expect(await log.callText({ pretty: "tformat:%s", ...options, ...indent })).toBe(expected);
    }
  });

  it("keeps RevFilter and the legacy author filter working beside the new filters", async () => {
    const g = await open();
    const got: string[] = [];
    for await (const c of await g.log().setRevFilter(RevFilter.NO_MERGES).addGrep("i").call())
      got.push(c.id);
    expect(got).toEqual(native("log", ["--no-merges", "--grep=i"], {}).ids);
  });
});

/** Whether the native git is 2.50 or later */
function modernGit(): boolean {
  const m = /(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" }));
  return !!m && (Number(m[1]) > 2 || Number(m[2]) >= 50);
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i < 0 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}
