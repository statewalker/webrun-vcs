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
import { type AtomicFiles, readFile } from "@statewalker/vcs-utils/files";
import { skipPacked, withPacks } from "./pack/with-packs.js";
import { beginFilesQuarantine } from "./quarantine/files-quarantine.js";
import { createFileRefStore } from "./refs/ref-store.files.js";
import { filesStagingStore } from "./storage/loose/files-staging-store.js";
import { FileRawStorage } from "./storage/raw/file-raw-storage.js";
import { createWorkingCopyConfig } from "./workspace/working-copy/working-copy-config.files.js";

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
   * Defaults to `atomicFilesOver(files, ".git")`: cross-process when the FilesApi has
   * `createExclusive`, otherwise atomic only among users of the same FilesApi instance
   * (another process, such as native git, is not excluded then).
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
  /**
   * Which refs get a new reflog (git: core.logAllRefUpdates). Read from the repository's
   * config when omitted: `core.logAllRefUpdates`, else `true` for a non-bare repository
   * and `false` for a bare one (`core.bare`), as git.
   */
  logAllRefUpdates?: boolean | "always";
  /** Reflog name and email; read from `user.name` / `user.email` in the config when omitted. */
  reflogIdentity?: { name: string; email: string };
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
    await createGitDirectoryStructure(files, gitDir, objectsDir);
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
  // receive-pack keeps a pushed pack in objects/tmp_objdir-incoming-* until the push is accepted
  objects.beginQuarantine = () =>
    beginFilesQuarantine({ files, objectsDir, objects, packs, freshenMaxAgeMs });
  const reflog = await readReflogConfig(files, gitDir);
  const refStore = createFileRefStore(files, gitDir, {
    atomicFiles: options.atomicFiles,
    refLockTimeoutMs: options.refLockTimeoutMs,
    packedLockTimeoutMs: options.packedLockTimeoutMs,
    logAllRefUpdates: options.logAllRefUpdates ?? reflog.logAllRefUpdates,
    reflogIdentity: options.reflogIdentity ?? reflog.identity,
  });
  // HEAD as git init writes it (create_symref): `ref: …` into HEAD.lock, renamed over HEAD
  if (create) await refStore.setSymbolic("HEAD", `refs/heads/${defaultBranch}`);

  const history = createHistoryFromComponents({
    objects,
    refs: refStore,
    packs,
  });

  return { history, objects, packs, looseStorage, files, gitDir };
}

/** A git boolean as the config parser returns it (`""` and `0` are false); else undefined. */
function gitBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (value === "") return false;
  return undefined;
}

/**
 * The reflog settings of the repository's config, as git reads them: core.logAllRefUpdates
 * (a boolean or "always"), defaulting to true unless core.bare is true; user.name and
 * user.email for the reflog identity (each defaulting to webrun-vcs <vcs@localhost>).
 */
async function readReflogConfig(
  files: FilesApi,
  gitDir: string,
): Promise<{
  logAllRefUpdates: boolean | "always";
  identity?: { name: string; email: string };
}> {
  const config = await createWorkingCopyConfig(
    {
      read: async (path) => ((await files.exists(path)) ? readFile(files, path) : undefined),
      write: (path, content) => files.write(path, [content]),
    },
    gitDir,
  );
  const setting = config.get("core.logAllRefUpdates");
  const logAllRefUpdates =
    typeof setting === "string" && setting.toLowerCase() === "always"
      ? "always"
      : (gitBoolean(setting) ?? !(gitBoolean(config.get("core.bare")) ?? false));
  const name = config.get("user.name");
  const email = config.get("user.email");
  const identity =
    name !== undefined || email !== undefined
      ? { name: String(name ?? "webrun-vcs"), email: String(email ?? "vcs@localhost") }
      : undefined;
  return { logAllRefUpdates, identity };
}

/**
 * Create standard .git directory structure (HEAD is written by the ref store, under its lock).
 */
async function createGitDirectoryStructure(
  files: FilesApi,
  gitDir: string,
  objectsDir: string,
): Promise<void> {
  await files.mkdir(gitDir);
  await files.mkdir(objectsDir);
  await files.mkdir(joinPath(objectsDir, "pack"));
  await files.mkdir(joinPath(gitDir, "refs"));
  await files.mkdir(joinPath(gitDir, "refs", "heads"));
  await files.mkdir(joinPath(gitDir, "refs", "tags"));

  const encoder = new TextEncoder();
  await files.write(joinPath(gitDir, "config"), [
    encoder.encode(
      `[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = ${gitDir === "." ? "true" : "false"}\n`,
    ),
  ]);
}
