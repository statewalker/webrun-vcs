/**
 * Malicious tree paths against native git: checkout, read-tree -u, reset --hard/--mixed and
 * clone refuse every path git's `verify_path` refuses, with git's message and exit code, and
 * write nothing (in the worktree, beside it, or through a link).
 *
 * The inputs are JGit's `DirCacheCheckoutMaliciousPathTest` (each method's path segments,
 * one tree level per segment, the last a blob) and `InvalidPathCheckoutTest`, from Eclipse
 * JGit under the Eclipse Distribution License v. 1.0 (SPDX-License-Identifier:
 * BSD-3-Clause), plus scenarios of git's t1450-fsck (`.git` spellings in trees), t7415-submodule-names
 * (symlinked `.gitmodules` and its NTFS short names), t0060-path-utils
 * (`is_ntfs_dotgit`/`is_hfs_dotgit` names), t1014-read-tree-confusing (`.git` behind
 * backslashes and dots) and t3600 (a directory that replaces a symbolic link). JGit's
 * expectation is kept beside each case for information (JGit runs some of them as if on
 * Windows); native git on this host decides. Trees are built with plumbing
 * (`hash-object --literally`), since git refuses to add such paths.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeGitHostEnvironment } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { FastForwardMode, MergeStatus, ResetMode } from "../src/index.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

let root = "";
let counter = 0;
/** Cases whose JGit expectation git does not share (printed once the suite ends) */
const jgitDiffers: string[] = [];

/**
 * A tree level: [mode, name, blob content or the entries of a subtree]. Link targets are
 * relative to the worktree's top: `../outside` is the directory beside the repository.
 */
type Spec = Array<[string, string, string | Spec]>;

/** JGit's path segments as its test builds them: one tree per segment, `data` in the blob. */
function segments(path: string[]): Spec {
  let spec: Spec | string = "data";
  for (let i = path.length - 1; i >= 0; i--) {
    spec = [[typeof spec === "string" ? "100644" : "40000", path[i] as string, spec]];
  }
  return spec as Spec;
}

const env = () => nativeGitEnv(root);

function git(cwd: string, args: string[], input?: string | Buffer): string {
  return execFileSync("git", args, { cwd, env: env(), input }).toString().trim();
}

function storeTree(repo: string, spec: Spec): string {
  const parts: Buffer[] = [];
  for (const [mode, name, content] of spec) {
    const id =
      typeof content === "string"
        ? git(repo, ["hash-object", "-w", "--stdin"], content)
        : storeTree(repo, content);
    parts.push(
      Buffer.from(`${mode} `),
      Buffer.from(name),
      Buffer.from([0]),
      Buffer.from(id, "hex"),
    );
  }
  return git(
    repo,
    ["hash-object", "--literally", "-t", "tree", "-w", "--stdin"],
    Buffer.concat(parts),
  );
}

/** The commands each case runs, native and ours. */
type Command =
  | "merge"
  | "merge-no-ff"
  | "checkout"
  | "checkout-unborn"
  | "read-tree"
  | "reset-hard"
  | "reset-mixed"
  | "clone";

interface Case {
  /** Where the input comes from: `JGitClass#method`, or a git t/ script */
  source: string;
  /** The tree of the second commit */
  spec: Spec;
  /** The first commit's tree (default a file `goodpath`) */
  from?: Spec;
  /** Configuration set in the repository (`core.protectNTFS`, `core.protectHFS`) */
  config?: Record<string, string>;
  /** JGit's expectation (it ran the case as on `windows` or `unix` where it says so); informational */
  jgit?: "refused" | "accepted";
  jgitPlatform?: "windows" | "unix";
  /** Where ours knowingly differs from git: what ours does instead, and why */
  divergence?: string;
  commands?: Command[];
}

