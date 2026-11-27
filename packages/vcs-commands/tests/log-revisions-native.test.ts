/**
 * Revision selection and order of `git log` / `git rev-list` against native git: the ref
 * options (`--all`, `--branches[=]`, `--tags[=]`, `--remotes[=]`, `--glob=`, `--exclude=`),
 * `--stdin`, the orders (`--topo-order`, `--date-order`, `--author-date-order`,
 * `--reverse`), `--boundary` (the `-` mark) and `--source`. Each case runs the same command
 * line through native git and through ours (`RevListCommand`: `callText` is rev-list's
 * output, `callLogText` log's) and compares stdout, stderr and the exit status.
 *
 * Inputs come from git's t6018-rev-list-glob, t6003-rev-list-topo-order, t6017-rev-list-stdin,
 * t6000-rev-list-misc, t4202-log and t6112-rev-list-filters-objects, and from JGit's
 * RevWalkSortTest (its RevSort cases run as the git options closest to them, native git
 * deciding the result).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, type LogOutputOptions } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { CLEANUP_TIMEOUT, removeTempDir } from "./temp-dir-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";

type Outcome = { status: number; out: string; err: string };

function env(extra: Record<string, string> = {}): Record<string, string> {
  return { ...nativeGitEnv(home), ...extra };
}

function git(cwd: string, args: string[], extra: Record<string, string> = {}, input?: string) {
  return execFileSync("git", args, { cwd, env: env(extra), encoding: "latin1", input }).trim();
}

/** A commit made with `commit-tree` at `date` (seconds), as lib-t6000's unique_commit. */
function commitTree(
  repo: string,
  message: string,
  parents: string[],
  date: number,
  authorDate = date,
  authorEmail?: string,
): string {
  const tree = git(repo, ["write-tree"]);
  const args = ["commit-tree", tree, "-m", message];
  for (const p of parents) args.push("-p", p);
  return git(repo, args, {
    GIT_COMMITTER_DATE: gitDate(date),
    GIT_AUTHOR_DATE: gitDate(authorDate),
    ...(authorEmail ? { GIT_AUTHOR_EMAIL: authorEmail } : {}),
  });
}

/** A date git reads (epoch seconds below 100000000 are refused: ISO then). */
function gitDate(seconds: number): string {
  if (seconds >= 100000000) return `${seconds} +0000`;
  return `${new Date(seconds * 1000).toISOString().slice(0, 19).replace("T", " ")} +0000`;
}

async function open(repo: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: env() });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** `git <cmd> <args>` by native git. */
function native(repo: string, cmd: "rev-list" | "log", args: string[], stdin = ""): Outcome {
  const r = spawnSync("git", [cmd, ...args], {
    cwd: repo,
    env: env(),
    encoding: "latin1",
    input: stdin,
  });
  return { status: r.status ?? -1, out: r.stdout, err: r.stderr };
}

/** The same command line through ours. */
async function ours(
  repo: string,
  cmd: "rev-list" | "log",
  args: string[],
  stdin = "",
): Promise<Outcome> {
  const command = (await open(repo)).revList();
  if (cmd === "rev-list") command.setCommittish(false);
  const log: LogOutputOptions = {};
  let paths = false;
  const valued: [RegExp, (value: string) => void][] = [
    [/^--(?:pretty|format)=(.*)$/s, (v) => (log.pretty = v)],
    [/^--max-count=(\d+)$/, (v) => command.setMaxCount(Number(v))],
    [/^-(\d+)$/, (v) => command.setMaxCount(Number(v))],
    [/^--skip=(\d+)$/, (v) => command.setSkip(Number(v))],
    [/^--max-age=(\d+)$/, (v) => command.setSince(Number(v))],
    [/^--grep=(.*)$/s, (v) => command.addGrep(v)],
  ];
  const flags: Record<string, () => void> = {
    "--topo-order": () => command.setOrder("topo"),
    "--date-order": () => command.setOrder("date"),
    "--author-date-order": () => command.setOrder("author-date"),
    "--reverse": () => command.setReverse(true),
    "--boundary": () => command.setBoundary(true),
    "--source": () => command.setSource(true),
    "--first-parent": () => command.setFirstParent(true),
    "--stdin": () => command.addStdin(stdin),
    "--oneline": () => (log.oneline = true),
    "--stat": () => (log.stat = true),
    "--name-only": () => (log.nameOnly = true),
    "--graph": () => (log.graph = true),
    "--bisect": () => command.setBisect("bisect"),
    "--bisect-vars": () => command.setBisect("vars"),
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    // a detached `--glob <pattern>` / `--exclude <pattern>` takes the next argument as it is
    if (args[i - 1] === "--glob" || args[i - 1] === "--exclude") {
      command.addRevision(a);
      continue;
    }
    if (paths) {
      command.addPath(a);
      continue;
    }
    if (a === "--") {
      paths = true;
      continue;
    }
    const flag = flags[a];
    if (flag) {
      flag();
      continue;
    }
    const option = valued.find(([re]) => re.test(a));
    if (option) option[1]((option[0].exec(a) as RegExpExecArray)[1] as string);
    else command.addRevision(a);
  }
  try {
    const out = cmd === "rev-list" ? await command.callText() : await command.callLogText(log);
    return { status: command.getExitStatus(), out, err: "" };
  } catch (error) {
    return { status: 128, out: "", err: `${(error as Error).message}\n` };
  }
}

