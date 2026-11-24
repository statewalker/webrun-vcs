/**
 * `git blame --reverse` (the last commit each line of an old version existed in) and
 * `--first-parent` against native git, byte for byte: t8009-blame-vs-topicbranches.sh, the
 * histories of JGit's BlameCommandTest and BlameGeneratorTest blamed in reverse, then random
 * histories with merges, renames and moved lines blamed in reverse from random commits.
 *
 * `BLAME_REV_SEEDS` sets the number of random histories (default 30), `BLAME_REV_SHOW` how
 * many mismatches to print.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { compareBlame, git as nativeGit, open, prng, tickEnv } from "./blame-native-support.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;
const SEEDS = Number(process.env.BLAME_REV_SEEDS ?? 30);
const SHOW = Number(process.env.BLAME_REV_SHOW ?? 3);

let root: string | undefined;
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
const tmp = () => {
  root ??= mkdtempSync(join(tmpdir(), "blame-reverse-native-"));
  return root;
};
const git = (cwd: string, args: string[], input?: string, env?: Record<string, string>) =>
  nativeGit(tmp(), cwd, args, input, env);

const ALL_FORMATS = [["--porcelain"], ["--line-porcelain"], [], ["-n", "-f"]];

function check(mismatches: string[]): void {
  for (const m of mismatches.slice(0, SHOW)) console.log(m);
  expect(mismatches).toEqual([]);
}

function scenario(name: string) {
  const dir = join(tmp(), name);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "master"]);
  let tick = 0;
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message: string) => {
    git(dir, ["add", "-A"]);
    git(
      dir,
      ["commit", "-q", "--allow-empty", "-m", message],
      undefined,
      tickEnv("A U Thor", ++tick),
    );
    return git(dir, ["rev-parse", "HEAD"]);
  };
  const lines = (...ls: string[]) => ls.map((l) => `${l}\n`).join("");
  const compare = async (path: string, args: string[], formats = ALL_FORMATS) =>
    compareBlame(tmp(), dir, await open(dir), path, args, { formats });
  const nextTick = () => ++tick;
  return { dir, write, commit, lines, compare, nextTick, git: (args: string[]) => git(dir, args) };
}

describeGit("git blame --reverse against native git", () => {
  it('t8009-blame-vs-topicbranches.sh: "setup", "blame --reverse --first-parent finds A1"', async () => {
    const s = scenario("t8009");
    // test_commit <name> [<file> [<contents>]]: file defaults to <name>.t, contents to <name>
    const testCommit = (name: string, file = `${name}.t`, contents = name) => {
      s.write(file, `${contents}\n`);
      s.commit(name);
      s.git(["tag", name]);
    };
    const testMerge = (name: string, other: string) => {
      git(s.dir, ["merge", "-q", "-m", name, other], undefined, tickEnv("A U Thor", s.nextTick()));
      s.git(["tag", name]);
    };
    testCommit("A0", "file.t", "line0");
    testCommit("A1");
    s.git(["reset", "-q", "--hard", "A0"]);
    testCommit("B1");
    testCommit("B2", "file.t", "line0changed");
    s.git(["reset", "-q", "--hard", "A1"]);
    testMerge("A2", "B2");
    s.git(["reset", "-q", "--hard", "A1"]);
    testCommit("C1");
    s.git(["reset", "-q", "--hard", "A2"]);
    testMerge("A3", "C1");
    const m: string[] = [];
    m.push(...(await s.compare("file.t", ["--reverse", "A0..A3", "--first-parent"])));
    m.push(...(await s.compare("file.t", ["--reverse", "A0..A3"])));
    m.push(...(await s.compare("file.t", ["--reverse", "A0"])));
    m.push(...(await s.compare("file.t", ["--reverse", "A1..A3"])));
    m.push(...(await s.compare("file.t", ["--first-parent"])));
    m.push(...(await s.compare("A1.t", ["--reverse", "A1..A3", "--first-parent"])));
    check(m);
    const ours = await open(s.dir);
    const r = await ours
      .blame()
      .setFilePath("file.t")
      .setReverse(s.git(["rev-parse", "A0"]))
      .setStartCommit(s.git(["rev-parse", "A3"]))
      .setFirstParent(true)
      .call();
    expect(r.entries[0].commitId).toBe(s.git(["rev-parse", "A1"]));
    // a range off the first-parent chain is refused as git refuses it
    await expect(
      (await open(s.dir))
        .blame()
        .setFilePath("file.t")
        .setReverse(s.git(["rev-parse", "B1"]))
        .setStartCommit(s.git(["rev-parse", "A3"]))
        .setFirstParent(true)
        .call(),
    ).rejects.toThrow("--reverse --first-parent together require range along first-parent chain");
  }, 60_000);

  it("BlameCommandTest: testTwoRevisions, testRename, testTwoRenames, testDeleteTrailingLines, testDeleteMiddleLines, testEditAllLines, testMiddleClearAllLines, testConflictingMerge1 (reverse)", async () => {
    const m: string[] = [];
    // testTwoRevisions
    let s = scenario("two");
    s.write("file.txt", s.lines("first", "second"));
    s.commit("create file");
    s.write("file.txt", s.lines("first", "third"));
    s.commit("create file");
    m.push(...(await s.compare("file.txt", ["--reverse", "HEAD~1"])));
    // testRename, testTwoRenames
    s = scenario("rename");
    s.write("0.txt", s.lines("a", "b", "c"));
    s.commit("create file");
    s.git(["mv", "0.txt", "1.txt"]);
    s.write("1.txt", s.lines("a", "b", "c", "d"));
    s.commit("moving file");
    s.git(["mv", "1.txt", "2.txt"]);
    s.write("2.txt", s.lines("a", "B", "c", "d", "e"));
    s.commit("moving file again");
    m.push(...(await s.compare("0.txt", ["--reverse", "HEAD~2"])));
    m.push(...(await s.compare("1.txt", ["--reverse", "HEAD~1"])));
    // testDeleteTrailingLines, testDeleteMiddleLines
    s = scenario("delete");
    s.write("file.txt", s.lines("a", "b", "c", "d", "e"));
    s.commit("edit file");
    s.write("file.txt", s.lines("a", "c", "e"));
    s.commit("edit file");
    s.write("file.txt", s.lines("a", "c"));
    s.commit("edit file");
    s.write("file.txt", s.lines("a", "c", "x", "y"));
    s.commit("edit file");
    m.push(...(await s.compare("file.txt", ["--reverse", "HEAD~3"])));
    m.push(...(await s.compare("file.txt", ["--reverse", "HEAD~3..HEAD~1"])));
    m.push(...(await s.compare("file.txt", ["--reverse", "HEAD~2", "-L2,3"])));
    // testEditAllLines, testMiddleClearAllLines
    s = scenario("edit-all");
    s.write("file.txt", s.lines("a", "1"));
    s.commit("edit file");
    s.write("file.txt", s.lines("b", "2"));
    s.commit("edit file");
    s.write("file.txt", "");
    s.commit("clear file");
    s.write("file.txt", s.lines("a", "1"));
    s.commit("edit file");
    m.push(...(await s.compare("file.txt", ["--reverse", "HEAD~3"])));
    m.push(...(await s.compare("file.txt", ["--reverse", "HEAD~3", "--root"])));
    // testConflictingMerge1
    s = scenario("merge");
    s.write("file.txt", s.lines("0", "1", "2", "3", "4"));
    s.commit("0-4");
    s.git(["checkout", "-q", "-b", "side"]);
    s.write("file.txt", s.lines("0", "1 side", "2", "3 on side", "4"));
    s.commit("side");
    s.git(["checkout", "-q", "master"]);
    s.write("file.txt", s.lines("0", "1 master", "2", "3", "4"));
    s.commit("master");
    git(s.dir, ["merge", "-q", "--no-commit", "-s", "ours", "side"], undefined, tickEnv("M", 30));
    s.write("file.txt", s.lines("0", "1 master", "2", "3 on side", "4"));
    s.commit("merge");
    m.push(...(await s.compare("file.txt", ["--reverse", "HEAD~2"])));
    m.push(...(await s.compare("file.txt", ["--reverse", "HEAD~2", "--first-parent"])));
    check(m);
  }, 120_000);

  it("BlameGeneratorTest: testBoundLineDelete, testRenamedBoundLineDelete, testLinesAllDeletedShortenedWalk (reverse)", async () => {
    const m: string[] = [];
    let s = scenario("bound");
    s.write("file.txt", s.lines("first", "second"));
    s.commit("create file");
    s.write("file.txt", s.lines("third", "first", "second"));
    s.commit("create file");
    m.push(...(await s.compare("file.txt", ["--reverse", "HEAD~1"])));
    s = scenario("renamed-bound");
    s.write("subdir/file1.txt", s.lines("first", "second"));
    s.commit("create file1");
    s.git(["mv", "subdir/file1.txt", "subdir/file2.txt"]);
    s.commit("rename file1.txt to file2.txt");
    s.write("subdir/file2.txt", s.lines("third", "first", "second"));
    s.commit("change file2");
    m.push(...(await s.compare("subdir/file1.txt", ["--reverse", "HEAD~2"])));
    m.push(...(await s.compare("subdir/file2.txt", ["--reverse", "HEAD~1"])));
    s = scenario("shortened");
    s.write("file.txt", s.lines("first", "second", "third"));
    s.commit("create file");
    s.write("file.txt", s.lines(""));
    s.commit("create file");
    s.write("file.txt", s.lines("first", "second", "third"));
    s.commit("create file");
    m.push(...(await s.compare("file.txt", ["--reverse", "HEAD~2"])));
    m.push(...(await s.compare("file.txt", ["--reverse", "HEAD~1"])));
    check(m);
  }, 60_000);
});

/** A random history of a few files: edits, moved blocks, renames, branches and merges */
function buildHistory(dir: string, seed: number): { ids: string[]; paths: Map<string, string[]> } {
  const r = prng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  let counter = 0;
  const line = () =>
    r() < 0.2 ? pick(["}", "", "{", "end"]) : `${pick(["int", "let", "call"])} v${counter++};`;
  const block = (n: number) => Array.from({ length: n }, line);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  type Files = Map<string, string[]>;
  const nodes: Array<{ id: string; files: Files }> = [];
  const paths = new Map<string, string[]>();
  let date = 1_600_000_000;
  const commit = (parents: string[], files: Files) => {
    const entries: string[] = [];
    for (const [path, lines] of [...files].sort()) {
      const blob = git(dir, ["hash-object", "-w", "--stdin"], lines.map((l) => `${l}\n`).join(""));
      entries.push(`100644 blob ${blob}\t${path}`);
    }
    const tree = git(dir, ["mktree"], `${entries.join("\n")}\n`);
    // ties and clock skew now and then
    date += r() < 0.1 ? 0 : r() < 0.05 ? -300 : 60 + Math.floor(r() * 3600);
    const id = git(
      dir,
      ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])],
      `commit ${nodes.length}\n`,
      {
        GIT_AUTHOR_NAME: pick(["Alice", "Bob"]),
        GIT_AUTHOR_EMAIL: "a@example.com",
        GIT_AUTHOR_DATE: `${date} +0000`,
        GIT_COMMITTER_NAME: "C",
        GIT_COMMITTER_EMAIL: "c@example.com",
        GIT_COMMITTER_DATE: `${date} +0000`,
      },
    );
    nodes.push({ id, files: new Map([...files].map(([p, l]) => [p, [...l]])) });
    paths.set(
      id,
      [...files.keys()].filter((p) => files.get(p)?.length),
    );
    return id;
  };
  const names = ["a.c", "b.c", "c.c", "d.c"];
  const start: Files = new Map();
  for (const n of names.slice(0, 2 + Math.floor(r() * 2)))
    start.set(n, block(4 + Math.floor(r() * 10)));
  commit([], start);
  const count = 6 + Math.floor(r() * 8);
  for (let k = 0; k < count; k++) {
    const parent = r() < 0.75 ? nodes[nodes.length - 1] : pick(nodes);
    const files: Files = new Map([...parent.files].map(([p, l]) => [p, [...l]]));
    for (let o = 1 + Math.floor(r() * 3); o > 0; o--) {
      const src = pick([...files.keys()]);
      const lines = files.get(src) ?? [];
      const at = Math.floor(r() * (lines.length + 1));
      const op = r();
      if (op < 0.35)
        lines.splice(at, Math.min(2, lines.length - at), ...block(1 + Math.floor(r() * 2)));
      else if (op < 0.55) lines.splice(at, 0, ...block(1 + Math.floor(r() * 3)));
      else if (op < 0.75) lines.splice(at, 1 + Math.floor(r() * 3));
      else if (op < 0.85) {
        const taken = lines.splice(at, 3);
        lines.splice(Math.floor(r() * (lines.length + 1)), 0, ...taken);
      } else if (op < 0.93) {
        const name = pick(names.filter((n) => !files.has(n)));
        if (name) {
          files.set(name, lines);
          files.delete(src);
        }
      } else if (files.size > 1) files.delete(src);
    }
    if (r() < 0.2 && nodes.length > 2) commit([parent.id, pick(nodes).id], files);
    else commit([parent.id], files);
  }
  // the newest commit and every other tip as branches
  git(dir, ["update-ref", "refs/heads/main", nodes[nodes.length - 1].id]);
  return { ids: nodes.map((n) => n.id), paths };
}

