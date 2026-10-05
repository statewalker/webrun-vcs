/**
 * File-backed Git storage backend factory.
 *
 * Creates a History instance from a FilesApi with standard Git on-disk layout:
 * - Loose objects in `.git/objects/XX/XXXX...` (compressed with zlib)
 * - Pack files in `.git/objects/pack/` (read-only fallback)
 * - Refs in `.git/refs/`, HEAD in `.git/HEAD`
 * - All objects (including blobs) stored with Git headers for format compatibility
 */

import type { FilesApi, GitObjectStore, History } from "@statewalker/vcs-core";
import {
  CompositeRawStorage,
  createGitObjectStore,
  createHistoryFromComponents,
  joinPath,
} from "@statewalker/vcs-core";
import { PackDirectory } from "./pack/pack-directory.js";
import { createFileRefStore } from "./refs/ref-store.files.js";
import { FileRawStorage } from "./storage/raw/file-raw-storage.js";
import { PackDirectoryAdapter } from "./storage/raw/pack-directory-adapter.js";

/**
 * Options for creating a file-backed Git storage backend.
 */
export interface GitFilesBackendOptions {
  /** FilesApi providing filesystem access */
  files: FilesApi;
  /** Path to .git directory relative to files root (default: ".git") */
  gitDir?: string;
  /** Whether to create the .git directory structure if it doesn't exist (default: false) */
  create?: boolean;
  /** Default branch name when creating a new repository (default: "main") */
  defaultBranch?: string;
}

/**
 * Result of creating a file-backed Git storage backend.
 */
export interface GitFilesBackendResult {
  /** History instance providing typed store access (blobs, trees, commits, tags, refs) */
  history: History;
  /** Low-level GitObjectStore for raw object access (headers, type codes) */
  objects: GitObjectStore;
  /** Pack directory for pack file management (repack, GC) */
  packDirectory: PackDirectory;
  /** Loose object storage (for repack/GC operations) */
  looseStorage: FileRawStorage;
}

/**
 * Create a file-backed Git storage backend.
 *
 * Wires up all storage layers from a single FilesApi:
 * 1. FileRawStorage (loose objects with zlib compression)
 * 2. PackDirectoryAdapter (read-only pack file access)
 * 3. CompositeRawStorage (loose + packs) → GitObjectStore
 * 4. FileRefStore → Refs adapter
 * 5. Composed into History via createHistoryFromComponents()
 *
 * @example
 * ```typescript
 * import { createInMemoryFilesApi } from "@statewalker/vcs-utils";
 * import { createGitFilesBackend } from "@statewalker/vcs-store-files";
 *
 * const files = createInMemoryFilesApi();
 * const { history, objects } = await createGitFilesBackend({
 *   files,
 *   create: true,
 * });
 * await history.initialize();
 *
 * const blobId = await history.blobs.store([new TextEncoder().encode("hello")]);
 * ```
 */
export async function createGitFilesBackend(
  options: GitFilesBackendOptions,
): Promise<GitFilesBackendResult> {
  const { files, gitDir = ".git", create = false, defaultBranch = "main" } = options;

  const objectsDir = joinPath(gitDir, "objects");
  const packDir = joinPath(objectsDir, "pack");

  if (create) {
    await createGitDirectoryStructure(files, gitDir, objectsDir, defaultBranch);
  }

  // Build storage layers.
  // FileRawStorage handles zlib compression/decompression (compress: true by default).
  // PackDirectoryAdapter provides read-only access to pack files.
  // CompositeRawStorage combines loose (read/write) with packs (read-only fallback).
  // GitObjectStore adds Git headers ("type size\0content").
  const looseStorage = new FileRawStorage(files, objectsDir);
  const packDirectory = new PackDirectory({ files, basePath: packDir });
  await packDirectory.scan();
  const packAdapter = new PackDirectoryAdapter(packDirectory);
  const compositeStorage = new CompositeRawStorage(looseStorage, [packAdapter]);
  const objects = createGitObjectStore(compositeStorage);
  const refStore = createFileRefStore(files, gitDir);

  const history = createHistoryFromComponents({
    objects,
    refs: { type: "adapter", refStore },
  });

  return { history, objects, packDirectory, looseStorage };
}

/**
 * Create standard .git directory structure.
 */
async function createGitDirectoryStructure(
  files: FilesApi,
  gitDir: string,
  objectsDir: string,
  defaultBranch: string,
): Promise<void> {
  await files.mkdir(gitDir);
  await files.mkdir(objectsDir);
  await files.mkdir(joinPath(objectsDir, "pack"));
  await files.mkdir(joinPath(gitDir, "refs"));
  await files.mkdir(joinPath(gitDir, "refs", "heads"));
  await files.mkdir(joinPath(gitDir, "refs", "tags"));

  const encoder = new TextEncoder();
  await files.write(joinPath(gitDir, "HEAD"), [
    encoder.encode(`ref: refs/heads/${defaultBranch}\n`),
  ]);
  await files.write(joinPath(gitDir, "config"), [
    encoder.encode(
      `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = ${gitDir === "." ? "true" : "false"}\n`,
    ),
  ]);
}
