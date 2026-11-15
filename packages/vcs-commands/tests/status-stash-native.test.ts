/**
 * `status` and `stash push` against native git: the same repository read by native
 * `git status --porcelain` (v1 and v2) and by our StatusCommand, and stashed by native
 * `git stash push` in one copy and by our StashCreateCommand (with its built-in working-tree
 * provider) in a twin copy, then the stash trees, index, status and files compared.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryFilesApi, createSymlinkFilesApi } from "@statewalker/vcs-core";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitWorkingCopyConfig,
} from "@statewalker/vcs-store-files";
import {
  createMemoryObjectStores,
  MemoryRefs,
  MemoryStagingStore,
} from "@statewalker/vcs-store-mem";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemoryCheckout, MemoryWorkingCopy, type Worktree } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { formatStatusPorcelain, Git } from "../src/index.js";
import { backends } from "./backend-factories.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { createSimpleHistory } from "./simple-history-store.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
const exec = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(root),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const run = (cwd: string, ...args: string[]) => exec(cwd, ...args).trim();
const nativeStatus = (dir: string, version: 1 | 2, ...extra: string[]) =>
  exec(
    dir,
    "-c",
    "status.renames=false",
    "status",
    `--porcelain=v${version}`,
    "--untracked-files=all",
    ...extra,
  );
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};
const read = (path: string) => {
  if (!existsSync(path)) return "<missing>";
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return `-> ${readlinkSync(path)}`;
  if (stat.isDirectory()) return "<dir>";
  return `${(stat.mode & 0o111) !== 0 ? "x " : ""}${readFileSync(path, "utf8")}`;
};

/** Every path of the worktree (outside `.git`), sorted. */
function listing(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === ".git") continue;
    out.push(path);
    if (entry.isDirectory()) out.push(...listing(dir, path));
  }
  return out.sort();
}

/** Our working copy over a repository native git made in `dir`. */
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
  return { ours: Git.fromWorkingCopy(wc), wc, worktree };
}

/** A repository with a few committed files on main. */
function repo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  run(dir, "init", "-q", "-b", "main");
  put(dir, "a.txt", "a\n");
  put(dir, "b.txt", "b\n");
  put(dir, "c.txt", "c\n");
  put(dir, "d/e.txt", "e\n");
  put(dir, "d/f.txt", "f\n");
  run(dir, "add", ".");
  run(dir, "commit", "-q", "-m", "c1");
}

/** Our status, as porcelain v1 and v2, equals native git's. */
async function expectStatusAsNative(dir: string, ignored = false) {
  const extra = ignored ? ["--ignored"] : [];
  const { ours } = await open(dir);
  const status = await ours.status().setIgnored(ignored).call();
  expect(formatStatusPorcelain(status, 1)).toBe(nativeStatus(dir, 1, ...extra));
  const { ours: again } = await open(dir);
  const v2 = formatStatusPorcelain(await again.status().setIgnored(ignored).call(), 2);
  expect(v2).toBe(nativeStatus(dir, 2, ...extra));
  return status;
}

