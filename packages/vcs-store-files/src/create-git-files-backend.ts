/**
 * File-backed Git storage backend factory.
 *
 * Creates a History instance from a FilesApi with standard Git on-disk layout:
 * - Loose objects in `.git/objects/XX/XXXX...` (compressed with zlib)
 * - Pack files in `.git/objects/pack/`, read first (as git and JGit do)
 * - Refs in `.git/refs/`, HEAD in `.git/HEAD`
 * - All objects (including blobs) stored with Git headers for format compatibility
 */

import type {
  CommitGraphProvider,
  FilesApi,
  GitObjects,
  History,
  PackSet,
} from "@statewalker/vcs-core";
import {
  createGitObjects,
  createHistoryFromComponents,
  graftFileBaseDir,
  graftFileReader,
  joinPath,
  openPackSet,
} from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils/encoding";
import { type AtomicFiles, readFile } from "@statewalker/vcs-utils/files";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import { createFilesCommitGraphProvider } from "./commit-graph.js";
import { readDeltaBaseCacheLimit, skipPacked, withPacks } from "./pack/index.js";
import { beginFilesQuarantine } from "./quarantine/files-quarantine.js";
import { createFileRefStore, type FileRefStore } from "./refs/ref-store.files.js";
import { readRepositoryFormat } from "./repository-format.js";
import { resolveLinkedGitDir } from "./resolve-linked-git-dir.js";
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
  /**
   * Retry a held ref lock for this long (git: core.filesRefLockTimeout, 100 ms; negative:
   * forever, 0: one attempt). Read from the repository's config when omitted.
   */
  refLockTimeoutMs?: number;
  /**
   * Retry a held packed-refs.lock for this long (git: core.packedRefsTimeout, 1000 ms;
   * negative: forever, 0: one attempt). Read from the repository's config when omitted.
   */
  packedLockTimeoutMs?: number;
  /**
   * git's freshen window (default one hour): writing an object whose pack was last modified
   * longer ago renews the pack's mtime (or writes the object loose where times cannot be
   * set), so a concurrent gc keeps it; a loose file is touched on every such write (rewritten
   * when older than this where times cannot be set). Passed to `openPackSet` and
   * `filesStagingStore`.
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
  /**
   * The user's environment (`createNodeGitHostEnvironment` on Node): the commit-graph
   * settings (`core.commitGraph`, `commitGraph.*`) are then read from the system and global
   * config files too, as git reads them. Absent, only the repository's config is read. Its
   * grafts file (`GIT_GRAFT_FILE`) is read in place of `info/grafts` (`refs.readGrafts`).
   */
  environment?: GitHostEnvironment;
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
 * 5. The commit-graph provider (`objects/info/commit-graph`, read on first use as git does)
 * 6. Composed into History via createHistoryFromComponents()
 *
 * The repository's format is checked first, as git does (`readRepositoryFormat`): a
 * `core.repositoryformatversion` above 1, an unknown version-1 extension, or one we do not
 * implement (`extensions.refStorage = reftable`, `extensions.objectFormat = sha256`,
 * `extensions.compatObjectFormat`) throws `UnsupportedRepositoryFormatError`.
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
  const { gitDir = ".git", create = false, defaultBranch = "main" } = options;
  // a `.git` or `.git/objects` the user linked elsewhere is followed, as git follows it
  const files = await resolveLinkedGitDir(options.files, gitDir);

  const objectsDir = joinPath(gitDir, "objects");
  const packDir = joinPath(objectsDir, "pack");

  // git's check_repository_format: a version or extension we cannot honour (reftable refs,
  // sha256 objects, an unknown v1 extension) is refused before anything is read or written
  await readRepositoryFormat(files, gitDir);

  if (create) {
    await createGitDirectoryStructure(files, gitDir, objectsDir);
  }

  // Objects: the installed packs first, then the kernel over git's loose layout
  // (tmp_obj_* and a rename). A REF_DELTA base outside its pack resolves through the
  // other packs, then the loose objects. FileRawStorage reads and writes the same
  // zlib files for gc and repack.
  const looseStorage = new FileRawStorage(files, objectsDir);
  const { freshenMaxAgeMs } = options;
  const staging = filesStagingStore(files, objectsDir, {
    freshenMaxAgeMs,
    cacheDirectoryChecks: true,
  });
  const looseOnly = createGitObjects(staging);
  const packs = await openPackSet(files, packDir, {
    externalBase: (id) => looseOnly.get(id),
    freshenMaxAgeMs,
    // git's core.deltaBaseCacheLimit (96 MiB when unset)
    baseCacheBytes: await readDeltaBaseCacheLimit(files, gitDir),
  });
  const loose = createGitObjects(skipPacked(staging, packs));
  const objects = withPacks(loose, packs);
  // receive-pack keeps a pushed pack in objects/tmp_objdir-incoming-* until the push is accepted
  objects.beginQuarantine = () =>
    beginFilesQuarantine({ files, objectsDir, objects, packs, freshenMaxAgeMs });
  const reflog = await readRefStoreConfig(files, gitDir);
  const refStore = createFileRefStore(files, gitDir, {
    atomicFiles: options.atomicFiles,
    refLockTimeoutMs: options.refLockTimeoutMs ?? reflog.refLockTimeoutMs,
    packedLockTimeoutMs: options.packedLockTimeoutMs ?? reflog.packedLockTimeoutMs,
    logAllRefUpdates: options.logAllRefUpdates ?? reflog.logAllRefUpdates,
    reflogIdentity: options.reflogIdentity ?? reflog.identity,
  });
  // GIT_GRAFT_FILE: the environment's grafts file is the one read (gc, repack and the
  // walks keep and follow its grafts), in place of info/grafts; a relative one from the
  // worktree top (the git directory when bare), where git's setup has changed to
  const readGraftFile = graftFileReader(options.environment, {
    files,
    dir: graftFileBaseDir(gitDir),
  });
  if (readGraftFile) refStore.readGrafts = readGraftFile;
  // HEAD as git init writes it (create_symref): `ref: …` into HEAD.lock, renamed over HEAD
  if (create) await refStore.setSymbolic("HEAD", `refs/heads/${defaultBranch}`);

  // the commit-graph (objects/info/commit-graph or its split chain), read on first use
  const commitGraph = createFilesCommitGraphProvider({
    files,
    gitDir,
    refs: refStore,
    environment: options.environment,
  });
  invalidateOnCompatibilityChange(refStore, commitGraph);
  const history = createHistoryFromComponents({
    objects,
    refs: refStore,
    packs,
    commitGraph,
  });

  return { history, objects, packs, looseStorage, files, gitDir };
}

