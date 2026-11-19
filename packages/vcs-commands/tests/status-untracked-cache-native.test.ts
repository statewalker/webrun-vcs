/**
 * The untracked cache (`UNTR`) against native git: from one index, native `git status` and
 * ours must write the same extension bytes and print the same status, step after step, the
 * worktree changed in between (files and directories made, removed and renamed, `.gitignore`
 * and `info/exclude` edited, paths added to and removed from the index). Each step keeps
 * the index one of the two wrote, alternately, so each side reads the other's cache.
 *
 * The twins share one repository: the index (bytes and mtime) is put back before the
 * second run, so both see the same directory stats and decide racy entries alike. The
 * directories are dated back after each change, so the cache's valid directories are
 * really reused rather than read again for being racy. A fuzz run of random steps checks
 * that the status is never stale: it is compared with native git's without any cache.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
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
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import {
  MemoryWorkingCopy,
  parseIndexFile,
  parseUntrackedCache,
} from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatStatusPorcelain, Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
const env = (extra: Record<string, string> = {}) => ({ ...nativeGitEnv(root), ...extra });
const git = (cwd: string, args: string[], extra?: Record<string, string>) =>
  execFileSync("git", args, {
    cwd,
    env: env(extra),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/** Our working copy over the repository, with the host environment native git has. */
async function open(dir: string) {
  return (await openParts(dir)).git;
}

/** `open`, with the staging store it reads the index through. */
async function openParts(dir: string) {
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
  const environment = createNodeGitHostEnvironment({ env: env() });
  const config = new GitWorkingCopyConfig(io, ".git/config", { environment });
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
  return { git: Git.fromWorkingCopy(wc), staging };
}

/** The `UNTR` payload of the repository's index (undefined: none). */
async function untr(dir: string): Promise<Buffer | undefined> {
  const parsed = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
  const ext = parsed.extensionData.find((e) => e.signature === "UNTR");
  return ext ? Buffer.from(ext.data) : undefined;
}

/** The index file as it is (bytes and mtime), to put back. */
function saveIndex(dir: string) {
  const path = join(dir, ".git/index");
  return { bytes: readFileSync(path), mtime: statSync(path).mtime };
}
function restoreIndex(dir: string, saved: ReturnType<typeof saveIndex>) {
  const path = join(dir, ".git/index");
  writeFileSync(path, saved.bytes);
  utimesSync(path, saved.mtime, saved.mtime);
}

let backSeconds = 0;
/**
 * The directories of the worktree (outside `.git`) changed in the last seconds, dated back
 * to a second of their own (never one used before, so a later change is always seen) well
 * before the index: no longer racy, so the cache's valid directories are reused.
 */
function dateBack(dir: string) {
  const recent = Date.now() / 1000 - 5;
  backSeconds++;
  const when = Math.floor(Date.now() / 1000) - 100_000 + backSeconds;
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      if (entry.name === ".git" && rel === "") continue;
      if (entry.isDirectory()) walk(rel ? `${rel}/${entry.name}` : entry.name);
    }
    const path = join(dir, rel);
    if (statSync(path).mtimeMs / 1000 >= recent) utimesSync(path, when, when);
  };
  walk("");
}

/**
 * From the index as it is, native git and ours write the same untracked cache and print the
 * same status; the index kept afterwards is native's or ours (`keep`).
 */
async function expectTwins(dir: string, keep: "native" | "ours") {
  const saved = saveIndex(dir);
  const nativeOut = git(dir, ["status", "--porcelain"]);
  const nativeIndex = readFileSync(join(dir, ".git/index"));
  const nativeUntr = await untr(dir);
  restoreIndex(dir, saved);
  const status = await (await open(dir)).status().call();
  const oursUntr = await untr(dir);
  expect(formatStatusPorcelain(status)).toBe(nativeOut);
  expect(oursUntr, "ours wrote an untracked cache").toBeDefined();
  expect(nativeUntr, "native wrote an untracked cache").toBeDefined();
  expect(oursUntr?.equals(nativeUntr as Buffer), "UNTR bytes as native git's").toBe(true);
  if (keep === "native") writeFileSync(join(dir, ".git/index"), nativeIndex);
  return status;
}

