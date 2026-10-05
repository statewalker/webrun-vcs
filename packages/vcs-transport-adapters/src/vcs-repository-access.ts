/**
 * VCS Repository Access
 *
 * Implements RepositoryAccess using the History facade for object access.
 * Provides low-level byte-level operations for protocol handlers.
 */

import type { History, ObjectId } from "@statewalker/vcs-core";
import {
  isSymbolicRef,
  ObjectType,
  parseCommit,
  parseTag,
  parseTreeToArray,
  serializeCommit,
  serializeTag,
  serializeTree,
} from "@statewalker/vcs-core";
import type {
  HeadInfo,
  ObjectInfo,
  ObjectTypeCode,
  RefInfo,
  RepositoryAccess,
} from "@statewalker/vcs-transport";
import { collect, toArray } from "@statewalker/vcs-utils/streams";
import { createGitWireFormat } from "./wire-format-utils.js";

/**
 * Configuration for VcsRepositoryAccess using History facade
 */
export interface VcsRepositoryAccessConfig {
  /** History facade for object access */
  history: History;
}

/**
 * Repository access implementation using History facade.
 *
 * Provides RepositoryAccess interface for protocol handlers using
 * the unified History API for object storage and retrieval.
 */
export class VcsRepositoryAccess implements RepositoryAccess {
  private readonly history: History;

  constructor(config: VcsRepositoryAccessConfig) {
    this.history = config.history;
  }

  /**
   * Check if an object exists in any store.
   * Checks in order: commits → trees → blobs → tags
   */
  async hasObject(id: ObjectId): Promise<boolean> {
    if (await this.history.commits.has(id)) return true;
    if (await this.history.trees.has(id)) return true;
    if (await this.history.blobs.has(id)) return true;
    if (await this.history.tags.has(id)) return true;

    return false;
  }

  /**
   * Get object type and size.
   *
   * For blobs, uses efficient size() method.
   * For other types, serializes to determine size.
   */
  async getObjectInfo(id: ObjectId): Promise<ObjectInfo | null> {
    // Try commits first
    const commit = await this.history.commits.load(id);
    if (commit) {
      const serialized = serializeCommit(commit);
      return { type: ObjectType.COMMIT, size: serialized.length };
    }

    // Try trees
    const tree = await this.history.trees.load(id);
    if (tree) {
      const entries = await toArray(tree);
      const serialized = serializeTree(entries);
      return { type: ObjectType.TREE, size: serialized.length };
    }

    // Try tags before blobs (tags have more structure)
    const tag = await this.history.tags.load(id);
    if (tag) {
      const serialized = serializeTag(tag);
      return { type: ObjectType.TAG, size: serialized.length };
    }

    // Try blobs - use efficient size() method
    const blobSize = await this.history.blobs.size(id);
    if (blobSize >= 0) {
      return { type: ObjectType.BLOB, size: blobSize };
    }

    return null;
  }

  /**
   * Load object content in Git wire format.
   *
   * Serializes domain objects and prepends Git header.
   */
  async *loadObject(id: ObjectId): AsyncIterable<Uint8Array> {
    // Try commits first
    const commit = await this.history.commits.load(id);
    if (commit) {
      const content = serializeCommit(commit);
      yield createGitWireFormat("commit", content);
      return;
    }

    // Try trees
    const tree = await this.history.trees.load(id);
    if (tree) {
      const entries = await toArray(tree);
      const content = serializeTree(entries);
      yield createGitWireFormat("tree", content);
      return;
    }

    // Try tags before blobs (tags have more structure)
    const tag = await this.history.tags.load(id);
    if (tag) {
      const content = serializeTag(tag);
      yield createGitWireFormat("tag", content);
      return;
    }

    // Try blobs
    try {
      const blob = await this.history.blobs.load(id);
      if (blob) {
        const content = await collect(blob);
        yield createGitWireFormat("blob", content);
        return;
      }
    } catch {
      // Not a blob
    }

    throw new Error(`Object not found: ${id}`);
  }

  /**
   * Store an object.
   *
   * Parses wire content and stores in appropriate high-level store.
   */
  async storeObject(type: ObjectTypeCode, content: Uint8Array): Promise<ObjectId> {
    switch (type) {
      case ObjectType.COMMIT: {
        const commit = parseCommit(content);
        return this.history.commits.store(commit);
      }

      case ObjectType.TREE: {
        const entries = parseTreeToArray(content);
        return this.history.trees.store(entries);
      }

      case ObjectType.BLOB: {
        return this.history.blobs.store([content]);
      }

      case ObjectType.TAG: {
        const tag = parseTag(content);
        return this.history.tags.store(tag);
      }

      default:
        throw new Error(`Unknown object type: ${type}`);
    }
  }

