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
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync } from "node:fs";
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
      // native write-tree above rewrote the index: a fresh instance commits it
      await (await openOurs(ours))
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
      // `git add <file>`, not `commit -a`: a racy re-add of every entry would invalidate the
      // cache-tree of old/ (its 100664 tree) or not, by the clock
      gitOk(root, dir, "add", "keep/y");
      gitOk(root, dir, "commit", "-q", "-m", "side");
      gitOk(root, dir, "checkout", "-q", "main");
      put(dir, "f", "main\n");
      gitOk(root, dir, "add", "f");
      gitOk(root, dir, "commit", "-q", "-m", "main");
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

describeGit("intent-to-add, rm, a stale index and rebase over flagged entries, as git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "index-flags-more-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** a, d/x, d/y committed on main */
  function buildPlain(dir: string): void {
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    put(dir, "a", "a\n");
    put(dir, "d/x", "x\n");
    put(dir, "d/y", "y\n");
    gitOk(root, dir, "add", ".");
    gitOk(root, dir, "commit", "-q", "-m", "c0");
  }

  it("an intent-to-add entry with skip-worktree is no part of the tree (update_one)", async () => {
    const native = join(root, "ita-n");
    const ours = join(root, "ita-o");
    for (const dir of [native, ours]) {
      buildPlain(dir);
      put(dir, "d/new", "new\n");
      gitOk(root, dir, "add", "-N", "d/new");
      gitOk(root, dir, "update-index", "--skip-worktree", "d/new");
      put(dir, "a", "changed\n");
      gitOk(root, dir, "add", "a");
    }
    gitOk(root, native, "commit", "-q", "-m", "c1");
    const g = await openOurs(ours);
    await g
      .commit()
      .setMessage("c1")
      .setAuthorIdent(INTEROP_IDENT)
      .setCommitterIdent(INTEROP_IDENT)
      .call();
    expect(gitOk(root, native, "ls-tree", "-r", "--name-only", "HEAD").trim()).toBe("a\nd/x\nd/y");
    expect(gitOk(root, ours, "rev-parse", "HEAD")).toBe(gitOk(root, native, "rev-parse", "HEAD"));
    // the directory above the intent-to-add entry stays invalid, as git leaves it
    expect(await treeExtension(ours)).toBe(await treeExtension(native));
    expect(await cacheTreeProblems(ours)).toEqual([]);
    expect(gitOk(root, ours, "ls-files", "-s", "-v")).toBe(
      gitOk(root, native, "ls-files", "-s", "-v"),
    );
  });

  it("rm leaves the other entries as they are: flags and stat data", async () => {
    const native = join(root, "rm-n");
    const ours = join(root, "rm-o");
    for (const dir of [native, ours]) {
      buildPlain(dir);
      put(dir, "b", "b\n");
      put(dir, "c", "c\n");
      gitOk(root, dir, "add", "b", "c");
      gitOk(root, dir, "commit", "-q", "-m", "c1");
      put(dir, "n", "intent\n");
      gitOk(root, dir, "add", "-N", "n");
      gitOk(root, dir, "update-index", "--skip-worktree", "b");
      gitOk(root, dir, "update-index", "--assume-unchanged", "c");
    }
    const statOf = async (dir: string) => {
      const parsed = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
      return parsed.entries
        .filter((e) => e.path !== "d/x")
        .map((e) => `${e.path} ${e.mtime} ${e.mtimeNs ?? 0} ${e.size} ${e.ino ?? 0}`);
    };
    const before = await statOf(ours);
    gitOk(root, native, "rm", "-q", "--cached", "d/x");
    const g = await openOurs(ours);
    await g.rm().addFilepattern("d/x").setCached(true).call();
    expect(gitOk(root, ours, "ls-files", "-s", "-v")).toBe(
      gitOk(root, native, "ls-files", "-s", "-v"),
    );
    expect(await statOf(ours)).toEqual(before);
    expect(gitOk(root, ours, "diff-files", "--name-status")).toBe(
      gitOk(root, native, "diff-files", "--name-status"),
    );
    expect(gitOk(root, ours, "write-tree")).toBe(gitOk(root, native, "write-tree"));
    expect(await cacheTreeProblems(ours)).toEqual([]);
  });

  it("commit reads again an index another writer replaced since it was read", async () => {
    // git reads the index at the start of every command: the entries staged by the other
    // writer are committed, not the stale ones this instance read
    const dir = join(root, "stale");
    buildPlain(dir);
    const g = await openOurs(dir);
    put(dir, "a", "native\n");
    gitOk(root, dir, "add", "a");
    await g
      .commit()
      .setMessage("stale")
      .setAuthorIdent(INTEROP_IDENT)
      .setCommitterIdent(INTEROP_IDENT)
      .call();
    expect(gitOk(root, dir, "show", "HEAD:a")).toBe("native\n");
    expect(gitOk(root, dir, "diff", "--cached", "--name-only").trim()).toBe("");
  });

  it("commit refuses an index another writer replaced while it holds unwritten edits", async () => {
    const dir = join(root, "stale-edits");
    buildPlain(dir);
    const g = await openOurs(dir);
    // an edit of this instance not written yet, which a re-read would lose
    const staging = g.workingCopy.checkout.staging;
    const entry = await staging.getEntry("d/x");
    if (!entry) throw new Error("d/x not in the index");
    await staging.setEntry({ ...entry, mtime: entry.mtime + 1000 });
    put(dir, "a", "native\n");
    gitOk(root, dir, "add", "a");
    const head = gitOk(root, dir, "rev-parse", "HEAD");
    await expect(
      g
        .commit()
        .setMessage("stale")
        .setAuthorIdent(INTEROP_IDENT)
        .setCommitterIdent(INTEROP_IDENT)
        .call(),
    ).rejects.toThrow(/index changed on disk/);
    expect(gitOk(root, dir, "rev-parse", "HEAD")).toBe(head);
    expect(gitOk(root, dir, "diff", "--cached", "--name-only").trim()).toBe("a");
  });

  it("rebase goes on over a dirty assume-unchanged file (require_clean_work_tree)", async () => {
    const build = (dir: string) => {
      buildPlain(dir);
      gitOk(root, dir, "checkout", "-q", "-b", "side");
      put(dir, "d/x", "side\n");
      gitOk(root, dir, "add", "d/x");
      gitOk(root, dir, "commit", "-q", "-m", "side");
      gitOk(root, dir, "checkout", "-q", "main");
      put(dir, "d/y", "main\n");
      gitOk(root, dir, "add", "d/y");
      gitOk(root, dir, "commit", "-q", "-m", "main");
      gitOk(root, dir, "update-index", "--assume-unchanged", "a");
      put(dir, "a", "dirty\n");
    };
    const native = join(root, "rebase-n");
    const ours = join(root, "rebase-o");
    build(native);
    build(ours);
    const r = git(root, native, "rebase", "-q", "side");
    expect(r.status).toBe(0);
    const g = await openOurs(ours, INTEROP_AUTHOR_ENV);
    const command = g.rebase().setCommitter(INTEROP_IDENT);
    await command.setUpstreamBranch("side");
    const result = await command.call();
    expect(result.status).not.toBe("uncommitted-changes");
    expect(gitOk(root, ours, "rev-parse", "HEAD")).toBe(gitOk(root, native, "rev-parse", "HEAD"));
    expect(readFileSync(join(ours, "a"), "utf8")).toBe(readFileSync(join(native, "a"), "utf8"));
    expect(gitOk(root, ours, "ls-files", "-s", "-v")).toBe(
      gitOk(root, native, "ls-files", "-s", "-v"),
    );
  });
});

