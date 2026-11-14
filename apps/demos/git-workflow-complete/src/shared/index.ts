/**
 * Shared utilities for the complete Git workflow demo
 *
 * This demo uses ONLY porcelain commands from @statewalker/vcs-commands
 * and FilesAPI for all operations. No low-level API or native git calls.
 */

import type { Git } from "@statewalker/vcs-commands";
import type { FilesApi, History, ObjectId } from "@statewalker/vcs-core";
import { joinPath } from "@statewalker/vcs-utils/files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";

// Initialize compression (required before any storage operations)

// ============================================================================
// Configuration
// ============================================================================

/** Name of the demo repository folder, relative to the current directory */
export const REPO_NAME = "test-workflow-repo";
/** Absolute path of the demo repository (for display) */
export const REPO_DIR = joinPath(process.cwd(), REPO_NAME);
export const GIT_DIR = ".git";
/** Paths inside the repository FilesApi (rooted at REPO_DIR) */
export const OBJECTS_DIR = joinPath(GIT_DIR, "objects");
export const PACK_DIR = joinPath(OBJECTS_DIR, "pack");

// ============================================================================
// Shared state between steps
// ============================================================================

export interface AppState {
  repository?: History;
  git?: Git;
  files?: FilesApi;
  commits: CommitInfo[];
  initialFiles: Map<string, string>;
}

export interface CommitInfo {
  id: ObjectId;
  message: string;
  files: Map<string, string>;
  branch?: string;
}

export const state: AppState = {
  commits: [],
  initialFiles: new Map(),
};

// ============================================================================
// Logging utilities
// ============================================================================

export function log(message: string): void {
  const timestamp = new Date().toISOString().substring(11, 19);
  console.log(`[${timestamp}] ${message}`);
}

export function logSection(title: string): void {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(70));
}

export function logInfo(label: string, value: string | number | boolean): void {
  console.log(`  ${label}: ${value}`);
}

export function logSuccess(message: string): void {
  console.log(`  ✓ ${message}`);
}

export function logError(message: string): void {
  console.log(`  ✗ ${message}`);
}

// ============================================================================
// File utilities
// ============================================================================

/** FilesApi rooted at the current working directory (parent of the repository) */
export function createWorkspaceFilesApi(): FilesApi {
  return createNodeFilesApi({ rootDir: process.cwd() });
}

/** FilesApi rooted at the demo repository */
export function createFilesApi(): FilesApi {
  return createNodeFilesApi({ rootDir: REPO_DIR });
}

/**
 * Write a file to the working tree using FilesAPI.
 * Creates parent directories as needed.
 */
export async function writeFileToWorktree(
  files: FilesApi,
  filePath: string,
  content: string,
): Promise<void> {
  // Create parent directories if needed
  const dir = filePath.includes("/") ? filePath.substring(0, filePath.lastIndexOf("/")) : "";
  if (dir) {
    await files.mkdir(dir);
  }

  // Write file content (files.write expects Iterable<Uint8Array>)
  const data = new TextEncoder().encode(content);
  await files.write(filePath, [data]);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function shortId(id: ObjectId): string {
  return id.substring(0, 7);
}

// ============================================================================
// Filesystem utilities
// ============================================================================

export async function cleanupRepo(): Promise<void> {
  await createWorkspaceFilesApi().remove(REPO_NAME);
}

/** Create the (empty) repository directory */
export async function createRepoDir(): Promise<void> {
  await createWorkspaceFilesApi().mkdir(REPO_NAME);
}

export async function countLooseObjects(): Promise<{ count: number; objects: string[] }> {
  const files = createFilesApi();
  const objects: string[] = [];

  for await (const dir of files.list(OBJECTS_DIR)) {
    if (dir.kind !== "directory") continue;
    if (!/^[0-9a-f]{2}$/i.test(dir.name)) continue;

    for await (const file of files.list(dir.path)) {
      if (file.kind === "file" && /^[0-9a-f]{38}$/i.test(file.name)) {
        objects.push(dir.name + file.name);
      }
    }
  }

  return { count: objects.length, objects };
}

export async function listPackFiles(): Promise<string[]> {
  const packs: string[] = [];
  for await (const entry of createFilesApi().list(PACK_DIR)) {
    if (entry.kind === "file" && entry.name.endsWith(".pack")) {
      packs.push(entry.name);
    }
  }
  return packs;
}

export async function getPackFileStats(): Promise<
  { name: string; size: number; sizeFormatted: string }[]
> {
  const files = createFilesApi();
  const stats: { name: string; size: number; sizeFormatted: string }[] = [];

  for await (const entry of files.list(PACK_DIR)) {
    if (entry.kind === "file" && entry.name.endsWith(".pack")) {
      const size = entry.size ?? (await files.stats(entry.path))?.size ?? 0;
      stats.push({
        name: entry.name,
        size,
        sizeFormatted: formatBytes(size),
      });
    }
  }

  return stats;
}

// Re-export types
export type { Git } from "@statewalker/vcs-commands";
