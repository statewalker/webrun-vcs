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
import { execFileSync } from "node:child_process";
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
});
