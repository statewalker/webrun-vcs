/**
 * The index entry flags (skip-worktree, assume-unchanged) through the commands that rewrite
 * the index, as git's unpack-trees keeps them: an entry a one-way reset (`reset --hard`,
 * `checkout -f`, an autostash's reset) finds unchanged stays as it was, flags included; a
 * changed one keeps its skip-worktree bit ("Migrate old flags over"); a skip-worktree file
 * the tree keeps is not checked out; and an entry whose flags cheat is checked against its
 * file even by a hard reset (`verify_uptodate_1`). Each case builds the same repository
 * twice with native git, runs native git in one twin and ours in the other, and compares
 * them (`ls-files -v` shows the flags: `S` skip-worktree, lowercase assume-unchanged).
 *
 * The same twins check what else rewrites the index as git does: `stash apply --index`
 * applying the stash's index as a patch (`apply --cached`), `--continue` of a single pick or
 * revert (`continue_single_pick`), a switch over an assume-unchanged file
 * (`verify_uptodate_1` by stat), and the cache-tree (`TREE`) through index edits, commits
 * and switches: byte for byte as git writes it, and every valid node describing the index
 * (`verifyCacheTree`).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend } from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { parseCacheTree, parseIndexFile, verifyCacheTree } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CheckoutStatus, ResetMode, SequencerOperation } from "../src/index.js";
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

/**
 * main: c1 holds s1 s2 h1 h2 n k (each "one"), c2 changes s2 h2 n to "two"; branch side (on
 * c1) changes k. The index flags: s1 s2 skip-worktree, h1 h2 assume-unchanged.
 */
function build(dir: string): string {
  gitOk(root, root, "init", "-q", "-b", "main", dir);
  for (const f of ["s1", "s2", "h1", "h2", "n", "k"]) put(dir, f, "one\n");
  put(dir, "d/x", "one\n");
  gitOk(root, dir, "add", ".");
  gitOk(root, dir, "commit", "-q", "-m", "c1");
  gitOk(root, dir, "branch", "side");
  for (const f of ["s2", "h2", "n"]) put(dir, f, "two\n");
  gitOk(root, dir, "commit", "-q", "-a", "-m", "c2");
  gitOk(root, dir, "checkout", "-q", "side");
  put(dir, "k", "side\n");
  gitOk(root, dir, "commit", "-q", "-a", "-m", "side");
  gitOk(root, dir, "checkout", "-q", "main");
  gitOk(root, dir, "update-index", "--skip-worktree", "s1", "s2");
  gitOk(root, dir, "update-index", "--assume-unchanged", "h1", "h2");
  return dir;
}

function twins(): { native: string; ours: string } {
  const n = counter++;
  return { native: build(join(root, `n${n}`)), ours: build(join(root, `o${n}`)) };
}

/** Both alike: flags, index, worktree, HEAD, state files. */
function same(ours: string, native: string) {
  expect(gitOk(root, ours, "ls-files", "-s", "-v")).toBe(
    gitOk(root, native, "ls-files", "-s", "-v"),
  );
  expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
}

