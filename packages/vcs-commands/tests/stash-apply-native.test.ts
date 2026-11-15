/**
 * `stash apply` against native `git stash apply`: the same repository (a stash made by
 * native git) applied by native git in one copy and by ours in a twin copy, then the
 * outcome (refusal message, status, index, file contents) compared. Also checkout and
 * the worktree's ignore rules read fresh as native git reads them.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
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

import { Git } from "../src/index.js";
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
/** Native git's outcome: ok, or its stderr. */
const nativeTry = (cwd: string, ...args: string[]) => {
  try {
    exec(cwd, ...args);
    return { ok: true, message: "" };
  } catch (error) {
    return { ok: false, message: String((error as { stderr?: string }).stderr ?? "").trim() };
  }
};
const read = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : "<missing>");
const status = (dir: string) => exec(dir, "status", "--porcelain=v1", "-uall");

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

/** A repository: a.txt (10 lines), b.txt, other.txt committed on main. */
function repo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  run(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
  writeFileSync(join(dir, "b.txt"), "b\n");
  writeFileSync(join(dir, "other.txt"), "other\n");
  run(dir, "add", ".");
  run(dir, "commit", "-q", "-m", "c1");
}

/** Applies the stash with native git in a copy of `dir` and with ours in `dir`. */
async function bothApply(dir: string, index = false) {
  const native = `${dir}-native`;
  cpSync(dir, native, { recursive: true });
  const expected = index
    ? nativeTry(native, "stash", "apply", "--index")
    : nativeTry(native, "stash", "apply");
  const { ours } = await open(dir);
  let actual: { ok: boolean; message: string; status?: string };
  try {
    const result = await ours.stashApply().setRestoreIndex(index).call();
    actual = { ok: result.status === "ok", message: "", status: result.status };
  } catch (error) {
    actual = { ok: false, message: (error as Error).message };
  }
  return { native, expected, actual };
}

/** The same files, index and status in both copies. */
function expectSameState(dir: string, native: string, files: string[]): void {
  expect(status(dir)).toBe(status(native));
  expect(run(dir, "ls-files", "-s")).toBe(run(native, "ls-files", "-s"));
  for (const file of files) expect(read(join(dir, file)), file).toBe(read(join(native, file)));
}

describeGit("stash apply against native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stash-native-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("stages the files the stash adds, keeps unrelated edits (without --index)", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "spot"), "spot\n");
    run(dir, "add", "spot");
    run(dir, "stash", "-q");
    writeFileSync(join(dir, "other.txt"), "EDIT\n");
    const { native, expected, actual } = await bothApply(dir);
    expect(actual.ok).toBe(expected.ok);
    expectSameState(dir, native, ["spot", "other.txt"]);
  });

  it("keeps newly staged files and staged content, with and without --index", async () => {
    for (const index of [false, true]) {
      const dir = join(root, `r-${index}`);
      repo(dir);
      writeFileSync(join(dir, "a.txt"), "X\n");
      run(dir, "stash", "-q");
      writeFileSync(join(dir, "staged.txt"), "s\n");
      run(dir, "add", "staged.txt");
      writeFileSync(join(dir, "b.txt"), "b-staged\n");
      run(dir, "add", "b.txt");
      writeFileSync(join(dir, "b.txt"), "b-worktree\n");
      const { native, expected, actual } = await bothApply(dir, index);
      expect(actual.ok, `index=${index}`).toBe(expected.ok);
      expectSameState(dir, native, ["a.txt", "b.txt", "staged.txt"]);
    }
  });

  it("merges non-overlapping changes cleanly; a stash with adds and deletes", async () => {
    for (const index of [false, true]) {
      const dir = join(root, `r-${index}`);
      repo(dir);
      writeFileSync(join(dir, "a.txt"), "ONE\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
      writeFileSync(join(dir, "new.txt"), "new\n");
      run(dir, "add", "new.txt", "a.txt");
      writeFileSync(join(dir, "c.txt"), "c\n");
      run(dir, "add", "c.txt");
      writeFileSync(join(dir, "c.txt"), "c-wt\n");
      run(dir, "rm", "-q", "other.txt");
      run(dir, "stash", "-q");
      writeFileSync(join(dir, "a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n");
      writeFileSync(join(dir, "b.txt"), "B2\n");
      run(dir, "commit", "-qam", "c2");
      writeFileSync(join(dir, "b.txt"), "B2-unstaged\n");
      const { native, expected, actual } = await bothApply(dir, index);
      expect(actual.ok, `index=${index}`).toBe(expected.ok);
      expectSameState(dir, native, ["a.txt", "b.txt", "c.txt", "new.txt", "other.txt"]);
    }
  });

  it("writes conflict markers and stages 1-3 on a real conflict", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "a.txt"), "X\n");
    run(dir, "stash", "-q");
    writeFileSync(join(dir, "a.txt"), "Y\n");
    run(dir, "commit", "-qam", "c2");
    const { native, expected, actual } = await bothApply(dir);
    expect(expected.ok).toBe(false);
    expect(actual.status).toBe("conflicts");
    expectSameState(dir, native, ["a.txt"]);
  });

  it("refuses --index on an index conflict as git", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "a.txt"), "X\n");
    run(dir, "add", "a.txt");
    run(dir, "stash", "-q");
    writeFileSync(join(dir, "a.txt"), "Y\n");
    run(dir, "commit", "-qam", "c2");
    const { expected, actual } = await bothApply(dir, true);
    expect(expected.ok).toBe(false);
    expect(expected.message).toContain("Try without --index");
    expect(actual.message).toBe("error: conflicts in index. Try without --index.");
  });

  it("restores -u files; refuses before writing when a file stands on a leading component", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "a.txt"), "X\n");
    writeFileSync(join(dir, "u.txt"), "u\n");
    mkdirSync(join(dir, "ud"));
    writeFileSync(join(dir, "ud/f"), "f\n");
    run(dir, "stash", "-q", "-u");
    const blocked = join(root, "blocked");
    cpSync(dir, blocked, { recursive: true });
    const { native, actual } = await bothApply(dir);
    expect(actual.ok).toBe(true);
    expectSameState(dir, native, ["a.txt", "u.txt", "ud/f"]);

    writeFileSync(join(blocked, "ud"), "precious\n");
    const refused = await bothApply(blocked);
    expect(refused.expected.ok).toBe(false);
    expect(refused.actual.message).toBe(refused.expected.message);
    expect(read(join(blocked, "a.txt"))).toBe("1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    expect(read(join(blocked, "ud"))).toBe("precious\n");
  });
});

