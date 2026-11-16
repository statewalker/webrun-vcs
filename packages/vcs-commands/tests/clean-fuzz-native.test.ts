/**
 * `git clean` against native git on randomized layouts (a differential fuzz): each seeded
 * layout (tracked, ignored, nested repositories, gitfiles, `.git` links, fake `.git`
 * directories, submodule entries, links, nested `.gitignore` files...) is built twice, native
 * `git clean` runs in one build and ours in the other with the same flags and path filters,
 * and nothing git keeps may be gone in ours (class (a), data loss). Over-keeps (class (b))
 * and dry-run differences are reported, not failed.
 *
 * A moderate number of seeds runs by default; `CLEAN_FUZZ=full` runs the full sweep (seeds
 * 1001-2500, or `CLEAN_FUZZ_START` / `CLEAN_FUZZ_COUNT`), `CLEAN_FUZZ_SEED=<n>` one seed,
 * `CLEAN_FUZZ_OUT=<file>` writes every difference as JSON.
 *
 * Named twins below pin the minimal repros the fuzz found.
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

const FULL = process.env.CLEAN_FUZZ === "full";
const START = Number(process.env.CLEAN_FUZZ_START ?? 1001);
const COUNT = Number(process.env.CLEAN_FUZZ_COUNT ?? (FULL ? 1500 : 80));
const OUT = process.env.CLEAN_FUZZ_OUT;
const ONLY = process.env.CLEAN_FUZZ_SEED ? Number(process.env.CLEAN_FUZZ_SEED) : undefined;

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
type Layout = { ignore: string[]; steps: Step[]; flags: Flags; flagName: string; paths: string[] };

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
    const n = Math.floor(r() * 4);
    return Array.from({ length: n }, () => pick(SEGS)).join("/");
  };
  const ignore = Array.from({ length: 1 + Math.floor(r() * 5) }, () => pick(PATTERNS));
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
          ]),
        );
    }
  }
  return { ignore, steps, flags, flagName, paths };
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

describeGit("clean differential fuzz against native git", () => {
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

type Repro = {
  setup: (repo: string, top: string) => void;
  flags: string[];
  /** ours may keep more than git (a target outside the root it cannot check), never less */
  overKeep?: boolean;
};

/** `-dff:x,*.txt` as flags and path filters. */
function parseFlags(flag: string): { L: Layout; args: string[]; spec: string[] } {
  const [fl, ps] = flag.split(":");
  const paths = ps ? ps.split(",") : [];
  const flags: Flags = {
    d: fl.includes("d"),
    x: fl.includes("x"),
    X: fl.includes("X"),
    ff: fl.includes("ff"),
  };
  const args = ["clean", flags.ff ? "-ff" : "-f"];
  if (flags.d) args.push("-d");
  if (flags.x) args.push("-x");
  if (flags.X) args.push("-X");
  return {
    L: { ignore: [], steps: [], flags, flagName: fl, paths },
    args,
    spec: paths.length ? ["--", ...paths] : [],
  };
}

const commitAll = (r: string) => {
  git(r, "add", "-A");
  git(r, "commit", "-qm", "c", "--allow-empty");
};

