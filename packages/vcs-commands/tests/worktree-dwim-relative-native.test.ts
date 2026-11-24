/**
 * `git worktree add`'s tracking options (`--track`, `--no-track`, `--guess-remote`,
 * `worktree.guessRemote`), relative worktree links (`--relative-paths`,
 * `worktree.useRelativePaths`, `extensions.relativeWorktrees`) through add, move, repair and
 * prune, and checkout's / switch's remote-branch DWIM (`checkout.defaultRemote`), against
 * native git.
 *
 * Each scenario is built twice by native git with fixed dates (same ids); one twin is
 * changed by native git, the other by our commands, and both are compared whole: every file
 * outside `objects/` and the indexes (configs, refs, reflogs, the worktrees' admin files and
 * `.git` files, the checked-out files), with each twin's directory written `<base>`, and
 * what each side printed. Relative links are 2.48+: those twins are skipped under 2.43.
 *
 * Run it against the system git (2.43) and against 2.56.1 first on `PATH`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, TrackMode, WorktreeError } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** The native git's version as [major, minor]. */
function nativeVersion(): [number, number] {
  try {
    const text = execFileSync("git", ["--version"], { encoding: "latin1" });
    const m = /(\d+)\.(\d+)/.exec(text) ?? ["", "0", "0"];
    return [Number(m[1]), Number(m[2])];
  } catch {
    return [0, 0];
  }
}
const [MAJOR, MINOR] = nativeVersion();
/** git 2.43 (the sandbox's system git): no relative worktrees, other DWIM wording. */
const LEGACY = MAJOR < 2 || (MAJOR === 2 && MINOR < 48);
const COMPAT: "2.43" | "2.56" = LEGACY ? "2.43" : "2.56";
/** Relative worktree links: git 2.48+. */
const itRelative = LEGACY ? it.skip : it;

let root = "";
let home = "";
let counter = 0;

/** git's environment with `-c` settings (`GIT_CONFIG_COUNT`) added: native's and ours alike. */
function envWith(config: Record<string, string> = {}): Record<string, string> {
  const env = nativeGitEnv(home);
  let n = Number(env.GIT_CONFIG_COUNT ?? "0");
  for (const [key, value] of Object.entries(config)) {
    env[`GIT_CONFIG_KEY_${n}`] = key;
    env[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: envWith(),
    encoding: "latin1",
    stdio: ["ignore", "pipe", "pipe"],
  });
/** Native git that may fail. */
const attempt = (cwd: string, args: string[], config: Record<string, string> = {}) => {
  const r = spawnSync("git", args, { cwd, env: envWith(config), encoding: "latin1" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
const commit = (repo: string, name: string) =>
  run(repo, "commit", "-q", "--allow-empty", "-m", name);

/** A scenario built twice: `native` and `ours`, the directories holding the repositories. */
function twins(build: (base: string) => void): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `t${n}-native`);
  const ours = join(root, `t${n}-ours`);
  for (const base of [native, ours]) {
    mkdirSync(base, { recursive: true });
    build(base);
  }
  return { native, ours };
}

/**
 * t2400's `setup_remote_repo`: `upstream` (main, foo) and `local` (main) with `upstream` as
 * remote `<remote>` fetching `refs/heads/*:refs/remotes/<remote>/*`.
 */
function setupRemoteRepo(base: string, upstream: string, local: string): void {
  run(base, "init", "-q", "-b", "main", upstream);
  commit(join(base, upstream), `${upstream}_main`);
  run(join(base, upstream), "checkout", "-q", "-b", "foo");
  commit(join(base, upstream), "upstream_foo");
  run(base, "init", "-q", "-b", "main", local);
  const repo = join(base, local);
  commit(repo, `${local}_main`);
  run(repo, "remote", "add", upstream, `../${upstream}`);
  run(repo, "config", `remote.${upstream}.fetch`, `refs/heads/*:refs/remotes/${upstream}/*`);
  run(repo, "fetch", "-q", "--all");
}

/** A plain repository `main` with one commit. */
function setupMain(base: string): void {
  run(base, "init", "-q", "-b", "main", "main");
  commit(join(base, "main"), "init");
}

/** Our Git on the repository whose git directory is `gitDir` (relative to `base`). */
async function open(
  base: string,
  gitDir: string,
  config: Record<string, string> = {},
  commonDir = gitDir,
): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: base });
  const environment = createNodeGitHostEnvironment({ env: envWith(config) });
  const { history } = await createGitFilesBackend({ files, gitDir: commonDir, environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir, history, environment });
  return Git.fromWorktreeAdmin(await worktrees.openAdmin());
}

