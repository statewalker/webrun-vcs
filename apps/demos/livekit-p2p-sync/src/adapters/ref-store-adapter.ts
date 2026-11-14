/**
 * Adapter from core Refs to transport RefStore.
 */

import type { Refs } from "@statewalker/vcs-core";
import { createTransportRefStore, type RefStore } from "@statewalker/vcs-transport";

export function createRefStoreAdapter(refs: Refs): RefStore {
  // The shared adapter: pushes go through Refs.batch, and the zero id deletes.
  return createTransportRefStore(refs);
}