const ALL: Command[] = [
  "checkout",
  "checkout-unborn",
  "read-tree",
  "reset-hard",
  "reset-mixed",
  "merge",
  "merge-no-ff",
  "clone",
];
const J = "DirCacheCheckoutMaliciousPathTest#";
const SLASH_NAME =
  "a tree entry name holding `/`: git checks it out as nested directories (fsck warns " +
  "fullPathname), ours refuses to decode such a tree (`invalid path`)";

const CASES: Case[] = [
  // JGit's DirCacheCheckoutMaliciousPathTest
  { source: `${J}testMaliciousAbsolutePathIsOk`, spec: segments(["ok"]), jgit: "accepted" },
  {
    source: `${J}testMaliciousAbsolutePathIsOkSecondCheckout`,
    spec: segments(["ok"]),
    jgit: "accepted",
  },
  {
    source: `${J}testMaliciousAbsolutePathIsOkTwoLevels`,
    spec: segments(["a", "ok"]),
    jgit: "accepted",
  },
  { source: `${J}testMaliciousAbsolutePath`, spec: segments(["/tmp/x"]), jgit: "refused" },
  {
    source: `${J}testMaliciousAbsolutePathSecondCheckout`,
    spec: segments(["/tmp/x"]),
    jgit: "refused",
  },
  {
    source: `${J}testMaliciousAbsolutePathTwoLevelsFirstBad`,
    spec: segments(["/tmp/x", "y"]),
    jgit: "refused",
  },
  {
    source: `${J}testMaliciousAbsolutePathTwoLevelsSecondBad`,
    spec: segments(["y", "/tmp/x"]),
    jgit: "refused",
  },
  {
    source: `${J}testMaliciousAbsoluteCurDrivePathWindows`,
    spec: segments(["\\somepath"]),
    jgit: "refused",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testMaliciousAbsoluteCurDrivePathWindowsOnUnix`,
    spec: segments(["\\somepath"]),
    jgit: "accepted",
    jgitPlatform: "unix",
  },
  {
    source: `${J}testMaliciousAbsoluteUNCPathWindows1`,
    spec: segments(["\\\\somepath"]),
    jgit: "refused",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testMaliciousAbsoluteUNCPathWindows1OnUnix`,
    spec: segments(["\\\\somepath"]),
    jgit: "accepted",
    jgitPlatform: "unix",
  },
  {
    source: `${J}testMaliciousAbsoluteUNCPathWindows2`,
    spec: segments(["\\/somepath"]),
    jgit: "refused",
    jgitPlatform: "windows",
    divergence: SLASH_NAME,
  },
  {
    source: `${J}testMaliciousAbsoluteUNCPathWindows2OnUnix`,
    spec: segments(["\\/somepath"]),
    jgit: "refused",
    jgitPlatform: "unix",
    divergence: SLASH_NAME,
  },
  {
    source: `${J}testMaliciousAbsoluteWindowsPath1`,
    spec: segments(["c:\\temp\\x"]),
    jgit: "refused",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testMaliciousAbsoluteWindowsPath1OnUnix`,
    spec: segments(["c:\\temp\\x"]),
    jgit: "accepted",
    jgitPlatform: "unix",
  },
  {
    source: `${J}testMaliciousAbsoluteWindowsPath2`,
    spec: segments(["c:/temp/x"]),
    jgit: "refused",
    divergence: SLASH_NAME,
  },
  { source: `${J}testMaliciousGitPath1`, spec: segments([".git/konfig"]), jgit: "refused" },
  { source: `${J}testMaliciousGitPath2`, spec: segments([".git", "konfig"]), jgit: "refused" },
  {
    source: `${J}testMaliciousGitPath1Case`,
    spec: segments([".Git/konfig"]),
    jgit: "refused",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testMaliciousGitPath2Case`,
    spec: segments([".gIt", "konfig"]),
    jgit: "refused",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testMaliciousGitPath3Case`,
    spec: segments([".giT", "konfig"]),
    jgit: "refused",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testMaliciousGitPathEndSpaceWindows`,
    spec: segments([".git ", "konfig"]),
    jgit: "refused",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testMaliciousGitPathEndSpaceUnixOk`,
    spec: segments([".git ", "konfig"]),
    jgit: "refused",
  },
  {
    source: `${J}testMaliciousGitPathEndDotWindows1`,
    spec: segments([".git.", "konfig"]),
    jgit: "refused",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testMaliciousGitPathEndDotWindows2`,
    spec: segments([".f."]),
    jgit: "refused",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testMaliciousGitPathEndDotWindows3`,
    spec: segments([".f"]),
    jgit: "accepted",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testMaliciousGitPathEndDotUnixOk`,
    spec: segments([".git.", "konfig"]),
    jgit: "refused",
  },
  { source: `${J}testMaliciousPathDotDot`, spec: segments(["..", "no"]), jgit: "refused" },
  { source: `${J}testMaliciousPathDot`, spec: segments([".", "no"]), jgit: "refused" },
  {
    source: `${J}testMaliciousPathEmptyUnix`,
    spec: segments(["", "no"]),
    jgit: "refused",
    jgitPlatform: "unix",
    divergence:
      "clone: native upload-pack dies on the empty name (pack-objects), ours sends the pack " +
      "and the checkout dies with git's `fatal: empty filename in tree entry`",
  },
  {
    source: `${J}testMaliciousPathEmptyWindows`,
    spec: segments(["", "no"]),
    jgit: "refused",
    jgitPlatform: "windows",
    commands: ["checkout", "read-tree", "reset-hard"],
  },
  {
    source: `${J}testMaliciousWindowsADS`,
    spec: segments(["some:path"]),
    jgit: "refused",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testMaliciousWindowsADSOnUnix`,
    spec: segments(["some:path"]),
    jgit: "accepted",
    jgitPlatform: "unix",
  },
  {
    source: `${J}testForbiddenNamesOnWindowsEgCon`,
    spec: segments(["con"]),
    jgit: "refused",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testForbiddenNamesOnWindowsEgConDotSuffix`,
    spec: segments(["con.txt"]),
    jgit: "refused",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testForbiddenNamesOnWindowsEgLpt1`,
    spec: segments(["lpt1"]),
    jgit: "refused",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testForbiddenNamesOnWindowsEgLpt1DotSuffix`,
    spec: segments(["lpt1.txt"]),
    jgit: "refused",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testForbiddenNamesOnWindowsEgDotCon`,
    spec: segments([".con"]),
    jgit: "accepted",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testForbiddenNamesOnWindowsEgLpr`,
    spec: segments(["lpt"]),
    jgit: "accepted",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testForbiddenNamesOnWindowsEgCon1`,
    spec: segments(["con1"]),
    jgit: "accepted",
    jgitPlatform: "windows",
  },
  {
    source: `${J}testForbiddenWindowsNamesOnUnixEgCon`,
    spec: segments(["con"]),
    jgit: "accepted",
    jgitPlatform: "unix",
  },
  {
    source: `${J}testForbiddenWindowsNamesOnUnixEgLpt1`,
    spec: segments(["lpt1"]),
    jgit: "accepted",
    jgitPlatform: "unix",
  },
  // JGit's InvalidPathCheckoutTest: a `.git/b` entry reset --hard must not write into .git
  {
    source: "InvalidPathCheckoutTest#testCheckoutIntoDotGit",
    spec: segments([".git", "b"]),
    jgit: "refused",
  },
  // t0060-path-utils / t1450-fsck: the NTFS and HFS+ spellings of .git
  { source: "t0060-path-utils (is_ntfs_dotgit: git~1)", spec: segments(["git~1", "config"]) },
  { source: "t0060-path-utils (is_ntfs_dotgit: GIT~1)", spec: segments(["GIT~1", "config"]) },
  { source: "t0060-path-utils (is_ntfs_dotgit: .git. .)", spec: segments([".git. .", "config"]) },
  {
    source: "t0060-path-utils (is_ntfs_dotgit: stream)",
    spec: segments([".git::$INDEX_ALLOCATION", "config"]),
  },
  {
    source: "t1014-read-tree-confusing (backslash: a\\.git)",
    spec: segments(["a\\.git", "config"]),
  },
  { source: "t1014-read-tree-confusing (backslash: .git\\foo)", spec: segments([".git\\foo"]) },
  { source: "t1450-fsck (HFS+ ignorable: \\u200c.git)", spec: segments(["\u200c.git", "config"]) },
  { source: "t1450-fsck (HFS+ ignorable: .g\\u200dit)", spec: segments([".g\u200dit", "config"]) },
  // core.protectNTFS / core.protectHFS as configured
  {
    source: "t1014-read-tree-confusing (core.protectNTFS=false: git~1)",
    spec: segments(["git~1", "config"]),
    config: { "core.protectNTFS": "false" },
    commands: ["read-tree"],
    divergence:
      "only read-tree without -u is compared: the worktree's own guard (FileWorktree) keeps " +
      "NTFS protection on whatever the configuration says",
  },
  {
    source: "t1014-read-tree-confusing (core.protectHFS=true: \\u200c.git)",
    spec: segments(["\u200c.git", "config"]),
    config: { "core.protectHFS": "true" },
  },
  {
    source: "t1014-read-tree-confusing (core.protectNTFS=false: .GIT still refused)",
    spec: segments([".GIT", "config"]),
    config: { "core.protectNTFS": "false" },
  },
  // t7415-submodule-names: a symbolic link named .gitmodules (any NTFS or HFS+ spelling)
  {
    source: "t7415-submodule-names (.gitmodules symlink)",
    spec: [["120000", ".gitmodules", "../outside/m"]],
  },
  {
    source: "t7415-submodule-names (.GITMODULES symlink)",
    spec: [["120000", ".GITMODULES", "../outside/m"]],
  },
  {
    source: "t7415-submodule-names (GITMOD~1 symlink)",
    spec: [["120000", "GITMOD~1", "../outside/m"]],
  },
  {
    source: "t7415-submodule-names (gi7eba~1 symlink)",
    spec: [["120000", "gi7eba~1", "../outside/m"]],
  },
  {
    source: "t7415-submodule-names (.gitmodules. symlink)",
    spec: [["120000", ".gitmodules. ", "../outside/m"]],
  },
  {
    source: "t7415-submodule-names (a .gitmodules file is fine)",
    spec: [["100644", ".gitmodules", ""]],
  },
  // t3600 / t2200-style: a directory replacing a symbolic link that leads outside
  {
    source: "t3600-rm (a directory replaces a link to outside)",
    from: [["120000", "d", "../outside"]],
    spec: [["40000", "d", [["100644", "x", "pwn"]]]],
    commands: ["checkout", "read-tree", "reset-hard", "reset-mixed"],
  },
  {
    source: "t3600-rm (a link and a directory of one name in one tree)",
    spec: [
      ["120000", "d", "../outside"],
      ["40000", "d", [["100644", "x", "pwn"]]],
    ],
    divergence:
      "ours refuses the tree (a path below a planned link) where git keeps `d/x` and drops the link",
    // read-tree -m and reset --mixed keep both `d` and `d/x` in our index (webrun-vcs#247)
    commands: ["checkout", "checkout-unborn", "reset-hard", "clone"],
  },
];

interface Outcome {
  status: number;
  /** The error lines (clone: the checkout's cause, the lines before git's "unable to checkout") */
  stderr: string;
  /** Every path below the case's directory but inside git directories, links with their targets */
  files: string[];
  head: string;
  index: string;
}

/** Every path below `dir` outside `.git/` directories (links as `path -> target`). */
function listFiles(dir: string): string[] {
  const out = execFileSync("find", [".", "-path", "*/.git/*", "-prune", "-o", "-print"], {
    cwd: dir,
  })
    .toString()
    .split("\n")
    .filter((p) => p && p !== ".")
    .map((p) => {
      try {
        return `${p} -> ${readlinkSync(join(dir, p))}`;
      } catch {
        return p;
      }
    });
  return out.sort();
}

function stateOf(base: string, repo: string): Omit<Outcome, "status" | "stderr"> {
  if (!existsSync(repo)) return { files: listFiles(base), head: "", index: "" };
  const head = spawnSync("git", ["rev-parse", "-q", "--verify", "HEAD"], { cwd: repo, env: env() });
  const symbolic = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: repo, env: env() });
  const index = spawnSync("git", ["ls-files", "-s"], { cwd: repo, env: env() });
  return {
    files: listFiles(base).map((p) => p.replaceAll(base, "<base>")),
    head: `${symbolic.stdout.toString().trim()} ${head.stdout.toString().trim()}`,
    index: index.stdout.toString(),
  };
}

/** The case's fixture: `r` at c1 (or unborn), c2 the malicious commit, `outside/` beside it. */
function fixture(c: Case): { base: string; c1: string; c2: string } {
  const base = join(root, `f${counter++}`);
  mkdirSync(join(base, "outside"), { recursive: true });
  const repo = join(base, "r");
  git(base, ["init", "-q", "-b", "main", "r"]);
  for (const [key, value] of Object.entries(c.config ?? {})) git(repo, ["config", key, value]);
  const c1 = git(repo, [
    "commit-tree",
    storeTree(repo, c.from ?? segments(["goodpath"])),
    "-m",
    "1",
  ]);
  const c2 = git(repo, ["commit-tree", storeTree(repo, c.spec), "-p", c1, "-m", "2"]);
  git(repo, ["branch", "next", c2]);
  return { base, c1, c2 };
}

/** One copy of the fixture: at c1 (or unborn), ready for the command. */
function copy(f: { base: string; c1: string }, name: string, unborn: boolean): string {
  const base = `${f.base}-${name}`;
  cpSync(f.base, base, { recursive: true, verbatimSymlinks: true });
  if (!unborn) git(join(base, "r"), ["reset", "-q", "--hard", f.c1]);
  return base;
}

function nativeArgs(command: Command, c2: string): string[] {
  switch (command) {
    case "checkout":
      return ["checkout", "-q", "next"];
    case "checkout-unborn":
      return ["checkout", "-q", "-b", "master", c2];
    case "read-tree":
      return ["read-tree", "-u", "-m", "HEAD", c2];
    case "reset-hard":
      return ["reset", "-q", "--hard", c2];
    case "reset-mixed":
      return ["reset", "-q", "--mixed", c2];
    case "merge":
      return ["merge", "-q", "next"];
    case "merge-no-ff":
      return ["merge", "-q", "--no-ff", "--no-edit", "next"];
    case "clone":
      return ["clone", "-q", "--no-local", "r", "d"];
  }
}

function runNative(
  base: string,
  command: Command,
  c2: string,
  readTreeIndexOnly: boolean,
): Outcome {
  const repo = join(base, "r");
  if (command === "clone") git(repo, ["update-ref", "refs/heads/main", c2]);
  const args =
    command === "read-tree" && readTreeIndexOnly
      ? ["read-tree", "-m", "HEAD", c2]
      : nativeArgs(command, c2);
  const r = spawnSync("git", args, { cwd: command === "clone" ? base : repo, env: env() });
  let stderr = r.stderr.toString();
  if (command === "clone") {
    const at = stderr.indexOf("fatal: unable to checkout working tree");
    stderr = at >= 0 ? stderr.slice(0, at) : stderr;
  }
  return {
    status: r.status ?? -1,
    stderr: stderr.replace(/\n$/, ""),
    ...stateOf(base, command === "clone" ? join(base, "d") : repo),
  };
}

async function runOurs(
  base: string,
  command: Command,
  c2: string,
  readTreeIndexOnly: boolean,
): Promise<Outcome> {
  const repo = join(base, "r");
  const environment = createNodeGitHostEnvironment({ env: env() });
  let status = 0;
  let stderr = "";
  try {
    if (command === "clone") {
      git(repo, ["update-ref", "refs/heads/main", c2]);
      git(base, ["init", "-q", "-b", "main", "d"]);
      const ours = await openOurs(base, environment, undefined, "d");
      await ours.clone().setURI(repo).setLocal(false).call();
    } else {
      const ours = await openOurs(repo, environment);
      if (command === "checkout") await ours.checkout().setName("next").call();
      else if (command === "checkout-unborn") {
        await ours.checkout().setName("master").setCreateBranch(true).setStartPoint(c2).call();
      } else if (command === "merge" || command === "merge-no-ff") {
        const merge = ours.merge().include("next");
        if (command === "merge-no-ff") merge.setFastForwardMode(FastForwardMode.NO_FF);
        const result = await merge.call();
        if (result.status === MergeStatus.FAILED) {
          stderr = result.message ?? "";
          // builtin/merge.c: 2 when the strategy failed, 1 when the fast-forward did
          status = /\nMerge with strategy \S+ failed\.$/.test(stderr) ? 2 : 1;
        }
      } else if (command === "read-tree") {
        await ours
          .readTree()
          .setMerge(true)
          .setUpdate(!readTreeIndexOnly)
          .addTree("HEAD")
          .addTree(c2)
          .call();
      } else {
        await ours
          .reset()
          .setMode(command === "reset-hard" ? ResetMode.HARD : ResetMode.MIXED)
          .setRef(c2)
          .call();
      }
    }
  } catch (error) {
    const e = error as Error & { exitCode?: number; cause?: unknown };
    status = e.exitCode ?? -1;
    stderr =
      command === "clone" && e.name === "CloneCheckoutError"
        ? (e.cause as Error).message
        : e.message;
  }
  return {
    status,
    stderr,
    ...stateOf(base, command === "clone" ? join(base, "d") : repo),
  };
}

/** What a case's outcome must show whoever ran it: nothing outside the worktree. */
function nothingOutside(outcome: Outcome): void {
  const escaped = outcome.files.filter(
    (p) => !/^\.\/(r|d|outside)(\/|$)/.test(p) || p.startsWith("./outside/"),
  );
  expect(escaped).toEqual([]);
}

describeGit("malicious tree paths against native git (verify_path)", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "malicious-paths-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  afterAll(() => {
    if (jgitDiffers.length > 0)
      console.info(`JGit's expectation differs from git's:\n${jgitDiffers.join("\n")}`);
  });

  for (const c of CASES) {
    describe(`${c.source} ${JSON.stringify(c.spec).slice(0, 80)}`, () => {
      for (const command of c.commands ?? ALL) {
        it(command, async () => {
          const f = fixture(c);
          try {
            await compareCase(c, command, f);
          } finally {
            for (const dir of [f.base, `${f.base}-native`, `${f.base}-ours`]) {
              rmSync(dir, { recursive: true, force: true });
            }
          }
        });
      }
    });
  }
});

/** Runs `command` on copies of the case's fixture, native and ours, and compares them. */
async function compareCase(
  c: Case,
  command: Command,
  f: { base: string; c1: string; c2: string },
): Promise<void> {
  const indexOnly = c.config?.["core.protectNTFS"] === "false";
  const unborn = command === "checkout-unborn" || command === "clone";
  const native = runNative(copy(f, "native", unborn), command, f.c2, indexOnly);
  const ours = await runOurs(copy(f, "ours", unborn), command, f.c2, indexOnly);
  nothingOutside(native);
  nothingOutside(ours);
  const refused = native.status !== 0;
  if (c.jgit && (c.jgit === "refused") !== refused && command === "checkout") {
    jgitDiffers.push(`${c.source}: JGit ${c.jgit}, git ${refused ? "refuses" : "accepts"}`);
  }
  if (native.status === -1 && native.stderr.includes("Assertion")) {
    // git's merge-ort asserts on a name holding `/` (record_entry_for_tree) and aborts;
    // ours refuses the path before writing anything
    expect(ours.status).toBe(2);
    expect(ours.stderr).toMatch(/^error: invalid path '.*'\nMerge with strategy ort failed\.$/);
    expect(ours.files).toEqual(native.files);
    return;
  }
  if (c.divergence === SLASH_NAME && !refused) {
    expect(ours.status).not.toBe(0);
    expect(ours.stderr).toMatch(/^error: invalid path '/);
    return;
  }
  if (command === "clone" && native.stderr.includes("empty filename")) {
    // native's upload-pack dies on the name; ours dies at the checkout with git's line
    expect({ status: ours.status, stderr: ours.stderr }).toEqual({
      status: 128,
      stderr: "fatal: empty filename in tree entry",
    });
    return;
  }
  if (c.divergence?.startsWith("ours refuses the tree") && ours.status !== 0) return;
  expect({ status: ours.status, stderr: ours.stderr }).toEqual({
    status: native.status,
    stderr: native.stderr,
  });
  expect(ours.files).toEqual(native.files);
  expect(ours.head).toBe(native.head);
  expect(ours.index).toBe(native.index);
}

// add_index_entry's verify_path on `git add`, as core.protectNTFS / core.protectHFS say
// (t1014-read-tree-confusing and t1450-fsck spell the names; JGit's DirCacheEntry refuses
// them all, whatever the configuration)
describeGit("git add of .git spellings, as core.protectNTFS/core.protectHFS say", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "malicious-add-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const cases: Array<{ path: string; config?: Record<string, string> }> = [
    { path: "git~1/x" },
    { path: "git~1/x", config: { "core.protectNTFS": "false" } },
    { path: ".git. /x" },
    { path: ".git. /x", config: { "core.protectNTFS": "false" } },
    { path: "‌.git/x" },
    { path: "‌.git/x", config: { "core.protectHFS": "true" } },
    { path: ".gi‍t/x", config: { "core.protectHFS": "true", "core.protectNTFS": "false" } },
  ];
  for (const c of cases) {
    it(`${JSON.stringify(c.path)} ${JSON.stringify(c.config ?? {})}`, async () => {
      const dirs: Record<"native" | "ours", string> = {
        native: join(root, `a${counter}-native`),
        ours: join(root, `a${counter++}-ours`),
      };
      for (const dir of Object.values(dirs)) {
        git(root, ["init", "-q", "-b", "main", dir]);
        for (const [key, value] of Object.entries(c.config ?? {})) git(dir, ["config", key, value]);
        mkdirSync(join(dir, c.path, ".."), { recursive: true });
        execFileSync("sh", ["-c", 'printf x > "$1"', "sh", join(dir, c.path)]);
      }
      const r = spawnSync("git", ["add", c.path], { cwd: dirs.native, env: env() });
      let status = 0;
      let stderr = "";
      try {
        const ours = await openOurs(dirs.ours, createNodeGitHostEnvironment({ env: env() }));
        await ours.add().addFilepattern(c.path).call();
      } catch (error) {
        status = (error as { exitCode?: number }).exitCode ?? -1;
        stderr = (error as Error).message;
      }
      expect({ status, stderr }).toEqual({
        status: r.status,
        stderr: r.stderr.toString().replace(/\n$/, ""),
      });
      const listed = (dir: string) => git(dir, ["ls-files", "-s"]);
      expect(listed(dirs.ours)).toBe(listed(dirs.native));
    });
  }
});
