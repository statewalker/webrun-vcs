/**
 * Ignore rules against native git (a differential fuzz): each seeded layout of files,
 * nested `.gitignore` files, `info/exclude` and `core.excludesFile` with random rules
 * (negations, anchors, directory-only rules, `**`, classes, escapes, trailing spaces) is
 * read by `git check-ignore --no-index -v` and `git status --porcelain --ignored -uall`, and
 * by our worktree walk, `isIgnored` and status: every decision must match.
 *
 * A small number of seeds runs by default; `IGNORE_FUZZ=full` runs the full sweep (seeds
 * 20000-20999, or `IGNORE_FUZZ_START` / `IGNORE_FUZZ_COUNT`), `IGNORE_FUZZ_SEED=<n>` one
 * seed, `IGNORE_FUZZ_OUT=<file>` writes every mismatch as JSON.
 */
import { execFileSync } from "node:child_process";
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
import { describe, expect, it } from "vitest";
import { Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const FULL = process.env.IGNORE_FUZZ === "full";
const START = Number(process.env.IGNORE_FUZZ_START ?? 20000);
const COUNT = Number(process.env.IGNORE_FUZZ_COUNT ?? (FULL ? 1000 : 60));
const ONLY = process.env.IGNORE_FUZZ_SEED ? Number(process.env.IGNORE_FUZZ_SEED) : undefined;
const OUT = process.env.IGNORE_FUZZ_OUT;

let home = "";
const git = (cwd: string, args: string[], input?: string): string => {
  try {
    return execFileSync("git", args, {
      cwd,
      env: nativeGitEnv(home),
      encoding: "utf8",
      input,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (e) {
    const x = e as { status?: number; stdout?: string };
    if (args[0] === "check-ignore" && x.status === 1) return x.stdout ?? "";
    throw e;
  }
};

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  const r = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 2 ** 32;
  };
  for (let i = 0; i < 5; i++) r();
  return r;
}

const DIRS = ["a", "b", "c", "foo", "bar", "deep", "sub", "build"];
const NAMES = [
  "a",
  "b",
  "foo",
  "bar",
  "x.log",
  "y.txt",
  "z.o",
  "!bang",
  "#hash",
  "sp ",
  "q*",
  "[x]",
  "build",
  "keep.log",
];
const CORES = [
  ...DIRS,
  "x.log",
  "y.txt",
  "z.o",
  "keep.log",
  "*.log",
  "*.txt",
  "*",
  "f*",
  "*o*",
  "?ar",
  "[a-c]",
  "[!a]*",
  "b[a-z]r",
  "*.[lt]*",
  "\\!bang",
  "\\#hash",
  "sp\\ ",
  "q\\*",
  "\\[x\\]",
  "!bang",
];

type Layout = {
  files: string[];
  ignores: Map<string, string[]>; // dir -> lines
  exclude?: string[];
  excludesFile?: string[];
};

function genLayout(seed: number): Layout {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const occupied = new Map<string, "f" | "d">();
  const files: string[] = [];
  const nf = 8 + Math.floor(r() * 20);
  for (let i = 0; i < nf; i++) {
    const depth = Math.floor(r() * 5);
    const dirs = Array.from({ length: depth }, () => pick(DIRS));
    const name = r() < 0.7 ? pick(NAMES) : pick(DIRS);
    const parts = [...dirs, name];
    let ok = true;
    for (let k = 1; k < parts.length; k++) {
      if (occupied.get(parts.slice(0, k).join("/")) === "f") ok = false;
    }
    const p = parts.join("/");
    if (occupied.has(p)) ok = false;
    if (parts.includes(".git")) ok = false;
    if (!ok) continue;
    for (let k = 1; k < parts.length; k++) occupied.set(parts.slice(0, k).join("/"), "d");
    occupied.set(p, "f");
    files.push(p);
  }
  const dirList = [...occupied].filter(([, k]) => k === "d").map(([p]) => p);
  const pattern = () => {
    const core = pick(CORES);
    const d = pick(DIRS);
    const shapes = [
      () => core,
      () => core,
      () => core,
      () => `/${core}`,
      () => `${core}/`,
      () => `/${core}/`,
      () => `${d}/${core}`,
      () => `**/${core}`,
      () => `${core}/**`,
      () => `${d}/**/${core}`,
      () => `${d}/*/${core}`,
      () => `**/${d}/${core}`,
      () => `${d}/**`,
      () => `/${d}/${core}/`,
      () => `${d}/${core}/`,
      () => `**/${core}/`,
      () => `${d}/**/`,
      () => `**/${d}/**`,
    ];
    let p = pick(shapes)();
    const x = r();
    if (x < 0.35) p = `!${p}`;
    if (r() < 0.1) p = `${p}  `;
    if (r() < 0.05) p = `# ${p}`;
    return p;
  };
  const lines = (n: number) => Array.from({ length: n }, pattern);
  const ignores = new Map<string, string[]>();
  ignores.set("", lines(1 + Math.floor(r() * 6)));
  const nn = Math.floor(r() * 4);
  for (let i = 0; i < nn && dirList.length; i++) {
    const dir = pick(dirList);
    ignores.set(dir, lines(1 + Math.floor(r() * 4)));
  }
  const L: Layout = { files, ignores };
  if (r() < 0.3) L.exclude = lines(1 + Math.floor(r() * 3));
  if (r() < 0.3) L.excludesFile = lines(1 + Math.floor(r() * 3));
  return L;
}

function build(repo: string, L: Layout) {
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  for (const f of L.files) {
    mkdirSync(join(repo, f, ".."), { recursive: true });
    writeFileSync(join(repo, f), "x\n");
  }
  for (const [dir, lines] of L.ignores) {
    mkdirSync(join(repo, dir), { recursive: true });
    writeFileSync(join(repo, dir, ".gitignore"), `${lines.join("\n")}\n`);
  }
  if (L.exclude) {
    mkdirSync(join(repo, ".git", "info"), { recursive: true });
    writeFileSync(join(repo, ".git", "info", "exclude"), `${L.exclude.join("\n")}\n`);
  }
  if (L.excludesFile) {
    writeFileSync(join(repo, ".git", "my-excludes"), `${L.excludesFile.join("\n")}\n`);
    git(repo, ["config", "core.excludesFile", join(repo, ".git", "my-excludes")]);
  } else {
    // keep git from reading $XDG_CONFIG_HOME/git/ignore
    writeFileSync(join(repo, ".git", "empty-excludes"), "");
    git(repo, ["config", "core.excludesFile", join(repo, ".git", "empty-excludes")]);
  }
}

async function open(dir: string, excludes: boolean) {
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
  await staging.read();
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
    ...(excludes ? { globalExcludesFile: ".git/my-excludes" } : {}),
  });
  const wc = new MemoryWorkingCopy({ history, checkout, worktree, config });
  return { g: Git.fromWorkingCopy(wc), worktree };
}

