/**
 * `git diff` configuration against native git, byte for byte: the path prefixes
 * (`diff.noprefix`, `diff.mnemonicPrefix`, `diff.srcPrefix` / `diff.dstPrefix`,
 * `--no-prefix`, `--default-prefix`, `--src-prefix`, `--dst-prefix`), the order file
 * (`diff.orderFile`, `-O`) and textconv (`diff.<driver>.textconv`, `.binary`,
 * `.cachetextconv`, `-diff`, `--no-textconv`), in the four modes of `git diff` (worktree,
 * `--cached`, `A B`, `A`) and the combined diff of a conflicted path.
 *
 * `DIFF_CONFIG_SEEDS` sets the number of random repositories (default 12), `DIFF_SHOW` how
 * many mismatches to print.
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
import { basename, join } from "node:path";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitWorkingCopyConfig,
} from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemoryWorkingCopy, type WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterAll, describe, expect, it } from "vitest";

import {
  type DiffCommand,
  type DiffOutputFormat,
  type DiffTextOptions,
  Git,
  installTextconvRunner,
  orderByPatterns,
  parseOrderFile,
  type TextconvRunner,
} from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;
const SEEDS = Number(process.env.DIFF_CONFIG_SEEDS ?? 12);
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
/** `diff.srcPrefix` / `diff.dstPrefix` exist from git 2.45 on */
const configPrefixes = atLeast(2, 45);

let root: string | undefined;
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});
const tmp = () => {
  root ??= mkdtempSync(join(tmpdir(), "diff-config-"));
  return root;
};

const native = (cwd: string, args: string[]): { status: number | null; stdout: Buffer } => {
  const res = spawnSync("git", args, { cwd, env: { ...nativeGitEnv(tmp()), COLUMNS: "80" } });
  return { status: res.status, stdout: res.stdout };
};
const nativeOut = (cwd: string, args: string[]): Buffer => {
  const res = native(cwd, args);
  if (res.status !== 0 && res.status !== 1) throw new Error(`git ${args.join(" ")} failed`);
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

function put(dir: string, path: string, content: string | Uint8Array): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  try {
    unlinkSync(join(dir, path));
  } catch {
    // not there
  }
  writeFileSync(join(dir, path), content);
}

/**
 * The host's textconv runner, as git runs `diff.<driver>.textconv`: the command through the
 * shell, with a temporary file named after the path as its argument.
 */
