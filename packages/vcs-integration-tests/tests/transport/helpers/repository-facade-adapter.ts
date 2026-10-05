/**
 * RepositoryFacade adapter for transport integration tests
 *
 * Creates a RepositoryFacade from a HistoryWithOperations for use in
 * transport operations (fetch, push).
 */

import {
  createRepositoryFacade as createFacadeFromHistory,
  type RepositoryFacade,
} from "@statewalker/vcs-transport";
import type { SimpleHistory } from "../../helpers/simple-history.js";

/**
 * Creates a RepositoryFacade from a HistoryWithOperations
 *
 * The RepositoryFacade provides transport-layer operations:
 * - importPack: Import objects from a pack stream
 * - exportPack: Export objects as a pack stream
 * - has: Check if an object exists
 * - walkAncestors: Walk commit ancestry for negotiation
 *
 * @param history HistoryWithOperations instance
 * @returns RepositoryFacade for transport operations
 *
 * @example
 * ```typescript
 * const history = createHistoryWithOperations({ backend });
 * const facade = createRepositoryFacade(history);
 *
 * // Check object existence
 * const exists = await facade.has(commitId);
 *
 * // Export objects as pack
 * const pack = facade.exportPack(new Set([wantOid]), new Set([haveOid]));
 * ```
 */
export function createRepositoryFacade(history: SimpleHistory): RepositoryFacade {
  // SimpleHistory has the required properties (commits, trees, blobs, tags, refs, serialization,
  // collectReachableObjects) but doesn't implement the full HistoryWithOperations interface
  // (missing delta, capabilities). The factory only uses the subset SimpleHistory provides.
  return createFacadeFromHistory({ history: history as any });
}
