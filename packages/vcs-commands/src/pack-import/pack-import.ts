import type { History, HistoryWithOperations } from "@statewalker/vcs-core";
// Import from the package root only: vcs-core ships a single runtime file
// (dist/index.js); its subpaths resolve for types but not at runtime.
import { DefaultSerializationApi } from "@statewalker/vcs-core";

/**
 * Unpack pack data into a history's object stores.
 *
 * Uses the history's own {@link SerializationApi} when it exposes one
 * (a `HistoryWithOperations`), otherwise builds a default one over its
 * object stores — `WorkingCopy.history` is typed as a plain `History`,
 * so `serialization` is not statically available.
 */
export async function importPackIntoHistory(history: History, packData: Uint8Array): Promise<void> {
  const serialization =
    (history as Partial<HistoryWithOperations>).serialization ??
    new DefaultSerializationApi({ history });

  const packStream = (async function* () {
    yield packData;
  })();

  await serialization.importPack(packStream);
}
