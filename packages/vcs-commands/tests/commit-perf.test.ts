/**
 * `commit -a` and `commit` stay proportional to what they change: in a repository of 2000
 * files, `commit -a` with three files edited settles every other entry by its stat in the
 * stat pass (no call into the index adder, no read), and both store only the trees of the
 * directories changed (the cache-tree's valid nodes skipped by their entry counts). The
 * commits are native git's, byte for byte. The bounds count calls and reads, which are
 * deterministic; the wall-clock bounds are generous, for slow CI machines.
 */

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { History } from "@statewalker/vcs-core";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitWorkingCopyConfig,
} from "@statewalker/vcs-store-files";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { IndexAdder } from "../src/commands/index-adder.js";
import { Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const DIRS = 40;
const FILES_PER_DIR = 50;

/** Worktree files read (outside `.git`). */
interface Reads {
  worktree: number;
}

/** A FilesApi counting its worktree reads (and those of its lstat-caching views). */
function counted(files: FilesApi, reads: Reads): FilesApi {
  return new Proxy(files, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (key === "withLstatCache") {
        return () => counted((value as () => FilesApi).call(target), reads);
      }
      if (key !== "read") return value.bind(target);
      return (path: string, ...rest: unknown[]) => {
        if (!path.replace(/^\/+/, "").startsWith(".git")) reads.worktree++;
        return (value as (...a: unknown[]) => unknown).call(target, path, ...rest);
      };
    },
  });
}

describeGit("commit stays proportional to the change", () => {
  let root: string;
  let counter = 0;
  const env = () => nativeGitEnv(root);

  const git = (dir: string, ...args: string[]): string => {
    const r = spawnSync("git", args, { cwd: dir, env: env(), encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout;
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "commit-perf-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * A repository of 2000 files committed; the files dated well before the index, so no
   * entry is racily clean (their stat alone settles them, in git and ours alike).
   */
  function repository(): string {
    const dir = join(root, `repo-${counter++}`);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    const old = new Date(Date.now() - 3600_000);
    for (let d = 0; d < DIRS; d++) {
      mkdirSync(join(dir, `d${d}`));
      for (let f = 0; f < FILES_PER_DIR; f++) {
        const path = join(dir, `d${d}`, `f${f}.txt`);
        writeFileSync(path, `file ${d}/${f}\n${"line\n".repeat(8)}`);
        utimesSync(path, old, old);
      }
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    return dir;
  }

  /** Twins built alike (never copied: a copy changes every file's ctime and inode). */
  const twins = () => ({ native: repository(), ours: repository() });

  async function open(dir: string, reads: Reads): Promise<{ git: Git; history: History }> {
    const files = counted(createNodeFilesApi({ rootDir: dir }), reads);
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
    const environment = createNodeGitHostEnvironment({ env: env() });
    const config = new GitWorkingCopyConfig(io, ".git/config", { environment });
    await config.load();
    const staging = new FileStagingStore(files, ".git/index");
    await staging.read();
    const checkoutFiles = {
      read: io.read,
      write: (p: string, c: Iterable<Uint8Array>) => files.write(p, c),
      stats: async (p: string) => {
        const s = await files.stats(p);
        return s ? { isDirectory: s.kind === "directory" } : undefined;
      },
      remove: async (p: string) => {
        await files.remove(p);
      },
      removeDir: async (p: string) => {
        await files.remove(p);
      },
      mkdir: (p: string) => files.mkdir(p),
      list: (p: string) => files.list(p),
    } as unknown as GitCheckoutFilesApi;
    const checkout = new GitCheckout({
      staging,
      refs: history.refs,
      files: checkoutFiles,
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
    return { git: Git.fromWorkingCopy(wc), history };
  }

  const edit = (dir: string, path: string) =>
    writeFileSync(join(dir, path), `${readFileSync(join(dir, path), "utf8")}edited\n`);

  const same = (native: string, ours: string) => {
    for (const args of [
      ["rev-parse", "HEAD", "HEAD^{tree}"],
      ["status", "--porcelain=v2", "-uall"],
      ["ls-files", "-s"],
    ]) {
      expect(git(ours, ...args)).toBe(git(native, ...args));
    }
  };

  it("commit -a of three edits settles the other 1997 entries by their stat", async () => {
    const { native, ours } = twins();
    const edited = ["d3/f7.txt", "d17/f0.txt", "d17/f9.txt"];
    for (const dir of [native, ours]) for (const path of edited) edit(dir, path);
    git(native, "commit", "-q", "-a", "-m", "edits");

    const reads: Reads = { worktree: 0 };
    const { git: ours$, history } = await open(ours, reads);
    const adds = vi.spyOn(IndexAdder.prototype, "add");
    const stored = vi.spyOn(history.trees, "store");
    const started = performance.now();
    let added: number;
    try {
      await ours$.commit().setAll(true).setMessage("edits").call();
    } finally {
      added = adds.mock.calls.length;
      adds.mockRestore();
    }
    const elapsed = performance.now() - started;

    same(native, ours);
    // the adder sees only the files whose stat changed
    expect(added).toBe(edited.length);
    expect(reads.worktree).toBeLessThanOrEqual(edited.length);
    // d3, d17 and the root
    expect(stored).toHaveBeenCalledTimes(3);
    expect(elapsed).toBeLessThan(15_000);
  });

  it("commit of a staged file stores the trees of its directory and the root", async () => {
    const { native, ours } = twins();
    for (const dir of [native, ours]) {
      edit(dir, "d25/f3.txt");
      git(dir, "add", "d25/f3.txt");
      // the index as git leaves it after a refresh: no entry racily clean
      const old = new Date(Date.now() - 1800_000);
      utimesSync(join(dir, "d25/f3.txt"), old, old);
      git(dir, "update-index", "-q", "--refresh");
      expect(statSync(join(dir, ".git/index")).mtimeMs).toBeGreaterThan(old.getTime());
    }
    git(native, "commit", "-q", "-m", "staged");

    const reads: Reads = { worktree: 0 };
    const { git: ours$, history } = await open(ours, reads);
    const stored = vi.spyOn(history.trees, "store");
    const started = performance.now();
    await ours$.commit().setMessage("staged").call();
    const elapsed = performance.now() - started;

    same(native, ours);
    expect(stored).toHaveBeenCalledTimes(2);
    expect(reads.worktree).toBe(0);
    expect(elapsed).toBeLessThan(15_000);
  });
});
