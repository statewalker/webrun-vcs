/**
 * git's repository setup (setup.c) against native git, over t1510-repo-setup.sh's matrix: each
 * case number encodes `GIT_WORK_TREE` (bit 0), `GIT_DIR` (bit 1), `core.worktree` (bit 2), a
 * gitfile for `.git` (bit 3) and `core.bare` (bit 4), and each is tried with several values of
 * those settings from the worktree's top, a subdirectory and (without a gitfile) inside
 * `.git`. Native git's `GIT_TRACE_SETUP` lines (git_dir, git_common_dir, worktree, cwd, prefix;
 * relative ones resolved against its cwd) are compared with `setupGitDirectory`'s result, and
 * so are the exit status and git's fatal and warning lines. t1501-work-tree.sh's cases add
 * `rev-parse --is-bare-repository`, `--is-inside-git-dir`, `--is-inside-work-tree` and
 * `--show-prefix`, and the multi-worktree `commondir` ones `--git-common-dir`; the location
 * variables (`GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_COMMON_DIR`) are compared with
 * `rev-parse --path-format=absolute --git-path`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupGitDirectory } from "../src/index.js";

const nativeGit = spawnSync("git", ["--version"]).status === 0;
const describeGit = nativeGit && process.platform !== "win32" ? describe : describe.skip;

let here = "";

const envOf = (over: Record<string, string>): Record<string, string> => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: here,
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  ...(process.env.GIT_EXEC_PATH ? { GIT_EXEC_PATH: process.env.GIT_EXEC_PATH } : {}),
  ...over,
});

/** What a setup gives, as absolute paths; or git's death. */
interface Setup {
  status: number;
  gitDir?: string;
  commonDir?: string;
  workTree?: string;
  cwd?: string;
  prefix?: string;
  /** git's `fatal:` and `warning:` lines */
  messages: string[];
}

const messagesOf = (stderr: string) =>
  stderr.split("\n").filter((l) => /^(fatal|warning):/.test(l));

/** Native git's setup: `GIT_TRACE_SETUP` of `git symbolic-ref HEAD`, as t1510's test_repo. */
function native(cwd: string, over: Record<string, string>): Setup {
  const trace = join(here, "trace");
  rmSync(trace, { force: true });
  const r = spawnSync("git", ["symbolic-ref", "HEAD"], {
    cwd,
    env: envOf({ ...over, GIT_TRACE_SETUP: trace }),
    encoding: "utf8",
  });
  const messages = messagesOf(r.stderr);
  if (r.status !== 0) return { status: r.status ?? -1, messages };
  const lines = new Map<string, string>();
  for (const line of readFileSync(trace, "utf8").split("\n")) {
    const m = /setup: ([a-z_]+): (.*)$/.exec(line);
    if (m) lines.set(m[1], m[2]);
  }
  const at = lines.get("cwd") as string;
  const abs = (value: string | undefined) =>
    value === undefined || value === "(null)" ? undefined : resolve(at, value);
  const prefix = lines.get("prefix");
  return {
    status: 0,
    gitDir: abs(lines.get("git_dir")),
    commonDir: abs(lines.get("git_common_dir")),
    workTree: abs(lines.get("worktree")),
    cwd: at,
    ...(prefix !== undefined && prefix !== "(null)" ? { prefix } : {}),
    messages,
  };
}

/** Our setup in `cwd` with the variables `over`. */
async function ours(cwd: string, over: Record<string, string>): Promise<Setup> {
  const files = createNodeFilesApi({ rootDir: "/" });
  const environment = createNodeGitHostEnvironment({ env: envOf(over), effectiveUid: null });
  try {
    const s = await setupGitDirectory({ files, cwd, environment });
    return {
      status: 0,
      gitDir: s.gitDir,
      commonDir: s.commonDir,
      workTree: s.workTree,
      cwd: s.cwd,
      ...(s.prefix !== undefined ? { prefix: s.prefix } : {}),
      messages: s.warnings,
    };
  } catch (error) {
    const message = (error as Error).message;
    return {
      status: (error as { exitCode?: number }).exitCode ?? 1,
      messages: messagesOf(message.startsWith("fatal:") ? message : `fatal: ${message}`),
    };
  }
}

/** Drops undefined fields (a native result has them, ours omits them). */
const clean = (s: Setup) =>
  Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as Setup;

