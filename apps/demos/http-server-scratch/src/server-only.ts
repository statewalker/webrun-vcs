/**
 * HTTP Git Server Demo - Server Only Mode
 *
 * Starts a standalone Git HTTP server that serves repositories from a directory.
 * Can be used with any Git client (native git, VCS, etc.)
 *
 * Usage:
 *   pnpm server                       # Start with default settings
 *   pnpm server -- --port 9000       # Custom port
 *   pnpm server -- --dir ./my-repos  # Custom repos directory
 *
 * Endpoints:
 *   GET  /repo.git/info/refs?service=git-upload-pack   (fetch/clone refs)
 *   POST /repo.git/git-upload-pack                     (send pack data)
 *   GET  /repo.git/info/refs?service=git-receive-pack  (push refs)
 *   POST /repo.git/git-receive-pack                    (receive pack data)
 */

import type { FilesApi } from "@statewalker/vcs-core";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";

import {
  createFileHistory,
  createVcsHttpServer,
  ensureDirectory,
  type FileHistory,
  printError,
  printInfo,
  printSection,
  printSuccess,
  resolvePath,
  type VcsHttpServer,
} from "./shared/index.js";

// Initialize compression

// Parse command line arguments
function parseArgs(): { port: number; reposDir: string } {
  const args = process.argv.slice(2);
  let port = 8080;
  let reposDir = resolvePath(process.cwd(), "repos");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--dir" && args[i + 1]) {
      reposDir = resolvePath(process.cwd(), args[i + 1]);
      i++;
    }
  }

  return { port, reposDir };
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  const { port, reposDir } = parseArgs();

  printSection("HTTP Git Server - Standalone Mode");
  console.log("A Git HTTP server built from scratch using VCS.\n");

  // FilesApi rooted at the repos directory; creating its root creates the directory
  const reposFiles = createNodeFilesApi({ rootDir: reposDir });
  await ensureDirectory(reposFiles, "/");

  printInfo(`Repos directory: ${reposDir}`);
  printInfo(`Port: ${port}`);

  // Cache open repositories
  const openRepos = new Map<string, FileHistory>();

  // Start server
  let server: VcsHttpServer | null = null;

  try {
    server = await createVcsHttpServer({
      port,
      getStorage: async (repoPath: string) => {
        // Check cache
        const cached = openRepos.get(repoPath);
        if (cached) {
          return cached;
        }

        // Try to open repository
        const fullPath = resolvePath(reposDir, repoPath);

        try {
          const stat = await reposFiles.stats(repoPath);
          if (stat?.kind !== "directory") {
            return null;
          }
        } catch {
          // Invalid path (e.g. outside the repos directory)
          return null;
        }

        // Determine if this is a bare repo or not
        const isBare = repoPath.endsWith(".git");
        const gitDir = isBare ? "." : ".git";

        try {
          const files = createNodeFilesApi({ rootDir: fullPath });
          const history = await createFileHistory({
            files,
            gitDir,
            create: false,
          });
          openRepos.set(repoPath, history);
          return history;
        } catch (error) {
          console.error(`Failed to open repository ${repoPath}:`, error);
          return null;
        }
      },
    });

    printSuccess(`Server running at http://localhost:${port}`);
    console.log("\nAvailable endpoints:");
    console.log(`  Clone:  git clone http://localhost:${port}/<repo>.git`);
    console.log(`  Push:   git push http://localhost:${port}/<repo>.git`);
    console.log("\nPress Ctrl+C to stop the server.\n");

    // List available repositories
    await listRepositories(reposFiles, reposDir);

    // Keep running until interrupted
    await new Promise<void>((resolve) => {
      process.on("SIGINT", () => {
        console.log("\nShutting down...");
        resolve();
      });
      process.on("SIGTERM", () => {
        console.log("\nShutting down...");
        resolve();
      });
    });
  } catch (error) {
    printError(`Failed to start server: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  } finally {
    // Close all open repositories
    for (const [repoPath, repo] of openRepos) {
      try {
        await repo.close();
        printInfo(`Closed repository: ${repoPath}`);
      } catch {
        // Ignore close errors
      }
    }

    // Stop server
    if (server) {
      await server.stop();
      printSuccess("Server stopped");
    }
  }
}

/**
 * List available repositories in the repos directory.
 */
async function listRepositories(reposFiles: FilesApi, reposDir: string): Promise<void> {
  try {
    const repos: Array<{ name: string }> = [];
    for await (const entry of reposFiles.list("/")) {
      if (entry.kind === "directory" && entry.name.endsWith(".git")) {
        repos.push(entry);
      }
    }

    if (repos.length === 0) {
      printInfo("No repositories found. Create a bare repository with:");
      console.log(`  git init --bare ${reposDir}/myrepo.git`);
    } else {
      printInfo(`Available repositories (${repos.length}):`);
      for (const repo of repos) {
        console.log(`  - ${repo.name}`);
      }
    }
  } catch {
    printInfo("No repositories found.");
  }
}

// Run main
main();
