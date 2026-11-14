/**
 * File-backed Git storage backend factory.
 *
 * Creates a History instance from a FilesApi with standard Git on-disk layout:
 * - Loose objects in `.git/objects/XX/XXXX...` (compressed with zlib)
 * - Pack files in `.git/objects/pack/` (read-only fallback)
 * - Refs in `.git/refs/`, HEAD in `.git/HEAD`
 * - All objects (including blobs) stored with Git headers for format compatibility
 */

import type { FilesApi, GitObjects, History } from "@statewalker/vcs-core";
import { createGitObjects, createHistoryFromComponents, joinPath } from "@statewalker/vcs-core";
import type { AtomicFiles } from "@statewalker/vcs-utils/files";
import { PackDirectory } from "./pack/pack-directory.js";
import { skipPacked, withPacks } from "./pack/with-packs.js";
import { createFileRefStore } from "./refs/ref-store.files.js";
import { filesStagingStore } from "./storage/loose/files-staging-store.js";
import { FileRawStorage } from "./storage/raw/file-raw-storage.js";

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
  /**
   * Lock-file primitives rooted at the `.git` directory, for atomic ref batches.
   * Defaults to a FilesApi-based implementation that is atomic only among users of
   * the same FilesApi instance;
   * pass `createNodeAtomicFiles(gitDirOnDisk)` from `@statewalker/vcs-utils-node`
   * to interoperate safely with native git.
   */
  atomicFiles?: AtomicFiles;
  /** Retry a held ref lock for this long (git: core.filesRefLockTimeout, 100 ms). */
  refLockTimeoutMs?: number;
  /** Retry a held packed-refs.lock for this long (git: core.packedRefsTimeout, 1000 ms). */
  packedLockTimeoutMs?: number;
}

/**
 * Result of creating a file-backed Git storage backend.
 */
export interface GitFilesBackendResult {
  /** History instance providing typed store access (blobs, trees, commits, tags, refs) */
  history: History;
  /** The object kernel: loose objects first, then packs (`withPacks`). */
  objects: GitObjects;
  /** Pack directory for pack file management (repack, GC) */
  packDirectory: PackDirectory;
  /** Loose object storage (for repack/GC operations) */
  looseStorage: FileRawStorage;
}

/**
 * Create a file-backed Git storage backend.
 *
 * Wires up all storage layers from a single FilesApi:
 * 1. filesStagingStore → createGitObjects (loose objects, git's layout)
 * 2. PackDirectory, read through withPacks (loose first, then packs)
 * 3. FileRawStorage over the same loose files, for gc and repack
 * 4. FileRefStore (Refs)
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

  // Objects: the kernel over git's loose layout (tmp_obj_* and a rename), reading
  // packs as a fallback. FileRawStorage reads and writes the same zlib files for
  // gc and repack.
  const looseStorage = new FileRawStorage(files, objectsDir);
  const packDirectory = new PackDirectory({ files, basePath: packDir });
  await packDirectory.scan();
  const loose = createGitObjects(skipPacked(filesStagingStore(files, objectsDir), packDirectory));
  const objects = withPacks(loose, packDirectory);
  const refStore = createFileRefStore(files, gitDir, {
    atomicFiles: options.atomicFiles,
    refLockTimeoutMs: options.refLockTimeoutMs,
    packedLockTimeoutMs: options.packedLockTimeoutMs,
  });

  const history = createHistoryFromComponents({
    objects,
    refs: refStore,
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
