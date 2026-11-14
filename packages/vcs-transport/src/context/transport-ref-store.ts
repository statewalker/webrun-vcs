/**
 * The transport `RefStore` over a vcs-core `Refs`.
 */
import { isSymbolicRef, type Refs } from "@statewalker/vcs-core";
import type { RefStore } from "./process-context.js";

/** git's zero id: "no object", used by push commands for creates and deletes. */
const ZERO_ID = "0".repeat(40);

/**
 * Adapt a vcs-core `Refs` to the transport `RefStore`. Pushes received through
 * it go through `refs.batch`: atomic where requested, with old-value checks.
 *
 * @example
 * ```typescript
 * const refStore = createTransportRefStore(history.refs);
 * await serveOverDuplex(duplex, repositoryFacade, refStore);
 * ```
 */
export function createTransportRefStore(refs: Refs): RefStore {
  return {
    async get(name) {
      return (await refs.resolve(name))?.objectId;
    },
    async update(name, oid) {
      // The zero id deletes, as in a push command.
      if (oid === ZERO_ID) await refs.remove(name);
      else await refs.set(name, oid);
    },
    batch: (commands, options) => refs.batch(commands, options),
    async listAll() {
      const out: Array<[string, string]> = [];
      for await (const ref of refs.list()) {
        if (isSymbolicRef(ref)) {
          const resolved = await refs.resolve(ref.name);
          if (resolved?.objectId) out.push([ref.name, resolved.objectId]);
        } else if (ref.objectId) {
          out.push([ref.name, ref.objectId]);
        }
      }
      return out;
    },
    async getSymrefTarget(name) {
      const ref = await refs.get(name);
      return ref && isSymbolicRef(ref) ? ref.target : undefined;
    },
    async isRefTip(oid) {
      for await (const ref of refs.list()) {
        if (!isSymbolicRef(ref) && ref.objectId === oid) return true;
      }
      return false;
    },
  };
}
