/**
 * The commit-graph a repository uses, loaded once and on demand as git's
 * `prepare_commit_graph`: not at all when `core.commitGraph` is false, nor when the graph
 * cannot describe the history git would walk (`commit_graph_compatible`): replace refs (with
 * `core.useReplaceRefs`), grafts in `info/grafts` (or the file `GIT_GRAFT_FILE` names), or a
 * shallow repository (a `shallow` file). The graph is the first one found among the object
 * directories in git's order: the repository's own, then its alternates' (`odb->sources`).
 */

import type { FilesApi } from "@statewalker/vcs-utils/files";
import { joinPath } from "@statewalker/vcs-utils/files";

import type { Refs } from "../refs/refs.js";
import type { CommitGraph } from "./commit-graph.js";
import type { CommitGraphDiagnostic } from "./commit-graph-format.js";
import { readCommitGraph, readGraphFile } from "./commit-graph-reader.js";

/** The configuration git reads for commit-graphs (`prepare_repo_settings`). */
export interface CommitGraphSettings {
  /** `core.commitGraph` (default true) */
  enabled: boolean;
  /** `commitGraph.generationVersion` (default 2) */
  generationVersion: number;
  /**
   * `commitGraph.changedPathsVersion` (default -1; 0 when `commitGraph.readChangedPaths` is
   * false)
   */
  changedPathsVersion: number;
  /** `core.useReplaceRefs` (default true; false also for GIT_NO_REPLACE_OBJECTS) */
  useReplaceRefs: boolean;
}

/** git's defaults. */
export const DEFAULT_COMMIT_GRAPH_SETTINGS: CommitGraphSettings = {
  enabled: true,
  generationVersion: 2,
  changedPathsVersion: -1,
  useReplaceRefs: true,
};

/** The graph a commit store reads, loaded on first use. */
export interface CommitGraphProvider {
  /**
   * The graph, loading it the first time; undefined when there is none, it is not used or it
   * failed to load (a failure is remembered until `invalidate`, not retried on each use).
   */
  get(): Promise<CommitGraph | undefined>;
  /** The graph if loaded already: undefined when there is none, null when not loaded yet. */
  current(): CommitGraph | undefined | null;
  /** Forget the loaded graph (after a write, a gc or a change of refs/replace): read again on next use. */
  invalidate(): void;
}

/**
 * A provider over a loader, which runs at most once until `invalidate`. A loader that throws
 * counts as no graph (git goes on without one), passed to `onError` once.
 *
 * @example
 * ```typescript
 * const provider = createCommitGraphProvider(async () => (await readCommitGraph(files, dir)).graph);
 * const graph = await provider.get();
 * ```
 */
export function createCommitGraphProvider(
  load: () => Promise<CommitGraph | undefined>,
  onError?: (error: unknown) => void,
): CommitGraphProvider {
  let loaded: CommitGraph | undefined | null = null;
  let pending: Promise<CommitGraph | undefined> | undefined;
  let generation = 0;
  return {
    get() {
      if (loaded !== null) return Promise.resolve(loaded);
      if (!pending) {
        const at = generation;
        pending = load().then(
          (graph) => {
            if (at === generation) {
              loaded = graph;
              pending = undefined;
            }
            return graph;
          },
          (error) => {
            if (at === generation) {
              loaded = undefined;
              pending = undefined;
            }
            onError?.(error);
            return undefined;
          },
        );
      }
      return pending;
    },
    current() {
      return loaded;
    },
    invalidate() {
      generation++;
      loaded = null;
      pending = undefined;
    },
  };
}

/** Where `commitGraphCompatible` looks. */
export interface CommitGraphRepository {
  files: FilesApi;
  /** The `.git` directory within `files` */
  gitDir: string;
  /** The refs, for `refs/replace/` */
  refs?: Pick<Refs, "list">;
  /** `core.useReplaceRefs` (default true) */
  useReplaceRefs?: boolean;
  /**
   * The grafts file's text, read in place of `<gitDir>/info/grafts` (git's `GIT_GRAFT_FILE`,
   * see `graftFileReader`); undefined when that file does not exist. Omit to read
   * `info/grafts`.
   */
  readGraftFile?: () => Promise<string | undefined>;
}