describeGit("status against native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "status-native-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a clean worktree is clean", async () => {
    const dir = join(root, "r");
    repo(dir);
    const status = await expectStatusAsNative(dir);
    expect(status.isClean()).toBe(true);
    expect(status.hasUncommittedChanges()).toBe(false);
  });

  it("modified, deleted, untracked and staged changes, as git reports them", async () => {
    const dir = join(root, "r");
    repo(dir);
    put(dir, "a.txt", "a changed\n");
    rmSync(join(dir, "b.txt"));
    put(dir, "new/deep/u.txt", "u\n");
    put(dir, "u.txt", "u\n");
    put(dir, "s.txt", "staged\n");
    run(dir, "add", "s.txt");
    put(dir, "s.txt", "staged then edited\n");
    put(dir, "c.txt", "c staged\n");
    run(dir, "add", "c.txt");
    rmSync(join(dir, "c.txt"));
    run(dir, "rm", "-q", "--cached", "d/e.txt");
    put(dir, "t.txt", "t\n");
    run(dir, "add", "t.txt");
    rmSync(join(dir, "t.txt"));
    const status = await expectStatusAsNative(dir);
    expect(status.isClean()).toBe(false);
    expect([...status.modified].sort()).toEqual(["a.txt", "s.txt"]);
    expect([...status.missing].sort()).toEqual(["b.txt", "c.txt", "t.txt"]);
    expect([...status.untracked].sort()).toEqual(["d/e.txt", "new/deep/u.txt", "u.txt"]);
    expect(status.removed).toEqual(new Set(["d/e.txt"]));
  });

  it("untracked files alone make the status unclean, without uncommitted changes", async () => {
    const dir = join(root, "r");
    repo(dir);
    put(dir, "u.txt", "u\n");
    const status = await expectStatusAsNative(dir);
    expect(status.isClean()).toBe(false);
    expect(status.hasUncommittedChanges()).toBe(false);
  });

  it("ignored files with --ignored; tracked files in ignored directories are compared", async () => {
    const dir = join(root, "r");
    repo(dir);
    put(dir, "build/tracked.txt", "t\n");
    run(dir, "add", "-f", "build/tracked.txt");
    run(dir, "commit", "-qm", "build");
    put(dir, ".gitignore", "*.log\nbuild/\n!keep.log\n");
    put(dir, "x.log", "log\n");
    put(dir, "keep.log", "keep\n");
    put(dir, "d/y.log", "log\n");
    put(dir, "build/out.o", "o\n");
    put(dir, "build/sub/deep.o", "o\n");
    put(dir, "build/tracked.txt", "tracked, edited\n");
    await expectStatusAsNative(dir);
    const status = await expectStatusAsNative(dir, true);
    expect([...status.ignored].sort()).toEqual([
      "build/out.o",
      "build/sub/deep.o",
      "d/y.log",
      "x.log",
    ]);
  });

  it("a same-size edit within the index's timestamp is found (racy git)", async () => {
    const dir = join(root, "r");
    repo(dir);
    const when = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    utimesSync(join(dir, "a.txt"), when, when);
    run(dir, "add", "a.txt");
    // the index file as old as the entry: the entry is racily clean
    utimesSync(join(dir, ".git/index"), when, when);
    put(dir, "a.txt", "A\n");
    utimesSync(join(dir, "a.txt"), when, when);
    const status = await expectStatusAsNative(dir);
    expect(status.modified).toEqual(new Set(["a.txt"]));
  });

  it("reads no file whose stat matches a non-racy index entry", async () => {
    const dir = join(root, "r");
    repo(dir);
    const old = new Date(Date.now() - 120_000);
    for (const f of ["a.txt", "b.txt", "c.txt", "d/e.txt", "d/f.txt"]) {
      utimesSync(join(dir, f), old, old);
    }
    run(dir, "update-index", "--really-refresh");
    put(dir, "c.txt", "changed size\n");
    const { ours, worktree } = await open(dir);
    const hash = vi.spyOn(worktree, "computeHash");
    const content = vi.spyOn(worktree, "readContent");
    const status = await ours.status().call();
    expect(status.modified).toEqual(new Set(["c.txt"]));
    // the size differs: no file was read at all
    if (hash.mock.calls.length > 0) {
      // show what the index recorded next to what the filesystem reports
      const stats = ["a.txt", "b.txt"].map((f) => {
        const s = lstatSync(join(dir, f), { bigint: true });
        return `${f}: mtimeNs=${s.mtimeNs} ctimeNs=${s.ctimeNs} size=${s.size}`;
      });
      const index = lstatSync(join(dir, ".git/index"), { bigint: true });
      const debug = run(dir, "ls-files", "--debug", "a.txt", "b.txt");
      const entries = await Promise.all(
        ["a.txt", "b.txt"].map(async (f) => JSON.stringify(await worktree.getEntry(f))),
      );
      throw new Error(
        [
          `hashed: ${hash.mock.calls.map((c) => c[0]).join(", ")}`,
          `index mtimeNs=${index.mtimeNs}`,
          ...stats,
          debug,
          ...entries,
          run(dir, "--version"),
        ].join("\n"),
      );
    }
    expect(hash).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
  });

  it("typechange, links (120000) and the executable bit per core.filemode", async () => {
    const dir = join(root, "r");
    repo(dir);
    symlinkSync("a.txt", join(dir, "link"));
    put(dir, "run.sh", "#!/bin/sh\n");
    chmodSync(join(dir, "run.sh"), 0o755);
    run(dir, "add", ".");
    run(dir, "commit", "-qm", "links");
    // a file becomes a link, a link a file, the executable bit goes
    rmSync(join(dir, "b.txt"));
    symlinkSync("c.txt", join(dir, "b.txt"));
    rmSync(join(dir, "link"));
    put(dir, "link", "not a link\n");
    chmodSync(join(dir, "run.sh"), 0o644);
    // a link retargeted
    symlinkSync("a.txt", join(dir, "l2"));
    run(dir, "add", "l2");
    rmSync(join(dir, "l2"));
    symlinkSync("b.txt", join(dir, "l2"));
    const status = await expectStatusAsNative(dir);
    expect([...status.modified].sort()).toEqual(["b.txt", "l2", "link", "run.sh"]);
    run(dir, "config", "core.filemode", "false");
    await expectStatusAsNative(dir);
  });

  it("core.symlinks=false: a link checked out as a file holding its target is clean", async () => {
    const dir = join(root, "r");
    repo(dir);
    symlinkSync("a.txt", join(dir, "link"));
    run(dir, "add", "link");
    run(dir, "commit", "-qm", "link");
    run(dir, "config", "core.symlinks", "false");
    rmSync(join(dir, "link"));
    put(dir, "link", "a.txt");
    const status = await expectStatusAsNative(dir);
    expect(status.isClean()).toBe(true);
    put(dir, "link", "b.txt");
    expect((await expectStatusAsNative(dir)).modified).toEqual(new Set(["link"]));
  });

  it("unmerged entries of a conflicted merge (UU, AA, UD, DU)", async () => {
    const dir = join(root, "r");
    repo(dir);
    run(dir, "checkout", "-qb", "other");
    put(dir, "a.txt", "a other\n");
    put(dir, "both.txt", "other\n");
    put(dir, "b.txt", "b other\n");
    run(dir, "rm", "-q", "c.txt");
    run(dir, "add", ".");
    run(dir, "commit", "-qm", "other");
    run(dir, "checkout", "-q", "main");
    put(dir, "a.txt", "a main\n");
    put(dir, "both.txt", "main\n");
    run(dir, "rm", "-q", "b.txt");
    put(dir, "c.txt", "c main\n");
    run(dir, "add", ".");
    run(dir, "commit", "-qm", "main");
    try {
      exec(dir, "merge", "-q", "other");
    } catch {
      // conflicts expected
    }
    put(dir, "u.txt", "untracked\n");
    const status = await expectStatusAsNative(dir);
    expect([...status.conflicting].sort()).toEqual(["a.txt", "b.txt", "both.txt", "c.txt"]);
    expect(status.conflictingStageState.get("both.txt")).toBe("both-added");
  });

  it("an intent-to-add entry, and a path filter", async () => {
    const dir = join(root, "r");
    repo(dir);
    put(dir, "n.txt", "n\n");
    run(dir, "add", "-N", "n.txt");
    put(dir, "d/e.txt", "e changed\n");
    put(dir, "a.txt", "a changed\n");
    const { ours } = await open(dir);
    expect(formatStatusPorcelain(await ours.status().call())).toBe(nativeStatus(dir, 1));
    const { ours: filtered } = await open(dir);
    expect(formatStatusPorcelain(await filtered.status().addPath("d").call())).toBe(
      nativeStatus(dir, 1, "--", "d"),
    );
  });
});

/** The trees of the newest stash: the stash commit, its index commit, its untracked one. */
function stashTrees(dir: string) {
  const tree = (rev: string) => {
    try {
      return run(dir, "rev-parse", "--verify", "-q", `${rev}^{tree}`);
    } catch {
      return "<none>";
    }
  };
  const parents = run(dir, "log", "-1", "--format=%P", "stash@{0}").split(" ");
  return {
    parents: parents.length,
    worktree: tree("stash@{0}"),
    index: tree(parents[1] ?? "<none>"),
    untracked: parents[2] ? tree(parents[2]) : "<none>",
  };
}

/** Stashes with native git in a copy of `dir` and with ours in `dir`. */
async function bothStash(
  dir: string,
  options: { untracked?: boolean; all?: boolean; keepIndex?: boolean } = {},
) {
  const native = `${dir}-native`;
  cpSync(dir, native, { recursive: true, verbatimSymlinks: true });
  const args = ["stash", "push", "-q"];
  if (options.untracked) args.push("-u");
  if (options.all) args.push("-a");
  if (options.keepIndex) args.push("--keep-index");
  exec(native, ...args);
  const { ours } = await open(dir);
  const id = await ours
    .stashCreate()
    .setIncludeUntracked(options.untracked === true)
    .setIncludeIgnored(options.all === true)
    .setKeepIndex(options.keepIndex === true)
    .call();
  return { native, id };
}

/** The same stash trees, status, index and files in both copies. */
function expectSameStash(dir: string, native: string) {
  expect(stashTrees(dir)).toEqual(stashTrees(native));
  expect(nativeStatus(dir, 1, "--ignored")).toBe(nativeStatus(native, 1, "--ignored"));
  expect(run(dir, "ls-files", "-s")).toBe(run(native, "ls-files", "-s"));
  expect(listing(dir)).toEqual(listing(native));
  for (const file of listing(native)) {
    expect(read(join(dir, file)), file).toBe(read(join(native, file)));
  }
}

