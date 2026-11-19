/**
 * The merge family stays proportional to what it changes, not to the repository: a small
 * merge and a rebase in a repository of 2000 files read only the trees, files and index
 * entries the change touches (as git's merge-ort skips subtrees by their ids and
 * unpack-trees stats only the paths it switches). The bounds count file reads, which are
 * deterministic; the wall-clock bounds are generous, for slow CI machines.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PersonIdent } from "@statewalker/vcs-core";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitWorkingCopyConfig,
} from "@statewalker/vcs-store-files";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, MergeStatus, RebaseOperation, RebaseStatus } from "../src/index.js";
import { git, INTEROP_IDENT } from "./merge-native-helpers.js";
import { buildHistory, type Files, type History } from "./merge-native-scenarios.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const DIRS = 40;
const FILES_PER_DIR = 50;

/** 2000 files in 40 directories. */
function baseFiles(): Files {
  const files: Files = {};
  for (let d = 0; d < DIRS; d++) {
    for (let f = 0; f < FILES_PER_DIR; f++) {
      files[`d${d}/f${f}.txt`] = `file ${d}/${f}\n${"line\n".repeat(8)}`;
    }
  }
  return files;
}

const edited = (d: number, f: number, text: string) => ({
  [`d${d}/f${f}.txt`]: `file ${d}/${f}\n${"line\n".repeat(8)}${text}\n`,
});

/** File reads by kind: worktree files, loose objects, everything else under `.git`. */
interface Reads {
  worktree: number;
  objects: number;
  other: number;
}

/** A FilesApi counting its reads (and those of its lstat-caching views). */
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
        const p = path.replace(/^\/+/, "");
        if (p.startsWith(".git/objects/")) reads.objects++;
        else if (p.startsWith(".git")) reads.other++;
        else reads.worktree++;
        return (value as (...a: unknown[]) => unknown).call(target, path, ...rest);
      };
    },
  });
}

/** Our working copy over `dir`, its file reads counted into `reads`. */
async function openCounted(dir: string, reads: Reads): Promise<Git> {
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
  const config = new GitWorkingCopyConfig(io, ".git/config");
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
  return Git.fromWorkingCopy(new MemoryWorkingCopy({ history, checkout, worktree, config }));
}

const COMMITTER: PersonIdent = INTEROP_IDENT;

/**
 * Dates the index back to the second its files were written in, so every entry is racily
 * clean (as when the files, the commit and the index share one second, often on CI): a
 * write that checks the kept entries for racy-git smudging then reads every file.
 */
function racilyClean(dir: string): void {
  const written = statSync(join(dir, "d0/f0.txt")).mtime;
  utimesSync(join(dir, ".git/index"), written, written);
}

