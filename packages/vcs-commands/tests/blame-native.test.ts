/**
 * `git blame` against native git, byte for byte: random histories (linear runs, branches
 * and merges, blocks of lines moved within the file, whitespace-only edits, repetitive
 * lines, a missing trailing newline, renames, committer dates with ties and clock skew,
 * several authors and time zones) built with plumbing, blamed by native git and by our
 * BlameCommand, in `--porcelain`, `--line-porcelain` and the default output, with random
 * `-w`, `-L` ranges, `--root`, `--diff-algorithm` and `diff.algorithm`.
 *
 * `BLAME_SEEDS` sets the number of histories (default 60), `BLAME_SHOW` how many mismatches
 * to print, `BLAME_ONLY` a single seed (its repository is kept).
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

import { formatBlame, formatBlamePorcelain, Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;
const SEEDS = Number(process.env.BLAME_SEEDS ?? 60);
const SHOW = Number(process.env.BLAME_SHOW ?? 3);
const ONLY = Number(process.env.BLAME_ONLY ?? 0);

const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "";
const [major, minor] = (/(\d+)\.(\d+)/.exec(version) ?? ["", "0", "0"]).slice(1).map(Number);
const atLeast = (ma: number, mi: number) => major > ma || (major === ma && minor >= mi);
const compatibility = {
  histogramRediff: atLeast(2, 54),
  legacyMinimal: !atLeast(2, 50),
  renameCountLastSpan: atLeast(2, 50),
};
/** git before 2.5x widened the abbreviated ids by one even without a boundary commit */
const alwaysWidenAbbrev = !atLeast(2, 50);

let root: string | undefined;
afterAll(() => {
  if (root && !ONLY) rmSync(root, { recursive: true, force: true });
});
const tmp = () => {
  root ??= mkdtempSync(join(tmpdir(), "blame-native-"));
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

const TOKENS = [
  "a",
  "b",
  "c",
  "}",
  "",
  "  x",
  "\tx",
  "x ",
  "int f(void)",
  "  return 0;",
  "{",
  "foo bar",
];
const AUTHORS = [
  ["Alice", "alice@example.com", "+0100"],
  ["Bob Builder", "bob@example.com", "-0700"],
  ["Ç. Unicode", "u@example.com", "+0530"],
];

function edit(r: () => number, lines: string[]): string[] {
  const out = [...lines];
  const n = 1 + Math.floor(r() * 4);
  for (let k = 0; k < n; k++) {
    const at = Math.floor(r() * (out.length + 1));
    const op = Math.floor(r() * 6);
    const tok = r() < 0.2 ? `u${Math.floor(r() * 1000)}` : TOKENS[Math.floor(r() * TOKENS.length)];
    if (op === 0 && at < out.length) out[at] = tok;
    else if (op === 1) out.splice(at, 0, tok);
    else if (op === 2 && at < out.length) out.splice(at, 1);
    else if (op === 3 && at < out.length)
      out[at] = `${out[at]}  `.replace(/^/, r() < 0.5 ? " " : "");
    else if (op === 4 && out.length > 3) {
      // move a block within the file
      const len = 1 + Math.floor(r() * Math.min(4, out.length - 1));
      const from = Math.floor(r() * (out.length - len + 1));
      const block = out.splice(from, len);
      const to = Math.floor(r() * (out.length + 1));
      out.splice(to, 0, ...block);
    } else out.splice(at, 0, `${tok}`, tok);
  }
  return out;
}

interface Node {
  id: string;
  lines: string[];
  path: string;
  eol: boolean;
}

/** A random history; returns the tip commit and the file's path there. */
function buildHistory(dir: string, seed: number): { tip: string; path: string } {
  const r = prng(seed);
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  if (r() < 0.3)
    git(dir, ["config", "diff.algorithm", ["histogram", "patience", "minimal"][seed % 3]]);
  const nodes: Node[] = [];
  let date = 1_600_000_000;
  const commit = (parents: Node[], lines: string[], path: string, eol: boolean): Node => {
    const text = lines.map((l) => `${l}\n`).join("");
    const content = eol || text.length === 0 ? text : text.slice(0, -1);
    const blob = git(dir, ["hash-object", "-w", "--stdin"], content);
    const other = git(dir, ["hash-object", "-w", "--stdin"], `other ${nodes.length % 3}\n`);
    const entries = [`100644 blob ${blob}\t${path}`, `100644 blob ${other}\tother.txt`];
    const parts = path.split("/");
    let tree: string;
    if (parts.length > 1) {
      const sub = git(dir, ["mktree"], `100644 blob ${blob}\t${parts[1]}\n`);
      tree = git(
        dir,
        ["mktree"],
        `040000 tree ${sub}\t${parts[0]}\n100644 blob ${other}\tother.txt\n`,
      );
    } else {
      tree = git(dir, ["mktree"], `${entries.join("\n")}\n`);
    }
    // committer dates move on, with ties and clock skew
    const step = r();
    date += step < 0.15 ? 0 : step < 0.25 ? -3600 : 60 + Math.floor(r() * 7200);
    const [name, email, tz] = AUTHORS[Math.floor(r() * AUTHORS.length)];
    const message = r() < 0.2 ? `\n\nsubject ${nodes.length}\n\nbody` : `commit ${nodes.length}\n`;
    const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p.id])];
    const id = git(dir, args, message, {
      GIT_AUTHOR_NAME: name,
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_DATE: `${date - Math.floor(r() * 5000)} ${tz}`,
      GIT_COMMITTER_NAME: name,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_DATE: `${date} ${tz}`,
    });
    const node = { id, lines, path, eol };
    nodes.push(node);
    return node;
  };
  const base = Array.from(
    { length: 5 + Math.floor(r() * 15) },
    () => TOKENS[Math.floor(r() * TOKENS.length)],
  );
  let path = "f.txt";
  commit([], base, path, true);
  const count = 4 + Math.floor(r() * 10);
  for (let k = 0; k < count; k++) {
    const p = r();
    if (p < 0.2 && nodes.length > 2) {
      // a merge of two earlier commits: lines of one side with some of the other
      const a = nodes[nodes.length - 1];
      const b = nodes[Math.floor(r() * (nodes.length - 1))];
      let lines = r() < 0.5 ? [...a.lines] : edit(r, a.lines);
      if (r() < 0.5) lines = [...lines.slice(0, 3), ...b.lines.slice(2, 6), ...lines.slice(3)];
      commit([a, b], lines, a.path, a.eol);
    } else {
      // usually the tip, sometimes an older commit (a branch)
      const parent = r() < 0.8 ? nodes[nodes.length - 1] : nodes[Math.floor(r() * nodes.length)];
      if (r() < 0.08) path = path === "f.txt" ? "dir/g.txt" : "f.txt";
      const lines = r() < 0.1 ? [...parent.lines] : edit(r, parent.lines);
      commit([parent], lines, r() < 0.5 ? path : parent.path, r() < 0.85);
    }
  }
  const tip = nodes[nodes.length - 1];
  git(dir, ["update-ref", "refs/heads/main", tip.id]);
  return { tip: tip.id, path: tip.path };
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

