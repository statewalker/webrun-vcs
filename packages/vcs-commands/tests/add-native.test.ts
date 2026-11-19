/**
 * `git add` as native git does it, path by path: each case builds the same repository twice
 * with native git, runs native `git add` in one twin and ours in the other, and compares
 * them (index, resolve-undo, cache-tree, worktree, state files, and git's messages).
 *
 * - a tracked file that became a directory is removed by `add -u` and `commit -a`, and by
 *   `add .` / `-A`, which add the directory's files as new (a conflict included);
 * - `add -N` writes the empty blob, and leaves a changed tracked file's entry as it is while
 *   invalidating its cache-tree path;
 * - pathspec checks: an element that names no file, ignored paths named without `-f`,
 *   `--dry-run` (with `--ignore-missing`), `-u` with an element that matches nothing tracked;
 * - repositories inside the worktree: staged as gitlinks to their HEAD (with git's
 *   warning), refused without a commit; a submodule's gitlink follows its checked-out HEAD;
 * - the cache-tree after `--renormalize`;
 * - `stash push` records ORIG_HEAD (its `reset --hard`);
 * - linked worktrees inside the repository (gitlinks), a `.git` beyond the storage (skipped),
 *   a tracked file turned repository or turned directory with a `.git` that is none, elements
 *   beyond a symbolic link or ending in "/", `--renormalize`'s checks and output, a tracked
 *   file turned FIFO;
 * - a nested repository found as git's is_git_directory finds it (a HEAD or `.git` that is a
 *   link, objects and refs in its commondir, an empty commondir fatal), paths verify_path
 *   refuses, and the errors, output and warnings printed before a failure.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseIndexFile } from "@statewalker/vcs-working-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AddResult } from "../src/commands/add-command.js";
import { AddFailedError, NoFilepatternError } from "../src/errors/index.js";
import type { Git } from "../src/index.js";
import { git, gitOk, normalizeState, openOurs, put, snapshot } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let counter = 0;

/** The same repository in two directories, built by `build` with native git. */
function twins(build: (dir: string) => void): { native: string; ours: string } {
  const n = counter++;
  const native = join(root, `n${n}`);
  const ours = join(root, `o${n}`);
  for (const dir of [native, ours]) {
    gitOk(root, root, "init", "-q", "-b", "main", dir);
    build(dir);
  }
  return { native, ours };
}

/** The `TREE` extension of the index in `dir`, as hex (empty: none). */
async function treeExtension(dir: string): Promise<string> {
  const parsed = await parseIndexFile(new Uint8Array(readFileSync(join(dir, ".git/index"))));
  const ext = parsed.extensionData.find((e) => e.signature === "TREE");
  return ext ? Buffer.from(ext.data).toString("hex") : "";
}

/** Both alike: index, resolve-undo, cache-tree, worktree, HEAD, state files. */
async function same(ours: string, native: string) {
  // a nested repository's own git directory is its business (its index's stat data)
  const view = (dir: string) => {
    const shot = snapshot(root, dir, normalizeState);
    const files = Object.entries(shot.files).filter(([p]) => !/(^|\/)\.git\//.test(p));
    return { ...shot, files: Object.fromEntries(files) };
  };
  expect(view(ours)).toEqual(view(native));
  expect(gitOk(root, ours, "ls-files", "--resolve-undo")).toBe(
    gitOk(root, native, "ls-files", "--resolve-undo"),
  );
  expect(await treeExtension(ours)).toBe(await treeExtension(native));
}

/** git's standard error without its advice lines (worded differently by version). */
const withoutHints = (stderr: string) =>
  stderr
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("hint:"))
    .join("\n");

/** What our add rejected with (undefined: it did not). */
async function failure(run: Promise<unknown>): Promise<Error | undefined> {
  return run.then(
    () => undefined,
    (e: unknown) => e as Error,
  );
}

/** A commit with files `a` and `x`, on main. */
function fileAndX(dir: string) {
  put(dir, "a", "a\n");
  put(dir, "x", "x\n");
  gitOk(root, dir, "add", ".");
  gitOk(root, dir, "commit", "-q", "-m", "c");
}

/** `a` replaced by a directory holding `a/inner`. */
function fileToDirectory(dir: string) {
  unlinkSync(join(dir, "a"));
  put(dir, "a/inner", "i\n");
}

/** A nested repository at `dir/sub` with one commit (fixed identity and dates). */
function nestedRepository(dir: string, name = "sub", commit = true) {
  gitOk(root, dir, "init", "-q", "-b", "main", name);
  if (!commit) return;
  put(dir, `${name}/s`, "s\n");
  gitOk(root, join(dir, name), "add", "s");
  gitOk(root, join(dir, name), "commit", "-q", "-m", "s");
}

