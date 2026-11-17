/**
 * A repository whose `.git` (or `.git/objects`) is a symbolic link the user made works as in
 * git: the link is resolved once through the FilesApi (openLinkTarget, or lexically for a
 * simulated FilesApi) and mounted. A link the stores would have to cross elsewhere fails
 * loudly, never as an empty repository.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createInMemoryFilesApi, createSymlinkFilesApi } from "@statewalker/vcs-core";
import { createFileWorktree, createGitFilesBackend } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  openRepositoryFiles,
  PosixNodeFilesApi,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const env = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  GIT_AUTHOR_NAME: "T",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "T",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit || process.platform === "win32")(
  "a symlinked .git (real directory)",
  () => {
    let base: string;
    beforeEach(() => {
      base = mkdtempSync(join(tmpdir(), "linked-git-"));
      git(base, "init", "-q", "--initial-branch=main", "real");
      git(join(base, "real"), "commit", "-q", "--allow-empty", "-m", "first");
    });
    afterEach(() => rmSync(base, { recursive: true, force: true }));

    it("follows a .git linked outside the worktree, as git does", async () => {
      mkdirSync(join(base, "work"));
      symlinkSync(join(base, "real/.git"), join(base, "work/.git"));
      const files = new PosixNodeFilesApi({ rootDir: join(base, "work"), openLinkTargets: true });
      const { history } = await createGitFilesBackend({ files });
      expect((await history.refs.resolve("HEAD"))?.objectId).toBe(
        git(join(base, "real"), "rev-parse", "HEAD"),
      );
    });

    it("follows .git/objects linked elsewhere", async () => {
      git(base, "init", "-q", "--initial-branch=main", "split");
      const split = join(base, "split");
      rmSync(join(split, ".git/objects"), { recursive: true });
      symlinkSync(join(base, "real/.git/objects"), join(split, ".git/objects"));
      git(split, "update-ref", "refs/heads/main", git(join(base, "real"), "rev-parse", "HEAD"));
      const { history } = await createGitFilesBackend({
        files: new PosixNodeFilesApi({ rootDir: split, openLinkTargets: true }),
      });
      const head = (await history.refs.resolve("HEAD"))?.objectId ?? "";
      expect(await history.commits.load(head)).toBeDefined();
    });

    it("fails loudly on a link it must not follow, never reading an empty repository", async () => {
      const repo = join(base, "real");
      rmSync(join(repo, ".git/refs/heads"), { recursive: true });
      mkdirSync(join(base, "heads"));
      symlinkSync(join(base, "heads"), join(repo, ".git/refs/heads"));
      const { history } = await createGitFilesBackend({
        files: new PosixNodeFilesApi({ rootDir: repo }),
      });
      await expect(history.refs.resolve("HEAD")).rejects.toThrow(/symbolic link/);
    });
  },
);

describe("a symlinked .git (simulated links)", () => {
  it("follows a .git linked within the FilesApi", async () => {
    const files = createSymlinkFilesApi(createInMemoryFilesApi());
    const store = await createGitFilesBackend({ files, gitDir: "/store/git", create: true });
    const empty = await store.history.trees.store([]);
    const commit = await store.history.commits.store({
      tree: empty,
      parents: [],
      author: { name: "T", email: "t@e", timestamp: 0, tzOffset: "+0000" },
      committer: { name: "T", email: "t@e", timestamp: 0, tzOffset: "+0000" },
      message: "m",
    });
    await store.history.refs.set("refs/heads/main", commit);
    await files.mkdir("/work");
    await files.symlink?.(new TextEncoder().encode("../store/git"), "/work/.git");
    const { history } = await createGitFilesBackend({ files, gitDir: "/work/.git" });
    expect((await history.refs.resolve("HEAD"))?.objectId).toBe(commit);
  });
});

describe.skipIf(!hasGit || process.platform === "win32")("openLinkTarget is opt-in", () => {
  it("never reaches outside the root unless enabled", async () => {
    const base = mkdtempSync(join(tmpdir(), "linked-git-optin-"));
    try {
      git(base, "init", "-q", "--initial-branch=main", "real");
      mkdirSync(join(base, "work"));
      symlinkSync(join(base, "real/.git"), join(base, "work/.git"));
      const files = new PosixNodeFilesApi({ rootDir: join(base, "work") });
      expect(await files.openLinkTarget("/.git")).toBeUndefined();
      await expect(createGitFilesBackend({ files })).rejects.toThrow(/symbolic link/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasGit || process.platform === "win32")("openRepositoryFiles", () => {
  it("follows a .git linked outside the root, and no other link", async () => {
    const base = mkdtempSync(join(tmpdir(), "open-repo-files-"));
    try {
      git(base, "init", "-q", "--initial-branch=main", "real");
      git(join(base, "real"), "commit", "-q", "--allow-empty", "-m", "first");
      mkdirSync(join(base, "work"));
      mkdirSync(join(base, "outdir"));
      symlinkSync(join(base, "real/.git"), join(base, "work/.git"));
      symlinkSync(join(base, "outdir"), join(base, "work/elsewhere"));
      const files = await openRepositoryFiles(join(base, "work"));
      const { history } = await createGitFilesBackend({ files });
      expect((await history.refs.resolve("HEAD"))?.objectId).toBe(
        git(join(base, "real"), "rev-parse", "HEAD"),
      );
      expect(await files.openLinkTarget?.("/elsewhere")).toBeUndefined();
      await expect(files.write("/elsewhere/x", [new Uint8Array([1])])).rejects.toThrow(
        /symbolic link/,
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!hasGit || process.platform !== "linux")(
  "a symlinked .git whose target is no UTF-8",
  () => {
    it("resolves the link target as its bytes (a latin-1 directory name)", async () => {
      const base = mkdtempSync(join(tmpdir(), "linked-git-latin1-"));
      try {
        git(base, "init", "-q", "--initial-branch=main", "work");
        const work = join(base, "work");
        git(work, "commit", "-q", "--allow-empty", "-m", "first");
        const head = git(work, "rev-parse", "HEAD");
        // the repository moves to "caf\xe9-git" (latin-1) in the worktree; .git links to it
        const target = Buffer.from("caf\xe9-git", "latin1");
        renameSync(join(work, ".git"), Buffer.concat([Buffer.from(`${work}/`), target]));
        symlinkSync(target, join(work, ".git"));
        const files = new PosixNodeFilesApi({ rootDir: work });
        const { history } = await createGitFilesBackend({ files });
        expect((await history.refs.resolve("HEAD"))?.objectId).toBe(head);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  },
);

describe.skipIf(!hasGit || process.platform !== "linux")(
  "a nested repository whose .git links to a directory named in latin-1",
  () => {
    it("is a repository, not a dangling link (as git sees it)", async () => {
      const base = mkdtempSync(join(tmpdir(), "nested-latin1-"));
      try {
        git(base, "init", "-q", "--initial-branch=main", ".");
        mkdirSync(join(base, "sub"));
        git(join(base, "sub"), "init", "-q", "--initial-branch=main", ".");
        writeFileSync(join(base, "sub", "f"), "x\n");
        git(join(base, "sub"), "add", "f");
        git(join(base, "sub"), "commit", "-q", "-m", "m");
        const target = Buffer.from("caf\xe9-git", "latin1");
        renameSync(join(base, "sub", ".git"), Buffer.concat([Buffer.from(`${base}/sub/`), target]));
        symlinkSync(target, join(base, "sub", ".git"));
        // git sees one untracked nested repository, not its files
        expect(git(base, "status", "--porcelain", "-uall")).toBe("?? sub/");
        const files = createNodeFilesApi({ rootDir: base });
        const worktree = createFileWorktree({ files, rootPath: "", gitDir: ".git" } as never);
        const state = await worktree.repositoryState?.("sub");
        expect(state).toBeDefined();
        expect(state).not.toBe("none");
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    });
  },
);