describeGit("the merge family reads only what it changes", () => {
  let root: string;
  let counter = 0;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "merge-perf-"));
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function twins(history: History): { native: string; ours: string } {
    const n = counter++;
    const native = join(root, `native-${n}`);
    const ours = join(root, `ours-${n}`);
    buildHistory(root, native, history);
    buildHistory(root, ours, history);
    return { native, ours };
  }

  const same = (native: string, ours: string) => {
    for (const args of [
      ["rev-parse", "HEAD^{tree}"],
      ["status", "--porcelain=v2", "-uall"],
      ["ls-files", "-s"],
    ]) {
      expect(git(root, ours, ...args).stdout).toBe(git(root, native, ...args).stdout);
    }
  };

  it("a merge of five changes a side reads a few trees and no untouched file", async () => {
    const side: Files = {};
    const main: Files = {};
    for (let i = 0; i < 5; i++) Object.assign(side, edited(i, 1, "side"));
    for (let i = 0; i < 5; i++) Object.assign(main, edited(10 + i, 2, "main"));
    // one file both sides change, merged line by line
    Object.assign(side, { "d20/f3.txt": `side\n${baseFiles()["d20/f3.txt"]}` });
    Object.assign(main, { "d20/f3.txt": `${baseFiles()["d20/f3.txt"]}main\n` });
    const { native, ours } = twins({ base: baseFiles(), side, main });
    git(root, native, "merge", "--no-edit", "side");

    const reads: Reads = { worktree: 0, objects: 0, other: 0 };
    const started = performance.now();
    const result = await (await openCounted(ours, reads))
      .merge()
      .include("side")
      .setAuthor(INTEROP_IDENT)
      .setCommitter(INTEROP_IDENT)
      .call();
    const elapsed = performance.now() - started;

    expect(result.status).toBe(MergeStatus.MERGED);
    same(native, ours);
    // the trees of the 11 changed directories and the root (two or three versions each),
    // the blobs written and merged, the commits: never the 40 directories of each side
    expect(reads.objects).toBeLessThan(2 * DIRS);
    // only the paths the merge writes are looked at in the worktree
    expect(reads.worktree).toBeLessThanOrEqual(11);
    expect(elapsed).toBeLessThan(15_000);
  }, 120_000);

  it("a rebase of ten commits reads a few objects per pick", async () => {
    const sideMore: Files[] = [];
    for (let i = 1; i < 10; i++) sideMore.push(edited(i * 3, 4, `side ${i}`));
    const { native, ours } = twins({
      base: baseFiles(),
      side: edited(0, 4, "side 0"),
      sideMore,
      main: { ...edited(1, 7, "main"), ...edited(2, 7, "main") },
    });
    git(root, native, "checkout", "-q", "side");
    git(root, ours, "checkout", "-q", "side");
    git(root, native, "rebase", "main");

    const reads: Reads = { worktree: 0, objects: 0, other: 0 };
    const started = performance.now();
    const command = (await openCounted(ours, reads)).rebase().setCommitter(COMMITTER);
    await command.setUpstreamBranch("main");
    const result = await command.call();
    const elapsed = performance.now() - started;

    expect(result.status).toBe(RebaseStatus.OK);
    same(native, ours);
    // per pick: the commit, its parent's and HEAD's trees where they differ; never a
    // whole tree (40 directories)
    expect(reads.objects).toBeLessThan(6 * DIRS);
    // the clean-worktree check stats every file (as git's refresh does) and reads at most
    // the racily clean ones; the picks read only the paths they write
    expect(reads.worktree).toBeLessThan(DIRS * FILES_PER_DIR + 100);
    expect(elapsed).toBeLessThan(60_000);
  }, 180_000);

  it("a merge over a racily clean index reads no untouched file either", async () => {
    const side: Files = {};
    const main: Files = {};
    for (let i = 0; i < 5; i++) Object.assign(side, edited(i, 1, "side"));
    for (let i = 0; i < 5; i++) Object.assign(main, edited(10 + i, 2, "main"));
    const { native, ours } = twins({ base: baseFiles(), side, main });
    git(root, native, "merge", "--no-edit", "side");
    racilyClean(ours);

    const reads: Reads = { worktree: 0, objects: 0, other: 0 };
    const result = await (await openCounted(ours, reads))
      .merge()
      .include("side")
      .setAuthor(INTEROP_IDENT)
      .setCommitter(INTEROP_IDENT)
      .call();

    expect(result.status).toBe(MergeStatus.MERGED);
    same(native, ours);
    // the entries the merge keeps are not checked for racy-git smudging when it writes the
    // index (it rewrites the index around its own paths): only the paths written are read
    expect(reads.worktree).toBeLessThanOrEqual(10);
  }, 120_000);

  it("a rebase over a racily clean index reads each file at most once", async () => {
    const sideMore: Files[] = [];
    for (let i = 1; i < 10; i++) sideMore.push(edited(i * 3, 4, `side ${i}`));
    const { native, ours } = twins({
      base: baseFiles(),
      side: edited(0, 4, "side 0"),
      sideMore,
      main: { ...edited(1, 7, "main"), ...edited(2, 7, "main") },
    });
    git(root, native, "checkout", "-q", "side");
    git(root, ours, "checkout", "-q", "side");
    git(root, native, "rebase", "main");
    racilyClean(ours);

    const reads: Reads = { worktree: 0, objects: 0, other: 0 };
    const command = (await openCounted(ours, reads)).rebase().setCommitter(COMMITTER);
    await command.setUpstreamBranch("main");
    const result = await command.call();

    expect(result.status).toBe(RebaseStatus.OK);
    same(native, ours);
    // the clean-worktree check reads the racily clean files once (as git's refresh); the
    // ten picks' index writes read none of them again
    expect(reads.worktree).toBeLessThan(DIRS * FILES_PER_DIR + 100);
  }, 180_000);

  it("an interactive rebase reads the list's abbreviations back without listing the store", async () => {
    const sideMore: Files[] = [];
    for (let i = 1; i < 10; i++) sideMore.push(edited(i * 3, 4, `side ${i}`));
    const { ours } = twins({
      base: baseFiles(),
      side: edited(0, 4, "side 0"),
      sideMore,
      main: { ...edited(1, 7, "main"), ...edited(2, 7, "main") },
    });
    git(root, ours, "checkout", "-q", "side");

    // the sequence editor stops after the first pick; prepareSteps names each step's commit
    const reads: Reads = { worktree: 0, objects: 0, other: 0 };
    let steps = 0;
    const begin = (await openCounted(ours, reads)).rebase().setCommitter(COMMITTER);
    begin.runInteractively({
      editTodo: (todo) => todo.replace(/^(pick .*)$/m, "$1\nbreak"),
      prepareSteps: (list) => {
        steps = list.length;
      },
    });
    await begin.setUpstreamBranch("main");
    const started = await begin.call();
    expect(started.status, started.message).toBe(RebaseStatus.STOPPED);
    expect(steps).toBe(11);
    // the picks and the list's commits; never a header of every object per name
    expect(reads.objects).toBeLessThan(6 * DIRS);

    // --edit-todo: the list as abbreviated for the editor read back
    reads.objects = 0;
    const edit = (await openCounted(ours, reads))
      .rebase()
      .setCommitter(COMMITTER)
      .setOperation(RebaseOperation.EDIT_TODO);
    edit.runInteractively({ editTodo: (todo) => todo });
    const editResult = await edit.call();
    expect(editResult.status, editResult.message).toBe(RebaseStatus.OK);
    expect(reads.objects).toBeLessThan(2 * DIRS);

    const resume = (await openCounted(ours, reads))
      .rebase()
      .setCommitter(COMMITTER)
      .setOperation(RebaseOperation.CONTINUE);
    expect((await resume.call()).status).toBe(RebaseStatus.OK);
  }, 180_000);
});