describeGit("git blame --reverse against native git on random histories", () => {
  it(`matches git blame --reverse on ${SEEDS} histories`, async () => {
    const m: string[] = [];
    let compared = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const dir = join(tmp(), `h-${seed}`);
      const { ids, paths } = buildHistory(dir, seed);
      const r = prng(seed * 104729);
      const ours = await open(dir);
      for (let k = 0; k < 5; k++) {
        const from = ids[Math.floor(r() * (ids.length - 1))];
        let to: string | undefined =
          r() < 0.3 ? undefined : ids[ids.length - 1 - Math.floor(r() * 3)];
        // git refuses `A..A` (two commits to dig up from)
        if (to === from) to = undefined;
        const range = to ? `${from}..${to}` : from;
        for (const path of paths.get(from) ?? []) {
          const ignored = ids[Math.floor(r() * ids.length)];
          const modes: string[][] = [
            [],
            ["-M"],
            ["--first-parent"],
            ["-C", "-w"],
            ["--ignore-rev", ignored],
          ];
          const mode = modes[k];
          // --first-parent needs the range along the first-parent chain
          if (mode[0] === "--first-parent") {
            const end = to ?? ids[ids.length - 1];
            const chain = git(dir, ["rev-list", "--first-parent", end]).split("\n");
            if (!chain.includes(from)) continue;
          }
          compared++;
          for (const x of await compareBlame(
            tmp(),
            dir,
            ours,
            path,
            ["--reverse", range, ...mode],
            {
              formats: [["--porcelain"], []],
            },
          )) {
            m.push(`seed ${seed}: ${x}`);
          }
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
    expect(compared).toBeGreaterThan(SEEDS);
    check(m);
  }, 600_000);
});
