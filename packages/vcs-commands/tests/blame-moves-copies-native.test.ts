/**
 * `git blame -M[<num>]` and `-C[<num>]` (up to three times), and the mailmap, against native
 * git, byte for byte: the scenarios of t8003-blame-corner-cases.sh, t8011-blame-split-file.sh
 * and t4203-mailmap.sh, then random histories whose commits move and copy blocks of lines
 * within and across files (deleted, renamed, new and unchanged files, merges), blamed in every
 * mode in `--porcelain` and the default output.
 *
 * `BLAME_MC_SEEDS` sets the number of random histories (default 40), `BLAME_MC_ONLY` a single
 * seed (its repository is kept), `BLAME_MC_SHOW` how many mismatches to print.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitWorkingCopyConfig,
} from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterAll, describe, expect, it } from "vitest";

import { type BlameCommand, formatBlame, formatBlamePorcelain, Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;
const SEEDS = Number(process.env.BLAME_MC_SEEDS ?? 40);
const ONLY = Number(process.env.BLAME_MC_ONLY ?? 0);
const SHOW = Number(process.env.BLAME_MC_SHOW ?? 3);

const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "";
const [major, minor] = (/(\d+)\.(\d+)/.exec(version) ?? ["", "0", "0"]).slice(1).map(Number);
const atLeast = (ma: number, mi: number) => major > ma || (major === ma && minor >= mi);
const compatibility = {
  histogramRediff: atLeast(2, 54),
  legacyMinimal: !atLeast(2, 50),
  renameCountLastSpan: atLeast(2, 50),
};
const alwaysWidenAbbrev = !atLeast(2, 50);

let root: string | undefined;
afterAll(() => {
  if (root && !ONLY) rmSync(root, { recursive: true, force: true });
});
const tmp = () => {
  root ??= mkdtempSync(join(tmpdir(), "blame-mc-native-"));
  return root;
};

function git(
  cwd: string,
  args: string[],
  input?: string | Uint8Array,
  env: Record<string, string> = {},
): string {
  return execFileSync("git", args, {
    cwd,
    input,
    env: { ...nativeGitEnv(tmp()), ...env },
    stdio: ["pipe", "pipe", "pipe"],
  })
    .toString()
    .trim();
}

async function open(dir: string): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const { history } = await createGitFilesBackend({ files });
  const io = {
    read: async (path: string) => {
      try {
        return new Uint8Array(readFileSync(join(dir, path)));
      } catch {
        return undefined;
      }
    },
    write: async (path: string, content: Uint8Array) => writeFileSync(join(dir, path), content),
  };
  const config = new GitWorkingCopyConfig(io, ".git/config");
  await config.load();
  const staging = new FileStagingStore(files, ".git/index");
  const checkout = new GitCheckout({
    staging,
    refs: history.refs,
    files: {
      read: io.read,
      write: (p: string, c: Uint8Array) => files.write(p, [c]),
      stats: async () => undefined,
      remove: async () => {},
    } as unknown as GitCheckoutFilesApi,
    gitDir: ".git",
  });
  const worktree = createFileWorktree({
    files,
    rootPath: "",
    gitDir: ".git",
    blobs: history.blobs,
    trees: history.trees,
  });
  return Git.fromWorkingCopy(new MemoryWorkingCopy({ history, checkout, worktree, config }));
}

/** The options of a `git blame` argv applied to our command */
function applyArgs(cmd: BlameCommand, args: string[]): void {
  let copies = 0;
  let copyScore: number | undefined;
  for (const a of args) {
    let m = /^-M(\d*)$/.exec(a);
    if (m) cmd.setDetectMoves(true, m[1] ? Number(m[1]) : undefined);
    m = /^-C(\d*)$/.exec(a);
    if (m) {
      copies++;
      if (m[1]) copyScore = Number(m[1]);
    }
    if (a === "--root") cmd.setShowRoot(true);
    if (a === "-w") cmd.setIgnoreWhitespace(true);
    m = /^-L(\d+),(\d+)$/.exec(a);
    if (m) cmd.setLineRanges([[Number(m[1]), Number(m[2])]]);
  }
  if (copies) cmd.setDetectCopies(copies, copyScore);
}

/** Entries blamed on another file than the one blamed (the copies found) */
let crossFileEntries = 0;

