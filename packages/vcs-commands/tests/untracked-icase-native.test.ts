/**
 * The untracked walks of `clean`, `add`, `stash -u`/`-a` and `checkout` under
 * `core.ignorecase`, against native git (2.43 or 2.5x, whichever is on PATH): dir.c asks
 * the index through its name hashes, which fold ASCII case (`index_file_exists` with icase,
 * `directory_exists_in_index_icase`, `dir_add_name`), while `index_name_is_other` stays
 * exact. The sandbox filesystem is case-sensitive, as in git's own icase tests, so both
 * spellings of a name exist side by side and native git with `core.ignorecase=true` is the
 * oracle.
 *
 * The fixture: tracked `a/b/two.txt` beside an untracked `a/b/TWO.txt`, a directory `A/`
 * beside the tracked `a/` (`A/X.txt` folds onto `a/x.txt`, `A/y.txt` is new), a
 * skip-worktree `s/skip.txt` (gone from disk) beside `S/SKIP.txt`, a tracked `t.log` that
 * `*.log` ignores beside `T.LOG`, an ignored `n.LOG` (the pattern folds case too),
 * `KEEP.TXT` beside the tracked `keep.txt`, and an untracked directory `U/`.
 */
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IndexDirnameCase } from "../src/commands/index-adder.js";
import type { Git } from "../src/index.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";
import { gitOut, gitRun, openRepo, putFile } from "./status-native-support.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
const DATES = {
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};
const git = (dir: string, args: string[]) => gitOut(root, dir, args, DATES);

/** The fixture, built the same way in `dir`. */
function build(dir: string): void {
  git(root, ["init", "-q", dir]);
  git(dir, ["config", "core.ignorecase", "true"]);
  putFile(dir, "a/b/two.txt", "two\n");
  putFile(dir, "a/x.txt", "x\n");
  putFile(dir, "s/skip.txt", "s\n");
  putFile(dir, "t.log", "t\n");
  putFile(dir, "keep.txt", "k\n");
  putFile(dir, ".gitignore", "*.log\n");
  git(dir, ["add", "a", "s", ".gitignore", "keep.txt"]);
  git(dir, ["add", "-f", "t.log"]);
  git(dir, ["commit", "-qm", "init"]);
  git(dir, ["update-index", "--skip-worktree", "s/skip.txt"]);
  rmSync(join(dir, "s/skip.txt"));
  putFile(dir, "a/b/TWO.txt", "TWO\n");
  putFile(dir, "A/y.txt", "y\n");
  putFile(dir, "A/X.txt", "X\n");
  putFile(dir, "S/SKIP.txt", "S\n");
  putFile(dir, "T.LOG", "T\n");
  putFile(dir, "n.LOG", "n\n");
  putFile(dir, "KEEP.TXT", "K\n");
  putFile(dir, "U/u.txt", "u\n");
}

/** Every file and directory below `dir` (outside `.git`), directories with a "/". */
function listTree(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(dir, base)).sort()) {
    if (!base && name === ".git") continue;
    const path = base ? `${base}/${name}` : name;
    if (statSync(join(dir, path)).isDirectory()) out.push(`${path}/`, ...listTree(dir, path));
    else out.push(path);
  }
  return out;
}

/** The two twins: native git's repository and ours, built alike. */
async function twins(): Promise<{ theirs: string; mine: string; ours: Git }> {
  const theirs = join(root, "theirs");
  const mine = join(root, "mine");
  build(theirs);
  build(mine);
  return { theirs, mine, ours: await openRepo(root, mine, DATES) };
}

const lines = (text: string, prefix: string) =>
  text
    .split("\n")
    .filter((l) => l.startsWith(prefix))
    .map((l) => l.slice(prefix.length))
    .sort();

