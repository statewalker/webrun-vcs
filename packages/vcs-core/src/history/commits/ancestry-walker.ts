/**
 * Ancestry Walker Utilities
 *
 * Provides shared implementation for commit ancestry traversal using
 * protocol injection pattern. Implementations provide storage operations,
 * and these functions provide the traversal algorithms.
 */

import { insertByTimestamp, type TimestampEntry } from "@statewalker/vcs-utils";

import type { ObjectId } from "../../common/id/index.js";
import type { AncestryOptions, Commit } from "./commits.js";

/**
 * Operations needed for ancestry traversal
 *
 * Implementations provide these operations to enable shared traversal logic.
 */
export interface AncestryStorageOps {
  /** Load a commit by ID (may throw if not found) */
  loadCommit(id: ObjectId): Promise<Commit>;
}

/**
 * Queue entry for timestamp-ordered traversal
 */
interface CommitQueueEntry extends TimestampEntry {
  id: ObjectId;
}

/**
 * Walk commit ancestry using provided storage operations.
 *
 * Traverses the commit graph from the starting commit(s),
 * yielding commits in reverse chronological order.
 *
 * @param ops Storage operations provider
 * @param startIds Starting commit ObjectId(s)
 * @param options Traversal options
 * @returns AsyncIterable of commit ObjectIds
 */
export async function* walkAncestry(
  ops: AncestryStorageOps,
  startIds: ObjectId | ObjectId[],
  options: AncestryOptions = {},
): AsyncGenerator<ObjectId> {
  const starts = Array.isArray(startIds) ? startIds : [startIds];
  const { limit, stopAt, firstParentOnly } = options;

  // Build stop set for quick lookup
  const stopSet = new Set(stopAt || []);

  // Priority queue ordered by timestamp (newest first)
  const queue: CommitQueueEntry[] = [];
  const visited = new Set<ObjectId>();
  let count = 0;

  // Initialize queue with start commits
  for (const id of starts) {
    if (!visited.has(id) && !stopSet.has(id)) {
      visited.add(id);
      try {
        const commit = await ops.loadCommit(id);
        insertByTimestamp(queue, { id, timestamp: commit.committer.timestamp });
      } catch {
        // Skip missing commits
      }
    }
  }

  // Process queue
  while (queue.length > 0) {
    if (limit !== undefined && count >= limit) {
      break;
    }

    const entry = queue.shift();
    if (!entry) break;
    yield entry.id;
    count++;

    // Add parents to queue
    const commit = await ops.loadCommit(entry.id);
    const parents = firstParentOnly ? commit.parents.slice(0, 1) : commit.parents;

    for (const parentId of parents) {
      if (!visited.has(parentId) && !stopSet.has(parentId)) {
        visited.add(parentId);
        try {
          const parent = await ops.loadCommit(parentId);
          insertByTimestamp(queue, {
            id: parentId,
            timestamp: parent.committer.timestamp,
          });
        } catch {
          // Skip missing parents
        }
      }
    }
  }
}

/**
 * Check if ancestorId is an ancestor of descendantId.
 *
 * @param ops Storage operations provider
 * @param ancestorId Potential ancestor commit
 * @param descendantId Potential descendant commit
 * @returns True if ancestorId is an ancestor of descendantId
 */
export async function isAncestor(
  ops: AncestryStorageOps,
  ancestorId: ObjectId,
  descendantId: ObjectId,
): Promise<boolean> {
  if (ancestorId === descendantId) {
    return true;
  }

  // Walk from descendant looking for ancestor
  for await (const id of walkAncestry(ops, descendantId)) {
    if (id === ancestorId) {
      return true;
    }
  }

  return false;
}

/**
 * Find merge base (common ancestor) using provided storage operations.
 *
 * Finds the best common ancestor(s) for merge operations.
 *
 * @param ops Storage operations provider
 * @param commitA First commit ObjectId
 * @param commitB Second commit ObjectId
 * @returns ObjectId(s) of merge base commit(s)
 */
export async function findMergeBase(
  ops: AncestryStorageOps,
  commitA: ObjectId,
  commitB: ObjectId,
): Promise<ObjectId[]> {
  // Paint ancestors of commitA with color A
  const colorA = new Set<ObjectId>();

  for await (const id of walkAncestry(ops, commitA)) {
    colorA.add(id);
  }

  // Walk ancestors of B and find intersections
  const mergeBases: ObjectId[] = [];

  for await (const id of walkAncestry(ops, commitB)) {
    if (colorA.has(id)) {
      // Found a common ancestor
      // Check if it's not an ancestor of another merge base
      let isRedundant = false;
      for (const base of mergeBases) {
        if (await isAncestor(ops, id, base)) {
          isRedundant = true;
          break;
        }
      }

      if (!isRedundant) {
        // Remove any existing merge bases that are ancestors of this one
        const filtered: ObjectId[] = [];
        for (const base of mergeBases) {
          if (!(await isAncestor(ops, base, id))) {
            filtered.push(base);
          }
        }
        filtered.push(id);
        mergeBases.length = 0;
        mergeBases.push(...filtered);
      }
    }
  }

  return mergeBases;
}