const REPROS: Record<string, Repro> = {
  // A4: a negated directory-only rule re-includes directories, never the files below them
  "nested .gitignore !*/ keeps files ignored by a parent rule": {
    flags: ["-d", "-f", "-dx", "-Xd"],
    setup: (r) => {
      put(join(r, ".gitignore"), "*.o\n");
      commitAll(r);
      put(join(r, "w/.gitignore"), "!*/\n");
      put(join(r, "w/sub/c.o"), "precious\n");
      put(join(r, "w/c.o"), "precious\n");
      put(join(r, "w/u.txt"), "u\n");
    },
  },
  // A3: a glob next to a plain path makes git descend; the plain-named directory is not
  // taken whole
  "-ff with a plain path and a glob keeps the nested repository below": {
    flags: ["-dff:x,*.txt", "-dff:x", "-ff:x,*.txt", "-d:x,*.txt"],
    setup: (r) => {
      commitAll(r);
      mkdirSync(join(r, "x/w"), { recursive: true });
      git(join(r, "x/w"), "init", "-q");
      put(join(r, "x/w/p.txt"), "precious\n");
      put(join(r, "x/u.txt"), "u\n");
      mkdirSync(join(r, "x/fake/.git"), { recursive: true });
      put(join(r, "x/fake/.git/junk"), "j\n");
      mkdirSync(join(r, "x/empty"), { recursive: true });
    },
  },
  // A2: a glob matching a directory's name does not take the directory
  "a glob matching a directory name removes nothing in it": {
    flags: ["-f:*o", "-d:*o", "-dx:*o", "-d:src/*o", "-d:proto"],
    setup: (r) => {
      commitAll(r);
      put(join(r, "proto/a.c"), "precious\n");
      put(join(r, "src/repo/b.c"), "precious\n");
    },
  },
  "a glob matching a fake-.git directory's name": {
    flags: ["-f:*.txt", "-d:*.txt", "-d:keep.txt,*.log"],
    setup: (r) => {
      commitAll(r);
      put(join(r, "keep.txt/.git/junk"), "precious\n");
      put(join(r, "keep.txt/x.txt"), "x\n");
      put(join(r, "keep.txt/y.dat"), "precious\n");
    },
  },
  // A1: an ignored nested repository keeps its untracked parent under -ff without -x
  "an ignored nested repository in an untracked directory": {
    flags: ["-dff", "-dxff", "-Xdff", "-d"],
    setup: (r) => {
      put(join(r, ".gitignore"), "ign/\n");
      commitAll(r);
      mkdirSync(join(r, "w/ign"), { recursive: true });
      git(join(r, "w/ign"), "init", "-q");
      put(join(r, "w/ign/p.txt"), "precious\n");
      put(join(r, "w/u.txt"), "u\n");
    },
  },
  "an ignored gitfile repository and an ignored .git link repository": {
    flags: ["-dff", "-dxff", "-Xdff"],
    setup: (r) => {
      put(join(r, ".gitignore"), "ign*/\n");
      commitAll(r);
      mkdirSync(join(r, "w"), { recursive: true });
      mkdirSync(join(r, ".git/mods"), { recursive: true });
      git(r, "init", "-q", `--separate-git-dir=${join(r, ".git/mods/g")}`, join(r, "w/ign"));
      put(join(r, "w/ign/p.txt"), "precious\n");
      git(r, "init", "-q", "--bare", join(r, ".git/mods/b"));
      mkdirSync(join(r, "w/ign2"), { recursive: true });
      symlinkSync(join(r, ".git/mods/b"), join(r, "w/ign2/.git"));
      put(join(r, "w/ign2/p.txt"), "precious\n");
      put(join(r, "w/u.txt"), "u\n");
    },
  },
  // a submodule entry wins over index paths below it (git's directory_exists_in_index)
  "a submodule entry with index paths below it is never entered": {
    flags: ["-dx", "-d", "-f"],
    setup: (r) => {
      commitAll(r);
      put(join(r, "sub/p.txt"), "precious\n");
      const sha = "1234567890123456789012345678901234567890";
      git(r, "update-index", "--add", "--cacheinfo", `160000,${sha},sub`);
      // git 2.43 records it; git 2.5x refuses the file/directory conflict
      tryGit(r, "update-index", "--add", "--cacheinfo", `160000,${sha},sub/k/deep`);
    },
  },
  // git's scan enters a directory the index tracks paths in, even a nested repository
  "a nested repository with paths tracked by the superproject": {
    flags: ["-f", "-d", "-x"],
    setup: (r) => {
      mkdirSync(join(r, "b"), { recursive: true });
      mkdirSync(join(r, ".git/mods"), { recursive: true });
      git(r, "init", "-q", `--separate-git-dir=${join(r, ".git/mods/m")}`, join(r, "b"));
      put(join(r, "b/p.txt"), "untracked\n");
      put(join(r, "b/deep/u.txt"), "untracked\n");
      // index paths below it, as update-index records them (git add refuses)
      const sha = "1234567890123456789012345678901234567890";
      git(r, "update-index", "--add", "--cacheinfo", `160000,${sha},b/deep/ign`);
      git(r, "commit", "-qm", "c");
    },
  },
  "a junk .git file or a gitfile naming a missing directory is no repository": {
    flags: ["-d", "-dx", "-dff"],
    setup: (r) => {
      commitAll(r);
      put(join(r, "j1/.git"), "not a gitdir\n");
      put(join(r, "j1/x.txt"), "x\n");
      put(join(r, "j2/.git"), "gitdir: missing/dir\n");
      put(join(r, "j2/x.txt"), "x\n");
    },
  },
  "an ignored directory with a dangling .git link outside the root": {
    flags: ["-d", "-dff", "-dx", "-dxff"],
    overKeep: true,
    setup: (r, top) => {
      put(join(r, ".gitignore"), "ign/\n");
      commitAll(r);
      mkdirSync(join(r, "w/ign"), { recursive: true });
      symlinkSync(join(top, "missing"), join(r, "w/ign/.git"));
      put(join(r, "w/ign/p.txt"), "precious\n");
      put(join(r, "w/u.txt"), "u\n");
    },
  },
};

