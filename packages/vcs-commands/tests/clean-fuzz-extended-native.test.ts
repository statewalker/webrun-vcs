/**
 * The extended `git clean` differential fuzz against native git: deeper nesting, nested
 * `.gitignore` files, `info/exclude`, `core.excludesFile`, `**`, classes, escapes and varied
 * pathspecs (magic included), on top of the layouts of `clean-fuzz-native.test.ts`. Each
 * seeded layout is built twice, native `git clean` runs in one build and ours in the other,
 * and nothing git keeps may be gone in ours (class (a), data loss). Over-keeps (class (b),
 * e.g. a `.git` naming a place beyond the root, which cannot be checked) and dry-run
 * differences are reported, not failed.
 *
 * A small number of seeds runs by default; `CLEAN_FUZZ_EXTENDED=full` runs the full sweep
 * (seeds 40000-40999, or `CLEAN_FUZZ_EXTENDED_START` / `_COUNT`),
 * `CLEAN_FUZZ_EXTENDED_SEED=<n>` one seed, `CLEAN_FUZZ_EXTENDED_OUT=<file>` writes every
 * difference as JSON.
 */
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const FULL = process.env.CLEAN_FUZZ_EXTENDED === "full";
const START = Number(process.env.CLEAN_FUZZ_EXTENDED_START ?? 40000);
const COUNT = Number(process.env.CLEAN_FUZZ_EXTENDED_COUNT ?? (FULL ? 1000 : 40));
const OUT = process.env.CLEAN_FUZZ_EXTENDED_OUT;
const ONLY = process.env.CLEAN_FUZZ_EXTENDED_SEED
  ? Number(process.env.CLEAN_FUZZ_EXTENDED_SEED)
  : undefined;

let home = "";
let tmpl = "";
const env = () => ({ ...nativeGitEnv(home), GIT_TEMPLATE_DIR: tmpl });
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: env(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const tryGit = (cwd: string, ...args: string[]) => {
  try {
    return git(cwd, ...args);
  } catch {
    return undefined;
  }
};
const put = (p: string, c: string) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, c);
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

const SEGS = ["a", "b", "u", "w", "ign", "build", "cache", "out", "deep", "x", "k", "sub"];
const FILES = ["f.txt", "n.txt", "keep.log", "a.log", "c.o", "x.tmp", "p.txt", "keep.txt", "build"];
const PATTERNS = [
  "*.log",
  "*.o",
  "ign/",
  "build",
  "!keep.log",
  "cache/*",
  "deep/**/out/",
  "*.tmp",
  "x/",
  "/u/k/",
  "lnk*",
  "!build/keep.o",
  "k",
  "*.git",
  ".git",
  "sub/",
  "!sub/keep.txt",
  "out",
];
const NESTED_IGN = ["!*.log", "*.txt", "!keep.txt", "sub/", "!x/", "*", "!*/", "a/", "*.o", "!c.o"];
const KINDS = [
  "tracked",
  "trackedIgnored",
  "staged",
  "ita",
  "untracked",
  "untracked",
  "ignoredFile",
  "emptyDir",
  "nested",
  "nestedGitfileRel",
  "nestedGitfileAbs",
  "gitfileViaSymlink",
  "dotGitSymlink",
  "bare",
  "fakeGitEmpty",
  "fakeGitFiles",
  "fakeGitInner",
  "fakeGitFileJunk",
  "danglingGitLink",
  "gitlinkWithDir",
  "gitlinkNoDir",
  "symlinkOutDir",
  "symlinkOutFile",
  "symlinkLoop",
  "ignoredSymlink",
  "nestedGitignore",
  "deep",
  "symlinkInside",
  "linkedWorktree",
  "untrackedInNested",
] as const;
type Kind = (typeof KINDS)[number];
type Step = { kind: Kind; path: string; v: number };
type Flags = { d: boolean; x: boolean; X: boolean; ff: boolean };
type Layout = {
  ignore: string[];
  steps: Step[];
  flags: Flags;
  flagName: string;
  paths: string[];
  exclude?: string[];
  excludesFile?: string[];
  nestedIgnores?: Array<{ dir: string; lines: string[] }>;
};

