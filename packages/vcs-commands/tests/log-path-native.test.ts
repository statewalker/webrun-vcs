/**
 * `git log -- <path>` against native git: history simplification as revision.c does it
 * (TREESAME commits hidden, a merge followed only to the parent it matches, commits in date
 * order with ties in queue order), and the changed-path Bloom filters of the commit-graph
 * asked before trees are compared. The repository is built with `git fast-import` (dates,
 * merges, a file that becomes a directory, a mode change, a deletion and re-addition, a
 * symlink, a non-ASCII name); each path's `git log --format=%H` must be what `LogCommand`
 * yields, without a graph and with one that has filters, and with filters the counts of
 * git's trace2 `bloom/statistics` must be ours. A last test guards the speed-up by counting
 * tree reads with and without the filters.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, type LogCommand } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** A fast-import stream: three branches with merges, every kind of change the walk compares. */
function history(): string {
  const out: string[] = [];
  let mark = 0;
  let time = 1500000000;
  const data = (s: string) => {
    out.push(`data ${Buffer.byteLength(s)}\n${s}\n`);
  };
  const commit = (
    ref: string,
    message: string,
    changes: string[],
    opts: { from?: number; merge?: number[]; sameDate?: boolean } = {},
  ): number => {
    if (!opts.sameDate) time += 100;
    out.push(`commit ${ref}\nmark :${++mark}\n`);
    out.push(`author A U Thor <a@example.com> ${time} +0000\n`);
    out.push(`committer C O Mitter <c@example.com> ${time} +0000\n`);
    data(`${message}\n`);
    if (opts.from) out.push(`from :${opts.from}\n`);
    for (const m of opts.merge ?? []) out.push(`merge :${m}\n`);
    for (const c of changes) {
      if (c.startsWith("D ")) out.push(`${c}\n`);
      else {
        const [mode, path, content] = c.split("|") as [string, string, string];
        out.push(`M ${mode} inline ${path}\n`);
        data(content);
      }
    }
    out.push("\n");
    return mark;
  };
  const f = (path: string, content: string, mode = "100644") => `${mode}|${path}|${content}`;
  let main = commit("refs/heads/main", "root", [
    f("README", "readme\n"),
    f("src/a.txt", "a0\n"),
    f("src/lib/b.txt", "b0\n"),
    f("doc/guide.txt", "g0\n"),
    f("node", "a file at first\n"),
  ]);
  for (let i = 1; i <= 6; i++) {
    main = commit("refs/heads/main", `main ${i}`, [f(`src/a.txt`, `a${i}\n`)], { from: main });
  }
  // a side branch changing src/lib, merged back: the merge matches its second parent there
  let side = commit("refs/heads/side", "side 1", [f("src/lib/b.txt", "b-side1\n")], {
    from: main - 3,
  });
  side = commit("refs/heads/side", "side 2", [f("src/lib/c.txt", "c-side\n")], { from: side });
  main = commit("refs/heads/main", "main touches doc", [f("doc/guide.txt", "g1\n")], {
    from: main,
  });
  main = commit("refs/heads/main", "merge side", [], { from: main, merge: [side] });
  // an evil merge: different from both parents at src/lib/b.txt
  let topic = commit("refs/heads/topic", "topic 1", [f("src/lib/b.txt", "b-topic\n")], {
    from: main,
  });
  main = commit("refs/heads/main", "main changes b", [f("src/lib/b.txt", "b-main\n")], {
    from: main,
  });
  main = commit("refs/heads/main", "evil merge", [f("src/lib/b.txt", "b-evil\n")], {
    from: main,
    merge: [topic],
  });
  // a file becomes a directory, a mode change, a symlink, a deletion and re-addition
  main = commit("refs/heads/main", "node becomes a directory", ["D node", f("node/x", "x\n")], {
    from: main,
  });
  main = commit("refs/heads/main", "make a.txt executable", [f("src/a.txt", "a6\n", "100755")], {
    from: main,
  });
  main = commit("refs/heads/main", "link", [f("src/link", "a.txt", "120000")], { from: main });
  main = commit("refs/heads/main", "remove doc", ["D doc/guide.txt"], { from: main });
  main = commit("refs/heads/main", "doc back", [f("doc/guide.txt", "g2\n")], { from: main });
  main = commit("refs/heads/main", "non-ascii", [f("doc/café.txt", "café\n")], {
    from: main,
  });
  // commits of one date on two branches merged: ties come out in queue order
  topic = commit("refs/heads/topic", "topic 2", [f("src/a.txt", "a-topic\n")], { from: main });
  const tie = commit("refs/heads/topic", "topic 3", [f("README", "readme 2\n")], {
    from: topic,
    sameDate: false,
  });
  main = commit("refs/heads/main", "main same date", [f("src/a.txt", "a-main\n")], {
    from: main,
    sameDate: true,
  });
  main = commit("refs/heads/main", "merge topic", [f("src/a.txt", "a-merged\n")], {
    from: main,
    merge: [tie],
  });
  for (let i = 0; i < 40; i++) {
    main = commit("refs/heads/main", `filler ${i}`, [f(`src/gen/g${i % 7}.txt`, `${i}\n`)], {
      from: main,
    });
  }
  return out.join("");
}

