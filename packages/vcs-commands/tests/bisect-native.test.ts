/**
 * `git bisect` against native git. Native twins: each history built twice by native git
 * (pinned identities and dates, so both have the same commit ids), native `git bisect`
 * run in one, ours in the other, step by step with the same answers; after each step the
 * exit status, stdout, `refs/bisect/*`, every `BISECT_*` file, HEAD and its reflog are
 * compared. Histories are random (linear, merges, criss-cross merges, several roots), as
 * are the bad and good commits, the first bad commit and the commits that cannot be tested.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type BisectResult,
  estimateBisectSteps,
  type LogOutputOptions,
  skipAwayIndex,
  sqDequoteToArgv,
  sqQuoteArgv,
  strbufRtrim,
  strbufTrim,
} from "../src/index.js";
import { gitOk, openOurs, put } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bisect-native-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** git 2.5x (quoted terms in the messages, no "We are not bisecting." without a start). */
function modern(): boolean {
  const version = gitOk(root, root, "--version").match(/(\d+)\.(\d+)/);
  return !!version && (Number(version[1]) > 2 || Number(version[2]) >= 50);
}

/** git 2.56 or later (`status.compareBranches`). */
function atLeast256(): boolean {
  const version = gitOk(root, root, "--version").match(/(\d+)\.(\d+)/);
  return !!version && (Number(version[1]) > 2 || Number(version[2]) >= 56);
}

/** Native git with extra environment. */
function run(
  dir: string,
  args: string[],
  extra: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd: dir,
    env: { ...nativeGitEnv(root), GIT_EDITOR: "true", ...extra },
  });
  // decoded as ours is: bytes that are no UTF-8 as lone surrogates
  const text = (bytes: Buffer | null) => (bytes ? decodeGitPath(new Uint8Array(bytes)) : "");
  return { status: r.status ?? 1, stdout: text(r.stdout), stderr: text(r.stderr) };
}

