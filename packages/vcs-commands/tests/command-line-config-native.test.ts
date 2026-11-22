/**
 * The command line's configuration (`git -c`, passed to child processes in
 * `$GIT_CONFIG_PARAMETERS` / `$GIT_CONFIG_COUNT`) against native git's: git reads it last, in
 * scope `command`, on every config read, so it overrides the repository's own config. Each
 * repository is built twice by native git; native git runs a command with `-c`, ours with the
 * same entries in `$GIT_CONFIG_PARAMETERS` read by `createNodeGitHostEnvironment`, and the
 * results are compared (index, objects, worktree files, output). The remote side of a local
 * transport never sees the client's `-c` (connect.c clears `local_repo_env`).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CommandLineConfigError,
  ConfigIncludeDepthError,
  createGitFilesBackend,
  discoverRepository,
  GitWorkingCopyConfig,
  openGitLinkedWorktrees,
  showOrigin,
} from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, PushStatus } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";
import { gitAtLeast } from "./native-git-working-copy.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

type Env = Record<string, string | undefined>;

let root = "";
let home = "";
let counter = 0;

const clean = (env: Env): Record<string, string> =>
  Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined));

/** `'key'='value'` entries as git writes `$GIT_CONFIG_PARAMETERS` (a key alone without `=`). */
function parametersOf(pairs: Array<[string, string | undefined]>): string {
  const sq = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  return pairs.map(([k, v]) => (v === undefined ? sq(k) : `${sq(k)}=${sq(v)}`)).join(" ");
}

/** `-c` arguments of `pairs`. */
const dashC = (pairs: Array<[string, string | undefined]>) =>
  pairs.flatMap(([k, v]) => ["-c", v === undefined ? k : `${k}=${v}`]);

const git = (cwd: string, args: string[], env: Env = nativeGitEnv(home)) =>
  execFileSync("git", args, {
    cwd,
    env: clean(env),
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });

const run = (cwd: string, args: string[], env: Env = nativeGitEnv(home)) => {
  const r = spawnSync("git", args, { cwd, env: clean(env), encoding: "latin1" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

const put = (dir: string, path: string, content: string) => {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), content);
};

/** main (c1, c2 changing a.txt) and `conf` (c1, a conflicting change of a.txt). */
function base(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const repo = join(dir, "repo");
  git(dir, ["init", "-q", "-b", "main", "repo"]);
  put(repo, "a.txt", "one\ntwo\nthree\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "c1"]);
  git(repo, ["branch", "conf"]);
  put(repo, "a.txt", "one\nTWO\nthree\n");
  git(repo, ["commit", "-qam", "c2"]);
  git(repo, ["checkout", "-q", "conf"]);
  put(repo, "a.txt", "one\nzwei\nthree\n");
  git(repo, ["commit", "-qam", "conflicting"]);
  git(repo, ["checkout", "-q", "main"]);
  return repo;
}

function twins(): { native: string; ours: string } {
  const n = counter++;
  return { native: base(join(root, `t${n}-native`)), ours: base(join(root, `t${n}-ours`)) };
}

/** Our Git on `repo`, `pairs` on its command line (`$GIT_CONFIG_PARAMETERS`). */
async function open(
  repo: string,
  pairs: Array<[string, string | undefined]>,
  over: Env = {},
): Promise<Git> {
  const env = clean({ ...nativeGitEnv(home), GIT_CONFIG_PARAMETERS: parametersOf(pairs), ...over });
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env, effectiveUid: null });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/**
 * Our Git on `<dir>/src` whose worktree has the environment too, so the local remotes it
 * opens get it (as a server's would) unless the transport strips the command line.
 */
async function openWithRemotes(dir: string, pairs: Array<[string, string]>): Promise<Git> {
  const env = clean({ ...nativeGitEnv(home), GIT_CONFIG_PARAMETERS: parametersOf(pairs) });
  const environment = createNodeGitHostEnvironment({ env, effectiveUid: null });
  return openOurs(dir, environment, undefined, "src", true);
}

/** Both twins configured alike by native git (their own `.git/config`). */
function configure(t: { native: string; ours: string }, pairs: Array<[string, string]>) {
  for (const repo of [t.native, t.ours]) {
    for (const [k, v] of pairs) git(repo, ["config", k, v]);
  }
}

describeGit("command-line config overrides the repository's (native twins)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cmdline-config-native-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("core.autocrlf: add stores LF", async () => {
    const t = twins();
    configure(t, [["core.autocrlf", "false"]]);
    const pairs: Array<[string, string]> = [["core.autocrlf", "true"]];
    for (const repo of [t.native, t.ours]) put(repo, "crlf.txt", "a\r\nb\r\n");
    git(t.native, [...dashC(pairs), "add", "crlf.txt"]);
    await (await open(t.ours, pairs)).add().addFilepattern("crlf.txt").call();
    const staged = (repo: string) => git(repo, ["ls-files", "-s", "crlf.txt"]);
    expect(staged(t.ours)).toBe(staged(t.native));
    // the repository's own false is overridden: the blob has no CR
    expect(git(t.native, ["cat-file", "-p", ":crlf.txt"])).toBe("a\nb\n");
  });

  it("user.name / user.email: the commit's identity", async () => {
    const t = twins();
    configure(t, [
      ["user.name", "Repo Person"],
      ["user.email", "repo@example.com"],
    ]);
    const pairs: Array<[string, string]> = [
      ["user.name", "Cli Person"],
      ["user.email", "cli@example.com"],
    ];
    // no identity in the environment: user.* decides, dates fixed for equal ids
    const noIdent: Env = {
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
    };
    put(t.native, "b.txt", "b\n");
    put(t.ours, "b.txt", "b\n");
    git(t.native, ["add", "b.txt"]);
    git(t.ours, ["add", "b.txt"]);
    git(t.native, [...dashC(pairs), "commit", "-qm", "by cli"], {
      ...nativeGitEnv(home),
      ...noIdent,
    });
    await (await open(t.ours, pairs, noIdent)).commit().setMessage("by cli\n").call();
    const head = (repo: string) => git(repo, ["cat-file", "-p", "HEAD"]);
    expect(head(t.ours)).toBe(head(t.native));
    expect(head(t.native)).toContain("author Cli Person <cli@example.com>");
  });

  it("merge.conflictStyle: the conflict markers", async () => {
    const t = twins();
    configure(t, [["merge.conflictStyle", "merge"]]);
    const pairs: Array<[string, string]> = [["merge.conflictStyle", "diff3"]];
    const native = run(t.native, [...dashC(pairs), "merge", "conf"]);
    expect(native.status).toBe(1);
    await (await open(t.ours, pairs)).merge().include("conf").call();
    const file = (repo: string) => readFileSync(join(repo, "a.txt"), "latin1");
    expect(file(t.ours)).toBe(file(t.native));
    expect(file(t.native)).toContain("|||||||");
  });

  it("diff.noprefix and diff.context: the patch", async () => {
    const t = twins();
    configure(t, [
      ["diff.noprefix", "false"],
      ["diff.context", "3"],
    ]);
    const pairs: Array<[string, string]> = [
      ["diff.noprefix", "true"],
      ["diff.context", "0"],
    ];
    for (const repo of [t.native, t.ours]) put(repo, "a.txt", "one\nTWO\nthree\nfour\n");
    const theirs = git(t.native, [...dashC(pairs), "diff"]);
    expect(theirs).toContain("--- a.txt");
    expect(await (await open(t.ours, pairs)).diff().callText()).toBe(theirs);
  });

  it("status.showUntrackedFiles: untracked files hidden", async () => {
    const t = twins();
    configure(t, [["status.showUntrackedFiles", "all"]]);
    const pairs: Array<[string, string]> = [["status.showUntrackedFiles", "no"]];
    for (const repo of [t.native, t.ours]) {
      put(repo, "new/u.txt", "u\n");
      put(repo, "a.txt", "changed\n");
    }
    const theirs = git(t.native, [...dashC(pairs), "status", "--porcelain"]);
    expect(theirs).toBe(" M a.txt\n");
    expect(
      (await (await open(t.ours, pairs)).status().callText({ format: "porcelain" })).text,
    ).toBe(theirs);
  });

  it("include.path given on the command line (an absolute path)", async () => {
    const t = twins();
    const included = join(root, `inc-${counter}.cfg`);
    writeFileSync(included, "[diff]\n\tnoprefix = true\n");
    const pairs: Array<[string, string]> = [["include.path", included]];
    for (const repo of [t.native, t.ours]) put(repo, "a.txt", "changed\n");
    const theirs = git(t.native, [...dashC(pairs), "diff"]);
    expect(theirs).toContain("--- a.txt");
    expect(await (await open(t.ours, pairs)).diff().callText()).toBe(theirs);
  });

  it("a relative include.path on the command line is fatal", async () => {
    const t = twins();
    const pairs: Array<[string, string]> = [["include.path", "x.cfg"]];
    const native = run(t.native, [...dashC(pairs), "status"]);
    expect(native.status).toBe(128);
    const error = await open(t.ours, pairs).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CommandLineConfigError);
    expect((error as CommandLineConfigError).exitCode).toBe(128);
    expect(`${(error as Error).message}\n`).toBe(native.stderr);
  });

  it("unparseable command-line config is fatal at the first config read", async () => {
    const t = twins();
    const env = { ...nativeGitEnv(home), GIT_CONFIG_PARAMETERS: "'=x'" };
    const native = run(t.native, ["status"], env);
    expect(native.status).toBe(128);
    const files = createNodeFilesApi({ rootDir: t.ours });
    const environment = createNodeGitHostEnvironment({ env, effectiveUid: null });
    const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
    const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
    const error = await worktrees.openCurrent().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CommandLineConfigError);
    expect(`${(error as Error).message}\n`).toBe(native.stderr);
  });

  it("config --list --show-origin --show-scope", async () => {
    const t = twins();
    const included = join(root, `inc-list-${counter}.cfg`);
    writeFileSync(included, "[foo]\n\tbar = inc\n");
    const pairs: Array<[string, string | undefined]> = [
      ["core.autocrlf", "input"],
      ["Section.Sub.Key", "v"],
      ["include.path", included],
      ["flag.alone", undefined],
    ];
    const theirs = git(t.native, [
      ...dashC(pairs),
      "config",
      "--list",
      "--show-origin",
      "--show-scope",
    ]);
    const g = await open(t.ours, pairs);
    const config = g.workingCopy.config as unknown as {
      listWithOrigin(): Array<{
        key: string;
        text: string | undefined;
        file?: string;
        scope?: "command";
      }>;
    };
    const ours = config
      .listWithOrigin()
      .map(
        (e) =>
          `${e.scope}\t${showOrigin(e)}\t${e.text === undefined ? e.key : `${e.key}=${e.text}`}\n`,
      )
      .join("");
    expect(ours).toBe(theirs);
    expect(theirs).toContain("command\tcommand line:\tflag.alone\n");
    expect(theirs).toContain(`command\tfile:${included}\tfoo.bar=inc\n`);
  });
});