/** Compares native git's setup with ours in `cwd` under the variables `over`. */
async function expectSame(cwd: string, over: Record<string, string>) {
  const theirs = clean(native(cwd, over));
  const mine = clean(await ours(cwd, over));
  expect({ cwd, over, ...mine }).toEqual({ cwd, over, ...theirs });
}

/** t1510's setup_repo: `<name>` with `core.worktree`, a gitfile and `core.bare` as asked. */
function setupRepo(name: string, worktree?: string, gitfile = false, bare?: string): string {
  const top = join(here, name);
  rmSync(top, { recursive: true, force: true });
  rmSync(`${top}.git`, { recursive: true, force: true });
  execFileSync("git", ["-c", "init.defaultBranch=initial", "init", "-q", top], { env: envOf({}) });
  const config = join(top, ".git", "config");
  if (worktree !== undefined)
    execFileSync("git", ["config", "--file", config, "core.worktree", worktree], {
      env: envOf({}),
    });
  if (bare !== undefined)
    execFileSync("git", ["config", "--file", config, "core.bare", bare], { env: envOf({}) });
  mkdirSync(join(top, "sub", "sub"), { recursive: true });
  mkdirSync(join(top, "wt", "sub"), { recursive: true });
  if (gitfile) {
    renameSync(join(top, ".git"), `${top}.git`);
    writeFileSync(join(top, ".git"), `gitdir: ../${name}.git\n`);
  } else {
    mkdirSync(join(top, ".git", "wt", "sub"), { recursive: true });
  }
  return top;
}

/** t1510's case titles, by case number (its bits). */
const TITLES: Record<number, string> = {
  0: "#0: nonbare repo, no explicit configuration",
  1: "#1: GIT_WORK_TREE without explicit GIT_DIR is accepted",
  2: "#2: worktree defaults to cwd with explicit GIT_DIR",
  3: "#3: setup",
  4: "#4: core.worktree without GIT_DIR set is accepted",
  5: "#5: core.worktree + GIT_WORK_TREE is accepted",
  6: "#6: setting GIT_DIR brings core.worktree to life",
  7: "#7: setup",
  8: "#8: gitfile, easy case",
  9: "#9: GIT_WORK_TREE accepted with gitfile",
  10: "#10: GIT_DIR can point to gitfile",
  11: "#11: setup",
  12: "#12: core.worktree with gitfile is accepted",
  13: "#13: core.worktree+GIT_WORK_TREE accepted (with gitfile)",
  14: "#14: core.worktree with GIT_DIR pointing to gitfile",
  15: "#15: setup",
  16: "#16c: bare .git has no worktree",
  17: "#17: GIT_WORK_TREE without explicit GIT_DIR is accepted (bare case)",
  18: "#18: bare .git named by GIT_DIR has no worktree",
  19: "#19: setup",
  20: "#20a: core.worktree without GIT_DIR accepted (inside .git)",
  21: "#21: setup, core.worktree warns before overriding core.bare",
  22: "#22.2: core.worktree and core.bare conflict",
  23: "#23: setup",
  24: "#24: bare repo has no worktree (gitfile case)",
  25: "#25: GIT_WORK_TREE accepted if GIT_DIR unset (bare gitfile case)",
  26: "#26: bare repo has no worktree (GIT_DIR -> gitfile case)",
  27: "#27: setup",
  28: "#28: core.worktree and core.bare conflict (gitfile case)",
  29: "#29: setup",
  30: "#30: core.worktree and core.bare conflict (gitfile version)",
  31: "#31: setup",
};

