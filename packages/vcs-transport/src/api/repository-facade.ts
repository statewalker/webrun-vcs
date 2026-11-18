/**
 * Transport-specific facade for repository operations.
 *
 * Defined in `packages/vcs-transport` (not `packages/vcs-core`).
 * Composes methods from core APIs into a transport-friendly interface.
 *
 * Delegates to:
 * - SerializationApi.importPack / createPack
 * - ObjectStore.has / collectReachable
 * - CommitStore.walkAncestors (via AncestryWalker)
 *
 * @example Factory implementation
 * ```ts
 * function createRepositoryFacade(historyStore: HistoryStore): RepositoryFacade {
 *   const { objectStore, commitStore, serialization } = historyStore;
 *
 *   return {
 *     importPack: (stream) => serialization.importPack(stream),
 *     async *exportPack(wants, exclude) {
 *       const objects = objectStore.collectReachable(wants, exclude);
 *       yield* serialization.createPack(objects);
 *     },
 *     has: (oid) => objectStore.has(oid),
 *     async *walkAncestors(startOid) {
 *       yield* commitStore.walkAncestors(startOid);
 *     },
 *   };
 * }
 * ```
 */

import type { PackImportResult as CorePackImportResult } from "@statewalker/vcs-core";

/** Options of {@link RepositoryFacade.importPack}. */
export interface PackImportOptions {
  /**
   * Keep the received objects in a quarantine until the push is accepted, as git's
   * receive-pack does with `tmp_objdir`: the result then carries {@link RepositoryQuarantine}
   * when the repository can quarantine (its object store has `beginQuarantine`).
   */
  quarantine?: boolean;
}

/**
 * Received objects kept aside (git's receive-pack quarantine): invisible to the repository's
 * readers until `commit()`, removed by `discard()`.
 *
 * @example
 * ```ts
 * const imported = await facade.importPack(pack, { quarantine: true });
 * const view = imported.quarantine?.repository ?? facade; // sees the pushed objects
 * if (await accepted(view)) await imported.quarantine?.commit();
 * else await imported.quarantine?.discard();
 * ```
 */
export interface RepositoryQuarantine {
  /**
   * The repository as the push sees it: the quarantined objects, then the repository's.
   * receive-pack's connectivity check, its `update()` checks and its hooks read through it.
   */
  readonly repository: RepositoryFacade;
  /** Publish the quarantined objects into the repository (before any ref names them). */
  commit(): Promise<void>;
  /** Remove every quarantined object. Safe to call more than once. */
  discard(): Promise<void>;
}

/** Statistics of an imported pack, with its quarantine when one was asked for and possible. */
export interface PackImportResult extends Omit<CorePackImportResult, "quarantine"> {
  /**
   * With `quarantine: true`, where the repository can quarantine: the caller must
   * `commit()` or `discard()` it. Absent otherwise: the objects are already published.
   */
  quarantine?: RepositoryQuarantine;
}
/**
 * Options for exportPack operation (Protocol V2 extensions).
 */
export interface ExportPackOptions {
  /** Use thin pack (deltas reference objects not in pack) */
  thin?: boolean;
  /**
   * The client asked for `include-tag`: annotated tags of packed objects are added (git's
   * `pack-objects --include-tag`), from `includeTags` when given, else from the facade's own
   * `refs/tags/*`
   */
  includeTag?: boolean;
  /**
   * The candidate tags for `includeTag` (upload-pack passes the ids of the visible
   * `refs/tags/*`): each one peeling to a packed object is added with its chain of tags
   */
  includeTags?: Iterable<string>;
  /** Partial clone filter specification */
  filterSpec?: string;
  /** Shallow boundaries (objects that should not include parents) */
  shallow?: Set<string>;
  /** Write deltas on a base in the pack as OFS deltas (the client's `ofs-delta`; default true) */
  ofsDelta?: boolean;
}

/**
 * A commit as upload-pack walks it: its parents and committer time.
 */
export interface CommitGraphInfo {
  /** Parent commit ids (empty for a root commit) */
  parents: string[];
  /** Committer time, seconds since the epoch */
  time: number;
  /**
   * The commit's root tree. receive-pack's connectivity check needs it (with
   * {@link RepositoryFacade.getTreeEntries}) to verify the objects a pushed commit names.
   */
  tree?: string;
}

