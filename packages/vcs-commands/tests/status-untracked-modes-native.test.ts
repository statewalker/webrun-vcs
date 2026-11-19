/**
 * `git status` untracked and ignored modes against native git: each `--untracked-files`
 * mode (`no`, `normal`, `all`) crossed with each `--ignored` mode (`no`, `traditional`,
 * `matching`), in porcelain v1 and v2 and the short format, over a worktree holding
 * directories with only untracked or only ignored content, empty directories, nested
 * repositories (plain, ignored, inside an ignored directory) and tracked directories with
 * both, with and without a pathspec; `status.showUntrackedFiles` in every spelling git
 * accepts; and a random fuzz of worktrees compared with native git run without any cache.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import { MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  formatStatusPorcelain,
  Git,
  type IgnoredMode,
  IncompatibleOptionsError,
  InvalidConfigError,
  type UntrackedFilesMode,
} from "../src/index.js";
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
/** Native git's exit code and stderr (for the commands it refuses). */
const gitFails = (cwd: string, args: string[]) => {
  const r = spawnSync("git", args, { cwd, env: env(), encoding: "utf8" });
  return { status: r.status, stderr: r.stderr };
};
const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/** git 2.5x reads a boolean `status.showUntrackedFiles`; 2.43 refuses one. */
function nativeTakesBooleanModes(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "status-umodes-probe-"));
  try {
    execFileSync("git", ["init", "-q", probe], { env: nativeGitEnv(probe), stdio: "ignore" });
    const r = spawnSync("git", ["-c", "status.showUntrackedFiles=true", "status", "--porcelain"], {
      cwd: probe,
      env: nativeGitEnv(probe),
    });
    return r.status === 0;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}
const booleanModes = nativeGitAvailable() && nativeTakesBooleanModes();

/** Our working copy over the repository, with the host environment native git has. */
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
  return Git.fromWorkingCopy(new MemoryWorkingCopy({ history, checkout, worktree, config }));
}

/**
 * A repository whose worktree holds every kind of directory the modes treat differently:
 * only untracked content, only ignored content, both, empty ones (plain and ignored), a
 * directory holding only an empty one, nested repositories (plain, matching an ignore
 * pattern, inside an ignored directory), tracked directories with untracked and ignored
 * files, a negated pattern inside an ignored directory, and a link.
 */
function repo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  put(dir, ".gitignore", "*.log\nbuild/\ncache/\nignored-repo/\nvendor/\n!build/keep.log\n");
  put(dir, "a/one.txt", "1\n");
  put(dir, "a/b/two.txt", "2\n");
  put(dir, "t/.gitignore", "*.tmp\n");
  put(dir, "t/three.txt", "3\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "base"]);
  // tracked directories with untracked and ignored files
  put(dir, "a/new.txt", "n\n");
  put(dir, "a/x.log", "x\n");
  put(dir, "a/b/c/deep.txt", "d\n");
  put(dir, "t/y.tmp", "y\n");
  put(dir, "t/sub/z.tmp", "z\n");
  // untracked directories
  put(dir, "u/v/w.txt", "w\n");
  put(dir, "u/v2/only.log", "l\n");
  put(dir, "ig/x.log", "x\n");
  put(dir, "ig/deep/y.log", "y\n");
  put(dir, "mix/a.txt", "a\n");
  put(dir, "mix/b.log", "b\n");
  put(dir, "mix/inner/c.log", "c\n");
  // ignored directories
  put(dir, "build/out.o", "o\n");
  put(dir, "build/keep.log", "k\n");
  put(dir, "build/sub/z", "z\n");
  mkdirSync(join(dir, "cache"));
  // empty directories
  mkdirSync(join(dir, "empty"));
  mkdirSync(join(dir, "hollow/inner/innermost"), { recursive: true });
  mkdirSync(join(dir, "a/b/empty"));
  // nested repositories
  for (const nested of ["nested", "ignored-repo", "vendor/lib"]) {
    mkdirSync(join(dir, nested), { recursive: true });
    git(join(dir, nested), ["init", "-q"]);
    put(join(dir, nested), "inside.txt", "i\n");
  }
  symlinkSync("a/one.txt", join(dir, "link"));
  put(dir, "top.log", "t\n");
  put(dir, "top.txt", "t\n");
}

const UNTRACKED_MODES: UntrackedFilesMode[] = ["no", "normal", "all"];
const IGNORED_MODES: IgnoredMode[] = ["no", "traditional", "matching"];

/** The options of native git's status for the modes (undefined: git's default). */
function modeArgs(untracked?: UntrackedFilesMode, ignored?: IgnoredMode): string[] {
  return [
    ...(untracked ? [`--untracked-files=${untracked}`] : []),
    ...(ignored ? [`--ignored=${ignored}`] : []),
  ];
}

/** Our status in the modes. */
async function ours(
  dir: string,
  untracked?: UntrackedFilesMode,
  ignored?: IgnoredMode,
  paths: string[] = [],
) {
  const command = (await open(dir)).status();
  if (untracked) command.setUntrackedFiles(untracked);
  if (ignored) command.setIgnored(ignored);
  for (const path of paths) command.addPath(path);
  return command.call();
}