const FLAGSETS: Array<[string, Flags]> = [
  ["-f", { d: false, x: false, X: false, ff: false }],
  ["-x", { d: false, x: true, X: false, ff: false }],
  ["-d", { d: true, x: false, X: false, ff: false }],
  ["-dx", { d: true, x: true, X: false, ff: false }],
  ["-X", { d: false, x: false, X: true, ff: false }],
  ["-Xd", { d: true, x: false, X: true, ff: false }],
  ["-dff", { d: true, x: false, X: false, ff: true }],
  ["-dxff", { d: true, x: true, X: false, ff: true }],
  ["-Xdff", { d: true, x: false, X: true, ff: true }],
];

function genLayout(seed: number): Layout {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const dir = () => {
    const n = Math.floor(r() * 6);
    return Array.from({ length: n }, () => pick(SEGS)).join("/");
  };
  const genPat = () => {
    if (r() < 0.3) return pick(PATTERNS);
    const core = pick([
      ...SEGS,
      ...FILES,
      "*.log",
      "*.txt",
      "*",
      "k*",
      "*o*",
      "?",
      "[a-c]",
      "[!a]*",
      "*.[lt]*",
      "\\*.txt",
    ]);
    const d = pick(SEGS);
    const shapes = [
      core,
      core,
      `/${core}`,
      `${core}/`,
      `/${core}/`,
      `${d}/${core}`,
      `**/${core}`,
      `${core}/**`,
      `${d}/**/${core}`,
      `${d}/*/${core}`,
      `**/${d}/${core}`,
      `${d}/**`,
      `**/${core}/`,
      `${d}/${core}/`,
      `${d}/**/`,
    ];
    let p = pick(shapes);
    if (r() < 0.35) p = `!${p}`;
    if (r() < 0.08) p = `${p}  `;
    return p;
  };
  const ignore = Array.from({ length: 1 + Math.floor(r() * 7) }, genPat);
  const exclude = r() < 0.3 ? Array.from({ length: 1 + Math.floor(r() * 3) }, genPat) : undefined;
  const excludesFile =
    r() < 0.3 ? Array.from({ length: 1 + Math.floor(r() * 3) }, genPat) : undefined;
  const nestedIgnores = Array.from({ length: Math.floor(r() * 4) }, () => ({
    dir: dir() || pick(SEGS),
    lines: Array.from({ length: 1 + Math.floor(r() * 4) }, genPat),
  }));
  const steps: Step[] = [];
  const n = 4 + Math.floor(r() * 12);
  for (let i = 0; i < n; i++) {
    const kind = pick(KINDS);
    const base = dir();
    const leaf =
      kind.includes("File") ||
      kind === "tracked" ||
      kind === "staged" ||
      kind === "ita" ||
      kind === "untracked" ||
      kind === "trackedIgnored"
        ? pick(FILES)
        : pick(SEGS);
    steps.push({ kind, path: base ? `${base}/${leaf}` : leaf, v: Math.floor(r() * 1000) });
  }
  const [flagName, flags] = pick(FLAGSETS);
  const paths: string[] = [];
  if (r() < 0.4) {
    const k = 1 + Math.floor(r() * 2);
    for (let i = 0; i < k; i++) {
      const c = r();
      if (c < 0.45)
        paths.push(
          pick(steps)
            .path.split("/")
            .slice(0, 1 + Math.floor(r() * 3))
            .join("/"),
        );
      else
        paths.push(
          pick([
            "*.log",
            "*.txt",
            `${pick(SEGS)}/*`,
            `*/${pick(SEGS)}*`,
            `${pick(SEGS)}*`,
            "*/p.txt",
            "*o",
            "?/*",
            `${pick(SEGS)}/`,
            `./${pick(SEGS)}`,
            `${pick(SEGS)}/**`,
            `**/${pick(FILES)}`,
            `**/${pick(SEGS)}/`,
            "[a-c]*",
            "[!a]*/*",
            `${pick(SEGS)}/[a-k]*`,
            "\\*.txt",
            `${pick(SEGS)}//${pick(SEGS)}`,
            `${pick(steps).path}/`,
            `./${pick(steps).path.split("/").slice(0, 2).join("/")}/`,
            `${pick(steps).path.split("/").slice(0, 3).join("/")}*`,
          ]),
        );
    }
  }
  return { ignore, steps, flags, flagName, paths, exclude, excludesFile, nestedIgnores };
}

