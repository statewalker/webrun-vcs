/**
 * `git checkout [<tree-ish>] -- <pathspec>`, `git restore` and `git reset [<tree-ish>] --
 * <pathspec>` against native git (builtin/checkout.c `checkout_paths`, builtin/reset.c
 * `read_from_tree`): wildcards, magic, `:(attr)`, excludes, directories and non-ASCII
 * names, from the index and from a tree, overlay or not; unmerged paths with
 * `--ours`/`--theirs`/`-m`; skip-worktree entries of a sparse checkout; the errors and exit
 * codes. Each case runs native git in one copy of a repository and ours in another, then
 * compares the worktree, `ls-files -s` with the entries' flags, status and the messages.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type CheckoutResult, CheckoutStage, type Git, ResetMode } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, openRepo, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform === "linux" ? describe : describe.skip;

/**
 * git 2.43's `do_match_pathspec` stops an element at its first exact match, a glob-looking
 * one too (`x*y.txt` then never matches `xzy.txt`); ours follows 2.5x, which goes on.
 */
const is25x = (() => {
  if (!nativeGitAvailable()) return false;
  const m = /git version (\d+)\.(\d+)/.exec(execFileSync("git", ["--version"]).toString());
  return !!m && (Number(m[1]) > 2 || Number(m[2]) >= 50);
})();
/** Elements whose glob also names an entry exactly: they match as in 2.5x only. */
const EXACT_GLOBS = new Set(["x*y.txt", "[ab].txt"]);
const versionNeutral = (spec: string[]) => is25x || !spec.some((p) => EXACT_GLOBS.has(p));

let root: string;
const git = (cwd: string, args: string[], extra?: Record<string, string>) =>
  gitOut(root, cwd, args, extra);

/** Every worktree path (outside `.git`) with its content, a mode marker for executables. */
function listing(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (path === ".git") continue;
    if (entry.isDirectory()) {
      out.push(`${path}/`);
      out.push(...listing(dir, path));
      continue;
    }
    const stat = lstatSync(join(dir, path));
    const x = (stat.mode & 0o111) !== 0 ? "x " : "";
    out.push(`${path}: ${x}${readFileSync(join(dir, path), "latin1")}`);
  }
  return out.sort();
}

/** The index as `ls-files -s` with each entry's flags (`--debug` without the stat lines). */
const indexOf = (dir: string) =>
  git(dir, ["ls-files", "-s", "--debug"])
    .split("\n")
    .filter((l) => !/^\s+(ctime|mtime|dev|uid|size):/.test(l))
    .join("\n");

const stateOf = (dir: string) =>
  [listing(dir).join("\n"), indexOf(dir), git(dir, ["status", "--porcelain", "-uall"])].join(
    "\n----\n",
  );

/** The template repository's copy for one run. */
function copyOf(template: string, name: string): string {
  const copy = join(root, name);
  rmSync(copy, { recursive: true, force: true });
  execFileSync("cp", ["-a", template, copy]);
  // cp changes ctime and inode: git's checkout_entry would rewrite every file it stats
  gitRun(root, copy, ["update-index", "-q", "--refresh"]);
  return copy;
}

/** Native git's stderr lines that ours reports (hints and usage left out). */
const nativeLines = (stderr: string) =>
  stderr
    .split("\n")
    .filter((l) => l !== "")
    .join("\n");

/** Ours as git prints it: exit code and stderr lines. */
async function runOurs(
  repo: Git,
  run: (git: Git) => Promise<unknown>,
): Promise<{ status: number; stderr: string }> {
  try {
    const result = (await run(repo)) as Partial<CheckoutResult> | undefined;
    const lines: string[] = [];
    if (result && typeof result === "object" && "status" in result) {
      if (result.warnings) lines.push(...result.warnings.filter((l) => l.startsWith("warning:")));
      if (result.message) lines.push(...result.message.split("\n"));
      if (result.warnings) lines.push(...result.warnings.filter((l) => !l.startsWith("warning:")));
      const status = result.exitCode ?? (result.status === "OK" ? 0 : 1);
      return { status, stderr: lines.join("\n") };
    }
    return { status: 0, stderr: "" };
  } catch (error) {
    const e = error as Error & { exitCode?: number };
    return { status: e.exitCode ?? -1, stderr: e.message };
  }
}

/** Runs `native` in one copy of `template` and `ours` in another, and compares them. */
async function expectTwins(
  template: string,
  label: string,
  native: string[],
  ours: (git: Git) => Promise<unknown>,
  extra: Record<string, string> = {},
  /** what ours reports, besides the outcome (warnings ours keeps elsewhere) */
  oursLines?: (git: Git) => string[],
): Promise<string> {
  const theirs = copyOf(template, "native");
  const mine = copyOf(template, "ours");
  const result = gitRun(root, theirs, native.map(utf8), extra);
  const repo = await openRepo(root, mine, extra);
  const got = await runOurs(repo, ours);
  const lines = latin1(
    oursLines ? [...oursLines(repo), got.stderr].filter((l) => l).join("\n") : got.stderr,
  );
  expect(`${got.status}\n${lines}`, `${label}: exit and messages`).toBe(
    `${result.status}\n${nativeLines(result.stderr)}`,
  );
  const state = stateOf(theirs);
  expect(stateOf(mine), label).toBe(state);
  return state;
}

/** A latin-1 test string (each character a byte) as the UTF-8 string it encodes. */
const utf8 = (s: string) => Buffer.from(s, "latin1").toString();
/** A string as its UTF-8 bytes, one latin-1 character each (as native output is read). */
const latin1 = (s: string) => Buffer.from(s).toString("latin1");

/** Adds the pathspec elements to a command. */
const withPaths = <T extends { addPath(p: string): T }>(command: T, spec: readonly string[]) => {
  for (const p of spec) command.addPath(p);
  return command;
};