describeGit("stash push against native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stash-push-native-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Staged, unstaged, deleted, added, untracked and ignored changes. */
  function changes(dir: string) {
    put(dir, ".gitignore", "*.log\n");
    run(dir, "add", ".gitignore");
    run(dir, "commit", "-qm", "ignore");
    put(dir, "a.txt", "a staged\n");
    run(dir, "add", "a.txt");
    put(dir, "a.txt", "a staged, then edited\n");
    put(dir, "b.txt", "b unstaged\n");
    rmSync(join(dir, "c.txt"));
    put(dir, "d/new.txt", "new\n");
    run(dir, "add", "d/new.txt");
    run(dir, "rm", "-q", "d/f.txt");
    put(dir, "u/untracked.txt", "untracked\n");
    put(dir, "top.txt", "untracked top\n");
    put(dir, "x.log", "ignored\n");
  }

  it("the default provider stashes as git stash push, and resets as git does", async () => {
    const dir = join(root, "r");
    repo(dir);
    changes(dir);
    const { native, id } = await bothStash(dir);
    expect(id).toBeDefined();
    expectSameStash(dir, native);
    // native git lists and shows our stash as its own
    expect(run(dir, "stash", "list", "--format=%gs")).toBe(
      run(native, "stash", "list", "--format=%gs"),
    );
    expect(run(dir, "stash", "show", "-p", "--stat")).toBe(
      run(native, "stash", "show", "-p", "--stat"),
    );
    // and applies it (with --index) to the same state as its own
    run(dir, "stash", "apply", "-q", "--index");
    run(native, "stash", "apply", "-q", "--index");
    expect(nativeStatus(dir, 2)).toBe(nativeStatus(native, 2));
    expect(run(dir, "ls-files", "-s")).toBe(run(native, "ls-files", "-s"));
    expect(listing(dir)).toEqual(listing(native));
    for (const file of listing(native))
      expect(read(join(dir, file))).toBe(read(join(native, file)));
  });

  it("-u stashes and removes the untracked files; ignored files stay", async () => {
    const dir = join(root, "r");
    repo(dir);
    changes(dir);
    const { native } = await bothStash(dir, { untracked: true });
    expectSameStash(dir, native);
    expect(existsSync(join(dir, "x.log"))).toBe(true);
    expect(existsSync(join(dir, "u"))).toBe(false);
    run(dir, "stash", "apply", "-q");
    run(native, "stash", "apply", "-q");
    expect(nativeStatus(dir, 1)).toBe(nativeStatus(native, 1));
  });

  it("-a stashes the ignored files too", async () => {
    const dir = join(root, "r");
    repo(dir);
    changes(dir);
    const { native } = await bothStash(dir, { all: true });
    expectSameStash(dir, native);
    expect(existsSync(join(dir, "x.log"))).toBe(false);
  });

  it("--keep-index keeps the staged changes in the index and the worktree", async () => {
    const dir = join(root, "r");
    repo(dir);
    changes(dir);
    const { native } = await bothStash(dir, { keepIndex: true });
    expectSameStash(dir, native);
    expect(read(join(dir, "a.txt"))).toBe("a staged\n");
  });

  it("links, executables and a git rm --cached file still in the worktree", async () => {
    const dir = join(root, "r");
    repo(dir);
    symlinkSync("a.txt", join(dir, "link"));
    put(dir, "run.sh", "#!/bin/sh\n");
    run(dir, "add", ".");
    run(dir, "commit", "-qm", "links");
    rmSync(join(dir, "link"));
    symlinkSync("b.txt", join(dir, "link"));
    chmodSync(join(dir, "run.sh"), 0o755);
    run(dir, "rm", "-q", "--cached", "d/e.txt");
    put(dir, "d/e.txt", "e edited, untracked now\n");
    const { native } = await bothStash(dir);
    expectSameStash(dir, native);
  });

  it("nothing to stash: no stash (untracked files only count with -u)", async () => {
    const dir = join(root, "r");
    repo(dir);
    put(dir, "u.txt", "u\n");
    const { ours } = await open(dir);
    expect(await ours.stashCreate().call()).toBeUndefined();
    expect(existsSync(join(dir, ".git/refs/stash"))).toBe(false);
    const { native, id } = await bothStash(dir, { untracked: true });
    expect(id).toBeDefined();
    expectSameStash(dir, native);
  });

  it("a same-size edit within the index's timestamp is stashed (racy git)", async () => {
    const dir = join(root, "r");
    repo(dir);
    const when = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
    utimesSync(join(dir, "a.txt"), when, when);
    run(dir, "add", "a.txt");
    utimesSync(join(dir, ".git/index"), when, when);
    put(dir, "a.txt", "A\n");
    utimesSync(join(dir, "a.txt"), when, when);
    const { native } = await bothStash(dir);
    expectSameStash(dir, native);
    expect(read(join(dir, "a.txt"))).toBe("a\n");
  });

  it("refuses an index with unmerged entries, as git", async () => {
    const dir = join(root, "r");
    repo(dir);
    run(dir, "checkout", "-qb", "other");
    put(dir, "a.txt", "a other\n");
    run(dir, "commit", "-qam", "other");
    run(dir, "checkout", "-q", "main");
    put(dir, "a.txt", "a main\n");
    run(dir, "commit", "-qam", "main");
    try {
      exec(dir, "merge", "-q", "other");
    } catch {
      // conflict expected
    }
    const { ours } = await open(dir);
    await expect(ours.stashCreate().call()).rejects.toThrow(/a\.txt: needs merge/);
    expect(existsSync(join(dir, ".git/refs/stash"))).toBe(false);
  });
});

describe.each(backends)("status and stash on a worktree ($name backend)", ({ factory }) => {
  const text = (s: string) => new TextEncoder().encode(s);
  const readText = async (worktree: Worktree, path: string) => {
    const chunks: Uint8Array[] = [];
    for await (const c of worktree.readContent(path)) chunks.push(c);
    return new TextDecoder().decode(Buffer.concat(chunks));
  };

  async function setup() {
    const { workingCopy } = await factory();
    const git = Git.fromWorkingCopy(workingCopy);
    const worktree = workingCopy.worktree as Worktree;
    await worktree.writeContent("a.txt", text("a\n"));
    await worktree.writeContent("b.txt", text("b\n"));
    await git.add().addFilepattern(".").call();
    await git.commit().setMessage("c1").call();
    return { git, workingCopy, worktree };
  }

  it("status sees worktree edits, deletions and untracked files", async () => {
    const { git, worktree } = await setup();
    expect((await git.status().call()).isClean()).toBe(true);
    await worktree.writeContent("a.txt", text("A\n"));
    await worktree.remove("b.txt");
    await worktree.writeContent("u.txt", text("u\n"));
    const status = await git.status().call();
    expect(formatStatusPorcelain(status)).toBe(" M a.txt\n D b.txt\n?? u.txt\n");
    expect(status.isClean()).toBe(false);
  });

  it("stashCreate needs no provider: stashes, resets, keeps untracked files", async () => {
    const { git, workingCopy, worktree } = await setup();
    await worktree.writeContent("a.txt", text("A\n"));
    await worktree.writeContent("u.txt", text("u\n"));
    const id = await git.stashCreate().call();
    expect(id).toBeDefined();
    const stash = await workingCopy.history.commits.load(id as string);
    const entry = await workingCopy.history.trees.getEntry(stash?.tree as string, "a.txt");
    expect(entry?.id).toBe(await workingCopy.history.blobs.store([text("A\n")]));
    expect(formatStatusPorcelain(await git.status().call())).toBe("?? u.txt\n");
    expect(await readText(worktree, "a.txt")).toBe("a\n");
    // nothing left to stash
    expect(await git.stashCreate().call()).toBeUndefined();
    // the stash applies back
    await git.stashApply().call();
    expect(formatStatusPorcelain(await git.status().call())).toBe(" M a.txt\n?? u.txt\n");
  });
});

