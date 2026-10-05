/**
 * VcsRepositoryFacade
 *
 * Implements RepositoryFacade using the History facade for object access.
 * Delegates to History.collectReachableObjects() for pack export and
 * SerializationApi for pack import/creation.
 */

import type { History, SerializationApi } from "@statewalker/vcs-core";
import { isSymbolicRef, serializeCommit, serializeTag, serializeTree } from "@statewalker/vcs-core";
import type {
  ExportPackOptions,
  PackImportResult,
  RepositoryFacade,
} from "@statewalker/vcs-transport";
import { toArray } from "@statewalker/vcs-utils/streams";

/**
 * Configuration for VcsRepositoryFacade using History facade
 */
export interface VcsRepositoryFacadeConfig {
  /** History facade for object access */
  history: History;
  /** Serialization API for pack operations */
  serialization: SerializationApi;
}

/**
 * Repository facade implementation using History facade.
 *
 * Provides RepositoryFacade interface for transport operations using
 * the unified History API. Delegates pack operations to SerializationApi.
 */
export class VcsRepositoryFacade implements RepositoryFacade {
  private readonly history: History;
  private readonly serialization: SerializationApi;

  constructor(config: VcsRepositoryFacadeConfig) {
    this.history = config.history;
    this.serialization = config.serialization;
  }

  /**
   * Import a pack stream into the repository.
   * Delegates to SerializationApi.importPack.
   */
  async importPack(packStream: AsyncIterable<Uint8Array>): Promise<PackImportResult> {
    return this.serialization.importPack(packStream);
  }

  /**
   * Export objects as a pack stream.
   * Collects reachable objects from wants, excluding those in exclude set.
   * Delegates to History.collectReachableObjects().
   */
  async *exportPack(
    wants: Set<string>,
    exclude: Set<string>,
    _options?: ExportPackOptions,
  ): AsyncIterable<Uint8Array> {
    const objectIds = this.history.collectReachableObjects(wants, exclude);
    yield* this.serialization.createPack(objectIds);
  }

  /**
   * Check if an object exists in any store.
   * Checks in order: commits → trees → blobs → tags
   */
  async has(oid: string): Promise<boolean> {
    if (await this.history.commits.has(oid)) return true;
    if (await this.history.trees.has(oid)) return true;
    if (await this.history.blobs.has(oid)) return true;
    if (await this.history.tags.has(oid)) return true;
    return false;
  }

  /**
   * Walk commit ancestry from a starting point.
   * Yields commit OIDs in BFS order.
   */
  async *walkAncestors(startOid: string): AsyncGenerator<string> {
    const visited = new Set<string>();
    const queue: string[] = [startOid];

    while (queue.length > 0) {
      const oid = queue.shift();
      if (!oid || visited.has(oid)) continue;
      visited.add(oid);

      const commit = await this.history.commits.load(oid);
      if (commit) {
        yield oid;
        // Queue parents for BFS traversal
        for (const parentOid of commit.parents) {
          if (!visited.has(parentOid)) {
            queue.push(parentOid);
          }
        }
      }
    }
  }

  /**
   * Peel a tag to its underlying object.
   */
  async peelTag(oid: string): Promise<string | null> {
    return (await this.history.tags.getTarget(oid)) ?? null;
  }

  /**
   * Get the size of an object.
   */
  async getObjectSize(oid: string): Promise<number | null> {
    // Try blobs first - most efficient with size() method
    const blobSize = await this.history.blobs.size(oid);
    if (blobSize >= 0) return blobSize;

    // Try commits
    const commit = await this.history.commits.load(oid);
    if (commit) {
      const content = serializeCommit(commit);
      return content.length;
    }

    // Try trees
    const tree = await this.history.trees.load(oid);
    if (tree) {
      const entries = await toArray(tree);
      const content = serializeTree(entries);
      return content.length;
    }

    // Try tags
    const tag = await this.history.tags.load(oid);
    if (tag) {
      const content = serializeTag(tag);
      return content.length;
    }

    return null;
  }

