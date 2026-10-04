/**
 * Repository Controller
 *
 * Manages Git repository operations using vcs-commands.
 * Updates models based on repository state.
 */

import { Git } from "@statewalker/vcs-commands";
import { FileMode, type History } from "@statewalker/vcs-core";
import { FileStagingStore } from "@statewalker/vcs-store-files";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import {
  type CommitEntry,
  type FileEntry,
  type FileStatus,
  getActivityLogModel,
  getCommitFormModel,
  getCommitHistoryModel,
  getFileListModel,
  getRepositoryModel,
  getStagingModel,
} from "../models/index.js";
import { newAdapter, newRegistry } from "../utils/index.js";
import { getStorageBackend } from "./storage-controller.js";

// Adapters for Git state
export const [getHistory, setHistory] = newAdapter<History | null>("history", () => null);

export const [getWorkingCopy, setWorkingCopy] = newAdapter<WorkingCopy | null>(
  "working-copy",
  () => null,
);

export const [getGit, setGit] = newAdapter<Git | null>("git-instance", () => null);

let refreshInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Create the repository controller.
 * Returns cleanup function.
 */
export function createRepositoryController(ctx: Map<string, unknown>): () => void {
  const [register, cleanup] = newRegistry();

  register(() => {
    stopAutoRefresh();
    const history = getHistory(ctx);
    if (history) {
      history.close();
      setHistory(ctx, null);
      setWorkingCopy(ctx, null);
      setGit(ctx, null);
    }
  });

  return cleanup;
}

/**
 * Initialize or open a Git repository.
 */
export async function initOrOpenRepository(ctx: Map<string, unknown>): Promise<boolean> {
  const backend = getStorageBackend(ctx);
  const repoModel = getRepositoryModel(ctx);
  const logModel = getActivityLogModel(ctx);

  if (!backend) {
    logModel.error("No storage backend selected");
    return false;
  }

  try {
    // Check if repository already exists using FilesApi
    const repoExists = await backend.files.exists(".git");

    // Configure staging store
    let customStaging: FileStagingStore | undefined;
    if (backend.type === "browser-fs") {
      customStaging = new FileStagingStore(backend.files, ".git/index");
      if (repoExists) {
        await customStaging.read();
      }
    }

    // Use Git.init() to initialize or open
    const initCommand = Git.init()
      .setFilesApi(backend.files)
      .setGitDir(".git")
      .setInitialBranch("main")
      .setWorktree(true);

    if (customStaging) {
      initCommand.setStagingStore(customStaging);
    }

    const result = await initCommand.call();

    setHistory(ctx, result.repository);
    setWorkingCopy(ctx, result.workingCopy);
    setGit(ctx, result.git);

    // Get current branch
    const headSymRef = await result.repository.refs.get("HEAD");
    const branch =
      headSymRef && "target" in headSymRef ? headSymRef.target.replace("refs/heads/", "") : "main";
    const headRef = await result.repository.refs.resolve("HEAD");
    const headCommit = headRef?.objectId || "";

    repoModel.setReady(backend.folderName, branch, headCommit);
    logModel.success(repoExists ? "Opened existing repository" : "Initialized new repository");

    // Load initial state
    await refreshFiles(ctx);
    await loadHistory(ctx);

    // Start auto-refresh for browser FS
    if (backend.type === "browser-fs") {
      startAutoRefresh(ctx, 3000);
    }

    return true;
  } catch (error) {
    logModel.error(`Failed to initialize repository: ${(error as Error).message}`);
    repoModel.setError((error as Error).message);
    return false;
  }
}

/**
 * Create sample files for a new repository.
 */