describeGit("clean: minimal repros of the differential fuzz (native twins)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clean-repro-"));
    home = join(root, "home");
    tmpl = join(root, "tmpl");
    mkdirSync(home);
    mkdirSync(tmpl);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  for (const [name, repro] of Object.entries(REPROS)) {
    for (const flag of repro.flags) {
      it(`${name} (${flag})`, async () => {
        const tops = [join(root, "n"), join(root, "o")];
        for (const top of tops) {
          mkdirSync(join(top, "repo"), { recursive: true });
          git(join(top, "repo"), "init", "-q", "-b", "main");
          repro.setup(join(top, "repo"), top);
        }
        const { L, args, spec } = parseFlags(flag);
        const dry = git(join(tops[0], "repo"), ...args, "-n", ...spec)
          .split("\n")
          .filter(Boolean);
        git(join(tops[0], "repo"), ...args, "-q", ...spec);
        const ourDry = await ours(join(tops[1], "repo"), L, true);
        await ours(join(tops[1], "repo"), L, false);
        const native = listing(tops[0]).map((p) => p.replace(tops[0], ""));
        const after = listing(tops[1]).map((p) => p.replace(tops[1], ""));
        // nothing git keeps is gone
        expect(native.filter((p) => !after.includes(p))).toEqual([]);
        if (repro.overKeep) return;
        expect(after).toEqual(native);
        const pick = (prefix: string) =>
          dry
            .filter((l) => l.startsWith(prefix))
            .map((l) => l.slice(prefix.length))
            .sort();
        expect([...ourDry.cleaned].sort()).toEqual(pick("Would remove "));
        expect([...ourDry.skipped].sort()).toEqual(pick("Would skip repository "));
      });
    }
  }
});

describeGit("ignore rules as git check-ignore (nested negations, directory-only rules)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-ignore-"));
    home = join(root, "home");
    tmpl = join(root, "tmpl");
    mkdirSync(home);
    mkdirSync(tmpl);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const layouts: Record<string, Record<string, string>> = {
    "!*/ under *.o": { ".gitignore": "*.o\n", "w/.gitignore": "!*/\n" },
    "!sub/ under sub/*": { ".gitignore": "*.log\nsub/*\n", "w/.gitignore": "!sub/\n" },
    "a directory pattern and a negated file": {
      ".gitignore": "build/\n!build/keep.o\n*.tmp\n!keep.tmp\n",
    },
    "* with !*/ and !*.txt": { "w/.gitignore": "*\n!*/\n!*.txt\n" },
    "anchored and nested": { ".gitignore": "/u/k/\nx/\n", "deep/.gitignore": "!x/\n*.o\n!c.o\n" },
  };
  const files = [
    "w/c.o",
    "w/sub/c.o",
    "w/sub/deep/d.o",
    "w/sub/a.log",
    "w/sub/keep.txt",
    "w/sub/x.dat",
    "w/x/y.txt",
    "build/keep.o",
    "build/out.o",
    "sub/a.txt",
    "a.tmp",
    "keep.tmp",
    "u/k/f.txt",
    "x/f.txt",
    "deep/x/c.o",
    "deep/x/d.o",
    "deep/sub/x/e.o",
  ];
  for (const [name, ignores] of Object.entries(layouts)) {
    it(name, async () => {
      const r = join(root, "repo");
      mkdirSync(r, { recursive: true });
      git(r, "init", "-q", "-b", "main");
      for (const [p, content] of Object.entries(ignores)) put(join(r, p), content);
      for (const f of files) put(join(r, f), "f\n");
      const files0 = createNodeFilesApi({ rootDir: r });
      const { history } = await createGitFilesBackend({ files: files0 });
      const worktree = createFileWorktree({
        files: files0,
        rootPath: "",
        gitDir: ".git",
        blobs: history.blobs,
        trees: history.trees,
      });
      // paths as git's directory scan matches them: without a trailing slash, the
      // directory known from the filesystem
      const ourIgnored: string[] = [];
      const all: string[] = [];
      for await (const e of worktree.walk({ includeIgnored: true, includeDirectories: true })) {
        all.push(e.path);
        if (e.isIgnored) ourIgnored.push(e.path);
      }
      let out = "";
      try {
        out = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], {
          cwd: r,
          env: env(),
          input: `${all.join("\n")}\n`,
          encoding: "utf8",
        });
      } catch (e) {
        out = String((e as { stdout?: string }).stdout ?? "");
      }
      const nativeIgnored = out.split("\n").filter(Boolean).sort();
      expect(ourIgnored.sort()).toEqual(nativeIgnored);
    });
  }
});