const nodeTextconv: TextconvRunner = async ({ command, path, content }) => {
  const dir = mkdtempSync(join(tmp(), "textconv-"));
  try {
    const file = join(dir, `XXXXXX_${basename(path)}`);
    writeFileSync(file, content);
    const res = spawnSync("sh", ["-c", `${command} "$@"`, command, file], {
      env: nativeGitEnv(tmp()),
    });
    if (res.status !== 0) throw new Error(`error running textconv command '${command}'`);
    return new Uint8Array(res.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Our working copy over a repository native git made in `dir`. */
async function open(dir: string): Promise<{ git: Git; workingCopy: WorkingCopy }> {
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
  const workingCopy = new MemoryWorkingCopy({ history, checkout, worktree, config });
  return { git: Git.fromWorkingCopy(workingCopy), workingCopy };
}

const LINES = ["alpha", "beta", "gamma", "delta", "x = 1", "int f(void)", "}", ""];

function text(r: () => number, n: number): string {
  return Array.from({ length: n }, () => `${LINES[Math.floor(r() * LINES.length)]}\n`).join("");
}

function edit(r: () => number, s: string): string {
  const lines = s.split("\n").slice(0, -1);
  const n = 1 + Math.floor(r() * 3);
  for (let k = 0; k < n; k++) {
    const at = Math.floor(r() * (lines.length + 1));
    const tok = LINES[Math.floor(r() * LINES.length)];
    if (r() < 0.5 && at < lines.length) lines[at] = `${tok}${k}`;
    else lines.splice(at, 0, tok);
  }
  return lines.map((l) => `${l}\n`).join("");
}

function binary(r: () => number): Uint8Array {
  const out = new Uint8Array(16 + Math.floor(r() * 24));
  for (let i = 0; i < out.length; i++) out[i] = 0x41 + Math.floor(r() * 4);
  out[2] = 0;
  return out;
}

const PATHS = [
  "a.txt",
  "dir/b.c",
  "dir/sub/c.h",
  "dir/sub/d.txt",
  "e f.txt",
  "z/y.c",
  "up.up",
  "hex.bin",
  "raw.raw",
  "forced.nb",
  "cached.tc",
];
const ATTRIBUTES = [
  "*.up diff=upper",
  "*.bin diff=hex",
  "*.raw -diff",
  "*.nb diff=forced",
  "*.tc diff=cachedconv",
].join("\n");
const TEXTCONV_CONFIG: Array<[string, string]> = [
  ["diff.upper.textconv", "tr a-z A-Z <"],
  ["diff.hex.textconv", "od -An -c -v"],
  ["diff.forced.textconv", "sed -e s/a/A/g"],
  ["diff.forced.binary", "true"],
  ["diff.cachedconv.textconv", "sed -e s/e/E/g"],
  ["diff.cachedconv.cachetextconv", "true"],
];

const contentFor = (r: () => number, path: string): string | Uint8Array =>
  path.endsWith(".bin") || path.endsWith(".raw") || (path.endsWith(".nb") && r() < 0.5)
    ? binary(r)
    : text(r, 3 + Math.floor(r() * 8));

/** A random repository with commits A and B, staged changes and worktree changes. */
function buildRepo(dir: string, seed: number, textconv: boolean): { a: string; b: string } {
  const r = prng(seed);
  mkdirSync(dir, { recursive: true });
  run(dir, "init", "-q", "-b", "main");
  if (textconv) {
    put(dir, ".gitattributes", `${ATTRIBUTES}\n`);
    for (const [key, value] of TEXTCONV_CONFIG) run(dir, "config", key, value);
  }
  const contents = new Map<string, string | Uint8Array>();
  for (const path of PATHS) {
    if (r() < 0.7) {
      const c = contentFor(r, path);
      contents.set(path, c);
      put(dir, path, c);
    }
  }
  if (r() < 0.3) symlinkSync("a.txt", join(dir, "link"));
  put(dir, "ren/old.txt", text(r, 20));
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "A", "--allow-empty");
  const a = run(dir, "rev-parse", "HEAD");
  const step = (rename: boolean) => {
    for (const path of PATHS) {
      const p = r();
      const old = contents.get(path);
      if (old !== undefined && p < 0.4) {
        const c = typeof old === "string" && r() < 0.8 ? edit(r, old) : contentFor(r, path);
        contents.set(path, c);
        put(dir, path, c);
      } else if (old !== undefined && p < 0.48) {
        rmSync(join(dir, path));
        contents.delete(path);
      } else if (old === undefined && p < 0.2) {
        const c = contentFor(r, path);
        contents.set(path, c);
        put(dir, path, c);
      }
    }
    if (contents.has("a.txt") && r() < 0.15) chmodSync(join(dir, "a.txt"), 0o755);
    if (rename && r() < 0.5) {
      try {
        const c = readFileSync(join(dir, "ren/old.txt"), "utf8");
        rmSync(join(dir, "ren/old.txt"));
        put(dir, "ren/new.txt", r() < 0.5 ? c : edit(r, c));
      } catch {
        // renamed before
      }
    }
  };
  step(true);
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "B", "--allow-empty");
  const b = run(dir, "rev-parse", "HEAD");
  step(true);
  run(dir, "add", "-A");
  step(r() < 0.5);
  return { a, b };
}

type Mode = [string, string[], (g: Git) => DiffCommand];
const modes = (a: string, b: string): Mode[] => [
  ["worktree", [], (g) => g.diff()],
  ["cached", ["--cached"], (g) => g.diff().setCached(true)],
  ["A B", [a, b], (g) => g.diff().setOldTree(a).setNewTree(b)],
  ["A", [a], (g) => g.diff().setOldTree(a)],
];

const FORMATS: Array<[DiffOutputFormat, string[]]> = [
  ["patch", []],
  ["stat", ["--stat"]],
  ["numstat", ["--numstat"]],
  ["name-only", ["--name-only"]],
  ["name-status", ["--name-status"]],
];

/** Compares our output with native git's; the mismatches, described */
async function compare(
  dir: string,
  label: string,
  ours: () => Promise<Uint8Array>,
  args: string[],
): Promise<string | undefined> {
  const mine = Buffer.from(await ours());
  const theirs = nativeOut(dir, args);
  if (theirs.equals(mine)) return undefined;
  return `${label}: git ${args.join(" ")}\n--- git\n${theirs}\n--- ours\n${mine}`;
}

/** A repository with a conflicted path (stages 2 and 3, conflict markers in the file) */
function buildConflict(dir: string, path: string, attributes?: string): void {
  mkdirSync(dir, { recursive: true });
  run(dir, "init", "-q", "-b", "main");
  if (attributes) put(dir, ".gitattributes", attributes);
  put(dir, path, "one\ntwo\nthree\n");
  put(dir, "other.txt", "other\n");
  run(dir, "add", "-A");
  run(dir, "commit", "-q", "-m", "one");
  run(dir, "checkout", "-q", "-b", "side");
  put(dir, path, "one\nside two\nthree\n");
  run(dir, "commit", "-q", "-am", "side");
  run(dir, "checkout", "-q", "main");
  put(dir, path, "one\nmain two\nthree\n");
  put(dir, "other.txt", "other changed\n");
  run(dir, "commit", "-q", "-am", "main");
  spawnSync("git", ["merge", "side"], { cwd: dir, env: nativeGitEnv(tmp()) });
  put(dir, "other.txt", "other changed again\n");
}

describe("diff order file", () => {
  it("parses patterns as git does: lines kept as they are, blank lines and comments skipped", () => {
    const patterns = parseOrderFile(new TextEncoder().encode("*.h\n\n# c\n x\n*.c\r\nlast"));
    expect(patterns).toEqual(["*.h", " x", "*.c\r", "last"]);
  });

  it("orders by the first pattern matching the path or a leading directory, stably", () => {
    const patterns = ["*.h", "dir", "*.c"];
    const paths = ["z.c", "dir/x.txt", "a.txt", "b.h", "dir/sub/y.c", "a.c", "b.txt"];
    expect(orderByPatterns(paths, patterns, (p) => p)).toEqual([
      "b.h",
      // "*.h" does not match; "dir" matches the leading directory
      "dir/x.txt",
      "dir/sub/y.c",
      "z.c",
      "a.c",
      "a.txt",
      "b.txt",
    ]);
  });
});

describeGit("git diff configuration against native git", () => {
  it(`matches path prefixes on ${SEEDS} random repositories`, async () => {
    const mismatches: string[] = [];
    let compared = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const dir = join(tmp(), `prefix-${seed}`);
      const { a, b } = buildRepo(dir, seed, false);
      const r = prng(seed * 7919);
      // configuration: noprefix, mnemonicPrefix, both, and (git 2.45+) srcPrefix/dstPrefix
      const pick = seed % 4;
      if (pick === 1 || pick === 3) run(dir, "config", "diff.mnemonicPrefix", "true");
      if (pick === 2 || (pick === 3 && r() < 0.5)) run(dir, "config", "diff.noprefix", "true");
      if (configPrefixes && r() < 0.4) {
        run(dir, "config", "diff.srcPrefix", "SRC/");
        if (r() < 0.5) run(dir, "config", "diff.dstPrefix", "dst:");
      }
      const { git } = await open(dir);
      for (const [mode, modeArgs, make] of modes(a, b)) {
        for (let k = 0; k < 3; k++) {
          const args: string[] = [];
          const options: DiffTextOptions = {};
          if (r() < 0.25) {
            args.push("--no-prefix");
            options.noPrefix = true;
          }
          if (r() < 0.25) {
            args.push("--default-prefix");
            options.defaultPrefix = true;
          }
          if (r() < 0.3) {
            args.push("--src-prefix=old/");
            options.srcPrefix = "old/";
          }
          if (r() < 0.3) {
            args.push("--dst-prefix=");
            options.dstPrefix = "";
          }
          const m = await compare(
            dir,
            `seed ${seed} ${mode}`,
            () =>
              make(git)
                .setOptions({ ...versionOptions, ...options })
                .callBytes("patch"),
            ["diff", ...args, ...modeArgs],
          );
          compared++;
          if (m) mismatches.push(m);
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
    for (const m of mismatches.slice(0, SHOW)) console.log(m);
    expect(mismatches.length).toBe(0);
    expect(compared).toBe(SEEDS * 12);
  }, 300_000);

  it("prefixes the combined diff of a conflicted path as git does", async () => {
    const dir = join(tmp(), "prefix-conflict");
    buildConflict(dir, "f.txt");
    const cases: Array<[Array<[string, string]>, string[], DiffTextOptions]> = [
      [[["diff.mnemonicPrefix", "true"]], [], {}],
      [[["diff.noprefix", "true"]], [], {}],
      [[], ["--src-prefix=L/", "--dst-prefix=R/"], { srcPrefix: "L/", dstPrefix: "R/" }],
      [[["diff.mnemonicPrefix", "true"]], ["--default-prefix"], { defaultPrefix: true }],
    ];
    for (const [config, args, options] of cases) {
      spawnSync("git", ["config", "--remove-section", "diff"], {
        cwd: dir,
        env: nativeGitEnv(tmp()),
      });
      for (const [key, value] of config) run(dir, "config", key, value);
      const fresh = (await open(dir)).git;
      const ours = Buffer.from(await fresh.diff().setOptions(options).callBytes("patch"));
      const theirs = nativeOut(dir, ["diff", ...args]);
      expect(ours.toString()).toBe(theirs.toString());
      expect(theirs.toString()).toContain("diff --cc f.txt");
    }
  });

  it(`matches the order file on ${SEEDS} random repositories`, async () => {
    const mismatches: string[] = [];
    const patternPool = [
      "*.c",
      "*.h",
      "dir",
      "dir/sub/*",
      "*.txt",
      "e f.txt",
      "z",
      "ren/*",
      "*.bin",
      "# a comment",
      "",
      "[ad]*",
      "**/c.h",
      "link",
    ];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const dir = join(tmp(), `order-${seed}`);
      const { a, b } = buildRepo(dir, seed + 100, false);
      const r = prng(seed * 131);
      const patterns = patternPool.filter(() => r() < 0.5).sort(() => r() - 0.5);
      // not in the index: it changes none of the diffs
      put(dir, "order.txt", `${patterns.join("\n")}\n`);
      const viaConfig = r() < 0.5;
      if (viaConfig) run(dir, "config", "diff.orderFile", "order.txt");
      const { git } = await open(dir);
      for (const [mode, modeArgs, make] of modes(a, b)) {
        for (const [format, formatArgs] of FORMATS) {
          const args = viaConfig ? [] : ["-Oorder.txt"];
          const options: DiffTextOptions = viaConfig ? {} : { orderFile: "order.txt" };
          const m = await compare(
            dir,
            `seed ${seed} ${mode} ${format} [${patterns.join(",")}]`,
            () =>
              make(git)
                .setOptions({ ...versionOptions, ...options })
                .callBytes(format),
            ["diff", ...formatArgs, ...args, ...modeArgs],
          );
          if (m) mismatches.push(m);
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
    for (const m of mismatches.slice(0, SHOW)) console.log(m);
    expect(mismatches.length).toBe(0);
  }, 300_000);

  it("fails on a missing order file, as git does", async () => {
    const dir = join(tmp(), "order-missing");
    buildRepo(dir, 7, false);
    const { git } = await open(dir);
    expect(native(dir, ["diff", "-Onope.txt"]).status).toBe(128);
    await expect(git.diff().setOptions({ orderFile: "nope.txt" }).callText()).rejects.toThrow(
      "failed to read orderfile 'nope.txt'",
    );
  });

  it(`matches textconv on ${SEEDS} random repositories`, async () => {
    const mismatches: string[] = [];
    let converted = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const dir = join(tmp(), `textconv-${seed}`);
      const { a, b } = buildRepo(dir, seed + 200, true);
      const r = prng(seed * 977);
      const withRunner = await open(dir);
      installTextconvRunner(withRunner.workingCopy, nodeTextconv);
      const withoutRunner = await open(dir);
      for (const [mode, modeArgs, make] of modes(a, b)) {
        for (const [format, formatArgs] of FORMATS) {
          const extra: string[] = [];
          const options: DiffTextOptions = {};
          if (format === "name-only" && r() < 0.5) {
            // the names shown come from the patch (git 2.50+)
            extra.push("-w");
            options.ignoreWhitespace = true;
          }
          if (r() < 0.2) {
            extra.push("--text");
            options.text = true;
          }
          const off = r() < 0.3;
          const theirsArgs = ["diff", ...formatArgs, ...extra, ...modeArgs];
          const m1 = await compare(
            dir,
            `seed ${seed} ${mode} ${format}${off ? " no-textconv" : ""}`,
            () =>
              make(withRunner.git)
                .setOptions({ ...versionOptions, ...options, ...(off ? { textconv: false } : {}) })
                .callBytes(format),
            off ? [...theirsArgs.slice(0, 1), "--no-textconv", ...theirsArgs.slice(1)] : theirsArgs,
          );
          if (m1) mismatches.push(m1);
          // without a runner no textconv applies: git's --no-textconv
          const m2 = await compare(
            dir,
            `seed ${seed} ${mode} ${format} without runner`,
            () =>
              make(withoutRunner.git)
                .setOptions({ ...versionOptions, ...options })
                .callBytes(format),
            ["diff", "--no-textconv", ...formatArgs, ...extra, ...modeArgs],
          );
          if (m2) mismatches.push(m2);
          if (format === "patch" && !off) {
            const conv = nativeOut(dir, theirsArgs);
            const plain = nativeOut(dir, ["diff", "--no-textconv", ...extra, ...modeArgs]);
            if (!conv.equals(plain)) converted++;
          }
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
    for (const m of mismatches.slice(0, SHOW)) console.log(m);
    expect(mismatches.length).toBe(0);
    // the random repositories exercise textconv
    expect(converted).toBeGreaterThan(SEEDS);
  }, 300_000);

  it("converts a conflicted path's combined diff with textconv, as git does", async () => {
    const dir = join(tmp(), "textconv-conflict");
    buildConflict(dir, "f.up", "*.up diff=upper\n");
    run(dir, "config", "diff.upper.textconv", "tr a-z A-Z <");
    const { git, workingCopy } = await open(dir);
    installTextconvRunner(workingCopy, nodeTextconv);
    for (const off of [false, true]) {
      const ours = Buffer.from(
        await git
          .diff()
          .setOptions(off ? { textconv: false } : {})
          .callBytes("patch"),
      );
      const theirs = nativeOut(dir, ["diff", ...(off ? ["--no-textconv"] : [])]);
      expect(ours.toString()).toBe(theirs.toString());
      expect(theirs.toString()).toContain(off ? "side two" : "SIDE TWO");
    }
  });
});