/** Our add with git's command-line arguments (`-u`, `-A`, `-n`, `-v`, ..., pathspec elements). */
async function ourAdd(repo: Git, args: string[]): Promise<AddResult> {
  const cmd = repo.add();
  for (const a of args) {
    if (a === "-u") cmd.setUpdate(true);
    else if (a === "-A") cmd.setAll(true);
    else if (a === "-n") cmd.setDryRun(true);
    else if (a === "-v") continue;
    else if (a === "--ignore-missing") cmd.setIgnoreMissing(true);
    else if (a === "--ignore-errors") cmd.setIgnoreErrors(true);
    else if (a === "--renormalize") cmd.setRenormalize(true);
    else cmd.addFilepattern(a);
  }
  return cmd.call();
}

/** git's lines without the "unable to index file" 2.43 does not print. */
const errorLines = (text: string) =>
  text
    .trim()
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("error: unable to index file"));

/** The lines of git's standard output. */
const stdoutLines = (stdout: string) => stdout.split("\n").filter((l) => l !== "");

/** `a` replaced by a repository: with a commit checked out, or none. */
function fileToRepository(commit: boolean) {
  return (dir: string) => {
    fileAndX(dir);
    unlinkSync(join(dir, "a"));
    nestedRepository(dir, "a", commit);
  };
}