describeGit("the remote side of a local transport does not see -c (local_repo_env)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cmdline-config-local-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** `<dir>/dst` (non-bare, on main) and `<dir>/src` cloned from it with one more commit. */
  function pushBase(dir: string): void {
    mkdirSync(dir, { recursive: true });
    const dst = join(dir, "dst");
    git(dir, ["init", "-q", "-b", "main", "dst"]);
    put(dst, "a.txt", "a\n");
    git(dst, ["add", "."]);
    git(dst, ["commit", "-qm", "a"]);
    git(dst, ["branch", "secret"]);
    for (const [k, v] of [
      ["maintenance.auto", "false"],
      ["gc.auto", "0"],
      ["receive.autogc", "false"],
    ]) {
      git(dst, ["config", k, v]);
    }
    git(dir, ["clone", "-q", "--no-local", "dst", "src"]);
    put(join(dir, "src"), "b.txt", "b\n");
    git(join(dir, "src"), ["add", "."]);
    git(join(dir, "src"), ["commit", "-qm", "b"]);
  }

  it("push: the client's receive.denyCurrentBranch=ignore does not reach receive-pack", async () => {
    const n = counter++;
    const theirs = join(root, `p${n}-native`);
    const mine = join(root, `p${n}-ours`);
    pushBase(theirs);
    pushBase(mine);
    const pairs: Array<[string, string]> = [["receive.denyCurrentBranch", "ignore"]];
    const native = run(join(theirs, "src"), [...dashC(pairs), "push", "../dst", "main"]);
    expect(native.status).toBe(1);
    expect(native.stderr).toContain("refusing to update checked out branch");
    const ours = await openWithRemotes(mine, pairs);
    const result = await ours
      .push()
      .setRemote("../dst")
      .add("main")
      .call()
      .catch(() => undefined);
    expect(result?.remoteUpdates[0]?.status === PushStatus.OK).toBe(false);
    const tip = (dir: string) => git(join(dir, "dst"), ["rev-parse", "main"]);
    expect(tip(mine)).toBe(tip(theirs));
  });

  it("fetch: the client's uploadpack.hideRefs does not reach upload-pack", async () => {
    const n = counter++;
    const theirs = join(root, `f${n}-native`);
    const mine = join(root, `f${n}-ours`);
    pushBase(theirs);
    pushBase(mine);
    const pairs: Array<[string, string]> = [["uploadpack.hideRefs", "refs/heads/secret"]];
    const spec = "+refs/heads/*:refs/remotes/d/*";
    git(join(theirs, "src"), [...dashC(pairs), "fetch", "-q", "../dst", spec]);
    const ours = await openWithRemotes(mine, pairs);
    await ours.fetch().setRemote("../dst").setRefSpecs(spec).call();
    const refs = (dir: string) => git(join(dir, "src"), ["for-each-ref", "refs/remotes/d"]);
    expect(refs(mine)).toBe(refs(theirs));
    expect(refs(theirs)).toContain("refs/remotes/d/secret");
  });
});