/** Native git's status without any untracked cache (on a copy of the index). */
function uncachedStatus(dir: string): string {
  const copy = join(root, "index-copy");
  writeFileSync(copy, readFileSync(join(dir, ".git/index")));
  return git(dir, ["status", "--porcelain"], {
    GIT_INDEX_FILE: copy,
    GIT_DISABLE_UNTRACKED_CACHE: "1",
  });
}

/** A repository with tracked files in nested directories, the untracked cache on for `-uall`. */
function repo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "core.untrackedCache", "true"]);
  git(dir, ["config", "status.showUntrackedFiles", "all"]);
  put(dir, ".gitignore", "*.log\nbuild/\n");
  put(dir, "a/one.txt", "1\n");
  put(dir, "a/b/two.txt", "2\n");
  put(dir, "a/b/c/three.txt", "3\n");
  put(dir, "d/four.txt", "4\n");
  put(dir, "d/.gitignore", "*.tmp\n!keep.tmp\n");
  put(dir, "e/f/g/five.txt", "5\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  put(dir, "a/new.txt", "n\n");
  put(dir, "a/b/c/x.log", "log\n");
  put(dir, "build/out.o", "o\n");
  put(dir, "u/v/w.txt", "w\n");
  dateBack(dir);
}

describeGit("untracked cache: native git and ours write the same UNTR", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "status-untr-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("through directory changes, ignore-file changes and index edits", async () => {
    const dir = join(root, "r");
    repo(dir);
    const steps: Array<[string, () => void]> = [
      ["first scan (no cache yet)", () => {}],
      ["nothing changed (every directory from the cache)", () => {}],
      ["a file made in a cached directory", () => put(dir, "a/b/new2.txt", "n\n")],
      ["an untracked file removed", () => rmSync(join(dir, "a/new.txt"))],
      [
        "an untracked file renamed",
        () => renameSync(join(dir, "u/v/w.txt"), join(dir, "u/v/z.txt")),
      ],
      ["a new directory tree", () => put(dir, "e/f/h/i/deep.txt", "d\n")],
      ["an untracked directory removed", () => rmSync(join(dir, "u"), { recursive: true })],
      [
        "a tracked .gitignore edited in place",
        () => put(dir, ".gitignore", "*.log\nbuild/\n*.txt.bak\nnew2.txt\n"),
      ],
      [
        "an ignored file and a negated one",
        () => {
          put(dir, "d/x.tmp", "t\n");
          put(dir, "d/keep.tmp", "k\n");
        },
      ],
      ["an untracked .gitignore in a subdirectory", () => put(dir, "e/.gitignore", "deep.txt\n")],
      ["that .gitignore edited", () => put(dir, "e/.gitignore", "*.none\n")],
      ["info/exclude edited", () => put(dir, ".git/info/exclude", "*.bak\nkeep.tmp\n")],
      [
        "a nested repository",
        () => {
          mkdirSync(join(dir, "nested"));
          git(join(dir, "nested"), ["init", "-q"]);
        },
      ],
      ["git add of an (ignored) untracked file", () => git(dir, ["add", "-f", "a/b/new2.txt"])],
      ["git rm --cached of a tracked file", () => git(dir, ["rm", "-q", "--cached", "d/four.txt"])],
      ["a .gitignore removed", () => rmSync(join(dir, "d/.gitignore"))],
    ];
    let i = 0;
    for (const [name, change] of steps) {
      change();
      dateBack(dir);
      // alternately the index native git wrote and ours: each side reads the other's cache
      const keep = i++ % 2 === 0 ? "native" : "ours";
      try {
        await expectTwins(dir, keep);
      } catch (error) {
        throw new Error(`step "${name}": ${(error as Error).message}`);
      }
    }
  }, 60_000);

  it("native git reads the cache ours wrote: same status, and it finds the directories valid", async () => {
    const dir = join(root, "r");
    repo(dir);
    const ours = formatStatusPorcelain(await (await open(dir)).status().call());
    const written = await untr(dir);
    expect(written).toBeDefined();
    const cache = parseUntrackedCache(new Uint8Array(written as Buffer));
    expect(cache?.root?.valid).toBe(true);
    expect(git(dir, ["status", "--porcelain"])).toBe(ours);
    // nothing changed: native git takes every directory from the cache and keeps it as is
    expect((await untr(dir))?.equals(written as Buffer)).toBe(true);
    expect(git(dir, ["status", "--porcelain"], { GIT_DISABLE_UNTRACKED_CACHE: "1" })).toBe(ours);
  });

  it("ours reads the cache native git wrote and reports what changed since", async () => {
    const dir = join(root, "r");
    repo(dir);
    git(dir, ["status", "--porcelain"]);
    const nativeUntr = await untr(dir);
    // a change in a directory the cache has valid: its mtime moves on, so it is read again
    put(dir, "a/b/c/later.txt", "l\n");
    const status = await (await open(dir)).status().call();
    expect(status.untracked.has("a/b/c/later.txt")).toBe(true);
    expect(formatStatusPorcelain(status)).toBe(uncachedStatus(dir));
    expect((await untr(dir))?.equals(nativeUntr as Buffer)).toBe(false);
  });

  it("core.untrackedCache=false removes the cache; unset keeps it as it is", async () => {
    const dir = join(root, "r");
    repo(dir);
    await (await open(dir)).status().call();
    const written = await untr(dir);
    expect(written).toBeDefined();
    git(dir, ["config", "--unset", "core.untrackedCache"]);
    put(dir, "a/kept.txt", "k\n");
    dateBack(dir);
    // keep: used, but not written back for its own changes (git writes it only when true)
    const status = await (await open(dir)).status().call();
    expect(status.untracked.has("a/kept.txt")).toBe(true);
    expect((await untr(dir))?.equals(written as Buffer)).toBe(true);
    git(dir, ["config", "core.untrackedCache", "false"]);
    await (await open(dir)).status().call();
    expect(await untr(dir)).toBeUndefined();
    // the same as native git: an index without the extension
    expect(git(dir, ["status", "--porcelain"])).toBe(uncachedStatus(dir));
  });

  it("a cache made for status.showUntrackedFiles=normal is kept for that mode, untouched by -uall", async () => {
    const dir = join(root, "r");
    repo(dir);
    git(dir, ["config", "--unset", "status.showUntrackedFiles"]);
    git(dir, ["status", "--porcelain"]);
    const normal = await untr(dir);
    expect(normal).toBeDefined();
    expect(parseUntrackedCache(new Uint8Array(normal as Buffer))?.dirFlags).toBe(6);
    const status = await (await open(dir)).status().call();
    expect(formatStatusPorcelain(status)).toBe(git(dir, ["status", "--porcelain", "-uall"]));
    expect((await untr(dir))?.equals(normal as Buffer)).toBe(true);
  });

  it("an index edited by ours invalidates the directories of the paths it adds or removes, as git's", async () => {
    const dir = join(root, "r");
    repo(dir);
    git(dir, ["status", "--porcelain"]);
    for (const [path, op] of [
      ["a/new.txt", "add"],
      ["a/b/two.txt", "rm"],
      ["u/v/w.txt", "add"],
    ] as const) {
      const saved = saveIndex(dir);
      if (op === "add") git(dir, ["add", path]);
      else git(dir, ["rm", "-q", "--cached", path]);
      const nativeUntr = await untr(dir);
      restoreIndex(dir, saved);
      const ours = await open(dir);
      if (op === "add") await ours.add().addFilepattern(path).call();
      else await ours.rm().addFilepattern(path).setCached(true).call();
      expect((await untr(dir))?.equals(nativeUntr as Buffer), `${op} ${path}`).toBe(true);
    }
  });

  it("fuzz: random worktree and ignore changes never leave the status stale", async () => {
    const dir = join(root, "r");
    repo(dir);
    let seed = 0x5eed;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const dirs = ["", "a", "a/b", "a/b/c", "d", "e/f", "e/f/g", "u", "u/v", "n/m"];
    const names = ["p.txt", "q.log", "r.tmp", "keep.tmp", "s", ".gitignore"];
    const ignores = ["", "*.txt\n", "*.tmp\n!keep.tmp\n", "s\n", "q.log\n!q.log\n", "v/\n"];
    const untrackedNow = () =>
      git(dir, ["ls-files", "-o", "--exclude-standard"]).split("\n").filter(Boolean);
    for (let step = 0; step < 30; step++) {
      const at = dirs[rand(dirs.length)] as string;
      const name = names[rand(names.length)] as string;
      const path = at ? `${at}/${name}` : name;
      switch (rand(7)) {
        case 0:
        case 1:
          put(
            dir,
            path,
            name === ".gitignore" ? (ignores[rand(ignores.length)] as string) : `${step}\n`,
          );
          break;
        case 2: {
          const files = untrackedNow();
          const victim = files[rand(Math.max(1, files.length))];
          if (victim) rmSync(join(dir, victim), { force: true });
          break;
        }
        case 3: {
          const files = untrackedNow();
          const victim = files[rand(Math.max(1, files.length))];
          if (victim) renameSync(join(dir, victim), join(dir, `${victim}.moved`));
          break;
        }
        case 4:
          put(dir, ".git/info/exclude", ignores[rand(ignores.length)] as string);
          break;
        case 5: {
          const files = untrackedNow();
          const victim = files[rand(Math.max(1, files.length))];
          if (victim) git(dir, ["add", "--", victim]);
          break;
        }
        default:
          if (existsSync(join(dir, at || "."))) {
            rmSync(join(dir, at, "zz"), { recursive: true, force: true });
            put(dir, `${at ? `${at}/` : ""}zz/new-${step}`, "z\n");
          }
      }
      // half the steps not dated back: racy directories are read again
      if (rand(2) === 0) dateBack(dir);
      const keep = rand(2) === 0 ? "native" : "ours";
      const expected = uncachedStatus(dir);
      try {
        const status = await expectTwins(dir, keep);
        expect(formatStatusPorcelain(status)).toBe(expected);
      } catch (error) {
        throw new Error(`fuzz step ${step} (${path}): ${(error as Error).message}`);
      }
    }
  }, 120_000);

  it("a status over unwritten index edits writes a cache that matches the index on disk", async () => {
    const dir = join(root, "r");
    repo(dir);
    await (await open(dir)).status().call();
    put(dir, "u/v/x.txt", "x\n");
    dateBack(dir);
    const objectId = git(dir, ["hash-object", "-w", "u/v/x.txt"]).trim();
    const { git: ours, staging } = await openParts(dir);
    const editor = staging.createEditor();
    editor.upsert({ path: "u/v/x.txt", mode: 0o100644, objectId });
    await editor.finish();
    // the scan sees u/v/x.txt as tracked; the index file (refreshed, not written) does not
    const inMemory = await ours.status().call();
    expect(inMemory.untracked.has("u/v/x.txt")).toBe(false);
    const fresh = await (await open(dir)).status().call();
    expect(fresh.untracked.has("u/v/x.txt")).toBe(true);
    expect(formatStatusPorcelain(fresh)).toBe(uncachedStatus(dir));
    expect(git(dir, ["status", "--porcelain", "-uall"])).toBe(uncachedStatus(dir));
    expect(git(dir, ["status", "--porcelain", "-uall"])).toContain("?? u/v/x.txt");
  });

  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    it(`a missing ${flag.slice(2)} .gitignore is recorded as native git records it`, async () => {
      const dir = join(root, "r");
      repo(dir);
      put(dir, "d/x.tmp", "t\n");
      git(dir, ["status", "--porcelain"]);
      git(dir, ["update-index", flag, "d/.gitignore"]);
      rmSync(join(dir, "d/.gitignore"));
      dateBack(dir);
      await expectTwins(dir, "native");
      put(dir, "d/later.txt", "l\n");
      dateBack(dir);
      await expectTwins(dir, "ours");
      expect(git(dir, ["status", "--porcelain"])).toBe(uncachedStatus(dir));
    });
  }
});
