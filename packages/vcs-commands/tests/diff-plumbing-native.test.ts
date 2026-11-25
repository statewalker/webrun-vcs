/**
 * The plumbing diffs (`git diff-tree`, `git diff-index`, `git diff-files`) against native git,
 * run on one repository native git built: t4002 (raw output over t1000's three-way trees),
 * t4054 (a tree holding the null id), t4044 (unique abbreviations).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { READ_TREE_3WAY, runNative, runOurs } from "./diff-plumbing-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
const env = () => nativeGitEnv(root);
const sh = (cwd: string, script: string) =>
  execFileSync("sh", ["-c", script], { cwd, env: env(), encoding: "latin1" });
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: env(), encoding: "latin1" });

/** Native git and ours give the same stdout and status for `args` */
async function same(dir: string, args: string[], input?: string): Promise<string> {
  const native = runNative(dir, env(), args, input);
  const ours = await runOurs(await openOurs(dir), args, input);
  expect({ status: ours.status, stdout: ours.stdout }).toEqual({
    status: native.status,
    stdout: native.stdout,
  });
  // git's death or usage line
  if (native.status !== 0) expect(ours.stderr).toBe(native.stderr);
  return native.stdout;
}

describeGit("plumbing diffs against native git", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "diff-plumbing-"));
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  describe("t4002-diff-basic.sh", () => {
    let dir = "";
    let O = "";
    let A = "";
    let B = "";
    beforeAll(() => {
      dir = join(root, "t4002");
      git(root, "init", "-q", dir);
      const out = sh(dir, READ_TREE_3WAY).trim().split("\n");
      [O, A, B] = (out[out.length - 1] as string).split(" ") as [string, string, string];
    });

    it('t4002-diff-basic.sh: "diff-tree of known trees."', async () => {
      for (const [x, y] of [
        [O, A],
        [O, B],
        [A, B],
      ] as const) {
        const plain = await same(dir, ["diff-tree", x, y]);
        expect(plain).toContain(":040000 040000 ");
        await same(dir, ["diff-tree", "-r", x, y]);
        await same(dir, ["diff-tree", "-t", x, y]);
        await same(dir, ["diff-tree", "-r", "-z", x, y]);
      }
    });

    it('t4002-diff-basic.sh: "diff-tree --stdin of known trees."', async () => {
      await same(dir, ["diff-tree", "--stdin"], `${A} ${B}\n`);
      await same(dir, ["diff-tree", "-r", "--stdin"], `${A} ${B}\nnot an id\n${O} ${A}\n`);
    });

    it('t4002-diff-basic.sh: "diff-cache O with A in cache"', async () => {
      git(dir, "read-tree", A);
      await same(dir, ["diff-index", "--cached", O]);
    });

    it('t4002-diff-basic.sh: "diff-cache O with B in cache"', async () => {
      git(dir, "read-tree", B);
      await same(dir, ["diff-index", "--cached", O]);
    });

    it('t4002-diff-basic.sh: "diff-cache A with B in cache"', async () => {
      git(dir, "read-tree", B);
      await same(dir, ["diff-index", "--cached", A]);
      await same(dir, ["diff-index", "--cached", "--name-status", A]);
      await same(dir, ["diff-index", "--cached", "-z", "--abbrev", A]);
    });

    for (const [title, cache, checkout] of [
      ["diff-files with O in cache and A checked out", "O", "A"],
      ["diff-files with O in cache and B checked out", "O", "B"],
      ["diff-files with A in cache and B checked out", "A", "B"],
    ] as const) {
      it(`t4002-diff-basic.sh: "${title}"`, async () => {
        const trees = { O, A, B };
        sh(dir, "rm -fr Z [A-Z][A-Z]");
        git(dir, "read-tree", trees[checkout]);
        git(dir, "checkout-index", "-f", "-a");
        git(dir, "read-tree", "--reset", trees[cache]);
        runNative(dir, env(), ["update-index", "--refresh", "-q"]);
        const raw = await same(dir, ["diff-files"]);
        expect(raw).toContain(` ${"0".repeat(40)} M\t`);
        await same(dir, ["diff-files", "--name-status"]);
        await same(dir, ["diff-index", trees[cache]]);
        await same(dir, ["diff-index", trees[checkout]]);
      });
    }

    it('t4002-diff-basic.sh: "diff-tree O A == diff-tree -R A O"', async () => {
      await same(dir, ["diff-tree", "-R", A, O]);
      await same(dir, ["diff-tree", "-r", "-R", A, O]);
      await same(dir, ["diff-tree", "-R", A, B]);
      await same(dir, ["diff-tree", "-r", "-R", A, B]);
    });
  });

  describe("t4054-diff-bogus-tree.sh", () => {
    let dir = "";
    let bogus = "";
    let good = "";
    const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    beforeAll(() => {
      dir = join(root, "t4054");
      git(root, "init", "-q", dir);
      bogus = sh(
        dir,
        'name=$(echo 0000000000000000000000000000000000000000 | sed -e "s/00/Q/g") && printf "100644 fooQ$name" | tr Q "\\000" | git hash-object --literally -w --stdin -t tree',
      ).trim();
      sh(dir, "echo bar >foo && git add foo");
      good = git(dir, "write-tree").trim();
    });

    it('t4054-diff-bogus-tree.sh: "raw diff shows null sha1 (addition)"', async () => {
      await same(dir, ["diff-tree", EMPTY_TREE, bogus]);
    });
    it('t4054-diff-bogus-tree.sh: "raw diff shows null sha1 (removal)"', async () => {
      await same(dir, ["diff-tree", bogus, EMPTY_TREE]);
    });
    it('t4054-diff-bogus-tree.sh: "raw diff shows null sha1 (modification)"', async () => {
      await same(dir, ["diff-tree", good, bogus]);
    });
    it('t4054-diff-bogus-tree.sh: "raw diff shows null sha1 (other direction)"', async () => {
      await same(dir, ["diff-tree", bogus, good]);
    });
    it('t4054-diff-bogus-tree.sh: "raw diff shows null sha1 (reverse)"', async () => {
      await same(dir, ["diff-tree", "-R", good, bogus]);
    });
    it('t4054-diff-bogus-tree.sh: "raw diff shows null sha1 (index)"', async () => {
      await same(dir, ["diff-index", bogus]);
    });
  });

  // diff-pairs is git 2.50+
  const version = nativeGitAvailable()
    ? (/(\d+)\.(\d+)/.exec(execFileSync("git", ["--version"], { encoding: "utf8" })) ?? [])
    : [];
  const hasDiffPairs = Number(version[1]) > 2 || Number(version[2]) >= 50;
  (hasDiffPairs ? describe : describe.skip)("t4070-diff-pairs.sh", () => {
    let dir = "";
    let raw = "";
    beforeAll(() => {
      const sub = join(root, "t4070-sub");
      git(root, "init", "-q", sub);
      sh(sub, "echo initial >initial.t && git add . && git commit -q -m initial");
      dir = join(root, "t4070");
      git(root, "init", "-q", dir);
      sh(
        dir,
        [
          "echo to-be-gone >deleted",
          "echo original >modified",
          "echo now-a-file >symlink",
          "seq 200 >two-hundred",
          "seq 201 500 >five-hundred",
          "git add . && git commit -q -m base && git tag base",
          "git -c protocol.file.allow=always submodule -q add ../t4070-sub sub",
          "echo now-here >added",
          "echo new >modified",
          "rm deleted",
          "mkdir subdir && echo content >subdir/file",
          "mv two-hundred renamed",
          "seq 201 500 | sed s/300/modified/ >copied",
          "rm symlink",
          "git add -A . && ln -s dest symlink && git add symlink",
          "git commit -q -m new && git tag new",
        ].join(" && "),
      );
      raw = git(dir, "diff-tree", "-r", "-M", "-C", "-C", "-z", "base", "new");
    });

    it('t4070-diff-pairs.sh: "diff-pairs recreates --raw"', async () => {
      const out = await same(dir, ["diff-pairs", "--raw", "-z"], raw);
      expect(out).toBe(raw);
    });
    it('t4070-diff-pairs.sh: "diff-pairs can create -p output"', async () => {
      const out = await same(dir, ["diff-pairs", "-p", "-z"], raw);
      expect(out).toBe(git(dir, "diff-tree", "-p", "-M", "-C", "-C", "base", "new"));
      await same(dir, ["diff-pairs", "--stat", "--summary", "-z"], raw);
      await same(dir, ["diff-pairs", "--name-status", "-z"], raw);
      await same(dir, ["diff-pairs", "-z"], git(dir, "diff-tree", "-r", "-z", "base", "new"));
      await same(dir, ["diff-pairs", "-M", "-z"], git(dir, "diff-tree", "-r", "-z", "base", "new"));
    });
    it('t4070-diff-pairs.sh: "diff-pairs does not support normal raw diff input"', async () => {
      await same(dir, ["diff-pairs"], git(dir, "diff-tree", "-r", "base", "new"));
    });
    it('t4070-diff-pairs.sh: "diff-pairs does not support tree objects as input"', async () => {
      await same(dir, ["diff-pairs", "-z"], git(dir, "diff-tree", "-z", "base", "new"));
    });
    it('t4070-diff-pairs.sh: "diff-pairs does not support pathspec arguments"', async () => {
      await same(dir, ["diff-pairs", "-z", "--", "new"], raw);
    });
    it('t4070-diff-pairs.sh: "diff-pairs explicit queue flush"', async () => {
      await same(dir, ["diff-pairs", "--raw", "-z"], `${raw}\0${raw}`);
    });
  });

  describe("diff-files and diff-index with an unmerged path", () => {
    it("lists it as U, then against stage 2; -p shows its combined diff", async () => {
      const dir = join(root, "unmerged");
      git(root, "init", "-q", "-b", "main", dir);
      sh(
        dir,
        [
          "echo a >a && echo k >k && echo x >x && git add . && git commit -q -m 1",
          "git checkout -q -b side && echo s >a && git commit -q -a -m s",
          "git checkout -q main && echo m >a && git commit -q -a -m m",
          "(git merge -q side >/dev/null 2>&1 || true)",
          "rm k && chmod +x x",
        ].join(" && "),
      );
      for (const args of [
        ["diff-files"],
        ["diff-files", "-z"],
        ["diff-files", "--name-status"],
        ["diff-files", "-p"],
        ["diff-files", "--stat"],
        ["diff-index", "HEAD"],
        ["diff-index", "--cached", "HEAD"],
        ["diff-index", "--cached", "-p", "HEAD"],
        ["diff-index", "-p", "HEAD"],
        ["diff-files", "--", "a"],
      ]) {
        await same(dir, args);
      }
    });
  });

  describe("t4044-diff-index-unique-abbrev.sh", () => {
    it('t4044-diff-index-unique-abbrev.sh: "diff does not produce ambiguous index line"', async () => {
      const dir = join(root, "t4044");
      git(root, "init", "-q", dir);
      // blobs 51d27384... and 51d2738e...: their first seven digits are one
      sh(dir, "echo 4827 >foo && git add foo && git commit -q -m initial");
      sh(dir, "echo 11742 >foo && git commit -q -a -m update");
      const patch = await same(dir, ["diff-tree", "-p", "HEAD^", "HEAD"]);
      expect(patch).toContain("index 51d27384..51d2738e 100644");
      const raw = await same(dir, ["diff-tree", "--abbrev", "HEAD^", "HEAD"]);
      expect(raw).toContain(" 51d27384 51d2738e M\t");
      await same(dir, ["diff-tree", "--abbrev=4", "HEAD^", "HEAD"]);
      await same(dir, ["diff-tree", "--abbrev=12", "HEAD"]);
    });
  });
});
