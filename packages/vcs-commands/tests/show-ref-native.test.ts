/**
 * `git show-ref` (builtin/show-ref.c), native twins: t1403-show-ref.sh, t1422-show-ref-exists.sh
 * and the listing's corners (abbreviations, broken refs, `--exclude-existing`), each run by
 * native git and by ours on the same repository with git as the oracle (stdout, stderr and
 * exit status compared).
 */

import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Git, ShowRefCommand } from "../src/index.js";
import { compatibilityOf, type Outcome, Shell } from "./describe-native-support.js";
import { openOurs } from "./merge-native-helpers.js";
import { nativeGitAvailable } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root: string;
let shell: Shell;
let compatibility: "2.43" | "2.56";
let counter = 0;

/** `git show-ref <argv>` mapped onto our ShowRefCommand (parse_options' order: last wins). */
function showRefArgs(git: Git, argv: string[], input?: string): ShowRefCommand {
  const command = git.showRef().setCompatibility(compatibility);
  if (input !== undefined) command.setStdin(input);
  let options = true;
  for (const arg of argv) {
    if (!options || !arg.startsWith("-")) {
      command.addPattern(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const [opt, value] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    switch (opt) {
      case "--":
        options = false;
        break;
      case "--tags":
        command.setTags(true);
        break;
      case "--heads":
      case "--branches":
        command.setBranches(true);
        break;
      case "--head":
      case "-h":
        command.setHead(true);
        break;
      case "--exists":
        command.setExists(true);
        break;
      case "--verify":
        command.setVerify(true);
        break;
      case "-d":
      case "--dereference":
        command.setDereference(true);
        break;
      case "-s":
      case "--hash":
        command.setHash(value === undefined ? undefined : Number(value));
        break;
      case "--abbrev":
        command.setAbbrev(value === undefined ? undefined : Number(value));
        break;
      case "--no-abbrev":
        command.setAbbrev(0);
        break;
      case "-q":
      case "--quiet":
        command.setQuiet(true);
        break;
      case "--exclude-existing":
        command.setExcludeExisting(value);
        break;
      default:
        throw new Error(`unmapped option ${arg}`);
    }
  }
  return command;
}

/** `git show-ref <argv>` in `dir`, native and ours, compared; native's outcome. */
async function check(dir: string, argv: string[], input?: string): Promise<Outcome> {
  const native = shell.git(dir, ["show-ref", ...argv], input !== undefined ? { input } : {});
  const git = await openOurs(dir);
  const out = await showRefArgs(git, argv, input).callOutput();
  const ours: Outcome = {
    status: out.exitCode,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: out.stderr,
  };
  expect({ argv, ...ours }).toEqual({ argv, ...native });
  return native;
}

/** A new repository (`main` its initial branch). */
function repository(name: string, ...initArgs: string[]): string {
  const dir = join(root, `${name}-${counter++}`);
  shell.ok(root, "init", "-q", "-b", "main", ...initArgs, dir);
  return dir;
}

/** t1403's and t1422's setup: A and B annotated, C lightweight, branch B at A. */
function t1403Setup(name: string, ...initArgs: string[]): string {
  const dir = repository(name, ...initArgs);
  shell.commit(dir, "--annotate", "A");
  shell.ok(dir, "checkout", "-q", "-b", "side");
  shell.commit(dir, "--annotate", "B");
  shell.ok(dir, "checkout", "-q", "main");
  shell.commit(dir, "C");
  shell.ok(dir, "branch", "B", "A^0");
  return dir;
}

/** Whether native git can create reftable repositories (2.45+). */
function nativeReftable(): boolean {
  return shell.git(root, ["init", "-q", "--ref-format=reftable", join(root, "probe")]).status === 0;
}

describeGit("git show-ref, native twins", () => {
  let dir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "show-ref-native-"));
    shell = new Shell(root);
    compatibility = compatibilityOf(shell);
    dir = t1403Setup("t1403");
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("t1403-show-ref.sh", () => {
    it('t1403-show-ref.sh: "show-ref"', async () => {
      await check(dir, ["A"]);
      await check(dir, ["tags/A"]);
      await check(dir, ["refs/tags/A"]);
      await check(dir, ["D"]);
    });

    it('t1403-show-ref.sh: "show-ref -q"', async () => {
      for (const p of ["A", "tags/A", "refs/tags/A", "D"]) await check(dir, ["-q", p]);
    });

    it('t1403-show-ref.sh: "show-ref --verify"', async () => {
      for (const p of ["refs/tags/A", "A", "tags/A", "D"]) await check(dir, ["--verify", p]);
    });

    it('t1403-show-ref.sh: "show-ref --verify -q"', async () => {
      for (const p of ["refs/tags/A", "A", "tags/A", "D"]) {
        await check(dir, ["--verify", "-q", p]);
      }
    });

    it('t1403-show-ref.sh: "show-ref -d"', async () => {
      await check(dir, ["-d", "A", "C"]);
      await check(dir, ["-d", "tags/A", "tags/C"]);
      await check(dir, ["-d", "refs/tags/A", "refs/tags/C"]);
      await check(dir, ["--verify", "-d", "refs/tags/A", "refs/tags/C"]);
      await check(dir, ["-d", "main"]);
      await check(dir, ["-d", "heads/main"]);
      await check(dir, ["-d", "refs/heads/main"]);
      await check(dir, ["-d", "--verify", "refs/heads/main"]);
      await check(dir, ["-d", "--verify", "main"]);
      await check(dir, ["-d", "--verify", "heads/main"]);
      await check(dir, ["--verify", "-d", "A", "C"]);
      await check(dir, ["--verify", "-d", "tags/A", "tags/C"]);
    });

    it('t1403-show-ref.sh: "show-ref --branches, --tags, --head, pattern"', async () => {
      // --branches is git 2.46's spelling of --heads
      const branches = compatibility === "2.43" ? "--heads" : "--branches";
      await check(dir, [branches]);
      await check(dir, ["--tags"]);
      await check(dir, [branches, "--tags"]);
      await check(dir, [branches, "--tags", "--head"]);
      await check(dir, ["--head", "B"]);
      await check(dir, ["--head", "-d", "B"]);
    });

    it('t1403-show-ref.sh: "show-ref --heads is deprecated and hidden"', async () => {
      await check(dir, ["--heads"]);
    });

    it('t1403-show-ref.sh: "show-ref --verify HEAD"', async () => {
      await check(dir, ["--verify", "HEAD"]);
      await check(dir, ["--verify", "-q", "HEAD"]);
    });

    it('t1403-show-ref.sh: "show-ref --verify pseudorefs"', async () => {
      const d = t1403Setup("pseudo");
      shell.ok(d, "update-ref", "CHERRY_PICK_HEAD", "HEAD");
      await check(d, ["-s", "--verify", "HEAD"]);
      await check(d, ["-s", "--verify", "CHERRY_PICK_HEAD"]);
    });

    it('t1403-show-ref.sh: "show-ref --verify with dangling ref"', async () => {
      const d = repository("dangling");
      shell.commit(d, "dangling");
      const id = shell.ok(d, "rev-parse", "refs/tags/dangling").trim();
      unlinkSync(join(d, ".git", "objects", id.slice(0, 2), id.slice(2)));
      await check(d, ["--verify", "refs/tags/dangling"]);
    });

    it('t1403-show-ref.sh: "show-ref sub-modes are mutually exclusive"', async () => {
      await check(dir, ["--verify", "--exclude-existing"]);
      await check(dir, ["--verify", "--exists"]);
      await check(dir, ["--exclude-existing", "--exists"]);
      await check(dir, ["--exists", "--verify", "--exclude-existing"]);
    });
  });

  // t1422-show-ref-exists.sh (its cases live in show-ref-exists-tests.sh from 2.47 on)
  describe("t1422-show-ref-exists.sh", () => {
    it("--exists with existing, missing and DWIM names", async () => {
      await check(dir, ["--exists", "refs/heads/main"]);
      await check(dir, ["--exists", "refs/heads/does-not-exist"]);
      await check(dir, ["--exists", "main"]);
      await check(dir, ["--exists", "HEAD"]);
      await check(dir, ["--exists"]);
      await check(dir, ["--exists", "refs/heads/main", "refs/heads/side"]);
    });

    it("--exists with symrefs, missing objects and non-commits", async () => {
      const d = t1403Setup("exists");
      shell.ok(d, "symbolic-ref", "refs/symref", "refs/heads/main");
      shell.ok(d, "symbolic-ref", "refs/heads/dangling", "refs/heads/does-not-exist");
      writeFileSync(join(d, ".git/refs/heads/missing-oid"), `${"0".repeat(39)}1\n`);
      const tree = shell.ok(d, "rev-parse", "HEAD^{tree}").trim();
      writeFileSync(join(d, ".git/refs/heads/tree"), `${tree}\n`);
      for (const ref of [
        "refs/symref",
        "refs/heads/dangling",
        "refs/heads/missing-oid",
        "refs/heads/tree",
      ]) {
        await check(d, ["--exists", ref]);
      }
    });

    it("--exists with a directory and with special refs", async () => {
      const d = t1403Setup("exists-special");
      // a directory: git's generic error (the files backend's EISDIR)
      await check(d, ["--exists", "refs/heads"]);
      await check(d, ["--exists", "FETCH_HEAD"]);
      writeFileSync(join(d, ".git/FETCH_HEAD"), shell.ok(d, "rev-parse", "HEAD"));
      await check(d, ["--exists", "FETCH_HEAD"]);
      await check(d, ["--exists", "MERGE_HEAD"]);
      writeFileSync(join(d, ".git/ORIG_HEAD"), shell.ok(d, "rev-parse", "side"));
      await check(d, ["--exists", "ORIG_HEAD"]);
      await check(d, ["--verify", "ORIG_HEAD"]);
    });
  });

  describe("listing", () => {
    it("lists every ref, symbolic refs at their target, HEAD only with --head", async () => {
      const d = t1403Setup("list");
      shell.ok(d, "update-ref", "refs/remotes/origin/main", "HEAD");
      shell.ok(d, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
      shell.ok(d, "update-ref", "refs/notes/x", "HEAD");
      await check(d, []);
      await check(d, ["-d"]);
      await check(d, ["--head"]);
      await check(d, ["main"]);
      await check(d, ["ain"]);
      await check(d, ["in/main"]);
      await check(d, ["origin/HEAD"]);
      await check(d, ["--tags", "main"]);
      await check(d, ["--", "main"]);
      await check(d, ["-q"]);
      shell.ok(d, "pack-refs", "--all");
      await check(d, ["-d"]);
      shell.ok(d, "tag", "-a", "-m", "nested", "N", "refs/tags/A");
      shell.ok(d, "tag", "T", "HEAD^{tree}");
      await check(d, ["-d", "--tags"]);
    });

    it("--hash and --abbrev", async () => {
      await check(dir, ["-s", "main"]);
      await check(dir, ["--hash=3", "main"]);
      await check(dir, ["--hash=10", "main"]);
      await check(dir, ["--hash=0", "main"]);
      await check(dir, ["--abbrev", "main"]);
      await check(dir, ["--abbrev=5", "-d", "A"]);
      await check(dir, ["--abbrev=50", "main"]);
      await check(dir, ["--abbrev=8", "--no-abbrev", "main"]);
      await check(dir, ["--abbrev=8", "--hash", "main"]);
      await check(dir, ["--hash=9", "--abbrev=5", "main"]);
      await check(dir, ["--verify", "--abbrev=6", "-d", "refs/tags/B"]);
      const d = t1403Setup("core-abbrev");
      shell.ok(d, "config", "core.abbrev", "12");
      await check(d, ["--abbrev", "main"]);
      await check(d, ["-s", "main"]);
    });

    it("an unborn HEAD, a detached HEAD", async () => {
      const unborn = repository("unborn");
      await check(unborn, []);
      await check(unborn, ["--head"]);
      await check(unborn, ["--verify", "HEAD"]);
      await check(unborn, ["--exists", "HEAD"]);
      const d = t1403Setup("detached");
      shell.ok(d, "checkout", "-q", "--detach", "side");
      await check(d, ["--head", "-s"]);
      await check(d, ["--head", "main"]);
    });

    it("dangling symbolic refs are skipped, a missing object is fatal", async () => {
      const d = t1403Setup("broken");
      shell.ok(d, "symbolic-ref", "refs/heads/dangling", "refs/heads/none");
      await check(d, []);
      await check(d, ["dangling"]);
      await check(d, ["--verify", "refs/heads/dangling"]);
      writeFileSync(join(d, ".git/refs/heads/missing"), `${"0".repeat(39)}1\n`);
      await check(d, []);
      await check(d, ["main"]);
      await check(d, ["missing"]);
      await check(d, ["-q"]);
      await check(d, ["--verify", "refs/heads/missing"]);
    });

    it("--verify takes exact names", async () => {
      for (const name of ["../x", "refs/heads/../x", "foo", "ORIG_HEAD", "refs/heads/side"]) {
        await check(dir, ["--verify", name]);
      }
      await check(dir, ["--verify"]);
      await check(dir, ["--verify", "-q", "refs/heads/main", "refs/heads/none", "HEAD"]);
      await check(dir, ["--verify", "refs/heads/main", "refs/heads/none"]);
    });
  });

  describe("--exclude-existing", () => {
    const input = [
      "x refs/heads/main",
      "y refs/heads/new",
      "refs/tags/B^{}",
      "z refs/tags/new^{}",
      "bad..name",
      "q  refs/heads/x",
      "refs/heads",
      "",
      "tab\trefs/remotes/r",
      "",
    ].join("\n");

    it("prints the lines naming refs the repository lacks", async () => {
      await check(dir, ["--exclude-existing"], input);
      await check(dir, ["--exclude-existing=refs/heads"], input);
      await check(dir, ["--exclude-existing=refs/heads/new"], input);
      await check(dir, ["--exclude-existing=x"], input);
      await check(dir, ["--exclude-existing"], "no newline refs/heads/b");
      await check(dir, ["--exclude-existing"], "");
    });
  });

  describe("other repository formats", () => {
    it("SHA-256 repositories", async () => {
      const d = t1403Setup("sha256", "--object-format=sha256");
      await check(d, ["-d", "--head"]);
      await check(d, ["--abbrev", "-d", "A"]);
      await check(d, ["--hash=70", "main"]);
      await check(d, ["--verify", "refs/heads/main"]);
      await check(d, ["--exists", "refs/heads/nope"]);
    });

    it("reftable repositories (git 2.45+)", async (context) => {
      if (!nativeReftable()) context.skip();
      const d = t1403Setup("reftable", "--ref-format=reftable");
      shell.ok(d, "symbolic-ref", "refs/heads/dangling", "refs/heads/none");
      await check(d, ["-d", "--head"]);
      await check(d, ["--verify", "refs/tags/A", "-d"]);
      await check(d, ["--exists", "refs/heads"]);
      await check(d, ["--exists", "refs/heads/dangling"]);
      await check(d, ["--exists", "refs/heads/nope"]);
    });
  });
});