/** Our output and native git's of `git blame <format> <args> <rev> -- <path>` */
async function compare(
  dir: string,
  ours: Git,
  rev: string,
  path: string,
  args: string[],
  formats: string[][] = [["--porcelain"], []],
): Promise<string[]> {
  const cmd = ours.blame().setFilePath(path).setStartCommit(rev).setCompatibility(compatibility);
  applyArgs(cmd, args);
  if (!atLeast(2, 50)) cmd.setAlgorithm("myers");
  const result = await cmd.call();
  for (const e of result.entries) if (e.sourcePath !== path) crossFileEntries++;
  const autoAbbrev = await result.autoAbbrev?.();
  const mismatches: string[] = [];
  for (const format of formats) {
    const mine =
      format[0] === "--porcelain"
        ? formatBlamePorcelain(result)
        : format[0] === "--line-porcelain"
          ? formatBlamePorcelain(result, { linePorcelain: true })
          : formatBlame(result, {
              alwaysWidenAbbrev,
              autoAbbrev,
              showName: format.includes("-f"),
              showEmail: format.includes("-e"),
            });
    const res = spawnSync("git", ["blame", ...format, ...args, rev, "--", path], {
      cwd: dir,
      env: nativeGitEnv(tmp()),
      maxBuffer: 1 << 26,
    });
    if (res.status !== 0) throw new Error(String(res.stderr));
    if (!res.stdout.equals(Buffer.from(mine))) {
      mismatches.push(
        `blame ${[...format, ...args, rev, path].join(" ")}\n--- git\n${res.stdout}\n--- ours\n${Buffer.from(mine)}`,
      );
    }
  }
  return mismatches;
}

const testEnv = (name: string, tick: number): Record<string, string> => ({
  GIT_AUTHOR_NAME: name,
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_AUTHOR_DATE: `${1112911993 + tick * 60} -0700`,
  GIT_COMMITTER_NAME: "C O Mitter",
  GIT_COMMITTER_EMAIL: "committer@example.com",
  GIT_COMMITTER_DATE: `${1112911993 + tick * 60} -0700`,
});