export async function createSampleFiles(ctx: Map<string, unknown>): Promise<void> {
  const backend = getStorageBackend(ctx);
  const git = getGit(ctx);
  const logModel = getActivityLogModel(ctx);

  if (!backend || !git) {
    logModel.error("No repository initialized");
    return;
  }

  const encoder = new TextEncoder();

  const sampleFiles = [
    {
      path: "index.md",
      content: `# My Project

Welcome to this VCS WebRTC Sync demo project.

## Overview

This project demonstrates peer-to-peer Git synchronization using WebRTC.
`,
    },
    {
      path: "docs/getting-started.md",
      content: `# Getting Started

## Prerequisites

- A modern web browser with WebRTC support
- Two browser tabs/windows to test P2P sync

## Quick Start

1. Open this app in two browser tabs
2. Initialize a repository in each
3. Use Share/Connect to establish a P2P connection
4. Make changes and sync between peers
`,
    },
    {
      path: "docs/architecture.md",
      content: `# Architecture

## Components

- **Models**: Observable state containers
- **Controllers**: Business logic and external API interactions
- **Views**: UI rendering based on model state

## Data Flow

\`\`\`
External World <---> Controllers <---> Models <---> Views <---> User
\`\`\`
`,
    },
    {
      path: "docs/api-reference.md",
      content: `# API Reference

## Git Operations

- \`init\`: Initialize a new repository
- \`add\`: Stage files for commit
- \`commit\`: Create a new commit
- \`status\`: Check working directory status

## WebRTC Operations

- \`createOffer\`: Generate connection offer
- \`acceptOffer\`: Accept and respond to offer
- \`sync\`: Synchronize repositories
`,
    },
  ];

  try {
    for (const file of sampleFiles) {
      await backend.files.write(file.path, [encoder.encode(file.content)]);
      await git.add().addFilepattern(file.path).call();
    }

    logModel.success(`Created ${sampleFiles.length} sample files`);
    await refreshFiles(ctx);
  } catch (error) {
    logModel.error(`Failed to create sample files: ${(error as Error).message}`);
  }
}

/**
 * Refresh the file list from the working directory.
 */
export async function refreshFiles(ctx: Map<string, unknown>): Promise<void> {
  const backend = getStorageBackend(ctx);
  const history = getHistory(ctx);
  const workingCopy = getWorkingCopy(ctx);
  const fileListModel = getFileListModel(ctx);
  const stagingModel = getStagingModel(ctx);
  const repoModel = getRepositoryModel(ctx);

  if (!backend || !history || !workingCopy) return;

  fileListModel.setLoading(true);

  try {
    // Get tracked files from HEAD
    const trackedFiles = new Map<string, string>();
    const headRef = await history.refs.resolve("HEAD");
    if (headRef?.objectId) {
      const commit = await history.commits.load(headRef.objectId);
      if (commit) {
        await collectTreeFiles(history, commit.tree, "", trackedFiles);
      }
    }

    // Get files from staging store (index)
    // Note: In Git, the index contains ALL tracked files, not just staged changes
    const indexFiles = new Map<string, string>();
    if (workingCopy.checkout.staging) {
      for await (const entry of workingCopy.checkout.staging.entries()) {
        indexFiles.set(entry.path, entry.objectId);
      }
    }

    // Determine which files are actually "staged" (different from HEAD)
    const stagedFiles = new Map<string, string>();
    for (const [path, objectId] of indexFiles) {
      const headObjectId = trackedFiles.get(path);
      // File is staged if: new file (not in HEAD) OR modified (different objectId)
      if (!headObjectId || headObjectId !== objectId) {
        stagedFiles.set(path, objectId);
      }
    }
    // Also check for deleted files (in HEAD but not in index)
    for (const [path] of trackedFiles) {
      if (!indexFiles.has(path)) {
        stagedFiles.set(path, "deleted");
      }
    }

    // List working directory files using FilesApi
    const workingFiles: string[] = [];
    await listFilesFromApi(backend.files, "", workingFiles);

    // Build file entries with status
    const fileEntries: FileEntry[] = [];
    const allPaths = new Set([...workingFiles, ...trackedFiles.keys()]);

    for (const path of allPaths) {
      const isInWorkdir = workingFiles.includes(path);
      const isTracked = trackedFiles.has(path);
      const isStaged = stagedFiles.has(path);

      let status: FileStatus;
      if (!isInWorkdir && isTracked) {
        status = "deleted";
      } else if (isStaged) {
        status = "staged";
      } else if (!isTracked) {
        status = "untracked";
      } else {
        // Check if modified (simplified - just check if in staging differs from HEAD)
        status = "unchanged";
      }

      fileEntries.push({ path, status });
    }

    fileListModel.setFiles(fileEntries);

    // Update staging model
    const staged = Array.from(stagedFiles.entries()).map(([path, objectId]) => ({
      path,
      objectId,
    }));
    stagingModel.setStagedFiles(staged);

    // Update uncommitted changes flag
    const hasChanges =
      stagedFiles.size > 0 ||
      fileEntries.some((f) => f.status !== "unchanged" && f.status !== "staged");
    repoModel.setUncommittedChanges(hasChanges);
  } catch (error) {
    console.error("Failed to refresh files:", error);
  } finally {
    fileListModel.setLoading(false);
  }
}