/** Every file of a twin but objects and indexes, `base` written `<base>`. */
function snapshot(base: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(base, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "objects" || entry.name === "hooks") continue;
        walk(path);
        continue;
      }
      if (entry.name === "index" || entry.name === "FETCH_HEAD") continue;
      out[path] = readFileSync(join(base, path), "latin1").split(base).join("<base>");
    }
  };
  walk("");
  return out;
}

function expectSame(t: { native: string; ours: string }): void {
  const n = snapshot(t.native);
  const o = snapshot(t.ours);
  expect(Object.keys(o).sort()).toEqual(Object.keys(n).sort());
  for (const key of Object.keys(n)) expect([key, o[key]]).toEqual([key, n[key]]);
}

const lines = (list: string[]) => list.map((l) => `${l}\n`).join("");
const norm = (text: string, base: string) => text.split(base).join("<base>");

/** What our call printed on stderr as git dies (hints, then `fatal: <message>`). */
async function death(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    if (error instanceof WorktreeError) {
      return `${lines(error.messages)}fatal: ${error.message}\n`;
    }
    return `${(error as Error).message}\n`;
  }
  return "(no error)";
}

/** Native `git worktree add` and ours, compared: exit, stderr, stdout, then the twins. */
async function addTwin(
  t: { native: string; ours: string },
  repo: string,
  args: string[],
  ours: (git: Git, base: string) => Promise<{ messages: string[]; output: string[] }>,
  config: Record<string, string> = {},
): Promise<void> {
  const r = attempt(
    join(t.native, repo),
    ["worktree", "add", ...args.map((a) => a.replace("<base>", t.native))],
    config,
  );
  const git = await open(t.ours, `${repo}/.git`, config);
  if (r.status !== 0) {
    expect(norm(await death(() => ours(git, t.ours)), t.ours)).toBe(norm(r.stderr, t.native));
  } else {
    const result = await ours(git, t.ours);
    expect([args, norm(lines(result.messages), t.ours)]).toEqual([args, norm(r.stderr, t.native)]);
    expect([args, norm(lines(result.output), t.ours)]).toEqual([args, norm(r.stdout, t.native)]);
  }
  expectSame(t);
}

