/**
 * `git diff` output against native git, byte for byte: random repositories (text files with
 * repetitive and function-like lines, whitespace variants, missing trailing newlines, binary
 * files, executable bits, symbolic links, a file turned into a link, renames, paths with
 * spaces and non-ASCII bytes, `diff=<driver>` attributes, an intent-to-add file) read by
 * native git and by our DiffCommand in four modes (`git diff`, `git diff --cached`,
 * `git diff A B`, `git diff A`), each as a patch, `--stat` (random `COLUMNS`), `--numstat`,
 * `--shortstat`, `--name-only` and `--name-status`, with random options (context,
 * inter-hunk context, -w/-b/--ignore-blank-lines, algorithm, indent heuristic, renames, -W)
 * and configuration (`diff.algorithm`, `diff.renames`, `core.quotePath`, `diff.context`).
 * And `git diff --no-index` of random file pairs against {@link formatNoIndexDiff}.
 *
 * `DIFF_SEEDS` sets the number of repositories (default 40), `DIFF_NOINDEX_SEEDS` the number
 * of `--no-index` pairs (default 400), `DIFF_SHOW` how many mismatches to print.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

import {
  type DiffOutputFormat,
  type DiffTextOptions,
  formatNoIndexDiff,
  Git,
} from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;
const SEEDS = Number(process.env.DIFF_SEEDS ?? 40);
const NOINDEX_SEEDS = Number(process.env.DIFF_NOINDEX_SEEDS ?? 400);
const SHOW = Number(process.env.DIFF_SHOW ?? 3);

const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout ?? "";
const [major, minor] = (/(\d+)\.(\d+)/.exec(version) ?? ["", "0", "0"]).slice(1).map(Number);
const atLeast = (ma: number, mi: number) => major > ma || (major === ma && minor >= mi);
/** Behaviour that changed between git 2.43 (sandbox) and 2.5x (CI) */
const versionOptions: DiffTextOptions = {
  histogramRediff: atLeast(2, 54),
  legacyMinimal: !atLeast(2, 50),
  renameCountLastSpan: atLeast(2, 50),
  namesFromContents: atLeast(2, 50),
};

let root: string | undefined;
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
const tmp = () => {
  root ??= mkdtempSync(join(tmpdir(), "diff-native-"));
  return root;
};

const native = (cwd: string, args: string[], columns = 80): Buffer => {
  const res = spawnSync("git", args, {
    cwd,
    env: { ...nativeGitEnv(tmp()), COLUMNS: String(columns) },
  });
  if (res.status !== 0 && res.status !== 1) {
    throw new Error(`git ${args.join(" ")}: ${res.stderr}`);
  }
  return res.stdout;
};
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: nativeGitEnv(tmp()), stdio: ["ignore", "pipe", "pipe"] })
    .toString()
    .trim();

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
  "}",
  "",
  "  a",
  "\ta",
  "a  ",
  "a b",
  "a  b",
  "int main(void)",
  "  if (x) {",
  "static int f(int y)",
  "def g(self):",
  "    return 1",
  "class K:",
  "_private",
  "label:",
];

function text(r: () => number, n: number, eol = true): string {
  const lines = Array.from({ length: n }, () => TOKENS[Math.floor(r() * TOKENS.length)]);
  const s = lines.map((l) => `${l}\n`).join("");
  return eol || s.length === 0 ? s : s.slice(0, -1);
}

function editText(r: () => number, s: string): string {
  const lines = s.split("\n");
  const last = lines.pop() ?? "";
  if (last) lines.push(last);
  const n = 1 + Math.floor(r() * 4);
  for (let k = 0; k < n; k++) {
    const at = Math.floor(r() * (lines.length + 1));
    const op = Math.floor(r() * 4);
    const tok = TOKENS[Math.floor(r() * TOKENS.length)];
    if (op === 0 && at < lines.length) lines[at] = tok;
    else if (op === 1) lines.splice(at, 0, tok);
    else if (op === 2 && at < lines.length) lines.splice(at, 1);
    else if (at < lines.length) lines[at] = `${lines[at]} `;
  }
  const out = lines.map((l) => `${l}\n`).join("");
  return r() < 0.15 && out.length > 0 ? out.slice(0, -1) : out;
}

