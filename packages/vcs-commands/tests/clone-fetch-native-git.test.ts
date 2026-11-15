/**
 * Clone and fetch against native git, both ways: our CloneCommand writes the same
 * `remote.*`/`branch.*` configuration and `refs/remotes/origin/HEAD` as `git clone` of
 * the same remote, native git reads our clone (upstream, `git status`, `git pull`), and
 * our FETCH_HEAD equals the one `git fetch` writes byte for byte (after the URL, which
 * differs: we reach the remote over `git http-backend`, native git through its path).
 *
 * Our repository is the files backend over a real directory; the remote is a bare
 * repository served by `git http-backend`.
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
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
import { createNodeFilesApi, NodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemoryWorkingCopy, type WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git, ResetMode, TagOption } from "../src/index.js";
import {
  type NativeGitHttpBackend,
  nativeGitAvailable,
  nativeGitEnv,
  nativeGitHttpBackend,
} from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() ? describe : describe.skip;

/** How our side reaches the remote; FETCH_HEAD shows it without `.git`. */
const URL = "http://git.test/src.git";

describeGit("clone and fetch parity with native git", () => {
  let root: string;
  let src: string;
  let backend: NativeGitHttpBackend;
  const originalFetch = globalThis.fetch;
  const opened: WorkingCopy[] = [];

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      env: nativeGitEnv(root),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  /** Commits `count` files on `branch` of the bare remote (through a scratch clone). */
  let commitCounter = 0;
  function commitOnRemote(branch: string, count = 1): string {
    const work = join(root, `work-${commitCounter++}`);
    git(root, "clone", "-q", src, work);
    if (git(src, "for-each-ref", `refs/heads/${branch}`)) {
      git(work, "checkout", "-q", "-B", branch, `origin/${branch}`);
    } else {
      git(work, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
    }
    for (let i = 0; i < count; i++) {
      writeFileSync(join(work, `f${commitCounter}-${i}.txt`), `${branch} ${commitCounter} ${i}\n`);
      git(work, "add", ".");
      git(work, "commit", "-q", "-m", `${branch} ${commitCounter} ${i}`);
    }
    git(work, "push", "-q", "origin", branch);
    rmSync(work, { recursive: true, force: true });
    return git(src, "rev-parse", `refs/heads/${branch}`);
  }

  /**
   * A files-backend working copy over `dir` (an empty `.git` is created). Its worktree is
   * `createNodeFilesApi`'s, which makes executables and symlinks, unless `modes` is false:
   * then it is a plain `NodeFilesApi`, without them, like a browser's.
   */
  async function openOurs(
    dir: string,
    { modes = true }: { modes?: boolean } = {},
  ): Promise<{ git: Git; workingCopy: WorkingCopy }> {
    mkdirSync(dir, { recursive: true });
    const files = createNodeFilesApi({ rootDir: dir });
    const worktreeFiles = modes ? files : new NodeFilesApi({ rootDir: dir });
    const { history } = await createGitFilesBackend({ files, create: true });
    await history.initialize();
    const config = new GitWorkingCopyConfig(
      {
        read: async (path) => {
          try {
            return new Uint8Array(readFileSync(join(dir, path)));
          } catch {
            return undefined;
          }
        },
        write: async (path, content) => writeFileSync(join(dir, path), content),
      },
      ".git/config",
    );
    await config.load();
    const checkoutFiles: GitCheckoutFilesApi = {
      read: async (path) => {
        try {
          return new Uint8Array(readFileSync(join(dir, path)));
        } catch {
          return undefined;
        }
      },
      write: (path, content) => files.write(path, content),
      stats: async (path) => {
        const s = await files.stats(path);
        return s ? { isDirectory: s.kind === "directory" } : undefined;
      },
      remove: async (path) => {
        await files.remove(path);
      },
    } as GitCheckoutFilesApi;
    const staging = new FileStagingStore(files, ".git/index");
    const checkout = new GitCheckout({
      staging,
      refs: history.refs,
      files: checkoutFiles,
      gitDir: ".git",
    });
    const worktree = createFileWorktree({
      files: worktreeFiles,
      rootPath: "",
      gitDir: ".git",
      blobs: history.blobs,
      trees: history.trees,
    });
    const workingCopy = new MemoryWorkingCopy({ history, checkout, worktree, config });
    opened.push(workingCopy);
    return { git: Git.fromWorkingCopy(workingCopy), workingCopy };
  }

  /** The `remote.*` and `branch.*` lines of `git config --list` in `repo`, URL normalised. */
  function remoteConfig(repo: string, url: string): string[] {
    return git(repo, "config", "--list", "--local")
      .split("\n")
      .filter((line) => /^(remote|branch)\./.test(line))
      .map((line) => line.replace(url, "<url>"))
      .sort();
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vcs-clone-parity-"));
    src = join(root, "src.git");
    git(root, "init", "-q", "--bare", "--initial-branch=main", src);
    commitOnRemote("main", 2);
    git(src, "branch", "feature", "main~1");
    git(src, "tag", "v0", "main~1");
    git(src, "tag", "-a", "v1", "-m", "release", "main");
    backend = nativeGitHttpBackend(root, root);
    globalThis.fetch = backend.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const wc of opened.splice(0)) await wc.close().catch(() => {});
    backend?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([
    { name: "default", ours: (c: CloneLike) => c, native: [] as string[] },
    {
      name: "--origin upstream",
      ours: (c: CloneLike) => c.setRemote("upstream"),
      native: ["-o", "upstream"],
    },
    { name: "--no-tags", ours: (c: CloneLike) => c.setNoTags(), native: ["--no-tags"] },
    {
      name: "--branch feature",
      ours: (c: CloneLike) => c.setBranch("feature"),
      native: ["-b", "feature"],
    },
    {
      name: "--single-branch --branch feature",
      ours: (c: CloneLike) => c.setBranch("feature").setSingleBranch(true),
      native: ["--single-branch", "-b", "feature"],
    },
    {
      name: "--single-branch --branch v1 (a tag)",
      ours: (c: CloneLike) => c.setBranch("v1").setSingleBranch(true),
      native: ["--single-branch", "-b", "v1"],
    },
    { name: "--bare", ours: (c: CloneLike) => c.setBare(true), native: ["--bare"] },
    { name: "--mirror", ours: (c: CloneLike) => c.setMirror(true), native: ["--mirror"] },
  ])("clone $name writes the configuration and remote HEAD native git writes", async (variant) => {
    const ours = join(root, "ours");
    const native = join(root, "native");
    const { git: ourGit } = await openOurs(ours);
    await variant.ours(ourGit.clone().setURI(URL)).call();
    git(root, "clone", "-q", ...variant.native, src, native);

    // native git reads our .git/config; for a bare clone both look at the config file
    const nativeGitDir = variant.native.includes("--bare") || variant.native.includes("--mirror");
    // git 2.49 made --mirror imply --no-tags (tagOpt); we write what current git writes
    const mirrorTagOpt = "remote.origin.tagopt=--no-tags";
    const expected = remoteConfig(native, src);
    if (variant.native.includes("--mirror") && !atLeast(git(root, "--version"), 2, 49)) {
      expected.push(mirrorTagOpt);
      expected.sort();
    }
    expect(remoteConfig(ours, URL)).toEqual(expected);
    expect(remoteConfig(ours, URL).length).toBeGreaterThan(0);

    const remote = variant.native.includes("upstream") ? "upstream" : "origin";
    const symref = (repo: string) => {
      try {
        return git(repo, "symbolic-ref", `refs/remotes/${remote}/HEAD`);
      } catch {
        return "<none>";
      }
    };
    expect(symref(ours)).toBe(symref(native));
    if (!nativeGitDir) {
      // the checked-out branch and its upstream, as native git resolves them
      expect(git(ours, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
        git(native, "rev-parse", "--abbrev-ref", "HEAD"),
      );
    }
  });

  it("native git sees the upstream of our clone: status, and pull fast-forwards", async () => {
    const ours = join(root, "ours");
    const { git: ourGit } = await openOurs(ours);
    await ourGit.clone().setURI(URL).call();
    // our clone writes the files and the index: native git finds nothing to report
    expect(git(ours, "status", "--porcelain")).toBe("");

    expect(git(ours, "rev-parse", "--abbrev-ref", "main@{upstream}")).toBe("origin/main");
    expect(git(ours, "status", "--porcelain=v2", "--branch")).toBe(
      [
        `# branch.oid ${git(src, "rev-parse", "main")}`,
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +0 -0",
      ].join("\n"),
    );

    const next = commitOnRemote("main");
    // native git cannot reach our test URL: point it at the same repository by path
    git(ours, "-c", `url.${src}.insteadOf=${URL}`, "pull", "-q", "--ff-only");
    expect(git(ours, "rev-parse", "HEAD")).toBe(next);
    expect(git(ours, "status", "--porcelain=v2", "--branch")).toContain("# branch.ab +0 -0");
  });

  it("FETCH_HEAD equals native git's, and native git merges it", async () => {
    const ours = join(root, "ours");
    const native = join(root, "native");
    const { git: ourGit, workingCopy } = await openOurs(ours);
    await ourGit.clone().setURI(URL).call();
    git(root, "clone", "-q", src, native);

    const shownNative = src.replace(/\.git$/, "");
    const shownOurs = "http://git.test/src";
    const compare = (label: string) => {
      const theirs = readFileSync(join(native, ".git/FETCH_HEAD"), "utf8");
      const mine = readFileSync(join(ours, ".git/FETCH_HEAD"), "utf8");
      expect(mine, label).toBe(theirs.replaceAll(shownNative, shownOurs));
      expect(mine.length, label).toBeGreaterThan(0);
    };

    // new commits on both branches, a tag of the new tip and one of an older new commit
    commitOnRemote("main", 2);
    git(src, "tag", "t-mid", "main~1");
    git(src, "tag", "-a", "t-tip", "-m", "tip", "main");
    commitOnRemote("feature");
    // a configured fetch: the upstream to merge, the rest, the followed tags
    await Git.fromWorkingCopy(workingCopy).fetch().call();
    git(native, "fetch", "-q");
    compare("git fetch");

    // explicit refspecs: everything they name is for merge
    await Git.fromWorkingCopy(workingCopy).fetch().setRefSpecs("feature", "main").call();
    git(native, "fetch", "-q", "origin", "feature", "main");
    compare("git fetch origin feature main");

    // --tags
    await Git.fromWorkingCopy(workingCopy).fetch().setTagOpt(TagOption.FETCH_TAGS).call();
    git(native, "fetch", "-q", "--tags");
    compare("git fetch --tags");

    // native git reads our FETCH_HEAD: its first line is the upstream branch
    await Git.fromWorkingCopy(workingCopy).fetch().call();
    expect(git(ours, "rev-parse", "FETCH_HEAD")).toBe(git(src, "rev-parse", "main"));
    git(ours, "merge", "-q", "--ff-only", "FETCH_HEAD");
    expect(git(ours, "rev-parse", "HEAD")).toBe(git(src, "rev-parse", "main"));
  });

  it("FETCH_HEAD equals native git's for other remotes, upstream remotes without fetch lines, repeated refs", async () => {
    const ours = join(root, "ours");
    const native = join(root, "native");
    const { git: ourGit, workingCopy } = await openOurs(ours);
    await ourGit.clone().setURI(URL).call();
    git(root, "clone", "-q", src, native);
    const config = workingCopy.config as unknown as GitWorkingCopyConfig;
    const set = (key: string, ourValue: string, nativeValue = ourValue) => {
      config.set(key, ourValue);
      git(native, "config", key, nativeValue);
    };
    const compare = (label: string) => {
      const theirs = readFileSync(join(native, ".git/FETCH_HEAD"), "utf8");
      const mine = readFileSync(join(ours, ".git/FETCH_HEAD"), "utf8");
      expect(mine, label).toBe(theirs.replaceAll(src.replace(/\.git$/, ""), "http://git.test/src"));
      expect(mine.length, label).toBeGreaterThan(0);
    };
    const fetch = () => Git.fromWorkingCopy(workingCopy).fetch();

    // main's upstream is origin: an exact first refspec of another remote is not for merge
    set("remote.up2.url", URL, src);
    set("remote.up2.fetch", "+refs/heads/feature:refs/remotes/up2/feature");
    await fetch().setRemote("up2").call();
    git(native, "fetch", "-q", "up2");
    compare("git fetch up2 (upstream on origin)");

    // a remote without fetch lines that is main's upstream: its merge refs, for merge
    set("remote.up3.url", URL, src);
    set("branch.main.remote", "up3");
    set("branch.main.merge", "refs/heads/feature");
    await fetch().setRemote("up3").call();
    git(native, "fetch", "-q", "up3");
    compare("git fetch up3 (no fetch lines, upstream)");

    // a ref named twice without destination is listed twice
    await fetch().setRemote("origin").setRefSpecs("main", "main").call();
    git(native, "fetch", "-q", "origin", "main", "main");
    compare("git fetch origin main main");
  });

  it("a fetch of a URL without configuration: FETCH_HEAD holds the remote HEAD alone", async () => {
    const ours = join(root, "ours");
    const native = join(root, "native");
    const { git: ourGit } = await openOurs(ours);
    git(root, "init", "-q", "--initial-branch=main", native);

    await ourGit.fetch().setRemote(URL).call();
    git(native, "fetch", "-q", src);

    const theirs = readFileSync(join(native, ".git/FETCH_HEAD"), "utf8");
    const mine = readFileSync(join(ours, ".git/FETCH_HEAD"), "utf8");
    expect(mine).toBe(theirs.replace(src.replace(/\.git$/, ""), "http://git.test/src"));
    expect(mine).toMatch(/^[0-9a-f]{40}\t\thttp:\/\/git\.test\/src\n$/);
  });

  /**
   * Commits on main of the remote: an executable, a symlink to a nested file, a
   * dangling symlink, nested directories and a submodule (a gitlink to the remote's
   * first commit, without .gitmodules).
   */
  function commitModesOnRemote(): void {
    const work = join(root, `work-${commitCounter++}`);
    git(root, "clone", "-q", src, work);
    mkdirSync(join(work, "dir/nested/deeper"), { recursive: true });
    writeFileSync(join(work, "dir/nested/deeper/file.txt"), "deep\n");
    writeFileSync(join(work, "dir/top.txt"), "top\n");
    writeFileSync(join(work, "run.sh"), "#!/bin/sh\necho hi\n");
    chmodSync(join(work, "run.sh"), 0o755);
    symlinkSync("dir/nested/deeper/file.txt", join(work, "link"));
    symlinkSync("missing/target", join(work, "dangling"));
    git(work, "add", ".");
    const first = git(work, "rev-list", "--max-parents=0", "HEAD");
    git(work, "update-index", "--add", "--cacheinfo", `160000,${first},sub`);
    git(work, "commit", "-q", "-m", "modes");
    git(work, "push", "-q", "origin", "main");
    rmSync(work, { recursive: true, force: true });
  }

  /** What a checkout holds at `path`: kind, mode bits that git tracks, content. */
  function describePath(repo: string, path: string): string {
    const full = join(repo, path);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) return `link -> ${readlinkSync(full)}`;
    if (stat.isDirectory()) return `dir [${readdirSync(full).join(",")}]`;
    const exec = (statSync(full).mode & 0o100) !== 0 ? "exec" : "file";
    return `${exec} ${readFileSync(full, "utf8")}`;
  }

  it("clone writes executables, symlinks, nested dirs and submodule dirs as git clone does", async () => {
    commitModesOnRemote();
    const ours = join(root, "ours");
    const native = join(root, "native");
    const { git: ourGit } = await openOurs(ours);
    await ourGit.clone().setURI(URL).call();
    git(root, "clone", "-q", src, native);

    // the index as native git reads it: modes, ids and paths
    expect(git(ours, "ls-files", "-s")).toBe(git(native, "ls-files", "-s"));
    // the files, path by path
    const paths = git(native, "ls-files").split("\n");
    expect(paths).toEqual(expect.arrayContaining(["dangling", "link", "run.sh", "sub"]));
    for (const path of paths) {
      expect(describePath(ours, path), path).toBe(describePath(native, path));
    }
    // the stat data is recorded (a link's own, from lstat): nothing looks changed before a
    // refresh. The index has no ino, dev, uid or gid (FilesApi gives none), so only a
    // minimal stat check passes; default git refreshes once (diff-files reports until then)
    const changed = git(
      ours,
      "-c",
      "core.checkStat=minimal",
      "-c",
      "core.trustctime=false",
      "diff-files",
      "--name-only",
    );
    expect(changed).toBe("");
    expect(git(ours, "status", "--porcelain")).toBe("");
    expect(git(ours, "config", "--get", "core.filemode")).toBe("true");
  });

  it("clone into a worktree without modes or links: core.filemode/core.symlinks false", async () => {
    commitModesOnRemote();
    const ours = join(root, "ours");
    const { git: ourGit } = await openOurs(ours, { modes: false });
    await ourGit.clone().setURI(URL).call();

    expect(git(ours, "config", "--get", "core.filemode")).toBe("false");
    expect(git(ours, "config", "--get", "core.symlinks")).toBe("false");
    // git with core.symlinks=false: a plain file holding the target
    expect(describePath(ours, "link")).toBe("file dir/nested/deeper/file.txt");
    expect(git(ours, "ls-files", "-s", "link")).toMatch(/^120000 /);
    expect(git(ours, "status", "--porcelain")).toBe("");
  });

  it("clone --no-checkout writes no files and no index, as git clone does", async () => {
    const ours = join(root, "ours");
    const native = join(root, "native");
    const { git: ourGit } = await openOurs(ours);
    await ourGit.clone().setURI(URL).setNoCheckout(true).call();
    git(root, "clone", "-q", "--no-checkout", src, native);

    expect(readdirSync(ours)).toEqual([".git"]);
    expect(readdirSync(native)).toEqual([".git"]);
    expect(existsSync(join(ours, ".git/index"))).toBe(existsSync(join(native, ".git/index")));
    expect(existsSync(join(ours, ".git/index"))).toBe(false);
    expect(git(ours, "status", "--porcelain")).toBe(git(native, "status", "--porcelain"));
  });

  it("clone --bare writes no worktree files and no index", async () => {
    const ours = join(root, "ours");
    const { git: ourGit } = await openOurs(ours);
    await ourGit.clone().setURI(URL).setBare(true).call();

    expect(readdirSync(ours)).toEqual([".git"]);
    expect(existsSync(join(ours, ".git/index"))).toBe(false);
  });
});

/** Whether `git version X.Y.Z` is at least `major.minor`. */
function atLeast(versionLine: string, major: number, minor: number): boolean {
  const match = /(\d+)\.(\d+)/.exec(versionLine);
  if (!match) return true;
  const [maj, min] = [Number(match[1]), Number(match[2])];
  return maj > major || (maj === major && min >= minor);
}

/** The clone options the variants set. */
type CloneLike = ReturnType<Git["clone"]>;

describeGit("clone, add and reset never follow symbolic links (native git)", () => {
  let root: string;
  let src: string;
  let backend: NativeGitHttpBackend;
  const originalFetch = globalThis.fetch;
  const opened: WorkingCopy[] = [];

  const run = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      env: nativeGitEnv(root),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  /** Our working copy over `dir`: the files backend, a FileWorktree over `files`. */
  async function open(dir: string, modes = true): Promise<{ ours: Git; wc: WorkingCopy }> {
    mkdirSync(dir, { recursive: true });
    const files = createNodeFilesApi({ rootDir: dir });
    const { history } = await createGitFilesBackend({ files, create: true });
    await history.initialize();
    const config = new GitWorkingCopyConfig(
      {
        read: async (path) => {
          try {
            return new Uint8Array(readFileSync(join(dir, path)));
          } catch {
            return undefined;
          }
        },
        write: async (path, content) => writeFileSync(join(dir, path), content),
      },
      ".git/config",
    );
    await config.load();
    const staging = new FileStagingStore(files, ".git/index");
    const checkout = new GitCheckout({
      staging,
      refs: history.refs,
      files: {
        read: async (path: string) => {
          try {
            return new Uint8Array(readFileSync(join(dir, path)));
          } catch {
            return undefined;
          }
        },
        write: (path: string, content: Uint8Array) => files.write(path, [content]),
        stats: async () => undefined,
        remove: async () => {},
      } as unknown as GitCheckoutFilesApi,
      gitDir: ".git",
    });
    const worktree = createFileWorktree({
      files: modes ? files : new NodeFilesApi({ rootDir: dir }),
      rootPath: "",
      gitDir: ".git",
      blobs: history.blobs,
      trees: history.trees,
    });
    const wc = new MemoryWorkingCopy({ history, checkout, worktree, config });
    opened.push(wc);
    return { ours: Git.fromWorkingCopy(wc), wc };
  }

  /**
   * The remote: branch `links` has `x -> ../outside.txt`, `d -> ../outdir`, a dangling
   * link and an executable; `main` replaces the links with a file `x` and `d/evil.txt`.
   */
  function linksRemote(): void {
    const work = join(root, "work");
    run(root, "clone", "-q", src, work);
    run(work, "symbolic-ref", "HEAD", "refs/heads/main");
    writeFileSync(join(work, "a.txt"), "hello\n");
    writeFileSync(join(work, "run.sh"), "#!/bin/sh\n");
    chmodSync(join(work, "run.sh"), 0o755);
    symlinkSync("../outside.txt", join(work, "x"));
    symlinkSync("../outdir", join(work, "d"));
    symlinkSync("missing", join(work, "dangling"));
    run(work, "add", ".");
    run(work, "commit", "-q", "-m", "links");
    run(work, "branch", "links");
    run(work, "rm", "-q", "x", "d", "dangling");
    writeFileSync(join(work, "x"), "PWNED\n");
    mkdirSync(join(work, "d"));
    writeFileSync(join(work, "d/evil.txt"), "EVIL\n");
    run(work, "add", ".");
    run(work, "commit", "-q", "-m", "files");
    run(work, "push", "-q", "origin", "main", "links");
    rmSync(work, { recursive: true, force: true });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "vcs-clone-links-"));
    src = join(root, "src.git");
    run(root, "init", "-q", "--bare", "--initial-branch=main", src);
    writeFileSync(join(root, "outside.txt"), "original\n");
    mkdirSync(join(root, "outdir"));
    writeFileSync(join(root, "outdir/secret.txt"), "s\n");
    linksRemote();
    backend = nativeGitHttpBackend(root, root);
    globalThis.fetch = backend.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    for (const wc of opened.splice(0)) await wc.close().catch(() => {});
    backend?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("reset --hard from links to files replaces the links, never writing through them", async () => {
    const dir = join(root, "ours");
    const { ours } = await open(dir);
    await ours.clone().setURI(URL).setBranch("links").call();
    expect(readlinkSync(join(dir, "x"))).toBe("../outside.txt");
    // (no native command here: one that refreshes the index would make ours re-read it)

    await ours.reset().setMode(ResetMode.HARD).setRef("refs/remotes/origin/main").call();

    expect(readFileSync(join(root, "outside.txt"), "utf8")).toBe("original\n");
    expect(readdirSync(join(root, "outdir"))).toEqual(["secret.txt"]);
    expect(lstatSync(join(dir, "x")).isFile()).toBe(true);
    expect(readFileSync(join(dir, "x"), "utf8")).toBe("PWNED\n");
    expect(lstatSync(join(dir, "d")).isDirectory()).toBe(true);
    expect(readFileSync(join(dir, "d/evil.txt"), "utf8")).toBe("EVIL\n");
    // the dangling link the target tree drops is unlinked
    expect(() => lstatSync(join(dir, "dangling"))).toThrow();
    expect(run(dir, "status", "--porcelain")).toBe("");
  });

  it("an untracked link to .git/hooks is replaced by reset --hard, never written through", async () => {
    const dir = join(root, "ours");
    const { ours } = await open(dir);
    // nothing checked out, nothing tracked: `d` linking into .git/hooks stands in the way
    await ours.clone().setURI(URL).setNoCheckout(true).call();
    mkdirSync(join(dir, ".git/hooks"), { recursive: true });
    writeFileSync(join(dir, ".git/hooks/pre-commit.sample"), "#!/bin/sh\n");
    symlinkSync(".git/hooks", join(dir, "d"));
    const hooks = readdirSync(join(dir, ".git/hooks"));

    // as git's create_directories with force: the link is unlinked, `d` made a directory
    await ours.reset().setMode(ResetMode.HARD).setRef("refs/remotes/origin/main").call();
    expect(readdirSync(join(dir, ".git/hooks"))).toEqual(hooks);
    expect(existsSync(join(dir, ".git/hooks/evil.txt"))).toBe(false);
    expect(lstatSync(join(dir, "d")).isDirectory()).toBe(true);
    expect(readFileSync(join(dir, "d/evil.txt"), "utf8")).toBe("EVIL\n");
  });

  it("add after clone stages links and modes as native git", async () => {
    const dir = join(root, "ours");
    const native = join(root, "native");
    const { ours } = await open(dir);
    await ours.clone().setURI(URL).setBranch("links").call();
    run(root, "clone", "-q", "-b", "links", src, native);

    await ours.add().addFilepattern(".").call();
    expect(run(dir, "ls-files", "-s")).toBe(run(native, "ls-files", "-s"));
    // the link's blob is its target, never the content of the file it names
    expect(run(dir, "ls-files", "-s", "x")).toBe(`120000 ${run(src, "rev-parse", "links:x")} 0\tx`);
    expect(run(dir, "status", "--porcelain")).toBe("");
  });

  it("add after a clone without modes or links keeps 100755 and 120000 (core.* false)", async () => {
    const dir = join(root, "ours");
    const native = join(root, "native");
    const { ours } = await open(dir, false);
    await ours.clone().setURI(URL).setBranch("links").call();
    run(root, "clone", "-q", "-b", "links", src, native);
    expect(run(dir, "config", "--get", "core.filemode")).toBe("false");
    expect(run(dir, "config", "--get", "core.symlinks")).toBe("false");

    await ours.add().addFilepattern(".").call();
    expect(run(dir, "ls-files", "-s")).toBe(run(native, "ls-files", "-s"));
    expect(run(dir, "status", "--porcelain")).toBe("");
  });
  it.skipIf(process.platform === "win32")(
    "a path with a backslash checks out as a file name, as native git on POSIX",
    async () => {
      const work = join(root, "work-bs");
      run(root, "clone", "-q", "-b", "main", src, work);
      writeFileSync(join(work, "a\\b.txt"), "backslash\n");
      run(work, "add", ".");
      run(work, "commit", "-q", "-m", "backslash");
      run(work, "push", "-q", "origin", "main");
      const dir = join(root, "ours");
      const native = join(root, "native");
      const { ours } = await open(dir);
      await ours.clone().setURI(URL).call();
      run(root, "clone", "-q", src, native);

      expect(run(dir, "ls-files", "-s")).toBe(run(native, "ls-files", "-s"));
      expect(readFileSync(join(dir, "a\\b.txt"), "utf8")).toBe("backslash\n");
      expect(readdirSync(dir).sort()).toEqual(readdirSync(native).sort());
      expect(run(dir, "status", "--porcelain")).toBe("");
    },
  );
  /** On the remote: branch `two` from main, with gone.txt removed and new.txt added. */
  function twoBranches(): void {
    const work = join(root, "work-two");
    run(root, "clone", "-q", "-b", "main", src, work);
    writeFileSync(join(work, "gone.txt"), "gone\n");
    writeFileSync(join(work, "same.txt"), "same\n");
    run(work, "add", ".");
    run(work, "commit", "-q", "-m", "gone and same");
    run(work, "push", "-q", "origin", "main");
    run(work, "checkout", "-q", "-b", "two");
    run(work, "rm", "-q", "gone.txt");
    writeFileSync(join(work, "new.txt"), "new\n");
    run(work, "add", ".");
    run(work, "commit", "-q", "-m", "two");
    run(work, "push", "-q", "origin", "two");
    rmSync(work, { recursive: true, force: true });
  }

  /** What native `git checkout <args>` printed on failure (stderr), or "" on success. */
  function nativeCheckout(dir: string, ...args: string[]): string {
    try {
      run(dir, "checkout", "-q", ...args);
      return "";
    } catch (error) {
      return String((error as { stderr?: string }).stderr ?? "").trim();
    }
  }

  it("checkout keeps unstaged edits and refuses to overwrite them, as native git", async () => {
    twoBranches();
    const dir = join(root, "ours");
    const native = join(root, "native");
    const { ours } = await open(dir);
    await ours.clone().setURI(URL).call();
    run(root, "clone", "-q", src, native);
    run(native, "branch", "-q", "two", "origin/two");
    await ours.branchCreate().setName("two").setStartPoint("refs/remotes/origin/two").call();

    // an edit of a file the target deletes: refused, the edit kept
    for (const d of [dir, native]) writeFileSync(join(d, "gone.txt"), "EDITED\n");
    const refused = await ours.checkout().setName("two").call();
    const expected = nativeCheckout(native, "two");
    expect(expected).toContain("would be overwritten by checkout");
    expect(refused.status).toBe("CONFLICTS");
    expect(refused.message).toBe(expected);
    expect(readFileSync(join(dir, "gone.txt"), "utf8")).toBe("EDITED\n");

    // an untracked file where the target writes one: refused too
    for (const d of [dir, native]) {
      writeFileSync(join(d, "gone.txt"), "gone\n");
      writeFileSync(join(d, "new.txt"), "UNTRACKED\n");
    }
    const untracked = await ours.checkout().setName("two").call();
    const expectedUntracked = nativeCheckout(native, "two");
    expect(expectedUntracked).toContain("untracked working tree files would be overwritten");
    expect(untracked.message).toBe(expectedUntracked);
    expect(readFileSync(join(dir, "new.txt"), "utf8")).toBe("UNTRACKED\n");

    // an edit of a file both branches agree on survives the switch
    for (const d of [dir, native]) {
      rmSync(join(d, "new.txt"));
      writeFileSync(join(d, "same.txt"), "LOCAL EDIT\n");
    }
    const switched = await ours.checkout().setName("two").call();
    expect(nativeCheckout(native, "two")).toBe("");
    expect(switched.status).toBe("OK");
    for (const d of [dir, native]) {
      expect(readFileSync(join(d, "same.txt"), "utf8")).toBe("LOCAL EDIT\n");
      expect(existsSync(join(d, "gone.txt"))).toBe(false);
      expect(readFileSync(join(d, "new.txt"), "utf8")).toBe("new\n");
    }
    expect(run(dir, "status", "--porcelain")).toBe(run(native, "status", "--porcelain"));
  });
  /** Our stash of `files` (path -> content) over HEAD's tree, as `git stash` records one. */
  async function ourStash(wc: WorkingCopy, files: Record<string, string>): Promise<void> {
    const { trees, blobs, commits, refs } = wc.history;
    const head = (await refs.resolve("HEAD"))?.objectId ?? "";
    const headTree = (await commits.load(head))?.tree ?? "";
    const entries = new Map<string, { name: string; mode: number; id: string }>();
    for await (const entry of (await trees.load(headTree)) ?? []) entries.set(entry.name, entry);
    for (const [name, content] of Object.entries(files)) {
      entries.set(name, {
        name,
        mode: 0o100644,
        id: await blobs.store([new TextEncoder().encode(content)]),
      });
    }
    const tree = await trees.store([...entries.values()]);
    const who = {
      name: "Interop Tester",
      email: "interop@example.com",
      timestamp: 1112911993,
      tzOffset: "+0000",
    };
    const index = await commits.store({
      tree,
      parents: [head],
      author: who,
      committer: who,
      message: "index",
    });
    const stash = await commits.store({
      tree,
      parents: [head, index],
      author: who,
      committer: who,
      message: "WIP",
    });
    await refs.set("refs/stash", stash);
  }

  /** What native `git <args>` printed on failure (stderr), or "" on success. */
  function nativeFails(dir: string, ...args: string[]): string {
    try {
      run(dir, ...args);
      return "";
    } catch (error) {
      return String((error as { stderr?: string }).stderr ?? "").trim();
    }
  }

  it("stash apply refuses as native git: untracked directory, local changes", async () => {
    twoBranches();
    const dir = join(root, "ours");
    const native = join(root, "native");
    const { ours, wc } = await open(dir);
    await ours.clone().setURI(URL).call();
    run(root, "clone", "-q", src, native);

    // a stash adding `spot`, an untracked directory `spot/` in the way
    writeFileSync(join(native, "spot"), "spot\n");
    run(native, "add", "spot");
    run(native, "stash", "-q");
    await ourStash(wc, { spot: "spot\n" });
    for (const d of [dir, native]) {
      mkdirSync(join(d, "spot"));
      writeFileSync(join(d, "spot/precious.txt"), "precious\n");
    }
    const expectedDir = nativeFails(native, "stash", "apply");
    expect(expectedDir).toContain("would lose untracked files");
    const errorDir = await ours
      .stashApply()
      .call()
      .catch((e: Error) => e);
    expect((errorDir as Error).message).toBe(expectedDir);
    for (const d of [dir, native]) {
      expect(readFileSync(join(d, "spot/precious.txt"), "utf8")).toBe("precious\n");
      rmSync(join(d, "spot"), { recursive: true });
    }

    // a stash changing same.txt, edited in the worktree meanwhile
    run(native, "stash", "drop", "-q");
    writeFileSync(join(native, "same.txt"), "stashed\n");
    run(native, "stash", "-q");
    await ourStash(wc, { "same.txt": "stashed\n" });
    for (const d of [dir, native]) writeFileSync(join(d, "same.txt"), "EDITED\n");
    const expectedLocal = nativeFails(native, "stash", "apply");
    expect(expectedLocal).toContain("would be overwritten by merge");
    const errorLocal = await ours
      .stashApply()
      .call()
      .catch((e: Error) => e);
    expect((errorLocal as Error).message).toBe(expectedLocal);
    expect(readFileSync(join(dir, "same.txt"), "utf8")).toBe("EDITED\n");
  });

  it("checkout refusals read as native git: directories, leading files, staged deletions", async () => {
    const work = join(root, "work-dirs");
    run(root, "clone", "-q", "-b", "main", src, work);
    mkdirSync(join(work, "dd"));
    writeFileSync(join(work, "dd/x"), "x\n");
    writeFileSync(join(work, "gone"), "g\n");
    run(work, "add", ".");
    run(work, "commit", "-q", "-m", "dirs");
    run(work, "push", "-q", "origin", "main");
    run(work, "checkout", "-q", "-b", "flip");
    run(work, "rm", "-q", "-r", "dd", "gone");
    writeFileSync(join(work, "dd"), "file\n");
    mkdirSync(join(work, "lead"));
    writeFileSync(join(work, "lead/x"), "x\n");
    run(work, "add", ".");
    run(work, "commit", "-q", "-m", "flip");
    run(work, "push", "-q", "origin", "flip");
    rmSync(work, { recursive: true, force: true });

    const dir = join(root, "ours");
    const native = join(root, "native");
    const { ours, wc } = await open(dir);
    await ours.clone().setURI(URL).call();
    run(root, "clone", "-q", src, native);
    run(native, "branch", "-q", "flip", "origin/flip");
    await ours.branchCreate().setName("flip").setStartPoint("refs/remotes/origin/flip").call();

    // untracked files in a directory a file replaces, an untracked file on a leading
    // component, a staged deletion of a file the target deletes too
    for (const d of [dir, native]) {
      writeFileSync(join(d, "dd/extra"), "untracked\n");
      writeFileSync(join(d, "lead"), "untracked\n");
    }
    run(native, "rm", "-q", "--cached", "gone");
    await wc.checkout.staging.removeEntry("gone");
    const expected = nativeFails(native, "checkout", "-q", "flip");
    const refused = await ours.checkout().setName("flip").call();
    expect(refused.message).toBe(expected);
    expect(readFileSync(join(dir, "dd/x"), "utf8")).toBe("x\n");
  });
});
