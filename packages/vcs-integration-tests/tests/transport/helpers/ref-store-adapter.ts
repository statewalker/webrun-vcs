/**
 * RefStore adapter for transport integration tests
 *
 * Wraps the core RefStore interface to implement the transport-layer
 * RefStore interface used by fetch/push operations.
 */

import type { Ref, Refs, SymbolicRef } from "@statewalker/vcs-core";
import type { RefStore as TransportRefStore } from "@statewalker/vcs-transport";

/**
 * Type guard for SymbolicRef
 */
function isSymbolicRef(ref: Ref | SymbolicRef): ref is SymbolicRef {
  return "target" in ref;
}

/**
 * Creates a transport-layer RefStore from a core RefStore
 *
 * The transport layer uses a simpler RefStore interface with:
 * - get(name) -> string | undefined (returns OID directly)
 * - update(name, oid) -> void
 * - listAll() -> Iterable<[name, oid]>
 *
 * @param coreRefStore Core RefStore from HistoryStore
 * @returns Transport-compatible RefStore
 *
 * @example
 * ```typescript
 * const repository = await createGitRepository(...);
 * const refStore = createTransportRefStore(repository.refs);
 *
 * // Use with transport operations
 * const oid = await refStore.get("refs/heads/main");
 * await refStore.update("refs/heads/feature", newCommitId);
 * ```
 */
export function createTransportRefStore(coreRefStore: Refs): TransportRefStore {
  return {
    async get(name: string): Promise<string | undefined> {
      // Resolve to get the final OID (follows symbolic refs)
      const ref = await coreRefStore.resolve(name);
      return ref?.objectId;
    },

    async update(name: string, oid: string): Promise<void> {
      await coreRefStore.set(name, oid);
    },

    async listAll(): Promise<Iterable<[string, string]>> {
      const refs: Array<[string, string]> = [];

      for await (const ref of coreRefStore.list()) {
        if (isSymbolicRef(ref)) {
          // For symbolic refs, resolve to get the OID
          const resolved = await coreRefStore.resolve(ref.name);
          if (resolved?.objectId) {
            refs.push([ref.name, resolved.objectId]);
          }
        } else if (ref.objectId) {
          // Only include refs that have an objectId (skip unborn refs)
          refs.push([ref.name, ref.objectId]);
        }
      }

      return refs;
    },

    async getSymrefTarget(name: string): Promise<string | undefined> {
      const ref = await coreRefStore.get(name);
      if (ref && isSymbolicRef(ref)) {
        return ref.target;
      }
      return undefined;
    },

    async isRefTip(oid: string): Promise<boolean> {
      for await (const ref of coreRefStore.list()) {
        if (!isSymbolicRef(ref) && ref.objectId === oid) {
          return true;
        }
      }
      return false;
    },
  };
}