describeGit("index flags through index rewrites, as git's unpack-trees keeps them", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "index-flags-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reset --hard keeps the flags of unchanged entries and skip-worktree of changed ones", async () => {
    const { native, ours } = twins();
    for (const dir of [native, ours]) {
      // a skip-worktree file gone from the worktree stays gone; an assume-unchanged dirty
      // file is written again
      unlinkSync(join(dir, "s1"));
      put(dir, "h1", "dirty\n");
    }
    gitOk(root, native, "reset", "-q", "--hard", "HEAD~1");
    const g = await openOurs(ours);
    await g.reset().setRef("HEAD~1").setMode(ResetMode.HARD).call();
    same(ours, native);
    expect(gitOk(root, ours, "ls-files", "-v")).toContain("S s1");
  });

  it("reset --mixed keeps unchanged entries and the skip-worktree bit of changed ones", async () => {
    const { native, ours } = twins();
    gitOk(root, native, "reset", "-q", "HEAD~1");
    const g = await openOurs(ours);
    await g.reset().setRef("HEAD~1").setMode(ResetMode.MIXED).call();
    same(ours, native);
  });

  it("reset --hard refuses a flagged entry it changes over a changed file", async () => {
    for (const [file, flag] of [
      ["h2", "--assume-unchanged"],
      ["s2", "--skip-worktree"],
    ]) {
      const { native, ours } = twins();
      for (const dir of [native, ours]) {
        gitOk(root, dir, "update-index", flag, file);
        put(dir, file, "dirty\n");
      }
      const r = git(root, native, "reset", "--hard", "HEAD~1");
      expect(r.status).toBe(128);
      const g = await openOurs(ours);
      await expect(g.reset().setRef("HEAD~1").setMode(ResetMode.HARD).call()).rejects.toThrow(
        r.stderr.trim(),
      );
      same(ours, native);
    }
  });

  it("checkout -f keeps the flags as a one-way reset does", async () => {
    const { native, ours } = twins();
    for (const dir of [native, ours]) {
      unlinkSync(join(dir, "s1"));
      put(dir, "n", "dirty\n");
    }
    gitOk(root, native, "checkout", "-q", "-f", "side");
    const g = await openOurs(ours);
    await g.checkout().setName("side").setForced(true).call();
    same(ours, native);
  });

  it("a branch switch keeps the flags of entries it leaves and skip-worktree of switched ones", async () => {
    const { native, ours } = twins();
    gitOk(root, native, "checkout", "-q", "side");
    const g = await openOurs(ours);
    await g.checkout().setName("side").call();
    same(ours, native);
  });

  it("merge --autostash keeps the flags through the autostash's reset", async () => {
    const { native, ours } = twins();
    for (const dir of [native, ours]) {
      put(dir, "n", "local\n");
      unlinkSync(join(dir, "s1"));
    }
    gitOk(root, native, "merge", "-q", "--autostash", "--no-edit", "side");
    const g = await openOurs(ours);
    await g
      .merge()
      .include("side")
      .setAutoStash(true)
      .setAuthor(INTEROP_IDENT)
      .setCommitter(INTEROP_IDENT)
      .call();
    same(ours, native);
  });
  it("stash apply (with and without --index) keeps the flags of entries it leaves", async () => {
    for (const index of [false, true]) {
      const { native, ours } = twins();
      for (const dir of [native, ours]) {
        put(dir, "n", "stashed\n");
        put(dir, "d/x", "staged\n");
        gitOk(root, dir, "add", "d/x");
        gitOk(root, dir, "stash", "-q");
        gitOk(root, dir, "update-index", "--skip-worktree", "k");
      }
      gitOk(root, native, "stash", "apply", "-q", ...(index ? ["--index"] : []));
      const g = await openOurs(ours);
      await g.stashApply().setRestoreIndex(index).call();
      same(ours, native);
    }
  });

  it("cherry-pick keeps the flags of entries it leaves, skip-worktree of the ones it changes", async () => {
    const { native, ours } = twins();
    for (const dir of [native, ours]) gitOk(root, dir, "update-index", "--skip-worktree", "k");
    gitOk(root, native, "cherry-pick", "side");
    const g = await openOurs(ours);
    await g.cherryPick().include("side").setCommitter(INTEROP_IDENT).call();
    same(ours, native);
  });
});

describeGit(
  "stash apply --index applies the stash's index as a patch, as git's apply --cached",
  () => {
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "stash-index-patch-"));
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    /** a staged edit of a's last line stashed on main; side changes a's second line (its context) */
    function buildPatch(dir: string): string {
      gitOk(root, root, "init", "-q", "-b", "main", dir);
      put(dir, "a", "1\n2\n3\n4\n5\n");
      put(dir, "b", "b\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-q", "-m", "c0");
      gitOk(root, dir, "checkout", "-q", "-b", "side");
      put(dir, "a", "1\n2x\n3\n4\n5\n");
      gitOk(root, dir, "commit", "-q", "-a", "-m", "side");
      gitOk(root, dir, "checkout", "-q", "main");
      put(dir, "a", "1\n2\n3\n4\n5y\n");
      gitOk(root, dir, "add", "a");
      put(dir, "b", "b worktree\n");
      gitOk(root, dir, "stash", "-q");
      gitOk(root, dir, "cherry-pick", "side");
      return dir;
    }

    it("refuses with 'conflicts in index' where the hunk's context changed, a merge would not", async () => {
      const native = buildPatch(join(root, "n"));
      const ours = buildPatch(join(root, "o"));
      const r = git(root, native, "stash", "apply", "--index");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("error: conflicts in index. Try without --index.");
      const g = await openOurs(ours);
      await expect(g.stashApply().setRestoreIndex(true).call()).rejects.toThrow(r.stderr.trim());
      expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
    });

    it("applies where the hunk's context is intact", async () => {
      const native = buildPatch(join(root, "n2"));
      const ours = buildPatch(join(root, "o2"));
      for (const dir of [native, ours]) gitOk(root, dir, "reset", "-q", "--hard", "HEAD~1");
      gitOk(root, native, "stash", "apply", "-q", "--index");
      const g = await openOurs(ours);
      await g.stashApply().setRestoreIndex(true).call();
      expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
    });
  },
);

