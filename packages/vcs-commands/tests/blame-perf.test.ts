/**
 * Blame does the work git's blame does, once: on a long history it loads each commit and each
 * version of the file at most once, walks whole trees only to find a rename, and splits,
 * hashes and numbers each version's lines at most once (`LineInterner`), skipping the tails
 * every diff trims. The bounds count reads and interned lines, which are deterministic; the
 * wall-clock bound is generous, for slow CI machines.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { LineInterner } from "@statewalker/vcs-utils";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { formatBlamePorcelain, Git } from "../src/index.js";
import { buildLongHistory, type LongHistory } from "./blame-long-history.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

type Counts = Record<string, number>;

/** `store` with its method calls counted into `counts` as `<name>.<method>` */
function counted<T extends object>(store: T, name: string, counts: Counts): T {
  return new Proxy(store, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const k = `${name}.${String(key)}`;
        counts[k] = (counts[k] ?? 0) + 1;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

/** Our working copy over `dir`, its commit, tree and blob reads counted */
async function openCounted(dir: string, counts: Counts): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: dir });
  const { history } = await createGitFilesBackend({ files });
  for (const name of ["blobs", "trees", "commits"] as const) {
    const store = counted(history[name], name, counts);
    Object.defineProperty(history, name, { value: store, configurable: true });
  }
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

describeGit("blame reads and diffs each version once", () => {
  let root: string;
  let dir: string;
  let h: LongHistory;
  /** Distinct versions of the long-lived file (under its three names), and their lines */
  let versions = 0;
  let versionLines = 0;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "blame-perf-"));
    dir = join(root, "repo");
    h = buildLongHistory(dir, root, { commits: 240, lines: 400, seed: 11 });
    const env = nativeGitEnv(root);
    const objects = execFileSync("git", ["rev-list", "--objects", h.tip], { cwd: dir, env })
      .toString()
      .trim()
      .split("\n")
      .map((l) => l.split(" "))
      .filter(([, p]) => p?.endsWith("main.c"))
      .map(([id]) => id);
    versions = objects.length;
    for (const id of objects) {
      const text = execFileSync("git", ["cat-file", "blob", id], { cwd: dir, env }).toString();
      versionLines += text.split("\n").length - 1;
    }
  }, 60_000);
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("loads each commit and version at most once and interns each line at most once", async () => {
    const counts: Counts = {};
    const intern = vi.spyOn(LineInterner.prototype, "intern");
    let interned = 0;
    const started = performance.now();
    try {
      const git = await openCounted(dir, counts);
      const result = await git.blame().setFilePath(h.path).setStartCommit(h.tip).call();
      expect(formatBlamePorcelain(result).length).toBeGreaterThan(0);
      expect(result.lineCount).toBeGreaterThan(300);
      interned = intern.mock.calls.length;
    } finally {
      intern.mockRestore();
    }
    const elapsed = performance.now() - started;

    // each commit once (the walk keeps them), no commit read twice
    expect(counts["commits.load"]).toBeLessThanOrEqual(h.commits);
    // each version of the file once, and the two old names read again by rename detection
    expect(counts["blobs.load"]).toBeLessThanOrEqual(versions + 2);
    // whole trees are walked only where the file was renamed (both sides, twice)
    expect(counts["trees.loadTree"] ?? 0).toBeLessThanOrEqual(2 * 2 * 12);
    // each version's lines interned once at most; the tails every diff trims never
    expect(interned).toBeGreaterThan(0);
    expect(interned).toBeLessThan(versionLines);
    expect(elapsed).toBeLessThan(30_000);
  }, 60_000);

  it("blames a file the history rarely changes without diffing the long-lived one", async () => {
    const counts: Counts = {};
    const intern = vi.spyOn(LineInterner.prototype, "intern");
    let interned = 0;
    try {
      const git = await openCounted(dir, counts);
      const result = await git.blame().setFilePath(h.notes).setStartCommit(h.tip).call();
      interned = intern.mock.calls.length;
      // the small file's versions only: a few lines each
      expect(interned).toBeLessThan(result.lineCount * 40);
    } finally {
      intern.mockRestore();
    }
    const native = execFileSync(
      "git",
      ["log", "--format=%H", "--full-history", h.tip, "--", h.notes],
      { cwd: dir, env: nativeGitEnv(root) },
    )
      .toString()
      .trim()
      .split("\n").length;
    // only the versions of the small file are read, each once
    expect(counts["blobs.load"]).toBeLessThanOrEqual(native);
    expect(counts["commits.load"]).toBeLessThanOrEqual(h.commits);
    expect(counts["trees.loadTree"] ?? 0).toBe(0);
  }, 60_000);

  it("gives the same blame when the line interner is capped and replaced", async () => {
    const run = async (ignoreWhitespace: boolean, limit?: number) => {
      const intern = vi.spyOn(LineInterner.prototype, "intern");
      try {
        const git = await openCounted(dir, {});
        const cmd = git
          .blame()
          .setFilePath(h.path)
          .setStartCommit(h.tip)
          .setIgnoreWhitespace(ignoreWhitespace);
        if (limit !== undefined) cmd.setInternerByteLimit(limit);
        const out = formatBlamePorcelain(await cmd.call());
        return { out, interners: new Set(intern.mock.contexts).size };
      } finally {
        intern.mockRestore();
      }
    };
    for (const ws of [false, true]) {
      const plain = await run(ws);
      // a cap far below one version: a new interner for nearly every version read
      const capped = await run(ws, 256);
      expect(plain.interners).toBe(1);
      expect(capped.interners).toBeGreaterThan(10);
      expect(capped.out.length).toBe(plain.out.length);
      expect(Buffer.from(capped.out).equals(Buffer.from(plain.out))).toBe(true);
    }
  }, 60_000);
  it("looks for copies (-C -C -C) reading each version of every file once", async () => {
    const env = nativeGitEnv(root);
    const blobs = execFileSync("git", ["rev-list", "--objects", "--no-object-names", h.tip], {
      cwd: dir,
      env,
    })
      .toString()
      .trim()
      .split("\n")
      .filter(
        (id) =>
          execFileSync("git", ["cat-file", "-t", id], { cwd: dir, env }).toString().trim() ===
          "blob",
      ).length;
    const counts: Counts = {};
    const git = await openCounted(dir, counts);
    const started = performance.now();
    const result = await git
      .blame()
      .setFilePath(h.path)
      .setStartCommit(h.tip)
      .setDetectCopies(3)
      .call();
    const elapsed = performance.now() - started;
    // every file of every parent is looked in, but each version is read once (and the two
    // old names of the long-lived file again by rename detection)
    expect(counts["blobs.load"]).toBeLessThanOrEqual(blobs + 2);
    expect(elapsed).toBeLessThan(60_000);
    // the same blame when the interner is replaced while the copies are looked for
    const capped = await (await openCounted(dir, {}))
      .blame()
      .setFilePath(h.path)
      .setStartCommit(h.tip)
      .setDetectCopies(3)
      .setInternerByteLimit(256)
      .call();
    expect(
      Buffer.from(formatBlamePorcelain(capped)).equals(Buffer.from(formatBlamePorcelain(result))),
    ).toBe(true);
  }, 120_000);
});

