/**
 * Repository discovery's stops against native git's (setup.c's `repo_discovery_find_dir`):
 * `$GIT_CEILING_DIRECTORIES` (entries canonicalised until an empty one, relative ones
 * ignored, the ceiling itself never searched) compared with `git rev-parse --absolute-git-dir`
 * run in the same directory, outcome and message; and the file system boundary
 * (`$GIT_DISCOVERY_ACROSS_FILESYSTEM`), which needs a second device, through a FilesApi whose
 * `lstat` reports one.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  discoverRepository,
  FilesystemBoundaryError,
  NotAGitRepositoryError,
} from "../src/index.js";

const nativeGit = spawnSync("git", ["--version"]).status === 0;
const describeGit = nativeGit && process.platform !== "win32" ? describe : describe.skip;

let T = "";

const envOf = (over: Record<string, string>): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: T,
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  ...(process.env.GIT_EXEC_PATH ? { GIT_EXEC_PATH: process.env.GIT_EXEC_PATH } : {}),
  ...over,
});

type Outcome = { exit: number; out: string };

function native(cwd: string, over: Record<string, string>): Outcome {
  const run = spawnSync("git", ["rev-parse", "--absolute-git-dir"], {
    cwd,
    env: envOf(over),
    encoding: "utf8",
  });
  return { exit: run.status ?? -1, out: run.status === 0 ? run.stdout : run.stderr };
}

async function ours(cwd: string, over: Record<string, string>): Promise<Outcome> {
  const files = createNodeFilesApi({ rootDir: "/" });
  const environment = createNodeGitHostEnvironment({ env: envOf(over), effectiveUid: null });
  try {
    const found = await discoverRepository({ files, cwd, environment });
    return { exit: 0, out: `${found.gitDir}\n` };
  } catch (error) {
    return {
      exit: (error as { exitCode?: number }).exitCode ?? 1,
      out: `${(error as Error).message}\n`,
    };
  }
}

describeGit("GIT_CEILING_DIRECTORIES (native twins)", () => {
  beforeAll(() => {
    T = realpathSync(mkdtempSync(join(tmpdir(), "discovery-ceiling-")));
    execFileSync("git", ["init", "-q", join(T, "repo")], { env: envOf({}) });
    mkdirSync(join(T, "repo", "a", "b", "c"), { recursive: true });
    symlinkSync(join(T, "repo"), join(T, "link"));
  });
  afterAll(() => {
    if (T) rmSync(T, { recursive: true, force: true });
  });

  const cases: Array<[string, string, () => string]> = [
    ["no ceiling", "repo/a/b", () => ""],
    ["the repository's top as ceiling", "repo/a/b", () => join(T, "repo")],
    ["a ceiling between", "repo/a/b/c", () => join(T, "repo", "a")],
    ["the ceiling is the directory itself", "repo", () => join(T, "repo")],
    ["the ceiling is cwd below the top", "repo/a", () => join(T, "repo", "a")],
    ["a ceiling above the repository", "repo/a", () => T],
    ["a relative entry is ignored", "repo/a/b", () => "repo"],
    ["a ceiling through a symbolic link is canonicalised", "repo/a/b", () => join(T, "link")],
    ["after an empty entry nothing is canonicalised", "repo/a/b", () => `:${join(T, "link")}`],
    ["an empty entry after a real one", "repo/a/b", () => `${join(T, "repo")}:`],
    ["a missing entry is dropped", "repo/a/b", () => `/nonexistent/x:${join(T, "repo", "a")}`],
    ["a trailing slash", "repo/a/b", () => `${join(T, "repo")}/`],
    ["the root", "repo/a/b", () => "/"],
    ["a longer prefix that is no ancestor", "repo/a/b", () => join(T, "rep")],
  ];
  for (const [name, cwd, ceiling] of cases) {
    it(name, async () => {
      const value = ceiling();
      const over: Record<string, string> = value ? { GIT_CEILING_DIRECTORIES: value } : {};
      const dir = join(T, cwd);
      expect(await ours(dir, over)).toEqual(native(dir, over));
    });
  }

  it("refuses with NotAGitRepositoryError (exit 128)", async () => {
    const files = createNodeFilesApi({ rootDir: "/" });
    const environment = createNodeGitHostEnvironment({
      env: envOf({ GIT_CEILING_DIRECTORIES: join(T, "repo") }),
      effectiveUid: null,
    });
    await expect(
      discoverRepository({ files, cwd: join(T, "repo", "a"), environment }),
    ).rejects.toBeInstanceOf(NotAGitRepositoryError);
  });
});

describe("the file system boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM)", () => {
  let root = "";
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "discovery-boundary-")));
    execFileSync("git", ["init", "-q", join(root, "outer")], { env: envOf({}) });
    mkdirSync(join(root, "outer", "mnt", "sub"), { recursive: true });
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** A FilesApi rooted at `root` whose `lstat` puts `/outer/mnt` on device 2. */
  function mounted() {
    const files = createNodeFilesApi({ rootDir: root });
    return new Proxy(files, {
      get(target, prop, receiver) {
        if (prop === "lstat") {
          return async (path: string) => {
            const stat = await target.lstat?.(path);
            if (!stat) return stat;
            const inside = path === "/outer/mnt" || path.startsWith("/outer/mnt/");
            return { ...stat, dev: inside ? 2 : 1 };
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  it("stops at the boundary with git's message", async () => {
    const files = mounted();
    const environment = createNodeGitHostEnvironment({ env: envOf({}), effectiveUid: null });
    const error = await discoverRepository({ files, cwd: "/outer/mnt/sub", environment }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(FilesystemBoundaryError);
    expect(error).toBeInstanceOf(NotAGitRepositoryError);
    expect((error as FilesystemBoundaryError).exitCode).toBe(128);
    // setup.c: the directory climbed to whose device differs
    expect((error as Error).message).toBe(
      `fatal: not a git repository (or any parent up to mount point ${root}/outer)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).`,
    );
  });

  it("climbs past it with GIT_DISCOVERY_ACROSS_FILESYSTEM", async () => {
    const files = mounted();
    const environment = createNodeGitHostEnvironment({
      env: envOf({ GIT_DISCOVERY_ACROSS_FILESYSTEM: "1" }),
      effectiveUid: null,
    });
    const found = await discoverRepository({ files, cwd: "/outer/mnt/sub", environment });
    expect(found.gitDir).toBe("/outer/.git");
  });

  it("finds a repository on the same device as before", async () => {
    const files = mounted();
    const environment = createNodeGitHostEnvironment({ env: envOf({}), effectiveUid: null });
    const found = await discoverRepository({ files, cwd: "/outer", environment });
    expect(found.gitDir).toBe("/outer/.git");
  });

  it("is no check where the storage reports no device", async () => {
    const files = createNodeFilesApi({ rootDir: root });
    const plain = new Proxy(files, {
      get(target, prop, receiver) {
        if (prop === "lstat") {
          return async (path: string) => {
            const stat = await target.lstat?.(path);
            if (!stat) return stat;
            const { dev: _dev, ...rest } = stat;
            return rest;
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const environment = createNodeGitHostEnvironment({ env: envOf({}), effectiveUid: null });
    const found = await discoverRepository({ files: plain, cwd: "/outer/mnt/sub", environment });
    expect(found.gitDir).toBe("/outer/.git");
  });
});

describeGit("discovery climbs the physical directory (native twins)", () => {
  // T is a repository; T/l links to T/a/b/c/r, a plain directory below the ceiling T/a/b
  let top = "";
  beforeAll(() => {
    top = realpathSync(mkdtempSync(join(tmpdir(), "discovery-physical-")));
    execFileSync("git", ["init", "-q", top], { env: envOf({}) });
    mkdirSync(join(top, "a", "b", "c", "r", "s"), { recursive: true });
    symlinkSync(join(top, "a", "b", "c", "r"), join(top, "l"));
  });
  afterAll(() => {
    if (top) rmSync(top, { recursive: true, force: true });
  });

  it("a ceiling on the physical path is not bypassed through a linked cwd", async () => {
    const over = { GIT_CEILING_DIRECTORIES: join(top, "a", "b") };
    const dir = join(top, "l", "s");
    const expected = native(dir, over);
    expect(expected.exit).toBe(128);
    expect(expected.out).toContain("not a git repository");
    expect(await ours(dir, over)).toEqual(expected);
  });

  it("without a ceiling the physical parents are searched", async () => {
    const dir = join(top, "l", "s");
    const expected = native(dir, {});
    expect(expected.out).toBe(`${top}/.git\n`);
    expect(await ours(dir, {})).toEqual(expected);
  });

  it("a FilesApi rooted elsewhere maps the real path back into it", async () => {
    const files = createNodeFilesApi({ rootDir: top });
    const environment = createNodeGitHostEnvironment({
      env: envOf({ GIT_CEILING_DIRECTORIES: join(top, "a", "b") }),
      effectiveUid: null,
    });
    await expect(discoverRepository({ files, cwd: "/l/s", environment })).rejects.toBeInstanceOf(
      NotAGitRepositoryError,
    );
    const free = createNodeGitHostEnvironment({ env: envOf({}), effectiveUid: null });
    expect((await discoverRepository({ files, cwd: "/l/s", environment: free })).gitDir).toBe(
      "/.git",
    );
  });
});