const PATHS = ["a.txt", "dir/b.c", "dir/sub/c.py", "e f.txt", "ü.txt", "z.txt", "x.sh"];

function put(dir: string, path: string, content: string | Uint8Array): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  try {
    unlinkSync(join(dir, path));
  } catch {
    // not there
  }
  writeFileSync(join(dir, path), content);
}

function binary(r: () => number): Uint8Array {
  const out = new Uint8Array(20 + Math.floor(r() * 40));
  for (let i = 0; i < out.length; i++) out[i] = Math.floor(r() * 256);
  out[3] = 0;
  return out;
}

/** A random repository with commits A and B, staged changes and worktree changes. */
function buildRepo(dir: string, seed: number): { a: string; b: string } {
  const r = prng(seed);
  mkdirSync(dir, { recursive: true });
  run(dir, "init", "-q", "-b", "main");
  if (r() < 0.3)
    run(dir, "config", "diff.algorithm", ["histogram", "patience", "minimal"][seed % 3]);
  if (r() < 0.2) run(dir, "config", "diff.renames", "false");
  if (r() < 0.2) run(dir, "config", "core.quotePath", "false");
  if (r() < 0.15) run(dir, "config", "diff.context", String(Math.floor(r() * 5)));
  if (r() < 0.15) run(dir, "config", "diff.indentHeuristic", "false");
  if (r() < 0.4) put(dir, ".gitattributes", "*.c diff=cpp\n*.py diff=python\n*.dat -diff\n");
  const contents = new Map<string, string>();
  for (const path of PATHS) {
    if (r() < 0.75) {
      const c = text(r, 3 + Math.floor(r() * 20), r() < 0.85);
      contents.set(path, c);
      put(dir, path, c);
    }
  }
  if (r() < 0.5) put(dir, "bin.dat", binary(r));
  if (r() < 0.4) put(dir, "img.bin", binary(r));
  if (r() < 0.4) symlinkSync("a.txt", join(dir, "link"));
  if (contents.has("x.sh") && r() < 0.5) chmodSync(join(dir, "x.sh"), 0o755);
  // a file for renames: long enough to stay similar after an edit
  const big = text(r, 30, true);
  put(dir, "ren/old.txt", big);
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "A", "--allow-empty");
  const a = run(dir, "rev-parse", "HEAD");

  // commit B: modify, delete, add, rename, chmod, typechange
  const step = (allowRename: boolean) => {
    for (const path of PATHS) {
      const p = r();
      const old = contents.get(path);
      if (old !== undefined && p < 0.35) {
        const c = editText(r, old);
        contents.set(path, c);
        put(dir, path, c);
      } else if (old !== undefined && p < 0.42) {
        rmSync(join(dir, path));
        contents.delete(path);
      } else if (old === undefined && p < 0.15) {
        const c = text(r, 2 + Math.floor(r() * 10), r() < 0.85);
        contents.set(path, c);
        put(dir, path, c);
      } else if (old !== undefined && path === "x.sh" && p < 0.6) {
        chmodSync(join(dir, path), r() < 0.5 ? 0o755 : 0o644);
      }
    }
    if (allowRename && r() < 0.6) {
      try {
        const c = readFileSync(join(dir, "ren/old.txt"), "utf8");
        rmSync(join(dir, "ren/old.txt"));
        put(dir, `ren/new${seed % 3}.txt`, r() < 0.5 ? c : editText(r, c));
      } catch {
        // renamed before
      }
    }
    if (r() < 0.2) {
      try {
        rmSync(join(dir, "z.txt"));
      } catch {
        // not there
      }
      symlinkSync("dir", join(dir, "z.txt"));
      contents.delete("z.txt");
    }
    if (r() < 0.2) put(dir, "bin.dat", binary(r));
  };
  step(true);
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "B", "--allow-empty");
  const b = run(dir, "rev-parse", "HEAD");
  // staged changes, then worktree changes on top
  step(true);
  run(dir, "add", "-A");
  step(r() < 0.5);
  if (r() < 0.3) {
    put(dir, "ita.txt", text(r, 4));
    run(dir, "add", "-N", "ita.txt");
  }
  return { a, b };
}