describeGit("--continue of a single pick stopped by -n, as git's continue_single_pick", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "single-pick-continue-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** a: 1 (c0), 2 (c1), 3 (c2); then `<op> -n <c1 or side>` conflicts and a is resolved, staged */
  function buildPick(dir: string, op: "revert" | "cherry-pick"): void {
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    put(dir, "a", "1\n");
    gitOk(root, dir, "add", "a");
    gitOk(root, dir, "commit", "-q", "-m", "c0");
    gitOk(root, dir, "branch", "side");
    put(dir, "a", "2\n");
    gitOk(root, dir, "commit", "-q", "-a", "-m", "c1");
    put(dir, "a", "3\n");
    gitOk(root, dir, "commit", "-q", "-a", "-m", "c2");
    gitOk(root, dir, "checkout", "-q", "side");
    put(dir, "a", "side\n");
    gitOk(root, dir, "commit", "-q", "-a", "-m", "side");
    gitOk(root, dir, "checkout", "-q", "main");
    const r = git(root, dir, op, "-n", op === "revert" ? "HEAD~1" : "side");
    expect(r.status).toBe(1);
    put(dir, "a", "resolved\n");
    gitOk(root, dir, "add", "a");
  }

  for (const op of ["revert", "cherry-pick"] as const) {
    it(`${op} --continue commits with the prepared message`, async () => {
      const native = join(root, `${op}-n`);
      const ours = join(root, `${op}-o`);
      buildPick(native, op);
      buildPick(ours, op);
      const r = git(root, native, op, "--continue");
      const g = await openOurs(ours, INTEROP_AUTHOR_ENV);
      const command =
        op === "revert"
          ? g.revert().setOperation(SequencerOperation.CONTINUE)
          : g.cherryPick().setOperation(SequencerOperation.CONTINUE);
      const result = await command.setCommitter(INTEROP_IDENT).call();
      expect({ ok: result.status !== "failed" }).toEqual({ ok: r.status === 0 });
      expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
      expect(gitOk(root, ours, "log", "--format=%H %an %B", "-3")).toBe(
        gitOk(root, native, "log", "--format=%H %an %B", "-3"),
      );
    });
  }

  it("a clean revert -n leaves REVERT_HEAD, and --continue commits it with what was staged", async () => {
    const build = (dir: string) => {
      gitOk(root, root, "init", "-q", "-b", "main", dir);
      put(dir, "a", "1\n");
      put(dir, "b", "1\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-q", "-m", "c0");
      put(dir, "a", "2\n");
      gitOk(root, dir, "commit", "-q", "-a", "-m", "c1");
      put(dir, "b", "2\n");
      gitOk(root, dir, "commit", "-q", "-a", "-m", "c2");
    };
    const native = join(root, "clean-n");
    const ours = join(root, "clean-o");
    build(native);
    build(ours);
    gitOk(root, native, "revert", "-n", "HEAD~1");
    const g = await openOurs(ours, INTEROP_AUTHOR_ENV);
    await g.revert().include("HEAD~1").setNoCommit(true).setCommitter(INTEROP_IDENT).call();
    expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
    for (const dir of [native, ours]) {
      put(dir, "c", "staged\n");
      gitOk(root, dir, "add", "c");
    }
    gitOk(root, native, "revert", "--continue");
    const g2 = await openOurs(ours, INTEROP_AUTHOR_ENV);
    const result = await g2
      .revert()
      .setOperation(SequencerOperation.CONTINUE)
      .setCommitter(INTEROP_IDENT)
      .call();
    expect(result.status).not.toBe("failed");
    expect(snapshot(root, ours, normalizeState)).toEqual(snapshot(root, native, normalizeState));
  });
});

