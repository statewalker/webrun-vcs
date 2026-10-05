/**
 * KV-based Commits implementation
 *
 * Stores commit objects using a key-value backend with JSON serialization.
 * Includes extended query methods (O(n) scans - less efficient than SQL).
 */

import type { Commit, Commits, ObjectId, WalkOptions } from "@statewalker/vcs-core";
import {
  computeCommitHash,
  findMergeBase as findMergeBaseShared,
  isAncestor as isAncestorShared,
  walkAncestry as walkAncestryShared,
} from "@statewalker/vcs-core";

import type { KVStore } from "./kv-store.js";

/**
 * Key prefix for commit data
 */
const COMMIT_PREFIX = "commit:";

/**
 * Serialized commit format
 */
interface SerializedCommit {
  t: string; // tree
  p: string[]; // parents
  an: string; // author name
  ae: string; // author email
  at: number; // author timestamp
  az: string; // author tzOffset
  cn: string; // committer name
  ce: string; // committer email
  ct: number; // committer timestamp
  cz: string; // committer tzOffset
  m: string; // message
  e?: string; // encoding
  g?: string; // gpgSignature
}

/**
 * Text encoder/decoder for JSON serialization
 */
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * KV-based Commits implementation.
 */
export class KVCommitStore implements Commits {
  constructor(private kv: KVStore) {}

  /**
   * Store a commit object.
   */
  async store(commit: Commit): Promise<ObjectId> {
    const commitId = computeCommitHash(commit);

    // Check if commit already exists (deduplication)
    if (await this.kv.has(`${COMMIT_PREFIX}${commitId}`)) {
      return commitId;
    }

    // Serialize
    const serialized: SerializedCommit = {
      t: commit.tree,
      p: commit.parents,
      an: commit.author.name,
      ae: commit.author.email,
      at: commit.author.timestamp,
      az: commit.author.tzOffset,
      cn: commit.committer.name,
      ce: commit.committer.email,
      ct: commit.committer.timestamp,
      cz: commit.committer.tzOffset,
      m: commit.message,
      e: commit.encoding,
      g: commit.gpgSignature,
    };

    await this.kv.set(`${COMMIT_PREFIX}${commitId}`, encoder.encode(JSON.stringify(serialized)));

    return commitId;
  }

  /**
   * Load a commit object by ID.
   * Returns undefined if not found (new API behavior).
   */
  async load(id: ObjectId): Promise<Commit | undefined> {
    const data = await this.kv.get(`${COMMIT_PREFIX}${id}`);
    if (!data) {
      return undefined;
    }

    const s: SerializedCommit = JSON.parse(decoder.decode(data));

    return {
      tree: s.t,
      parents: s.p,
      author: {
        name: s.an,
        email: s.ae,
        timestamp: s.at,
        tzOffset: s.az,
      },
      committer: {
        name: s.cn,
        email: s.ce,
        timestamp: s.ct,
        tzOffset: s.cz,
      },
      message: s.m,
      encoding: s.e,
      gpgSignature: s.g,
    };
  }

  /**
   * Remove a commit object by ID.
   */
  async remove(id: ObjectId): Promise<boolean> {
    return this.kv.delete(`${COMMIT_PREFIX}${id}`);
  }

  /**
   * Load a commit object by ID (throws if not found).
   * Required for AncestryStorageOps interface compatibility.
   */
  async loadCommit(id: ObjectId): Promise<Commit> {
    const commit = await this.load(id);
    if (!commit) {
      throw new Error(`Commit ${id} not found`);
    }
    return commit;
  }

  /**
   * Get parent commit IDs.
   */
  async getParents(id: ObjectId): Promise<ObjectId[]> {
    const commit = await this.load(id);
    if (!commit) {
      return [];
    }
    return commit.parents;
  }

  /**
   * Get the tree ObjectId for a commit.
   * Returns undefined if commit doesn't exist.
   */
  async getTree(id: ObjectId): Promise<ObjectId | undefined> {
    const commit = await this.load(id);
    return commit?.tree;
  }

  /**
   * Walk commit ancestry (depth-first with timestamp ordering).
   */
  walkAncestry(
    startIds: ObjectId | ObjectId[],
    options: WalkOptions = {},
  ): AsyncIterable<ObjectId> {
    return walkAncestryShared(this, startIds, options);
  }

  /**
   * Find merge base (common ancestor).
   */
  async findMergeBase(commitA: ObjectId, commitB: ObjectId): Promise<ObjectId[]> {
    return findMergeBaseShared(this, commitA, commitB);
  }

  /**
   * Check if commit exists.
   */
  async has(id: ObjectId): Promise<boolean> {
    return this.kv.has(`${COMMIT_PREFIX}${id}`);
  }

  /**
   * Enumerate all commit object IDs.
   */
  async *keys(): AsyncIterable<ObjectId> {
    for await (const key of this.kv.list(COMMIT_PREFIX)) {
      yield key.slice(COMMIT_PREFIX.length);
    }
  }

  /**
   * Check if ancestorId is ancestor of descendantId.
   */
  async isAncestor(ancestorId: ObjectId, descendantId: ObjectId): Promise<boolean> {
    return isAncestorShared(this, ancestorId, descendantId);
  }

  // --- Extended query methods (O(n) scans) ---

  /**
   * Find commits by author email
   *
   * Note: This is an O(n) scan through all commits. For better performance,
   * use SQL-backed storage instead.
   *
   * @param email Author email to search for
   * @returns Async iterable of matching commit IDs (unsorted)
   */
  async *findByAuthor(email: string): AsyncIterable<ObjectId> {
    for await (const id of this.keys()) {
      const commit = await this.load(id);
      if (commit?.author.email === email) {
        yield id;
      }
    }
  }

  /**
   * Find commits in a date range
   *
   * Note: This is an O(n) scan through all commits. For better performance,
   * use SQL-backed storage instead.
   *
   * @param since Start of date range
   * @param until End of date range
   * @returns Async iterable of matching commit IDs (unsorted)
   */
  async *findByDateRange(since: Date, until: Date): AsyncIterable<ObjectId> {
    const sinceTs = Math.floor(since.getTime() / 1000);
    const untilTs = Math.floor(until.getTime() / 1000);

    for await (const id of this.keys()) {
      const commit = await this.load(id);
      if (commit && commit.author.timestamp >= sinceTs && commit.author.timestamp <= untilTs) {
        yield id;
      }
    }
  }

  /**
   * Search commits by message content
   *
   * Note: This is an O(n) scan through all commits. For better performance,
   * use SQL-backed storage with FTS5 instead.
   *
   * @param pattern Substring to search for in message
   * @returns Async iterable of matching commit IDs (unsorted)
   */
  async *searchMessage(pattern: string): AsyncIterable<ObjectId> {
    const lowerPattern = pattern.toLowerCase();

    for await (const id of this.keys()) {
      const commit = await this.load(id);
      if (commit?.message.toLowerCase().includes(lowerPattern)) {
        yield id;
      }
    }
  }

  /**
   * Get commit count
   */
  async count(): Promise<number> {
    let count = 0;
    for await (const _ of this.keys()) {
      count++;
    }
    return count;
  }
}
