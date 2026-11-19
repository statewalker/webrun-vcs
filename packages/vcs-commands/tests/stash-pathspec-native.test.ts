/**
 * `git stash push -- <pathspec>` and `git stash push --staged` against native git: one copy
 * stashed by native git, its twin by our StashCreateCommand, then the files, the index, the
 * stash's trees and messages, `stash list`, ORIG_HEAD and HEAD's reflog compared.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git, NoStagedChangesError } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

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
const tryRun = (cwd: string, ...args: string[]) => {
  try {
    return run(cwd, ...args);
  } catch {
    return "<none>";
  }
};
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
  return Git.fromWorkingCopy(wc);
}

/** A repository with a few committed files on main. */
function repo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  run(dir, "init", "-q", "-b", "main");
  put(dir, "a.txt", "a\n");
  put(dir, "b.txt", "b\n");
  put(dir, "c.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n");
  put(dir, "d/e.txt", "e\n");
  put(dir, "d/f.txt", "f\n");
  run(dir, "add", ".");
  run(dir, "commit", "-q", "-m", "c1");
}

/**
 * The files, the index, the newest stash's trees and messages, `stash list`, ORIG_HEAD and
 * HEAD's last reflog entry of `dir`.
 */
function snapshot(dir: string): string {
  const files = listing(dir).map((p) => `${p}: ${read(join(dir, p))}`);
  const parents = tryRun(dir, "log", "-1", "--format=%P", "stash@{0}").split(" ");
  return [
    "FILES",
    ...files,
    "INDEX",
    run(dir, "ls-files", "-s"),
    "STATUS",
    run(dir, "status", "--porcelain=v1", "--untracked-files=all"),
    "W",
    tryRun(dir, "ls-tree", "-r", "stash@{0}"),
    "I",
    parents[1] ? tryRun(dir, "ls-tree", "-r", parents[1]) : "<none>",
    "U",
    parents[2] ? tryRun(dir, "ls-tree", "-r", parents[2]) : "<none>",
    "MESSAGES",
    tryRun(dir, "log", "-1", "--format=%s", "stash@{0}"),
    parents[1] ? tryRun(dir, "log", "-1", "--format=%s", parents[1]) : "<none>",
    "LIST",
    tryRun(dir, "stash", "list"),
    "SHOW",
    tryRun(dir, "stash", "show", "--stat"),
    "ORIG_HEAD",
    tryRun(dir, "rev-parse", "-q", "--verify", "ORIG_HEAD"),
    "REFLOG",
    tryRun(dir, "reflog", "-1", "--format=%gs", "HEAD"),
  ].join("\n");
}

interface StashOptions {
  u?: boolean;
  a?: boolean;
  k?: boolean;
  staged?: boolean;
  paths?: string[];
}

/**
 * `git stash push` (with `opts`) in `<name>-n` and ours in its twin `<name>-o`, both set up
 * by `setup`: both refuse or both succeed, and leave the same state.
 */
async function twinStash(name: string, setup: (dir: string) => void, opts: StashOptions = {}) {
  const n = join(root, `${name}-n`);
  const o = join(root, `${name}-o`);
  repo(n);
  setup(n);
  cpSync(n, o, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
  const args = ["stash", "push", "-q"];
  if (opts.a) args.push("-a");
  else if (opts.u) args.push("-u");
  if (opts.k) args.push("--keep-index");
  if (opts.staged) args.push("--staged");
  if (opts.paths) args.push("--", ...opts.paths);
  let nativeError = "";
  try {
    exec(n, ...args);
  } catch (e) {
    const out = e as { stderr?: string; stdout?: string };
    nativeError = (out.stderr || out.stdout || String(e)).trim();
  }
  let ourError = "";
  let ourException: unknown;
  try {
    const ours = await open(o);
    const command = ours
      .stashCreate()
      .setIncludeUntracked(!!opts.u || !!opts.a)
      .setIncludeIgnored(!!opts.a)
      .setKeepIndex(!!opts.k)
      .setStaged(!!opts.staged);
    for (const path of opts.paths ?? []) command.addPath(path);
    await command.call();
  } catch (e) {
    ourException = e;
    ourError = (e as Error).message;
  }
  expect(ourError !== "", `ours: ${ourError} / native: ${nativeError}`).toBe(nativeError !== "");
  expect(snapshot(o)).toBe(snapshot(n));
  return { native: n, ours: o, nativeError, ourError, ourException };
}

describeGit("stash push -- <pathspec> against native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stash-pathspec-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("stashes and resets only the named file; ORIG_HEAD is not written", async () => {
    const { ours } = await twinStash(
      "one-file",
      (d) => {
        put(d, "a.txt", "a changed\n");
        put(d, "d/e.txt", "e changed\n");
      },
      { paths: ["a.txt"] },
    );
    expect(read(join(ours, "a.txt"))).toBe("a\n");
    expect(read(join(ours, "d/e.txt"))).toBe("e changed\n");
  });

  it("a directory: staged and unstaged changes under it, others kept", async () => {
    await twinStash(
      "dir",
      (d) => {
        put(d, "d/e.txt", "e staged\n");
        run(d, "add", "d/e.txt");
        put(d, "d/e.txt", "e staged then edited\n");
        put(d, "d/f.txt", "f unstaged\n");
        put(d, "a.txt", "a staged\n");
        run(d, "add", "a.txt");
        put(d, "b.txt", "b unstaged\n");
      },
      { paths: ["d"] },
    );
  });

  it("a deleted file and a staged new file named by the pathspec", async () => {
    const { ours } = await twinStash(
      "deleted-new",
      (d) => {
        rmSync(join(d, "b.txt"));
        put(d, "n/new.txt", "new\n");
        run(d, "add", "n/new.txt");
        put(d, "a.txt", "a kept\n");
      },
      { paths: ["b.txt", "n"] },
    );
    expect(read(join(ours, "b.txt"))).toBe("b\n");
    expect(existsSync(join(ours, "n"))).toBe(false);
  });

  it("glob and exclude elements", async () => {
    await twinStash(
      "glob",
      (d) => {
        put(d, "a.txt", "a changed\n");
        put(d, "b.txt", "b changed\n");
        put(d, "d/e.txt", "e changed\n");
      },
      { paths: [":(glob)*.txt", ":(exclude)b.txt"] },
    );
  });

  it("-u: the untracked files the pathspec matches are stashed and removed", async () => {
    const { ours } = await twinStash(
      "untracked",
      (d) => {
        put(d, "d/u1.txt", "u1\n");
        put(d, "d/deep/u3.txt", "u3\n");
        put(d, "u2.txt", "u2\n");
        put(d, "d/f.txt", "f changed\n");
      },
      { u: true, paths: ["d"] },
    );
    expect(read(join(ours, "u2.txt"))).toBe("u2\n");
    expect(existsSync(join(ours, "d/deep"))).toBe(false);
  });

  it("--keep-index with a pathspec checks the index out again for those paths", async () => {
    await twinStash(
      "keep-index",
      (d) => {
        put(d, "a.txt", "a staged\n");
        run(d, "add", "a.txt");
        put(d, "a.txt", "a staged then edited\n");
        put(d, "b.txt", "b staged\n");
        run(d, "add", "b.txt");
        put(d, "b.txt", "b staged then edited\n");
      },
      { k: true, paths: ["a.txt"] },
    );
  });

  it("an element that matches nothing tracked is refused before anything changes", async () => {
    const { ourError } = await twinStash(
      "no-match",
      (d) => {
        put(d, "a.txt", "a changed\n");
        put(d, "u.txt", "untracked\n");
      },
      { paths: ["a.txt", "u.txt"] },
    );
    expect(ourError).toContain("error: pathspec 'u.txt' did not match any file(s) known to git");
    expect(ourError).toContain("Did you forget to 'git add'?");
  });

  it("nothing to stash among the named paths: no stash, nothing changes", async () => {
    await twinStash(
      "nothing",
      (d) => {
        put(d, "a.txt", "a changed\n");
      },
      { paths: ["b.txt"] },
    );
  });
});

