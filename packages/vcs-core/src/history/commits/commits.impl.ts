/**
 * Git commit store implementation
 *
 * Wraps GitObjectStore with commit serialization/deserialization.
 * Provides graph traversal operations for commit history.
 */

import type { ObjectId } from "../../common/id/index.js";
import type { GitObjectStore } from "../objects/object-store.js";
import {
  commitToEntries,
  decodeCommitEntries,
  encodeCommitEntries,
  entriesToCommit,
} from "./commit-format.js";
import type { AncestryOptions, Commit, Commits } from "./commits.js";

/**
 * Git commit store implementation
 *
 * Handles commit serialization and provides graph traversal.
 */
class GitCommitStore implements Commits {
  constructor(private readonly objects: GitObjectStore) {}

  // ============ New Commits Interface ============

  /**
   * Store a commit object (new interface)
   */
  async store(commit: Commit): Promise<ObjectId> {
    const entries = commitToEntries(commit);
    return this.objects.store("commit", encodeCommitEntries(entries));
  }

  /**
   * Load a commit object by ID (new interface)
   * Returns undefined if commit doesn't exist.
   */
  async load(id: ObjectId): Promise<Commit | undefined> {
    if (!(await this.has(id))) {
      return undefined;
    }
    try {
      return await this.loadCommitInternal(id);
    } catch {
      return undefined;
    }
  }

  /**
   * Remove commit (new interface)
   */
  async remove(id: ObjectId): Promise<boolean> {
    return this.objects.remove(id);
  }

  /**
   * Load a commit object by ID (internal implementation)
   */
  private async loadCommitInternal(id: ObjectId): Promise<Commit> {
    const [header, content] = await this.objects.loadWithHeader(id);
    try {
      if (header.type !== "commit") {
        throw new Error(`Object ${id} is not a commit (found type: ${header.type})`);
      }
      const entries = decodeCommitEntries(content);
      return entriesToCommit(entries);
    } catch (err) {
      content?.return?.(void 0);
      throw err;
    }
  }

  /**
   * Get parent commit IDs
   */
  async getParents(id: ObjectId): Promise<ObjectId[]> {
    const commit = await this.load(id);
    return commit?.parents ?? [];
  }

  /**
   * Get tree ID for a commit
   */
  async getTree(id: ObjectId): Promise<ObjectId | undefined> {
    const commit = await this.load(id);
    return commit?.tree;
  }

  /**
   * Walk commit ancestry (depth-first)
   */
  async *walkAncestry(
    startIds: ObjectId | ObjectId[],
    options: AncestryOptions = {},
  ): AsyncIterable<ObjectId> {
    const starts = Array.isArray(startIds) ? startIds : [startIds];
    const visited = new Set<ObjectId>();
    const stopAt = new Set(options.stopAt || []);
    const stack = [...starts];
    let count = 0;

    while (stack.length > 0) {
      if (options.limit !== undefined && count >= options.limit) {
        break;
      }

      const id = stack.pop();
      if (id === undefined) break;

      if (visited.has(id) || stopAt.has(id)) {
        continue;
      }

      visited.add(id);
      yield id;
      count++;

      const parents = await this.getParents(id);
      if (options.firstParentOnly && parents.length > 0) {
        stack.push(parents[0]);
      } else {
        for (let i = parents.length - 1; i >= 0; i--) {
          stack.push(parents[i]);
        }
      }
    }
  }

  /**
   * Find merge base (common ancestor)
   */
  async findMergeBase(commitA: ObjectId, commitB: ObjectId): Promise<ObjectId[]> {
    const ancestorsA = new Set<ObjectId>();

    for await (const id of this.walkAncestry(commitA)) {
      ancestorsA.add(id);
    }

    for await (const id of this.walkAncestry(commitB)) {
      if (ancestorsA.has(id)) {
        return [id];
      }
    }

    return [];
  }

  /**
   * Check if commit exists and is actually a commit object
   */
  async has(id: ObjectId): Promise<boolean> {
    if (!(await this.objects.has(id))) {
      return false;
    }
    try {
      const header = await this.objects.getHeader(id);
      return header.type === "commit";
    } catch {
      return false;
    }
  }

  /**
   * Enumerate all commit object IDs
   */
  async *keys(): AsyncIterable<ObjectId> {
    for await (const id of this.objects.list()) {
      try {
        const header = await this.objects.getHeader(id);
        if (header.type === "commit") {
          yield id;
        }
      } catch {
        // Skip invalid objects
      }
    }
  }

  /**
   * Check if commitA is ancestor of commitB
   */
  async isAncestor(ancestorId: ObjectId, descendantId: ObjectId): Promise<boolean> {
    if (ancestorId === descendantId) return true;
    for await (const id of this.walkAncestry(descendantId)) {
      if (id === ancestorId) {
        return true;
      }
    }
    return false;
  }
}

/**
 * Create a Commits instance backed by GitObjectStore
 *
 * @param objects GitObjectStore implementation to use for persistence
 * @returns Commits instance
 */
export function createCommits(objects: GitObjectStore): Commits {
  return new GitCommitStore(objects);
}