  /**
   * Check if an object is reachable from other objects.
   */
  async isReachableFrom(oid: string, from: string | string[]): Promise<boolean> {
    const roots = Array.isArray(from) ? from : [from];

    for (const root of roots) {
      for await (const ancestorOid of this.walkAncestors(root)) {
        if (ancestorOid === oid) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Check if an object is reachable from any ref tip.
   */
  async isReachableFromAnyTip(oid: string): Promise<boolean> {
    const tips: string[] = [];

    for await (const ref of this.history.refs.list()) {
      const resolved = isSymbolicRef(ref) ? await this.history.refs.resolve(ref.name) : ref;
      if (resolved && "objectId" in resolved && resolved.objectId !== undefined) {
        tips.push(resolved.objectId);
      }
    }

    return this.isReachableFrom(oid, tips);
  }

  /**
   * Compute shallow boundaries for depth-limited clone.
   */
  async computeShallowBoundaries(wants: Set<string>, depth: number): Promise<Set<string>> {
    const boundaries = new Set<string>();

    for (const want of wants) {
      const queue: Array<{ oid: string; depth: number }> = [{ oid: want, depth: 0 }];
      const visited = new Set<string>();

      while (queue.length > 0) {
        const item = queue.shift();
        if (!item) continue;

        const { oid, depth: d } = item;
        if (visited.has(oid)) continue;
        visited.add(oid);

        if (d >= depth) {
          boundaries.add(oid);
          continue;
        }

        const commit = await this.history.commits.load(oid);
        if (commit) {
          for (const parent of commit.parents) {
            queue.push({ oid: parent, depth: d + 1 });
          }
        }
      }
    }

    return boundaries;
  }

  /**
   * Compute shallow boundaries since a timestamp.
   */
  async computeShallowSince(wants: Set<string>, timestamp: number): Promise<Set<string>> {
    const boundaries = new Set<string>();

    for (const want of wants) {
      const queue: string[] = [want];
      const visited = new Set<string>();

      while (queue.length > 0) {
        const oid = queue.shift();
        if (!oid || visited.has(oid)) continue;
        visited.add(oid);

        const commit = await this.history.commits.load(oid);
        if (commit) {
          // Check if commit is before timestamp
          if (commit.committer.timestamp < timestamp) {
            boundaries.add(oid);
            continue;
          }

          // Continue walking parents
          for (const parent of commit.parents) {
            queue.push(parent);
          }
        }
      }
    }

    return boundaries;
  }

  /**
   * Compute shallow boundaries excluding refs.
   */
  async computeShallowExclude(wants: Set<string>, excludeRefs: string[]): Promise<Set<string>> {
    const boundaries = new Set<string>();

    // Resolve exclude refs to OIDs
    const excludeOids = new Set<string>();
    for (const refName of excludeRefs) {
      const ref = await this.history.refs.resolve(refName);
      if (ref && "objectId" in ref && ref.objectId) {
        excludeOids.add(ref.objectId);

        // Also add all ancestors of excluded refs
        for await (const ancestorOid of this.walkAncestors(ref.objectId)) {
          excludeOids.add(ancestorOid);
        }
      }
    }

    // Walk from wants and mark boundaries where we hit excluded commits
    for (const want of wants) {
      const queue: string[] = [want];
      const visited = new Set<string>();

      while (queue.length > 0) {
        const oid = queue.shift();
        if (!oid || visited.has(oid)) continue;
        visited.add(oid);

        if (excludeOids.has(oid)) {
          boundaries.add(oid);
          continue;
        }

        const commit = await this.history.commits.load(oid);
        if (commit) {
          for (const parent of commit.parents) {
            queue.push(parent);
          }
        }
      }
    }

    return boundaries;
  }
}

/**
 * Create RepositoryFacade from History facade.
 *
 * @param config - History facade and SerializationApi
 * @returns RepositoryFacade interface for transport operations
 */
export function createVcsRepositoryFacade(config: VcsRepositoryFacadeConfig): RepositoryFacade {
  return new VcsRepositoryFacade(config);
}