const OID40 = /^[0-9a-fA-F]{40}/;
const GRAFT_LINE = /^[0-9a-fA-F]{40}(\s[0-9a-fA-F]{40})*$/;

/**
 * git's commit_graph_compatible: false with replace refs (`refs/replace/<id>`, unless replace
 * refs are off), with a graft in the grafts file (`info/grafts`, or the file `GIT_GRAFT_FILE`
 * names: `readGraftFile`), or in a shallow repository (a `shallow` file, even an empty one).
 *
 * @example
 * ```typescript
 * if (await commitGraphCompatible({ files, gitDir: ".git", refs })) { ... }
 * ```
 */
export async function commitGraphCompatible(repo: CommitGraphRepository): Promise<boolean> {
  const { files, gitDir } = repo;
  if ((repo.useReplaceRefs ?? true) && repo.refs) {
    for await (const ref of repo.refs.list("refs/replace/")) {
      if (OID40.test(ref.name.slice("refs/replace/".length))) return false;
    }
  }
  const grafts = repo.readGraftFile
    ? await repo.readGraftFile().catch(() => undefined)
    : await readGraphFile(files, joinPath(gitDir, "info", "grafts")).then((bytes) =>
        bytes ? new TextDecoder().decode(bytes) : undefined,
      );
  if (grafts) {
    for (const raw of grafts.split("\n")) {
      const line = raw.trimEnd();
      if (line === "" || line.startsWith("#")) continue;
      if (GRAFT_LINE.test(line)) return false;
    }
  }
  if ((await files.stats(joinPath(gitDir, "shallow")))?.kind === "file") return false;
  return true;
}

/** What `loadRepositoryCommitGraph` needs. */
export interface LoadRepositoryCommitGraphOptions extends CommitGraphRepository {
  /** The object directory (default `<gitDir>/objects`) */
  objectsDir?: string;
  /**
   * The alternates' object directories in `files`, in git's order: where the repository's own
   * objects directory has no graph, the first of them that has one is used (git's
   * prepare_commit_graph walks every odb source and keeps the first graph it reads)
   */
  alternateObjectDirs?: () => Promise<readonly string[]>;
  /** The settings (default: git's) */
  settings?: Partial<CommitGraphSettings>;
  /** Receives the messages git prints while loading */
  onDiagnostic?: (diagnostic: CommitGraphDiagnostic) => void;
}

/**
 * The graph git would use in this repository (git's prepare_commit_graph): undefined when
 * `core.commitGraph` is false, when the repository is not compatible, or when no graph loads.
 *
 * @example
 * ```typescript
 * const provider = createCommitGraphProvider(() =>
 *   loadRepositoryCommitGraph({ files, gitDir: ".git", refs }),
 * );
 * ```
 */
export async function loadRepositoryCommitGraph(
  options: LoadRepositoryCommitGraphOptions,
): Promise<CommitGraph | undefined> {
  const settings = { ...DEFAULT_COMMIT_GRAPH_SETTINGS, ...options.settings };
  if (!settings.enabled) return undefined;
  if (!(await commitGraphCompatible({ ...options, useReplaceRefs: settings.useReplaceRefs }))) {
    return undefined;
  }
  const objectsDir = options.objectsDir ?? joinPath(options.gitDir, "objects");
  const alternates = options.alternateObjectDirs ? await options.alternateObjectDirs() : [];
  // every source's layers are looked up in all of them, the repository's own first
  const objectDirs = [objectsDir, ...alternates];
  const read = await readCommitGraph(options.files, objectsDir, settings, objectDirs);
  for (const d of read.diagnostics) options.onDiagnostic?.(d);
  if (read.graph) return read.graph;
  // the alternates' graphs, in order: the first that loads is the one used (it describes the
  // borrowed history; the repository's own commits are parsed from their objects)
  for (const dir of alternates) {
    const alt = await readCommitGraph(options.files, dir, settings, objectDirs);
    for (const d of alt.diagnostics) options.onDiagnostic?.(d);
    if (alt.graph) return alt.graph;
  }
  return undefined;
}