/** A repository whose HEAD differs from HEAD~1, the index from HEAD and the worktree from both. */
function base(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"]);
  putFile(dir, ".gitattributes", "*.c foo\nd/sub/** bar\n");
  for (const [path, content] of [
    ["a.txt", "a1\n"],
    ["b.txt", "b1\n"],
    ["c.md", "c1\n"],
    ["A.TXT", "upper1\n"],
    ["x*y.txt", "star1\n"],
    ["xzy.txt", "xzy1\n"],
    ["[ab].txt", "brackets1\n"],
    ["d/e.txt", "e1\n"],
    ["d/f.c", "f1\n"],
    ["d/sub/g.txt", "g1\n"],
    ["d/sub/h.c", "h1\n"],
    ["dir with space/s.txt", "s1\n"],
    ["\xc3\xa9/\xc3\xbc.txt", "u1\n"],
    ["gone.txt", "gone1\n"],
  ]) {
    putFile(dir, path, content);
  }
  putFile(dir, "run.sh", "#!/bin/sh\n");
  execFileSync("chmod", ["+x", join(dir, "run.sh")]);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "c1"]);
  // HEAD: changed, deleted and added files
  for (const [path, content] of [
    ["a.txt", "a2\n"],
    ["d/e.txt", "e2\n"],
    ["d/sub/h.c", "h2\n"],
    ["x*y.txt", "star2\n"],
    ["\xc3\xa9/\xc3\xbc.txt", "u2\n"],
    ["n.txt", "n2\n"],
    ["d/n.c", "nc2\n"],
  ]) {
    putFile(dir, path, content);
  }
  rmSync(join(dir, "gone.txt"));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-qm", "c2"]);
  // the index: staged changes and a new file
  putFile(dir, "b.txt", "b-staged\n");
  putFile(dir, "d/f.c", "f-staged\n");
  putFile(dir, "new.txt", "new\n");
  putFile(dir, "d/sub/new.c", "newc\n");
  git(dir, ["add", "b.txt", "d/f.c", "new.txt", "d/sub/new.c"]);
  putFile(dir, "ita.txt", "ita\n");
  git(dir, ["add", "-N", "ita.txt"]);
  // the worktree: unstaged changes, a deletion, untracked files
  for (const path of [
    "a.txt",
    "b.txt",
    "c.md",
    "A.TXT",
    "x*y.txt",
    "xzy.txt",
    "[ab].txt",
    "d/e.txt",
    "d/sub/g.txt",
    "dir with space/s.txt",
    "\xc3\xa9/\xc3\xbc.txt",
    "new.txt",
  ]) {
    putFile(
      dir,
      path,
      `${readFileSync(join(dir, Buffer.from(path, "latin1").toString()), "latin1")}wt\n`,
    );
  }
  rmSync(join(dir, "d/sub/h.c"));
  putFile(dir, "untracked.txt", "u\n");
  putFile(dir, "d/untracked.c", "u\n");
  git(dir, ["update-index", "-q", "--refresh"]);
}

/** About thirty pathspecs: wildcards, magic, attr, exclude, directories, non-ASCII. */
const ALL_SPECS: string[][] = [
  ["a.txt"],
  ["*.txt"],
  ["*.c"],
  ["d"],
  ["d/"],
  ["d/*"],
  ["d/**"],
  [":(glob)*.txt"],
  [":(glob)**/*.txt"],
  [":(glob)d/*"],
  [":(icase)a.TXT"],
  [":(literal)x*y.txt"],
  ["x*y.txt"],
  ["?.txt"],
  ["[ab].txt"],
  [":!d", "."],
  [":(exclude)*.txt", "."],
  [":^d/sub", "d"],
  [":/a.txt"],
  [":(top)d/e.txt"],
  ["."],
  [":(attr:foo)"],
  [":(attr:bar)"],
  [":(attr:-foo)d"],
  ["\xc3\xa9"],
  ["\xc3\xa9/\xc3\xbc.txt"],
  ["dir with space"],
  ["n.txt"],
  ["new.txt"],
  ["ita.txt"],
  ["gone.txt"],
  ["nomatch"],
  ["a.txt", "nomatch", "*.zzz"],
  ["d/sub/g.txt", "d/sub/g.txt"],
];

const SPECS = ALL_SPECS.filter(versionNeutral);

/** The elements as JavaScript strings (the latin-1 test strings decoded as UTF-8). */
const decode = (spec: string[]) => spec.map(utf8);

