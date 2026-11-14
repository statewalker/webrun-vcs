/**
 * File-backed Git storage backend factory.
 *
 * Creates a History instance from a FilesApi with standard Git on-disk layout:
 * - Loose objects in `.git/objects/XX/XXXX...` (compressed with zlib)
 * - Pack files in `.git/objects/pack/`, read first (as git and JGit do)
 * - Refs in `.git/refs/`, HEAD in `.git/HEAD`
 * - All objects (including blobs) stored with Git headers for format compatibility
 */

import type { FilesApi, GitObjects, History, PackSet } from "@statewalker/vcs-core";
import {
  createGitObjects,
  createHistoryFromComponents,
  joinPath,
  openPackSet,
} from "@statewalker/vcs-core";
import type { AtomicFiles } from "@statewalker/vcs-utils/files";
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
   * the same FilesApi instance (another process, such as native git, is not excluded).
   */
  atomicFiles?: AtomicFiles;
  /** Retry a held ref lock for this long (git: core.filesRefLockTimeout, 100 ms). */
  refLockTimeoutMs?: number;
  /** Retry a held packed-refs.lock for this long (git: core.packedRefsTimeout, 1000 ms). */
  packedLockTimeoutMs?: number;
  /**
   * git's freshen window (default one hour): writing an object whose pack or loose file was
   * last modified longer ago writes it loose again or renews the loose file's mtime, so a
   * concurrent gc keeps it. Passed to `openPackSet` and `filesStagingStore`.
   */
  freshenMaxAgeMs?: number;
}

/**
 * Result of creating a file-backed Git storage backend.
 */
export interface GitFilesBackendResult {
  /** History instance providing typed store access (blobs, trees, commits, tags, refs) */
  history: History;
  /** The object kernel: packs first, then loose objects (`withPacks`). */
  objects: GitObjects;
  /** The installed packs, read by `objects`; `repack()` installs and removes packs here. */
  packs: PackSet;
  /** Loose object storage (for repack/GC operations) */
  looseStorage: FileRawStorage;
  /** The FilesApi the repository lives in (for `repack()` and `gc()`). */
  files: FilesApi;
  /** Path of the `.git` directory within `files`. */
  gitDir: string;
}

/**
 * Create a file-backed Git storage backend.
 *
 * Wires up all storage layers from a single FilesApi:
 * 1. filesStagingStore → createGitObjects (loose objects, git's layout)
 * 2. openPackSet over objects/pack, read through withPacks (packs first, then loose)
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

  // Objects: the installed packs first, then the kernel over git's loose layout
  // (tmp_obj_* and a rename). A REF_DELTA base outside its pack resolves through the
  // other packs, then the loose objects. FileRawStorage reads and writes the same
  // zlib files for gc and repack.
  const looseStorage = new FileRawStorage(files, objectsDir);
  const { freshenMaxAgeMs } = options;
  const staging = filesStagingStore(files, objectsDir, { freshenMaxAgeMs });
  const looseOnly = createGitObjects(staging);
  const packs = await openPackSet(files, packDir, {
    externalBase: (id) => looseOnly.get(id),
    freshenMaxAgeMs,
  });
  const loose = createGitObjects(skipPacked(staging, packs));
  const objects = withPacks(loose, packs);
  const refStore = createFileRefStore(files, gitDir, {
    atomicFiles: options.atomicFiles,
    refLockTimeoutMs: options.refLockTimeoutMs,
    packedLockTimeoutMs: options.packedLockTimeoutMs,
  });

  const history = createHistoryFromComponents({
    objects,
    refs: refStore,
    packs,
  });

  return { history, objects, packs, looseStorage, files, gitDir };
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
