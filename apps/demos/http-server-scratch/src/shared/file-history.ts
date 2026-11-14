/**
 * File-based History factory for the HTTP server demo.
 *
 * Creates a History instance backed by the filesystem with Git-compatible
 * loose object storage.
 */

import {
  createBlobs,
  createCommits,
  createGitObjects,
  createHistoryFromStores,
  createTags,
  createTrees,
  type FilesApi,
  type GitObjects,
  type History,
  joinPath,
} from "@statewalker/vcs-core";
import { createFileRefStore, filesStagingStore } from "@statewalker/vcs-store-files";

/**
 * Extended History type that also exposes the GitObjects for low-level operations.
 *
 * This is needed for the HTTP server demo to access raw object data for
 * pack file building during push operations.
 */
export interface FileHistory extends History {
  /** Low-level object store for raw object access */
  readonly objects: GitObjects;
}

/**
 * Options for creating a file-based History
 */
export interface CreateFileHistoryOptions {
  /** FilesApi for filesystem operations */
  files: FilesApi;
  /** Path to .git directory (relative to files root). Use "." for bare repos */
  gitDir: string;
  /** Whether to create the repository if it doesn't exist */
  create?: boolean;
  /** Default branch name (only used when creating) */
  defaultBranch?: string;
}

/**
 * Create a file-based History instance.
 *
 * This creates a History backed by Git-compatible loose object storage
 * with compressed objects in the standard .git/objects layout.
 *
 * @param options Configuration options
 * @returns FileHistory instance with both History API and objects access
 *
 * @example
 * ```typescript
 * const files = createNodeFilesApi({ rootDir: "/path/to/repo" });
 * const history = await createFileHistory({
 *   files,
 *   gitDir: ".git",
 *   create: true,
 *   defaultBranch: "main",
 * });
 *
 * // Use History API
 * const blobId = await history.blobs.store([content]);
 *
 * // Use objects API for low-level access
 * const obj = await history.objects.get(id); // { type, size, content }
 * ```
 */
export async function createFileHistory(options: CreateFileHistoryOptions): Promise<FileHistory> {
  const { files, gitDir, create = false, defaultBranch = "main" } = options;

  const objectsDir = joinPath(gitDir, "objects");

  // All objects (including blobs) go through one GitObjects over git's loose
  // layout (zlib, written through tmp_obj_* and a rename) in .git/objects.
  const objects = createGitObjects(filesStagingStore(files, objectsDir));
  const refStore = createFileRefStore(files, gitDir);

  const blobs = createBlobs(objects);
  const trees = createTrees(objects);
  const commits = createCommits(objects);
  const tags = createTags(objects);

  // `objects` lets received packs be written byte for byte through the kernel.
  const history = createHistoryFromStores({ blobs, trees, commits, tags, refs: refStore, objects });

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

    // Write basic config for bare repos
    const configContent = `[core]
\trepositoryformatversion = 0
\tfilemode = true
\tbare = ${gitDir === "." ? "true" : "false"}
`;
    await files.write(joinPath(gitDir, "config"), [new TextEncoder().encode(configContent)]);
  }

  await history.initialize();

  // Expose the low-level object store alongside the History facade.
  // NOTE: do NOT spread `history` here. createHistoryFromStores() returns a
  // HistoryImpl class instance whose methods (collectReachableObjects, close,
  // …) live on the prototype. Object spread copies only own enumerable
  // properties, so `{ ...history }` would silently drop those methods — which
  // makes the transport RepositoryFacade throw
  // "history.collectReachableObjects is not a function" during upload-pack.
  const fileHistory = history as History & { objects: GitObjects };
  fileHistory.objects = objects;
  return fileHistory;
}

/**
 * Get HEAD commit ID from a History instance.
 *
 * Resolves HEAD -> branch -> commit ID.
 *
 * @param history History instance
 * @returns Commit ID or undefined if repository is empty
 */
export async function getHead(history: History): Promise<string | undefined> {
  const resolved = await history.refs.resolve("HEAD");
  return resolved?.objectId;
}