/** A git object type name. */
export type GitObjectTypeName = "commit" | "tree" | "blob" | "tag";

/** One entry of a tree object, as receive-pack's connectivity check reads it. */
export interface TreeEntryInfo {
  /** File mode, e.g. `0o100644`, `0o040000` (a tree), `0o160000` (a gitlink: not followed) */
  mode: number;
  /** Entry name */
  name: string;
  /** Object id of the blob, tree or (gitlink) commit */
  id: string;
}

/** What an annotated tag points at. */
export interface TagTargetInfo {
  /** Id of the tagged object */
  object: string;
  /** Type of the tagged object */
  type: GitObjectTypeName;
}

export interface RepositoryFacade {
  /**
   * Imports a pack stream into the repository.
   * Parses pack format and stores objects.
   *
   * Delegates to: SerializationApi.importPack
   *
   * With `options.quarantine` the objects are kept aside until the caller commits them
   * (receive-pack); see {@link PackImportResult.quarantine}.
   *
   * @param packStream - Stream of pack bytes
   * @param options - Import options
   * @returns Import statistics
   */
  importPack(
    packStream: AsyncIterable<Uint8Array>,
    options?: PackImportOptions,
  ): Promise<PackImportResult>;

  /**
   * Exports objects as a pack stream.
   * Collects reachable objects and serializes to pack format.
   *
   * Delegates to: SerializationApi.exportPack (listObjects + writePack)
   *
   * @param wants - Object IDs to include (with all reachable objects)
   * @param exclude - Object IDs to exclude (client already has these)
   * @param options - Optional export options (Protocol V2)
   * @yields Pack data chunks
   */
  exportPack(
    wants: Set<string>,
    exclude: Set<string>,
    options?: ExportPackOptions,
  ): AsyncIterable<Uint8Array>;

  /**
   * Checks if an object exists in the repository.
   *
   * Delegates to: ObjectStore.has
   *
   * @param oid - Object ID to check
   * @returns true if object exists locally
   */
  has(oid: string): Promise<boolean>;

  /**
   * Walks commit ancestry from a starting point.
   * Used during negotiation to find common ancestors.
   *
   * Delegates to: AncestryWalker / CommitStore.walkAncestors
   *
   * @param startOid - Commit to start walking from
   * @yields Commit OIDs in topological order
   */
  walkAncestors(startOid: string): AsyncGenerator<string>;

  // Protocol V2 optional methods

  /**
   * Peels a tag to its underlying object.
   * Returns the OID of the dereferenced object.
   *
   * @param oid - Tag object ID
   * @returns Peeled object ID, or same OID if not a tag
   */
  peelTag?(oid: string): Promise<string | null>;

  /**
   * Gets the size of an object.
   * Used by object-info command in Protocol V2.
   *
   * @param oid - Object ID
   * @returns Object size in bytes, or null if not found
   */
  getObjectSize?(oid: string): Promise<number | null>;

  // Server-side validation methods (optional)

  /**
   * A commit's parents and committer time, or undefined when `oid` is not a commit here
   * (absent, or another object type). upload-pack walks the commit graph with it: the
   * "not our ref" check, `ok_to_give_up` in negotiation, and shallow fetches
   * (`deepen`, `deepen-relative`, `deepen-since`, `deepen-not`, unshallow).
   *
   * A facade may answer from a commit-graph without looking the commit up in the object store
   * (git's default): a graph left over after the commit was pruned then still lists it. With
   * `checkExists` the commit must also be in the object store (git's
   * GIT_COMMIT_GRAPH_PARANOIA); receive-pack asks so where a missing commit changes the answer
   * (the type of a new tip, the connectivity of what was pushed).
   *
   * @param oid - Object ID
   * @param options - `checkExists`: answer only for a commit in the object store
   * @returns The commit's graph data, or undefined
   */
  getCommitInfo?(
    oid: string,
    options?: { checkExists?: boolean },
  ): Promise<CommitGraphInfo | undefined>;