describeGit("repository setup (t1510, t1501 native twins)", () => {
  beforeAll(() => {
    here = realpathSync(mkdtempSync(join(tmpdir(), "repo-setup-")));
  });
  afterAll(() => {
    if (here) rmSync(here, { recursive: true, force: true });
  });

  for (let n = 0; n < 32; n++) {
    const wtEnv = (n & 1) !== 0;
    const dirEnv = (n & 2) !== 0;
    const wtCfg = (n & 4) !== 0;
    const gitfile = (n & 8) !== 0;
    const bare = (n & 16) !== 0;
    it(`t1510-repo-setup.sh: "${TITLES[n]}"`, async () => {
      const cfgChoices: Array<string | undefined> = wtCfg
        ? ["..", "TOP", "../wt", "TOP/wt"]
        : [undefined];
      for (const cfgChoice of cfgChoices) {
        const name = `${n}-${cfgChoices.indexOf(cfgChoice)}`;
        const top = join(here, name);
        const cfg = cfgChoice?.replace("TOP", top);
        setupRepo(name, cfg, gitfile, bare ? "true" : undefined);
        // with a gitfile, GIT_DIR names the gitfile (t1510's #10, #14)
        const gitPath = join(top, ".git");
        const cwds = [
          top,
          join(top, "sub", "sub"),
          ...(gitfile ? [] : [gitPath, join(gitPath, "wt")]),
        ];
        for (const cwd of cwds) {
          const dirValues = dirEnv ? [relative(cwd, gitPath) || ".", gitPath] : [undefined];
          const wtValues = wtEnv
            ? [top, relative(cwd, top) || ".", join(top, "wt"), here, relative(cwd, here)]
            : [undefined];
          for (const dir of dirValues) {
            for (const wt of wtValues) {
              await expectSame(cwd, {
                ...(dir !== undefined ? { GIT_DIR: dir } : {}),
                ...(wt !== undefined ? { GIT_WORK_TREE: wt } : {}),
              });
            }
          }
        }
      }
    });
  }

  it('t1510-repo-setup.sh: "#16a: implicitly bare repo (cwd inside .git dir)"', async () => {
    const top = setupRepo("16a");
    for (const cwd of [join(top, ".git"), join(top, ".git", "wt"), join(top, ".git", "wt", "sub")])
      await expectSame(cwd, {});
  });

  it('t1510-repo-setup.sh: "#2b: relative GIT_DIR"', async () => {
    const top = setupRepo("2b");
    await expectSame(top, { GIT_DIR: ".git" });
    await expectSame(join(top, "sub"), { GIT_DIR: "../.git" });
  });

  it('t1510-repo-setup.sh: "#6e: GIT_DIR set, core.worktree=../.. (absolute)"', async () => {
    const top = setupRepo("6e", join(here, "6e", ".."));
    await expectSame(join(here, "6e"), { GIT_DIR: ".git" });
    await expectSame(join(here, "6e", "sub", "sub"), { GIT_DIR: "../../.git" });
    await expectSame(top, { GIT_DIR: join(top, ".git") });
  });

  it('t1510-repo-setup.sh: "#6f: GIT_DIR set, core.worktree=../.. (relative)"', async () => {
    const top = setupRepo("6f", "../..");
    await expectSame(top, { GIT_DIR: ".git" });
    await expectSame(join(top, "sub", "sub"), { GIT_DIR: "../../.git" });
  });

  it('t1510-repo-setup.sh: "#22a: core.worktree = GIT_DIR = .git dir"', async () => {
    const top = setupRepo("22a", ".", false, "true");
    await expectSame(join(top, ".git"), { GIT_DIR: "." });
    await expectSame(join(top, ".git", "wt", "sub"), { GIT_DIR: "../.." });
    await expectSame(top, { GIT_DIR: ".git" });
  });

  it('t1510-repo-setup.sh: "#22b: core.worktree child of .git, GIT_DIR=.git"', async () => {
    const top = setupRepo("22b", "wt");
    await expectSame(join(top, ".git"), { GIT_DIR: "." });
    await expectSame(join(top, ".git", "wt"), { GIT_DIR: ".." });
    await expectSame(join(top, ".git", "wt", "sub"), { GIT_DIR: "../.." });
  });

  it('t1510-repo-setup.sh: "#22c: core.worktree = .git/.., GIT_DIR=.git"', async () => {
    const top = setupRepo("22c", "..");
    await expectSame(join(top, ".git"), { GIT_DIR: "." });
    await expectSame(join(top, ".git", "wt"), { GIT_DIR: ".." });
  });

  it("GIT_DIR naming no repository dies as git does", async () => {
    const top = setupRepo("nope");
    await expectSame(top, { GIT_DIR: "nope" });
    await expectSame(top, { GIT_DIR: join(top, "sub") });
  });

  it('t1501-work-tree.sh: "error out gracefully on invalid $GIT_WORK_TREE"', async () => {
    const top = setupRepo("invalid-wt");
    await expectSame(top, { GIT_WORK_TREE: "/.invalid/work/tree" });
    // a missing last component is accepted (t1510's #13 "non-existent-too")
    await expectSame(top, { GIT_WORK_TREE: join(top, "sub", "non-existent-too") });
  });

  /** t1501's layout: repo.git beside work/ (core.worktree set by each case) */
  function t1501(name: string): { root: string; repo: string } {
    const root = join(here, name);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "work", "sub", "dir"), { recursive: true });
    mkdirSync(join(root, "work2"), { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", join(root, "repo.git")], { env: envOf({}) });
    execFileSync("git", [
      "config",
      "--file",
      join(root, "repo.git", "config"),
      "core.bare",
      "false",
    ]);
    return { root, repo: join(root, "repo.git") };
  }

  /** rev-parse's view of the setup, native and ours. */
  async function expectRevParse(cwd: string, over: Record<string, string>) {
    const r = spawnSync(
      "git",
      [
        "rev-parse",
        "--is-bare-repository",
        "--is-inside-git-dir",
        "--is-inside-work-tree",
        "--show-prefix",
      ],
      { cwd, env: envOf(over), encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const files = createNodeFilesApi({ rootDir: "/" });
    const environment = createNodeGitHostEnvironment({ env: envOf(over), effectiveUid: null });
    const s = await setupGitDirectory({ files, cwd, environment });
    const lines = [String(s.bare), String(s.insideGitDir), String(s.insideWorkTree)];
    // --show-prefix prints the prefix, an empty line at the top, nothing outside the worktree
    if (s.insideWorkTree) lines.push(s.prefix ?? "");
    expect({ cwd, over, lines }).toEqual({
      cwd,
      over,
      lines: r.stdout.split("\n").slice(0, lines.length),
    });
  }

  it('t1501-work-tree.sh: "setup: core.worktree = relative path"', async () => {
    const { root, repo } = t1501("t1501-relative");
    execFileSync("git", ["config", "--file", join(repo, "config"), "core.worktree", "../work"]);
    const env = { GIT_DIR: "repo.git" };
    await expectRevParse(root, { GIT_DIR: "repo.git" });
    await expectRevParse(join(root, "work"), { GIT_DIR: "../repo.git" });
    await expectRevParse(join(root, "work", "sub", "dir"), { GIT_DIR: "../../../repo.git" });
    await expectSame(root, env);
    await expectSame(join(root, "work", "sub", "dir"), { GIT_DIR: "../../../repo.git" });
  });

  it('t1501-work-tree.sh: "setup: core.worktree = absolute path"', async () => {
    const { root, repo } = t1501("t1501-absolute");
    execFileSync("git", [
      "config",
      "--file",
      join(repo, "config"),
      "core.worktree",
      join(root, "work"),
    ]);
    await expectRevParse(root, { GIT_DIR: repo });
    await expectRevParse(join(root, "work"), { GIT_DIR: repo });
    await expectRevParse(join(root, "work", "sub", "dir"), { GIT_DIR: repo });
  });

  it('t1501-work-tree.sh: "setup: GIT_WORK_TREE=relative (override core.worktree)"', async () => {
    const { root, repo } = t1501("t1501-env-relative");
    execFileSync("git", [
      "config",
      "--file",
      join(repo, "config"),
      "core.worktree",
      join(root, "non-existent"),
    ]);
    await expectRevParse(root, { GIT_DIR: repo, GIT_WORK_TREE: "work" });
    await expectRevParse(join(root, "work"), { GIT_DIR: repo, GIT_WORK_TREE: "." });
    await expectRevParse(join(root, "work", "sub", "dir"), {
      GIT_DIR: repo,
      GIT_WORK_TREE: "../..",
    });
  });

  it('t1501-work-tree.sh: "setup: GIT_WORK_TREE=absolute, below git dir"', async () => {
    const { root, repo } = t1501("t1501-below");
    renameSync(join(root, "work"), join(repo, "work"));
    renameSync(join(root, "work2"), join(repo, "work2"));
    const env = { GIT_DIR: repo, GIT_WORK_TREE: join(repo, "work") };
    await expectRevParse(root, env);
    for (const dir of [repo, join(repo, "objects"), join(repo, "work2")]) {
      await expectRevParse(dir, env);
    }
    await expectRevParse(join(repo, "work"), env);
    await expectRevParse(join(repo, "work", "sub", "dir"), env);
    // '_gently() groks relative GIT_DIR & GIT_WORK_TREE'
    await expectSame(join(repo, "work", "sub", "dir"), {
      GIT_DIR: "../../..",
      GIT_WORK_TREE: "../..",
    });
  });

  /** The multi-worktree layout of t1501: repo.git/repos/foo with a `commondir` */
  function multiWorktree(name: string, commondir: (root: string) => string) {
    const root = join(here, name);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "work"), { recursive: true });
    execFileSync("git", ["init", "-q", "--bare", join(root, "repo.git")], { env: envOf({}) });
    execFileSync("git", [
      "config",
      "--file",
      join(root, "repo.git", "config"),
      "core.bare",
      "false",
    ]);
    const foo = join(root, "repo.git", "repos", "foo");
    mkdirSync(foo, { recursive: true });
    writeFileSync(join(foo, "HEAD"), readFileSync(join(root, "repo.git", "HEAD")));
    writeFileSync(join(foo, "commondir"), `${commondir(root)}\n`);
    return root;
  }

  it('t1501-work-tree.sh: "GIT_DIR set (1)"', async () => {
    const root = multiWorktree("t1501-common-1", () => "../..");
    writeFileSync(join(root, "gitfile"), "gitdir: repo.git/repos/foo\n");
    await expectSame(join(root, "work"), { GIT_DIR: "../gitfile" });
  });

  it('t1501-work-tree.sh: "GIT_DIR set (2)"', async () => {
    const root = multiWorktree("t1501-common-2", (r) => join(r, "repo.git"));
    writeFileSync(join(root, "gitfile"), "gitdir: repo.git/repos/foo\n");
    await expectSame(join(root, "work"), { GIT_DIR: "../gitfile" });
  });

  it('t1501-work-tree.sh: "Auto discovery"', async () => {
    const root = multiWorktree("t1501-auto", () => "../..");
    writeFileSync(join(root, ".git"), "gitdir: repo.git/repos/foo\n");
    await expectSame(join(root, "work"), {});
  });

  it('t1501-work-tree.sh: "$GIT_DIR/common overrides core.worktree"', async () => {
    const root = multiWorktree("t1501-common-worktree", () => "../..");
    mkdirSync(join(root, "elsewhere"));
    execFileSync("git", [
      "config",
      "--file",
      join(root, "repo.git", "config"),
      "core.worktree",
      join(root, "elsewhere"),
    ]);
    writeFileSync(join(root, ".git"), "gitdir: repo.git/repos/foo\n");
    await expectSame(join(root, "work"), {});
  });

  it('t1501-work-tree.sh: "$GIT_WORK_TREE overrides $GIT_DIR/common"', async () => {
    const root = multiWorktree("t1501-env-over-common", () => "../..");
    writeFileSync(join(root, ".git"), "gitdir: repo.git/repos/foo\n");
    await expectSame(join(root, "work"), { GIT_DIR: "../.git", GIT_WORK_TREE: "." });
  });

  it("GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY and GIT_COMMON_DIR resolve from where git ends up", async () => {
    const top = setupRepo("locations");
    mkdirSync(join(top, "objs"));
    const sub = join(top, "sub", "sub");
    const cases: Array<[string, Record<string, string>]> = [
      [top, { GIT_INDEX_FILE: "idx" }],
      [sub, { GIT_INDEX_FILE: "idx" }],
      [sub, { GIT_DIR: "../../.git", GIT_WORK_TREE: "../..", GIT_INDEX_FILE: "idx" }],
      [sub, { GIT_DIR: "../../.git", GIT_INDEX_FILE: "idx" }],
      [top, { GIT_OBJECT_DIRECTORY: "objs" }],
      [sub, { GIT_OBJECT_DIRECTORY: join(top, "objs") }],
      [top, { GIT_COMMON_DIR: ".git" }],
      [sub, { GIT_INDEX_FILE: join(here, "abs-index") }],
    ];
    for (const [cwd, over] of cases) {
      const r = spawnSync(
        "git",
        [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "index",
          "--git-path",
          "objects",
          "--git-common-dir",
        ],
        { cwd, env: envOf(over), encoding: "utf8" },
      );
      expect(r.status).toBe(0);
      const files = createNodeFilesApi({ rootDir: "/" });
      const environment = createNodeGitHostEnvironment({ env: envOf(over), effectiveUid: null });
      const s = await setupGitDirectory({ files, cwd, environment });
      expect({ cwd, over, paths: [s.indexFile, s.objectDirectory, s.commonDir] }).toEqual({
        cwd,
        over,
        paths: r.stdout.trim().split("\n"),
      });
    }
    // $GIT_OBJECT_DIRECTORY must exist for $GIT_DIR to be a repository
    await expectSame(sub, { GIT_DIR: "../../.git", GIT_OBJECT_DIRECTORY: "missing" });
    expect(existsSync(join(top, "missing"))).toBe(false);
  });
});