describeGit("stash push --staged against native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stash-staged-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("stashes the staged changes alone; unstaged ones stay in the worktree", async () => {
    const { ours } = await twinStash(
      "staged",
      (d) => {
        put(d, "a.txt", "a staged\n");
        run(d, "add", "a.txt");
        put(d, "b.txt", "b unstaged\n");
      },
      { staged: true },
    );
    expect(read(join(ours, "a.txt"))).toBe("a\n");
    expect(read(join(ours, "b.txt"))).toBe("b unstaged\n");
  });

  it("a staged new file and a staged deletion", async () => {
    await twinStash(
      "staged-add-rm",
      (d) => {
        put(d, "n.txt", "new\n");
        run(d, "add", "n.txt");
        run(d, "rm", "-q", "b.txt");
      },
      { staged: true },
    );
  });

  it("an unstaged edit next to the staged one in the same file is kept", async () => {
    await twinStash(
      "staged-same-file",
      (d) => {
        put(d, "c.txt", "ONE\n2\n3\n4\n5\n6\n7\n8\n9\n");
        run(d, "add", "c.txt");
        put(d, "c.txt", "ONE\n2\n3\n4\n5\n6\n7\n8\nNINE\n");
      },
      { staged: true },
    );
  });

  it("with --keep-index the index keeps the staged changes", async () => {
    await twinStash(
      "staged-keep",
      (d) => {
        put(d, "a.txt", "a staged\n");
        run(d, "add", "a.txt");
      },
      { staged: true, k: true },
    );
  });

  it("with a pathspec the stash takes every staged change, the index resets the named paths", async () => {
    await twinStash(
      "staged-pathspec",
      (d) => {
        put(d, "a.txt", "a staged\n");
        put(d, "d/e.txt", "e staged\n");
        run(d, "add", "a.txt", "d/e.txt");
      },
      { staged: true, paths: ["a.txt"] },
    );
  });

  it("nothing staged: refused with git's message, no stash", async () => {
    const { ourException } = await twinStash(
      "staged-none",
      (d) => {
        put(d, "a.txt", "a unstaged\n");
      },
      { staged: true },
    );
    expect(ourException).toBeInstanceOf(NoStagedChangesError);
  });

  it("an unstaged edit over the staged lines: the stash is kept, the worktree cannot be reverted", async () => {
    const { ourException } = await twinStash(
      "staged-conflict",
      (d) => {
        put(d, "a.txt", "a staged\n");
        run(d, "add", "a.txt");
        put(d, "a.txt", "a staged then edited\n");
      },
      { staged: true },
    );
    expect((ourException as Error).message).toContain("Cannot remove worktree changes");
  });

  it("refused together with --include-untracked", async () => {
    const { ourError } = await twinStash(
      "staged-u",
      (d) => {
        put(d, "a.txt", "a staged\n");
        run(d, "add", "a.txt");
      },
      { staged: true, u: true },
    );
    expect(ourError).toContain("Can't use --staged and --include-untracked");
  });
});
