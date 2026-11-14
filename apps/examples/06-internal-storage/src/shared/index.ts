/**
 * Shared utilities for the internal storage example.
 */

import type { FilesApi, GitObjects, History, ObjectId, PersonIdent } from "@statewalker/vcs-core";
import { createGitObjects, createHistoryFromComponents, joinPath } from "@statewalker/vcs-core";
import { createFileRefStore, filesStagingStore } from "@statewalker/vcs-store-files";
import { joinPath as joinFilePath } from "@statewalker/vcs-utils/files";
import { createNodeFilesApi } from "@statewalker/vcs-utils-node/files";

// Initialize compression (required before any storage operations)

// ============================================================================
// Configuration
// ============================================================================

/** Name of the example repository folder, relative to the current directory */
export const REPO_NAME = "test-repo";
/** Absolute path of the example repository (for display) */
export const REPO_DIR = joinFilePath(process.cwd(), REPO_NAME);
export const GIT_DIR = ".git";
/** Paths inside the repository FilesApi (see createFilesApi) */
export const OBJECTS_DIR = joinFilePath(GIT_DIR, "objects");
export const PACK_DIR = joinFilePath(OBJECTS_DIR, "pack");

// ============================================================================
// Extended History type with objects access
// ============================================================================

/**
 * Extended History type that also exposes the GitObjects for low-level operations.
 * This is needed for internal storage demonstrations.
 */
export interface FileHistory extends History {
  /** Low-level object store for raw object access */
  readonly objects: GitObjects;
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

/** FilesApi rooted at the example repository */
export function createFilesApi(): FilesApi {
  return createNodeFilesApi({ rootDir: REPO_DIR });
}

/** FilesApi rooted at the current working directory (parent of the repository) */
export function createWorkspaceFilesApi(): FilesApi {
  return createNodeFilesApi({ rootDir: process.cwd() });
}

/** Path of a loose object inside the repository FilesApi */
export function looseObjectPath(objectId: string): string {
  return joinFilePath(OBJECTS_DIR, objectId.substring(0, 2), objectId.substring(2));
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

  // Git objects (blobs, trees, commits, tags) as loose objects in .git/objects
  const objects = createGitObjects(filesStagingStore(files, objectsDir));

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
  await createWorkspaceFilesApi().remove(REPO_NAME);
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