/** Our working copy over a repository native git made in `dir`. */
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
  return Git.fromWorkingCopy(new MemoryWorkingCopy({ history, checkout, worktree, config }));
}

const FORMATS: Array<[DiffOutputFormat, string[]]> = [
  ["patch", []],
  ["stat", ["--stat"]],
  ["numstat", ["--numstat"]],
  ["shortstat", ["--shortstat"]],
  ["name-only", ["--name-only"]],
  ["name-status", ["--name-status"]],
];

function randomOptions(
  r: () => number,
  patch = true,
): { args: string[]; options: DiffTextOptions } {
  const args: string[] = [];
  const options: DiffTextOptions = {};
  // -U<n> implies the patch format
  if (r() < 0.3 && patch) {
    const n = Math.floor(r() * 5);
    args.push(`-U${n}`);
    options.context = n;
  }
  if (r() < 0.15) {
    const n = 1 + Math.floor(r() * 3);
    args.push(`--inter-hunk-context=${n}`);
    options.interHunkContext = n;
  }
  const ws = Math.floor(r() * 10);
  if (ws === 1) {
    args.push("-w");
    options.ignoreWhitespace = true;
  } else if (ws === 2) {
    args.push("-b");
    options.ignoreWhitespaceChange = true;
  } else if (ws === 3) {
    args.push("--ignore-space-at-eol");
    options.ignoreWhitespaceAtEol = true;
  }
  if (r() < 0.1) {
    args.push("--ignore-blank-lines");
    options.ignoreBlankLines = true;
  }
  if (r() < 0.2) {
    const alg = (["myers", "minimal", "patience", "histogram"] as const)[Math.floor(r() * 4)];
    args.push(`--diff-algorithm=${alg}`);
    options.algorithm = alg;
  }
  if (r() < 0.15) {
    args.push("--no-indent-heuristic");
    options.indentHeuristic = false;
  }
  if (r() < 0.05) {
    args.push("-W");
    options.functionContext = true;
  }
  return { args, options };
}

