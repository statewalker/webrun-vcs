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
  createCommitGraphProvider,
  createGitObjects,
  createHistoryFromComponents,
  createObjectPromisor,
  graftFileBaseDir,
  graftFileReader,
  joinPath,
  openPackSet,
  type PromisorPack,
  withLazyFetch,
} from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils/encoding";
import type { AtomicFiles } from "@statewalker/vcs-utils/files";
import {
  type ObjectFormat,
  SHA1_OBJECT_FORMAT,
  UnsupportedObjectFormatError,
} from "@statewalker/vcs-utils/hash";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import { openObjectAlternates, withAlternates } from "./alternates/index.js";
import { createFilesCommitGraphProvider } from "./commit-graph.js";
import {
  assertNoMultiPackIndexInFormat,
  parseConfigInt,
  readPackSetSettings,
  skipPacked,
  withPacks,
} from "./pack/index.js";
import { beginFilesQuarantine } from "./quarantine/files-quarantine.js";
import {
  createFileRefStore,
  createReftableRefStore,
  type FileRefStore,
  peelTag,
  type ReftableRefStore,
  type ReftableStackWriteOptions,
} from "./refs/index.js";
import { repack } from "./repack.js";
import { readRepositoryFormat } from "./repository-format.js";
import { resolveLinkedGitDir } from "./resolve-linked-git-dir.js";
import { filesStagingStore } from "./storage/loose/files-staging-store.js";
import { FileRawStorage } from "./storage/raw/file-raw-storage.js";
import {
  configFilesApiOf,
  createWorkingCopyConfig,
  type GitWorkingCopyConfig,
} from "./workspace/working-copy/working-copy-config.files.js";

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
  /**
   * The object format of a repository being created (`create`; default SHA-1, git's
   * `--object-format`); written to its config as `extensions.objectFormat`. Opening an existing
   * repository reads its own, and refuses another one given here.
   */
  objectFormat?: ObjectFormat;
  /** Default branch name when creating a new repository (default: "main") */
  defaultBranch?: string;
  /**
   * The ref storage of a repository created here (`create`): `files` (the default) or
   * `reftable` (`extensions.refStorage`, the refs in `<git dir>/reftable`, as `git init
   * --ref-format=reftable` lays them out)
   */
  refFormat?: "files" | "reftable";
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
   * The user's environment (`createNodeGitHostEnvironment` on Node): the settings read here
   * (`core.logAllRefUpdates`, `core.bare`, the lock timeouts, `core.multiPackIndex`,
   * `core.deltaBaseCacheLimit`, the commit-graph's, the alternates') then come from git's
   * whole sequence: the system and global files, the repository's, `config.worktree` and the
   * command line (`commandLineConfig`, `git -c`), as git reads them. Absent, only the
   * repository's config is read; the repository format is always its file alone. Its
   * grafts file (`GIT_GRAFT_FILE`) is read in place of `info/grafts` (`refs.readGrafts`).
   */
  environment?: GitHostEnvironment;
  /**
   * Which include directives of the repository's config are followed while its settings are
   * read here (see `GitConfigOptions.includes`): git's rule by default, `"files"` confined to
   * the repository's directory (a server's repositories), `false` none.
   */
  configIncludes?: boolean | "files";
  /**
   * Read the alternate object directories (`objects/info/alternates`, and
   * `$GIT_ALTERNATE_OBJECT_DIRECTORIES` unless `alternatesFromEnvironment` is false), as git
   * always does. Default true. A server whose storage holds repositories of owners who must
   * not read each other's objects passes false: the objects an alternate holds are then
   * missing (git honours alternates whatever the owner; see docs/transports.md).
   */
  alternates?: boolean;
  /**
   * Read `$GIT_ALTERNATE_OBJECT_DIRECTORIES` from `environment` (default true). False for a
   * repository opened as git opens another one in a child process with `local_repo_env`
   * cleared (a local remote, a served repository).
   */
  alternatesFromEnvironment?: boolean;
  /**
   * The worktree top in `files` (git's current directory after its setup): relative
   * `$GIT_ALTERNATE_OBJECT_DIRECTORIES` entries name directories from there. Default: the
   * git directory when bare, `core.worktree` when set, the directory holding `.git`, else (a
   * separate git directory) the FilesApi's root.
   */
  workTree?: string;
  /** Each of git's error lines (`error: ...`) while the alternates are read */
  onAlternatesError?: (line: string) => void;
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
 * implement (`extensions.compatObjectFormat`) throws `UnsupportedRepositoryFormatError`. A
 * SHA-256 repository (`extensions.objectFormat = sha256`) opens with 32-byte object ids
 * (`objects.objectFormat`): its packs, `.idx`, `.rev` and `.mtimes` hold 32-byte ids and
 * SHA-256 checksums. One holding a multi-pack-index is refused with
 * `UnsupportedObjectFormatError` (its reader holds 20-byte ids), its bitmaps are not used and
 * its commit-graph is not read.
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

  // git's check_repository_format: a version or extension we cannot honour (a compatibility
  // object format, an unknown v1 extension) is refused before anything is read or written.
  // Like git's read_repository_format it reads the config file alone, without includes.
  const format = await readRepositoryFormat(files, gitDir);
  const refStorage = create && options.refFormat === "reftable" ? "reftable" : format.refStorage;
  // the hash naming the objects (`extensions.objectFormat`): SHA-1, or SHA-256 (whose
  // multi-pack-index is not read yet: a SHA-256 repository holding one is refused here)
  const objectFormat = options.objectFormat ?? format.objectFormat;
  if (objectFormat.name !== format.objectFormat.name && !create) {
    throw new UnsupportedObjectFormatError(
      `opening a ${format.objectFormat.name} repository as ${objectFormat.name}`,
      objectFormat.name,
    );
  }
  await assertNoMultiPackIndexInFormat(files, packDir, objectFormat);
  // a SHA-256 reftable (hash id `s256`) is neither read nor written yet
  if (objectFormat.name !== "sha1" && refStorage === "reftable") {
    throw new UnsupportedObjectFormatError("reftable refs", objectFormat.name);
  }
  const includes = options.configIncludes === undefined ? {} : { includes: options.configIncludes };
  // the settings read below come from git's whole sequence (system, global, the repository's
  // file, config.worktree, the command line), as git's repo_config reads them; only the
  // repository format above is the file alone
  const settingsOptions = {
    ...includes,
    ...(options.environment ? { environment: options.environment } : {}),
  };

  if (create) {
    await createGitDirectoryStructure(files, gitDir, objectsDir, refStorage, objectFormat);
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
  const looseOnly = createGitObjects(staging, { objectFormat });
  // git's core.deltaBaseCacheLimit (96 MiB when unset) and core.multiPackIndex (default on)
  // one load of the sequence for the pack and ref store settings (nothing writes the config
  // in between: a created repository's is written above)
  const settingsConfig = await createWorkingCopyConfig(
    configFilesApiOf(files, { readOnly: "reading the store settings never writes the config" }),
    gitDir,
    undefined,
    settingsOptions,
  );
  const packSettings = await readPackSetSettings(files, gitDir, {
    ...settingsOptions,
    config: settingsConfig,
  });
  const packs = await openPackSet(files, packDir, {
    externalBase: (id) => looseOnly.get(id),
    freshenMaxAgeMs,
    baseCacheBytes: packSettings.baseCacheBytes,
    multiPackIndex: packSettings.multiPackIndex,
    writeReverseIndex: packSettings.writeReverseIndex,
    readReverseIndex: packSettings.readReverseIndex,
    ...(objectFormat.name === "sha1" ? {} : { objectFormat }),
  });
  // the alternates (git's other odb sources): read after the repository's own objects, never
  // written; an object one holds is not written here (odb_freshen_object)
  const alternates =
    options.alternates === false
      ? undefined
      : await openObjectAlternates({
          files,
          gitDir,
          objectsDir,
          freshenMaxAgeMs,
          objectFormat,
          ...(options.environment ? { environment: options.environment } : {}),
          ...(options.alternatesFromEnvironment === false ? { honorEnvironment: false } : {}),
          ...(options.workTree !== undefined ? { workTree: options.workTree } : {}),
          ...(options.onAlternatesError ? { onError: options.onAlternatesError } : {}),
          readConfig: () =>
            createWorkingCopyConfig(configFilesApiOf(files), gitDir, undefined, settingsOptions),
        });
  if (alternates) {
    // clone --dissociate: copy what is borrowed (repack -a -d), then stop borrowing
    alternates.dissociate = async () => {
      const file = joinPath(objectsDir, "info", "alternates");
      if ((await files.stats(file))?.kind !== "file") return;
      await repack({ history, objects, packs, looseStorage, files, gitDir, all: true });
      await files.remove(file);
      await alternates.refresh();
      // a graph read from an alternate is gone with it
      commitGraph.invalidate();
    };
  }
  const loose = createGitObjects(skipPacked(staging, packs, alternates), { objectFormat });
  const local = withPacks(loose, packs);
  const stored = alternates ? withAlternates(local, alternates) : local;
  // a partial clone's absent objects: fetched from its promisor remote on a read (once a
  // fetcher is installed: vcs-commands installs one), its promisor packs known by their
  // `.promisor` files
  const promisorPacks = promisorPacksOf(files, packDir, packs);
  const promisor = createObjectPromisor({
    objects: stored,
    promisorPacks,
    storedOutsidePromisorPacks: async (id) => {
      if (await loose.has(id)) return true;
      const marked = new Set((await promisorPacks()).map((p) => p.packId));
      for (const pack of await packs.packs()) {
        if (!marked.has(pack.packId) && pack.has(id)) return true;
      }
      return false;
    },
  });
  const objects = withLazyFetch(stored, promisor);
  // receive-pack keeps a pushed pack in objects/tmp_objdir-incoming-* until the push is
  // accepted; reads through a quarantine never fetch (receive-pack's and fetch's checks run
  // with git's fetch_if_missing = 0)
  objects.beginQuarantine = () =>
    beginFilesQuarantine({
      files,
      objectsDir,
      objects: objects.withoutLazyFetch ?? objects,
      packs,
      freshenMaxAgeMs,
    });
  const reflog = readRefStoreConfig(settingsConfig);
  // a reftable repository's refs are in `<git dir>/reftable`; a files repository's are loose
  // refs and packed-refs
  const refStore: FileRefStore | ReftableRefStore =
    refStorage === "reftable"
      ? createReftableRefStore({
          files,
          gitDir,
          write: readReftableWriteOptions(settingsConfig, options.environment),
          logAllRefUpdates: options.logAllRefUpdates ?? reflog.logAllRefUpdates,
          reflogIdentity: options.reflogIdentity ?? reflog.identity,
          peel: (id) => peelTag(objects, id),
        })
      : createFileRefStore(files, gitDir, {
          atomicFiles: options.atomicFiles,
          refLockTimeoutMs: options.refLockTimeoutMs ?? reflog.refLockTimeoutMs,
          packedLockTimeoutMs: options.packedLockTimeoutMs ?? reflog.packedLockTimeoutMs,
          logAllRefUpdates: options.logAllRefUpdates ?? reflog.logAllRefUpdates,
          reflogIdentity: options.reflogIdentity ?? reflog.identity,
          objectFormat,
          peel: (id) => peelTag(objects, id),
          hasObject: (id) => objects.has(id),
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

  // the commit-graph (objects/info/commit-graph or its split chain), read on first use; a
  // SHA-256 repository's is not read (its 32-byte ids are not read yet): walks read commits
  const commitGraph =
    objectFormat.name !== "sha1"
      ? createCommitGraphProvider(async () => undefined)
      : createFilesCommitGraphProvider({
          files,
          gitDir,
          refs: refStore,
          environment: options.environment,
          ...(options.configIncludes === undefined
            ? {}
            : { configIncludes: options.configIncludes }),
          // git's prepare_commit_graph: the alternates' graphs after the repository's own
          ...(alternates
            ? {
                alternateObjectDirs: async () => (await alternates.list()).map((a) => a.objectsDir),
              }
            : {}),
        });
  invalidateOnCompatibilityChange(refStore, commitGraph);
  // an alternate linked later (clone --shared, --reference, each one added or re-read) may
  // bring a graph or the layers a chain builds on
  alternates?.onChange(() => commitGraph.invalidate());
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
function invalidateOnCompatibilityChange(
  refs: FileRefStore | ReftableRefStore,
  commitGraph: CommitGraphProvider,
) {
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
 * The ref store settings of the repository's config, as git reads them (with an environment,
 * through the whole sequence, the command line last): core.logAllRefUpdates
 * (a boolean or "always"), defaulting to true unless core.bare is true; user.name and
 * user.email for the reflog identity (each defaulting to webrun-vcs <vcs@localhost>); the
 * lock timeouts core.filesRefLockTimeout and core.packedRefsTimeout (undefined when unset
 * or not an integer: the store's defaults, 100 and 1000 ms).
 */
function readRefStoreConfig(config: Pick<GitWorkingCopyConfig, "get">): {
  logAllRefUpdates: boolean | "always";
  identity?: { name: string; email: string };
  refLockTimeoutMs?: number;
  packedLockTimeoutMs?: number;
} {
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

/**
 * Create standard .git directory structure (HEAD is written by the ref store, under its lock).
 */
async function createGitDirectoryStructure(
  files: FilesApi,
  gitDir: string,
  objectsDir: string,
  refStorage: "files" | "reftable" = "files",
  objectFormat: ObjectFormat = SHA1_OBJECT_FORMAT,
): Promise<void> {
  await files.mkdir(gitDir);
  await files.mkdir(objectsDir);
  await files.mkdir(joinPath(objectsDir, "pack"));
  await files.mkdir(joinPath(gitDir, "refs"));
  const encoder = new TextEncoder();
  const bare = gitDir === "." ? "true" : "false";
  if (refStorage === "reftable") {
    // git's layout for older gits (refs.c refs_init_db / setup.c): HEAD naming an invalid
    // branch, `refs/heads` a file, so that a git without reftable support refuses the
    // repository instead of reading it as an empty one
    await files.write(joinPath(gitDir, "refs", "heads"), [
      encoder.encode("this repository uses the reftable format\n"),
    ]);
    await files.write(joinPath(gitDir, "HEAD"), [encoder.encode("ref: refs/heads/.invalid\n")]);
    await files.mkdir(joinPath(gitDir, "reftable"));
    await files.write(joinPath(gitDir, "config"), [
      encoder.encode(
        `[extensions]\n\trefstorage = reftable\n[core]\n\trepositoryformatversion = 1\n\tfilemode = true\n\tbare = ${bare}\n`,
      ),
    ]);
    return;
  }
  await files.mkdir(joinPath(gitDir, "refs", "heads"));
  await files.mkdir(joinPath(gitDir, "refs", "tags"));

  // a SHA-256 repository is version 1 with `extensions.objectformat` (git's
  // initialize_repository_version)
  const sha1 = objectFormat.name === "sha1";
  await files.write(joinPath(gitDir, "config"), [
    encoder.encode(
      `[core]\n\trepositoryformatversion = ${sha1 ? 0 : 1}\n\tfilemode = true\n\tbare = ${bare}\n` +
        (sha1 ? "" : `[extensions]\n\tobjectformat = ${objectFormat.name}\n`),
    ),
  ]);
}

/**
 * git's reftable write options from the config (refs/reftable-backend.c reftable_be_config):
 * `reftable.blockSize`, `restartInterval`, `indexObjects`, `geometricFactor`,
 * `lockTimeout` (100 ms by default); `$GIT_TEST_REFTABLE_AUTOCOMPACTION` turns compaction off.
 */
export function readReftableWriteOptions(
  config: Pick<GitWorkingCopyConfig, "get">,
  environment?: GitHostEnvironment,
): ReftableStackWriteOptions {
  const int = (key: string) => parseConfigInt(config.get(key));
  const blockSize = int("reftable.blockSize");
  if (blockSize !== undefined && blockSize > 16777215) {
    throw new Error("reftable block size cannot exceed 16MB");
  }
  const restartInterval = int("reftable.restartInterval");
  if (restartInterval !== undefined && restartInterval > 65535) {
    throw new Error("reftable block size cannot exceed 65535");
  }
  const indexObjects = config.get("reftable.indexObjects");
  const geometricFactor = int("reftable.geometricFactor");
  if (geometricFactor !== undefined && geometricFactor > 255) {
    throw new Error("reftable geometric factor cannot exceed 255");
  }
  const lockTimeoutMs = int("reftable.lockTimeout");
  if (lockTimeoutMs !== undefined && lockTimeoutMs < 0 && lockTimeoutMs !== -1) {
    throw new Error("reftable lock timeout does not support negative values other than -1");
  }
  return {
    ...(blockSize ? { blockSize } : {}),
    ...(restartInterval ? { restartInterval } : {}),
    ...(indexObjects !== undefined && parseGitBool(indexObjects) === false
      ? { indexObjects: false }
      : {}),
    ...(geometricFactor ? { geometricFactor } : {}),
    lockTimeoutMs: lockTimeoutMs ?? 100,
    ...(environment?.reftableAutoCompaction === false ? { autoCompaction: false } : {}),
  };
}

/**
 * The promisor packs of a pack directory, in lookup order: those with a `pack-<id>.promisor`
 * file (git's `pack_promisor`), each file looked up once per pack.
 */
export function promisorPacksOf(
  files: FilesApi,
  packDir: string,
  packs: PackSet,
): () => Promise<readonly PromisorPack[]> {
  const known = new Map<string, Promise<boolean>>();
  // a pack marked later (fetch-pack writes the file after index-pack) is looked up again
  const { writePromisor } = packs;
  if (writePromisor) {
    packs.writePromisor = async (packId, content) => {
      try {
        await writePromisor.call(packs, packId, content);
      } finally {
        known.delete(packId);
      }
    };
  }
  return async () => {
    const out: PromisorPack[] = [];
    for (const pack of await packs.packs()) {
      let marked = known.get(pack.packId);
      if (!marked) {
        marked = files
          .stats(joinPath(packDir, `pack-${pack.packId}.promisor`))
          .then((s) => s?.kind === "file")
          .catch(() => false);
        known.set(pack.packId, marked);
      }
      if (await marked) out.push(pack);
    }
    return out;
  };
}