describeGit("untracked walks under core.ignorecase: native git's name hashes", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "untracked-icase-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  for (const [flags, d, x, X] of [
    ["-n", false, false, false],
    ["-nd", true, false, false],
    ["-ndx", true, true, false],
    ["-ndX", true, false, true],
    ["-nX", false, false, true],
  ] as const) {
    it(`clean ${flags}: files and directories differing from index paths only by case are tracked`, async () => {
      const { theirs, ours } = await twins();
      const expected = lines(git(theirs, ["clean", flags]), "Would remove ");
      const result = await ours
        .clean()
        .setDryRun(true)
        .setCleanDirectories(d)
        .setIgnore(!x)
        .setIgnoredOnly(X)
        .call();
      expect([...result.cleaned].sort()).toEqual(expected);
    });
  }

  it("clean -fd removes no file the index has in another case", async () => {
    const { theirs, mine, ours } = await twins();
    git(theirs, ["clean", "-fd"]);
    await ours.clean().setDryRun(false).setCleanDirectories(true).call();
    expect(listTree(mine)).toEqual(listTree(theirs));
    expect(listTree(mine)).toContain("A/X.txt");
  });

  for (const args of [["-A"], ["-N", "."], ["."], ["--", "A"]]) {
    it(`add ${args.join(" ")}: new files only, their directories spelled as the index's`, async () => {
      const { theirs, mine, ours } = await twins();
      git(theirs, ["add", ...args]);
      const add = ours.add();
      const patterns = args.filter((a) => !a.startsWith("-"));
      for (const p of patterns.length > 0 ? patterns : ["."]) add.addFilepattern(p);
      if (args.includes("-N")) add.setIntentToAdd(true);
      await add.call();
      expect(git(mine, ["ls-files", "-s"])).toEqual(git(theirs, ["ls-files", "-s"]));
    });
  }

  it("add -n . lists what native git's dry run lists", async () => {
    const { theirs, ours } = await twins();
    const expected = git(theirs, ["add", "-n", "."]).split("\n").filter(Boolean);
    const result = await ours.add().addFilepattern(".").setDryRun(true).call();
    expect(result.output ?? []).toEqual(expected);
  });

  for (const path of ["KEEP.TXT", "T.LOG", "a/b/TWO.txt"]) {
    it(`add ${path}: a case variant of a tracked file is neither added nor reported`, async () => {
      const { theirs, mine, ours } = await twins();
      const native = gitRun(root, theirs, ["add", path], DATES);
      expect(native.status).toBe(0);
      await ours.add().addFilepattern(path).call();
      expect(git(mine, ["ls-files", "-s"])).toEqual(git(theirs, ["ls-files", "-s"]));
    });
  }

  // add_files_to_cache runs first: its removals (remove_name_hash) drop a directory they
  // leave empty from the name hash, so adjust_dirname_case no longer spells a new file by it
  for (const [label, args, keep] of [
    ["add -A, the directory emptied", ["-A"], false],
    ["add ., the directory emptied", ["."], false],
    ["add -A, the directory partly emptied", ["-A"], true],
    ["add -n -A, a dry run removing nothing", ["-n", "-A"], false],
  ] as const) {
    it(`${label}: a new file's directory is spelled by the index as it stands`, async () => {
      const theirs = join(root, "theirs");
      const mine = join(root, "mine");
      for (const dir of [theirs, mine]) {
        git(root, ["init", "-q", dir]);
        git(dir, ["config", "core.ignorecase", "true"]);
        putFile(dir, "d/x.txt", "x\n");
        putFile(dir, "d/z.txt", "z\n");
        git(dir, ["add", "d"]);
        git(dir, ["commit", "-qm", "init"]);
        rmSync(join(dir, keep ? "d/x.txt" : "d"), { recursive: true });
        putFile(dir, "D/y.txt", "y\n");
      }
      const dry = (args as readonly string[]).includes("-n");
      const native = git(theirs, ["add", ...args]);
      const ours = await openRepo(root, mine, DATES);
      const result = await ours.add().addFilepattern(".").setDryRun(dry).call();
      if (dry) {
        expect(result.output ?? []).toEqual(native.split("\n").filter(Boolean));
      }
      expect(git(mine, ["ls-files", "-s"])).toEqual(git(theirs, ["ls-files", "-s"]));
      if (!dry) {
        expect(git(theirs, ["ls-files"])).toContain(keep ? "d/y.txt" : "D/y.txt");
      }
    });
  }

  for (const [flag, all] of [
    ["-u", false],
    ["-a", true],
  ] as const) {
    it(`stash ${flag}: the untracked tree and the clean after it`, async () => {
      const { theirs, mine, ours } = await twins();
      git(theirs, ["stash", flag, "-q"]);
      await ours.stashCreate().setIncludeUntracked(true).setIncludeIgnored(all).call();
      const untracked = (dir: string) =>
        git(dir, ["ls-tree", "-r", "--name-only", "stash@{0}^3"]).split("\n").filter(Boolean);
      expect(untracked(mine)).toEqual(untracked(theirs));
      expect(listTree(mine)).toEqual(listTree(theirs));
    });
  }

  // A deliberate divergence: native git saves the stash, then its `git apply --index -R`
  // fails ("No valid patches in input": the stash's diff names `a/y.txt`, the file is
  // `A/y.txt`), exit 1 in 2.43 and 128 in 2.5x, leaving `A/y.txt` on disk and `a/y.txt`
  // staged. Ours removes the file it saved in the stash's untracked tree and succeeds.
  it("stash push -u -- A: an untracked case variant of a tracked directory is saved and removed", async () => {
    const { theirs, mine, ours } = await twins();
    const native = gitRun(root, theirs, ["stash", "push", "-u", "-q", "--", "A"], DATES);
    expect(native.status).not.toBe(0);
    expect(native.stderr).toContain("No valid patches in input");
    expect(listTree(theirs)).toContain("A/y.txt");
    expect(git(theirs, ["ls-files"])).toContain("a/y.txt");

    await ours.stashCreate().setIncludeUntracked(true).addPath("A").call();
    const untracked = (dir: string) =>
      git(dir, ["ls-tree", "-r", "--name-only", "stash@{0}^3"]).split("\n").filter(Boolean);
    expect(untracked(mine)).toEqual(untracked(theirs));
    expect(listTree(mine)).not.toContain("A/y.txt");
    expect(git(mine, ["ls-files"])).not.toContain("y.txt");
    // native: "AD a/y.txt" (staged under the index's spelling) beside "?? U/"
    expect(git(theirs, ["status", "--porcelain"])).toBe("AD a/y.txt\n?? U/\n");
    expect(git(mine, ["status", "--porcelain"])).toBe("?? U/\n");
  });

  it("checkout: an untracked case variant of an index path is in the way of a new file", async () => {
    const { theirs, mine } = await twins();
    for (const dir of [theirs, mine]) {
      const exact = (args: string[]) => git(dir, ["-c", "core.ignorecase=false", ...args]);
      exact(["checkout", "-q", "-b", "side"]);
      exact(["add", "a/b/TWO.txt"]);
      exact(["commit", "-qm", "side"]);
      exact(["checkout", "-q", "-"]);
      putFile(dir, "a/b/TWO.txt", "mine\n");
    }
    // verify_absent: icase_exists finds a/b/two.txt, whose stat is not this file's
    const native = gitRun(root, theirs, ["checkout", "side"], DATES);
    expect(native.status).not.toBe(0);
    expect(native.stderr).toContain("a/b/TWO.txt");
    const ours = await openRepo(root, mine, DATES);
    const result = await ours.checkout().setName("side").call();
    expect(result.conflicts).toEqual(["a/b/TWO.txt"]);
    expect(listTree(mine)).toEqual(listTree(theirs));
  });
});