function ok(dir: string, args: string[], extra: Record<string, string> = {}): string {
  const r = run(dir, args, extra);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface HistoryShape {
  commits: number;
  merges: boolean;
  roots: boolean;
  criss: boolean;
}

/**
 * A random history built by native git in `dir`: commits adding (and sometimes deleting)
 * files under `src/` and `doc/`, branches, merges (criss-cross ones), other roots. The
 * same seed builds the same commits in another directory.
 */
function buildHistory(dir: string, seed: number, shape: HistoryShape): void {
  const rnd = mulberry32(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(rnd() * items.length)] as T;
  ok(root, ["init", "-q", "-b", "main", dir]);
  let time = 1_300_000_000;
  let n = 0;
  const dated = () => {
    time += 60 + Math.floor(rnd() * 3) * 60;
    return { GIT_AUTHOR_DATE: `${time} +0000`, GIT_COMMITTER_DATE: `${time} +0000` };
  };
  const files = new Map<string, string[]>();
  const branches = ["main"];
  let current = "main";
  files.set("main", []);
  const commit = () => {
    n++;
    const own = files.get(current) as string[];
    const area = rnd() < 0.5 ? "src" : "doc";
    const name = `${area}/f${n}.txt`;
    put(dir, name, `line ${n}\nmore ${n} of ${seed}\n`);
    own.push(name);
    if (own.length > 3 && rnd() < 0.2) {
      const gone = own.splice(Math.floor(rnd() * (own.length - 1)), 1)[0] as string;
      ok(dir, ["rm", "-q", gone]);
    }
    ok(dir, ["add", "-A"]);
    const body = rnd() < 0.3 ? `\n\nbody of ${n}\n\twith a tab` : "";
    ok(dir, ["commit", "-q", "-m", `commit ${n}${body}`], dated());
  };
  commit();
  let rootsMade = 0;
  for (let step = 1; step < shape.commits; step++) {
    const r = rnd();
    if (shape.merges && r < 0.15 && branches.length < 5) {
      const name = `b${branches.length}`;
      ok(dir, ["checkout", "-q", "-b", name]);
      files.set(name, [...(files.get(current) as string[])]);
      branches.push(name);
      current = name;
      commit();
    } else if (shape.merges && r < 0.3 && branches.length > 1) {
      const other = pick(branches.filter((b) => b !== current));
      const res = run(
        dir,
        ["merge", "-q", "--no-ff", "--no-edit", "-m", `merge ${other} into ${current}`, other],
        dated(),
      );
      if (res.status !== 0) throw new Error(res.stdout + res.stderr);
      const mine = files.get(current) as string[];
      for (const f of files.get(other) as string[]) {
        if (existsSync(join(dir, f)) && !mine.includes(f)) mine.push(f);
      }
      for (let k = mine.length - 1; k >= 0; k--)
        if (!existsSync(join(dir, mine[k] as string))) mine.splice(k, 1);
      if (shape.criss && rnd() < 0.5) {
        // the other way round from the same tips: a criss-cross
        const mergedTip = ok(dir, ["rev-parse", "HEAD^1"]).trim();
        const otherTip = ok(dir, ["rev-parse", other]).trim();
        ok(dir, ["checkout", "-q", other]);
        const res2 = run(
          dir,
          [
            "merge",
            "-q",
            "--no-ff",
            "--no-edit",
            "-m",
            `criss ${current} into ${other}`,
            mergedTip,
          ],
          dated(),
        );
        if (res2.status !== 0) throw new Error(res2.stdout + res2.stderr);
        void otherTip;
        files.set(other, [...mine]);
        ok(dir, ["checkout", "-q", current]);
      }
    } else if (shape.merges && r < 0.4 && branches.length > 1) {
      current = pick(branches);
      ok(dir, ["checkout", "-q", current]);
    } else if (shape.roots && rootsMade < 2 && r < 0.45) {
      rootsMade++;
      const name = `root${rootsMade}`;
      ok(dir, ["checkout", "-q", "--orphan", name]);
      ok(dir, ["rm", "-rq", "--cached", "."]);
      for (const f of files.get(current) as string[]) rmSync(join(dir, f), { force: true });
      files.set(name, []);
      branches.push(name);
      current = name;
      commit();
      commit();
      ok(dir, ["checkout", "-q", "main"]);
      const res = run(
        dir,
        [
          "merge",
          "-q",
          "--no-ff",
          "--no-edit",
          "--allow-unrelated-histories",
          "-m",
          `merge ${name}`,
          name,
        ],
        dated(),
      );
      if (res.status !== 0) throw new Error(res.stdout + res.stderr);
      const mine = files.get("main") as string[];
      mine.push(...(files.get(name) as string[]));
      current = "main";
    } else {
      commit();
    }
  }
  if (current !== "main") ok(dir, ["checkout", "-q", "main"]);
  // everything on main: the last tip of every branch merged
  for (const b of branches) {
    if (b === "main") continue;
    const merged = run(dir, ["merge-base", "--is-ancestor", b, "main"]).status === 0;
    if (!merged) {
      const res = run(
        dir,
        [
          "merge",
          "-q",
          "--no-ff",
          "--no-edit",
          "--allow-unrelated-histories",
          "-m",
          `final ${b}`,
          b,
        ],
        dated(),
      );
      if (res.status !== 0) throw new Error(res.stdout + res.stderr);
    }
  }
}

/** Twins of one random history. */
function twins(seed: number, shape: HistoryShape): { a: string; b: string } {
  const a = join(root, `t${++counter}-a`);
  const b = join(root, `t${counter}-b`);
  buildHistory(a, seed, shape);
  buildHistory(b, seed, shape);
  expect(ok(b, ["rev-parse", "HEAD"])).toBe(ok(a, ["rev-parse", "HEAD"]));
  return { a, b };
}

const BISECT_FILES = [
  "BISECT_START",
  "BISECT_LOG",
  "BISECT_TERMS",
  "BISECT_NAMES",
  "BISECT_EXPECTED_REV",
  "BISECT_ANCESTORS_OK",
  "BISECT_FIRST_PARENT",
  "BISECT_HEAD",
  "BISECT_RUN",
];

/**
 * 2.43's messages without the quotes 2.5x puts around the terms; its status lines (always
 * "good" and "bad") and its `git show` of the first bad commit (made in process: no
 * renames, other merge diffs) left out.
 */
function canon(text: string, terms: string[]): string {
  if (modern()) return text;
  let out = text;
  for (const t of terms) out = out.replaceAll(`'${t}'`, t);
  out = out.replace(/^(# )?status: waiting for .*$/gm, "$1status: <waiting>");
  out = out.replace(
    // (2.43's diff-tree shows nothing for a commit without parents)
    /( is the first \S+ commit\n)(commit [0-9a-f]{40}\n(.*\n)*?)?(?=bisect found|$)/g,
    "$1<show>\n",
  );
  return out;
}

/** Stderr as compared: the usage git prints differs by version. */
function bisectStderr(text: string): string {
  return modern() ? text : text.replace(/\nusage: [\s\S]*$/, "\n");
}

/** What is compared between the twins after each step. */
function stateOf(dir: string, terms: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const gitDir = join(dir, ".git");
  for (const name of BISECT_FILES) {
    const path = join(gitDir, name);
    if (existsSync(path)) out[name] = canon(readFileSync(path, "utf8"), terms);
  }
  out.refs = ok(dir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/bisect/"]);
  const symbolic = run(dir, ["symbolic-ref", "-q", "HEAD"]).stdout.trim();
  out.head = `${symbolic || "detached"} ${ok(dir, ["rev-parse", "HEAD"]).trim()}`;
  out.reflog = readFileSync(join(gitDir, "logs", "HEAD"), "utf8");
  const logs: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(gitDir, "logs", rel), { withFileTypes: true })) {
      const sub = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(sub);
      else logs.push(sub);
    }
  };
  if (existsSync(join(gitDir, "logs", "refs"))) walk("refs");
  logs.sort();
  out.logs = logs.join("\n");
  out.status = ok(dir, ["status", "--porcelain=v2", "-uall"]);
  return out;
}

const ourEnv = () => createNodeGitHostEnvironment({ env: nativeGitEnv(root) });

/** One `git bisect <args>` in both twins, compared; native git's result. */
async function step(
  a: string,
  b: string,
  args: string[],
  terms: string[],
  options: {
    configure?: (cmd: ReturnType<Awaited<ReturnType<typeof openOurs>>["bisect"]>) => void;
    compareStderr?: boolean;
    /** extra environment, for both */
    env?: Record<string, string>;
  } = {},
): Promise<{ native: { status: number; stdout: string; stderr: string }; ours: BisectResult }> {
  const native = run(a, ["bisect", ...args], options.env);
  // 2.43's replay reset first (printing "We are not bisecting." without a bisection)
  if ((args[0] === "replay" || (args[0] === "reset" && args.length === 1)) && !modern())
    native.stdout = native.stdout.replace(/^We are not bisecting\.\n/, "");
  const git = await openOurs(
    b,
    options.env
      ? createNodeGitHostEnvironment({ env: { ...nativeGitEnv(root), ...options.env } })
      : ourEnv(),
  );
  const cmd = git.bisect().setArguments(args);
  options.configure?.(cmd);
  const ours = await cmd.call();
  const where = `git bisect ${args.join(" ")}`;
  expect(
    canon(ours.stdout, terms),
    `${where}\n${ours.stderr}\n--- native stderr\n${native.stderr}`,
  ).toBe(canon(native.stdout, terms));
  expect(ours.exitCode, `${where}: ${ours.stderr} / ${native.stderr}`).toBe(native.status);
  if (options.compareStderr ?? true) {
    expect(bisectStderr(canon(ours.stderr, terms))).toBe(bisectStderr(canon(native.stderr, terms)));
  }
  expect(stateOf(b, terms), where).toEqual(stateOf(a, terms));
  return { native, ours };
}

/** Whether `ancestor` is reachable from `id` (or is it). */
function reaches(dir: string, ancestor: string, id: string): boolean {
  return run(dir, ["merge-base", "--is-ancestor", ancestor, id]).status === 0;
}

function allCommits(dir: string): string[] {
  return ok(dir, ["rev-list", "--all"]).trim().split("\n");
}

/** The commit under test: HEAD, or BISECT_HEAD with --no-checkout. */
function underTest(dir: string): string {
  const head = run(dir, ["rev-parse", "-q", "--verify", "BISECT_HEAD"]);
  return (head.status === 0 ? head.stdout : ok(dir, ["rev-parse", "HEAD"])).trim();
}

const CANDIDATE = /^\[[0-9a-f]{40}\] /m;

interface SessionPlan {
  start: string[];
  culprit: string;
  untestable: Set<string>;
  bad: string;
  good: string;
  terms: string[];
}

/** Steps through a bisection to its end in both twins, then resets both. */
async function bisectSession(a: string, b: string, plan: SessionPlan): Promise<void> {
  let { native } = await step(a, b, ["start", ...plan.start], plan.terms);
  for (let k = 0; k < 60 && native.status === 0 && CANDIDATE.test(native.stdout); k++) {
    const id = underTest(a);
    const answer = plan.untestable.has(id)
      ? "skip"
      : reaches(a, plan.culprit, id)
        ? plan.bad
        : plan.good;
    ({ native } = await step(a, b, [answer], plan.terms));
  }
  await step(a, b, ["log"], plan.terms);
  await step(a, b, ["reset"], plan.terms);
}

/** A random plan over a history: the first bad commit, the bad and good ones, skips. */
function randomPlan(
  a: string,
  seed: number,
  extra: { firstParent?: boolean } = {},
): Omit<SessionPlan, "start" | "terms" | "bad" | "good"> & { badRev: string; goods: string[] } {
  const rnd = mulberry32(seed * 7919 + 1);
  const commits = allCommits(a);
  const tip = ok(a, ["rev-parse", "main"]).trim();
  const pool = extra.firstParent
    ? ok(a, ["rev-list", "--first-parent", "main"]).trim().split("\n")
    : commits;
  // a first bad commit with commits before it (a good one can be given)
  const roots = new Set(ok(a, ["rev-list", "--max-parents=0", "--all"]).trim().split("\n"));
  const eligible = pool.filter((c) => !roots.has(c) || roots.size > 1);
  const culprit = eligible[Math.floor(rnd() * eligible.length)] as string;
  const descendants = commits.filter((c) => reaches(a, culprit, c));
  const badRev =
    rnd() < 0.5 ? tip : (descendants[Math.floor(rnd() * descendants.length)] as string);
  const candidates = commits.filter((c) => !reaches(a, culprit, c));
  const goods: string[] = [];
  const count = candidates.length === 0 ? 0 : 1 + Math.floor(rnd() * 2);
  for (let k = 0; k < count; k++) {
    const g = candidates[Math.floor(rnd() * candidates.length)] as string;
    if (!goods.includes(g)) goods.push(g);
  }
  const untestable = new Set<string>();
  if (rnd() < 0.5) {
    for (const c of commits) if (c !== badRev && rnd() < 0.25) untestable.add(c);
  }
  return { culprit, untestable, badRev, goods };
}

describeGit("git bisect against native git", () => {
  const shapes: [string, HistoryShape][] = [
    ["linear", { commits: 14, merges: false, roots: false, criss: false }],
    ["merges", { commits: 22, merges: true, roots: false, criss: false }],
    ["criss-cross", { commits: 24, merges: true, roots: false, criss: true }],
    ["several roots", { commits: 20, merges: true, roots: true, criss: false }],
  ];
  for (const [label, shape] of shapes) {
    for (const seed of [1, 2, 3]) {
      it(`steps through a bisection of a ${label} history (seed ${seed})`, async () => {
        const { a, b } = twins(seed * 31 + label.length, shape);
        const plan = randomPlan(a, seed + label.length);
        await bisectSession(a, b, {
          start: [plan.badRev, ...plan.goods],
          culprit: plan.culprit,
          untestable: plan.untestable,
          bad: "bad",
          good: "good",
          terms: ["bad", "good"],
        });
      }, 120_000);
    }
  }

  it("bisects with custom terms, --no-checkout and skip ranges", async () => {
    const { a, b } = twins(77, { commits: 20, merges: true, roots: false, criss: false });
    const plan = randomPlan(a, 5);
    const terms = ["broken", "fixed"];
    let { native } = await step(
      a,
      b,
      ["start", "--term-new=broken", "--term-old", "fixed", "--no-checkout"],
      terms,
    );
    ({ native } = await step(a, b, ["terms"], terms));
    ({ native } = await step(a, b, ["terms", "--term-good"], terms));
    ({ native } = await step(a, b, ["broken", plan.badRev], terms));
    ({ native } = await step(a, b, ["fixed", ...plan.goods], terms));
    const range = `${plan.goods[0]}..${plan.badRev}`;
    const firstFew = ok(a, ["rev-list", "-n", "3", range]).trim().split("\n").filter(Boolean);
    if (firstFew.length >= 2) {
      ({ native } = await step(a, b, ["skip", `${firstFew[1]}..${firstFew[0]}`], terms));
    }
    for (let k = 0; k < 60 && native.status === 0 && CANDIDATE.test(native.stdout); k++) {
      const id = underTest(a);
      ({ native } = await step(a, b, [reaches(a, plan.culprit, id) ? "broken" : "fixed"], terms));
    }
    await step(a, b, ["log"], terms);
    await step(a, b, ["reset"], terms);
  }, 120_000);

  it("bisects along first parents", async () => {
    for (const seed of [11, 12]) {
      const { a, b } = twins(seed, { commits: 24, merges: true, roots: false, criss: true });
      const plan = randomPlan(a, seed, { firstParent: true });
      await bisectSession(a, b, {
        start: ["--first-parent", plan.badRev, ...plan.goods],
        culprit: plan.culprit,
        untestable: plan.untestable,
        bad: "bad",
        good: "good",
        terms: ["bad", "good"],
      });
    }
  }, 120_000);

  it("bisects limited to paths", async () => {
    for (const seed of [21, 22]) {
      const { a, b } = twins(seed, { commits: 24, merges: true, roots: false, criss: false });
      const plan = randomPlan(a, seed);
      await bisectSession(a, b, {
        start: [plan.badRev, ...plan.goods, "--", "src"],
        culprit: plan.culprit,
        untestable: plan.untestable,
        bad: "bad",
        good: "good",
        terms: ["bad", "good"],
      });
    }
  }, 120_000);

  it("runs a command on each candidate as git bisect run does", async () => {
    for (const seed of [31, 32, 33]) {
      const { a, b } = twins(seed, { commits: 22, merges: true, roots: false, criss: true });
      const plan = randomPlan(a, seed);
      const skips = [...plan.untestable].join("|") || "none";
      const script = `case $(git rev-parse HEAD) in ${skips}) exit 125;; esac; git merge-base --is-ancestor ${plan.culprit} HEAD && exit 1; exit 0`;
      const terms = ["bad", "good"];
      await step(a, b, ["start", plan.badRev, ...plan.goods], terms);
      await step(a, b, ["run", "sh", "-c", script], terms, {
        configure: (cmd) =>
          cmd.setRunHandler(({ commit }) => {
            if (commit && plan.untestable.has(commit)) return 125;
            return commit && reaches(b, plan.culprit, commit) ? 1 : 0;
          }),
      });
      await step(a, b, ["log"], terms);
      await step(a, b, ["reset"], terms);
    }
  }, 120_000);

  it("stops a run on an exit status of 128 or more, verifies 126/127 on a good commit", async () => {
    const { a, b } = twins(41, { commits: 12, merges: false, roots: false, criss: false });
    const tip = ok(a, ["rev-parse", "main"]).trim();
    const first = ok(a, ["rev-list", "--max-parents=0", "main"]).trim();
    const terms = ["bad", "good"];
    await step(a, b, ["start", tip, first], terms);
    await step(a, b, ["run", "sh", "-c", "exit 129"], terms, {
      configure: (cmd) => cmd.setRunHandler(() => 129),
    });
    await step(a, b, ["run", "sh", "-c", "exit 127"], terms, {
      configure: (cmd) => cmd.setRunHandler(() => 127),
    });
    await step(a, b, ["reset"], terms);
  }, 60_000);

  it("replays a log", async () => {
    const { a, b } = twins(51, { commits: 20, merges: true, roots: false, criss: true });
    const plan = randomPlan(a, 51);
    const terms = ["bad", "good"];
    let { native } = await step(a, b, ["start", plan.badRev, ...plan.goods], terms);
    for (let k = 0; k < 2 && native.status === 0 && CANDIDATE.test(native.stdout); k++) {
      const id = underTest(a);
      ({ native } = await step(a, b, [reaches(a, plan.culprit, id) ? "bad" : "good"], terms));
    }
    const log = ok(a, ["bisect", "log"]);
    await step(a, b, ["reset"], terms);
    const file = join(root, `replay-${counter}.log`);
    writeFileSync(file, log);
    await step(a, b, ["replay", file], terms, {
      configure: (cmd) => cmd.setLogText(log),
    });
    await step(a, b, ["reset"], terms);
  }, 60_000);

  it("refuses as git refuses", async () => {
    const { a, b } = twins(61, { commits: 10, merges: false, roots: false, criss: false });
    const terms = ["bad", "good", "new", "old", "bad|new", "good|old"];
    const opts = { compareStderr: true };
    await step(a, b, ["bad"], terms, opts);
    await step(a, b, ["log"], terms, opts);
    await step(a, b, ["next"], terms, opts);
    rmSync(join(a, ".git", "BISECT_TERMS"));
    rmSync(join(b, ".git", "BISECT_TERMS"));
    await step(a, b, ["start", "--term-new=bad", "--term-old=bad"], terms, opts);
    await step(a, b, ["start", "--term-new=skip"], terms, opts);
    await step(a, b, ["start", "--term-old=new"], terms, opts);
    await step(a, b, ["start", "--bogus"], terms, opts);
    await step(a, b, ["start", "main", "nope", "--", "src"], terms, opts);
    await step(a, b, ["start"], terms, opts);
    await step(a, b, ["new"], terms, opts);
    await step(a, b, ["bad", "main", "main~1"], terms, opts);
    await step(a, b, ["bad", "nope"], terms, opts);
    await step(a, b, ["terms", "--bogus"], terms, opts);
    await step(a, b, ["next"], terms, opts);
    await step(a, b, ["reset"], terms, opts);
    // started at a detached HEAD, reset to a commit
    ok(a, ["checkout", "-q", "main~2"]);
    ok(b, ["checkout", "-q", "main~2"]);
    await step(a, b, ["start", "main", "main~5"], terms, opts);
    await step(a, b, ["reset", "main~1"], terms);
    if (modern()) await step(a, b, ["reset"], terms, opts);
  }, 60_000);

  /** main: c1..c6; side: from c2, s1 s2 (adding side files). */
  function sideHistory(dir: string): void {
    ok(root, ["init", "-q", "-b", "main", dir]);
    let time = 1_400_000_000;
    const dated = () => {
      time += 60;
      return { GIT_AUTHOR_DATE: `${time} +0000`, GIT_COMMITTER_DATE: `${time} +0000` };
    };
    const commit = (name: string) => {
      put(dir, `${name}.txt`, `${name}\n`);
      ok(dir, ["add", "-A"]);
      ok(dir, ["commit", "-q", "-m", name], dated());
      ok(dir, ["tag", name]);
    };
    commit("c1");
    commit("c2");
    ok(dir, ["checkout", "-q", "-b", "side"]);
    commit("s1");
    commit("s2");
    ok(dir, ["checkout", "-q", "main"]);
    for (const c of ["c3", "c4", "c5", "c6"]) commit(c);
  }

  function sideTwins(): { a: string; b: string } {
    const a = join(root, `s${++counter}-a`);
    const b = join(root, `s${counter}-b`);
    sideHistory(a);
    sideHistory(b);
    return { a, b };
  }

  it("tests merge bases as git does", async () => {
    const { a, b } = sideTwins();
    const opts = { compareStderr: true };
    for (const [bad, good, newTerm, oldTerm] of [
      ["bad", "good", undefined, undefined],
      ["new", "old", "new", "old"],
      ["broken", "fixed", "broken", "fixed"],
    ] as const) {
      const terms = [bad, good];
      const termArgs = newTerm ? [`--term-new=${newTerm}`, `--term-old=${oldTerm}`] : [];
      // the merge base c2 must be tested; it is bad: the bug was fixed on the side
      await step(a, b, ["start", ...termArgs, "c6", "s2"], terms, opts);
      await step(a, b, [bad], terms, opts);
      await step(a, b, ["log"], terms, opts);
      await step(a, b, ["reset"], terms, opts);
      // the merge base is good: the bisection goes on
      await step(a, b, ["start", ...termArgs, "c6", "s2"], terms, opts);
      let { native } = await step(a, b, [good], terms, opts);
      for (let k = 0; k < 10 && native.status === 0 && CANDIDATE.test(native.stdout); k++) {
        const id = underTest(a);
        ({ native } = await step(
          a,
          b,
          [reaches(a, ok(a, ["rev-parse", "c4"]).trim(), id) ? bad : good],
          terms,
          opts,
        ));
      }
      await step(a, b, ["reset"], terms, opts);
      // a good commit the bad one does not reach, the bad one their merge base
      await step(a, b, ["start", ...termArgs, "c2", "s2"], terms, opts);
      await step(a, b, ["reset"], terms, opts);
    }
    // a skipped merge base: a warning, then on
    const terms = ["bad", "good"];
    await step(a, b, ["start"], terms, opts);
    await step(a, b, ["skip", "c2"], terms, opts);
    await step(a, b, ["bad", "c6"], terms, opts);
    await step(a, b, ["good", "s2"], terms, opts);
    await step(a, b, ["reset"], terms, opts);
    // good and bad at once; nothing to test on the paths
    await step(a, b, ["start", "c6", "c5"], terms, opts);
    await step(a, b, ["good", "c6"], terms, opts);
    await step(a, b, ["reset"], terms, opts);
    await step(a, b, ["start", "c6", "c1", "--", "nothing-here"], terms, opts);
    await step(a, b, ["reset"], terms, opts);
    // a single path without "--" is read as no path (git's off-by-one)
    await step(a, b, ["start", "c6", "c1", "c4.txt"], terms, opts);
    await step(a, b, ["reset"], terms, opts);
    await step(a, b, ["start", "c6", "c1", "c4.txt", "c5.txt"], terms, opts);
    await step(a, b, ["next"], terms, opts);
    await step(a, b, ["reset"], terms, opts);
  }, 60_000);

  it("runs with --no-checkout and from a merge base", async () => {
    const { a, b } = sideTwins();
    const terms = ["bad", "good"];
    const culprit = ok(a, ["rev-parse", "c4"]).trim();
    const handler = ({ commit }: { commit: string | undefined }) =>
      commit && reaches(b, culprit, commit) ? 1 : 0;
    const script = `git merge-base --is-ancestor ${culprit} $(git rev-parse BISECT_HEAD 2>/dev/null || git rev-parse HEAD) && exit 1; exit 0`;
    await step(a, b, ["start", "--no-checkout", "c6", "s2"], terms);
    await step(a, b, ["run", "sh", "-c", script], terms, {
      configure: (cmd) => cmd.setRunHandler(handler),
    });
    await step(a, b, ["log"], terms);
    await step(a, b, ["reset"], terms);
  }, 60_000);

  it("stops a run at a second merge base to test (criss-cross)", async () => {
    const make = (dir: string) => {
      ok(root, ["init", "-q", "-b", "main", dir]);
      let time = 1_450_000_000;
      const commit = (name: string) => {
        time += 60;
        put(dir, `${name}.txt`, `${name}\n`);
        ok(dir, ["add", "-A"]);
        ok(dir, ["commit", "-q", "-m", name], {
          GIT_AUTHOR_DATE: `${time} +0000`,
          GIT_COMMITTER_DATE: `${time} +0000`,
        });
      };
      const merge = (name: string, other: string) => {
        time += 60;
        const env = { GIT_AUTHOR_DATE: `${time} +0000`, GIT_COMMITTER_DATE: `${time} +0000` };
        ok(dir, ["merge", "-q", "--no-ff", "--no-edit", "-m", name, other], env);
      };
      commit("c1");
      ok(dir, ["checkout", "-q", "-b", "y"]);
      commit("y1");
      ok(dir, ["checkout", "-q", "main"]);
      commit("x1");
      ok(dir, ["tag", "x1"]);
      ok(dir, ["checkout", "-q", "y"]);
      ok(dir, ["tag", "y1"]);
      merge("m2", "x1");
      commit("y2");
      ok(dir, ["checkout", "-q", "main"]);
      merge("m1", "y1");
      commit("x2");
    };
    const a = join(root, `cc${++counter}-a`);
    const b = join(root, `cc${counter}-b`);
    make(a);
    make(b);
    const terms = ["bad", "good"];
    await step(a, b, ["start", "main", "y"], terms);
    await step(a, b, ["run", "sh", "-c", "exit 0"], terms, {
      configure: (cmd) => cmd.setRunHandler(() => 0),
    });
    await step(a, b, ["log"], terms);
    await step(a, b, ["reset"], terms);
  }, 60_000);

  it("shows the first bad commit as git show does (renames, modes, merges)", async () => {
    const make = (dir: string) => {
      ok(root, ["init", "-q", "-b", "main", dir]);
      let time = 1_500_000_000;
      const dated = () => {
        time += 60;
        return { GIT_AUTHOR_DATE: `${time} +0000`, GIT_COMMITTER_DATE: `${time} +0000` };
      };
      put(dir, "a.txt", "one\ntwo\nthree\nfour\nfive\nsix\n");
      put(dir, "run.sh", "echo\n");
      ok(dir, ["add", "-A"]);
      ok(dir, ["commit", "-q", "-m", "root"], dated());
      ok(dir, ["mv", "a.txt", "b.txt"]);
      chmodSync(join(dir, "run.sh"), 0o755);
      ok(dir, ["add", "run.sh"]);
      ok(dir, ["commit", "-q", "-m", "rename\n\n\tindented body\n"], dated());
      ok(dir, ["checkout", "-q", "-b", "side", "HEAD~1"]);
      put(dir, "side.txt", "side\n");
      ok(dir, ["add", "-A"]);
      ok(dir, ["commit", "-q", "-m", "side"], dated());
      ok(dir, ["checkout", "-q", "main"]);
      ok(dir, ["merge", "-q", "--no-ff", "--no-edit", "-m", "merge side", "side"], dated());
      put(dir, "c.txt", "c\n");
      ok(dir, ["add", "-A"]);
      ok(dir, ["commit", "-q", "-m", "tip"], dated());
    };
    const a = join(root, `m${++counter}-a`);
    const b = join(root, `m${counter}-b`);
    make(a);
    make(b);
    const terms = ["bad", "good"];
    for (const culprit of ["main~1^1", "main~1", "main~1^2"]) {
      const id = ok(a, ["rev-parse", culprit]).trim();
      let { native } = await step(a, b, ["start", "main", "main~1^1~1"], terms);
      for (let k = 0; k < 10 && native.status === 0 && CANDIDATE.test(native.stdout); k++) {
        ({ native } = await step(a, b, [reaches(a, id, underTest(a)) ? "bad" : "good"], terms));
      }
      expect(native.stdout).toContain(`${id} is the first`);
      await step(a, b, ["reset"], terms);
    }
  }, 60_000);

  it("resets when found (--reset-when-found)", async () => {
    const probe = join(root, `probe${++counter}`);
    ok(root, ["init", "-q", probe]);
    if (run(probe, ["bisect", "start", "--reset-when-found"]).stderr.includes("unrecognized"))
      return;
    const { a, b } = sideTwins();
    const terms = ["bad", "good"];
    const culprit = ok(a, ["rev-parse", "c4"]).trim();
    for (const mode of ["--reset-when-found", "--reset-when-found=found"]) {
      let { native } = await step(a, b, ["start", mode, "c6", "c1"], terms);
      for (let k = 0; k < 10 && native.status === 0 && CANDIDATE.test(native.stdout); k++) {
        ({ native } = await step(
          a,
          b,
          [reaches(a, culprit, underTest(a)) ? "bad" : "good"],
          terms,
        ));
      }
      if (existsSync(join(a, ".git", "BISECT_START"))) await step(a, b, ["reset"], terms);
      else {
        ok(a, ["checkout", "-q", "main"]);
        ok(b, ["checkout", "-q", "main"]);
      }
    }
  }, 60_000);

  it("refuses to check out a candidate over local changes", async () => {
    const { a, b } = twins(71, { commits: 10, merges: false, roots: false, criss: false });
    const terms = ["bad", "good"];
    const tracked =
      ok(a, ["ls-files", "src"]).trim().split("\n")[0] || ok(a, ["ls-files"]).trim().split("\n")[0];
    for (const dir of [a, b]) writeFileSync(join(dir, tracked as string), "changed\n");
    await step(a, b, ["start", "main", "main~9"], terms);
    for (const dir of [a, b]) ok(dir, ["checkout", "--", tracked as string]);
    await step(a, b, ["start", "main", "main~9"], terms);
    await step(a, b, ["reset"], terms);
  }, 60_000);

  /** A linear history c1..c<n> (tagged), each commit adding f<k>.txt, dated a minute apart. */
  function linearHistory(dir: string, n: number, extra: Record<string, string> = {}): void {
    ok(root, ["init", "-q", "-b", "main", dir]);
    for (let k = 1; k <= n; k++) {
      const time = 1_600_000_000 + k * 60;
      put(dir, `f${k}.txt`, `${k}\n`);
      ok(dir, ["add", "-A"]);
      ok(dir, ["commit", "-q", "-m", `c${k}`], {
        GIT_AUTHOR_DATE: `${time} +0000`,
        GIT_COMMITTER_DATE: `${time} +0000`,
        ...extra,
      });
      ok(dir, ["tag", `c${k}`]);
    }
  }

  function linearTwins(n: number): { a: string; b: string } {
    const a = join(root, `l${++counter}-a`);
    const b = join(root, `l${counter}-b`);
    linearHistory(a, n);
    linearHistory(b, n);
    return { a, b };
  }

  it("bisects a shallow clone (shallow commits have no parents)", async () => {
    const src = join(root, `shallow-src${++counter}`);
    linearHistory(src, 12);
    const a = join(root, `sh${counter}-a`);
    const b = join(root, `sh${counter}-b`);
    for (const dir of [a, b]) ok(root, ["clone", "-q", "--depth", "6", `file://${src}`, dir]);
    expect(readFileSync(join(a, ".git", "shallow"), "utf8").trim()).toBe(
      ok(src, ["rev-parse", "c7"]).trim(),
    );
    const terms = ["bad", "good"];
    let { native } = await step(a, b, ["start", "main", "main~4"], terms);
    for (let k = 0; k < 10 && native.status === 0 && CANDIDATE.test(native.stdout); k++) {
      ({ native } = await step(a, b, ["bad"], terms));
    }
    expect(native.stdout).toContain("is the first");
    await step(a, b, ["log"], terms);
    // the branch has an upstream: the checkout reports how they compare
    const { native: reset } = await step(a, b, ["reset"], terms);
    expect(reset.stdout).toContain("Your branch is up to date with 'origin/main'.");
    // the merge base of a shallow commit and a good one the bad one does not reach
    ok(a, ["checkout", "-q", "-b", "side", "main~3"]);
    ok(b, ["checkout", "-q", "-b", "side", "main~3"]);
    for (const dir of [a, b]) {
      put(dir, "side.txt", "side\n");
      ok(dir, ["add", "-A"]);
      ok(dir, ["commit", "-q", "-m", "side"], {
        GIT_AUTHOR_DATE: "1600009000 +0000",
        GIT_COMMITTER_DATE: "1600009000 +0000",
      });
      ok(dir, ["checkout", "-q", "main"]);
    }
    ({ native } = await step(a, b, ["start", "main", "side"], terms));
    for (let k = 0; k < 10 && native.status === 0 && CANDIDATE.test(native.stdout); k++) {
      ({ native } = await step(a, b, ["good"], terms));
    }
    await step(a, b, ["reset"], terms);
    // a good commit of an unrelated history: the walks reach the shallow commit, which
    // has no parents to read
    for (const dir of [a, b]) {
      const tree = ok(dir, ["rev-parse", "main~5^{tree}"]).trim();
      const lone = ok(dir, ["commit-tree", tree, "-m", "lone"], {
        GIT_AUTHOR_DATE: "1600009500 +0000",
        GIT_COMMITTER_DATE: "1600009500 +0000",
      }).trim();
      ok(dir, ["branch", "lone", lone]);
    }
    const c9 = ok(a, ["rev-parse", "main~3"]).trim();
    ({ native } = await step(a, b, ["start", "main", "lone"], terms));
    for (let k = 0; k < 10 && native.status === 0 && CANDIDATE.test(native.stdout); k++) {
      ({ native } = await step(a, b, [reaches(a, c9, underTest(a)) ? "bad" : "good"], terms));
    }
    await step(a, b, ["reset"], terms);
    ({ native } = await step(a, b, ["start", "main", "lone", "--", "f8.txt", "f7.txt"], terms));
    for (let k = 0; k < 10 && native.status === 0 && CANDIDATE.test(native.stdout); k++) {
      ({ native } = await step(a, b, ["bad"], terms));
    }
    await step(a, b, ["reset"], terms);
  }, 60_000);

  it("bisects past a shallow commit to the merge base of a good branch", async () => {
    const { a, b } = linearTwins(12);
    const terms = ["bad", "good"];
    for (const dir of [a, b]) {
      ok(dir, ["checkout", "-q", "-b", "side", "c3"]);
      put(dir, "side.txt", "side\n");
      ok(dir, ["add", "-A"]);
      ok(dir, ["commit", "-q", "-m", "side"], {
        GIT_AUTHOR_DATE: "1600009000 +0000",
        GIT_COMMITTER_DATE: "1600009000 +0000",
      });
      ok(dir, ["checkout", "-q", "main"]);
    }
    // c7 shallow (no parents): main and side then have no merge base
    const c7 = ok(a, ["rev-parse", "c7"]).trim();
    for (const dir of [a, b]) writeFileSync(join(dir, ".git", "shallow"), `${c7}\n`);
    const starts = [
      ["start", "main", "side"],
      ["start", "--no-checkout", "main", "side"],
      ["start", "main", "side", "--", "f9.txt", "f10.txt", "f11.txt"],
    ];
    for (const start of starts) {
      let { native } = await step(a, b, start, terms);
      if (start.length === 3) {
        expect(native.stdout).toMatch(/^Bisecting: 2 revisions left to test after this/);
        expect(native.stdout).toContain("] c9\n");
      }
      for (let k = 0; k < 10 && native.status === 0 && CANDIDATE.test(native.stdout); k++) {
        ({ native } = await step(a, b, ["good"], terms));
      }
      await step(a, b, ["log"], terms);
      await step(a, b, ["reset"], terms);
    }
  }, 60_000);

  it("compares the branch with each ref status.compareBranches names (git 2.56)", async () => {
    if (!atLeast256()) return;
    const src = join(root, `cmp-src${++counter}`);
    linearHistory(src, 8);
    const fork = join(root, `cmp-fork${counter}`);
    ok(root, ["clone", "-q", `file://${src}`, fork]);
    const commit = (dir: string, name: string, time: number) => {
      put(dir, name, `${name}\n`);
      ok(dir, ["add", "-A"]);
      ok(dir, ["commit", "-q", "-m", name], {
        GIT_AUTHOR_DATE: `${time} +0000`,
        GIT_COMMITTER_DATE: `${time} +0000`,
      });
    };
    commit(fork, "fork.txt", 1600008000);
    const a = join(root, `cmp${counter}-a`);
    const b = join(root, `cmp${counter}-b`);
    for (const dir of [a, b]) {
      ok(root, ["clone", "-q", `file://${src}`, dir]);
      commit(dir, "local.txt", 1600009000);
      ok(dir, ["remote", "add", "fork", `file://${fork}`]);
      ok(dir, ["fetch", "-q", "fork"]);
    }
    const terms = ["bad", "good"];
    const config = (key: string, value: string | undefined) => {
      for (const dir of [a, b]) {
        if (value === undefined) run(dir, ["config", "--unset-all", key]);
        else ok(dir, ["config", key, value]);
      }
    };
    const cycle = async () => {
      await step(a, b, ["start", "HEAD", "HEAD~5"], terms);
      return (await step(a, b, ["reset"], terms)).native;
    };
    // the push ref is the upstream: one report
    config("status.compareBranches", "@{upstream} @{push}");
    let native = await cycle();
    expect(native.stdout).toBe(
      "Your branch is ahead of 'origin/main' by 1 commit.\n" +
        '  (use "git push" to publish your local commits)\n',
    );
    // pushed elsewhere: a report for each, a blank line apart
    config("remote.pushDefault", "fork");
    native = await cycle();
    // ('simple' resolves no push ref to another remote)
    expect(native.stdout).not.toContain("fork/main");
    config("push.default", "current");
    native = await cycle();
    expect(native.stdout).toContain("\n\nYour branch and 'fork/main' have diverged,\n");
    // the order given, each ref once, a value git ignores (with its warning)
    config("status.compareBranches", "@{push} @{UPSTREAM} @{push} origin/main");
    native = await cycle();
    expect(native.stderr).toContain("warning: ignoring value 'origin/main'");
    config("status.compareBranches", "");
    expect((await cycle()).stdout).toBe("");
    config("status.compareBranches", "  @{push}  ");
    await cycle();
    // behind the push ref: `git pull <remote> <branch>`
    for (const dir of [a, b]) ok(dir, ["reset", "-q", "--hard", "origin/main"]);
    config("status.compareBranches", "@{upstream} @{push}");
    native = await cycle();
    expect(native.stdout).toContain('(use "git pull fork main" to update your local branch)');
    config("advice.statusHints", "false");
    await cycle();
    config("advice.statusHints", undefined);
    // an upstream that is gone, then the push ref
    for (const dir of [a, b]) ok(dir, ["update-ref", "-d", "refs/remotes/origin/main"]);
    native = await cycle();
    expect(native.stdout).toContain("but the upstream is gone");
  }, 60_000);

  it("puts an ellipsis after the ids of detached HEADs (GIT_PRINT_SHA1_ELLIPSIS=yes)", async () => {
    const { a, b } = linearTwins(8);
    const terms = ["bad", "good"];
    const env = { GIT_PRINT_SHA1_ELLIPSIS: "yes" };
    await step(a, b, ["start", "c7", "c1"], terms, { env });
    const { native } = await step(a, b, ["reset"], terms, { env });
    expect(native.stderr).toMatch(/^Previous HEAD position was [0-9a-f]+\.\.\. c4\n/);
    await step(a, b, ["start", "c7", "c1"], terms, { env });
    for (const dir of [a, b]) ok(dir, ["checkout", "-q", "main"]);
    const { native: detached } = await step(a, b, ["reset", "c5"], terms, { env });
    expect(detached.stderr).toMatch(/HEAD is now at [0-9a-f]+\.\.\. c5\n/);
    // anything but "yes" (any case) prints none
    await step(a, b, ["start", "c7", "c1"], terms, { env: { GIT_PRINT_SHA1_ELLIPSIS: "YES" } });
    await step(a, b, ["reset"], terms, { env: { GIT_PRINT_SHA1_ELLIPSIS: "1" } });
  }, 60_000);

  it("shows the first bad commit as git show does (format, dates, mailmap, notes, encodings)", async () => {
    const make = (dir: string) => {
      ok(root, ["init", "-q", "-b", "main", dir]);
      let time = 1_550_000_000;
      const dated = () => {
        time += 60;
        return { GIT_AUTHOR_DATE: `${time} +0100`, GIT_COMMITTER_DATE: `${time} +0100` };
      };
      put(dir, "a.txt", "one\ntwo\nthree\nfour\nfive\nsix\n");
      put(dir, "gone.txt", "gone\n");
      put(dir, "run.sh", "echo\n");
      ok(dir, ["add", "-A"]);
      ok(dir, ["commit", "-q", "-m", "root"], dated());
      // a rename, a deletion, a creation and a mode change in one commit
      ok(dir, ["mv", "a.txt", "b.txt"]);
      ok(dir, ["rm", "-q", "gone.txt"]);
      put(dir, "new dir/café.txt", "new\n");
      chmodSync(join(dir, "run.sh"), 0o755);
      ok(dir, ["add", "-A"]);
      ok(dir, ["commit", "-q", "-m", "many\n\nbody line"], dated());
      // a message stored in ISO-8859-1 (shown in UTF-8)
      put(dir, "c.txt", "c\n");
      ok(dir, ["add", "-A"]);
      writeFileSync(join(dir, ".git", "MSG"), Buffer.from("caf\xe9 latin1\n", "latin1"));
      ok(dir, ["-c", "i18n.commitEncoding=ISO-8859-1", "commit", "-q", "-F", ".git/MSG"], dated());
      put(dir, "d.txt", "d\n");
      ok(dir, ["add", "-A"]);
      ok(dir, ["commit", "-q", "-m", "tip"], dated());
      ok(dir, ["notes", "add", "-m", "a note", "HEAD~2"], dated());
      put(dir, ".mailmap", "Mapped Name <mapped@example.com> <author@example.com>\n");
    };
    const a = join(root, `show${++counter}-a`);
    const b = join(root, `show${counter}-b`);
    make(a);
    make(b);
    const terms = ["bad", "good"];
    const configs: string[][] = [
      [],
      ["log.date", "iso"],
      ["format.pretty", "fuller"],
      ["log.mailmap", "false"],
    ];
    for (const culprit of ["main~2", "main~1"]) {
      for (const [key, value] of configs) {
        if (key) for (const dir of [a, b]) ok(dir, ["config", key, value as string]);
        const id = ok(a, ["rev-parse", culprit]).trim();
        let { native } = await step(a, b, ["start", "main", "main~3"], terms);
        for (let k = 0; k < 10 && native.status === 0 && CANDIDATE.test(native.stdout); k++) {
          ({ native } = await step(a, b, [reaches(a, id, underTest(a)) ? "bad" : "good"], terms));
        }
        expect(native.stdout).toContain(`${id} is the first`);
        await step(a, b, ["reset"], terms);
        if (key) for (const dir of [a, b]) ok(dir, ["config", "--unset", key]);
      }
    }
  }, 120_000);

  it("prints git log's --summary lines", async () => {
    const dir = join(root, `summary${++counter}`);
    ok(root, ["init", "-q", "-b", "main", dir]);
    put(dir, "a.txt", "one\ntwo\nthree\nfour\nfive\nsix\n");
    put(dir, "gone.txt", "gone\n");
    put(dir, "run.sh", "echo\n");
    put(dir, "keep.txt", "keep\n");
    ok(dir, ["add", "-A"]);
    ok(dir, ["commit", "-q", "-m", "root"]);
    mkdirSync(join(dir, "sub"));
    ok(dir, ["mv", "a.txt", "sub/b.txt"]);
    ok(dir, ["rm", "-q", "gone.txt"]);
    put(dir, "new\tfile.txt", "new\n");
    chmodSync(join(dir, "run.sh"), 0o755);
    put(dir, "keep.txt", "kept\n");
    ok(dir, ["add", "-A"]);
    ok(dir, ["commit", "-q", "-m", "changes"]);
    // a merge: its summary against the first parent with combined diffs
    ok(dir, ["checkout", "-q", "-b", "side", "HEAD~1"]);
    put(dir, "side.txt", "side\n");
    ok(dir, ["add", "-A"]);
    ok(dir, ["commit", "-q", "-m", "side"]);
    ok(dir, ["checkout", "-q", "main"]);
    ok(dir, ["merge", "-q", "--no-ff", "--no-edit", "-m", "merge", "side"]);
    const git = await openOurs(dir, ourEnv());
    const cases: [string[], LogOutputOptions][] = [
      [[], {}],
      [["--stat"], { stat: true }],
      [["-p"], { patch: true }],
      [["--name-status"], { nameStatus: true }],
      [["--cc"], { cc: true }],
      [["-m", "--stat"], { m: true, stat: true }],
      [["--diff-merges=first-parent"], { diffMerges: "first-parent" }],
    ];
    for (const [extra, options] of cases) {
      const native = ok(dir, ["log", "--summary", ...extra]);
      const ours = await git.log().callText({ summary: true, ...options });
      expect(ours, extra.join(" ")).toBe(native);
    }
  }, 60_000);

  it("bisects limited to nested paths and pathspec magic (pruned tree comparisons)", async () => {
    const make = (dir: string) => {
      ok(root, ["init", "-q", "-b", "main", dir]);
      for (let k = 1; k <= 24; k++) {
        const time = 1_620_000_000 + k * 60;
        const area = ["src/core/deep", "src/ui", "doc", "src/core"][k % 4] as string;
        put(dir, `${area}/f${k}.txt`, `${k}\n`);
        if (k % 5 === 0) put(dir, "src/core/deep/shared.txt", `${k}\n`);
        ok(dir, ["add", "-A"]);
        ok(dir, ["commit", "-q", "-m", `c${k}`], {
          GIT_AUTHOR_DATE: `${time} +0000`,
          GIT_COMMITTER_DATE: `${time} +0000`,
        });
      }
    };
    const a = join(root, `paths${++counter}-a`);
    const b = join(root, `paths${counter}-b`);
    make(a);
    make(b);
    const terms = ["bad", "good"];
    for (const [spec, culprit] of [
      [["src/core/deep"], "main~6"],
      [["src/core/*.txt"], "main~9"],
      [[":(exclude)doc"], "main~4"],
      [["src/core/deep/shared.txt", "src/ui"], "main~10"],
    ] as const) {
      const id = ok(a, ["rev-parse", culprit]).trim();
      let { native } = await step(a, b, ["start", "main", "main~23", "--", ...spec], terms);
      for (let k = 0; k < 20 && native.status === 0 && CANDIDATE.test(native.stdout); k++) {
        ({ native } = await step(a, b, [reaches(a, id, underTest(a)) ? "bad" : "good"], terms));
      }
      await step(a, b, ["reset"], terms);
    }
  }, 120_000);

  it("keeps the flags a skipped range leaves, as git does (stale UNINTERESTING)", async () => {
    const { a, b } = linearTwins(8);
    const terms = ["bad", "good"];
    await step(a, b, ["start", "c8", "c1"], terms);
    const { native, ours } = await step(a, b, ["skip", "c7..c2"], terms);
    // git's own quirk: c8 is declared the first bad commit
    const c8 = ok(a, ["rev-parse", "c8"]).trim();
    expect(native.stdout).toContain(`${c8} is the first`);
    expect(ours.firstBad).toBe(c8);
    await step(a, b, ["reset"], terms);
    // without BISECT_ANCESTORS_OK the flags are cleared by check_ancestors
    await step(a, b, ["start", "c8", "c1"], terms);
    rmSync(join(a, ".git", "BISECT_ANCESTORS_OK"));
    rmSync(join(b, ".git", "BISECT_ANCESTORS_OK"));
    await step(a, b, ["skip", "c7..c2"], terms);
    await step(a, b, ["skip", "c3...c5", "c6"], terms);
    await step(a, b, ["log"], terms);
    await step(a, b, ["reset"], terms);
  }, 60_000);

  it("prints what git checkout prints for the bisection's checkouts", async () => {
    const { a, b } = linearTwins(8);
    const terms = ["bad", "good"];
    // a local change the checkouts keep (f1.txt is the same in every commit): `M\t<path>`
    // on stdout where the checkout is not quiet
    for (const dir of [a, b]) writeFileSync(join(dir, "f1.txt"), "changed\n");
    await step(a, b, ["start", "c7", "c1"], terms);
    // started again: back to the branch, then on
    await step(a, b, ["start", "c7", "c2"], terms);
    // a commit made at the detached HEAD, left behind by the reset
    for (const dir of [a, b]) {
      put(dir, "lost.txt", "lost\n");
      ok(dir, ["add", "lost.txt"]);
      ok(dir, ["commit", "-q", "-m", "lost"], {
        GIT_AUTHOR_DATE: "1600010000 +0000",
        GIT_COMMITTER_DATE: "1600010000 +0000",
      });
    }
    const { native: left } = await step(a, b, ["reset"], terms);
    expect(left.stdout).toBe("M\tf1.txt\n");
    expect(left.stderr).toContain("Warning: you are leaving 1 commit behind");
    // on the branch during the bisection: the reset finds it there; a reset to a commit
    // from a branch gives the detached HEAD advice
    await step(a, b, ["start", "c7", "c1"], terms);
    for (const dir of [a, b]) ok(dir, ["checkout", "-q", "main"]);
    await step(a, b, ["reset"], terms);
    await step(a, b, ["start", "c7", "c1"], terms);
    for (const dir of [a, b]) ok(dir, ["checkout", "-q", "main"]);
    const { native } = await step(a, b, ["reset", "c5"], terms);
    expect(native.stderr).toContain("Note: switching to 'c5'.");
    for (const dir of [a, b]) ok(dir, ["checkout", "-q", "main"]);
  }, 60_000);

  it("prints subjects that are not UTF-8 as git does (bytes as stored)", async () => {
    const make = (dir: string) => {
      ok(root, ["init", "-q", "-b", "main", dir]);
      ok(dir, ["config", "i18n.commitEncoding", "ISO-8859-1"]);
      for (let k = 1; k <= 6; k++) {
        const time = 1_630_000_000 + k * 60;
        put(dir, `f${k}.txt`, `${k}\n`);
        ok(dir, ["add", "-A"]);
        writeFileSync(join(dir, ".git", "MSG"), Buffer.from(`c${k} caf\xe9\n`, "latin1"));
        ok(dir, ["commit", "-q", "-F", ".git/MSG"], {
          GIT_AUTHOR_DATE: `${time} +0000`,
          GIT_COMMITTER_DATE: `${time} +0000`,
        });
      }
    };
    const a = join(root, `enc${++counter}-a`);
    const b = join(root, `enc${counter}-b`);
    make(a);
    make(b);
    const native = spawnSync("git", ["bisect", "start", "main", "main~5"], {
      cwd: a,
      env: { ...nativeGitEnv(root), GIT_EDITOR: "true" },
    });
    const git = await openOurs(b, ourEnv());
    const ours = await git.bisect().setArguments(["start", "main", "main~5"]).call();
    expect(Buffer.from(ours.stdoutBytes).equals(native.stdout)).toBe(true);
    expect(native.stdout.includes(Buffer.from("caf\xe9", "latin1"))).toBe(true);
    const log = (dir: string) => readFileSync(join(dir, ".git", "BISECT_LOG"));
    expect(log(b).equals(log(a))).toBe(true);
    await step(a, b, ["bad"], ["bad", "good"]);
    expect(log(b).equals(log(a))).toBe(true);
    await step(a, b, ["reset"], ["bad", "good"]);
  }, 60_000);

  it("parses its options and dies on bad revisions as git does", async () => {
    const { a, b } = linearTwins(8);
    const terms = ["bad", "good"];
    await step(a, b, ["--foo"], terms);
    await step(a, b, ["-x"], terms);
    if (modern()) {
      await step(a, b, ["help"], terms);
      await step(a, b, ["-h"], terms);
    }
    await step(a, b, ["start", "c8", "c1"], terms);
    await step(a, b, ["skip", "nope..c2"], terms);
    await step(a, b, ["skip", "c7..c5", "nope"], terms);
    await step(a, b, ["good", "HEAD^{tree}"], terms);
    await step(a, b, ["skip", "HEAD^{tree}"], terms);
    await step(a, b, ["--", "good"], terms);
    await step(a, b, ["reset"], terms);
    // git's isspace has no VT: the line is no command, as git reads it
    const c8 = ok(a, ["rev-parse", "c8"]).trim();
    const c1 = ok(a, ["rev-parse", "c1"]).trim();
    const c5 = ok(a, ["rev-parse", "c5"]).trim();
    const log = `git bisect start '${c8}' '${c1}'\ngit bisect\vgood ${c5}\n`;
    const file = join(root, `replay-vt-${counter}.log`);
    writeFileSync(file, log);
    await step(a, b, ["replay", file], terms, { configure: (cmd) => cmd.setLogText(log) });
    await step(a, b, ["reset"], terms);
    // the typed commands refuse raw arguments
    const git = await openOurs(b, ourEnv());
    expect(() => git.bisectNext().setArguments(["next"])).toThrow(/builds its own arguments/);
    expect(() => git.bisectState("bad").setArguments(["good"])).toThrow(/builds its own/);
  }, 60_000);
});

describe("bisect quoting", () => {
  it("quotes and reads back as git's quote.c", () => {
    const argv = ["main", "it's", "a!b", "", "x y"];
    const quoted = sqQuoteArgv(argv);
    expect(quoted).toBe(" 'main' 'it'\\''s' 'a'\\!'b' '' 'x y'");
    expect(sqDequoteToArgv(quoted.trim())).toEqual({ argv, ok: true });
    expect(sqDequoteToArgv("'a' b")).toEqual({ argv: ["a"], ok: false });
  });

  it("splits words at git's isspace (no VT, no FF) and trims as strbuf_trim", () => {
    expect(sqDequoteToArgv("'a'\t'b'")).toEqual({ argv: ["a", "b"], ok: true });
    expect(sqDequoteToArgv("'a'\v'b'")).toEqual({ argv: [], ok: false });
    expect(sqDequoteToArgv("'a'\f'b'")).toEqual({ argv: [], ok: false });
    expect(strbufTrim(" \t\r\nmain\v\n")).toBe("main\v");
    expect(strbufRtrim(" main \n")).toBe(" main");
  });
});

describe("bisect arithmetic", () => {
  it("picks skip_away's index as git's C code does (values from bisect.c compiled)", () => {
    const expected = [
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 1],
      [6, 0],
      [7, 3],
      [8, 0],
      [9, 3],
      [10, 0],
      [11, 5],
      [12, 0],
      [13, 6],
      [17, 10],
      [25, 19],
      [31, 26],
      [50, 28],
      [64, 52],
      [100, 23],
      [257, 3],
      [1000, 801],
      [4096, 2853],
      [65535, 2003],
      [65537, 2932],
      [70000, 24902],
      [100000, 28464],
      [1000000, -36241],
    ];
    expect(expected.map(([count]) => [count, skipAwayIndex(count as number)])).toEqual(expected);
  });

  it("estimates the steps left as git does (values from bisect.c compiled)", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 100].map(estimateBisectSteps)).toEqual([
      0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 6,
    ]);
  });
});