describe("stash apply on a case-folding worktree (core.ignorecase)", () => {
  it("a move-aside name taken in another case gets the next suffix", async () => {
    const files = createSymlinkFilesApi(createInMemoryFilesApi(), { ignoreCase: true });
    const stores = createMemoryObjectStores();
    const refs = new MemoryRefs();
    const history = createSimpleHistory({ ...stores, refs });
    const worktree = createFileWorktree({
      files,
      rootPath: "/repo",
      gitDir: ".git",
      blobs: stores.blobs,
      trees: stores.trees,
    });
    const workingCopy = new MemoryWorkingCopy({
      history,
      checkout: new MemoryCheckout({ staging: new MemoryStagingStore() }),
      worktree,
      config: { "core.ignorecase": "true" },
    });
    await refs.setSymbolic("HEAD", "refs/heads/main");
    const git = Git.fromWorkingCopy(workingCopy);
    const write = (path: string, content: string) =>
      worktree.writeContent(path, new TextEncoder().encode(content), { createParents: true });
    const readText = async (path: string) => {
      const chunks: Uint8Array[] = [];
      for await (const c of worktree.readContent(path)) chunks.push(c);
      return new TextDecoder().decode(Buffer.concat(chunks));
    };
    // a tracked file whose name is the move-aside name in lower case
    await write("p~updated upstream", "TRACKED\n");
    await git.add().addFilepattern(".").call();
    await git.commit().setMessage("c1").call();
    // the stash adds p/x; then the index gets the file p
    await write("p/x", "px\n");
    await git.add().addFilepattern("p/x").call();
    expect(await git.stashCreate().call()).toBeDefined();
    await write("p", "index p\n");
    await git.add().addFilepattern("p").call();

    const result = await git.stashApply().call();
    expect(result.status).toBe("conflicts");
    expect(await readText("p~updated upstream")).toBe("TRACKED\n");
    expect(await readText("p~Updated upstream_0")).toBe("index p\n");
    expect(await readText("p/x")).toBe("px\n");
    const stages: string[] = [];
    for await (const e of workingCopy.checkout.staging.entries()) {
      stages.push(`${e.stage} ${e.path}`);
    }
    expect(stages).toEqual(["0 p/x", "2 p~Updated upstream_0", "0 p~updated upstream"]);
  });
});

/** Files (outside any `.git`), index and the newest stash's three trees of `dir`. */
function stashSnapshot(dir: string): string {
  const files = listing(dir)
    .filter((p) => !p.includes("/.git/") && !p.endsWith("/.git"))
    .map((p) => `${p}: ${read(join(dir, p))}`);
  const tree = (rev: string) => {
    try {
      return run(dir, "ls-tree", "-r", rev);
    } catch {
      return "<none>";
    }
  };
  const parents = (() => {
    try {
      return run(dir, "log", "-1", "--format=%P", "stash@{0}").split(" ");
    } catch {
      return [];
    }
  })();
  return [
    "FILES",
    ...files,
    "INDEX",
    run(dir, "ls-files", "-s"),
    "W",
    tree("stash@{0}"),
    "I",
    parents[1] ? tree(parents[1]) : "<none>",
    "U",
    parents[2] ? tree(parents[2]) : "<none>",
  ].join("\n");
}

/** A nested repository at `p` in `dir`, with one committed file. */
const nestedRepo = (dir: string, p: string) => {
  mkdirSync(join(dir, p), { recursive: true });
  run(join(dir, p), "init", "-q", "-b", "main");
  put(join(dir, p), "inner.txt", "precious\n");
  run(join(dir, p), "add", ".");
  run(join(dir, p), "commit", "-qm", "inner");
};

/**
 * `git stash push` (with `opts`) in `<name>-n` and ours in its twin `<name>-o`, both set up
 * by `setup`: the same files, index and stash trees, and both refuse or both succeed.
 */