  /**
   * Checks if an object is reachable from other objects.
   * Used for REACHABLE_COMMIT policy validation.
   *
   * @param oid - Object ID to check
   * @param from - Object ID(s) to check reachability from
   * @returns true if oid is reachable from any 'from' object
   */
  isReachableFrom?(oid: string, from: string | string[]): Promise<boolean>;

  /**
   * Checks if an object is reachable from any ref tip.
   * Used for REACHABLE_COMMIT_TIP policy validation.
   *
   * @param oid - Object ID to check
   * @returns true if oid is reachable from any tip
   */
  isReachableFromAnyTip?(oid: string): Promise<boolean>;

  // receive-pack: connectivity and ref checks (optional)

  /**
   * The type of the object stored under `oid`, or undefined when it is absent. receive-pack
   * uses it to refuse a branch that would point at a non-commit, and to start its
   * connectivity walk from each pushed tip.
   */
  getObjectType?(oid: string): Promise<GitObjectTypeName | undefined>;

  /**
   * The entries of a tree, or undefined when `oid` is not a tree here (absent, or another
   * type). With {@link CommitGraphInfo.tree} and {@link getTagInfo}, receive-pack walks the
   * objects a push introduces (git's `check_connected`); without them it only checks that
   * each new tip exists.
   */
  getTreeEntries?(oid: string): Promise<TreeEntryInfo[] | undefined>;

  /** What an annotated tag points at, or undefined when `oid` is not a tag here. */
  getTagInfo?(oid: string): Promise<TagTargetInfo | undefined>;

  /**
   * The ids of the local objects that start with `prefix` (an abbreviated id, 4 or more hex
   * digits); at most two are enough to tell a unique one from an ambiguous one. A push resolves
   * an abbreviated source (`abc1234:refs/heads/x`) or lease value with it.
   */
  resolvePrefix?(prefix: string): Promise<string[]>;

  /**
   * The abbreviated length of each id as git's find_unique_abbrev gives it: from `minLength`
   * (`core.abbrev`; -1 for the automatic length of the repository's size) up to where no
   * other local object shares the prefix. Fetch and push summaries abbreviate with it;
   * without it they use `minLength` (7 for automatic).
   */
  abbrevLengths?(ids: readonly string[], minLength: number): Promise<Map<string, number>>;

  /**
   * Whether the repository has no working tree. receive-pack refuses to update the checked
   * out branch of a non-bare repository (git's `receive.denyCurrentBranch`). Absent: bare.
   */
  isBare?(): boolean | Promise<boolean>;

  /**
   * Record commits as shallow (git's `.git/shallow`). receive-pack calls it for a shallow
   * push it accepted with `shallowUpdate` (git's `receive.shallowUpdate`); without it such a
   * push is refused ("shallow update not allowed").
   */
  updateShallow?(oids: string[]): Promise<void>;

  // Shallow clone computation methods (optional)

  /**
   * Computes shallow boundaries for a depth-limited clone, as git's `deepen <depth>`: the
   * commits `depth - 1` parents away from the wants (so `depth` commits deep), the wants
   * themselves for depth 1. A facade with `getCommitInfo` does not need it.
   *
   * @param wants - Object IDs being fetched
   * @param depth - Number of commits to include
   * @returns Set of OIDs that should be shallow boundaries
   */
  computeShallowBoundaries?(wants: Set<string>, depth: number): Promise<Set<string>>;

  /**
   * Computes shallow boundaries since a timestamp. upload-pack does not call it: it answers
   * `deepen-since` through `getCommitInfo`.
   *
   * @param wants - Object IDs being fetched
   * @param timestamp - Unix timestamp cutoff
   * @returns Set of OIDs that should be shallow boundaries
   */
  computeShallowSince?(wants: Set<string>, timestamp: number): Promise<Set<string>>;

  /**
   * Computes shallow boundaries excluding refs. upload-pack does not call it: it answers
   * `deepen-not` through `getCommitInfo`.
   *
   * @param wants - Object IDs being fetched
   * @param excludeRefs - Ref names to exclude
   * @returns Set of OIDs that should be shallow boundaries
   */
  computeShallowExclude?(wants: Set<string>, excludeRefs: string[]): Promise<Set<string>>;
}