describe("IndexDirnameCase (adjust_dirname_case)", () => {
  it("spells each leading directory found as the index first did", () => {
    const dirs = new IndexDirnameCase(["a/b/two.txt", "a/x.txt", "Q/z"]);
    expect(dirs.adjust("A/B/new.txt")).toBe("a/b/new.txt");
    expect(dirs.adjust("A/C/new.txt")).toBe("a/C/new.txt");
    expect(dirs.adjust("U/u.txt")).toBe("U/u.txt");
    expect(dirs.adjust("q/z2")).toBe("Q/z2");
    dirs.note("a/C/new.txt");
    expect(dirs.adjust("A/c/D/e")).toBe("a/C/D/e");
  });

  it("forgets a directory once the entries in it are removed (remove_dir_entry)", () => {
    const dirs = new IndexDirnameCase(["d/x", "d/z", "D/e/f"]);
    dirs.forget("d/x");
    expect(dirs.adjust("D/y")).toBe("d/y");
    dirs.forget("d/z");
    // "d/e" still holds "D/e/f", so "d" stays
    expect(dirs.adjust("D/y")).toBe("d/y");
    dirs.forget("D/e/f");
    expect(dirs.adjust("D/y")).toBe("D/y");
    expect(dirs.adjust("d/E/g")).toBe("d/E/g");
  });
});

