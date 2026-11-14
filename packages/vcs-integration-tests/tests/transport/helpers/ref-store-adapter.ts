/**
 * RefStore adapter for transport integration tests
 *
 * Wraps the core RefStore interface to implement the transport-layer
 * RefStore interface used by fetch/push operations.
 */

import type { Ref, Refs, SymbolicRef } from "@statewalker/vcs-core";
import {
  createTransportRefStore as createCoreTransportRefStore,
  type RefStore as TransportRefStore,
} from "@statewalker/vcs-transport";

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
  return createCoreTransportRefStore(coreRefStore);
}