type Repro2 = {
  setup: (repo: string, top: string) => void;
  /** flags (as `parseFlags` reads them, without paths) and path filters */
  runs: Array<[string, string[]]>;
  /** ours may keep more than git (a `.git` beyond the root it cannot check), never less */
  overKeep?: boolean;
};

const REPROS2: Record<string, Repro2> = {
  // A: a name-only pattern names the path itself, wherever the name repeats above it
  "A: `foo` then `!foo/` keeps foo/foo ignored": {
    runs: [
      ["-f", []],
      ["-d", []],
      ["-X", []],
    ],
    setup: (r) => {
      put(join(r, ".gitignore"), "foo\n!foo/\n");
      put(join(r, "foo/t"), "t\n");
      git(r, "add", "-f", ".gitignore", "foo/t");
      git(r, "commit", "-qm", "c");
      put(join(r, "foo/foo"), "precious\n");
      put(join(r, "foo/x/foo"), "precious\n");
    },
  },
  "A: `foo` then `!/foo`, and `a/` then `!/a/`": {
    runs: [
      ["-d", []],
      ["-f", []],
      ["-Xd", []],
    ],
    setup: (r) => {
      put(join(r, ".gitignore"), "foo\n!/foo\na/\n!/a/\n");
      commitAll(r);
      put(join(r, "foo/foo"), "precious\n");
      put(join(r, "foo/x/foo"), "precious\n");
      put(join(r, "foo/other"), "o\n");
      put(join(r, "a/b/a/x"), "precious\n");
      put(join(r, "a/c"), "c\n");
    },
  },
  // B: a directory-only rule ending in `**` matches only directories
  "B: `**/[!a]*/` and friends never match files": {
    runs: [
      ["-X", []],
      ["-Xd", []],
      ["-d", []],
    ],
    setup: (r) => {
      put(join(r, ".gitignore"), "**/[!a]*/\n**/?/\n**/*.[lt]*/\n**/*o*/\n");
      commitAll(r);
      put(join(r, "x.log"), "precious\n");
      put(join(r, "q"), "precious\n");
      put(join(r, "foo"), "precious\n");
      put(join(r, "dir.txt/f"), "f\n");
      put(join(r, "a/b/k"), "k\n");
    },
  },
  // C: a backslash makes the next character literal, as in git's wildmatch
  "C: escaped wildcards and escaped `#`/`!`": {
    runs: [
      ["-d", []],
      ["-X", []],
      ["-dx", []],
    ],
    setup: (r) => {
      put(join(r, ".gitignore"), "*.txt\n!\\*.txt\n\\[x\\]\n**/\\#hash\n**/\\!bang\nsp\\ \n");
      commitAll(r);
      put(join(r, "x.txt"), "precious\n");
      put(join(r, "*.txt"), "literal\n");
      put(join(r, "[x]"), "x\n");
      put(join(r, "x"), "precious\n");
      put(join(r, "d/#hash"), "h\n");
      put(join(r, "d/!bang"), "b\n");
      put(join(r, "sp "), "s\n");
    },
  },
  // D: a `.git` that cannot be checked here is never removed, not even with -ff
  "D: a dangling .git link or gitfile beyond the root (-dff keeps it)": {
    runs: [
      ["-dff", []],
      ["-d", []],
    ],
    setup: (r) => {
      put(join(r, ".gitignore"), "*.txt\n");
      commitAll(r);
      mkdirSync(join(r, "d"));
      symlinkSync("/nonexistent/missing", join(r, "d/.git"));
      put(join(r, "d/x.txt"), "precious\n");
      put(join(r, "e/.git"), "gitdir: /nonexistent/missing\n");
      put(join(r, "e/x.txt"), "precious\n");
    },
  },
  "D: the same with -dxff (git removes them; ours keeps what it cannot check)": {
    runs: [["-dxff", []]],
    overKeep: true,
    setup: (r) => {
      commitAll(r);
      mkdirSync(join(r, "d"));
      symlinkSync("/nonexistent/missing", join(r, "d/.git"));
      put(join(r, "d/x.txt"), "x\n");
      put(join(r, "e/.git"), "gitdir: /nonexistent/missing\n");
      put(join(r, "e/x.txt"), "x\n");
    },
  },
  // E: pathspec magic, as git parses it
  "E: exclude, top, literal, glob and icase pathspec magic": {
    runs: [
      ["-f", ["*.txt", ":!keep.txt"]],
      ["-f", ["*.txt", ":(exclude)keep.txt"]],
      ["-f", ["*.txt", ":^keep.txt"]],
      ["-d", ["*.txt", ":!d"]],
      ["-d", [":!keep.txt"]],
      ["-d", [":!*.log"]],
      ["-f", [":/a.txt"]],
      ["-f", [":(top)b"]],
      ["-f", [":(literal)*.txt"]],
      ["-f", [":(glob)*.txt"]],
      ["-f", [":(glob)**/*.txt"]],
      ["-f", ["**/y.txt"]],
      ["-f", [":(icase)KEEP.TXT"]],
      ["-d", ["./b/../d/"]],
      ["-d", ["./a.txt"]],
    ],
    setup: (r) => {
      commitAll(r);
      put(join(r, "keep.txt"), "precious\n");
      put(join(r, "KEEP.TXT"), "k\n");
      put(join(r, "a.txt"), "a\n");
      put(join(r, "*.txt"), "literal\n");
      put(join(r, "d/keep.txt"), "precious\n");
      put(join(r, "d/x.txt"), "x\n");
      put(join(r, "b/y.txt"), "y\n");
      put(join(r, "b/z.log"), "z\n");
    },
  },
};