async function twinStash(
  name: string,
  setup: (dir: string) => void,
  opts: { u?: boolean; a?: boolean; k?: boolean } = {},
) {
  const n = join(root, `${name}-n`);
  const o = join(root, `${name}-o`);
  repo(n);
  setup(n);
  cpSync(n, o, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  const args = ["stash", "push", "-q"];
  if (opts.a) args.push("-a");
  else if (opts.u) args.push("-u");
  if (opts.k) args.push("--keep-index");
  let nativeError = "";
  try {
    exec(n, ...args);
  } catch (e) {
    // git stash prints some refusals ("<path>: needs merge") on stdout
    const out = e as { stderr?: string; stdout?: string };
    nativeError = (out.stderr || out.stdout || String(e)).trim();
  }
  let ourError = "";
  try {
    const { ours } = await open(o);
    await ours
      .stashCreate()
      .setIncludeUntracked(!!opts.u || !!opts.a)
      .setIncludeIgnored(!!opts.a)
      .setKeepIndex(!!opts.k)
      .call();
  } catch (e) {
    ourError = (e as Error).message;
  }
  expect(ourError !== "", `ours: ${ourError} / native: ${nativeError}`).toBe(nativeError !== "");
  expect(stashSnapshot(o)).toBe(stashSnapshot(n));
  return { native: n, ours: o, nativeError, ourError };
}

describeGit("stash push twins against native git (review cases)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stash-twins-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("-u keeps an untracked nested repository next to stashed untracked files", async () => {
    const { ours } = await twinStash(
      "nested-u",
      (d) => {
        put(d, "x/a.txt", "u\n");
        nestedRepo(d, "x/sub");
      },
      { u: true },
    );
    expect(read(join(ours, "x/sub/inner.txt"))).toBe("precious\n");
    expect(existsSync(join(ours, "x/sub/.git"))).toBe(true);
  });

  it("a staged new file next to a nested repository: the repository stays", async () => {
    const { ours } = await twinStash("nested-staged-new", (d) => {
      put(d, "x/new.txt", "n\n");
      run(d, "add", "x/new.txt");
      nestedRepo(d, "x/sub");
    });
    expect(existsSync(join(ours, "x/sub/.git"))).toBe(true);
  });

  it("-a with an ignored directory holding a nested repository", async () => {
    const { ours } = await twinStash(
      "nested-ignored-a",
      (d) => {
        put(d, ".gitignore", "x/\n");
        run(d, "add", ".gitignore");
        run(d, "commit", "-qm", "ig");
        put(d, "x/a.log", "l\n");
        nestedRepo(d, "x/sub");
      },
      { a: true },
    );
    expect(existsSync(join(ours, "x/sub/.git"))).toBe(true);
  });

  it("-u with tracked files removed from a directory holding a nested repository", async () => {
    const { ours } = await twinStash(
      "tracked-deleted-dir-nested",
      (d) => {
        rmSync(join(d, "d/e.txt"));
        rmSync(join(d, "d/f.txt"));
        run(d, "rm", "-q", "--cached", "d/e.txt", "d/f.txt");
        nestedRepo(d, "d/sub");
        put(d, "d/u.txt", "u\n");
      },
      { u: true },
    );
    expect(existsSync(join(ours, "d/sub/.git"))).toBe(true);
  });

  it("more nested repositories, staged and unstaged, exec bits, links, keep-index", async () => {
    await twinStash(
      "nested-top-u",
      (d) => {
        put(d, "u.txt", "u\n");
        nestedRepo(d, "sub");
        put(d, "a.txt", "mod\n");
      },
      { u: true },
    );
    await twinStash("dir-with-tracked-and-nested", (d) => {
      put(d, "d/e.txt", "emod\n");
      rmSync(join(d, "d/f.txt"));
      nestedRepo(d, "d/sub");
      run(d, "rm", "-q", "--cached", "d/f.txt");
    });
    await twinStash("staged-and-unstaged", (d) => {
      put(d, "a.txt", "staged\n");
      run(d, "add", "a.txt");
      put(d, "a.txt", "unstaged\n");
    });
    await twinStash(
      "staged-and-unstaged-k",
      (d) => {
        put(d, "a.txt", "staged\n");
        run(d, "add", "a.txt");
        put(d, "a.txt", "unstaged\n");
        put(d, "b.txt", "bmod\n");
      },
      { k: true },
    );
    await twinStash(
      "k-del-new",
      (d) => {
        run(d, "rm", "-q", "b.txt");
        put(d, "n.txt", "n\n");
        run(d, "add", "n.txt");
        put(d, "n.txt", "n edited\n");
        put(d, "c.txt", "cm\n");
      },
      { k: true },
    );
    await twinStash(
      "k-u",
      (d) => {
        put(d, "a.txt", "s\n");
        run(d, "add", "a.txt");
        put(d, "u.txt", "u\n");
        put(d, "b.txt", "bm\n");
      },
      { k: true, u: true },
    );
    await twinStash("exec-bit", (d) => chmodSync(join(d, "a.txt"), 0o755));
    await twinStash("exec-staged-content-unstaged", (d) => {
      chmodSync(join(d, "a.txt"), 0o755);
      run(d, "add", "a.txt");
      put(d, "a.txt", "changed\n");
    });
    await twinStash("filemode-false", (d) => {
      run(d, "config", "core.filemode", "false");
      chmodSync(join(d, "a.txt"), 0o755);
      put(d, "b.txt", "bm\n");
    });
    await twinStash("link-retarget", (d) => {
      symlinkSync("a.txt", join(d, "l"));
      run(d, "add", "l");
      run(d, "commit", "-qm", "l");
      rmSync(join(d, "l"));
      symlinkSync("b.txt", join(d, "l"));
    });
  });

  it("a tracked file replaced by a link to a directory outside: nothing outside touched", async () => {
    const outside = join(root, "outside-1");
    mkdirSync(outside, { recursive: true });
    put(root, "outside-1/keep.txt", "keep\n");
    await twinStash("symlink-typechange", (d) => {
      rmSync(join(d, "a.txt"));
      symlinkSync(outside, join(d, "a.txt"));
    });
    expect(listing(outside)).toEqual(["keep.txt"]);
    expect(read(join(outside, "keep.txt"))).toBe("keep\n");
  });

  it("a tracked directory replaced by a link: refused as git, nothing changed", async () => {
    const outside = join(root, "outside-2");
    mkdirSync(outside, { recursive: true });
    put(root, "outside-2/e.txt", "outside e\n");
    const { ourError, nativeError } = await twinStash("dir-replaced-by-link", (d) => {
      rmSync(join(d, "d"), { recursive: true });
      symlinkSync(outside, join(d, "d"));
    });
    // native git ran with -q: our message also has git's last line
    expect(ourError).toBe(`${nativeError}\nCannot save the current worktree state`);
    expect(listing(outside)).toEqual(["e.txt"]);
    expect(read(join(outside, "e.txt"))).toBe("outside e\n");
  });

  it("an untracked link to a directory with -u: the link goes, its target stays", async () => {
    const outside = join(root, "outside-3");
    mkdirSync(outside, { recursive: true });
    put(root, "outside-3/f.txt", "f\n");
    await twinStash(
      "untracked-link-u",
      (d) => {
        symlinkSync(outside, join(d, "lnk"));
        put(d, "a.txt", "m\n");
      },
      { u: true },
    );
    expect(listing(outside)).toEqual(["f.txt"]);
  });

  it("ignored files: -u keeps them, -a stashes them; ignored dirs with tracked files", async () => {
    const ignores = (d: string) => {
      put(d, ".gitignore", "*.log\nbuild/\n");
      run(d, "add", ".gitignore");
      run(d, "commit", "-qm", "ig");
      put(d, "x.log", "l\n");
      put(d, "build/o", "o\n");
      put(d, "d/u.txt", "u\n");
    };
    await twinStash("ignored-u", ignores, { u: true });
    await twinStash("ignored-a", ignores, { a: true });
    await twinStash(
      "ignored-dir-with-tracked-u",
      (d) => {
        put(d, ".gitignore", "d/\n");
        run(d, "add", ".gitignore");
        run(d, "commit", "-qm", "ig");
        put(d, "d/x.o", "o\n");
        put(d, "d/e.txt", "em\n");
      },
      { u: true },
    );
  });

  it("-u removes empty untracked directories, as git clean -d", async () => {
    await twinStash(
      "empty-dirs-u",
      (d) => {
        mkdirSync(join(d, "empty/deeper"), { recursive: true });
        put(d, "u/v.txt", "v\n");
      },
      { u: true },
    );
  });

  it("a tracked file replaced by a directory, a staged new file deleted from disk", async () => {
    await twinStash("file-to-dir", (d) => {
      rmSync(join(d, "a.txt"));
      put(d, "a.txt/inner", "untracked inside\n");
      put(d, "b.txt", "bm\n");
    });
    await twinStash(
      "file-to-dir-u",
      (d) => {
        rmSync(join(d, "a.txt"));
        put(d, "a.txt/inner", "untracked inside\n");
      },
      { u: true },
    );
    await twinStash("staged-new-deleted-wt", (d) => {
      put(d, "n.txt", "n\n");
      run(d, "add", "n.txt");
      rmSync(join(d, "n.txt"));
    });
  });

  it("git rm --cached, intent-to-add, untracked only, unmerged, racy", async () => {
    await twinStash(
      "rm-cached-u",
      (d) => {
        run(d, "rm", "-q", "--cached", "a.txt");
        put(d, "a.txt", "edited\n");
      },
      { u: true },
    );
    await twinStash("rm-cached", (d) => {
      run(d, "rm", "-q", "--cached", "a.txt");
      put(d, "a.txt", "edited\n");
    });
    const ita = await twinStash("ita", (d) => {
      put(d, "n.txt", "n\n");
      run(d, "add", "-N", "n.txt");
    });
    expect(ita.ourError).toBe(`${ita.nativeError}\nCannot save the current worktree state`);
    await twinStash("only-untracked-noflag", (d) => put(d, "u.txt", "u\n"));
    await twinStash(
      "unmerged",
      (d) => {
        run(d, "checkout", "-qb", "side");
        put(d, "a.txt", "side\n");
        run(d, "commit", "-qam", "side");
        run(d, "checkout", "-q", "main");
        put(d, "a.txt", "main\n");
        run(d, "commit", "-qam", "main");
        try {
          exec(d, "merge", "-q", "side");
        } catch {
          // conflict expected
        }
        put(d, "b.txt", "bm\n");
        put(d, "u.txt", "u\n");
      },
      { u: true },
    );
    await twinStash("same-size-racy", (d) => {
      const when = new Date(Math.floor(Date.now() / 1000) * 1000 - 60_000);
      utimesSync(join(d, "a.txt"), when, when);
      run(d, "add", "a.txt");
      utimesSync(join(d, ".git/index"), when, when);
      put(d, "a.txt", "A\n");
      utimesSync(join(d, "a.txt"), when, when);
    });
  });

  it("stash create (no ref) saves the stash and changes nothing", async () => {
    const dir = join(root, "r");
    repo(dir);
    put(dir, "a.txt", "changed\n");
    const { ours } = await open(dir);
    const id = await ours.stashCreate().setRef(null).call();
    expect(id).toBeDefined();
    expect(read(join(dir, "a.txt"))).toBe("changed\n");
    expect(run(dir, "status", "--porcelain")).toBe("M a.txt");
    expect(run(dir, "cat-file", "-p", `${id}:a.txt`)).toBe("changed");
  });

  it("checkout keeps an untracked nested repository in a directory it empties", async () => {
    const dir = join(root, "co");
    repo(dir);
    run(dir, "branch", "other");
    put(dir, "x/t.txt", "t\n");
    run(dir, "add", ".");
    run(dir, "commit", "-qm", "x");
    nestedRepo(dir, "x/sub");
    const native = `${dir}-native`;
    cpSync(dir, native, { recursive: true, verbatimSymlinks: true });
    run(native, "checkout", "-q", "other");
    const { ours } = await open(dir);
    await ours.checkout().setName("other").call();
    expect(existsSync(join(dir, "x/sub/.git"))).toBe(true);
    expect(read(join(dir, "x/sub/inner.txt"))).toBe("precious\n");
    expect(listing(dir).filter((p) => !p.includes(".git"))).toEqual(
      listing(native).filter((p) => !p.includes(".git")),
    );
  });

  it("stash apply keeps an untracked nested repository in a directory it empties", async () => {
    const dir = join(root, "ap");
    repo(dir);
    run(dir, "rm", "-q", "d/e.txt", "d/f.txt");
    run(dir, "stash", "-q");
    nestedRepo(dir, "d/sub");
    const native = `${dir}-native`;
    cpSync(dir, native, { recursive: true, verbatimSymlinks: true });
    run(native, "stash", "apply", "-q");
    const { ours } = await open(dir);
    await ours.stashApply().call();
    expect(existsSync(join(dir, "d/sub/.git"))).toBe(true);
    expect(listing(dir).filter((p) => !p.includes(".git"))).toEqual(
      listing(native).filter((p) => !p.includes(".git")),
    );
    expect(run(dir, "ls-files", "-s")).toBe(run(native, "ls-files", "-s"));
  });
});

