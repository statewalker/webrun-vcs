/**
 * `stash apply` against native `git stash apply`: the same repository (a stash made by
 * native git) applied by native git in one copy and by ours in a twin copy, then the
 * outcome (refusal message, status, index, file contents) compared. Also checkout and
 * the worktree's ignore rules read fresh as native git reads them.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
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

import { findInTheWay } from "../src/commands/worktree-overwrite-checks.js";
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

/** A file's content, `<dir>` for a directory, `<missing>` for nothing. */
const contentOf = (path: string) => {
  if (!existsSync(path)) return "<missing>";
  try {
    return readFileSync(path, "latin1");
  } catch {
    return "<dir>";
  }
};

/** Applies the stash with both and expects native git's outcome, index, status and files. */
async function expectAsNative(dir: string, files: string[], index = false) {
  const { native, expected, actual } = await bothApply(dir, index);
  expect(actual.ok, actual.message).toBe(expected.ok);
  expect(status(dir)).toBe(status(native));
  expect(run(dir, "ls-files", "-s")).toBe(run(native, "ls-files", "-s"));
  for (const file of files) {
    expect(contentOf(join(dir, file)), file).toBe(contentOf(join(native, file)));
  }
  return { native, expected, actual };
}

describeGit("stash apply conflicts as native git leaves them", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stash-conflicts-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("modify/delete: the stash deletes what HEAD modified, ours stays (UD)", async () => {
    const dir = join(root, "r");
    repo(dir);
    run(dir, "rm", "-q", "b.txt");
    run(dir, "stash", "-q");
    writeFileSync(join(dir, "b.txt"), "b-head\n");
    run(dir, "commit", "-qam", "c2");
    await expectAsNative(dir, ["b.txt"]);
    expect(read(join(dir, "b.txt"))).toBe("b-head\n");
  });

  it("modify/delete: a staged-only change survives the stash's deletion", async () => {
    const dir = join(root, "r");
    repo(dir);
    run(dir, "rm", "-q", "b.txt");
    run(dir, "stash", "-q");
    writeFileSync(join(dir, "b.txt"), "b-staged\n");
    run(dir, "add", "b.txt");
    await expectAsNative(dir, ["b.txt"]);
    expect(read(join(dir, "b.txt"))).toBe("b-staged\n");
  });

  it("delete/modify: the stash's version is written and staged at 1 and 3 (DU)", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "b.txt"), "b-stash\n");
    run(dir, "stash", "-q");
    run(dir, "rm", "-q", "b.txt");
    run(dir, "commit", "-qm", "c2");
    await expectAsNative(dir, ["b.txt"]);
    expect(status(dir)).toBe("DU b.txt\n");
  });

  it("file/directory: the staged file p moves aside to `p~Updated upstream`", async () => {
    const dir = join(root, "r");
    repo(dir);
    mkdirSync(join(dir, "p"));
    writeFileSync(join(dir, "p/x"), "x\n");
    run(dir, "add", "p/x");
    run(dir, "stash", "-q");
    writeFileSync(join(dir, "p"), "precious staged\n");
    run(dir, "add", "p");
    await expectAsNative(dir, ["p", "p/x", "p~Updated upstream"]);
    expect(read(join(dir, "p~Updated upstream"))).toBe("precious staged\n");
  });

  it("file/directory: the stash's file q moves aside to `q~Stashed changes`", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "q"), "q-stash\n");
    run(dir, "add", "q");
    run(dir, "stash", "-q");
    mkdirSync(join(dir, "q"));
    writeFileSync(join(dir, "q/y"), "precious\n");
    run(dir, "add", "q/y");
    await expectAsNative(dir, ["q", "q/y", "q~Stashed changes"]);
    expect(read(join(dir, "q/y"))).toBe("precious\n");
  });

  it("binary files: ours stays without markers, staged 1-3", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "bin"), Buffer.from([0, 1, 2, 10, 3, 4, 10]));
    run(dir, "add", "bin");
    run(dir, "commit", "-qm", "bin");
    writeFileSync(join(dir, "bin"), Buffer.from([0, 9, 2, 10, 3, 4, 10]));
    run(dir, "stash", "-q");
    writeFileSync(join(dir, "bin"), Buffer.from([0, 8, 2, 10, 3, 4, 10]));
    run(dir, "commit", "-qam", "c2");
    await expectAsNative(dir, ["bin"]);
    expect([...readFileSync(join(dir, "bin"))]).toEqual([0, 8, 2, 10, 3, 4, 10]);
  });

  it("text conflicts: markers in several hunks, a missing final newline", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "a.txt"), "1\nS2\n3\n4\n5\n6\n7\n8\n9\nS10");
    run(dir, "stash", "-q");
    writeFileSync(join(dir, "a.txt"), "1\nH2\n3\n4\n5\n6\n7\n8\n9\nH10\n");
    run(dir, "commit", "-qam", "c2");
    await expectAsNative(dir, ["a.txt"]);
  });

  it("a mode change merges with a content change", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "a.txt"), "ONE\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    chmodSync(join(dir, "a.txt"), 0o755);
    run(dir, "stash", "-q");
    writeFileSync(join(dir, "a.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n");
    run(dir, "commit", "-qam", "c2");
    await expectAsNative(dir, ["a.txt"]);
  });

  it("a rename on HEAD carries the stash's change to the new path", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "a.txt"), "ONE\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    run(dir, "stash", "-q");
    run(dir, "mv", "a.txt", "z.txt");
    run(dir, "commit", "-qm", "mv");
    await expectAsNative(dir, ["a.txt", "z.txt"]);
    expect(read(join(dir, "z.txt"))).toBe("ONE\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    expect(existsSync(join(dir, "a.txt"))).toBe(false);
  });

  it("a similar (inexact) rename on HEAD carries the stash's change too", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "a.txt"), "ONE\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    run(dir, "stash", "-q");
    run(dir, "mv", "a.txt", "z.txt");
    writeFileSync(join(dir, "z.txt"), "1\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n");
    run(dir, "commit", "-qam", "mv");
    await expectAsNative(dir, ["a.txt", "z.txt"]);
  });

  it("--index with partial staging: index and worktree as native git", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "a.txt"), "STAGED-1\n");
    run(dir, "add", "a.txt");
    writeFileSync(join(dir, "a.txt"), "WORKTR-2\n");
    writeFileSync(join(dir, "n.txt"), "N-STAGED\n");
    run(dir, "add", "n.txt");
    writeFileSync(join(dir, "n.txt"), "N-WORKTR\n");
    run(dir, "stash", "-q");
    await expectAsNative(dir, ["a.txt", "n.txt"], true);
  });

  it("--index records no stat for a file whose content is not the staged blob", async () => {
    // same size staged and unstaged versions: a recorded stat would hide the edit
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "a.txt"), "STAGED-1\n");
    run(dir, "add", "a.txt");
    writeFileSync(join(dir, "a.txt"), "WORKTR-2\n");
    run(dir, "stash", "-q");
    const { native } = await expectAsNative(dir, ["a.txt"], true);
    // past the racy window, and comparing only size and whole-second mtime (git's
    // core.checkStat=minimal), native git trusts a recorded stat
    const later = Date.now() / 1000 + 10;
    for (const d of [dir, native]) utimesSync(join(d, ".git/index"), later, later);
    const statStatus = (d: string) =>
      exec(
        d,
        "-c",
        "core.trustctime=false",
        "-c",
        "core.checkStat=minimal",
        "status",
        "--porcelain=v1",
      );
    expect(statStatus(dir)).toBe("MM a.txt\n");
    expect(statStatus(dir)).toBe(statStatus(native));
  });

  it("--index: a stash index adding a file the worktree deleted", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "n.txt"), "n\n");
    run(dir, "add", "n.txt");
    rmSync(join(dir, "n.txt"));
    run(dir, "stash", "-q");
    await expectAsNative(dir, ["n.txt"], true);
  });

  it("a conflict with an unrelated clean change and add/add", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "a.txt"), "X\n");
    writeFileSync(join(dir, "b.txt"), "b-stash\n");
    run(dir, "stash", "-q");
    writeFileSync(join(dir, "a.txt"), "Y\n");
    run(dir, "commit", "-qam", "c2");
    await expectAsNative(dir, ["a.txt", "b.txt"]);

    const other = join(root, "add");
    repo(other);
    writeFileSync(join(other, "n.txt"), "stash\n");
    run(other, "add", "n.txt");
    run(other, "stash", "-q");
    writeFileSync(join(other, "n.txt"), "head\n");
    run(other, "add", "n.txt");
    run(other, "commit", "-qm", "c2");
    await expectAsNative(other, ["n.txt"]);
  });

  it("a conflicted -u stash restores its untracked files", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, "a.txt"), "X\n");
    writeFileSync(join(dir, "u.txt"), "u\n");
    run(dir, "stash", "-q", "-u");
    writeFileSync(join(dir, "a.txt"), "Y\n");
    run(dir, "commit", "-qam", "c2");
    await expectAsNative(dir, ["a.txt", "u.txt"]);
  });

  it("an ignored file in a directory a stashed file replaces is deleted, as git does", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    run(dir, "add", ".gitignore");
    run(dir, "commit", "-qm", "gi");
    writeFileSync(join(dir, "dd"), "file in stash\n");
    run(dir, "add", "dd");
    run(dir, "stash", "-q");
    mkdirSync(join(dir, "dd"));
    writeFileSync(join(dir, "dd/precious.log"), "PRECIOUS\n");
    await expectAsNative(dir, ["dd", "dd/precious.log"]);
    expect(read(join(dir, "dd"))).toBe("file in stash\n");
  });
});