describeGit("clean: review repros A-E (native twins)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clean-repro2-"));
    home = join(root, "home");
    tmpl = join(root, "tmpl");
    mkdirSync(home);
    mkdirSync(tmpl);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  for (const [name, repro] of Object.entries(REPROS2)) {
    for (const [flag, paths] of repro.runs) {
      it(`${name} (${flag}${paths.length ? ` -- ${paths.join(" ")}` : ""})`, async () => {
        const tops = [join(root, "n"), join(root, "o")];
        for (const top of tops) {
          mkdirSync(join(top, "repo"), { recursive: true });
          git(join(top, "repo"), "init", "-q", "-b", "main");
          git(join(top, "repo"), "config", "core.excludesFile", "/dev/null");
          repro.setup(join(top, "repo"), top);
        }
        const { L, args } = parseFlags(flag);
        L.paths = paths;
        const spec = paths.length ? ["--", ...paths] : [];
        const dry = git(join(tops[0], "repo"), ...args, "-n", ...spec)
          .split("\n")
          .filter(Boolean);
        git(join(tops[0], "repo"), ...args, "-q", ...spec);
        const ourDry = await ours(join(tops[1], "repo"), L, true);
        await ours(join(tops[1], "repo"), L, false);
        const native = listing(tops[0]).map((p) => p.replace(tops[0], ""));
        const after = listing(tops[1]).map((p) => p.replace(tops[1], ""));
        expect(
          native.filter((p) => !after.includes(p)),
          "gone in ours, kept by git",
        ).toEqual([]);
        if (repro.overKeep) return;
        expect(after).toEqual(native);
        const pick = (prefix: string) =>
          dry
            .filter((l) => l.startsWith(prefix))
            .map((l) => l.slice(prefix.length).replace(/^"(.*)"$/, "$1"))
            .sort();
        expect([...ourDry.cleaned].sort()).toEqual(pick("Would remove "));
        expect([...ourDry.skipped].sort()).toEqual(pick("Would skip repository "));
      });
    }
  }

  it("E: paths above the top and attr magic are refused, as git refuses them", async () => {
    const r = join(root, "r");
    mkdirSync(r, { recursive: true });
    git(r, "init", "-q", "-b", "main");
    commitAll(r);
    put(join(r, "a.txt"), "a\n");
    expect(() => git(r, "clean", "-f", "-n", "--", "../x")).toThrow();
    for (const paths of [["../x"], [":(attr:foo)a.txt"], [":(bogus)a.txt"]]) {
      const L = parseFlags("-f").L;
      L.paths = paths;
      await expect(ours(r, L, true)).rejects.toThrow();
    }
  });
});

