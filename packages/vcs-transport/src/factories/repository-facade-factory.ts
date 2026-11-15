/**
 * Factory for creating RepositoryFacade from HistoryWithOperations.
 *
 * The RepositoryFacade provides a transport-friendly interface for
 * repository operations needed during Git protocol negotiation.
 *
 * Uses HistoryWithOperations for all operations:
 * - SerializationApi.exportPack() (listObjects + writePack) for pack export
 * - SerializationApi for pack import/export
 * - Typed stores (Blobs, Trees, Commits, Tags, Refs) for object access
 */

import type { HistoryWithOperations, Ref, SymbolicRef } from "@statewalker/vcs-core";
import type {
  CommitGraphInfo,
  ExportPackOptions,
  PackImportResult,
  RepositoryFacade,
} from "../api/repository-facade.js";
import { computeShallowUpdate } from "../fsm/fetch/upload-pack-graph.js";

/**
 * Configuration for creating RepositoryFacade using History facade.
 */
export interface HistoryFacadeConfig {
  /** History facade for object access */
  history: HistoryWithOperations;
}

/**
 * Creates a RepositoryFacade from History facade with backend.
 *
 * Pack export goes through SerializationApi.exportPack (listObjects + writePack).
 *
 * @param config - History facade configuration
 * @returns RepositoryFacade implementation
 *
 * @example
 * ```ts
 * const facade = createRepositoryFacade({ history });
 *
 * // Check if we have an object
 * const exists = await facade.has("abc123...");
 *
 * // Export pack
 * const packStream = facade.exportPack(wants, exclude);
 * ```
 */
export function createRepositoryFacade(config: HistoryFacadeConfig): RepositoryFacade {
  return createRepositoryFacadeFromHistory(config.history);
}

/**
 * Create RepositoryFacade using new History interface (recommended)
 */
function createRepositoryFacadeFromHistory(history: HistoryWithOperations): RepositoryFacade {
  const { commits, tags, refs, serialization } = history;

  const facade: RepositoryFacade = {
    // ─────────────────────────────────────────────────────────────────
    // Pack I/O - delegated to SerializationApi
    // ─────────────────────────────────────────────────────────────────

    importPack(packStream: AsyncIterable<Uint8Array>): Promise<PackImportResult> {
      return serialization.importPack(packStream);
    },

    exportPack(
      wants: Set<string>,
      exclude: Set<string>,
      options?: ExportPackOptions,
    ): AsyncIterable<Uint8Array> {
      // listObjects + writePack: streamed, stored entries reused, deltas searched
      return serialization.exportPack(wants, exclude, {
        thinPack: options?.thin,
        shallow: options?.shallow,
        ofsDelta: options?.ofsDelta,
      });
    },

    // ─────────────────────────────────────────────────────────────────
    // Object existence - check across all stores
    // ─────────────────────────────────────────────────────────────────

    async has(oid: string): Promise<boolean> {
      if (await commits.has(oid)) return true;
      if (await history.trees.has(oid)) return true;
      if (await history.blobs.has(oid)) return true;
      if (await tags.has(oid)) return true;
      return false;
    },

    // ─────────────────────────────────────────────────────────────────
    // Commit ancestry - walk commit graph
    // ─────────────────────────────────────────────────────────────────

    async *walkAncestors(startOid: string): AsyncGenerator<string> {
      yield* commits.walkAncestry(startOid);
    },

    // ─────────────────────────────────────────────────────────────────
    // Optional Protocol V2 methods
    // ─────────────────────────────────────────────────────────────────

    async peelTag(oid: string): Promise<string | null> {
      return (await tags.getTarget(oid)) ?? null;
    },

    async getObjectSize(oid: string): Promise<number | null> {
      // Any type (git's object-info): the size in the object header; the content is released
      // unread
      if (history.objects) {
        const object = await history.objects.get(oid);
        if (!object) return null;
        await object.content[Symbol.asyncIterator]().return?.();
        return object.size;
      }
      // Without the object store only blobs can be sized
      const blobSize = await history.blobs.size(oid);
      return blobSize >= 0 ? blobSize : null;
    },

    // ─────────────────────────────────────────────────────────────────
    // Server-side validation methods
    // ─────────────────────────────────────────────────────────────────

    async getCommitInfo(oid: string): Promise<CommitGraphInfo | undefined> {
      const commit = await commits.load(oid);
      if (!commit) return undefined;
      return { parents: commit.parents, time: commit.committer.timestamp };
    },

    async computeShallowBoundaries(wants: Set<string>, depth: number): Promise<Set<string>> {
      const update = await computeShallowUpdate(facade, { wants, clientShallow: [], depth });
      return new Set(update.shallow);
    },

    async isReachableFrom(oid: string, from: string | string[]): Promise<boolean> {
      const roots = Array.isArray(from) ? from : [from];

      for (const root of roots) {
        if (await commits.isAncestor(oid, root)) {
          return true;
        }
      }

      return false;
    },

    async isReachableFromAnyTip(oid: string): Promise<boolean> {
      const tips: string[] = [];
      for await (const ref of refs.list()) {
        const resolved = isSymbolicRef(ref) ? await refs.resolve(ref.name) : ref;
        if (resolved && "objectId" in resolved && resolved.objectId !== undefined) {
          tips.push(resolved.objectId);
        }
      }

      return facade.isReachableFrom?.(oid, tips) ?? false;
    },
  };

  return facade;
}

/**
 * Type guard for SymbolicRef
 */
function isSymbolicRef(ref: Ref | SymbolicRef): ref is SymbolicRef {
  return "target" in ref;
}