describeGit("git blame -M/-C against native git", () => {
  it("t8003-blame-corner-cases.sh: the copy and move cases", async () => {
    const dir = join(tmp(), "t8003");
    mkdirSync(dir, { recursive: true });
    const w = (name: string, text: string) => writeFileSync(join(dir, name), text);
    git(dir, ["init", "-q", "-b", "main"]);
    // t8003-blame-corner-cases.sh: "setup"
    w("one", "A A A A A\n");
    w("two", "B B B B B\n");
    w("tres", "C C C C C\n");
    w("mouse", "ABC\n");
    w("nine_lines", "1\n2\n3\n4\n5\n6\n7\n8\n9\n");
    w("ten_lines", "1\n2\n3\n4\n5\n6\n7\n8\n9\na\n");
    git(dir, ["add", "one", "two", "tres", "mouse", "nine_lines", "ten_lines"]);
    git(dir, ["commit", "-q", "-m", "Initial"], undefined, testEnv("Initial", 1));
    w("uno", "A A A A A\n");
    git(dir, ["mv", "two", "dos"]);
    w("tres", "C C C C C\nA A A A A\n");
    w("mouse", "ABC\nDEF\n");
    git(dir, ["add", "uno", "dos", "tres", "mouse"]);
    git(dir, ["commit", "-q", "-a", "-m", "Second"], undefined, testEnv("Second", 2));
    w("mouse", "ABC\nDEF\nGHIJK\n");
    git(dir, ["add", "mouse"]);
    git(dir, ["commit", "-q", "-m", "Third"], undefined, testEnv("Third", 3));
    w("cow", "ABC\nDEF\nGHIJK\n");
    git(dir, ["add", "cow"]);
    git(dir, ["commit", "-q", "-m", "Fourth"], undefined, testEnv("Fourth", 4));
    w("cow", "ABC\nDEF\nXXXX\nGHIJK\n");
    git(dir, ["add", "cow"]);
    git(dir, ["commit", "-q", "-m", "Fifth"], undefined, testEnv("Fifth", 5));
    const ours = await open(dir);
    const head = git(dir, ["rev-parse", "HEAD"]);
    const prev = git(dir, ["rev-parse", "HEAD^"]);
    const cases: Array<[string, string, string[]]> = [
      [head, "uno", []], // "straight copy without -C"
      [head, "dos", []], // "straight move without -C"
      [head, "uno", ["-C1"]], // "straight copy with -C"
      [head, "dos", ["-C1"]], // "straight move with -C"
      [head, "uno", ["-C", "-C1"]], // "straight copy with -C -C"
      [head, "dos", ["-C", "-C1"]], // "straight move with -C -C"
      [head, "tres", ["-L2,2"]], // "append without -C"
      [head, "tres", ["-L2,2", "-C1"]], // "append with -C"
      [head, "tres", ["-L2,2", "-C", "-C1"]], // "append with -C -C"
      [head, "tres", ["-L2,2", "-C", "-C", "-C1"]], // "append with -C -C -C"
      [prev, "cow", ["-C", "-C1"]], // "blame wholesale copy"
      [head, "cow", ["-C", "-C1"]], // "blame wholesale copy and more"
    ];
    const mismatches: string[] = [];
    for (const [rev, path, args] of cases) {
      mismatches.push(
        ...(await compare(dir, ours, rev, path, args, [["--porcelain"], ["-f"], []])),
      );
    }
    for (const m of mismatches.slice(0, SHOW)) console.log(m);
    expect(mismatches).toEqual([]);
    // the copies are found where t8003 expects them
    const authors = async (rev: string, path: string, args: string[]) => {
      const cmd = ours.blame().setFilePath(path).setStartCommit(rev);
      applyArgs(cmd, args);
      const r = await cmd.call();
      return r.entries.map((e) => `${e.sourcePath}-${e.commit.author.name}`);
    };
    expect(await authors(head, "uno", ["-C1"])).toEqual(["uno-Second"]);
    expect(await authors(head, "uno", ["-C", "-C1"])).toEqual(["one-Initial"]);
    expect(await authors(head, "tres", ["-L2,2", "-C", "-C", "-C1"])).toEqual(["one-Initial"]);
    expect(await authors(head, "cow", ["-C", "-C1"])).toEqual([
      "mouse-Initial",
      "mouse-Second",
      "cow-Fifth",
      "mouse-Third",
    ]);
  }, 120_000);

  it('t8011-blame-split-file.sh: "generate --porcelain output", "generate --line-porcelain output"', async () => {
    const dir = join(tmp(), "t8011");
    mkdirSync(dir, { recursive: true });
    const seq = (a: number, b: number) =>
      Array.from({ length: b - a + 1 }, (_, i) => `${a + i}\n`).join("");
    const w = (name: string, text: string) => writeFileSync(join(dir, name), text);
    git(dir, ["init", "-q", "-b", "main"]);
    w("one", seq(1000, 1010));
    w("two", seq(2000, 2010));
    git(dir, ["add", "one", "two"]);
    git(dir, ["commit", "-q", "-m", "base"], undefined, testEnv("A U Thor", 1));
    w("one", seq(1000, 1010).replace("1005\n", "modified 1005\n"));
    w("two", seq(2000, 2010).replace("2005\n", "modified 2005\n"));
    git(dir, ["add", "-u"]);
    git(dir, ["commit", "-q", "-m", "modified"], undefined, testEnv("A U Thor", 2));
    w("combined", readFileSync(join(dir, "one"), "utf8") + readFileSync(join(dir, "two"), "utf8"));
    git(dir, ["add", "combined"]);
    git(dir, ["rm", "-q", "one", "two"]);
    git(dir, ["commit", "-q", "-m", "combined"], undefined, testEnv("A U Thor", 3));
    const ours = await open(dir);
    const head = git(dir, ["rev-parse", "HEAD"]);
    const mismatches = await compare(
      dir,
      ours,
      head,
      "combined",
      ["--root", "-C"],
      [["--porcelain"], ["--line-porcelain"], []],
    );
    for (const m of mismatches.slice(0, SHOW)) console.log(m);
    expect(mismatches).toEqual([]);
  }, 60_000);

  it('t4203-mailmap.sh: "Blame --porcelain output (complex mapping)", "Blame output (complex mapping)"', async () => {
    const dir = join(tmp(), "t4203");
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    const lines: string[] = [];
    let tick = 0;
    const append = (author: string, line: string) => {
      lines.push(line);
      writeFileSync(join(dir, "one"), lines.map((l) => `${l}\n`).join(""));
      git(dir, ["add", "one"]);
      const m = /^(.*) <(.*)>$/.exec(author) ?? ["", "A U Thor", "author@example.com"];
      git(dir, ["commit", "-q", "-m", line], undefined, {
        ...testEnv(m[1], ++tick),
        GIT_AUTHOR_EMAIL: m[2],
      });
    };
    // "setup commits and contacts file", then "Shortlog output (complex mapping)"
    append("A U Thor <author@example.com>", "one");
    append("nick1 <bugs@company.xx>", "two");
    append("nick2 <bugs@company.xx>", "three");
    append("nick2 <nick2@company.xx>", "four");
    append("santa <me@company.xx>", "five");
    append("claus <me@company.xx>", "six");
    append("CTO <cto@coompany.xx>", "seven");
    writeFileSync(
      join(dir, "complex.map"),
      [
        "Committed <committer@example.com>",
        "<cto@company.xx> <cto@coompany.xx>",
        "Some Dude <some@dude.xx>         nick1 <bugs@company.xx>",
        "Other Author <other@author.xx>   nick2 <bugs@company.xx>",
        "Other Author <other@author.xx>         <nick2@company.xx>",
        "Santa Claus <santa.claus@northpole.xx> <me@company.xx>",
        "",
      ].join("\n"),
    );
    const head = git(dir, ["rev-parse", "HEAD"]);
    const mismatches: string[] = [];
    // no mailmap, then mailmap.file, then the same lines as the worktree's .mailmap
    mismatches.push(
      ...(await compare(dir, await open(dir), head, "one", [], [["--porcelain"], []])),
    );
    git(dir, ["config", "mailmap.file", "complex.map"]);
    const mapped = await open(dir);
    mismatches.push(...(await compare(dir, mapped, head, "one", [], [["--porcelain"], ["-e"]])));
    const r = await mapped.blame().setFilePath("one").setStartCommit(head).call();
    expect(r.entries.map((e) => e.commit.author.name)).toEqual([
      "A U Thor",
      "Some Dude",
      "Other Author",
      "Other Author",
      "Santa Claus",
      "Santa Claus",
      "CTO",
    ]);
    git(dir, ["config", "--unset", "mailmap.file"]);
    writeFileSync(join(dir, ".mailmap"), readFileSync(join(dir, "complex.map")));
    mismatches.push(
      ...(await compare(dir, await open(dir), head, "one", [], [["--line-porcelain"], []])),
    );
    // without the mailmap
    const raw = await (await open(dir))
      .blame()
      .setFilePath("one")
      .setStartCommit(head)
      .setUseMailmap(false)
      .call();
    expect(raw.entries.map((e) => e.commit.author.name)).toContain("nick1");
    for (const m of mismatches.slice(0, SHOW)) console.log(m);
    expect(mismatches).toEqual([]);
  }, 60_000);
});

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SHORT = ["}", "", "{", "  return 0;", "x", "end"];
const AUTHORS = ["Alice", "Bob Builder", "Carol"];