  /**
   * List all refs in the repository.
   *
   * Resolves symbolic refs to get objectIds.
   */
  async *listRefs(): AsyncIterable<RefInfo> {
    for await (const ref of this.history.refs.list()) {
      if (isSymbolicRef(ref)) {
        // Resolve symbolic ref to get objectId
        const resolved = await this.history.refs.resolve(ref.name);
        if (resolved?.objectId) {
          yield {
            name: ref.name,
            objectId: resolved.objectId,
          };
        }
      } else if (ref.objectId) {
        const refInfo: RefInfo = {
          name: ref.name,
          objectId: ref.objectId,
        };

        // Include peeledId for annotated tags
        if (ref.peeledObjectId) {
          refInfo.peeledId = ref.peeledObjectId;
        } else if (
          ref.name.startsWith("refs/tags/") &&
          (await this.history.tags.has(ref.objectId))
        ) {
          // If it's a tag ref pointing to a tag object, try to get peeled target
          const peeled = await this.history.tags.getTarget(ref.objectId, true);
          if (peeled && peeled !== ref.objectId) {
            refInfo.peeledId = peeled;
          }
        }

        yield refInfo;
      }
    }
  }

  /**
   * Get HEAD reference (may be symbolic).
   */
  async getHead(): Promise<HeadInfo | null> {
    const head = await this.history.refs.get("HEAD");
    if (!head) return null;

    if (isSymbolicRef(head)) {
      return { target: head.target };
    }

    return { objectId: head.objectId };
  }

  /**
   * Update a ref.
   *
   * Uses compareAndSwap for atomic updates when oldId is provided.
   */
  async updateRef(name: string, oldId: ObjectId | null, newId: ObjectId | null): Promise<boolean> {
    if (newId === null) {
      // Delete ref
      return this.history.refs.remove(name);
    }

    if (oldId !== null) {
      // Compare-and-swap update
      const result = await this.history.refs.compareAndSwap(name, oldId, newId);
      return result.success;
    }

    // Simple set (create or overwrite)
    await this.history.refs.set(name, newId);
    return true;
  }

  /**
   * Walk object graph from starting points.
   *
   * Collects all objects reachable from wants, excluding haves.
   */
  async *walkObjects(
    wants: ObjectId[],
    haves: ObjectId[],
  ): AsyncIterable<{ id: ObjectId; type: ObjectTypeCode; content: Uint8Array }> {
    const haveSet = new Set(haves);
    const seen = new Set<ObjectId>();

    for (const wantId of wants) {
      yield* this.walkObject(wantId, haveSet, seen);
    }
  }

  /**
   * Recursively walk an object and its references.
   */
  private async *walkObject(
    id: ObjectId,
    haveSet: Set<ObjectId>,
    seen: Set<ObjectId>,
  ): AsyncGenerator<{ id: ObjectId; type: ObjectTypeCode; content: Uint8Array }> {
    if (seen.has(id) || haveSet.has(id)) return;
    seen.add(id);

    // Try commits first
    const commit = await this.history.commits.load(id);
    if (commit) {
      const content = serializeCommit(commit);
      yield { id, type: ObjectType.COMMIT, content };

      // Walk tree
      yield* this.walkObject(commit.tree, haveSet, seen);

      // Walk parent commits
      for (const parentId of commit.parents) {
        yield* this.walkObject(parentId, haveSet, seen);
      }
      return;
    }

    // Try trees
    const tree = await this.history.trees.load(id);
    if (tree) {
      const entries = await toArray(tree);
      const content = serializeTree(entries);
      yield { id, type: ObjectType.TREE, content };

      // Walk tree entries
      for (const entry of entries) {
        yield* this.walkObject(entry.id, haveSet, seen);
      }
      return;
    }

    // Try tags before blobs (tags have more structure)
    const tag = await this.history.tags.load(id);
    if (tag) {
      const content = serializeTag(tag);
      yield { id, type: ObjectType.TAG, content };

      // Walk tagged object
      yield* this.walkObject(tag.object, haveSet, seen);
      return;
    }

    // Try blobs (catch-all for non-structured objects)
    try {
      const blob = await this.history.blobs.load(id);
      if (blob) {
        const content = await collect(blob);
        yield { id, type: ObjectType.BLOB, content };
        return;
      }
    } catch {
      // Not a blob - skip
    }

    // Object not found - skip silently (might be unreachable)
  }
}

/**
 * Create RepositoryAccess from History facade.
 *
 * @param config - History facade configuration
 * @returns RepositoryAccess interface for protocol handlers
 */
export function createVcsRepositoryAccess(config: VcsRepositoryAccessConfig): RepositoryAccess {
  return new VcsRepositoryAccess(config);
}