describeGit("status against native git (review cases)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "status-review-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const at = (name: string, setup: (d: string) => void) => {
    const d = join(root, name);
    repo(d);
    setup(d);
    return d;
  };

  it("intent-to-add entries, present and deleted (v1 and v2)", async () => {
    await expectStatusAsNative(
      at("ita", (d) => {
        put(d, "n.txt", "n\n");
        run(d, "add", "-N", "n.txt");
      }),
    );
    await expectStatusAsNative(
      at("ita-deleted", (d) => {
        put(d, "n.txt", "n\n");
        run(d, "add", "-N", "n.txt");
        rmSync(join(d, "n.txt"));
      }),
    );
  });

  it("a submodule moved to another commit (its dirty content is not inspected)", async () => {
    const sub = (d: string) => {
      nestedRepo(d, "sub");
      run(d, "add", "sub");
      run(d, "commit", "-qm", "sub");
    };
    await expectStatusAsNative(
      at("submodule-moved", (d) => {
        sub(d);
        put(join(d, "sub"), "inner.txt", "changed\n");
        run(join(d, "sub"), "commit", "-qam", "x");
      }),
    );
    // a submodule whose own worktree is dirty: git reports ` M sub` (`S.M.` / `S..U`); we
    // do not read the submodule's index, so it is clean here
    const dirty = at("submodule-dirty", (d) => {
      sub(d);
      put(join(d, "sub"), "inner.txt", "changed\n");
    });
    const { ours } = await open(dirty);
    expect(formatStatusPorcelain(await ours.status().call())).toBe("");
  });

  it("deleted by both (DD), ignored directory files, quoted paths", async () => {
    await expectStatusAsNative(
      at("unmerged-dd", (d) => {
        run(d, "checkout", "-qb", "side");
        run(d, "mv", "a.txt", "side.txt");
        run(d, "commit", "-qm", "side");
        run(d, "checkout", "-q", "main");
        run(d, "mv", "a.txt", "main.txt");
        run(d, "commit", "-qm", "main");
        try {
          exec(d, "merge", "-q", "side");
        } catch {
          // conflict expected
        }
      }),
    );
    await expectStatusAsNative(
      at("ignored-dir", (d) => {
        put(d, ".gitignore", "build/\n");
        put(d, "build/a/b.o", "o\n");
        put(d, "build/c.o", "o\n");
      }),
      true,
    );
    await expectStatusAsNative(
      at("quoted", (d) => {
        put(d, "sp ace.txt", "x");
        put(d, "tab\tx", "x");
        put(d, "ü.txt", "x");
        put(d, 'q"uote', "x");
        put(d, "a.txt", "mod\n");
        run(d, "mv", "b.txt", "b c.txt");
      }),
    );
  });

  it("a file replaced by a directory and a directory by a file; after our mixed reset", async () => {
    await expectStatusAsNative(
      at("typechange-dir", (d) => {
        rmSync(join(d, "a.txt"));
        put(d, "a.txt/x", "x\n");
      }),
    );
    await expectStatusAsNative(
      at("file-in-place-of-dir", (d) => {
        rmSync(join(d, "d"), { recursive: true });
        put(d, "d", "file\n");
      }),
    );
    const d = at("after-mixed-reset", (dir) => put(dir, "a.txt", "AX\n"));
    const { ours } = await open(d);
    await ours.reset().setRef("HEAD").call();
    await expectStatusAsNative(d);
  });
});

