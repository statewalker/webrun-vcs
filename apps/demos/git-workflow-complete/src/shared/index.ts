/**
 * Shared utilities for the complete Git workflow demo
 *
 * This demo uses ONLY porcelain commands from @statewalker/vcs-commands
 * and FilesAPI for all operations. No low-level API or native git calls.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Git } from "@statewalker/vcs-commands";
import type { FilesApi, History, ObjectId } from "@statewalker/vcs-core";
import { setCompressionUtils } from "@statewalker/vcs-utils";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";

// Initialize compression (required before any storage operations)
setCompressionUtils(createNodeCompression());

// ============================================================================
// Configuration
// ============================================================================

export const REPO_DIR = path.join(process.cwd(), "test-workflow-repo");
export const GIT_DIR = ".git";
export const OBJECTS_DIR = path.join(REPO_DIR, GIT_DIR, "objects");
export const PACK_DIR = path.join(OBJECTS_DIR, "pack");

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
  try {
    await fs.rm(REPO_DIR, { recursive: true, force: true });
  } catch {
    // Directory doesn't exist
  }
}

export async function countLooseObjects(): Promise<{ count: number; objects: string[] }> {
  const objects: string[] = [];

  try {
    const fanoutDirs = await fs.readdir(OBJECTS_DIR);

    for (const dir of fanoutDirs) {
      if (dir === "pack" || dir === "info" || dir.length !== 2) continue;
      if (!/^[0-9a-f]{2}$/i.test(dir)) continue;

      const subdir = path.join(OBJECTS_DIR, dir);
      try {
        const files = await fs.readdir(subdir);
        for (const file of files) {
          if (file.length === 38 && /^[0-9a-f]{38}$/i.test(file)) {
            objects.push(dir + file);
          }
        }
      } catch {
        // Directory doesn't exist
      }
    }
  } catch {
    // Objects directory doesn't exist
  }

  return { count: objects.length, objects };
}

export async function listPackFiles(): Promise<string[]> {
  const packs: string[] = [];

  try {
    const files = await fs.readdir(PACK_DIR);
    for (const file of files) {
      if (file.endsWith(".pack")) {
        packs.push(file);
      }
    }
  } catch {
    // Pack directory doesn't exist
  }

  return packs;
}

export async function getPackFileStats(): Promise<
  { name: string; size: number; sizeFormatted: string }[]
> {
  const stats: { name: string; size: number; sizeFormatted: string }[] = [];

  try {
    const files = await fs.readdir(PACK_DIR);
    for (const file of files) {
      if (file.endsWith(".pack")) {
        const packPath = path.join(PACK_DIR, file);
        const stat = await fs.stat(packPath);
        stats.push({
          name: file,
          size: stat.size,
          sizeFormatted: formatBytes(stat.size),
        });
      }
    }
  } catch {
    // Pack directory doesn't exist
  }

  return stats;
}

// Re-export types
export type { Git } from "@statewalker/vcs-commands";
// Re-export fs and path for cleanup step
export { fs, path };