/** The native git's version as our compatibility setting names it. */
const nativeCompatibility = (): "2.43" | "2.56" =>
  gitAtLeast(execFileSync("git", ["--version"], { encoding: "utf8" }), 2, 44) ? "2.56" : "2.43";

/**
 * Our Git on `repo` with the environment given to the stores too (`createGitFilesBackend`),
 * so their own reads (the ref store's core.logAllRefUpdates) see the command line.
 */
async function openWithStores(
  repo: string,
  pairs: Array<[string, string | undefined]>,
  over: Env = {},
): Promise<Git> {
  const env = clean({ ...nativeGitEnv(home), GIT_CONFIG_PARAMETERS: parametersOf(pairs), ...over });
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env, effectiveUid: null });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

/** The reflogs of a repository (paths below `.git/logs`, each with its line count). */
function reflogs(repo: string): string[] {
  const out = git(repo, ["for-each-ref", "--format=%(refname)"])
    .split("\n")
    .filter(Boolean)
    .concat("HEAD");
  return out
    .map((ref) => {
      try {
        const text = readFileSync(join(repo, ".git", "logs", ref), "latin1");
        return `${ref} ${text.split("\n").filter(Boolean).length}`;
      } catch {
        return `${ref} -`;
      }
    })
    .sort();
}