describeGit("ignore rules are read fresh, as native git reads them", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ignore-native-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("a .gitignore changed since an earlier read no longer makes a file expendable", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    run(dir, "add", ".gitignore");
    run(dir, "commit", "-qm", "gi");
    run(dir, "checkout", "-qb", "other");
    writeFileSync(join(dir, "p.log"), "branch\n");
    run(dir, "add", "-f", "p.log");
    run(dir, "commit", "-qm", "plog");
    run(dir, "checkout", "-q", "main");
    const { ours, worktree } = await open(dir);
    expect(await worktree.isIgnored("p.log")).toBe(true);
    for await (const _ of worktree.walk()) {
      // a status-like walk reads the rules too
    }
    writeFileSync(join(dir, ".gitignore"), "# none\n");
    writeFileSync(join(dir, "p.log"), "PRECIOUS\n");
    expect(await worktree.isIgnored("p.log")).toBe(false);
    const native = `${dir}-native`;
    cpSync(dir, native, { recursive: true });
    const expected = nativeTry(native, "checkout", "-q", "other");
    const result = await ours.checkout().setName("other").call();
    expect(expected.ok).toBe(false);
    expect(result.message).toBe(expected.message);
    expect(read(join(dir, "p.log"))).toBe("PRECIOUS\n");
  });

  it("matches git check-ignore: directories, negations, nested and info/exclude", async () => {
    const dir = join(root, "r");
    repo(dir);
    mkdirSync(join(dir, "sub"));
    mkdirSync(join(dir, "build"));
    writeFileSync(join(dir, ".gitignore"), "*.log\nbuild/\n!build/keep.txt\n");
    writeFileSync(join(dir, "sub/.gitignore"), "!x.log\n");
    // (newer git creates no .git/info at init)
    mkdirSync(join(dir, ".git/info"), { recursive: true });
    writeFileSync(join(dir, ".git/info/exclude"), "*.tmp\n!y.log\n");
    const { worktree } = await open(dir);
    for (const path of [
      "a.log",
      "sub/x.log",
      "y.log",
      "z.tmp",
      "build/keep.txt",
      "build/o.txt",
      "sub/deep/x.log",
      "plain.txt",
    ]) {
      const ignored = nativeTry(dir, "check-ignore", "-q", "--no-index", path).ok;
      expect(await worktree.isIgnored(path), path).toBe(ignored);
    }
  });

  it("an abandoned walk leaves no lstat cache behind for later writes", async () => {
    const dir = join(root, "r");
    repo(dir);
    mkdirSync(join(dir, "dir"));
    writeFileSync(join(dir, "dir/f"), "f\n");
    mkdirSync(join(root, "outside"));
    const { worktree } = await open(dir);
    const walk = worktree.walk()[Symbol.asyncIterator]();
    await walk.next();
    await walk.next();
    await walk.next();
    await worktree.writeContent("dir/g", new TextEncoder().encode("g"));
    rmSync(join(dir, "dir"), { recursive: true });
    symlinkSync(join(root, "outside"), join(dir, "dir"));
    await expect(
      worktree.writeContent("dir/evil", new TextEncoder().encode("EVIL")),
    ).rejects.toThrow(/symbolic link/);
    expect(existsSync(join(root, "outside/evil"))).toBe(false);
  });
});
