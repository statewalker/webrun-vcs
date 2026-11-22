/**
 * Commands that convert, filter or check many worktree files run as one worktree operation
 * (`Worktree.batch`): `info/attributes` and the `.gitattributes` files are read once for the
 * whole command, not once per file (each attributes lookup outside an operation opens one of
 * its own, re-reading the configuration and every attributes file on the way). As
 * `diff-one-operation.test.ts` does for `git diff`, each case counts the attributes files
 * read through the worktree's FilesApi while the command runs.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitFilesBackend, openGitLinkedWorktrees } from "@statewalker/vcs-store-files";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import {
  createNodeFilesApi,
  createNodeGitHostEnvironment,
} from "@statewalker/vcs-utils-node/files";
import { afterEach, describe, expect, it } from "vitest";

import { Git } from "../src/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

const FILES = 12;
let root = "";
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

/** A repository of 12 text files in three directories, two commits; ours over it. */
async function setup(): Promise<{
  dir: string;
  git: (...args: string[]) => string;
  write: (round: number) => void;
  ours: Git;
  reads: string[];
}> {
  root = mkdtempSync(join(tmpdir(), "one-op-"));
  const dir = join(root, "repo");
  mkdirSync(dir);
  const env = nativeGitEnv(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, env, encoding: "latin1", stdio: "pipe" });
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, ".git", "info"), { recursive: true });
  writeFileSync(join(dir, ".git", "info", "attributes"), "*.bin binary\n");
  writeFileSync(join(dir, ".gitattributes"), "*.txt text\n");
  const write = (round: number) => {
    for (let i = 0; i < FILES; i++) {
      mkdirSync(join(dir, `d${i % 3}`), { recursive: true });
      writeFileSync(join(dir, `d${i % 3}`, `f${i}.txt`), `file ${i}\nround ${round}\n`);
    }
  };
  write(1);
  git("add", "-A");
  git("commit", "-qm", "one");
  write(2);
  git("commit", "-qam", "two");

  const raw = createNodeFilesApi({ rootDir: dir });
  const reads: string[] = [];
  const files = new Proxy(raw, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop !== "read" || typeof value !== "function") return value;
      return (path: string, ...rest: unknown[]) => {
        if (/attributes$/.test(path)) reads.push(path);
        return value.call(target, path, ...rest);
      };
    },
  }) as FilesApi;
  const environment = createNodeGitHostEnvironment({ env });
  const { history } = await createGitFilesBackend({ files, gitDir: ".git", environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir: ".git", history, environment });
  const ours = Git.fromWorkingCopy(await worktrees.openCurrent());
  return { dir, git, write, ours, reads };
}

/** Once each (the in-tree file and info/attributes), whatever the number of files. */
function expectReadOnce(reads: string[]): void {
  expect(reads.filter((p) => p.endsWith("info/attributes")).length).toBeLessThanOrEqual(1);
  expect(reads.filter((p) => p.endsWith(".gitattributes")).length).toBeLessThanOrEqual(1);
}

describeGit("commands converting many files in one worktree operation", () => {
  it("apply reads the attributes files once for every file it patches", async () => {
    const { git, ours, reads } = await setup();
    const patch = git("diff", "main", "main~1");
    reads.length = 0;
    const result = await ours.apply().addPatch(patch).setIndex(true).call();
    expect(result.exitCode).toBe(0);
    expect(git("status", "--porcelain")).toBe(
      git("diff", "--name-only", "main~1", "main")
        .split("\n")
        .filter(Boolean)
        .map((p) => `M  ${p}\n`)
        .join(""),
    );
    expectReadOnce(reads);
  });

  it("am reads them once for every file of its patches", async () => {
    const { git, ours, reads } = await setup();
    const mbox = git("format-patch", "--stdout", "main~1..main");
    git("reset", "-q", "--hard", "main~1");
    reads.length = 0;
    await ours.am().addMbox(mbox).call();
    expect(git("diff", "HEAD", "main")).toBe("");
    expectReadOnce(reads);
  });

  it("reset -- <paths> reads them once for the modified files it refreshes", async () => {
    const { git, write, ours, reads } = await setup();
    write(3);
    reads.length = 0;
    await ours.reset().setRef("main~1").addPath("d0").addPath("d1").addPath("d2").call();
    expect(git("diff", "--cached", "--name-only", "main~1")).toBe("");
    expectReadOnce(reads);
  });
});
