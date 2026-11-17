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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