describeGit("store-internal config reads see -c and the global file (native twins)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cmdline-config-stores-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("-c core.logAllRefUpdates=false: branch writes no reflog", async () => {
    const t = twins();
    const pairs: Array<[string, string]> = [["core.logAllRefUpdates", "false"]];
    git(t.native, [...dashC(pairs), "branch", "b2"]);
    await (await openWithStores(t.ours, pairs)).branchCreate().setName("b2").call();
    expect(reflogs(t.ours)).toEqual(reflogs(t.native));
    expect(reflogs(t.native)).toContain("refs/heads/b2 -");
  });

  it("-c core.logAllRefUpdates=false: checkout -b writes no reflog of the branch", async () => {
    const t = twins();
    const pairs: Array<[string, string]> = [["core.logAllRefUpdates", "false"]];
    git(t.native, [...dashC(pairs), "checkout", "-q", "-b", "b3"]);
    await (await openWithStores(t.ours, pairs))
      .checkout()
      .setCreateBranch(true)
      .setName("b3")
      .call();
    expect(reflogs(t.ours)).toEqual(reflogs(t.native));
    expect(reflogs(t.native)).toContain("refs/heads/b3 -");
  });

  it("-c core.logAllRefUpdates=always: tag writes a reflog", async () => {
    const t = twins();
    const pairs: Array<[string, string]> = [["core.logAllRefUpdates", "always"]];
    git(t.native, [...dashC(pairs), "tag", "t1"]);
    await (await openWithStores(t.ours, pairs)).tag().setName("t1").call();
    expect(reflogs(t.ours)).toEqual(reflogs(t.native));
    expect(reflogs(t.native)).toContain("refs/tags/t1 1");
  });

  it("core.logAllRefUpdates=always in the global file: tag writes a reflog", async () => {
    const t = twins();
    const global = join(root, `global-${counter}.cfg`);
    writeFileSync(global, "[core]\n\tlogAllRefUpdates = always\n");
    // git init wrote `logallrefupdates = true` into each repository: drop it
    for (const repo of [t.native, t.ours])
      git(repo, ["config", "--unset", "core.logAllRefUpdates"]);
    const over: Env = { GIT_CONFIG_GLOBAL: global };
    git(t.native, ["tag", "t2"], { ...nativeGitEnv(home), ...over });
    await (await openWithStores(t.ours, [], over)).tag().setName("t2").call();
    expect(reflogs(t.ours)).toEqual(reflogs(t.native));
    expect(reflogs(t.native)).toContain("refs/tags/t2 1");
  });
});

