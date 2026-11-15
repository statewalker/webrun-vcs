/**
 * Test-only: a files-backend working copy over a real directory, so native git can read
 * what our commands write (and the other way round), and small helpers around native git.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
  GitCheckout,
  type GitCheckoutFilesApi,
  GitWorkingCopyConfig,
} from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { MemoryWorkingCopy, type WorkingCopy } from "@statewalker/vcs-working-tree";

import { Git } from "../src/index.js";
import { nativeGitEnv } from "./native-git-http-backend.js";

/** A files-backend working copy over `dir` (an empty `.git` is created). */
export async function openFilesWorkingCopy(
  dir: string,
): Promise<{ git: Git; workingCopy: WorkingCopy; config: GitWorkingCopyConfig }> {
  mkdirSync(dir, { recursive: true });
  const files = createNodeFilesApi({ rootDir: dir });
  const { history } = await createGitFilesBackend({ files, create: true });
  await history.initialize();
  const read = async (path: string) => {
    try {
      return new Uint8Array(readFileSync(join(dir, path)));
    } catch {
      return undefined;
    }
  };
  const config = new GitWorkingCopyConfig(
    { read, write: async (path, content) => writeFileSync(join(dir, path), content) },
    ".git/config",
  );
  await config.load();
  const checkoutFiles = {
    read,
    write: (path: string, content: Parameters<typeof files.write>[1]) => files.write(path, content),
    stats: async (path: string) => {
      const s = await files.stats(path);
      return s ? { isDirectory: s.kind === "directory" } : undefined;
    },
    remove: async (path: string) => {
      await files.remove(path);
    },
  } as unknown as GitCheckoutFilesApi;
  const staging = new FileStagingStore(files, ".git/index");
  const checkout = new GitCheckout({
    staging,
    refs: history.refs,
    files: checkoutFiles,
    gitDir: ".git",
  });
  const worktree = createFileWorktree({
    files,
    rootPath: "",
    gitDir: ".git",
    blobs: history.blobs,
    trees: history.trees,
  });
  const workingCopy = new MemoryWorkingCopy({ history, checkout, worktree, config });
  return { git: Git.fromWorkingCopy(workingCopy), workingCopy, config };
}

/** Runs native git in `cwd` with a clean environment; stdout, trimmed. */
export function runGit(home: string, cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: nativeGitEnv(home),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Runs native git and returns its exit status, stdout and stderr, whatever the status. */
export function runGitResult(
  home: string,
  cwd: string,
  ...args: string[]
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, env: nativeGitEnv(home), encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Whether `git version X.Y.Z` is at least `major.minor`. */
export function gitAtLeast(versionLine: string, major: number, minor: number): boolean {
  const match = /(\d+)\.(\d+)/.exec(versionLine);
  if (!match) return true;
  const [maj, min] = [Number(match[1]), Number(match[2])];
  return maj > major || (maj === major && min >= minor);
}
