/**
 * The commit-graph of a files repository: its settings from the config, the provider the
 * commit store reads, and `writeCommitGraph`, the `git commit-graph write` of a repository
 * (`--reachable` from every ref by default; `--append`, `--split`).
 */

import {
  type CommitGraphPrefetch,
  type CommitGraphProvider,
  type CommitGraphSettings,
  type CommitGraphSplitStrategy,
  commitGraphCompatible,
  createCommitGraphProvider,
  DEFAULT_COMMIT_GRAPH_SETTINGS,
  type FilesApi,
  type GitObjects,
  graftFileBaseDir,
  graftFileReader,
  isSymbolicRef,
  joinPath,
  loadRepositoryCommitGraph,
  type ObjectId,
  type Refs,
  readCommitGraph,
  type WriteCommitGraphFileResult,
  writeCommitGraphFile,
} from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils/encoding";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";

import { readAllRefs } from "./refs/index.js";
import {
  configFilesApiOf,
  createWorkingCopyConfig,
} from "./workspace/working-copy/working-copy-config.files.js";

/** The commit-graph settings of a repository's config, with git's maintenance switches. */
export interface RepositoryCommitGraphSettings extends CommitGraphSettings {
  /** `gc.writeCommitGraph` (default true): gc writes a graph */
  gcWriteCommitGraph: boolean;
  /** `fetch.writeCommitGraph` (default false): fetch writes a split graph */
  fetchWriteCommitGraph: boolean;
  /** `commitGraph.maxNewFilters` (unset: no limit) */
  maxNewFilters?: number;
}

