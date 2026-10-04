/**
 * Git infrastructure setup — extracted from controllers/index.ts.
 *
 * Provides two modes:
 * - In-memory (existing): MemoryHistory + MemoryWorktree
 * - File-backed: FilesApi-based History + FileWorktree
 */

import { Git } from "@statewalker/vcs-commands";
import type { FilesApi, History, SerializationApi } from "@statewalker/vcs-core";
import {
  createGitObjectStore,
  createHistoryFromComponents,
  createMemoryHistory,
  DefaultSerializationApi,
  joinPath,
} from "@statewalker/vcs-core";
import { createFileRefStore, FileRawStorage, FileWorktree } from "@statewalker/vcs-store-files";
import type { Worktree } from "@statewalker/vcs-working-tree";
import {
  createGitStaging,
  createMemoryGitStaging,
  MemoryCheckout,
  MemoryWorkingCopy,
  MemoryWorktree,
} from "@statewalker/vcs-working-tree";

import type { AppContext } from "./index.js";
import { setGit, setHistory, setSerializationApi, setWorkingCopy, setWorktree } from "./index.js";

function createSerializationApi(history: History): SerializationApi {
  return new DefaultSerializationApi({ history });
}

/**
 * Initialize in-memory Git infrastructure (existing behavior).
 */
export async function initializeGitInMemory(ctx: AppContext): Promise<void> {
  const history = createMemoryHistory();
  await history.initialize();
  await history.refs.setSymbolic("HEAD", "refs/heads/main");
  setHistory(ctx, history);

  const staging = createMemoryGitStaging();
  const checkout = new MemoryCheckout({
    staging,
    initialHead: { type: "symbolic", target: "refs/heads/main" },
  });

  const worktree = new MemoryWorktree({
    blobs: history.blobs,
    trees: history.trees,
  });
  setWorktree(ctx, worktree);

  const workingCopy = new MemoryWorkingCopy({
    history,
    checkout,
    worktree,
  });
  setWorkingCopy(ctx, workingCopy);

  const git = Git.fromWorkingCopy(workingCopy);
  setGit(ctx, git);

  const serialization = createSerializationApi(history);
  setSerializationApi(ctx, serialization);
}

/**
 * Initialize Git infrastructure from a FilesApi (file-backed storage).
 *
 * All objects (including blobs) go through a single GitObjectStore, matching
 * real Git's on-disk format where every object has a "type size\0" header.
 *
 * @param ctx Application context to populate
 * @param files FilesApi providing filesystem access
 * @returns Object with the storage label for UI display
 */
export async function initializeGitFromFiles(ctx: AppContext, files: FilesApi): Promise<void> {
  const gitDir = ".git";
  const objectsDir = joinPath(gitDir, "objects");

  // Detect whether .git already exists
  const gitDirExists = await files.exists(gitDir);

  if (!gitDirExists) {
    // Create .git structure
    await files.mkdir(gitDir);
    await files.mkdir(objectsDir);
    await files.mkdir(joinPath(objectsDir, "pack"));
    await files.mkdir(joinPath(gitDir, "refs"));
    await files.mkdir(joinPath(gitDir, "refs", "heads"));
    await files.mkdir(joinPath(gitDir, "refs", "tags"));

    const encoder = new TextEncoder();
    await files.write(joinPath(gitDir, "HEAD"), [encoder.encode("ref: refs/heads/main\n")]);
    await files.write(joinPath(gitDir, "config"), [
      encoder.encode("[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n"),
    ]);
  }

  // Build History from file components.
  // FileRawStorage handles zlib compression/decompression by default.
  // GitObjectStore adds Git headers ("type size\0content")
  // — matching real Git's on-disk format.
  const looseStorage = new FileRawStorage(files, objectsDir);
  const objects = createGitObjectStore(looseStorage);
  const refStore = createFileRefStore(files, gitDir);

  const history = createHistoryFromComponents({
    objects,
    refs: { type: "adapter", refStore },
  });
  await history.initialize();
  setHistory(ctx, history);

  // Create file-backed worktree
  const worktree: Worktree = new FileWorktree({
    files,
    rootPath: "/",
    blobs: history.blobs,
    trees: history.trees,
    gitDir,
  });
  setWorktree(ctx, worktree as MemoryWorktree);

  // Create file-backed staging (reads/writes native .git/index)
  const indexPath = joinPath(gitDir, "index");
  const staging = createGitStaging(files, indexPath);
  const checkout = new MemoryCheckout({
    staging,
    initialHead: { type: "symbolic", target: "refs/heads/main" },
  });

  // Create WorkingCopy
  const workingCopy = new MemoryWorkingCopy({
    history,
    checkout,
    worktree,
  });
  setWorkingCopy(ctx, workingCopy);

  // Create Git porcelain API
  const git = Git.fromWorkingCopy(workingCopy);
  setGit(ctx, git);

  // Create SerializationApi
  const serialization = createSerializationApi(history);
  setSerializationApi(ctx, serialization);

  // Read existing .git/index if present — populates staging with
  // the persisted index entries so new commits include all tracked files.
  await staging.read();
}