function allPaths(L: Layout): { files: string[]; dirs: string[] } {
  const files = new Set(L.files);
  for (const d of L.ignores.keys()) files.add(d ? `${d}/.gitignore` : ".gitignore");
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let k = 1; k < parts.length; k++) dirs.add(parts.slice(0, k).join("/"));
  }
  return { files: [...files].sort(), dirs: [...dirs].sort() };
}

async function one(root: string, seed: number) {
  const L = genLayout(seed);
  const repo = join(root, `r${seed}`);
  build(repo, L);
  const { files, dirs } = allPaths(L);
  const all = [...files, ...dirs];
  // native check-ignore
  const out = git(
    repo,
    ["check-ignore", "--no-index", "-v", "-n", "-z", "--stdin"],
    `${all.join("\0")}\0`,
  );
  const toks = out.split("\0");
  const gitCI = new Map<string, { ignored: boolean; why: string }>();
  for (let i = 0; i + 3 < toks.length; i += 4) {
    const [src, line, pat, path] = toks.slice(i, i + 4);
    gitCI.set(path, {
      ignored: pat !== "" && !pat.startsWith("!"),
      why: pat ? `${src}:${line}:${pat}` : "",
    });
  }
  // native status
  const st = git(repo, ["status", "--porcelain=v1", "-z", "--ignored", "-uall"])
    .split("\0")
    .filter(Boolean);
  const gitStatus = new Map<string, string>();
  for (const e of st) {
    const code = e.slice(0, 2);
    const p = e.slice(3);
    if (p.endsWith("/")) {
      for (const f of files) if (f.startsWith(p)) gitStatus.set(f, code);
    } else gitStatus.set(p, code);
  }
  // ours
  const { g, worktree } = await open(repo, !!L.excludesFile);
  const status = await g.status().setUntrackedFiles("all").setIgnored(true).call();
  const ourStatus = new Map<string, string>();
  for (const f of status.files) ourStatus.set(f.path, `${f.index}${f.worktree}`);
  const ourWalk = new Map<string, boolean>();
  for await (const e of worktree.walk({ includeIgnored: true, includeDirectories: true })) {
    ourWalk.set(e.path, e.isIgnored);
  }
  const diffs: string[] = [];
  for (const p of all) {
    const gi = gitCI.get(p);
    if (!gi) {
      diffs.push(`no check-ignore result for ${p}`);
      continue;
    }
    const isFile = files.includes(p);
    const ow = ourWalk.get(p);
    // the walk's own flag is the rules on the path (+ ancestors via the manager)
    if (ow !== undefined && ow !== gi.ignored)
      diffs.push(
        `walk ${isFile ? "file" : "dir "} ${JSON.stringify(p)}: ours=${ow} git=${gi.ignored} (${gi.why})`,
      );
    if (ow === undefined) diffs.push(`walk missing ${p}`);
    const oi = await worktree.isIgnored(p);
    if (oi !== gi.ignored)
      diffs.push(
        `isIgnored ${isFile ? "file" : "dir "} ${JSON.stringify(p)}: ours=${oi} git=${gi.ignored} (${gi.why})`,
      );
    if (isFile) {
      const gs = gitStatus.get(p) ?? "--";
      const os = ourStatus.get(p) ?? "--";
      if (gs !== os) diffs.push(`status ${JSON.stringify(p)}: ours=${os} git=${gs} (${gi.why})`);
    }
  }
  rmSync(repo, { recursive: true, force: true });
  return { seed, L: { ...L, ignores: Object.fromEntries(L.ignores) }, diffs };
}

describeGit("ignore rules against native git (differential fuzz)", () => {
  it(`match git check-ignore and status (${ONLY !== undefined ? `seed ${ONLY}` : `seeds ${START}..${START + COUNT - 1}`})`, async () => {
    const root = mkdtempSync(join(tmpdir(), "ign-diff-"));
    home = join(root, "home");
    mkdirSync(home);
    const seeds = ONLY !== undefined ? [ONLY] : Array.from({ length: COUNT }, (_, i) => START + i);
    const bad = [];
    for (const s of seeds) {
      const res = await one(root, s);
      if (res.diffs.length) bad.push(res);
    }
    rmSync(root, { recursive: true, force: true });
    if (OUT)
      writeFileSync(
        OUT,
        JSON.stringify({ git: git(tmpdir(), ["--version"]).trim(), n: seeds.length, bad }, null, 1),
      );
    expect(bad).toEqual([]);
  }, 3_600_000);
});