/** Builds the layout in `top/repo` (outside targets in `top/out`, links in `top`). */
function build(top: string, L: Layout): void {
  const repo = join(top, "repo");
  const out = join(top, "out");
  mkdirSync(repo, { recursive: true });
  mkdirSync(out, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  put(join(repo, ".gitignore"), `${L.ignore.join("\n")}\n`);
  put(join(repo, "root.txt"), "root\n");
  const commitAdds = [".gitignore", "root.txt"];
  const post: Array<() => void> = [];
  const occupied = new Map<string, string>(); // path -> kind boundary (file|link|dir)
  const blocked = (p: string) => {
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const anc = parts.slice(0, i).join("/");
      const k = occupied.get(anc);
      if (k === "file" || k === "link") return true;
    }
    if (occupied.has(p)) return true;
    // never inside the root's own .git
    if (parts[0] === ".git") return true;
    return false;
  };
  const A = (p: string) => join(repo, p);
  const mark = (p: string, k: string) => {
    occupied.set(p, k);
    const parts = p.split("/");
    for (let i = 1; i < parts.length; i++) {
      const anc = parts.slice(0, i).join("/");
      if (!occupied.has(anc)) occupied.set(anc, "dir");
    }
  };
  const fakeSha = "1234567890123456789012345678901234567890";
  L.steps.forEach((s, idx) => {
    const p = s.path;
    if (blocked(p)) return;
    const v = s.v;
    const absOrRel = v % 2 === 0;
    switch (s.kind) {
      case "tracked":
        put(A(p), `t${idx}\n`);
        mark(p, "file");
        commitAdds.push(p);
        break;
      case "trackedIgnored": {
        const q = p.replace(/[^/]+$/, `ti${idx}.log`);
        if (blocked(q)) return;
        put(A(q), `ti\n`);
        mark(q, "file");
        commitAdds.push(q);
        break;
      }
      case "staged":
        put(A(p), `s${idx}\n`);
        mark(p, "file");
        post.push(() => tryGit(repo, "add", "-f", "--", p));
        break;
      case "ita":
        put(A(p), `i${idx}\n`);
        mark(p, "file");
        post.push(() => tryGit(repo, "add", "-N", "-f", "--", p));
        break;
      case "untracked":
        put(A(p), `u${idx}\n`);
        mark(p, "file");
        break;
      case "ignoredFile": {
        const q = p.replace(/[^/]+$/, v % 3 === 0 ? "z.o" : v % 3 === 1 ? "z.log" : "z.tmp");
        if (blocked(q)) return;
        put(A(q), "z\n");
        mark(q, "file");
        break;
      }
      case "emptyDir":
        mkdirSync(A(p), { recursive: true });
        mark(p, "dir");
        break;
      case "nested":
        mkdirSync(A(p), { recursive: true });
        git(A(p), "init", "-q");
        put(A(`${p}/p.txt`), "precious\n");
        if (v % 3 === 0) {
          git(A(p), "add", "p.txt");
          git(A(p), "commit", "-qm", "n");
        }
        if (v % 4 === 0) put(A(`${p}/ign/z.log`), "nz\n");
        mark(p, "dir");
        break;
      case "untrackedInNested": {
        // a nested repo with a nested repo/fake .git inside it
        mkdirSync(A(p), { recursive: true });
        git(A(p), "init", "-q");
        put(A(`${p}/p.txt`), "precious\n");
        mkdirSync(A(`${p}/in`), { recursive: true });
        git(A(`${p}/in`), "init", "-q");
        put(A(`${p}/in/q.txt`), "q\n");
        mark(p, "dir");
        break;
      }
      case "nestedGitfileRel":
      case "nestedGitfileAbs": {
        const target = v % 3 === 0 ? join(out, `gd${idx}`) : join(repo, ".git", "mods", `m${idx}`);
        mkdirSync(join(A(p), ".."), { recursive: true });
        mkdirSync(join(target, ".."), { recursive: true });
        git(repo, "init", "-q", `--separate-git-dir=${target}`, A(p));
        if (s.kind === "nestedGitfileRel")
          writeFileSync(A(`${p}/.git`), `gitdir: ${relative(A(p), target)}\n`);
        put(A(`${p}/p.txt`), "precious\n");
        mark(p, "dir");
        break;
      }
      case "gitfileViaSymlink": {
        const real = join(out, `real${idx}`);
        mkdirSync(real, { recursive: true });
        const link = join(top, `outlink${idx}`);
        symlinkSync(absOrRel ? real : relative(top, real), link);
        mkdirSync(A(p), { recursive: true });
        git(repo, "init", "-q", `--separate-git-dir=${join(link, "g.git")}`, A(p));
        const via = join(link, "g.git");
        writeFileSync(A(`${p}/.git`), `gitdir: ${v % 3 === 0 ? relative(A(p), via) : via}\n`);
        put(A(`${p}/p.txt`), "precious\n");
        mark(p, "dir");
        break;
      }
      case "dotGitSymlink": {
        const target = v % 3 === 0 ? join(out, `sg${idx}`) : join(repo, ".git", "mods", `s${idx}`);
        git(repo, "init", "-q", "--bare", target);
        mkdirSync(A(p), { recursive: true });
        symlinkSync(absOrRel ? target : relative(A(p), target), A(`${p}/.git`));
        put(A(`${p}/p.txt`), "precious\n");
        mark(p, "dir");
        break;
      }
      case "bare":
        mkdirSync(join(A(p), ".."), { recursive: true });
        git(repo, "init", "-q", "--bare", A(p));
        if (v % 2) put(A(`${p}/extra.txt`), "e\n");
        mark(p, "dir");
        break;
      case "fakeGitEmpty":
        mkdirSync(A(`${p}/.git`), { recursive: true });
        put(A(`${p}/f.txt`), "f\n");
        mark(p, "dir");
        break;
      case "fakeGitFiles":
        mkdirSync(A(`${p}/.git`), { recursive: true });
        put(A(`${p}/.git/junk`), "j\n");
        put(A(`${p}/.git/sub/j.log`), "j\n");
        if (v % 2) put(A(`${p}/.git/HEAD`), "ref: refs/heads/main\n");
        if (v % 3 === 0) mkdirSync(A(`${p}/.git/empty`), { recursive: true });
        put(A(`${p}/x.txt`), "x\n");
        mark(p, "dir");
        break;
      case "fakeGitInner": {
        const depth = 1 + (v % 3);
        const inner = `${p}/.git/${Array.from({ length: depth }, (_, i) => `d${i}`).join("/")}`;
        mkdirSync(A(inner), { recursive: true });
        git(A(inner), "init", "-q");
        put(A(`${inner}/p.txt`), "precious\n");
        if (v % 2) put(A(`${p}/.git/loose.txt`), "l\n");
        if (v % 5 === 0) {
          mkdirSync(A(`${p}/.git/fake2/.git`), { recursive: true });
          put(A(`${p}/.git/fake2/y.txt`), "y\n");
        }
        put(A(`${p}/x.txt`), "x\n");
        mark(p, "dir");
        break;
      }
      case "fakeGitFileJunk":
        mkdirSync(A(p), { recursive: true });
        writeFileSync(
          A(`${p}/.git`),
          v % 2 ? "not a gitdir\n" : `gitdir: ${v % 3 ? "missing/dir" : join(out, "nope")}\n`,
        );
        put(A(`${p}/x.txt`), "x\n");
        mark(p, "dir");
        break;
      case "danglingGitLink":
        mkdirSync(A(p), { recursive: true });
        symlinkSync(absOrRel ? join(out, "missing-target") : "missing", A(`${p}/.git`));
        put(A(`${p}/x.txt`), "x\n");
        mark(p, "dir");
        break;
      case "gitlinkWithDir":
        mkdirSync(A(p), { recursive: true });
        if (v % 2) {
          git(A(p), "init", "-q");
        }
        put(A(`${p}/p.txt`), "precious\n");
        mark(p, "dir");
        post.push(() =>
          tryGit(repo, "update-index", "--add", "--cacheinfo", `160000,${fakeSha},${p}`),
        );
        break;
      case "gitlinkNoDir":
        mark(p, "file");
        post.push(() =>
          tryGit(repo, "update-index", "--add", "--cacheinfo", `160000,${fakeSha},${p}`),
        );
        break;
      case "symlinkOutDir": {
        const od = join(out, `od${idx}`);
        put(join(od, "precious.txt"), "o\n");
        put(join(od, "z.log"), "o\n");
        mkdirSync(join(od, "deep"), { recursive: true });
        put(join(od, "deep", "d.txt"), "o\n");
        mkdirSync(join(A(p), ".."), { recursive: true });
        symlinkSync(absOrRel ? od : relative(join(A(p), ".."), od), A(p));
        mark(p, "link");
        break;
      }
      case "symlinkOutFile": {
        const of = join(out, `of${idx}.txt`);
        put(of, "o\n");
        mkdirSync(join(A(p), ".."), { recursive: true });
        symlinkSync(absOrRel ? of : relative(join(A(p), ".."), of), A(p));
        mark(p, "link");
        break;
      }
      case "symlinkLoop":
        mkdirSync(A(p), { recursive: true });
        symlinkSync("l2", A(`${p}/l1`));
        symlinkSync("l1", A(`${p}/l2`));
        symlinkSync("self", A(`${p}/self`));
        symlinkSync("..", A(`${p}/up`));
        mark(p, "dir");
        break;
      case "ignoredSymlink": {
        const name = v % 3 === 0 ? "l.log" : v % 3 === 1 ? "ign" : "build";
        const q = p.replace(/[^/]+$/, name);
        if (blocked(q)) return;
        const od = join(out, `il${idx}`);
        put(join(od, "precious.txt"), "o\n");
        mkdirSync(join(A(q), ".."), { recursive: true });
        symlinkSync(v % 2 ? od : relative(join(A(q), ".."), od), A(q));
        mark(q, "link");
        break;
      }
      case "nestedGitignore": {
        const rules = Array.from(
          { length: 1 + (v % 3) },
          (_, i) => NESTED_IGN[(v + i * 7) % NESTED_IGN.length],
        );
        put(A(`${p}/.gitignore`), `${rules.join("\n")}\n`);
        put(A(`${p}/keep.log`), "k\n");
        put(A(`${p}/a.txt`), "a\n");
        put(A(`${p}/sub/c.o`), "c\n");
        put(A(`${p}/x/keep.txt`), "k\n");
        if (v % 2) commitAdds.push(`${p}/.gitignore`);
        mark(p, "dir");
        break;
      }
      case "deep": {
        const depth = 4 + (v % 4);
        const segs = Array.from({ length: depth }, (_, i) => SEGS[(v + i * 5) % SEGS.length]);
        const q = `${p}/${segs.join("/")}`;
        put(A(`${q}/${FILES[v % FILES.length]}`), "d\n");
        if (v % 3 === 0) mkdirSync(A(`${q}/empty`), { recursive: true });
        mark(p, "dir");
        break;
      }
      case "symlinkInside": {
        mkdirSync(join(A(p), ".."), { recursive: true });
        symlinkSync(v % 2 ? "." : "..", A(p));
        mark(p, "link");
        break;
      }
      case "linkedWorktree":
        mkdirSync(join(A(p), ".."), { recursive: true });
        mark(p, "dir");
        post.push(() => {
          tryGit(repo, "worktree", "add", "-q", "--detach", A(p));
        });
        break;
    }
  });
  if (L.exclude) put(join(repo, ".git", "info", "exclude"), `${L.exclude.join("\n")}\n`);
  put(join(repo, ".git", "my-excludes"), `${(L.excludesFile ?? []).join("\n")}\n`);
  git(repo, "config", "core.excludesFile", join(repo, ".git", "my-excludes"));
  for (const ni of L.nestedIgnores ?? []) {
    if (blocked(`${ni.dir}/.gitignore`)) continue;
    try {
      put(A(`${ni.dir}/.gitignore`), `${ni.lines.join("\n")}\n`);
      mark(`${ni.dir}/.gitignore`, "file");
      if (ni.lines.length % 2) commitAdds.push(`${ni.dir}/.gitignore`);
    } catch {}
  }
  for (const p of commitAdds) tryGit(repo, "add", "-f", "--", p);
  git(repo, "commit", "-qm", "c1", "--allow-empty");
  for (const f of post) f();
}

