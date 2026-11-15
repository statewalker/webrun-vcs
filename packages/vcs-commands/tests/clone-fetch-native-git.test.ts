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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { MemoryWorkingCopy, type WorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Git, TagOption } from "../src/index.js";
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

  /** A files-backend working copy over `dir` (an empty `.git` is created). */
  async function openOurs(dir: string): Promise<{ git: Git; workingCopy: WorkingCopy }> {
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
      files,
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
    // our clone fills the index, not the files: let native git write them
    git(ours, "checkout", "-q", "--", ".");

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
    git(ours, "checkout", "-q", "--", ".");
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