/** git's git_config_int: a decimal (or 0x/0 prefixed) number with an optional k, m or g. */
function configInt(value: unknown): number | undefined {
  // the config reader turns canonical numbers ("2") into numbers
  if (typeof value === "number") return Number.isInteger(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const m = /^\s*([-+]?(?:0x[0-9a-f]+|[0-9]+))\s*([kmg]?)\s*$/i.exec(value);
  if (!m) return undefined;
  const n = Number.parseInt(
    m[1] as string,
    (m[1] as string).toLowerCase().includes("0x") ? 16 : 10,
  );
  const unit = { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[(m[2] as string).toLowerCase()] ?? 1;
  return n * unit;
}

/**
 * The commit-graph settings of the configuration chain, defaulting as git's
 * prepare_repo_settings: the system and global files when `environment` is given (as working
 * copies read them), then `<gitDir>/config` with its includes. Defaults:
 * `core.commitGraph` true, `commitGraph.generationVersion` 2, `commitGraph.changedPathsVersion`
 * -1 (0 when `commitGraph.readChangedPaths` is false), `core.useReplaceRefs` true,
 * `gc.writeCommitGraph` true, `fetch.writeCommitGraph` false.
 *
 * @example
 * ```typescript
 * const settings = await readCommitGraphSettings(files, ".git");
 * if (settings.gcWriteCommitGraph) { ... }
 * ```
 */
export async function readCommitGraphSettings(
  files: FilesApi,
  gitDir = ".git",
  options: {
    environment?: GitHostEnvironment;
    /** Which include directives of the repository's config are followed (git's: all) */
    includes?: boolean | "files";
  } = {},
): Promise<RepositoryCommitGraphSettings> {
  const config = await createWorkingCopyConfig(configFilesApiOf(files), gitDir, undefined, {
    ...(options.environment ? { environment: options.environment } : {}),
    ...(options.includes === undefined ? {} : { includes: options.includes }),
  });
  const bool = (key: string, fallback: boolean) => parseGitBool(config.get(key)) ?? fallback;
  const readChangedPaths = bool("commitGraph.readChangedPaths", true);
  return {
    enabled: bool("core.commitGraph", DEFAULT_COMMIT_GRAPH_SETTINGS.enabled),
    generationVersion:
      configInt(config.get("commitGraph.generationVersion")) ??
      DEFAULT_COMMIT_GRAPH_SETTINGS.generationVersion,
    changedPathsVersion:
      configInt(config.get("commitGraph.changedPathsVersion")) ?? (readChangedPaths ? -1 : 0),
    useReplaceRefs: bool("core.useReplaceRefs", true),
    gcWriteCommitGraph: bool("gc.writeCommitGraph", true),
    fetchWriteCommitGraph: bool("fetch.writeCommitGraph", false),
    maxNewFilters: configInt(config.get("commitGraph.maxNewFilters")),
  };
}

/**
 * The commit-graph provider of a files repository: loads the graph on first use, as git's
 * prepare_commit_graph (settings from the config, `commitGraphCompatible`, then
 * `objects/info/commit-graph` or the split chain, else the first alternate's).
 *
 * @example
 * ```typescript
 * const commitGraph = createFilesCommitGraphProvider({ files, gitDir: ".git", refs });
 * const graph = await commitGraph.get();
 * ```
 */
export function createFilesCommitGraphProvider(options: {
  files: FilesApi;
  gitDir?: string;
  refs?: Pick<Refs, "list">;
  /** The user's environment: the global and system config files are read too */
  environment?: GitHostEnvironment;
  /** Which include directives of the repository's config are followed (git's: all) */
  configIncludes?: boolean | "files";
  /**
   * The alternates' object directories in `files` (git's order): the first graph among the
   * repository's own objects directory and these is used
   */
  alternateObjectDirs?: () => Promise<readonly string[]>;
}): CommitGraphProvider {
  const { files, refs, environment } = options;
  const gitDir = options.gitDir ?? ".git";
  return createCommitGraphProvider(async () => {
    const settings = await readCommitGraphSettings(files, gitDir, {
      environment,
      ...(options.configIncludes === undefined ? {} : { includes: options.configIncludes }),
    });
    const readGraftFile = graftFileReader(environment, { files, dir: graftFileBaseDir(gitDir) });
    return loadRepositoryCommitGraph({
      files,
      gitDir,
      refs,
      settings,
      ...(readGraftFile ? { readGraftFile } : {}),
      ...(options.alternateObjectDirs ? { alternateObjectDirs: options.alternateObjectDirs } : {}),
    });
  });
}

/** What `writeCommitGraph` writes. */
export interface WriteCommitGraphOptions {
  files: FilesApi;
  /** Path of the `.git` directory within `files` (default ".git") */
  gitDir?: string;
  /** The object kernel commits and trees are read from */
  objects: Pick<GitObjects, "get">;
  /** The refs (`--reachable` starts from each of them, and `refs/replace/` disables the graph) */
  refs: Refs;
  /** The provider to invalidate after writing (the commit store's) */
  commitGraph?: CommitGraphProvider;
  /**
   * `--reachable` (the default when `commits` is not given): every ref under `refs/`, peeled,
   * that names a commit
   */
  reachable?: boolean;
  /** `--stdin-commits`: start from these commits */
  commits?: Iterable<ObjectId>;
  /** `--append` */
  append?: boolean;
  /** `--split[=strategy]` */
  split?: boolean | CommitGraphSplitStrategy;
  /** `--size-multiple` */
  sizeMultiple?: number;
  /** `--max-commits` */
  maxCommits?: number;
  /** `--expire-time`, ms since the epoch */
  expireTime?: number;
  /** `--[no-]changed-paths` */
  changedPaths?: boolean;
  /** `--max-new-filters` (default `commitGraph.maxNewFilters`) */
  maxNewFilters?: number;
  /**
   * Honour replace refs as `git gc` does: no graph is written while `refs/replace/` has any
   * (with `core.useReplaceRefs`). `git commit-graph write` ignores them (the default here).
   */
  replaceRefs?: boolean;
  /**
   * The user's environment: the global and system config files are read too, and the grafts
   * file it names (`GIT_GRAFT_FILE`) in place of `info/grafts`
   */
  environment?: GitHostEnvironment;
  /** When the changed-path filters' trees are unpacked in pack order first (tuning) */
  prefetch?: CommitGraphPrefetch;
}

/**
 * `git commit-graph write` in a files repository: from every ref (`--reachable`, the default)
 * or the given commits. Nothing is written, as with git, when `core.commitGraph` is false
 * (with git's warning) or the repository is not compatible (grafts, shallow; replace refs only
 * with `replaceRefs`, as `git gc` sees them: `git commit-graph write` disables them).
 *
 * @example
 * ```typescript
 * const { history, objects, files } = await createGitFilesBackend({ files });
 * await writeCommitGraph({ files, objects, refs: history.refs, commitGraph: history.commitGraph });
 * ```
 */
export async function writeCommitGraph(
  options: WriteCommitGraphOptions,
): Promise<WriteCommitGraphFileResult> {
  const { files, objects, refs } = options;
  const gitDir = options.gitDir ?? ".git";
  const objectsDir = joinPath(gitDir, "objects");
  const settings = await readCommitGraphSettings(files, gitDir, {
    environment: options.environment,
  });
  const none = (warnings: string[] = []): WriteCommitGraphFileResult => ({
    written: false,
    commits: 0,
    hashes: [],
    expired: [],
    warnings,
  });
  if (!settings.enabled) {
    return none(["attempting to write a commit-graph, but 'core.commitGraph' is disabled"]);
  }
  if (
    !(await commitGraphCompatible({
      files,
      gitDir,
      refs,
      useReplaceRefs: (options.replaceRefs ?? false) && settings.useReplaceRefs,
      readGraftFile: graftFileReader(options.environment, {
        files,
        dir: graftFileBaseDir(gitDir),
      }),
    }))
  ) {
    return none();
  }
  const commits =
    options.commits && !options.reachable
      ? [...options.commits]
      : await reachableTips(files, gitDir, objects);
  const existing = await readCommitGraph(files, objectsDir, settings);
  try {
    return await writeCommitGraphFile({
      files,
      objectsDir,
      objects,
      commits,
      existing,
      append: options.append,
      split: options.split,
      sizeMultiple: options.sizeMultiple,
      maxCommits: options.maxCommits,
      expireTime: options.expireTime,
      changedPaths: options.changedPaths,
      maxNewFilters: options.maxNewFilters ?? settings.maxNewFilters,
      generationVersion: settings.generationVersion,
      changedPathsVersion: settings.changedPathsVersion,
      prefetch: options.prefetch,
    });
  } finally {
    options.commitGraph?.invalidate();
  }
}

/**
 * git's write_commit_graph_reachable roots: every ref under `refs/` (symbolic ones resolved),
 * peeled through tags, kept when it names a commit.
 */
async function reachableTips(
  files: FilesApi,
  gitDir: string,
  objects: Pick<GitObjects, "get">,
): Promise<ObjectId[]> {
  const stored = await readAllRefs(files, gitDir, "refs/");
  const byName = new Map(stored.map((r) => [r.name, r]));
  const tips = new Set<ObjectId>();
  for (const ref of stored) {
    let r: (typeof stored)[number] | undefined = ref;
    for (let depth = 0; r && isSymbolicRef(r) && depth < 5; depth++) r = byName.get(r.target);
    if (!r || isSymbolicRef(r) || !r.objectId) continue;
    let id = r.objectId;
    for (let depth = 0; depth < 100; depth++) {
      let obj: Awaited<ReturnType<GitObjects["get"]>>;
      try {
        obj = await objects.get(id);
      } catch {
        obj = undefined;
      }
      if (!obj) break;
      if (obj.type === "commit") {
        tips.add(id);
        await obj.content[Symbol.asyncIterator]().return?.();
        break;
      }
      if (obj.type !== "tag") {
        await obj.content[Symbol.asyncIterator]().return?.();
        break;
      }
      const target = await tagTarget(obj);
      if (!target) break;
      id = target;
    }
  }
  return [...tips];
}

/** The `object` line of a tag. */
async function tagTarget(obj: NonNullable<Awaited<ReturnType<GitObjects["get"]>>>) {
  let bytes = obj.bytes;
  if (!bytes) {
    const chunks: Uint8Array[] = [];
    for await (const c of obj.content) chunks.push(c);
    bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
  }
  const first = new TextDecoder().decode(bytes.subarray(0, 64)).split("\n")[0] ?? "";
  const m = /^object ([0-9a-f]{40})$/.exec(first);
  return m?.[1];
}