/** Every entry below `top` (lstat), with type and link target; twin path normalised. */
function listing(top: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let names: string[];
    try {
      names = readdirSync(join(top, rel));
    } catch {
      return;
    }
    for (const name of names) {
      const p = rel ? `${rel}/${name}` : name;
      if (p === "repo/.git/index" || p === "repo/.git/index.lock") continue;
      const st = lstatSync(join(top, p));
      if (st.isSymbolicLink())
        out.push(`${p} -> ${readlinkSync(join(top, p)).split(top).join("<T>")}`);
      else if (st.isDirectory()) {
        out.push(`${p}/`);
        walk(p);
      } else out.push(p);
    }
  };
  walk("");
  return out.sort();
}

async function open(dir: string) {
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
    globalExcludesFile: ".git/my-excludes",
    blobs: history.blobs,
    trees: history.trees,
  });
  const wc = new MemoryWorkingCopy({ history, checkout, worktree, config });
  return Git.fromWorkingCopy(wc);
}

async function ours(repo: string, L: Layout, dryRun: boolean) {
  const g = await open(repo);
  let c = g
    .clean()
    .setCleanDirectories(L.flags.d)
    .setIgnore(!L.flags.x)
    .setIgnoredOnly(L.flags.X)
    .setForceNestedRepositories(L.flags.ff)
    .setDryRun(dryRun);
  if (L.paths.length) c = c.setPaths(new Set(L.paths));
  return c.call();
}

