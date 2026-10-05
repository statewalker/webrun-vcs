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

import type { PackImportResult } from "@statewalker/vcs-core";

// Re-export PackImportResult from core for transport consumers
export type { PackImportResult } from "@statewalker/vcs-core";
/**
 * Options for exportPack operation (Protocol V2 extensions).
 */
export interface ExportPackOptions {
  /** Use thin pack (deltas reference objects not in pack) */
  thin?: boolean;
  /** Include tags for fetched commits */
  includeTag?: boolean;
  /** Partial clone filter specification */
  filterSpec?: string;
  /** Shallow boundaries (objects that should not include parents) */
  shallow?: Set<string>;
}

export interface RepositoryFacade {
  /**
   * Imports a pack stream into the repository.
   * Parses pack format and stores objects.
   *
   * Delegates to: SerializationApi.importPack
   *
   * @param packStream - Stream of pack bytes
   * @returns Import statistics
   */
  importPack(packStream: AsyncIterable<Uint8Array>): Promise<PackImportResult>;

  /**
   * Exports objects as a pack stream.
   * Collects reachable objects and serializes to pack format.
   *
   * Delegates to: ObjectStore.collectReachable + SerializationApi.createPack
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

  // Shallow clone computation methods (optional)

  /**
   * Computes shallow boundaries for a depth-limited clone.
   *
   * @param wants - Object IDs being fetched
   * @param depth - Number of commits to include
   * @returns Set of OIDs that should be shallow boundaries
   */
  computeShallowBoundaries?(wants: Set<string>, depth: number): Promise<Set<string>>;

  /**
   * Computes shallow boundaries since a timestamp.
   *
   * @param wants - Object IDs being fetched
   * @param timestamp - Unix timestamp cutoff
   * @returns Set of OIDs that should be shallow boundaries
   */
  computeShallowSince?(wants: Set<string>, timestamp: number): Promise<Set<string>>;

  /**
   * Computes shallow boundaries excluding refs.
   *
   * @param wants - Object IDs being fetched
   * @param excludeRefs - Ref names to exclude
   * @returns Set of OIDs that should be shallow boundaries
   */
  computeShallowExclude?(wants: Set<string>, excludeRefs: string[]): Promise<Set<string>>;
}
