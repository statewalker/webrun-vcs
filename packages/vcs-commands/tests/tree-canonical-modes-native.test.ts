/**
 * Trees whose blobs are stored with mode 100664 (older git wrote it) read as git reads
 * them: `decode_tree_entry` canonicalises every mode (`canon_mode`: 100664 is 100644), so
 * status is clean after `reset --hard`, merges, checkouts, picks and reverts go through,
 * diffs and patch-ids see no mode change, and the trees git rebuilds hold canonical modes.
 * Only fsck reads the modes as stored (`TREE_DESC_RAW_MODES`). Each case builds the same
 * history twice with native git (`mktree`, `commit-tree`), runs native git in one twin and
 * ours in the other, then compares them.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { formatStatusPorcelain, ResetMode } from "../src/index.js";
import {
  git,
  gitOk,
  INTEROP_AUTHOR_ENV,
  INTEROP_IDENT,
  normalizeState,
  openOurs,
  put,
  snapshot,
} from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;
/** `--no-references` where native git knows it (2.45+ checks the refs in fsck otherwise) */
let noReferences: string[] = [];

/** Native git reading `input` on stdin; its stdout, trimmed. */
function gitIn(dir: string, input: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    env: nativeGitEnv(root),
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

interface Repo {
  dir: string;
  c0: string;
  main: string;
  theirs: string;
}

/**
 * The repository of the report: c0 holds f, g, h as 100664; main (on c0) makes f 100644 and
 * g's content b (still 100664); theirs (on c0) makes f 100755, g 100644 and h's content b;
 * up (on c0) makes g's content b as main does, with g stored 100644 and f left 100664.
 * The branch main is checked out (`reset --hard`).
 */
function build(dir: string): Repo {
  gitOk(root, root, "init", "-q", "-b", "main", dir);
  const a = gitIn(dir, "a\n", "hash-object", "-w", "--stdin");
  const b = gitIn(dir, "b\n", "hash-object", "-w", "--stdin");
  const tree = (lines: string[]) => gitIn(dir, `${lines.join("\n")}\n`, "mktree");
  const t0 = tree([`100664 blob ${a}\tf`, `100664 blob ${a}\tg`, `100664 blob ${a}\th`]);
  const t1 = tree([`100644 blob ${a}\tf`, `100664 blob ${b}\tg`, `100664 blob ${a}\th`]);
  const t2 = tree([`100755 blob ${a}\tf`, `100644 blob ${a}\tg`, `100664 blob ${b}\th`]);
  const t3 = tree([`100664 blob ${a}\tf`, `100644 blob ${b}\tg`, `100664 blob ${a}\th`]);
  const c0 = gitIn(dir, "c0\n", "commit-tree", t0);
  const main = gitIn(dir, "main\n", "commit-tree", t1, "-p", c0);
  const theirs = gitIn(dir, "theirs\n", "commit-tree", t2, "-p", c0);
  const up = gitIn(dir, "up\n", "commit-tree", t3, "-p", c0);
  gitOk(root, dir, "update-ref", "refs/heads/main", main);
  gitOk(root, dir, "update-ref", "refs/heads/theirs", theirs);
  gitOk(root, dir, "update-ref", "refs/heads/up", up);
  gitOk(root, dir, "reset", "-q", "--hard", "main");
  return { dir, c0, main, theirs };
}

function twins(): { native: Repo; ours: Repo } {
  const n = counter++;
  return { native: build(join(root, `n${n}`)), ours: build(join(root, `o${n}`)) };
}

/**
 * Both twins alike: HEAD, status, index entries, worktree files, state files; then the tree
 * `git write-tree` writes from each index, which reuses its cache-tree's valid directories
 * (a primed one keeps a stored tree's 100664 modes, a recomputed one is canonical).
 */
function same(ours: string, native: string, writeTree = true) {
  expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
  if (writeTree) expect(gitOk(root, ours, "write-tree")).toBe(gitOk(root, native, "write-tree"));
}

const lsTree = (dir: string, rev: string) => gitOk(root, dir, "ls-tree", "-r", rev);

describeGit("trees with 100664 modes read as git reads them", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "tree-canonical-modes-"));
    gitOk(root, root, "init", "-q", join(root, "probe"));
    const probe = git(root, join(root, "probe"), "fsck", "--no-references");
    noReferences = probe.status === 129 ? [] : ["--no-references"];
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("status is clean after reset --hard, as git's", async () => {
    const { native, ours } = twins();
    const theirs = gitOk(root, native.dir, "status", "--porcelain=v2");
    const g = await openOurs(ours.dir);
    expect(formatStatusPorcelain(await g.status().call(), 2)).toBe(theirs);
    expect(theirs).toBe("");
    // the index holds canonical modes, as git's unpack-trees builds it
    expect(gitOk(root, ours.dir, "ls-files", "-s")).toBe(gitOk(root, native.dir, "ls-files", "-s"));
  });

  it("a status with a worktree change shows only that change", async () => {
    const { native, ours } = twins();
    put(native.dir, "h", "changed\n");
    put(ours.dir, "h", "changed\n");
    const theirs = gitOk(root, native.dir, "status", "--porcelain=v2");
    const g = await openOurs(ours.dir);
    expect(formatStatusPorcelain(await g.status().call(), 2)).toBe(theirs);
  });

  it("merge theirs is clean and writes git's tree", async () => {
    const { native, ours } = twins();
    expect(git(root, native.dir, "merge", "--no-edit", "theirs").status).toBe(0);
    const g = await openOurs(ours.dir);
    const r = await g
      .merge()
      .include("theirs")
      .setAuthor(INTEROP_IDENT)
      .setCommitter(INTEROP_IDENT)
      .call();
    expect(r.status).toBe("merged");
    same(ours.dir, native.dir);
    expect(lsTree(ours.dir, "HEAD")).toBe(lsTree(native.dir, "HEAD"));
    expect(gitOk(root, ours.dir, "cat-file", "-p", "HEAD^{tree}")).toContain("100755 blob");
  });

  it("checkout of c0 goes through", async () => {
    const { native, ours } = twins();
    gitOk(root, native.dir, "checkout", "-q", native.c0);
    const g = await openOurs(ours.dir);
    await g.checkout().setName(ours.c0).call();
    same(ours.dir, native.dir);
  });

  it("checkout of c0 with a worktree change carries it", async () => {
    const { native, ours } = twins();
    put(native.dir, "h", "changed\n");
    put(ours.dir, "h", "changed\n");
    gitOk(root, native.dir, "checkout", "-q", native.c0);
    const g = await openOurs(ours.dir);
    await g.checkout().setName(ours.c0).call();
    same(ours.dir, native.dir);
  });

  it("cherry-pick of theirs writes git's commit", async () => {
    const { native, ours } = twins();
    expect(git(root, native.dir, "cherry-pick", "theirs").status).toBe(0);
    const g = await openOurs(ours.dir);
    await g.cherryPick().include("theirs").setCommitter(INTEROP_IDENT).call();
    same(ours.dir, native.dir);
  });

  it("revert of main writes git's commit", async () => {
    const { native, ours } = twins();
    expect(git(root, native.dir, "revert", "--no-edit", "main").status).toBe(0);
    const g = await openOurs(ours.dir, INTEROP_AUTHOR_ENV);
    await g.revert().include("main").setCommitter(INTEROP_IDENT).call();
    same(ours.dir, native.dir);
  });

  it("reset --hard and --mixed to c0", async () => {
    for (const [flag, mode] of [
      ["--hard", ResetMode.HARD],
      ["--mixed", ResetMode.MIXED],
      ["--soft", ResetMode.SOFT],
    ] as const) {
      const { native, ours } = twins();
      gitOk(root, native.dir, "reset", "-q", flag, native.c0);
      const g = await openOurs(ours.dir);
      await g.reset().setRef(ours.c0).setMode(mode).call();
      same(ours.dir, native.dir);
      expect(formatStatusPorcelain(await (await openOurs(ours.dir)).status().call(), 2)).toBe(
        gitOk(root, native.dir, "status", "--porcelain=v2"),
      );
    }
  });

  it("stash of a worktree change stores git's trees and applies back", async () => {
    const { native, ours } = twins();
    put(native.dir, "h", "changed\n");
    put(ours.dir, "h", "changed\n");
    gitOk(root, native.dir, "stash", "-q");
    const g = await openOurs(ours.dir);
    expect(await g.stashCreate().call()).toBeDefined();
    for (const rev of ["stash^{tree}", "stash^2^{tree}"]) {
      expect(gitOk(root, ours.dir, "rev-parse", rev)).toBe(
        gitOk(root, native.dir, "rev-parse", rev),
      );
    }
    same(ours.dir, native.dir);
    gitOk(root, native.dir, "stash", "apply", "-q");
    await (await openOurs(ours.dir)).stashApply().call();
    same(ours.dir, native.dir);
  });

  it("diff between the commits and against the worktree shows no mode change for 100664 against 100644", async () => {
    const { native: repo } = twins();
    const g = await openOurs(repo.dir);
    for (const [a, b] of [
      [repo.c0, repo.main],
      [repo.c0, repo.theirs],
      [repo.main, repo.theirs],
    ]) {
      for (const [format, args] of [
        ["patch", ["-p"]],
        ["summary", ["--summary"]],
        ["stat", ["--stat"]],
        ["name-status", ["--name-status"]],
      ] as const) {
        const theirs = execFileSync("git", ["diff", ...args, a, b], {
          cwd: repo.dir,
          env: nativeGitEnv(root),
          encoding: "utf8",
        });
        const ourBytes = await g.diff().setOldTree(a).setNewTree(b).callBytes(format);
        expect(Buffer.from(ourBytes).toString()).toBe(theirs);
      }
    }
    // the worktree and the index against c0
    const theirs = execFileSync("git", ["diff", repo.c0], {
      cwd: repo.dir,
      env: nativeGitEnv(root),
      encoding: "utf8",
    });
    expect(Buffer.from(await g.diff().setOldTree(repo.c0).callBytes("patch")).toString()).toBe(
      theirs,
    );
  });

  it("log -p, --name-status, --stat, --cc, -m print what git prints", async () => {
    const { native: repo } = twins();
    gitOk(root, repo.dir, "merge", "-q", "--no-edit", "theirs");
    const g = await openOurs(repo.dir);
    for (const [args, options] of [
      [["-p"], { patch: true }],
      [["--name-status"], { nameStatus: true }],
      [["--stat"], { stat: true }],
      [["-p", "--cc"], { patch: true, cc: true }],
      [["-p", "-m"], { patch: true, m: true }],
    ] as const) {
      const theirs = execFileSync("git", ["log", ...args, "--all"], {
        cwd: repo.dir,
        env: nativeGitEnv(root),
        encoding: "utf8",
      });
      const ours = Buffer.from(await g.log().all().callBytes(options)).toString();
      expect({ args, ours }).toEqual({ args, ours: theirs });
    }
  });

  it("format-patch --base lists git's prerequisite patch-ids", async () => {
    const { native: repo } = twins();
    put(repo.dir, "h", "next\n");
    gitOk(root, repo.dir, "commit", "-q", "-am", "next");
    const theirs = gitOk(root, repo.dir, "format-patch", "--stdout", "-1", `--base=${repo.c0}`);
    const g = await openOurs(repo.dir);
    const r = await g
      .formatPatch()
      .setStdout(true)
      .setMaxCount(1)
      .setBase(repo.c0)
      .setMessageIdTime(() => 1)
      .call();
    const ids = (text: string) =>
      text.split("\n").filter((l) => /^(base-commit|prerequisite-patch-id):/.test(l));
    expect(ids(Buffer.from(r.output).toString())).toEqual(ids(theirs));
    expect(ids(theirs)).toHaveLength(2);
  });

  it("rebase onto up drops main's commit: the same patch-id, modes canonical", async () => {
    const { native, ours } = twins();
    const expected = git(root, native.dir, "rebase", "up");
    expect(expected.status).toBe(0);
    const command = (await openOurs(ours.dir)).rebase().setCommitter(INTEROP_IDENT);
    await command.setUpstreamBranch("up");
    const result = await command.call();
    // the cache-tree a rebase leaves differs by version (2.43 primes it with onto's tree,
    // 2.5x keeps the one of the checkout), so write-tree is not compared
    same(ours.dir, native.dir, false);
    const skipped = (lines: string[]) => lines.filter((l) => l.startsWith("warning: skipped"));
    expect(skipped(result.output ?? [])).toEqual(skipped(expected.stderr.split("\n")));
    expect(gitOk(root, native.dir, "rev-parse", "HEAD")).toBe(
      gitOk(root, native.dir, "rev-parse", "up"),
    );
  });

  it("fsck reads the modes as stored: 100664 is a bad file mode only under --strict", async () => {
    const { native: repo } = twins();
    const g = await openOurs(repo.dir);
    const files = createNodeFilesApi({ rootDir: repo.dir });
    for (const strict of [false, true]) {
      const theirs = git(
        root,
        repo.dir,
        "fsck",
        ...noReferences,
        "--no-dangling",
        ...(strict ? ["--strict"] : []),
      );
      const ours = await g
        .fsck()
        .setRepositoryFiles({ files })
        .setDangling(false)
        .setStrict(strict)
        .call();
      expect(ours.errorOutput.split("\n").sort()).toEqual(theirs.stderr.split("\n").sort());
      expect(ours.output).toBe(theirs.stdout);
      if (strict) expect(theirs.stderr).toContain("badFilemode");
      else expect(theirs.stderr).toBe("");
    }
  });
});