describeGit("add -N, commit --only, kept stat data and a stale instance, as git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "index-flags-follow-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  let k = 0;
  /** a, d/x, d/y committed on main; with `side`, a branch changing d/x and main changing a */
  function buildPlain(dir: string, side = false): void {
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    put(dir, "a", "a\n");
    put(dir, "d/x", "x\n");
    put(dir, "d/y", "y\n");
    gitOk(root, dir, "add", ".");
    gitOk(root, dir, "commit", "-q", "-m", "c0");
    if (!side) return;
    gitOk(root, dir, "checkout", "-q", "-b", "side");
    put(dir, "d/x", "side\n");
    gitOk(root, dir, "add", "d/x");
    gitOk(root, dir, "commit", "-q", "-m", "side");
    gitOk(root, dir, "checkout", "-q", "main");
    put(dir, "a", "main\n");
    gitOk(root, dir, "add", "a");
    gitOk(root, dir, "commit", "-q", "-m", "main");
  }

  function pair(prepare: (dir: string) => void, side = false): { native: string; ours: string } {
    const n = k++;
    const native = join(root, `n${n}`);
    const ours = join(root, `o${n}`);
    for (const dir of [native, ours]) {
      buildPlain(dir, side);
      prepare(dir);
    }
    return { native, ours };
  }

  const lsFiles = (dir: string) => gitOk(root, dir, "ls-files", "-s", "-v");
  const commitOurs = (g: Awaited<ReturnType<typeof openOurs>>, message: string) =>
    g.commit().setMessage(message).setAuthorIdent(INTEROP_IDENT).setCommitterIdent(INTEROP_IDENT);

  /** The stat data of every entry but those given, as the index file holds it. */
  const statOf = async (dir: string, skip: (path: string) => boolean) => {
    const parsed = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
    return parsed.entries
      .filter((e) => !skip(e.path))
      .map(
        (e) =>
          `${e.path} ${e.mtime} ${e.mtimeNs ?? 0} ${e.ctime ?? 0} ${e.ctimeNs ?? 0} ${e.size} ${e.ino ?? 0}`,
      );
  };

  it("add -N leaves a tracked or intent-to-add path alone (ADD_CACHE_NEW_ONLY)", async () => {
    const { native, ours } = pair((dir) => {
      put(dir, "n", "new\n");
      gitOk(root, dir, "add", "-N", "n");
      put(dir, "a", "changed\n");
    });
    for (const args of [["a"], ["n"], ["d"]]) gitOk(root, native, "add", "-N", ...args);
    const afterIntent = lsFiles(native);
    put(native, "d/x", "x2\n");
    gitOk(root, native, "add", "d/x");
    gitOk(root, native, "commit", "-q", "-m", "c1");
    const g = await openOurs(ours);
    for (const path of ["a", "n", "d"]) {
      await g.add().addFilepattern(path).setIntentToAdd(true).call();
    }
    expect(lsFiles(ours)).toBe(afterIntent);
    put(ours, "d/x", "x2\n");
    await g.add().addFilepattern("d/x").call();
    await commitOurs(g, "c1").call();
    // a stays in the commit (it was never turned into an intent-to-add entry)
    expect(gitOk(root, ours, "ls-tree", "-r", "--name-only", "HEAD").trim()).toBe("a\nd/x\nd/y");
    expect(gitOk(root, ours, "rev-parse", "HEAD")).toBe(gitOk(root, native, "rev-parse", "HEAD"));
    expect(lsFiles(ours)).toBe(lsFiles(native));
    expect(gitOk(root, ours, "status", "--porcelain")).toBe(
      gitOk(root, native, "status", "--porcelain"),
    );
  });

  it("add -N of a conflicted path replaces its stages, as git's add_index_entry", async () => {
    const { native, ours } = pair((dir) => {
      const id = gitOk(root, dir, "rev-parse", "HEAD:d/y").trim();
      gitOk(root, dir, "update-index", "--force-remove", "a");
      execFileSync("git", ["update-index", "--index-info"], {
        cwd: dir,
        env: nativeGitEnv(root),
        input: [1, 2, 3].map((s) => `100644 ${id} ${s}\ta\n`).join(""),
      });
    });
    gitOk(root, native, "add", "-N", "a");
    const g = await openOurs(ours);
    await g.add().addFilepattern("a").setIntentToAdd(true).call();
    expect(lsFiles(ours)).toBe(lsFiles(native));
    expect(gitOk(root, ours, "ls-files", "--resolve-undo")).toBe(
      gitOk(root, native, "ls-files", "--resolve-undo"),
    );
  });

  /** commit --only twins: native `git commit --only` against ours, compared whole. */
  async function onlyTwins(
    prepare: (dir: string) => void,
    paths: string[],
  ): Promise<{ native: string; ours: string }> {
    const { native, ours } = pair(prepare);
    gitOk(root, native, "commit", "-q", "-m", "only", "--only", "--", ...paths);
    const g = await openOurs(ours);
    await commitOurs(g, "only")
      .setOnly(...paths)
      .call();
    expect(gitOk(root, ours, "rev-parse", "HEAD")).toBe(gitOk(root, native, "rev-parse", "HEAD"));
    expect(lsFiles(ours)).toBe(lsFiles(native));
    expect(gitOk(root, ours, "status", "--porcelain")).toBe(
      gitOk(root, native, "status", "--porcelain"),
    );
    // nothing looks changed by its stat that git does not see so
    expect(gitOk(root, ours, "diff-files", "--name-status")).toBe(
      gitOk(root, native, "diff-files", "--name-status"),
    );
    expect(await cacheTreeProblems(ours)).toEqual([]);
    expect(await treeExtension(ours)).toBe(await treeExtension(native));
    return { native, ours };
  }

  it("commit --only takes the worktree content of the paths, into the index too", async () => {
    const { ours } = await onlyTwins(
      (dir) => {
        put(dir, "a", "staged\n");
        gitOk(root, dir, "add", "a");
        put(dir, "a", "worktree\n");
        put(dir, "d/x", "other staged\n");
        gitOk(root, dir, "add", "d/x");
      },
      ["a"],
    );
    expect(gitOk(root, ours, "show", "HEAD:a")).toBe("worktree\n");
    expect(gitOk(root, ours, "diff", "--cached", "--name-only").trim()).toBe("d/x");
  });

  it("commit --only of an intent-to-add path commits the file", async () => {
    const { ours } = await onlyTwins(
      (dir) => {
        put(dir, "n", "new\n");
        gitOk(root, dir, "add", "-N", "n");
        put(dir, "d/y", "staged\n");
        gitOk(root, dir, "add", "d/y");
      },
      ["n"],
    );
    expect(gitOk(root, ours, "show", "HEAD:n")).toBe("new\n");
  });

  it("commit --only of a deleted file and a directory removes and takes them", async () => {
    await onlyTwins(
      (dir) => {
        unlinkSync(join(dir, "d/y"));
        put(dir, "d/x", "x2\n");
        put(dir, "a", "staged\n");
        gitOk(root, dir, "add", "a");
      },
      ["d"],
    );
  });

  it("commit --only keeps the stat data of the other entries", async () => {
    const { native, ours } = pair((dir) => {
      put(dir, "a", "changed\n");
      gitOk(root, dir, "add", "a");
    });
    const before = await statOf(ours, (p) => p === "a");
    gitOk(root, native, "commit", "-q", "-m", "only", "--only", "a");
    const g = await openOurs(ours);
    await commitOurs(g, "only").setOnly("a").call();
    expect(await statOf(ours, (p) => p === "a")).toEqual(before);
    // a later write keeps them too
    put(ours, "d/x", "x2\n");
    await g.add().addFilepattern("d/x").call();
    expect(await statOf(ours, (p) => p === "a" || p === "d/x")).toEqual(
      before.filter((line) => !line.startsWith("d/x ")),
    );
    expect(gitOk(root, ours, "rev-parse", "HEAD^{tree}")).toBe(
      gitOk(root, native, "rev-parse", "HEAD^{tree}"),
    );
  });

  it("commit --only refuses a path neither the index nor HEAD knows", async () => {
    const { native, ours } = pair((dir) => {
      put(dir, "u", "untracked\n");
      put(dir, "a", "changed\n");
    });
    const r = git(root, native, "commit", "-q", "-m", "only", "--only", "--", "u", "a");
    expect(r.status).toBe(1);
    const head = gitOk(root, ours, "rev-parse", "HEAD");
    const index = readFileSync(join(ours, ".git/index"));
    const g = await openOurs(ours);
    await expect(commitOurs(g, "only").setOnly("u", "a").call()).rejects.toThrow(r.stderr.trim());
    expect(gitOk(root, ours, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(ours, ".git/index")).equals(index)).toBe(true);
  });

  /** A refused commit --only: git's message, and HEAD, the index and its lock as they were. */
  async function onlyRefused(
    prepare: (dir: string) => void,
    paths: string[],
    status: number,
  ): Promise<{ native: string; ours: string }> {
    const { native, ours } = pair(prepare);
    const r = git(root, native, "commit", "-q", "-m", "only", "--only", "--", ...paths);
    expect(r.status).toBe(status);
    const head = gitOk(root, ours, "rev-parse", "HEAD");
    const index = readFileSync(join(ours, ".git/index"));
    const g = await openOurs(ours);
    const refusal = await commitOurs(g, "only")
      .setOnly(...paths)
      .call()
      .then(
        () => "",
        (error: Error) => error.message,
      );
    // each line git printed (2.5x adds "unable to index file" to 2.43's lines)
    for (const line of r.stderr.trim().split("\n")) expect(refusal).toContain(line);
    expect(gitOk(root, ours, "rev-parse", "HEAD")).toBe(head);
    expect(readFileSync(join(ours, ".git/index")).equals(index)).toBe(true);
    expect(existsSync(join(ours, ".git/index.lock"))).toBe(false);
    expect(lsFiles(ours)).toBe(lsFiles(native));
    return { native, ours };
  }

  it("commit --only of a path that is now a directory refuses, as add_to_index", async () => {
    // the index still has the file a, the worktree a directory: git's add_remove_files
    // refuses before anything changes (no tree with two entries named a)
    const toDir = (dir: string) => {
      unlinkSync(join(dir, "a"));
      put(dir, "a/inner", "inner\n");
    };
    await onlyRefused(toDir, ["a"], 128);
    await onlyRefused(toDir, ["a", "d/x"], 128);
    // a/inner is known to neither the index nor HEAD
    await onlyRefused(toDir, ["a/inner"], 1);
    // HEAD's a is listed through `.`
    await onlyRefused(
      (dir) => {
        toDir(dir);
        gitOk(root, dir, "add", "a/inner");
      },
      ["."],
      128,
    );
  });

  it("commit --only of a staged file that replaced a directory's file commits it", async () => {
    const { ours } = await onlyTwins(
      (dir) => {
        unlinkSync(join(dir, "a"));
        put(dir, "a/inner", "inner\n");
        gitOk(root, dir, "add", "a/inner");
      },
      ["a/inner"],
    );
    expect(gitOk(root, ours, "ls-tree", "-r", "--name-only", "HEAD")).toBe("a/inner\nd/x\nd/y\n");
    expect(git(root, ours, "fsck", "--no-dangling").status).toBe(0);
  });

  it("add replaces the entries a file or directory clashes with (check_file_directory_conflict)", async () => {
    const { native, ours } = pair((dir) => {
      unlinkSync(join(dir, "a"));
      put(dir, "a/inner", "inner\n");
      rmSync(join(dir, "d"), { recursive: true });
      put(dir, "d", "now a file\n");
    });
    // without removals: only the entries the new ones clash with go
    gitOk(root, native, "add", "--ignore-removal", "a/inner", "d");
    const g = await openOurs(ours);
    await g.add().addFilepattern("a/inner").addFilepattern("d").setAll(false).call();
    expect(lsFiles(ours)).toBe(lsFiles(native));
    gitOk(root, native, "commit", "-q", "-m", "df");
    await commitOurs(g, "df").call();
    expect(gitOk(root, ours, "rev-parse", "HEAD")).toBe(gitOk(root, native, "rev-parse", "HEAD"));
    expect(git(root, ours, "fsck", "--no-dangling").status).toBe(0);
  });

  it("commit --only takes only the paths listed: glob characters match no untracked file", async () => {
    const { ours } = await onlyTwins(
      (dir) => {
        put(dir, "x*y", "tracked\n");
        gitOk(root, dir, "add", "x*y");
        gitOk(root, dir, "commit", "-q", "-m", "glob name");
        put(dir, "x*y", "changed\n");
        put(dir, "xzy", "untracked\n");
        put(dir, ".gitignore", "x.y\n");
        put(dir, "x.y", "ignored\n");
      },
      ["x*y"],
    );
    expect(gitOk(root, ours, "ls-tree", "--name-only", "HEAD")).not.toContain("xzy");
  });

  for (const spec of ["d/", "d/*", "*.md", "g/**", ":(glob)d/**", "./a", "d/../a", ":!d/x"]) {
    it(`commit --only matches '${spec}' as git's pathspec`, async () => {
      await onlyTwins(
        (dir) => {
          put(dir, "g/h/i.md", "i\n");
          put(dir, "r.md", "r\n");
          put(dir, "d/e/z", "z\n");
          gitOk(root, dir, "add", ".");
          gitOk(root, dir, "commit", "-q", "-m", "more");
          for (const f of ["a", "d/x", "d/y", "d/e/z", "g/h/i.md", "r.md"])
            put(dir, f, "changed\n");
        },
        [spec],
      );
    });
  }

  it("commit --only leaves the cache-tree invalid where git's does while paths are unmerged", async () => {
    // g/h/i racily clean in both twins whatever the clock does while they are built: its
    // mtime is the index's second, every other file is older (a second boundary between
    // the add and the last index write in one twin only made the cache-trees differ)
    const T = 1_700_000_000;
    await onlyTwins(
      (dir) => {
        put(dir, "g/h/i", "i\n");
        for (const p of ["a", "d/x", "d/y"]) utimesSync(join(dir, p), T - 100, T - 100);
        utimesSync(join(dir, "g/h/i"), T, T);
        gitOk(root, dir, "add", ".");
        gitOk(root, dir, "commit", "-q", "-m", "more");
        // a fully valid cache-tree, then a conflict on d/y
        gitOk(root, dir, "write-tree");
        const id = execFileSync("git", ["hash-object", "-w", "--stdin"], {
          cwd: dir,
          input: "theirs\n",
          encoding: "utf8",
        }).trim();
        gitOk(root, dir, "update-index", "--force-remove", "d/y");
        execFileSync("git", ["update-index", "--index-info"], {
          cwd: dir,
          input: [1, 2, 3].map((s) => `100644 ${id} ${s}\td/y\n`).join(""),
        });
        utimesSync(join(dir, ".git/index"), T, T);
        // a racily clean g/h/i is read again: git invalidates its path all the same
        put(dir, "a", "changed\n");
      },
      ["a", "g"],
    );
  });

  it("a failed commit --only keeps the instance's unwritten edits and the index as it was", async () => {
    const { ours } = pair((dir) => {
      put(dir, "d/x", "staged in memory\n");
    });
    const g = await openOurs(ours);
    await g.add().addFilepattern("d/x").setWriteIndex(false).call();
    const index = readFileSync(join(ours, ".git/index"));
    const staging = g.workingCopy.checkout.staging;
    const staged = (await staging.getEntry("d/x"))?.objectId;
    // nothing to commit for a: refused after the index was edited and written to the lock
    await expect(commitOurs(g, "only").setOnly("a").call()).rejects.toThrow();
    expect(readFileSync(join(ours, ".git/index")).equals(index)).toBe(true);
    expect(existsSync(join(ours, ".git/index.lock"))).toBe(false);
    expect(staging.hasUnwrittenChanges?.()).toBe(true);
    expect((await staging.getEntry("d/x"))?.objectId).toBe(staged);
  });

  for (const mode of ["--only", "-a"] as const) {
    it(`commit ${mode} holds index.lock until HEAD has moved: a concurrent git add is refused`, async () => {
      const { native, ours } = pair((dir) => {
        put(dir, "a", "changed\n");
        put(dir, "n", "new\n");
      });
      const args = mode === "--only" ? ["--only", "a"] : ["-a"];
      gitOk(root, native, "commit", "-q", "-m", "locked", ...args);
      const g = await openOurs(ours);
      const commits = g.history?.commits;
      if (!commits) throw new Error("no history");
      const store = commits.store.bind(commits);
      let concurrent: ReturnType<typeof git> | undefined;
      commits.store = async (commit) => {
        concurrent = git(root, ours, "add", "n");
        return store(commit);
      };
      const command = commitOurs(g, "locked");
      await (mode === "--only" ? command.setOnly("a") : command.setAll(true)).call();
      expect(concurrent?.status).toBe(128);
      expect(concurrent?.stderr).toContain("index.lock': File exists");
      expect(existsSync(join(ours, ".git/index.lock"))).toBe(false);
      expect(gitOk(root, ours, "rev-parse", "HEAD")).toBe(gitOk(root, native, "rev-parse", "HEAD"));
      expect(lsFiles(ours)).toBe(lsFiles(native));
      expect(await treeExtension(ours)).toBe(await treeExtension(native));
      expect(gitOk(root, ours, "status", "--porcelain")).toBe(
        gitOk(root, native, "status", "--porcelain"),
      );
    });
  }

  it("rm --cached of a large directory keeps the stat data of the other entries", async () => {
    const { native, ours } = pair((dir) => {
      for (let i = 0; i < 30; i++) put(dir, `big/f${String(i).padStart(2, "0")}`, `${i}\n`);
      for (const f of ["e1", "e2", "e3"]) put(dir, f, `${f}\n`);
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-q", "-m", "big");
    });
    const before = await statOf(ours, (p) => p.startsWith("big/"));
    gitOk(root, native, "rm", "-q", "-r", "--cached", "big");
    const g = await openOurs(ours);
    await g.rm().addFilepattern("big").setCached(true).setRecursive(true).call();
    expect(lsFiles(ours)).toBe(lsFiles(native));
    expect(await statOf(ours, (p) => p.startsWith("big/"))).toEqual(before);
    expect(gitOk(root, ours, "diff-files", "--name-status")).toBe(
      gitOk(root, native, "diff-files", "--name-status"),
    );
  });

  // an instance opened before another writer staged b: each command reads the index again
  // first and behaves as on a fresh instance (no partial run over the stale entries)
  const staleCommands: [
    string,
    string[],
    (g: Awaited<ReturnType<typeof openOurs>>) => Promise<unknown>,
  ][] = [
    [
      "cherry-pick",
      ["cherry-pick", "side"],
      (g) => g.cherryPick().include("side").setCommitter(INTEROP_IDENT).call(),
    ],
    ["switch", ["switch", "-q", "side"], (g) => g.switch().setName("side").call()],
    [
      "merge",
      ["merge", "-q", "--no-edit", "side"],
      (g) => g.merge().include("side").setAuthor(INTEROP_IDENT).setCommitter(INTEROP_IDENT).call(),
    ],
    [
      "reset --mixed",
      ["reset", "-q", "HEAD~1"],
      (g) => g.reset().setRef("HEAD~1").setMode(ResetMode.MIXED).call(),
    ],
    [
      "reset --hard",
      ["reset", "-q", "--hard", "HEAD"],
      (g) => g.reset().setRef("HEAD").setMode(ResetMode.HARD).call(),
    ],
    ["stash push", ["stash", "push", "-q"], (g) => g.stashCreate().call()],
  ];
  for (const [name, args, run] of staleCommands) {
    it(`${name} on a stale instance reads the index again first`, async () => {
      const { native, ours } = pair(() => {}, true);
      const g = await openOurs(ours, INTEROP_AUTHOR_ENV);
      for (const dir of [native, ours]) {
        put(dir, "b", "b\n");
        gitOk(root, dir, "add", "b");
      }
      const r = git(root, native, ...args);
      // a refusal: thrown, or a result with status "failed" (merge, cherry-pick)
      let failed = false;
      try {
        const result = await run(g);
        failed = (result as { status?: unknown } | undefined)?.status === "failed";
      } catch {
        failed = true;
      }
      expect(failed).toBe(r.status !== 0);
      // ORIG_HEAD: native stash push runs `reset --hard` as a child, which writes it; ours
      // (fresh instance or not) writes none
      const state = (name: string, text: string) =>
        name === "ORIG_HEAD" && args[0] === "stash" ? "" : normalizeState(name, text);
      const strip = (snap: ReturnType<typeof snapshot>) => ({
        ...snap,
        state: Object.fromEntries(Object.entries(snap.state).filter(([, v]) => v !== "")),
      });
      expect(strip(snapshot(root, ours, state))).toEqual(strip(snapshot(root, native, state)));
      expect(lsFiles(ours)).toBe(lsFiles(native));
      expect(gitOk(root, ours, "stash", "list").split("\n").length).toBe(
        gitOk(root, native, "stash", "list").split("\n").length,
      );
    });
  }
});