/** Each command line by native git and by ours. */
async function expectSame(
  repo: string,
  cmd: "rev-list" | "log",
  cases: (string[] | { args: string[]; stdin: string })[],
): Promise<void> {
  for (const c of cases) {
    const { args, stdin } = Array.isArray(c) ? { args: c, stdin: "" } : c;
    const n = native(repo, cmd, args, stdin);
    const o = await ours(repo, cmd, args, stdin);
    expect([cmd, args, stdin, o]).toEqual([cmd, args, stdin, n]);
  }
}

/** git's test_tick: 60 seconds after the last one (first 1112912053), zone -0700. */
function ticker() {
  let tick = 1112911993;
  return () => {
    tick += 60;
    return { GIT_COMMITTER_DATE: `${tick} -0700`, GIT_AUTHOR_DATE: `${tick} -0700` };
  };
}

/** t6018's `commit`: a file changed and committed at the next tick. */
function tickCommit(repo: string, tick: () => Record<string, string>, text: string): void {
  writeFileSync(join(repo, "foo"), `${text}\n`);
  git(repo, ["add", "foo"]);
  git(repo, ["commit", "-qm", text], tick());
}

describeGit("log/rev-list revisions and order against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-revisions-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(async () => {
    if (root) await removeTempDir(root);
  }, CLEANUP_TIMEOUT);

  describe("t6018-rev-list-glob", () => {
    let repo = "";
    beforeAll(() => {
      repo = join(root, "t6018");
      git(root, ["init", "-q", "-b", "main", repo]);
      const tick = ticker();
      const c = (t: string) => tickCommit(repo, tick, t);
      c("main");
      git(repo, ["checkout", "-qb", "subspace/one", "main"]);
      c("one");
      git(repo, ["checkout", "-qb", "subspace/two", "main"]);
      c("two");
      git(repo, ["checkout", "-qb", "subspace-x", "main"]);
      c("subspace-x");
      git(repo, ["checkout", "-qb", "other/three", "main"]);
      c("three");
      git(repo, ["checkout", "-qb", "someref", "main"]);
      c("some");
      git(repo, ["checkout", "-q", "main"]);
      c("topic_2");
      git(repo, ["tag", "foo/bar", "main"]);
      c("topic_3");
      git(repo, ["update-ref", "refs/remotes/foo/baz", "main"]);
      c("topic_4");
      git(repo, ["update-ref", "refs/remotes/upstream/one", "subspace/one"]);
      git(repo, ["update-ref", "refs/remotes/upstream/two", "subspace/two"]);
      git(repo, ["update-ref", "refs/remotes/upstream/x", "subspace-x"]);
      git(repo, ["tag", "qux/one", "subspace/one"]);
      git(repo, ["tag", "qux/two", "subspace/two"]);
      git(repo, ["tag", "qux/x", "subspace-x"]);
    });

    /** t6018's `compare rev-list "<a>" "<b>"`: both sides, each also against native git */
    async function compare(a: string[], b: string[]): Promise<void> {
      await expectSame(repo, "rev-list", [a, b]);
      expect(native(repo, "rev-list", a).out).toBe(native(repo, "rev-list", b).out);
    }

    it('t6018-rev-list-glob.sh: "rev-list --exclude=glob with --branches=glob", "--exclude=glob with --tags=glob", "--exclude=glob with --remotes=glob"', async () => {
      await compare(["--exclude=subspace-*", "--branches=sub*"], ["subspace/one", "subspace/two"]);
      await compare(["--exclude=qux/?", "--tags=qux/*"], ["qux/one", "qux/two"]);
      await compare(
        ["--exclude=upstream/?", "--remotes=upstream/*"],
        ["upstream/one", "upstream/two"],
      );
    });

    it('t6018-rev-list-glob.sh: "rev-list --exclude=ref with --branches=glob", "--exclude=ref with --tags=glob", "--exclude=ref with --remotes=glob"', async () => {
      await compare(["--exclude=subspace-x", "--branches=sub*"], ["subspace/one", "subspace/two"]);
      await compare(["--exclude=qux/x", "--tags=qux/*"], ["qux/one", "qux/two"]);
      await compare(
        ["--exclude=upstream/x", "--remotes=upstream/*"],
        ["upstream/one", "upstream/two"],
      );
    });

    it('t6018-rev-list-glob.sh: "rev-list --glob=refs/heads/subspace/*", "rev-list --glob refs/heads/subspace/*", "rev-list not confused by option-like --glob arg"', async () => {
      await compare(["subspace/one", "subspace/two"], ["--glob=refs/heads/subspace/*"]);
      await compare(["subspace/one", "subspace/two"], ["--glob", "refs/heads/subspace/*"]);
      await compare(["main"], ["--glob", "-0", "main"]);
    });

    it('t6018-rev-list-glob.sh: "rev-list --glob=heads/subspace/*", "--glob=refs/heads/subspace/", "--glob=heads/subspace/", "--glob=heads/subspace"', async () => {
      for (const glob of [
        "--glob=heads/subspace/*",
        "--glob=refs/heads/subspace/",
        "--glob=heads/subspace/",
        "--glob=heads/subspace",
      ]) {
        await compare(["subspace/one", "subspace/two"], [glob]);
      }
    });

    it('t6018-rev-list-glob.sh: "rev-list --branches=subspace/*", "--branches=subspace/", "--branches=subspace", "rev-list --branches"', async () => {
      for (const option of ["--branches=subspace/*", "--branches=subspace/", "--branches=subspace"])
        await compare(["subspace/one", "subspace/two"], [option]);
      await compare(
        ["main", "subspace-x", "someref", "other/three", "subspace/one", "subspace/two"],
        ["--branches"],
      );
    });

    it('t6018-rev-list-glob.sh: "rev-list --glob=heads/someref/* main", "rev-list --glob=heads/subspace/* --glob=heads/other/*", "rev-list --glob=heads/*"', async () => {
      await compare(["main"], ["--glob=heads/someref/*", "main"]);
      await compare(
        ["subspace/one", "subspace/two", "other/three"],
        ["--glob=heads/subspace/*", "--glob=heads/other/*"],
      );
      await compare(
        ["main", "other/three", "someref", "subspace-x", "subspace/one", "subspace/two"],
        ["--glob=heads/*"],
      );
    });

    it('t6018-rev-list-glob.sh: "rev-list --tags=foo", "rev-list --tags", "rev-list --remotes=foo"', async () => {
      await compare(["foo/bar"], ["--tags=foo"]);
      await compare(["foo/bar", "qux/x", "qux/two", "qux/one"], ["--tags"]);
      await compare(["foo/baz"], ["--remotes=foo"]);
    });

    it('t6018-rev-list-glob.sh: "rev-list --exclude with --branches", "rev-list --exclude with --all", "rev-list accumulates multiple --exclude"', async () => {
      await compare(["--exclude=*/*", "--branches"], ["main", "someref", "subspace-x"]);
      await compare(["--exclude=refs/remotes/*", "--all"], ["--branches", "--tags"]);
      await compare(["--exclude=refs/remotes/*", "--exclude=refs/tags/*", "--all"], ["--branches"]);
    });

    it("--branches, --tags and --all clear --exclude (t6018's rev-parse cases as rev-list)", async () => {
      await compare(["--exclude=*", "--branches", "--branches"], ["--branches"]);
      await compare(["--exclude=*", "--tags", "--tags"], ["--tags"]);
      await compare(["--exclude=*", "--all", "--all"], ["--all"]);
    });

    it('t6018-rev-list-glob.sh: "rev-list should succeed with empty output on empty stdin", "with all refs excluded", "with empty glob"', async () => {
      await expectSame(repo, "rev-list", [
        { args: ["--stdin"], stdin: "" },
        ["--exclude=*", "--all"],
        ["--glob=does-not-match-anything"],
      ]);
    });

    it('t6018-rev-list-glob.sh: "rev-list should succeed with empty output with empty --all"', async () => {
      const empty = join(root, "t6018-empty");
      git(root, ["init", "-q", "-b", "main", empty]);
      await expectSame(empty, "rev-list", [["--all"]]);
    });

    it('t6018-rev-list-glob.sh: "shortlog accepts --glob/--tags/--remotes" (the commits, as git log lists them)', async () => {
      await expectSame(repo, "log", [
        ["--oneline", "--branches=subspace"],
        ["--oneline", "--branches"],
        ["--oneline", "--glob=heads/someref/*", "main"],
        ["--oneline", "--glob=heads/subspace/*", "--glob=heads/other/*"],
        ["--oneline", "--glob=heads/*"],
        ["--oneline", "--tags=foo"],
        ["--oneline", "--tags"],
        ["--oneline", "--remotes=foo"],
      ]);
    });

    it("t6018's refs: --not before ref options, --exclude reaching only the next one, --source names", async () => {
      await expectSame(repo, "rev-list", [
        ["--branches", "--not", "--tags=qux/*"],
        ["--all", "--not", "--exclude=main", "--branches"],
        ["--exclude=main", "--remotes", "--branches"],
        ["--exclude=*", "--remotes=upstream", "--exclude=foo/*", "--tags"],
        ["--exclude", "subspace/*", "--branches=sub*"],
        ["--glob=refs/remotes/upstream/[ot]*"],
        ["--glob=remotes/*/x"],
        ["--exclude=HEAD", "--all"],
      ]);
      await expectSame(repo, "log", [
        ["--oneline", "--source", "--all"],
        ["--oneline", "--source", "--branches"],
        ["--oneline", "--source", "--exclude=subspace-*", "--branches=sub*"],
        ["--oneline", "--source", "--tags=qux"],
        ["--oneline", "--source", "--glob=remotes/upstream"],
        ["--format=%h %S %s", "--remotes"],
        ["--oneline", "--exclude=x", "-3"],
        ["--oneline", "--branches=does-not-exist"],
      ]);
    });
  });

  describe("t6003-rev-list-topo-order", () => {
    let repo = "";
    let graphRepo = "";
    beforeAll(() => {
      repo = join(root, "t6003");
      git(root, ["init", "-q", "-b", "main", repo]);
      writeFileSync(join(repo, "path0"), "date\n");
      git(repo, ["update-index", "--add", "path0"]);
      const ids = new Map<string, string>();
      // 1971-08-16 00:00 UTC
      const base = 51148800;
      const save = (
        tag: string,
        parents: string[],
        committer: number,
        author = committer,
        email?: string,
      ) => {
        const id = commitTree(
          repo,
          tag,
          parents.map((p) => ids.get(p) as string),
          base + committer,
          base + author,
          email,
        );
        ids.set(tag, id);
        git(repo, ["update-ref", `refs/tags/${tag}`, id]);
      };
      const m = (minute: number) => minute * 60;
      save("root", [], m(0));
      save("l0", ["root"], m(1));
      save("l1", ["l0"], m(2));
      save("l2", ["l1"], m(3));
      save("a0", ["l2"], m(4));
      save("a1", ["a0"], m(5));
      save("b1", ["a0"], m(6));
      save("c1", ["b1"], m(7));
      save("b2", ["b1"], m(8), m(8), "foobar@example.com");
      save("b3", ["b2"], m(9));
      save("c2", ["c1", "b2"], m(10));
      save("c3", ["c2"], m(11));
      save("a2", ["a1"], m(12), m(0));
      save("a3", ["a2"], m(13), m(1));
      save("b4", ["b3", "a3"], m(14));
      save("a4", ["a3", "b4", "c3"], m(15));
      save("l3", ["a4"], m(16));
      save("l4", ["l3"], m(17));
      save("l5", ["l4"], m(18));
      save("m1", ["a4", "c3"], m(19));
      save("m2", ["c3", "a4"], m(20));
      save("alt_root", [], m(21));
      save("r0", ["alt_root"], m(22));
      save("r1", ["r0"], m(23));
      save("l5r1", ["l5", "r1"], m(24));
      save("r1l5", ["r1", "l5"], m(25));
      // the e/f/g commits: git's test gives them all 00:25; here each its own minute
      let t = 26;
      const e = (tag: string, parents: string[], email: string) =>
        save(tag, parents, m(t), m(t++), email);
      e("e1", [], "e@example.com");
      e("e2", ["e1"], "e@example.com");
      e("f1", ["e1"], "f@example.com");
      e("e3", ["e2"], "e@example.com");
      e("f2", ["f1"], "f@example.com");
      e("e4", ["e3", "f2"], "e@example.com");
      e("e5", ["e4"], "e@example.com");
      e("f3", ["f2"], "f@example.com");
      e("f4", ["f3"], "f@example.com");
      e("e6", ["e5", "f4"], "e@example.com");
      e("f5", ["f4"], "f@example.com");
      e("f6", ["f5", "e6"], "f@example.com");
      e("e7", ["e6"], "e@example.com");
      e("e8", ["e7"], "e@example.com");
      e("e9", ["e8"], "e@example.com");
      e("f7", ["f6"], "f@example.com");
      e("f8", ["f7"], "f@example.com");
      e("f9", ["f8"], "f@example.com");
      e("e10", ["e9", "f8"], "e@example.com");
      const g = (tag: string, parents: string[]) => save(tag, parents, m(t++));
      g("g0", []);
      g("g1", ["g0"]);
      g("h1", ["g0"]);
      g("g2", ["g1", "h1"]);
      g("h2", ["g2"]);
      g("g3", ["g2"]);
      g("g4", ["g3", "h2"]);
      git(repo, ["update-ref", "HEAD", ids.get("l5") as string]);
      // the same history with a commit-graph: native git walks a topo order incrementally
      graphRepo = join(root, "t6003-graph");
      cpSync(repo, graphRepo, { recursive: true });
      git(graphRepo, ["commit-graph", "write", "--reachable"]);
    });

    const cases: [string, string[]][] = [
      ["rev-list has correct number of entries", ["HEAD"]],
      ["simple topo order", ["--topo-order", "HEAD"]],
      ["simple date order", ["--date-order", "HEAD"]],
      ["simple author-date order", ["--author-date-order", "HEAD"]],
      ["two diamonds topo order (g6)", ["--topo-order", "g4"]],
      ["multiple heads", ["--topo-order", "a3", "b3", "c3"]],
      ["multiple heads, prune at a1", ["--topo-order", "a3", "b3", "c3", "^a1"]],
      ["multiple heads, prune at l1", ["--topo-order", "a3", "b3", "c3", "^l1"]],
      ["cross-epoch, head at l5, prune at l1", ["--topo-order", "l5", "^l1"]],
      ["duplicated head arguments", ["--topo-order", "l5", "l5", "^l1"]],
      ["prune near topo", ["--topo-order", "a4", "^c3"]],
      ["head has no parent", ["--topo-order", "root"]],
      ["two nodes - one head, one base", ["--topo-order", "l0"]],
      ["three nodes one head, one internal, one base", ["--topo-order", "l1"]],
      ["linear prune l2 ^root", ["--topo-order", "l2", "^root"]],
      ["linear prune l2 ^l0", ["--topo-order", "l2", "^l0"]],
      ["linear prune l2 ^l1", ["--topo-order", "l2", "^l1"]],
      ["linear prune l5 ^a4", ["--topo-order", "l5", "^a4"]],
      ["linear prune l5 ^l3", ["--topo-order", "l5", "^l3"]],
      ["linear prune l5 ^l4", ["--topo-order", "l5", "^l4"]],
      ["max-count 10 - topo order", ["--topo-order", "--max-count=10", "l5"]],
      ["max-count 10 - non topo order", ["--max-count=10", "l5"]],
      [
        "one specified head reachable from another a4, c3, --topo-order",
        ["--topo-order", "a4", "c3"],
      ],
      [
        "one specified head reachable from another c3, a4, --topo-order",
        ["--topo-order", "c3", "a4"],
      ],
      ["one specified head reachable from another a4, c3, no --topo-order", ["a4", "c3"]],
      ["one specified head reachable from another c3, a4, no --topo-order", ["c3", "a4"]],
      ["graph with c3 and a4 parents of head", ["m1"]],
      ["graph with a4 and c3 parents of head", ["m2"]],
      ["head ^head --topo-order", ["--topo-order", "a3", "^a3"]],
      ["head ^head no --topo-order", ["a3", "^a3"]],
      ["simple topo order (l5r1)", ["--topo-order", "l5r1"]],
      ["simple topo order (r1l5)", ["--topo-order", "r1l5"]],
      ["don't print things unreachable from one branch", ["a3", "^b3", "--topo-order"]],
      ["--topo-order a4 l3", ["--topo-order", "a4", "l3"]],
    ];

    for (const [title, args] of cases) {
      it(`t6003-rev-list-topo-order.sh: "${title}"`, async () => {
        await expectSame(repo, "rev-list", [args]);
        await expectSame(graphRepo, "rev-list", [args]);
      });
    }

    it("t6003's histories bisected: rev-list --bisect and --bisect-vars", async () => {
      const ranges = [
        ["HEAD"],
        ["l5", "^l1"],
        ["a4", "^c3"],
        ["a3", "b3", "c3", "^a1"],
        ["e10", "^e1"],
        ["g4", "^g0"],
        ["l5r1", "^root"],
        ["a3", "^a3"],
        ["l5", "--", "path0"],
      ];
      const all: string[][] = [];
      for (const r of ranges) {
        all.push(["--bisect", ...r], ["--bisect-vars", ...r]);
        all.push(["--bisect", "--first-parent", ...r], ["--bisect-vars", "--first-parent", ...r]);
      }
      await expectSame(repo, "rev-list", all);
    });

    it('t6003-rev-list-topo-order.sh: "--max-age=c3, no --topo-order", "--max-age=c3, --topo-order"', async () => {
      const c3 = git(repo, ["show", "-s", "--format=%ct", "c3"]);
      await expectSame(repo, "rev-list", [
        [`--max-age=${c3}`, "l5"],
        ["--topo-order", `--max-age=${c3}`, "l5"],
      ]);
    });

    it("t6003's histories in every order, reversed, and the e/f and g/h diamonds", async () => {
      const orders = [[], ["--topo-order"], ["--date-order"], ["--author-date-order"]];
      const heads = [
        ["HEAD"],
        ["e10"],
        ["f9", "e10"],
        ["g4"],
        ["l5r1", "^a4"],
        ["m1", "m2", "^b2"],
      ];
      const all: string[][] = [];
      for (const order of orders) {
        for (const head of heads) {
          all.push([...order, ...head], [...order, "--reverse", ...head]);
          all.push([...order, "--reverse", "--max-count=4", ...head]);
          all.push([...order, "--skip=3", "--max-count=5", ...head]);
        }
      }
      await expectSame(repo, "rev-list", all);
      await expectSame(graphRepo, "rev-list", all);
    });

    it("t6003's prunes with --boundary (rev-list's `-` lines, log's `- ` mark)", async () => {
      const ranges = [
        ["a3", "b3", "c3", "^a1"],
        ["a3", "b3", "c3", "^l1"],
        ["l5", "^l1"],
        ["a4", "^c3"],
        ["l5", "^a4"],
        ["a3", "^b3"],
        ["e10", "^e6", "^f4"],
        ["g4", "^g1"],
        ["m1", "m2", "^a3", "^c1"],
        ["l5r1", "^l4", "^r0"],
      ];
      const orders = [[], ["--topo-order"], ["--date-order"], ["--author-date-order"]];
      const all: string[][] = [];
      for (const order of orders)
        for (const r of ranges) {
          all.push(["--boundary", ...order, ...r], ["--boundary", "--reverse", ...order, ...r]);
          all.push(["--boundary", "--max-count=3", ...order, ...r]);
        }
      // cut by -n, --skip, --max-age and a filter: the parents shown as boundaries
      all.push(["--boundary", "-1", "l5"]);
      all.push(["--boundary", "--max-count=2", "l5r1"], ["--boundary", "--skip=2", "-3", "g4"]);
      all.push(
        ["--boundary", "--first-parent", "a4", "^l2"],
        ["--boundary", "--max-count=0", "l5"],
      );
      all.push(
        ["--boundary", "--grep=^a", "l5", "^l2"],
        ["--boundary", "--grep=^c", "--topo-order", "l5"],
      );
      await expectSame(repo, "rev-list", all);
      await expectSame(graphRepo, "rev-list", all);
      await expectSame(repo, "log", [
        ["--oneline", "--boundary", "a4", "^c3"],
        ["--oneline", "--boundary", "--topo-order", "a3", "b3", "c3", "^a1"],
        ["--boundary", "--format=%m %s", "l5r1", "^l4", "^r0"],
        ["--boundary", "a3", "^b3"],
        ["--oneline", "--boundary", "--reverse", "e10", "^e6", "^f4"],
        ["--oneline", "--boundary", "--source", "a4", "^c3"],
        ["--oneline", "--source", "--topo-order", "m1", "m2", "^b2"],
      ]);
    });
  });

  describe("t6017-rev-list-stdin", () => {
    let repo = "";
    beforeAll(() => {
      repo = join(root, "t6017");
      git(root, ["init", "-q", "-b", "main", repo]);
      const tick = ticker();
      const them = [1, 2, 3, 4, 5, 6, 7];
      for (const i of [0, ...them]) {
        for (const j of them) writeFileSync(join(repo, `file-${j}`), `${i}.${j}\n`);
        git(repo, ["add", "."]);
        git(repo, ["commit", "-qm", `${i}`], tick());
      }
      for (const i of them) {
        git(repo, ["checkout", "-qb", `side-${i}`, `main~${i}`]);
        writeFileSync(join(repo, `file-${i}`), `updated ${i}\n`);
        git(repo, ["add", `file-${i}`]);
        git(repo, ["commit", "-qm", `side-${i}`], tick());
      }
      git(repo, ["update-ref", "refs/heads/-dashed-branch", "HEAD"]);
    });

    const checks = [
      ["main"],
      ["side-1", "^side-4"],
      ["side-1", "^side-7", "--"],
      ["side-1", "^side-7", "--", "file-1"],
      ["side-1", "^side-7", "--", "file-2"],
      ["side-3", "^side-4", "--", "file-3"],
      ["side-3", "^side-2"],
      ["side-3", "^side-2", "--", "file-1"],
      ["--all"],
      ["--all", "--not", "--branches"],
      ["--glob=refs/heads"],
      ["--glob=refs/heads", "--"],
      ["--glob=refs/heads", "--", "file-1"],
      ["--end-of-options", "-dashed-branch"],
      ["--all", "--not", "refs/heads/main"],
    ];
    for (const args of checks) {
      it(`t6017-rev-list-stdin.sh: "check rev-list ${args.join(" ")}", "check log --stat ${args.join(" ")}"`, async () => {
        const stdin = args.map((a) => `${a}\n`).join("");
        await expectSame(repo, "rev-list", [args, { args: ["--stdin"], stdin }]);
        await expectSame(repo, "log", [
          ["--stat", ...args],
          { args: ["--stat", "--stdin"], stdin },
        ]);
      });
    }

    it('t6017-rev-list-stdin.sh: "not only --stdin"', async () => {
      await expectSame(repo, "log", [
        {
          args: ["--pretty=tformat:%s", "--name-only", "--stdin", "main", "--", "file-1"],
          stdin: "^main^\n--\nfile-2\n",
        },
      ]);
    });

    it('t6017-rev-list-stdin.sh: "pseudo-opt with missing value", "unknown option without --end-of-options"', async () => {
      await expectSame(repo, "rev-list", [
        { args: ["--stdin"], stdin: "--glob\nrefs/heads\n" },
        { args: ["--stdin"], stdin: "-dashed-branch\n" },
        { args: ["--stdin"], stdin: "nope\n" },
      ]);
    });

    it('t6017-rev-list-stdin.sh: "--not on command line does not influence revisions read via --stdin", "--not via stdin does not influence revisions from command line"', async () => {
      await expectSame(repo, "rev-list", [
        { args: ["refs/heads/main", "--not", "--stdin"], stdin: "refs/heads/main\n" },
        { args: ["refs/heads/main", "--stdin", "refs/heads/main"], stdin: "--not\n" },
      ]);
    });

    it("--stdin: an empty line ends it, CRLF lines, --exclude shared with the command line", async () => {
      await expectSame(repo, "rev-list", [
        { args: ["--stdin"], stdin: "side-1\n\nside-2\n" },
        { args: ["--stdin"], stdin: "side-1\r\n^side-3\r\n" },
        { args: ["--stdin", "--branches=side-*"], stdin: "--exclude=side-[1-5]\n" },
        { args: ["--stdin"], stdin: "--tags\n--branches=side-2\n--not\nmain~3\n" },
        { args: ["--stdin"], stdin: "side-4" },
      ]);
      await expectSame(repo, "log", [
        { args: ["--oneline", "--stdin"], stdin: "" },
        { args: ["--oneline", "--stdin"], stdin: "--not\n" },
      ]);
    });
  });

  describe("t6000-rev-list-misc", () => {
    let repo = "";
    beforeAll(() => {
      repo = join(root, "t6000");
      git(root, ["init", "-q", "-b", "main", repo]);
      const tick = ticker();
      writeFileSync(join(repo, "wanted_file"), "content1\n");
      writeFileSync(join(repo, "unwanted_file"), "content2\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-qm", "one"], tick());
      git(repo, ["commit", "-q", "--allow-empty", "-m", "another"], tick());
      git(repo, ["tag", "-a", "-m", "annotated", "v1.0"], tick());
      git(repo, ["update-ref", "refs/heads/--output=yikes", "HEAD"]);
    });

    it('t6000-rev-list-misc.sh: "rev-list A..B and rev-list ^A B are the same", "rev-list --end-of-options"', async () => {
      await expectSame(repo, "rev-list", [
        ["^v1.0^", "v1.0"],
        ["v1.0^..v1.0"],
        ["--end-of-options", "--output=yikes"],
        ["--boundary", "v1.0^..v1.0"],
        ["--boundary", "HEAD~.."],
      ]);
    });

    it('t6000-rev-list-misc.sh: "--bisect and --first-parent can be combined"', async () => {
      await expectSame(repo, "rev-list", [["--bisect", "--first-parent", "HEAD"]]);
    });
  });

  describe("t4202-log", () => {
    let repo = "";
    beforeAll(() => {
      repo = join(root, "t4202");
      git(root, ["init", "-q", "-b", "main", repo]);
      const tick = ticker();
      const testCommit = (name: string) => {
        writeFileSync(join(repo, `${name}.t`), `${name}\n`);
        git(repo, ["add", `${name}.t`]);
        git(repo, ["commit", "-qm", name], tick());
        git(repo, ["tag", name], tick());
      };
      git(repo, ["checkout", "-q", "--orphan", "source-a"]);
      testCommit("one");
      testCommit("two");
      git(repo, ["checkout", "-qb", "source-b", "HEAD^"]);
      testCommit("three");
      git(repo, ["tag", "-m", "tagged", "source-tag"], tick());
    });

    it('t4202-log.sh: "log --source paints branch names", "log --source paints tag names", "log --source paints symmetric ranges"', async () => {
      await expectSame(repo, "log", [
        ["--oneline", "--source", "source-a", "source-b"],
        ["--oneline", "--source", "source-tag", "source-a"],
        ["--oneline", "--source", "source-a...source-b"],
        ["--source", "source-a", "source-b"],
        ["--format=%h %S %s", "source-a", "source-b"],
        ["--oneline", "--source", "--boundary", "source-a..source-b"],
      ]);
    });

    it('t4202-log.sh: "log does not default to HEAD when rev input is given", "--reverse and --graph conflict"', async () => {
      await expectSame(repo, "log", [["--branches=does-not-exist"]]);
      const n = native(repo, "log", ["--reverse", "--graph"]);
      const o = await ours(repo, "log", ["--reverse", "--graph"]);
      // the two names come in another order in 2.43 than in 2.5x
      expect(o.status).toBe(n.status);
      expect(o.err).toMatch(/options '--(graph|reverse)' and '--(graph|reverse)' cannot be used/);
    });
  });

  describe("t6112-rev-list-filters-objects", () => {
    it('t6112-rev-list-filters-objects.sh: "setup r1" (the commits, in every order and with their boundaries)', async () => {
      const repo = join(root, "t6112");
      git(root, ["init", "-q", "-b", "main", repo]);
      const tick = ticker();
      for (const n of [1, 2, 3, 4, 5]) {
        writeFileSync(join(repo, "large"), "x".repeat(n * 10));
        git(repo, ["add", "large"]);
        git(repo, ["commit", "-qm", `large-${n}`], tick());
      }
      await expectSame(repo, "rev-list", [
        ["HEAD"],
        ["--reverse", "HEAD"],
        ["--boundary", "HEAD~2.."],
        ["--topo-order", "--boundary", "--reverse", "HEAD~3..HEAD~1"],
      ]);
    });
  });

  describe("JGit RevWalkSortTest", () => {
    /** One history per test: JGit's commit(delta, parents) ticks the clock by delta seconds */
    function history(name: string, build: (commit: CommitFn) => void): string {
      const repo = join(root, `jgit-${name}`);
      git(root, ["init", "-q", "-b", "main", repo]);
      writeFileSync(join(repo, "f"), "f\n");
      git(repo, ["update-index", "--add", "f"]);
      let clock = 1250379778;
      build((tag, parents, delta = 1) => {
        clock += delta;
        const id = commitTree(
          repo,
          tag,
          parents.map((p) => git(repo, ["rev-parse", `refs/tags/${p}`])),
          clock,
        );
        git(repo, ["update-ref", `refs/tags/${tag}`, id]);
      });
      return repo;
    }
    type CommitFn = (tag: string, parents: string[], delta?: number) => void;
    const sorts = [[], ["--date-order"], ["--topo-order"], ["--author-date-order"]];
    const reversed = sorts.flatMap((s) => [s, [...s, "--reverse"], [...s, "--boundary"]]);

    async function check(repo: string, ...revisions: string[][]): Promise<void> {
      const all: string[][] = [];
      for (const r of revisions) for (const s of reversed) all.push([...s, ...r]);
      await expectSame(repo, "rev-list", all);
    }

    const linear = (c: CommitFn) => {
      c("a", []);
      c("b", ["a"]);
      c("c", ["b"]);
      c("d", ["c"]);
    };
    const backdated = (c: CommitFn) => {
      c("a", []);
      c("b", ["a"]);
      c("c1", ["b"], -5);
      c("c2", ["b"], 10);
      c("d", ["c1", "c2"]);
    };

    it("RevWalkSortTest.testSort_Default, testSort_COMMIT_TIME_DESC, testSort_REVERSE", async () => {
      await check(history("default", linear), ["d"]);
    });

    it("RevWalkSortTest.testSort_COMMIT_TIME_DESC_OutOfOrder1", async () => {
      const repo = history("out-of-order1", (c) => {
        c("a", []);
        c("b", ["a"]);
        c("c", ["b"], -5);
        c("d", ["c"], 10);
      });
      await check(repo, ["d"]);
    });

    it("RevWalkSortTest.testSort_COMMIT_TIME_DESC_OutOfOrder2, testSort_TOPO, testSort_TOPO_REVERSE, testSort_TOPO_reachable, testSort_TOPO_reachable2", async () => {
      await check(history("out-of-order2", backdated), ["d"], ["d", "^b"], ["d", "^d"]);
    });

    it("RevWalkSortTest.testSort_TOPO_NON_INTERMIX, testSort_TOPO_NON_INTERMIX_REVERSE (as --topo-order)", async () => {
      await check(history("non-intermix", backdated), ["d"]);
    });

    it("RevWalkSortTest.testSort_TOPO_NON_INTERMIX_OutOfOrderCommitTimes (as --topo-order)", async () => {
      const repo = history("non-intermix-ooo", (c) => {
        c("a", []);
        c("c1", ["a"]);
        c("b", ["a"]);
        c("c2", ["c1"]);
        c("d", ["b", "c2"]);
      });
      await check(repo, ["d"], ["d", "^c1"]);
    });

    it("RevWalkSortTest.testSort_TOPO_NON_INTERMIX_MultipleLinesOfHistory, testSort_TOPO_NON_INTERMIX_REVERSE_MultipleLinesOfHistory (as --topo-order)", async () => {
      const repo = history("multiple-lines", (c) => {
        c("a1", []);
        c("b1", ["a1"]);
        c("a2", ["a1", "b1"]);
        c("b2", ["b1"]);
        c("b3", ["b1"]);
        c("a3", ["a2", "b2"]);
        c("a4", ["a3", "b3"]);
      });
      await check(repo, ["a4"], ["a4", "^b1"], ["a4", "^a2"]);
    });

    it("RevWalkSortTest.testSort_TOPO_NON_INTERMIX_ParentOfMultipleStartChildren (as --topo-order)", async () => {
      const repo = history("multiple-starts", (c) => {
        c("a", []);
        c("b", ["a"]);
        c("c", ["a"]);
        c("d1", ["a"]);
        c("d2", ["d1"]);
        c("e", ["a"]);
      });
      await check(repo, ["b", "c", "d2", "e"], ["e", "d2", "c", "b"], ["b", "c", "d2", "e", "^a"]);
    });

    it("RevWalkSortTest.testSort_TOPO_NON_INTERMIX_Uninteresting (as --topo-order)", async () => {
      const repo = history("uninteresting", (c) => {
        c("a1", []);
        c("a2", ["a1"]);
        c("a3", ["a2"]);
        c("b", ["a1"]);
        c("a4", ["a3", "b"]);
      });
      await check(repo, ["a4", "^a2"], ["a4", "^b"]);
    });
  });
});
