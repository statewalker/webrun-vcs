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
