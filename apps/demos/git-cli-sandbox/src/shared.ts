/**
 * Shared utilities for the Git CLI sandbox
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Git } from "@statewalker/vcs-commands";
import type { FilesApi, GitObjectStore, History } from "@statewalker/vcs-core";
import {
  createFileWorktree,
  createGitFilesBackend,
  FileStagingStore,
} from "@statewalker/vcs-store-files";
import { setCompressionUtils } from "@statewalker/vcs-utils";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";
import {
  createMemoryCheckout,
  createMemoryWorkingCopy,
  createMemoryWorktree,
  type WorkingCopy,
} from "@statewalker/vcs-working-tree";

// Initialize compression for pack operations
setCompressionUtils(createNodeCompression());

/**
 * Context for CLI operations
 */
export interface CliContext {
  cwd: string;
  git: Git;
  workingCopy: WorkingCopy;
  history: History;
  objects: GitObjectStore;
  files: FilesApi;
}

/**
 * Find the repository root from the current directory
 */
export async function findRepoRoot(startDir: string): Promise<string | null> {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const gitDir = path.join(dir, ".git");

    try {
      const stat = await fs.stat(gitDir);
      if (stat.isDirectory()) {
        return dir;
      }
    } catch {
      // Not found, continue up
    }

    dir = path.dirname(dir);
  }

  return null;
}

/**
 * Open an existing repository
 */
export async function openRepository(repoDir: string): Promise<CliContext> {
  const files = createNodeFilesApi({ rootDir: repoDir });

  // Create backend and history
  const { history, objects } = await createGitFilesBackend({
    files,
    gitDir: ".git",
    create: false,
  });
  await history.initialize();

  // Create staging
  const staging = new FileStagingStore(files, ".git/index");
  await staging.read();

  // Create checkout (manages HEAD, staging, operation states)
  const checkout = createMemoryCheckout({ staging });

  // Create worktree for filesystem operations
  const worktree = createFileWorktree({
    files,
    rootPath: "",
    blobs: history.blobs,
    trees: history.trees,
    gitDir: ".git",
  });

  // Create WorkingCopy
  const workingCopy = createMemoryWorkingCopy({
    history,
    checkout,
    worktree,
  });

  // Create Git facade
  const git = Git.fromWorkingCopy(workingCopy);

  return {
    cwd: repoDir,
    git,
    workingCopy,
    history,
    objects,
    files,
  };
}

/**
 * Initialize a new repository
 */
export async function initRepository(
  repoDir: string,
  options: { bare?: boolean; defaultBranch?: string } = {},
): Promise<CliContext> {
  const files = createNodeFilesApi({ rootDir: repoDir });

  const gitDir = options.bare ? "." : ".git";

  // Create backend and history
  const { history, objects } = await createGitFilesBackend({
    files,
    gitDir,
    create: true,
  });
  await history.initialize();

  // Set initial branch
  const defaultBranch = options.defaultBranch || "main";
  await history.refs.setSymbolic("HEAD", `refs/heads/${defaultBranch}`);

  // Create staging
  const indexPath = options.bare ? "index" : ".git/index";
  const staging = new FileStagingStore(files, indexPath);

  // Create checkout
  const checkout = createMemoryCheckout({ staging });

  // Create worktree for filesystem operations
  // For bare repos, use a memory worktree (it won't be used but is required by the interface)
  const worktree = options.bare
    ? createMemoryWorktree({
        blobs: history.blobs,
        trees: history.trees,
      })
    : createFileWorktree({
        files,
        rootPath: "",
        blobs: history.blobs,
        trees: history.trees,
        gitDir: ".git",
      });

  // Create WorkingCopy
  const workingCopy = createMemoryWorkingCopy({
    history,
    checkout,
    worktree,
  });

  // Create Git facade
  const git = Git.fromWorkingCopy(workingCopy);

  return {
    cwd: repoDir,
    git,
    workingCopy,
    history,
    objects,
    files,
  };
}

/**
 * Format a SHA-1 hash for display (short form)
 */
export function shortId(id: string, length = 7): string {
  return id.slice(0, length);
}

/**
 * Format a date for display
 */
export function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString();
}

/**
 * Print output styling utilities
 */
export const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

export function colorize(text: string, ...codes: string[]): string {
  if (!process.stdout.isTTY) {
    return text;
  }
  return `${codes.join("")}${text}${colors.reset}`;
}

export function success(text: string): string {
  return colorize(text, colors.green);
}

export function error(text: string): string {
  return colorize(text, colors.red);
}

export function warning(text: string): string {
  return colorize(text, colors.yellow);
}

export function info(text: string): string {
  return colorize(text, colors.cyan);
}

export function dim(text: string): string {
  return colorize(text, colors.dim);
}

export function bold(text: string): string {
  return colorize(text, colors.bold);
}

/**
 * Parse author/committer string
 */
export function formatAuthor(name: string, email: string): string {
  return `${name} <${email}>`;
}

/**
 * Get default author from environment or use placeholder
 */
export function getDefaultAuthor(): { name: string; email: string } {
  return {
    name: process.env.GIT_AUTHOR_NAME || process.env.USER || "User",
    email: process.env.GIT_AUTHOR_EMAIL || `${process.env.USER || "user"}@localhost`,
  };
}

/**
 * Print an error and exit
 */
export function fatal(message: string): never {
  console.error(error(`fatal: ${message}`));
  process.exit(1);
}

/**
 * Ensure we're in a repository
 */
export async function requireRepository(): Promise<CliContext> {
  const repoRoot = await findRepoRoot(process.cwd());
  if (!repoRoot) {
    fatal("not a git repository (or any of the parent directories): .git");
  }
  return openRepository(repoRoot);
}

/**
 * Text encoder for content
 */
export const textEncoder = new TextEncoder();
export const textDecoder = new TextDecoder();