/**
 * Stage a file for commit.
 */
export async function stageFile(ctx: Map<string, unknown>, path: string): Promise<void> {
  const git = getGit(ctx);
  const logModel = getActivityLogModel(ctx);

  if (!git) {
    logModel.error("No repository initialized");
    return;
  }

  try {
    await git.add().addFilepattern(path).call();
    logModel.info(`Staged: ${path}`);
    await refreshFiles(ctx);
  } catch (error) {
    logModel.error(`Failed to stage ${path}: ${(error as Error).message}`);
  }
}

/**
 * Unstage a file.
 */
export async function unstageFile(ctx: Map<string, unknown>, path: string): Promise<void> {
  const workingCopy = getWorkingCopy(ctx);
  const logModel = getActivityLogModel(ctx);

  if (!workingCopy || !workingCopy.checkout.staging) {
    logModel.error("No repository initialized");
    return;
  }

  try {
    const editor = workingCopy.checkout.staging.createEditor();
    editor.remove(path);
    await editor.finish();
    logModel.info(`Unstaged: ${path}`);
    await refreshFiles(ctx);
  } catch (error) {
    logModel.error(`Failed to unstage ${path}: ${(error as Error).message}`);
  }
}

/**
 * Create a commit with the staged files.
 */
export async function commit(ctx: Map<string, unknown>, message: string): Promise<string | null> {
  const git = getGit(ctx);
  const history = getHistory(ctx);
  const workingCopy = getWorkingCopy(ctx);
  const repoModel = getRepositoryModel(ctx);
  const commitFormModel = getCommitFormModel(ctx);
  const stagingModel = getStagingModel(ctx);
  const logModel = getActivityLogModel(ctx);

  if (!git || !history || !workingCopy) {
    logModel.error("No repository initialized");
    return null;
  }

  if (stagingModel.isEmpty) {
    logModel.error("No files staged for commit");
    return null;
  }

  commitFormModel.setCommitting(true);

  try {
    const commitData = await git.commit().setMessage(message).call();
    const commitId = await history.commits.store(commitData);

    // Clear the Git staging store after commit
    if (workingCopy.checkout.staging) {
      await workingCopy.checkout.staging.clear();
    }

    // Update HEAD
    repoModel.updateHead(commitId);
    commitFormModel.clear();
    stagingModel.clear();

    logModel.success(`Created commit: ${commitId.slice(0, 7)}`);

    await refreshFiles(ctx);
    await loadHistory(ctx);

    return commitId;
  } catch (error) {
    logModel.error(`Failed to commit: ${(error as Error).message}`);
    return null;
  } finally {
    commitFormModel.setCommitting(false);
  }
}

/**
 * Load commit history.
 */