describeGit("checkout, restore and reset with pathspecs, as native git", () => {
  let template: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "checkout-paths-"));
    template = join(root, "template");
    base(template);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("git checkout [<tree-ish>] [--[no-]overlay] -- <pathspec>", async () => {
    const seen = new Set<string>();
    for (const raw of SPECS) {
      const spec = decode(raw);
      const label = raw.join(" ");
      seen.add(
        await expectTwins(template, `checkout -- ${label}`, ["checkout", "--", ...raw], (g) =>
          withPaths(g.checkout(), spec).call(),
        ),
      );
      seen.add(
        await expectTwins(
          template,
          `checkout HEAD~1 -- ${label}`,
          ["checkout", "HEAD~1", "--", ...raw],
          (g) => withPaths(g.checkout().setStartPoint("HEAD~1"), spec).call(),
        ),
      );
      seen.add(
        await expectTwins(
          template,
          `checkout --no-overlay HEAD~1 -- ${label}`,
          ["checkout", "--no-overlay", "HEAD~1", "--", ...raw],
          (g) => withPaths(g.checkout().setStartPoint("HEAD~1").setOverlay(false), spec).call(),
        ),
      );
    }
    expect(seen.size).toBeGreaterThan(40);
  }, 600_000);

  it("git restore [--source] [--staged] [--worktree] [--overlay] -- <pathspec>", async () => {
    for (const raw of SPECS) {
      const spec = decode(raw);
      const label = raw.join(" ");
      await expectTwins(template, `restore -- ${label}`, ["restore", "--", ...raw], (g) =>
        withPaths(g.restore(), spec).call(),
      );
      await expectTwins(
        template,
        `restore --source=HEAD~1 -- ${label}`,
        ["restore", "--source=HEAD~1", "--", ...raw],
        (g) => withPaths(g.restore().setSource("HEAD~1"), spec).call(),
      );
      await expectTwins(
        template,
        `restore --staged -- ${label}`,
        ["restore", "--staged", "--", ...raw],
        (g) => withPaths(g.restore().setStaged(true), spec).call(),
      );
      await expectTwins(
        template,
        `restore -SW -s HEAD~1 -- ${label}`,
        ["restore", "--staged", "--worktree", "--source=HEAD~1", "--", ...raw],
        (g) =>
          withPaths(g.restore().setStaged(true).setWorktree(true).setSource("HEAD~1"), spec).call(),
      );
      await expectTwins(
        template,
        `restore --overlay -s HEAD~1 -- ${label}`,
        ["restore", "--overlay", "--source=HEAD~1", "--", ...raw],
        (g) => withPaths(g.restore().setOverlay(true).setSource("HEAD~1"), spec).call(),
      );
    }
  }, 900_000);

  it("git reset [-N] [<tree-ish>] -- <pathspec>", async () => {
    for (const raw of SPECS) {
      const spec = decode(raw);
      const label = raw.join(" ");
      await expectTwins(template, `reset -- ${label}`, ["reset", "-q", "--", ...raw], (g) =>
        withPaths(g.reset(), spec).call(),
      );
      await expectTwins(
        template,
        `reset HEAD~1 -- ${label}`,
        ["reset", "-q", "HEAD~1", "--", ...raw],
        (g) => withPaths(g.reset().setRef("HEAD~1"), spec).call(),
      );
      await expectTwins(
        template,
        `reset -N HEAD~1 -- ${label}`,
        ["reset", "-q", "-N", "HEAD~1", "--", ...raw],
        (g) => withPaths(g.reset().setRef("HEAD~1").setIntentToAdd(true), spec).call(),
      );
    }
  }, 600_000);

  it("reset: modes with paths, --pathspec-from-file, -N without paths, an unborn HEAD", async () => {
    await expectTwins(template, "reset --hard -- a.txt", ["reset", "--hard", "--", "a.txt"], (g) =>
      g.reset().setMode(ResetMode.HARD).addPath("a.txt").call(),
    );
    let mixed: ReturnType<Git["reset"]> | undefined;
    await expectTwins(
      template,
      "reset --mixed -- a.txt",
      ["reset", "-q", "--mixed", "--", "a.txt"],
      (g) => {
        mixed = g.reset().setMode(ResetMode.MIXED).addPath("a.txt");
        return mixed.call();
      },
      {},
      () => mixed?.getWarnings() ?? [],
    );
    writeFileSync(join(root, "list"), 'd/*.c\n"\\303\\251"\n');
    await expectTwins(
      template,
      "reset --pathspec-from-file (written)",
      ["reset", "-q", "HEAD~1", `--pathspec-from-file=${join(root, "list")}`],
      (g) => g.reset().setRef("HEAD~1").setPathspecFromFile('d/*.c\n"\\303\\251"\n').call(),
    );
    await expectTwins(template, "reset -N HEAD~1", ["reset", "-q", "-N", "HEAD~1"], (g) =>
      g.reset().setRef("HEAD~1").setIntentToAdd(true).call(),
    );
    const unborn = join(root, "unborn");
    mkdirSync(unborn);
    git(unborn, ["init", "-q", "-b", "main"]);
    putFile(unborn, "a.txt", "a\n");
    putFile(unborn, "b.txt", "b\n");
    git(unborn, ["add", "."]);
    await expectTwins(
      unborn,
      "reset -- a.txt on an unborn HEAD",
      ["reset", "-q", "--", "a.txt"],
      (g) => g.reset().addPath("a.txt").call(),
    );
    await expectTwins(
      unborn,
      "reset -N -- a.txt on an unborn HEAD",
      ["reset", "-q", "-N", "--", "a.txt"],
      (g) => g.reset().setIntentToAdd(true).addPath("a.txt").call(),
    );
  }, 120_000);

  it("literal paths: GIT_LITERAL_PATHSPECS, and the counts without `--`", async () => {
    const literal = { GIT_LITERAL_PATHSPECS: "1" };
    for (const raw of [["x*y.txt"], ["*.txt"], [":(glob)*.txt"], ["d"]]) {
      const spec = decode(raw);
      const label = raw.join(" ");
      await expectTwins(
        template,
        `literal checkout -- ${label}`,
        ["checkout", "--", ...raw],
        (g) => withPaths(g.checkout(), spec).call(),
        literal,
      );
      await expectTwins(
        template,
        `literal restore -s HEAD~1 -- ${label}`,
        ["restore", "-s", "HEAD~1", "--", ...raw],
        (g) => withPaths(g.restore().setSource("HEAD~1"), spec).call(),
        literal,
      );
      await expectTwins(
        template,
        `literal reset HEAD~1 -- ${label}`,
        ["reset", "-q", "HEAD~1", "--", ...raw],
        (g) => withPaths(g.reset().setRef("HEAD~1"), spec).call(),
        literal,
      );
    }
    // `git checkout <paths>` and `git checkout <tree-ish> <paths>` (no `--`) count
    await expectTwins(template, "checkout a.txt d", ["checkout", "a.txt", "d"], (g) =>
      g.checkout().setCountCheckoutPaths(true).addPath("a.txt").addPath("d").call(),
    );
    await expectTwins(template, "checkout HEAD~1 d", ["checkout", "HEAD~1", "d"], (g) =>
      g.checkout().setCountCheckoutPaths(true).setStartPoint("HEAD~1").addPath("d").call(),
    );
    await expectTwins(template, "checkout c.md (up to date)", ["checkout", "run.sh"], (g) =>
      g.checkout().setCountCheckoutPaths(true).addPath("run.sh").call(),
    );
  }, 120_000);

  it("errors: dies and their exit codes", async () => {
    const cases: Array<[string, string[], (g: Git) => Promise<unknown>]> = [
      [
        "checkout --ours HEAD~1",
        ["checkout", "--ours", "HEAD~1", "--", "a.txt"],
        (g) =>
          g.checkout().setStage(CheckoutStage.OURS).setStartPoint("HEAD~1").addPath("a.txt").call(),
      ],
      [
        "checkout --ours -m",
        ["checkout", "--ours", "-m", "--", "a.txt"],
        (g) => g.checkout().setStage(CheckoutStage.OURS).setMerge(true).addPath("a.txt").call(),
      ],
      [
        "checkout -f -m",
        ["checkout", "-f", "-m", "--", "a.txt"],
        (g) => g.checkout().setForced(true).setMerge(true).addPath("a.txt").call(),
      ],
      [
        "checkout nosuch --",
        ["checkout", "nosuch", "--", "a.txt"],
        (g) => g.checkout().setStartPoint("nosuch").addPath("a.txt").call(),
      ],
      [
        "checkout <blob> --",
        ["checkout", "HEAD:a.txt", "--", "a.txt"],
        (g) => g.checkout().setStartPoint("HEAD:a.txt").addPath("a.txt").call(),
      ],
      [
        "restore --staged --ours",
        ["restore", "--staged", "--ours", "--", "a.txt"],
        (g) => g.restore().setStaged(true).setStage(CheckoutStage.OURS).addPath("a.txt").call(),
      ],
      [
        "restore --staged --merge",
        ["restore", "--staged", "--merge", "--", "a.txt"],
        (g) => g.restore().setStaged(true).setMerge(true).addPath("a.txt").call(),
      ],
      [
        "restore --no-worktree",
        ["restore", "--no-worktree", "--", "a.txt"],
        (g) => g.restore().setWorktree(false).addPath("a.txt").call(),
      ],
      [
        "restore --source --ours",
        ["restore", "--source=HEAD", "--ours", "--", "a.txt"],
        (g) => g.restore().setSource("HEAD").setStage(CheckoutStage.OURS).addPath("a.txt").call(),
      ],
      [
        "restore --source=nosuch",
        ["restore", "--source=nosuch", "--", "a.txt"],
        (g) => g.restore().setSource("nosuch").addPath("a.txt").call(),
      ],
      [
        "restore --ignore-unmerged -m",
        ["restore", "--ignore-unmerged", "-m", "--", "a.txt"],
        (g) => g.restore().setIgnoreUnmerged(true).setMerge(true).addPath("a.txt").call(),
      ],
      [
        "restore --source=<blob>",
        ["restore", "--source=HEAD:a.txt", "--", "a.txt"],
        (g) => g.restore().setSource("HEAD:a.txt").addPath("a.txt").call(),
      ],
      [
        "reset <blob> --",
        ["reset", "HEAD:a.txt", "--", "a.txt"],
        (g) => g.reset().setRef("HEAD:a.txt").addPath("a.txt").call(),
      ],
      ["restore without paths", ["restore"], (g) => g.restore().call()],
      [
        "reset --soft -- a.txt",
        ["reset", "--soft", "--", "a.txt"],
        (g) => g.reset().setMode(ResetMode.SOFT).addPath("a.txt").call(),
      ],
      [
        "reset nosuch -- a.txt",
        ["reset", "nosuch", "--", "a.txt"],
        (g) => g.reset().setRef("nosuch").addPath("a.txt").call(),
      ],
      [
        "reset --hard -N",
        ["reset", "--hard", "-N"],
        (g) => g.reset().setMode(ResetMode.HARD).setIntentToAdd(true).call(),
      ],
      [
        "checkout -- :(bogus)a",
        ["checkout", "--", ":(bogus)a"],
        (g) => g.checkout().addPath(":(bogus)a").call(),
      ],
    ];
    for (const [label, native, ours] of cases) {
      // git 2.43 said "could not resolve nosuch" (2.5x quotes the name)
      if (!is25x && label === "restore --source=nosuch") continue;
      // git 2.43 said "fatal: reference is not a tree: <rev>" for a blob
      if (!is25x && (label === "checkout <blob> --" || label === "restore --source=<blob>")) {
        continue;
      }
      const theirs = gitRun(root, copyOf(template, "native"), native);
      // usage lines are git's own
      const expected = nativeLines(theirs.stderr).split("\n")[0] ?? "";
      const got = await runOurs(await openRepo(root, copyOf(template, "ours")), ours);
      expect(`${got.status} ${got.stderr.split("\n")[0]}`, label).toBe(
        `${theirs.status} ${expected}`,
      );
    }
  }, 120_000);
});