describeGit("git diff output against native git", () => {
  it(`matches git diff on ${SEEDS} random repositories`, async () => {
    const mismatches: string[] = [];
    let compared = 0;
    let nonEmpty = 0;
    const only = Number(process.env.DIFF_ONLY ?? 0);
    for (let seed = only || 1; seed <= (only || SEEDS); seed++) {
      const dir = join(tmp(), `repo-${seed}`);
      const { a, b } = buildRepo(dir, seed);
      const r = prng(seed * 7919);
      const modes: Array<[string, string[], (g: Git) => ReturnType<Git["diff"]>]> = [
        ["worktree", [], (g) => g.diff()],
        ["cached", ["--cached"], (g) => g.diff().setCached(true)],
        ["A B", [a, b], (g) => g.diff().setOldTree(a).setNewTree(b)],
        ["A", [a], (g) => g.diff().setOldTree(a)],
      ];
      const git = await open(dir);
      for (const [mode, modeArgs, make] of modes) {
        for (const [format, formatArgs] of FORMATS) {
          const { args, options } = randomOptions(r, format === "patch");
          const columns = format === "stat" && r() < 0.5 ? 30 + Math.floor(r() * 100) : 80;
          if (format === "stat") options.stat = { width: columns };
          const ours = Buffer.from(
            await make(git)
              .setOptions({ ...versionOptions, ...options })
              .callBytes(format),
          );
          const theirs = native(dir, ["diff", ...formatArgs, ...args, ...modeArgs], columns);
          compared++;
          if (theirs.length > 0) nonEmpty++;
          if (!theirs.equals(ours)) {
            mismatches.push(
              `seed ${seed} ${mode} ${format} ${args.join(" ")}\n--- git\n${theirs}\n--- ours\n${ours}`,
            );
          }
        }
      }
      if (!only) rmSync(dir, { recursive: true, force: true });
    }
    for (const m of mismatches.slice(0, SHOW)) console.log(m);
    expect(mismatches.length).toBe(0);
    expect(compared).toBe((only ? 1 : SEEDS) * 24);
    if (!only) expect(nonEmpty).toBeGreaterThan(compared / 2);
  }, 900_000);

  it("prints an unmerged path of the index as git diff --cached does", async () => {
    const dir = join(tmp(), "unmerged");
    mkdirSync(dir, { recursive: true });
    run(dir, "init", "-q", "-b", "main");
    put(dir, "f.txt", "a\nb\n");
    put(dir, "g.txt", "g\n");
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "one");
    run(dir, "checkout", "-q", "-b", "side");
    put(dir, "f.txt", "a\nside\n");
    run(dir, "commit", "-q", "-am", "side");
    run(dir, "checkout", "-q", "main");
    put(dir, "f.txt", "a\nmain\n");
    put(dir, "g.txt", "g2\n");
    run(dir, "commit", "-q", "-am", "main");
    spawnSync("git", ["merge", "side"], { cwd: dir, env: nativeGitEnv(tmp()) });
    const git = await open(dir);
    for (const [format, formatArgs] of FORMATS) {
      const ours = Buffer.from(await git.diff().setCached(true).callBytes(format));
      const theirs = native(dir, ["diff", "--cached", ...formatArgs]);
      expect(ours.toString()).toBe(theirs.toString());
    }
  });

  it(`matches git diff --no-index on ${NOINDEX_SEEDS} random file pairs`, async () => {
    const dir = join(tmp(), "noindex");
    mkdirSync(dir, { recursive: true });
    const mismatches: string[] = [];
    for (let seed = 1; seed <= NOINDEX_SEEDS; seed++) {
      const r = prng(seed * 31);
      const names = [
        ["one", "two"],
        ["a file", "b file"],
        ["é.txt", "f.txt"],
        ["same", "same2"],
      ][seed % 4];
      const isBinary = r() < 0.1;
      const before = isBinary
        ? binary(r)
        : new TextEncoder().encode(text(r, Math.floor(r() * 15), r() < 0.8));
      const after =
        isBinary && r() < 0.8
          ? binary(r)
          : new TextEncoder().encode(
              r() < 0.1
                ? new TextDecoder().decode(before)
                : editText(r, new TextDecoder().decode(before)),
            );
      put(dir, names[0], before);
      put(dir, names[1], after);
      const { args, options } = randomOptions(r);
      const theirs = native(dir, ["diff", "--no-index", ...args, names[0], names[1]]);
      const ours = Buffer.from(
        await formatNoIndexDiff(
          { path: names[0], content: before },
          { path: names[1], content: after },
          {
            ...versionOptions,
            ...options,
            indentHeuristic: options.indentHeuristic ?? true,
          },
        ),
      );
      if (!theirs.equals(ours)) {
        mismatches.push(`seed ${seed} ${args.join(" ")}\n--- git\n${theirs}\n--- ours\n${ours}`);
      }
    }
    for (const m of mismatches.slice(0, SHOW)) console.log(m);
    expect(mismatches.length).toBe(0);
  }, 600_000);
});

const CONFLICT_PATHS = ["c1.txt", "c2.txt", "dir/c3.c", "c4.txt", "c5.bin", "n.txt"];

/**
 * A repository in the middle of a conflicted merge: files modified on both sides, deleted on
 * one, added on both, a binary file, an executable bit; then the worktree edited further
 * (markers left, a side taken, the file rewritten, deleted, made executable).
 */