describeGit("ignore rules read per operation", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ignore-fresh-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** The stashed file dd, an untracked dd/precious.log, the instance's rules read first. */
  async function staleSetup(dir: string, stash: boolean) {
    repo(dir);
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    run(dir, "add", ".gitignore");
    run(dir, "commit", "-qm", "gi");
    if (stash) {
      writeFileSync(join(dir, "dd"), "file in stash\n");
      run(dir, "add", "dd");
      run(dir, "stash", "-q");
    } else {
      run(dir, "checkout", "-q", "-b", "other");
      writeFileSync(join(dir, "dd"), "file\n");
      run(dir, "add", "dd");
      run(dir, "commit", "-qm", "dd");
      run(dir, "checkout", "-q", "main");
    }
    mkdirSync(join(dir, "dd"));
    writeFileSync(join(dir, "dd/precious.log"), "PRECIOUS\n");
    const opened = await open(dir);
    for await (const _ of opened.worktree.walk({})) {
      // reads the root .gitignore (logs ignored)
    }
    writeFileSync(join(dir, ".gitignore"), "# logs are precious now\n");
    const native = `${dir}-native`;
    cpSync(dir, native, { recursive: true });
    return { ...opened, native };
  }

  it("stash apply sees a .gitignore changed after an earlier walk", async () => {
    const dir = join(root, "r");
    const { ours, native } = await staleSetup(dir, true);
    const expected = nativeTry(native, "stash", "apply");
    expect(expected.ok).toBe(false);
    await expect(ours.stashApply().call()).rejects.toThrow(expected.message);
    expect(read(join(dir, "dd/precious.log"))).toBe("PRECIOUS\n");
    expect(read(join(native, "dd/precious.log"))).toBe("PRECIOUS\n");
  });

  it("checkout sees a .gitignore changed after an earlier walk", async () => {
    const dir = join(root, "r");
    const { ours, native } = await staleSetup(dir, false);
    const expected = nativeTry(native, "checkout", "other");
    expect(expected.ok).toBe(false);
    const result = await ours.checkout().setName("other").call();
    expect(result.status).toBe("CONFLICTS");
    expect(result.message).toContain("would lose untracked files in them:\n\tdd");
    expect(read(join(dir, "dd/precious.log"))).toBe("PRECIOUS\n");
    expect(run(dir, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  });

  it("a walk with a prefix reads the .gitignore of every parent directory afresh", async () => {
    const dir = join(root, "r");
    repo(dir);
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    mkdirSync(join(dir, "dd"));
    writeFileSync(join(dir, "dd/precious.log"), "P\n");
    const { worktree } = await open(dir);
    const walked = async () => {
      const paths: string[] = [];
      for await (const entry of worktree.walk({ pathPrefix: "dd" })) paths.push(entry.path);
      return paths;
    };
    expect(await walked()).toEqual([]);
    writeFileSync(join(dir, ".gitignore"), "# none\n");
    expect(await walked()).toEqual(["dd/precious.log"]);
    expect(await worktree.isIgnored("dd/precious.log")).toBe(false);
    writeFileSync(join(dir, ".gitignore"), "*.log\n");
    expect(await walked()).toEqual([]);
    expect(await worktree.isIgnored("dd/precious.log")).toBe(true);
  });

  it("info/exclude takes precedence over core.excludesFile, whatever was read first", async () => {
    const dir = join(root, "r");
    repo(dir);
    mkdirSync(join(dir, ".git/info"), { recursive: true });
    writeFileSync(join(dir, "keep.log"), "k\n");
    writeFileSync(join(dir, "drop.log"), "d\n");
    const files = createNodeFilesApi({ rootDir: dir });
    const { history } = await createGitFilesBackend({ files });
    const worktree = createFileWorktree({
      files,
      rootPath: "",
      gitDir: ".git",
      blobs: history.blobs,
      trees: history.trees,
      globalExcludesFile: ".git/global-ignore",
    });
    const nativeIgnored = (path: string) =>
      nativeTry(
        dir,
        "-c",
        `core.excludesFile=${join(dir, ".git/global-ignore")}`,
        "check-ignore",
        "-q",
        path,
      ).ok;
    const expectAsNative = async (label: string) => {
      for (const path of ["keep.log", "drop.log"]) {
        expect(await worktree.isIgnored(path), `${label}: ${path}`).toBe(nativeIgnored(path));
      }
    };
    // core.excludesFile appears after info/exclude was read: info/exclude still wins
    writeFileSync(join(dir, ".git/info/exclude"), "*.log\n");
    await expectAsNative("info/exclude only");
    writeFileSync(join(dir, ".git/global-ignore"), "!keep.log\n");
    await expectAsNative("core.excludesFile added later");
    expect(await worktree.isIgnored("keep.log")).toBe(true);
    // and the other way round
    rmSync(join(dir, ".git/info/exclude"));
    writeFileSync(join(dir, ".git/global-ignore"), "*.log\n");
    await expectAsNative("core.excludesFile only");
    writeFileSync(join(dir, ".git/info/exclude"), "!keep.log\n");
    await expectAsNative("info/exclude added later");
    expect(await worktree.isIgnored("keep.log")).toBe(false);
  });

  it("ignore checks in one batch read the rules once (deep trees stay fast)", async () => {
    const dir = join(root, "r");
    repo(dir);
    const parts: string[] = [];
    for (let i = 0; i < 8; i++) {
      parts.push(`l${i}`);
      mkdirSync(join(dir, ...parts));
      writeFileSync(join(dir, ...parts, ".gitignore"), "*.tmp\n!keep.tmp\n");
    }
    const { worktree } = await open(dir);
    const deep = parts.join("/");
    const started = performance.now();
    const checks = async () => {
      const out: boolean[] = [];
      for (let i = 0; i < 200; i++) out.push(await worktree.isIgnored(`${deep}/f${i}.tmp`));
      return out;
    };
    const results = worktree.batch ? await worktree.batch(checks) : await checks();
    expect(results.every(Boolean)).toBe(true);
    // a rough bound: read once per batch, not once per check
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

/** Writes `content` at `path` in `dir`, creating the parent directories. */
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
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

/** As {@link expectAsNative}, the whole worktree listing too. */
async function expectTreeAsNative(dir: string, files: string[]) {
  const outcome = await expectAsNative(dir, files);
  expect(listing(dir)).toEqual(listing(outcome.native));
  return outcome;
}

describeGit("stash apply file/directory conflicts: unique move-aside names", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stash-moveaside-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** The stash adds p/x; the index has the file p. */
  function oursFileSetup(dir: string) {
    put(dir, "p/x", "px\n");
    run(dir, "add", "p/x");
    run(dir, "stash", "-q");
    put(dir, "p", "index p\n");
    run(dir, "add", "p");
  }
  /** The stash adds the file q; the index has q/y. */
  function theirsFileSetup(dir: string) {
    put(dir, "q", "stash q\n");
    run(dir, "add", "q");
    run(dir, "stash", "-q");
    put(dir, "q/y", "qy\n");
    run(dir, "add", "q/y");
  }
  const P = ["p", "p/x", "p~Updated upstream", "p~Updated upstream_0"];
  const Q = ["q", "q/y", "q~Stashed changes", "q~Stashed changes_0"];

  it("an untracked file at `p~Updated upstream` refuses the apply", async () => {
    const dir = join(root, "r");
    repo(dir);
    oursFileSetup(dir);
    put(dir, "p~Updated upstream", "PRECIOUS\n");
    const { actual } = await expectTreeAsNative(dir, P);
    expect(actual.message).toContain("untracked working tree files would be overwritten");
    expect(read(join(dir, "p~Updated upstream"))).toBe("PRECIOUS\n");
  });

  it("an untracked file at `q~Stashed changes` refuses the apply", async () => {
    const dir = join(root, "r");
    repo(dir);
    theirsFileSetup(dir);
    put(dir, "q~Stashed changes", "PRECIOUS\n");
    await expectTreeAsNative(dir, Q);
    expect(read(join(dir, "q~Stashed changes"))).toBe("PRECIOUS\n");
  });

  it("an ignored file at `p~Updated upstream` is overwritten, as git does", async () => {
    const dir = join(root, "r");
    repo(dir);
    put(dir, ".gitignore", "*~*\n");
    run(dir, "add", ".");
    run(dir, "commit", "-qm", "t");
    oursFileSetup(dir);
    put(dir, "p~Updated upstream", "IGNORED\n");
    await expectTreeAsNative(dir, P);
  });

  it("a tracked clean `p~Updated upstream`: the file moves to `p~Updated upstream_0`", async () => {
    const dir = join(root, "r");
    repo(dir);
    put(dir, "p~Updated upstream", "TRACKED\n");
    run(dir, "add", ".");
    run(dir, "commit", "-qm", "t");
    oursFileSetup(dir);
    await expectTreeAsNative(dir, P);
    expect(read(join(dir, "p~Updated upstream"))).toBe("TRACKED\n");
    expect(read(join(dir, "p~Updated upstream_0"))).toBe("index p\n");
  });

  it("a tracked `p~Updated upstream` keeps its unstaged edit", async () => {
    const dir = join(root, "r");
    repo(dir);
    put(dir, "p~Updated upstream", "TRACKED\n");
    run(dir, "add", ".");
    run(dir, "commit", "-qm", "t");
    oursFileSetup(dir);
    put(dir, "p~Updated upstream", "UNSTAGED EDIT\n");
    await expectTreeAsNative(dir, P);
    expect(read(join(dir, "p~Updated upstream"))).toBe("UNSTAGED EDIT\n");
  });

  it("a tracked `q~Stashed changes` keeps its unstaged edit", async () => {
    const dir = join(root, "r");
    repo(dir);
    put(dir, "q~Stashed changes", "TRACKED\n");
    run(dir, "add", ".");
    run(dir, "commit", "-qm", "t");
    theirsFileSetup(dir);
    put(dir, "q~Stashed changes", "UNSTAGED EDIT\n");
    await expectTreeAsNative(dir, Q);
    expect(read(join(dir, "q~Stashed changes"))).toBe("UNSTAGED EDIT\n");
  });

  it("a tracked directory `q~Stashed changes` stays, with its edit", async () => {
    const dir = join(root, "r");
    repo(dir);
    put(dir, "q~Stashed changes/t", "TRACKED\n");
    run(dir, "add", ".");
    run(dir, "commit", "-qm", "t");
    theirsFileSetup(dir);
    put(dir, "q~Stashed changes/t", "UNSTAGED EDIT\n");
    await expectTreeAsNative(dir, [...Q, "q~Stashed changes/t"]);
    expect(read(join(dir, "q~Stashed changes/t"))).toBe("UNSTAGED EDIT\n");
  });

  it("a staged edit of `q~Stashed changes` stays staged", async () => {
    const dir = join(root, "r");
    repo(dir);
    put(dir, "q~Stashed changes", "TRACKED\n");
    run(dir, "add", ".");
    run(dir, "commit", "-qm", "t");
    put(dir, "q", "stash q\n");
    run(dir, "add", "q");
    run(dir, "stash", "-q");
    put(dir, "q/y", "qy\n");
    put(dir, "q~Stashed changes", "STAGED EDIT\n");
    run(dir, "add", ".");
    await expectTreeAsNative(dir, Q);
  });

  it("a tracked link `q~Stashed changes` stays a link", async () => {
    const dir = join(root, "r");
    repo(dir);
    const outside = join(root, "outside.txt");
    writeFileSync(outside, "OUTSIDE\n");
    symlinkSync(outside, join(dir, "q~Stashed changes"));
    run(dir, "add", ".");
    run(dir, "commit", "-qm", "t");
    theirsFileSetup(dir);
    await expectTreeAsNative(dir, Q);
    expect(readlinkSync(join(dir, "q~Stashed changes"))).toBe(outside);
    expect(read(outside)).toBe("OUTSIDE\n");
  });
});

describeGit("stash apply modify/delete with a file/directory collision", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stash-mddir-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** p committed; the stash modifies it; then p is deleted and p/x added (staged). */
  function setup(dir: string, ignore = false) {
    repo(dir);
    if (ignore) put(dir, ".gitignore", "*.log\n");
    put(dir, "p", "p0\n");
    run(dir, "add", ".");
    run(dir, "commit", "-qm", "t");
    put(dir, "p", "p-stash\n");
    run(dir, "stash", "-q");
    run(dir, "rm", "-q", "p");
    put(dir, "p/x", "px staged\n");
    run(dir, "add", "p/x");
  }
  const files = ["p", "p/x", "p/u", "p/x.log", "p~Stashed changes", "p~Updated upstream"];

  it("ours modified p, the stash deleted p and added p/x: p moves aside", async () => {
    const dir = join(root, "r");
    repo(dir);
    put(dir, "p", "p0\n");
    run(dir, "add", ".");
    run(dir, "commit", "-qm", "t");
    run(dir, "rm", "-q", "p");
    put(dir, "p/x", "px\n");
    run(dir, "add", "p/x");
    run(dir, "stash", "-q");
    put(dir, "p", "p-ours-staged\n");
    run(dir, "add", "p");
    await expectTreeAsNative(dir, files);
    expect(read(join(dir, "p~Updated upstream"))).toBe("p-ours-staged\n");
  });

  it("the stash modified p, the index has p/x: the stash's p moves aside", async () => {
    const dir = join(root, "r");
    setup(dir);
    await expectTreeAsNative(dir, files);
    expect(read(join(dir, "p/x"))).toBe("px staged\n");
  });

  it("an unstaged edit in p/x survives", async () => {
    const dir = join(root, "r");
    setup(dir);
    put(dir, "p/x", "px UNSTAGED\n");
    await expectTreeAsNative(dir, files);
    expect(read(join(dir, "p/x"))).toBe("px UNSTAGED\n");
  });

  it("an unstaged edit and an untracked file in p survive", async () => {
    const dir = join(root, "r");
    setup(dir);
    put(dir, "p/x", "px UNSTAGED\n");
    put(dir, "p/u", "UNTRACKED\n");
    await expectTreeAsNative(dir, files);
    expect(read(join(dir, "p/u"))).toBe("UNTRACKED\n");
  });

  it("p/x committed on HEAD: its edit and an untracked p/u survive", async () => {
    const dir = join(root, "r");
    setup(dir);
    run(dir, "commit", "-qm", "dir");
    put(dir, "p/x", "px UNSTAGED\n");
    put(dir, "p/u", "UNTRACKED\n");
    await expectTreeAsNative(dir, files);
  });

  it("p/x committed on HEAD: an ignored p/x.log survives", async () => {
    const dir = join(root, "r");
    setup(dir, true);
    run(dir, "commit", "-qm", "dir");
    put(dir, "p/x.log", "LOG\n");
    await expectTreeAsNative(dir, files);
    expect(read(join(dir, "p/x.log"))).toBe("LOG\n");
  });
});

describeGit("stash apply rename conflicts as git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "stash-renames-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const files = ["a.txt", "c.txt", "d.txt", "c.txt/inner", "c.txt~Updated upstream"];

  it("rename/delete: the stash renamed a.txt, HEAD deleted it (DU)", async () => {
    const dir = join(root, "r");
    repo(dir);
    run(dir, "mv", "a.txt", "c.txt");
    run(dir, "stash", "-q");
    run(dir, "rm", "-q", "a.txt");
    run(dir, "commit", "-qm", "del");
    const { actual } = await expectTreeAsNative(dir, files);
    expect(actual.status).toBe("conflicts");
    expect(status(dir)).toBe("DU c.txt\n");
  });

  it("rename/delete: HEAD renamed and modified a.txt, the stash deleted it (UD)", async () => {
    const dir = join(root, "r");
    repo(dir);
    run(dir, "rm", "-q", "a.txt");
    run(dir, "stash", "-q");
    run(dir, "mv", "a.txt", "c.txt");
    put(dir, "c.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\nTEN\n");
    run(dir, "commit", "-qam", "mv");
    await expectTreeAsNative(dir, files);
    expect(status(dir)).toBe("UD c.txt\n");
  });

  it("rename/rename: a.txt renamed to c.txt by HEAD and to d.txt by the stash", async () => {
    const dir = join(root, "r");
    repo(dir);
    run(dir, "mv", "a.txt", "d.txt");
    run(dir, "stash", "-q");
    run(dir, "mv", "a.txt", "c.txt");
    run(dir, "commit", "-qm", "mv");
    await expectTreeAsNative(dir, files);
    expect(status(dir)).toBe("DD a.txt\nAU c.txt\nUA d.txt\n");
  });

  it("the stash renamed and modified a.txt, HEAD added another c.txt", async () => {
    const dir = join(root, "r");
    repo(dir);
    run(dir, "mv", "a.txt", "c.txt");
    put(dir, "c.txt", "ONE\n2\n3\n4\n5\n6\n7\n8\n9\n10\n");
    run(dir, "add", "c.txt");
    run(dir, "stash", "-q");
    put(dir, "c.txt", "HEAD C\n");
    run(dir, "add", "c.txt");
    run(dir, "commit", "-qm", "c");
    await expectTreeAsNative(dir, files);
  });

  it("HEAD renamed a.txt to c.txt, the stash added c.txt/inner: the file moves aside", async () => {
    const dir = join(root, "r");
    repo(dir);
    put(dir, "c.txt/inner", "stash dir\n");
    run(dir, "add", ".");
    put(dir, "a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\nSTASH\n");
    run(dir, "stash", "-q");
    run(dir, "mv", "a.txt", "c.txt");
    run(dir, "commit", "-qm", "mv");
    await expectTreeAsNative(dir, files);
    expect(read(join(dir, "c.txt~Updated upstream"))).toBe("1\n2\n3\n4\n5\n6\n7\n8\n9\nSTASH\n");
  });

  it("the stash renamed a.txt to c, an untracked file in a directory c", async () => {
    const dir = join(root, "r");
    repo(dir);
    run(dir, "mv", "a.txt", "c");
    run(dir, "stash", "-q");
    put(dir, "c/u", "UNTRACKED in dir\n");
    await expectTreeAsNative(dir, ["a.txt", "c", "c/u"]);
    expect(read(join(dir, "c/u"))).toBe("UNTRACKED in dir\n");
  });
});

describe("findInTheWay never lets a file replace a tracked directory", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "in-the-way-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("refuses a write at a tracked directory unless its files are removed", async () => {
    const dir = join(root, "r");
    mkdirSync(join(dir, "p"), { recursive: true });
    writeFileSync(join(dir, "p/x"), "tracked\n");
    const files = createNodeFilesApi({ rootDir: dir });
    const { history } = await createGitFilesBackend({ files, create: true });
    const worktree = createFileWorktree({
      files,
      rootPath: "",
      gitDir: ".git",
      blobs: history.blobs,
      trees: history.trees,
    });
    const index = new Map([["p/x", {}]]);
    expect(await findInTheWay(worktree, { writes: ["p"], removes: new Set(), index })).toEqual({
      untracked: [],
      lostDirs: ["p"],
    });
    // also when the directory is missing from the worktree: the index still has it
    rmSync(join(dir, "p"), { recursive: true });
    expect(
      (await findInTheWay(worktree, { writes: ["p"], removes: new Set(), index })).lostDirs,
    ).toEqual(["p"]);
    // removing the tracked files first makes way
    expect(
      await findInTheWay(worktree, { writes: ["p"], removes: new Set(["p/x"]), index }),
    ).toEqual({ untracked: [], lostDirs: [] });
  });
});
