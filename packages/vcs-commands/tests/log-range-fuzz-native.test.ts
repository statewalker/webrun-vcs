/**
 * `git log <revs> -- <pathspec>` with excluded commits against native git, on random
 * histories: merges whose trees match one parent, the other, both or neither, commits of one
 * date, and clock skew (a commit older than its parent). With commits excluded git limits the
 * walk first (revision.c limit_list): one date-ordered queue of included and excluded
 * commits, UNINTERESTING spread as commits are taken, a merge's relevance judged with what is
 * marked so far, the walk stopped once only uninteresting commits are left, and `--since`
 * turned into UNINTERESTING. The ids `LogCommand` yields must be git's, without a commit-graph
 * and with changed-path filters (and then git's trace2 Bloom statistics), across rev-list
 * limits (`-n`, `--skip`, `--author`, `--first-parent`, `--since`, `--until`, `--merges`,
 * `--no-merges`) and pathspecs with wildcards, a trailing slash and exclusions.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, type LogCommand, RevFilter } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** mulberry32: a small seeded generator. */
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
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
    chance: (p: number) => next() < p,
  };
}

const FILES = ["a", "b", "d/x", "d/y", "d/e/z", "p/q"];

interface Built {
  stream: string;
  /** Commit dates by mark */
  dates: number[];
  count: number;
}

/**
 * A random history as a fast-import stream: each commit states its whole tree (`deleteall`
 * and every file), so a merge can take its first parent's tree, its second's, a mix, or new
 * content.
 */
function randomHistory(seed: number, count: number): Built {
  const r = rng(seed);
  const out: string[] = [];
  const trees: Map<string, string>[] = [new Map()];
  const dates: number[] = [0];
  let time = 1500000000;
  const data = (s: string) => out.push(`data ${Buffer.byteLength(s)}\n${s}\n`);
  for (let mark = 1; mark <= count; mark++) {
    const parents: number[] = [];
    if (mark > 1) {
      parents.push(r.chance(0.7) ? mark - 1 : 1 + r.int(mark - 1));
      if (mark > 3 && r.chance(0.3)) {
        const second = 1 + r.int(mark - 1);
        if (second !== parents[0]) parents.push(second);
      }
    }
    const first = trees[parents[0] ?? 0] as Map<string, string>;
    let tree = new Map(first);
    if (parents.length > 1) {
      const other = trees[parents[1] as number] as Map<string, string>;
      const how = r.int(4);
      if (how === 1) tree = new Map(other);
      else if (how === 2) {
        for (const f of FILES) {
          if (r.chance(0.5)) {
            const v = other.get(f);
            if (v === undefined) tree.delete(f);
            else tree.set(f, v);
          }
        }
      }
    }
    const changes = parents.length > 1 ? r.int(2) : r.int(3);
    for (let i = 0; i < changes; i++) {
      const f = r.pick(FILES);
      if (tree.has(f) && r.chance(0.15)) tree.delete(f);
      else tree.set(f, `${f} ${mark} ${i}\n`);
    }
    trees.push(tree);
    // dates: mostly later than the last, sometimes the same, sometimes before a parent
    const roll = r.next();
    if (roll < 0.2) {
      // same date
    } else if (roll < 0.3) time -= 50 + r.int(500);
    else time += 10 + r.int(100);
    dates.push(time);
    const who = r.chance(0.5) ? "Alice Author <alice@example.com>" : "Bob Writer <bob@example.com>";
    out.push(`commit refs/heads/fuzz\nmark :${mark}\n`);
    out.push(`author ${who} ${time} +0000\n`);
    out.push(`committer C O Mitter <c@example.com> ${time} +0000\n`);
    data(`commit ${mark}\n`);
    if (parents.length > 0) out.push(`from :${parents[0]}\n`);
    else out.push("from 0000000000000000000000000000000000000000\n");
    if (parents.length > 1) out.push(`merge :${parents[1]}\n`);
    out.push("deleteall\n");
    for (const [path, content] of [...tree].sort()) {
      out.push(`M 100644 inline ${path}\n`);
      data(content);
    }
    out.push("\n");
  }
  return { stream: out.join(""), dates, count };
}

const PATHSPECS: string[][] = [
  ["a"],
  ["b"],
  ["d"],
  ["d/"],
  ["d/x"],
  ["d/e"],
  ["d/e/z"],
  ["p/q", "a"],
  ["d/x", "b"],
  ["missing"],
  ["d/*"],
  ["*/z"],
  ["d", ":(exclude)d/y"],
  [":!a"],
];

interface Query {
  revs: { id: string; exclude: boolean }[];
  paths: string[];
  args: string[];
  configure: (c: LogCommand) => LogCommand;
}