/**
 * Forgets the loaded commit-graph when this ref store changes what decides whether it may be
 * used (git's commit_graph_compatible): the `shallow` file or a ref under `refs/replace/`. The
 * next walk loads it again (or finds it unusable). Changes made by another process (native
 * `git replace`, a `git fetch --depth`) are not seen until `commitGraph.invalidate()`.
 */
function invalidateOnCompatibilityChange(refs: FileRefStore, commitGraph: CommitGraphProvider) {
  const replace = (name: string) => name.startsWith("refs/replace/");
  const after = async <T>(change: Promise<T>, touches: boolean): Promise<T> => {
    try {
      return await change;
    } finally {
      if (touches) commitGraph.invalidate();
    }
  };
  const { setShallow, set, setSymbolic, remove, removeAll, compareAndSwap, batch } = refs;
  refs.setShallow = (...args) => after(setShallow.apply(refs, args), true);
  refs.set = (...args) => after(set.apply(refs, args), replace(args[0]));
  refs.setSymbolic = (...args) => after(setSymbolic.apply(refs, args), replace(args[0]));
  refs.remove = (...args) => after(remove.apply(refs, args), replace(args[0]));
  refs.removeAll = (...args) => after(removeAll.apply(refs, args), args[0].some(replace));
  refs.compareAndSwap = (...args) => after(compareAndSwap.apply(refs, args), replace(args[0]));
  refs.batch = (...args) =>
    after(
      batch.apply(refs, args),
      args[0].some((c) => replace(c.name)),
    );
}

/**
 * The ref store settings of the repository's config, as git reads them: core.logAllRefUpdates
 * (a boolean or "always"), defaulting to true unless core.bare is true; user.name and
 * user.email for the reflog identity (each defaulting to webrun-vcs <vcs@localhost>); the
 * lock timeouts core.filesRefLockTimeout and core.packedRefsTimeout (undefined when unset
 * or not an integer: the store's defaults, 100 and 1000 ms).
 */
async function readRefStoreConfig(
  files: FilesApi,
  gitDir: string,
): Promise<{
  logAllRefUpdates: boolean | "always";
  identity?: { name: string; email: string };
  refLockTimeoutMs?: number;
  packedLockTimeoutMs?: number;
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
      : (parseGitBool(setting) ?? !(parseGitBool(config.get("core.bare")) ?? false));
  const name = config.get("user.name");
  const email = config.get("user.email");
  const identity =
    name !== undefined || email !== undefined
      ? { name: String(name ?? "webrun-vcs"), email: String(email ?? "vcs@localhost") }
      : undefined;
  return {
    logAllRefUpdates,
    identity,
    refLockTimeoutMs: parseConfigInt(config.get("core.filesRefLockTimeout")),
    packedLockTimeoutMs: parseConfigInt(config.get("core.packedRefsTimeout")),
  };
}

/** An integer as git_config_int reads it (sign, decimal, 0x hex or 0 octal, then k, m or g). */
function parseConfigInt(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const match = /^\s*([-+]?)(0[xX][0-9a-fA-F]+|0[0-7]*|[1-9][0-9]*)([kKmMgG]?)\s*$/.exec(value);
  if (!match) return undefined;
  const digits = match[2] as string;
  const magnitude =
    digits.length > 2 && (digits[1] === "x" || digits[1] === "X")
      ? Number.parseInt(digits.slice(2), 16)
      : digits.length > 1 && digits.startsWith("0")
        ? Number.parseInt(digits.slice(1), 8)
        : Number.parseInt(digits, 10);
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(match[3] as string).toLowerCase()];
  const n = magnitude * (unit ?? 1) * (match[1] === "-" ? -1 : 1);
  return Number.isSafeInteger(n) ? n : undefined;
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