describeGit("command-line includes and conditions as git reads them (native twins)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "cmdline-config-includes-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  /** Our config of `repo`, `pairs` on the command line, read as `compatibility`. */
  async function configOf(repo: string, pairs: Array<[string, string]>, over: Env = {}) {
    const env = clean({
      ...nativeGitEnv(home),
      GIT_CONFIG_PARAMETERS: parametersOf(pairs),
      ...over,
    });
    const environment = createNodeGitHostEnvironment({ env, effectiveUid: null });
    const config = new GitWorkingCopyConfig(
      {
        read: async (path: string) => {
          try {
            return new Uint8Array(readFileSync(join(repo, path)));
          } catch {
            return undefined;
          }
        },
        write: async () => undefined,
        rootDirectory: repo,
      },
      ".git/config",
      { environment, gitDirPath: join(repo, ".git"), compatibility: nativeCompatibility() },
    );
    await config.load();
    return config;
  }

  it("includeIf.gitdir:./ from -c: git's error, applied by 2.5x only", async () => {
    const t = twins();
    const included = join(root, `cond-${counter}.cfg`);
    writeFileSync(included, "[x]\n\ty = 1\n");
    const pairs: Array<[string, string]> = [["includeIf.gitdir:./.path", included]];
    const native = run(t.native, [...dashC(pairs), "config", "x.y"]);
    const config = await configOf(t.ours, pairs);
    const value = config.get("x.y");
    expect({
      status: value === undefined ? 1 : 0,
      stdout: value === undefined ? "" : `${value}\n`,
      stderr: config.loadErrors.map((l) => `${l}\n`).join(""),
    }).toEqual(native);
    expect(native.stderr).toBe(
      "error: relative config include conditionals must come from files\n",
    );
    expect(native.status).toBe(nativeCompatibility() === "2.43" ? 1 : 0);
  });

  it("-c include.path naming a directory: git's warning, then fatal", async () => {
    const t = twins();
    const dir = join(root, `adir-${counter}`);
    mkdirSync(dir);
    const pairs: Array<[string, string]> = [["include.path", dir]];
    const native = run(t.native, [...dashC(pairs), "status"]);
    expect(native.status).toBe(128);
    const error = await open(t.ours, pairs).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CommandLineConfigError);
    expect((error as CommandLineConfigError).exitCode).toBe(128);
    expect(`${(error as Error).message}\n`).toBe(native.stderr);
  });

  it("an include loop through -c: git's fatal, absolute paths", async () => {
    const t = twins();
    const one = join(root, `loop1-${counter}.cfg`);
    const two = join(root, `loop2-${counter}.cfg`);
    writeFileSync(one, `[include]\n\tpath = ${two}\n`);
    writeFileSync(two, `[include]\n\tpath = ${one}\n`);
    const pairs: Array<[string, string]> = [["include.path", one]];
    const native = run(t.native, [...dashC(pairs), "status"]);
    expect(native.status).toBe(128);
    const error = await open(t.ours, pairs).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ConfigIncludeDepthError);
    expect((error as ConfigIncludeDepthError).exitCode).toBe(128);
    expect(`${(error as Error).message}\n`).toBe(native.stderr);
  });

  it("includeIf.hasconfig:remote.*.url: matches the repository's remotes and -c includes'", async () => {
    const t = twins();
    for (const repo of [t.native, t.ours]) {
      git(repo, ["remote", "add", "origin", "https://example.com/r.git"]);
    }
    const viaRepo = join(root, `has-repo-${counter}.cfg`);
    writeFileSync(viaRepo, "[foo]\n\trepo = yes\n");
    const remotes = join(root, `has-remotes-${counter}.cfg`);
    writeFileSync(remotes, '[remote "x"]\n\turl = https://h/z\n');
    const viaCli = join(root, `has-cli-${counter}.cfg`);
    writeFileSync(viaCli, "[foo]\n\tcli = yes\n");
    const pairs: Array<[string, string]> = [
      ["includeIf.hasconfig:remote.*.url:https://example.com/**.path", viaRepo],
      ["include.path", remotes],
      ["includeIf.hasconfig:remote.*.url:https://h/**.path", viaCli],
      ["includeIf.hasconfig:remote.*.url:https://nowhere/**.path", viaCli],
    ];
    const theirs = git(t.native, [...dashC(pairs), "config", "--get-regexp", "^foo\\."]);
    expect(theirs).toBe("foo.repo yes\nfoo.cli yes\n");
    const config = await configOf(t.ours, pairs);
    const ours = config
      .listWithOrigin()
      .filter((e) => e.key.startsWith("foo."))
      .map((e) => `${e.key} ${e.text}\n`)
      .join("");
    expect(ours).toBe(theirs);
  });

  it("the protected config's hasconfig sees remote URLs a -c include brings in", async () => {
    const t = twins();
    const remotes = join(root, `prot-remotes-${counter}.cfg`);
    writeFileSync(remotes, '[remote "x"]\n\turl = https://h/z\n');
    const safe = join(root, `prot-safe-${counter}.cfg`);
    writeFileSync(safe, "[safe]\n\tdirectory = *\n");
    const pairs: Array<[string, string]> = [
      ["include.path", remotes],
      ["includeIf.hasconfig:remote.*.url:https://h/**.path", safe],
    ];
    const over: Env = { GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };
    const outcome = async (p: Array<[string, string]>) => {
      const env = clean({ ...nativeGitEnv(home), GIT_CONFIG_PARAMETERS: parametersOf(p), ...over });
      const environment = createNodeGitHostEnvironment({ env });
      const files = createNodeFilesApi({ rootDir: "/" });
      return discoverRepository({ files, cwd: t.ours, environment }).then(
        () => 0,
        (e: unknown) => (e as { exitCode?: number }).exitCode ?? 1,
      );
    };
    const native = (p: Array<[string, string]>) =>
      run(t.native, [...dashC(p), "status", "-s"], { ...nativeGitEnv(home), ...over }).status;
    expect(native(pairs)).toBe(0);
    expect(await outcome(pairs)).toBe(0);
    expect(native(pairs.slice(1))).toBe(128);
    expect(await outcome(pairs.slice(1))).toBe(128);
  });
});