describeGit("blame -C -C -C over parents with many files", () => {
  let root: string;
  let dir: string;
  let tip: string;
  const FILES = 600;
  const COMMITS = 30;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "blame-wide-"));
    dir = join(root, "repo");
    const env = nativeGitEnv(root);
    execFileSync("git", ["init", "-q", "-b", "main", dir], { env });
    // as the review's gen.py: files of distinct lines in 50 directories, three changed per
    // commit, and a target file growing by blocks copied from them
    let seed = 1;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const content = (i: number, v: number) =>
      Array.from(
        { length: 40 },
        (_, j) => `file ${i} line ${j} version ${v} payload ${rand(1e6)}\n`,
      ).join("");
    const files: string[] = [];
    const target: string[] = [];
    const chunks: string[] = [];
    const data = (text: string) => chunks.push(`data ${Buffer.byteLength(text)}\n${text}\n`);
    for (let c = 0; c < COMMITS; c++) {
      const t = 1112911993 + c * 60;
      chunks.push(`commit refs/heads/main\nmark :${c + 1}\n`);
      chunks.push(`author A U Thor <a@x> ${t} +0000\ncommitter C O M <c@x> ${t} +0000\n`);
      data(`c${c}\n`);
      if (c) chunks.push(`from :${c}\n`);
      const changed =
        c === 0
          ? Array.from({ length: FILES }, (_, i) => i)
          : [rand(FILES), rand(FILES), rand(FILES)];
      for (const i of changed) {
        files[i] = content(i, c);
        chunks.push(`M 100644 inline d${i % 50}/f${i}.txt\n`);
        data(files[i]);
      }
      if (c) {
        const src = files[rand(FILES)].split(/(?<=\n)/);
        const a = rand(30);
        target.splice(rand(target.length + 1), 0, ...src.slice(a, a + 5));
      }
      target.push(`own line ${c}\n`);
      chunks.push("M 100644 inline target.txt\n");
      data(target.join(""));
    }
    execFileSync("git", ["fast-import", "--quiet"], { cwd: dir, env, input: chunks.join("") });
    tip = execFileSync("git", ["rev-parse", "main"], { cwd: dir, env }).toString().trim();
  }, 120_000);
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("interns only the files sharing lines with the blamed ones, whatever the caches keep", async () => {
    const native = execFileSync(
      "git",
      ["blame", "--porcelain", "-C", "-C", "-C", tip, "--", "target.txt"],
      { cwd: dir, env: nativeGitEnv(root), maxBuffer: 1 << 26 },
    );
    // the caches far below the parents' files (a 24 KiB file each): nothing stays between commits
    for (const limit of [undefined, 4096]) {
      const counts: Counts = {};
      const text = vi.spyOn(LineInterner.prototype, "text");
      let texts = 0;
      const started = performance.now();
      let out: Uint8Array;
      try {
        const cmd = (await openCounted(dir, counts))
          .blame()
          .setFilePath("target.txt")
          .setStartCommit(tip)
          .setDetectCopies(3);
        if (limit !== undefined) cmd.setCopyCacheByteLimit(limit);
        out = formatBlamePorcelain(await cmd.call());
        texts = text.mock.calls.length;
      } finally {
        text.mockRestore();
      }
      const elapsed = performance.now() - started;
      expect(Buffer.from(out).equals(native)).toBe(true);
      // each commit looks in all its parent's files, but splits and diffs only the few the
      // target's lines come from (a file sharing no line cannot give a copy)
      expect(texts).toBeLessThan(COMMITS * 10);
      // with the caches, each version of a file is read once
      if (limit === undefined) expect(counts["blobs.load"]).toBeLessThan(FILES + COMMITS * 5);
      else expect(counts["blobs.load"]).toBeLessThan(FILES * COMMITS * 2);
      expect(elapsed).toBeLessThan(60_000);
    }
  }, 180_000);
});