/** A random history of several files whose commits move and copy blocks among them */
function buildHistory(dir: string, seed: number): { tip: string; paths: string[] } {
  const r = prng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  let counter = 0;
  const line = () =>
    r() < 0.25
      ? pick(SHORT)
      : `${pick(["int", "let", "call", "word", "data"])} v${counter++}${r() < 0.3 ? " and some more text" : ""};`;
  const block = (n: number) => Array.from({ length: n }, line);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  type Files = Map<string, string[]>;
  const nodes: Array<{ id: string; files: Files }> = [];
  let date = 1_600_000_000;
  const commit = (parents: Array<{ id: string }>, files: Files) => {
    const byDir = new Map<string, string[]>();
    for (const [path, lines] of [...files].sort()) {
      const blob = git(dir, ["hash-object", "-w", "--stdin"], lines.map((l) => `${l}\n`).join(""));
      const [d, name] = path.includes("/") ? path.split("/") : ["", path];
      const list = byDir.get(d) ?? [];
      list.push(`100644 blob ${blob}\t${name}`);
      byDir.set(d, list);
    }
    const top = byDir.get("") ?? [];
    for (const [d, list] of byDir) {
      if (!d) continue;
      top.push(`040000 tree ${git(dir, ["mktree"], `${list.join("\n")}\n`)}\t${d}`);
    }
    const tree = git(dir, ["mktree"], `${top.join("\n")}\n`);
    date += r() < 0.1 ? 0 : 60 + Math.floor(r() * 3600);
    const name = pick(AUTHORS);
    const id = git(
      dir,
      ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p.id])],
      `commit ${nodes.length}\n`,
      {
        GIT_AUTHOR_NAME: name,
        GIT_AUTHOR_EMAIL: `${name.split(" ")[0].toLowerCase()}@example.com`,
        GIT_AUTHOR_DATE: `${date} +0000`,
        GIT_COMMITTER_NAME: name,
        GIT_COMMITTER_EMAIL: "c@example.com",
        GIT_COMMITTER_DATE: `${date} +0000`,
      },
    );
    const node = { id, files: new Map([...files].map(([p, l]) => [p, [...l]])) };
    nodes.push(node);
    return node;
  };
  const names = ["a.c", "b.c", "c.c", "lib/d.c", "lib/e.c", "f.c"];
  const start: Files = new Map();
  for (const n of names.slice(0, 3 + Math.floor(r() * 2)))
    start.set(n, block(4 + Math.floor(r() * 12)));
  commit([], start);
  const count = 5 + Math.floor(r() * 8);
  for (let k = 0; k < count; k++) {
    const parent = r() < 0.85 ? nodes[nodes.length - 1] : pick(nodes);
    const files: Files = new Map([...parent.files].map(([p, l]) => [p, [...l]]));
    const ops = 1 + Math.floor(r() * 4);
    for (let o = 0; o < ops; o++) {
      const paths = [...files.keys()];
      const src = pick(paths);
      const from = files.get(src) ?? [];
      const op = r();
      const len = 1 + Math.floor(r() * 4);
      const at = Math.floor(r() * (from.length + 1));
      const taken = from.slice(at, at + len);
      if (op < 0.2) {
        // edit lines
        from.splice(at, Math.min(1, from.length - at), ...block(1 + Math.floor(r() * 2)));
      } else if (op < 0.35) {
        // move a block within the file
        from.splice(at, taken.length);
        from.splice(Math.floor(r() * (from.length + 1)), 0, ...taken);
      } else if (op < 0.5) {
        // move a block to another file
        const dst = files.get(pick(paths)) ?? [];
        from.splice(at, taken.length);
        dst.splice(Math.floor(r() * (dst.length + 1)), 0, ...taken);
      } else if (op < 0.65) {
        // copy a block to another file (or the same one)
        const dst = files.get(pick(paths)) ?? [];
        dst.splice(Math.floor(r() * (dst.length + 1)), 0, ...taken);
      } else if (op < 0.75 && files.size > 2) {
        // delete a file, its lines copied elsewhere first
        const dst = files.get(pick(paths.filter((p) => p !== src))) ?? [];
        dst.splice(Math.floor(r() * (dst.length + 1)), 0, ...from.slice(0, 6));
        files.delete(src);
      } else if (op < 0.85) {
        // a new file made of blocks of others
        const name = pick(names.filter((n) => !files.has(n))) ?? `n${k}.c`;
        const lines = [...taken, ...block(1 + Math.floor(r() * 2))];
        const other = files.get(pick(paths)) ?? [];
        lines.push(...other.slice(0, 1 + Math.floor(r() * 5)));
        files.set(name, lines);
      } else if (op < 0.92) {
        // rename a file
        const name = pick(names.filter((n) => !files.has(n)));
        if (name) {
          files.set(name, from);
          files.delete(src);
        }
      } else {
        from.splice(at, 0, ...block(2));
      }
    }
    if (r() < 0.15 && nodes.length > 2) {
      const other = pick(nodes.slice(0, -1));
      commit([parent, other], files);
    } else commit([parent], files);
  }
  const tip = nodes[nodes.length - 1];
  git(dir, ["update-ref", "refs/heads/main", tip.id]);
  return { tip: tip.id, paths: [...tip.files.keys()].filter((p) => tip.files.get(p)?.length) };
}