describeGit("status and stash refresh the index (review cases)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "refresh-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("files proved clean by hashing get their stat: the next status reads none", async () => {
    const dir = join(root, "r");
    repo(dir);
    // our mixed reset leaves every entry without a stat
    const { ours: resetter } = await open(dir);
    await resetter.reset().setRef("HEAD").call();
    const first = await open(dir);
    const hashedFirst = vi.spyOn(first.worktree, "computeHash");
    expect((await first.ours.status().call()).isClean()).toBe(true);
    expect(hashedFirst).toHaveBeenCalledTimes(5);
    const second = await open(dir);
    const hashedSecond = vi.spyOn(second.worktree, "computeHash");
    expect((await second.ours.status().call()).isClean()).toBe(true);
    expect(hashedSecond).not.toHaveBeenCalled();
    // native git reads the refreshed index as clean too, its stats included (diff-files
    // trusts them without refreshing)
    expect(nativeStatus(dir, 1)).toBe("");
    expect(run(dir, "diff-files", "--name-only")).toBe("");
    run(dir, "ls-files", "--debug");
  });

  it("stash push compares each file once and leaves an index the next status trusts", async () => {
    const dir = join(root, "r");
    repo(dir);
    const { ours: resetter } = await open(dir);
    await resetter.reset().setRef("HEAD").call();
    put(dir, "a.txt", "dirty\n");
    const stasher = await open(dir);
    const hashed = vi.spyOn(stasher.worktree, "computeHash");
    expect(await stasher.ours.stashCreate().call()).toBeDefined();
    // one comparison per tracked file (no stat after the reset: each is hashed once)
    expect(hashed).toHaveBeenCalledTimes(5);
    const after = await open(dir);
    const hashedAfter = vi.spyOn(after.worktree, "computeHash");
    expect((await after.ours.status().call()).isClean()).toBe(true);
    expect(hashedAfter).not.toHaveBeenCalled();
  });
});

/**
 * `git clean` with `flags` in `<name>-n` and our CleanCommand in its twin: the same
 * "Would remove" / "Would skip repository" lists (dry run), then the same files after
 * the real clean.
 */
async function twinClean(
  name: string,
  setup: (dir: string) => void,
  flags: { d?: boolean; x?: boolean; ff?: boolean; paths?: string[] } = {},
) {
  const n = join(root, `${name}-n`);
  const o = join(root, `${name}-o`);
  repo(n);
  setup(n);
  cpSync(n, o, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  const args = ["clean", flags.ff ? "-ff" : "-f"];
  if (flags.d) args.push("-d");
  if (flags.x) args.push("-x");
  const paths = flags.paths ? ["--", ...flags.paths] : [];
  const lines = exec(n, ...args, "-n", ...paths)
    .split("\n")
    .filter(Boolean);
  const nativeRemove = lines
    .filter((l) => l.startsWith("Would remove "))
    .map((l) => l.slice("Would remove ".length))
    .sort();
  const nativeSkip = lines
    .filter((l) => l.startsWith("Would skip repository "))
    .map((l) => l.slice("Would skip repository ".length))
    .sort();
  const command = async (dryRun: boolean) => {
    const { ours } = await open(o);
    return ours
      .clean()
      .setCleanDirectories(flags.d === true)
      .setIgnore(flags.x !== true)
      .setForceNestedRepositories(flags.ff === true)
      .setPaths(new Set(flags.paths ?? []))
      .setDryRun(dryRun)
      .call();
  };
  const dry = await command(true);
  expect([...dry.cleaned].sort(), "would remove").toEqual(nativeRemove);
  expect([...dry.skipped].sort(), "would skip").toEqual(nativeSkip);
  exec(n, ...args, "-q", ...paths);
  await command(false);
  expect(listing(o)).toEqual(listing(n));
  expect(run(o, "ls-files", "-s")).toBe(run(n, "ls-files", "-s"));
  return { native: n, ours: o };
}

describeGit("clean against native git (review cases)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "clean-twins-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("-d: an untracked file next to tracked files goes, the tracked directory stays", async () => {
    const { ours } = await twinClean("tracked-dir", (d) => put(d, "d/u.txt", "u\n"), { d: true });
    expect(read(join(ours, "d/e.txt"))).toBe("e\n");
  });

  it("-d: a staged new file and its directory stay", async () => {
    const { ours } = await twinClean(
      "staged-new-dir",
      (d) => {
        put(d, "n/new.txt", "n\n");
        run(d, "add", "n/new.txt");
        put(d, "n/u.txt", "u\n");
      },
      { d: true },
    );
    expect(read(join(ours, "n/new.txt"))).toBe("n\n");
  });

  it("-d: nested repositories are skipped (top level and inside an untracked dir)", async () => {
    const { ours } = await twinClean(
      "nested",
      (d) => {
        put(d, "u/x.txt", "x\n");
        nestedRepo(d, "u/sub");
        nestedRepo(d, "sub");
      },
      { d: true },
    );
    expect(read(join(ours, "sub/inner.txt"))).toBe("precious\n");
    expect(read(join(ours, "u/sub/inner.txt"))).toBe("precious\n");
  });

  it("-ffd removes nested repositories", async () => {
    await twinClean(
      "nested-ff",
      (d) => {
        put(d, "u/x.txt", "x\n");
        nestedRepo(d, "u/sub");
        nestedRepo(d, "sub");
      },
      { d: true, ff: true },
    );
  });

  it("-d keeps ignored files (and their directories); -dx removes them", async () => {
    const setup = (d: string) => {
      put(d, ".gitignore", "*.log\nbuild/\n");
      run(d, "add", ".");
      run(d, "commit", "-qm", "i");
      put(d, "u/x.txt", "x\n");
      put(d, "u/keep.log", "precious\n");
      put(d, "build/o/p.o", "o\n");
      put(d, "top.log", "log\n");
      put(d, "w/v.txt", "v\n");
      mkdirSync(join(d, "empty/deeper"), { recursive: true });
    };
    const { ours } = await twinClean("ignored", setup, { d: true });
    expect(read(join(ours, "u/keep.log"))).toBe("precious\n");
    await twinClean("ignored-x", setup, { d: true, x: true });
  });

  it("without -d untracked directories are not entered; a path filter enters them", async () => {
    const setup = (d: string) => {
      put(d, "u/x.txt", "x\n");
      put(d, "d/u.txt", "u\n");
      put(d, "top.txt", "t\n");
    };
    await twinClean("no-d", setup);
    await twinClean("no-d-path", setup, { paths: ["d"] });
    await twinClean("d-path", setup, { d: true, paths: ["u"] });
  });
});