/** A random `git log` of the history: revisions (most with exclusions), pathspec, limits. */
function randomQuery(r: ReturnType<typeof rng>, ids: string[], dates: number[]): Query {
  const revs: Query["revs"] = [];
  const includes = 1 + r.int(2);
  for (let i = 0; i < includes; i++) revs.push({ id: r.pick(ids), exclude: false });
  const excludes = r.chance(0.85) ? 1 + r.int(2) : 0;
  for (let i = 0; i < excludes; i++) {
    revs.splice(r.int(revs.length + 1), 0, { id: r.pick(ids), exclude: true });
  }
  const paths = r.pick(PATHSPECS);
  const args: string[] = [];
  const steps: ((c: LogCommand) => LogCommand)[] = [];
  if (r.chance(0.15)) {
    args.push("--first-parent");
    steps.push((c) => c.setFirstParent(true));
  }
  if (r.chance(0.2)) {
    const since = r.pick(dates.slice(1));
    args.push(`--since=${since}`);
    steps.push((c) => c.setSince(since));
  }
  if (r.chance(0.1)) {
    const until = r.pick(dates.slice(1));
    args.push(`--until=${until}`);
    steps.push((c) => c.setUntil(until));
  }
  if (r.chance(0.15)) {
    const n = r.int(4);
    args.push(`--max-count=${n}`);
    steps.push((c) => c.setMaxCount(n));
  }
  if (r.chance(0.15)) {
    const n = 1 + r.int(3);
    args.push(`--skip=${n}`);
    steps.push((c) => c.setSkip(n));
  }
  if (r.chance(0.1)) {
    const who = r.pick(["Alice", "Bob"]);
    args.push(`--author=${who}`);
    steps.push((c) => c.setAuthorFilter(who));
  }
  if (r.chance(0.1)) {
    const merges = r.chance(0.5);
    args.push(merges ? "--merges" : "--no-merges");
    steps.push((c) => c.setRevFilter(merges ? RevFilter.ONLY_MERGES : RevFilter.NO_MERGES));
  }
  return {
    revs,
    paths,
    args,
    configure: (c) => steps.reduce((acc, step) => step(acc), c),
  };
}

const SEEDS = [11, 23, 37, 41];
const COMMITS = 36;
const QUERIES = 70;