describeGit("checkout and restore of unmerged paths, as native git", () => {
  let template: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "checkout-unmerged-"));
    template = join(root, "template");
    const dir = template;
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    putFile(dir, "m.txt", "1\n2\n3\n4\n5\n");
    putFile(dir, "md.txt", "keep\n");
    putFile(dir, "dm.txt", "keep\n");
    putFile(dir, "clean.txt", "c\n");
    putFile(dir, "bin.dat", "a\0b\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "base"]);
    git(dir, ["checkout", "-qb", "side"]);
    putFile(dir, "m.txt", "1\nside\n3\n4\n5\n");
    putFile(dir, "md.txt", "side change\n");
    rmSync(join(dir, "dm.txt"));
    putFile(dir, "aa.txt", "side add\n");
    putFile(dir, "bin.dat", "s\0side\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "side"]);
    git(dir, ["checkout", "-q", "main"]);
    putFile(dir, "m.txt", "1\nmain\n3\n4\n5\n");
    rmSync(join(dir, "md.txt"));
    putFile(dir, "dm.txt", "main change\n");
    putFile(dir, "aa.txt", "main add\n");
    putFile(dir, "bin.dat", "m\0main\n");
    putFile(dir, "clean.txt", "c2\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "main"]);
    gitRun(root, dir, ["merge", "-q", "side"]);
    putFile(dir, "clean.txt", "c3\n");
    // (exits 1 for the unmerged paths)
    gitRun(root, dir, ["update-index", "-q", "--refresh"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const resolved = (dir: string) => {
    putFile(dir, "m.txt", "resolved\n");
    git(dir, ["add", "m.txt"]);
  };

  it("--ours / --theirs / -m / --conflict / -f / --ignore-unmerged / errors", async () => {
    const S = CheckoutStage;
    const cases: Array<[string, string[], (g: Git) => Promise<unknown>]> = [
      [
        "checkout -- m.txt",
        ["checkout", "--", "m.txt"],
        (g) => g.checkout().addPath("m.txt").call(),
      ],
      ["checkout -- .", ["checkout", "--", "."], (g) => g.checkout().addPath(".").call()],
      [
        "checkout --ours -- m.txt",
        ["checkout", "--ours", "--", "m.txt"],
        (g) => g.checkout().setStage(S.OURS).addPath("m.txt").call(),
      ],
      [
        "checkout --theirs -- *.txt",
        ["checkout", "--theirs", "--", "*.txt"],
        (g) => g.checkout().setStage(S.THEIRS).addPath("*.txt").call(),
      ],
      [
        "checkout --ours -- .",
        ["checkout", "--ours", "--", "."],
        (g) => g.checkout().setStage(S.OURS).addPath(".").call(),
      ],
      [
        "checkout --theirs --no-overlay -- .",
        ["checkout", "--theirs", "--no-overlay", "--", "."],
        (g) => g.checkout().setStage(S.THEIRS).setOverlay(false).addPath(".").call(),
      ],
      [
        "checkout -m -- m.txt aa.txt",
        ["checkout", "-m", "--", "m.txt", "aa.txt"],
        (g) => g.checkout().setMerge(true).addPath("m.txt").addPath("aa.txt").call(),
      ],
      [
        "checkout -m m.txt (counts)",
        ["checkout", "-m", "m.txt", "clean.txt"],
        (g) =>
          g
            .checkout()
            .setCountCheckoutPaths(true)
            .setMerge(true)
            .addPath("m.txt")
            .addPath("clean.txt")
            .call(),
      ],
      [
        "checkout --conflict=diff3 -- m.txt",
        ["checkout", "--conflict=diff3", "--", "m.txt"],
        (g) => g.checkout().setConflictStyle("diff3").addPath("m.txt").call(),
      ],
      [
        "checkout -m -- md.txt",
        ["checkout", "-m", "--", "md.txt"],
        (g) => g.checkout().setMerge(true).addPath("md.txt").call(),
      ],
      [
        "checkout -m -- bin.dat",
        ["checkout", "-m", "--", "bin.dat"],
        (g) => g.checkout().setMerge(true).addPath("bin.dat").call(),
      ],
      [
        "checkout -f -- .",
        ["checkout", "-f", "--", "."],
        (g) => g.checkout().setForced(true).addPath(".").call(),
      ],
      [
        "checkout HEAD -- m.txt",
        ["checkout", "HEAD", "--", "m.txt"],
        (g) => g.checkout().setStartPoint("HEAD").addPath("m.txt").call(),
      ],
      ["restore -- m.txt", ["restore", "--", "m.txt"], (g) => g.restore().addPath("m.txt").call()],
      [
        "restore --ours -- .",
        ["restore", "--ours", "--", "."],
        (g) => g.restore().setStage(S.OURS).addPath(".").call(),
      ],
      [
        "restore --theirs -- m.txt dm.txt",
        ["restore", "--theirs", "--", "m.txt", "dm.txt"],
        (g) => g.restore().setStage(S.THEIRS).addPath("m.txt").addPath("dm.txt").call(),
      ],
      [
        "restore --merge -- m.txt",
        ["restore", "--merge", "--", "m.txt"],
        (g) => g.restore().setMerge(true).addPath("m.txt").call(),
      ],
      [
        "restore --ignore-unmerged -- .",
        ["restore", "--ignore-unmerged", "--", "."],
        (g) => g.restore().setIgnoreUnmerged(true).addPath(".").call(),
      ],
      [
        "restore --staged -- m.txt",
        ["restore", "--staged", "--", "m.txt"],
        (g) => g.restore().setStaged(true).addPath("m.txt").call(),
      ],
      [
        "restore --staged -- md.txt",
        ["restore", "--staged", "--", "md.txt"],
        (g) => g.restore().setStaged(true).addPath("md.txt").call(),
      ],
      ["reset -- m.txt", ["reset", "-q", "--", "m.txt"], (g) => g.reset().addPath("m.txt").call()],
      ["reset -- .", ["reset", "-q", "--", "."], (g) => g.reset().addPath(".").call()],
      [
        "reset -N -- md.txt aa.txt",
        ["reset", "-q", "-N", "--", "md.txt", "aa.txt"],
        (g) => g.reset().setIntentToAdd(true).addPath("md.txt").addPath("aa.txt").call(),
      ],
    ];
    for (const [label, native, ours] of cases) {
      await expectTwins(template, label, native, ours);
    }
  }, 300_000);

  it("checkout -m re-creates a resolved conflict from resolve-undo", async () => {
    const dir = join(root, "resolved");
    rmSync(dir, { recursive: true, force: true });
    execFileSync("cp", ["-a", template, dir]);
    resolved(dir);
    await expectTwins(dir, "checkout -m -- m.txt", ["checkout", "-m", "--", "m.txt"], (g) =>
      g.checkout().setMerge(true).addPath("m.txt").call(),
    );
    await expectTwins(dir, "restore -m -- .", ["restore", "-m", "--", "."], (g) =>
      g.restore().setMerge(true).addPath(".").call(),
    );
    // the resolve-undo record is gone once used: both forget it
    const theirs = copyOf(dir, "native");
    const mine = copyOf(dir, "ours");
    gitRun(root, theirs, ["checkout", "-m", "--", "m.txt"]);
    await (await openRepo(root, mine)).checkout().setMerge(true).addPath("m.txt").call();
    for (const d of [theirs, mine]) resolved(d);
    gitRun(root, theirs, ["checkout", "-m", "--", "m.txt"]);
    await (await openRepo(root, mine)).checkout().setMerge(true).addPath("m.txt").call();
    expect(stateOf(mine)).toBe(stateOf(theirs));
    expect(existsSync(join(mine, "m.txt"))).toBe(true);
  }, 120_000);
});

describeGit("checkout, restore and reset in a sparse checkout, as native git", () => {
  let template: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "checkout-sparse-"));
    template = join(root, "template");
    const dir = template;
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    putFile(dir, "a.txt", "a1\n");
    putFile(dir, "in/b.txt", "b1\n");
    putFile(dir, "out/c.txt", "c1\n");
    putFile(dir, "out/d.txt", "d1\n");
    putFile(dir, "out/deep/e.txt", "e1\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "c1"]);
    putFile(dir, "out/c.txt", "c2\n");
    putFile(dir, "in/b.txt", "b2\n");
    putFile(dir, "out/new.txt", "new2\n");
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", "c2"]);
    git(dir, ["sparse-checkout", "set", "in"]);
    putFile(dir, "in/b.txt", "b-wt\n");
    git(dir, ["update-index", "-q", "--refresh"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("skip-worktree entries are passed over unless --ignore-skip-worktree-bits", async () => {
    const specs: string[][] = [
      ["out/c.txt"],
      ["out"],
      ["*.txt"],
      ["."],
      ["out/d.txt", "in"],
      [":(glob)out/**"],
    ];
    for (const spec of specs) {
      const label = spec.join(" ");
      await expectTwins(template, `checkout -- ${label}`, ["checkout", "--", ...spec], (g) =>
        withPaths(g.checkout(), spec).call(),
      );
      await expectTwins(
        template,
        `checkout --ignore-skip-worktree-bits -- ${label}`,
        ["checkout", "--ignore-skip-worktree-bits", "--", ...spec],
        (g) => withPaths(g.checkout().setIgnoreSkipWorktreeBits(true), spec).call(),
      );
      await expectTwins(
        template,
        `checkout HEAD~1 -- ${label}`,
        ["checkout", "HEAD~1", "--", ...spec],
        (g) => withPaths(g.checkout().setStartPoint("HEAD~1"), spec).call(),
      );
      await expectTwins(
        template,
        `restore -s HEAD~1 -- ${label}`,
        ["restore", "-s", "HEAD~1", "--", ...spec],
        (g) => withPaths(g.restore().setSource("HEAD~1"), spec).call(),
      );
      await expectTwins(
        template,
        `restore --staged -s HEAD~1 -- ${label}`,
        ["restore", "--staged", "-s", "HEAD~1", "--", ...spec],
        (g) => withPaths(g.restore().setStaged(true).setSource("HEAD~1"), spec).call(),
      );
      await expectTwins(
        template,
        `restore -SW --ignore-skip-worktree-bits -s HEAD~1 -- ${label}`,
        ["restore", "-SW", "--ignore-skip-worktree-bits", "-s", "HEAD~1", "--", ...spec],
        (g) =>
          withPaths(
            g
              .restore()
              .setStaged(true)
              .setWorktree(true)
              .setIgnoreSkipWorktreeBits(true)
              .setSource("HEAD~1"),
            spec,
          ).call(),
      );
      await expectTwins(
        template,
        `reset HEAD~1 -- ${label}`,
        ["reset", "-q", "HEAD~1", "--", ...spec],
        (g) => withPaths(g.reset().setRef("HEAD~1"), spec).call(),
      );
    }
  }, 300_000);
});

/** Native `write-tree` and `status` on a result (both fail on an index naming a missing object). */
const soundness = (dir: string) => {
  const tree = gitRun(root, dir, ["write-tree"]);
  const status = gitRun(root, dir, ["status", "--porcelain"]);
  return `write-tree ${tree.status} ${tree.stdout}${tree.stderr}\nstatus ${status.status} ${status.stderr}`;
};

/** The twins {@link expectTwins} left behind: native git reads ours as it reads its own. */
function expectSoundTwins(label: string, mustSucceed = true): void {
  const theirs = soundness(join(root, "native"));
  expect(soundness(join(root, "ours")), `${label}: write-tree and status`).toBe(theirs);
  if (mustSucceed) expect(theirs, label).toMatch(/^write-tree 0 [0-9a-f]{40}\n\nstatus 0 $/);
}

/** Replaces the index entries of `path` with conflict stages (`[stage, content]`). */
function unmerge(dir: string, path: string, stages: Array<[number, string]>): void {
  const lines = [`0 ${"0".repeat(40)}\t${path}`];
  for (const [stage, content] of stages) {
    const id = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: dir,
      input: content,
    })
      .toString()
      .trim();
    lines.push(`100644 ${id} ${stage}\t${path}`);
  }
  execFileSync("git", ["update-index", "--index-info"], {
    cwd: dir,
    input: `${lines.join("\n")}\n`,
  });
}

describeGit("path checkouts and resets: the index git writes, removals, merges, errors", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "checkout-paths-fixes-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const fixture = (name: string, build: (dir: string) => void) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    git(dir, ["init", "-q", "-b", "main"]);
    build(dir);
    gitRun(root, dir, ["update-index", "-q", "--refresh"]);
    return dir;
  };

  it("reset -N writes the empty blob its intent-to-add entries name", async () => {
    const template = fixture("ita", (dir) => {
      putFile(dir, "a/x", "1\n");
      putFile(dir, "c/z", "3\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "c1"]);
      putFile(dir, "c/n", "4\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "c2"]);
    });
    const emptyBlob = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
    expect(gitRun(root, template, ["cat-file", "-e", emptyBlob]).status).not.toBe(0);
    await expectTwins(
      template,
      "reset -N HEAD~1 -- .",
      ["reset", "-q", "-N", "HEAD~1", "--", "."],
      (g) => g.reset().setRef("HEAD~1").setIntentToAdd(true).addPath(".").call(),
    );
    expectSoundTwins("reset -N HEAD~1 -- .");
    await expectTwins(template, "reset -N HEAD~1", ["reset", "-q", "-N", "HEAD~1"], (g) =>
      g.reset().setRef("HEAD~1").setIntentToAdd(true).call(),
    );
    expectSoundTwins("reset -N HEAD~1");
    // apply -N (add_index_file's set_object_name_for_intent_to_add_entry); native git's
    // apply -N never reads the index (only --index does), so the index starts empty here
    const empty = fixture("ita-apply", () => {});
    const patch =
      "diff --git a/c/m b/c/m\nnew file mode 100644\n--- /dev/null\n+++ b/c/m\n@@ -0,0 +1 @@\n+5\n";
    writeFileSync(join(root, "new.patch"), patch);
    await expectTwins(empty, "apply -N", ["apply", "-N", join(root, "new.patch")], (g) =>
      g.apply().setIntentToAdd(true).addPatch(patch).call(),
    );
    expectSoundTwins("apply -N");
  }, 120_000);

  it("reset: a stage-0 entry replaces the stage-0 entries it clashes with", async () => {
    // reset: p/q comes back from HEAD~1, the file p of HEAD leaves the index
    const fileOverDir = fixture("file-over-dir", (dir) => {
      putFile(dir, "p/q", "q\n");
      putFile(dir, "o", "o\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-qm", "c1"]);
      git(dir, ["rm", "-q", "-r", "p"]);
      putFile(dir, "p", "pf\n");
      git(dir, ["add", "p"]);
      git(dir, ["commit", "-qm", "c2"]);
    });
    await expectTwins(
      fileOverDir,
      "reset HEAD~1 -- p/q",
      ["reset", "-q", "HEAD~1", "--", "p/q"],
      (g) => g.reset().setRef("HEAD~1").addPath("p/q").call(),
    );
    expectSoundTwins("reset HEAD~1 -- p/q");
    await expectTwins(
      fileOverDir,
      "reset -N HEAD~1 -- p/q p",
      ["reset", "-q", "-N", "HEAD~1", "--", "p/q", "p"],
      (g) => g.reset().setRef("HEAD~1").setIntentToAdd(true).addPath("p/q").addPath("p").call(),
    );
    expectSoundTwins("reset -N HEAD~1 -- p/q p");
  }, 120_000);

  it("checkout: a file from the tree leaves the conflict stages below it", async () => {
    // checkout: the file p from HEAD~1 leaves the unmerged p/q as it is ("UD p/q")
    const unmergedBelow = fixture("unmerged-below", (dir) => {
      putFile(dir, "d/g", "g\n");
      putFile(dir, "p", "pf\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-qm", "c1"]);
      rmSync(join(dir, "p"));
      putFile(dir, "p/q", "q\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "c2"]);
      unmerge(dir, "p/q", [
        [1, "base\n"],
        [2, "q\n"],
      ]);
    });
    await expectTwins(
      unmergedBelow,
      "checkout HEAD~1 -- :^d/g",
      ["checkout", "HEAD~1", "--", ":^d/g"],
      (g) => g.checkout().setStartPoint("HEAD~1").addPath(":^d/g").call(),
    );
    expectSoundTwins("checkout HEAD~1 -- :^d/g", false);
  }, 120_000);

  it("restore: a file below an unmerged path leaves its stages, refused as unmerged", async () => {
    // restore: p/q from HEAD~1 leaves the unmerged file p, which is then refused
    const unmergedAbove = fixture("unmerged-above", (dir) => {
      putFile(dir, "p/q", "q\n");
      putFile(dir, "o", "o\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-qm", "c1"]);
      rmSync(join(dir, "p"), { recursive: true });
      putFile(dir, "p", "pf\n");
      git(dir, ["add", "-A"]);
      git(dir, ["commit", "-qm", "c2"]);
      unmerge(dir, "p", [
        [1, "base\n"],
        [2, "pf\n"],
      ]);
    });
    await expectTwins(
      unmergedAbove,
      "restore -s HEAD~1 -- *",
      ["restore", "-s", "HEAD~1", "--", "*"],
      (g) => g.restore().setSource("HEAD~1").addPath("*").call(),
    );
    await expectTwins(
      unmergedAbove,
      "restore -SW -s HEAD~1 -- *",
      ["restore", "-SW", "-s", "HEAD~1", "--", "*"],
      (g) => g.restore().setStaged(true).setWorktree(true).setSource("HEAD~1").addPath("*").call(),
    );
  }, 120_000);

  it("no-overlay removals prune emptied directories, a file already gone too", async () => {
    const template = fixture("prune", (dir) => {
      putFile(dir, "keep.txt", "k\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-qm", "c1"]);
      putFile(dir, "n/deep/z", "z\n");
      putFile(dir, "n/deep/z2", "z2\n");
      putFile(dir, "au/sub/v", "v\n");
      putFile(dir, "here/w", "w\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-qm", "c2"]);
      // gone from the worktree, their directories left (one a directory of its own)
      rmSync(join(dir, "n/deep/z"));
      rmSync(join(dir, "n/deep/z2"));
      rmSync(join(dir, "au/sub/v"));
      git(dir, ["update-index", "--assume-unchanged", "au/sub/v"]);
    });
    const cases: Array<[string, string[], (g: Git) => Promise<unknown>]> = [
      [
        "restore -s HEAD~1 -- n",
        ["restore", "-s", "HEAD~1", "--", "n"],
        (g) => g.restore().setSource("HEAD~1").addPath("n").call(),
      ],
      [
        "restore -SW -s HEAD~1 -- n here",
        ["restore", "-SW", "-s", "HEAD~1", "--", "n", "here"],
        (g) =>
          g
            .restore()
            .setStaged(true)
            .setWorktree(true)
            .setSource("HEAD~1")
            .addPath("n")
            .addPath("here")
            .call(),
      ],
      [
        "checkout --no-overlay HEAD~1 -- .",
        ["checkout", "--no-overlay", "HEAD~1", "--", "."],
        (g) => g.checkout().setOverlay(false).setStartPoint("HEAD~1").addPath(".").call(),
      ],
      [
        "restore -s HEAD~1 -- au (assume-unchanged)",
        ["restore", "-s", "HEAD~1", "--", "au"],
        (g) => g.restore().setSource("HEAD~1").addPath("au").call(),
      ],
      [
        "restore -SW -s HEAD~1 -- au (assume-unchanged)",
        ["restore", "-SW", "-s", "HEAD~1", "--", "au"],
        (g) =>
          g.restore().setStaged(true).setWorktree(true).setSource("HEAD~1").addPath("au").call(),
      ],
    ];
    for (const [label, native, ours] of cases) {
      await expectTwins(template, label, native, ours);
    }
  }, 120_000);

  it("no-overlay removals: nothing beneath a symbolic link", async () => {
    // a symbolic link on a leading directory: nothing beneath it is unlinked
    const linked = fixture("linked", (dir) => {
      putFile(dir, "keep.txt", "k\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-qm", "c1"]);
      putFile(dir, "sl/f", "f\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-qm", "c2"]);
      rmSync(join(dir, "sl"), { recursive: true });
      putFile(dir, "target/f", "f\n");
      execFileSync("ln", ["-s", "target", join(dir, "sl")]);
    });
    const theirs = copyOf(linked, "native");
    const mine = copyOf(linked, "ours");
    const result = gitRun(root, theirs, ["restore", "-s", "HEAD~1", "--", "sl"]);
    const got = await runOurs(await openRepo(root, mine), (g) =>
      g.restore().setSource("HEAD~1").addPath("sl").call(),
    );
    expect(`${got.status}\n${got.stderr}`).toBe(`${result.status}\n${nativeLines(result.stderr)}`);
    for (const dir of [theirs, mine]) expect(existsSync(join(dir, "target/f")), dir).toBe(true);
    expect(indexOf(mine)).toBe(indexOf(theirs));
    expect(git(mine, ["status", "--porcelain", "-uall"])).toBe(
      git(theirs, ["status", "--porcelain", "-uall"]),
    );
  }, 120_000);

  it("no-overlay removals that fail warn: a populated gitlink, a directory for a file", async () => {
    const template = fixture("warnings", (dir) => {
      putFile(dir, "keep.txt", "k\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-qm", "c1"]);
      for (const sm of ["sm", "g/sm2"]) {
        const inner = join(dir, sm);
        mkdirSync(inner, { recursive: true });
        git(inner, ["init", "-q", "-b", "main"]);
        putFile(inner, "i", "i\n");
        git(inner, ["add", "."]);
        git(inner, ["commit", "-qm", "inner"]);
        git(dir, ["add", sm]);
      }
      putFile(dir, "q", "q\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-qm", "c2"]);
      // a gitlink whose directory is gone, a directory where the file q was
      rmSync(join(dir, "g/sm2"), { recursive: true });
      rmSync(join(dir, "q"));
      putFile(dir, "q/inside", "x\n");
    });
    await expectTwins(
      template,
      "checkout --no-overlay HEAD~1 -- sm",
      ["checkout", "--no-overlay", "HEAD~1", "--", "sm"],
      (g) => g.checkout().setOverlay(false).setStartPoint("HEAD~1").addPath("sm").call(),
    );
    await expectTwins(
      template,
      "restore -s HEAD~1 -- q",
      ["restore", "-s", "HEAD~1", "--", "q"],
      (g) => g.restore().setSource("HEAD~1").addPath("q").call(),
    );
    await expectTwins(
      template,
      "restore -s HEAD~1 -- sm g q",
      ["restore", "-s", "HEAD~1", "--", "sm", "g", "q"],
      (g) => g.restore().setSource("HEAD~1").addPath("sm").addPath("g").addPath("q").call(),
    );
  }, 120_000);

  it("restore --ours without our version warns of a directory in the way", async () => {
    // restore --ours (no overlay) of a path without our version, a directory there now
    const theirsOnly = fixture("theirs-only", (dir) => {
      putFile(dir, "o", "o\n");
      putFile(dir, "p", "p\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-qm", "c1"]);
      unmerge(dir, "p", [
        [1, "base\n"],
        [3, "theirs\n"],
      ]);
      rmSync(join(dir, "p"));
      putFile(dir, "p/z", "z\n");
    });
    await expectTwins(theirsOnly, "restore --ours -- p", ["restore", "--ours", "--", "p"], (g) =>
      g.restore().setStage(CheckoutStage.OURS).addPath("p").call(),
    );
  }, 120_000);

  it("checkout -m merges with the merge and conflict-marker-size attributes", async () => {
    const template = fixture("attrs", (dir) => {
      const files = ["u.txt", "b.txt", "n.txt", "m.txt", "plain.txt"];
      for (const f of files) putFile(dir, f, "1\n2\n3\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-qm", "base"]);
      git(dir, ["checkout", "-qb", "side"]);
      for (const f of files) putFile(dir, f, "1\nside\n3\n");
      git(dir, ["commit", "-qam", "side"]);
      git(dir, ["checkout", "-q", "main"]);
      for (const f of files) putFile(dir, f, "1\nmain\n3\n");
      git(dir, ["commit", "-qam", "main"]);
      gitRun(root, dir, ["merge", "-q", "side"]);
      putFile(
        dir,
        ".gitattributes",
        "u.txt merge=union\nb.txt merge=binary\nn.txt -merge\nm.txt conflict-marker-size=12\n",
      );
    });
    const paths = ["u.txt", "b.txt", "n.txt", "m.txt", "plain.txt"];
    await expectTwins(template, "checkout -m -- m.txt", ["checkout", "-m", "--", "m.txt"], (g) =>
      g.checkout().setMerge(true).addPath("m.txt").call(),
    );
    await expectTwins(template, "checkout -m -- u.txt", ["checkout", "-m", "--", "u.txt"], (g) =>
      g.checkout().setMerge(true).addPath("u.txt").call(),
    );
    await expectTwins(template, "checkout -m -- <all>", ["checkout", "-m", "--", ...paths], (g) =>
      withPaths(g.checkout().setMerge(true), paths).call(),
    );
    await expectTwins(template, "checkout -m <all> (counts)", ["checkout", "-m", ...paths], (g) =>
      withPaths(g.checkout().setCountCheckoutPaths(true).setMerge(true), paths).call(),
    );
    await expectTwins(
      template,
      "checkout --conflict=diff3 -- m.txt u.txt",
      ["checkout", "--conflict=diff3", "--", "m.txt", "u.txt"],
      (g) => g.checkout().setConflictStyle("diff3").addPath("m.txt").addPath("u.txt").call(),
    );
    await expectTwins(template, "restore -m -- .", ["restore", "-m", "--", "."], (g) =>
      g.restore().setMerge(true).addPath(".").call(),
    );
  }, 120_000);

  it("a blob missing partway: an error for its path, the rest checked out, exit 255", async () => {
    const template = fixture("missing-blob", (dir) => {
      for (const f of ["a", "b", "c", "d/e"]) putFile(dir, f, `${f}1\n`);
      git(dir, ["add", "."]);
      git(dir, ["commit", "-qm", "c1"]);
      for (const f of ["a", "b", "c", "d/e"]) putFile(dir, f, `${f}2\n`);
      git(dir, ["add", "."]);
      git(dir, ["commit", "-qm", "c2"]);
      for (const f of ["b", "d/e"]) {
        const id = git(dir, ["rev-parse", `HEAD~1:${f}`]).trim();
        rmSync(join(dir, ".git/objects", id.slice(0, 2), id.slice(2)));
      }
      rmSync(join(dir, "d"), { recursive: true });
    });
    const cases: Array<[string, string[], (g: Git) => Promise<unknown>]> = [
      [
        "checkout HEAD~1 -- a b c d",
        ["checkout", "HEAD~1", "--", "a", "b", "c", "d"],
        (g) => withPaths(g.checkout().setStartPoint("HEAD~1"), ["a", "b", "c", "d"]).call(),
      ],
      [
        "checkout HEAD~1 a b c (counts)",
        ["checkout", "HEAD~1", "a", "b", "c"],
        (g) =>
          withPaths(g.checkout().setCountCheckoutPaths(true).setStartPoint("HEAD~1"), [
            "a",
            "b",
            "c",
          ]).call(),
      ],
      [
        "restore -s HEAD~1 -- .",
        ["restore", "-s", "HEAD~1", "--", "."],
        (g) => g.restore().setSource("HEAD~1").addPath(".").call(),
      ],
      [
        "restore -SW -s HEAD~1 -- .",
        ["restore", "-SW", "-s", "HEAD~1", "--", "."],
        (g) =>
          g.restore().setStaged(true).setWorktree(true).setSource("HEAD~1").addPath(".").call(),
      ],
    ];
    for (const [label, native, ours] of cases) {
      await expectTwins(template, label, native, ours);
    }
  }, 120_000);
});