describeGit("git add, as native git stages paths", () => {
  const g = (dir: string): Promise<Git> => openOurs(dir);
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "add-native-"));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("add -u removes a tracked file that became a directory", async () => {
    const { native, ours } = twins((dir) => {
      fileAndX(dir);
      fileToDirectory(dir);
    });
    gitOk(root, native, "add", "-u");
    const result = await (await g(ours)).add().setUpdate(true).call();
    expect(result.removed).toEqual(["a"]);
    expect(result.output).toEqual(["remove 'a'"]);
    await same(ours, native);
  });

  it("add . removes the file and adds the directory's files", async () => {
    const { native, ours } = twins((dir) => {
      fileAndX(dir);
      fileToDirectory(dir);
    });
    const r = git(root, native, "add", "-v", ".");
    const result = await (await g(ours)).add().addFilepattern(".").call();
    expect(result.output.join("\n")).toBe(r.stdout.trim());
    await same(ours, native);
  });

  it("commit -a commits the removal of a file that became a directory", async () => {
    const { native, ours } = twins((dir) => {
      fileAndX(dir);
      fileToDirectory(dir);
    });
    gitOk(root, native, "commit", "-q", "-a", "-m", "gone");
    await (await g(ours)).commit().setAll(true).setMessage("gone\n").call();
    expect(gitOk(root, ours, "rev-parse", "HEAD^{tree}")).toBe(
      gitOk(root, native, "rev-parse", "HEAD^{tree}"),
    );
    expect(gitOk(root, ours, "ls-files", "-s")).toBe(gitOk(root, native, "ls-files", "-s"));
  });

  it("add . resolves a conflicted file replaced by a directory: removed, its files added", async () => {
    const { native, ours } = twins((dir) => {
      put(dir, "d/e", "base\n");
      put(dir, "k", "k\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-q", "-m", "c");
      gitOk(root, dir, "checkout", "-q", "-b", "side");
      put(dir, "d/e", "side\n");
      gitOk(root, dir, "commit", "-q", "-a", "-m", "s");
      gitOk(root, dir, "checkout", "-q", "main");
      put(dir, "d/e", "main\n");
      gitOk(root, dir, "commit", "-q", "-a", "-m", "m");
      git(root, dir, "merge", "side");
      unlinkSync(join(dir, "d/e"));
      put(dir, "d/e/f", "in\n");
    });
    const r = git(root, native, "add", "-v", ".");
    expect(r.status).toBe(0);
    const result = await (await g(ours)).add().addFilepattern(".").call();
    expect(result.output.join("\n")).toBe(r.stdout.trim());
    await same(ours, native);
  });

  it("add -u stages a tracked file replaced by a repository as a gitlink", async () => {
    const { native, ours } = twins((dir) => {
      fileAndX(dir);
      unlinkSync(join(dir, "a"));
      nestedRepository(dir, "a");
    });
    gitOk(root, native, "add", "-u");
    await (await g(ours)).add().setUpdate(true).call();
    await same(ours, native);
  });

  it("add -N writes the empty blob, so fsck and write-tree find it", async () => {
    const { native, ours } = twins((dir) => {
      fileAndX(dir);
      put(dir, "new", "content\n");
    });
    gitOk(root, native, "add", "-N", "new");
    const result = await (await g(ours)).add().addFilepattern("new").setIntentToAdd(true).call();
    expect(result.output).toEqual(["add 'new'"]);
    await same(ours, native);
    for (const dir of [native, ours]) {
      expect(gitOk(root, dir, "cat-file", "-t", "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391")).toBe(
        "blob\n",
      );
      expect(git(root, dir, "fsck", "--no-dangling").status).toBe(0);
      expect(git(root, dir, "write-tree").status).toBe(0);
    }
  });

  it("add -N . keeps a changed tracked file's entry, invalidating its cache-tree path", async () => {
    const { native, ours } = twins((dir) => {
      put(dir, "d/t", "t\n");
      put(dir, "e/u", "u\n");
      // never racily clean: an entry the same second as the index is hashed again
      for (const f of ["d/t", "e/u"]) utimesSync(join(dir, f), 1_000_000_000, 1_000_000_000);
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-q", "-m", "c");
      put(dir, "d/t", "changed\n");
      put(dir, "n", "new\n");
    });
    expect(await treeExtension(native)).not.toBe("");
    gitOk(root, native, "add", "-N", ".");
    await (await g(ours)).add().addFilepattern(".").setIntentToAdd(true).call();
    await same(ours, native);
  });

  it("refuses an element that names no file, changing nothing", async () => {
    for (const args of [["nope"], ["x", "nope"], ["-u", "nope"], ["build/*"]]) {
      const { native, ours } = twins((dir) => {
        fileAndX(dir);
        put(dir, "x", "changed\n");
      });
      const r = git(root, native, "add", ...args);
      expect(r.status).toBe(128);
      const cmd = (await g(ours)).add();
      for (const a of args) {
        if (a === "-u") cmd.setUpdate(true);
        else cmd.addFilepattern(a);
      }
      const error = await failure(cmd.call());
      expect(error?.message).toBe(r.stderr.trim());
      await same(ours, native);
    }
  });

  it("add -u refuses an element that matches nothing tracked", async () => {
    const { native, ours } = twins((dir) => {
      fileAndX(dir);
      put(dir, "untracked", "u\n");
      put(dir, "x", "changed\n");
    });
    const r = git(root, native, "add", "-u", "untracked", "x");
    const cmd = (await g(ours)).add().setUpdate(true);
    const error = await failure(cmd.addFilepattern("untracked").addFilepattern("x").call());
    const message = "error: pathspec 'untracked' did not match any file(s) known to git";
    expect(error?.message).toBe(message);
    // git 2.43 staged `x` and reported nothing (2.5x refuses, as ours)
    if (r.status === 0) return;
    expect(r.status).toBe(128);
    expect(r.stderr.trim()).toBe(message);
    await same(ours, native);
  });

  it("reports ignored paths named without -f, adding the others (exit status 1)", async () => {
    const build = (dir: string) => {
      fileAndX(dir);
      put(dir, ".gitignore", "build/\n*.ig\n");
      put(dir, "build/x", "x\n");
      put(dir, "build/deep/y", "y\n");
      put(dir, "sub/z.ig", "z\n");
      put(dir, "sub/w", "w\n");
    };
    for (const args of [
      ["build/x", "sub/z.ig", "sub/w"],
      ["build"],
      ["sub"],
      ["build/deep/y", "sub/*"],
    ]) {
      const { native, ours } = twins(build);
      const r = git(root, native, "add", ...args);
      const cmd = (await g(ours)).add();
      for (const a of args) cmd.addFilepattern(a);
      const error = await failure(cmd.call());
      if (r.status === 0) {
        expect(error).toBeUndefined();
      } else {
        expect(r.status).toBe(1);
        expect(error).toBeInstanceOf(AddFailedError);
        expect(withoutHints(error?.message ?? "")).toBe(withoutHints(r.stderr));
        expect((error as AddFailedError<AddResult>).result).toBeDefined();
      }
      await same(ours, native);
    }
    // with -f they are added
    const { native, ours } = twins(build);
    gitOk(root, native, "add", "-f", "build", "sub");
    await (await g(ours)).add().addFilepattern("build").addFilepattern("sub").setForce(true).call();
    await same(ours, native);
  });

  it("--dry-run tells what it would do and changes nothing; --ignore-missing", async () => {
    const build = (dir: string) => {
      fileAndX(dir);
      put(dir, ".gitignore", "build/\n");
      put(dir, "build/x", "x\n");
      put(dir, "x", "changed\n");
      put(dir, "n", "new\n");
      unlinkSync(join(dir, "a"));
    };
    {
      const { native, ours } = twins(build);
      const r = git(root, native, "add", "-n", ".");
      expect(r.status).toBe(0);
      const result = await (await g(ours)).add().addFilepattern(".").setDryRun(true).call();
      expect(result.output.join("\n")).toBe(r.stdout.trim());
      await same(ours, native);
    }
    {
      const { native, ours } = twins(build);
      const r = git(root, native, "add", "-n", "--ignore-missing", "build/nope", "nope", "n");
      expect(r.status).toBe(1);
      const error = await failure(
        (await g(ours))
          .add()
          .addFilepattern("build/nope")
          .addFilepattern("nope")
          .addFilepattern("n")
          .setDryRun(true)
          .setIgnoreMissing(true)
          .call(),
      );
      expect(withoutHints(error?.message ?? "")).toBe(withoutHints(r.stderr));
      const result = (error as AddFailedError<AddResult>).result;
      expect(result?.output.join("\n")).toBe(r.stdout.trim());
      await same(ours, native);
    }
    {
      const { ours } = twins(build);
      const error = await failure(
        (await g(ours)).add().addFilepattern("nope").setIgnoreMissing(true).call(),
      );
      expect(error?.message).toBe("fatal: the option '--ignore-missing' requires '--dry-run'");
    }
  });

  it("stages a repository inside the worktree as a gitlink, with git's warning", async () => {
    const { native, ours } = twins((dir) => {
      fileAndX(dir);
      nestedRepository(dir);
    });
    const r = git(root, native, "add", ".");
    expect(r.status).toBe(0);
    const result = await (await g(ours)).add().addFilepattern(".").call();
    expect(result.warnings[0]).toBe("warning: adding embedded git repository: sub");
    expect(withoutHints(result.warnings.join("\n"))).toBe(withoutHints(r.stderr));
    expect(gitOk(root, ours, "ls-files", "-s", "sub")).toMatch(/^160000 /);
    await same(ours, native);
  });

  it("refuses a repository without a commit checked out, changing nothing", async () => {
    for (const args of [["."], ["sub"], ["--ignore-errors", "."]]) {
      const { native, ours } = twins((dir) => {
        fileAndX(dir);
        put(dir, "x", "changed\n");
        nestedRepository(dir, "sub", false);
      });
      const r = git(root, native, "add", ...args);
      const cmd = (await g(ours)).add();
      for (const a of args) {
        if (a === "--ignore-errors") cmd.setIgnoreErrors(true);
        else cmd.addFilepattern(a);
      }
      const error = await failure(cmd.call());
      expect(error).toBeInstanceOf(AddFailedError);
      // 2.43 has no "unable to index file" line
      const lines = (text: string) =>
        text
          .trim()
          .split("\n")
          .filter((l) => !l.startsWith("error: unable to index file"));
      expect(lines(error?.message ?? "")).toEqual(lines(r.stderr));
      if (args[0] === "--ignore-errors") {
        expect(r.status).toBe(1);
        expect((error as AddFailedError<AddResult>).failedPaths).toEqual(["sub"]);
      } else {
        expect(r.status).toBe(128);
      }
      await same(ours, native);
    }
  });

  it("a submodule's gitlink follows the commit checked out there", async () => {
    const { native, ours } = twins((dir) => {
      fileAndX(dir);
      nestedRepository(dir);
      gitOk(root, dir, "add", "sub");
      gitOk(root, dir, "commit", "-q", "-m", "with sub");
      put(dir, "sub/s2", "s2\n");
      gitOk(root, join(dir, "sub"), "add", "s2");
      gitOk(root, join(dir, "sub"), "commit", "-q", "-m", "s2");
    });
    gitOk(root, native, "add", "-u");
    await (await g(ours)).add().setUpdate(true).call();
    await same(ours, native);
    const { native: n2, ours: o2 } = twins((dir) => {
      fileAndX(dir);
      nestedRepository(dir);
      gitOk(root, dir, "add", "sub");
      gitOk(root, dir, "commit", "-q", "-m", "with sub");
      put(dir, "sub/s2", "s2\n");
      gitOk(root, join(dir, "sub"), "add", "s2");
      gitOk(root, join(dir, "sub"), "commit", "-q", "-m", "s2");
    });
    gitOk(root, n2, "add", "sub");
    await (await g(o2)).add().addFilepattern("sub").call();
    await same(o2, n2);
  });

  it("--renormalize invalidates the cache-tree path of every file it adds again", async () => {
    const { native, ours } = twins((dir) => {
      put(dir, "d/crlf.txt", "a\r\nb\r\n");
      // its content stays the same: git invalidates `e` all the same
      put(dir, "e/lf.txt", "a\nb\n");
      put(dir, "f/other.bin", "x\r\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-q", "-m", "c");
      put(dir, ".gitattributes", "*.txt text\n");
    });
    expect(await treeExtension(native)).not.toBe("");
    gitOk(root, native, "add", "--renormalize", "d", "e");
    await (await g(ours)).add().addFilepattern("d").addFilepattern("e").setRenormalize(true).call();
    await same(ours, native);
  });

  it("stash push records ORIG_HEAD, as its reset --hard does", async () => {
    const { native, ours } = twins((dir) => {
      fileAndX(dir);
      put(dir, "x", "x2\n");
      gitOk(root, dir, "commit", "-q", "-a", "-m", "c2");
      put(dir, "x", "dirty\n");
    });
    gitOk(root, native, "stash", "push", "-q");
    expect(await (await g(ours)).stashCreate().call()).toBeDefined();
    const orig = (dir: string) => readFileSync(join(dir, ".git/ORIG_HEAD"), "utf8");
    expect(orig(ours)).toBe(orig(native));
    expect(orig(ours).trim()).toBe(gitOk(root, ours, "rev-parse", "HEAD").trim());
    expect(gitOk(root, ours, "ls-files", "-s")).toBe(gitOk(root, native, "ls-files", "-s"));
  });
  it("add . stages linked worktrees made inside the repository as gitlinks", async () => {
    // `git worktree add` writes an absolute gitdir; this repository's own layout included
    const { native, ours } = twins((dir) => {
      fileAndX(dir);
      gitOk(root, dir, "worktree", "add", "-q", "wt");
      gitOk(root, dir, "worktree", "add", "-q", "-b", "feat", ".claude/worktrees/feat");
    });
    const r = git(root, native, "add", "-v", ".");
    expect(r.status).toBe(0);
    const result = await ourAdd(await g(ours), ["-v", "."]);
    expect(result.output).toEqual(stdoutLines(r.stdout));
    expect(withoutHints(result.warnings.join("\n"))).toBe(withoutHints(r.stderr));
    expect(gitOk(root, ours, "ls-files", "-s")).toBe(gitOk(root, native, "ls-files", "-s"));
    expect(await treeExtension(ours)).toBe(await treeExtension(native));
    // -A and a glob alike
    for (const args of [["-A"], ["*"]]) {
      const { native: n, ours: o } = twins((dir) => {
        fileAndX(dir);
        gitOk(root, dir, "worktree", "add", "-q", "wt");
      });
      gitOk(root, n, "add", ...args);
      await ourAdd(await g(o), args);
      expect(gitOk(root, o, "ls-files", "-s")).toBe(gitOk(root, n, "ls-files", "-s"));
    }
  });

  it("skips, with a warning, a repository whose .git names a place outside the storage", async () => {
    const outside = join(root, `outside${counter}`);
    gitOk(root, root, "init", "-q", "-b", "main", outside);
    put(outside, "o", "o\n");
    gitOk(root, outside, "add", "o");
    gitOk(root, outside, "commit", "-q", "-m", "o");
    const { native, ours } = twins((dir) => {
      fileAndX(dir);
      put(dir, "n", "n\n");
      gitOk(root, outside, "worktree", "add", "-q", "--detach", join(dir, "ext"));
    });
    gitOk(root, native, "add", ".");
    const result = await ourAdd(await g(ours), ["."]);
    expect(result.warnings).toEqual([
      "warning: skipping 'ext/': the repository its .git names cannot be read here",
    ]);
    // git stages the gitlink; everything else alike
    const withoutExt = (text: string) =>
      text
        .split("\n")
        .filter((l) => !l.endsWith("\text"))
        .join("\n");
    expect(gitOk(root, ours, "ls-files", "-s")).toBe(
      withoutExt(gitOk(root, native, "ls-files", "-s")),
    );
    expect(gitOk(root, native, "ls-files", "-s", "ext")).toMatch(/^160000 /);
  });

  it("refuses a tracked file replaced by a repository without a commit, changing nothing", async () => {
    for (const args of [["."], ["a"], ["-A"], [":(icase)A"], ["-v", "."], ["-n", "."]]) {
      const { native, ours } = twins(fileToRepository(false));
      const r = git(root, native, "add", ...args);
      expect(r.status).toBe(128);
      const error = await failure(ourAdd(await g(ours), args));
      expect(error).toBeInstanceOf(AddFailedError);
      expect(errorLines(error?.message ?? "")).toEqual(errorLines(r.stderr));
      // what -v / -n printed before it failed
      if (args.length > 1) expect((error as AddFailedError).output).toEqual(stdoutLines(r.stdout));
      await same(ours, native);
    }
  });

  it("add . warns of a tracked file replaced by a repository with a commit, added once", async () => {
    const { native, ours } = twins(fileToRepository(true));
    const r = git(root, native, "add", "-v", ".");
    expect(r.status).toBe(0);
    const result = await ourAdd(await g(ours), ["-v", "."]);
    expect(result.output).toEqual(stdoutLines(r.stdout));
    expect(result.added.filter((p) => p === "a")).toEqual(["a"]);
    expect(result.warnings[0]).toBe("warning: adding embedded git repository: a");
    expect(withoutHints(result.warnings.join("\n"))).toBe(withoutHints(r.stderr));
    await same(ours, native);
  });

  it("adds the files of a directory whose .git is no repository, removing the file", async () => {
    const corrupt: Array<(dir: string) => void> = [
      // a .git directory with an invalid HEAD
      (dir) => {
        put(dir, "a/.git/HEAD", "junk\n");
        mkdirSync(join(dir, "a/.git/objects"));
        mkdirSync(join(dir, "a/.git/refs"));
      },
      // a gitfile naming no repository
      (dir) => put(dir, "a/.git", "gitdir: nowhere\n"),
    ];
    for (const make of corrupt) {
      for (const args of [["-v", "."], ["-A"]]) {
        const { native, ours } = twins((dir) => {
          fileAndX(dir);
          unlinkSync(join(dir, "a"));
          make(dir);
          put(dir, "a/inner", "i\n");
        });
        const r = git(root, native, "add", ...args);
        expect(r.status).toBe(0);
        const result = await ourAdd(await g(ours), args);
        if (args[0] === "-v") expect(result.output).toEqual(stdoutLines(r.stdout));
        await same(ours, native);
      }
    }
  });

  it("refuses an element beyond a symbolic link, changing nothing", async () => {
    for (const args of [["e/f/g"], ["z", "e/f/g"], ["e/y"], [":!e/f"], [":(glob)e/*"], ["lnk/"]]) {
      const { native, ours } = twins((dir) => {
        fileAndX(dir);
        put(dir, "t/y", "y\n");
        symlinkSync("t", join(dir, "e"));
        symlinkSync("x", join(dir, "lnk"));
        put(dir, "z", "z\n");
      });
      const r = git(root, native, "add", ...args);
      expect(r.status).toBe(128);
      const error = await failure(ourAdd(await g(ours), args));
      expect(error?.message).toBe(r.stderr.trim());
      await same(ours, native);
    }
  });

  it("an element ending in a slash names a directory only", async () => {
    for (const args of [["a/"], ["x/", "a"], ["nope/"], ["sm/"]]) {
      const { native, ours } = twins((dir) => {
        fileAndX(dir);
        put(dir, "a", "changed\n");
        mkdirSync(join(dir, "sm"));
      });
      const r = git(root, native, "add", ...args);
      const error = await failure(ourAdd(await g(ours), args));
      if (r.status === 0) expect(error).toBeUndefined();
      else {
        expect(r.status).toBe(128);
        expect(error?.message).toBe(r.stderr.trim());
      }
      await same(ours, native);
    }
  });

  it("--renormalize as git: a pathspec required, every file reported, its failures", async () => {
    const build = (dir: string) => {
      fileAndX(dir);
      put(dir, "d/t", "t\n");
      gitOk(root, dir, "add", ".");
      gitOk(root, dir, "commit", "-q", "-m", "d");
      put(dir, ".gitignore", "ig/\n");
    };
    {
      const { native, ours } = twins(build);
      const r = git(root, native, "add", "--renormalize");
      expect(r.status).toBe(0);
      const error = await failure(ourAdd(await g(ours), ["--renormalize"]));
      expect(error).toBeInstanceOf(NoFilepatternError);
      expect(error?.message).toBe(r.stderr.split("\n")[0]);
      await same(ours, native);
    }
    for (const args of [
      ["-v", "."],
      ["-n", "d"],
      ["-n", "--ignore-missing", "nope", "ig/z", "d"],
    ]) {
      const { native, ours } = twins(build);
      const r = git(root, native, "add", "--renormalize", ...args);
      expect(r.status).toBe(0);
      const result = await ourAdd(await g(ours), ["--renormalize", ...args]);
      expect(result.output).toEqual(stdoutLines(r.stdout));
      await same(ours, native);
    }
    // a tracked file gone: fatal, nothing written
    {
      const { native, ours } = twins((dir) => {
        build(dir);
        unlinkSync(join(dir, "a"));
      });
      const r = git(root, native, "add", "--renormalize", ".");
      expect(r.status).toBe(128);
      const error = await failure(ourAdd(await g(ours), ["--renormalize", "."]));
      expect(error?.message).toBe(r.stderr.trim());
      await same(ours, native);
    }
    // a tracked file replaced by a directory: an error, the others added; a repository with
    // a commit: its gitlink
    for (const make of [
      (dir: string) => put(dir, "a/i", "i\n"),
      (dir: string) => nestedRepository(dir, "a"),
    ]) {
      const { native, ours } = twins((dir) => {
        build(dir);
        unlinkSync(join(dir, "a"));
        make(dir);
      });
      const r = git(root, native, "add", "--renormalize", "-v", ".");
      const error = await failure(ourAdd(await g(ours), ["--renormalize", "-v", "."]));
      if (r.status === 0) {
        expect(error).toBeUndefined();
      } else {
        expect(error).toBeInstanceOf(AddFailedError);
        expect(errorLines(error?.message ?? "")).toEqual(errorLines(r.stderr));
        expect((error as AddFailedError<AddResult>).result?.output).toEqual(stdoutLines(r.stdout));
      }
      await same(ours, native);
    }
  });

  it("refuses a tracked file replaced by a FIFO, as add -u, add . and commit -a do", async () => {
    for (const args of [["-u"], ["."], ["--ignore-errors", "-u"], ["commit"]]) {
      const { native, ours } = twins((dir) => {
        fileAndX(dir);
        unlinkSync(join(dir, "a"));
        execFileSync("mkfifo", [join(dir, "a")]);
      });
      const r =
        args[0] === "commit"
          ? git(root, native, "commit", "-q", "-a", "-m", "c2")
          : git(root, native, "add", ...args);
      const error = await failure(
        args[0] === "commit"
          ? (await g(ours)).commit().setAll(true).setMessage("c2\n").call()
          : ourAdd(await g(ours), args),
      );
      expect(error?.message).toBe(r.stderr.trim());
      expect(r.status).toBe(args[0] === "--ignore-errors" ? 1 : 128);
      // a FIFO is not read by the snapshot
      for (const dir of [native, ours]) unlinkSync(join(dir, "a"));
      expect(gitOk(root, ours, "ls-files", "-s")).toBe(gitOk(root, native, "ls-files", "-s"));
      expect(gitOk(root, ours, "rev-parse", "HEAD")).toBe(gitOk(root, native, "rev-parse", "HEAD"));
    }
  });
  it("-n --ignore-missing reports a missing element under an ignored directory as given", async () => {
    for (const args of [["build/nope/"], ["missingdir/"], ["ign/x", "build/nope"]]) {
      const { native, ours } = twins((dir) => {
        fileAndX(dir);
        put(dir, ".gitignore", "build/\nign\nmissingdir/\n");
        put(dir, "build/x", "x\n");
        put(dir, "ign/x", "x\n");
      });
      const r = git(root, native, "add", "-n", "--ignore-missing", ...args);
      expect(r.status).toBe(1);
      const error = await failure(ourAdd(await g(ours), ["-n", "--ignore-missing", ...args]));
      expect(error).toBeInstanceOf(AddFailedError);
      expect(withoutHints(error?.message ?? "")).toBe(withoutHints(r.stderr));
      await same(ours, native);
    }
  });

  it("stages a tracked file turned repository whose HEAD or .git is a link (-u, -A, .)", async () => {
    const variants: Array<(dir: string) => void> = [
      // core.preferSymlinkRefs: HEAD a link into refs/
      (dir) => {
        fileToRepository(true)(dir);
        unlinkSync(join(dir, "a/.git/HEAD"));
        symlinkSync("refs/heads/main", join(dir, "a/.git/HEAD"));
      },
      // `a/.git` a link to a repository inside the worktree
      (dir) => {
        fileAndX(dir);
        unlinkSync(join(dir, "a"));
        nestedRepository(dir, "real");
        mkdirSync(join(dir, "a"));
        symlinkSync("../real/.git", join(dir, "a/.git"));
      },
    ];
    for (const make of variants) {
      for (const args of [["-u"], ["-A"], ["-v", "."]]) {
        const { native, ours } = twins(make);
        const r = git(root, native, "add", ...args);
        expect(r.status).toBe(0);
        expect(gitOk(root, native, "ls-files", "-s", "a")).toMatch(/^160000 /);
        const result = await ourAdd(await g(ours), args);
        if (args[0] === "-v") expect(result.output).toEqual(stdoutLines(r.stdout));
        expect(withoutHints(result.warnings.join("\n"))).toBe(withoutHints(r.stderr));
        await same(ours, native);
      }
    }
  });

  it("adds the files of a directory whose .git names no git directory (objects, refs, commondir)", async () => {
    const corrupt: Array<(dir: string) => void> = [
      // a gitfile naming a directory with only a HEAD
      (dir) => {
        put(dir, "g/HEAD", "ref: refs/heads/main\n");
        put(dir, "a/.git", "gitdir: ../g\n");
      },
      // a linked worktree's gitdir whose commondir is gone
      (dir) => {
        put(dir, "g/HEAD", "ref: refs/heads/main\n");
        put(dir, "g/commondir", "../missing\n");
        put(dir, "a/.git", "gitdir: ../g\n");
      },
      // a `.git` link to a directory that is no repository
      (dir) => {
        put(dir, "plain/p", "p\n");
        mkdirSync(join(dir, "a"));
        symlinkSync("../plain", join(dir, "a/.git"));
      },
    ];
    for (const make of corrupt) {
      for (const args of [["-v", "."], ["-u"], ["-A"]]) {
        const { native, ours } = twins((dir) => {
          fileAndX(dir);
          unlinkSync(join(dir, "a"));
          make(dir);
          put(dir, "a/inner", "i\n");
        });
        const r = git(root, native, "add", ...args);
        expect(r.status).toBe(0);
        const result = await ourAdd(await g(ours), args);
        if (args[0] === "-v") expect(result.output).toEqual(stdoutLines(r.stdout));
        await same(ours, native);
      }
    }
  });

  it("dies on an empty commondir, as git's get_common_dir, changing nothing", async () => {
    for (const args of [["-u"], ["-v", "."]]) {
      const { native, ours } = twins((dir) => {
        fileAndX(dir);
        unlinkSync(join(dir, "a"));
        mkdirSync(join(dir, "g/objects"), { recursive: true });
        mkdirSync(join(dir, "g/refs"));
        put(dir, "g/HEAD", "ref: refs/heads/main\n");
        put(dir, "g/commondir", "");
        put(dir, "a/.git", "gitdir: ../g\n");
      });
      const index = (dir: string) => readFileSync(join(dir, ".git/index")).toString("hex");
      const before = { native: index(native), ours: index(ours) };
      const r = git(root, native, "add", ...args);
      expect(r.status).toBe(128);
      const error = await failure(ourAdd(await g(ours), args));
      // git's errno text follows (a stale one: it varies)
      expect(error?.message).toBe("fatal: failed to read a/../g/commondir");
      expect(r.stderr.startsWith(`${error?.message}:`)).toBe(true);
      // git status dies there too: each index is left as it was
      expect({ native: index(native), ours: index(ours) }).toEqual(before);
      expect(gitOk(root, ours, "ls-files", "-s")).toBe(gitOk(root, native, "ls-files", "-s"));
    }
  });

  it("-n . tells of a tracked file turned repository twice, as tracked and as untracked", async () => {
    const { native, ours } = twins(fileToRepository(true));
    const r = git(root, native, "add", "-n", ".");
    expect(r.status).toBe(0);
    const result = await ourAdd(await g(ours), ["-n", "."]);
    expect(result.output).toEqual(stdoutLines(r.stdout));
    await same(ours, native);
  });

  it("--renormalize keeps the errors printed before a tracked file it cannot stat", async () => {
    const { native, ours } = twins((dir) => {
      fileAndX(dir);
      unlinkSync(join(dir, "a"));
      put(dir, "a/i", "i\n");
      unlinkSync(join(dir, "x"));
    });
    const r = git(root, native, "add", "--renormalize", ".");
    expect(r.status).toBe(128);
    const error = await failure(ourAdd(await g(ours), ["--renormalize", "."]));
    expect(error).toBeInstanceOf(AddFailedError);
    expect(errorLines(error?.message ?? "")).toEqual(errorLines(r.stderr));
    await same(ours, native);
  });

  it("refuses a path with a .GIT component as git's verify_path, --ignore-errors going on", async () => {
    for (const args of [
      ["-v", "."],
      ["--ignore-errors", "-v", "."],
      ["u/.GIT/x"],
      ["-A"],
      ["-n", "."],
    ]) {
      const { native, ours } = twins((dir) => {
        fileAndX(dir);
        put(dir, "x", "changed\n");
        put(dir, "u/.GIT/x", "x\n");
        put(dir, "b", "b\n");
        put(dir, "u/y", "y\n");
      });
      const r = git(root, native, "add", ...args);
      const run = failure(ourAdd(await g(ours), args));
      const error = await run;
      if (r.status === 0) expect(error).toBeUndefined();
      else {
        expect(error).toBeInstanceOf(AddFailedError);
        expect(error?.message).toBe(r.stderr.trim());
        const failed = error as AddFailedError<AddResult>;
        const printed = r.status === 1 ? failed.result?.output : failed.output;
        if (args.includes("-v")) expect(printed).toEqual(stdoutLines(r.stdout));
        expect(r.status).toBe(args[0] === "--ignore-errors" ? 1 : 128);
      }
      await same(ours, native);
    }
  });

  it("AddFailedError carries the warnings printed before the failure", async () => {
    const { native, ours } = twins((dir) => {
      fileAndX(dir);
      nestedRepository(dir, "sub");
      put(dir, "u/.GIT/x", "x\n");
    });
    const r = git(root, native, "add", ".");
    expect(r.status).toBe(128);
    const error = await failure(ourAdd(await g(ours), ["."]));
    expect(error).toBeInstanceOf(AddFailedError);
    const before = r.stderr.slice(0, r.stderr.indexOf("error: "));
    expect(before).toContain("warning: adding embedded git repository: sub");
    expect(withoutHints((error as AddFailedError).warnings.join("\n"))).toBe(withoutHints(before));
    await same(ours, native);
  });
});