describeGit("ignore rules as git check-ignore (review repros A-C)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-ignore2-"));
    home = join(root, "home");
    tmpl = join(root, "tmpl");
    mkdirSync(home);
    mkdirSync(tmpl);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const layouts: Record<string, { ignores: Record<string, string>; files: string[] }> = {
    "A: repeated names": {
      ignores: { ".gitignore": "foo\n!foo/\na\n!a/\n" },
      files: ["foo/foo", "foo/t", "a/a", "b/c/foo/bar/bar", "foo/x/foo", "a/b/a/c"],
    },
    "A: dir-only repeated names": {
      ignores: { ".gitignore": "bar/\n!/bar/\n", "b/.gitignore": "bar\n!bar/\n" },
      files: ["bar/bar/x", "b/c/foo/bar/bar", "b/bar/bar", "bar/y"],
    },
    "B: dir-only rules after **": {
      ignores: { ".gitignore": "**/[!a]*/\n**/?/\n**/*.[lt]*/\n**/*o*/\n" },
      files: ["x.log", "q", "foo", "dir.txt/f", "a/b/k", "ab/o/c"],
    },
    "C: escapes": {
      ignores: { ".gitignore": "\\*.txt\n\\[x\\]\n**/\\#hash\n**/\\!bang\nsp\\ \nq\\*\n" },
      files: ["x.txt", "*.txt", "[x]", "x", "d/#hash", "d/!bang", "sp ", "sp", "q*", "qq"],
    },
  };
  for (const [name, layout] of Object.entries(layouts)) {
    it(name, async () => {
      const r = join(root, "repo");
      mkdirSync(r, { recursive: true });
      git(r, "init", "-q", "-b", "main");
      git(r, "config", "core.excludesFile", "/dev/null");
      for (const [p, content] of Object.entries(layout.ignores)) put(join(r, p), content);
      for (const f of layout.files) put(join(r, f), "f\n");
      const files0 = createNodeFilesApi({ rootDir: r });
      const { history } = await createGitFilesBackend({ files: files0 });
      const worktree = createFileWorktree({
        files: files0,
        rootPath: "",
        gitDir: ".git",
        blobs: history.blobs,
        trees: history.trees,
      });
      const ourIgnored: string[] = [];
      const all: string[] = [];
      for await (const e of worktree.walk({ includeIgnored: true, includeDirectories: true })) {
        all.push(e.path);
        if (e.isIgnored) ourIgnored.push(e.path);
      }
      let out = "";
      try {
        out = execFileSync("git", ["check-ignore", "--no-index", "-z", "--stdin"], {
          cwd: r,
          env: env(),
          input: `${all.join("\0")}\0`,
          encoding: "utf8",
        });
      } catch (e) {
        out = String((e as { stdout?: string }).stdout ?? "");
      }
      const nativeIgnored = out.split("\0").filter(Boolean).sort();
      expect(ourIgnored.sort()).toEqual(nativeIgnored);
    });
  }
});
