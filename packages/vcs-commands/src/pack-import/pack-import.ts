import type { History, HistoryWithOperations } from "@statewalker/vcs-core";
// Import from the package root only: vcs-core ships a single runtime file
// (dist/index.js); its subpaths resolve for types but not at runtime.
import { DefaultSerializationApi } from "@statewalker/vcs-core";

/**
 * Import a received pack stream into a history, byte for byte.
 *
 * Uses the history's own {@link SerializationApi} when it exposes one
 * (a `HistoryWithOperations`), otherwise one over its object kernel
 * (`history.objects`, `history.packs`). Either way the pack goes through
 * vcs-core's `importPack`: kept as a pack when it is large and the history
 * has packs, unpacked into loose objects otherwise, never buffered whole.
 */
export async function importPackIntoHistory(
  history: History,
  pack: AsyncIterable<Uint8Array>,
): Promise<void> {
  const serialization =
    (history as Partial<HistoryWithOperations>).serialization ??
    new DefaultSerializationApi({ history });
  await serialization.importPack(pack);
}