const MODES: string[][] = [
  ["-M"],
  ["-M5"],
  ["-C"],
  ["-C15"],
  ["-C", "-C"],
  ["-C", "-C", "-C"],
  ["-M30", "-C", "-C10", "-C"],
  ["-C", "-M50"],
  ["-w", "-C", "-C"],
];

describeGit("git blame -M/-C against native git on random histories", () => {
  it(`matches git blame on ${SEEDS} histories that move and copy lines`, async () => {
    const mismatches: string[] = [];
    let compared = 0;
    crossFileEntries = 0;
    for (let seed = ONLY || 1; seed <= (ONLY || SEEDS); seed++) {
      const dir = join(tmp(), `h-${seed}`);
      const { tip, paths } = buildHistory(dir, seed);
      const ours = await open(dir);
      for (const path of paths) {
        for (const mode of MODES) {
          const found = await compare(dir, ours, tip, path, mode);
          compared++;
          for (const m of found) mismatches.push(`seed ${seed} ${m}`);
        }
      }
      if (!ONLY) rmSync(dir, { recursive: true, force: true });
    }
    for (const m of mismatches.slice(0, SHOW)) console.log(m);
    expect(mismatches.length).toBe(0);
    expect(compared).toBeGreaterThan(SEEDS);
    // the histories copy lines across files, and blame finds them
    expect(crossFileEntries).toBeGreaterThan(SEEDS);
  }, 900_000);
});