function buildConflictRepo(dir: string, seed: number): { base: string } {
  const r = prng(seed * 104729);
  mkdirSync(dir, { recursive: true });
  run(dir, "init", "-q", "-b", "main");
  if (r() < 0.3) put(dir, ".gitattributes", "*.c diff=cpp\n");
  const base = new Map<string, string>();
  for (const path of CONFLICT_PATHS) {
    if (path === "c4.txt" && r() < 0.5) continue; // added on both sides later
    const c = text(r, 3 + Math.floor(r() * 12), r() < 0.85);
    base.set(path, c);
    put(dir, path, path.endsWith(".bin") ? new Uint8Array([0, ...new TextEncoder().encode(c)]) : c);
  }
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "base");
  const baseId = run(dir, "rev-parse", "HEAD");
  const branch = (name: string) => {
    for (const path of CONFLICT_PATHS) {
      const old = base.get(path);
      const p = r();
      if (path === "n.txt") continue;
      if (old === undefined) {
        put(dir, path, text(r, 2 + Math.floor(r() * 6)));
      } else if (p < 0.1) {
        rmSync(join(dir, path));
      } else if (path.endsWith(".bin")) {
        put(dir, path, binary(r));
      } else {
        put(dir, path, editText(r, editText(r, old)));
        if (p > 0.9) chmodSync(join(dir, path), 0o755);
      }
    }
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", name, "--allow-empty");
  };
  run(dir, "checkout", "-q", "-b", "side");
  branch("side");
  run(dir, "checkout", "-q", "main");
  branch("main");
  spawnSync("git", ["merge", "side"], { cwd: dir, env: nativeGitEnv(tmp()) });
  // the worktree, edited after the merge stopped
  for (const path of CONFLICT_PATHS) {
    const p = r();
    const full = join(dir, path);
    let current: string | undefined;
    try {
      current = readFileSync(full, "utf8");
    } catch {
      current = undefined;
    }
    if (path === "n.txt") {
      if (p < 0.5 && current !== undefined) put(dir, path, editText(r, current));
    } else if (current === undefined) {
      if (p < 0.3) put(dir, path, text(r, 3));
    } else if (p < 0.15) {
      rmSync(full);
    } else if (p < 0.35 && !path.endsWith(".bin")) {
      put(dir, path, editText(r, current));
    } else if (p < 0.45) {
      chmodSync(full, 0o755);
    } else if (p < 0.55 && !path.endsWith(".bin")) {
      // a side taken: the markers and the other side dropped
      const kept = current
        .split("\n")
        .filter((l) => !/^(<<<<<<<|=======|>>>>>>>)/.test(l))
        .join("\n");
      put(dir, path, kept);
    }
  }
  return { base: baseId };
}

describeGit("git diff of conflicted paths against native git", () => {
  const SEEDS_CONFLICT = Number(process.env.DIFF_CONFLICT_SEEDS ?? 40);
  it(`matches git diff (diff --cc, unmerged entries) on ${SEEDS_CONFLICT} merges`, async () => {
    const mismatches: string[] = [];
    let combined = 0;
    const only = Number(process.env.DIFF_ONLY ?? 0);
    for (let seed = only || 1; seed <= (only || SEEDS_CONFLICT); seed++) {
      const dir = join(tmp(), `conflict-${seed}`);
      const { base } = buildConflictRepo(dir, seed);
      const r = prng(seed * 31337);
      const git = await open(dir);
      const modes: Array<[string, string[], (g: Git) => ReturnType<Git["diff"]>]> = [
        ["worktree", [], (g) => g.diff()],
        ["HEAD", ["HEAD"], (g) => g.diff().setOldTree("HEAD")],
        ["base", [base], (g) => g.diff().setOldTree(base)],
        ["cached", ["--cached"], (g) => g.diff().setCached(true)],
      ];
      for (const [mode, modeArgs, make] of modes) {
        for (const [format, formatArgs] of FORMATS) {
          const { args, options } = randomOptions(r, format === "patch");
          const ours = Buffer.from(
            await make(git)
              .setOptions({ ...versionOptions, ...options })
              .callBytes(format),
          );
          const theirs = native(dir, ["diff", ...formatArgs, ...args, ...modeArgs]);
          if (theirs.includes("diff --cc ")) combined++;
          if (!theirs.equals(ours)) {
            mismatches.push(
              `seed ${seed} ${mode} ${format} ${args.join(" ")}\n--- git\n${theirs}\n--- ours\n${ours}`,
            );
          }
        }
      }
      if (!only) rmSync(dir, { recursive: true, force: true });
    }
    for (const m of mismatches.slice(0, SHOW)) console.log(m);
    expect(mismatches.length).toBe(0);
    if (!only) expect(combined).toBeGreaterThan(SEEDS_CONFLICT / 2);
  }, 900_000);

  it("throws on a revision that names nothing, as git refuses it", async () => {
    const dir = join(tmp(), "badref");
    mkdirSync(dir, { recursive: true });
    run(dir, "init", "-q", "-b", "main");
    put(dir, "a.txt", "a\n");
    run(dir, "add", "-A");
    run(dir, "commit", "-q", "-m", "one");
    const res = spawnSync("git", ["diff", "no-such-ref"], { cwd: dir, env: nativeGitEnv(tmp()) });
    expect(res.status).toBe(128);
    const res2 = spawnSync("git", ["diff", "HEAD", "no-such-ref"], {
      cwd: dir,
      env: nativeGitEnv(tmp()),
    });
    expect(res2.status).toBe(128);
    const git = await open(dir);
    await expect(git.diff().setOldTree("no-such-ref").callText()).rejects.toThrow(/no-such-ref/);
    await expect(
      (await open(dir)).diff().setOldTree("HEAD").setNewTree("no-such-ref").callText(),
    ).rejects.toThrow(/no-such-ref/);
    await expect(
      (await open(dir)).diff().setOldTree("no-such-ref").setCached(true).call(),
    ).rejects.toThrow(/no-such-ref/);
    // a tree id is a revision too
    const tree = run(dir, "rev-parse", "HEAD^{tree}");
    expect(await (await open(dir)).diff().setOldTree(tree).setNewTree("HEAD").callText()).toBe("");
  });
});

