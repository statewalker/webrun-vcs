/**
 * Arguments that may be revisions or paths, against native git: `git rev-parse <args>`
 * (`RevParseCommand.addArgument`) and `git log <args>` without `--` (`RevListCommand
 * .addArgument`): git's `verify_filename` / `verify_non_filename` and the diagnosis of a
 * misspelt revision (`maybe_die_on_misspelt_object_name`), stdout, stderr and status
 * compared, from the top and from a subdirectory.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Git, RevisionError } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

let root = "";
let home = "";
let repo = "";

const run = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: nativeGitEnv(home), encoding: "latin1" });
const put = (path: string, content: string) => {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), content);
};

async function open(): Promise<Git> {
  const files = createNodeFilesApi({ rootDir: repo });
  const environment = createNodeGitHostEnvironment({ env: nativeGitEnv(home) });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git" });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  return Git.fromWorkingCopy(await worktrees.openCurrent());
}

type Outcome = { status: number; out: string; err: string };

function failure(error: unknown): Outcome {
  const output = error instanceof RevisionError ? error.output : [];
  return {
    status: 128,
    out: output.map((l) => `${l}\n`).join(""),
    err: `${(error as Error).message}\n`,
  };
}

/** `git rev-parse <args>` in `prefix` by native git and by ours. */
async function expectSameRevParse(cases: string[][], prefix = ""): Promise<void> {
  const git = await open();
  for (const args of cases) {
    const n = spawnSync("git", ["rev-parse", ...args], {
      cwd: join(repo, prefix),
      env: nativeGitEnv(home),
      encoding: "latin1",
    });
    let ours: Outcome;
    try {
      const command = git.revParse().setPrefix(prefix);
      for (const arg of args) command.addArgument(arg);
      const r = await command.call();
      ours = {
        status: 0,
        out: r.lines.map((l) => `${l}\n`).join(""),
        err: r.warnings.map((w) => `${w}\n`).join(""),
      };
    } catch (error) {
      ours = failure(error);
    }
    expect([args, ours]).toEqual([args, { status: n.status, out: n.stdout, err: n.stderr }]);
  }
}

/** `git log --format=%H <args>` (no `--` added) by native git and by ours. */
async function expectSameLog(cases: string[][]): Promise<void> {
  const git = await open();
  for (const args of cases) {
    const n = spawnSync("git", ["log", "--format=%H", ...args], {
      cwd: repo,
      env: nativeGitEnv(home),
      encoding: "latin1",
    });
    let ours: Outcome;
    try {
      const command = git.revList();
      for (const arg of args) command.addArgument(arg);
      const ids: string[] = [];
      for await (const c of await command.call()) ids.push(c.id);
      ours = { status: 0, out: ids.map((id) => `${id}\n`).join(""), err: "" };
    } catch (error) {
      ours = { status: 128, out: "", err: `${(error as Error).message}\n` };
    }
    expect([args, ours]).toEqual([args, { status: n.status, out: n.stdout, err: n.stderr }]);
  }
}