describeGit("worktree tracking, relative links, checkout DWIM: native twins", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "wt-dwim-rel-"));
    home = join(root, "home");
    mkdirSync(home);
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------ tracking

  it('t2400-worktree-add.sh: "--track sets up tracking"', async () => {
    const t = twins(setupMain);
    await addTwin(t, "main", ["--track", "-b", "track", "<base>/track", "main"], (git, base) =>
      git
        .worktreeAdd()
        .setPath(join(base, "track"))
        .setNewBranch("track")
        .setCommitish("main")
        .setTrack(TrackMode.DIRECT)
        .setCompatibility(COMPAT)
        .call(),
    );
    // --[no-]track without a new branch
    await addTwin(t, "main", ["--track", "--detach", "<base>/det"], (git, base) =>
      git
        .worktreeAdd()
        .setPath(join(base, "det"))
        .setDetach(true)
        .setTrack(TrackMode.DIRECT)
        .setCompatibility(COMPAT)
        .call(),
    );
  });

  it('t2400-worktree-add.sh: "--no-track avoids setting up tracking"', async () => {
    const t = twins((base) => setupRemoteRepo(base, "repo_upstream", "repo_local"));
    await addTwin(
      t,
      "repo_local",
      ["--no-track", "-b", "foo", "<base>/foo", "repo_upstream/foo"],
      (git, base) =>
        git
          .worktreeAdd()
          .setPath(join(base, "foo"))
          .setNewBranch("foo")
          .setCommitish("repo_upstream/foo")
          .setTrack(TrackMode.NONE)
          .setCompatibility(COMPAT)
          .call(),
    );
    // without --no-track, branch.autoSetupMerge tracks the remote-tracking start
    await addTwin(t, "repo_local", ["-b", "bar", "<base>/bar", "repo_upstream/foo"], (git, base) =>
      git
        .worktreeAdd()
        .setPath(join(base, "bar"))
        .setNewBranch("bar")
        .setCommitish("repo_upstream/foo")
        .setCompatibility(COMPAT)
        .call(),
    );
  });

  // t2400-worktree-add.sh: '"add" <path> <branch> dwims'
  it("worktree add <path> <branch> dwims", async () => {
    const t = twins((base) => setupRemoteRepo(base, "repo_upstream", "repo_dwim"));
    await addTwin(t, "repo_dwim", ["<base>/foo", "foo"], (git, base) =>
      git
        .worktreeAdd()
        .setPath(join(base, "foo"))
        .setCommitish("foo")
        .setCompatibility(COMPAT)
        .call(),
    );
  });

  // t2400-worktree-add.sh: '"add" <path> <branch> does not dwim with -b'
  it("worktree add <path> <branch> does not dwim with -b", async () => {
    const t = twins((base) => setupRemoteRepo(base, "repo_upstream", "repo_dwim"));
    await addTwin(t, "repo_dwim", ["-b", "branch", "<base>/wt", "foo"], (git, base) =>
      git
        .worktreeAdd()
        .setPath(join(base, "wt"))
        .setNewBranch("branch")
        .setCommitish("foo")
        .setCompatibility(COMPAT)
        .call(),
    );
  });

  // t2400-worktree-add.sh: '"add" <path> <branch> dwims with checkout.defaultRemote'
  it("worktree add <path> <branch> dwims with checkout.defaultRemote", async () => {
    const t = twins((base) => {
      setupRemoteRepo(base, "repo_upstream", "repo_dwim");
      const repo = join(base, "repo_dwim");
      run(repo, "remote", "add", "repo_upstream2", "../repo_upstream");
      run(repo, "fetch", "-q", "repo_upstream2");
    });
    // ambiguous: 2.5x dies with its advice, 2.43 takes it for no remote branch at all
    await addTwin(t, "repo_dwim", ["<base>/foo", "foo"], (git, base) =>
      git
        .worktreeAdd()
        .setPath(join(base, "foo"))
        .setCommitish("foo")
        .setCompatibility(COMPAT)
        .call(),
    );
    const config = { "checkout.defaultRemote": "repo_upstream" };
    await addTwin(
      t,
      "repo_dwim",
      ["<base>/foo", "foo"],
      (git, base) =>
        git
          .worktreeAdd()
          .setPath(join(base, "foo"))
          .setCommitish("foo")
          .setCompatibility(COMPAT)
          .call(),
      config,
    );
  });

  it('t2400-worktree-add.sh: "git worktree add does not match remote"', async () => {
    const t = twins((base) => setupRemoteRepo(base, "repo_a", "repo_b"));
    await addTwin(t, "repo_b", ["<base>/foo"], (git, base) =>
      git.worktreeAdd().setPath(join(base, "foo")).setCompatibility(COMPAT).call(),
    );
  });

  it('t2400-worktree-add.sh: "git worktree add --guess-remote sets up tracking"', async () => {
    const t = twins((base) => setupRemoteRepo(base, "repo_a", "repo_b"));
    await addTwin(t, "repo_b", ["--guess-remote", "<base>/foo"], (git, base) =>
      git
        .worktreeAdd()
        .setPath(join(base, "foo"))
        .setGuessRemote(true)
        .setCompatibility(COMPAT)
        .call(),
    );
  });

  it('t2400-worktree-add.sh: "git worktree add --guess-remote fails if there are multiple matches"', async () => {
    const t = twins((base) => {
      setupRemoteRepo(base, "repo_a", "repo_b");
      run(join(base, "repo_b"), "remote", "add", "repo_a2", "../repo_a");
      run(join(base, "repo_b"), "fetch", "-q", "repo_a2");
    });
    await addTwin(t, "repo_b", ["--guess-remote", "<base>/foo"], (git, base) =>
      git
        .worktreeAdd()
        .setPath(join(base, "foo"))
        .setGuessRemote(true)
        .setCompatibility(COMPAT)
        .call(),
    );
  });

  it('t2400-worktree-add.sh: "git worktree add --guess-remote sets up tracking (quiet)"', async () => {
    const t = twins((base) => setupRemoteRepo(base, "repo_a", "repo_b"));
    await addTwin(t, "repo_b", ["--quiet", "--guess-remote", "<base>/foo"], (git, base) =>
      git
        .worktreeAdd()
        .setPath(join(base, "foo"))
        .setQuiet(true)
        .setGuessRemote(true)
        .setCompatibility(COMPAT)
        .call(),
    );
  });

  it('t2400-worktree-add.sh: "git worktree --no-guess-remote (quiet)"', async () => {
    const t = twins((base) => setupRemoteRepo(base, "repo_a", "repo_b"));
    await addTwin(t, "repo_b", ["--quiet", "--no-guess-remote", "<base>/foo"], (git, base) =>
      git
        .worktreeAdd()
        .setPath(join(base, "foo"))
        .setQuiet(true)
        .setGuessRemote(false)
        .setCompatibility(COMPAT)
        .call(),
    );
  });

  it('t2400-worktree-add.sh: "git worktree add with worktree.guessRemote sets up tracking", "git worktree --no-guess-remote option overrides config"', async () => {
    const t = twins((base) => {
      setupRemoteRepo(base, "repo_a", "repo_b");
      run(join(base, "repo_b"), "config", "worktree.guessRemote", "true");
      // a second branch for --no-guess-remote to leave alone
      run(join(base, "repo_a"), "branch", "bar");
      run(join(base, "repo_b"), "fetch", "-q", "--all");
    });
    await addTwin(t, "repo_b", ["<base>/foo"], (git, base) =>
      git.worktreeAdd().setPath(join(base, "foo")).setCompatibility(COMPAT).call(),
    );
    await addTwin(t, "repo_b", ["--no-guess-remote", "<base>/bar"], (git, base) =>
      git
        .worktreeAdd()
        .setPath(join(base, "bar"))
        .setGuessRemote(false)
        .setCompatibility(COMPAT)
        .call(),
    );
  });

  // ------------------------------------------------------------------ relative links

  itRelative('t2400-worktree-add.sh: "can create worktrees with relative paths"', async () => {
    const t = twins((base) => {
      setupMain(base);
      run(join(base, "main"), "config", "worktree.useRelativePaths", "false");
    });
    await addTwin(t, "main", ["--relative-paths", "<base>/main/relative"], (git, base) =>
      git.worktreeAdd().setPath(join(base, "main/relative")).setRelativePaths(true).call(),
    );
    expect(readFileSync(join(t.ours, "main/relative/.git"), "latin1")).toBe(
      "gitdir: ../.git/worktrees/relative\n",
    );
    expect(readFileSync(join(t.ours, "main/.git/worktrees/relative/gitdir"), "latin1")).toBe(
      "../../../relative/.git\n",
    );
  });

  itRelative('t2400-worktree-add.sh: "can create worktrees with absolute paths"', async () => {
    const t = twins((base) => {
      setupMain(base);
      run(join(base, "main"), "config", "worktree.useRelativePaths", "true");
    });
    await addTwin(t, "main", ["<base>/main/relative"], (git, base) =>
      git.worktreeAdd().setPath(join(base, "main/relative")).call(),
    );
    await addTwin(t, "main", ["--no-relative-paths", "<base>/main/absolute"], (git, base) =>
      git.worktreeAdd().setPath(join(base, "main/absolute")).setRelativePaths(false).call(),
    );
  });

  itRelative('t2400-worktree-add.sh: "relative worktree sets extension config"', async () => {
    const t = twins(setupMain);
    await addTwin(t, "main", ["--relative-paths", "<base>/foo"], (git, base) =>
      git.worktreeAdd().setPath(join(base, "foo")).setRelativePaths(true).call(),
    );
    const config = readFileSync(join(t.ours, "main/.git/config"), "latin1");
    expect(config).toContain("repositoryformatversion = 1");
    expect(config).toContain("relativeWorktrees = true");
    // a second one leaves the configuration as it is
    await addTwin(t, "main", ["--relative-paths", "<base>/bar"], (git, base) =>
      git.worktreeAdd().setPath(join(base, "bar")).setRelativePaths(true).call(),
    );
  });

  itRelative(
    't2400-worktree-add.sh: "move repo without breaking relative internal links"',
    async () => {
      const t = twins((base) => {
        setupMain(base);
        run(join(base, "main"), "worktree", "add", "-q", "--relative-paths", "wt1");
        execFileSync("mv", [join(base, "main"), join(base, "moved")]);
      });
      const native = attempt(join(t.native, "moved/wt1"), ["worktree", "list", "--porcelain"]);
      expect(native.stderr).toBe("");
      // ours reads both relative links: listed, opened, its status clean
      const git = await open(t.ours, "moved/.git/worktrees/wt1", {}, "moved/.git");
      const list = await git.worktreeList().setFormat("porcelain").call();
      expect(norm(list.output, t.ours)).toBe(norm(native.stdout, t.native));
      const status = await git.status().call();
      expect(status.isClean()).toBe(true);
    },
  );

  itRelative(
    't2401-worktree-prune.sh: "not prune proper worktrees inside linked worktree with relative paths"',
    async () => {
      const t = twins((base) => {
        setupMain(base);
        const repo = join(base, "main");
        run(repo, "config", "worktree.useRelativePaths", "true");
        run(repo, "worktree", "add", "-q", "../wt_ext");
        run(repo, "worktree", "add", "-q", "wt_int");
      });
      for (const gitDir of ["main/.git/worktrees/wt_int", "main/.git/worktrees/wt_ext"]) {
        const cwd = join(t.native, gitDir.endsWith("wt_int") ? "main/wt_int" : "wt_ext");
        const r = attempt(cwd, ["worktree", "prune", "-v"]);
        expect(r.stdout + r.stderr).toBe("");
        const result = await (await open(t.ours, gitDir, {}, "main/.git"))
          .worktreePrune()
          .setVerbose(true)
          .call();
        expect(result.messages).toEqual([]);
      }
      expectSame(t);
    },
  );

  itRelative(
    't2403-worktree-move.sh: "move worktree with absolute path to relative path", "move worktree with relative path to absolute path"',
    async () => {
      const t = twins((base) => {
        setupMain(base);
        run(join(base, "main"), "config", "worktree.useRelativePaths", "false");
        run(join(base, "main"), "worktree", "add", "-q", "./absolute");
      });
      const steps: Array<{ args: string[]; config?: Record<string, string>; rel?: boolean }> = [
        { args: ["--relative-paths", "absolute", "relative"], rel: true },
        // worktree.useRelativePaths keeps it relative
        { args: ["relative", "relative2"], config: { "worktree.useRelativePaths": "true" } },
        {
          args: ["--no-relative-paths", "relative2", "absolute"],
          config: { "worktree.useRelativePaths": "true" },
          rel: false,
        },
      ];
      for (const step of steps) {
        const r = attempt(join(t.native, "main"), ["worktree", "move", ...step.args], step.config);
        expect(r.status).toBe(0);
        const git = await open(t.ours, "main/.git", step.config);
        const [from, to] = step.args.slice(-2);
        const move = git
          .worktreeMove()
          .setWorktree(from)
          .setDestination(join(t.ours, "main", to));
        if (step.rel !== undefined) move.setRelativePaths(step.rel);
        await move.call();
        expectSame(t);
      }
      expect(readFileSync(join(t.ours, "main/absolute/.git"), "latin1")).toBe(
        `gitdir: ${t.ours}/main/.git/worktrees/absolute\n`,
      );
    },
  );

  itRelative(
    't2406-worktree-repair.sh: "repair worktree with relative path with missing gitfile"',
    async () => {
      const t = twins((base) => {
        setupMain(base);
        run(join(base, "main"), "config", "worktree.useRelativePaths", "true");
        run(join(base, "main"), "worktree", "add", "-q", "--detach", "../wt");
        rmSync(join(base, "wt/.git"));
      });
      const r = attempt(join(t.native, "main"), ["worktree", "repair"]);
      const mine = await (await open(t.ours, "main/.git")).worktreeRepair().call();
      expect(norm(lines(mine.messages), t.ours)).toBe(norm(r.stderr, t.native));
      expect(mine.ok).toBe(r.status === 0);
      expectSame(t);
      expect(readFileSync(join(t.ours, "wt/.git"), "latin1")).toBe(
        "gitdir: ../main/.git/worktrees/wt\n",
      );
    },
  );

  const repairCases: Array<{
    title: string;
    addRelative: boolean;
    repairArgs: string[];
    config?: string;
    relative?: boolean;
  }> = [
    {
      // t2406-worktree-repair.sh: "repair absolute to relative from side worktree"
      title: '"repair absolute to relative from side worktree"',
      addRelative: false,
      repairArgs: ["--relative-paths", "../side"],
      relative: true,
    },
    {
      // t2406-worktree-repair.sh: "repair relative to absolute from side worktree"
      title: '"repair relative to absolute from side worktree"',
      addRelative: true,
      repairArgs: ["../side"],
    },
    {
      // t2406-worktree-repair.sh: "repair absolute to relative from main worktree"
      title: '"repair absolute to relative from main worktree"',
      addRelative: false,
      repairArgs: [],
      config: "true",
    },
    {
      // t2406-worktree-repair.sh: "repair relative to absolute from main worktree"
      title: '"repair relative to absolute from main worktree"',
      addRelative: true,
      repairArgs: [],
      config: "false",
    },
  ];
  for (const c of repairCases) {
    itRelative(`t2406-worktree-repair.sh: ${c.title}`, async () => {
      const t = twins((base) => {
        setupMain(base);
        const repo = join(base, "main");
        const flag = c.addRelative ? "--relative-paths" : "--no-relative-paths";
        run(repo, "worktree", "add", "-q", flag, "--detach", "../side");
        if (c.config !== undefined) run(repo, "config", "worktree.useRelativePaths", c.config);
      });
      const r = attempt(join(t.native, "main"), ["worktree", "repair", ...c.repairArgs]);
      const repair = (await open(t.ours, "main/.git")).worktreeRepair();
      if (c.repairArgs.includes("../side")) repair.addPath(join(t.ours, "side"));
      if (c.relative !== undefined) repair.setRelativePaths(c.relative);
      const mine = await repair.call();
      expect(norm(lines(mine.messages), t.ours)).toBe(norm(r.stderr, t.native));
      expect(mine.ok).toBe(r.status === 0);
      expectSame(t);
    });
  }

  it("worktree repair without --relative-paths rewrites relative links as absolute ones (the rollback)", async () => {
    if (LEGACY) return;
    const t = twins((base) => {
      setupMain(base);
      run(join(base, "main"), "worktree", "add", "-q", "--relative-paths", "--detach", "../side");
    });
    run(join(t.native, "main"), "worktree", "repair", "../side");
    const mine = await (await open(t.ours, "main/.git"))
      .worktreeRepair()
      .addPath(join(t.ours, "side"))
      .call();
    expect(mine.ok).toBe(true);
    expectSame(t);
    expect(readFileSync(join(t.ours, "side/.git"), "latin1")).toBe(
      `gitdir: ${t.ours}/main/.git/worktrees/side\n`,
    );
    // native git reads ours back
    expect(run(join(t.ours, "side"), "status", "--porcelain")).toBe("");
  });

  it("2.43 compatibility: no relative links", async () => {
    const t = twins(setupMain);
    const git = await open(t.ours, "main/.git", { "worktree.useRelativePaths": "true" });
    // worktree.useRelativePaths is unknown to 2.43: absolute links
    await git.worktreeAdd().setPath(join(t.ours, "abs")).setCompatibility("2.43").call();
    expect(readFileSync(join(t.ours, "abs/.git"), "latin1")).toBe(
      `gitdir: ${t.ours}/main/.git/worktrees/abs\n`,
    );
    expect(readFileSync(join(t.ours, "main/.git/config"), "latin1")).not.toContain(
      "relativeWorktrees",
    );
    await expect(
      (await open(t.ours, "main/.git"))
        .worktreeAdd()
        .setPath(join(t.ours, "rel"))
        .setRelativePaths(true)
        .setCompatibility("2.43")
        .call(),
    ).rejects.toThrow("unknown option `relative-paths'");
  });

  // ------------------------------------------------------------------ checkout DWIM

  /** t2024's setup: remotes repo_a and repo_b (fetching into other_b), fetched. */
  function setupDwim(base: string): void {
    run(base, "init", "-q", "-b", "main", "repo");
    const repo = join(base, "repo");
    commit(repo, "my_main");
    const remote = (name: string, branches: string[]) => {
      run(repo, "init", "-q", "-b", "main", name);
      const at = join(repo, name);
      commit(at, `${name}_main`);
      for (const b of branches) {
        run(at, "checkout", "-q", "-b", b);
        commit(at, `${name}_${b}`);
      }
    };
    remote("repo_a", ["foo", "bar", "ambiguous_branch_and_file"]);
    remote("repo_b", ["foo", "baz", "ambiguous_branch_and_file"]);
    run(repo, "remote", "add", "repo_a", "repo_a");
    run(repo, "remote", "add", "repo_b", "repo_b");
    run(repo, "config", "remote.repo_b.fetch", "+refs/heads/*:refs/remotes/other_b/*");
    run(repo, "fetch", "-q", "--all");
  }

  /** t2024's "setup more remotes with unconventional refspecs". */
  function setupMoreRemotes(base: string): void {
    setupDwim(base);
    const repo = join(base, "repo");
    for (const [name, branches] of [
      ["repo_c", ["bar", "spam"]],
      ["repo_d", ["baz", "eggs"]],
    ] as const) {
      run(repo, "init", "-q", "-b", "main", name);
      const at = join(repo, name);
      commit(at, `${name.slice(-1)}_main`);
      for (const b of branches) {
        run(at, "checkout", "-q", "-b", b);
        commit(at, `${name.slice(-1)}_${b}`);
      }
    }
    run(repo, "remote", "add", "repo_c", "repo_c");
    run(
      repo,
      "config",
      "remote.repo_c.fetch",
      "+refs/heads/*:refs/remotes/extra_dir/repo_c/extra_dir/*",
    );
    run(repo, "remote", "add", "repo_d", "repo_d");
    run(repo, "config", "remote.repo_d.fetch", "+refs/heads/*:refs/repo_d/*");
    run(repo, "fetch", "-q", "--all");
  }

  /** `git checkout <name>` (or `git switch`) on both twins: exit, stderr, then the twins. */
  async function dwimTwin(
    t: { native: string; ours: string },
    command: "checkout" | "switch",
    name: string,
    options: { config?: Record<string, string>; guess?: boolean } = {},
  ): Promise<void> {
    const args = [command, ...(options.guess === false ? ["--no-guess"] : []), name];
    if (command === "checkout") args.push("--");
    const r = attempt(join(t.native, "repo"), args, options.config);
    const git = await open(t.ours, "repo/.git", options.config);
    const call = async () => {
      if (command === "switch") {
        const cmd = git.switch().setName(name).setCompatibility(COMPAT);
        if (options.guess !== undefined) cmd.setGuess(options.guess);
        return cmd.call();
      }
      const cmd = git.checkout().setName(name).setCompatibility(COMPAT);
      if (options.guess !== undefined) cmd.setGuess(options.guess);
      return cmd.call();
    };
    if (r.status !== 0) {
      let message = "(no error)";
      try {
        await call();
      } catch (error) {
        message = `${(error as Error).message}\n`;
      }
      expect([args, message]).toEqual([args, r.stderr]);
    } else {
      await call();
    }
    expectSame(t);
  }

  /** Back on main, `name` deleted, in both twins (t2024's `git checkout -B main` + `branch -D`). */
  function reset(t: { native: string; ours: string }, name: string): void {
    for (const base of [t.native, t.ours]) {
      const repo = join(base, "repo");
      run(repo, "checkout", "-q", "-B", "main");
      if (existsSync(join(repo, ".git/refs/heads", name))) run(repo, "branch", "-q", "-D", name);
    }
  }

  it('t2024-checkout-dwim.sh: "checkout of non-existing branch fails", "checkout of branch from multiple remotes fails #1", "checkout of branch from multiple remotes fails with advice"', async () => {
    const t = twins(setupDwim);
    for (const command of ["checkout", "switch"] as const) {
      reset(t, "xyzzy");
      await dwimTwin(t, command, "xyzzy");
      reset(t, "foo");
      await dwimTwin(t, command, "foo");
      await dwimTwin(t, command, "foo", {
        config: { "advice.checkoutAmbiguousRemoteBranchName": "false" },
      });
    }
  });

  it('t2024-checkout-dwim.sh: "checkout of branch from multiple remotes succeeds with checkout.defaultRemote #1"', async () => {
    const t = twins(setupDwim);
    for (const command of ["checkout", "switch"] as const) {
      reset(t, "foo");
      await dwimTwin(t, command, "foo", { config: { "checkout.defaultRemote": "repo_a" } });
    }
  });

  it('t2024-checkout-dwim.sh: "checkout of branch from a single remote succeeds #1", "checkout of branch from a single remote succeeds #2"', async () => {
    const t = twins(setupDwim);
    for (const command of ["checkout", "switch"] as const) {
      for (const name of ["bar", "baz"]) {
        reset(t, name);
        await dwimTwin(t, command, name);
      }
    }
  });

  it('t2024-checkout-dwim.sh: "--no-guess suppresses branch auto-vivification", "checkout.guess = false suppresses branch auto-vivification"', async () => {
    const t = twins(setupDwim);
    for (const command of ["checkout", "switch"] as const) {
      reset(t, "bar");
      await dwimTwin(t, command, "bar", { guess: false });
      await dwimTwin(t, command, "bar", { config: { "checkout.guess": "false" } });
    }
  });

  it('t2024-checkout-dwim.sh: "checkout of branch from multiple remotes fails #2", "checkout of branch from multiple remotes fails #3", "checkout of branch from a single remote succeeds #3", "checkout of branch from a single remote succeeds #4"', async () => {
    const t = twins(setupMoreRemotes);
    for (const command of ["checkout", "switch"] as const) {
      for (const name of ["bar", "baz", "spam", "eggs"]) {
        reset(t, name);
        await dwimTwin(t, command, name);
      }
    }
  });

  it('t2024-checkout-dwim.sh: "checkout <branch> -- succeeds, even if a file with the same name exists"', async () => {
    const t = twins((base) => {
      setupMoreRemotes(base);
      execFileSync("touch", [join(base, "repo/spam")]);
    });
    reset(t, "spam");
    await dwimTwin(t, "checkout", "spam");
  });

  // ------------------------------------------------------------------ format upgrade refusal

  /** A version-0 repository `main` with an extension git does not know (v0 ignores it). */
  function setupUnknownExtension(base: string): void {
    setupMain(base);
    run(join(base, "main"), "config", "extensions.foo", "bar");
  }

  itRelative(
    "relative add refused in a version-0 repository with an unknown extension (upgrade_repository_format)",
    async () => {
      const t = twins(setupUnknownExtension);
      // the DWIM branch is made before (git's `git branch` child), the worktree never
      await addTwin(t, "main", ["--relative-paths", "<base>/wt"], (git, base) =>
        git.worktreeAdd().setPath(join(base, "wt")).setRelativePaths(true).call(),
      );
      await addTwin(t, "main", ["--relative-paths", "--detach", "<base>/det"], (git, base) =>
        git.worktreeAdd().setPath(join(base, "det")).setDetach(true).setRelativePaths(true).call(),
      );
      for (const base of [t.native, t.ours]) {
        expect(existsSync(join(base, "wt"))).toBe(false);
        expect(existsSync(join(base, "det"))).toBe(false);
        expect(readFileSync(join(base, "main/.git/config"), "latin1")).toContain(
          "repositoryformatversion = 0",
        );
      }
    },
  );

  itRelative(
    "relative repair refused in a version-0 repository with an unknown extension",
    async () => {
      const t = twins((base) => {
        setupUnknownExtension(base);
        run(join(base, "main"), "worktree", "add", "-q", "--detach", "../side");
      });
      const r = attempt(join(t.native, "main"), [
        "worktree",
        "repair",
        "--relative-paths",
        "../side",
      ]);
      expect(r.status).toBe(128);
      const ours = await death(() =>
        open(t.ours, "main/.git").then((git) =>
          git.worktreeRepair().addPath(join(t.ours, "side")).setRelativePaths(true).call(),
        ),
      );
      expect(norm(ours, t.ours)).toBe(norm(r.stderr, t.native));
      expectSame(t);
    },
  );

  itRelative(
    "relative move refused in a version-0 repository with an unknown extension",
    async () => {
      const t = twins((base) => {
        setupUnknownExtension(base);
        run(join(base, "main"), "worktree", "add", "-q", "--detach", "../wt");
      });
      const r = attempt(join(t.native, "main"), [
        "worktree",
        "move",
        "--relative-paths",
        "../wt",
        "../wt2",
      ]);
      const ours = await death(() =>
        open(t.ours, "main/.git").then((git) =>
          git
            .worktreeMove()
            .setWorktree(join(t.ours, "wt"))
            .setDestination(join(t.ours, "wt2"))
            .setRelativePaths(true)
            .call(),
        ),
      );
      expect(r.status).toBe(128);
      expect(ours).toBe(r.stderr);
      // the configuration is untouched on both sides; native git renamed the directory before
      // dying (its links left stale), ours refuses before the rename (a deliberate divergence)
      for (const base of [t.native, t.ours]) {
        expect(readFileSync(join(base, "main/.git/config"), "latin1")).toBe(
          readFileSync(join(t.native, "main/.git/config"), "latin1"),
        );
      }
      expect(existsSync(join(t.ours, "wt/.git"))).toBe(true);
      expect(existsSync(join(t.ours, "wt2"))).toBe(false);
      expect(run(join(t.ours, "wt"), "status", "--porcelain")).toBe("");
    },
  );

  // ------------------------------------------------------------------ dwim_orphan's remote

  /** An empty repository `main` with remotes (URLs to an empty upstream), nothing fetched. */
  function setupEmptyWithRemotes(names: string[]) {
    return (base: string) => {
      run(base, "init", "-q", "-b", "main", "up");
      run(base, "init", "-q", "-b", "main", "main");
      for (const name of names) run(join(base, "main"), "remote", "add", name, "../up");
    };
  }

  it("worktree add --guess-remote infers --orphan when remote_get(NULL) finds no remote (two remotes, no origin)", async () => {
    const t = twins(setupEmptyWithRemotes(["a", "b"]));
    await addTwin(t, "main", ["--guess-remote", "<base>/foo"], (git, base) =>
      git
        .worktreeAdd()
        .setPath(join(base, "foo"))
        .setGuessRemote(true)
        .setCompatibility(COMPAT)
        .call(),
    );
  });

  it("worktree add --guess-remote dies when the default remote exists but nothing was fetched", async () => {
    for (const names of [["origin", "b"], ["a"]]) {
      const t = twins(setupEmptyWithRemotes(names));
      await addTwin(t, "main", ["--guess-remote", "<base>/foo"], (git, base) =>
        git
          .worktreeAdd()
          .setPath(join(base, "foo"))
          .setGuessRemote(true)
          .setCompatibility(COMPAT)
          .call(),
      );
    }
    // branch.<current>.remote names it, even without a section of its own
    const t = twins((base) => {
      setupEmptyWithRemotes(["a", "b"])(base);
      run(join(base, "main"), "config", "branch.main.remote", "b");
    });
    await addTwin(t, "main", ["--guess-remote", "<base>/foo"], (git, base) =>
      git
        .worktreeAdd()
        .setPath(join(base, "foo"))
        .setGuessRemote(true)
        .setCompatibility(COMPAT)
        .call(),
    );
  });
});