describeGit("log <revs> -- <pathspec> with exclusions against native git (fuzzed)", () => {
  let root: string;
  const env = () => nativeGitEnv(root);
  const gitIn = (
    dir: string,
    args: string[],
    extraEnv: Record<string, string> = {},
    input?: string,
  ) =>
    execFileSync("git", args, {
      cwd: dir,
      env: { ...env(), ...extraEnv },
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-range-fuzz-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** git 2.50 and later ask a root commit's filter (2.43 compares it without). */
  function rootFilters(): boolean {
    const m = /(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" }));
    return !!m && (Number(m[1]) > 2 || Number(m[2]) >= 50);
  }

  async function open(dir: string): Promise<Git> {
    const files = createNodeFilesApi({ rootDir: dir });
    const environment = createNodeGitHostEnvironment({ env: env() });
    const { history } = await createGitFilesBackend({ files });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
    return Git.fromWorkingCopy(await worktrees.openCurrent());
  }

  function build(seed: number): { dir: string; ids: string[]; dates: number[] } {
    const dir = join(root, `repo-${seed}`);
    execFileSync("git", ["init", "-q", "-b", "main", dir], { env: env() });
    const { stream, dates, count } = randomHistory(seed, COMMITS);
    const marks = join(root, `marks-${seed}`);
    gitIn(dir, ["fast-import", "--quiet", `--export-marks=${marks}`], {}, stream);
    const byMark = new Map<number, string>();
    for (const line of readFileSync(marks, "utf8").split("\n")) {
      const m = /^:(\d+) ([0-9a-f]{40})$/.exec(line);
      if (m) byMark.set(Number(m[1]), m[2] as string);
    }
    const ids: string[] = [];
    for (let mark = 1; mark <= count; mark++) ids.push(byMark.get(mark) as string);
    gitIn(dir, ["update-ref", "refs/heads/main", ids[ids.length - 1] as string]);
    gitIn(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    return { dir, ids, dates };
  }

  function nativeLog(dir: string, q: Query, extraEnv: Record<string, string> = {}): string[] {
    const revs = q.revs.map((r) => (r.exclude ? `^${r.id}` : r.id));
    return gitIn(dir, ["log", "--format=%H", ...q.args, ...revs, "--", ...q.paths], extraEnv)
      .split("\n")
      .filter(Boolean);
  }

  function nativeBloom(dir: string, q: Query) {
    const trace = join(root, "trace2.json");
    rmSync(trace, { force: true });
    nativeLog(dir, q, { GIT_TRACE2_EVENT: trace });
    const line = readFileSync(trace, "utf8")
      .split("\n")
      .find((l) => l.includes('"category":"bloom"') && l.includes('"key":"statistics"'));
    const value = line ? JSON.parse(line).value : undefined;
    return typeof value === "string" ? JSON.parse(value) : value;
  }

  async function ourLog(git: Git, q: Query, bloom = true) {
    let command = git.log();
    for (const r of q.revs) command = r.exclude ? command.not(r.id) : command.add(r.id);
    for (const p of q.paths) {
      if (p.startsWith(":!")) command = command.excludePath(p.slice(2));
      else if (p.startsWith(":(exclude)")) command = command.excludePath(p.slice(10));
      else command = command.addPath(p);
    }
    command = q.configure(command).setUseBloomFilters(bloom);
    const ids: string[] = [];
    for await (const c of await command.call()) ids.push(c.id);
    return { ids, command };
  }

  const describeQuery = (q: Query, ids: string[]) =>
    [
      ...q.args,
      ...q.revs.map((r) => `${r.exclude ? "^" : ""}c${ids.indexOf(r.id) + 1}`),
      "--",
      ...q.paths,
    ].join(" ");

  for (const seed of SEEDS) {
    it(`seed ${seed}: the same commits as git, without and with changed-path filters`, async () => {
      const { dir, ids, dates } = build(seed);
      const r = rng(seed * 7919);
      const queries = Array.from({ length: QUERIES }, () => randomQuery(r, ids, dates));

      let git = await open(dir);
      for (const q of queries) {
        const theirs = nativeLog(dir, q);
        const { ids: mine } = await ourLog(git, q);
        expect([describeQuery(q, ids), mine]).toEqual([describeQuery(q, ids), theirs]);
      }

      gitIn(dir, ["commit-graph", "write", "--reachable", "--changed-paths"]);
      git = await open(dir);
      const exact = rootFilters();
      for (const q of queries) {
        const theirs = nativeLog(dir, q);
        const { ids: mine, command } = await ourLog(git, q);
        const label = describeQuery(q, ids);
        expect([label, mine]).toEqual([label, theirs]);
        const { ids: without } = await ourLog(git, q, false);
        expect([label, without]).toEqual([label, theirs]);
        const n = nativeBloom(dir, q);
        const s = command.getStatistics();
        if (!n && !exact) {
          // git before 2.50 asks the filters for one literal path only
        } else if (!n) {
          // no filter asked (exclusions, or a pathspec without a literal directory)
          expect([label, s.bloomMaybe + s.bloomDefinitelyNot + s.bloomNotPresent]).toEqual([
            label,
            0,
          ]);
        } else if (exact) {
          expect([label, s.bloomNotPresent, s.bloomMaybe, s.bloomDefinitelyNot]).toEqual([
            label,
            n.filter_not_present,
            n.maybe,
            n.definitely_not,
          ]);
          expect([label, s.bloomFalsePositive]).toEqual([label, n.false_positive]);
        } else {
          // git before 2.50 compares a root commit with the empty tree without its filter
          expect([label, s.bloomNotPresent]).toEqual([label, n.filter_not_present]);
          const extra = s.bloomMaybe + s.bloomDefinitelyNot - n.maybe - n.definitely_not;
          expect([label, extra >= 0]).toEqual([label, true]);
        }
      }
    }, 120_000);
  }
});

/** Pathspec forms that cannot use the changed-path filters, or name entries by pattern. */
const PATHSPEC_FORMS: string[][] = [
  [":(icase)D/X"],
  [":(icase)A"],
  [":(glob)d/**"],
  [":(glob)**/z"],
  [":(glob)d/*"],
  [":(literal)d/*"],
  [":(literal)d/x"],
  ["**/z"],
  ["d/?"],
  ["d/[xy]"],
  ["[ab]"],
  [":(icase,glob)D/*"],
  ["d", ":!d/y"],
  [":(exclude)a"],
  [":^b", "d"],
  [":!d/e/*"],
];

describeGit("log <revs> [-- <pathspec forms>] against native git (fuzzed)", () => {
  let root: string;
  const env = () => nativeGitEnv(root);
  const gitIn = (dir: string, args: string[], input?: string) =>
    execFileSync("git", args, {
      cwd: dir,
      env: env(),
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-plain-fuzz-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function open(dir: string): Promise<Git> {
    const files = createNodeFilesApi({ rootDir: dir });
    const environment = createNodeGitHostEnvironment({ env: env() });
    const { history } = await createGitFilesBackend({ files });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
    return Git.fromWorkingCopy(await worktrees.openCurrent());
  }

  function build(seed: number): { dir: string; ids: string[]; dates: number[] } {
    const dir = join(root, `repo-${seed}`);
    execFileSync("git", ["init", "-q", "-b", "main", dir], { env: env() });
    const { stream, dates, count } = randomHistory(seed, COMMITS);
    const marks = join(root, `marks-${seed}`);
    gitIn(dir, ["fast-import", "--quiet", `--export-marks=${marks}`], stream);
    const byMark = new Map<number, string>();
    for (const line of readFileSync(marks, "utf8").split("\n")) {
      const m = /^:(\d+) ([0-9a-f]{40})$/.exec(line);
      if (m) byMark.set(Number(m[1]), m[2] as string);
    }
    const ids: string[] = [];
    for (let mark = 1; mark <= count; mark++) ids.push(byMark.get(mark) as string);
    gitIn(dir, ["update-ref", "refs/heads/main", ids[ids.length - 1] as string]);
    gitIn(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    return { dir, ids, dates };
  }

  /** A query of the fuzz above, with its pathspec replaced (none: a plain `git log`). */
  function variant(r: ReturnType<typeof rng>, ids: string[], dates: number[], plain: boolean) {
    const q = randomQuery(r, ids, dates);
    // half of the plain queries stream (no excluded commit)
    if (plain && r.chance(0.5)) q.revs = q.revs.filter((x) => !x.exclude);
    if (q.revs.every((x) => x.exclude)) q.revs.push({ id: r.pick(ids), exclude: false });
    q.paths = plain ? [] : r.pick(PATHSPEC_FORMS);
    return q;
  }

  function nativeLog(dir: string, q: Query): string[] {
    const revs = q.revs.map((x) => (x.exclude ? `^${x.id}` : x.id));
    const paths = q.paths.length > 0 ? ["--", ...q.paths] : [];
    return gitIn(dir, ["log", "--format=%H", ...q.args, ...revs, ...paths])
      .split("\n")
      .filter(Boolean);
  }

  async function ourLog(git: Git, q: Query): Promise<string[]> {
    let command = git.log();
    for (const x of q.revs) command = x.exclude ? command.not(x.id) : command.add(x.id);
    // every form through addPath, `:!` and `:(exclude)` included
    for (const p of q.paths) command = command.addPath(p);
    command = q.configure(command);
    const out: string[] = [];
    for await (const c of await command.call()) out.push(c.id);
    return out;
  }

  const label = (q: Query, ids: string[]) =>
    [
      ...q.args,
      ...q.revs.map((x) => `${x.exclude ? "^" : ""}c${ids.indexOf(x.id) + 1}`),
      ...(q.paths.length > 0 ? ["--", ...q.paths] : []),
    ].join(" ");

  for (const seed of SEEDS) {
    it(`seed ${seed}: plain and pattern-limited logs list git's commits in git's order`, async () => {
      const { dir, ids, dates } = build(seed);
      const r = rng(seed * 104729);
      const queries = [
        ...Array.from({ length: 40 }, () => variant(r, ids, dates, true)),
        ...Array.from({ length: 40 }, () => variant(r, ids, dates, false)),
      ];
      for (const graph of [false, true]) {
        if (graph) gitIn(dir, ["commit-graph", "write", "--reachable", "--changed-paths"]);
        const git = await open(dir);
        for (const q of queries) {
          const theirs = nativeLog(dir, q);
          const mine = await ourLog(git, q);
          expect([graph, label(q, ids), mine]).toEqual([graph, label(q, ids), theirs]);
        }
      }
    }, 120_000);
  }
});

/** `:(attr:...)` and `:(prefix:N)` elements, matched against the worktree's attributes. */
const ATTR_FORMS: string[][] = [
  [":(attr:text)"],
  [":(attr:-text)"],
  [":(attr:!text)"],
  [":(attr:foo=bar)"],
  [":(attr:foo=nested)d"],
  [":(attr:foo=baz)"],
  [":(attr:diff=c)"],
  [":(attr:eol=lf -text)d"],
  [":(attr:!foo)"],
  [":(glob,attr:foo)**/x"],
  [":(attr:text)", ":(attr:foo=bar)"],
  ["d", ":(exclude,attr:foo=bar)"],
  [":(attr:!foo eol=lf)", ":!b"],
  [":(prefix:2)d/x"],
  [":(prefix:2)d/*"],
  [":(prefix:1)d*"],
  [":(prefix:0)*/z"],
];

const ATTRIBUTES = [
  "a text",
  "d/* -text foo=bar",
  "d/e/** diff=c",
  "p/q !text foo=baz",
  "* eol=lf",
  "",
].join("\n");

describeGit("log -- :(attr:...) / :(prefix:N) against native git (fuzzed)", () => {
  let root: string;
  const env = () => nativeGitEnv(root);
  const gitIn = (dir: string, args: string[], input?: string) =>
    execFileSync("git", args, {
      cwd: dir,
      env: env(),
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-attr-fuzz-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  for (const seed of SEEDS.slice(0, 2)) {
    it(`seed ${seed}: attribute and prefix magic selects git's commits`, async () => {
      const dir = join(root, `repo-${seed}`);
      execFileSync("git", ["init", "-q", "-b", "main", dir], { env: env() });
      const { stream, dates, count } = randomHistory(seed, COMMITS);
      const marks = join(root, `marks-${seed}`);
      gitIn(dir, ["fast-import", "--quiet", `--export-marks=${marks}`], stream);
      const byMark = new Map<number, string>();
      for (const line of readFileSync(marks, "utf8").split("\n")) {
        const m = /^:(\d+) ([0-9a-f]{40})$/.exec(line);
        if (m) byMark.set(Number(m[1]), m[2] as string);
      }
      const ids: string[] = [];
      for (let mark = 1; mark <= count; mark++) ids.push(byMark.get(mark) as string);
      gitIn(dir, ["update-ref", "refs/heads/main", ids[ids.length - 1] as string]);
      gitIn(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      // the worktree's attributes (not committed): what git's match_pathspec_attrs reads
      writeFileSync(join(dir, ".gitattributes"), ATTRIBUTES);
      mkdirSync(join(dir, "d"), { recursive: true });
      writeFileSync(join(dir, "d", ".gitattributes"), "x foo=nested\n");

      const files = createNodeFilesApi({ rootDir: dir });
      const environment = createNodeGitHostEnvironment({ env: env() });
      const { history } = await createGitFilesBackend({ files });
      const worktrees = await openGitLinkedWorktrees({
        files,
        gitDir: ".git",
        history,
        environment,
      });
      const git = Git.fromWorkingCopy(await worktrees.openCurrent());
      const r = rng(seed * 15485863);
      for (let i = 0; i < 50; i++) {
        const q = randomQuery(r, ids, dates);
        // most without excluded commits: longer lists
        if (r.chance(0.6)) q.revs = q.revs.filter((x) => !x.exclude);
        if (q.revs.every((x) => x.exclude)) q.revs.push({ id: r.pick(ids), exclude: false });
        q.paths = r.pick(ATTR_FORMS);
        const revs = q.revs.map((x) => (x.exclude ? `^${x.id}` : x.id));
        const theirs = gitIn(dir, ["log", "--format=%H", ...q.args, ...revs, "--", ...q.paths])
          .split("\n")
          .filter(Boolean);
        let command = git.log();
        for (const x of q.revs) command = x.exclude ? command.not(x.id) : command.add(x.id);
        for (const p of q.paths) command = command.addPath(p);
        const mine: string[] = [];
        for await (const c of await q.configure(command).call()) mine.push(c.id);
        const label = [...q.args, ...q.paths].join(" ");
        expect([label, mine]).toEqual([label, theirs]);
      }
    }, 120_000);
  }
});

describeGit("log keeps a few dozen bytes per commit it walks", () => {
  let root: string;
  const env = () => nativeGitEnv(root);
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-table-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("a 3000-commit history: git's order, and the walk's table stays compact", async () => {
    const dir = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", dir], { env: env() });
    const out: string[] = [];
    for (let i = 1; i <= 3000; i++) {
      const t = 1500000000 + i * 60 - (i % 7 === 0 ? 500 : 0); // some clock skew
      out.push(`commit refs/heads/main\nmark :${i}\n`);
      out.push(`committer C O Mitter <c@example.com> ${t} +0000\n`);
      out.push(`data 4\nc${String(i % 100).padStart(2, "0")}\n`);
      if (i > 1) out.push(`from :${i - 1}\n`);
      out.push(`M 100644 inline f${i % 13}\ndata 5\nv${String(i).padStart(4, "0")}\n\n`);
    }
    execFileSync("git", ["fast-import", "--quiet"], { cwd: dir, env: env(), input: out.join("") });
    for (const graph of [false, true]) {
      if (graph) {
        execFileSync("git", ["commit-graph", "write", "--reachable"], { cwd: dir, env: env() });
      }
      const files = createNodeFilesApi({ rootDir: dir });
      const environment = createNodeGitHostEnvironment({ env: env() });
      const { history } = await createGitFilesBackend({ files });
      const worktrees = await openGitLinkedWorktrees({
        files,
        gitDir: ".git",
        history,
        environment,
      });
      const git = Git.fromWorkingCopy(await worktrees.openCurrent());
      for (const paths of [[], ["f3"]]) {
        const theirs = execFileSync("git", ["log", "--format=%H", "--", ...paths], {
          cwd: dir,
          env: env(),
          encoding: "utf8",
          maxBuffer: 1 << 26,
        })
          .split("\n")
          .filter(Boolean);
        const command = git.log();
        for (const p of paths) command.addPath(p);
        const mine: string[] = [];
        for await (const c of await command.call()) mine.push(c.id);
        expect([graph, paths, mine]).toEqual([graph, paths, theirs]);
        const s = command.getStatistics();
        expect(s.commitsWalked).toBe(3000);
        // typed arrays grown by doubling (and one slot per graph commit): no object per commit
        expect((s.walkTableBytes as number) / 3000).toBeLessThan(48);
      }
    }
  }, 120_000);
});

/**
 * Paths whose bytes matter: two directories that differ in case only, a non-ASCII directory
 * and names (two bytes per "Ä"), and names that are no UTF-8 (raw bytes 0xfe and 0xff).
 */
const BYTE_FILES: Uint8Array[] = ["a", "d/x", "D/X", "Ä/x", "Ä/y", "Äb", "q/r", "bad1"].map((p) =>
  new TextEncoder().encode(p),
);
BYTE_FILES.push(Uint8Array.of(0x6e, 0xff, 0x78), Uint8Array.of(0x6e, 0xfe, 0x78));

/** A path in a fast-import stream: quoted, every byte outside printable ASCII in octal. */
function quoteFastImportPath(bytes: Uint8Array): string {
  let out = '"';
  for (const b of bytes) {
    if (b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c) out += String.fromCharCode(b);
    else out += `\\${b.toString(8).padStart(3, "0")}`;
  }
  return `${out}"`;
}

/** A random history over {@link BYTE_FILES} (each commit states its whole tree). */
function randomByteHistory(seed: number, count: number): string {
  const r = rng(seed);
  const out: string[] = [];
  const trees: Map<number, string>[] = [new Map()];
  let time = 1500000000;
  const data = (s: string) => out.push(`data ${Buffer.byteLength(s)}\n${s}\n`);
  for (let mark = 1; mark <= count; mark++) {
    const parents: number[] = [];
    if (mark > 1) {
      parents.push(r.chance(0.7) ? mark - 1 : 1 + r.int(mark - 1));
      if (mark > 3 && r.chance(0.25)) {
        const second = 1 + r.int(mark - 1);
        if (second !== parents[0]) parents.push(second);
      }
    }
    const tree = new Map(trees[parents[0] ?? 0] as Map<number, string>);
    if (parents.length > 1 && r.chance(0.5)) {
      for (const [f, v] of trees[parents[1] as number] as Map<number, string>) {
        if (r.chance(0.5)) tree.set(f, v);
      }
    }
    const changes = 1 + r.int(2);
    for (let i = 0; i < changes; i++) {
      const f = r.int(BYTE_FILES.length);
      if (tree.has(f) && r.chance(0.15)) tree.delete(f);
      else tree.set(f, `${f} ${mark} ${i}\n`);
    }
    trees.push(tree);
    time += r.chance(0.2) ? -(50 + r.int(300)) : 10 + r.int(100);
    out.push(`commit refs/heads/main\nmark :${mark}\n`);
    out.push(`committer C O Mitter <c@example.com> ${time} +0000\n`);
    data(`commit ${mark}\n`);
    if (parents.length > 0) out.push(`from :${parents[0]}\n`);
    if (parents.length > 1) out.push(`merge :${parents[1]}\n`);
    out.push("deleteall\n");
    for (const [f, content] of tree) {
      out.push(`M 100644 inline ${quoteFastImportPath(BYTE_FILES[f] as Uint8Array)}\n`);
      data(content);
    }
    out.push("\n");
  }
  return out.join("");
}

/**
 * Attribute magic with the root `.gitattributes` only in the index (git log reads no index:
 * those rules do not count), the worktree's `d/.gitattributes`, `info/attributes`,
 * `core.attributesFile` and names that are no UTF-8; `:(icase,prefix:N)` (the prefix stays
 * case-sensitive) and `:(prefix:N)` counting bytes, also inside a character.
 */
const BYTE_FORMS: string[][] = [
  [":(attr:foo)"],
  [":(attr:!foo)"],
  [":(attr:-foo)"],
  [":(attr:foo=v)"],
  [":(attr:foo=w)"],
  [":(attr:binary)"],
  [":(attr:-text)"],
  [":(attr:info)"],
  [":(attr:glob)"],
  [":(attr:raw=ff)"],
  [":(attr:raw=fe)"],
  [":(attr:!raw)"],
  ["Ä", ":(exclude,attr:info)"],
  [":(icase,prefix:2)D/x"],
  [":(icase,prefix:2)d/X"],
  [":(icase,prefix:1)D/x"],
  [":(icase,prefix:0)D/x"],
  [":(icase)D/x"],
  [":(icase,prefix:2)D/*"],
  [":(icase,prefix:1)d*"],
  [":(prefix:3)Ä/*"],
  [":(prefix:2)Ä/*"],
  [":(prefix:1)Ä*"],
  [":(prefix:1)Äb"],
  [":(prefix:3)Ä/x"],
  [":(prefix:4)Ä/x"],
  [":(icase,prefix:1)Ä/X"],
  [":(icase,prefix:3)Ä/X"],
  [":(prefix:)Ä/y"],
  [":(prefix:-1)Ä/./y"],
  [":(prefix:+2)d/x"],
  [":(prefix: 2)D/X"],
  // strtol's long, kept as an int: 2^32 + 2 is 2, LONG_MIN is 0
  [":(prefix:4294967298)d/x"],
  [":(prefix:-99999999999999999999)d/x"],
];

describeGit("log -- :(attr) / :(icase,prefix) / multibyte :(prefix) against native git", () => {
  let root: string;
  const env = () => nativeGitEnv(root);
  const gitIn = (dir: string, args: string[], input?: string | Buffer) =>
    execFileSync("git", args, {
      cwd: dir,
      env: env(),
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-byte-fuzz-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  for (const seed of SEEDS.slice(0, 2)) {
    it(`seed ${seed}: index-only attributes, icase prefixes and byte prefixes as git`, async () => {
      const dir = join(root, `repo-${seed}`);
      execFileSync("git", ["init", "-q", "-b", "main", dir], { env: env() });
      gitIn(dir, ["fast-import", "--quiet"], randomByteHistory(seed, COMMITS));
      gitIn(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
      // the root .gitattributes staged only: git log does not read the index
      const staged = gitIn(
        dir,
        ["hash-object", "-w", "--stdin"],
        "d/* foo\nÄ/* foo=v\nbad* foo=w\nq/* binary\n",
      ).trim();
      gitIn(dir, ["update-index", "--add", "--cacheinfo", `100644,${staged},.gitattributes`]);
      mkdirSync(join(dir, "d"), { recursive: true });
      writeFileSync(join(dir, "d", ".gitattributes"), "x -foo\n");
      writeFileSync(join(root, `global-${seed}`), "D/* glob\n");
      gitIn(dir, ["config", "core.attributesFile", join(root, `global-${seed}`)]);
      // a rule per raw name (decoded to U+FFFD the two would be one name)
      mkdirSync(join(dir, ".git", "info"), { recursive: true });
      writeFileSync(
        join(dir, ".git", "info", "attributes"),
        Buffer.concat([
          Buffer.from("Äb info\nq/r -text\n"),
          Buffer.from([0x6e, 0xff, 0x78]),
          Buffer.from(" raw=ff\n"),
          Buffer.from([0x6e, 0xfe, 0x78]),
          Buffer.from(" raw=fe\n"),
        ]),
      );
      const ids = gitIn(dir, ["rev-list", "--all"]).split("\n").filter(Boolean);

      for (const graph of [false, true]) {
        if (graph) gitIn(dir, ["commit-graph", "write", "--reachable", "--changed-paths"]);
        const files = createNodeFilesApi({ rootDir: dir });
        const environment = createNodeGitHostEnvironment({ env: env() });
        const { history } = await createGitFilesBackend({ files });
        const worktrees = await openGitLinkedWorktrees({
          files,
          gitDir: ".git",
          history,
          environment,
        });
        const git = Git.fromWorkingCopy(await worktrees.openCurrent());
        const r = rng(seed * 7919 + (graph ? 1 : 0));
        const queries: string[][] = [...BYTE_FORMS];
        for (let i = 0; i < 20; i++) queries.push(r.pick(BYTE_FORMS));
        for (const paths of queries) {
          const revs = r.chance(0.5) ? ["--all"] : [r.pick(ids)];
          const args: string[] = [];
          const firstParent = r.chance(0.2);
          if (firstParent) args.push("--first-parent");
          const max = r.chance(0.2) ? 1 + r.int(4) : undefined;
          if (max !== undefined) args.push(`--max-count=${max}`);
          const theirs = gitIn(dir, ["log", "--format=%H", ...args, ...revs, "--", ...paths])
            .split("\n")
            .filter(Boolean);
          let command = git.log();
          if (revs[0] === "--all") command = command.all();
          else command = command.add(revs[0] as string);
          for (const p of paths) command = command.addPath(p);
          if (firstParent) command = command.setFirstParent(true);
          if (max !== undefined) command = command.setMaxCount(max);
          const mine: string[] = [];
          for await (const c of await command.call()) mine.push(c.id);
          const label = [graph, ...args, ...paths].join(" ");
          expect([label, mine]).toEqual([label, theirs]);
        }
      }
    }, 120_000);
  }
});

describeGit("log -- :(attr) in a bare repository reads no in-tree attributes (git 2.56)", () => {
  let root: string;
  const env = () => nativeGitEnv(root);
  const gitIn = (dir: string, args: string[], input?: string) =>
    execFileSync("git", args, { cwd: dir, env: env(), encoding: "utf8", input });
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-attr-bare-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("only builtin, global and info/attributes count; HEAD's .gitattributes does not", async () => {
    const work = join(root, "work");
    const bare = join(root, "bare.git");
    execFileSync("git", ["init", "-q", "-b", "main", work], { env: env() });
    writeFileSync(join(work, ".gitattributes"), "x foo\n");
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(work, i % 2 ? "x" : "y"), `${i}\n`);
      gitIn(work, ["add", "-A"]);
      gitIn(work, ["commit", "-q", "-m", `c${i}`]);
    }
    execFileSync("git", ["clone", "-q", "--bare", work, bare], { env: env() });
    mkdirSync(join(bare, "info"), { recursive: true });
    writeFileSync(join(bare, "info", "attributes"), "y foo\n");

    const files = createNodeFilesApi({ rootDir: bare });
    const environment = createNodeGitHostEnvironment({ env: env() });
    const { history } = await createGitFilesBackend({ files, gitDir: "." });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".", history, environment });
    const git = Git.fromWorktreeAdmin(await worktrees.openAdmin());
    const ours = async (paths: string[]) => {
      let command = git.log();
      for (const p of paths) command = command.addPath(p);
      const out: string[] = [];
      for await (const c of await command.call()) out.push(c.id);
      return out;
    };
    const log = (paths: string[]) =>
      gitIn(bare, ["log", "--format=%H", "--", ...paths])
        .split("\n")
        .filter(Boolean);
    // git 2.56 (attr.tree unset): what info/attributes names, as `log -- y` lists it
    expect(await ours([":(attr:foo)"])).toEqual(log(["y"]));
    expect(await ours([":(attr:!foo)"])).toEqual(log(["x", ".gitattributes"]));
    const version = /(\d+)\.(\d+)/.exec(gitIn(root, ["--version"])) ?? [];
    // git 2.43 still read HEAD's attributes in a bare repository
    if (Number(version[1]) > 2 || Number(version[2]) >= 50) {
      for (const paths of [[":(attr:foo)"], [":(attr:!foo)"], [":(attr:-foo)"]]) {
        expect(await ours(paths)).toEqual(log(paths));
      }
    }
  });
});

describeGit("log -- :(prefix:<n>) refuses what git refuses", () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-prefix-bad-"));
    execFileSync("git", ["init", "-q", "-b", "main", root], { env: nativeGitEnv(root) });
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "c"], {
      cwd: root,
      env: nativeGitEnv(root),
    });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it.each([":(prefix:abc)a", ":(prefix: )a", ":(prefix:2x)a", ":(prefix:+)a"])(
    "%s: invalid parameter for pathspec magic 'prefix'",
    async (spec) => {
      let stderr = "";
      try {
        execFileSync("git", ["log", "--", spec], {
          cwd: root,
          env: nativeGitEnv(root),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        stderr = String((e as { stderr?: Buffer }).stderr);
      }
      expect(stderr).toContain("invalid parameter for pathspec magic 'prefix'");
      const files = createNodeFilesApi({ rootDir: root });
      const { history } = await createGitFilesBackend({ files });
      const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history });
      const git = Git.fromWorkingCopy(await worktrees.openCurrent());
      await expect(
        (async () => {
          for await (const _ of await git.log().addPath(spec).call()) {
            // nothing: the pathspec is refused first
          }
        })(),
      ).rejects.toThrow("invalid parameter for pathspec magic 'prefix'");
    },
  );
});