/** Runs one layout in two builds (native and ours) under `root`; what differs. */
async function twin(root: string, seed: number, L: Layout) {
  const n = join(root, `${seed}-n`);
  const o = join(root, `${seed}-o`);
  try {
    build(n, L);
    build(o, L);
  } catch (e) {
    rmSync(n, { recursive: true, force: true });
    rmSync(o, { recursive: true, force: true });
    return { seed, buildErr: String(e).slice(0, 300) };
  }
  const args = ["clean", L.flags.ff ? "-ff" : "-f"];
  if (L.flags.d) args.push("-d");
  if (L.flags.x) args.push("-x");
  if (L.flags.X) args.push("-X");
  const spec = L.paths.length ? ["--", ...L.paths] : [];
  let dryOut = "";
  let nativeErr = "";
  try {
    dryOut = git(join(n, "repo"), ...args, "-n", ...spec);
    git(join(n, "repo"), ...args, "-q", ...spec);
  } catch (e) {
    nativeErr = String((e as { stderr?: string }).stderr ?? e).slice(0, 300);
  }
  const lines = dryOut.split("\n").filter(Boolean);
  const pick = (prefix: string) =>
    lines
      .filter((l) => l.startsWith(prefix))
      .map((l) => l.slice(prefix.length))
      .sort();
  let err = "";
  let ourRemove: string[] = [];
  let ourSkip: string[] = [];
  if (!nativeErr) {
    try {
      const dry = await ours(join(o, "repo"), L, true);
      ourRemove = [...dry.cleaned].sort();
      ourSkip = [...dry.skipped].sort();
      await ours(join(o, "repo"), L, false);
    } catch (e) {
      err = String(e).slice(0, 300);
    }
  }
  const after = new Set(listing(n));
  const afterO = new Set(listing(o));
  rmSync(n, { recursive: true, force: true });
  rmSync(o, { recursive: true, force: true });
  const gitRemove = pick("Would remove ");
  const gitSkip = pick("Would skip repository ");
  return {
    seed,
    L,
    nativeErr,
    err,
    // (a): gone in ours, kept by git; (b): kept in ours, removed by git
    lost: nativeErr ? [] : [...after].filter((p) => !afterO.has(p)),
    kept: nativeErr ? [] : [...afterO].filter((p) => !after.has(p)),
    dryMismatch:
      !nativeErr &&
      (gitRemove.join("\n") !== ourRemove.join("\n") || gitSkip.join("\n") !== ourSkip.join("\n")),
    gitRemove,
    ourRemove,
    gitSkip,
    ourSkip,
  };
}

describeGit("extended clean differential fuzz against native git", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clean-fuzz-"));
    home = join(root, "home");
    tmpl = join(root, "tmpl");
    mkdirSync(home);
    mkdirSync(tmpl);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it(`never removes what git keeps (${ONLY !== undefined ? `seed ${ONLY}` : `seeds ${START}..${START + COUNT - 1}`})`, async () => {
    const seeds = ONLY !== undefined ? [ONLY] : Array.from({ length: COUNT }, (_, i) => START + i);
    const differences: Array<Awaited<ReturnType<typeof twin>>> = [];
    for (const seed of seeds) {
      const result = await twin(root, seed, genLayout(seed));
      if ("buildErr" in result) continue;
      if (result.lost.length || result.kept.length || result.dryMismatch || result.err) {
        differences.push(result);
      }
    }
    if (OUT)
      writeFileSync(
        OUT,
        JSON.stringify({ git: git(root, "--version").trim(), differences }, null, 1),
      );
    const lost = differences
      .filter((d) => (d.lost?.length ?? 0) > 0 || d.err)
      .map((d) => ({ seed: d.seed, lost: d.lost, err: d.err, layout: d.L }));
    expect(lost).toEqual([]);
  }, 3_600_000);
});