describeGit("combined diff -U0 hunk headers as git prints them", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "combined-u0-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /**
   * A conflicted merge of `a c y y` (main) and `c y a y` (side) resolved to an empty file:
   * git keeps the -U0 hunk's counts in `unsigned long`, so the result's goes below zero and
   * prints as 2^64 - 1.
   */
  function conflicted(dir: string): void {
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    put(dir, "f", "x\n");
    gitOk(root, dir, "add", "f");
    gitOk(root, dir, "commit", "-q", "-m", "base");
    gitOk(root, dir, "checkout", "-q", "-b", "side");
    put(dir, "f", "c\ny\na\ny\n");
    gitOk(root, dir, "commit", "-q", "-am", "side");
    gitOk(root, dir, "checkout", "-q", "main");
    put(dir, "f", "a\nc\ny\ny\n");
    gitOk(root, dir, "commit", "-q", "-am", "main");
    expect(git(root, dir, "merge", "side").status).toBe(1);
    put(dir, "f", "");
  }

  it("git diff -U0 of a conflict", async () => {
    const dir = join(root, "conflict");
    conflicted(dir);
    const theirs = execFileSync("git", ["diff", "-U0"], {
      cwd: dir,
      env: nativeGitEnv(root),
      encoding: "utf8",
    });
    expect(theirs).toContain("+1,18446744073709551615 @@@");
    const g = await openOurs(dir);
    const ours = await g.diff().setOptions({ context: 0 }).callBytes("patch");
    expect(Buffer.from(ours).toString()).toBe(theirs);
  });

  it("git log -p --cc -U0 of the merge", async () => {
    const dir = join(root, "merged");
    conflicted(dir);
    gitOk(root, dir, "commit", "-q", "-am", "merged");
    const theirs = execFileSync("git", ["log", "-p", "--cc", "-U0", "-1"], {
      cwd: dir,
      env: nativeGitEnv(root),
      encoding: "utf8",
    });
    expect(theirs).toContain("+1,18446744073709551615 @@@");
    const g = await openOurs(dir);
    const ours = await g
      .log()
      .setMaxCount(1)
      .setDiffOptions({ context: 0 })
      .callBytes({ patch: true, cc: true });
    expect(Buffer.from(ours).toString()).toBe(theirs);
  });
});
