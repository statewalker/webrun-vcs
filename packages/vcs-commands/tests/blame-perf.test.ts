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
});