// unpack-trees' verify_clean_subdirectory asks read_directory, whose index lookups fold case
// under core.ignorecase (index_file_exists, directory_exists_in_index_icase): a directory a
// checkout replaces by a file may hold case variants of its tracked files, which go with it
describeGit(
  "checkout replacing a directory under core.ignorecase: verify_clean_subdirectory",
  () => {
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "untracked-icase-dir-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    /** `d/x.txt` and `d/sub/a.txt` on main, a file `d` on `side`, then `extra` put in `d/` */
    function buildReplaced(dir: string, extra: string[]): void {
      git(root, ["init", "-q", "-b", "main", dir]);
      git(dir, ["config", "core.ignorecase", "true"]);
      putFile(dir, "d/x.txt", "x\n");
      putFile(dir, "d/sub/a.txt", "a\n");
      putFile(dir, "k.txt", "k\n");
      git(dir, ["add", "."]);
      git(dir, ["commit", "-qm", "init"]);
      git(dir, ["checkout", "-q", "-b", "side"]);
      git(dir, ["rm", "-rq", "d"]);
      putFile(dir, "d", "file\n");
      git(dir, ["add", "d"]);
      git(dir, ["commit", "-qm", "side"]);
      git(dir, ["checkout", "-q", "main"]);
      for (const path of extra) putFile(dir, path, `${path}\n`);
    }

    for (const [label, extra, refused] of [
      ["a case variant of a tracked file goes with the directory", ["d/X.txt"], false],
      ["a variant of a tracked directory and file goes too", ["d/SUB/A.TXT"], false],
      ["both variants at once", ["d/X.TXT", "d/Sub/a.txt"], false],
      ["a new file in the directory refuses the checkout", ["d/new.txt"], true],
      ["a new file in a variant of a tracked directory refuses it", ["d/SUB/b.txt"], true],
      ["a variant beside a new file still refuses it", ["d/X.txt", "d/y.txt"], true],
    ] as const) {
      it(label, async () => {
        const theirs = join(root, "theirs");
        const mine = join(root, "mine");
        buildReplaced(theirs, [...extra]);
        buildReplaced(mine, [...extra]);
        const native = gitRun(root, theirs, ["checkout", "side"], DATES);
        expect(native.status !== 0).toBe(refused);
        if (refused) expect(native.stderr).toContain("would lose untracked files in them");
        const ours = await openRepo(root, mine, DATES);
        const result = await ours.checkout().setName("side").call();
        expect((result.conflicts ?? []).length > 0).toBe(refused);
        expect(listTree(mine)).toEqual(listTree(theirs));
        expect(git(mine, ["symbolic-ref", "HEAD"])).toEqual(git(theirs, ["symbolic-ref", "HEAD"]));
        expect(git(mine, ["ls-files", "-s"])).toEqual(git(theirs, ["ls-files", "-s"]));
        expect(git(mine, ["status", "--porcelain"])).toEqual(
          git(theirs, ["status", "--porcelain"]),
        );
      });
    }

    it("without core.ignorecase a case variant refuses the checkout, as in git", async () => {
      const theirs = join(root, "theirs");
      const mine = join(root, "mine");
      for (const dir of [theirs, mine]) {
        buildReplaced(dir, ["d/X.txt"]);
        git(dir, ["config", "core.ignorecase", "false"]);
      }
      const native = gitRun(root, theirs, ["checkout", "side"], DATES);
      expect(native.status).not.toBe(0);
      const ours = await openRepo(root, mine, DATES);
      const result = await ours.checkout().setName("side").call();
      expect(result.conflicts ?? []).toEqual(["d"]);
      expect(listTree(mine)).toEqual(listTree(theirs));
      expect(listTree(mine)).toContain("d/X.txt");
    });
  },
);
