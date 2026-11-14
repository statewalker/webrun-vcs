/**
 * Shared utilities for the internal storage example.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  FilesApi,
  GitObjectStore,
  History,
  ObjectId,
  PersonIdent,
} from "@statewalker/vcs-core";
import { createGitObjectStore, createHistoryFromComponents, joinPath } from "@statewalker/vcs-core";
import { createFileRefStore, FileRawStorage } from "@statewalker/vcs-store-files";
import { setCompressionUtils } from "@statewalker/vcs-utils";
import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";

// Initialize compression (required before any storage operations)
setCompressionUtils(createNodeCompression());

// ============================================================================
// Configuration
// ============================================================================

export const REPO_DIR = path.join(process.cwd(), "test-repo");
export const GIT_DIR = ".git";
export const OBJECTS_DIR = path.join(REPO_DIR, GIT_DIR, "objects");
export const PACK_DIR = path.join(OBJECTS_DIR, "pack");

// ============================================================================
// Extended History type with objects access
// ============================================================================

/**
 * Extended History type that also exposes the GitObjectStore for low-level operations.
 * This is needed for internal storage demonstrations.
 */
export interface FileHistory extends History {
  /** Low-level object store for raw object access */
  readonly objects: GitObjectStore;
}

// ============================================================================
// Shared state between steps
// ============================================================================

export interface AppState {
  history?: FileHistory;
  commits: CommitInfo[];
  objectIds: string[];
}

export interface CommitInfo {
  id: ObjectId;
  message: string;
}

export const state: AppState = {
  commits: [],
  objectIds: [],
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
  console.log(`  [OK] ${message}`);
}

export function logError(message: string): void {
  console.log(`  [ERROR] ${message}`);
}

// ============================================================================
// File utilities
// ============================================================================

export function createFilesApi(): FilesApi {
  return createNodeFilesApi({ rootDir: REPO_DIR });
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
// History factory
// ============================================================================

/**
 * Create a file-based History instance with objects access.
 */
export async function createFileHistory(options: {
  files: FilesApi;
  gitDir: string;
  create?: boolean;
  defaultBranch?: string;
}): Promise<FileHistory> {
  const { files, gitDir, create = false, defaultBranch = "main" } = options;

  const objectsDir = joinPath(gitDir, "objects");

  // Create file storage for objects (FileRawStorage compresses by default)
  const looseStorage = new FileRawStorage(files, objectsDir);

  // Create Git object store for blobs, trees, commits, tags
  const objects = createGitObjectStore(looseStorage);

  // Create file-based ref store
  const refStore = createFileRefStore(files, gitDir);

  // Create History from components
  const history = createHistoryFromComponents({
    objects,
    refs: refStore,
  });

  // Initialize if creating
  if (create) {
    await files.mkdir(gitDir);
    await files.mkdir(objectsDir);
    await files.mkdir(joinPath(objectsDir, "pack"));
    await files.mkdir(joinPath(gitDir, "refs"));
    await files.mkdir(joinPath(gitDir, "refs", "heads"));
    await files.mkdir(joinPath(gitDir, "refs", "tags"));

    // Write HEAD
    const headContent = `ref: refs/heads/${defaultBranch}\n`;
    await files.write(joinPath(gitDir, "HEAD"), [new TextEncoder().encode(headContent)]);

    // Write basic config
    const configContent = `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = false
`;
    await files.write(joinPath(gitDir, "config"), [new TextEncoder().encode(configContent)]);
  }

  await history.initialize();

  // Return extended History with objects access
  // Use Object.assign to preserve prototype methods (close, initialize)
  return Object.assign(history, { objects }) as FileHistory;
}

// ============================================================================
// Repository utilities
// ============================================================================

export function createAuthor(
  name = "Internal Storage Example",
  email = "example@demo.com",
  timestamp = Math.floor(Date.now() / 1000),
): PersonIdent {
  return {
    name,
    email,
    timestamp,
    tzOffset: "+0000",
  };
}

export async function storeBlob(history: History, content: string): Promise<ObjectId> {
  const bytes = new TextEncoder().encode(content);
  return history.blobs.store([bytes]);
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

// ============================================================================
// Native git utilities
// ============================================================================

export function runGitCommand(cmd: string): string {
  try {
    return execSync(cmd, { cwd: REPO_DIR, encoding: "utf-8" }).trim();
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    return `ERROR: ${e.stderr || e.message}`;
  }
}

export function isGitAvailable(): boolean {
  try {
    execSync("git --version", { encoding: "utf-8" });
    return true;
  } catch {
    return false;
  }
}

// Re-export fs for steps that need direct access
export { fs, path };