/** What ours throws for `git log <arg>`, if anything. */
async function revisionOrPathError(arg: string): Promise<string | undefined> {
  try {
    const command = (await open()).revList().addArgument(arg);
    for await (const _ of await command.call());
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

describeGit("revision or path: git's verify_filename and its diagnoses", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "revision-args-native-"));
    home = join(root, "home");
    mkdirSync(home);
    repo = join(root, "r");
    run(root, "init", "-q", "-b", "main", "r");
    put("a.txt", "a\n");
    put("d/e/c.txt", "c\n");
    put("d/e/gone.txt", "g\n");
    run(repo, "add", ".");
    run(repo, "commit", "-qm", "c1");
    put("a.txt", "a\nb\n");
    run(repo, "commit", "-qam", "c2");
    run(repo, "branch", "feat");
    // a branch named as a directory, an untracked file, a tracked file gone from disk
    run(repo, "branch", "d");
    put("u.txt", "u\n");
    put("d/e/u2.txt", "u\n");
    unlinkSync(join(repo, "d/e/gone.txt"));
  });
  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("rev-parse: paths printed, the first non-path diagnosed as a misspelt revision", async () => {
    await expectSameRevParse([
      ["a.txt"],
      ["main", "a.txt", "d"],
      ["a.txt", "nofile"],
      ["a.txt", "-x"],
      ["nope"],
      ["main", "nope", "a.txt"],
      ["*.txt"],
      [":(icase)A.TXT"],
      [":/c2"],
      [":/no such message"],
      ["HEAD:nope"],
      ["HEAD:u.txt"],
      ["HEAD:d/e"],
      ["main~1:a.txt", "HEAD:d/x"],
      ["nope:a.txt"],
      [":nope"],
      [":u.txt"],
      [":1:a.txt"],
      [":2:nope"],
      ["main", "--", "nope", "a.txt"],
      ["nope", "--", "a.txt"],
      ["main", "--"],
      ["HEAD:../x"],
      [":../x"],
    ]);
  });

  it("rev-parse from a subdirectory: relative names, and the worktree in the error", async () => {
    await expectSameRevParse(
      [
        ["c.txt"],
        ["HEAD:c.txt"],
        ["HEAD:gone.txt"],
        ["HEAD:u2.txt"],
        [":c.txt"],
        [":gone.txt"],
        ["HEAD:../../../x"],
        [":../../../x"],
        ["HEAD:./c.txt", "../e/c.txt"],
        [":/a.txt"],
      ],
      "d/e",
    );
  });

  it("log: a revision that is also a file, paths that must exist", async () => {
    await expectSameLog([
      ["a.txt"],
      ["main", "a.txt"],
      ["d"],
      ["main", "d"],
      ["main", "--", "d"],
      ["d", "--"],
      ["feat..main", "d"],
      ["nope"],
      ["main", "nofile", "a.txt"],
      ["main", "a.txt", "nofile"],
      ["HEAD:nope"],
      ["^nope"],
      ["nope", "--", "a.txt"],
      ["main^!", "a.txt"],
      ["main^@"],
      ["*.txt"],
    ]);
  });

  it("paths looked up as git's lstat: trailing slashes, '..', links to directories", async () => {
    symlinkSync("d/e", join(repo, "lnk"));
    symlinkSync("a.txt", join(repo, "flnk"));
    try {
      const cases = [
        ["a.txt/"],
        ["d/"],
        ["d/e/"],
        ["nope/../a.txt"],
        ["d/../a.txt"],
        ["lnk/c.txt"],
        ["lnk/"],
        ["lnk"],
        ["lnk/../a.txt"],
        ["lnk/../e/c.txt"],
        ["flnk"],
        ["flnk/"],
        ["../r/a.txt"],
        ["../r/nope"],
        ["../nothere"],
        [".."],
        ["./a.txt"],
        [`${repo}/a.txt`],
        ["HEAD:a.txt/"],
        ["HEAD:u.txt/"],
        ["main", "a.txt/"],
      ];
      await expectSameRevParse(cases);
      await expectSameRevParse([["../../lnk/c.txt"], ["../c.txt/"], ["c.txt/"]], "d/e");
      // paths that leave the worktree (and come back, or are absolute) pass verify_filename;
      // git's pathspec then reads them on its own terms, not compared here
      const escaping = (arg: string) => arg.startsWith("..") || arg.startsWith("/");
      await expectSameLog(cases.filter(([arg]) => !escaping(arg)));
      for (const [arg] of cases.filter(([a]) => escaping(a))) {
        const n = spawnSync("git", ["log", arg], { cwd: repo, env: nativeGitEnv(home) });
        const message = (await revisionOrPathError(arg)) ?? "";
        const refused = /ambiguous argument|no such path/;
        expect([arg, refused.test(message)]).toEqual([arg, refused.test(String(n.stderr))]);
      }
    } finally {
      unlinkSync(join(repo, "lnk"));
      unlinkSync(join(repo, "flnk"));
    }
  });
});