describeGit("git diff of dirty submodules against native git", () => {
  const env = () => ({
    ...nativeGitEnv(tmp()),
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_2: "protocol.file.allow",
    GIT_CONFIG_VALUE_2: "always",
  });
  const sh = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env: env(), stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();

  it("shows Subproject commit <id>-dirty as git does, in every format", async () => {
    const root = join(tmp(), "submodules");
    mkdirSync(join(root, "up"), { recursive: true });
    sh(join(root, "up"), "init", "-q", "-b", "main");
    put(join(root, "up"), "s.txt", "s\n");
    sh(join(root, "up"), "add", "-A");
    sh(join(root, "up"), "commit", "-q", "-m", "s");
    put(join(root, "up"), "t.txt", "t\n");
    sh(join(root, "up"), "add", "-A");
    sh(join(root, "up"), "commit", "-q", "-m", "t");
    const dir = join(root, "top");
    mkdirSync(dir, { recursive: true });
    sh(dir, "init", "-q", "-b", "main");
    put(dir, "a.txt", "a\n");
    for (const name of ["s1", "s2", "s3", "s4", "s5"]) {
      sh(dir, "submodule", "add", "-q", join(root, "up"), name);
    }
    sh(dir, "commit", "-q", "-m", "one");
    const one = sh(dir, "rev-parse", "HEAD");
    put(join(dir, "s1"), "s.txt", "changed\n"); // tracked change: dirty
    put(join(dir, "s2"), "u.txt", "u\n"); // untracked only: not dirty by default
    sh(join(dir, "s3"), "checkout", "-q", "HEAD~1"); // another commit
    put(join(dir, "s3"), "s.txt", "x\n"); // ... and dirty
    sh(join(dir, "s4"), "checkout", "-q", "HEAD~1"); // another commit, clean
    put(join(dir, "s5"), "s.txt", "staged\n");
    sh(join(dir, "s5"), "add", "s.txt"); // a staged change inside: dirty
    for (const extra of [
      [],
      ["diff.ignoreSubmodules", "none"],
      ["diff.ignoreSubmodules", "dirty"],
    ]) {
      if (extra.length) sh(dir, "config", extra[0], extra[1]);
      for (const [mode, modeArgs, make] of [
        ["worktree", [], (g: Git) => g.diff()],
        ["A", [one], (g: Git) => g.diff().setOldTree(one)],
      ] as const) {
        for (const [format, formatArgs] of FORMATS) {
          const git = await open(dir);
          const ours = Buffer.from(await make(git).callBytes(format)).toString();
          const res = spawnSync("git", ["diff", ...formatArgs, ...modeArgs], {
            cwd: dir,
            env: env(),
          });
          expect(`${extra.join("=")} ${mode} ${format}\n${ours}`).toBe(
            `${extra.join("=")} ${mode} ${format}\n${res.stdout}`,
          );
        }
      }
    }
  });
});