describeGit("index refresh is compare-and-set (review cases)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "refresh-cas-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** A repository whose files' stats no longer match the index (status must hash them). */
  function staleRepo(dir: string) {
    repo(dir);
    const when = new Date(Date.now() - 100_000);
    for (const f of ["a.txt", "b.txt", "c.txt", "d/e.txt", "d/f.txt"]) {
      utimesSync(join(dir, f), when, when);
    }
  }

  it("an add made while status hashes is not undone by the refresh", async () => {
    const dir = join(root, "r");
    staleRepo(dir);
    const { ours, worktree } = await open(dir);
    const hash = worktree.computeHash.bind(worktree);
    let added = "";
    vi.spyOn(worktree, "computeHash").mockImplementation(async (path: string) => {
      const id = await hash(path);
      if (path === "c.txt" && !added) {
        put(dir, "a.txt", "STAGED BY OUR ADD\n");
        await ours.add().addFilepattern("a.txt").call();
        added = run(dir, "ls-files", "-s", "a.txt");
      }
      return id;
    });
    await ours.status().call();
    expect(added).toContain("a.txt");
    expect(run(dir, "ls-files", "-s", "a.txt")).toBe(added);
    expect(run(dir, "status", "--porcelain")).toBe("M  a.txt");
  });

  it("keeps the assume-unchanged flag (status and stash), as native git", async () => {
    const dir = join(root, "r");
    staleRepo(dir);
    run(dir, "update-index", "--assume-unchanged", "b.txt");
    put(dir, "a.txt", "am\n");
    const native = `${dir}-native`;
    cpSync(dir, native, { recursive: true, preserveTimestamps: true });
    exec(native, "stash", "push", "-q");
    const { ours } = await open(dir);
    await ours.status().call();
    expect(run(dir, "ls-files", "-v", "b.txt")).toBe("h b.txt");
    const { ours: stasher } = await open(dir);
    await stasher.stashCreate().call();
    expect(run(dir, "ls-files", "-v")).toBe(run(native, "ls-files", "-v"));
  });

  it("does not write in-memory edits made before the status, only stats", async () => {
    const dir = join(root, "r");
    staleRepo(dir);
    const { ours, wc } = await open(dir);
    const id = await wc.history.blobs.store([new TextEncoder().encode("unsaved\n")]);
    const editor = wc.checkout.staging.createEditor();
    editor.upsert({ path: "unsaved.txt", objectId: id, mode: 0o100644, size: 8, mtime: 1 });
    await editor.finish();
    await ours.status().call();
    // the refresh reached the disk, the unsaved entry did not
    expect(run(dir, "ls-files", "unsaved.txt")).toBe("");
    expect(run(dir, "diff-files", "--name-only")).toBe("");
    expect(await wc.checkout.staging.getEntry("unsaved.txt")).toBeDefined();
  });

  it("records the exact stat (nanoseconds, inode, owner) so native git trusts it", async () => {
    const dir = join(root, "r");
    staleRepo(dir);
    put(dir, "c.txt", "c\n"); // a fresh mtime with nanoseconds
    utimesSync(join(dir, "c.txt"), new Date(Date.now() - 50_000), new Date(Date.now() - 50_000));
    const { ours } = await open(dir);
    await ours.status().call();
    const debug = run(dir, "ls-files", "--debug", "c.txt");
    const stat = lstatSync(join(dir, "c.txt"), { bigint: true });
    const sec = stat.mtimeNs / 1_000_000_000n;
    const nsec = stat.mtimeNs % 1_000_000_000n;
    expect(debug).toContain(`mtime: ${sec}:${nsec}`);
    expect(debug).toContain(`ino: ${stat.ino & 0xffffffffn}`);
    expect(debug).toContain(`uid: ${stat.uid}\tgid: ${stat.gid}`);
    expect(run(dir, "diff-files", "--name-only")).toBe("");
  });

  it("an index changed on disk (same mtime) is outdated; the refresh then writes nothing", async () => {
    const dir = join(root, "r");
    staleRepo(dir);
    const { ours, wc } = await open(dir);
    const before = statSync(join(dir, ".git/index"));
    put(dir, "n.txt", "n\n");
    run(dir, "add", "n.txt");
    utimesSync(join(dir, ".git/index"), before.atime, before.mtime);
    expect(await wc.checkout.staging.isOutdated()).toBe(true);
    const after = readFileSync(join(dir, ".git/index"));
    await ours.status().call();
    expect(readFileSync(join(dir, ".git/index")).equals(after)).toBe(true);
  });

  it("a refresh that cannot take index.lock leaves the index and memory as they were", async () => {
    const dir = join(root, "r");
    staleRepo(dir);
    writeFileSync(join(dir, ".git/index.lock"), "");
    const { ours, wc } = await open(dir);
    const before = await wc.checkout.staging.getEntry("a.txt");
    const status = await ours.status().call();
    expect(status.isClean()).toBe(true);
    expect(await wc.checkout.staging.getEntry("a.txt")).toEqual(before);
    rmSync(join(dir, ".git/index.lock"));
  });
});

describeGit("submodules (review cases)", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "submodule-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a submodule added by git (gitdir: ../.git/modules/sub) moved to another commit", async () => {
    const dir = join(root, "r");
    repo(dir);
    const upstream = join(root, "up");
    repo(upstream);
    exec(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", upstream, "sub");
    run(dir, "commit", "-qm", "sub");
    expect(readFileSync(join(dir, "sub/.git"), "utf8")).toContain("gitdir: ../.git/modules/sub");
    await expectStatusAsNative(dir);
    put(join(dir, "sub"), "a.txt", "changed\n");
    run(join(dir, "sub"), "commit", "-qam", "x");
    const status = await expectStatusAsNative(dir);
    expect(status.modified).toEqual(new Set(["sub"]));
  });

  it("a FIFO where a submodule's HEAD should be is not read", async () => {
    const dir = join(root, "r");
    repo(dir);
    nestedRepo(dir, "sub");
    run(dir, "add", "sub");
    run(dir, "commit", "-qm", "sub");
    rmSync(join(dir, "sub/.git/HEAD"));
    execFileSync("mkfifo", [join(dir, "sub/.git/HEAD")]);
    const { ours } = await open(dir);
    const status = await ours.status().call();
    expect(status.modified.has("sub")).toBe(false);
  }, 10_000);

  it("a gitdir: pointing above the repository's root is not followed", async () => {
    const dir = join(root, "r");
    repo(dir);
    nestedRepo(dir, "sub");
    run(dir, "add", "sub");
    run(dir, "commit", "-qm", "sub");
    rmSync(join(dir, "sub/.git"), { recursive: true });
    writeFileSync(join(dir, "sub/.git"), "gitdir: ../../outside\n");
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside/HEAD"), `${"ab".repeat(20)}\n`);
    const { ours } = await open(dir);
    expect((await ours.status().call()).modified.has("sub")).toBe(false);
  });
});

describe("removing an empty directory never removes what is in it", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rmdir-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("PosixFilesApi.rmdir and FileWorktree.removeEmptyDirectory refuse a non-empty one", async () => {
    mkdirSync(join(root, "d/e"), { recursive: true });
    writeFileSync(join(root, "d/e/f"), "f\n");
    mkdirSync(join(root, "empty"));
    const files = createNodeFilesApi({ rootDir: root });
    expect(await files.rmdir?.("/d/e")).toBe(false);
    expect(readFileSync(join(root, "d/e/f"), "utf8")).toBe("f\n");
    expect(await files.rmdir?.("/d/e/f")).toBe(false);
    const { history } = await createGitFilesBackend({ files, create: true });
    const worktree = createFileWorktree({
      files,
      rootPath: "",
      gitDir: ".git",
      blobs: history.blobs,
      trees: history.trees,
    });
    expect(await worktree.removeEmptyDirectory?.("d")).toBe(false);
    expect(existsSync(join(root, "d/e/f"))).toBe(true);
    expect(await worktree.removeEmptyDirectory?.("empty")).toBe(true);
    expect(existsSync(join(root, "empty"))).toBe(false);
  });
});
