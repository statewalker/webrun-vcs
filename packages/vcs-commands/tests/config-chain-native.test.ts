/**
 * git's configuration chain against native git: global files (`~/.gitconfig`,
 * `$XDG_CONFIG_HOME/git/config`), `include.path`, `includeIf` (`gitdir:`, `gitdir/i:`,
 * `onbranch:`) and `config.worktree`, read by `git config --get-all` and by our
 * `GitWorkingCopyConfig` with the host environment; and their effect on `add`.
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
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { MemoryWorkingCopy } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatStatusPorcelain, Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";
/** Native git reading the global files of `home` (not /dev/null). */
const env = () => {
  const e: Record<string, string> = {
    ...nativeGitEnv(home),
    XDG_CONFIG_HOME: join(home, ".config"),
  };
  delete e.GIT_CONFIG_GLOBAL;
  return e;
};
const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: env(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const getAll = (cwd: string, key: string) => {
  try {
    return run(cwd, "config", "--get-all", key).split("\n").filter(Boolean);
  } catch {
    return [];
  }
};
const put = (path: string, content: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
};

async function openConfig(dir: string) {
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
  const config = new GitWorkingCopyConfig(io, ".git/config", {
    environment: createNodeGitHostEnvironment({ env: env() }),
    gitDirPath: join(dir, ".git"),
  });
  await config.load();
  return config;
}

async function openGit(dir: string) {
  const files = createNodeFilesApi({ rootDir: dir });
  const { history } = await createGitFilesBackend({ files });
  const config = await openConfig(dir);
  const staging = new FileStagingStore(files, ".git/index");
  await staging.read();
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

const KEYS = [
  "core.autocrlf",
  "core.eol",
  "core.safecrlf",
  "user.name",
  "test.multi",
  "test.fromglobal",
  "test.fromxdg",
  "test.included",
  "test.gitdir",
  "test.gitdiricase",
  "test.nogitdir",
  "test.branch",
  "test.nobranch",
  "test.worktree",
  "test.nested",
];

/** Our values of `key`, as `git config --get-all` prints them. */
const ours = (config: GitWorkingCopyConfig, key: string) =>
  config.getAll(key).map((v) => (v === true ? "true" : v === false ? "false" : String(v)));

describeGit("configuration chain against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cfg-chain-"));
    home = join(root, "home");
    mkdirSync(home);
    put(
      join(home, ".gitconfig"),
      "[test]\n\tfromglobal = true\n\tmulti = g1\n[core]\n\tautocrlf = true\n[include]\n\tpath = ~/inc/nested.cfg\n",
    );
    put(join(home, "inc/nested.cfg"), "[test]\n\tnested = from-home\n\tmulti = g2\n");
    put(join(home, ".config/git/config"), "[test]\n\tfromxdg = 1\n\tfromglobal = xdg-loses\n");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reads global, include, includeIf and config.worktree values as git config does", async () => {
    const dir = join(root, "Repo");
    mkdirSync(dir);
    run(dir, "init", "-q", "-b", "feature/x");
    put(join(dir, ".git/extra.cfg"), "[test]\n\tincluded = relative\n\tmulti = inc\n");
    put(join(dir, ".git/gitdir.cfg"), "[test]\n\tgitdir = matched\n");
    put(join(dir, ".git/icase.cfg"), "[test]\n\tgitdiricase = matched\n");
    put(join(dir, ".git/no.cfg"), "[test]\n\tnogitdir = wrong\n\tnobranch = wrong\n");
    put(join(dir, ".git/branch.cfg"), "[test]\n\tbranch = feature\n");
    put(join(dir, ".git/config.worktree"), "[test]\n\tworktree = wt\n\tmulti = wt\n");
    const config = readFileSync(join(dir, ".git/config"), "utf8");
    writeFileSync(
      join(dir, ".git/config"),
      `${config}[test]\n\tmulti = local1\n[include]\n\tpath = extra.cfg\n[test]\n\tmulti = local2\n` +
        `[includeIf "gitdir:${dir}/"]\n\tpath = gitdir.cfg\n` +
        `[includeIf "gitdir/i:${dir.toLowerCase()}/.GIT"]\n\tpath = icase.cfg\n` +
        `[includeIf "gitdir:/nowhere/"]\n\tpath = no.cfg\n` +
        `[includeIf "onbranch:feature/"]\n\tpath = branch.cfg\n` +
        `[includeIf "onbranch:main"]\n\tpath = no.cfg\n` +
        `[extensions]\n\tworktreeConfig = true\n[core]\n\trepositoryformatversion = 1\n`,
    );
    const ourConfig = await openConfig(dir);
    for (const key of KEYS) {
      expect(ours(ourConfig, key), key).toEqual(getAll(dir, key));
    }
  });

  it("a global core.autocrlf and an included core.eol apply to add as in git", async () => {
    const dirs = [join(root, "add-native"), join(root, "add-ours")];
    for (const dir of dirs) {
      mkdirSync(dir);
      run(dir, "init", "-q", "-b", "main");
      put(join(dir, ".git/eol.cfg"), "[core]\n\tsafecrlf = false\n");
      writeFileSync(
        join(dir, ".git/config"),
        `${readFileSync(join(dir, ".git/config"), "utf8")}[include]\n\tpath = eol.cfg\n`,
      );
      put(join(dir, "a.txt"), "one\r\ntwo\r\n");
      put(join(dir, "b.txt"), "x\ny\r\n");
    }
    run(dirs[0], "add", ".");
    await (await openGit(dirs[1])).add().addFilepattern(".").call();
    expect(run(dirs[1], "ls-files", "-s", "--eol")).toBe(run(dirs[0], "ls-files", "-s", "--eol"));
  });

  it("core.excludesFile from an included global file (with ~/) and the XDG default ignore as git does", async () => {
    put(join(home, ".config/git/ignore"), "*.xdg\n");
    const dir = join(root, "excludes");
    mkdirSync(dir);
    run(dir, "init", "-q", "-b", "main");
    for (const f of ["a.log", "b.xdg", "c.txt"]) put(join(dir, f), "x\n");
    const status = async () => {
      const result = await (await openGit(dir)).status().setIgnored(true).call();
      return formatStatusPorcelain(result, 1);
    };
    // no core.excludesFile: $XDG_CONFIG_HOME/git/ignore
    expect(await status()).toBe(run(dir, "status", "--porcelain=v1", "--ignored", "-uall"));
    // core.excludesFile = ~/ignore-global (set in a file the global config includes)
    put(join(home, "ignore-global"), "*.log\n");
    put(
      join(home, "inc/nested.cfg"),
      "[test]\n\tnested = from-home\n\tmulti = g2\n[core]\n\texcludesFile = ~/ignore-global\n",
    );
    expect(await status()).toBe(run(dir, "status", "--porcelain=v1", "--ignored", "-uall"));
    put(join(home, "inc/nested.cfg"), "[test]\n\tnested = from-home\n\tmulti = g2\n");
  });
});