describeGit("a switch over an assume-unchanged file, as git's verify_uptodate checks it", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "assume-unchanged-switch-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** f: one (c1, branch b), two (c2, main); b checked out, f assume-unchanged */
  function buildSwitch(dir: string): void {
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    put(dir, "f", "one\n");
    put(dir, "g", "g\n");
    gitOk(root, dir, "add", ".");
    gitOk(root, dir, "commit", "-q", "-m", "c1");
    gitOk(root, dir, "branch", "b");
    put(dir, "f", "two\n");
    gitOk(root, dir, "commit", "-q", "-a", "-m", "c2");
    gitOk(root, dir, "checkout", "-q", "b");
    gitOk(root, dir, "update-index", "--assume-unchanged", "f");
  }

  const cases: [string, (dir: string) => void][] = [
    ["unchanged", () => {}],
    ["dirty", (dir) => put(dir, "f", "dirty\n")],
    // the same content, another mtime: the entry's stat no longer matches (git refuses: the
    // flag cheats, so the stat is checked and the content not compared)
    ["touched", (dir) => utimesSync(join(dir, "f"), 978307200, 978307200)],
  ];
  for (const [name, change] of cases) {
    it(`a ${name} file`, async () => {
      const native = join(root, `${name}-n`);
      const ours = join(root, `${name}-o`);
      buildSwitch(native);
      buildSwitch(ours);
      change(native);
      change(ours);
      const r = git(root, native, "checkout", "-q", "main");
      const g = await openOurs(ours);
      const result = await g.checkout().setName("main").call();
      expect({
        ok: result.status !== CheckoutStatus.CONFLICTS,
        message: result.message ?? "",
      }).toEqual({
        ok: r.status === 0,
        message: r.status === 0 ? (result.message ?? "") : r.stderr.trim(),
      });
      same(ours, native);
    });
  }
});

/** The `TREE` extension of the index in `dir`, as hex (empty: none). */
async function treeExtension(dir: string): Promise<string> {
  const parsed = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
  const ext = parsed.extensionData.find((e) => e.signature === "TREE");
  return ext ? Buffer.from(ext.data).toString("hex") : "";
}

/**
 * The debug check of the cache-tree in `dir`'s index: every valid node describes the
 * index's entries below it (none: it does).
 */
async function cacheTreeProblems(dir: string): Promise<string[]> {
  const parsed = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
  const ext = parsed.extensionData.find((e) => e.signature === "TREE");
  if (!ext) return [];
  const { history } = await createGitFilesBackend({ files: createNodeFilesApi({ rootDir: dir }) });
  return verifyCacheTree(history.trees, parseCacheTree(ext.data), parsed.entries);
}