describeGit("git blame against native git", () => {
  it(`matches git blame on ${SEEDS} random histories`, async () => {
    const mismatches: string[] = [];
    let compared = 0;
    for (let seed = ONLY || 1; seed <= (ONLY || SEEDS); seed++) {
      const dir = join(tmp(), `h-${seed}`);
      const { tip, path } = buildHistory(dir, seed);
      const ours = await open(dir);
      const r = prng(seed * 104729);
      const lineCount = (await ours.blame().setFilePath(path).setStartCommit(tip).call()).lineCount;
      for (let variant = 0; variant < 4; variant++) {
        const args: string[] = [];
        const cmd = ours
          .blame()
          .setFilePath(path)
          .setStartCommit(tip)
          .setCompatibility(compatibility);
        if (variant > 0 && r() < 0.3) {
          args.push("-w");
          cmd.setIgnoreWhitespace(true);
        }
        if (variant > 0 && r() < 0.2) {
          args.push("--root");
          cmd.setShowRoot(true);
        }
        if (variant > 0 && r() < 0.2) {
          const alg = (["myers", "minimal", "patience", "histogram"] as const)[Math.floor(r() * 4)];
          args.push(`--diff-algorithm=${alg}`);
          cmd.setAlgorithm(alg);
        }
        if (variant > 1 && lineCount > 2 && r() < 0.5) {
          const s = 1 + Math.floor(r() * lineCount);
          const e = Math.min(lineCount, s + Math.floor(r() * 5));
          const s2 = 1 + Math.floor(r() * lineCount);
          const ranges: Array<[number, number]> = [[s, e]];
          args.push("-L", `${s},${e}`);
          if (r() < 0.4) {
            ranges.push([s2, s2]);
            args.push("-L", `${s2},${s2}`);
          }
          cmd.setLineRanges(ranges);
        }
        // git before 2.5x blamed with myers whatever --diff-algorithm and diff.algorithm say
        if (!atLeast(2, 50)) cmd.setAlgorithm("myers");
        const result = await cmd.call();
        const autoAbbrev = await result.autoAbbrev?.();
        const formats: Array<[string[], Uint8Array]> = [
          [["--porcelain"], formatBlamePorcelain(result)],
          [["--line-porcelain"], formatBlamePorcelain(result, { linePorcelain: true })],
          [[], formatBlame(result, { alwaysWidenAbbrev, autoAbbrev })],
          [
            ["-n", "-f", "-e"],
            formatBlame(result, {
              showNumber: true,
              showName: true,
              showEmail: true,
              alwaysWidenAbbrev,
              autoAbbrev,
            }),
          ],
        ];
        for (const [formatArgs, mine] of formats) {
          const res = spawnSync("git", ["blame", ...formatArgs, ...args, tip, "--", path], {
            cwd: dir,
            env: nativeGitEnv(tmp()),
          });
          if (res.status !== 0) throw new Error(String(res.stderr));
          compared++;
          if (!res.stdout.equals(Buffer.from(mine))) {
            mismatches.push(
              `seed ${seed} blame ${[...formatArgs, ...args].join(" ")}\n--- git\n${res.stdout}\n--- ours\n${Buffer.from(mine)}`,
            );
          }
        }
      }
      if (!ONLY) rmSync(dir, { recursive: true, force: true });
    }
    for (const m of mismatches.slice(0, SHOW)) console.log(m);
    expect(mismatches.length).toBe(0);
    expect(compared).toBe((ONLY ? 1 : SEEDS) * 16);
  }, 900_000);
});
