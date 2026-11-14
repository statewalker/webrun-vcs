/**
 * Adapter from core Refs interface to transport RefStore interface.
 *
 * The transport layer's RefStore has a simpler interface than the core Refs:
 * - get(name) returns string|undefined (not RefValue)
 * - update(name, oid) instead of set(name, oid)
 * - listAll() returns Iterable<[string, string]> (not AsyncIterable<RefEntry>)
 */

import type { Refs } from "@statewalker/vcs-core";
import { createTransportRefStore, type RefStore } from "@statewalker/vcs-transport";

/**
 * Create a transport RefStore from a core Refs instance.
 *
 * Resolves symbolic refs to their final object IDs.
 * Skips refs with undefined objectIds (unborn branches).
 *
 * @param refs - Core Refs instance
 * @returns Transport RefStore interface
 */
export function createRefStoreAdapter(refs: Refs): RefStore {
  // The shared adapter: pushes go through Refs.batch, and the zero id deletes.
  return createTransportRefStore(refs);
}