const PATHS = [
  "src/a.txt",
  "src/lib/b.txt",
  "src/lib",
  "src/lib/",
  "src",
  "doc/guide.txt",
  "doc/café.txt",
  "node",
  "node/x",
  "src/link",
  "README",
  "src/gen/g3.txt",
  "missing/path",
];

describeGit("log -- <path> against native git", () => {
  let root: string;
  let dir: string;
  const env = () => nativeGitEnv(root);
  const git = (args: string[], extraEnv: Record<string, string> = {}, input?: string) =>
    execFileSync("git", args, {
      cwd: dir,
      env: { ...env(), ...extraEnv },
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "log-path-native-"));
    dir = join(root, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", dir], { env: env() });
    git(["fast-import", "--quiet"], {}, history());
    git(["checkout", "-q", "main"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function open(): Promise<Git> {
    const files = createNodeFilesApi({ rootDir: dir });
    const environment = createNodeGitHostEnvironment({ env: env() });
    const { history } = await createGitFilesBackend({ files });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
    return Git.fromWorkingCopy(await worktrees.openCurrent());
  }

  async function ours(
    paths: string[],
    configure: (c: LogCommand) => LogCommand = (c) => c,
  ): Promise<{ ids: string[]; command: LogCommand }> {
    let command = (await open()).log();
    for (const p of paths) command = command.addPath(p);
    command = configure(command);
    const ids: string[] = [];
    for await (const c of await command.call()) ids.push(c.id);
    return { ids, command };
  }

  const native = (paths: string[], args: string[] = []) =>
    git(["log", "--format=%H", ...args, "--", ...paths])
      .split("\n")
      .filter(Boolean);

  /** git's trace2 bloom statistics of a `git log`. */
  function nativeBloom(paths: string[], args: string[] = []) {
    const trace = join(root, "trace2.json");
    rmSync(trace, { force: true });
    git(["log", "--format=%H", ...args, "--", ...paths], { GIT_TRACE2_EVENT: trace });
    const line = readFileSync(trace, "utf8")
      .split("\n")
      .find((l) => l.includes('"category":"bloom"') && l.includes('"key":"statistics"'));
    const value = line ? JSON.parse(line).value : undefined;
    return typeof value === "string" ? JSON.parse(value) : value;
  }

  /** Whether native git asks a root commit's filter (rev_same_tree_as_empty; not in 2.43). */
  function rootFilters(): boolean {
    const m = /(\d+)\.(\d+)/.exec(git(["--version"]));
    return !!m && (Number(m[1]) > 2 || Number(m[2]) >= 50);
  }

  function removeGraph() {
    rmSync(join(dir, ".git/objects/info/commit-graph"), { force: true });
    rmSync(join(dir, ".git/objects/info/commit-graphs"), { recursive: true, force: true });
  }

  it("lists what native git lists, without a commit-graph", async () => {
    removeGraph();
    for (const path of PATHS) {
      expect([path, (await ours([path])).ids]).toEqual([path, native([path])]);
    }
    const two = ["src/lib/c.txt", "doc"];
    expect((await ours(two)).ids).toEqual(native(two));
    expect((await ours(["src/a.txt"], (c) => c.setFirstParent(true))).ids).toEqual(
      native(["src/a.txt"], ["--first-parent"]),
    );
  });

  it("lists the same with changed-path filters, with git's Bloom statistics", async () => {
    removeGraph();
    git(["commit-graph", "write", "--reachable", "--changed-paths"]);
    for (const path of PATHS) {
      const { ids, command } = await ours([path]);
      expect([path, ids]).toEqual([path, native([path])]);
      const s = command.getStatistics();
      const n = nativeBloom([path]);
      const mine = [s.bloomNotPresent, s.bloomMaybe, s.bloomDefinitelyNot, s.bloomFalsePositive];
      const theirs = [n.filter_not_present, n.maybe, n.definitely_not, n.false_positive];
      if (rootFilters()) {
        expect([path, ...mine]).toEqual([path, ...theirs]);
      } else {
        // git before 2.5x compares a root commit with the empty tree without its filter: one
        // check less (a "maybe" or a "definitely not"), all else the same
        expect([path, s.bloomNotPresent, s.bloomFalsePositive]).toEqual([
          path,
          n.filter_not_present,
          n.false_positive,
        ]);
        expect([path, s.bloomMaybe + s.bloomDefinitelyNot]).toEqual([
          path,
          n.maybe + n.definitely_not + 1,
        ]);
        expect(s.bloomMaybe - n.maybe === 1 || s.bloomDefinitelyNot - n.definitely_not === 1).toBe(
          true,
        );
      }
    }
    const two = ["src/lib/c.txt", "doc"];
    expect((await ours(two)).ids).toEqual(native(two));
  });

  it("reads far fewer trees with the filters (counted, not timed)", async () => {
    removeGraph();
    git(["commit-graph", "write", "--reachable", "--changed-paths"]);
    const path = "src/lib/b.txt";
    const withFilters = await ours([path]);
    const without = await ours([path], (c) => c.setUseBloomFilters(false));
    expect(withFilters.ids).toEqual(without.ids);
    const a = withFilters.command.getStatistics();
    const b = without.command.getStatistics();
    // every first-parent comparison of a commit that did not touch the path is settled by
    // its filter: only the few that did (and merges' other parents) read trees
    expect(a.bloomDefinitelyNot).toBeGreaterThan(50);
    expect(b.bloomDefinitelyNot).toBe(0);
    expect(a.treeComparisons).toBeLessThan(b.treeComparisons / 5);
    expect(a.treeEntryReads).toBeLessThan(b.treeEntryReads / 5);
  });

  /** git's version as [major, minor]. */
  function gitVersion(): [number, number] {
    const m = /(\d+)\.(\d+)/.exec(git(["--version"]));
    return m ? [Number(m[1]), Number(m[2])] : [0, 0];
  }

  it("treats filters of another commitGraph.changedPathsVersion as not there", async () => {
    const [major, minor] = gitVersion();
    // the setting is read (and written) by git 2.46 and later
    if (major === 2 && minor < 46) return;
    removeGraph();
    git([
      "-c",
      "commitGraph.changedPathsVersion=2",
      "commit-graph",
      "write",
      "--reachable",
      "--changed-paths",
    ]);
    try {
      git(["config", "commitGraph.changedPathsVersion", "1"]);
      for (const path of ["src/lib/b.txt", "doc"]) {
        const { ids, command } = await ours([path]);
        expect([path, ids]).toEqual([path, native([path])]);
        const s = command.getStatistics();
        const n = nativeBloom([path]);
        expect([path, s.bloomNotPresent, s.bloomMaybe, s.bloomDefinitelyNot]).toEqual([
          path,
          n.filter_not_present,
          n.maybe,
          n.definitely_not,
        ]);
        expect(s.bloomNotPresent).toBeGreaterThan(50);
      }
    } finally {
      git(["config", "--unset", "commitGraph.changedPathsVersion"]);
    }
  });

  it("fails as git does on a missing tree or parent", async () => {
    const saved = dir;
    dir = join(root, "broken");
    try {
      execFileSync("git", ["init", "-q", "-b", "main", dir], { env: env() });
      const write = (content: string) => git(["hash-object", "-w", "--stdin"], {}, content).trim();
      const commitWith = (files: Record<string, string>, parent?: string) => {
        const lines = Object.entries(files).map(([p, c]) => `100644 blob ${write(c)}\t${p}`);
        // one directory level: "d/x" goes into a tree of its own
        const top = lines.filter((l) => !l.includes("\td/"));
        const inD = lines.filter((l) => l.includes("\td/")).map((l) => l.replace("\td/", "\t"));
        if (inD.length)
          top.push(`040000 tree ${git(["mktree"], {}, `${inD.join("\n")}\n`).trim()}\td`);
        const tree = git(["mktree"], {}, `${top.join("\n")}\n`).trim();
        return git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "c"]).trim();
      };
      const c1 = commitWith({ a: "a\n", "d/x": "1\n" });
      const c2 = commitWith({ a: "a\n", "d/x": "2\n" }, c1);
      const c3 = commitWith({ a: "3\n", "d/x": "2\n" }, c2);
      git(["update-ref", "refs/heads/main", c3]);
      const loose = (id: string) => join(dir, ".git/objects", id.slice(0, 2), id.slice(2));
      const nativeError = (path: string) => {
        try {
          native([path]);
        } catch (e) {
          return String((e as { stderr?: string }).stderr);
        }
        return "";
      };
      const oursError = async (path: string) => {
        try {
          await ours([path]);
        } catch (e) {
          return (e as Error).message;
        }
        return "";
      };

      const tree = git(["rev-parse", `${c1}:d`]).trim();
      const treeFile = loose(tree);
      const treeBytes = readFileSync(treeFile);
      rmSync(treeFile);
      // git 2.43 says "unable to read tree <id>", 2.5x "unable to read tree (<id>)"
      expect(nativeError("d/x")).toMatch(new RegExp(`fatal: unable to read tree \\(?${tree}`));
      expect(await oursError("d/x")).toBe(`unable to read tree (${tree})`);
      writeFileSync(treeFile, treeBytes);

      rmSync(loose(c2));
      const message = `cannot simplify commit ${c3} (because of ${c2})`;
      expect(nativeError("a")).toContain(`fatal: ${message}`);
      expect(await oursError("a")).toBe(message);
    } finally {
      dir = saved;
    }
  });

  it("hides an empty root for `.` and `:/`, and refuses an empty pathspec, as git does", async () => {
    const saved = dir;
    dir = join(root, "empty-root");
    try {
      execFileSync("git", ["init", "-q", "-b", "main", dir], { env: env() });
      git(["commit", "-q", "--allow-empty", "-m", "root"]);
      writeFileSync(join(dir, "a"), "a\n");
      git(["add", "a"]);
      git(["commit", "-q", "-m", "a"]);
      for (const path of [".", ":/", "*"]) {
        expect([path, (await ours([path])).ids]).toEqual([path, native([path])]);
      }
      expect(native(["."])).toHaveLength(1);
      await expect(ours([""])).rejects.toThrow("empty string is not a valid pathspec");
    } finally {
      dir = saved;
    }
  });

  it("matches paths that are no UTF-8 by their bytes, as git does", async () => {
    const saved = dir;
    dir = join(root, "raw-names");
    try {
      execFileSync("git", ["init", "-q", "-b", "main", dir], { env: env() });
      // a stream with raw name bytes (n\xffx, d\xfe/f) and a UTF-8 neighbour; each commit
      // continues the branch
      const parts: Buffer[] = [];
      let time = 1500000000;
      const commit = (message: string, path: Buffer, content: string) => {
        time += 100;
        parts.push(Buffer.from(`commit refs/heads/main\n`));
        parts.push(Buffer.from(`committer C O Mitter <c@example.com> ${time} +0000\n`));
        parts.push(Buffer.from(`data ${message.length}\n${message}\n`));
        parts.push(Buffer.from("M 100644 inline "), path, Buffer.from("\n"));
        parts.push(Buffer.from(`data ${content.length}\n${content}\n\n`));
      };
      const nx = Buffer.from([0x6e, 0xff, 0x78]);
      const df = Buffer.from([0x64, 0xfe, 0x2f, 0x66]);
      commit("root", Buffer.from("README"), "r\n");
      commit("nx 1", nx, "1\n");
      commit("df 1", df, "1\n");
      commit("other", Buffer.from("n\u00ffx"), "u\n");
      commit("nx 2", nx, "2\n");
      commit("df 2", df, "2\n");
      execFileSync("git", ["fast-import", "--quiet"], {
        cwd: dir,
        env: env(),
        input: Buffer.concat(parts),
      });
      git(["checkout", "-q", "main"]);
      // native git takes the raw bytes through the shell (argv cannot carry them from Node)
      const octal = (b: Buffer) =>
        [...b].map((x) => `\\${x.toString(8).padStart(3, "0")}`).join("");
      const nativeRaw = (path: Buffer) =>
        execFileSync("sh", ["-c", `git log --format=%H -- "$(printf '${octal(path)}')"`], {
          cwd: dir,
          env: env(),
          encoding: "utf8",
        })
          .split("\n")
          .filter(Boolean);
      const cases = [
        nx,
        Buffer.concat([Buffer.from(":(literal)"), nx]),
        Buffer.from([0x64, 0xfe]),
        df,
        Buffer.concat([Buffer.from(":(literal)"), df]),
        Buffer.from("n\u00ffx"),
      ];
      for (const path of cases) {
        const expected = nativeRaw(path);
        expect(expected.length).toBeGreaterThan(0);
        const label = path.toString("hex");
        expect([label, (await ours([decodeGitPath(path)])).ids]).toEqual([label, expected]);
      }
    } finally {
      dir = saved;
    }
  });
});
