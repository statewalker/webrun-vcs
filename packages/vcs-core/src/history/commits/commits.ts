/**
 * Commits - New interface for commit storage
 *
 * This is the new interface with bare naming convention (Commits instead of CommitStore)
 * and consistent method names (remove instead of delete).
 */

import type { ObjectId } from "../../common/index.js";
import type { PersonIdent } from "../../common/person/person-ident.js";
import type { CommitGraphProvider } from "../commit-graph/commit-graph-provider.js";
import type { ObjectStorage } from "../objects/index.js";

/**
 * Commit object
 *
 * Following Git's commit format (JGit RevCommit):
 * - tree: SHA-1 of the root tree
 * - parents: Array of parent commit SHA-1s (empty for initial commit)
 * - author: Person who authored the changes
 * - committer: Person who committed (may differ from author)
 * - message: Commit message (UTF-8)
 *
 * Optional fields:
 * - encoding: Character encoding if not UTF-8
 * - gpgSignature: GPG signature if signed
 */
export interface Commit {
  /** ObjectId of the root tree */
  tree: ObjectId;
  /** Parent commit ObjectIds (empty array for initial commit) */
  parents: ObjectId[];
  /** Author identity */
  author: PersonIdent;
  /** Committer identity */
  committer: PersonIdent;
  /** Commit message (UTF-8) */
  message: string;
  /** Character encoding (optional, defaults to UTF-8) */
  encoding?: string;
  /** GPG signature (optional) */
  gpgSignature?: string;
}

/**
 * What history walks read of a commit: its tree, parents and committer time, and its
 * generation number when the commit-graph has it.
 */
export interface CommitHeader {
  /** ObjectId of the root tree */
  tree: ObjectId;
  /** Parent commit ObjectIds */
  parents: ObjectId[];
  /** Committer time, seconds since the epoch */
  commitTime: number;
  /**
   * The commit-graph's generation (corrected commit date, or topological level for a graph
   * without generation data v2); Infinity when the commit is not in the graph or the graph's
   * generations are not trusted (`CommitGraph.generationsTrusted`)
   */
  generation: number;
}

/**
 * Headers read over one commit-graph (`Commits.headerReader`): commits that graph has come from
 * it, others from the object store with generation Infinity.
 */
export interface CommitHeaderReader {
  /** As `Commits.getHeader`, over the reader's graph. */
  getHeader(
    commitId: ObjectId,
    options?: { checkExists?: boolean },
  ): Promise<CommitHeader | undefined>;
  /**
   * Whether the generations are corrected commit dates the graph trusts (git orders its
   * merge-base queue by them then)
   */
  readonly correctedDates: boolean;
}

/**
 * Commit ancestry traversal options
 */
export interface AncestryOptions {
  /** Maximum number of commits to traverse */
  limit?: number;
  /** Stop at these commit IDs (exclusive) */
  stopAt?: ObjectId[];
  /** Only follow first parent (for linear history) */
  firstParentOnly?: boolean;
}

/**
 * Commit walk entry with metadata
 *
 * Extended entry type for ancestry walking that includes
 * depth and generation information for graph algorithms.
 */
export interface CommitWalkEntry {
  /** Commit object ID */
  id: ObjectId;
  /** Commit data (may be undefined if walk is ID-only) */
  commit?: Commit;
  /** Depth from walk start (0 = starting commit) */
  depth: number;
}

/**
 * Options for ancestry walking
 *
 * Alias for AncestryOptions for naming consistency.
 */
export type WalkOptions = AncestryOptions;

/**
 * Commit object store for version history
 *
 * Commits represent snapshots in time, linking to a tree (content)
 * and parent commits (history).
 */
export interface Commits extends ObjectStorage<Commit> {
  /**
   * Get parent commit IDs
   *
   * Convenience method for history traversal without loading
   * the full commit object.
   *
   * @param commitId Commit object ID
   * @returns Array of parent commit IDs (empty for root commits)
   */
  getParents(commitId: ObjectId): Promise<ObjectId[]>;

  /**
   * The commit's tree, parents, committer time and generation: from the commit-graph when it
   * has the commit (the commit is not read), else parsed. Undefined when the commit is missing.
   * With `checkExists`, a commit the graph has is also looked up in the object store (git's
   * GIT_COMMIT_GRAPH_PARANOIA), so a stale graph does not report a pruned commit as present.
   */
  getHeader?(
    commitId: ObjectId,
    options?: { checkExists?: boolean },
  ): Promise<CommitHeader | undefined>;

  /**
   * A reader of headers bound to the commit-graph loaded now (see {@link CommitHeaderReader}):
   * a walk that reads many headers takes one, so all its reads see the same graph even when a
   * new one is written and loaded while it runs.
   */
  headerReader?(): Promise<CommitHeaderReader>;

  /**
   * The commit-graph this store reads (stores over a git repository's files), if any.
   */
  readonly commitGraph?: CommitGraphProvider;

  /**
   * Get tree ID for a commit
   *
   * Convenience method for checkout operations without loading
   * the full commit object.
   *
   * @param commitId Commit object ID
   * @returns Tree ID if commit exists, undefined otherwise
   */
  getTree(commitId: ObjectId): Promise<ObjectId | undefined>;

  /**
   * Walk commit ancestry
   *
   * Traverses the commit graph from a starting point, yielding
   * commits in topological order.
   *
   * @param startId Starting commit ID (or array of IDs)
   * @param options Walk options (filters, limits)
   * @returns AsyncIterable of commit IDs
   */
  walkAncestry(startId: ObjectId | ObjectId[], options?: WalkOptions): AsyncIterable<ObjectId>;

  /**
   * Find merge base between two commits
   *
   * Returns the most recent common ancestor(s) of two commits,
   * or empty array if they share no common history.
   *
   * @param commit1 First commit ID
   * @param commit2 Second commit ID
   * @returns Array of merge base commit IDs
   */
  findMergeBase(commit1: ObjectId, commit2: ObjectId): Promise<ObjectId[]>;

  /**
   * Check if one commit is an ancestor of another
   *
   * @param ancestor Potential ancestor commit ID
   * @param descendant Potential descendant commit ID
   * @returns True if ancestor is reachable from descendant
   */
  isAncestor(ancestor: ObjectId, descendant: ObjectId): Promise<boolean>;

  /**
   * Check if a commit exists
   *
   * @param id Commit object ID
   * @returns True if commit exists
   */
  has(id: ObjectId): Promise<boolean>;
}

/**
 * Extended queries for native Commits implementations
 *
 * These methods are optional and only available in implementations
 * that support advanced queries (e.g., SQL with indexes).
 */
export interface CommitsExtended extends Commits {
  /**
   * Find commits by author
   *
   * @param author Author name or email pattern
   * @returns AsyncIterable of matching commit IDs
   */
  findByAuthor?(author: string): AsyncIterable<ObjectId>;

  /**
   * Find commits by date range
   *
   * @param start Start date (inclusive)
   * @param end End date (exclusive)
   * @returns AsyncIterable of matching commit IDs
   */
  findByDateRange?(start: Date, end: Date): AsyncIterable<ObjectId>;

  /**
   * Search commits by message
   *
   * @param pattern Search pattern (regex or substring)
   * @returns AsyncIterable of matching commit IDs
   */
  searchMessage?(pattern: string): AsyncIterable<ObjectId>;
}