export async function loadHistory(ctx: Map<string, unknown>): Promise<void> {
  const history = getHistory(ctx);
  const historyModel = getCommitHistoryModel(ctx);

  if (!history) return;

  historyModel.setLoading(true);

  try {
    const headRef = await history.refs.resolve("HEAD");
    if (!headRef?.objectId) {
      historyModel.setCommits([]);
      return;
    }

    const commits: CommitEntry[] = [];

    for await (const id of history.commits.walkAncestry(headRef.objectId, { limit: 50 })) {
      const commit = await history.commits.load(id);
      if (commit) {
        commits.push({
          id,
          shortId: id.slice(0, 7),
          message: commit.message.trim().split("\n")[0],
          author: commit.author.name,
          timestamp: commit.author.timestamp,
        });
      }
    }

    historyModel.setCommits(commits);
  } catch (error) {
    console.error("Failed to load history:", error);
  } finally {
    historyModel.setLoading(false);
  }
}

/**
 * Restore working directory to a specific commit.
 */
export async function restoreToCommit(ctx: Map<string, unknown>, commitId: string): Promise<void> {
  const history = getHistory(ctx);
  const backend = getStorageBackend(ctx);
  const repoModel = getRepositoryModel(ctx);
  const logModel = getActivityLogModel(ctx);

  if (!history || !backend) {
    logModel.error("No repository initialized");
    return;
  }

  if (repoModel.hasUncommittedChanges) {
    logModel.warning("Cannot restore: uncommitted changes exist");
    return;
  }

  try {
    const commit = await history.commits.load(commitId);
    if (!commit) {
      logModel.error(`Commit not found: ${commitId}`);
      return;
    }

    // Clear working directory and restore from tree
    await restoreTree(history, backend, commit.tree, "");

    // Update refs
    await history.refs.set("refs/heads/main", commitId);
    repoModel.updateHead(commitId);

    logModel.success(`Restored to commit: ${commitId.slice(0, 7)}`);
    await refreshFiles(ctx);
    await loadHistory(ctx);
  } catch (error) {
    logModel.error(`Failed to restore: ${(error as Error).message}`);
  }
}

/**
 * Start auto-refresh interval.
 */
export function startAutoRefresh(ctx: Map<string, unknown>, intervalMs: number): void {
  stopAutoRefresh();
  refreshInterval = setInterval(() => refreshFiles(ctx), intervalMs);
}

/**
 * Stop auto-refresh interval.
 */
export function stopAutoRefresh(): void {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}

// Helper functions

async function collectTreeFiles(
  history: History,
  treeId: string,
  prefix: string,
  files: Map<string, string>,
): Promise<void> {
  const tree = await history.trees.load(treeId);
  if (!tree) return;
  for await (const entry of tree) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === FileMode.TREE) {
      await collectTreeFiles(history, entry.id, path, files);
    } else {
      files.set(path, entry.id);
    }
  }
}

/**
 * Normalize file path to Git format (no leading slash).
 */
function normalizePath(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

async function listFilesFromApi(
  files: {
    list: (
      path: string,
    ) => AsyncIterable<{ name: string; path: string; kind: "file" | "directory" }>;
  },
  prefix: string,
  result: string[],
): Promise<void> {
  for await (const entry of files.list(prefix)) {
    const normalizedPath = normalizePath(entry.path);
    if (entry.kind === "file") {
      result.push(normalizedPath);
    } else if (entry.kind === "directory" && entry.name !== ".git") {
      await listFilesFromApi(files, normalizedPath, result);
    }
  }
}

async function restoreTree(
  history: History,
  backend: { files: { write: (path: string, chunks: Uint8Array[]) => Promise<void> } },
  treeId: string,
  prefix: string,
): Promise<void> {
  const tree = await history.trees.load(treeId);
  if (!tree) return;
  for await (const entry of tree) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === FileMode.TREE) {
      await restoreTree(history, backend, entry.id, path);
    } else {
      const chunks: Uint8Array[] = [];
      const blobData = await history.blobs.load(entry.id);
      if (blobData) {
        for await (const chunk of blobData) {
          chunks.push(chunk);
        }
      }
      await backend.files.write(path, chunks);
    }
  }
}
