/**
 * Factory for creating RepositoryFacade from HistoryWithOperations.
 *
 * The RepositoryFacade provides a transport-friendly interface for
 * repository operations needed during Git protocol negotiation.
 *
 * Uses HistoryWithOperations for all operations:
 * - collectReachableObjects() for efficient object graph traversal
 * - SerializationApi for pack import/export
 * - Typed stores (Blobs, Trees, Commits, Tags, Refs) for object access
 */

import type { HistoryWithOperations, Ref, SymbolicRef } from "@statewalker/vcs-core";
import type {
  ExportPackOptions,
  PackImportResult,
  RepositoryFacade,
} from "../api/repository-facade.js";

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
 * Uses History.collectReachableObjects() for efficient object graph traversal
 * during pack export.
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

    async *exportPack(
      wants: Set<string>,
      exclude: Set<string>,
      _options?: ExportPackOptions,
    ): AsyncIterable<Uint8Array> {
      // Use History.collectReachableObjects for efficient traversal
      const objectIds = history.collectReachableObjects(wants, exclude);
      yield* serialization.createPack(objectIds);
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
      // Try blobs first - most efficient with size() method
      const blobSize = await history.blobs.size(oid);
      if (blobSize >= 0) return blobSize;

      // For other types, would need to serialize to determine size
      // Return null for now as this is an optional optimization
      return null;
    },

    // ─────────────────────────────────────────────────────────────────
    // Server-side validation methods
    // ─────────────────────────────────────────────────────────────────

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
