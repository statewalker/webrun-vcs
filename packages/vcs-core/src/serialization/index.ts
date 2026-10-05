/**
 * Serialization module
 *
 * Git-compatible wire format I/O for objects and packs.
 *
 * @example Create SerializationApi from History
 * ```typescript
 * import { createSerializationApi } from "@statewalker/vcs-core";
 *
 * const serialization = createSerializationApi({ history });
 * const pack = serialization.createPack(objectIds);
 * ```
 */

export * from "./serialization-api.impl.js";
export * from "./serialization-api.js";

// Re-export factory for convenience
import type { History } from "../history/history.js";
import { DefaultSerializationApi } from "./serialization-api.impl.js";
import type { SerializationApi } from "./serialization-api.js";

/**
 * Create SerializationApi from History facade
 *
 * @param history History facade for object access
 * @returns SerializationApi implementation
 */
export function createSerializationApi(history: History): SerializationApi {
  return new DefaultSerializationApi({ history });
}
