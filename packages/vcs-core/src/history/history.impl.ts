/**
 * History implementation - concrete classes for the History interface
 */

import type { BackendCapabilities } from "../backend/storage-backend.js";
import type { ObjectId } from "../common/id/index.js";
import type { SerializationApi } from "../serialization/serialization-api.js";
import type { DeltaApi } from "../storage/delta/delta-api.js";
import type { Blobs } from "./blobs/blobs.js";
import type { Commits } from "./commits/commits.js";
import type { History, HistoryWithOperations } from "./history.js";
import type { Refs } from "./refs/refs.js";
import type { Tags } from "./tags/tags.js";
import type { Trees } from "./trees/trees.js";

/**
 * History implementation that composes individual stores
 *
 * This is the primary implementation used by applications.
 * It wraps individual store implementations into a unified facade.
 *
 * @example
 * ```typescript
 * const history = new HistoryImpl(blobs, trees, commits, tags, refs);
 * await history.initialize();
 *
 * // Use stores
 * const blobId = await history.blobs.store(content);
 * const commit = await history.commits.load(commitId);
 *
 * await history.close();
 * ```
 */
export class HistoryImpl implements History {
  private initialized = false;

  constructor(
    readonly blobs: Blobs,
    readonly trees: Trees,
    readonly commits: Commits,
    readonly tags: Tags,
    readonly refs: Refs,
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize refs (creates directory structure, etc.)
    if (this.refs.initialize) {
      await this.refs.initialize();
    }

    // Set up default HEAD → refs/heads/main if HEAD doesn't exist yet.
    // For new repos this creates the standard symbolic ref;
    // for existing repos HEAD is already present and this is a no-op.
    if (!(await this.refs.has("HEAD"))) {
      await this.refs.setSymbolic("HEAD", "refs/heads/main");
    }

    this.initialized = true;
  }

  async close(): Promise<void> {
    // Flush any pending operations
    // Individual stores may have their own cleanup

    this.initialized = false;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Collect all objects reachable from wants, excluding haves
   *
   * Traverses the object graph using BFS:
   * - From commits: adds tree and parent commits
   * - From trees: adds child blobs and trees
   * - From tags: adds target object
   * - Blobs: leaf nodes, no children
   */
  async *collectReachableObjects(
    wants: Set<string>,
    exclude: Set<string>,
  ): AsyncIterable<ObjectId> {
    const visited = new Set<string>();

    // Expand exclude set to include all ancestor commits
    const excludeExpanded = new Set<string>(exclude);
    for (const excludeOid of exclude) {
      try {
        for await (const ancestorOid of this.commits.walkAncestry(excludeOid)) {
          excludeExpanded.add(ancestorOid);
        }
      } catch {
        // Not a commit, skip
      }
    }

    // BFS from wants
    const queue: string[] = [...wants];

    while (queue.length > 0) {
      const oid = queue.shift();
      if (!oid) continue;

      if (visited.has(oid) || excludeExpanded.has(oid)) {
        continue;
      }
      visited.add(oid);

      // Check if object exists
      const exists = await this.hasObject(oid);
      if (!exists) continue;

      yield oid;

      // Try to load as commit and walk its tree and parents
      const commit = await this.commits.load(oid);
      if (commit) {
        // Add tree to queue
        if (!visited.has(commit.tree)) {
          queue.push(commit.tree);
        }

        // Add parents to queue
        for (const parent of commit.parents) {
          if (!visited.has(parent) && !excludeExpanded.has(parent)) {
            queue.push(parent);
          }
        }
        continue;
      }

      // Try to load as tree and walk entries
      const tree = await this.trees.load(oid);
      if (tree) {
        for await (const entry of tree) {
          if (!visited.has(entry.id)) {
            queue.push(entry.id);
          }
        }
        continue;
      }

      // Try to load as tag and walk tagged object
      const tag = await this.tags.load(oid);
      if (tag) {
        if (!visited.has(tag.object)) {
          queue.push(tag.object);
        }
      }

      // Blob - no children to walk
    }
  }

  /**
   * Check if an object exists in any store
   */
  private async hasObject(oid: string): Promise<boolean> {
    if (await this.commits.has(oid)) return true;
    if (await this.trees.has(oid)) return true;
    if (await this.blobs.has(oid)) return true;
    if (await this.tags.has(oid)) return true;
    return false;
  }
}

/**
 * History implementation with storage operations
 *
 * Used when delta compression, serialization, or GC is needed.
 * Provides access to low-level storage operations without duplicating stores.
 *
 * @example
 * ```typescript
 * const history = new HistoryWithOperationsImpl(
 *   blobs, trees, commits, tags, refs,
 *   delta, serialization, capabilities,
 *   initializeFn, closeFn
 * );
 * await history.initialize();
 *
 * // Use delta API for GC
 * history.delta.startBatch();
 * await history.delta.blobs.deltifyBlob(blobId, baseId, delta);
 * await history.delta.endBatch();
 *
 * // Use serialization for transport
 * const pack = history.serialization.createPack(objectIds);
 *
 * await history.close();
 * ```
 */
export class HistoryWithOperationsImpl extends HistoryImpl implements HistoryWithOperations {
  constructor(
    blobs: Blobs,
    trees: Trees,
    commits: Commits,
    tags: Tags,
    refs: Refs,
    readonly delta: DeltaApi,
    readonly serialization: SerializationApi,
    readonly capabilities: BackendCapabilities,
    private readonly initializeOps: () => Promise<void>,
    private readonly closeOps: () => Promise<void>,
  ) {
    super(blobs, trees, commits, tags, refs);
  }

  async initialize(): Promise<void> {
    // Initialize operations first (creates storage structures)
    await this.initializeOps();

    // Then initialize refs
    await super.initialize();
  }

  async close(): Promise<void> {
    // Close stores first
    await super.close();

    // Then close operations (flushes data)
    await this.closeOps();
  }
}
