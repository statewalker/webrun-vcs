/**
 * Git Checkout Interoperability Tests
 *
 * Verifies GitCheckout can read/write checkout state compatible with native git.
 * Tests focus on HEAD, refs, and operation state files (MERGE_HEAD, etc.).
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RefsAdapter } from "@statewalker/vcs-core";
import { FileRefStore, GitCheckout, type GitCheckoutFilesApi } from "@statewalker/vcs-store-files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import { createMemoryGitStaging } from "@statewalker/vcs-working-tree";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Run git command in a directory
 */
function git(args: string[], cwd: string): string {
  const quotedArgs = args.map((arg) => (arg.includes(" ") ? `"${arg}"` : arg));
  return execSync(`git ${quotedArgs.join(" ")}`, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

describe("GitCheckout Git Interoperability", () => {
  let testDir: string;
  let repoDir: string;
  let gitDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "vcs-checkout-interop-"));
    repoDir = path.join(testDir, "repo");
    gitDir = path.join(repoDir, ".git");

    // Create repo with native git
    await fs.mkdir(repoDir);
    git(["init"], repoDir);
    git(["config", "user.email", "test@example.com"], repoDir);
    git(["config", "user.name", "Test User"], repoDir);

    // Create initial commit
    await fs.writeFile(path.join(repoDir, "README.md"), "# Test\n");
    git(["add", "README.md"], repoDir);
    git(["commit", "-m", "Initial commit"], repoDir);
  });

  afterEach(async () => {
    try {
      execSync(`chmod -R u+w "${testDir}"`, { stdio: "ignore" });
    } catch {
      // Ignore chmod errors
    }
    await fs.rm(testDir, { recursive: true, force: true });
  });

  describe("Reading native git state", () => {
    it("reads symbolic HEAD created by native git", async () => {
      // Native git creates symbolic HEAD by default
      const headContent = await fs.readFile(path.join(gitDir, "HEAD"), "utf-8");
      expect(headContent).toContain("ref: refs/heads/");

      // Create GitCheckout and verify it reads HEAD correctly
      const nodeFiles = createNodeFilesApi({ fs, rootDir: repoDir });
      const files: GitCheckoutFilesApi = {
        ...nodeFiles,
        read: async (filePath: string) => {
          const chunks: Uint8Array[] = [];
          for await (const chunk of nodeFiles.read(filePath)) {
            chunks.push(chunk);
          }
          if (chunks.length === 0) return undefined;
          const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const result = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
          }
          return result;
        },
        stats: async (filePath: string) => {
          const fileStats = await nodeFiles.stats(filePath);
          if (!fileStats) return undefined;
          return { isDirectory: fileStats.kind === "directory" };
        },
        removeDir: nodeFiles.remove.bind(nodeFiles),
      };

      const refStore = new FileRefStore(nodeFiles, ".git");
      const refs = new RefsAdapter(refStore);
      await refs.initialize();

      const staging = createMemoryGitStaging();
      const checkout = new GitCheckout({
        staging,
        refs,
        files,
        gitDir: ".git",
      });

      await checkout.initialize();

      const head = await checkout.getHead();
      expect(head.type).toBe("symbolic");
      if (head.type === "symbolic") {
        expect(head.target).toMatch(/^refs\/heads\/(main|master)$/);
      }

      const branch = await checkout.getCurrentBranch();
      expect(branch).toMatch(/^(main|master)$/);
      expect(await checkout.isDetached()).toBe(false);

      await checkout.close();
    });

    it("reads detached HEAD created by native git", async () => {
      // Create detached HEAD with native git
      const commitHash = git(["rev-parse", "HEAD"], repoDir);
      git(["checkout", "--detach", "HEAD"], repoDir);

      // Verify HEAD file contains commit hash (detached HEAD is stored directly)
      const headContent = await fs.readFile(path.join(gitDir, "HEAD"), "utf-8");
      expect(headContent.trim()).toBe(commitHash);

      // Create GitCheckout and verify it reads detached HEAD
      const nodeFiles = createNodeFilesApi({ fs, rootDir: repoDir });
      const files: GitCheckoutFilesApi = {
        ...nodeFiles,
        read: async (filePath: string) => {
          const chunks: Uint8Array[] = [];
          for await (const chunk of nodeFiles.read(filePath)) {
            chunks.push(chunk);
          }
          if (chunks.length === 0) return undefined;
          const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const result = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
          }
          return result;
        },
        stats: async (filePath: string) => {
          const fileStats = await nodeFiles.stats(filePath);
          if (!fileStats) return undefined;
          return { isDirectory: fileStats.kind === "directory" };
        },
        removeDir: nodeFiles.remove.bind(nodeFiles),
      };

      const refStore = new FileRefStore(nodeFiles, ".git");
      const refs = new RefsAdapter(refStore);
      await refs.initialize();

      const staging = createMemoryGitStaging();
      const checkout = new GitCheckout({
        staging,
        refs,
        files,
        gitDir: ".git",
      });

      await checkout.initialize();

      const head = await checkout.getHead();
      expect(head.type).toBe("detached");
      if (head.type === "detached") {
        expect(head.commitId).toBe(commitHash);
      }

      expect(await checkout.getCurrentBranch()).toBeUndefined();
      expect(await checkout.isDetached()).toBe(true);

      await checkout.close();
    });
  });

  describe("Writing native git compatible state", () => {
    it("writes HEAD readable by native git", async () => {
      const nodeFiles = createNodeFilesApi({ fs, rootDir: repoDir });
      const files: GitCheckoutFilesApi = {
        ...nodeFiles,
        read: async (filePath: string) => {
          const chunks: Uint8Array[] = [];
          for await (const chunk of nodeFiles.read(filePath)) {
            chunks.push(chunk);
          }
          if (chunks.length === 0) return undefined;
          const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
          const result = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
          }
          return result;
        },
        stats: async (filePath: string) => {
          const fileStats = await nodeFiles.stats(filePath);
          if (!fileStats) return undefined;
          return { isDirectory: fileStats.kind === "directory" };
        },
        removeDir: nodeFiles.remove.bind(nodeFiles),
      };

      const refStore = new FileRefStore(nodeFiles, ".git");
      const refs = new RefsAdapter(refStore);
      await refs.initialize();
      const initialCommit = git(["rev-parse", "HEAD"], repoDir);

      const staging = createMemoryGitStaging();
      const checkout = new GitCheckout({
        staging,
        refs,
        files,
        gitDir: ".git",
      });

      await checkout.initialize();

      // Switch to feature branch
      await refs.setSymbolic("HEAD", "refs/heads/feature");
      await refs.set("refs/heads/feature", initialCommit);
      await checkout.setHead({ type: "symbolic", target: "refs/heads/feature" });

      await checkout.close();

      // Verify native git sees the branch switch
      const currentBranch = git(["symbolic-ref", "--short", "HEAD"], repoDir);
      expect(currentBranch).toBe("feature");
    });
  });
});