describeGit(
  "the cache-tree through index edits: untouched directories stay valid, as git's",
  () => {
    beforeAll(() => {
      root = mkdtempSync(join(tmpdir(), "cache-tree-edits-"));
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    /** Native git reading `input` on stdin. */
    const gitIn = (dir: string, input: string, ...args: string[]) =>
      execFileSync("git", args, {
        cwd: dir,
        env: nativeGitEnv(root),
        input,
        encoding: "utf8",
      }).trim();

    /**
     * f (100644) and the directories old/ (x stored 100664) and keep/ (y), committed with
     * mktree; main checked out with reset --hard (the cache-tree primed with the stored trees).
     */
    function buildModes(dir: string): void {
      gitOk(root, root, "init", "-q", "-b", "main", dir);
      const blob = (text: string) => gitIn(dir, text, "hash-object", "-w", "--stdin");
      const old = gitIn(dir, `100664 blob ${blob("x\n")}\tx\n`, "mktree");
      const keep = gitIn(dir, `100644 blob ${blob("y\n")}\ty\n`, "mktree");
      const top = gitIn(
        dir,
        `100644 blob ${blob("f\n")}\tf\n040000 tree ${keep}\tkeep\n040000 tree ${old}\told\n`,
        "mktree",
      );
      gitOk(root, dir, "update-ref", "refs/heads/main", gitIn(dir, "c0\n", "commit-tree", top));
      gitOk(root, dir, "reset", "-q", "--hard", "main");
    }

    it("add then commit keep the stored 100664 subtree: the commit ids are git's", async () => {
      const native = join(root, "n");
      const ours = join(root, "o");
      buildModes(native);
      buildModes(ours);
      for (const dir of [native, ours]) {
        put(dir, "f", "changed\n");
        put(dir, "keep/z", "new\n");
      }
      gitOk(root, native, "add", "f", "keep/z");
      const g = await openOurs(ours);
      await g.add().addFilepattern("f").addFilepattern("keep/z").call();
      // git's add invalidates the paths it touched: old/ stays valid, with its stored tree
      expect(await treeExtension(ours)).toBe(await treeExtension(native));
      expect(await cacheTreeProblems(ours)).toEqual([]);
      expect(gitOk(root, ours, "write-tree")).toBe(gitOk(root, native, "write-tree"));

      gitOk(root, native, "commit", "-q", "-m", "c1");
      await g
        .commit()
        .setMessage("c1")
        .setAuthorIdent(INTEROP_IDENT)
        .setCommitterIdent(INTEROP_IDENT)
        .call();
      expect(gitOk(root, ours, "rev-parse", "HEAD")).toBe(gitOk(root, native, "rev-parse", "HEAD"));
      expect(gitOk(root, ours, "cat-file", "tree", "HEAD:old")).toContain("100664 x");
      // the commit writes the index with a fully valid cache-tree, as git's prepare_index
      expect(await treeExtension(ours)).toBe(await treeExtension(native));
      expect(await cacheTreeProblems(ours)).toEqual([]);
    });

    it("rm and a mixed reset of one path invalidate only that path", async () => {
      const native = join(root, "n2");
      const ours = join(root, "o2");
      buildModes(native);
      buildModes(ours);
      gitOk(root, native, "rm", "-q", "--cached", "keep/y");
      const g = await openOurs(ours);
      await g.rm().addFilepattern("keep/y").setCached(true).call();
      expect(await treeExtension(ours)).toBe(await treeExtension(native));
      expect(await cacheTreeProblems(ours)).toEqual([]);
      gitOk(root, native, "reset", "-q", "--", "keep/y");
      const g2 = await openOurs(ours);
      await g2.reset().addPath("keep/y").call();
      expect(await treeExtension(ours)).toBe(await treeExtension(native));
      expect(await cacheTreeProblems(ours)).toEqual([]);
      expect(gitOk(root, ours, "write-tree")).toBe(gitOk(root, native, "write-tree"));
    });

    /** a and d/x, e/y on main (stored trees); side changes d/x; f added on top */
    function buildBranches(dir: string): void {
      buildModes(dir);
      gitOk(root, dir, "checkout", "-q", "-b", "side");
      put(dir, "keep/y", "side\n");
      gitOk(root, dir, "commit", "-q", "-a", "-m", "side");
      gitOk(root, dir, "checkout", "-q", "main");
      put(dir, "f", "main\n");
      gitOk(root, dir, "commit", "-q", "-a", "-m", "main");
    }

    const commands: [
      string,
      string[],
      (g: Awaited<ReturnType<typeof openOurs>>) => Promise<unknown>,
    ][] = [
      ["checkout", ["checkout", "-q", "side"], (g) => g.checkout().setName("side").call()],
      [
        "checkout -f",
        ["checkout", "-q", "-f", "side"],
        (g) => g.checkout().setName("side").setForced(true).call(),
      ],
      [
        "reset --hard",
        ["reset", "-q", "--hard", "side"],
        (g) => g.reset().setRef("side").setMode(ResetMode.HARD).call(),
      ],
      ["reset --mixed", ["reset", "-q", "side"], (g) => g.reset().setRef("side").call()],
      [
        "reset --merge",
        ["reset", "-q", "--merge", "side"],
        (g) => g.reset().setRef("side").setMode(ResetMode.MERGE).call(),
      ],
      [
        "reset --keep",
        ["reset", "-q", "--keep", "side"],
        (g) => g.reset().setRef("side").setMode(ResetMode.KEEP).call(),
      ],
      [
        "merge",
        ["merge", "-q", "--no-edit", "side"],
        (g) =>
          g.merge().include("side").setAuthor(INTEROP_IDENT).setCommitter(INTEROP_IDENT).call(),
      ],
      [
        "cherry-pick",
        ["cherry-pick", "side"],
        (g) => g.cherryPick().include("side").setCommitter(INTEROP_IDENT).call(),
      ],
    ];
    for (const [name, args, ours] of commands) {
      it(`${name} leaves the cache-tree git leaves`, async () => {
        const n = join(root, `${name.replace(/\W/g, "")}-n`);
        const o = join(root, `${name.replace(/\W/g, "")}-o`);
        buildBranches(n);
        buildBranches(o);
        gitOk(root, n, ...args);
        await ours(await openOurs(o));
        expect(gitOk(root, o, "rev-parse", "HEAD")).toBe(gitOk(root, n, "rev-parse", "HEAD"));
        expect(await treeExtension(o)).toBe(await treeExtension(n));
        expect(await cacheTreeProblems(o)).toEqual([]);
        expect(gitOk(root, o, "write-tree")).toBe(gitOk(root, n, "write-tree"));
      });
    }
  },
);
