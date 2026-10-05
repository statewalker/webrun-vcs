/**
 * Native git command-line client wrapper for integration testing.
 *
 * Provides convenience methods for running git commands against HTTP servers.
 * Each client operates in an isolated temp directory.
 *
 * All git operations that talk to an HTTP server use async exec to avoid
 * deadlocking the event loop (the HTTP server runs in the same process).
 */

import { exec } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface NativeGitClient {
  /** Working directory for the cloned repo */
  workDir: string;
  /** Run a git command in the working directory (async, non-blocking) */
  git(args: string): Promise<string>;
  /** Clone a repository */
  clone(url: string): Promise<void>;
  /** Create a commit with a file */
  commitFile(filename: string, content: string, message: string): Promise<void>;
  /** Push to remote */
  push(remote?: string, branch?: string): Promise<string>;
  /** Get list of refs from ls-remote */
  lsRemote(url: string): Promise<Map<string, string>>;
  /** Cleanup temp directory */
  cleanup(): void;
}

/**
 * Create a native git client with an isolated temp directory.
 */
export function createNativeGitClient(): NativeGitClient {
  const workDir = mkdtempSync(join(tmpdir(), "vcs-git-client-"));

  async function git(args: string): Promise<string> {
    const { stdout } = await execAsync(`git -C "${workDir}" ${args}`);
    return stdout.trim();
  }

  return {
    workDir,
    git,

    async clone(url: string) {
      // An empty repository clones onto the local default branch: pin it to main.
      await execAsync(`git -c init.defaultBranch=main clone "${url}" "${workDir}"`);
    },

    async commitFile(filename: string, content: string, message: string) {
      const filePath = join(workDir, filename);
      writeFileSync(filePath, content, "utf-8");
      await git(`add "${filename}"`);
      await git(`-c user.name="Test" -c user.email="test@test.com" commit -m "${message}"`);
    },

    async push(remote = "origin", branch = "main"): Promise<string> {
      return git(`push ${remote} ${branch}`);
    },

    async lsRemote(url: string): Promise<Map<string, string>> {
      const { stdout } = await execAsync(`git ls-remote "${url}"`);
      const refs = new Map<string, string>();
      for (const line of stdout.trim().split("\n")) {
        if (!line.trim()) continue;
        const [oid, name] = line.split("\t");
        refs.set(name, oid);
      }
      return refs;
    },

    cleanup(): void {
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