/** Ours and native git's agree in porcelain v1, v2 and the short format. */
async function expectAsNative(
  dir: string,
  untracked?: UntrackedFilesMode,
  ignored?: IgnoredMode,
  paths: string[] = [],
) {
  const args = [...modeArgs(untracked, ignored), "--", ...paths];
  const label = `-u${untracked ?? "(default)"} --ignored=${ignored ?? "(default)"} ${paths.join(" ")}`;
  const status = await ours(dir, untracked, ignored, paths);
  expect(formatStatusPorcelain(status, 1), `${label} v1`).toBe(
    git(dir, ["status", "--porcelain", ...args]),
  );
  expect(formatStatusPorcelain(status, 2), `${label} v2`).toBe(
    git(dir, ["status", "--porcelain=v2", ...args]),
  );
  expect(formatStatusPorcelain(status, 1), `${label} short`).toBe(
    git(dir, ["-c", "color.status=false", "status", "--short", ...args]),
  );
  return status;
}

describeGit("status untracked and ignored modes: as native git", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "status-umodes-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("each -u mode crossed with each --ignored mode", async () => {
    const dir = join(root, "r");
    repo(dir);
    for (const untracked of UNTRACKED_MODES) {
      for (const ignored of IGNORED_MODES) {
        if (untracked === "no" && ignored === "matching") continue;
        await expectAsNative(dir, untracked, ignored);
      }
    }
  }, 60_000);

  it("the default is normal: an untracked directory shows as dir/, an empty one not at all", async () => {
    const dir = join(root, "r");
    repo(dir);
    const status = await expectAsNative(dir);
    expect(status.untracked.has("u/")).toBe(true);
    expect(status.untracked.has("u/v/w.txt")).toBe(false);
    expect(status.untracked.has("nested/")).toBe(true);
    expect([...status.untracked].some((p) => p.startsWith("empty") || p.startsWith("hollow"))).toBe(
      false,
    );
    await expectAsNative(dir, undefined, "traditional");
  });

  it("--ignored=matching with -uno fails as git does", async () => {
    const dir = join(root, "r");
    repo(dir);
    const native = gitFails(dir, ["status", "--ignored=matching", "-uno"]);
    expect(native.status).toBe(128);
    const error = await ours(dir, "no", "matching").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IncompatibleOptionsError);
    expect(native.stderr).toBe(`fatal: ${(error as Error).message}\n`);
    // status.showUntrackedFiles=no counts as -uno
    git(dir, ["config", "status.showUntrackedFiles", "no"]);
    expect(gitFails(dir, ["status", "--ignored=matching"]).status).toBe(128);
    await expect(ours(dir, undefined, "matching")).rejects.toThrow(IncompatibleOptionsError);
  });

  it("with a pathspec", async () => {
    const dir = join(root, "r");
    repo(dir);
    const pathspecs = [
      ["u"],
      ["u/"],
      ["u/v"],
      ["u/v/w.txt"],
      ["mix/a.txt"],
      ["mix", "ig"],
      ["ig"],
      ["build"],
      ["build/sub"],
      ["build/keep.log"],
      ["nested"],
      ["nested/inside.txt"],
      ["vendor"],
      ["vendor/lib"],
      ["a"],
      ["a/b"],
      ["t/sub"],
      ["empty"],
      ["hollow/inner"],
      ["."],
      ["nonexistent/x"],
      ["a/nonexistent"],
      ["top.txt", "u/v2"],
    ];
    for (const paths of pathspecs) {
      for (const untracked of UNTRACKED_MODES) {
        for (const ignored of IGNORED_MODES) {
          if (untracked === "no" && ignored === "matching") continue;
          try {
            await expectAsNative(dir, untracked, ignored, paths);
          } catch (error) {
            throw new Error(`pathspec ${paths.join(" ")}: ${(error as Error).message}`);
          }
        }
      }
    }
  }, 120_000);

  it("status.showUntrackedFiles decides the mode when no option is given", async () => {
    const dir = join(root, "r");
    repo(dir);
    const values = [
      "no",
      "normal",
      "all",
      ...(booleanModes ? ["true", "false", "yes", "off", "1", "0", ""] : []),
    ];
    for (const value of values) {
      git(dir, ["config", "status.showUntrackedFiles", value]);
      await expectAsNative(dir);
      await expectAsNative(dir, undefined, "traditional");
      // the option wins over the configuration
      await expectAsNative(dir, "all");
    }
  }, 60_000);

  it("a value of status.showUntrackedFiles git cannot read fails with git's message", async () => {
    const dir = join(root, "r");
    repo(dir);
    // (git 2.43 refuses the boolean spellings too; ours reads them as 2.5x does)
    for (const value of ["bogus", "All", "Normal"]) {
      git(dir, ["config", "status.showUntrackedFiles", value]);
      const native = gitFails(dir, ["status", "--porcelain"]);
      expect(native.status).toBe(128);
      const error = await ours(dir).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(InvalidConfigError);
      expect(`${(error as Error).message}\n`).toBe(native.stderr);
      // the option does not save a bad configuration
      expect(gitFails(dir, ["status", "-uall"]).status).toBe(128);
      await expect(ours(dir, "all")).rejects.toThrow(InvalidConfigError);
    }
  });

  it("git commit fails on a status.showUntrackedFiles it cannot read, as git does", async () => {
    const dir = join(root, "r");
    repo(dir);
    git(dir, ["config", "status.showUntrackedFiles", "bogus"]);
    const native = gitFails(dir, ["commit", "-q", "--allow-empty", "-m", "x"]);
    expect(native.status).toBe(128);
    const head = git(dir, ["rev-parse", "HEAD"]);
    const error = await (await open(dir))
      .commit()
      .setMessage("x")
      .setAllowEmpty(true)
      .call()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidConfigError);
    expect(`${(error as Error).message}\n`).toBe(native.stderr);
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(head);
  });

  it.runIf(booleanModes)("a variable without a value is a true boolean: normal", async () => {
    const dir = join(root, "r");
    repo(dir);
    const configPath = join(dir, ".git/config");
    writeFileSync(
      configPath,
      `${readFileSync(configPath, "utf8")}[status]\n\tshowUntrackedFiles\n`,
    );
    const status = await expectAsNative(dir);
    expect(status.untracked.has("u/")).toBe(true);
  });

  it("an untracked directory holding only an ignored file, and an ignored one holding an untracked repository", async () => {
    const dir = join(root, "r");
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    put(dir, ".gitignore", "*.o\nout/\n");
    put(dir, "only-ignored/x.o", "x\n");
    put(dir, "only-ignored/deeper/y.o", "y\n");
    put(dir, "out/sub/z.c", "z\n");
    mkdirSync(join(dir, "out/repo"), { recursive: true });
    git(join(dir, "out/repo"), ["init", "-q"]);
    put(dir, "both/x.o", "x\n");
    put(dir, "both/deeper/u.c", "u\n");
    put(dir, "both/deeper/v.o", "v\n");
    for (const untracked of UNTRACKED_MODES) {
      for (const ignored of IGNORED_MODES) {
        if (untracked === "no" && ignored === "matching") continue;
        await expectAsNative(dir, untracked, ignored);
      }
    }
  });

  it("fuzz: random worktrees, every mode, against native git without any cache", async () => {
    let seed = 0x6a11;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const dirNames = ["p", "q", "r", "s"];
    const fileNames = ["f.txt", "g.log", "h.o", "keep.log"];
    const ignores = ["*.log\n", "*.o\n!keep.log\n", "q/\n", "*.log\n!keep.log\nr\n", "s/*\n", ""];
    for (let round = 0; round < 12; round++) {
      const dir = join(root, `f${round}`);
      mkdirSync(dir, { recursive: true });
      git(dir, ["init", "-q", "-b", "main"]);
      put(dir, ".gitignore", ignores[rand(ignores.length)] as string);
      const paths: string[] = [];
      for (let i = 0; i < 14; i++) {
        const depth = rand(4);
        const parts: string[] = [];
        for (let d = 0; d < depth; d++) parts.push(dirNames[rand(dirNames.length)] as string);
        const kind = rand(10);
        const base = parts.join("/");
        if (kind === 0) {
          mkdirSync(join(dir, base, "e"), { recursive: true });
        } else if (kind === 1 && base) {
          put(dir, `${base}/.gitignore`, ignores[rand(ignores.length)] as string);
        } else {
          const path = `${base ? `${base}/` : ""}${fileNames[rand(fileNames.length)]}`;
          try {
            put(dir, path, `${i}\n`);
            paths.push(path);
          } catch {
            // a file where a directory was asked for
          }
        }
      }
      // a few tracked, so some directories are in the index
      for (const path of paths.filter(() => rand(3) === 0)) git(dir, ["add", "-f", "--", path]);
      if (rand(2) === 0) {
        git(dir, ["commit", "-qm", "c", "--allow-empty"]);
      }
      const spec = rand(3) === 0 ? [dirNames[rand(dirNames.length)] as string] : [];
      for (const untracked of UNTRACKED_MODES) {
        for (const ignored of IGNORED_MODES) {
          if (untracked === "no" && ignored === "matching") continue;
          try {
            const status = await ours(dir, untracked, ignored, spec);
            const args = [...modeArgs(untracked, ignored), "--", ...spec];
            expect(formatStatusPorcelain(status, 2)).toBe(
              git(dir, ["status", "--porcelain=v2", ...args], {
                GIT_DISABLE_UNTRACKED_CACHE: "1",
              }),
            );
          } catch (error) {
            throw new Error(
              `round ${round} -u${untracked} --ignored=${ignored} ${spec.join(" ")}: ${(error as Error).message}`,
            );
          }
        }
      }
    }
  }, 180_000);
});
